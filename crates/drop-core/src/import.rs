//! CSV import (REQ-IMP-001).
//!
//! The importer reads a header row (`address,amount[,memo]`, any order, any case)
//! and turns every following record into a [`Recipient`] or into one or more
//! [`RowError`]s. It never drops a row silently: a malformed record is reported
//! with its 1-based line number, and a quote that is never closed is an error
//! instead of swallowing the rest of the file into one field.
//!
//! The parser is a small strict RFC 4180 reader rather than a lenient library
//! parser, precisely so that unbalanced quotes and stray quotes are detected.
//! Tolerated input: a UTF-8 byte-order mark, `\n`, `\r\n` or `\r` line endings,
//! quoted fields with embedded delimiters, quotes (`""`) and newlines, and `;`
//! as the delimiter (detected from the header line).
//!
//! Address validity is delegated to an [`AddressCodec`], which keeps this crate
//! free of chain dependencies. Error values hold only line numbers, counts and
//! static text, never the offending address, amount or memo (REQ-PRIV-002).

use std::collections::HashMap;
use std::fmt;
use std::io::Read;

use serde::{Serialize, Serializer};
use thiserror::Error;

use crate::amount::Zatoshi;
use crate::codec::{check_policy, AddressCodec};
use crate::error::{AddressError, AmountError, RecipientError};
use crate::recipient::{check_memo, Recipient, MAX_MEMO_BYTES};

/// Largest input [`import_csv_reader`] will read, in bytes.
pub const MAX_IMPORT_BYTES: usize = 32 * 1024 * 1024;

/// Import behaviour switches.
#[derive(Clone, Copy, Debug, Default)]
pub struct ImportOptions {
    /// Accept transparent recipient addresses. Off by default, because paying a
    /// transparent address publishes the recipient and amount on-chain.
    pub allow_transparent: bool,
}

/// What was wrong with a row (or with the header).
#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum RowErrorKind {
    /// The first record is not a header naming `address` and `amount`.
    #[error("the first row must be a header such as: address,amount,memo")]
    MissingHeader,
    /// A header cell is not `address`, `amount` or `memo`.
    #[error("unknown column in header at position {position}; expected address, amount, memo")]
    UnknownColumn {
        /// 1-based position of the cell in the header.
        position: usize,
    },
    /// The same column appears twice in the header.
    #[error("column `{name}` appears more than once in the header")]
    DuplicateColumn {
        /// The repeated column name.
        name: &'static str,
    },
    /// A required column is absent from the header.
    #[error("the header has no `{name}` column")]
    MissingColumn {
        /// The missing column name.
        name: &'static str,
    },
    /// The row has a different number of cells than the header.
    #[error("expected {expected} columns but found {found}")]
    FieldCount {
        /// Number of columns in the header.
        expected: usize,
        /// Number of cells in this row.
        found: usize,
    },
    /// A quoted field was opened but never closed.
    #[error("a quoted field is never closed; the rest of the file would be swallowed")]
    UnterminatedQuote,
    /// A quote appears where it is not allowed (inside an unquoted field, or text after a closing quote).
    #[error("misplaced quote character; quote the whole field and double any inner quotes")]
    MalformedQuote,
    /// The address cell is empty.
    #[error("address is empty")]
    MissingAddress,
    /// The address was rejected by the address codec or by policy.
    #[error("{reason}")]
    InvalidAddress {
        /// Why the address was rejected.
        reason: AddressError,
    },
    /// The amount could not be parsed.
    #[error("{reason}")]
    InvalidAmount {
        /// Why the amount was rejected.
        reason: AmountError,
    },
    /// The amount is zero.
    #[error("amount must be greater than zero")]
    ZeroAmount,
    /// The memo is longer than 512 bytes.
    #[error("memo is {bytes} bytes; the limit is {max} bytes")]
    MemoTooLong {
        /// Memo length in UTF-8 bytes.
        bytes: usize,
        /// The limit.
        max: usize,
    },
    /// The same address already appeared on an earlier line.
    #[error("this address already appears on line {first_line}")]
    DuplicateAddress {
        /// Line of the first occurrence.
        first_line: u64,
    },
}

/// A problem found on one line of the input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowError {
    /// 1-based line number where the offending record starts.
    pub line: u64,
    /// What was wrong.
    pub kind: RowErrorKind,
}

impl fmt::Display for RowError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "line {}: {}", self.line, self.kind)
    }
}

impl std::error::Error for RowError {}

impl Serialize for RowError {
    /// Serializes as `{line, kind: {code, ...}, message}` for the UI.
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Wire<'a> {
            line: u64,
            kind: &'a RowErrorKind,
            message: String,
        }
        Wire {
            line: self.line,
            kind: &self.kind,
            message: self.kind.to_string(),
        }
        .serialize(serializer)
    }
}

/// The outcome of an import: the rows that were valid and every error found.
///
/// A non-empty `errors` means the file must be fixed; `rows` is only what parsed
/// cleanly and must not be paid out on its own.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportReport {
    /// Valid recipients, in file order.
    pub rows: Vec<Recipient>,
    /// Every problem found, in file order.
    pub errors: Vec<RowError>,
}

impl ImportReport {
    /// Whether the file imported without any error.
    pub fn is_clean(&self) -> bool {
        self.errors.is_empty()
    }

    /// The rows if there were no errors, otherwise all the errors.
    pub fn into_result(self) -> Result<Vec<Recipient>, Vec<RowError>> {
        if self.errors.is_empty() {
            Ok(self.rows)
        } else {
            Err(self.errors)
        }
    }
}

/// Failure to even read the input as text (as opposed to problems in its rows).
#[derive(Debug, Error)]
pub enum ImportError {
    /// Reading from the source failed.
    #[error("could not read the input: {0}")]
    Io(#[from] std::io::Error),
    /// The input is not valid UTF-8.
    #[error("the input is not valid UTF-8 text")]
    NotUtf8,
    /// The input is larger than [`MAX_IMPORT_BYTES`].
    #[error("the input is larger than {MAX_IMPORT_BYTES} bytes")]
    TooLarge,
}

/// Reads CSV from `reader` and imports it. See [`import_csv_str`].
pub fn import_csv_reader<R, C>(
    mut reader: R,
    codec: &C,
    options: &ImportOptions,
) -> Result<ImportReport, ImportError>
where
    R: Read,
    C: AddressCodec + ?Sized,
{
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take(MAX_IMPORT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_IMPORT_BYTES {
        return Err(ImportError::TooLarge);
    }
    let text = String::from_utf8(bytes).map_err(|_| ImportError::NotUtf8)?;
    Ok(import_csv_str(&text, codec, options))
}

/// Imports recipients from CSV text.
///
/// Every problem is reported with a 1-based line number; nothing is skipped or
/// truncated silently. Only lines that are wholly empty are ignored. A row can
/// produce several errors (for example a bad address and a bad amount).
pub fn import_csv_str<C>(input: &str, codec: &C, options: &ImportOptions) -> ImportReport
where
    C: AddressCodec + ?Sized,
{
    let input = input.strip_prefix('\u{feff}').unwrap_or(input);
    let delimiter = detect_delimiter(input);
    let mut records = tokenize(input, delimiter).into_iter();
    let mut report = ImportReport::default();

    let Some(header_record) = records.next() else {
        report.errors.push(RowError {
            line: 1,
            kind: RowErrorKind::MissingHeader,
        });
        return report;
    };
    let columns = match parse_header(&header_record) {
        Ok(columns) => columns,
        Err(errors) => {
            report.errors = errors;
            return report;
        }
    };

    // Canonical address -> line of its first occurrence.
    let mut seen: HashMap<String, u64> = HashMap::new();
    for record in records {
        import_record(&record, &columns, codec, options, &mut seen, &mut report);
    }
    report
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/// Column positions resolved from the header.
struct Columns {
    address: usize,
    amount: usize,
    memo: Option<usize>,
    width: usize,
}

fn parse_header(record: &Record) -> Result<Columns, Vec<RowError>> {
    let line = record.line;
    let err = |kind| RowError { line, kind };

    if let Some(issue) = record.issue {
        return Err(vec![err(issue.kind())]);
    }

    let mut address = None;
    let mut amount = None;
    let mut memo = None;
    let mut errors = Vec::new();
    let mut recognized = 0usize;

    for (i, cell) in record.fields.iter().enumerate() {
        let (slot, name) = match cell.trim().to_ascii_lowercase().as_str() {
            "address" => (&mut address, "address"),
            "amount" => (&mut amount, "amount"),
            "memo" => (&mut memo, "memo"),
            _ => {
                errors.push(err(RowErrorKind::UnknownColumn { position: i + 1 }));
                continue;
            }
        };
        recognized += 1;
        if slot.is_some() {
            errors.push(err(RowErrorKind::DuplicateColumn { name }));
        } else {
            *slot = Some(i);
        }
    }

    if recognized == 0 {
        return Err(vec![err(RowErrorKind::MissingHeader)]);
    }
    if address.is_none() {
        errors.push(err(RowErrorKind::MissingColumn { name: "address" }));
    }
    if amount.is_none() {
        errors.push(err(RowErrorKind::MissingColumn { name: "amount" }));
    }
    match (address, amount) {
        (Some(address), Some(amount)) if errors.is_empty() => Ok(Columns {
            address,
            amount,
            memo,
            width: record.fields.len(),
        }),
        _ => Err(errors),
    }
}

/// Picks `;` over `,` when the header line has more unquoted semicolons than commas.
fn detect_delimiter(input: &str) -> char {
    let header = input
        .trim_start_matches(['\n', '\r'])
        .split(['\n', '\r'])
        .next()
        .unwrap_or("");
    let (mut commas, mut semicolons, mut in_quotes) = (0usize, 0usize, false);
    for c in header.chars() {
        match c {
            '"' => in_quotes = !in_quotes,
            ',' if !in_quotes => commas += 1,
            ';' if !in_quotes => semicolons += 1,
            _ => {}
        }
    }
    if semicolons > commas {
        ';'
    } else {
        ','
    }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

fn import_record<C>(
    record: &Record,
    columns: &Columns,
    codec: &C,
    options: &ImportOptions,
    seen: &mut HashMap<String, u64>,
    report: &mut ImportReport,
) where
    C: AddressCodec + ?Sized,
{
    let line = record.line;
    let first_error = report.errors.len();
    let mut fail = |kind| report.errors.push(RowError { line, kind });

    if let Some(issue) = record.issue {
        fail(issue.kind());
        return;
    }
    if record.fields.len() != columns.width {
        fail(RowErrorKind::FieldCount {
            expected: columns.width,
            found: record.fields.len(),
        });
        return;
    }

    // Cells are indexed through `get`, which cannot fail because the width matches.
    let cell = |index: usize| record.fields.get(index).map_or("", String::as_str);

    // Address.
    let address = cell(columns.address).trim();
    let mut address_ok = false;
    if address.is_empty() {
        fail(RowErrorKind::MissingAddress);
    } else {
        match codec
            .validate(address)
            .and_then(|kind| check_policy(kind, options.allow_transparent))
        {
            Ok(()) => address_ok = true,
            Err(reason) => fail(RowErrorKind::InvalidAddress { reason }),
        }
    }

    // Duplicate detection runs for any valid address, even when another cell on
    // the row is bad, so one fix pass is enough for the user.
    if address_ok {
        match seen.entry(codec.canonical(address)) {
            std::collections::hash_map::Entry::Occupied(first) => {
                fail(RowErrorKind::DuplicateAddress {
                    first_line: *first.get(),
                });
            }
            std::collections::hash_map::Entry::Vacant(slot) => {
                slot.insert(line);
            }
        }
    }

    // Amount.
    let amount = match Zatoshi::parse_zec(cell(columns.amount).trim()) {
        Ok(amount) if amount.is_zero() => {
            fail(RowErrorKind::ZeroAmount);
            None
        }
        Ok(amount) => Some(amount),
        Err(reason) => {
            fail(RowErrorKind::InvalidAmount { reason });
            None
        }
    };

    // Memo.
    let memo = columns.memo.map(cell).filter(|m| !m.is_empty());
    let mut memo_ok = true;
    if let Some(memo) = memo {
        if check_memo(memo).is_err() {
            memo_ok = false;
            fail(RowErrorKind::MemoTooLong {
                bytes: memo.len(),
                max: MAX_MEMO_BYTES,
            });
        }
    }

    if report.errors.len() != first_error || !address_ok || !memo_ok {
        return;
    }
    if let Some(amount) = amount {
        match Recipient::new(address, amount, memo.map(str::to_owned)) {
            Ok(recipient) => report.rows.push(recipient),
            Err(error) => report.errors.push(RowError {
                line,
                kind: kind_for(error),
            }),
        }
    }
}

/// Maps a recipient constructor failure onto the row error vocabulary.
fn kind_for(error: RecipientError) -> RowErrorKind {
    match error {
        RecipientError::EmptyAddress => RowErrorKind::MissingAddress,
        RecipientError::AddressTooLong { .. } => RowErrorKind::InvalidAddress {
            reason: AddressError::Malformed {
                reason: "address is too long",
            },
        },
        RecipientError::ZeroAmount => RowErrorKind::ZeroAmount,
        RecipientError::MemoTooLong { bytes, max } => RowErrorKind::MemoTooLong { bytes, max },
    }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/// A quoting problem found while reading a record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QuoteIssue {
    Unterminated,
    Malformed,
}

impl QuoteIssue {
    fn kind(self) -> RowErrorKind {
        match self {
            QuoteIssue::Unterminated => RowErrorKind::UnterminatedQuote,
            QuoteIssue::Malformed => RowErrorKind::MalformedQuote,
        }
    }
}

/// One CSV record and the line it starts on.
#[derive(Debug)]
struct Record {
    line: u64,
    fields: Vec<String>,
    issue: Option<QuoteIssue>,
}

/// Splits `input` into records. Wholly empty lines are skipped; everything else
/// becomes a record. Never panics and never discards text silently.
fn tokenize(input: &str, delimiter: char) -> Vec<Record> {
    let mut chars = input.chars().peekable();
    let mut records = Vec::new();
    let mut line: u64 = 1;

    // Consumes one line terminator (`\n`, `\r\n` or `\r`) if present.
    fn eat_newline(chars: &mut std::iter::Peekable<std::str::Chars<'_>>, line: &mut u64) -> bool {
        match chars.peek() {
            Some('\n') => {
                chars.next();
            }
            Some('\r') => {
                chars.next();
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
            }
            _ => return false,
        }
        *line += 1;
        true
    }

    loop {
        // Skip wholly empty lines.
        if eat_newline(&mut chars, &mut line) {
            continue;
        }
        if chars.peek().is_none() {
            break;
        }

        let start_line = line;
        let mut fields = Vec::new();
        let mut issue = None;

        loop {
            let mut field = String::new();
            if chars.peek() == Some(&'"') {
                chars.next();
                let mut closed = false;
                while let Some(c) = chars.next() {
                    match c {
                        '"' if chars.peek() == Some(&'"') => {
                            chars.next();
                            field.push('"');
                        }
                        '"' => {
                            closed = true;
                            break;
                        }
                        '\n' => {
                            line += 1;
                            field.push('\n');
                        }
                        '\r' => {
                            if chars.peek() == Some(&'\n') {
                                chars.next();
                                field.push_str("\r\n");
                            } else {
                                field.push('\r');
                            }
                            line += 1;
                        }
                        other => field.push(other),
                    }
                }
                if !closed {
                    issue = Some(QuoteIssue::Unterminated);
                } else if let Some(&next) = chars.peek() {
                    if next != delimiter && next != '\n' && next != '\r' {
                        // Text after the closing quote: flag it and skip to the cell end.
                        issue.get_or_insert(QuoteIssue::Malformed);
                        while let Some(&c) = chars.peek() {
                            if c == delimiter || c == '\n' || c == '\r' {
                                break;
                            }
                            chars.next();
                        }
                    }
                }
            } else {
                while let Some(&c) = chars.peek() {
                    if c == delimiter || c == '\n' || c == '\r' {
                        break;
                    }
                    if c == '"' {
                        issue.get_or_insert(QuoteIssue::Malformed);
                    }
                    field.push(c);
                    chars.next();
                }
            }
            fields.push(field);

            if chars.peek() == Some(&delimiter) {
                chars.next();
                continue;
            }
            break;
        }

        eat_newline(&mut chars, &mut line);
        records.push(Record {
            line: start_line,
            fields,
            issue,
        });
    }
    records
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::PermissiveCodec;
    use proptest::prelude::*;

    const A1: &str = "u1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const A2: &str = "u1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const A3: &str = "zs1cccccccccccccccccccccccccccccc";

    fn run(input: &str) -> ImportReport {
        import_csv_str(input, &PermissiveCodec, &ImportOptions::default())
    }

    fn kinds(report: &ImportReport) -> Vec<(u64, RowErrorKind)> {
        report
            .errors
            .iter()
            .map(|e| (e.line, e.kind.clone()))
            .collect()
    }

    // covers: REQ-IMP-001
    #[test]
    fn imports_a_clean_file() {
        let csv = format!("address,amount,memo\n{A1},1.5,hello\n{A2},0.25,\n{A3},3,\n");
        let report = run(&csv);
        assert!(report.is_clean(), "{:?}", report.errors);
        assert_eq!(report.rows.len(), 3);
        assert_eq!(report.rows[0].address(), A1);
        assert_eq!(report.rows[0].amount().as_u64(), 150_000_000);
        assert_eq!(report.rows[0].memo(), Some("hello"));
        assert_eq!(report.rows[1].memo(), None);
        assert_eq!(report.rows[2].amount().as_u64(), 300_000_000);
    }

    // covers: REQ-IMP-001
    #[test]
    fn header_is_case_insensitive_order_flexible_and_memo_optional() {
        let report = run(&format!(" Amount , ADDRESS \n2,{A1}\n"));
        assert!(report.is_clean(), "{:?}", report.errors);
        assert_eq!(report.rows[0].address(), A1);
        assert_eq!(report.rows[0].amount().as_u64(), 200_000_000);

        let report = run(&format!("memo,amount,address\nhi,1,{A1}\n"));
        assert!(report.is_clean(), "{:?}", report.errors);
        assert_eq!(report.rows[0].memo(), Some("hi"));
    }

    // covers: REQ-IMP-001
    #[test]
    fn missing_or_wrong_header_is_reported() {
        assert_eq!(kinds(&run("")), vec![(1, RowErrorKind::MissingHeader)]);
        // A file whose first row is data, not a header.
        assert_eq!(
            kinds(&run(&format!("{A1},1\n{A2},2\n"))),
            vec![(1, RowErrorKind::MissingHeader)]
        );
        assert_eq!(
            kinds(&run("address\n")),
            vec![(1, RowErrorKind::MissingColumn { name: "amount" })]
        );
        assert_eq!(
            kinds(&run("amount\n")),
            vec![(1, RowErrorKind::MissingColumn { name: "address" })]
        );
        assert_eq!(
            kinds(&run("address,amount,amount\n")),
            vec![(1, RowErrorKind::DuplicateColumn { name: "amount" })]
        );
        // An extra column could carry data, so it is an error rather than ignored.
        assert_eq!(
            kinds(&run("address,amount,note\n")),
            vec![(1, RowErrorKind::UnknownColumn { position: 3 })]
        );
    }

    // covers: REQ-IMP-001
    #[test]
    fn tolerates_bom_and_crlf() {
        let csv = format!("\u{feff}address,amount\r\n{A1},1\r\n{A2},2\r\n");
        let report = run(&csv);
        assert!(report.is_clean(), "{:?}", report.errors);
        assert_eq!(report.rows.len(), 2);
        assert_eq!(report.rows[1].address(), A2);
    }

    // covers: REQ-IMP-001
    #[test]
    fn tolerates_old_style_cr_only_line_endings() {
        let report = run(&format!("address,amount\r{A1},1\r{A2},2"));
        assert!(report.is_clean(), "{:?}", report.errors);
        assert_eq!(report.rows.len(), 2);
    }

    // covers: REQ-IMP-001
    #[test]
    fn quoted_fields_with_commas_quotes_and_newlines() {
        let csv = format!(
            "address,amount,memo\n{A1},1,\"hello, world\"\n{A2},2,\"she said \"\"hi\"\"\"\n{A3},3,\"line one\nline two\"\n"
        );
        let report = run(&csv);
        assert!(report.is_clean(), "{:?}", report.errors);
        assert_eq!(report.rows[0].memo(), Some("hello, world"));
        assert_eq!(report.rows[1].memo(), Some("she said \"hi\""));
        assert_eq!(report.rows[2].memo(), Some("line one\nline two"));
    }

    // covers: REQ-IMP-001
    #[test]
    fn line_numbers_account_for_multiline_quoted_fields() {
        let csv = format!("address,amount,memo\n{A1},1,\"a\nb\nc\"\n{A2},not-a-number,x\n");
        let report = run(&csv);
        // Row 1 spans lines 2-4, so the bad row is on line 5.
        assert_eq!(
            kinds(&report),
            vec![(
                5,
                RowErrorKind::InvalidAmount {
                    reason: AmountError::InvalidCharacter
                }
            )]
        );
        assert_eq!(report.rows.len(), 1);
    }

    // covers: REQ-IMP-001
    #[test]
    fn detects_semicolon_delimiter() {
        let csv = format!("address;amount;memo\n{A1};1.5;\"a;b\"\n{A2};2;\n");
        let report = run(&csv);
        assert!(report.is_clean(), "{:?}", report.errors);
        assert_eq!(report.rows[0].memo(), Some("a;b"));
        assert_eq!(report.rows[1].amount().as_u64(), 200_000_000);
    }

    // covers: REQ-IMP-001
    #[test]
    fn decimal_comma_under_semicolon_delimiter_is_an_error_not_a_misread() {
        let report = run(&format!("address;amount\n{A1};1,5\n"));
        assert_eq!(
            kinds(&report),
            vec![(
                2,
                RowErrorKind::InvalidAmount {
                    reason: AmountError::InvalidCharacter
                }
            )]
        );
    }

    // covers: REQ-IMP-001
    #[test]
    fn reports_all_errors_with_one_based_lines() {
        let csv = format!(
            "address,amount,memo\n\
             {A1},1,ok\n\
             {A2},-1,\n\
             \n\
             {A3},1e3,\n\
             bad address!,5,\n\
             {A1},2,\n\
             {A2},0,\n\
             {A2},1,{}\n\
             ,1,\n",
            "m".repeat(513)
        );
        let report = run(&csv);
        assert_eq!(report.rows.len(), 1, "only the first row is clean");
        assert_eq!(
            kinds(&report),
            vec![
                (
                    3,
                    RowErrorKind::InvalidAmount {
                        reason: AmountError::Negative
                    }
                ),
                (
                    5,
                    RowErrorKind::InvalidAmount {
                        reason: AmountError::ScientificNotation
                    }
                ),
                (
                    6,
                    RowErrorKind::InvalidAddress {
                        reason: AddressError::Malformed {
                            reason: "unexpected character"
                        }
                    }
                ),
                (7, RowErrorKind::DuplicateAddress { first_line: 2 }),
                // Line 8 repeats line 3's address; line 3 failed on its amount but
                // its address still counts as seen.
                (8, RowErrorKind::DuplicateAddress { first_line: 3 }),
                (8, RowErrorKind::ZeroAmount),
                (9, RowErrorKind::DuplicateAddress { first_line: 3 }),
                (
                    9,
                    RowErrorKind::MemoTooLong {
                        bytes: 513,
                        max: 512
                    }
                ),
                (10, RowErrorKind::MissingAddress),
            ]
        );
    }

    // covers: REQ-IMP-001
    #[test]
    fn duplicate_error_is_on_the_later_line_and_names_the_first() {
        let report = run(&format!("address,amount\n{A1},1\n{A2},2\n{A1},3\n"));
        assert_eq!(
            kinds(&report),
            vec![(4, RowErrorKind::DuplicateAddress { first_line: 2 })]
        );
        assert_eq!(report.rows.len(), 2, "the first occurrence is kept");
        let message = report.errors[0].to_string();
        assert!(
            message.contains("line 4") && message.contains("line 2"),
            "{message}"
        );
    }

    /// A codec whose canonical form ignores ASCII case, like Bech32 addresses.
    struct CaseFolding;
    impl AddressCodec for CaseFolding {
        fn validate(&self, a: &str) -> Result<crate::codec::RecipientKind, AddressError> {
            PermissiveCodec.validate(a)
        }
        fn canonical(&self, a: &str) -> String {
            a.to_ascii_lowercase()
        }
    }

    // covers: REQ-IMP-001
    #[test]
    fn duplicates_use_the_codec_canonical_form() {
        let csv = "address,amount\nu1abcdef,1\nu1ABCDEF,2\n";
        let report = import_csv_str(csv, &CaseFolding, &ImportOptions::default());
        assert_eq!(
            kinds(&report),
            vec![(3, RowErrorKind::DuplicateAddress { first_line: 2 })]
        );
        // With the identity canonical form the two spellings are different addresses.
        let report = run(csv);
        assert!(report.is_clean());
        assert_eq!(report.rows.len(), 2);
    }

    // covers: REQ-IMP-001
    #[test]
    fn memo_limit_is_512_bytes_not_characters() {
        let ok = "é".repeat(256); // 512 bytes
        let bad = "é".repeat(257); // 514 bytes
        let report = run(&format!("address,amount,memo\n{A1},1,{ok}\n{A2},1,{bad}\n"));
        assert_eq!(report.rows.len(), 1);
        assert_eq!(
            kinds(&report),
            vec![(
                3,
                RowErrorKind::MemoTooLong {
                    bytes: 514,
                    max: 512
                }
            )]
        );
    }

    // covers: REQ-IMP-001
    #[test]
    fn transparent_addresses_are_rejected_unless_allowed() {
        let csv = "address,amount\nt1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,1\n";
        let report = run(csv);
        assert_eq!(
            kinds(&report),
            vec![(
                2,
                RowErrorKind::InvalidAddress {
                    reason: AddressError::TransparentNotAllowed
                }
            )]
        );
        let allowed = import_csv_str(
            csv,
            &PermissiveCodec,
            &ImportOptions {
                allow_transparent: true,
            },
        );
        assert!(allowed.is_clean());
        assert_eq!(allowed.rows.len(), 1);
    }

    // covers: REQ-IMP-001
    #[test]
    fn blank_lines_are_skipped_only_when_wholly_empty() {
        let csv = format!("address,amount\n\n{A1},1\n\n\n{A2},2\n");
        let report = run(&csv);
        assert!(report.is_clean());
        assert_eq!(report.rows.len(), 2);

        // Whitespace-only and delimiter-only lines are errors, not skipped.
        let report = run(&format!("address,amount\n   \n,\n{A1},1\n"));
        assert_eq!(
            kinds(&report),
            vec![
                (
                    2,
                    RowErrorKind::FieldCount {
                        expected: 2,
                        found: 1
                    }
                ),
                (3, RowErrorKind::MissingAddress),
                (
                    3,
                    RowErrorKind::InvalidAmount {
                        reason: AmountError::Empty
                    }
                ),
            ]
        );
        assert_eq!(report.rows.len(), 1);
    }

    // covers: REQ-IMP-001
    #[test]
    fn wrong_field_count_is_reported_not_padded() {
        let report = run(&format!(
            "address,amount,memo\n{A1},1\n{A2},2,m,extra\n{A3},3,ok\n"
        ));
        assert_eq!(
            kinds(&report),
            vec![
                (
                    2,
                    RowErrorKind::FieldCount {
                        expected: 3,
                        found: 2
                    }
                ),
                (
                    3,
                    RowErrorKind::FieldCount {
                        expected: 3,
                        found: 4
                    }
                ),
            ]
        );
        assert_eq!(report.rows.len(), 1);
    }

    // covers: REQ-IMP-001
    #[test]
    fn unterminated_quote_is_an_error_not_a_swallowed_tail() {
        let csv = format!("address,amount,memo\n{A1},1,\"never closed\n{A2},2,x\n{A3},3,y\n");
        let report = run(&csv);
        assert_eq!(kinds(&report), vec![(2, RowErrorKind::UnterminatedQuote)]);
        assert!(report.rows.is_empty());
    }

    // covers: REQ-IMP-001
    #[test]
    fn stray_quotes_are_errors() {
        let csv =
            format!("address,amount,memo\n{A1},1,5\" pipe\n{A2},2,\"closed\"junk\n{A3},3,fine\n");
        let report = run(&csv);
        assert_eq!(
            kinds(&report),
            vec![
                (2, RowErrorKind::MalformedQuote),
                (3, RowErrorKind::MalformedQuote)
            ]
        );
        assert_eq!(report.rows.len(), 1);
        assert_eq!(report.rows[0].address(), A3);
    }

    // covers: REQ-IMP-001
    #[test]
    fn rows_are_neither_dropped_nor_truncated() {
        // 1000 good rows and a bad one at the end: all 1000 survive, the bad one is reported.
        let mut csv = String::from("address,amount\n");
        for i in 0..1000 {
            csv.push_str(&format!("u1addr{i:040},1\n"));
        }
        csv.push_str("u1bad,xyz\n");
        let report = run(&csv);
        assert_eq!(report.rows.len(), 1000);
        assert_eq!(report.errors.len(), 1);
        assert_eq!(report.errors[0].line, 1002);
    }

    // covers: REQ-IMP-001
    #[test]
    fn reader_entry_point_rejects_bad_utf8_and_oversize() {
        let good = format!("address,amount\n{A1},1\n");
        let report =
            import_csv_reader(good.as_bytes(), &PermissiveCodec, &ImportOptions::default())
                .unwrap();
        assert!(report.is_clean());

        let bad = b"address,amount\n\xff\xfe,1\n";
        assert!(matches!(
            import_csv_reader(&bad[..], &PermissiveCodec, &ImportOptions::default()),
            Err(ImportError::NotUtf8)
        ));

        struct Endless;
        impl Read for Endless {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                buf.fill(b'a');
                Ok(buf.len())
            }
        }
        assert!(matches!(
            import_csv_reader(Endless, &PermissiveCodec, &ImportOptions::default()),
            Err(ImportError::TooLarge)
        ));
    }

    // covers: REQ-IMP-001
    #[test]
    fn into_result_splits_clean_from_dirty() {
        let clean = run(&format!("address,amount\n{A1},1\n"));
        assert_eq!(clean.into_result().unwrap().len(), 1);
        let dirty = run(&format!("address,amount\n{A1},x\n"));
        assert_eq!(dirty.into_result().unwrap_err().len(), 1);
    }

    // covers: REQ-IMP-001
    #[test]
    fn row_error_serializes_with_line_code_and_message() {
        let report = run(&format!("address,amount\n{A1},1\n{A1},2\n"));
        let json = serde_json::to_value(&report.errors[0]).unwrap();
        assert_eq!(json["line"], 3);
        assert_eq!(json["kind"]["code"], "duplicate_address");
        assert_eq!(json["kind"]["first_line"], 2);
        assert!(json["message"].as_str().unwrap().contains("line 2"));
    }

    // covers: REQ-PRIV-002
    #[test]
    fn row_errors_never_contain_the_offending_address_amount_or_memo() {
        let secret_addr = "u1sentinelsecretaddress0000000000000000";
        let csv = format!(
            "address,amount,memo\n\
             {secret_addr},1,ok\n\
             {secret_addr},sentinel-amount-777,secretmemo\n\
             {secret_addr}!bad,1.123456789,\"unterminated sentinel memo\n"
        );
        let report = run(&csv);
        assert!(!report.errors.is_empty());
        let mut texts = vec![format!("{report:?}")];
        for e in &report.errors {
            texts.push(e.to_string());
            texts.push(format!("{e:?}"));
            texts.push(format!("{:?}", e.kind));
            texts.push(serde_json::to_string(e).unwrap());
        }
        // The valid first row is in `rows`, whose Debug is redacted too.
        for text in texts {
            for needle in [
                "sentinelsecret",
                "sentinel-amount",
                "777",
                "secretmemo",
                "unterminated sentinel",
                "1.123456789",
            ] {
                assert!(!text.contains(needle), "leaked {needle:?} in {text}");
            }
        }
    }

    // covers: REQ-IMP-001
    #[test]
    fn tokenizer_handles_edge_shapes() {
        let t = |s: &str| {
            tokenize(s, ',')
                .into_iter()
                .map(|r| (r.line, r.fields))
                .collect::<Vec<_>>()
        };
        assert_eq!(t("a,b"), vec![(1, vec!["a".into(), "b".into()])]);
        assert_eq!(
            t("a,b,"),
            vec![(1, vec!["a".into(), "b".into(), "".into()])]
        );
        assert_eq!(
            t("a\n\nb"),
            vec![(1, vec!["a".into()]), (3, vec!["b".into()])]
        );
        assert_eq!(t("\"\""), vec![(1, vec!["".into()])]);
        assert_eq!(
            t("\"a\r\nb\",c"),
            vec![(1, vec!["a\r\nb".into(), "c".into()])]
        );
        assert!(t("").is_empty());
        assert!(t("\n\r\n\r").is_empty());
    }

    proptest! {
        // covers: REQ-IMP-001
        #[test]
        fn tokenizer_round_trips_quoted_cells(
            cells in proptest::collection::vec(
                proptest::collection::vec("[ -~\n\r,;\"é]{0,12}", 1..5), 1..6)
        ) {
            // Serialize every cell quoted, then read back: the cells must survive intact.
            let quote = |c: &str| format!("\"{}\"", c.replace('"', "\"\""));
            let text: String = cells
                .iter()
                .map(|row| row.iter().map(|c| quote(c)).collect::<Vec<_>>().join(","))
                .collect::<Vec<_>>()
                .join("\n");
            let parsed = tokenize(&text, ',');
            prop_assert_eq!(parsed.len(), cells.len());
            for (record, row) in parsed.iter().zip(&cells) {
                prop_assert!(record.issue.is_none());
                // Bare `\r` inside quotes is preserved as `\r`, and `\r\n` as `\r\n`.
                prop_assert_eq!(&record.fields, row);
            }
        }

        // covers: REQ-IMP-001
        #[test]
        fn import_never_panics_and_accounts_for_every_record(s in "\\PC{0,120}") {
            let report = import_csv_str(&s, &PermissiveCodec, &ImportOptions::default());
            // Every produced row is valid and all line numbers are 1-based.
            for e in &report.errors {
                prop_assert!(e.line >= 1);
            }
            for r in &report.rows {
                prop_assert!(!r.amount().is_zero());
            }
        }

        // covers: REQ-IMP-001
        #[test]
        fn valid_files_import_every_row_in_order(
            amounts in proptest::collection::vec(1u64..1_000_000_000, 1..40)
        ) {
            let mut csv = String::from("address,amount\n");
            for (i, a) in amounts.iter().enumerate() {
                csv.push_str(&format!("u1row{i:040},{}\n", Zatoshi::new(*a).unwrap().format_zec()));
            }
            let report = run(&csv);
            prop_assert!(report.is_clean());
            prop_assert_eq!(report.rows.len(), amounts.len());
            for (row, a) in report.rows.iter().zip(&amounts) {
                prop_assert_eq!(row.amount().as_u64(), *a);
            }
        }
    }
}

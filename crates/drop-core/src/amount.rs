//! Money handling. Amounts are whole zatoshi in a `u64`; floats are never used.

use std::fmt;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::error::AmountError;

/// Zatoshi in one ZEC.
pub const ZATOSHI_PER_ZEC: u64 = 100_000_000;

/// The maximum possible supply in zatoshi (21,000,000 ZEC). No valid amount or sum exceeds it.
pub const MAX_MONEY: u64 = 21_000_000 * ZATOSHI_PER_ZEC;

/// Number of digits after the decimal point in a ZEC amount.
const DECIMALS: usize = 8;

/// An amount of zatoshi, guaranteed to be at most [`MAX_MONEY`].
///
/// The range invariant is enforced by every constructor, so values can be added
/// without risk of `u64` overflow; [`Zatoshi::checked_add`] still reports any sum
/// above [`MAX_MONEY`] as an error rather than wrapping or saturating.
///
/// In JSON an amount is a decimal **string** (`"150000000"`), because JavaScript
/// numbers cannot hold every `u64` exactly.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Zatoshi(u64);

impl Zatoshi {
    /// Zero zatoshi.
    pub const ZERO: Zatoshi = Zatoshi(0);

    /// The largest representable amount, [`MAX_MONEY`].
    pub const MAX: Zatoshi = Zatoshi(MAX_MONEY);

    /// Wraps a raw zatoshi count, rejecting anything above [`MAX_MONEY`].
    pub fn new(zatoshi: u64) -> Result<Self, AmountError> {
        if zatoshi > MAX_MONEY {
            return Err(AmountError::ExceedsMaxMoney);
        }
        Ok(Zatoshi(zatoshi))
    }

    /// The raw zatoshi count.
    pub const fn as_u64(self) -> u64 {
        self.0
    }

    /// Whether this amount is zero.
    pub const fn is_zero(self) -> bool {
        self.0 == 0
    }

    /// Adds two amounts; a result above [`MAX_MONEY`] is an error.
    pub fn checked_add(self, rhs: Zatoshi) -> Result<Zatoshi, AmountError> {
        self.0
            .checked_add(rhs.0)
            .ok_or(AmountError::ExceedsMaxMoney)
            .and_then(Zatoshi::new)
    }

    /// Sums amounts with checked arithmetic. Any partial or final sum above
    /// [`MAX_MONEY`] is an error; the sum never wraps or saturates.
    pub fn checked_sum<I>(amounts: I) -> Result<Zatoshi, AmountError>
    where
        I: IntoIterator<Item = Zatoshi>,
    {
        amounts
            .into_iter()
            .try_fold(Zatoshi::ZERO, Zatoshi::checked_add)
    }

    /// Parses a decimal ZEC string such as `"1"`, `"0.5"` or `"12.34567890"`.
    ///
    /// Accepted: ASCII digits with at most one `.`, digits on both sides of the
    /// point, at most eight fractional digits, and a value of at most 21,000,000 ZEC.
    ///
    /// Rejected: empty or whitespace-only input, leading or trailing whitespace,
    /// signs (`-1`, `+1`), exponent notation (`1e3`), `.5` and `1.`, nine or more
    /// decimals (which also catches float artifacts like `0.30000000000000004`),
    /// thousands separators, non-ASCII digits, `NaN`/`inf`, and anything above
    /// [`MAX_MONEY`]. Zero is accepted here; the importer rejects it per recipient.
    pub fn parse_zec(s: &str) -> Result<Self, AmountError> {
        if s.trim().is_empty() {
            return Err(AmountError::Empty);
        }
        if s.starts_with('-') {
            return Err(AmountError::Negative);
        }

        let bytes = s.as_bytes();
        for (i, &b) in bytes.iter().enumerate() {
            match b {
                b'0'..=b'9' | b'.' => {}
                b'e' | b'E' if i > 0 && bytes[i - 1].is_ascii_digit() => {
                    return Err(AmountError::ScientificNotation)
                }
                _ => return Err(AmountError::InvalidCharacter),
            }
        }

        let (int_part, frac_part) = match s.split_once('.') {
            Some((int_part, frac_part)) => (int_part, Some(frac_part)),
            None => (s, None),
        };
        if int_part.is_empty() {
            return Err(AmountError::MalformedDecimal);
        }
        if let Some(frac) = frac_part {
            if frac.is_empty() || frac.contains('.') {
                return Err(AmountError::MalformedDecimal);
            }
            if frac.len() > DECIMALS {
                return Err(AmountError::TooManyDecimals);
            }
        }

        let max_whole = MAX_MONEY / ZATOSHI_PER_ZEC;
        let mut whole: u64 = 0;
        for b in int_part.bytes() {
            whole = whole * 10 + u64::from(b - b'0');
            if whole > max_whole {
                return Err(AmountError::ExceedsMaxMoney);
            }
        }

        let mut fraction: u64 = 0;
        let frac_digits = frac_part.unwrap_or("");
        for b in frac_digits.bytes() {
            fraction = fraction * 10 + u64::from(b - b'0');
        }
        for _ in frac_digits.len()..DECIMALS {
            fraction *= 10;
        }

        // whole <= 21_000_000 and fraction < 10^8, so this cannot overflow.
        Zatoshi::new(whole * ZATOSHI_PER_ZEC + fraction)
    }

    /// Formats as decimal ZEC: the exact inverse of [`Zatoshi::parse_zec`].
    ///
    /// Trailing zeros after the point are trimmed (and the point itself when the
    /// fraction is zero); at least one integer digit is always printed.
    pub fn format_zec(self) -> String {
        let whole = self.0 / ZATOSHI_PER_ZEC;
        let fraction = self.0 % ZATOSHI_PER_ZEC;
        if fraction == 0 {
            return whole.to_string();
        }
        let padded = format!("{fraction:08}");
        format!("{whole}.{}", padded.trim_end_matches('0'))
    }
}

impl fmt::Display for Zatoshi {
    /// Formats as decimal ZEC without a unit suffix, like [`Zatoshi::format_zec`].
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.format_zec())
    }
}

impl TryFrom<u64> for Zatoshi {
    type Error = AmountError;

    fn try_from(value: u64) -> Result<Self, Self::Error> {
        Zatoshi::new(value)
    }
}

impl Serialize for Zatoshi {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Zatoshi {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
            return Err(D::Error::custom(
                "zatoshi must be a string of decimal digits",
            ));
        }
        let raw: u64 = text.parse().map_err(D::Error::custom)?;
        Zatoshi::new(raw).map_err(D::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn z(s: &str) -> Zatoshi {
        Zatoshi::parse_zec(s).expect("valid amount")
    }

    // covers: REQ-AMT-001
    #[test]
    fn parses_valid_amounts() {
        assert_eq!(z("1").as_u64(), 100_000_000);
        assert_eq!(z("0.5").as_u64(), 50_000_000);
        assert_eq!(z("12.34567890").as_u64(), 1_234_567_890);
        assert_eq!(z("0").as_u64(), 0);
        assert_eq!(z("0.00000001").as_u64(), 1);
        assert_eq!(z("007.50").as_u64(), 750_000_000);
        assert_eq!(z("21000000").as_u64(), MAX_MONEY);
        assert_eq!(z("21000000.00000000").as_u64(), MAX_MONEY);
    }

    // covers: REQ-AMT-001
    #[test]
    fn rejects_empty_and_whitespace_only() {
        for s in ["", " ", "   ", "\t", "\n", " \t\r\n"] {
            assert_eq!(Zatoshi::parse_zec(s), Err(AmountError::Empty), "{s:?}");
        }
    }

    // covers: REQ-AMT-001
    #[test]
    fn rejects_negative() {
        for s in ["-1", "-0", "-0.5", "-"] {
            assert_eq!(Zatoshi::parse_zec(s), Err(AmountError::Negative), "{s:?}");
        }
    }

    // covers: REQ-AMT-001
    #[test]
    fn rejects_exponent_notation() {
        for s in ["1e3", "1E3", "1.5e3", "2e-2", "0e0"] {
            assert_eq!(
                Zatoshi::parse_zec(s),
                Err(AmountError::ScientificNotation),
                "{s:?}"
            );
        }
    }

    // covers: REQ-AMT-001
    #[test]
    fn rejects_float_artifacts_and_nine_or_more_decimals() {
        for s in [
            "0.30000000000000004",
            "0.123456789",
            "1.000000000",
            "99.999999999",
        ] {
            assert_eq!(
                Zatoshi::parse_zec(s),
                Err(AmountError::TooManyDecimals),
                "{s:?}"
            );
        }
        for s in ["NaN", "inf", "Infinity", "-inf"] {
            assert!(Zatoshi::parse_zec(s).is_err(), "{s:?}");
        }
    }

    // covers: REQ-AMT-001
    #[test]
    fn rejects_separators_signs_and_stray_whitespace() {
        for s in [
            "1,000", "1,5", "1_000", "1 000", " 1", "1 ", "+1", "1.5.2", "0x10", "1f", "$1",
        ] {
            assert!(Zatoshi::parse_zec(s).is_err(), "{s:?} should be rejected");
        }
        assert_eq!(
            Zatoshi::parse_zec("1,000"),
            Err(AmountError::InvalidCharacter)
        );
    }

    // covers: REQ-AMT-001
    #[test]
    fn rejects_malformed_decimal_points() {
        for s in [".5", "1.", ".", "1..5", "1.5.2"] {
            assert_eq!(
                Zatoshi::parse_zec(s),
                Err(AmountError::MalformedDecimal),
                "{s:?}"
            );
        }
    }

    // covers: REQ-AMT-001
    #[test]
    fn rejects_non_ascii_digits() {
        // Arabic-Indic, fullwidth, superscript and Devanagari digits.
        for s in ["١٢٣", "１２３", "1²", "१२३", "1.５"] {
            assert_eq!(
                Zatoshi::parse_zec(s),
                Err(AmountError::InvalidCharacter),
                "{s:?}"
            );
        }
    }

    // covers: REQ-AMT-001
    #[test]
    fn rejects_over_max_money() {
        assert_eq!(
            Zatoshi::parse_zec("21000000.00000001"),
            Err(AmountError::ExceedsMaxMoney)
        );
        assert_eq!(
            Zatoshi::parse_zec("21000001"),
            Err(AmountError::ExceedsMaxMoney)
        );
        // Far beyond u64: must be an error, not an overflow panic or wrap.
        assert_eq!(
            Zatoshi::parse_zec("99999999999999999999999999999999"),
            Err(AmountError::ExceedsMaxMoney)
        );
    }

    // covers: REQ-AMT-001
    #[test]
    fn formats_canonically() {
        assert_eq!(Zatoshi::new(0).unwrap().format_zec(), "0");
        assert_eq!(Zatoshi::new(1).unwrap().format_zec(), "0.00000001");
        assert_eq!(Zatoshi::new(50_000_000).unwrap().format_zec(), "0.5");
        assert_eq!(Zatoshi::new(100_000_000).unwrap().format_zec(), "1");
        assert_eq!(
            Zatoshi::new(1_234_567_890).unwrap().format_zec(),
            "12.3456789"
        );
        assert_eq!(Zatoshi::MAX.format_zec(), "21000000");
        assert_eq!(
            Zatoshi::new(1_234_567_890).unwrap().to_string(),
            "12.3456789"
        );
    }

    // covers: REQ-AMT-001
    #[test]
    fn serializes_as_decimal_string() {
        let amount = Zatoshi::new(MAX_MONEY).unwrap();
        let json = serde_json::to_string(&amount).unwrap();
        assert_eq!(json, "\"2100000000000000\"");
        let back: Zatoshi = serde_json::from_str(&json).unwrap();
        assert_eq!(back, amount);
        // Numbers, signs, empties and out-of-range strings are not accepted.
        for bad in [
            "5",
            "\"-5\"",
            "\"+5\"",
            "\"\"",
            "\"1.5\"",
            "\"2100000000000001\"",
        ] {
            assert!(serde_json::from_str::<Zatoshi>(bad).is_err(), "{bad}");
        }
    }

    // covers: REQ-AMT-002
    #[test]
    fn new_rejects_values_above_max_money() {
        assert!(Zatoshi::new(MAX_MONEY).is_ok());
        assert_eq!(
            Zatoshi::new(MAX_MONEY + 1),
            Err(AmountError::ExceedsMaxMoney)
        );
        assert_eq!(Zatoshi::new(u64::MAX), Err(AmountError::ExceedsMaxMoney));
    }

    // covers: REQ-AMT-002
    #[test]
    fn checked_add_never_wraps_or_saturates() {
        let half = Zatoshi::new(MAX_MONEY / 2).unwrap();
        let one = Zatoshi::new(1).unwrap();
        // MAX_MONEY is even, so two halves land exactly on the limit.
        assert_eq!(half.checked_add(half), Ok(Zatoshi::MAX));
        let almost = Zatoshi::new(MAX_MONEY - 1).unwrap();
        assert_eq!(almost.checked_add(one), Ok(Zatoshi::MAX));
        assert_eq!(
            almost.checked_add(Zatoshi::new(2).unwrap()),
            Err(AmountError::ExceedsMaxMoney)
        );
        assert_eq!(
            Zatoshi::MAX.checked_add(one),
            Err(AmountError::ExceedsMaxMoney)
        );
        assert_eq!(
            Zatoshi::MAX.checked_add(Zatoshi::MAX),
            Err(AmountError::ExceedsMaxMoney)
        );
    }

    // covers: REQ-AMT-002
    #[test]
    fn checked_sum_errors_above_max_money() {
        let exactly = [
            Zatoshi::new(MAX_MONEY - 1).unwrap(),
            Zatoshi::new(1).unwrap(),
        ];
        assert_eq!(Zatoshi::checked_sum(exactly), Ok(Zatoshi::MAX));

        let over = [Zatoshi::new(MAX_MONEY).unwrap(), Zatoshi::new(1).unwrap()];
        assert_eq!(
            Zatoshi::checked_sum(over),
            Err(AmountError::ExceedsMaxMoney)
        );

        // Many large values: the partial sum must trip the check, never wrap.
        let many = std::iter::repeat_n(Zatoshi::MAX, 20_000);
        assert_eq!(
            Zatoshi::checked_sum(many),
            Err(AmountError::ExceedsMaxMoney)
        );

        assert_eq!(Zatoshi::checked_sum([]), Ok(Zatoshi::ZERO));
    }

    proptest! {
        // covers: REQ-AMT-001
        #[test]
        fn format_then_parse_round_trips(v in prop_oneof![
            0..=MAX_MONEY,
            Just(0u64), Just(1u64), Just(MAX_MONEY), Just(MAX_MONEY - 1),
            Just(ZATOSHI_PER_ZEC), Just(ZATOSHI_PER_ZEC - 1), Just(ZATOSHI_PER_ZEC + 1),
        ]) {
            let amount = Zatoshi::new(v).unwrap();
            let text = amount.format_zec();
            prop_assert_eq!(Zatoshi::parse_zec(&text), Ok(amount));
            // Canonical: no trailing zero after a point, no trailing point, no leading zero run.
            if text.contains('.') {
                prop_assert!(!text.ends_with('0'));
                prop_assert!(!text.ends_with('.'));
            }
            prop_assert!(text == "0" || !text.starts_with('0') || text.starts_with("0."));
        }

        // covers: REQ-AMT-001
        #[test]
        fn parse_then_format_is_canonical(
            whole in "[0-9]{1,9}",
            frac in proptest::option::of("[0-9]{1,8}"),
        ) {
            let text = match &frac {
                Some(f) => format!("{whole}.{f}"),
                None => whole.clone(),
            };
            match Zatoshi::parse_zec(&text) {
                Ok(amount) => {
                    let canonical = amount.format_zec();
                    prop_assert_eq!(Zatoshi::parse_zec(&canonical), Ok(amount));
                    // Value-preserving: same zatoshi as a manual u128 computation.
                    let w: u128 = whole.parse().unwrap();
                    let f = frac.unwrap_or_default();
                    let mut padded = f.clone();
                    while padded.len() < 8 { padded.push('0'); }
                    let fv: u128 = padded.parse().unwrap();
                    prop_assert_eq!(u128::from(amount.as_u64()), w * 100_000_000 + fv);
                }
                Err(e) => prop_assert_eq!(e, AmountError::ExceedsMaxMoney),
            }
        }

        // covers: REQ-AMT-001
        #[test]
        fn parse_never_panics_on_arbitrary_text(s in "\\PC{0,40}") {
            if let Ok(amount) = Zatoshi::parse_zec(&s) {
                prop_assert!(amount.as_u64() <= MAX_MONEY);
                prop_assert_eq!(Zatoshi::parse_zec(&amount.format_zec()), Ok(amount));
            }
        }

        // covers: REQ-AMT-002
        #[test]
        fn checked_sum_matches_wide_arithmetic(
            values in proptest::collection::vec(0..=MAX_MONEY, 0..12)
        ) {
            let amounts: Vec<Zatoshi> = values.iter().map(|v| Zatoshi::new(*v).unwrap()).collect();
            let wide: u128 = values.iter().map(|v| u128::from(*v)).sum();
            let got = Zatoshi::checked_sum(amounts);
            if wide <= u128::from(MAX_MONEY) {
                prop_assert_eq!(got.map(Zatoshi::as_u64), Ok(u64::try_from(wide).unwrap()));
            } else {
                prop_assert_eq!(got, Err(AmountError::ExceedsMaxMoney));
            }
        }
    }
}

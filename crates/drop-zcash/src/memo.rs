//! ZIP-302 memos (REQ-TX-003): a text memo is UTF-8, at most 512 bytes, zero-padded to the
//! 512-byte memo field; no memo is encoded as the 0xF6 "empty" marker. Over-length text is
//! rejected before any transaction is built.

use thiserror::Error;
use zcash_protocol::memo::{Memo, MemoBytes};

/// The ZIP-302 memo field size.
pub const MAX_MEMO_BYTES: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum MemoError {
    /// Carries lengths only, never memo text.
    #[error("memo is {len} bytes; the limit is {MAX_MEMO_BYTES}")]
    TooLong { len: usize },
}

/// Encodes an optional text memo. `None` and `Some("")` both encode as "no memo".
pub fn encode_memo(text: Option<&str>) -> Result<MemoBytes, MemoError> {
    match text {
        None | Some("") => Ok(MemoBytes::empty()),
        Some(t) if t.len() > MAX_MEMO_BYTES => Err(MemoError::TooLong { len: t.len() }),
        Some(t) => {
            let memo: Memo = t.parse().map_err(|_| MemoError::TooLong { len: t.len() })?;
            Ok(MemoBytes::from(&memo))
        }
    }
}

/// The text of a decrypted memo field, or `None` for an empty or non-text memo.
pub fn decode_memo(bytes: &[u8; 512]) -> Option<String> {
    let memo = MemoBytes::from_bytes(bytes).ok()?;
    match Memo::try_from(memo).ok()? {
        Memo::Text(t) => Some(t.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // covers: REQ-TX-003
    #[test]
    fn text_memo_is_utf8_zero_padded_to_512_bytes() {
        let bytes = encode_memo(Some("thanks — ZecDrop")).unwrap();
        let raw = bytes.as_array();
        let text = "thanks — ZecDrop".as_bytes();
        assert_eq!(&raw[..text.len()], text);
        assert!(raw[text.len()..].iter().all(|b| *b == 0));
        assert_eq!(decode_memo(raw).as_deref(), Some("thanks — ZecDrop"));
    }

    // covers: REQ-TX-003
    #[test]
    fn exactly_512_bytes_is_accepted_and_513_is_rejected_before_building() {
        let max = "é".repeat(256); // 2-byte UTF-8 chars: 512 bytes
        assert_eq!(max.len(), 512);
        assert_eq!(
            decode_memo(encode_memo(Some(&max)).unwrap().as_array()).as_deref(),
            Some(max.as_str())
        );

        let over = format!("{max}x");
        assert_eq!(
            encode_memo(Some(&over)),
            Err(MemoError::TooLong { len: 513 })
        );
    }

    // covers: REQ-TX-003
    #[test]
    fn no_memo_is_the_zip302_empty_marker() {
        for m in [None, Some("")] {
            let bytes = encode_memo(m).unwrap();
            assert_eq!(bytes.as_array()[0], 0xF6);
            assert!(bytes.as_array()[1..].iter().all(|b| *b == 0));
            assert_eq!(decode_memo(bytes.as_array()), None);
        }
    }

    // covers: REQ-TX-003
    #[test]
    fn memo_errors_carry_no_memo_text() {
        let secret = "s3cret-memo-".repeat(50);
        let err = encode_memo(Some(&secret)).unwrap_err();
        assert!(!err.to_string().contains("s3cret"));
        assert!(!format!("{err:?}").contains("s3cret"));
    }
}

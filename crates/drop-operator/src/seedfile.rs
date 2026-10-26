//! Reading a testnet development seed from a file (`--seed-file`).
//!
//! The file holds the 32-byte seed as 64 hexadecimal characters (surrounding whitespace
//! allowed) or as 32 raw bytes. It must not be readable by group or others, the same rule
//! SSH applies to private keys. The contents are read into zeroizing buffers, never
//! logged, and never copied into the store. Errors say what is wrong with the file, not
//! what is in it.

use std::path::Path;

use thiserror::Error;
use zeroize::Zeroizing;

use crate::secret::SecretSeed;

/// Why a seed file was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum SeedFileError {
    /// The file could not be read.
    #[error("the seed file could not be read")]
    Unreadable,
    /// The file is readable by group or others.
    #[error("the seed file is readable by other users; run `chmod 600` on it")]
    TooOpen,
    /// The file is not 64 hex characters or 32 raw bytes.
    #[error("the seed file must hold 64 hexadecimal characters or 32 raw bytes")]
    BadFormat,
}

/// Reads the seed from `path`.
pub fn read_seed_file(path: &Path) -> Result<SecretSeed, SeedFileError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path)
            .map_err(|_| SeedFileError::Unreadable)?
            .permissions()
            .mode();
        if mode & 0o077 != 0 {
            return Err(SeedFileError::TooOpen);
        }
    }
    let bytes = Zeroizing::new(std::fs::read(path).map_err(|_| SeedFileError::Unreadable)?);
    parse_seed(&bytes)
}

fn parse_seed(bytes: &[u8]) -> Result<SecretSeed, SeedFileError> {
    if let Ok(raw) = <[u8; 32]>::try_from(bytes) {
        return Ok(SecretSeed::from_bytes(raw));
    }
    let text = bytes.trim_ascii();
    if text.len() == 64 {
        let mut seed = Zeroizing::new([0u8; 32]);
        hex::decode_to_slice(text, seed.as_mut()).map_err(|_| SeedFileError::BadFormat)?;
        return Ok(SecretSeed::from_bytes(*seed));
    }
    Err(SeedFileError::BadFormat)
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    fn file_with(content: &[u8], mode: u32) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("seed");
        std::fs::File::create(&path)
            .unwrap()
            .write_all(content)
            .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        }
        let _ = mode;
        (dir, path)
    }

    // covers: REQ-SEC-001
    #[test]
    fn hex_with_whitespace_and_raw_bytes_both_load() {
        let seed = [0xA7u8; 32];
        let hex_text = format!("  {}\n", hex::encode(seed));
        for content in [hex_text.as_bytes(), &seed[..]] {
            let (_dir, path) = file_with(content, 0o600);
            assert_eq!(read_seed_file(&path).unwrap().expose_secret(), &seed);
        }
    }

    // covers: REQ-SEC-001
    #[test]
    fn anything_else_is_refused_without_quoting_the_content() {
        for bad in [
            &b""[..],
            b"too short",
            b"zz00000000000000000000000000000000000000000000000000000000000000",
            &[1u8; 31],
            &[1u8; 33],
            b"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00",
        ] {
            let (_dir, path) = file_with(bad, 0o600);
            let error = read_seed_file(&path).unwrap_err();
            assert_eq!(error, SeedFileError::BadFormat, "{bad:?}");
            assert!(!error.to_string().contains("zz00"));
        }
        assert_eq!(
            read_seed_file(Path::new("/nonexistent/seed")).unwrap_err(),
            SeedFileError::Unreadable
        );
    }

    // covers: REQ-SEC-001
    #[cfg(unix)]
    #[test]
    fn a_seed_file_others_can_read_is_refused() {
        for mode in [0o644, 0o640, 0o604, 0o666, 0o660] {
            let (_dir, path) = file_with(hex::encode([1u8; 32]).as_bytes(), mode);
            assert_eq!(
                read_seed_file(&path).unwrap_err(),
                SeedFileError::TooOpen,
                "{mode:o}"
            );
        }
        let (_dir, path) = file_with(hex::encode([1u8; 32]).as_bytes(), 0o400);
        assert!(read_seed_file(&path).is_ok(), "owner-only read is fine");
    }
}

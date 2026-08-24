use std::fmt;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use sha2::{Digest as _, Sha256};
use thiserror::Error;

pub const HTLC_OPAQUE_CIPHERTEXT_VERSION: &str = "xln:htlc-opaque:aes-gcm";
const EPHEMERAL_PUBLIC_KEY_BYTES: usize = 32;
const AUTH_TAG_BYTES: usize = 16;
const MAX_HTLC_BINARY_LAYER_BYTES: usize = (10_000_000 - 1_000_000) * 3 / 4;
const MAX_PACKED_CIPHERTEXT_BYTES: usize =
    EPHEMERAL_PUBLIC_KEY_BYTES + MAX_HTLC_BINARY_LAYER_BYTES + AUTH_TAG_BYTES;
pub(crate) const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum HtlcBoundaryError {
    #[error("HTLC_HASHLOCK_INVALID:{0}")]
    InvalidHashlock(String),
    #[error("HTLC_OPAQUE_CIPHERTEXT_VERSION_INVALID:{0}")]
    InvalidEnvelopeVersion(String),
    #[error("HTLC_OPAQUE_CIPHERTEXT_BASE64_INVALID")]
    InvalidEnvelopeBase64,
    #[error("HTLC_OPAQUE_CIPHERTEXT_SIZE_INVALID")]
    InvalidEnvelopeSize,
    #[error("HTLC_OPAQUE_CIPHERTEXT_NON_CANONICAL")]
    NonCanonicalEnvelope,
    #[error("HTLC_REVEAL_BEFORE_HEIGHT_UNSAFE:{value}:{maximum}")]
    RevealBeforeHeightUnsafe { value: u64, maximum: u64 },
}

pub(crate) fn validate_reveal_before_height(value: u64) -> Result<(), HtlcBoundaryError> {
    if value > MAX_SAFE_INTEGER {
        return Err(HtlcBoundaryError::RevealBeforeHeightUnsafe {
            value,
            maximum: MAX_SAFE_INTEGER,
        });
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HtlcHashlock {
    text: String,
    bytes: [u8; 32],
}

impl HtlcHashlock {
    pub fn parse(value: &str) -> Result<Self, HtlcBoundaryError> {
        let Some(hex) = value.strip_prefix("0x") else {
            return Err(HtlcBoundaryError::InvalidHashlock(value.into()));
        };
        if hex.len() != 64 || !hex.bytes().all(is_lower_hex) {
            return Err(HtlcBoundaryError::InvalidHashlock(value.into()));
        }
        let mut bytes = [0_u8; 32];
        for (index, pair) in hex.as_bytes().chunks_exact(2).enumerate() {
            let Some(high) = hex_nibble(pair[0]) else {
                return Err(HtlcBoundaryError::InvalidHashlock(value.into()));
            };
            let Some(low) = hex_nibble(pair[1]) else {
                return Err(HtlcBoundaryError::InvalidHashlock(value.into()));
            };
            bytes[index] = (high << 4) | low;
        }
        Ok(Self {
            text: value.into(),
            bytes,
        })
    }

    pub const fn bytes(&self) -> &[u8; 32] {
        &self.bytes
    }

    pub fn as_str(&self) -> &str {
        &self.text
    }

    pub(crate) fn from_bytes(bytes: [u8; 32]) -> Self {
        Self {
            text: hex_32(&bytes),
            bytes,
        }
    }
}

impl fmt::Display for HtlcHashlock {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.text)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpaqueHtlcCiphertext {
    ciphertext: String,
    packed: Vec<u8>,
}

impl OpaqueHtlcCiphertext {
    pub fn parse(version: &str, ciphertext: &str) -> Result<Self, HtlcBoundaryError> {
        if version != HTLC_OPAQUE_CIPHERTEXT_VERSION {
            return Err(HtlcBoundaryError::InvalidEnvelopeVersion(version.into()));
        }
        if ciphertext.is_empty() || ciphertext.len() > MAX_PACKED_CIPHERTEXT_BYTES.div_ceil(3) * 4 {
            return Err(HtlcBoundaryError::InvalidEnvelopeSize);
        }
        let packed = BASE64_STANDARD
            .decode(ciphertext)
            .map_err(|_| HtlcBoundaryError::InvalidEnvelopeBase64)?;
        validate_packed_size(&packed)?;
        if BASE64_STANDARD.encode(&packed) != ciphertext {
            return Err(HtlcBoundaryError::NonCanonicalEnvelope);
        }
        Ok(Self {
            ciphertext: ciphertext.into(),
            packed,
        })
    }

    pub fn from_packed(packed: Vec<u8>) -> Result<Self, HtlcBoundaryError> {
        validate_packed_size(&packed)?;
        Ok(Self {
            ciphertext: BASE64_STANDARD.encode(&packed),
            packed,
        })
    }

    pub fn ciphertext(&self) -> &str {
        &self.ciphertext
    }

    pub fn packed(&self) -> &[u8] {
        &self.packed
    }

    pub fn integrity_hash(&self) -> [u8; 32] {
        Sha256::digest(&self.packed).into()
    }
}

fn validate_packed_size(packed: &[u8]) -> Result<(), HtlcBoundaryError> {
    if packed.len() < EPHEMERAL_PUBLIC_KEY_BYTES + AUTH_TAG_BYTES
        || packed.len() > MAX_PACKED_CIPHERTEXT_BYTES
    {
        return Err(HtlcBoundaryError::InvalidEnvelopeSize);
    }
    Ok(())
}

fn is_lower_hex(value: u8) -> bool {
    value.is_ascii_digit() || (b'a'..=b'f').contains(&value)
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        _ => None,
    }
}

pub(crate) fn hex_32(bytes: &[u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(66);
    output.push_str("0x");
    for byte in bytes {
        output.push(char::from(HEX[(byte >> 4) as usize]));
        output.push(char::from(HEX[(byte & 0x0f) as usize]));
    }
    output
}

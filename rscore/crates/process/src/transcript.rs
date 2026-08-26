//! Read-only capture format used by native parity and performance tools.
//!
//! This is deliberately feature-gated out of the production process. A
//! transcript is test evidence, never a durable Runtime checkpoint.

use std::fs;
use std::path::Path;

use thiserror::Error;
use xln_rscore_abi::{Envelope, decode_envelope};

const TRANSCRIPT_MAGIC: &[u8; 8] = b"XRSCTR01";

#[derive(Clone)]
pub struct TranscriptPair {
    pub request: Envelope,
    pub expected: Envelope,
}

#[derive(Debug, Error)]
pub enum TranscriptError {
    #[error("RSCORE_TRANSCRIPT_READ:{0}")]
    Read(#[from] std::io::Error),
    #[error("RSCORE_TRANSCRIPT_MAGIC")]
    Magic,
    #[error("RSCORE_TRANSCRIPT_RECORD_HEADER")]
    RecordHeader,
    #[error("RSCORE_TRANSCRIPT_RECORD_DIRECTION:{0}")]
    RecordDirection(u8),
    #[error("RSCORE_TRANSCRIPT_RECORD_LENGTH")]
    RecordLength,
    #[error("RSCORE_TRANSCRIPT_RECORD_OVERFLOW")]
    RecordOverflow,
    #[error("RSCORE_TRANSCRIPT_RECORD_TRUNCATED")]
    RecordTruncated,
    #[error("RSCORE_TRANSCRIPT_ENVELOPE:index={index}:direction={direction}:{detail}")]
    Envelope {
        index: usize,
        direction: u8,
        detail: String,
    },
    #[error("RSCORE_TRANSCRIPT_RECORD_COUNT:{0}")]
    RecordCount(usize),
    #[error("RSCORE_TRANSCRIPT_RECORD_ORDER:{0}")]
    RecordOrder(usize),
}

pub fn read_transcript(path: impl AsRef<Path>) -> Result<Vec<TranscriptPair>, TranscriptError> {
    let bytes = fs::read(path)?;
    if bytes.get(..TRANSCRIPT_MAGIC.len()) != Some(TRANSCRIPT_MAGIC) {
        return Err(TranscriptError::Magic);
    }
    let mut records = Vec::new();
    let mut offset = TRANSCRIPT_MAGIC.len();
    while offset < bytes.len() {
        let header = bytes
            .get(offset..offset.saturating_add(5))
            .ok_or(TranscriptError::RecordHeader)?;
        let direction = *header.first().ok_or(TranscriptError::RecordHeader)?;
        if direction > 1 {
            return Err(TranscriptError::RecordDirection(direction));
        }
        let length_bytes: [u8; 4] = header
            .get(1..5)
            .ok_or(TranscriptError::RecordLength)?
            .try_into()
            .map_err(|_| TranscriptError::RecordLength)?;
        let length = usize::try_from(u32::from_be_bytes(length_bytes))
            .map_err(|_| TranscriptError::RecordLength)?;
        offset = offset.saturating_add(5);
        let end = offset
            .checked_add(length)
            .ok_or(TranscriptError::RecordOverflow)?;
        let frame = bytes
            .get(offset..end)
            .ok_or(TranscriptError::RecordTruncated)?;
        let envelope = decode_envelope(frame, 1)
            .or_else(|first_error| decode_envelope(frame, 2).map_err(|_| first_error))
            .map_err(|error| TranscriptError::Envelope {
                index: records.len(),
                direction,
                detail: error.to_string(),
            })?;
        records.push((direction, envelope));
        offset = end;
    }
    if records.is_empty() || !records.len().is_multiple_of(2) {
        return Err(TranscriptError::RecordCount(records.len()));
    }
    records
        .chunks_exact(2)
        .enumerate()
        .map(|(index, pair)| {
            if pair[0].0 != 0 || pair[1].0 != 1 {
                return Err(TranscriptError::RecordOrder(index));
            }
            Ok(TranscriptPair {
                request: pair[0].1.clone(),
                expected: pair[1].1.clone(),
            })
        })
        .collect()
}

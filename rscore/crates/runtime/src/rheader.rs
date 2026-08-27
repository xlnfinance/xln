//! The v5 Runtime frame header: one fixed-width block header per frame.
//!
//! A Runtime is a personal blockchain. Each frame commits exactly one header;
//! everything else — inputs, outbox rows, state — is bound through the three
//! roots. Replay rebuilds the header from the same input and asserts equality
//! of the whole header, which subsumes every separate outbox/state/event
//! assertion the v4 format carried as individual fields.
//!
//! The encoding is raw fixed-width bytes in field order — no serialization
//! framework, nothing to parse. `frame_hash` is the integrity digest of those
//! bytes and is the frame's identity everywhere (WAL keys, lineage,
//! publication).

use sha2::{Digest as _, Sha256};

/// Domain-separates header hashing from every other integrity digest.
const RHEADER_DOMAIN: &[u8] = b"xln.runtime.header:v5";

pub const RHEADER_VERSION: u16 = 5;
/// version + height + timestamp + runtime_id + prev + input + state + outbox.
pub const RHEADER_BYTES: usize = 2 + 8 + 8 + 32 + 32 + 32 + 32 + 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RuntimeHeader {
    pub version: u16,
    pub height: u64,
    pub timestamp: u64,
    /// The identity of the single durable writer that produced this chain.
    pub runtime_id: [u8; 32],
    pub prev_r_hash: [u8; 32],
    /// Integrity digest of the canonical encoding of the whole RuntimeInput.
    pub r_input_root: [u8; 32],
    /// Root of the runtime state after applying the input: entity roots and
    /// the machine digest, positionally bound. Committed every frame.
    pub r_state_root: [u8; 32],
    /// Integrity digest over the ordered outbox row digests. Positional:
    /// the rows are never sorted.
    pub r_outbox_root: [u8; 32],
}

impl RuntimeHeader {
    pub fn encode(&self) -> [u8; RHEADER_BYTES] {
        let mut bytes = [0_u8; RHEADER_BYTES];
        bytes[0..2].copy_from_slice(&self.version.to_be_bytes());
        bytes[2..10].copy_from_slice(&self.height.to_be_bytes());
        bytes[10..18].copy_from_slice(&self.timestamp.to_be_bytes());
        bytes[18..50].copy_from_slice(&self.runtime_id);
        bytes[50..82].copy_from_slice(&self.prev_r_hash);
        bytes[82..114].copy_from_slice(&self.r_input_root);
        bytes[114..146].copy_from_slice(&self.r_state_root);
        bytes[146..178].copy_from_slice(&self.r_outbox_root);
        bytes
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, RuntimeHeaderError> {
        let bytes: &[u8; RHEADER_BYTES] = bytes
            .try_into()
            .map_err(|_| RuntimeHeaderError::Width(bytes.len()))?;
        let version = u16::from_be_bytes(bytes[0..2].try_into().expect("width"));
        if version != RHEADER_VERSION {
            return Err(RuntimeHeaderError::Version(version));
        }
        let field = |range: std::ops::Range<usize>| -> [u8; 32] {
            bytes[range].try_into().expect("width")
        };
        Ok(Self {
            version,
            height: u64::from_be_bytes(bytes[2..10].try_into().expect("width")),
            timestamp: u64::from_be_bytes(bytes[10..18].try_into().expect("width")),
            runtime_id: field(18..50),
            prev_r_hash: field(50..82),
            r_input_root: field(82..114),
            r_state_root: field(114..146),
            r_outbox_root: field(146..178),
        })
    }

    /// The frame's identity: integrity digest of the encoded header.
    pub fn frame_hash(&self) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(RHEADER_DOMAIN);
        hasher.update(self.encode());
        hasher.finalize().into()
    }
}

/// Positional digest over the ordered outbox rows. Empty outbox hashes the
/// domain alone, which still binds "no outputs" into the header.
pub fn outbox_root<Rows, Row>(rows: Rows) -> [u8; 32]
where
    Rows: IntoIterator<Item = Row>,
    Row: AsRef<[u8]>,
{
    let mut hasher = Sha256::new();
    hasher.update(b"xln.runtime.outbox:v5");
    for row in rows {
        let digest: [u8; 32] = Sha256::digest(row.as_ref()).into();
        hasher.update(digest);
    }
    hasher.finalize().into()
}

/// Positional digest over the runtime state components: each entity's state
/// root in entity-id order, then the machine digest. Committed every frame;
/// components keep their own dirty-only caches so this stays O(entities).
pub fn state_root<'a>(
    entity_roots: impl IntoIterator<Item = (&'a [u8; 32], &'a [u8; 32])>,
    machine_digest: &[u8; 32],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"xln.runtime.state:v5");
    for (entity_id, root) in entity_roots {
        hasher.update(entity_id);
        hasher.update(root);
    }
    hasher.update(machine_digest);
    hasher.finalize().into()
}

#[derive(Debug, thiserror::Error)]
pub enum RuntimeHeaderError {
    #[error("RHEADER_WIDTH:{0}")]
    Width(usize),
    #[error("RHEADER_VERSION:{0}")]
    Version(u16),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header() -> RuntimeHeader {
        RuntimeHeader {
            version: RHEADER_VERSION,
            height: 7,
            timestamp: 1_700_000_000_000,
            runtime_id: [1; 32],
            prev_r_hash: [2; 32],
            r_input_root: [3; 32],
            r_state_root: [4; 32],
            r_outbox_root: [5; 32],
        }
    }

    #[test]
    fn encode_decode_round_trips_and_hash_is_stable() {
        let original = header();
        let decoded = RuntimeHeader::decode(&original.encode()).expect("decode");
        assert_eq!(original, decoded);
        assert_eq!(original.frame_hash(), decoded.frame_hash());
    }

    #[test]
    fn every_field_changes_the_frame_hash() {
        let base = header().frame_hash();
        let mut mutations = Vec::new();
        let mut h = header();
        h.height += 1;
        mutations.push(h);
        let mut h = header();
        h.timestamp += 1;
        mutations.push(h);
        let mut h = header();
        h.runtime_id[0] ^= 1;
        mutations.push(h);
        let mut h = header();
        h.prev_r_hash[0] ^= 1;
        mutations.push(h);
        let mut h = header();
        h.r_input_root[0] ^= 1;
        mutations.push(h);
        let mut h = header();
        h.r_state_root[0] ^= 1;
        mutations.push(h);
        let mut h = header();
        h.r_outbox_root[0] ^= 1;
        mutations.push(h);
        for mutated in mutations {
            assert_ne!(base, mutated.frame_hash());
        }
    }

    #[test]
    fn wrong_width_and_version_are_loud() {
        assert!(matches!(
            RuntimeHeader::decode(&[0; 10]),
            Err(RuntimeHeaderError::Width(10))
        ));
        let mut bytes = header().encode();
        bytes[0..2].copy_from_slice(&9_u16.to_be_bytes());
        assert!(matches!(
            RuntimeHeader::decode(&bytes),
            Err(RuntimeHeaderError::Version(9))
        ));
    }

    #[test]
    fn outbox_root_is_positional() {
        let a = outbox_root(["row-a".as_bytes(), "row-b".as_bytes()]);
        let b = outbox_root(["row-b".as_bytes(), "row-a".as_bytes()]);
        assert_ne!(a, b);
        assert_ne!(outbox_root(std::iter::empty::<&[u8]>()), [0; 32]);
    }
}

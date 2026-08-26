use sha2::{Digest as _, Sha256};
use thiserror::Error;
use xln_rscore_protocol::{
    CanonicalNumber, CanonicalValue, ConsensusMessagePackError, encode_canonical_consensus_bytes,
};

const STORAGE_MSGPACK_MAGIC: u8 = 0x03;
const POST_STATE_DOMAIN: &str = "xln.storage.postState";
const REPLICA_META_DOMAIN: &str = "xln.storage.replicaMeta.v1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeComponentDigest {
    pub key: String,
    pub value_hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimePostStateCommitment {
    pub height: u64,
    pub timestamp: u64,
    pub replica_meta_digest: String,
    pub runtime_component_digests: Vec<RuntimeComponentDigest>,
    pub runtime_output_refs: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageReplicaMetaEntry {
    pub key: Vec<u8>,
    pub value: Vec<u8>,
}

#[derive(Debug, Error)]
pub enum RuntimeCommitmentError {
    #[error(transparent)]
    Encoding(#[from] ConsensusMessagePackError),
    #[error("RUNTIME_STORAGE_NUMBER_UNSAFE:field={field}:value={value}")]
    UnsafeNumber { field: &'static str, value: u64 },
}

fn text(value: impl Into<String>) -> CanonicalValue {
    CanonicalValue::String(value.into())
}

fn number(field: &'static str, value: u64) -> Result<CanonicalValue, RuntimeCommitmentError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|_| RuntimeCommitmentError::UnsafeNumber { field, value })
}

fn object(entries: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
    CanonicalValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(2 + bytes.len() * 2);
    output.push_str("0x");
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// Storage hashes include the canonical codec discriminator byte. Consensus
/// hashes use the same record-aware MessagePack body without that byte.
pub fn encode_storage_payload(value: &CanonicalValue) -> Result<Vec<u8>, RuntimeCommitmentError> {
    let body = encode_canonical_consensus_bytes(value)?;
    let mut encoded = Vec::with_capacity(body.len() + 1);
    encoded.push(STORAGE_MSGPACK_MAGIC);
    encoded.extend_from_slice(&body);
    Ok(encoded)
}

pub fn compute_runtime_component_digest(
    value: &CanonicalValue,
) -> Result<String, RuntimeCommitmentError> {
    Ok(sha256_hex(&encode_storage_payload(value)?))
}

pub fn compute_storage_post_state_hash(
    input: &RuntimePostStateCommitment,
) -> Result<String, RuntimeCommitmentError> {
    let component_rows = input
        .runtime_component_digests
        .iter()
        .map(|entry| {
            object(vec![
                ("key", text(&entry.key)),
                ("valueHash", text(&entry.value_hash)),
            ])
        })
        .collect();
    let value = object(vec![
        ("kind", text(POST_STATE_DOMAIN)),
        ("height", number("height", input.height)?),
        ("timestamp", number("timestamp", input.timestamp)?),
        ("replicaMetaDigest", text(&input.replica_meta_digest)),
        (
            "runtimeComponentDigests",
            CanonicalValue::Array(component_rows),
        ),
        (
            "runtimeOutputRefs",
            CanonicalValue::Array(input.runtime_output_refs.iter().map(text).collect()),
        ),
    ]);
    Ok(sha256_hex(&encode_storage_payload(&value)?))
}

pub fn compute_storage_replica_meta_digest(
    entries: &[StorageReplicaMetaEntry],
) -> Result<String, RuntimeCommitmentError> {
    let mut rows = entries
        .iter()
        .map(|entry| (hex(&entry.key), sha256_hex(&entry.value)))
        .collect::<Vec<_>>();
    rows.sort_unstable();
    let rows = rows
        .into_iter()
        .map(|(key, value_hash)| object(vec![("key", text(key)), ("valueHash", text(value_hash))]))
        .collect();
    let value = object(vec![
        ("kind", text(REPLICA_META_DOMAIN)),
        ("entries", CanonicalValue::Array(rows)),
    ]);
    Ok(sha256_hex(&encode_storage_payload(&value)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repeated(byte: &str) -> String {
        format!("0x{}", byte.repeat(32))
    }

    #[test]
    fn storage_post_state_bytes_match_typescript_msgpackr() {
        let input = RuntimePostStateCommitment {
            height: 55,
            timestamp: 1_787_579_799_935,
            replica_meta_digest: repeated("11"),
            runtime_component_digests: vec![
                RuntimeComponentDigest {
                    key: "jReplicas".into(),
                    value_hash: repeated("22"),
                },
                RuntimeComponentDigest {
                    key: "runtimeId".into(),
                    value_hash: repeated("33"),
                },
                RuntimeComponentDigest {
                    key: "runtimeInput".into(),
                    value_hash: repeated("44"),
                },
            ],
            runtime_output_refs: vec![repeated("55"), repeated("66")],
        };
        assert_eq!(
            compute_storage_post_state_hash(&input).expect("post-state hash"),
            "0x2c3cf33e5a7d98a39272ea8a688404073398764ec188f374505371749662dea5",
        );
    }

    #[test]
    fn h1_frame_55_post_state_hash_matches_recorded_typescript_root() {
        let input = RuntimePostStateCommitment {
            height: 55,
            timestamp: 1_787_579_799_935,
            replica_meta_digest:
                "0xe3ba49b8ccc4723da8e3d315fc0171800a5e50354852a117aca18606ac4b614c".into(),
            runtime_component_digests: vec![
                RuntimeComponentDigest {
                    key: "infrastructure".into(),
                    value_hash:
                        "0x0f70e0321cd92ed06731011949c5da27238ccd7770485119fc7c257980d845ba".into(),
                },
                RuntimeComponentDigest {
                    key: "jReplicas".into(),
                    value_hash:
                        "0x01368ab9f0e93485f449305b88d592fc9e1b1a396d526c26c9c7803a3ba0077a".into(),
                },
                RuntimeComponentDigest {
                    key: "runtimeId".into(),
                    value_hash:
                        "0xeceafa7c547507e4f5d74b447af4c7f7589c8fc1eb523770a0577ec4db6bf5dd".into(),
                },
                RuntimeComponentDigest {
                    key: "runtimeInput".into(),
                    value_hash:
                        "0x7c79fed396265cc14e27c9475e5e5fc02e2b0733ce8d3d1db34a2af117632e22".into(),
                },
            ],
            runtime_output_refs: vec![
                "0xde140f60b20b533061956e2c7dec80877d3c9920ca3e9ee6b791712c00be4f13".into(),
                "0x254f630f6ebc42a33a004c7b1e278f346fcd24accfbb60aaa7b0eb655ef0fc84".into(),
            ],
        };
        assert_eq!(
            compute_storage_post_state_hash(&input).expect("frame 55 post-state hash"),
            "0xb7e0d40bef5e2a0d1c608ebd1cc343c48ddad6c879c387132798660d2f36e7f9",
        );
    }
}

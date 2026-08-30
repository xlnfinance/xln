use serde_json::Value as JsonValue;
use sha2::{Digest as _, Sha256};
use sha3::Keccak256;
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
    pub runtime_output_count: u64,
    pub runtime_outputs_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageReplicaMetaEntry {
    pub key: Vec<u8>,
    pub value: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanonicalRuntimeEntityHash {
    pub entity_id: String,
    pub hash: String,
    pub cell_count: u64,
}

#[derive(Debug, Error)]
pub enum RuntimeCommitmentError {
    #[error(transparent)]
    Encoding(#[from] ConsensusMessagePackError),
    #[error("RUNTIME_STORAGE_NUMBER_UNSAFE:field={field}:value={value}")]
    UnsafeNumber { field: &'static str, value: u64 },
    #[error("RUNTIME_CANONICAL_JSON_NUMBER_INVALID:path={path}:value={value}")]
    InvalidJsonNumber { path: String, value: String },
    #[error("RUNTIME_CANONICAL_JSON_ENCODE_FAILED:{0}")]
    JsonEncode(#[from] serde_json::Error),
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

fn compare_utf16(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn js_array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    let value = key.parse::<u32>().ok()?;
    (value < u32::MAX && value.to_string() == key).then_some(value)
}

fn compare_js_object_keys(left: &str, right: &str) -> std::cmp::Ordering {
    match (js_array_index(left), js_array_index(right)) {
        (Some(left), Some(right)) => left.cmp(&right),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => compare_utf16(left, right),
    }
}

fn append_canonical_json(
    output: &mut String,
    value: &JsonValue,
    path: &str,
) -> Result<(), RuntimeCommitmentError> {
    match value {
        JsonValue::Null => output.push_str("null"),
        JsonValue::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        JsonValue::String(value) => output.push_str(&serde_json::to_string(value)?),
        JsonValue::Number(number) => {
            let parsed =
                number
                    .as_f64()
                    .ok_or_else(|| RuntimeCommitmentError::InvalidJsonNumber {
                        path: path.to_string(),
                        value: number.to_string(),
                    })?;
            let mut buffer = ryu_js::Buffer::new();
            output.push_str(buffer.format(parsed));
        }
        JsonValue::Array(values) => {
            output.push('[');
            for (index, child) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                append_canonical_json(output, child, &format!("{path}[{index}]"))?;
            }
            output.push(']');
        }
        JsonValue::Object(object) => {
            output.push('{');
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort_by(|left, right| compare_js_object_keys(left, right));
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key)?);
                output.push(':');
                append_canonical_json(output, &object[key], &format!("{path}.{key}"))?;
            }
            output.push('}');
        }
    }
    Ok(())
}

/// Exact Rust implementation of `computeCanonicalRuntimeStateHash`.
///
/// `runtime_machine` is the tagged, key-sorted value produced by the canonical
/// storage projection. Passing the previous root would add no authority, so the
/// resident Runtime computes this directly from its owned post-state.
pub fn compute_canonical_runtime_state_hash(
    height: u64,
    timestamp: u64,
    entity_hashes: &[CanonicalRuntimeEntityHash],
    runtime_machine: Option<&JsonValue>,
) -> Result<String, RuntimeCommitmentError> {
    number("height", height)?;
    number("timestamp", timestamp)?;

    let mut entities = entity_hashes
        .iter()
        .map(|entry| {
            number("cellCount", entry.cell_count)?;
            Ok((entry.entity_id.to_lowercase(), entry))
        })
        .collect::<Result<Vec<_>, RuntimeCommitmentError>>()?;
    entities.sort_by(|left, right| compare_utf16(&left.0, &right.0));

    let mut preimage =
        String::from("{\"kind\":\"xln.storage.canonicalRuntimeHash.v1\",\"height\":");
    preimage.push_str(&height.to_string());
    preimage.push_str(",\"timestamp\":");
    preimage.push_str(&timestamp.to_string());
    preimage.push_str(",\"entities\":[");
    for (index, (entity_id, entry)) in entities.into_iter().enumerate() {
        if index > 0 {
            preimage.push(',');
        }
        preimage.push_str("{\"entityId\":");
        preimage.push_str(&serde_json::to_string(&entity_id)?);
        preimage.push_str(",\"hash\":");
        preimage.push_str(&serde_json::to_string(&entry.hash)?);
        preimage.push_str(",\"cellCount\":");
        preimage.push_str(&entry.cell_count.to_string());
        preimage.push('}');
    }
    preimage.push(']');
    if let Some(machine) = runtime_machine {
        preimage.push_str(",\"runtimeMachine\":");
        append_canonical_json(&mut preimage, machine, "$.runtimeMachine")?;
    }
    preimage.push('}');
    Ok(hex(&Keccak256::digest(preimage.as_bytes())))
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
            "runtimeOutputCount",
            number("runtimeOutputCount", input.runtime_output_count)?,
        ),
        ("runtimeOutputsDigest", text(&input.runtime_outputs_digest)),
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
    fn canonical_runtime_state_hash_matches_typescript() {
        let runtime_machine: JsonValue = serde_json::from_str(
            r#"{"a":{"__xlnType":"Map","value":[["a",{"__xlnType":"BigInt","value":"1"}],["b",{"__xlnType":"BigInt","value":"2"}]]},"bytes":{"__xlnType":"TypedArray","kind":"Uint8Array","value":"0001ff"},"nested":{"x":"ok","y":true},"z":3}"#,
        )
        .expect("canonical runtime fixture");
        let entities = vec![
            CanonicalRuntimeEntityHash {
                entity_id: "0xBB".into(),
                hash: repeated("22"),
                cell_count: 3,
            },
            CanonicalRuntimeEntityHash {
                entity_id: "0xAa".into(),
                hash: repeated("11"),
                cell_count: 1,
            },
        ];
        assert_eq!(
            compute_canonical_runtime_state_hash(
                55,
                1_787_579_799_935,
                &entities,
                Some(&runtime_machine),
            )
            .expect("runtime state hash"),
            "0x4a2c670c5ffd39fa8dc865ccffee2277d2dffb681f2025e1fec35c2eadfc0ebd",
        );
    }

    #[test]
    fn canonical_runtime_state_hash_matches_javascript_key_and_number_order() {
        let runtime_machine: JsonValue = serde_json::from_str(
            r#"{"2":"two","10":"ten","":"bmp","😀":"astral","small":1e-7,"wide":100000000000000000000,"exp":1e+21}"#,
        )
        .expect("javascript ordering fixture");
        assert_eq!(
            compute_canonical_runtime_state_hash(1, 2, &[], Some(&runtime_machine))
                .expect("runtime state hash"),
            "0x432eec0ee1220efa8d301b00c20d4c13f35baf6aef749fb17f4c9642c539d642",
        );
    }

    #[test]
    fn canonical_runtime_state_hash_normalizes_negative_zero_like_json_stringify() {
        let runtime_machine: JsonValue =
            serde_json::from_str(r#"{"negzero":-0.0}"#).expect("negative zero fixture");
        assert_eq!(
            compute_canonical_runtime_state_hash(1, 2, &[], Some(&runtime_machine))
                .expect("runtime state hash"),
            "0x8a3d0ebab608f949e4c607d5635ad06f588984f652e00a3dbdc29735f41a4431",
        );
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
            runtime_output_count: 2,
            runtime_outputs_digest: repeated("55"),
        };
        assert_eq!(
            compute_storage_post_state_hash(&input).expect("post-state hash"),
            "0x2f7c9a1d9756b3b107cb93b82f2e013f34566a817a48c1d5f177bc0307ba700a",
        );
    }

    #[test]
    fn flat_outbox_post_state_bytes_match_typescript() {
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
            runtime_output_count: 2,
            runtime_outputs_digest:
                "0xde140f60b20b533061956e2c7dec80877d3c9920ca3e9ee6b791712c00be4f13".into(),
        };
        assert_eq!(
            compute_storage_post_state_hash(&input).expect("frame 55 post-state hash"),
            "0x75a32bf23c92c9e70bd34a39a38f3f7def1dead75e09418ced484995c73b6ca1",
        );
    }
}

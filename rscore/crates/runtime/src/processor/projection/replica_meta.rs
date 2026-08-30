//! Exact canonical `0x26` live Entity-replica projection.

use serde_json::{Map, Number, Value};
use sha2::{Digest as _, Sha256};
use thiserror::Error;
use xln_rscore_entity_kernel::{CertifiedEntityFrameLink, EntityFrame, EntityFrameEvent, HashType};

use crate::{RuntimeApplyResult, RuntimeEntityKey, StorageReplicaMetaEntry};

use super::EntityOutputEncodingError;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(crate) struct PreparedReplicaMeta {
    pub entry: StorageReplicaMetaEntry,
    pub value: Value,
}

pub(crate) fn prepare_replica_meta(
    result: &RuntimeApplyResult,
    key: &RuntimeEntityKey,
    materialized: bool,
) -> Result<PreparedReplicaMeta, ReplicaMetaProjectionError> {
    let state = result
        .replica
        .state
        .e_replicas
        .get(key)
        .ok_or(ReplicaMetaProjectionError::CertifiedFrameMissing)?;
    let live = result
        .replica
        .e_replicas
        .get(key)
        .ok_or(ReplicaMetaProjectionError::CertifiedFrameMissing)?;
    let head = live
        .entity_consensus
        .certified_frame_head
        .as_ref()
        .ok_or(ReplicaMetaProjectionError::CertifiedFrameMissing)?;
    let entity_id = state.entity.entity_id.to_ascii_lowercase();
    let signer_id = normalize_hex(&key.signer_id, 20)
        .ok_or_else(|| ReplicaMetaProjectionError::Signer(key.signer_id.clone()))?;
    let source_meta = live
        .replica_metadata
        .as_object()
        .ok_or_else(|| ReplicaMetaProjectionError::Envelope("OBJECT_REQUIRED".into()))?;
    // The certified head already lives in the typed consensus replica. Keeping
    // its derived projection in the RAM envelope made the next frame clone
    // O(previous frame bytes). Rebuild it only at the checkpoint boundary.
    let mut retained = source_meta
        .iter()
        .filter(|(field, _)| field.as_str() != "certifiedFrameHead")
        .map(|(field, value)| (field.clone(), value.clone()))
        .collect::<Map<_, _>>();
    retained.insert("entityId".into(), Value::String(entity_id.clone()));
    retained.insert("signerId".into(), Value::String(signer_id.clone()));
    retained.insert("isProposer".into(), Value::Bool(true));
    retained.insert(
        "lastConsensusProgressAt".into(),
        safe_number("lastConsensusProgressAt", result.replica.state.timestamp)?,
    );
    let committed_value = if materialized {
        let mut full = retained.clone();
        full.insert(
            "certifiedFrameHead".into(),
            object([
                ("frame", frame(&head.frame)?),
                (
                    "postAuthority",
                    super::output::canonical_json(head.post_authority.state_value()?)?,
                ),
            ]),
        );
        Value::Object(full)
    } else {
        live_replica_meta(state, live, head, &entity_id, &signer_id)?
    };
    let encoded = crate::transport::msgpack::encode_framed(&committed_value)?;
    let mut key = Vec::with_capacity(65);
    key.push(0x26);
    key.extend_from_slice(&parse_hex(&entity_id, 32)?);
    key.extend_from_slice(&[0; 12]);
    key.extend_from_slice(&parse_hex(&signer_id, 20)?);
    let entry = StorageReplicaMetaEntry {
        key,
        value: encoded,
    };
    Ok(PreparedReplicaMeta {
        entry,
        value: Value::Object(retained),
    })
}

fn live_replica_meta(
    state: &crate::RuntimeEntityState,
    live: &crate::RuntimeEntityReplica,
    head: &CertifiedEntityFrameLink,
    entity_id: &str,
    signer_id: &str,
) -> Result<Value, ReplicaMetaProjectionError> {
    let identity = certified_head_identity(head)?;
    let head_digest: [u8; 32] =
        Sha256::digest(crate::transport::msgpack::encode_framed(&identity)?).into();
    let frame_hash = head.frame.hash.clone();
    let mut value = Map::from_iter([
        (
            "replicaKey".into(),
            Value::String(format!("{entity_id}:{signer_id}")),
        ),
        ("entityId".into(), Value::String(entity_id.into())),
        ("signerId".into(), Value::String(signer_id.into())),
        ("isProposer".into(), Value::Bool(true)),
        (
            "entityHead".into(),
            object([
                ("entityId", Value::String(entity_id.into())),
                (
                    "height",
                    safe_number("entityHead.height", state.entity.height)?,
                ),
                (
                    "timestamp",
                    safe_number("entityHead.timestamp", state.entity.timestamp)?,
                ),
                ("frameHash", Value::String(frame_hash)),
            ]),
        ),
        (
            "certifiedFrameHeadDigest".into(),
            Value::String(hex(&head_digest)),
        ),
    ]);
    let source = live
        .replica_metadata
        .as_object()
        .ok_or_else(|| ReplicaMetaProjectionError::Envelope("OBJECT_REQUIRED".into()))?;
    for field in [
        "leaderVotes",
        "pendingLeaderCertificate",
        "jPrefixRound",
        // Frame A's certified Entity Hanko is the only authority for sealing
        // Frame B's durable J attempt. Dropping it here makes live submission
        // impossible even though replay still sees the signed Entity frame.
        "hankoWitness",
        "jSubmitState",
        "entityProviderActionSubmitState",
        "jHistory",
        "lockedFrame",
    ] {
        if let Some(entry) = source.get(field) {
            value.insert(field.into(), entry.clone());
        }
    }
    Ok(Value::Object(value))
}

fn certified_head_identity(
    head: &CertifiedEntityFrameLink,
) -> Result<Value, ReplicaMetaProjectionError> {
    let frame = &head.frame;
    let mut value = Map::from_iter([
        (
            "frameHash".into(),
            Value::String(frame.hash.to_ascii_lowercase()),
        ),
        (
            "parentFrameHash".into(),
            Value::String(frame.parent_frame_hash.clone()),
        ),
        (
            "stateRoot".into(),
            Value::String(frame.state_root.to_ascii_lowercase()),
        ),
        (
            "authorityRoot".into(),
            Value::String(frame.authority_root.to_ascii_lowercase()),
        ),
        ("leader".into(), leader(frame)?),
        (
            "postAuthority".into(),
            super::output::canonical_json(head.post_authority.state_value()?)?,
        ),
    ]);
    if !frame.hashes_to_sign.is_empty() {
        value.insert(
            "hashesToSign".into(),
            Value::Array(
                frame
                    .hashes_to_sign
                    .iter()
                    .map(|row| {
                        object([
                            ("hash", Value::String(row.hash.clone())),
                            ("type", Value::String(hash_type(&row.kind).into())),
                            ("context", Value::String(row.context.clone())),
                        ])
                    })
                    .collect(),
            ),
        );
    }
    if !frame.collected_sigs.is_empty() {
        value.insert(
            "collectedSigs".into(),
            tagged_map(
                frame
                    .collected_sigs
                    .iter()
                    .map(|(signer, signatures)| {
                        Value::Array(vec![
                            Value::String(signer.clone()),
                            Value::Array(
                                signatures
                                    .iter()
                                    .map(|signature| Value::String(hex(signature)))
                                    .collect(),
                            ),
                        ])
                    })
                    .collect(),
            ),
        );
    }
    if !frame.hankos.is_empty() {
        value.insert(
            "hankos".into(),
            Value::Array(
                frame
                    .hankos
                    .iter()
                    .map(|hanko| Value::String(hex(hanko)))
                    .collect(),
            ),
        );
    }
    Ok(Value::Object(value))
}

fn frame(frame: &EntityFrame) -> Result<Value, ReplicaMetaProjectionError> {
    let mut value = Map::from_iter([
        ("height".into(), safe_number("frame.height", frame.height)?),
        (
            "parentFrameHash".into(),
            Value::String(frame.parent_frame_hash.clone()),
        ),
        ("stateRoot".into(), Value::String(frame.state_root.clone())),
        (
            "authorityRoot".into(),
            Value::String(frame.authority_root.clone()),
        ),
        (
            "timestamp".into(),
            safe_number("frame.timestamp", frame.timestamp)?,
        ),
        (
            "entityContext".into(),
            super::output::canonical_json_ref(&frame.entity_context)?,
        ),
        (
            "txs".into(),
            Value::Array(
                frame
                    .txs
                    .iter()
                    .map(|tx| {
                        Ok(object([
                            ("type", Value::String(tx.kind.as_str().into())),
                            ("data", super::output::canonical_json_ref(&tx.wire_data)?),
                        ]))
                    })
                    .collect::<Result<Vec<_>, ReplicaMetaProjectionError>>()?,
            ),
        ),
        (
            "events".into(),
            Value::Array(frame.events.iter().map(event).collect()),
        ),
        ("hash".into(), Value::String(frame.hash.clone())),
        ("leader".into(), leader(frame)?),
        (
            "hashesToSign".into(),
            Value::Array(
                frame
                    .hashes_to_sign
                    .iter()
                    .map(|row| {
                        object([
                            ("hash", Value::String(row.hash.clone())),
                            ("type", Value::String(hash_type(&row.kind).into())),
                            ("context", Value::String(row.context.clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "collectedSigs".into(),
            tagged_map(
                frame
                    .collected_sigs
                    .iter()
                    .map(|(signer, signatures)| {
                        Value::Array(vec![
                            Value::String(signer.clone()),
                            Value::Array(
                                signatures
                                    .iter()
                                    .map(|signature| Value::String(hex(signature)))
                                    .collect(),
                            ),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "hankos".into(),
            Value::Array(
                frame
                    .hankos
                    .iter()
                    .map(|hanko| Value::String(hex(hanko)))
                    .collect(),
            ),
        ),
    ]);
    if let Some(certificate) = &frame.j_prefix_certificate {
        value.insert(
            "jPrefixCertificate".into(),
            super::output::canonical_json_ref(certificate)?,
        );
    }
    Ok(Value::Object(value))
}

fn leader(frame: &EntityFrame) -> Result<Value, ReplicaMetaProjectionError> {
    let leader = &frame.leader;
    let mut value = Map::from_iter([
        (
            "proposerSignerId".into(),
            Value::String(leader.proposer_signer_id.clone()),
        ),
        ("view".into(), safe_number("leader.view", leader.view)?),
    ]);
    if let Some(certificate) = &leader.certificate {
        value.insert(
            "certificate".into(),
            super::output::canonical_json_ref(certificate)?,
        );
    }
    if let Some(certificate) = &leader.relay_certificate {
        value.insert(
            "relayCertificate".into(),
            super::output::canonical_json_ref(certificate)?,
        );
    }
    Ok(Value::Object(value))
}

fn event(value: &EntityFrameEvent) -> Value {
    match value {
        EntityFrameEvent::Status { message } => object([
            ("type", Value::String("status".into())),
            ("message", Value::String(message.clone())),
        ]),
        EntityFrameEvent::Text {
            validator_id,
            message,
        } => object([
            ("type", Value::String("text".into())),
            ("validatorId", Value::String(validator_id.clone())),
            ("message", Value::String(message.clone())),
        ]),
    }
}

fn hash_type(value: &HashType) -> &'static str {
    match value {
        HashType::EntityFrame => "entityFrame",
        HashType::EntityOutput => "entityOutput",
        HashType::AccountFrame => "accountFrame",
        HashType::Dispute => "dispute",
        HashType::Settlement => "settlement",
        HashType::Profile => "profile",
        HashType::JBatch => "jBatch",
        HashType::EntityProviderAction => "entityProviderAction",
    }
}

fn tagged_map(rows: Vec<Value>) -> Value {
    object([
        ("__xlnType", Value::String("Map".into())),
        ("value", Value::Array(rows)),
    ])
}

fn safe_number(field: &'static str, value: u64) -> Result<Value, ReplicaMetaProjectionError> {
    if value > MAX_SAFE_INTEGER {
        return Err(ReplicaMetaProjectionError::UnsafeNumber { field, value });
    }
    Ok(Value::Number(Number::from(value)))
}

fn parse_hex(value: &str, bytes: usize) -> Result<Vec<u8>, ReplicaMetaProjectionError> {
    let normalized = normalize_hex(value, bytes)
        .ok_or_else(|| ReplicaMetaProjectionError::Digest(value.into()))?;
    (0..bytes)
        .map(|index| {
            u8::from_str_radix(&normalized[2 + index * 2..4 + index * 2], 16)
                .map_err(|_| ReplicaMetaProjectionError::Digest(value.into()))
        })
        .collect()
}

fn normalize_hex(value: &str, bytes: usize) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    let body = normalized.strip_prefix("0x")?;
    (body.len() == bytes * 2 && body.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then_some(normalized)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::from("0x"), |mut value, byte| {
        use std::fmt::Write as _;
        let _ = write!(value, "{byte:02x}");
        value
    })
}

fn object<const N: usize>(entries: [(&str, Value); N]) -> Value {
    Value::Object(Map::from_iter(
        entries
            .into_iter()
            .map(|(field, value)| (field.to_string(), value)),
    ))
}

#[derive(Debug, Error)]
pub(crate) enum ReplicaMetaProjectionError {
    #[error("RRS_REPLICA_META_CERTIFIED_FRAME_MISSING")]
    CertifiedFrameMissing,
    #[error("RRS_REPLICA_META_SIGNER:{0}")]
    Signer(String),
    #[error("RRS_REPLICA_META_DIGEST:{0}")]
    Digest(String),
    #[error("RRS_REPLICA_META_ENVELOPE:{0}")]
    Envelope(String),
    #[error("RRS_REPLICA_META_NUMBER_UNSAFE:{field}:{value}")]
    UnsafeNumber { field: &'static str, value: u64 },
    #[error(transparent)]
    Transport(#[from] crate::transport::RuntimeTransportError),
    #[error(transparent)]
    EntityOutput(#[from] EntityOutputEncodingError),
    #[error(transparent)]
    Authority(#[from] xln_rscore_entity_kernel::EntityAuthorityError),
}

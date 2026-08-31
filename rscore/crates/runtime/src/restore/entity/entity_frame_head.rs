//! Exact decoder for the certified Entity head stored in replica metadata.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};
use thiserror::Error;
use xln_rscore_entity_kernel::{
    CanonicalEntityTx, CertifiedEntityFrameLink, EntityFrame, EntityFrameEvent, EntityFrameLeader,
    HashToSign, HashType,
};

use crate::{TaggedJsonError, canonical_value_from_tagged_json};

use super::entity_consensus::{EntityConsensusRestoreError, decode_entity_authority};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const ECDSA_SIGNATURE_BYTES: usize = 65;

#[derive(Debug, Error)]
pub enum EntityFrameHeadRestoreError {
    #[error("RRS_RESTORE_ENTITY_HEAD:{0}")]
    Invalid(String),
    #[error(transparent)]
    Tagged(#[from] TaggedJsonError),
    #[error(transparent)]
    Consensus(#[from] EntityConsensusRestoreError),
}

fn invalid(detail: impl Into<String>) -> EntityFrameHeadRestoreError {
    EntityFrameHeadRestoreError::Invalid(detail.into())
}

fn object<'a>(
    value: &'a Value,
    path: &str,
) -> Result<&'a Map<String, Value>, EntityFrameHeadRestoreError> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("OBJECT:{path}")))
}

fn exact_fields(
    value: &Map<String, Value>,
    required: &[&str],
    optional: &[&str],
    path: &str,
) -> Result<(), EntityFrameHeadRestoreError> {
    if let Some(field) = required.iter().find(|field| !value.contains_key(**field)) {
        return Err(invalid(format!("FIELD:{path}.{field}")));
    }
    if let Some(field) = value
        .keys()
        .find(|field| !required.contains(&field.as_str()) && !optional.contains(&field.as_str()))
    {
        return Err(invalid(format!("UNKNOWN_FIELD:{path}.{field}")));
    }
    Ok(())
}

fn required<'a>(
    value: &'a Map<String, Value>,
    field: &str,
    path: &str,
) -> Result<&'a Value, EntityFrameHeadRestoreError> {
    value
        .get(field)
        .ok_or_else(|| invalid(format!("FIELD:{path}.{field}")))
}

fn text(value: &Value, path: &str) -> Result<String, EntityFrameHeadRestoreError> {
    value
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| invalid(format!("TEXT:{path}")))
}

fn nonempty_text(value: &Value, path: &str) -> Result<String, EntityFrameHeadRestoreError> {
    text(value, path).and_then(|value| {
        if value.is_empty() {
            Err(invalid(format!("TEXT_EMPTY:{path}")))
        } else {
            Ok(value)
        }
    })
}

fn safe_u64(value: &Value, path: &str) -> Result<u64, EntityFrameHeadRestoreError> {
    value
        .as_u64()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid(format!("UNSIGNED:{path}")))
}

fn digest(value: &Value, path: &str) -> Result<String, EntityFrameHeadRestoreError> {
    let value = text(value, path)?;
    if value.strip_prefix("0x").is_some_and(|payload| {
        payload.len() == 64 && payload.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        Ok(value.to_lowercase())
    } else {
        Err(invalid(format!("DIGEST:{path}")))
    }
}

fn hex_bytes(
    value: &Value,
    expected_length: Option<usize>,
    path: &str,
) -> Result<Vec<u8>, EntityFrameHeadRestoreError> {
    let value = text(value, path)?;
    let payload = value
        .strip_prefix("0x")
        .filter(|payload| !payload.is_empty() && payload.len().is_multiple_of(2))
        .ok_or_else(|| invalid(format!("HEX:{path}")))?;
    if expected_length.is_some_and(|expected| payload.len() != expected.saturating_mul(2)) {
        return Err(invalid(format!("HEX_LENGTH:{path}")));
    }
    payload
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let pair = std::str::from_utf8(pair).map_err(|_| invalid(format!("HEX:{path}")))?;
            u8::from_str_radix(pair, 16).map_err(|_| invalid(format!("HEX:{path}")))
        })
        .collect()
}

fn txs(value: &Value) -> Result<Vec<CanonicalEntityTx>, EntityFrameHeadRestoreError> {
    value
        .as_array()
        .ok_or_else(|| invalid("ARRAY:frame.txs"))?
        .iter()
        .map(|tx| {
            crate::entity_frame::project_entity_tx(tx)
                .map_err(|error| invalid(format!("TX:{error}")))
        })
        .collect()
}

fn events(value: &Value) -> Result<Vec<EntityFrameEvent>, EntityFrameHeadRestoreError> {
    value
        .as_array()
        .ok_or_else(|| invalid("ARRAY:frame.events"))?
        .iter()
        .enumerate()
        .map(|(index, event)| {
            let path = format!("frame.events[{index}]");
            let event = object(event, &path)?;
            match required(event, "type", &path)?.as_str() {
                Some("status") => {
                    exact_fields(event, &["type", "message"], &[], &path)?;
                    Ok(EntityFrameEvent::Status {
                        message: text(required(event, "message", &path)?, &path)?,
                    })
                }
                Some("text") => {
                    exact_fields(event, &["type", "validatorId", "message"], &[], &path)?;
                    let validator_id = nonempty_text(
                        required(event, "validatorId", &path)?,
                        &format!("{path}.validatorId"),
                    )?;
                    if validator_id != validator_id.trim().to_lowercase() {
                        return Err(invalid(format!("VALIDATOR_ID:{path}")));
                    }
                    Ok(EntityFrameEvent::Text {
                        validator_id,
                        message: text(
                            required(event, "message", &path)?,
                            &format!("{path}.message"),
                        )?,
                    })
                }
                _ => Err(invalid(format!("EVENT_TYPE:{path}"))),
            }
        })
        .collect()
}

fn hash_type(value: &str, path: &str) -> Result<HashType, EntityFrameHeadRestoreError> {
    Ok(match value {
        "entityFrame" => HashType::EntityFrame,
        "entityOutput" => HashType::EntityOutput,
        "accountFrame" => HashType::AccountFrame,
        "dispute" => HashType::Dispute,
        "settlement" => HashType::Settlement,
        "profile" => HashType::Profile,
        "jBatch" => HashType::JBatch,
        "entityProviderAction" => HashType::EntityProviderAction,
        _ => return Err(invalid(format!("HASH_TYPE:{path}:{value}"))),
    })
}

fn hashes(value: &Value) -> Result<Vec<HashToSign>, EntityFrameHeadRestoreError> {
    let rows = value
        .as_array()
        .filter(|rows| !rows.is_empty())
        .ok_or_else(|| invalid("HASH_MANIFEST"))?;
    rows.iter()
        .enumerate()
        .map(|(index, value)| {
            let path = format!("frame.hashesToSign[{index}]");
            let row = object(value, &path)?;
            exact_fields(row, &["hash", "type", "context"], &[], &path)?;
            Ok(HashToSign {
                hash: digest(required(row, "hash", &path)?, &format!("{path}.hash"))?,
                kind: hash_type(
                    required(row, "type", &path)?
                        .as_str()
                        .ok_or_else(|| invalid(format!("HASH_TYPE:{path}")))?,
                    &path,
                )?,
                context: text(required(row, "context", &path)?, &format!("{path}.context"))?,
            })
        })
        .collect()
}

fn tagged_map<'a>(
    value: &'a Value,
    path: &str,
) -> Result<&'a [Value], EntityFrameHeadRestoreError> {
    let value = object(value, path)?;
    exact_fields(value, &["__xlnType", "value"], &[], path)?;
    if value.get("__xlnType").and_then(Value::as_str) != Some("Map") {
        return Err(invalid(format!("MAP:{path}")));
    }
    value
        .get("value")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| invalid(format!("MAP:{path}")))
}

fn signatures(
    value: &Value,
    hash_count: usize,
) -> Result<BTreeMap<String, Vec<Vec<u8>>>, EntityFrameHeadRestoreError> {
    let mut output = BTreeMap::new();
    for (index, value) in tagged_map(value, "frame.collectedSigs")?.iter().enumerate() {
        let row = value
            .as_array()
            .filter(|row| row.len() == 2)
            .ok_or_else(|| invalid(format!("SIGNATURE_ROW:{index}")))?;
        let signer = nonempty_text(&row[0], "frame.collectedSigs.signer")?.to_lowercase();
        let values = row[1]
            .as_array()
            .filter(|values| values.len() == hash_count)
            .ok_or_else(|| invalid(format!("SIGNATURE_COUNT:{signer}")))?;
        let values = values
            .iter()
            .enumerate()
            .map(|(signature_index, value)| {
                hex_bytes(
                    value,
                    Some(ECDSA_SIGNATURE_BYTES),
                    &format!("frame.collectedSigs.{signer}[{signature_index}]"),
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        if output.insert(signer.clone(), values).is_some() {
            return Err(invalid(format!("SIGNATURE_DUPLICATE:{signer}")));
        }
    }
    if output.is_empty() {
        return Err(invalid("SIGNATURES_EMPTY"));
    }
    Ok(output)
}

fn leader(value: &Value) -> Result<EntityFrameLeader, EntityFrameHeadRestoreError> {
    let value = object(value, "frame.leader")?;
    exact_fields(
        value,
        &["proposerSignerId", "view"],
        &["certificate", "relayCertificate"],
        "frame.leader",
    )?;
    Ok(EntityFrameLeader {
        proposer_signer_id: nonempty_text(
            required(value, "proposerSignerId", "frame.leader")?,
            "frame.leader.proposerSignerId",
        )?
        .to_lowercase(),
        view: safe_u64(
            required(value, "view", "frame.leader")?,
            "frame.leader.view",
        )?,
        certificate: value
            .get("certificate")
            .map(canonical_value_from_tagged_json)
            .transpose()?,
        relay_certificate: value
            .get("relayCertificate")
            .map(canonical_value_from_tagged_json)
            .transpose()?,
    })
}

fn frame(value: &Value) -> Result<EntityFrame, EntityFrameHeadRestoreError> {
    let value = object(value, "frame")?;
    exact_fields(
        value,
        &[
            "height",
            "parentFrameHash",
            "stateRoot",
            "authorityRoot",
            "timestamp",
            "entityContext",
            "txs",
            "events",
            "hash",
            "leader",
            "hashesToSign",
            "collectedSigs",
            "hankos",
        ],
        &["jPrefixCertificate"],
        "frame",
    )?;
    let hashes_to_sign = hashes(required(value, "hashesToSign", "frame")?)?;
    let hankos = required(value, "hankos", "frame")?
        .as_array()
        .filter(|values| values.len() == 1)
        .ok_or_else(|| invalid("HANKO_COUNT"))?
        .iter()
        .map(|value| hex_bytes(value, None, "frame.hankos[0]"))
        .collect::<Result<Vec<_>, _>>()?;
    let parent_frame_hash = nonempty_text(
        required(value, "parentFrameHash", "frame")?,
        "frame.parentFrameHash",
    )?;
    if parent_frame_hash != "genesis" {
        digest(
            &Value::String(parent_frame_hash.clone()),
            "frame.parentFrameHash",
        )?;
    }
    Ok(EntityFrame {
        height: safe_u64(required(value, "height", "frame")?, "frame.height")?,
        parent_frame_hash,
        state_root: digest(required(value, "stateRoot", "frame")?, "frame.stateRoot")?,
        authority_root: digest(
            required(value, "authorityRoot", "frame")?,
            "frame.authorityRoot",
        )?,
        timestamp: safe_u64(required(value, "timestamp", "frame")?, "frame.timestamp")?,
        entity_context: canonical_value_from_tagged_json(required(
            value,
            "entityContext",
            "frame",
        )?)?,
        txs: txs(required(value, "txs", "frame")?)?,
        events: events(required(value, "events", "frame")?)?,
        hash: digest(required(value, "hash", "frame")?, "frame.hash")?,
        leader: leader(required(value, "leader", "frame")?)?,
        j_prefix_certificate: value
            .get("jPrefixCertificate")
            .map(canonical_value_from_tagged_json)
            .transpose()?,
        collected_sigs: signatures(
            required(value, "collectedSigs", "frame")?,
            hashes_to_sign.len(),
        )?,
        hashes_to_sign,
        hankos,
    })
}

/// Decode the exact `CertifiedEntityFrameLink` persisted in 0x26 metadata.
/// Hash/root/signature shape is rebound by `RuntimeReplica::new`; this decoder
/// only admits the canonical structural and scalar domains.
pub fn decode_certified_entity_frame_head(
    value: &Value,
) -> Result<CertifiedEntityFrameLink, EntityFrameHeadRestoreError> {
    let value = object(value, "certifiedFrameHead")?;
    exact_fields(
        value,
        &["frame", "postAuthority"],
        &[],
        "certifiedFrameHead",
    )?;
    let frame = frame(required(value, "frame", "certifiedFrameHead")?)?;
    let post_authority = decode_entity_authority(object(
        required(value, "postAuthority", "certifiedFrameHead")?,
        "certifiedFrameHead.postAuthority",
    )?)?;
    if post_authority
        .root()
        .map_err(|error| invalid(error.to_string()))?
        != frame.authority_root
    {
        return Err(invalid("AUTHORITY_ROOT"));
    }
    if frame
        .hashes_to_sign
        .first()
        .is_none_or(|entry| entry.kind != HashType::EntityFrame || entry.hash != frame.hash)
    {
        return Err(invalid("FRAME_MANIFEST"));
    }
    let signers = frame
        .collected_sigs
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    if signers
        .iter()
        .any(|signer| !post_authority.config.shares.contains_key(signer))
    {
        return Err(invalid("SIGNER_OUTSIDE_AUTHORITY"));
    }
    frame
        .require_certified_proof_shape()
        .map_err(|error| invalid(error.to_string()))?;
    Ok(CertifiedEntityFrameLink {
        frame,
        post_authority,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use xln_rscore_entity_kernel::{
        ConsensusMode, EntityConsensusConfig, EntityFrameAuthority, EntityFrameBody,
        EntityLeaderState, compute_entity_frame_hash,
    };
    use xln_rscore_protocol::CanonicalValue;

    use super::*;

    fn tagged_bigint(value: u16) -> Value {
        json!({ "__xlnType": "BigInt", "value": value.to_string() })
    }

    fn authority() -> EntityFrameAuthority {
        EntityFrameAuthority {
            config: EntityConsensusConfig {
                mode: ConsensusMode::ProposerBased,
                threshold: 1,
                validators: vec!["0x1111111111111111111111111111111111111111".into()],
                shares: BTreeMap::from([("0x1111111111111111111111111111111111111111".into(), 1)]),
                jurisdiction: None,
            },
            leader_state: EntityLeaderState {
                active_validator_id: "0x1111111111111111111111111111111111111111".into(),
                view: 0,
                changed_at_height: 0,
            },
        }
    }

    fn authority_json() -> Value {
        json!({
            "config": {
                "mode": "proposer-based",
                "threshold": tagged_bigint(1),
                "validators": ["0x1111111111111111111111111111111111111111"],
                "shares": {
                    "0x1111111111111111111111111111111111111111": tagged_bigint(1)
                }
            },
            "leaderState": {
                "activeValidatorId": "0x1111111111111111111111111111111111111111",
                "view": 0,
                "changedAtHeight": 0
            }
        })
    }

    fn fixture() -> Value {
        let authority_root = authority().root().expect("authority root");
        let state_root = format!("0x{}", "22".repeat(32));
        let entity_id = format!("0x{}", "33".repeat(32));
        let context = CanonicalValue::Object(Vec::new());
        let hash = compute_entity_frame_hash(&EntityFrameBody {
            parent_frame_hash: "genesis",
            height: 1,
            timestamp: 10,
            txs: &[],
            events: &[],
            entity_id: &entity_id,
            state_root: &state_root,
            authority_root: &authority_root,
            entity_context: &context,
            entity_context_bytes: None,
            j_prefix_certificate: None,
        })
        .expect("frame hash");
        json!({
            "frame": {
                "height": 1,
                "parentFrameHash": "genesis",
                "stateRoot": state_root,
                "authorityRoot": authority_root,
                "timestamp": 10,
                "entityContext": {},
                "txs": [],
                "events": [],
                "hash": hash,
                "leader": {
                    "proposerSignerId": "0x1111111111111111111111111111111111111111",
                    "view": 0
                },
                "hashesToSign": [{
                    "hash": hash,
                    "type": "entityFrame",
                    "context": "entity-frame"
                }],
                "collectedSigs": {
                    "__xlnType": "Map",
                    "value": [[
                        "0x1111111111111111111111111111111111111111",
                        [format!("0x{}", "44".repeat(65))]
                    ]]
                },
                "hankos": ["0x55"]
            },
            "postAuthority": authority_json()
        })
    }

    #[test]
    fn exact_certified_head_decodes_and_binds_authority() {
        let decoded = decode_certified_entity_frame_head(&fixture()).expect("decode head");
        assert_eq!(decoded.frame.height, 1);
        assert_eq!(decoded.frame.collected_sigs.len(), 1);
        assert_eq!(decoded.frame.hankos, vec![vec![0x55]]);
    }

    #[test]
    fn authority_substitution_is_rejected() {
        let mut value = fixture();
        value["postAuthority"]["leaderState"]["view"] = json!(1);
        let error = decode_certified_entity_frame_head(&value).expect_err("wrong authority root");
        assert!(error.to_string().contains("AUTHORITY_ROOT"));
    }

    #[test]
    fn truncated_signature_is_rejected() {
        let mut value = fixture();
        value["frame"]["collectedSigs"]["value"][0][1][0] =
            Value::String(format!("0x{}", "44".repeat(64)));
        let error = decode_certified_entity_frame_head(&value).expect_err("short signature");
        assert!(error.to_string().contains("HEX_LENGTH"));
    }
}

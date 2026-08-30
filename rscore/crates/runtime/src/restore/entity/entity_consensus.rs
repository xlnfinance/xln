//! Restore the live Entity consensus envelope from canonical graph values.

use std::collections::BTreeMap;

use num_bigint::BigInt;
use serde_json::{Map, Value};
use thiserror::Error;
use xln_rscore_engine::BoardDelays;
use xln_rscore_entity_kernel::{
    ConsensusMode, EntityConsensusConfig, EntityConsensusState, EntityFrameAuthority,
    EntityLeaderState, EntitySingleSigner, ResidentEntityConsensusReplica,
};
use xln_rscore_protocol::CanonicalValue;

use crate::{TaggedJsonError, canonical_value_from_tagged_json};

use super::{HydratedEntityGraph, RestoredReplicaMetadata, decode_certified_entity_frame_head};

#[derive(Debug, Error)]
pub enum EntityConsensusRestoreError {
    #[error("RRS_RESTORE_ENTITY_CONSENSUS:{0}")]
    Invalid(String),
    #[error(transparent)]
    Tagged(#[from] TaggedJsonError),
    #[error("RRS_RESTORE_ENTITY_SIGNER:{0}")]
    Signer(String),
}

fn invalid(detail: impl Into<String>) -> EntityConsensusRestoreError {
    EntityConsensusRestoreError::Invalid(detail.into())
}

fn object<'a>(
    value: &'a Value,
    path: &str,
) -> Result<&'a Map<String, Value>, EntityConsensusRestoreError> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("OBJECT:{path}")))
}

fn required<'a>(
    value: &'a Map<String, Value>,
    name: &str,
    path: &str,
) -> Result<&'a Value, EntityConsensusRestoreError> {
    value
        .get(name)
        .ok_or_else(|| invalid(format!("FIELD:{path}.{name}")))
}

fn text(value: &Value, path: &str) -> Result<String, EntityConsensusRestoreError> {
    value
        .as_str()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(format!("TEXT:{path}")))
}

fn safe_u64(value: &Value, path: &str) -> Result<u64, EntityConsensusRestoreError> {
    value
        .as_u64()
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or_else(|| invalid(format!("UNSIGNED:{path}")))
}

fn bigint(value: &Value, path: &str) -> Result<BigInt, EntityConsensusRestoreError> {
    let value = object(value, path)?;
    if value.len() != 2 || value.get("__xlnType").and_then(Value::as_str) != Some("BigInt") {
        return Err(invalid(format!("BIGINT:{path}")));
    }
    value
        .get("value")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("BIGINT:{path}")))?
        .parse()
        .map_err(|_| invalid(format!("BIGINT:{path}")))
}

fn positive_u16(value: &Value, path: &str) -> Result<u16, EntityConsensusRestoreError> {
    let value = bigint(value, path)?;
    u16::try_from(value)
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| invalid(format!("U16:{path}")))
}

fn canonical_jurisdiction(
    config: &Map<String, Value>,
) -> Result<Option<CanonicalValue>, EntityConsensusRestoreError> {
    let Some(value) = config.get("jurisdiction") else {
        return Ok(None);
    };
    object(value, "config.jurisdiction")?;
    canonical_value_from_tagged_json(value)
        .map(Some)
        .map_err(Into::into)
}

pub(super) fn decode_entity_authority(
    core: &Map<String, Value>,
) -> Result<EntityFrameAuthority, EntityConsensusRestoreError> {
    let config = object(required(core, "config", "core")?, "core.config")?;
    let mode = match required(config, "mode", "config")?.as_str() {
        Some("proposer-based") => ConsensusMode::ProposerBased,
        Some("gossip-based") => ConsensusMode::GossipBased,
        _ => return Err(invalid("CONFIG_MODE")),
    };
    let validators = required(config, "validators", "config")?
        .as_array()
        .ok_or_else(|| invalid("CONFIG_VALIDATORS"))?
        .iter()
        .map(|value| text(value, "config.validators"))
        .collect::<Result<Vec<_>, _>>()?;
    let mut shares = BTreeMap::new();
    for (signer, share) in object(required(config, "shares", "config")?, "config.shares")? {
        let signer = signer.trim().to_lowercase();
        if signer.is_empty()
            || shares
                .insert(signer.clone(), positive_u16(share, "config.share")?)
                .is_some()
        {
            return Err(invalid(format!("CONFIG_SHARE:{signer}")));
        }
    }
    let config = EntityConsensusConfig {
        mode,
        threshold: positive_u16(required(config, "threshold", "config")?, "config.threshold")?,
        validators,
        shares,
        jurisdiction: canonical_jurisdiction(config)?,
    };
    let leader = match core.get("leaderState") {
        Some(value) => {
            let value = object(value, "core.leaderState")?;
            EntityLeaderState {
                active_validator_id: text(
                    required(value, "activeValidatorId", "leaderState")?,
                    "leaderState.activeValidatorId",
                )?,
                view: safe_u64(required(value, "view", "leaderState")?, "leaderState.view")?,
                changed_at_height: safe_u64(
                    required(value, "changedAtHeight", "leaderState")?,
                    "leaderState.changedAtHeight",
                )?,
            }
        }
        None => EntityLeaderState {
            active_validator_id: config
                .validators
                .first()
                .cloned()
                .ok_or_else(|| invalid("CONFIG_VALIDATORS_EMPTY"))?,
            view: 0,
            changed_at_height: 0,
        },
    };
    EntityFrameAuthority {
        config,
        leader_state: leader,
    }
    .validate_and_normalize()
    .map_err(|error| invalid(error.to_string()))
}

/// Hydrate the complete live consensus envelope. The certified head is decoded
/// by the exact Entity-frame codec and passed in; a non-genesis graph without
/// one is rejected by `RuntimeReplica::new::validate_restored`.
pub fn hydrate_entity_consensus(
    graph: &HydratedEntityGraph,
    metadata: &RestoredReplicaMetadata,
    private_key: [u8; 32],
    delays: BoardDelays,
) -> Result<(ResidentEntityConsensusReplica, EntitySingleSigner), EntityConsensusRestoreError> {
    let core = object(&graph.core, "core")?;
    let authority = decode_entity_authority(core)?;
    if !authority
        .is_single_signer()
        .map_err(|error| invalid(error.to_string()))?
    {
        return Err(invalid("SINGLE_SIGNER_REQUIRED"));
    }
    let signer = metadata.signer_id.trim().to_lowercase();
    let weight = authority
        .config
        .shares
        .get(&signer)
        .copied()
        .ok_or_else(|| invalid("SIGNER_OUTSIDE_AUTHORITY"))?;
    let entity_id = text(required(core, "entityId", "core")?, "core.entityId")?;
    let entity_signer = EntitySingleSigner::from_key(
        private_key,
        &signer,
        &entity_id,
        u128::from(weight),
        u128::from(authority.config.threshold),
        delays,
    )
    .map_err(|error| EntityConsensusRestoreError::Signer(error.to_string()))?;
    let metadata_value = object(&metadata.value, "replicaMeta")?;
    let certified_frame_head = metadata_value
        .get("certifiedFrameHead")
        .map(decode_certified_entity_frame_head)
        .transpose()
        .map_err(|error| invalid(error.to_string()))?;
    Ok((
        ResidentEntityConsensusReplica {
            state: EntityConsensusState {
                sections: graph.carried_sections.clone(),
                authority,
            },
            certified_frame_head,
        },
        entity_signer,
    ))
}

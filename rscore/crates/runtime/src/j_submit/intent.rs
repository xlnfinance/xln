//! Frame-A Jurisdiction intents finalized by Entity certification.
//!
//! Entity execution can name a batch hash, but only certification owns its
//! Hanko. This seam binds the exact manifest witness into the canonical live
//! Entity replica and returns the Frame-B retry input. Runtime releases the
//! retry only after Frame A is fsynced.

use num_bigint::BigInt;
use serde_json::{Map, Value, json};
use thiserror::Error;
use xln_rscore_entity_kernel::{
    EntityHankoWitnessMap, EntityJOutput, EntityProviderActionIntent,
    EntityProviderGovernanceIntent, HashType,
};

use super::{DurableGovernanceAttempt, RetryJSubmitData, prepare_governance_attempt};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JMaintenanceIntent {
    MintReserves {
        jurisdiction_name: String,
        entity_id: [u8; 32],
        token_id: u64,
        amount: BigInt,
        timestamp: u64,
    },
    ActivateBoard {
        jurisdiction_name: String,
        entity_id: [u8; 32],
        target_entity_id: [u8; 32],
        signer_id: String,
        timestamp: u64,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PreparedEntityJIntents {
    pub retries: Vec<RetryJSubmitData>,
    pub provider_actions: Vec<PreparedEntityProviderActionIntent>,
    pub governance: Vec<DurableGovernanceAttempt>,
    pub maintenance: Vec<JMaintenanceIntent>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedEntityProviderActionIntent {
    pub jurisdiction_name: String,
    pub intent: EntityProviderActionIntent,
    pub signer_id: String,
    pub hanko: Vec<u8>,
}

#[derive(Debug, Error)]
#[error("RSCORE_J_INTENT:{0}")]
pub struct JIntentError(String);

fn error(code: impl Into<String>) -> JIntentError {
    JIntentError(code.into())
}

fn hex(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn metadata_object(replica_metadata: &mut Value) -> Result<&mut Map<String, Value>, JIntentError> {
    replica_metadata
        .as_object_mut()
        .ok_or_else(|| error("REPLICA_METADATA_OBJECT"))
}

fn witness_rows(metadata: &mut Map<String, Value>) -> Result<&mut Vec<Value>, JIntentError> {
    let tagged = metadata
        .entry("hankoWitness")
        .or_insert_with(|| json!({"__xlnType":"Map","value":[]}));
    let object = tagged
        .as_object_mut()
        .ok_or_else(|| error("HANKO_WITNESS_TAG_OBJECT"))?;
    if object.get("__xlnType").and_then(Value::as_str) != Some("Map") {
        return Err(error("HANKO_WITNESS_TAG"));
    }
    object
        .get_mut("value")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| error("HANKO_WITNESS_ROWS"))
}

fn install_j_batch_witness(
    replica_metadata: &mut Value,
    batch_hash: &[u8; 32],
    hanko: &[u8],
    entity_height: u64,
    timestamp: u64,
) -> Result<(), JIntentError> {
    let wanted = hex(batch_hash);
    let rows = witness_rows(metadata_object(replica_metadata)?)?;
    // TS prunes stale quorum staging after each Entity commit. Preserve other
    // live witness classes, but a Runtime may retain only the current jBatch.
    rows.retain(|row| {
        row.as_array()
            .and_then(|pair| pair.get(1))
            .and_then(Value::as_object)
            .and_then(|entry| entry.get("type"))
            .and_then(Value::as_str)
            != Some("jBatch")
    });
    rows.push(json!([wanted, {
        "hanko": hex(hanko),
        "type": "jBatch",
        "entityHeight": entity_height,
        "createdAt": timestamp,
    }]));
    Ok(())
}

fn install_entity_provider_action_witness(
    replica_metadata: &mut Value,
    action_hash: &[u8; 32],
    hanko: &[u8],
    entity_height: u64,
    timestamp: u64,
) -> Result<(), JIntentError> {
    let wanted = hex(action_hash);
    let rows = witness_rows(metadata_object(replica_metadata)?)?;
    rows.retain(|row| {
        let Some(pair) = row.as_array() else {
            return true;
        };
        let is_provider = pair
            .get(1)
            .and_then(Value::as_object)
            .and_then(|entry| entry.get("type"))
            .and_then(Value::as_str)
            == Some("entityProviderAction");
        let same_hash = pair.first().and_then(Value::as_str) == Some(&wanted);
        !(is_provider && same_hash)
    });
    rows.push(json!([wanted, {
        "hanko": hex(hanko),
        "type": "entityProviderAction",
        "entityHeight": entity_height,
        "createdAt": timestamp,
    }]));
    Ok(())
}

pub fn prepare_certified_entity_j_intents(
    state: &xln_rscore_entity_kernel::EntityStateSlice,
    replica_metadata: &mut Value,
    local_signer_id: &str,
    outputs: Vec<EntityJOutput>,
    witnesses: &EntityHankoWitnessMap,
) -> Result<PreparedEntityJIntents, JIntentError> {
    let mut prepared = PreparedEntityJIntents::default();
    for output in outputs {
        match output {
            EntityJOutput::BatchIntent {
                jurisdiction_name,
                batch_hash,
                entity_nonce,
                batch_generation,
                fee_overrides,
            } => {
                let sent = state
                    .j_batch_state
                    .as_ref()
                    .and_then(|batch| batch.sent_batch.as_ref())
                    .ok_or_else(|| error("SENT_BATCH_MISSING"))?;
                if sent.batch_hash != batch_hash
                    || sent.entity_nonce != entity_nonce
                    || state
                        .j_batch_state
                        .as_ref()
                        .is_none_or(|batch| batch.broadcast_count != batch_generation)
                {
                    return Err(error("BATCH_INTENT_STATE_MISMATCH"));
                }
                let hash = hex(&batch_hash);
                let witness = witnesses
                    .get(&hash)
                    .ok_or_else(|| error(format!("J_BATCH_WITNESS_MISSING:{hash}")))?;
                if witness.kind != HashType::JBatch {
                    return Err(error("J_BATCH_WITNESS_TYPE"));
                }
                install_j_batch_witness(
                    replica_metadata,
                    &batch_hash,
                    &witness.hanko,
                    state.height,
                    state.timestamp,
                )?;
                prepared.retries.push(RetryJSubmitData {
                    entity_id: state.entity_id.clone(),
                    signer_id: local_signer_id.to_string(),
                    jurisdiction_name,
                    batch_hash: hash,
                    entity_nonce,
                    batch_generation,
                    fee_overrides,
                });
            }
            EntityJOutput::MintReserves {
                jurisdiction_name,
                entity_id,
                token_id,
                amount,
                timestamp,
            } => {
                if hex(&entity_id) != state.entity_id.to_ascii_lowercase() {
                    return Err(error("MINT_ENTITY_MISMATCH"));
                }
                prepared.maintenance.push(JMaintenanceIntent::MintReserves {
                    jurisdiction_name,
                    entity_id,
                    token_id,
                    amount,
                    timestamp,
                });
            }
            EntityJOutput::EntityProviderActionIntent {
                jurisdiction_name,
                intent,
                signer_id,
            } => {
                if !intent.entity_id.eq_ignore_ascii_case(&state.entity_id)
                    || signer_id != local_signer_id
                    || state
                        .entity_provider_action_state
                        .as_ref()
                        .and_then(|value| value.pending.as_ref())
                        != Some(&intent)
                {
                    return Err(error("ENTITY_PROVIDER_ACTION_INTENT_STATE_MISMATCH"));
                }
                let hash = hex(&intent.action_hash);
                let witness = witnesses.get(&hash).ok_or_else(|| {
                    error(format!("ENTITY_PROVIDER_ACTION_WITNESS_MISSING:{hash}"))
                })?;
                if witness.kind != HashType::EntityProviderAction {
                    return Err(error("ENTITY_PROVIDER_ACTION_WITNESS_TYPE"));
                }
                install_entity_provider_action_witness(
                    replica_metadata,
                    &intent.action_hash,
                    &witness.hanko,
                    state.height,
                    state.timestamp,
                )?;
                prepared
                    .provider_actions
                    .push(PreparedEntityProviderActionIntent {
                        jurisdiction_name,
                        intent,
                        signer_id,
                        hanko: witness.hanko.clone(),
                    });
            }
            EntityJOutput::GovernanceIntent {
                jurisdiction_name,
                intent,
            } => match intent {
                proposal @ EntityProviderGovernanceIntent::ProposeControlBoard { .. } => {
                    let EntityProviderGovernanceIntent::ProposeControlBoard {
                        shareholder_entity_id,
                        proposal_hash,
                        signer_id,
                        ..
                    } = &proposal
                    else {
                        unreachable!("matched governance proposal")
                    };
                    if hex(shareholder_entity_id) != state.entity_id.to_ascii_lowercase()
                        || signer_id != local_signer_id
                    {
                        return Err(error("GOVERNANCE_INTENT_STATE_MISMATCH"));
                    }
                    let hash = hex(proposal_hash);
                    let witness = witnesses
                        .get(&hash)
                        .ok_or_else(|| error(format!("GOVERNANCE_WITNESS_MISSING:{hash}")))?;
                    if witness.kind != HashType::EntityProviderAction {
                        return Err(error("GOVERNANCE_WITNESS_TYPE"));
                    }
                    prepared.governance.push(
                        prepare_governance_attempt(
                            jurisdiction_name,
                            proposal,
                            witness.hanko.clone(),
                        )
                        .map_err(|reason| error(reason.to_string()))?,
                    );
                }
                EntityProviderGovernanceIntent::ActivateBoard {
                    entity_id,
                    target_entity_id,
                    signer_id,
                    timestamp,
                } => {
                    if hex(&entity_id) != state.entity_id.to_ascii_lowercase()
                        || signer_id != local_signer_id
                    {
                        return Err(error("GOVERNANCE_ACTIVATION_STATE_MISMATCH"));
                    }
                    prepared
                        .maintenance
                        .push(JMaintenanceIntent::ActivateBoard {
                            jurisdiction_name,
                            entity_id,
                            target_entity_id,
                            signer_id,
                            timestamp,
                        });
                }
            },
        }
    }
    Ok(prepared)
}

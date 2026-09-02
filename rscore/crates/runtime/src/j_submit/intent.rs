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

fn install_profile_witnesses(
    replica_metadata: &mut Value,
    witnesses: &EntityHankoWitnessMap,
    entity_height: u64,
    timestamp: u64,
) -> Result<(), JIntentError> {
    let rows = witness_rows(metadata_object(replica_metadata)?)?;
    for (hash, witness) in witnesses {
        if witness.kind != HashType::Profile {
            continue;
        }
        rows.retain(|row| {
            row.as_array()
                .and_then(|pair| pair.first())
                .and_then(Value::as_str)
                != Some(hash)
        });
        rows.push(json!([hash, {
            "hanko": hex(&witness.hanko),
            "type": "profile",
            "entityHeight": entity_height,
            "createdAt": timestamp,
        }]));
    }
    Ok(())
}

fn witness_binding(row: &Value) -> Result<(&str, &Map<String, Value>), JIntentError> {
    let pair = row
        .as_array()
        .filter(|pair| pair.len() == 2)
        .ok_or_else(|| error("HANKO_WITNESS_PAIR"))?;
    let hash = pair[0]
        .as_str()
        .filter(|hash| !hash.is_empty())
        .ok_or_else(|| error("HANKO_WITNESS_HASH"))?;
    let entry = pair[1]
        .as_object()
        .ok_or_else(|| error("HANKO_WITNESS_ENTRY"))?;
    entry
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| error("HANKO_WITNESS_TYPE"))?;
    Ok((hash, entry))
}

fn require_reachable_witness(
    rows: &[Value],
    hash: &str,
    expected_type: &str,
) -> Result<(), JIntentError> {
    let entry = rows
        .iter()
        .find_map(|row| {
            let (candidate, entry) = witness_binding(row).ok()?;
            (candidate == hash).then_some(entry)
        })
        .ok_or_else(|| {
            error(format!(
                "HANKO_WITNESS_REACHABLE_MISSING:{expected_type}:{hash}"
            ))
        })?;
    let actual_type = entry
        .get("type")
        .and_then(Value::as_str)
        .expect("witness rows were validated");
    if actual_type != expected_type {
        return Err(error(format!(
            "HANKO_WITNESS_REACHABLE_TYPE_MISMATCH:{hash}:{expected_type}:{actual_type}"
        )));
    }
    Ok(())
}

fn newest_profile_witness(rows: &[Value]) -> Result<Option<String>, JIntentError> {
    let mut newest: Option<(String, u64, u64)> = None;
    for row in rows {
        let (hash, entry) = witness_binding(row)?;
        if entry.get("type").and_then(Value::as_str) != Some("profile") {
            continue;
        }
        let entity_height = entry
            .get("entityHeight")
            .and_then(Value::as_u64)
            .ok_or_else(|| error("HANKO_WITNESS_PROFILE_ENTITY_HEIGHT"))?;
        let created_at = entry
            .get("createdAt")
            .and_then(Value::as_u64)
            .ok_or_else(|| error("HANKO_WITNESS_PROFILE_CREATED_AT"))?;
        let replace = newest
            .as_ref()
            .is_none_or(|(best_hash, best_height, best_created)| {
                entity_height > *best_height
                    || (entity_height == *best_height && created_at > *best_created)
                    || (entity_height == *best_height
                        && created_at == *best_created
                        && hash < best_hash.as_str())
            });
        if replace {
            newest = Some((hash.to_string(), entity_height, created_at));
        }
    }
    Ok(newest.map(|(hash, _, _)| hash))
}

fn prune_hanko_witness_to_reachable_state(
    state: &xln_rscore_entity_kernel::EntityStateSlice,
    replica_metadata: &mut Value,
) -> Result<(), JIntentError> {
    let rows = witness_rows(metadata_object(replica_metadata)?)?;
    for row in rows.iter() {
        witness_binding(row)?;
    }
    let mut reachable = Vec::new();
    if let Some(sent) = state
        .j_batch_state
        .as_ref()
        .and_then(|batch| batch.sent_batch.as_ref())
    {
        let hash = hex(&sent.batch_hash);
        require_reachable_witness(rows, &hash, "jBatch")?;
        reachable.push(hash);
    }
    if let Some(pending) = state
        .entity_provider_action_state
        .as_ref()
        .and_then(|provider| provider.pending.as_ref())
    {
        let hash = hex(&pending.action_hash);
        require_reachable_witness(rows, &hash, "entityProviderAction")?;
        reachable.push(hash);
    }
    if let Some(profile_hash) = newest_profile_witness(rows)? {
        reachable.push(profile_hash);
    }
    // Match TS exactly: quorum Hankos are staging material, not history.
    // Account/dispute/settlement witnesses are already embedded in their
    // committed payloads. Only reconstructible external writes plus the newest
    // routable Profile remain checkpoint-live after every certified Entity
    // frame, including the J frame that consumes an immutable sent batch.
    rows.retain(|row| {
        row.as_array()
            .and_then(|pair| pair.first())
            .and_then(Value::as_str)
            .is_some_and(|hash| reachable.iter().any(|candidate| candidate == hash))
    });
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
    install_profile_witnesses(replica_metadata, witnesses, state.height, state.timestamp)?;
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
                println!(
                    "RSCORE_J_BATCH_INTENT:batch={}:nonce={}:generation={}",
                    hash, entity_nonce, batch_generation
                );
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
    prune_hanko_witness_to_reachable_state(state, replica_metadata)?;
    Ok(prepared)
}

#[cfg(test)]
mod tests {
    use ethabi::ethereum_types::U256;
    use serde_json::json;
    use xln_rscore_entity_kernel::{
        EntityHankoWitness, EntityHankoWitnessMap, EntityProviderActionIntent,
        EntityProviderActionPayload, EntityProviderActionState, EntityStateSlice, HashType, JBatch,
        JBatchState, JBatchStatus, SentJBatch, hash_entity_provider_action,
    };

    use super::prepare_certified_entity_j_intents;

    #[test]
    fn certified_state_prunes_every_stale_witness_and_keeps_newest_profile() {
        let mut state = EntityStateSlice::empty(format!("0x{}", "11".repeat(32)), 2_008);
        state.height = 2_008;
        let batch_hash = format!("0x{}", "08".repeat(32));
        let stale_profile_hash = format!("0x{}", "09".repeat(32));
        let newest_profile_hash = format!("0x{}", "0a".repeat(32));
        let mut metadata = json!({
            "hankoWitness": {
                "__xlnType": "Map",
                "value": [
                    [batch_hash, {
                        "hanko": "0xaa",
                        "type": "jBatch",
                        "entityHeight": 2_000,
                        "createdAt": 2_000
                    }],
                    [stale_profile_hash, {
                        "hanko": "0xbb",
                        "type": "profile",
                        "entityHeight": 1_999,
                        "createdAt": 1_999
                    }],
                    [format!("0x{}", "10".repeat(32)), {
                        "hanko": "0xdd",
                        "type": "entityProviderAction",
                        "entityHeight": 1_998,
                        "createdAt": 1_998
                    }],
                    [format!("0x{}", "11".repeat(32)), {
                        "hanko": "0xee",
                        "type": "accountFrame",
                        "entityHeight": 1_997,
                        "createdAt": 1_997
                    }],
                    [format!("0x{}", "12".repeat(32)), {
                        "hanko": "0xff",
                        "type": "dispute",
                        "entityHeight": 1_996,
                        "createdAt": 1_996
                    }],
                    [format!("0x{}", "13".repeat(32)), {
                        "hanko": "0xab",
                        "type": "settlement",
                        "entityHeight": 1_995,
                        "createdAt": 1_995
                    }]
                ]
            }
        });
        let witnesses = EntityHankoWitnessMap::from([(
            newest_profile_hash,
            EntityHankoWitness {
                kind: HashType::Profile,
                hanko: vec![0xcc],
            },
        )]);

        let prepared = prepare_certified_entity_j_intents(
            &state,
            &mut metadata,
            "validator-1",
            Vec::new(),
            &witnesses,
        )
        .expect("prepare certified J intents");

        assert_eq!(prepared, Default::default());
        assert_eq!(
            metadata["hankoWitness"]["value"],
            json!([[
                format!("0x{}", "0a".repeat(32)),
                {
                    "hanko": "0xcc",
                    "type": "profile",
                    "entityHeight": 2_008,
                    "createdAt": 2_008
                }
            ]])
        );
    }

    #[test]
    fn certified_state_retains_current_external_write_witnesses() {
        let current_hash = [0x08; 32];
        let entity_id = format!("0x{}", "11".repeat(32));
        let mut state = EntityStateSlice::empty(entity_id.clone(), 2_008);
        state.j_batch_state = Some(JBatchState {
            status: JBatchStatus::Sent,
            sent_batch: Some(SentJBatch {
                batch: JBatch::default(),
                batch_hash: current_hash,
                encoded_batch: Vec::new(),
                entity_nonce: 1,
                first_submitted_at: 2_000,
                last_submitted_at: 2_000,
                submit_attempts: 1,
                fee_overrides: None,
                transaction_hash: None,
                last_failure: None,
                terminal_failure: None,
            }),
            ..JBatchState::default()
        });
        let mut provider_intent = EntityProviderActionIntent {
            entity_id,
            entity_number: U256::from(1_u8),
            chain_id: U256::from(31_337_u64),
            entity_provider_address: [0x22; 20],
            board_epoch: U256::from(1_u8),
            action_nonce: U256::from(1_u8),
            action_hash: [0; 32],
            generation: 1,
            created_at: 2_000,
            payload: EntityProviderActionPayload::Transfer {
                to: [0x33; 20],
                token_id: U256::from(1_u8),
                amount: U256::from(2_u8),
            },
        };
        provider_intent.action_hash = hash_entity_provider_action(&provider_intent);
        state.entity_provider_action_state = Some(EntityProviderActionState {
            confirmed_nonce: U256::zero(),
            generation: 1,
            pending: Some(provider_intent.clone()),
        });
        let current = format!("0x{}", "08".repeat(32));
        let stale = format!("0x{}", "07".repeat(32));
        let provider = format!("0x{}", hex::encode(provider_intent.action_hash));
        let mut metadata = json!({
            "hankoWitness": {
                "__xlnType": "Map",
                "value": [
                    [stale, {
                        "hanko": "0xaa", "type": "jBatch",
                        "entityHeight": 1_999, "createdAt": 1_999
                    }],
                    [current, {
                        "hanko": "0xbb", "type": "jBatch",
                        "entityHeight": 2_000, "createdAt": 2_000
                    }],
                    [provider, {
                        "hanko": "0xcc", "type": "entityProviderAction",
                        "entityHeight": 2_000, "createdAt": 2_000
                    }]
                ]
            }
        });

        prepare_certified_entity_j_intents(
            &state,
            &mut metadata,
            "validator-1",
            Vec::new(),
            &EntityHankoWitnessMap::new(),
        )
        .expect("prepare certified J intents");

        assert_eq!(
            metadata["hankoWitness"]["value"],
            json!([
                [format!("0x{}", "08".repeat(32)), {
                    "hanko": "0xbb",
                    "type": "jBatch",
                    "entityHeight": 2_000,
                    "createdAt": 2_000
                }],
                [format!("0x{}", hex::encode(provider_intent.action_hash)), {
                    "hanko": "0xcc",
                    "type": "entityProviderAction",
                    "entityHeight": 2_000,
                    "createdAt": 2_000
                }]
            ])
        );
    }
}

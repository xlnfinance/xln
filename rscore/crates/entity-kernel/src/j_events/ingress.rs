use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;
use xln_rscore_engine::{AccountTx, EntityId, JEventClaimTx, JurisdictionEvent, canonical_events};

use crate::{AccountProposalWork, EntityKernelError, EntityStateSlice};

use super::{EntityJEventIngress, FinalizedJEventBatch, JEventClaimQueued, JReserveUpdate};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

type ClaimKey = (String, u64, [u8; 32]);

struct ValidatedBatch {
    reserve_updates: Vec<JReserveUpdate>,
    claims: Vec<(ClaimKey, Vec<JurisdictionEvent>)>,
    queued: Vec<JEventClaimQueued>,
}

fn invalid(detail: impl Into<String>) -> EntityKernelError {
    EntityKernelError::JEventInvalid {
        detail: detail.into(),
    }
}

fn account_text(value: &EntityId) -> String {
    value.as_hex()
}

fn validate_active_accounts(
    state: &EntityStateSlice,
    active_accounts: &BTreeSet<String>,
) -> Result<(), EntityKernelError> {
    for account_id in active_accounts {
        EntityId::parse(account_id).map_err(|_| invalid("ACTIVE_ACCOUNT_ID"))?;
        if !state.known_accounts.contains(account_id) {
            return Err(invalid(format!("ACTIVE_ACCOUNT_UNKNOWN:{account_id}")));
        }
    }
    Ok(())
}

fn event_binding(
    owner: &EntityId,
    event: &JurisdictionEvent,
    batch: &FinalizedJEventBatch,
) -> Result<(EntityId, JReserveUpdate), EntityKernelError> {
    let JurisdictionEvent::AccountSettled(settled) = event;
    if settled.metadata.block_number != Some(batch.j_height)
        || settled.metadata.block_hash != Some(batch.j_block_hash)
        || settled.metadata.transaction_hash.is_none()
        || settled.metadata.log_index.is_none()
    {
        return Err(invalid("ACCOUNT_SETTLED_METADATA_BINDING"));
    }
    if settled.token_id.get() == 0 {
        return Err(invalid("ACCOUNT_SETTLED_TOKEN_ZERO"));
    }
    let (counterparty, own_reserve) = if &settled.left_entity == owner {
        (settled.right_entity.clone(), settled.left_reserve.clone())
    } else if &settled.right_entity == owner {
        (settled.left_entity.clone(), settled.right_reserve.clone())
    } else {
        return Err(invalid("ACCOUNT_SETTLED_OWNER_MISMATCH"));
    };
    if own_reserve < BigInt::from(0) {
        return Err(invalid("ACCOUNT_SETTLED_RESERVE_NEGATIVE"));
    }
    Ok((
        counterparty.clone(),
        JReserveUpdate {
            token_id: settled.token_id.get(),
            own_reserve,
            counterparty_id: counterparty,
        },
    ))
}

fn validate_batch(
    owner: &EntityId,
    state: &EntityStateSlice,
    active_accounts: &BTreeSet<String>,
    batch: &FinalizedJEventBatch,
) -> Result<ValidatedBatch, EntityKernelError> {
    if batch.j_height == 0 || batch.j_height > MAX_SAFE_INTEGER {
        return Err(invalid("J_HEIGHT"));
    }
    let mut claims = Vec::new();
    let mut global_events = Vec::new();
    for ingress in &batch.account_claims {
        let account_id = account_text(&ingress.account_id);
        let AccountTx::JEventClaim(claim) = &ingress.tx else {
            return Err(EntityKernelError::UnsupportedJEventIngress {
                kind: super::account_tx_kind(&ingress.tx),
            });
        };
        validate_claim_coordinates(claim, batch)?;
        let events = canonical_events(&claim.events).map_err(|error| invalid(error.to_string()))?;
        for event in &events {
            let (counterparty, _) = event_binding(owner, event, batch)?;
            if counterparty != ingress.account_id {
                return Err(invalid("ACCOUNT_SETTLED_COUNTERPARTY_MISMATCH"));
            }
        }
        global_events.extend(events.iter().cloned());
        if state.known_accounts.contains(&account_id) && active_accounts.contains(&account_id) {
            claims.push(((account_id, claim.j_height, claim.j_block_hash), events));
        }
    }
    let ordered_events =
        canonical_events(&global_events).map_err(|error| invalid(error.to_string()))?;
    let mut reserve_updates = Vec::with_capacity(ordered_events.len());
    let mut queued = Vec::new();
    for event in &ordered_events {
        let (counterparty, reserve) = event_binding(owner, event, batch)?;
        let account_id = account_text(&counterparty);
        if state.known_accounts.contains(&account_id) && active_accounts.contains(&account_id) {
            queued.push(JEventClaimQueued {
                entity_id: state.entity_id.clone(),
                counterparty_id: account_id,
                token_id: reserve.token_id,
                j_height: batch.j_height,
            });
        }
        reserve_updates.push(reserve);
    }
    if reserve_updates != batch.reserve_updates {
        return Err(invalid("ACCOUNT_SETTLED_RESERVE_PROJECTION"));
    }
    Ok(ValidatedBatch {
        reserve_updates,
        claims,
        queued,
    })
}

fn validate_claim_coordinates(
    claim: &JEventClaimTx,
    batch: &FinalizedJEventBatch,
) -> Result<(), EntityKernelError> {
    if claim.j_height != batch.j_height
        || claim.j_block_hash != batch.j_block_hash
        || claim.left_proof.is_some()
        || claim.right_proof.is_some()
    {
        return Err(invalid("J_CLAIM_WATCHER_BINDING"));
    }
    Ok(())
}

/// Apply an authenticated watcher range using the exact TS Entity semantics:
/// reserves follow EVM log order, while Account claims are merged and sorted
/// independently by Account id, J height and block hash.
///
/// `active_accounts` is explicit because Account status belongs to the child
/// replica, not Entity state. Missing and non-active Accounts still update the
/// Entity reserve but do not receive a bilateral claim.
pub fn apply_finalized_j_event_batches(
    state: &mut EntityStateSlice,
    finalized_through: u64,
    batches: &[FinalizedJEventBatch],
    active_accounts: &BTreeSet<String>,
) -> Result<EntityJEventIngress, EntityKernelError> {
    validate_active_accounts(state, active_accounts)?;
    if finalized_through < state.last_finalized_j_height || finalized_through > MAX_SAFE_INTEGER {
        return Err(invalid("FINALIZED_HEIGHT_REGRESSION"));
    }
    let owner = EntityId::parse(&state.entity_id).map_err(|_| invalid("ENTITY_ID"))?;
    let mut prior_height = state.last_finalized_j_height;
    let mut validated = Vec::with_capacity(batches.len());
    for batch in batches {
        if batch.j_height <= prior_height || batch.j_height > finalized_through {
            return Err(invalid("J_BATCH_ORDER"));
        }
        prior_height = batch.j_height;
        validated.push(validate_batch(&owner, state, active_accounts, batch)?);
    }

    let mut grouped = BTreeMap::<ClaimKey, Vec<JurisdictionEvent>>::new();
    let mut queued_claims = Vec::new();
    for batch in validated {
        for reserve in batch.reserve_updates {
            state.reserves.insert(reserve.token_id, reserve.own_reserve);
        }
        for (key, events) in batch.claims {
            grouped.entry(key).or_default().extend(events);
        }
        queued_claims.extend(batch.queued);
    }
    state.last_finalized_j_height = finalized_through;

    let mut proposals = BTreeMap::<String, Vec<AccountTx>>::new();
    for ((account_id, j_height, j_block_hash), events) in grouped {
        let events = canonical_events(&events).map_err(|error| invalid(error.to_string()))?;
        proposals
            .entry(account_id)
            .or_default()
            .push(AccountTx::JEventClaim(JEventClaimTx {
                j_height,
                j_block_hash,
                events,
                left_proof: None,
                right_proof: None,
            }));
    }
    Ok(EntityJEventIngress {
        proposal_work: proposals
            .into_iter()
            .map(|(account_id, txs)| AccountProposalWork { account_id, txs })
            .collect(),
        queued_claims,
    })
}

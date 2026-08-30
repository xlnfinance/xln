use crate::commitment::JClaimAccumulator;
use crate::j_claims::accumulator::{JClaimStore, delete, insert, prune};
use crate::j_claims::codec::{JClaimRecord, JClaimSide, account_key, j_error, same_record};
use crate::j_claims::event_types::JurisdictionEvent;
use crate::j_claims::events::{MAX_SAFE_INTEGER, canonical_events, canonical_events_hash};
use crate::j_claims::proof::{ProofResult, create, inspect};
use crate::j_claims::store::apply_changes;
use crate::j_claims::types::{JClaimStatus, JClaimTransition, JEventClaimTx};
use crate::{AccountIdentity, JClaimProof, Side, StateError, ValidationRejection};

pub(crate) struct AccountJEventClaimAdmission {
    events: Vec<JurisdictionEvent>,
    records: (JClaimRecord, JClaimRecord),
    results: (ProofResult, ProofResult),
}

pub(crate) enum AccountJEventClaimAdmissionResult {
    Accepted(Box<AccountJEventClaimAdmission>),
    Rejected(ValidationRejection),
}

struct OwnedTransition<'a> {
    own: &'a JClaimAccumulator,
    peer: &'a JClaimAccumulator,
    own_record: JClaimRecord,
    peer_record: JClaimRecord,
    own_result: ProofResult,
    peer_result: ProofResult,
}

pub fn apply_claim_transition(
    identity: &AccountIdentity,
    left: &JClaimAccumulator,
    right: &JClaimAccumulator,
    last_finalized_j_height: u64,
    tx: &JEventClaimTx,
    by_left: bool,
    store: &mut JClaimStore,
) -> Result<JClaimTransition, StateError> {
    match validate_j_event_claim_admission(identity, left, right, tx)? {
        AccountJEventClaimAdmissionResult::Accepted(admission) => apply_admitted_claim_transition(
            left,
            right,
            last_finalized_j_height,
            tx,
            by_left,
            store,
            *admission,
        ),
        AccountJEventClaimAdmissionResult::Rejected(rejection) => Err(j_error(rejection.message())),
    }
}

pub(crate) fn validate_j_event_claim_admission(
    identity: &AccountIdentity,
    left: &JClaimAccumulator,
    right: &JClaimAccumulator,
    tx: &JEventClaimTx,
) -> Result<AccountJEventClaimAdmissionResult, StateError> {
    let events = canonical_events(&tx.events)?;
    let records = build_records(identity, tx, &events)?;
    let left_proof = required_proof(tx.left_proof.as_ref(), "left")?;
    let right_proof = required_proof(tx.right_proof.as_ref(), "right")?;
    let left_result = inspect(left.root, &records.0, left_proof)?.result;
    let right_result = inspect(right.root, &records.1, right_proof)?.result;
    for (result, expected, side) in [
        (&left_result, &records.0, Side::Left),
        (&right_result, &records.1, Side::Right),
    ] {
        if exact_member_conflicts(result, expected) {
            return Ok(AccountJEventClaimAdmissionResult::Rejected(
                ValidationRejection::JEventClaimConflict {
                    side,
                    j_height: expected.j_height,
                },
            ));
        }
    }
    Ok(AccountJEventClaimAdmissionResult::Accepted(Box::new(
        AccountJEventClaimAdmission {
            events,
            records,
            results: (left_result, right_result),
        },
    )))
}

pub(crate) fn apply_admitted_claim_transition(
    left: &JClaimAccumulator,
    right: &JClaimAccumulator,
    last_finalized_j_height: u64,
    tx: &JEventClaimTx,
    by_left: bool,
    store: &mut JClaimStore,
    admission: AccountJEventClaimAdmission,
) -> Result<JClaimTransition, StateError> {
    let AccountJEventClaimAdmission {
        events,
        records,
        results: (left_result, right_result),
    } = admission;
    if tx.j_height <= last_finalized_j_height {
        return stale_transition(left, right, records, last_finalized_j_height, events, store);
    }
    let (state, swap) = owned_by_side(left, right, records, (left_result, right_result), by_left);
    let transition = apply_owned_transition(state, tx, events, store)?;
    Ok(if swap {
        swap_sides(transition)
    } else {
        transition
    })
}

pub fn prepare_claim_tx(
    identity: &AccountIdentity,
    left: &JClaimAccumulator,
    right: &JClaimAccumulator,
    tx: &JEventClaimTx,
    store: &JClaimStore,
) -> Result<JEventClaimTx, StateError> {
    let events = canonical_events(&tx.events)?;
    let records = build_records(identity, tx, &events)?;
    Ok(JEventClaimTx {
        j_height: tx.j_height,
        j_block_hash: tx.j_block_hash,
        events,
        left_proof: Some(create(store, left.root, &records.0)?),
        right_proof: Some(create(store, right.root, &records.1)?),
    })
}

/// Minimal comparable evidence of one already-queued claim row: enough to
/// decide clause 3 of the admission planner without borrowing the queue.
pub(crate) struct QueuedClaimWitness {
    pub j_height: u64,
    pub j_block_hash: [u8; 32],
    pub events_hash: [u8; 32],
}

/// FX-3 (proofs/fixes.md, decision D4): the one local j-claim admission
/// verdict, shared by `AccountConsensus::admit_txs` in this engine and
/// mirrored by TypeScript `planAccountJClaimLocalAdmission` in
/// `core/account/j-claims/j-claim-transition.ts`.
///
/// A locally admitted claim carries no proofs, so committed membership is
/// decided by building fresh witnesses against the committed accumulator
/// roots — the store is authoritative, never the transaction. Store and
/// decode failures stay fail-loud `Err`; a conflict is per-row data so an
/// adversarial observation can never halt the account.
pub(crate) enum LocalClaimPlan {
    Admit,
    /// Exact (jHeight, jBlockHash, eventsHash) evidence already committed or
    /// queued: idempotent skip, never a second mempool row.
    Duplicate,
    /// Same jHeight, different block/event evidence: typed rejection for this
    /// row only.
    Conflict(ValidationRejection),
}

pub(crate) fn plan_local_claim(
    identity: &AccountIdentity,
    left: &JClaimAccumulator,
    right: &JClaimAccumulator,
    queued: &[QueuedClaimWitness],
    tx: &JEventClaimTx,
    store: &JClaimStore,
) -> Result<LocalClaimPlan, StateError> {
    let events = canonical_events(&tx.events)?;
    let records = build_records(identity, tx, &events)?;
    for (accumulator, expected, side) in [
        (left, &records.0, Side::Left),
        (right, &records.1, Side::Right),
    ] {
        let proof = create(store, accumulator.root, expected)?;
        let result = inspect(accumulator.root, expected, &proof)?.result;
        let ProofResult::Member(actual) = result else {
            continue;
        };
        if same_record(&actual, expected) {
            return Ok(LocalClaimPlan::Duplicate);
        }
        return Ok(LocalClaimPlan::Conflict(
            ValidationRejection::JEventClaimConflict {
                side,
                j_height: expected.j_height,
            },
        ));
    }
    let events_hash = canonical_events_hash(&events)?;
    for queued_claim in queued {
        if queued_claim.j_height != tx.j_height {
            continue;
        }
        if queued_claim.events_hash == events_hash && queued_claim.j_block_hash == tx.j_block_hash {
            return Ok(LocalClaimPlan::Duplicate);
        }
        return Ok(LocalClaimPlan::Conflict(
            ValidationRejection::JEventClaimQueuedConflict {
                j_height: tx.j_height,
            },
        ));
    }
    Ok(LocalClaimPlan::Admit)
}

fn owned_by_side<'a>(
    left: &'a JClaimAccumulator,
    right: &'a JClaimAccumulator,
    records: (JClaimRecord, JClaimRecord),
    results: (ProofResult, ProofResult),
    by_left: bool,
) -> (OwnedTransition<'a>, bool) {
    if by_left {
        (
            OwnedTransition {
                own: left,
                peer: right,
                own_record: records.0,
                peer_record: records.1,
                own_result: results.0,
                peer_result: results.1,
            },
            false,
        )
    } else {
        (
            OwnedTransition {
                own: right,
                peer: left,
                own_record: records.1,
                peer_record: records.0,
                own_result: results.1,
                peer_result: results.0,
            },
            true,
        )
    }
}

fn apply_owned_transition(
    state: OwnedTransition<'_>,
    tx: &JEventClaimTx,
    events: Vec<JurisdictionEvent>,
    store: &mut JClaimStore,
) -> Result<JClaimTransition, StateError> {
    if matches!(state.peer_result, ProofResult::Absent) {
        return apply_without_peer(state, tx, events, store);
    }
    let (_, mut next_peer, peer_changes) = delete(
        state.peer,
        &state.peer_record,
        proof_for(tx, state.peer_record.side)?,
    )?;
    apply_changes(store, &peer_changes);
    let mut next_own = state.own.clone();
    if matches!(state.own_result, ProofResult::Member(_)) {
        let (_, next, changes) = delete(
            state.own,
            &state.own_record,
            proof_for(tx, state.own_record.side)?,
        )?;
        apply_changes(store, &changes);
        next_own = next;
    }
    let account_key = state.own_record.account_key;
    next_own = prune(
        next_own,
        store,
        account_key,
        state.own_record.side,
        tx.j_height,
    )?;
    next_peer = prune(
        next_peer,
        store,
        account_key,
        state.peer_record.side,
        tx.j_height,
    )?;
    Ok(transition(
        JClaimStatus::Finalized,
        next_own,
        next_peer,
        events,
    ))
}

fn apply_without_peer(
    state: OwnedTransition<'_>,
    tx: &JEventClaimTx,
    events: Vec<JurisdictionEvent>,
    store: &mut JClaimStore,
) -> Result<JClaimTransition, StateError> {
    if matches!(state.own_result, ProofResult::Member(_)) {
        return Ok(transition(
            JClaimStatus::Idempotent,
            state.own.clone(),
            state.peer.clone(),
            events,
        ));
    }
    let (_, next, changes) = insert(
        state.own,
        &state.own_record,
        proof_for(tx, state.own_record.side)?,
    )?;
    apply_changes(store, &changes);
    Ok(transition(
        JClaimStatus::Pending,
        next,
        state.peer.clone(),
        events,
    ))
}

fn stale_transition(
    left: &JClaimAccumulator,
    right: &JClaimAccumulator,
    records: (JClaimRecord, JClaimRecord),
    height: u64,
    events: Vec<JurisdictionEvent>,
    store: &mut JClaimStore,
) -> Result<JClaimTransition, StateError> {
    let next_left = prune(
        left.clone(),
        store,
        records.0.account_key,
        JClaimSide::Left,
        height,
    )?;
    let next_right = prune(
        right.clone(),
        store,
        records.1.account_key,
        JClaimSide::Right,
        height,
    )?;
    Ok(transition(
        JClaimStatus::Stale,
        next_left,
        next_right,
        events,
    ))
}

fn build_records(
    identity: &AccountIdentity,
    tx: &JEventClaimTx,
    events: &[JurisdictionEvent],
) -> Result<(JClaimRecord, JClaimRecord), StateError> {
    if tx.j_height == 0 || tx.j_height > MAX_SAFE_INTEGER {
        return Err(j_error(format!(
            "ACCOUNT_J_CLAIM_HEIGHT_INVALID:{}",
            tx.j_height
        )));
    }
    let events_hash = canonical_events_hash(events)?;
    let key = account_key(identity);
    Ok((
        claim_record(key, JClaimSide::Left, tx, events_hash),
        claim_record(key, JClaimSide::Right, tx, events_hash),
    ))
}

fn claim_record(
    account_key: [u8; 32],
    side: JClaimSide,
    tx: &JEventClaimTx,
    events_hash: [u8; 32],
) -> JClaimRecord {
    JClaimRecord {
        account_key,
        side,
        j_height: tx.j_height,
        j_block_hash: tx.j_block_hash,
        events_hash,
    }
}

fn exact_member_conflicts(result: &ProofResult, expected: &JClaimRecord) -> bool {
    matches!(result, ProofResult::Member(actual) if !same_record(actual, expected))
}

fn required_proof<'a>(
    proof: Option<&'a JClaimProof>,
    side: &str,
) -> Result<&'a JClaimProof, StateError> {
    proof.ok_or_else(|| j_error(format!("ACCOUNT_J_CLAIM_PROOF_REQUIRED:{side}")))
}

fn proof_for(tx: &JEventClaimTx, side: JClaimSide) -> Result<&JClaimProof, StateError> {
    match side {
        JClaimSide::Left => tx.left_proof.as_ref(),
        JClaimSide::Right => tx.right_proof.as_ref(),
    }
    .ok_or_else(|| j_error("ACCOUNT_J_CLAIM_PROOF_REQUIRED"))
}

fn transition(
    status: JClaimStatus,
    left: JClaimAccumulator,
    right: JClaimAccumulator,
    events: Vec<JurisdictionEvent>,
) -> JClaimTransition {
    JClaimTransition {
        status,
        left,
        right,
        events,
    }
}

fn swap_sides(mut value: JClaimTransition) -> JClaimTransition {
    std::mem::swap(&mut value.left, &mut value.right);
    value
}

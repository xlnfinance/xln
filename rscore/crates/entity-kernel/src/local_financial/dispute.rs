use std::collections::BTreeSet;

use ethabi::{Token, ethereum_types::U256};
use sha3::{Digest, Keccak256};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use crate::cross_j::{DisputeBookRemovalPlan, plan_dispute_book_removal};
use crate::j_batch::{
    FinalDisputeProof, InitialDisputeProof, JBatch, JBatchState, SecretReveal,
    proof_body_from_engine, proof_body_hash,
};
use crate::orderbook::SameJOutputDelta;
use crate::paybook::PaybookChanges;
use crate::{EntityFrameEvent, EntityKernelError, EntityStateSlice, LocalEntityOutput};

use super::types::{
    AccountEnvelopeMutation, DisputeFinalizeEntityTx, DisputeStartEntityTx,
    LocalAccountFinancialView, PrepareDisputeEntityTx,
};

const ZERO_WORD: [u8; 32] = [0; 32];

fn invalid(kind: &'static str, detail: impl Into<String>) -> EntityKernelError {
    EntityKernelError::local(kind, detail.into())
}

fn number(value: u64, kind: &'static str) -> Result<CanonicalValue, EntityKernelError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|_| invalid(kind, "SAFE_NUMBER"))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(2 + bytes.len() * 2);
    out.push_str("0x");
    for byte in bytes {
        out.push(DIGITS[usize::from(byte >> 4)] as char);
        out.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    out
}

fn bytes(
    value: &str,
    kind: &'static str,
    field: &'static str,
) -> Result<Vec<u8>, EntityKernelError> {
    let payload = value
        .strip_prefix("0x")
        .filter(|payload| payload.len() % 2 == 0)
        .ok_or_else(|| invalid(kind, field))?;
    payload
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let nibble = |byte: u8| match byte {
                b'0'..=b'9' => Some(byte - b'0'),
                b'a'..=b'f' => Some(byte - b'a' + 10),
                _ => None,
            };
            Ok((nibble(pair[0]).ok_or_else(|| invalid(kind, field))? << 4)
                | nibble(pair[1]).ok_or_else(|| invalid(kind, field))?)
        })
        .collect()
}

fn word(
    value: &str,
    kind: &'static str,
    field: &'static str,
) -> Result<[u8; 32], EntityKernelError> {
    let bytes = bytes(value, kind, field)?;
    bytes.try_into().map_err(|_| invalid(kind, field))
}

fn entity_word(value: &str, kind: &'static str) -> Result<[u8; 32], EntityKernelError> {
    word(value, kind, "COUNTERPARTY_ENTITY_ID")
}

fn object<'a>(
    value: &'a CanonicalValue,
    kind: &'static str,
    field: &'static str,
) -> Result<&'a [(String, CanonicalValue)], EntityKernelError> {
    match value {
        CanonicalValue::Object(fields) => Ok(fields),
        _ => Err(invalid(kind, field)),
    }
}

fn field<'a>(fields: &'a [(String, CanonicalValue)], name: &str) -> Option<&'a CanonicalValue> {
    fields
        .iter()
        .find_map(|(field, value)| (field == name).then_some(value))
}

fn bool_field(fields: &[(String, CanonicalValue)], name: &str) -> Option<bool> {
    match field(fields, name) {
        Some(CanonicalValue::Bool(value)) => Some(*value),
        _ => None,
    }
}

fn u64_field(fields: &[(String, CanonicalValue)], name: &str) -> Option<u64> {
    match field(fields, name) {
        Some(CanonicalValue::Number(value)) => value.as_str().parse().ok(),
        _ => None,
    }
}

fn text_field<'a>(fields: &'a [(String, CanonicalValue)], name: &str) -> Option<&'a str> {
    match field(fields, name) {
        Some(CanonicalValue::String(value)) => Some(value),
        _ => None,
    }
}

fn status(events: &mut Vec<EntityFrameEvent>, message: impl Into<String>) {
    events.push(EntityFrameEvent::Status {
        message: message.into(),
    });
}

fn view<'a>(
    account_views: &'a std::collections::BTreeMap<String, LocalAccountFinancialView>,
    counterparty: &str,
) -> Option<&'a xln_rscore_batch::ResidentAccountDisputeView> {
    account_views
        .get(counterparty)
        .and_then(|view| view.dispute.as_ref())
}

fn batch_op_count(batch: &JBatch) -> usize {
    batch.reserve_to_reserve.len()
        + batch.reserve_to_collateral.len()
        + batch.collateral_to_reserve.len()
        + batch.settlements.len()
        + batch.dispute_starts.len()
        + batch.counter_disputes.len()
        + batch.dispute_finalizations.len()
        + batch.external_token_to_reserve.len()
        + batch.reserve_to_external_token.len()
        + batch.reveal_secrets.len()
        + batch.hash_ladder_registrations.len()
}

fn has_queued_start(state: &JBatchState, counterparty: [u8; 32]) -> bool {
    let contains = |batch: &JBatch| {
        batch
            .dispute_starts
            .iter()
            .any(|row| row.counterentity == counterparty)
    };
    contains(&state.batch)
        || state
            .sent_batch
            .as_ref()
            .is_some_and(|sent| contains(&sent.batch))
        || state.recovery_batches.iter().any(contains)
}

fn has_queued_finalize(state: &JBatchState, counterparty: [u8; 32]) -> bool {
    let contains = |batch: &JBatch| {
        batch
            .dispute_finalizations
            .iter()
            .any(|row| row.counterentity == counterparty)
    };
    contains(&state.batch)
        || state
            .sent_batch
            .as_ref()
            .is_some_and(|sent| contains(&sent.batch))
        || state.recovery_batches.iter().any(contains)
}

fn argument_tuple(fill_ratios: Vec<u32>, secrets: Vec<[u8; 32]>) -> Vec<u8> {
    ethabi::encode(&[Token::Tuple(vec![
        Token::Array(
            fill_ratios
                .into_iter()
                .map(|ratio| Token::Uint(U256::from(ratio.min(u32::from(u16::MAX)))))
                .collect(),
        ),
        Token::Array(
            secrets
                .into_iter()
                .map(|secret| Token::FixedBytes(secret.to_vec()))
                .collect(),
        ),
    ])])
}

fn wrap_arguments(arguments: Vec<u8>, clause_count: usize) -> Result<Vec<u8>, EntityKernelError> {
    if !(1..=2).contains(&clause_count) {
        return Err(invalid(
            "dispute",
            format!("DISPUTE_ARGUMENT_CANONICAL_CLAUSE_COUNT_INVALID:{clause_count}"),
        ));
    }
    Ok(ethabi::encode(&[Token::Array(
        (0..clause_count)
            .map(|_| Token::Bytes(arguments.clone()))
            .collect(),
    )]))
}

fn known_secrets(
    state: &EntityStateSlice,
    paybook: &PaybookChanges,
    dispute: &xln_rscore_batch::ResidentAccountDisputeView,
    counterparty: &str,
) -> Result<Vec<[u8; 32]>, EntityKernelError> {
    let mut seen = BTreeSet::new();
    let mut output = Vec::new();
    for hashlock in &dispute.payment_hashlocks {
        let Some(entry) = paybook.entry(state, hashlock)? else {
            continue;
        };
        if entry.inbound_entity.as_deref() != Some(counterparty)
            && entry.outbound_entity.as_deref() != Some(counterparty)
        {
            continue;
        }
        let Some(secret) = entry.secret.as_deref() else {
            continue;
        };
        let secret = word(secret, "dispute", "SECRET")?;
        let digest: [u8; 32] =
            Keccak256::digest(ethabi::encode(&[Token::FixedBytes(secret.to_vec())])).into();
        if hex(&digest) != hashlock.to_ascii_lowercase() || !seen.insert(secret) {
            continue;
        }
        output.push(secret);
    }
    Ok(output)
}

fn build_arguments(
    state: &EntityStateSlice,
    paybook: &PaybookChanges,
    dispute: &xln_rscore_batch::ResidentAccountDisputeView,
    counterparty: &str,
    secrets_side_is_left: Option<bool>,
) -> Result<(Vec<u8>, Vec<u8>), EntityKernelError> {
    let same_j = dispute
        .swap_offers
        .iter()
        .filter(|offer| offer.cross_jurisdiction.is_none())
        .collect::<Vec<_>>();
    let mut left_ratios = Vec::new();
    let mut right_ratios = Vec::new();
    for offer in &same_j {
        let ratio = dispute
            .pending_swap_fill_ratios
            .get(&offer.offer_id)
            .copied()
            .unwrap_or(0);
        if offer.maker_is_left {
            right_ratios.push(ratio);
        } else {
            left_ratios.push(ratio);
        }
    }
    let secrets = known_secrets(state, paybook, dispute, counterparty)?;
    let left_secrets = secrets_side_is_left
        .filter(|side| *side)
        .map(|_| secrets.clone())
        .unwrap_or_default();
    let right_secrets = secrets_side_is_left
        .filter(|side| !*side)
        .map(|_| secrets)
        .unwrap_or_default();
    let clause_count =
        usize::from(!dispute.payment_hashlocks.is_empty()) + usize::from(!same_j.is_empty());
    let encode = |ratios: Vec<u32>, secrets: Vec<[u8; 32]>| {
        if ratios.iter().all(|ratio| *ratio == 0) && secrets.is_empty() {
            return Ok(Vec::new());
        }
        wrap_arguments(argument_tuple(ratios, secrets), clause_count)
    };
    Ok((
        encode(left_ratios, left_secrets)?,
        encode(right_ratios, right_secrets)?,
    ))
}

fn counter_commitment(nonce: u64, proposer_is_left: bool, hash: [u8; 32]) -> [u8; 32] {
    Keccak256::digest(ethabi::encode(&[
        Token::Uint(U256::from(nonce)),
        Token::Bool(proposer_is_left),
        Token::FixedBytes(hash.to_vec()),
    ]))
    .into()
}

fn active_dispute_value(
    dispute: &xln_rscore_batch::ResidentAccountDisputeView,
    initial_hash: [u8; 32],
    initial_nonce: u64,
    initial_proposer_is_left: bool,
    starter_initial_arguments: &[u8],
    starter_counter_arguments: &[u8],
    starter_counter_proof_commitment: [u8; 32],
) -> Result<CanonicalValue, EntityKernelError> {
    Ok(CanonicalValue::Object(vec![
        (
            "startedByLeft".into(),
            CanonicalValue::Bool(dispute.owner_is_left),
        ),
        (
            "initialProofbodyHash".into(),
            CanonicalValue::String(hex(&initial_hash)),
        ),
        (
            "initialNonce".into(),
            number(initial_nonce, "disputeStart")?,
        ),
        (
            "initialProposerIsLeft".into(),
            CanonicalValue::Bool(initial_proposer_is_left),
        ),
        ("disputeTimeout".into(), number(0, "disputeStart")?),
        ("jNonce".into(), number(dispute.j_nonce, "disputeStart")?),
        (
            "starterInitialArguments".into(),
            CanonicalValue::String(hex(starter_initial_arguments)),
        ),
        (
            "starterCounterArguments".into(),
            CanonicalValue::String(hex(starter_counter_arguments)),
        ),
        (
            "starterCounterProofCommitment".into(),
            CanonicalValue::String(hex(&starter_counter_proof_commitment)),
        ),
        ("observedOnChain".into(), CanonicalValue::Bool(false)),
        ("finalizeQueued".into(), CanonicalValue::Bool(false)),
    ]))
}

#[expect(
    clippy::too_many_arguments,
    reason = "the dispute transition keeps signed evidence and every output sink explicit"
)]
fn start(
    state: &mut EntityStateSlice,
    paybook: &PaybookChanges,
    counterparty: &str,
    description: Option<&str>,
    cross_jurisdiction_route_id: Option<&str>,
    starter_initial_override: Option<&str>,
    account_views: &std::collections::BTreeMap<String, LocalAccountFinancialView>,
    runtime_seed: Option<&str>,
    mutations: &mut Vec<(String, AccountEnvelopeMutation)>,
    routed_outputs: &mut Vec<LocalEntityOutput>,
    events: &mut Vec<EntityFrameEvent>,
) -> Result<(), EntityKernelError> {
    let Some(dispute) = view(account_views, counterparty) else {
        status(
            events,
            format!(
                "❌ No account with {} - cannot start dispute",
                &counterparty[counterparty.len() - 4..]
            ),
        );
        return Ok(());
    };
    if let Some(route_id) = cross_jurisdiction_route_id {
        crate::cross_j::validate_cross_jurisdiction_dispute_route(state, counterparty, route_id)?;
        if dispute.pull_count == 0 {
            return Err(invalid(
                "disputeStart",
                format!("CROSS_J_PROOF_PULLS_MISSING:{route_id}"),
            ));
        }
    }
    if dispute.status == "disputed" {
        status(
            events,
            format!(
                "❌ Account with {} is disputed - reopen required",
                &counterparty[counterparty.len() - 4..]
            ),
        );
        return Ok(());
    }
    let Some(counter) = dispute.counterparty_dispute.as_ref() else {
        status(
            events,
            "❌ Missing counterparty dispute hanko - cannot start dispute",
        );
        return Ok(());
    };
    let hanko = counter
        .hanko
        .clone()
        .filter(|hanko| !hanko.is_empty())
        .ok_or_else(|| invalid("disputeStart", "COUNTERPARTY_HANKO_MISSING"))?;
    if counter.nonce == 0 || counter.nonce <= dispute.j_nonce {
        status(
            events,
            format!(
                "❌ Stale dispute proof nonce {} (on-chain={}) - reopen required",
                counter.nonce, dispute.j_nonce
            ),
        );
        return Ok(());
    }
    let body = proof_body_from_engine(
        dispute
            .proof_body
            .clone()
            .map_err(|error| invalid("disputeStart", error))?,
    )
    .map_err(|error| invalid("disputeStart", error.to_string()))?;
    let body_hash =
        proof_body_hash(&body).map_err(|error| invalid("disputeStart", error.to_string()))?;
    if body_hash != counter.proof_body_hash {
        return Err(invalid(
            "disputeStart",
            format!(
                "DISPUTE_START_PROOFBODY_HASH_MISMATCH:{counterparty}:{}:{}",
                hex(&counter.proof_body_hash),
                hex(&body_hash)
            ),
        ));
    }
    let counterentity = entity_word(counterparty, "disputeStart")?;
    if state
        .j_batch_state
        .as_ref()
        .is_some_and(|j_state| has_queued_start(j_state, counterentity))
    {
        status(
            events,
            format!(
                "ℹ️ disputeStart already queued for {} (awaiting batch lifecycle)",
                &counterparty[counterparty.len() - 4..]
            ),
        );
        return Ok(());
    }
    let (left_arguments, right_arguments) = build_arguments(
        state,
        paybook,
        dispute,
        counterparty,
        Some(dispute.owner_is_left),
    )?;
    let built_initial = if let Some(value) = starter_initial_override.filter(|value| *value != "0x")
    {
        bytes(value, "disputeStart", "STARTER_INITIAL_ARGUMENTS")?
    } else if dispute.owner_is_left {
        left_arguments
    } else {
        right_arguments
    };
    let (starter_counter_arguments, starter_counter_proof_commitment) = dispute
        .local_dispute
        .as_ref()
        .filter(|candidate| {
            candidate.nonce > counter.nonce
                || (candidate.nonce == counter.nonce
                    && candidate.proposer_is_left
                    && !counter.proposer_is_left)
        })
        .map(|candidate| {
            let (left, right) = build_arguments(
                state,
                paybook,
                dispute,
                counterparty,
                Some(dispute.owner_is_left),
            )?;
            Ok::<_, EntityKernelError>((
                if dispute.owner_is_left { left } else { right },
                counter_commitment(
                    candidate.nonce,
                    candidate.proposer_is_left,
                    candidate.proof_body_hash,
                ),
            ))
        })
        .transpose()?
        .unwrap_or_else(|| (Vec::new(), ZERO_WORD));
    if cross_jurisdiction_route_id.is_some()
        && state
            .j_batch_state
            .as_ref()
            .is_some_and(|j_state| batch_op_count(&j_state.batch) != 0)
    {
        return Err(invalid(
            "disputeStart",
            "DISPUTE_START_PULL_BATCH_NOT_EMPTY",
        ));
    }
    {
        let j_state = state.j_batch_state.get_or_insert_with(JBatchState::default);
        if batch_op_count(&j_state.batch) >= 50 || j_state.batch.dispute_starts.len() >= 8 {
            return Err(invalid("disputeStart", "J_BATCH_LIMIT_EXCEEDED"));
        }
        j_state.batch.dispute_starts.push(InitialDisputeProof {
            counterentity,
            nonce: U256::from(counter.nonce),
            proposer_is_left: counter.proposer_is_left,
            proofbody_hash: body_hash,
            initial_proofbody: body.clone(),
            watch_seed: dispute
                .proof_body
                .as_ref()
                .map(|body| body.watch_seed)
                .map_err(|error| invalid("disputeStart", error.clone()))?,
            sig: hanko,
            starter_initial_arguments: built_initial.clone(),
            starter_counter_arguments: starter_counter_arguments.clone(),
            starter_counter_proof_commitment,
        });
    }
    let active_dispute = active_dispute_value(
        dispute,
        body_hash,
        counter.nonce,
        counter.proposer_is_left,
        &built_initial,
        &starter_counter_arguments,
        starter_counter_proof_commitment,
    )?;
    if cross_jurisdiction_route_id.is_some() {
        let runtime_seed = runtime_seed
            .filter(|seed| !seed.trim().is_empty())
            .ok_or_else(|| invalid("disputeStart", "RUNTIME_SEED_MISSING"))?;
        let delta_transformer = dispute
            .delta_transformer
            .ok_or_else(|| invalid("disputeStart", "DELTA_TRANSFORMER_MISSING"))?;
        crate::cross_j::queue_source_hub_claim_registrations(
            state,
            counterparty,
            runtime_seed,
            &body,
            delta_transformer,
            dispute.owner_is_left,
            Some(&active_dispute),
            routed_outputs,
        )?;
    }
    crate::encode_j_batch(
        &state
            .j_batch_state
            .as_ref()
            .expect("dispute start installed jBatch")
            .batch,
    )
    .map_err(|error| invalid("disputeStart", error.to_string()))?;
    mutations.push((
        counterparty.to_string(),
        AccountEnvelopeMutation::ReplaceDisputeLifecycle {
            status: "disputed".into(),
            dispute_prepare: None,
            active_dispute: Some(active_dispute),
        },
    ));
    if let Some(route_id) = cross_jurisdiction_route_id {
        crate::cross_j::flush_pending_target_reveal_for_route(
            state,
            route_id,
            counterparty,
            routed_outputs,
        )?;
    }
    status(
        events,
        format!(
            "⚔️ Dispute started vs {} {}- account frozen, use jBroadcast to commit",
            &counterparty[counterparty.len() - 4..],
            description
                .map(|value| format!("({value}) "))
                .unwrap_or_default(),
        ),
    );
    Ok(())
}

#[expect(
    clippy::too_many_arguments,
    reason = "dispute authority, evidence views, and ordered effect sinks stay explicit at the security boundary"
)]
pub(super) fn apply_prepare(
    state: &mut EntityStateSlice,
    paybook: &PaybookChanges,
    tx: PrepareDisputeEntityTx,
    account_views: &std::collections::BTreeMap<String, LocalAccountFinancialView>,
    runtime_seed: Option<&str>,
    mutations: &mut Vec<(String, AccountEnvelopeMutation)>,
    routed_outputs: &mut Vec<LocalEntityOutput>,
    events: &mut Vec<EntityFrameEvent>,
    orderbook_deltas: &mut Vec<SameJOutputDelta>,
) -> Result<(), EntityKernelError> {
    let Some(dispute) = view(account_views, &tx.counterparty_entity_id) else {
        status(
            events,
            format!(
                "❌ No account with {} - cannot prepare dispute",
                &tx.counterparty_entity_id[tx.counterparty_entity_id.len() - 4..]
            ),
        );
        return Ok(());
    };
    if dispute.active_dispute.is_some() || dispute.status == "disputed" {
        status(
            events,
            format!(
                "ℹ️ Dispute already active/queued for {}",
                &tx.counterparty_entity_id[tx.counterparty_entity_id.len() - 4..]
            ),
        );
        return Ok(());
    }
    if dispute.status == "dispute_preparing" {
        let preparation = dispute
            .dispute_prepare
            .as_ref()
            .ok_or_else(|| invalid("prepareDispute", "DISPUTE_PREPARE_MISSING"))?;
        let fields = object(preparation, "prepareDispute", "DISPUTE_PREPARE")?;
        let ready_after = u64_field(fields, "readyAfter").unwrap_or(0);
        let pending = match field(fields, "pendingOrderbookRemovalIds") {
            Some(CanonicalValue::Array(rows)) => rows.len(),
            None => 0,
            Some(_) => return Err(invalid("prepareDispute", "PENDING_REMOVALS")),
        };
        if ready_after > state.timestamp || pending > 0 {
            status(
                events,
                format!(
                    "⏳ Dispute preparation still pending for {}: cooldown:{}ms; orderbookRemovals:{}",
                    &tx.counterparty_entity_id[tx.counterparty_entity_id.len() - 4..],
                    ready_after.saturating_sub(state.timestamp),
                    pending,
                ),
            );
            return Ok(());
        }
        let intent = field(fields, "startIntent")
            .map(|value| object(value, "prepareDispute", "START_INTENT"))
            .transpose()?;
        let description = intent.and_then(|fields| text_field(fields, "description"));
        let starter = intent.and_then(|fields| text_field(fields, "starterInitialArguments"));
        return start(
            state,
            paybook,
            &tx.counterparty_entity_id,
            description,
            intent.and_then(|fields| text_field(fields, "crossJurisdictionRouteId")),
            starter,
            account_views,
            runtime_seed,
            mutations,
            routed_outputs,
            events,
        );
    }
    let mut local_removed = 0_usize;
    let mut pending_orderbook_removal_ids = Vec::new();
    for offer in &dispute.swap_offers {
        let removal_account = if let Some(route) = offer.cross_jurisdiction.as_ref() {
            match plan_dispute_book_removal(
                &state.entity_id,
                &tx.counterparty_entity_id,
                &offer.offer_id,
                route,
            )? {
                DisputeBookRemovalPlan::Local { source_entity_id } => source_entity_id,
                DisputeBookRemovalPlan::Remote { output } => {
                    pending_orderbook_removal_ids.push(offer.offer_id.clone());
                    routed_outputs.push(output);
                    continue;
                }
            }
        } else {
            tx.counterparty_entity_id.clone()
        };
        let order_id = format!("{removal_account}:{}", offer.offer_id);
        if state
            .orderbook
            .as_ref()
            .is_some_and(|orderbook| orderbook.pair_by_order.contains_key(&order_id))
        {
            local_removed += 1;
        }
        orderbook_deltas.push(SameJOutputDelta::DisputeRemove {
            account_id: removal_account,
            offer_id: offer.offer_id.clone(),
        });
    }
    pending_orderbook_removal_ids.sort();
    if local_removed > 0 || !pending_orderbook_removal_ids.is_empty() {
        status(
            events,
            format!(
                "⚔️ Dispute removed {local_removed} local orderbook row(s), queued {} remote row removal(s)",
                pending_orderbook_removal_ids.len(),
            ),
        );
    }
    let started_at = state.timestamp;
    let ready_after = started_at
        .checked_add(tx.min_cooldown_ms)
        .ok_or_else(|| invalid("prepareDispute", "READY_AFTER_OVERFLOW"))?;
    let mut intent = Vec::new();
    if let Some(value) = tx.description.as_ref() {
        intent.push(("description".into(), CanonicalValue::String(value.clone())));
    }
    if let Some(value) = tx.starter_initial_arguments.as_ref() {
        intent.push((
            "starterInitialArguments".into(),
            CanonicalValue::String(value.clone()),
        ));
    }
    if let Some(value) = tx.cross_jurisdiction_route_id.as_ref() {
        intent.push((
            "crossJurisdictionRouteId".into(),
            CanonicalValue::String(value.clone()),
        ));
    }
    let mut preparation = vec![
        ("startedAt".into(), number(started_at, "prepareDispute")?),
        ("readyAfter".into(), number(ready_after, "prepareDispute")?),
        (
            "reason".into(),
            CanonicalValue::String(
                tx.description
                    .clone()
                    .unwrap_or_else(|| "prepare-dispute".into()),
            ),
        ),
    ];
    if !intent.is_empty() {
        preparation.push(("startIntent".into(), CanonicalValue::Object(intent)));
    }
    if !pending_orderbook_removal_ids.is_empty() {
        preparation.push((
            "pendingOrderbookRemovalIds".into(),
            CanonicalValue::Array(
                pending_orderbook_removal_ids
                    .iter()
                    .cloned()
                    .map(CanonicalValue::String)
                    .collect(),
            ),
        ));
    }
    if ready_after > state.timestamp || !pending_orderbook_removal_ids.is_empty() {
        mutations.push((
            tx.counterparty_entity_id.clone(),
            AccountEnvelopeMutation::ReplaceDisputeLifecycle {
                status: "dispute_preparing".into(),
                dispute_prepare: Some(CanonicalValue::Object(preparation)),
                active_dispute: None,
            },
        ));
        status(
            events,
            format!(
                "⏳ Dispute prepared vs {}; waiting for stable evidence: cooldown:{}ms; orderbookRemovals:{}",
                &tx.counterparty_entity_id[tx.counterparty_entity_id.len() - 4..],
                ready_after.saturating_sub(state.timestamp),
                pending_orderbook_removal_ids.len(),
            ),
        );
        return Ok(());
    }
    // TS commits the prepared envelope before attempting the ready start.
    // A missing counterparty Hanko leaves this exact preparation in place;
    // dropping it here would make the next deterministic retry forget intent.
    mutations.push((
        tx.counterparty_entity_id.clone(),
        AccountEnvelopeMutation::ReplaceDisputeLifecycle {
            status: "dispute_preparing".into(),
            dispute_prepare: Some(CanonicalValue::Object(preparation)),
            active_dispute: None,
        },
    ));
    status(
        events,
        format!(
            "⏳ Dispute prepared vs {}; evidence currently stable, queue disputeStart when ready",
            &tx.counterparty_entity_id[tx.counterparty_entity_id.len() - 4..],
        ),
    );
    start(
        state,
        paybook,
        &tx.counterparty_entity_id,
        tx.description.as_deref(),
        tx.cross_jurisdiction_route_id.as_deref(),
        tx.starter_initial_arguments.as_deref(),
        account_views,
        runtime_seed,
        mutations,
        routed_outputs,
        events,
    )
}

#[expect(
    clippy::too_many_arguments,
    reason = "dispute authority, evidence views, and ordered effect sinks stay explicit at the security boundary"
)]
pub(super) fn apply_start(
    state: &mut EntityStateSlice,
    paybook: &PaybookChanges,
    tx: DisputeStartEntityTx,
    account_views: &std::collections::BTreeMap<String, LocalAccountFinancialView>,
    runtime_seed: Option<&str>,
    mutations: &mut Vec<(String, AccountEnvelopeMutation)>,
    routed_outputs: &mut Vec<LocalEntityOutput>,
    events: &mut Vec<EntityFrameEvent>,
) -> Result<(), EntityKernelError> {
    if tx.starter_counter_arguments.is_some() {
        return Err(invalid(
            "disputeStart",
            "DISPUTE_INCREMENTED_ARGUMENT_OVERRIDE_UNSUPPORTED",
        ));
    }
    if let Some(route_id) = tx.cross_jurisdiction_route_id.as_deref() {
        crate::cross_j::validate_cross_jurisdiction_dispute_route(
            state,
            &tx.counterparty_entity_id,
            route_id,
        )?;
    }
    let pending_nonce = state
        .j_batch_state
        .as_ref()
        .and_then(|j_state| j_state.sent_batch.as_ref())
        .map(|sent| sent.entity_nonce);
    state.j_batch_state.get_or_insert_with(JBatchState::default);
    if let Some(nonce) = pending_nonce {
        status(
            events,
            format!(
                "ℹ️ disputeStart queued to current batch while sentBatch nonce={nonce} is still pending"
            ),
        );
    }
    let Some(dispute) = view(account_views, &tx.counterparty_entity_id) else {
        status(
            events,
            format!(
                "❌ No account with {} - cannot start dispute",
                &tx.counterparty_entity_id[tx.counterparty_entity_id.len() - 4..],
            ),
        );
        return Ok(());
    };
    if dispute.status != "dispute_preparing" {
        status(
            events,
            format!(
                "❌ Account with {} must enter dispute preparation before disputeStart",
                &tx.counterparty_entity_id[tx.counterparty_entity_id.len() - 4..],
            ),
        );
        return Ok(());
    }
    let preparation = dispute
        .dispute_prepare
        .as_ref()
        .ok_or_else(|| invalid("disputeStart", "DISPUTE_PREPARE_MISSING"))?;
    let preparation = object(preparation, "disputeStart", "DISPUTE_PREPARE")?;
    let ready_after = u64_field(preparation, "readyAfter").unwrap_or(0);
    let pending = match field(preparation, "pendingOrderbookRemovalIds") {
        Some(CanonicalValue::Array(rows)) => rows.len(),
        None => 0,
        Some(_) => return Err(invalid("disputeStart", "PENDING_REMOVALS")),
    };
    if ready_after > state.timestamp || pending > 0 {
        let mut issues = Vec::new();
        if ready_after > state.timestamp {
            issues.push(format!(
                "cooldown:{}ms",
                ready_after.saturating_sub(state.timestamp),
            ));
        }
        if pending > 0 {
            issues.push(format!("orderbookRemovals:{pending}"));
        }
        status(
            events,
            format!(
                "⏳ disputeStart blocked until evidence is stable for {}: {}",
                &tx.counterparty_entity_id[tx.counterparty_entity_id.len() - 4..],
                issues.join("; "),
            ),
        );
        return Ok(());
    }
    start(
        state,
        paybook,
        &tx.counterparty_entity_id,
        tx.description.as_deref(),
        tx.cross_jurisdiction_route_id.as_deref(),
        tx.starter_initial_arguments.as_deref(),
        account_views,
        runtime_seed,
        mutations,
        routed_outputs,
        events,
    )
}

fn set_object_field(value: &mut CanonicalValue, name: &str, next: CanonicalValue) {
    let CanonicalValue::Object(fields) = value else {
        return;
    };
    fields.retain(|(field, _)| field != name);
    fields.push((name.to_string(), next));
}

pub(super) fn apply_finalize(
    state: &mut EntityStateSlice,
    paybook: &PaybookChanges,
    tx: DisputeFinalizeEntityTx,
    account_views: &std::collections::BTreeMap<String, LocalAccountFinancialView>,
    mutations: &mut Vec<(String, AccountEnvelopeMutation)>,
    _routed_outputs: &mut Vec<LocalEntityOutput>,
    events: &mut Vec<EntityFrameEvent>,
) -> Result<(), EntityKernelError> {
    const KIND: &str = "disputeFinalize";
    let Some(dispute) = view(account_views, &tx.counterparty_entity_id) else {
        status(
            events,
            format!(
                "❌ No account with {} - cannot finalize dispute",
                &tx.counterparty_entity_id[tx.counterparty_entity_id.len() - 4..]
            ),
        );
        return Ok(());
    };
    let Some(mut active_value) = dispute.active_dispute.clone() else {
        status(
            events,
            format!(
                "❌ No active dispute with {} - must call disputeStart first",
                &tx.counterparty_entity_id[tx.counterparty_entity_id.len() - 4..]
            ),
        );
        return Ok(());
    };
    let active = object(&active_value, KIND, "ACTIVE_DISPUTE")?;
    if bool_field(active, "observedOnChain") != Some(true) {
        status(
            events,
            format!(
                "⏳ disputeFinalize blocked until DisputeStarted is observed on-chain for {}",
                &tx.counterparty_entity_id[tx.counterparty_entity_id.len() - 4..]
            ),
        );
        return Ok(());
    }
    if bool_field(active, "finalizeQueued") == Some(true) {
        status(
            events,
            format!(
                "ℹ️ disputeFinalize already queued for {} (awaiting batch lifecycle)",
                &tx.counterparty_entity_id[tx.counterparty_entity_id.len() - 4..]
            ),
        );
        return Ok(());
    }
    let timeout = u64_field(active, "disputeTimeout").unwrap_or(0);
    if let Some(recovery) = field(active, "crossJurisdictionRecovery") {
        let recovery = object(recovery, KIND, "CROSS_J_RECOVERY")?;
        let required = match field(recovery, "requiredPullIds") {
            Some(CanonicalValue::Array(values)) => values,
            _ => return Err(invalid(KIND, "CROSS_J_RECOVERY_REQUIRED_PULL_IDS")),
        };
        let results = match field(recovery, "resultsByPullId") {
            Some(CanonicalValue::Object(values)) => values,
            _ => return Err(invalid(KIND, "CROSS_J_RECOVERY_RESULTS")),
        };
        let missing = required
            .iter()
            .filter_map(|value| match value {
                CanonicalValue::String(pull_id)
                    if !results.iter().any(|(known, _)| known == pull_id) =>
                {
                    Some(pull_id)
                }
                _ => None,
            })
            .count();
        let now_sec = state.timestamp / 1_000;
        if missing > 0 && (timeout == 0 || now_sec < timeout) {
            status(
                events,
                format!(
                    "⏳ disputeFinalize waiting for {missing} cross-j source result(s) (nowSec={now_sec}, timeoutSec={timeout})"
                ),
            );
            return Ok(());
        }
    }
    let initial_nonce =
        u64_field(active, "initialNonce").ok_or_else(|| invalid(KIND, "INITIAL_NONCE"))?;
    let initial_hash = word(
        text_field(active, "initialProofbodyHash")
            .ok_or_else(|| invalid(KIND, "INITIAL_PROOFBODY_HASH"))?,
        KIND,
        "INITIAL_PROOFBODY_HASH",
    )?;
    let initial_proposer_is_left = bool_field(active, "initialProposerIsLeft")
        .ok_or_else(|| invalid(KIND, "INITIAL_PROPOSER_ROLE"))?;
    let started_by_left =
        bool_field(active, "startedByLeft").ok_or_else(|| invalid(KIND, "STARTER_ROLE"))?;
    let selected_nonce = u64_field(active, "selectedCounterNonce");
    let selected_hash = text_field(active, "selectedCounterProofbodyHash")
        .map(|value| word(value, KIND, "SELECTED_COUNTER_HASH"))
        .transpose()?;
    let selected_role = bool_field(active, "selectedCounterProposerIsLeft");
    let caller_is_starter = dispute.owner_is_left == started_by_left;
    let counter = dispute.counterparty_dispute.as_ref();
    let counter_outranks = counter.is_some_and(|counter| {
        counter.nonce > initial_nonce
            || (counter.nonce == initial_nonce
                && counter.proposer_is_left
                && !initial_proposer_is_left)
    });
    let use_counter = if selected_nonce.is_some() {
        true
    } else {
        !caller_is_starter && counter_outranks
    };
    let (final_nonce, proposer_is_left, final_hash, sig) = if let Some(nonce) = selected_nonce {
        (
            nonce,
            selected_role.ok_or_else(|| invalid(KIND, "SELECTED_COUNTER_ROLE"))?,
            selected_hash.ok_or_else(|| invalid(KIND, "SELECTED_COUNTER_HASH"))?,
            Vec::new(),
        )
    } else if use_counter {
        let counter = counter.expect("counter selected");
        (
            counter.nonce,
            counter.proposer_is_left,
            counter.proof_body_hash,
            counter.hanko.clone().unwrap_or_default(),
        )
    } else {
        (
            initial_nonce,
            initial_proposer_is_left,
            initial_hash,
            Vec::new(),
        )
    };
    if final_nonce == 0 {
        status(events, "❌ Invalid dispute finalNonce=0 — must be > 0");
        return Ok(());
    }
    let final_body = proof_body_from_engine(
        dispute
            .proof_body
            .clone()
            .map_err(|error| invalid(KIND, error))?,
    )
    .map_err(|error| invalid(KIND, error.to_string()))?;
    let rebuilt_hash =
        proof_body_hash(&final_body).map_err(|error| invalid(KIND, error.to_string()))?;
    if rebuilt_hash != final_hash {
        return Err(invalid(
            KIND,
            format!(
                "DISPUTE_FROZEN_ACCOUNT_STATE_MISMATCH:finalize:{}:{}:{}",
                tx.counterparty_entity_id,
                hex(&final_hash),
                hex(&rebuilt_hash)
            ),
        ));
    }
    let has_pulls = dispute.pull_count > 0;
    let has_selected_counter = selected_nonce.is_some();
    let now_sec = state.timestamp / 1_000;
    let submit_not_before_timestamp = if timeout > 0 && now_sec >= timeout {
        (has_pulls || caller_is_starter || has_selected_counter).then_some(timeout)
    } else if has_selected_counter || has_pulls || caller_is_starter {
        status(
            events,
            format!("❌ disputeFinalize too early: nowSec={now_sec}, timeoutSec={timeout}"),
        );
        return Ok(());
    } else {
        None
    };
    let (left_arguments, right_arguments) = if caller_is_starter {
        (Vec::new(), Vec::new())
    } else {
        build_arguments(
            state,
            paybook,
            dispute,
            &tx.counterparty_entity_id,
            Some(dispute.owner_is_left),
        )?
    };
    let selected_commitment =
        use_counter.then(|| counter_commitment(final_nonce, proposer_is_left, final_hash));
    let starter_counter_commitment = text_field(active, "starterCounterProofCommitment")
        .map(|value| word(value, KIND, "STARTER_COUNTER_PROOF_COMMITMENT"))
        .transpose()?
        .unwrap_or(ZERO_WORD);
    let starter_arguments = if use_counter {
        if selected_commitment == Some(starter_counter_commitment) {
            bytes(
                text_field(active, "starterCounterArguments").unwrap_or("0x"),
                KIND,
                "STARTER_COUNTER_ARGUMENTS",
            )?
        } else {
            Vec::new()
        }
    } else {
        bytes(
            text_field(active, "starterInitialArguments").unwrap_or("0x"),
            KIND,
            "STARTER_INITIAL_ARGUMENTS",
        )?
    };
    let other_arguments = if caller_is_starter {
        Vec::new()
    } else if started_by_left {
        right_arguments
    } else {
        left_arguments
    };
    let counterentity = entity_word(&tx.counterparty_entity_id, KIND)?;
    if state
        .j_batch_state
        .as_ref()
        .is_some_and(|j_state| has_queued_finalize(j_state, counterentity))
    {
        set_object_field(
            &mut active_value,
            "finalizeQueued",
            CanonicalValue::Bool(true),
        );
        mutations.push((
            tx.counterparty_entity_id,
            AccountEnvelopeMutation::ReplaceDisputeLifecycle {
                status: "disputed".into(),
                dispute_prepare: None,
                active_dispute: Some(active_value),
            },
        ));
        return Ok(());
    }
    let registry_secrets = if tx.use_onchain_registry {
        known_secrets(state, paybook, dispute, &tx.counterparty_entity_id)?
    } else {
        Vec::new()
    };
    let j_state = state.j_batch_state.get_or_insert_with(JBatchState::default);
    if !j_state.batch.hash_ladder_registrations.is_empty() {
        status(
            events,
            "⏳ disputeFinalize deferred: hashLadderReveal(s) must broadcast first",
        );
        return Ok(());
    }
    if batch_op_count(&j_state.batch) >= 50 || !j_state.batch.dispute_finalizations.is_empty() {
        return Err(invalid(KIND, "J_BATCH_LIMIT_EXCEEDED"));
    }
    if tx.use_onchain_registry {
        let transformer = dispute
            .delta_transformer
            .ok_or_else(|| invalid(KIND, "DELTA_TRANSFORMER_MISSING"))?;
        for secret in registry_secrets {
            if !j_state
                .batch
                .reveal_secrets
                .iter()
                .any(|row| row.transformer == transformer && row.secret == secret)
            {
                j_state.batch.reveal_secrets.push(SecretReveal {
                    transformer,
                    secret,
                });
            }
        }
    }
    j_state.batch.dispute_finalizations.push(FinalDisputeProof {
        counterentity,
        initial_nonce: U256::from(initial_nonce),
        final_nonce: U256::from(final_nonce),
        proposer_is_left,
        initial_proofbody_hash: initial_hash,
        final_proofbody: final_body,
        starter_arguments,
        other_arguments,
        sig,
        started_by_left,
        cooperative: false,
        submit_not_before_timestamp,
    });
    crate::encode_j_batch(&j_state.batch).map_err(|error| invalid(KIND, error.to_string()))?;
    set_object_field(
        &mut active_value,
        "finalizeQueued",
        CanonicalValue::Bool(true),
    );
    mutations.push((
        tx.counterparty_entity_id.clone(),
        AccountEnvelopeMutation::ReplaceDisputeLifecycle {
            status: "disputed".into(),
            dispute_prepare: None,
            active_dispute: Some(active_value),
        },
    ));
    status(
        events,
        format!(
            "⚖️ Dispute finalized vs {} {}- use jBroadcast to commit",
            &tx.counterparty_entity_id[tx.counterparty_entity_id.len() - 4..],
            tx.description
                .as_ref()
                .map(|value| format!("({value}) "))
                .unwrap_or_default(),
        ),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CanonicalEntityTx, EntityTxKind};
    use std::collections::BTreeMap;
    use xln_rscore_batch::ResidentAccountDisputeView;
    use xln_rscore_engine::{CounterpartyDispute, DisputeProofBody};

    const OWNER: &str = "0x0101010101010101010101010101010101010101010101010101010101010101";
    const PEER: &str = "0x0202020202020202020202020202020202020202020202020202020202020202";

    fn proof_body() -> DisputeProofBody {
        DisputeProofBody {
            watch_seed: [0x11; 32],
            left_response_seconds: 10,
            right_response_seconds: 20,
            offdeltas: Vec::new(),
            token_ids: Vec::new(),
            transformers: Vec::new(),
        }
    }

    #[test]
    fn dispute_start_wire_rejects_unauthenticated_counter_commitment_override() {
        let tx = CanonicalEntityTx::from_frame_projection(
            EntityTxKind::DisputeStart,
            CanonicalValue::Object(vec![
                (
                    "counterpartyEntityId".into(),
                    CanonicalValue::String(PEER.into()),
                ),
                (
                    "starterCounterProofCommitment".into(),
                    CanonicalValue::String(format!("0x{}", "11".repeat(32))),
                ),
            ]),
        )
        .expect("canonical wire projection");

        let error = crate::local_financial::decode::decode_local_entity_financial_tx(&tx)
            .expect_err("standalone counter commitment is not an EntityTx input");
        assert!(error.to_string().contains("disputeStart:DATA_FIELDS"));
    }

    fn account_view(
        status: &str,
        prepare: Option<CanonicalValue>,
        active: Option<CanonicalValue>,
        counterparty: Option<CounterpartyDispute>,
    ) -> BTreeMap<String, LocalAccountFinancialView> {
        BTreeMap::from([(
            PEER.to_string(),
            LocalAccountFinancialView {
                active: status == "active",
                owner_side: xln_rscore_engine::Side::Left,
                owner_out_capacity: BTreeMap::new(),
                owner_peer_credit_limit: BTreeMap::new(),
                settlement_workspace: None,
                settlement_transition_pending: false,
                settlement_execution: Err("unused".into()),
                rebalance_active_quote: None,
                htlc_locks: BTreeMap::new(),
                pulls: BTreeMap::new(),
                swap_offers: BTreeMap::new(),
                pending_cross_pull_close_ids: Default::default(),
                dispute: Some(ResidentAccountDisputeView {
                    status: status.into(),
                    dispute_prepare: prepare,
                    active_dispute: active,
                    local_dispute: None,
                    counterparty_dispute: counterparty,
                    proof_body: Ok(proof_body()),
                    j_nonce: 0,
                    owner_is_left: true,
                    delta_transformer: Some([0x22; 20]),
                    payment_hashlocks: Vec::new(),
                    pull_ids: Vec::new(),
                    pull_count: 0,
                    swap_offers: Vec::new(),
                    pending_swap_fill_ratios: BTreeMap::new(),
                }),
            },
        )])
    }

    #[test]
    fn dispute_start_missing_account_matches_typescript_state_and_event() {
        let mut state = state(1_000);
        let mut mutations = Vec::new();
        let mut routed_outputs = Vec::new();
        let mut events = Vec::new();
        apply_start(
            &mut state,
            &PaybookChanges::default(),
            DisputeStartEntityTx {
                counterparty_entity_id: PEER.into(),
                description: None,
                cross_jurisdiction_route_id: None,
                starter_initial_arguments: None,
                starter_counter_arguments: None,
            },
            &BTreeMap::new(),
            None,
            &mut mutations,
            &mut routed_outputs,
            &mut events,
        )
        .expect("missing Account is a deterministic no-op");

        assert_eq!(state.j_batch_state, Some(JBatchState::default()));
        assert!(mutations.is_empty());
        assert!(routed_outputs.is_empty());
        assert_eq!(
            events,
            [EntityFrameEvent::Status {
                message: "❌ No account with 0202 - cannot start dispute".into(),
            }],
        );
    }

    #[test]
    fn dispute_start_readiness_event_matches_typescript_issue_order() {
        let prepare = CanonicalValue::Object(vec![
            (
                "readyAfter".into(),
                CanonicalValue::Number(CanonicalNumber::try_from_u64(1_100).expect("number")),
            ),
            (
                "pendingOrderbookRemovalIds".into(),
                CanonicalValue::Array(vec![CanonicalValue::String("offer-1".into())]),
            ),
        ]);
        let views = account_view("dispute_preparing", Some(prepare), None, None);
        let mut state = state(1_000);
        let mut mutations = Vec::new();
        let mut routed_outputs = Vec::new();
        let mut events = Vec::new();
        apply_start(
            &mut state,
            &PaybookChanges::default(),
            DisputeStartEntityTx {
                counterparty_entity_id: PEER.into(),
                description: None,
                cross_jurisdiction_route_id: None,
                starter_initial_arguments: None,
                starter_counter_arguments: None,
            },
            &views,
            None,
            &mut mutations,
            &mut routed_outputs,
            &mut events,
        )
        .expect("not-ready dispute is a deterministic no-op");

        assert_eq!(
            events,
            [EntityFrameEvent::Status {
                message: "⏳ disputeStart blocked until evidence is stable for 0202: cooldown:100ms; orderbookRemovals:1".into(),
            }],
        );
    }

    #[test]
    fn route_bound_dispute_start_rejects_before_no_account_state_mutation() {
        let mut state = state(1_000);
        let mut mutations = Vec::new();
        let mut routed_outputs = Vec::new();
        let mut events = Vec::new();
        let error = apply_start(
            &mut state,
            &PaybookChanges::default(),
            DisputeStartEntityTx {
                counterparty_entity_id: PEER.into(),
                description: None,
                cross_jurisdiction_route_id: Some("missing-route".into()),
                starter_initial_arguments: None,
                starter_counter_arguments: None,
            },
            &BTreeMap::new(),
            None,
            &mut mutations,
            &mut routed_outputs,
            &mut events,
        )
        .expect_err("unknown route must reject before Account admission");

        assert!(
            error
                .to_string()
                .contains("DISPUTE_START_CROSS_J_ROUTE_MISSING")
        );
        assert!(state.j_batch_state.is_none());
        assert!(events.is_empty());
        assert!(mutations.is_empty());
        assert!(routed_outputs.is_empty());
    }

    fn state(timestamp: u64) -> EntityStateSlice {
        EntityStateSlice::empty(OWNER, timestamp)
    }

    fn counterparty_proof() -> CounterpartyDispute {
        let body = proof_body_from_engine(proof_body()).expect("body");
        CounterpartyDispute {
            hanko: Some(vec![0x44; 65]),
            hash: [0x33; 32],
            proof_body_hash: proof_body_hash(&body).expect("hash"),
            nonce: 1,
            proposer_is_left: false,
        }
    }

    #[test]
    fn zero_cooldown_prepare_queues_one_start_and_one_account_lifecycle_write() {
        let mut state = state(1_000);
        let views = account_view("active", None, None, Some(counterparty_proof()));
        let mut mutations = Vec::new();
        let mut routed_outputs = Vec::new();
        let mut events = Vec::new();
        apply_prepare(
            &mut state,
            &PaybookChanges::default(),
            PrepareDisputeEntityTx {
                counterparty_entity_id: PEER.into(),
                description: Some("test".into()),
                min_cooldown_ms: 0,
                cross_jurisdiction_route_id: None,
                starter_initial_arguments: None,
            },
            &views,
            None,
            &mut mutations,
            &mut routed_outputs,
            &mut events,
            &mut Vec::new(),
        )
        .expect("prepare");
        assert_eq!(
            state
                .j_batch_state
                .as_ref()
                .expect("j state")
                .batch
                .dispute_starts
                .len(),
            1
        );
        // TS commits the prepared envelope before the ready start replaces it.
        assert_eq!(mutations.len(), 2);
        assert!(matches!(
            &mutations[0].1,
            AccountEnvelopeMutation::ReplaceDisputeLifecycle { status, dispute_prepare: Some(_), active_dispute: None }
                if status == "dispute_preparing"
        ));
        assert!(matches!(
            &mutations[1].1,
            AccountEnvelopeMutation::ReplaceDisputeLifecycle { status, dispute_prepare: None, active_dispute: Some(_) }
                if status == "disputed"
        ));
        let messages = events
            .iter()
            .map(|event| match event {
                EntityFrameEvent::Status { message } => message.as_str(),
                EntityFrameEvent::Text { .. } => panic!("unexpected text event"),
            })
            .collect::<Vec<_>>();
        assert_eq!(
            messages,
            vec![
                "⏳ Dispute prepared vs 0202; evidence currently stable, queue disputeStart when ready",
                "⚔️ Dispute started vs 0202 (test) - account frozen, use jBroadcast to commit",
            ],
        );
    }

    #[test]
    fn cooldown_prepare_only_freezes_and_does_not_queue_jbatch() {
        let mut state = state(1_000);
        let views = account_view("active", None, None, Some(counterparty_proof()));
        let mut mutations = Vec::new();
        let mut routed_outputs = Vec::new();
        let mut events = Vec::new();
        apply_prepare(
            &mut state,
            &PaybookChanges::default(),
            PrepareDisputeEntityTx {
                counterparty_entity_id: PEER.into(),
                description: None,
                min_cooldown_ms: 50,
                cross_jurisdiction_route_id: None,
                starter_initial_arguments: None,
            },
            &views,
            None,
            &mut mutations,
            &mut routed_outputs,
            &mut events,
            &mut Vec::new(),
        )
        .expect("prepare");
        assert!(state.j_batch_state.is_none());
        assert!(matches!(
            &mutations[0].1,
            AccountEnvelopeMutation::ReplaceDisputeLifecycle { status, dispute_prepare: Some(_), active_dispute: None }
                if status == "dispute_preparing"
        ));
    }

    #[test]
    fn h2005_pull_free_nonstarter_finalize_matches_mutual_consent_transition() {
        let body = proof_body_from_engine(proof_body()).expect("body");
        let body_hash = proof_body_hash(&body).expect("hash");
        let active = active_dispute_value(
            &account_view("active", None, None, None)
                .get(PEER)
                .unwrap()
                .dispute
                .clone()
                .unwrap(),
            body_hash,
            1,
            false,
            &[],
            &[],
            ZERO_WORD,
        )
        .expect("active");
        let mut active = active;
        set_object_field(&mut active, "observedOnChain", CanonicalValue::Bool(true));
        set_object_field(&mut active, "startedByLeft", CanonicalValue::Bool(false));
        let views = account_view("disputed", None, Some(active), None);
        let mut state = state(1_000);
        let mut mutations = Vec::new();
        let mut routed_outputs = Vec::new();
        let mut events = Vec::new();
        apply_finalize(
            &mut state,
            &PaybookChanges::default(),
            DisputeFinalizeEntityTx {
                counterparty_entity_id: PEER.into(),
                use_onchain_registry: false,
                description: Some("hlt-authority-reverse-mutual-consent".into()),
            },
            &views,
            &mut mutations,
            &mut routed_outputs,
            &mut events,
        )
        .expect("finalize");
        let finalizations = &state
            .j_batch_state
            .as_ref()
            .expect("j state")
            .batch
            .dispute_finalizations;
        assert_eq!(finalizations.len(), 1);
        let queued = &finalizations[0];
        assert_eq!(queued.initial_nonce, U256::from(1));
        assert_eq!(queued.final_nonce, U256::from(1));
        assert!(!queued.proposer_is_left);
        assert!(!queued.started_by_left);
        assert!(!queued.cooperative);
        assert_eq!(queued.submit_not_before_timestamp, None);
        assert_eq!(queued.initial_proofbody_hash, body_hash);
        assert_eq!(
            proof_body_hash(&queued.final_proofbody).expect("hash"),
            body_hash
        );
        assert!(queued.sig.is_empty());
        assert!(queued.starter_arguments.is_empty());
        assert!(queued.other_arguments.is_empty());

        assert_eq!(mutations.len(), 1);
        let AccountEnvelopeMutation::ReplaceDisputeLifecycle {
            status: mutation_status,
            dispute_prepare,
            active_dispute: Some(mutation_active),
        } = &mutations[0].1
        else {
            panic!("expected dispute lifecycle replacement");
        };
        assert_eq!(mutation_status, "disputed");
        assert_eq!(dispute_prepare, &None);
        assert_eq!(
            bool_field(
                object(mutation_active, "test", "ACTIVE").expect("active"),
                "finalizeQueued"
            ),
            Some(true),
        );
        assert_eq!(
            events,
            [EntityFrameEvent::Status {
                message: "⚖️ Dispute finalized vs 0202 (hlt-authority-reverse-mutual-consent) - use jBroadcast to commit".into(),
            }],
        );
    }
}

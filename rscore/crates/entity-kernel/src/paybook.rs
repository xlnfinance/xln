use std::collections::BTreeSet;

use num_bigint::BigInt;
use sha3::{Digest as _, Keccak256};
use xln_rscore_engine::{
    AccountOutput, AccountTx, DeliveryMode, HtlcLockTx, HtlcResolveOutcome, HtlcResolveTx,
};

use crate::types::{
    EntityKernelOutput, EntityStateSlice, HtlcPreparedOutcome, HtlcRoute, TargetedAccountTx,
};
use crate::{DeterministicContext, EntityKernelError, OrderedAccountCommit};

const MIN_TIMELOCK_DELTA_MS: u64 = 10_000;
const MIN_REVEAL_HEIGHT_DELTA_BLOCKS: u64 = 3;
const SECRET_ACK_TIMEOUT_MS: u64 = 120_000;

pub(crate) struct PaybookEffects<'a> {
    pub account_txs: &'a mut Vec<TargetedAccountTx>,
    pub outputs: &'a mut Vec<EntityKernelOutput>,
}

pub(crate) fn direct_payment_forward(
    state: &EntityStateSlice,
    output: &AccountOutput,
    effects: &mut PaybookEffects<'_>,
) -> Result<(), EntityKernelError> {
    let AccountOutput::DirectPaymentForward {
        token_id,
        amount,
        route,
        description,
        delivery_mode,
        trusted_gateway_entity_id,
    } = output
    else {
        return Err(EntityKernelError::output("DIRECT_PAYMENT_FORWARD_KIND"));
    };
    if *delivery_mode != DeliveryMode::Trusted {
        return Err(EntityKernelError::output("DIRECT_PAYMENT_FORWARD_MODE"));
    }
    let Some(next_hop) = route.get(1) else {
        return Err(EntityKernelError::output("ROUTED_PAYMENT_NEXT_HOP_MISSING"));
    };
    if !state.known_accounts.contains(next_hop) {
        return Err(EntityKernelError::AccountMissing {
            account_id: next_hop.clone(),
        });
    }
    effects.account_txs.push((
        next_hop.clone(),
        AccountTx::DirectPayment {
            token_id: *token_id,
            amount: amount.clone(),
            route: route[1..].to_vec(),
            description: Some(
                description
                    .clone()
                    .unwrap_or_else(|| "Forwarded payment".to_string()),
            ),
            from_entity_id: state.entity_id.clone(),
            to_entity_id: next_hop.clone(),
            delivery_mode: *delivery_mode,
            trusted_gateway_entity_id: Some(trusted_gateway_entity_id.clone()),
        },
    ));
    Ok(())
}

fn prepared_key(commit: &OrderedAccountCommit, lock_id: &str) -> (String, String) {
    (commit.frame_state_hash.clone(), lock_id.to_string())
}

fn validate_binding<'a>(
    commit: &OrderedAccountCommit,
    tx: &HtlcLockTx,
    state_entity_id: &str,
    context: &'a DeterministicContext,
) -> Result<&'a crate::PreparedHtlcEntry, EntityKernelError> {
    let key = prepared_key(commit, &tx.lock_id);
    let prepared =
        context
            .prepared_htlcs
            .get(&key)
            .ok_or_else(|| EntityKernelError::PreparedHtlcMissing {
                account_id: commit.account_id.clone(),
                lock_id: tx.lock_id.clone(),
            })?;
    let binding = &prepared.binding;
    let envelope_hash = tx
        .envelope
        .as_ref()
        .map(|value| hex_digest(&value.integrity_hash()));
    let matches = binding.from_entity_id == commit.account_id
        && binding.to_entity_id == state_entity_id
        && binding.domain == commit.domain
        && binding.account_frame_hash == commit.frame_state_hash
        && binding.account_height == commit.frame_height
        && binding.lock_id == tx.lock_id
        && Some(binding.envelope_hash.as_str()) == envelope_hash.as_deref()
        && binding.hashlock == tx.hashlock.as_str()
        && binding.token_id == tx.token_id.get()
        && binding.amount == tx.amount
        && binding.timelock == tx.timelock
        && binding.reveal_before_height == tx.reveal_before_height;
    if !matches {
        return Err(EntityKernelError::PreparedHtlcMismatch {
            detail: format!("{}:{}", commit.frame_state_hash, tx.lock_id),
        });
    }
    Ok(prepared)
}

fn hex_digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(2 + bytes.len() * 2);
    output.push_str("0x");
    for byte in bytes {
        output.push(char::from(HEX[(byte >> 4) as usize]));
        output.push(char::from(HEX[(byte & 0x0f) as usize]));
    }
    output
}

fn forward_lock_id(lock_id: &str) -> Result<String, EntityKernelError> {
    let Some(payload) = lock_id.strip_prefix("0x") else {
        return Err(EntityKernelError::htlc("HTLC_FORWARD_LOCK_ID_INVALID"));
    };
    if payload.len() != 64 || !payload.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(EntityKernelError::htlc("HTLC_FORWARD_LOCK_ID_INVALID"));
    }
    let text = format!("xln:htlc-forward-lock:v1:{}", lock_id.to_lowercase());
    Ok(hex_digest(&Keccak256::digest(text.as_bytes())))
}

fn queue_error(effects: &mut PaybookEffects<'_>, account_id: &str, lock_id: &str, reason: String) {
    effects.account_txs.push((
        account_id.to_string(),
        AccountTx::HtlcResolve(HtlcResolveTx {
            lock_id: lock_id.to_string(),
            outcome: HtlcResolveOutcome::Error {
                reason: Some(reason),
            },
        }),
    ));
}

fn queue_secret(effects: &mut PaybookEffects<'_>, account_id: &str, lock_id: &str, secret: &str) {
    effects.account_txs.push((
        account_id.to_string(),
        AccountTx::HtlcResolve(HtlcResolveTx {
            lock_id: lock_id.to_string(),
            outcome: HtlcResolveOutcome::Secret {
                secret: secret.to_string(),
            },
        }),
    ));
}

fn apply_final_prepared(
    state: &mut EntityStateSlice,
    commit: &OrderedAccountCommit,
    tx: &HtlcLockTx,
    secret: &str,
    started_at_ms: Option<u64>,
    effects: &mut PaybookEffects<'_>,
) {
    let existing = state.htlc_routes.get_mut(tx.hashlock.as_str());
    if let Some(route) = existing {
        route.inbound_entity = Some(commit.account_id.clone());
        route.inbound_lock_id = Some(tx.lock_id.clone());
    } else {
        state.htlc_routes.insert(
            tx.hashlock.as_str().to_string(),
            HtlcRoute {
                hashlock: tx.hashlock.as_str().to_string(),
                token_id: Some(tx.token_id.get()),
                amount: Some(tx.amount.clone()),
                started_at_ms,
                originated: false,
                inbound_entity: Some(commit.account_id.clone()),
                inbound_lock_id: Some(tx.lock_id.clone()),
                outbound_entity: None,
                outbound_lock_id: None,
                inbound_settled: false,
                outbound_settled: false,
                secret: None,
                secret_ack_pending: false,
                secret_ack_started_at: None,
                secret_ack_deadline_at: None,
                pending_fee: None,
                created_timestamp: state.timestamp,
            },
        );
    }
    queue_secret(effects, &commit.account_id, &tx.lock_id, secret);
}

fn apply_forward_prepared(
    state: &mut EntityStateSlice,
    commit: &OrderedAccountCommit,
    tx: &HtlcLockTx,
    next_hop: &str,
    forward_amount: &BigInt,
    inner_envelope: &xln_rscore_engine::OpaqueHtlcCiphertext,
    effects: &mut PaybookEffects<'_>,
) -> Result<(), EntityKernelError> {
    if !state.known_accounts.contains(next_hop) {
        return Err(EntityKernelError::AccountMissing {
            account_id: next_hop.to_string(),
        });
    }
    let timelock = &tx.timelock - BigInt::from(MIN_TIMELOCK_DELTA_MS);
    let reveal = tx
        .reveal_before_height
        .checked_sub(MIN_REVEAL_HEIGHT_DELTA_BLOCKS)
        .ok_or_else(|| EntityKernelError::htlc("HTLC_FORWARD_REVEAL_UNDERFLOW"))?;
    if timelock <= BigInt::from(0)
        || forward_amount <= &BigInt::from(0)
        || forward_amount > &tx.amount
    {
        return Err(EntityKernelError::htlc(
            "HTLC_FORWARD_AMOUNT_OR_TIME_INVALID",
        ));
    }
    let outbound_lock_id = forward_lock_id(&tx.lock_id)?;
    state.htlc_routes.insert(
        tx.hashlock.as_str().to_string(),
        HtlcRoute {
            hashlock: tx.hashlock.as_str().to_string(),
            token_id: Some(tx.token_id.get()),
            amount: Some(tx.amount.clone()),
            started_at_ms: None,
            originated: false,
            inbound_entity: Some(commit.account_id.clone()),
            inbound_lock_id: Some(tx.lock_id.clone()),
            outbound_entity: Some(next_hop.to_string()),
            outbound_lock_id: Some(outbound_lock_id.clone()),
            inbound_settled: false,
            outbound_settled: false,
            secret: None,
            secret_ack_pending: false,
            secret_ack_started_at: None,
            secret_ack_deadline_at: None,
            pending_fee: Some(&tx.amount - forward_amount),
            created_timestamp: state.timestamp,
        },
    );
    effects
        .outputs
        .push(EntityKernelOutput::HtlcForwardAccepted {
            entity_id: state.entity_id.clone(),
            hashlock: tx.hashlock.as_str().to_string(),
        });
    effects.account_txs.push((
        next_hop.to_string(),
        AccountTx::HtlcLock(HtlcLockTx {
            lock_id: outbound_lock_id,
            hashlock: tx.hashlock.clone(),
            timelock,
            reveal_before_height: reveal,
            amount: forward_amount.clone(),
            token_id: tx.token_id,
            delivery_mode: None,
            envelope: Some(inner_envelope.clone()),
        }),
    ));
    Ok(())
}

pub(crate) fn committed_htlc_lock(
    state: &mut EntityStateSlice,
    commit: &OrderedAccountCommit,
    tx: &HtlcLockTx,
    context: &DeterministicContext,
    consumed: &mut BTreeSet<(String, String)>,
    effects: &mut PaybookEffects<'_>,
) -> Result<(), EntityKernelError> {
    if !commit.committed_via_new_frame || tx.envelope.is_none() {
        return Ok(());
    }
    let key = prepared_key(commit, &tx.lock_id);
    if !consumed.insert(key.clone()) {
        return Err(EntityKernelError::PreparedHtlcMismatch {
            detail: format!("REUSED:{key:?}"),
        });
    }
    let prepared = validate_binding(commit, tx, &state.entity_id, context)?;
    let closes_self_cycle = matches!(prepared.outcome, HtlcPreparedOutcome::Final { .. })
        && state
            .htlc_routes
            .get(tx.hashlock.as_str())
            .is_some_and(|route| route.originated && route.inbound_entity.is_none());
    if state.htlc_routes.contains_key(tx.hashlock.as_str()) && !closes_self_cycle {
        queue_error(
            effects,
            &commit.account_id,
            &tx.lock_id,
            "hashlock_already_active".to_string(),
        );
        return Ok(());
    }
    match &prepared.outcome {
        HtlcPreparedOutcome::Reject { reason } => {
            queue_error(effects, &commit.account_id, &tx.lock_id, reason.clone());
            Ok(())
        }
        HtlcPreparedOutcome::Final {
            secret,
            started_at_ms,
        } => {
            apply_final_prepared(state, commit, tx, secret, *started_at_ms, effects);
            Ok(())
        }
        HtlcPreparedOutcome::Forward {
            next_hop_entity_id,
            forward_amount,
            inner_envelope,
        } => apply_forward_prepared(
            state,
            commit,
            tx,
            next_hop_entity_id,
            forward_amount,
            inner_envelope,
            effects,
        ),
    }
}

fn matching_route<'a>(
    state: &'a mut EntityStateSlice,
    hashlock: &str,
) -> Option<&'a mut HtlcRoute> {
    state.htlc_routes.get_mut(hashlock)
}

pub(crate) fn committed_htlc_resolve(
    state: &mut EntityStateSlice,
    account_id: &str,
    output: &AccountOutput,
    jurisdiction_id: Option<&str>,
    effects: &mut PaybookEffects<'_>,
) -> Result<(), EntityKernelError> {
    let (lock_id, hashlock, secret) = match output {
        AccountOutput::HtlcSecret {
            lock_id,
            hashlock,
            secret,
            ..
        } => (lock_id, hashlock, Some(secret)),
        AccountOutput::HtlcError {
            lock_id, hashlock, ..
        } => (lock_id, hashlock, None),
        _ => return Err(EntityKernelError::output("HTLC_RESOLVE_OUTPUT_KIND")),
    };
    state.lock_book.remove(lock_id);
    let entity_id = state.entity_id.clone();
    let timestamp = state.timestamp;
    let Some(route) = matching_route(state, hashlock) else {
        return Ok(());
    };
    let resolves_inbound = route.inbound_lock_id.as_deref() == Some(lock_id);
    let resolves_originated_outbound = route.outbound_lock_id.as_deref() == Some(lock_id)
        && (route.originated || route.inbound_entity.is_none());
    let resolves_forwarded_outbound = route.outbound_lock_id.as_deref() == Some(lock_id)
        && route.inbound_entity.is_some()
        && route.outbound_entity.is_some()
        && !route.originated;
    if let Some(secret) = secret {
        if resolves_inbound {
            effects.outputs.push(EntityKernelOutput::HtlcReceived {
                entity_id: entity_id.clone(),
                from_entity: account_id.to_string(),
                to_entity: entity_id.clone(),
                hashlock: hashlock.to_string(),
                lock_id: lock_id.to_string(),
                token_id: route.token_id,
                amount: route.amount.clone(),
                started_at_ms: route.started_at_ms,
                jurisdiction_id: jurisdiction_id.map(str::to_string),
                received_at_ms: timestamp,
            });
        }
        if resolves_forwarded_outbound {
            return Ok(());
        }
        if resolves_originated_outbound {
            effects.outputs.push(EntityKernelOutput::HtlcFinalized {
                entity_id: entity_id.clone(),
                from_entity: entity_id,
                to_entity: route.outbound_entity.clone(),
                hashlock: hashlock.to_string(),
                secret: secret.to_string(),
                lock_id: Some(lock_id.to_string()),
                token_id: route.token_id,
                amount: route.amount.clone(),
                started_at_ms: route.started_at_ms,
                jurisdiction_id: jurisdiction_id.map(str::to_string),
                finalized_at_ms: timestamp,
            });
        }
        if route.originated && route.inbound_entity.is_some() {
            if resolves_inbound {
                route.inbound_settled = true;
            }
            if resolves_originated_outbound {
                route.outbound_settled = true;
            }
            if !route.inbound_settled || !route.outbound_settled {
                return Ok(());
            }
        }
        state.htlc_routes.remove(hashlock);
    }
    Ok(())
}

pub(crate) fn revealed_secret_followup(
    state: &mut EntityStateSlice,
    output: &AccountOutput,
    jurisdiction_id: Option<&str>,
    effects: &mut PaybookEffects<'_>,
) -> Result<(), EntityKernelError> {
    let AccountOutput::HtlcSecret {
        hashlock, secret, ..
    } = output
    else {
        return Err(EntityKernelError::output("HTLC_SECRET_OUTPUT_KIND"));
    };
    let entity_id = state.entity_id.clone();
    let timestamp = state.timestamp;
    let Some(route) = state.htlc_routes.get_mut(hashlock) else {
        return Ok(());
    };
    if route.secret.is_some() {
        return Ok(());
    }
    route.secret = Some(secret.clone());
    if let Some(fee) = route.pending_fee.take() {
        state.htlc_fees_earned += fee;
    }
    if let Some(lock_id) = &route.outbound_lock_id {
        state.lock_book.remove(lock_id);
    }
    if let Some(lock_id) = &route.inbound_lock_id {
        state.lock_book.remove(lock_id);
    }
    if let (Some(account), Some(lock_id)) = (&route.inbound_entity, &route.inbound_lock_id) {
        queue_secret(effects, account, lock_id, secret);
        route.secret_ack_pending = true;
        route.secret_ack_started_at = Some(timestamp);
        route.secret_ack_deadline_at = Some(
            timestamp
                .checked_add(SECRET_ACK_TIMEOUT_MS)
                .ok_or_else(|| EntityKernelError::htlc("HTLC_SECRET_ACK_DEADLINE_OVERFLOW"))?,
        );
        return Ok(());
    }
    effects.outputs.push(EntityKernelOutput::HtlcFinalized {
        entity_id: entity_id.clone(),
        from_entity: entity_id,
        to_entity: route.outbound_entity.clone(),
        hashlock: hashlock.clone(),
        secret: secret.clone(),
        lock_id: route.outbound_lock_id.clone(),
        token_id: route.token_id,
        amount: route.amount.clone(),
        started_at_ms: route.started_at_ms,
        jurisdiction_id: jurisdiction_id.map(str::to_string),
        finalized_at_ms: timestamp,
    });
    state.htlc_routes.remove(hashlock);
    Ok(())
}

pub(crate) fn timed_out_followup(
    state: &mut EntityStateSlice,
    output: &AccountOutput,
    effects: &mut PaybookEffects<'_>,
) -> Result<(), EntityKernelError> {
    let AccountOutput::HtlcError { hashlock, .. } = output else {
        return Err(EntityKernelError::output("HTLC_ERROR_OUTPUT_KIND"));
    };
    let Some(route) = state.htlc_routes.remove(hashlock) else {
        return Ok(());
    };
    if let (Some(account), Some(lock_id)) = (&route.inbound_entity, &route.inbound_lock_id) {
        queue_error(effects, account, lock_id, "downstream_error".to_string());
    } else {
        effects.outputs.push(EntityKernelOutput::HtlcFailed {
            entity_id: state.entity_id.clone(),
            hashlock: hashlock.clone(),
            lock_id: route.outbound_lock_id.clone(),
            reason: "timeout".to_string(),
        });
    }
    if let Some(lock_id) = route.outbound_lock_id {
        state.lock_book.remove(&lock_id);
    }
    Ok(())
}

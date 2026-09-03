use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;
use xln_rscore_engine::{
    AccountOutput, AccountTx, DeliveryMode, HtlcLockTx, HtlcResolveOutcome, HtlcResolveTx,
};
use xln_rscore_protocol::{PersistentRadixMutation, SlotWork};

use crate::commitment::{canonical_paybook_entry, consensus_digest_bytes};
use crate::types::{
    EntityKernelOutput, EntityStateSlice, HtlcPreparedOutcome, PaybookEntry, PaybookState,
    TargetedAccountTx,
};
use crate::{DeterministicContext, EntityKernelError, OrderedAccountCommit};

const MIN_TIMELOCK_DELTA_MS: u64 = 10_000;
const MIN_REVEAL_HEIGHT_DELTA_BLOCKS: u64 = 3;
const SECRET_ACK_TIMEOUT_MS: u64 = 120_000;

/// Paybook paths are the raw 32-byte hashlock. A length-prefixed text key puts
/// every canonical `0x…` hashlock under the same Patricia prefix and defeats
/// physical sharding even though the financial identifier itself is uniform.
fn paybook_key(hashlock: &str) -> Result<Vec<u8>, EntityKernelError> {
    let payload = hashlock
        .strip_prefix("0x")
        .filter(|payload| {
            payload.len() == 64
                && payload
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .ok_or_else(|| EntityKernelError::htlc("PAYBOOK_HASHLOCK_INVALID"))?;
    let bytes =
        hex::decode(payload).map_err(|_| EntityKernelError::htlc("PAYBOOK_HASHLOCK_INVALID"))?;
    if bytes.len() != 32 {
        return Err(EntityKernelError::htlc("PAYBOOK_HASHLOCK_INVALID"));
    }
    Ok(bytes)
}

pub(crate) struct PaybookEffects<'a> {
    pub account_txs: &'a mut Vec<TargetedAccountTx>,
    pub outputs: &'a mut Vec<EntityKernelOutput>,
}

/// Transient, frame-local overlay over the canonical Paybook radix map.
/// Reads observe prior writes in transaction order; only the final value of
/// each hashlock is encoded and committed once after Entity execution.
#[derive(Default)]
pub(crate) struct PaybookChanges {
    pending: BTreeMap<Vec<u8>, Option<PaybookEntry>>,
}

pub(crate) type PendingPaybookMutation = (Vec<u8>, Option<PaybookEntry>);

impl PaybookChanges {
    pub(crate) fn mutation_count(&self) -> usize {
        self.pending.len()
    }

    pub(crate) fn entry<'a>(
        &'a self,
        state: &'a EntityStateSlice,
        hashlock: &str,
    ) -> Result<Option<&'a PaybookEntry>, EntityKernelError> {
        let key = paybook_key(hashlock)?;
        Ok(match self.pending.get(&key) {
            Some(entry) => entry.as_ref(),
            None => state.paybook.entries.get(&key),
        })
    }

    pub(crate) fn put(&mut self, entry: PaybookEntry) -> Result<(), EntityKernelError> {
        self.pending
            .insert(paybook_key(&entry.hashlock)?, Some(entry));
        Ok(())
    }

    pub(crate) fn remove(
        &mut self,
        state: &EntityStateSlice,
        hashlock: &str,
    ) -> Result<Option<PaybookEntry>, EntityKernelError> {
        let key = paybook_key(hashlock)?;
        let entry = match self.pending.get(&key) {
            Some(entry) => entry.clone(),
            None => state.paybook.entries.get(&key).cloned(),
        };
        if entry.is_some() {
            self.pending.insert(key, None);
        }
        Ok(entry)
    }

    /// Secret-ack waits whose deadline is at or before `now`, frame-local
    /// writes included, in (deadline, hashlock) order: the key the hook map
    /// used to drain `htlc-secret-ack:<hashlock>` by. Mirrors TS
    /// `collectDerivedDeadlines` / `isSecretAckPendingPayment`.
    pub(crate) fn due_secret_acks(
        &self,
        state: &EntityStateSlice,
        now: u64,
    ) -> Result<Vec<(String, String)>, EntityKernelError> {
        let mut due = Vec::new();
        let mut consider = |entry: &PaybookEntry| {
            let (Some(counterparty), Some(deadline), Some(started_at)) = (
                entry.inbound_entity.as_ref(),
                entry.secret_ack_deadline_at,
                entry.secret_ack_started_at,
            ) else {
                return;
            };
            if entry.secret_ack_pending
                && entry.secret.is_some()
                && deadline >= started_at
                && deadline <= now
            {
                due.push((deadline, entry.hashlock.clone(), counterparty.clone()));
            }
        };
        for (key, entry) in state.paybook.entries.iter() {
            if self.pending.contains_key(key) {
                continue;
            }
            consider(entry);
        }
        for entry in self.pending.values().flatten() {
            consider(entry);
        }
        due.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
        Ok(due
            .into_iter()
            .map(|(_, hashlock, counterparty)| (hashlock, counterparty))
            .collect())
    }

    pub(crate) fn into_mutations(
        self,
    ) -> Result<Vec<PersistentRadixMutation<PaybookEntry>>, EntityKernelError> {
        self.into_pending()
            .into_iter()
            .map(build_paybook_mutation)
            .collect()
    }

    /// Move the final frame-local values out in canonical key order. Resident
    /// production maps the independent encode+digest work over the shared CPU
    /// pool; the sequential oracle below calls the exact same builder.
    pub(crate) fn into_pending(self) -> Vec<PendingPaybookMutation> {
        self.pending.into_iter().collect()
    }

    pub(crate) fn commit_sequential(
        self,
        state: &mut EntityStateSlice,
    ) -> Result<(), EntityKernelError> {
        let mutations = self.into_mutations()?;
        state.paybook.entries = state
            .paybook
            .entries
            .mutated_batch_two_levels(mutations, |slots| slots.map(SlotWork::apply))
            .map_err(paybook_error)?;
        Ok(())
    }
}

pub(crate) fn build_paybook_mutation(
    (key, entry): PendingPaybookMutation,
) -> Result<PersistentRadixMutation<PaybookEntry>, EntityKernelError> {
    match entry {
        Some(entry) => {
            let value = canonical_paybook_entry(&entry)?;
            Ok(PersistentRadixMutation::Put {
                key,
                value_digest: consensus_digest_bytes(&value)?,
                value: entry,
            })
        }
        None => Ok(PersistentRadixMutation::Remove { key }),
    }
}

impl PaybookState {
    pub fn entry(&self, hashlock: &str) -> Result<Option<&PaybookEntry>, EntityKernelError> {
        Ok(self.entries.get(&paybook_key(hashlock)?))
    }

    pub fn from_entries(
        entries: impl IntoIterator<Item = PaybookEntry>,
        fees_earned: BigInt,
    ) -> Result<Self, EntityKernelError> {
        let mut output = Self {
            entries: xln_rscore_protocol::PersistentRadixMap::empty(),
            fees_earned,
        };
        for entry in entries {
            let key = paybook_key(&entry.hashlock)?;
            if output.entries.get(&key).is_some() {
                return Err(EntityKernelError::htlc("PAYBOOK_ENTRY_DUPLICATE"));
            }
            let value = canonical_paybook_entry(&entry)?;
            output.entries = output
                .entries
                .updated(key, entry, consensus_digest_bytes(&value)?)
                .map_err(paybook_error)?;
        }
        Ok(output)
    }
}

pub(crate) fn paybook_entry<'a>(
    state: &'a EntityStateSlice,
    hashlock: &str,
) -> Result<Option<&'a PaybookEntry>, EntityKernelError> {
    state.paybook.entry(hashlock)
}

pub(crate) fn remove_paybook_entry(
    state: &mut EntityStateSlice,
    hashlock: &str,
) -> Result<Option<PaybookEntry>, EntityKernelError> {
    let key = paybook_key(hashlock)?;
    let entry = state.paybook.entries.get(&key).cloned();
    if entry.is_some() {
        state.paybook.entries = state.paybook.entries.removed(&key).map_err(paybook_error)?;
    }
    Ok(entry)
}

fn paybook_error(error: impl std::fmt::Display) -> EntityKernelError {
    EntityKernelError::CommitmentEncoding {
        detail: error.to_string(),
    }
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

#[expect(
    clippy::too_many_arguments,
    reason = "the paybook transition keeps the Account commit and every output sink explicit"
)]
fn apply_final_prepared(
    state: &mut EntityStateSlice,
    paybook: &mut PaybookChanges,
    commit: &OrderedAccountCommit,
    tx: &HtlcLockTx,
    secret: &str,
    description: Option<&String>,
    started_at_ms: Option<u64>,
    effects: &mut PaybookEffects<'_>,
) -> Result<(), EntityKernelError> {
    let existing = paybook.entry(state, tx.hashlock.as_str())?.cloned();
    if let Some(mut entry) = existing {
        entry.inbound_entity = Some(commit.account_id.clone());
        paybook.put(entry)?;
    } else {
        paybook.put(PaybookEntry {
            hashlock: tx.hashlock.as_str().to_string(),
            description: description.cloned().filter(|value| !value.is_empty()),
            token_id: Some(tx.token_id.get()),
            amount: Some(tx.amount.clone()),
            started_at_ms,
            originated: false,
            inbound_entity: Some(commit.account_id.clone()),
            outbound_entity: None,
            inbound_settled: false,
            outbound_settled: false,
            secret: None,
            secret_ack_pending: false,
            secret_ack_started_at: None,
            secret_ack_deadline_at: None,
            pending_fee: None,
            created_timestamp: state.timestamp,
        })?;
    }
    queue_secret(effects, &commit.account_id, &tx.lock_id, secret);
    Ok(())
}

#[expect(
    clippy::too_many_arguments,
    reason = "the paybook transition keeps the Account commit and every output sink explicit"
)]
fn apply_forward_prepared(
    state: &mut EntityStateSlice,
    paybook: &mut PaybookChanges,
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
    let lock_id = tx.hashlock.as_str().to_string();
    paybook.put(PaybookEntry {
        hashlock: tx.hashlock.as_str().to_string(),
        description: None,
        token_id: Some(tx.token_id.get()),
        amount: Some(tx.amount.clone()),
        started_at_ms: None,
        originated: false,
        inbound_entity: Some(commit.account_id.clone()),
        outbound_entity: Some(next_hop.to_string()),
        inbound_settled: false,
        outbound_settled: false,
        secret: None,
        secret_ack_pending: false,
        secret_ack_started_at: None,
        secret_ack_deadline_at: None,
        pending_fee: Some(&tx.amount - forward_amount),
        created_timestamp: state.timestamp,
    })?;
    effects
        .outputs
        .push(EntityKernelOutput::HtlcForwardAccepted {
            entity_id: state.entity_id.clone(),
            hashlock: tx.hashlock.as_str().to_string(),
        });
    effects.account_txs.push((
        next_hop.to_string(),
        AccountTx::HtlcLock(HtlcLockTx {
            lock_id,
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
    paybook: &mut PaybookChanges,
    commit: &OrderedAccountCommit,
    tx: &HtlcLockTx,
    context: &DeterministicContext,
    consumed: &mut BTreeSet<(String, String)>,
    effects: &mut PaybookEffects<'_>,
) -> Result<(), EntityKernelError> {
    if !commit.committed_via_new_frame || tx.envelope.is_none() {
        return Ok(());
    }
    if tx.lock_id != tx.hashlock.as_str() {
        return Err(EntityKernelError::htlc(
            "PAYBOOK_LOCK_ID_MUST_EQUAL_HASHLOCK",
        ));
    }
    let key = prepared_key(commit, &tx.lock_id);
    if !consumed.insert(key.clone()) {
        return Err(EntityKernelError::PreparedHtlcMismatch {
            detail: format!("REUSED:{key:?}"),
        });
    }
    let prepared = validate_binding(commit, tx, &state.entity_id, context)?;
    let closes_self_cycle = matches!(prepared.outcome, HtlcPreparedOutcome::Final { .. })
        && paybook
            .entry(state, tx.hashlock.as_str())?
            .is_some_and(|route| route.originated && route.inbound_entity.is_none());
    if paybook.entry(state, tx.hashlock.as_str())?.is_some() && !closes_self_cycle {
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
            description,
            started_at_ms,
        } => apply_final_prepared(
            state,
            paybook,
            commit,
            tx,
            secret,
            description.as_ref(),
            *started_at_ms,
            effects,
        ),
        HtlcPreparedOutcome::Forward {
            next_hop_entity_id,
            forward_amount,
            inner_envelope,
        } => apply_forward_prepared(
            state,
            paybook,
            commit,
            tx,
            next_hop_entity_id,
            forward_amount,
            inner_envelope,
            effects,
        ),
    }
}

pub(crate) fn terminate_route(
    state: &mut EntityStateSlice,
    hashlock: &str,
) -> Result<Option<PaybookEntry>, EntityKernelError> {
    remove_paybook_entry(state, hashlock)
}

pub(crate) fn terminate_route_in_frame(
    state: &mut EntityStateSlice,
    paybook: &mut PaybookChanges,
    hashlock: &str,
) -> Result<Option<PaybookEntry>, EntityKernelError> {
    paybook.remove(state, hashlock)
}

pub(crate) fn committed_htlc_resolve(
    state: &mut EntityStateSlice,
    paybook: &mut PaybookChanges,
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
    if lock_id != hashlock {
        return Err(EntityKernelError::htlc("PAYBOOK_RESOLVE_ID_MISMATCH"));
    }
    let entity_id = state.entity_id.clone();
    let timestamp = state.timestamp;
    let Some(mut route) = paybook.entry(state, hashlock)?.cloned() else {
        return Ok(());
    };
    let resolves_inbound = route.inbound_entity.as_deref() == Some(account_id);
    let resolves_originated_outbound = route.outbound_entity.as_deref() == Some(account_id)
        && (route.originated || route.inbound_entity.is_none());
    let resolves_forwarded_outbound = route.outbound_entity.as_deref() == Some(account_id)
        && route.inbound_entity.is_some()
        && route.outbound_entity.is_some()
        && !route.originated;
    if !resolves_inbound && !resolves_originated_outbound && !resolves_forwarded_outbound {
        return Ok(());
    }
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
                description: route.description.clone(),
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
                description: route.description.clone(),
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
                return paybook.put(route);
            }
        }
        terminate_route_in_frame(state, paybook, hashlock)?;
    }
    Ok(())
}

pub(crate) fn revealed_secret_followup(
    state: &mut EntityStateSlice,
    paybook: &mut PaybookChanges,
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
    let Some(mut route) = paybook.entry(state, hashlock)?.cloned() else {
        return Ok(());
    };
    if route.secret.is_some() {
        return Ok(());
    }
    route.secret = Some(secret.clone());
    if route
        .pending_fee
        .as_ref()
        .is_some_and(|fee| fee != &BigInt::from(0))
    {
        let fee = route
            .pending_fee
            .take()
            .ok_or_else(|| EntityKernelError::htlc("HTLC_PENDING_FEE_MISSING"))?;
        state.paybook.fees_earned += fee;
    }
    if let Some(account) = route.inbound_entity.clone() {
        queue_secret(effects, &account, hashlock, secret);
        route.secret_ack_pending = true;
        route.secret_ack_started_at = Some(timestamp);
        let deadline = timestamp
            .checked_add(SECRET_ACK_TIMEOUT_MS)
            .ok_or_else(|| EntityKernelError::htlc("HTLC_SECRET_ACK_DEADLINE_OVERFLOW"))?;
        // The deadline lives on the entry; the wake derives from it.
        route.secret_ack_deadline_at = Some(deadline);
        return paybook.put(route);
    }
    effects.outputs.push(EntityKernelOutput::HtlcFinalized {
        entity_id: entity_id.clone(),
        from_entity: entity_id,
        to_entity: route.outbound_entity.clone(),
        hashlock: hashlock.clone(),
        secret: secret.clone(),
        lock_id: Some(hashlock.clone()),
        token_id: route.token_id,
        amount: route.amount.clone(),
        description: route.description.clone(),
        started_at_ms: route.started_at_ms,
        jurisdiction_id: jurisdiction_id.map(str::to_string),
        finalized_at_ms: timestamp,
    });
    terminate_route_in_frame(state, paybook, hashlock)?;
    Ok(())
}

/// Consume a secret that arrived only as authenticated rejected-frame
/// evidence. The Account frame itself is deliberately not committed, but the
/// receiver must retain the verified secret before building its dispute proof
/// and must propagate it to an upstream payer exactly as TypeScript does.
pub(crate) fn dispute_evidence_secret(
    state: &mut EntityStateSlice,
    paybook: &mut PaybookChanges,
    account_id: &str,
    account_view: &crate::LocalAccountFinancialView,
    lock: &xln_rscore_engine::HtlcLock,
    secret: &str,
    effects: &mut PaybookEffects<'_>,
) -> Result<(), EntityKernelError> {
    if lock.lock_id() != lock.hashlock().as_str() {
        return Err(EntityKernelError::htlc(
            "PAYBOOK_LOCK_ID_MUST_EQUAL_HASHLOCK",
        ));
    }
    let hashlock = lock.hashlock().as_str();
    let existing = paybook.entry(state, hashlock)?.cloned();
    let mut route = existing.unwrap_or(PaybookEntry {
        hashlock: hashlock.to_string(),
        description: None,
        token_id: Some(lock.token_id().get()),
        amount: Some(lock.amount().clone()),
        started_at_ms: None,
        originated: false,
        inbound_entity: None,
        outbound_entity: None,
        inbound_settled: false,
        outbound_settled: false,
        secret: None,
        secret_ack_pending: false,
        secret_ack_started_at: None,
        secret_ack_deadline_at: None,
        pending_fee: None,
        created_timestamp: state.timestamp,
    });
    if route.secret.as_ref().is_some_and(|known| known != secret) {
        return Err(EntityKernelError::htlc("PAYBOOK_SECRET_CONFLICT"));
    }
    let token_id = lock.token_id().get();
    if route.token_id.is_some_and(|known| known != token_id) {
        return Err(EntityKernelError::htlc("PAYBOOK_TOKEN_CONFLICT"));
    }
    if route
        .amount
        .as_ref()
        .is_some_and(|known| known != lock.amount())
    {
        return Err(EntityKernelError::htlc("PAYBOOK_AMOUNT_CONFLICT"));
    }
    let local_sent_lock = lock.sender() == account_view.owner_side;
    let endpoint = if local_sent_lock {
        &mut route.outbound_entity
    } else {
        &mut route.inbound_entity
    };
    if endpoint
        .as_ref()
        .is_some_and(|known| !known.eq_ignore_ascii_case(account_id))
    {
        return Err(EntityKernelError::htlc("PAYBOOK_ENTITY_CONFLICT"));
    }
    *endpoint = Some(account_id.to_string());
    route.secret = Some(secret.to_string());
    if local_sent_lock && let Some(inbound) = route.inbound_entity.clone() {
        queue_secret(effects, &inbound, hashlock, secret);
        route.secret_ack_pending = true;
        route.secret_ack_started_at = Some(state.timestamp);
        let deadline = state
            .timestamp
            .checked_add(SECRET_ACK_TIMEOUT_MS)
            .ok_or_else(|| EntityKernelError::htlc("HTLC_SECRET_ACK_DEADLINE_OVERFLOW"))?;
        route.secret_ack_deadline_at = Some(deadline);
    }
    paybook.put(route)
}

pub(crate) fn timed_out_followup(
    state: &mut EntityStateSlice,
    paybook: &mut PaybookChanges,
    output: &AccountOutput,
    effects: &mut PaybookEffects<'_>,
) -> Result<(), EntityKernelError> {
    let AccountOutput::HtlcError { hashlock, .. } = output else {
        return Err(EntityKernelError::output("HTLC_ERROR_OUTPUT_KIND"));
    };
    let Some(route) = terminate_route_in_frame(state, paybook, hashlock)? else {
        return Ok(());
    };
    if let Some(account) = &route.inbound_entity {
        queue_error(effects, account, hashlock, "downstream_error".to_string());
    } else {
        effects.outputs.push(EntityKernelOutput::HtlcFailed {
            entity_id: state.entity_id.clone(),
            hashlock: hashlock.clone(),
            lock_id: Some(hashlock.clone()),
            reason: "timeout".to_string(),
            description: route.description,
        });
    }
    Ok(())
}

#[cfg(test)]
mod key_tests {
    use std::collections::{BTreeMap, BTreeSet};

    use num_bigint::BigInt;
    use sha3::{Digest as _, Keccak256};
    use xln_rscore_batch::ResidentAccountFinancialView;
    use xln_rscore_engine::{HtlcHashlock, HtlcLock, Side, TokenId};

    use super::{PaybookChanges, PaybookEffects, dispute_evidence_secret, paybook_key};
    use crate::{
        CrontabState, EntityKernelOutput, EntityStateSlice, LocalAccountFinancialView,
        PaybookEntry, PaybookState,
    };

    fn evidence() -> (String, String) {
        let secret_bytes = [0x61_u8; 32];
        (
            format!(
                "0x{}",
                hex::encode(<[u8; 32]>::from(Keccak256::digest(secret_bytes)))
            ),
            format!("0x{}", hex::encode(secret_bytes)),
        )
    }

    fn lock(hashlock: &str, sender: Side) -> HtlcLock {
        HtlcLock::restore(
            hashlock.to_string(),
            HtlcHashlock::parse(hashlock).expect("hashlock"),
            BigInt::from(1_700_000_100_000_u64),
            100,
            BigInt::from(50),
            TokenId::new(1).expect("token"),
            sender,
            1,
            1_700_000_000_000,
            None,
        )
        .expect("lock")
    }

    fn view(owner_side: Side, lock: HtlcLock) -> LocalAccountFinancialView {
        ResidentAccountFinancialView {
            active: true,
            owner_side,
            owner_in_capacity: BTreeMap::new(),
            owner_out_capacity: BTreeMap::new(),
            owner_own_credit_limit: BTreeMap::new(),
            owner_peer_credit_limit: BTreeMap::new(),
            settlement_workspace: None,
            settlement_transition_pending: false,
            settlement_execution: Err("not requested".into()),
            rebalance_active_quote: None,
            htlc_locks: BTreeMap::from([(lock.lock_id().to_string(), lock)]),
            pulls: BTreeMap::new(),
            swap_offers: BTreeMap::new(),
            pending_cross_pull_close_ids: BTreeSet::new(),
            pending_cross_swap_ack_ids: BTreeSet::new(),
            dispute: None,
        }
        .into()
    }

    fn route(hashlock: &str, inbound: Option<&str>) -> PaybookEntry {
        PaybookEntry {
            hashlock: hashlock.to_string(),
            description: None,
            token_id: Some(1),
            amount: Some(BigInt::from(50)),
            started_at_ms: None,
            originated: false,
            inbound_entity: inbound.map(str::to_string),
            outbound_entity: None,
            inbound_settled: false,
            outbound_settled: false,
            secret: None,
            secret_ack_pending: false,
            secret_ack_started_at: None,
            secret_ack_deadline_at: None,
            pending_fee: None,
            created_timestamp: 1_700_000_000_000,
        }
    }

    #[test]
    fn canonical_hashlocks_select_independent_physical_slots() {
        let zero = paybook_key(&format!("0x{}", "00".repeat(32))).expect("zero hashlock");
        let middle = paybook_key(&format!("0x{}", "7f".repeat(32))).expect("middle hashlock");
        let high = paybook_key(&format!("0x{}", "ff".repeat(32))).expect("high hashlock");

        assert_eq!(zero.len(), 32);
        assert_eq!([zero[0], middle[0], high[0]], [0x00, 0x7f, 0xff]);
        assert!(paybook_key(&format!("0X{}", "ff".repeat(32))).is_err());
        assert!(paybook_key(&format!("0x{}", "FF".repeat(32))).is_err());
    }

    #[test]
    fn downstream_unsafe_secret_queues_upstream_resolve_and_ack_timeout() {
        let (hashlock, secret) = evidence();
        let mut state = EntityStateSlice::empty("local", 1_700_000_000_000);
        state.crontab = Some(CrontabState::default());
        state.paybook =
            PaybookState::from_entries([route(&hashlock, Some("upstream"))], BigInt::from(0))
                .expect("paybook");
        let lock = lock(&hashlock, Side::Left);
        let view = view(Side::Left, lock.clone());
        let mut changes = PaybookChanges::default();
        let mut account_txs = Vec::new();
        let mut outputs = Vec::<EntityKernelOutput>::new();
        dispute_evidence_secret(
            &mut state,
            &mut changes,
            "downstream",
            &view,
            &lock,
            &secret,
            &mut PaybookEffects {
                account_txs: &mut account_txs,
                outputs: &mut outputs,
            },
        )
        .expect("downstream evidence");

        assert!(matches!(
            account_txs.as_slice(),
            [(account, xln_rscore_engine::AccountTx::HtlcResolve(resolve))]
                if account == "upstream"
                    && resolve.lock_id == hashlock
                    && matches!(&resolve.outcome, xln_rscore_engine::HtlcResolveOutcome::Secret { secret: value } if value == &secret)
        ));
        let route = changes
            .entry(&state, &hashlock)
            .expect("route lookup")
            .expect("route");
        assert!(route.secret_ack_pending);
        assert_eq!(route.outbound_entity.as_deref(), Some("downstream"));
        // No hook: the ack deadline is derived from the entry itself.
        assert!(state.crontab.as_ref().expect("crontab").hooks.is_empty());
        let deadline = route.secret_ack_deadline_at.expect("ack deadline");
        assert_eq!(
            changes
                .due_secret_acks(&state, deadline - 1)
                .expect("not yet due"),
            Vec::new()
        );
        assert_eq!(
            changes.due_secret_acks(&state, deadline).expect("due"),
            vec![(hashlock.clone(), "upstream".to_string())]
        );
    }

    #[test]
    fn upstream_unsafe_secret_only_persists_without_resolve_or_timeout() {
        let (hashlock, secret) = evidence();
        let mut state = EntityStateSlice::empty("local", 1_700_000_000_000);
        state.crontab = None;
        let lock = lock(&hashlock, Side::Right);
        let view = view(Side::Left, lock.clone());
        let mut changes = PaybookChanges::default();
        let mut account_txs = Vec::new();
        let mut outputs = Vec::<EntityKernelOutput>::new();
        dispute_evidence_secret(
            &mut state,
            &mut changes,
            "upstream",
            &view,
            &lock,
            &secret,
            &mut PaybookEffects {
                account_txs: &mut account_txs,
                outputs: &mut outputs,
            },
        )
        .expect("upstream evidence");

        assert!(account_txs.is_empty());
        let route = changes
            .entry(&state, &hashlock)
            .expect("route lookup")
            .expect("route");
        assert_eq!(route.secret.as_deref(), Some(secret.as_str()));
        assert_eq!(route.inbound_entity.as_deref(), Some("upstream"));
        assert!(!route.secret_ack_pending);
    }
}

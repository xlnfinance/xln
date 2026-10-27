//! Incoming HTLC deadline admission.
//!
//! Parity target: `core/account/consensus/dispute/deadline-policy.ts`.
//! The signed frame clock is consensus data, but it is not the receiver's
//! enforcement clock. This scan is speculative and cannot mutate the live
//! Account: a frame rejected here must leave the replica byte-identical.

use std::collections::BTreeMap;

use crate::tx::handlers::rebalance::policy::{RebalancePolicyTx, announced_policy};
use crate::{RebalanceFeePolicySnapshot, TokenId};
use num_bigint::BigInt;

use crate::{
    AccountFrame, AccountState, AccountTx, HtlcHashlock, HtlcResolveOutcome, ReceiverClock, Side,
};

/// `ACCOUNT_NETWORK_ALLOWANCE_MS` in TypeScript.
pub const HTLC_ENFORCEMENT_RESERVE_MS: u64 = 30_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HtlcEvidenceSecret {
    pub hashlock: String,
    pub secret: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IncomingDeadlineViolation {
    Reject {
        reason: String,
    },
    Dispute {
        reason: String,
        evidence_secrets: Vec<HtlcEvidenceSecret>,
    },
}

#[derive(Clone)]
struct DeadlineLock {
    hashlock: HtlcHashlock,
    timelock: BigInt,
    reveal_before_height: u64,
    sender: Side,
}

fn deadline_expired(timestamp: u64, j_height: u64, lock: &DeadlineLock) -> bool {
    j_height > lock.reveal_before_height || BigInt::from(timestamp) >= lock.timelock
}

fn reject(reason: String) -> IncomingDeadlineViolation {
    IncomingDeadlineViolation::Reject { reason }
}

fn valid_secret(lock: &DeadlineLock, secret: &str) -> bool {
    crate::tx::handlers::htlc::hash_secret(secret).is_ok_and(|actual| actual == lock.hashlock)
}

fn inspect_policy_notice(
    policies: &mut BTreeMap<u32, RebalanceFeePolicySnapshot>,
    state: &AccountState,
    frame: &AccountFrame,
    proposer: Side,
    clock: ReceiverClock,
    tx: &AccountTx,
) -> Option<IncomingDeadlineViolation> {
    let AccountTx::RebalancePolicy {
        token_id,
        policy_version,
        base_fee,
        liquidity_fee_bps,
        gas_fee,
        notice_period_seconds,
    } = tx
    else {
        return None;
    };
    let token = TokenId::new(*token_id).ok()?;
    let current = policies.get(token_id).or_else(|| {
        state
            .rebalance_policy(token)
            .and_then(|entry| entry.side(proposer))
    });
    if current.is_some_and(|old| {
        *policy_version <= old.policy_version() || frame.timestamp < old.updated_at()
    }) {
        return None;
    }
    let next = announced_policy(
        current,
        &RebalancePolicyTx {
            token_id: *token_id,
            policy_version: *policy_version,
            base_fee,
            liquidity_fee_bps,
            gas_fee,
            notice_period_seconds: *notice_period_seconds,
        },
        frame.timestamp,
    )?;
    // The peer's signed clock cannot spend notice during an idle interval.
    // Only this frame's ordered policy prefix is held speculatively here.
    if let Some(active) = next.previous() {
        let earliest = clock
            .entity_timestamp
            .checked_add(active.notice_period_seconds() * 1000);
        if earliest.is_none_or(|earliest| next.effective_at() < earliest) {
            return Some(reject(format!(
                "REBALANCE_POLICY_NOTICE_TOO_SHORT: token={token_id} version={policy_version}"
            )));
        }
    }
    policies.insert(*token_id, next);
    None
}

/// Return the first canonical deadline violation in transaction order.
pub fn incoming_deadline_violation(
    state: &AccountState,
    frame: &AccountFrame,
    proposer: Side,
    clock: ReceiverClock,
) -> Option<IncomingDeadlineViolation> {
    // New frames cannot spend either side's notice using a signed future clock,
    // even without a policy tx. A replacement could otherwise erase the old
    // terms as an "improvement" before the receiver reaches activation.
    // Certified duplicates are handled before this guard, as in TypeScript.
    for policy in state.rebalance_policies() {
        for side in [Side::Left, Side::Right] {
            if let Some(pending) = policy.side(side)
                && pending.previous().is_some()
                && clock.entity_timestamp < pending.effective_at()
                && pending.effective_at() <= frame.timestamp
            {
                let side = if side == Side::Left { "left" } else { "right" };
                return Some(reject(format!(
                    "REBALANCE_POLICY_ACTIVATION_BEFORE_RECEIVER: side={side} version={}",
                    pending.policy_version()
                )));
            }
        }
    }
    let mut policies = BTreeMap::new();
    let mut locks: BTreeMap<String, DeadlineLock> = state
        .htlc_locks()
        .map(|lock| {
            (
                lock.lock_id().to_owned(),
                DeadlineLock {
                    hashlock: lock.hashlock().clone(),
                    timelock: lock.timelock().clone(),
                    reveal_before_height: lock.reveal_before_height(),
                    sender: lock.sender(),
                },
            )
        })
        .collect();

    for tx in &frame.txs {
        if let Some(violation) =
            inspect_policy_notice(&mut policies, state, frame, proposer, clock, tx)
        {
            return Some(violation);
        }
        match tx {
            AccountTx::HtlcLock(tx) => {
                if locks.contains_key(&tx.lock_id) {
                    continue;
                }
                let local_timestamp_unsafe = tx.timelock
                    <= BigInt::from(
                        clock
                            .entity_timestamp
                            .saturating_add(HTLC_ENFORCEMENT_RESERVE_MS),
                    );
                let local_height_unsafe = tx.reveal_before_height <= clock.finalized_j_height;
                let frame_timestamp_unsafe = BigInt::from(frame.timestamp) >= tx.timelock;
                let frame_height_unsafe = tx.reveal_before_height <= frame.j_height;
                if local_timestamp_unsafe
                    || local_height_unsafe
                    || frame_timestamp_unsafe
                    || frame_height_unsafe
                {
                    return Some(reject(format!(
                        "HTLC_LOCK_ENFORCEMENT_WINDOW_TOO_SHORT: lock={} localTimestamp={} localJHeight={} frameTimestamp={} frameJHeight={}",
                        tx.lock_id,
                        clock.entity_timestamp,
                        clock.finalized_j_height,
                        frame.timestamp,
                        frame.j_height,
                    )));
                }
                locks.insert(
                    tx.lock_id.clone(),
                    DeadlineLock {
                        hashlock: tx.hashlock.clone(),
                        timelock: tx.timelock.clone(),
                        reveal_before_height: tx.reveal_before_height,
                        sender: proposer,
                    },
                );
            }
            AccountTx::HtlcResolve(tx) => {
                let Some(lock) = locks.get(&tx.lock_id).cloned() else {
                    continue;
                };
                match &tx.outcome {
                    HtlcResolveOutcome::Secret { secret } => {
                        if !valid_secret(&lock, secret) {
                            continue;
                        }
                        if deadline_expired(
                            clock
                                .entity_timestamp
                                .saturating_add(HTLC_ENFORCEMENT_RESERVE_MS),
                            clock.finalized_j_height,
                            &lock,
                        ) {
                            return Some(IncomingDeadlineViolation::Dispute {
                                reason: format!(
                                    "HTLC_SECRET_ENFORCEMENT_WINDOW_TOO_SHORT: lock={} reserve={}ms localTimestamp={}",
                                    tx.lock_id, HTLC_ENFORCEMENT_RESERVE_MS, clock.entity_timestamp,
                                ),
                                evidence_secrets: vec![HtlcEvidenceSecret {
                                    hashlock: lock.hashlock.as_str().to_owned(),
                                    secret: secret.clone(),
                                }],
                            });
                        }
                        if deadline_expired(frame.timestamp, frame.j_height, &lock) {
                            return Some(reject(format!(
                                "HTLC_SECRET_FRAME_CLOCK_EXPIRED: lock={} frameTimestamp={} frameJHeight={}",
                                tx.lock_id, frame.timestamp, frame.j_height,
                            )));
                        }
                        locks.remove(&tx.lock_id);
                    }
                    HtlcResolveOutcome::Error { reason } => {
                        let proposer_is_payer = proposer == lock.sender;
                        let locally_expired = deadline_expired(
                            clock.entity_timestamp,
                            clock.finalized_j_height,
                            &lock,
                        );
                        if proposer_is_payer && !locally_expired {
                            return Some(reject(format!(
                                "HTLC_PAYER_CANCEL_BEFORE_LOCAL_EXPIRY: lock={} localTimestamp={} localJHeight={}",
                                tx.lock_id, clock.entity_timestamp, clock.finalized_j_height,
                            )));
                        }
                        let frame_expired =
                            deadline_expired(frame.timestamp, frame.j_height, &lock);
                        if (proposer_is_payer || reason.as_deref() == Some("timeout"))
                            && !frame_expired
                        {
                            return Some(reject(format!(
                                "HTLC_TIMEOUT_FRAME_CLOCK_NOT_EXPIRED: lock={} frameTimestamp={} frameJHeight={}",
                                tx.lock_id, frame.timestamp, frame.j_height,
                            )));
                        }
                        let beneficiary_release =
                            !proposer_is_payer && reason.as_deref() != Some("timeout");
                        if locally_expired || beneficiary_release {
                            locks.remove(&tx.lock_id);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    None
}

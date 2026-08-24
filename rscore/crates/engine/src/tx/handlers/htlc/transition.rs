use num_bigint::BigInt;
use sha3::{Digest as _, Keccak256};

use crate::state::delta::max_payment_amount;
use crate::tx::apply_types::MutationDecision;
use crate::{
    AccountExecutionContext, AccountOutput, AccountRejection, AccountReplica, HtlcHashlock,
    HtlcLock, HtlcLockTx, HtlcRejection, HtlcResolveOutcome, HtlcResolveTx, Side, TransitionError,
    ValidationRejection,
};

const MAX_ACCOUNT_HTLC_LOCKS: usize = 32;

pub(crate) fn apply_lock(
    replica: &mut AccountReplica,
    proposer: Side,
    tx: &HtlcLockTx,
    context: &AccountExecutionContext,
) -> Result<MutationDecision, TransitionError> {
    super::boundary::validate_reveal_before_height(tx.reveal_before_height)?;
    if replica.state().htlc_lock(&tx.lock_id).is_some() {
        return Ok(rejected(HtlcRejection::LockExists {
            lock_id: tx.lock_id.clone(),
        }));
    }
    if BigInt::from(context.enforcement_timestamp) >= tx.timelock.clone() {
        return Ok(rejected(HtlcRejection::TimelockExpired {
            timelock: tx.timelock.clone(),
        }));
    }
    if tx.reveal_before_height <= context.enforcement_j_height {
        return Ok(rejected(HtlcRejection::RevealHeightPassed {
            reveal_before_height: tx.reveal_before_height,
            current_j_height: context.enforcement_j_height,
        }));
    }
    let minimum = BigInt::from(1);
    let maximum = max_payment_amount();
    if tx.amount < minimum || tx.amount > maximum {
        return Ok(rejected(HtlcRejection::Amount {
            amount: tx.amount.clone(),
            minimum,
            maximum,
        }));
    }
    if replica.state().htlc_count() >= MAX_ACCOUNT_HTLC_LOCKS {
        return Ok(MutationDecision::rejected(
            AccountRejection::HtlcLockCapacity {
                maximum: MAX_ACCOUNT_HTLC_LOCKS,
            },
        ));
    }

    let mut delta = replica.state().delta_or_zero(tx.token_id)?;
    let available = delta.perspective(proposer).out_capacity;
    if tx.amount > available {
        return Ok(rejected(HtlcRejection::InsufficientCapacity {
            required: tx.amount.clone(),
            available,
        }));
    }

    let lock = HtlcLock::new(
        tx.lock_id.clone(),
        tx.hashlock.clone(),
        tx.timelock.clone(),
        tx.reveal_before_height,
        tx.amount.clone(),
        tx.token_id,
        proposer,
        context.current_account_height,
        context.committed_timestamp,
        tx.envelope
            .as_ref()
            .map(|envelope| envelope.integrity_hash()),
    );
    delta.add_hold(proposer, &tx.amount)?;
    replica.state_mut().put_delta(delta)?;
    replica.state_mut().put_htlc_lock(lock)?;

    Ok(MutationDecision::applied(vec![format!(
        "🔒 HTLC locked: {} token {}, expires block {}, hash {}...",
        tx.amount,
        tx.token_id,
        tx.reveal_before_height,
        &tx.hashlock.as_str()[..16],
    )]))
}

pub(crate) fn apply_resolve(
    replica: &mut AccountReplica,
    proposer: Side,
    tx: &HtlcResolveTx,
    context: &AccountExecutionContext,
) -> Result<MutationDecision, TransitionError> {
    let Some(lock) = replica.state().htlc_lock(&tx.lock_id).cloned() else {
        return Ok(rejected(HtlcRejection::LockNotFound {
            lock_id: tx.lock_id.clone(),
        }));
    };
    let Some(mut delta) = replica.state().delta(lock.token_id()).cloned() else {
        return Ok(rejected(HtlcRejection::DeltaNotFound {
            token_id: lock.token_id(),
        }));
    };

    match &tx.outcome {
        HtlcResolveOutcome::Secret { secret } => {
            if let Err(reason) = validate_secret(&lock, secret, context) {
                return Ok(rejected(reason));
            }
        }
        HtlcResolveOutcome::Error { reason } => {
            if let Some(rejection) = error_rejection(&lock, proposer, reason.as_deref(), context) {
                return Ok(rejected(rejection));
            }
        }
    }

    let hold = delta.hold(lock.sender()).clone();
    if hold < *lock.amount() {
        return Ok(rejected(HtlcRejection::HoldUnderflow {
            side: lock.sender(),
            hold,
            amount: lock.amount().clone(),
        }));
    }
    delta.release_hold(lock.sender(), lock.amount())?;

    let (events, output) = match &tx.outcome {
        HtlcResolveOutcome::Secret { secret } => {
            delta.apply_transfer(lock.sender(), lock.amount())?;
            (
                vec![format!(
                    "🔓 HTLC resolved (secret): {} token {}",
                    lock.amount(),
                    lock.token_id(),
                )],
                AccountOutput::HtlcSecret {
                    lock_id: lock.lock_id().into(),
                    hashlock: lock.hashlock().as_str().into(),
                    secret: secret.clone(),
                    token_id: lock.token_id(),
                    amount: lock.amount().clone(),
                },
            )
        }
        HtlcResolveOutcome::Error { reason } => {
            let display_reason = reason
                .as_deref()
                .filter(|value| !value.is_empty())
                .unwrap_or("unknown");
            (
                vec![format!(
                    "❌ HTLC resolved (error): {} token {} returned — {display_reason}",
                    lock.amount(),
                    lock.token_id(),
                )],
                AccountOutput::HtlcError {
                    lock_id: lock.lock_id().into(),
                    hashlock: lock.hashlock().as_str().into(),
                    token_id: lock.token_id(),
                    amount: lock.amount().clone(),
                    reason: reason.clone(),
                },
            )
        }
    };

    replica.state_mut().put_delta(delta)?;
    replica.state_mut().remove_htlc_lock(lock.lock_id())?;
    Ok(MutationDecision::with_outputs(events, vec![output]))
}

fn validate_secret(
    lock: &HtlcLock,
    secret: &str,
    context: &AccountExecutionContext,
) -> Result<(), HtlcRejection> {
    if deadline_expired(lock, context) {
        return Err(HtlcRejection::DeadlineExpired {
            timestamp: context.enforcement_timestamp,
            timelock: lock.timelock().clone(),
            j_height: context.enforcement_j_height,
            reveal_before_height: lock.reveal_before_height(),
        });
    }
    let actual = match hash_secret(secret) {
        Ok(hashlock) => hashlock,
        Err(message) => {
            return Err(HtlcRejection::InvalidSecret { message });
        }
    };
    if &actual != lock.hashlock() {
        return Err(HtlcRejection::HashMismatch {
            expected: lock.hashlock().clone(),
            actual,
        });
    }
    Ok(())
}

fn error_rejection(
    lock: &HtlcLock,
    proposer: Side,
    reason: Option<&str>,
    context: &AccountExecutionContext,
) -> Option<HtlcRejection> {
    let expired = deadline_expired(lock, context);
    let beneficiary = proposer != lock.sender();
    let payer = proposer == lock.sender();
    if !(beneficiary || payer && expired) {
        return Some(HtlcRejection::ActivePayerCancellation);
    }
    if reason == Some("timeout") && !expired {
        return Some(HtlcRejection::TimeoutBeforeExpiry);
    }
    None
}

fn deadline_expired(lock: &HtlcLock, context: &AccountExecutionContext) -> bool {
    context.enforcement_j_height > lock.reveal_before_height()
        || BigInt::from(context.enforcement_timestamp) >= lock.timelock().clone()
}

fn hash_secret(secret: &str) -> Result<HtlcHashlock, String> {
    let Some(hex) = secret.strip_prefix("0x") else {
        return Err(secret_shape_error(secret));
    };
    if hex.len() != 64 || !hex.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Err(secret_shape_error(secret));
    }
    let mut bytes = [0_u8; 32];
    for (index, pair) in hex.as_bytes().chunks_exact(2).enumerate() {
        let text = std::str::from_utf8(pair).map_err(|_| secret_shape_error(secret))?;
        bytes[index] = u8::from_str_radix(text, 16).map_err(|_| secret_shape_error(secret))?;
    }
    Ok(HtlcHashlock::from_bytes(Keccak256::digest(bytes).into()))
}

fn secret_shape_error(secret: &str) -> String {
    format!(
        "HTLC secret must be 32-byte hex (got {} chars)",
        secret.encode_utf16().count(),
    )
}

fn rejected(reason: HtlcRejection) -> MutationDecision {
    MutationDecision::rejected(AccountRejection::Validation(ValidationRejection::Htlc(
        reason,
    )))
}

//! The account mempool: local intentions waiting for a frame.
//!
//! Parity target: core/account/input/mempool.ts. The limit counts what is
//! already proposed as well, so a peer that never acks cannot be used to grow
//! the queue past the bound.

use crate::AccountTx;
use crate::error::StateError;

/// `LIMITS.ACCOUNT_MEMPOOL_SIZE` in core/config/constants.ts.
pub const ACCOUNT_MEMPOOL_SIZE: usize = 10_000;

pub fn assert_mempool_within_limit(
    mempool_len: usize,
    pending_len: usize,
    context: &'static str,
) -> Result<(), StateError> {
    if mempool_len + pending_len <= ACCOUNT_MEMPOOL_SIZE {
        return Ok(());
    }
    Err(StateError::MempoolLimitExceeded {
        context,
        outstanding: mempool_len + pending_len,
        maximum: ACCOUNT_MEMPOOL_SIZE,
    })
}

pub fn assert_mempool_admission(
    mempool_len: usize,
    pending_len: usize,
    incoming: usize,
    context: &'static str,
) -> Result<(), StateError> {
    assert_mempool_within_limit(mempool_len, pending_len, context)?;
    if mempool_len + pending_len + incoming <= ACCOUNT_MEMPOOL_SIZE {
        return Ok(());
    }
    Err(StateError::MempoolLimitExceeded {
        context,
        outstanding: mempool_len + pending_len + incoming,
        maximum: ACCOUNT_MEMPOOL_SIZE,
    })
}

/// Transactions restored from a rolled-back frame go back to the front of the
/// queue. Every direct payment is its own authorized intent even when its
/// bytes match another, so payments are never deduplicated.
///
/// Parity target: `prependUniqueMempoolTxs` in core/account/consensus/helpers.ts.
pub fn is_deduplicated_on_restore(tx: &AccountTx) -> bool {
    !matches!(tx, AccountTx::DirectPayment { .. })
}

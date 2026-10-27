mod codec;
mod state;

use num_bigint::BigInt;
use xln_rscore_engine::{AccountTx, TokenId};

use crate::local_financial::LocalAccountFinancialView;
use crate::types::TargetedAccountTx;
use crate::{EntityKernelError, EntityStateSlice, OrderedAccountCommit};

pub use codec::decode_canonical_lending_state;
pub use state::{LendingState, canonical_lending_state};

/// One loan whose committed term has passed unpaid, with the hub's committed
/// credit grant on the borrower Account. The caller reads the grant where the
/// Account views live; the transition itself stays pure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OverdueLendingLoan {
    pub loan_id: String,
    pub borrower_entity_id: String,
    pub token_id: TokenId,
    pub committed_credit_limit: BigInt,
}

/// Retired scheduler commands must reject, never mutate a pool book.
pub fn settle_overdue_lending_loans(
    state: &mut EntityStateSlice,
    loans: &[OverdueLendingLoan],
    _account_txs: &mut Vec<TargetedAccountTx>,
) -> Result<(), EntityKernelError> {
    let _ = (state, loans);
    Err(EntityKernelError::RejectedEntityTx {
        kind: "lending",
        detail: "LENDING_UNSUPPORTED".into(),
    })
}

pub(crate) fn apply_committed_lending_followup(
    _state: &mut EntityStateSlice,
    _commit: &OrderedAccountCommit,
    transition: &crate::CommittedAccountTransition,
    _account_view: Option<&LocalAccountFinancialView>,
    _account_txs: &mut Vec<TargetedAccountTx>,
) -> Result<bool, EntityKernelError> {
    if !matches!(
        transition.tx,
        AccountTx::LendingFund { .. }
            | AccountTx::LendingRate { .. }
            | AccountTx::LendingBorrowRequest { .. }
            | AccountTx::LendingRepay { .. }
            | AccountTx::LendingDisburse { .. }
            | AccountTx::LendingCloseRequest { .. }
            | AccountTx::LendingClosePayout { .. }
    ) {
        return Ok(false);
    }
    // A caller supplying already-committed lending must not revive retired pools.
    Err(EntityKernelError::RejectedEntityTx {
        kind: "lending",
        detail: "LENDING_UNSUPPORTED".into(),
    })
}

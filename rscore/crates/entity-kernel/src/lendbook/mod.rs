pub(crate) mod codec;
mod committed;
mod policy;
pub(crate) mod state;
use crate::types::TargetedAccountTx;
use crate::{EntityKernelError, EntityStateSlice};
pub use codec::decode_canonical_lending_state;
pub(crate) use committed::apply_committed_lending_followup;
use num_bigint::BigInt;
pub use state::{LendingState, canonical_lending_state};
use xln_rscore_engine::TokenId;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OverdueLendingLoan {
    pub loan_id: String,
    pub borrower_entity_id: String,
    pub token_id: TokenId,
    pub committed_credit_limit: BigInt,
}
pub fn settle_overdue_lending_loans(
    state: &mut EntityStateSlice,
    loans: &[OverdueLendingLoan],
    _out: &mut Vec<TargetedAccountTx>,
) -> Result<(), EntityKernelError> {
    use self::state::*;
    let Some(book) = &mut state.lending else {
        return Ok(());
    };
    for id in loans {
        if let Some(v) = find_mut(&mut book.loans, &id.loan_id) {
            if text(v, "status")? == "active" && number(v, "dueAt")? <= state.timestamp {
                if !state.known_accounts.contains(text(v, "borrowerEntityId")?) {
                    return Err(err(format!(
                        "LENDING_OVERDUE_ACCOUNT_MISSING:{}",
                        id.loan_id
                    )));
                }
                set(v, "status", s("defaulted"));
                set(v, "updatedAt", n(state.timestamp));
            }
        }
    }
    Ok(())
}

mod projection;
pub use projection::summarize_lending_state;
pub(crate) mod servicing;
#[cfg(test)]
pub(crate) mod tests;

pub(crate) mod default_terms;

use crate::{AccountReplica, AccountTx, StateError};

// Parity: core/account/validation/dispute-gas-budget.ts. This is a deterministic
// stock-program admission charge, never an RPC estimate or durable counter.
const BUDGET: usize = 5_000_000;

pub(crate) fn charge(account: &AccountReplica) -> Result<usize, StateError> {
    projected_charge(account, 0, 0)
}

pub(crate) fn projected_charge(
    account: &AccountReplica,
    additional_tokens: usize,
    additional_conditions: usize,
) -> Result<usize, StateError> {
    let state = account.state();
    if state.carried().subcontracts_root != [0; 32] {
        return Ok(9_007_199_254_740_991);
    }
    let tokens = state.delta_count() + additional_tokens;
    let swaps = state
        .swap_offers()
        .filter(|offer| offer.cross_jurisdiction().is_none())
        .count();
    let conditions = state.htlc_count() + swaps + state.pull_count() + additional_conditions;
    let clauses = crate::dispute::build_dispute_proof_body(account, &[0; 20])?
        .transformers
        .len()
        + additional_conditions;
    Ok(3_000_000 + 200_000 * tokens + 10_000 * conditions + (50_000 + 4_000 * tokens) * clauses)
}

pub(crate) fn admission_error(before: usize, after: usize, tx: &AccountTx) -> Option<String> {
    if after <= BUDGET || matches!(tx, AccountTx::JEventClaim(_)) {
        return None;
    }
    // Same no-op exception as TS; custom-program sentinels are not estimates.
    if matches!(tx, AccountTx::AddDelta { .. }) && after == before && after < 9_007_199_254_740_991
    {
        return None;
    }
    let resolving = matches!(
        tx.wire_name(),
        "htlc_resolve"
            | "swap_resolve"
            | "swap_cancel_request"
            | "cross_pull_close"
            | "settle_transition"
            | "lending_repay"
            | "lending_close_request"
            | "lending_close_payout"
    );
    if resolving && after <= before {
        return None;
    }
    budget_error(after)
}

pub(crate) fn opening_deferred(tx: &AccountTx, message: &str) -> bool {
    let opening = tx.wire_name() == "cross_pull_lock"
        || matches!(
            tx,
            AccountTx::SwapOffer {
                cross_jurisdiction: Some(_),
                ..
            }
        );
    opening && message.starts_with("ACCOUNT_DISPUTE_GAS_BUDGET_EXCEEDED:")
}

pub(crate) fn budget_error(after: usize) -> Option<String> {
    (after > BUDGET).then(|| format!("ACCOUNT_DISPUTE_GAS_BUDGET_EXCEEDED:{after}/{BUDGET}"))
}

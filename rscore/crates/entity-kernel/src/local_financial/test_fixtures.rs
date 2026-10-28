use std::collections::BTreeMap;

use super::LocalAccountFinancialView;

pub(crate) fn account_view() -> LocalAccountFinancialView {
    LocalAccountFinancialView {
        dispute_config: xln_rscore_engine::AccountDisputeConfig::new(10, 10).unwrap(),
        active: true,
        owner_side: xln_rscore_engine::Side::Left,
        owner_out_capacity: BTreeMap::new(),
        owner_peer_credit_limit: BTreeMap::new(),
        settlement_workspace: None,
        settlement_transition_pending: false,
        settlement_execution: Err("no settlement".into()),
        rebalance_active_quote: None,
        htlc_locks: BTreeMap::new(),
        pending_htlc_lock_ids: Default::default(),
        pulls: BTreeMap::new(),
        swap_offers: BTreeMap::new(),
        pending_cross_pull_close_ids: Default::default(),
        dispute: None,
    }
}

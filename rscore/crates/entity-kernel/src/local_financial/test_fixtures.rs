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

pub(crate) fn dispute_view() -> xln_rscore_batch::ResidentAccountDisputeView {
    xln_rscore_batch::ResidentAccountDisputeView {
        status: "active".into(),
        dispute_prepare: None,
        active_dispute: None,
        local_dispute: None,
        pending_dispute: None,
        counterparty_dispute: None,
        proof_body: Err("unused".into()),
        j_nonce: 0,
        owner_is_left: true,
        delta_transformer: None,
        payment_hashlocks: Vec::new(),
        pull_ids: Vec::new(),
        pull_count: 0,
        swap_offers: Vec::new(),
        pending_swap_fill_ratios: BTreeMap::new(),
    }
}

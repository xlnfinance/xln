mod support;

use std::collections::BTreeSet;

use support::{MAKER, commit, token};
use xln_rscore_engine::AccountTx;
use xln_rscore_entity_kernel::{
    DeterministicContext, EntityKernelError, EntityStateSlice, JurisdictionScope,
    apply_entity_kernel,
};

#[test]
fn cross_j_and_unknown_transactions_fail_loudly() {
    let mut state = EntityStateSlice::empty(support::HUB, 1);
    state.known_accounts = BTreeSet::from([MAKER.to_string()]);
    let unknown = commit(
        MAKER,
        0x61,
        1,
        AccountTx::AddDelta { token_id: token(1) },
        Vec::new(),
    );
    assert_eq!(
        apply_entity_kernel(
            state.clone(),
            &[unknown],
            &DeterministicContext::hlt_default()
        ),
        Err(EntityKernelError::UnsupportedAccountTx { kind: "add_delta" })
    );

    let mut cross = commit(
        MAKER,
        0x62,
        1,
        AccountTx::AddDelta { token_id: token(1) },
        Vec::new(),
    );
    cross.scope = JurisdictionScope::Cross;
    assert_eq!(
        apply_entity_kernel(state, &[cross], &DeterministicContext::hlt_default()),
        Err(EntityKernelError::CrossJurisdictionUnsupported {
            account_id: MAKER.to_string(),
        })
    );
}

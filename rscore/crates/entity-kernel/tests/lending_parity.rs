use xln_rscore_entity_kernel::{
    CanonicalEntityTx, EntityTxKind, LocalEntityFinancialTx, LocalEntityTx, decode_local_entity_tx,
};
use xln_rscore_protocol::CanonicalValue;
fn object(entries: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
    CanonicalValue::Object(entries.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
#[test]
fn lending_entity_admission_retains_typed_unsupported_command() {
    for kind in [
        EntityTxKind::LendingOffer,
        EntityTxKind::LendingBorrow,
        EntityTxKind::LendingRepay,
        EntityTxKind::LendingClosePosition,
        EntityTxKind::LendingApprove,
        EntityTxKind::LendingSetTerms,
    ] {
        let tx =
            CanonicalEntityTx::from_frame_projection(kind, object(vec![])).expect("canonical tx");
        assert!(
            matches!(decode_local_entity_tx(&tx), Ok(Some(LocalEntityTx::Financial(
                LocalEntityFinancialTx::UnsupportedLending(retained)
            ))) if retained == tx),
            "{kind:?}"
        );
    }
}

#[test]
fn retired_pool_state_cannot_be_restored() {
    let old = object(vec![
        ("pools", CanonicalValue::Map(vec![])),
        ("loans", CanonicalValue::Map(vec![])),
    ]);
    let result = xln_rscore_entity_kernel::decode_canonical_lending_state(&old);
    assert!(
        result.is_err(),
        "retired pool schema must never reenter execution"
    );
}

use std::collections::BTreeMap;

use xln_rscore_engine::canonical_tx_digest;

use super::*;
use crate::local_financial::types::ProcessHtlcTimeoutsEntityTx;

const FIXTURE: &str = include_str!("../../../../fixtures/entity-routing-semantics/parity-v1.json");
const PEER: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";
const EXTERNAL: &str = "0x3333333333333333333333333333333333333333333333333333333333333333";

#[test]
fn process_htlc_timeouts_matches_typescript_ordered_account_outbox() {
    let fixture: serde_json::Value = serde_json::from_str(FIXTURE).expect("shared fixture");
    let expected = fixture["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|row| row["txType"].as_str() == Some("processHtlcTimeouts"))
        .expect("timeout case");
    let mut state = EntityStateSlice::empty(
        "0x1111111111111111111111111111111111111111111111111111111111111111",
        2_000,
    );
    let before = state.clone();
    let result = apply_local_entity_financial_txs(
        &mut state,
        &mut PaybookChanges::default(),
        vec![LocalEntityFinancialTx::ProcessHtlcTimeouts(
            ProcessHtlcTimeoutsEntityTx {
                expired_locks: vec![
                    (PEER.into(), format!("0x{}", "66".repeat(32))),
                    (EXTERNAL.into(), format!("0x{}", "77".repeat(32))),
                ],
            },
        )],
        &DeterministicContext::hlt_default(),
        &BTreeMap::new(),
        None,
        None,
    )
    .expect("production timeout reducer");

    let actual = result
        .account_txs
        .iter()
        .map(|(account_id, tx)| {
            serde_json::json!({
                "accountId": account_id,
                "txType": tx.wire_name(),
                "txDigest": format!("0x{}", hex::encode(canonical_tx_digest(tx).expect("tx digest"))),
            })
        })
        .collect::<Vec<_>>();
    assert_eq!(
        actual,
        expected["outbox"]["accountTxs"]
            .as_array()
            .expect("expected Account outbox")
            .clone()
    );
    assert_eq!(
        state, before,
        "timeout routing must not mutate Entity state"
    );
    assert!(result.events.is_empty());
    assert!(result.outputs.is_empty());
    assert!(result.routed_entity_outputs.is_empty());
}

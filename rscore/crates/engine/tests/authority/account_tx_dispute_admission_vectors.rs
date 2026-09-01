use super::common;

use std::path::Path;

use serde_json::Value;
use xln_rscore_engine::{
    AccountConsensus, AccountExecutionContext, AccountRejection, AccountTx, AccountVerdict,
    CanonicalValue, DeliveryMode, SequentialAccountEngine, Side,
};

fn vectors() -> Vec<(String, String, String)> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../core/__tests__/rscore/authority/account-tx-dispute-admission-vectors.json");
    let document: Value = serde_json::from_str(
        &std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display())),
    )
    .expect("shared dispute admission vectors decode");
    document["vectors"]
        .as_array()
        .expect("vectors array")
        .iter()
        .map(|row| {
            (
                row["status"].as_str().expect("status").to_owned(),
                row["expectedCode"].as_str().expect("code").to_owned(),
                row["expectedMessage"].as_str().expect("message").to_owned(),
            )
        })
        .collect()
}

fn payment() -> AccountTx {
    AccountTx::DirectPayment {
        token_id: common::token(1),
        amount: 1.into(),
        route: vec![common::entity_text(0x22)],
        description: None,
        from_entity_id: common::entity_text(0x11),
        to_entity_id: common::entity_text(0x22),
        delivery_mode: DeliveryMode::Direct,
        trusted_gateway_entity_id: None,
    }
}

#[test]
fn shared_frozen_account_tx_vectors_reject_without_a_candidate() {
    for (status, expected_code, expected_message) in vectors() {
        let replica = common::replica(
            common::entity(0x11),
            common::entity(0x11),
            common::entity(0x22),
            vec![common::delta(common::token(1), 1_000, 0, 0, 500, 500)],
        );
        let mut consensus = AccountConsensus::new(replica);
        consensus
            .replace_entity_dispute_lifecycle(
                &status,
                (status == "dispute_preparing").then_some(CanonicalValue::Object(Vec::new())),
                None,
            )
            .expect("freeze account");
        let frozen_leaf = consensus
            .replica()
            .entity_account_leaf()
            .expect("frozen leaf");
        let result = SequentialAccountEngine::apply_with_context(
            consensus.replica(),
            Side::Left,
            &payment(),
            &AccountExecutionContext::new(2_000, 2_000, 0, 0, 0),
        )
        .expect("typed rejection");

        let AccountVerdict::Rejected(rejection) = result.verdict() else {
            panic!("unexpected verdict: {:?}", result.verdict());
        };
        assert_eq!(rejection.code(), expected_code);
        assert_eq!(rejection.message(), expected_message);
        let AccountRejection::ClosedForDispute { status: actual, .. } = rejection else {
            panic!("unexpected rejection: {rejection:?}");
        };
        assert_eq!(actual, &status);
        assert!(result.candidate().is_none());
        assert_eq!(
            consensus
                .replica()
                .entity_account_leaf()
                .expect("unchanged frozen leaf"),
            frozen_leaf,
        );
    }
}

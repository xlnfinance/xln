//! Shared TS/Rust vector for `credit_request` and the hub's `set_credit_limit`
//! answer. TypeScript writes and checks the same file in
//! core/__tests__/rscore/parity/account-credit-request-semantic-parity.test.ts.

mod common;

use serde::Deserialize;
use xln_rscore_engine::{
    AccountFrame, AccountTx, AccountVerdict, LendingIntentKind, SequentialAccountEngine, Side,
    TransitionError,
};

use common::{delta, entity, entity_text, replica, token};

const FRAME_HASH: &str = "0x5555555555555555555555555555555555555555555555555555555555555555";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    version: u64,
    canonical_source: String,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    steps: Vec<Step>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    tx_type: String,
    by_left: bool,
    account_state_root: String,
    deltas_root: String,
    lending_intents_root: String,
    intent_entries: Vec<(String, String)>,
    left_credit_limit: String,
    right_credit_limit: String,
    frame_hash: String,
    events: Vec<String>,
}

fn prefixed_hex(bytes: [u8; 32]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn account() -> xln_rscore_engine::AccountReplica {
    replica(
        entity(0x10),
        entity(0x10),
        entity(0x30),
        vec![delta(token(1), 0, 0, 0, 0, 0)],
    )
}

fn request(request_id: &str, amount: u64) -> AccountTx {
    AccountTx::CreditRequest {
        request_id: request_id.into(),
        requester_entity_id: entity_text(0x30),
        token_id: token(1),
        amount: amount.into(),
    }
}

fn grant(amount: u64) -> AccountTx {
    AccountTx::SetCreditLimit {
        token_id: token(1),
        amount: amount.into(),
    }
}

fn assert_step(
    account: &mut xln_rscore_engine::AccountReplica,
    side: Side,
    tx: AccountTx,
    expected: &Step,
) {
    assert_eq!(tx.wire_name(), expected.tx_type);
    assert_eq!(matches!(side, Side::Left), expected.by_left);
    let transition = SequentialAccountEngine::apply(account, side, &tx).expect("shared transition");
    assert_eq!(transition.verdict(), &AccountVerdict::Applied);
    assert_eq!(transition.events(), expected.events);
    let candidate = transition.committed().expect("shared candidate");
    let state = candidate.state();
    let root = state
        .payment_profile_account_state_root()
        .expect("state root");
    assert_eq!(prefixed_hex(root), expected.account_state_root);
    assert_eq!(prefixed_hex(state.deltas_root()), expected.deltas_root);
    assert_eq!(
        state.lending_intents_root().map(prefixed_hex).as_deref(),
        Some(expected.lending_intents_root.as_str())
    );
    for (key, kind) in &expected.intent_entries {
        assert_eq!(kind, "credit-request");
        assert_eq!(
            state.lending_intent(key),
            Some(LendingIntentKind::CreditRequest)
        );
    }
    assert_eq!(state.lending_intent_count(), expected.intent_entries.len());
    let delta = state.delta(token(1)).expect("delta");
    assert_eq!(
        delta.left_credit_limit().to_string(),
        expected.left_credit_limit
    );
    assert_eq!(
        delta.right_credit_limit().to_string(),
        expected.right_credit_limit
    );
    let frame = AccountFrame {
        height: 2,
        timestamp: 1_000,
        j_height: 0,
        txs: vec![tx],
        prev_frame_hash: FRAME_HASH.into(),
        account_state_root: root,
    };
    assert_eq!(
        prefixed_hex(frame.hash().expect("frame hash")),
        expected.frame_hash
    );
    *account = candidate;
}

#[test]
fn credit_request_and_hub_answer_match_the_shared_typescript_vector() {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../fixtures/account-semantics/credit-request-v1.json"
    ))
    .expect("shared TypeScript credit request fixture");
    assert_eq!(fixture.version, 1);
    assert_eq!(
        fixture.canonical_source,
        "TypeScript applyAccountTxToMutableReplica"
    );
    let case = &fixture.cases[0];
    assert_eq!(case.name, "wallet-ask-hub-answers");
    let txs = [
        (Side::Right, request("credit-1111111111111111", 25_000_000)),
        (Side::Left, grant(25_000_000)),
        (
            Side::Right,
            request("credit-2222222222222222", 5_000_000_000),
        ),
        (Side::Left, grant(1_000_000_000)),
    ];
    assert_eq!(case.steps.len(), txs.len());
    let mut account = account();
    for ((side, tx), expected) in txs.into_iter().zip(&case.steps) {
        assert_step(&mut account, side, tx, expected);
    }
}

/// Same rejections, in the same order, as the TypeScript L1 vectors in
/// core/__tests__/payments/invariants/credit-request.test.ts.
#[test]
fn replay_non_party_zero_amount_and_unknown_lane_are_rejected() {
    let base = account();
    let accepted =
        SequentialAccountEngine::apply(&base, Side::Right, &request("credit-1111111111111111", 1))
            .expect("first request")
            .committed()
            .expect("candidate");
    assert!(matches!(
        SequentialAccountEngine::apply(&accepted, Side::Right, &request("credit-1111111111111111", 2)),
        Err(TransitionError::LendingIntentReplay(key)) if key == "credit:credit-1111111111111111"
    ));
    // The hub (LEFT) signs a request that names the user as requester.
    assert!(matches!(
        SequentialAccountEngine::apply(&base, Side::Left, &request("credit-1111111111111111", 1)),
        Err(TransitionError::CreditRequestRequesterNotProposer { .. })
    ));
    assert!(matches!(
        SequentialAccountEngine::apply(&base, Side::Right, &request("credit-1111111111111111", 0)),
        Err(TransitionError::LendingAmountNotPositive {
            context: "CREDIT_REQUEST"
        })
    ));
    let no_lane = AccountTx::CreditRequest {
        request_id: "credit-1111111111111111".into(),
        requester_entity_id: entity_text(0x30),
        token_id: token(2),
        amount: 1.into(),
    };
    assert!(matches!(
        SequentialAccountEngine::apply(&base, Side::Right, &no_lane),
        Err(TransitionError::CreditRequestTokenNotEnabled(_))
    ));
    assert!(matches!(
        SequentialAccountEngine::apply(&base, Side::Right, &request("credit-XYZ", 1)),
        Err(TransitionError::CreditRequestIdInvalid(_))
    ));
}

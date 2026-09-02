mod common;

use num_bigint::BigInt;
use serde::Deserialize;
use xln_rscore_engine::{
    AccountTx, AccountVerdict, LendingAction, LendingIntentKind, LendingTermId,
    SequentialAccountEngine, Side, TransitionError,
};

use common::{delta, entity, entity_text, replica, root_hex, token};

const POSITION: &str = "lend-1111111111111111";
const BORROW: &str = "borrow-2222222222222222";
const LOAN: &str = "loan-0327fd9035d42518";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LendingFixture {
    version: u64,
    canonical_source: String,
    cases: Vec<LendingCase>,
}

#[derive(Deserialize)]
struct LendingCase {
    name: String,
    steps: Vec<LendingExpectedStep>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LendingExpectedStep {
    tx_type: String,
    by_left: bool,
    account_state_root: String,
    deltas_root: String,
    lending_intents_root: String,
    intent_entries: Vec<(String, String)>,
    offdelta: String,
    left_credit_limit: String,
    right_credit_limit: String,
    events: Vec<String>,
    output_count: usize,
}

fn prefixed_hex(bytes: [u8; 32]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn intent_kind(value: &str) -> LendingIntentKind {
    match value {
        "fund" => LendingIntentKind::Fund,
        "borrow" => LendingIntentKind::Borrow,
        "credit-grant" => LendingIntentKind::CreditGrant,
        "credit-revoke" => LendingIntentKind::CreditRevoke,
        "repay" => LendingIntentKind::Repay,
        "close-request" => LendingIntentKind::CloseRequest,
        "close-payout" => LendingIntentKind::ClosePayout,
        other => panic!("unknown lending intent {other}"),
    }
}

fn assert_shared_step(
    account: &mut xln_rscore_engine::AccountReplica,
    side: Side,
    tx: AccountTx,
    expected: &LendingExpectedStep,
) {
    assert_eq!(tx.wire_name(), expected.tx_type);
    assert_eq!(matches!(side, Side::Left), expected.by_left);
    let transition = SequentialAccountEngine::apply(account, side, &tx).expect("shared transition");
    assert_eq!(transition.verdict(), &AccountVerdict::Applied);
    assert_eq!(transition.events(), expected.events);
    assert_eq!(transition.outputs().len(), expected.output_count);
    let candidate = transition.committed().expect("shared candidate");
    let state = candidate.state();
    assert_eq!(
        prefixed_hex(
            state
                .payment_profile_account_state_root()
                .expect("state root")
        ),
        expected.account_state_root
    );
    assert_eq!(prefixed_hex(state.deltas_root()), expected.deltas_root);
    assert_eq!(
        state
            .lending_intents_root()
            .map(prefixed_hex)
            .unwrap_or_else(|| format!("0x{}", "00".repeat(32))),
        expected.lending_intents_root
    );
    let delta = state.delta(token(1)).expect("shared delta");
    assert_eq!(delta.offdelta().to_string(), expected.offdelta);
    assert_eq!(
        delta.left_credit_limit().to_string(),
        expected.left_credit_limit
    );
    assert_eq!(
        delta.right_credit_limit().to_string(),
        expected.right_credit_limit
    );
    for (key, kind) in &expected.intent_entries {
        assert_eq!(state.lending_intent(key), Some(intent_kind(kind)), "{key}");
    }
    assert_eq!(state.lending_intent_count(), expected.intent_entries.len());
    *account = candidate;
}

fn lender_account() -> xln_rscore_engine::AccountReplica {
    replica(
        entity(0x10),
        entity(0x10),
        entity(0x20),
        vec![delta(token(1), 20_000, 0, 0, 20_000, 20_000)],
    )
}

fn borrower_account() -> xln_rscore_engine::AccountReplica {
    replica(
        entity(0x10),
        entity(0x10),
        entity(0x30),
        vec![delta(token(1), 20_000, 0, 0, 20_000, 20_000)],
    )
}

fn fund() -> AccountTx {
    AccountTx::LendingFund {
        position_id: POSITION.into(),
        hub_entity_id: entity_text(0x10),
        lender_entity_id: entity_text(0x20),
        token_id: token(1),
        amount: 10_000.into(),
        term_id: LendingTermId::OneDay,
        interest_bps: 100,
    }
}

#[test]
fn fund_matches_literal_delta_and_intent_roots() {
    let base = lender_account();
    assert_eq!(
        root_hex(&base),
        "d0f6c4d2d2ecf5393b499adcbca31364f13ee59e1892455d3998e669f74eff39"
    );
    let transition =
        SequentialAccountEngine::apply(&base, Side::Right, &fund()).expect("fund transition");
    assert_eq!(transition.verdict(), &AccountVerdict::Applied);
    assert!(transition.outputs().is_empty());
    let funded = transition.candidate().expect("candidate");
    assert_eq!(
        funded.state().delta(token(1)).expect("delta").offdelta(),
        &10_000.into()
    );
    assert_eq!(
        root_hex(funded),
        "8b2f57f5a7ff67570d909be30dc18ab49bfe3b2d1751bdedb143ae090718ee43"
    );
    assert_eq!(
        funded
            .state()
            .lending_intents_root()
            .map(hex::encode)
            .as_deref(),
        Some("8ee49f1fb0cee4b8c22be28d6bb1ef41b29ce54f277ec21413eb420202bb77f4")
    );
    assert_eq!(
        funded.state().lending_intent("fund:lend-1111111111111111"),
        Some(LendingIntentKind::Fund)
    );
}

#[test]
fn forged_lender_and_replay_are_fail_fast_and_atomic() {
    let base = lender_account();
    let before = root_hex(&base);
    let forged = SequentialAccountEngine::apply(&base, Side::Left, &fund());
    assert!(matches!(
        forged,
        Err(TransitionError::LendingRoleNotProposer { role: "LENDER", .. })
    ));
    assert_eq!(root_hex(&base), before);

    let funded = SequentialAccountEngine::apply(&base, Side::Right, &fund())
        .expect("first fund")
        .committed()
        .expect("candidate");
    let funded_root = root_hex(&funded);
    let replay = SequentialAccountEngine::apply(&funded, Side::Right, &fund());
    assert!(matches!(
        replay,
        Err(TransitionError::LendingIntentReplay(_))
    ));
    assert_eq!(root_hex(&funded), funded_root);
}

#[test]
fn all_six_lending_variants_apply_with_exact_roles_and_orientation() {
    let lender = lender_account();
    let sequence = vec![
        (Side::Right, fund()),
        (
            Side::Right,
            AccountTx::LendingCloseRequest {
                position_id: POSITION.into(),
                hub_entity_id: entity_text(0x10),
                lender_entity_id: entity_text(0x20),
            },
        ),
        (
            Side::Left,
            AccountTx::LendingClosePayout {
                position_id: POSITION.into(),
                hub_entity_id: entity_text(0x10),
                lender_entity_id: entity_text(0x20),
                token_id: token(1),
                amount: 10_025.into(),
            },
        ),
    ];
    let lender = SequentialAccountEngine::apply_atomic(&lender, &sequence)
        .expect("lender lifecycle")
        .committed()
        .expect("candidate");
    assert_eq!(
        lender.state().delta(token(1)).expect("delta").offdelta(),
        &(-25).into()
    );
    assert_eq!(
        lender.state().lending_intent("close:lend-1111111111111111"),
        Some(LendingIntentKind::CloseRequest)
    );
    assert_eq!(
        lender
            .state()
            .lending_intent("payout:lend-1111111111111111"),
        Some(LendingIntentKind::ClosePayout)
    );

    let borrower = borrower_account();
    let sequence = vec![
        (
            Side::Right,
            AccountTx::LendingBorrowRequest {
                request_id: BORROW.into(),
                hub_entity_id: entity_text(0x10),
                borrower_entity_id: entity_text(0x30),
                token_id: 65_536,
                amount: 2_500.into(),
                term_id: LendingTermId::OneDay,
                max_interest_bps: 150,
            },
        ),
        (
            Side::Left,
            AccountTx::LendingCredit {
                action: LendingAction::Grant,
                loan_id: LOAN.into(),
                hub_entity_id: entity_text(0x10),
                borrower_entity_id: entity_text(0x30),
                token_id: token(1),
                credit_limit: 22_500.into(),
            },
        ),
        (
            Side::Right,
            AccountTx::LendingRepay {
                loan_id: LOAN.into(),
                hub_entity_id: entity_text(0x10),
                borrower_entity_id: entity_text(0x30),
                token_id: token(1),
                amount: 2_525.into(),
            },
        ),
    ];
    let borrower = SequentialAccountEngine::apply_atomic(&borrower, &sequence)
        .expect("borrower lifecycle")
        .committed()
        .expect("candidate");
    let delta = borrower.state().delta(token(1)).expect("delta");
    assert_eq!(delta.right_credit_limit(), &BigInt::from(22_500));
    assert_eq!(delta.offdelta(), &BigInt::from(2_525));
    assert_eq!(
        borrower
            .state()
            .lending_intent("borrow:borrow-2222222222222222"),
        Some(LendingIntentKind::Borrow)
    );
    assert_eq!(
        borrower
            .state()
            .lending_intent("grant:loan-0327fd9035d42518"),
        Some(LendingIntentKind::CreditGrant)
    );
    assert_eq!(
        borrower
            .state()
            .lending_intent("repay:loan-0327fd9035d42518"),
        Some(LendingIntentKind::Repay)
    );
}

#[test]
fn credit_grant_root_matches_typescript_literal() {
    let base = borrower_account();
    let tx = AccountTx::LendingCredit {
        action: LendingAction::Grant,
        loan_id: LOAN.into(),
        hub_entity_id: entity_text(0x10),
        borrower_entity_id: entity_text(0x30),
        token_id: token(1),
        credit_limit: 22_500.into(),
    };
    let candidate = SequentialAccountEngine::apply(&base, Side::Left, &tx)
        .expect("credit")
        .committed()
        .expect("candidate");
    assert_eq!(
        root_hex(&candidate),
        "67104d5645f8cbe8fb1126337873d8c4b6e4ec199e58b941339a0b2df76ed4dc"
    );
    assert_eq!(
        candidate
            .state()
            .lending_intents_root()
            .map(hex::encode)
            .as_deref(),
        Some("b1c856124c7dee52e0a5b8c63cdcfd5f3912c50e78c5b48b8cd82550751e8c01")
    );
}

#[test]
fn all_lending_variants_match_the_shared_typescript_semantic_vector() {
    let fixture: LendingFixture = serde_json::from_str(include_str!(
        "../../../fixtures/account-semantics/lending-v1.json"
    ))
    .expect("shared TypeScript lending fixture");
    assert_eq!(fixture.version, 1);
    assert_eq!(
        fixture.canonical_source,
        "TypeScript applyAccountTxToMutableReplica"
    );

    let borrower = fixture
        .cases
        .iter()
        .find(|test_case| test_case.name == "borrower-lifecycle")
        .expect("borrower vector");
    let mut borrower_account = borrower_account();
    let borrower_txs = [
        (
            Side::Right,
            AccountTx::LendingBorrowRequest {
                request_id: BORROW.into(),
                hub_entity_id: entity_text(0x10),
                borrower_entity_id: entity_text(0x30),
                token_id: 1,
                amount: 2_500.into(),
                term_id: LendingTermId::OneDay,
                max_interest_bps: 150,
            },
        ),
        (
            Side::Left,
            AccountTx::LendingCredit {
                action: LendingAction::Grant,
                loan_id: LOAN.into(),
                hub_entity_id: entity_text(0x10),
                borrower_entity_id: entity_text(0x30),
                token_id: token(1),
                credit_limit: 22_500.into(),
            },
        ),
        (
            Side::Right,
            AccountTx::LendingRepay {
                loan_id: LOAN.into(),
                hub_entity_id: entity_text(0x10),
                borrower_entity_id: entity_text(0x30),
                token_id: token(1),
                amount: 2_525.into(),
            },
        ),
    ];
    assert_eq!(borrower.steps.len(), borrower_txs.len());
    for ((side, tx), expected) in borrower_txs.into_iter().zip(&borrower.steps) {
        assert_shared_step(&mut borrower_account, side, tx, expected);
    }

    let lender = fixture
        .cases
        .iter()
        .find(|test_case| test_case.name == "lender-lifecycle")
        .expect("lender vector");
    let mut lender_account = lender_account();
    let lender_txs = [
        (Side::Right, fund()),
        (
            Side::Right,
            AccountTx::LendingCloseRequest {
                position_id: POSITION.into(),
                hub_entity_id: entity_text(0x10),
                lender_entity_id: entity_text(0x20),
            },
        ),
        (
            Side::Left,
            AccountTx::LendingClosePayout {
                position_id: POSITION.into(),
                hub_entity_id: entity_text(0x10),
                lender_entity_id: entity_text(0x20),
                token_id: token(1),
                amount: 10_025.into(),
            },
        ),
    ];
    assert_eq!(lender.steps.len(), lender_txs.len());
    for ((side, tx), expected) in lender_txs.into_iter().zip(&lender.steps) {
        assert_shared_step(&mut lender_account, side, tx, expected);
    }
}

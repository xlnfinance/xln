mod common;

use num_bigint::BigInt;
use xln_rscore_engine::{
    AccountTx, AccountVerdict, LendingAction, LendingIntentKind, LendingTermId,
    SequentialAccountEngine, Side, TransitionError,
};

use common::{delta, entity, entity_text, replica, root_hex, token};

const POSITION: &str = "lend-1111111111111111";
const BORROW: &str = "borrow-2222222222222222";
const LOAN: &str = "loan-0327fd9035d42518";

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

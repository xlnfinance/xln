mod common;
use common::{delta, entity, entity_text, replica, root_hex, token};
use xln_rscore_engine::{AccountTx, AccountVerdict, LendingTermId, SequentialAccountEngine, Side};
const POSITION: &str = "lend-1111111111111111";
const BORROW: &str = "borrow-2222222222222222";
const LOAN: &str = "loan-0327fd9035d42518";
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
fn every_lending_variant_is_unsupported_and_atomic() {
    let base = replica(
        entity(0x10),
        entity(0x10),
        entity(0x20),
        vec![delta(token(1), 20_000, 0, 0, 20_000, 20_000)],
    );
    let before = root_hex(&base);
    let mut txs = vec![
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
    txs.extend([
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
                expires_at: 5_000,
                max_late_ms: 86_400_000,
            },
        ),
        (
            Side::Left,
            AccountTx::LendingDisburse {
                loan_id: LOAN.into(),
                hub_entity_id: entity_text(0x10),
                borrower_entity_id: entity_text(0x30),
                token_id: token(1),
                amount: 2_500.into(),
                term_id: LendingTermId::OneDay,
                interest_bps: 100,
                request_id: BORROW.into(),
                max_interest_bps: 150,
                expires_at: 5_000,
                max_late_ms: 86_400_000,
                late_ms: 86_400_000,
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
                claim_hash: format!("0x{}", "cc".repeat(32)),
            },
        ),
    ]);

    txs.push((
        Side::Left,
        AccountTx::LendingRate {
            position_id: POSITION.into(),
            hub_entity_id: entity_text(0x10),
            lender_entity_id: entity_text(0x20),
            token_id: token(1),
            claim_hash: format!("0x{}", "cc".repeat(32)),
            interest_bps: 100,
        },
    ));
    assert_eq!(txs.len(), 7);
    for (side, tx) in &txs {
        let result = SequentialAccountEngine::apply(&base, *side, tx).expect("typed disposition");
        assert!(matches!(result.verdict(), AccountVerdict::Rejected(_)));
        assert!(result.candidate().is_none());
        assert!(result.outputs().is_empty());
        assert_eq!(
            common::rejected_message(SequentialAccountEngine::apply(&base, *side, tx)),
            format!("LENDING_UNSUPPORTED:{}", tx.wire_name())
        );
        assert_eq!(root_hex(&base), before);
    }
    // A rejected second tx must also discard an earlier successful mutation.
    txs.insert(0, (Side::Left, AccountTx::AddDelta { token_id: token(2) }));
    let batch = SequentialAccountEngine::apply_atomic(&base, &txs).expect("batch disposition");
    assert!(matches!(batch.verdict(), AccountVerdict::Rejected(_)));
    assert!(batch.candidate().is_none());
    assert!(batch.outputs().is_empty());
    assert_eq!(root_hex(&base), before);
}

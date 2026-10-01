use super::*;
use xln_rscore_engine::LendingTermId;
use xln_rscore_entity_kernel::{LendingLoan, LendingPoolPosition, LendingPoolStatus};

fn entity(byte: &str) -> String {
    format!("0x{}", byte.repeat(32))
}
fn pool(id: &str, user: &str, token: u16, updated: u64) -> LendingPoolPosition {
    LendingPoolPosition {
        position_id: id.into(),
        hub_entity_id: entity("11"),
        lender_entity_id: user.into(),
        token_id: token,
        principal_amount: BigInt::from(9007199254740993_u64),
        available_amount: BigInt::from(7),
        borrowed_amount: BigInt::from(3),
        interest_bps: 50,
        term_id: LendingTermId::OneDay,
        term_ms: 86400000,
        created_at: 1,
        updated_at: updated,
        status: LendingPoolStatus::Open,
    }
}
fn loan(id: &str, borrower: &str, lender: &str, status: LendingLoanStatus) -> LendingLoan {
    LendingLoan {
        request_id: id.into(),
        loan_id: id.into(),
        hub_entity_id: entity("11"),
        borrower_entity_id: borrower.into(),
        lender_entity_id: lender.into(),
        position_id: "pool".into(),
        token_id: 1,
        principal_amount: BigInt::from(10),
        interest_amount: BigInt::from(1),
        repayment_amount: BigInt::from(11),
        repaid_amount: BigInt::from(0),
        interest_bps: 50,
        term_id: LendingTermId::OneDay,
        term_ms: 86400000,
        opened_at: 1,
        due_at: 86400001,
        updated_at: 2,
        status,
    }
}
#[test]
fn committed_lending_projection_matches_ts_filters_sort_and_bigints() {
    let user = entity("22");
    let other = entity("33");
    let state = LendingState::from_entries(
        [
            pool("z", &user, 1, 10),
            pool("b", &user, 1, 20),
            pool("a", &user, 1, 20),
            pool("other", &other, 1, 20),
            pool("token2", &user, 2, 30),
        ],
        [
            loan("b", &user, &other, LendingLoanStatus::Active),
            loan("a", &other, &user, LendingLoanStatus::Closing),
            loan("hidden", &other, &other, LendingLoanStatus::Opening),
            loan("repaid", &other, &other, LendingLoanStatus::Repaid),
        ],
    )
    .unwrap();
    let query = LendingStateQuery::parse(&format!(
        "/?hubEntityId={}&userEntityId={user}&tokenId=1",
        entity("11")
    ))
    .unwrap();
    let value = lending_state_response(Some(&state), &query).unwrap();
    assert_eq!(
        value["pools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|pool| pool["positionId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["a", "b", "z"]
    );
    assert_eq!(
        value["loans"]
            .as_array()
            .unwrap()
            .iter()
            .map(|loan| loan["loanId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["a", "b"]
    );
    assert_eq!(value["pools"][0]["principalAmount"], "9007199254740993");
    assert_eq!(
        value["totals"],
        json!({"availableAmount":"28","borrowedAmount":"12","activePrincipalAmount":"30"})
    );
    let empty = lending_state_response(None, &query).unwrap();
    assert_eq!(empty["pools"], json!([]));
    assert_eq!(empty["loans"], json!([]));
    assert_eq!(empty["totals"]["availableAmount"], "0");
}
#[test]
fn lending_query_rejects_malformed_ids_and_token_filters() {
    for query in [
        "/".to_string(),
        "/?hubEntityId=bad".into(),
        format!("/?hubEntityId={}&userEntityId=bad", entity("11")),
        format!("/?hubEntityId={}&tokenId=NaN", entity("11")),
        format!("/?hubEntityId={}&tokenId=0", entity("11")),
        format!("/?hubEntityId={}&tokenId=-2", entity("11")),
    ] {
        assert!(LendingStateQuery::parse(&query).is_err());
    }
    let query =
        LendingStateQuery::parse(&format!("/?hubEntityId={}&tokenId=1.9", entity("11"))).unwrap();
    assert_eq!(query.token_id, Some(1.0));
}

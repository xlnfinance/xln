#[path = "../../../../fixtures/lending-oracle.rs"]
mod lending_oracle;

use super::state::*;
use super::*;
use crate::{
    CanonicalEntityTx, DeterministicContext, EntityStateSlice, EntityTxKind,
    LocalAccountFinancialView,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use xln_rscore_engine::{AccountTx, Side, TokenId, lending::LendingCovenant};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue as V};
const HUB: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
const PEER: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";
pub(crate) fn canonical(v: &Value) -> V {
    match v {
        Value::Null => V::Null,
        Value::Bool(v) => V::Bool(*v),
        Value::String(v) => s(v),
        Value::Number(v) => V::Number(CanonicalNumber::parse_js_canonical(&v.to_string()).unwrap()),
        Value::Array(v) => V::Array(v.iter().map(canonical).collect()),
        Value::Object(v) => match v.get("__xlnType").and_then(Value::as_str) {
            Some("BigInt") => V::BigInt(v["value"].as_str().unwrap().parse().unwrap()),
            Some("Map") => V::Map(
                v["value"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| (canonical(&p[0]), canonical(&p[1])))
                    .collect(),
            ),
            _ => V::Object(v.iter().map(|(k, v)| (k.clone(), canonical(v))).collect()),
        },
    }
}
fn equal(a: &V, b: &V) {
    assert_eq!(
        xln_rscore_protocol::encode_canonical_consensus_bytes(a).unwrap(),
        xln_rscore_protocol::encode_canonical_consensus_bytes(b).unwrap()
    );
}
pub(crate) fn view() -> LocalAccountFinancialView {
    let mut lending = xln_rscore_engine::lending::LendingAccountView {
        chain_id: 31337,
        depository_address: format!("0x{}", "88".repeat(20)),
        ..Default::default()
    };
    lending.claims.insert(
        "loan-0327fd9035d42518".into(),
        LendingCovenant {
            kind: "loan".into(),
            token_id: 1,
            creditor_is_left: true,
            principal: 2500.into(),
            interest_bps: 100,
            opened_at: 1000,
            accrued_at: 1000,
            accrued_interest: 0.into(),
            interest_remainder: 0.into(),
            term_ms: 86400000,
            late_ms: 86400000,
        },
    );
    LocalAccountFinancialView {
        lending,
        dispute_config: xln_rscore_engine::AccountDisputeConfig::new(10, 10).unwrap(),
        active: true,
        owner_side: Side::Left,
        owner_out_capacity: BTreeMap::from([(TokenId::new(1).unwrap(), 20000.into())]),
        owner_peer_credit_limit: BTreeMap::new(),
        settlement_workspace: None,
        settlement_transition_pending: false,
        settlement_execution: Err("no settlement".into()),
        rebalance_active_quote: None,
        htlc_locks: BTreeMap::new(),
        pending_htlc_lock_ids: BTreeSet::new(),
        pulls: BTreeMap::new(),
        swap_offers: BTreeMap::new(),
        pending_cross_pull_close_ids: BTreeSet::new(),
        dispute: None,
    }
}
#[test]
fn policies_and_ts_bank_snapshot_round_trip() {
    let fixture = lending_oracle::lending_oracle("entity-kernel/lending");
    for row in fixture["policies"].as_array().unwrap() {
        let mut state = EntityStateSlice::empty(HUB, 1000);
        state.profile.is_hub = row["isHub"].as_bool().unwrap();
        state.known_accounts.insert(PEER.into());
        let input = &row["tx"];
        let kind = EntityTxKind::parse(input["type"].as_str().unwrap()).unwrap();
        let tx = CanonicalEntityTx::from_frame_projection(kind, canonical(&input["data"])).unwrap();
        let result = crate::local_financial::apply_local_entity_financial_txs(
            &mut state,
            &mut crate::paybook::PaybookChanges::default(),
            vec![crate::LocalEntityFinancialTx::LendingCommand(tx)],
            &DeterministicContext::hlt_default(),
            &BTreeMap::from([(PEER.into(), view())]),
            None,
            None,
        );
        if row.get("error").is_some() {
            assert!(
                matches!(result,Err(crate::EntityKernelError::RejectedEntityTx{detail,..}) if detail=="LENDING_POLICY_BANK_REQUIRED")
            );
        } else {
            let result = result.unwrap();
            equal(
                &canonical_lending_state(state.lending.as_ref().unwrap()).unwrap(),
                &canonical(&row["lending"]),
            );
            assert_eq!(result.events.len(), row["events"].as_array().unwrap().len());
        }
    }
    // TS-produced current book includes exact bank terms/facilities and closed records.
    let snapshot = canonical(&fixture["snapshot"]);
    let restored = decode_canonical_lending_state(&snapshot).unwrap();
    equal(&canonical_lending_state(&restored).unwrap(), &snapshot);
    // Every intermediate committed lifecycle snapshot must also restore exactly.
    for step in fixture["steps"].as_array().unwrap() {
        let book =
            canonical(&serde_json::from_str::<Value>(step["book"].as_str().unwrap()).unwrap());
        let restored = decode_canonical_lending_state(&book).unwrap();
        equal(&canonical_lending_state(&restored).unwrap(), &book);
        let time = step
            .get("time")
            .or_else(|| step.get("defaultAt"))
            .unwrap()
            .as_u64()
            .unwrap();
        equal(
            &summarize_lending_state(Some(&restored), time, PEER, None, None, &BTreeMap::new())
                .unwrap(),
            &canonical(&step["projection"]),
        );
    }
}
fn account_tx(value: &Value) -> AccountTx {
    let d = canonical(&value["data"]);
    let kind = value["type"].as_str().unwrap();
    let id = |k| text(&d, k).unwrap().to_owned();
    let num = |k| number(&d, k).unwrap();
    let amount = || big(&d, "amount").unwrap();
    let token = || TokenId::new(u32::try_from(num("tokenId")).unwrap()).unwrap();
    let term = || codec::term(text(&d, "termId").unwrap()).unwrap();
    match kind {
        "lending_rate" => AccountTx::LendingRate {
            position_id: id("positionId"),
            hub_entity_id: id("hubEntityId"),
            lender_entity_id: id("lenderEntityId"),
            token_id: token(),
            claim_hash: id("claimHash"),
            interest_bps: num("interestBps") as i64,
        },
        "lending_fund" => AccountTx::LendingFund {
            position_id: id("positionId"),
            hub_entity_id: id("hubEntityId"),
            lender_entity_id: id("lenderEntityId"),
            token_id: token(),
            amount: amount(),
            term_id: term(),
            interest_bps: num("interestBps") as i64,
        },
        "lending_borrow_request" => AccountTx::LendingBorrowRequest {
            request_id: id("requestId"),
            hub_entity_id: id("hubEntityId"),
            borrower_entity_id: id("borrowerEntityId"),
            token_id: num("tokenId"),
            amount: amount(),
            term_id: term(),
            max_interest_bps: num("maxInterestBps") as i64,
            max_late_ms: num("maxLateMs"),
            expires_at: num("expiresAt"),
        },
        "lending_disburse" => AccountTx::LendingDisburse {
            loan_id: id("loanId"),
            hub_entity_id: id("hubEntityId"),
            borrower_entity_id: id("borrowerEntityId"),
            token_id: token(),
            amount: amount(),
            term_id: term(),
            interest_bps: num("interestBps") as i64,
            request_id: id("requestId"),
            max_interest_bps: num("maxInterestBps") as i64,
            max_late_ms: num("maxLateMs"),
            late_ms: num("lateMs"),
            expires_at: num("expiresAt"),
        },
        "lending_repay" => AccountTx::LendingRepay {
            loan_id: id("loanId"),
            hub_entity_id: id("hubEntityId"),
            borrower_entity_id: id("borrowerEntityId"),
            token_id: token(),
            amount: amount(),
            claim_hash: id("claimHash"),
        },
        "lending_close_request" => AccountTx::LendingCloseRequest {
            position_id: id("positionId"),
            hub_entity_id: id("hubEntityId"),
            lender_entity_id: id("lenderEntityId"),
        },
        "lending_close_payout" => AccountTx::LendingClosePayout {
            position_id: id("positionId"),
            hub_entity_id: id("hubEntityId"),
            lender_entity_id: id("lenderEntityId"),
            token_id: token(),
            amount: amount(),
        },
        _ => panic!("{kind}"),
    }
}
#[test]
fn committed_book_lifecycle_matches_typescript() {
    let fixture = lending_oracle::lending_oracle("entity-kernel/lending");
    let mut state = EntityStateSlice::empty(HUB, 1000);
    state.profile.is_hub = true;
    state.known_accounts.insert(PEER.into());
    state.lending = Some(LendingState {
        terms: Some(Vec::new()),
        facilities: Some(Vec::new()),
        ..Default::default()
    });
    for row in fixture["policies"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| v["isHub"] == true)
    {
        let book = decode_canonical_lending_state(&canonical(&row["lending"])).unwrap();
        if book.terms.is_some() {
            state.lending.as_mut().unwrap().terms = book.terms;
        }
        if book.facilities.is_some() {
            state.lending.as_mut().unwrap().facilities = book.facilities;
        }
    }
    let view = view();
    let mut events = Vec::new();
    for step in fixture["steps"].as_array().unwrap() {
        let mut outputs = Vec::new();
        if let Some(time) = step.get("defaultAt") {
            state.timestamp = time.as_u64().unwrap();
            let id = state.lending.as_ref().unwrap().loans[0].0.clone();
            settle_overdue_lending_loans(
                &mut state,
                &[OverdueLendingLoan {
                    loan_id: id,
                    borrower_entity_id: PEER.into(),
                    token_id: TokenId::new(1).unwrap(),
                    committed_credit_limit: 0.into(),
                }],
                &mut outputs,
            )
            .unwrap();
        } else {
            state.timestamp = step["time"].as_u64().unwrap();
            let tx = account_tx(&step["tx"]);
            let commit = crate::OrderedAccountCommit {
                account_id: PEER.into(),
                domain: xln_rscore_engine::AccountDomain::new(
                    31337,
                    xln_rscore_engine::DepositoryAddress::parse(&format!("0x{}", "88".repeat(20)))
                        .unwrap(),
                )
                .unwrap(),
                scope: crate::JurisdictionScope::Same,
                committed_via_new_frame: true,
                frame_state_hash: "".into(),
                frame_height: 1,
                frame_timestamp: state.timestamp,
                inbound_position: 0,
                transitions: Vec::new(),
            };
            apply_committed_lending_followup(
                &mut state,
                &commit,
                &crate::CommittedAccountTransition {
                    tx,
                    outputs: Vec::new(),
                },
                Some(&view),
                &mut outputs,
                &mut events,
            )
            .unwrap();
            let expected = step["outputs"].as_array().unwrap();
            assert_eq!(outputs.len(), expected.len());
            for ((peer, tx), expected) in outputs.iter().zip(expected) {
                assert_eq!(peer, expected["accountId"].as_str().unwrap());
                assert_eq!(tx, &account_tx(&expected["tx"]));
            }
        }
        let expected =
            canonical(&serde_json::from_str::<Value>(step["book"].as_str().unwrap()).unwrap());
        equal(
            &canonical_lending_state(state.lending.as_ref().unwrap()).unwrap(),
            &expected,
        );
    }
    assert!(events.is_empty());
}

#[test]
fn servicing_and_dispute_retirement_match_ts() {
    let fixture = lending_oracle::lending_oracle("entity-kernel/lending-servicing");
    for row in fixture["cases"].as_array().unwrap() {
        let mut state = EntityStateSlice::empty(HUB, row["time"].as_u64().unwrap());
        state.lending = Some(decode_canonical_lending_state(&canonical(&row["book"])).unwrap());
        state.known_accounts.insert(PEER.into());
        let mut view = view();
        view.lending.busy = row["busy"].as_bool().unwrap();
        view.lending.claims.clear();
        for pair in row["claims"].as_array().unwrap() {
            view.lending.claims.insert(
                pair[0].as_str().unwrap().into(),
                LendingCovenant::decode(&canonical(&pair[1])).unwrap(),
            );
        }
        let amount = |name: &str| {
            row[name]["value"]
                .as_str()
                .unwrap()
                .parse::<num_bigint::BigInt>()
                .unwrap()
        };
        view.owner_out_capacity
            .insert(TokenId::new(1).unwrap(), amount("outCapacity"));
        view.lending
            .coupon_capacity
            .insert((1, true), amount("leftCoupon"));
        view.lending
            .coupon_capacity
            .insert((1, false), amount("rightCoupon"));
        let views = BTreeMap::from([(PEER.into(), view.clone())]);
        let withdrawals = servicing::withdrawals(&state, &views).unwrap();
        let renewals = servicing::renewals(&state, &views).unwrap();
        assert_eq!(
            withdrawals.len(),
            row["withdrawals"].as_array().unwrap().len(),
            "{}",
            row["name"]
        );
        for ((peer, tx), expected) in withdrawals
            .iter()
            .zip(row["withdrawals"].as_array().unwrap())
        {
            assert_eq!(peer, expected["accountId"].as_str().unwrap());
            assert_eq!(tx, &account_tx(&expected["tx"]));
        }
        assert_eq!(
            renewals.len(),
            row["renewals"].as_array().unwrap().len(),
            "{}",
            row["name"]
        );
        for ((time, peer, tx), expected) in renewals.iter().zip(row["renewals"].as_array().unwrap())
        {
            assert_eq!(*time, expected["triggerAt"].as_u64().unwrap());
            assert_eq!(peer, expected["accountId"].as_str().unwrap());
            assert_eq!(tx, &account_tx(&expected["tx"]));
        }
        equal(
            &summarize_lending_state(
                state.lending.as_ref(),
                state.timestamp,
                PEER,
                None,
                None,
                &BTreeMap::from([(PEER.into(), view.lending.clone())]),
            )
            .unwrap(),
            &canonical(&row["projection"]),
        );
        servicing::retire_disputed(
            &mut state,
            PEER,
            &view.lending.claims.keys().cloned().collect::<Vec<_>>(),
        )
        .unwrap();
        equal(
            &canonical_lending_state(state.lending.as_ref().unwrap()).unwrap(),
            &canonical(&row["retired"]),
        );
    }
}

#[test]
fn invalid_signed_policies_have_the_same_typed_reject() {
    let fixture = lending_oracle::lending_oracle("entity-kernel/lending");
    for row in fixture["invalidPolicies"].as_array().unwrap() {
        let mut state = EntityStateSlice::empty(HUB, 1000);
        state.profile.is_hub = true;
        state.known_accounts.insert(PEER.into());
        let input = &row["tx"];
        let tx = CanonicalEntityTx::from_frame_projection(
            EntityTxKind::parse(input["type"].as_str().unwrap()).unwrap(),
            canonical(&input["data"]),
        )
        .unwrap();
        let result = crate::local_financial::apply_local_entity_financial_txs(
            &mut state,
            &mut crate::paybook::PaybookChanges::default(),
            vec![crate::LocalEntityFinancialTx::LendingCommand(tx)],
            &DeterministicContext::hlt_default(),
            &BTreeMap::from([(PEER.into(), view())]),
            None,
            None,
        );
        if let Some(expected) = row.get("error") {
            let error = result.err().unwrap();
            let crate::EntityKernelError::RejectedEntityTx { kind, detail } = error else {
                panic!("wrong reject: {error}")
            };
            assert_eq!(
                format!("ENTITY_FRAME_TX_FAILED: type={kind} error={detail}"),
                expected.as_str().unwrap(),
                "{}",
                row["mode"]
            );
            assert!(state.lending.is_none());
        } else {
            result.unwrap();
            equal(
                &canonical_lending_state(state.lending.as_ref().unwrap()).unwrap(),
                &canonical(&row["lending"]),
            );
        }
    }
}

#[test]
fn default_terms_match_typescript_governance_commands() {
    let fixture = lending_oracle::lending_oracle("entity-kernel/lending");
    let domain = xln_rscore_engine::AccountDomain::new(
        31337,
        xln_rscore_engine::DepositoryAddress::parse(&format!("0x{}", "88".repeat(20))).unwrap(),
    )
    .unwrap();
    let actual = crate::build_default_bank_terms_txs(&domain, &[1, 2, 3], 1000).unwrap();
    assert_eq!(actual.len(), 12);
    for (tx, expected) in actual.iter().zip(fixture["defaults"].as_array().unwrap()) {
        assert_eq!(tx.kind.as_str(), expected["type"].as_str().unwrap());
        equal(&tx.wire_data, &canonical(&expected["data"]));
    }
}

fn oversized_token_reject(kind: &str, expected: &str) {
    let fixture = lending_oracle::lending_oracle("entity-kernel/lending-tokens");
    let row = fixture
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["tx"]["type"] == kind)
        .unwrap();
    assert_eq!(row["error"], expected, "canonical TS rejection");
    let mut state = EntityStateSlice::empty(HUB, 1000);
    state.profile.is_hub = true;
    state.known_accounts.insert(PEER.into());
    let before = state.clone();
    let mut view = view();
    view.lending
        .claims
        .get_mut("loan-0327fd9035d42518")
        .unwrap()
        .creditor_is_left = false;
    let tx = CanonicalEntityTx::from_frame_projection(
        EntityTxKind::parse(kind).unwrap(),
        canonical(&row["tx"]["data"]),
    )
    .unwrap();
    let result = crate::local_financial::apply_local_entity_financial_txs(
        &mut state,
        &mut crate::paybook::PaybookChanges::default(),
        vec![crate::LocalEntityFinancialTx::LendingCommand(tx)],
        &DeterministicContext::hlt_default(),
        &BTreeMap::from([(PEER.into(), view)]),
        None,
        None,
    );
    assert!(
        matches!(result, Err(crate::EntityKernelError::RejectedEntityTx { detail, .. }) if detail == expected),
        "{kind} must reject {expected}"
    );
    assert_eq!(
        state, before,
        "rejection must preserve the entire Entity state"
    );
}
#[test]
fn oversized_token_offer_matches_ts_rejection_without_mutation() {
    oversized_token_reject("lendingOffer", "LENDING_TOKEN_NOT_ENABLED:4294967297");
}
#[test]
fn oversized_token_approval_matches_ts_rejection_without_mutation() {
    oversized_token_reject("lendingApprove", "LENDING_FACILITY_ACCOUNT_UNAVAILABLE");
}
#[test]
fn oversized_token_repayment_matches_ts_rejection_without_mutation() {
    oversized_token_reject("lendingRepay", "LENDING_REPAY_COVENANT_MISMATCH");
}

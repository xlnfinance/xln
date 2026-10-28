#[path = "../../../fixtures/lending-oracle.rs"]
mod lending_oracle;

mod common;
use common::*;
use serde_json::Value;
use xln_rscore_engine::*;
fn text(v: &Value) -> String {
    v.as_str().unwrap().into()
}
fn n(v: &Value) -> u64 {
    v.as_u64().unwrap()
}
fn big(v: &Value) -> num_bigint::BigInt {
    v.as_str()
        .unwrap_or_else(|| v["value"].as_str().unwrap())
        .parse()
        .unwrap()
}
fn term(v: &Value) -> LendingTermId {
    match n(v) {
        0 => LendingTermId::OneHour,
        1 => LendingTermId::OneDay,
        2 => LendingTermId::OneMonth,
        3 => LendingTermId::Demand,
        _ => panic!(),
    }
}
fn tx(v: &Value) -> AccountTx {
    let a = v.as_array().unwrap();
    match n(&a[0]) {
        10 => AccountTx::LendingFund {
            position_id: text(&a[1]),
            hub_entity_id: text(&a[2]),
            lender_entity_id: text(&a[3]),
            token_id: token(n(&a[4]) as u32),
            amount: big(&a[5]),
            term_id: term(&a[6]),
            interest_bps: a[7].as_i64().unwrap(),
        },
        11 => AccountTx::LendingBorrowRequest {
            request_id: text(&a[1]),
            hub_entity_id: text(&a[2]),
            borrower_entity_id: text(&a[3]),
            token_id: n(&a[4]),
            amount: big(&a[5]),
            term_id: term(&a[6]),
            max_interest_bps: a[7].as_i64().unwrap(),
            expires_at: n(&a[8]),
            max_late_ms: n(&a[9]),
        },
        24 => AccountTx::LendingDisburse {
            loan_id: text(&a[1]),
            hub_entity_id: text(&a[2]),
            borrower_entity_id: text(&a[3]),
            token_id: token(n(&a[4]) as u32),
            amount: big(&a[5]),
            term_id: term(&a[6]),
            interest_bps: a[7].as_i64().unwrap(),
            request_id: text(&a[8]),
            max_interest_bps: a[9].as_i64().unwrap(),
            expires_at: n(&a[10]),
            max_late_ms: n(&a[11]),
            late_ms: n(&a[12]),
        },
        12 => AccountTx::LendingRepay {
            loan_id: text(&a[1]),
            hub_entity_id: text(&a[2]),
            borrower_entity_id: text(&a[3]),
            token_id: token(n(&a[4]) as u32),
            amount: big(&a[5]),
            claim_hash: text(&a[6]),
        },
        14 => AccountTx::LendingCloseRequest {
            position_id: text(&a[1]),
            hub_entity_id: text(&a[2]),
            lender_entity_id: text(&a[3]),
        },
        15 => AccountTx::LendingClosePayout {
            position_id: text(&a[1]),
            hub_entity_id: text(&a[2]),
            lender_entity_id: text(&a[3]),
            token_id: token(n(&a[4]) as u32),
            amount: big(&a[5]),
        },
        25 => AccountTx::LendingRate {
            position_id: text(&a[1]),
            hub_entity_id: text(&a[2]),
            lender_entity_id: text(&a[3]),
            token_id: token(n(&a[4]) as u32),
            claim_hash: text(&a[5]),
            interest_bps: a[6].as_i64().unwrap(),
        },
        _ => panic!("unknown tx {v}"),
    }
}
#[test]
fn typescript_lending_vectors_match_every_root_event_and_rejection() {
    let fixtures = lending_oracle::lending_oracle("account-semantics/lending-edges");
    let mut count = 0;
    for case in fixtures["cases"].as_array().unwrap() {
        let mut a = replica(
            entity(0x10),
            entity(0x10),
            entity(0x20),
            vec![delta(token(1), 20000, 10000, 0, 20000, 20000)],
        );
        for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            let label = format!("{} step {i}", case["name"]);
            let tx = tx(&step["txWire"]);
            let context =
                AccountExecutionContext::new(n(&step["timestamp"]), n(&step["timestamp"]), 0, 1, 0);
            let result = SequentialAccountEngine::apply_with_context(
                &a,
                if step["byLeft"] == true {
                    Side::Left
                } else {
                    Side::Right
                },
                &tx,
                &context,
            )
            .unwrap_or_else(|e| panic!("{label}: {e}"));
            let applied = matches!(result.verdict(), AccountVerdict::Applied);
            assert_eq!(
                applied,
                step["verdict"] == "applied",
                "{label}: {:?}",
                result.verdict()
            );
            if let AccountVerdict::Rejected(r) = result.verdict() {
                assert_eq!(
                    r.message(),
                    step["rejection"]["message"].as_str().unwrap(),
                    "{label}"
                );
                assert_eq!(
                    r.code(),
                    step["rejection"]["code"].as_str().unwrap(),
                    "{label}"
                );
            }
            assert_eq!(
                serde_json::json!(result.events()),
                step["events"],
                "{label}: events"
            );
            assert_eq!(
                result.outputs().len() as u64,
                n(&step["outputCount"]),
                "{label}"
            );
            if let Some(next) = result.committed() {
                a = next;
            }
            assert_eq!(
                format!("0x{}", hex::encode(a.state().carried().subcontracts_root)),
                step["subcontractsRoot"],
                "{label}: claims"
            );
            assert_eq!(
                format!("0x{}", hex::encode(a.state().deltas_root())),
                step["deltasRoot"],
                "{label}: deltas"
            );
            assert_eq!(
                format!(
                    "0x{}",
                    hex::encode(a.state().lending_intents_root().unwrap_or([0; 32]))
                ),
                step["lendingIntentsRoot"],
                "{label}: intents"
            );
            assert_eq!(
                format!(
                    "0x{}",
                    hex::encode(a.state().payment_profile_account_state_root().unwrap())
                ),
                step["accountStateRoot"],
                "{label}: account root"
            );
            assert_eq!(
                format!("0x{}", hex::encode(a.state().carried().subcontracts_root)),
                step["subcontractsRoot"],
                "{label}: claims"
            );
            assert_eq!(
                format!(
                    "0x{}",
                    hex::encode(proof_body_hash(&a, &[0x77; 20]).unwrap())
                ),
                step["proofBodyHash"],
                "{label}: dispute proof"
            );
            count += 1;
        }
    }
    for row in fixtures["arithmetic"].as_array().unwrap() {
        assert_eq!(
            lending::interest(
                &big(&row["principal"]),
                row["interestBps"].as_i64().unwrap()
            ),
            big(&row["interest"])
        );
    }
    println!("{count} TS lending transitions and 24 rounding vectors matched");
}

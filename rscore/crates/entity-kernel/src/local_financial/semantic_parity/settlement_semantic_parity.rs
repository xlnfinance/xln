//! Cross-engine semantic parity for the Entity settlement + dispute-start family.
//!
//! `settle_propose`, `settle_update`, `settle_approve`, `settle_reject`,
//! `settle_execute` and `disputeStart` were the six Entity transaction kinds
//! with no cross-engine vector, and the production H1 replay diverged inside
//! exactly that gap: a signed ProofBody offset is a Solidity
//! `Int512 { high, low }` tuple in TypeScript's `jBatchState`, while the Rust
//! canonical projection flattened it to one BigInt. The `disputeStart` case
//! below pins that section digest against the TypeScript oracle.
//!
//! Vector: `rscore/fixtures/entity-settlement/settlement-v1.json`
//! Oracle: `rscore/fixtures/entity-settlement/generate.ts`

use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;
use serde_json::Value;
use xln_rscore_batch::ResidentAccountDisputeView;
use xln_rscore_engine::{
    CounterpartyDispute, DisputeProofBody, DisputeTransformerClause, PreparedSettlementDiff,
    PreparedSettlementExecution, Side, TokenId,
};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use super::*;

const FIXTURE: &str = include_str!("../../../../../fixtures/entity-settlement/settlement-v1.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("TypeScript Entity settlement fixture")
}

/// `safeStringify` tagged JSON -> CanonicalValue, same mapping the other
/// fixture consumers use.
fn canonical(value: &Value) -> CanonicalValue {
    match value {
        Value::Null => CanonicalValue::Null,
        Value::Bool(value) => CanonicalValue::Bool(*value),
        Value::String(value) => CanonicalValue::String(value.clone()),
        Value::Number(value) => CanonicalValue::Number(
            CanonicalNumber::try_from_u64(value.as_u64().expect("fixture unsigned integer"))
                .expect("fixture safe integer"),
        ),
        Value::Array(values) => CanonicalValue::Array(values.iter().map(canonical).collect()),
        Value::Object(fields)
            if fields.get("__xlnType") == Some(&Value::String("BigInt".into())) =>
        {
            CanonicalValue::BigInt(
                fields["value"]
                    .as_str()
                    .expect("BigInt text")
                    .parse::<BigInt>()
                    .expect("BigInt"),
            )
        }
        Value::Object(fields) => CanonicalValue::Object(
            fields
                .iter()
                .map(|(key, value)| (key.clone(), canonical(value)))
                .collect(),
        ),
    }
}

fn text(value: &Value) -> String {
    value.as_str().expect("fixture text").to_string()
}

fn bytes(value: &Value) -> Vec<u8> {
    hex::decode(text(value).strip_prefix("0x").expect("0x")).expect("hex bytes")
}

fn word(value: &Value) -> [u8; 32] {
    bytes(value).try_into().expect("bytes32")
}

fn big(value: &Value) -> BigInt {
    match value {
        Value::Object(fields) if fields.contains_key("value") => fields["value"]
            .as_str()
            .expect("BigInt text")
            .parse()
            .expect("BigInt"),
        Value::Number(value) => BigInt::from(value.as_i64().expect("fixture integer")),
        other => panic!("fixture BigInt expected, got {other:?}"),
    }
}

fn case<'a>(fixture: &'a Value, name: &str) -> &'a Value {
    fixture["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| case["name"] == name)
        .unwrap_or_else(|| panic!("fixture case {name}"))
}

fn proof_body(value: &Value) -> DisputeProofBody {
    DisputeProofBody {
        watch_seed: word(&value["watchSeed"]),
        left_response_seconds: value["leftResponseSeconds"].as_u64().expect("left") as u32,
        right_response_seconds: value["rightResponseSeconds"].as_u64().expect("right") as u32,
        // TypeScript persists each offset as `Int512 { high, low }`; the Rust
        // ProofBody keeps the flat signed value and re-splits it on projection.
        offdeltas: value["offdeltas"]
            .as_array()
            .expect("offdeltas")
            .iter()
            .map(|row| (big(&row["high"]) << 256_u32) + big(&row["low"]))
            .collect(),
        token_ids: value["tokenIds"]
            .as_array()
            .expect("tokenIds")
            .iter()
            .map(|row| u32::try_from(big(row)).expect("token id fits u32"))
            .collect(),
        transformers: value["transformers"]
            .as_array()
            .expect("transformers")
            .iter()
            .map(|row| DisputeTransformerClause {
                transformer_address: bytes(&row["transformerAddress"])
                    .try_into()
                    .expect("address"),
                encoded_batch: bytes(&row["encodedBatch"]),
                allowances: Vec::new(),
            })
            .collect(),
    }
}

fn state_for(case: &Value) -> EntityStateSlice {
    let setup = &case["setup"];
    let mut state = EntityStateSlice::empty(
        text(&setup["entityId"]),
        setup["timestamp"].as_u64().expect("timestamp"),
    );
    state
        .known_accounts
        .insert(text(&setup["counterpartyEntityId"]));
    state
}

fn settlement_execution(value: &Value) -> Result<PreparedSettlementExecution, String> {
    if value.is_null() {
        return Err("fixture case has no executable settlement".into());
    }
    Ok(PreparedSettlementExecution {
        revision: value["revision"].as_u64().expect("revision"),
        workspace_hash: text(&value["workspaceHash"]),
        nonce: value["nonce"].as_u64().expect("nonce"),
        diffs: value["diffs"]
            .as_array()
            .expect("diffs")
            .iter()
            .map(|row| PreparedSettlementDiff {
                token_id: TokenId::new(row["tokenId"].as_u64().expect("tokenId") as u32)
                    .expect("token id"),
                left_diff: big(&row["leftDiff"]),
                right_diff: big(&row["rightDiff"]),
                collateral_diff: big(&row["collateralDiff"]),
                ondelta_diff: big(&row["ondeltaDiff"]),
            })
            .collect(),
        forgive_token_ids: value["forgiveTokenIds"]
            .as_array()
            .expect("forgiveTokenIds")
            .iter()
            .map(|row| {
                TokenId::new(row.as_u64().expect("token id") as u32).expect("forgive token id")
            })
            .collect(),
        counterparty_hanko: bytes(&value["counterpartyHanko"]),
    })
}

fn account_view(case: &Value) -> LocalAccountFinancialView {
    let view = &case["accountView"];
    let owner_is_left = view["ownerIsLeft"].as_bool().expect("ownerIsLeft");
    let dispute =
        view["counterpartyDispute"]
            .as_object()
            .map(|counterparty| ResidentAccountDisputeView {
                status: text(&view["status"]),
                dispute_prepare: (!view["disputePrepare"].is_null())
                    .then(|| canonical(&view["disputePrepare"])),
                active_dispute: None,
                local_dispute: None,
                counterparty_dispute: Some(CounterpartyDispute {
                    hanko: Some(bytes(&counterparty["hanko"])),
                    hash: [0; 32],
                    nonce: counterparty["nonce"].as_u64().expect("nonce"),
                    proof_body_hash: word(&counterparty["proofBodyHash"]),
                    proposer_is_left: counterparty["proposerIsLeft"]
                        .as_bool()
                        .expect("proposerIsLeft"),
                }),
                proof_body: Ok(proof_body(&case["evidence"]["proofBody"])),
                j_nonce: view["jNonce"].as_u64().expect("jNonce"),
                owner_is_left,
                delta_transformer: Some(
                    bytes(&case["setup"]["deltaTransformer"])
                        .try_into()
                        .expect("delta transformer"),
                ),
                payment_hashlocks: Vec::new(),
                pull_ids: Vec::new(),
                pull_count: 0,
                swap_offers: Vec::new(),
                pending_swap_fill_ratios: BTreeMap::new(),
            });
    LocalAccountFinancialView {
        active: true,
        owner_side: if owner_is_left {
            Side::Left
        } else {
            Side::Right
        },
        owner_out_capacity: BTreeMap::new(),
        owner_peer_credit_limit: BTreeMap::new(),
        settlement_workspace: (!view["settlementWorkspace"].is_null())
            .then(|| canonical(&view["settlementWorkspace"])),
        settlement_transition_pending: view["settlementTransitionPending"]
            .as_bool()
            .expect("settlementTransitionPending"),
        settlement_execution: settlement_execution(&view["settlementExecution"]),
        rebalance_active_quote: None,
        htlc_locks: BTreeMap::new(),
        pulls: BTreeMap::new(),
        swap_offers: BTreeMap::new(),
        pending_cross_pull_close_ids: BTreeSet::new(),
        dispute,
    }
}

fn transaction(case: &Value) -> LocalEntityFinancialTx {
    let data = &case["tx"]["data"];
    let counterparty = text(&data["counterpartyEntityId"]);
    let ops = || match canonical(&data["ops"]) {
        CanonicalValue::Array(values) => values,
        _ => panic!("fixture ops array"),
    };
    let memo = data.get("memo").map(text);
    match case["tx"]["type"].as_str().expect("tx type") {
        "settle_propose" => LocalEntityFinancialTx::SettlePropose(types::SettleProposeEntityTx {
            counterparty_entity_id: counterparty,
            ops: ops(),
            executor_is_left: data.get("executorIsLeft").and_then(Value::as_bool),
            memo,
            continuation: None,
        }),
        "settle_update" => LocalEntityFinancialTx::SettleUpdate(types::SettleUpdateEntityTx {
            counterparty_entity_id: counterparty,
            ops: ops(),
            executor_is_left: data.get("executorIsLeft").and_then(Value::as_bool),
            memo,
        }),
        "settle_approve" => LocalEntityFinancialTx::SettleApprove(types::SettleApproveEntityTx {
            counterparty_entity_id: counterparty,
            workspace_hash: text(&data["workspaceHash"]),
        }),
        "settle_reject" => LocalEntityFinancialTx::SettleReject(types::SettleRejectEntityTx {
            counterparty_entity_id: counterparty,
            reason: data.get("reason").map(text),
        }),
        "settle_execute" => LocalEntityFinancialTx::SettleExecute(types::SettleExecuteEntityTx {
            counterparty_entity_id: counterparty,
            disable_c2r_shortcut: data
                .get("disableC2RShortcut")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }),
        "disputeStart" => LocalEntityFinancialTx::DisputeStart(types::DisputeStartEntityTx {
            counterparty_entity_id: counterparty,
            description: data.get("description").map(text),
            cross_jurisdiction_route_id: None,
            starter_initial_arguments: None,
            starter_counter_arguments: None,
        }),
        other => panic!("unsupported settlement fixture case {other}"),
    }
}

fn assert_changed_sections(name: &str, case: &Value, state: &EntityStateSlice) {
    let actual = crate::compute_entity_owned_sections(state, [0; 32], 0).expect("owned sections");
    for field in case["changedSections"]
        .as_array()
        .expect("changedSections")
        .iter()
        .map(|field| field.as_str().expect("field"))
        // `accounts` moves through Account envelope mutations the caller applies
        // after this kernel returns, so it is asserted separately below.
        .filter(|field| *field != "accounts")
    {
        let expected = case["after"]["sections"]
            .as_array()
            .expect("sections")
            .iter()
            .find(|row| row["field"] == field)
            .and_then(|row| row["digest"].as_str())
            .expect("expected digest");
        let observed = actual
            .iter()
            .find(|row| row.field == field)
            .unwrap_or_else(|| panic!("{name}: section {field}"))
            .digest
            .as_str();
        assert_eq!(observed, expected, "{name}: {field}");
    }
}

fn run(case: &Value) -> LocalFinancialResult {
    let name = case["name"].as_str().expect("name");
    let mut state = state_for(case);
    let mut paybook = PaybookChanges::default();
    let views = BTreeMap::from([(
        text(&case["setup"]["counterpartyEntityId"]),
        account_view(case),
    )]);
    let result = apply_local_entity_financial_txs(
        &mut state,
        &mut paybook,
        vec![transaction(case)],
        &DeterministicContext::hlt_default(),
        &views,
        None,
        Some("entity-settlement-semantic-fixture"),
    )
    .unwrap_or_else(|error| panic!("{name}: {error}"));

    let expected_events = case["evidence"]["events"].as_array().expect("events");
    assert_eq!(result.events.len(), expected_events.len(), "{name}: events");
    for (observed, expected) in result.events.iter().zip(expected_events) {
        let EntityFrameEvent::Status { message } = observed else {
            panic!("{name}: expected status event")
        };
        assert_eq!(expected["type"], "status", "{name}: event kind");
        assert_eq!(
            message,
            expected["message"].as_str().expect("message"),
            "{name}: event"
        );
    }

    let expected_account_txs = case["evidence"]["accountTxs"]
        .as_array()
        .expect("accountTxs");
    assert_eq!(
        result.account_txs.len(),
        expected_account_txs.len(),
        "{name}: Account tx count"
    );
    for ((account_id, tx), expected) in result.account_txs.iter().zip(expected_account_txs) {
        assert_eq!(
            account_id,
            expected["accountId"].as_str().expect("accountId"),
            "{name}: Account target"
        );
        assert_eq!(
            tx.wire_name(),
            expected["tx"]["type"].as_str().expect("tx type"),
            "{name}: AccountTx kind"
        );
    }

    assert_changed_sections(name, case, &state);
    result
}

#[test]
fn settlement_workspace_entity_reducers_match_typescript() {
    let fixture = fixture();
    for name in [
        "settle_propose",
        "settle_update",
        "settle_approve",
        "settle_reject",
        "settle_execute",
    ] {
        let case = case(&fixture, name);
        let result = run(case);
        assert!(
            result.envelope_mutations.is_empty(),
            "{name}: settlement workspace transitions travel as Account txs"
        );
        assert!(result.outputs.is_empty(), "{name}: no runtime effects");
    }
}

/// The exact production regression: a `disputeStart` whose signed ProofBody
/// carries non-zero, both-sign offsets must reproduce TypeScript's
/// `jBatchState` section digest byte for byte.
#[test]
fn dispute_start_jbatch_section_matches_typescript_int512_offsets() {
    let fixture = fixture();
    let case = case(&fixture, "disputeStart");
    let result = run(case);

    let expected_row = &case["jBatchState"]["batch"]["disputeStarts"][0];

    // One `replaceDisputeLifecycle` mutation, mirroring the TypeScript envelope
    // update the caller applies to the Account after the kernel returns.
    assert!(
        matches!(
            result.envelope_mutations.as_slice(),
            [(account_id, AccountEnvelopeMutation::ReplaceDisputeLifecycle { status, dispute_prepare, active_dispute })]
                if account_id == case["setup"]["counterpartyEntityId"].as_str().unwrap()
                    && status == "disputed"
                    && dispute_prepare.is_none()
                    && active_dispute.is_some()
        ),
        "disputeStart: exact Account envelope mutation"
    );

    // The fixture row is the TypeScript jBatch draft: two-limb offsets included.
    let offsets = expected_row["initialProofbody"]["offdeltas"]
        .as_array()
        .expect("offdeltas");
    assert_eq!(offsets.len(), 3, "fixture pins three token offsets");
    assert!(
        offsets
            .iter()
            .all(|row| row.get("high").is_some() && row.get("low").is_some()),
        "TypeScript persists Int512 limbs, never a flat integer"
    );
}

#[test]
fn actual_native_withdrawal_continuation_waits_for_ack_then_derives_exact_order() {
    let recorded: Value = serde_json::from_str(include_str!(
        "../../../../../fixtures/entity-settlement/native-continuation-frame62.json"
    ))
    .expect("actual native WAL62 projection");
    let peer = text(&recorded["continuation"][0]);
    let continuation = canonical(&recorded["continuation"][1]);
    let state = EntityStateSlice::empty(text(&recorded["entityId"]), 1791408516239);
    let mut view = account_view(case(&fixture(), "settle_execute"));
    view.settlement_workspace = Some(canonical(&recorded["workspace"]));
    view.settlement_transition_pending = false;
    let mut views = BTreeMap::from([(peer.clone(), view)]);
    let choose = |views: &BTreeMap<String, LocalAccountFinancialView>, queued| {
        select_continuation(
            &state,
            &peer,
            &continuation,
            views,
            queued,
            "local-validator",
        )
    };
    let ContinuationDisposition::Execute(txs) =
        choose(&views, false).expect("ready signed withdrawal")
    else {
        panic!("execute")
    };
    assert_eq!(txs.len(), 3);
    assert!(
        matches!(&txs[0].tx, crate::LocalEntityTx::Financial(LocalEntityFinancialTx::SettleExecute(tx)) if tx.disable_c2r_shortcut && tx.counterparty_entity_id == peer)
    );
    assert!(matches!(
        &txs[1].tx,
        crate::LocalEntityTx::Control(crate::LocalEntityControlTx::R2e { .. })
    ));
    assert!(matches!(
        &txs[2].tx,
        crate::LocalEntityTx::Control(crate::LocalEntityControlTx::JBroadcast { .. })
    ));
    views.get_mut(&peer).expect("peer").settlement_workspace = None;
    assert!(matches!(
        choose(&views, true).expect("queued transition"),
        ContinuationDisposition::Wait
    ));
    assert!(matches!(
        choose(&views, false).expect("absent workspace"),
        ContinuationDisposition::Discard("workspace missing")
    ));
    views
        .get_mut(&peer)
        .expect("peer")
        .settlement_transition_pending = true;
    assert!(matches!(
        choose(&views, false).expect("unacked transition"),
        ContinuationDisposition::Wait
    ));
}

#[test]
fn settlement_propose_and_unsigned_update_reject_invalid_sender_ops() {
    let fixture = fixture();
    for kind in ["settle_propose", "settle_update"] {
        for (ops, reason) in [
            (
                serde_json::json!([{"type":"r2r","tokenId":1,"amount":{"__xlnType":"BigInt","value":"-1"}}]),
                "SETTLEMENT_WORKSPACE_AMOUNT_INVALID",
            ),
            (
                serde_json::json!([{"type":"r2r","tokenId":65536,"amount":{"__xlnType":"BigInt","value":"1"}}]),
                "SETTLEMENT_TOKEN_INVALID",
            ),
            (serde_json::json!([]), "SETTLEMENT_WORKSPACE_OPS_EMPTY"),
        ] {
            let mut vector = case(&fixture, kind).clone();
            vector["tx"]["data"]["ops"] = ops;
            let mut state = state_for(&vector);
            let before = state.clone();
            let views = BTreeMap::from([(
                text(&vector["setup"]["counterpartyEntityId"]),
                account_view(&vector),
            )]);
            let result = apply_local_entity_financial_txs(
                &mut state,
                &mut PaybookChanges::default(),
                vec![transaction(&vector)],
                &DeterministicContext::hlt_default(),
                &views,
                None,
                Some("entity-settlement-semantic-fixture"),
            );
            let error = result
                .err()
                .unwrap_or_else(|| {
                    panic!("{kind}:{reason}: invalid sender ops created Account work")
                })
                .into_user_reject();
            assert!(
                matches!(&error, EntityKernelError::RejectedEntityTx { detail, .. } if detail.starts_with(reason)),
                "{kind}:{reason}:{error}"
            );
            assert_eq!(
                state, before,
                "{kind}:{reason}: no partial financial mutation"
            );
        }
    }
}

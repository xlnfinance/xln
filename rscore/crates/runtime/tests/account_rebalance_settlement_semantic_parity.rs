use std::sync::Arc;

use num_bigint::BigInt;
use serde::Deserialize;
use serde_json::Value;
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountExecutionContext, AccountIdentity, AccountReplica,
    AccountState, AccountTx, AccountVerdict, CanonicalValue, Delta, DepositoryAddress, EntityId,
    RebalanceRefundReason, SequentialAccountEngine, Side, SwapMarketPolicy, TokenId, WatchSeed,
};
use xln_rscore_runtime::canonical_value_from_tagged_json;

const FIXTURE: &str =
    include_str!("../../../fixtures/account-semantics/rebalance-settlement-v1.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    version: u64,
    canonical_source: String,
    inputs: Value,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    steps: Vec<ExpectedStep>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedStep {
    input: String,
    tx_type: String,
    by_left: bool,
    timestamp: u64,
    account_state_root: String,
    deltas_root: String,
    requested_rebalance_root: String,
    requested_rebalance_fee_state_root: String,
    requested_amount: String,
    requested_count: usize,
    fee_state_count: usize,
    offdelta: String,
    left_hold: String,
    right_hold: String,
    workspace_hash: Option<String>,
    events: Vec<String>,
    output_count: usize,
}

fn entity(byte: u8) -> EntityId {
    EntityId::parse(&format!("0x{}", format!("{byte:02x}").repeat(32))).expect("fixture Entity")
}

fn account() -> AccountReplica {
    let left = entity(0x11);
    let identity = AccountIdentity::new(
        AccountDomain::new(
            31_337,
            DepositoryAddress::parse(&format!("0x{}", "88".repeat(20)))
                .expect("fixture depository"),
        )
        .expect("fixture domain"),
        left.clone(),
        entity(0x22),
        WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("fixture watch seed"),
    )
    .expect("fixture identity");
    let delta = Delta::new(
        TokenId::new(1).expect("fixture token"),
        1_000.into(),
        0.into(),
        0.into(),
        1_000.into(),
        1_000.into(),
        0.into(),
        0.into(),
        0.into(),
        0.into(),
    )
    .expect("fixture delta");
    AccountReplica::new(
        left,
        AccountState::new(
            identity,
            AccountDisputeConfig::new(10, 10).expect("fixture dispute config"),
            vec![delta],
        )
        .expect("fixture state"),
    )
    .expect("fixture replica")
}

fn bigint(value: &Value, field: &str) -> BigInt {
    value[field]["value"]
        .as_str()
        .unwrap_or_else(|| panic!("fixture BigInt {field}"))
        .parse()
        .expect("fixture BigInt")
}

fn tx(input: &Value, expected_type: &str) -> AccountTx {
    let data = &input["data"];
    match expected_type {
        "request_collateral" => AccountTx::RequestCollateral {
            token_id: TokenId::new(data["tokenId"].as_u64().expect("token") as u32).expect("token"),
            amount: bigint(data, "amount"),
            fee_token_id: Some(
                TokenId::new(data["feeTokenId"].as_u64().expect("fee token") as u32)
                    .expect("fee token"),
            ),
            fee_amount: bigint(data, "feeAmount"),
            policy_version: data["policyVersion"].as_u64().expect("policy version"),
        },
        "rebalance_refund" => AccountTx::RebalanceRefund {
            request_id: data["requestId"].as_str().expect("request id").into(),
            request_token_id: TokenId::new(
                data["requestTokenId"].as_u64().expect("request token") as u32
            )
            .expect("request token"),
            amount: bigint(data, "amount"),
            reason: match data["reason"].as_str().expect("refund reason") {
                "timeout" => RebalanceRefundReason::Timeout,
                other => panic!("unsupported refund reason {other}"),
            },
        },
        "settle_transition" => AccountTx::SettleTransition {
            data: canonical_value_from_tagged_json(data).expect("settlement data"),
        },
        other => panic!("unsupported fixture AccountTx {other}"),
    }
}

fn root(bytes: [u8; 32]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn workspace_hash(value: Option<&CanonicalValue>) -> Option<String> {
    let CanonicalValue::Object(fields) = value? else {
        panic!("settlement workspace must be an object")
    };
    fields.iter().find_map(|(name, value)| {
        (name == "workspaceHash").then(|| match value {
            CanonicalValue::String(hash) => hash.clone(),
            _ => panic!("workspaceHash must be a string"),
        })
    })
}

fn apply_step(
    account: &mut AccountReplica,
    input: &Value,
    expected: &ExpectedStep,
    assert_outputs: bool,
) {
    let transaction = tx(input, &expected.tx_type);
    assert_eq!(transaction.wire_name(), expected.tx_type);
    let side = if expected.by_left {
        Side::Left
    } else {
        Side::Right
    };
    let context = AccountExecutionContext::with_market(
        expected.timestamp,
        expected.timestamp,
        4,
        4,
        4,
        Arc::new(SwapMarketPolicy::default()),
    );
    let transition =
        SequentialAccountEngine::apply_with_context(account, side, &transaction, &context)
            .expect("shared rebalance/settlement transition");
    assert_eq!(transition.verdict(), &AccountVerdict::Applied);
    assert_eq!(transition.events(), expected.events);
    let output_count = transition.outputs().len();
    let candidate = transition.committed().expect("shared candidate");
    let state = candidate.state();
    assert_eq!(root(state.deltas_root()), expected.deltas_root);
    assert_eq!(
        root(state.requested_rebalance_root()),
        expected.requested_rebalance_root
    );
    assert_eq!(
        root(state.requested_rebalance_fee_state_root()),
        expected.requested_rebalance_fee_state_root
    );
    assert_eq!(
        root(
            state
                .payment_profile_account_state_root()
                .expect("state root")
        ),
        expected.account_state_root,
        "{} Account root",
        expected.input
    );
    assert_eq!(state.requested_rebalance_count(), expected.requested_count);
    assert_eq!(
        state.requested_rebalance_fee_state_count(),
        expected.fee_state_count
    );
    assert_eq!(
        state
            .requested_rebalance(TokenId::new(1).expect("token"))
            .cloned()
            .unwrap_or_default()
            .to_string(),
        expected.requested_amount
    );
    let delta = state.delta(TokenId::new(1).expect("token")).expect("delta");
    assert_eq!(delta.offdelta().to_string(), expected.offdelta);
    assert_eq!(delta.hold(Side::Left).to_string(), expected.left_hold);
    assert_eq!(delta.hold(Side::Right).to_string(), expected.right_hold);
    assert_eq!(
        workspace_hash(state.settlement_workspace()),
        expected.workspace_hash
    );
    if assert_outputs {
        assert_eq!(
            output_count, expected.output_count,
            "{} outputs",
            expected.input
        );
    }
    *account = candidate;
}

#[test]
fn request_collateral_matches_the_shared_typescript_vector() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("shared fixture");
    assert_eq!(fixture.version, 1);
    assert_eq!(
        fixture.canonical_source,
        "TypeScript applyAccountTxToMutableReplica"
    );
    let test_case = fixture
        .cases
        .iter()
        .find(|test_case| test_case.name == "rebalance-request-refund")
        .expect("rebalance fixture case");
    let expected = test_case.steps.first().expect("request step");
    let mut replica = account();
    apply_step(
        &mut replica,
        &fixture.inputs[&expected.input],
        expected,
        true,
    );
}

#[test]
fn rebalance_refund_matches_the_shared_typescript_vector() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("shared fixture");
    let test_case = fixture
        .cases
        .iter()
        .find(|test_case| test_case.name == "rebalance-request-refund")
        .expect("rebalance fixture case");
    let mut replica = account();
    for (index, expected) in test_case.steps.iter().enumerate() {
        apply_step(
            &mut replica,
            &fixture.inputs[&expected.input],
            expected,
            index != 0,
        );
    }
}

#[test]
fn settle_transition_matches_the_shared_typescript_vector() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("shared fixture");
    let test_case = fixture
        .cases
        .iter()
        .find(|test_case| test_case.name == "settlement-upsert")
        .expect("settlement fixture case");
    let mut replica = account();
    for expected in &test_case.steps {
        apply_step(
            &mut replica,
            &fixture.inputs[&expected.input],
            expected,
            true,
        );
    }
}

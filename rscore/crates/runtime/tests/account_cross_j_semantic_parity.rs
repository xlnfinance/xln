use std::sync::Arc;

use num_bigint::BigInt;
use serde::Deserialize;
use serde_json::Value;
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountExecutionContext, AccountIdentity,
    AccountRejection, AccountReplica, AccountState, AccountTx, AccountVerdict, Delta,
    DepositoryAddress, EntityId, SequentialAccountEngine, Side, SwapMarketPolicy, SwapToken,
    TokenId, ValidationRejection, WatchSeed,
};
use xln_rscore_runtime::canonical_value_from_tagged_json;

const FIXTURE: &str = include_str!("../../../fixtures/account-semantics/cross-j-v1.json");
const ROUTE_HASH_FIXTURE: &str =
    include_str!("../../../fixtures/account-semantics/cross-j-route-hash-v1.json");

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
    height: u64,
    account_state_root: String,
    deltas_root: String,
    pulls_root: String,
    swap_offers_root: String,
    offdelta: String,
    left_hold: String,
    right_hold: String,
    pull_count: usize,
    offer_count: usize,
    events: Vec<String>,
    output_count: usize,
}

fn entity(byte: u8) -> EntityId {
    EntityId::parse(&format!("0x{}", format!("{byte:02x}").repeat(32))).expect("fixture Entity")
}

fn account(source: bool, high_capacity: bool) -> AccountReplica {
    let (left, right, token, chain, depository) = if source {
        (entity(0x11), entity(0x22), 1, 31_337, 0x88)
    } else {
        (entity(0x33), entity(0x44), 2, 31_338, 0x77)
    };
    let identity = AccountIdentity::new(
        AccountDomain::new(
            chain,
            DepositoryAddress::parse(&format!("0x{}", format!("{depository:02x}").repeat(20)))
                .expect("fixture depository"),
        )
        .expect("fixture domain"),
        left.clone(),
        right,
        WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("fixture watch seed"),
    )
    .expect("fixture identity");
    let delta = Delta::new(
        TokenId::new(token).expect("fixture token"),
        (if high_capacity { 100_000_000 } else { 100 }).into(),
        0.into(),
        0.into(),
        (if high_capacity {
            100_000_000_000_000_000i64
        } else {
            1_000
        })
        .into(),
        (if high_capacity {
            100_000_000_000_000_000i64
        } else {
            1_000
        })
        .into(),
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
    let canonical = || canonical_value_from_tagged_json(data).expect("canonical AccountTx data");
    match expected_type {
        "cross_pull_lock" => AccountTx::CrossPullLock { data: canonical() },
        "cross_pull_close" => AccountTx::CrossPullClose { data: canonical() },
        "swap_offer" => AccountTx::SwapOffer {
            offer_id: data["offerId"].as_str().expect("offer id").to_string(),
            give_token_id: data["giveTokenId"].as_u64().expect("give token") as u32,
            give_token_decimals: data["giveTokenDecimals"].as_u64().expect("give decimals") as u32,
            give_amount: bigint(data, "giveAmount"),
            want_token_id: data["wantTokenId"].as_u64().expect("want token") as u32,
            want_token_decimals: data["wantTokenDecimals"].as_u64().expect("want decimals") as u32,
            want_amount: bigint(data, "wantAmount"),
            max_fee: bigint(data, "maxFee"),
            min_net_receive: bigint(data, "minNetReceive"),
            time_in_force: None,
            price_ticks: Some(bigint(data, "priceTicks")),
            cross_jurisdiction: Some(
                canonical_value_from_tagged_json(&data["crossJurisdiction"])
                    .expect("canonical cross-J route"),
            ),
        },
        other => panic!("unsupported fixture AccountTx {other}"),
    }
}

fn root(bytes: [u8; 32]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn context(timestamp: u64, height: u64) -> AccountExecutionContext {
    AccountExecutionContext::with_market(
        timestamp,
        timestamp,
        height,
        height,
        height,
        Arc::new(SwapMarketPolicy::new(
            vec![
                SwapToken {
                    token_id: 1,
                    decimals: 6,
                    liquid: true,
                },
                SwapToken {
                    token_id: 2,
                    decimals: 6,
                    liquid: false,
                },
            ],
            Vec::new(),
        )),
    )
}

fn assert_step(account: &mut AccountReplica, input: &Value, expected: &ExpectedStep, token: u32) {
    let transaction = tx(input, &expected.tx_type);
    assert_eq!(transaction.wire_name(), expected.tx_type);
    let side = if expected.by_left {
        Side::Left
    } else {
        Side::Right
    };
    let context = context(expected.timestamp, expected.height);
    let transition =
        SequentialAccountEngine::apply_with_context(account, side, &transaction, &context)
            .expect("shared cross-J transition");
    assert_eq!(transition.verdict(), &AccountVerdict::Applied);
    assert_eq!(transition.events(), expected.events);
    assert_eq!(transition.outputs().len(), expected.output_count);
    let candidate = transition.committed().expect("shared candidate");
    let state = candidate.state();
    assert_eq!(
        root(state.deltas_root()),
        expected.deltas_root,
        "{} deltas",
        expected.input
    );
    assert_eq!(
        root(state.pulls_root()),
        expected.pulls_root,
        "{} pulls",
        expected.input
    );
    assert_eq!(
        root(state.swap_offers_root()),
        expected.swap_offers_root,
        "{} offers",
        expected.input
    );
    assert_eq!(
        root(
            state
                .payment_profile_account_state_root()
                .expect("state root")
        ),
        expected.account_state_root,
        "{} Account root",
        expected.input,
    );
    assert_eq!(state.pull_count(), expected.pull_count);
    assert_eq!(state.swap_offer_count(), expected.offer_count);
    let delta = state
        .delta(TokenId::new(token).expect("token"))
        .expect("delta");
    assert_eq!(delta.offdelta().to_string(), expected.offdelta);
    assert_eq!(delta.hold(Side::Left).to_string(), expected.left_hold);
    assert_eq!(delta.hold(Side::Right).to_string(), expected.right_hold);
    *account = candidate;
}

#[test]
fn cross_j_account_transitions_match_the_shared_typescript_vector() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("shared cross-J fixture");
    assert_eq!(fixture.version, 1);
    assert_eq!(
        fixture.canonical_source,
        "TypeScript applyAccountTxToMutableReplica"
    );
    for test_case in fixture.cases {
        let source = test_case.name.starts_with("source");
        let token = if source { 1 } else { 2 };
        let mut replica = account(source, test_case.name == "source-buyer-price-improvement");
        for expected in test_case.steps {
            let input = &fixture.inputs[&expected.input];
            assert_step(&mut replica, input, &expected, token);
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RouteHashFixture {
    version: u64,
    canonical_source: String,
    inputs: Value,
    cases: Vec<RouteHashCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RouteHashCase {
    name: String,
    input: String,
    account_state_root: String,
    rejection_code: String,
    rejection: String,
}

/// Parity target: rscore/fixtures/account-semantics/cross-j-route-hash.ts.
/// Rust recomputes the canonical route hash exactly as TypeScript
/// `validateCrossJurisdictionSourceBinding`: a changed claim and a changed
/// hashed field under the pull-bound claim are the same typed rejection.
/// Missing/unknown route keys and malformed nested fields reject before
/// canonicalization, preserving the Account and the TypeScript error text.
#[test]
fn non_canonical_cross_j_offer_route_hash_matches_the_typescript_rejection() {
    let fixture: RouteHashFixture =
        serde_json::from_str(ROUTE_HASH_FIXTURE).expect("shared route-hash fixture");
    assert_eq!(fixture.version, 1);
    assert_eq!(
        fixture.canonical_source,
        "TypeScript applyAccountTxToMutableReplica"
    );
    assert_eq!(fixture.cases.len(), 5);
    for test_case in fixture.cases {
        assert_eq!(test_case.rejection_code, "ACCOUNT_TX_VALIDATION");
        let mut replica = account(true, false);
        let lock = tx(&fixture.inputs["sourceLock"], "cross_pull_lock");
        let locked = SequentialAccountEngine::apply_with_context(
            &replica,
            Side::Right,
            &lock,
            &context(1_000, 10),
        )
        .expect("source lock");
        assert_eq!(locked.verdict(), &AccountVerdict::Applied);
        replica = locked.committed().expect("locked candidate");
        let before = root(
            replica
                .state()
                .payment_profile_account_state_root()
                .expect("state root"),
        );
        assert_eq!(before, test_case.account_state_root, "{}", test_case.name);
        let offer = tx(&fixture.inputs[&test_case.input], "swap_offer");
        let rejected = SequentialAccountEngine::apply_with_context(
            &replica,
            Side::Left,
            &offer,
            &context(1_000, 10),
        )
        .expect("route mismatch is a rejection, not an engine error");
        assert!(
            matches!(
                rejected.verdict(),
                AccountVerdict::Rejected(AccountRejection::Validation(
                    ValidationRejection::AccountTx { message }
                )) if *message == test_case.rejection
            ),
            "{}: {:?}",
            test_case.name,
            rejected.verdict()
        );
        assert!(rejected.candidate().is_none(), "{}", test_case.name);
    }
}

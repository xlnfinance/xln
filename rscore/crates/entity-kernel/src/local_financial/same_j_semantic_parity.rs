use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;
use serde::Deserialize;
use sha3::{Digest as _, Keccak256};
use xln_rscore_batch::{
    AccountId, EntityAccountGenesisPolicy, LocalGenesisSeedParams, build_local_genesis_seed,
};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, DepositoryAddress, HtlcHashlock, HtlcLock, LendingTermId,
    OpaqueHtlcCiphertext, Side, TokenId, WatchSeed, canonical_tx_digest,
};

use super::*;
use crate::local_financial::types::{
    LendingBorrowEntityTx, LendingClosePositionEntityTx, LendingOfferEntityTx,
    LendingRepayEntityTx, PlaceSwapOfferEntityTx, ProposeCancelSwapEntityTx,
    RequestCollateralEntityTx, SetRebalancePolicyEntityTx,
};

const FIXTURE: &str = include_str!("../../../../fixtures/entity-kernel/same-j-financial-v1.json");
const OWNER: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
const PEER: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    version: u64,
    canonical_source: String,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    account_ids: Vec<String>,
    account_tx_types: Vec<String>,
    account_tx_digests: Vec<String>,
    wake_targets: Vec<String>,
    events: Vec<Event>,
    prepared_tx_hash: Option<String>,
    runtime_effects: Option<Vec<serde_json::Value>>,
    paybook_entry: Option<serde_json::Value>,
    account_create_state_root: Option<String>,
}

#[derive(Deserialize)]
struct Event {
    #[serde(rename = "type")]
    kind: String,
    message: String,
}

fn token(value: u32) -> TokenId {
    TokenId::new(value).expect("fixture token")
}

fn state(has_account: bool) -> EntityStateSlice {
    let mut state = EntityStateSlice::empty(OWNER.to_string(), 1_000);
    if has_account {
        state.known_accounts.insert(PEER.to_string());
    }
    state
}

fn account_view() -> LocalAccountFinancialView {
    LocalAccountFinancialView {
        active: true,
        owner_side: Side::Left,
        owner_out_capacity: BTreeMap::from([
            (token(1), BigInt::from(10_000)),
            (token(2), BigInt::from(10_000)),
        ]),
        owner_peer_credit_limit: BTreeMap::new(),
        settlement_workspace: None,
        settlement_transition_pending: false,
        settlement_execution: Err("fixture has no settlement".into()),
        rebalance_active_quote: None,
        htlc_locks: BTreeMap::new(),
        pulls: BTreeMap::new(),
        swap_offers: BTreeMap::new(),
        pending_cross_pull_close_ids: BTreeSet::new(),
        dispute: None,
    }
}

fn transaction(name: &str) -> LocalEntityFinancialTx {
    match name {
        "lendingOffer" => LocalEntityFinancialTx::LendingOffer(LendingOfferEntityTx {
            position_id: "lend-1111111111111111".into(),
            hub_entity_id: PEER.into(),
            token_id: token(1),
            amount: BigInt::from(10_000),
            term_id: LendingTermId::OneDay,
            interest_bps: 100,
        }),
        "lendingBorrow" => LocalEntityFinancialTx::LendingBorrow(LendingBorrowEntityTx {
            request_id: "borrow-2222222222222222".into(),
            hub_entity_id: PEER.into(),
            token_id: 1,
            amount: BigInt::from(2_500),
            term_id: LendingTermId::OneDay,
            max_interest_bps: 150,
        }),
        "lendingRepay" => LocalEntityFinancialTx::LendingRepay(LendingRepayEntityTx {
            hub_entity_id: PEER.into(),
            loan_id: "loan-0327fd9035d42518".into(),
            token_id: token(1),
            amount: BigInt::from(2_525),
        }),
        "lendingClosePosition" => {
            LocalEntityFinancialTx::LendingClosePosition(LendingClosePositionEntityTx {
                hub_entity_id: PEER.into(),
                position_id: "lend-1111111111111111".into(),
            })
        }
        "placeSwapOffer" => LocalEntityFinancialTx::PlaceSwapOffer(PlaceSwapOfferEntityTx {
            counterparty_entity_id: PEER.into(),
            offer_id: "offer-1".into(),
            give_token_id: 2,
            give_token_decimals: 18,
            give_amount: BigInt::from(1_000_000_000_000_000_000_u64),
            want_token_id: 1,
            want_token_decimals: 6,
            want_amount: BigInt::from(2_500_000),
            max_fee: BigInt::from(25_000),
            min_net_receive: BigInt::from(2_475_000),
            price_ticks: Some(BigInt::from(25_000)),
            time_in_force: Some(0),
        }),
        "proposeCancelSwap" => {
            LocalEntityFinancialTx::ProposeCancelSwap(ProposeCancelSwapEntityTx {
                counterparty_entity_id: PEER.into(),
                offer_id: "offer-1".into(),
            })
        }
        "requestCollateral" => {
            LocalEntityFinancialTx::RequestCollateral(RequestCollateralEntityTx {
                counterparty_entity_id: PEER.into(),
                token_id: token(1),
                amount: BigInt::from(100),
                fee_token_id: Some(token(2)),
                fee_amount: BigInt::from(3),
                policy_version: 7,
            })
        }
        "setRebalancePolicy" => {
            LocalEntityFinancialTx::SetRebalancePolicy(SetRebalancePolicyEntityTx {
                counterparty_entity_id: PEER.into(),
                token_id: token(1),
                r2c_request_soft_limit: BigInt::from(50),
                hard_limit: BigInt::from(100),
                max_acceptable_fee: BigInt::from(5),
            })
        }
        "resolveHtlcLock" => LocalEntityFinancialTx::ResolveHtlcLock(
            crate::local_financial::types::ResolveHtlcLockEntityTx {
                counterparty_entity_id: PEER.into(),
                lock_id: hashlock(),
                secret: format!("0x{}", "55".repeat(32)),
                cross_jurisdiction_route_id: None,
                description: None,
            },
        ),
        "openAccount" => LocalEntityFinancialTx::OpenAccount(
            crate::local_financial::types::OpenAccountEntityTx {
                target_entity_id: PEER.into(),
                dispute_config: AccountDisputeConfig::new(10, 20).expect("dispute"),
                account_domain: account_domain(),
                watch_seed: WatchSeed::parse(&format!("0x{}", "44".repeat(32))).expect("watch"),
                credit_amount: Some(BigInt::from(7)),
                token_id: token(1),
                pin_public: true,
                rebalance_policy: None,
            },
        ),
        other => panic!("unsupported same-j fixture case {other}"),
    }
}

fn hashlock() -> String {
    format!("0x{}", hex::encode(Keccak256::digest([0x55_u8; 32])))
}

fn account_domain() -> AccountDomain {
    AccountDomain::new(
        31_337,
        DepositoryAddress::parse(&format!("0x{}", "88".repeat(20))).expect("depository"),
    )
    .expect("domain")
}

fn policy_value(soft: BigInt, hard: BigInt, fee: BigInt) -> xln_rscore_protocol::CanonicalValue {
    xln_rscore_protocol::CanonicalValue::Object(vec![
        (
            "r2cRequestSoftLimit".into(),
            xln_rscore_protocol::CanonicalValue::BigInt(soft),
        ),
        (
            "hardLimit".into(),
            xln_rscore_protocol::CanonicalValue::BigInt(hard),
        ),
        (
            "maxAcceptableFee".into(),
            xln_rscore_protocol::CanonicalValue::BigInt(fee),
        ),
    ])
}

fn open_policy() -> EntityAccountGenesisPolicy {
    let owner = xln_rscore_engine::EntityId::parse(OWNER).expect("owner");
    let peer = xln_rscore_engine::EntityId::parse(PEER).expect("peer");
    let dispute = AccountDisputeConfig::new(10, 20).expect("dispute");
    let rows = vec![
        (
            1,
            policy_value(
                500_000_000.into(),
                10_000_000_000_u64.into(),
                15_000_000.into(),
            ),
        ),
        (
            3,
            policy_value(
                500_000_000.into(),
                10_000_000_000_u64.into(),
                15_000_000.into(),
            ),
        ),
        (
            2,
            policy_value(
                BigInt::parse_bytes(b"500000000000000000000", 10).expect("soft"),
                BigInt::parse_bytes(b"10000000000000000000000", 10).expect("hard"),
                BigInt::parse_bytes(b"15000000000000000000", 10).expect("fee"),
            ),
        ),
    ];
    let reference = build_local_genesis_seed(LocalGenesisSeedParams {
        owner_entity_id: *owner.as_bytes(),
        account_id: AccountId::from_bytes(*peer.as_bytes()),
        domain: account_domain(),
        watch_seed: WatchSeed::parse(&format!("0x{}", "44".repeat(32))).expect("watch"),
        dispute_config: dispute,
        delta_transformer: [0x55; 20],
        public_pinned: true,
        policy_rows: rows.clone(),
    })
    .expect("reference");
    EntityAccountGenesisPolicy {
        expected_domain: account_domain(),
        shadow_policy_root: reference.replica.envelope().rebalance_shadow_policy_root(),
        shadow_policy_rows: rows,
        delta_transformer: [0x55; 20],
        public_pinned: true,
    }
}

fn context_for(expected: &Case) -> DeterministicContext {
    let mut context = DeterministicContext::hlt_default();
    if expected.name != "htlcPayment" {
        return context;
    }
    let tx_hash = expected.prepared_tx_hash.clone().expect("prepared tx hash");
    context.originated_htlcs.insert(
        tx_hash.clone(),
        crate::PreparedOriginatedHtlcPayment {
            tx_hash,
            target_entity_id: PEER.into(),
            token_id: 1,
            recipient_amount: BigInt::from(100),
            route: vec![OWNER.into(), PEER.into()],
            description: "note".into(),
            delivery_mode: crate::OriginatedHtlcDeliveryMode::Instant,
            started_at_ms: 1_000,
            hashlock: hashlock(),
            sender_lock_amount: BigInt::from(110),
            max_sender_debit: BigInt::from(120),
            total_fee: BigInt::from(10),
            timelock: BigInt::from(2_000),
            reveal_before_height: 50,
            next_hop_entity_id: PEER.into(),
            envelope: OpaqueHtlcCiphertext::from_packed(vec![0x44; 48]).expect("envelope"),
        },
    );
    context
}

fn transaction_for(expected: &Case) -> LocalEntityFinancialTx {
    if expected.name == "htlcPayment" {
        return LocalEntityFinancialTx::HtlcPayment(
            crate::local_financial::types::HtlcPaymentEntityTx {
                target_entity_id: PEER.into(),
                token_id: token(1),
                amount: BigInt::from(100),
                max_sender_debit: BigInt::from(120),
                route: vec![OWNER.into(), PEER.into()],
                description: Some("note".into()),
                delivery_mode: crate::OriginatedHtlcDeliveryMode::Instant,
                started_at_ms: Some(1_000),
                hashlock: Some(hashlock()),
                tx_hash: expected.prepared_tx_hash.clone().expect("prepared tx hash"),
            },
        );
    }
    transaction(&expected.name)
}

fn account_view_for(name: &str) -> LocalAccountFinancialView {
    let mut view = account_view();
    if name == "resolveHtlcLock" {
        let lock_id = hashlock();
        let lock = HtlcLock::restore(
            lock_id.clone(),
            HtlcHashlock::parse(&lock_id).expect("hashlock"),
            BigInt::from(100),
            10,
            BigInt::from(7),
            token(1),
            Side::Right,
            1,
            2,
            None,
        )
        .expect("lock");
        view.htlc_locks.insert(lock_id, lock);
    }
    view
}

fn hex(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

#[test]
fn same_j_financial_entity_projections_match_typescript() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("shared fixture");
    assert_eq!(fixture.version, 1);
    assert_eq!(
        fixture.canonical_source,
        "TypeScript Entity production handlers"
    );
    for expected in fixture.cases {
        let mut state = state(expected.name != "openAccount");
        let mut paybook = PaybookChanges::default();
        let context = context_for(&expected);
        let account_views = BTreeMap::from([(PEER.to_string(), account_view_for(&expected.name))]);
        let policy = (expected.name == "openAccount").then(open_policy);
        let result = apply_local_entity_financial_txs(
            &mut state,
            &mut paybook,
            vec![transaction_for(&expected)],
            &context,
            &account_views,
            policy.as_ref(),
            None,
        )
        .unwrap_or_else(|error| panic!("{}: {error}", expected.name));
        assert_eq!(
            result
                .account_txs
                .iter()
                .map(|(account_id, _)| account_id.clone())
                .collect::<Vec<_>>(),
            expected.account_ids,
            "{} Account targets",
            expected.name
        );
        assert_eq!(
            result
                .account_txs
                .iter()
                .map(|(_, tx)| tx.wire_name().to_string())
                .collect::<Vec<_>>(),
            expected.account_tx_types,
            "{} AccountTx types",
            expected.name
        );
        assert_eq!(
            result
                .account_txs
                .iter()
                .map(|(_, tx)| hex(&canonical_tx_digest(tx).expect("tx digest")))
                .collect::<Vec<_>>(),
            expected.account_tx_digests,
            "{} AccountTx digests",
            expected.name
        );
        assert_eq!(
            result.wake_targets, expected.wake_targets,
            "{} wakes",
            expected.name
        );
        assert_eq!(result.events.len(), expected.events.len());
        for (actual, expected_event) in result.events.iter().zip(expected.events) {
            let EntityFrameEvent::Status { message } = actual else {
                panic!("{} expected status event", expected.name)
            };
            assert_eq!(expected_event.kind, "status");
            assert_eq!(message, &expected_event.message, "{} event", expected.name);
        }
        if expected.name == "setRebalancePolicy" {
            assert!(matches!(
                result.envelope_mutations.as_slice(),
                [(account_id, AccountEnvelopeMutation::SetRebalancePolicy { token_id: 1, policy: xln_rscore_protocol::CanonicalValue::Object(fields) })]
                    if account_id == PEER
                        && fields.iter().any(|(key, value)| key == "r2cRequestSoftLimit" && value == &xln_rscore_protocol::CanonicalValue::BigInt(BigInt::from(50)))
                        && fields.iter().any(|(key, value)| key == "hardLimit" && value == &xln_rscore_protocol::CanonicalValue::BigInt(BigInt::from(100)))
                        && fields.iter().any(|(key, value)| key == "maxAcceptableFee" && value == &xln_rscore_protocol::CanonicalValue::BigInt(BigInt::from(5)))
            ));
        } else {
            assert!(result.envelope_mutations.is_empty());
        }
        if let Some(expected_root) = expected.account_create_state_root.as_ref() {
            assert_eq!(
                result.account_creates.len(),
                1,
                "{} create count",
                expected.name
            );
            assert_eq!(
                hex(&result.account_creates[0]
                    .replica
                    .state()
                    .payment_profile_account_state_root()
                    .expect("state root")),
                *expected_root,
                "{} created Account state root",
                expected.name,
            );
        } else {
            assert!(
                result.account_creates.is_empty(),
                "{} unexpected create",
                expected.name
            );
        }
        paybook
            .commit_sequential(&mut state)
            .unwrap_or_else(|error| panic!("{} paybook commit: {error}", expected.name));
        if let Some(expected_entry) = expected.paybook_entry.as_ref() {
            let actual = state
                .paybook
                .entry(&hashlock())
                .expect("paybook lookup")
                .expect("paybook entry");
            assert_eq!(actual.hashlock, expected_entry["hashlock"]);
            assert_eq!(
                actual.token_id,
                expected_entry["tokenId"].as_u64().map(|value| value as u16)
            );
            assert_eq!(
                actual.amount.as_ref().map(ToString::to_string),
                expected_entry["amount"]["value"]
                    .as_str()
                    .map(str::to_string),
            );
            assert_eq!(
                actual.originated,
                expected_entry["originated"].as_bool().unwrap_or(false)
            );
            assert_eq!(actual.secret.as_deref(), expected_entry["secret"].as_str());
            assert_eq!(
                actual.inbound_entity.as_deref(),
                expected_entry["inboundEntity"].as_str()
            );
            assert_eq!(
                actual.outbound_entity.as_deref(),
                expected_entry["outboundEntity"].as_str()
            );
        }
        if let Some(expected_effects) = expected.runtime_effects.as_ref() {
            assert_eq!(expected_effects.len(), 1, "fixture effect count");
            assert!(
                matches!(
                    result.outputs.as_slice(),
                    [EntityKernelOutput::HtlcInitiated {
                        entity_id, from_entity, to_entity, token_id, amount, sender_amount,
                        fee, hashlock: output_hashlock, lock_id, route, description, started_at_ms,
                    }] if entity_id == expected_effects[0]["data"]["entityId"].as_str().unwrap()
                        && from_entity == expected_effects[0]["data"]["fromEntity"].as_str().unwrap()
                        && to_entity == expected_effects[0]["data"]["toEntity"].as_str().unwrap()
                        && u64::from(*token_id) == expected_effects[0]["data"]["tokenId"].as_u64().unwrap()
                        && amount.to_string() == expected_effects[0]["data"]["amount"].as_str().unwrap()
                        && sender_amount.to_string() == expected_effects[0]["data"]["senderAmount"].as_str().unwrap()
                        && fee.to_string() == expected_effects[0]["data"]["fee"].as_str().unwrap()
                        && output_hashlock == expected_effects[0]["data"]["hashlock"].as_str().unwrap()
                        && lock_id == expected_effects[0]["data"]["lockId"].as_str().unwrap()
                        && route.iter().map(String::as_str).eq(expected_effects[0]["data"]["route"].as_array().unwrap().iter().map(|value| value.as_str().unwrap()))
                        && description.as_deref() == expected_effects[0]["data"]["description"].as_str()
                        && *started_at_ms == expected_effects[0]["data"]["startedAtMs"].as_u64().unwrap()
                ),
                "{} runtime effect",
                expected.name
            );
        } else {
            assert!(
                result.outputs.is_empty(),
                "{} unexpected output",
                expected.name
            );
        }
    }
}

#![allow(dead_code)]

use std::sync::Arc;

use num_bigint::BigInt;
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountExecutionContext, AccountIdentity, AccountOutput,
    AccountReplica, AccountState, AccountTx, AccountVerdict, Delta, DepositoryAddress, EntityId,
    SequentialAccountEngine, Side, SwapMarketPolicy, SwapToken, TokenId, WatchSeed,
};
use xln_rscore_entity_kernel::{
    CommittedAccountTransition, JurisdictionScope, OrderedAccountCommit,
};

pub const HUB: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
pub const MAKER: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";
pub const TAKER: &str = "0x3333333333333333333333333333333333333333333333333333333333333333";
pub const NEXT: &str = "0x4444444444444444444444444444444444444444444444444444444444444444";

pub fn token(value: u32) -> TokenId {
    TokenId::new(value).expect("fixture token")
}

pub fn domain() -> AccountDomain {
    AccountDomain::new(
        31_337,
        DepositoryAddress::parse("0x8888888888888888888888888888888888888888")
            .expect("fixture depository"),
    )
    .expect("fixture domain")
}

fn funded_delta(token_id: u32) -> Delta {
    let capacity = BigInt::from(10_u8).pow(30);
    Delta::new(
        token(token_id),
        capacity.clone(),
        BigInt::from(0),
        BigInt::from(0),
        capacity.clone(),
        capacity,
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(0),
    )
    .expect("fixture delta")
}

pub fn account(remote: &str, token_ids: &[u32]) -> AccountReplica {
    let identity = AccountIdentity::new(
        domain(),
        EntityId::parse(HUB).expect("hub"),
        EntityId::parse(remote).expect("remote"),
        WatchSeed::parse("0x9999999999999999999999999999999999999999999999999999999999999999")
            .expect("watch seed"),
    )
    .expect("identity");
    let state = AccountState::new(
        identity,
        AccountDisputeConfig::new(10, 10).expect("dispute config"),
        token_ids.iter().copied().map(funded_delta).collect(),
    )
    .expect("account state");
    AccountReplica::new(EntityId::parse(HUB).expect("hub"), state).expect("account replica")
}

pub fn market() -> Arc<SwapMarketPolicy> {
    Arc::new(SwapMarketPolicy::new(
        vec![
            SwapToken {
                token_id: 1,
                decimals: 6,
                liquid: true,
            },
            SwapToken {
                token_id: 2,
                decimals: 18,
                liquid: false,
            },
        ],
        vec![((2, 1), 1)],
    ))
}

pub fn execution_context(account_height: u64, frame_j_height: u64) -> AccountExecutionContext {
    AccountExecutionContext::with_market(
        1_000,
        1_000,
        100,
        account_height,
        frame_j_height,
        market(),
    )
}

pub fn apply_account(
    base: &AccountReplica,
    proposer: Side,
    tx: &AccountTx,
    account_height: u64,
    frame_j_height: u64,
) -> (AccountReplica, Vec<AccountOutput>) {
    let transition = SequentialAccountEngine::apply_with_context(
        base,
        proposer,
        tx,
        &execution_context(account_height, frame_j_height),
    )
    .expect("account transition");
    assert_eq!(transition.verdict(), &AccountVerdict::Applied);
    let outputs = transition.outputs().to_vec();
    let candidate = transition.committed().expect("applied candidate");
    (candidate, outputs)
}

pub fn commit(
    account_id: &str,
    frame_byte: u8,
    frame_height: u64,
    tx: AccountTx,
    outputs: Vec<AccountOutput>,
) -> OrderedAccountCommit {
    OrderedAccountCommit {
        account_id: account_id.to_string(),
        domain: domain(),
        scope: JurisdictionScope::Same,
        committed_via_new_frame: true,
        frame_state_hash: format!("0x{}", format!("{frame_byte:02x}").repeat(32)),
        frame_height,
        frame_timestamp: 1_000,
        transitions: vec![CommittedAccountTransition { tx, outputs }],
    }
}

pub fn hex(bytes: &[u8]) -> String {
    let mut value = String::from("0x");
    for byte in bytes {
        value.push_str(&format!("{byte:02x}"));
    }
    value
}

pub fn tx_digest(tx: &AccountTx) -> String {
    hex(&xln_rscore_engine::canonical_tx_digest(tx).expect("canonical tx digest"))
}

pub fn fixture() -> serde_json::Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/entity-kernel/parity-v1.json"
    )))
    .expect("canonical TypeScript fixture")
}

pub fn fixture_text<'a>(fixture: &'a serde_json::Value, path: &[&str]) -> &'a str {
    let mut value = fixture;
    for segment in path {
        value = &value[*segment];
    }
    value.as_str().expect("fixture text")
}

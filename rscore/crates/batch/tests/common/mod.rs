use num_bigint::BigInt;
use xln_rscore_batch::{AccountId, AccountSeed, BatchJob, EngineGeneration};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountExecutionContext, AccountIdentity, AccountReplica,
    AccountState, AccountTx, DeliveryMode, Delta, DepositoryAddress, EntityId, HtlcHashlock,
    HtlcLockTx, HtlcResolveOutcome, HtlcResolveTx, Side, TokenId, WatchSeed,
};

pub const HTLC_SECRET: &str = "0x0101010101010101010101010101010101010101010101010101010101010101";
pub const HTLC_HASHLOCK: &str =
    "0xcebc8882fecbec7fb80d2cf4b312bec018884c2d66667c67a90508214bd8bafc";

pub fn generation() -> EngineGeneration {
    EngineGeneration::from_bytes([0x42; 8])
}

pub fn account_id(value: u32) -> AccountId {
    let mut bytes = [0_u8; 32];
    bytes[28..].copy_from_slice(&value.to_be_bytes());
    AccountId::from_bytes(bytes)
}

pub fn entity(value: u32) -> EntityId {
    let mut bytes = [0_u8; 32];
    bytes[28..].copy_from_slice(&value.to_be_bytes());
    EntityId::parse(&format!("0x{}", hex_string(&bytes))).expect("literal entity")
}

pub fn token(value: u32) -> TokenId {
    TokenId::new(value).expect("literal token")
}

pub fn seed(value: u32) -> AccountSeed {
    seed_with_deltas(value, vec![funded_delta(token(1))])
}

pub fn full_seed(value: u32) -> AccountSeed {
    let deltas = (0..128).map(|value| funded_delta(token(value))).collect();
    seed_with_deltas(value, deltas)
}

fn seed_with_deltas(value: u32, deltas: Vec<Delta>) -> AccountSeed {
    let left = entity(value * 2 + 1);
    let right = entity(value * 2 + 2);
    let domain = AccountDomain::new(
        31_337,
        DepositoryAddress::parse(&format!("0x{}", "88".repeat(20))).expect("literal depository"),
    )
    .expect("literal domain");
    let watch_seed =
        WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("literal watch seed");
    let identity =
        AccountIdentity::new(domain, left.clone(), right, watch_seed).expect("canonical parties");
    let state = AccountState::new(
        identity,
        AccountDisputeConfig::new(10, 10).expect("literal dispute config"),
        deltas,
    )
    .expect("literal state");
    AccountSeed {
        account_id: account_id(value),
        replica: AccountReplica::new(left, state).expect("literal owner"),
    }
}

fn funded_delta(token_id: TokenId) -> Delta {
    Delta::new(
        token_id,
        1_000_000.into(),
        0.into(),
        0.into(),
        0.into(),
        0.into(),
        0.into(),
        0.into(),
        0.into(),
        0.into(),
    )
    .expect("literal delta")
}

pub fn direct_job(input_index: u32, account: u32, amount: i64) -> BatchJob {
    let left = entity(account * 2 + 1).to_string();
    let right = entity(account * 2 + 2).to_string();
    BatchJob {
        input_index,
        account_id: account_id(account),
        proposer: Side::Right,
        context: context(input_index),
        tx: AccountTx::DirectPayment {
            token_id: token(1),
            amount: BigInt::from(amount),
            route: vec![left.clone()],
            description: Some(format!("batch-{input_index}")),
            from_entity_id: right,
            to_entity_id: left,
            delivery_mode: DeliveryMode::Direct,
            trusted_gateway_entity_id: None,
        },
    }
}

pub fn trusted_job(input_index: u32, account: u32, amount: i64) -> BatchJob {
    let gateway = entity(account * 2 + 1).to_string();
    let source = entity(account * 2 + 2).to_string();
    let target = entity(10_000 + input_index).to_string();
    BatchJob {
        input_index,
        account_id: account_id(account),
        proposer: Side::Right,
        context: context(input_index),
        tx: AccountTx::DirectPayment {
            token_id: token(1),
            amount: BigInt::from(amount),
            route: vec![gateway.clone(), target],
            description: Some("stable-forward".into()),
            from_entity_id: source,
            to_entity_id: gateway.clone(),
            delivery_mode: DeliveryMode::Trusted,
            trusted_gateway_entity_id: Some(gateway),
        },
    }
}

pub fn htlc_lock_job(input_index: u32, account: u32, lock_id: &str) -> BatchJob {
    BatchJob {
        input_index,
        account_id: account_id(account),
        proposer: Side::Right,
        context: context(input_index),
        tx: AccountTx::HtlcLock(HtlcLockTx {
            lock_id: lock_id.into(),
            hashlock: HtlcHashlock::parse(HTLC_HASHLOCK).expect("literal hashlock"),
            timelock: 1_700_000_010_000_u64.into(),
            reveal_before_height: 100,
            amount: 3.into(),
            token_id: token(1),
            delivery_mode: None,
            envelope: None,
        }),
    }
}

pub fn htlc_resolve_job(input_index: u32, account: u32, lock_id: &str) -> BatchJob {
    BatchJob {
        input_index,
        account_id: account_id(account),
        proposer: Side::Left,
        context: context(input_index),
        tx: AccountTx::HtlcResolve(HtlcResolveTx {
            lock_id: lock_id.into(),
            outcome: HtlcResolveOutcome::Secret {
                secret: HTLC_SECRET.into(),
            },
        }),
    }
}

pub fn context(input_index: u32) -> AccountExecutionContext {
    AccountExecutionContext::new(
        1_700_000_000_000,
        1_700_000_000_000,
        50,
        u64::from(input_index),
    )
}

pub fn delta_root(engine: &xln_rscore_batch::StatefulBatchEngine, account: u32) -> [u8; 32] {
    engine
        .account(&account_id(account))
        .expect("account")
        .state()
        .deltas_root()
}

pub fn locks_root(engine: &xln_rscore_batch::StatefulBatchEngine, account: u32) -> [u8; 32] {
    engine
        .account(&account_id(account))
        .expect("account")
        .state()
        .htlc_locks_root()
}

fn hex_string(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        write!(output, "{byte:02x}").expect("string write");
    }
    output
}

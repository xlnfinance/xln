//! In-process throughput of the account engine, with no wire in the way.
//!
//! `cargo run --release --example bench -- [accounts] [waves] [txs_per_wave] [workers]`
//!
//! Reports prepare (execution + candidate leaves) and commit (rebranch + root)
//! separately, because they scale differently: execution fans out per account,
//! the tree fold does not.

use std::time::Instant;

use num_bigint::BigInt;
use xln_rscore_batch::{AccountId, AccountSeed, BatchJob, EngineGeneration, StatefulBatchEngine};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountExecutionContext, AccountIdentity, AccountReplica,
    AccountState, AccountTx, DeliveryMode, Delta, DepositoryAddress, EntityId, Side, TokenId,
    WatchSeed,
};

fn hex_string(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn entity(value: u32) -> EntityId {
    let mut bytes = [0_u8; 32];
    bytes[28..].copy_from_slice(&value.to_be_bytes());
    EntityId::parse(&format!("0x{}", hex_string(&bytes))).expect("literal entity")
}

fn account_id(value: u32) -> AccountId {
    let mut bytes = [0_u8; 32];
    bytes[28..].copy_from_slice(&value.to_be_bytes());
    AccountId::from_bytes(bytes)
}

fn seed(value: u32) -> AccountSeed {
    let left = entity(value * 2 + 1);
    let right = entity(value * 2 + 2);
    let domain = AccountDomain::new(
        31_337,
        DepositoryAddress::parse(&format!("0x{}", "88".repeat(20))).expect("depository"),
    )
    .expect("domain");
    let identity = AccountIdentity::new(
        domain,
        left.clone(),
        right,
        WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
    )
    .expect("identity");
    let delta = Delta::new(
        TokenId::new(1).expect("token"),
        1_000_000_000.into(),
        0.into(),
        0.into(),
        500_000_000.into(),
        500_000_000.into(),
        0.into(),
        0.into(),
        0.into(),
        0.into(),
    )
    .expect("delta");
    let state = AccountState::new(
        identity,
        AccountDisputeConfig::new(10, 10).expect("dispute config"),
        vec![delta],
    )
    .expect("state");
    AccountSeed {
        account_id: account_id(value),
        replica: AccountReplica::new(left, state).expect("owner"),
    }
}

fn payment(input_index: u32, account: u32, amount: i64, left_pays: bool) -> BatchJob {
    let left = entity(account * 2 + 1).to_string();
    let right = entity(account * 2 + 2).to_string();
    let (from, to) = if left_pays {
        (left.clone(), right)
    } else {
        (right, left.clone())
    };
    BatchJob {
        input_index,
        account_id: account_id(account),
        proposer: if left_pays { Side::Left } else { Side::Right },
        context: AccountExecutionContext::new(
            1_700_000_000_000 + u64::from(input_index),
            1_700_000_000_000 + u64::from(input_index),
            100,
            0,
            100,
        ),
        tx: AccountTx::DirectPayment {
            token_id: TokenId::new(1).expect("token"),
            amount: BigInt::from(amount),
            route: vec![to.clone()],
            description: None,
            from_entity_id: from,
            to_entity_id: to,
            delivery_mode: DeliveryMode::Direct,
            trusted_gateway_entity_id: None,
        },
        envelope: None,
    }
}

fn arg(index: usize, fallback: usize) -> usize {
    std::env::args()
        .nth(index)
        .and_then(|value| value.parse().ok())
        .unwrap_or(fallback)
}

/// Raw hash cost, to tell a slow commitment from a slow SHA-256 build.
fn micro_sha() {
    use sha2::{Digest, Sha256};
    let data = [7_u8; 200];
    let rounds = 1_000_000;
    let started = Instant::now();
    let mut sink = 0_u8;
    for _ in 0..rounds {
        sink ^= Sha256::digest(data)[0];
    }
    println!(
        "sha256(200B): {:.0} ns/call (sink={sink})",
        started.elapsed().as_secs_f64() * 1e9 / f64::from(rounds)
    );
}

/// Isolate the commitment cost: how long one account state root takes.
fn micro(seeds: &[AccountSeed]) {
    let replica = &seeds[0].replica;
    let rounds = 2_000_000;
    let started = Instant::now();
    let mut sink = 0_u8;
    for _ in 0..rounds {
        let root = replica
            .state()
            .payment_profile_account_state_root()
            .expect("root");
        sink ^= root[0];
    }
    let per = started.elapsed().as_secs_f64() * 1e9 / f64::from(rounds);
    println!("accountStateRoot: {per:.0} ns/call (sink={sink})");
}

fn main() {
    let accounts = arg(1, 1_000) as u32;
    let waves = arg(2, 10);
    let per_wave = arg(3, 10_000) as u32;
    let workers = arg(4, 8);

    let seeds: Vec<AccountSeed> = (0..accounts).map(seed).collect();
    let mut engine = StatefulBatchEngine::new(
        EngineGeneration::from_bytes([0x42; 8]),
        workers,
        seeds,
    )
    .expect("engine");

    if std::env::var("XLN_BENCH_MICRO").is_ok() {
        micro_sha();
        micro(&(0..1).map(seed).collect::<Vec<_>>());
    }
    let mut prepare_ns = 0_u128;
    let mut commit_ns = 0_u128;
    let mut applied = 0_usize;
    let started = Instant::now();
    for wave in 0..waves {
        let jobs: Vec<BatchJob> = (0..per_wave)
            .map(|index| {
                payment(
                    index,
                    (wave as u32 * 7 + index) % accounts,
                    5,
                    (wave as u32 + index) % 2 == 0,
                )
            })
            .collect();
        let prepare_started = Instant::now();
        let prepared = engine.prepare(&jobs).expect("prepare");
        prepare_ns += prepare_started.elapsed().as_nanos();
        applied += prepared
            .results()
            .iter()
            .filter(|result| matches!(result.verdict, xln_rscore_batch::BatchVerdict::Applied))
            .count();
        let commit_started = Instant::now();
        engine.commit(prepared).expect("commit");
        commit_ns += commit_started.elapsed().as_nanos();
    }
    let elapsed = started.elapsed();
    let total = waves * per_wave as usize;
    println!(
        "accounts={accounts} waves={waves} txs={total} applied={applied} workers={workers} \
         totalMs={:.0} txPerSec={:.0} prepareUsPerTx={:.2} commitUsPerTx={:.2}",
        elapsed.as_secs_f64() * 1000.0,
        total as f64 / elapsed.as_secs_f64(),
        prepare_ns as f64 / 1000.0 / total as f64,
        commit_ns as f64 / 1000.0 / total as f64,
    );
}

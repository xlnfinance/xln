//! Account inputs per second when Rust owns the accounts.
//!
//! Every round is one payment per account pair: the payer's engine proposes
//! and signs a frame, the payee's engine verifies it, replays it and signs an
//! ack, and the payer verifies that ack. Two signed account inputs cross per
//! payment, and each one is authenticated before it touches state — that is
//! what `ai/s` counts here.
//!
//! What this number is not: the TypeScript twin
//! (core/scripts/operations/benchmark/bench-account-inputs.ts) does the same
//! round trip, but it also pays for per-frame work this engine does not
//! implement yet — dispute proof projection on both propose and receive,
//! j-claim sessions, pendingAccountInput/lastOutboundFrameAck bookkeeping, and
//! deep clones of the replica. Read the ratio as "the payment path in Rust vs
//! the payment path in TypeScript as it stands today", not as a like-for-like
//! engine comparison.
//!
//! `cargo run --release --example bench_consensus -- [accounts] [rounds] [workers]`

use std::time::Instant;

use num_bigint::BigInt;
use xln_rscore_batch::{
    AccountId, AccountInputKind, AccountInputRow, AccountInputVerdict, AccountSeed,
    EngineGeneration, ReceiverClock, StatefulConsensusEngine,
};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountIdentity, AccountReplica, AccountState, AccountTx,
    BoardDelays, DeliveryMode, Delta, DepositoryAddress, EntityId, SigningIdentity, TokenId,
    WatchSeed,
};

fn signer_key(signer_id: &str) -> [u8; 32] {
    xln_rscore_engine::derive_signer_key(SEED, signer_id).expect("signer key")
}

const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";

fn hex_of(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn entity_of(signer_id: &str) -> ([u8; 32], EntityId) {
    let identity = SigningIdentity::lazy_from_seed(SEED, signer_id, 1, 1, BoardDelays::default())
        .expect("identity");
    let bytes = *identity.entity_id();
    let parsed = EntityId::parse(&format!("0x{}", hex_of(&bytes))).expect("entity");
    (bytes, parsed)
}

fn account_state(left: &EntityId, right: &EntityId) -> AccountState {
    let domain = AccountDomain::new(
        31_337,
        DepositoryAddress::parse(&format!("0x{}", "88".repeat(20))).expect("depository"),
    )
    .expect("domain");
    let identity = AccountIdentity::new(
        domain,
        left.clone(),
        right.clone(),
        WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
    )
    .expect("identity");
    let delta = Delta::new(
        TokenId::new(1).expect("token"),
        BigInt::from(1_000_000_000),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(500_000_000),
        BigInt::from(500_000_000),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(0),
    )
    .expect("delta");
    AccountState::new(
        identity,
        AccountDisputeConfig::new(10, 10).expect("dispute config"),
        vec![delta],
    )
    .expect("state")
}

fn arg(index: usize, fallback: usize) -> usize {
    std::env::args()
        .nth(index)
        .and_then(|value| value.parse().ok())
        .unwrap_or(fallback)
}

struct Pair {
    account_id: AccountId,
    payer: EntityId,
    payee: EntityId,
    payer_entity: [u8; 32],
    payee_entity: [u8; 32],
}

fn main() {
    let accounts = arg(1, 1_000);
    let rounds = arg(2, 10);
    let workers = arg(3, 8);

    // One entity per side of every pair, each with its own signer key, so the
    // benchmark verifies as many distinct signatures as a real hub does.
    let mut payer_seeds = Vec::with_capacity(accounts);
    let mut payee_seeds = Vec::with_capacity(accounts);
    let mut pairs = Vec::with_capacity(accounts);
    let mut payer_signers = Vec::with_capacity(accounts);
    let mut payee_signers = Vec::with_capacity(accounts);
    for index in 0..accounts {
        let payer_signer = format!("payer-{index}");
        let payee_signer = format!("payee-{index}");
        let (payer_bytes, payer) = entity_of(&payer_signer);
        let (payee_bytes, payee) = entity_of(&payee_signer);
        let (left, right) = if payer.to_string() < payee.to_string() {
            (payer.clone(), payee.clone())
        } else {
            (payee.clone(), payer.clone())
        };
        let state = account_state(&left, &right);
        // The account id is the counterparty entity id, from each side's view.
        let payer_account = AccountId::from_bytes(payee_bytes);
        let payee_account = AccountId::from_bytes(payer_bytes);
        payer_seeds.push(AccountSeed {
            account_id: payer_account,
            replica: AccountReplica::new(payer.clone(), state.clone()).expect("payer replica"),
            consensus: None,
        });
        payee_seeds.push(AccountSeed {
            account_id: payee_account,
            replica: AccountReplica::new(payee.clone(), state).expect("payee replica"),
            consensus: None,
        });
        payer_signers.push((payer_bytes, payer_signer));
        payee_signers.push((payee_bytes, payee_signer));
        pairs.push(Pair {
            account_id: payer_account,
            payer,
            payee,
            payer_entity: payer_bytes,
            payee_entity: payee_bytes,
        });
    }

    let by_account_id: std::collections::HashMap<[u8; 32], usize> = pairs
        .iter()
        .enumerate()
        .map(|(index, pair)| (*pair.account_id.as_bytes(), index))
        .collect();
    let by_payee_account_id: std::collections::HashMap<[u8; 32], usize> = pairs
        .iter()
        .enumerate()
        .map(|(index, pair)| (pair.payer_entity, index))
        .collect();

    let mut payer_engine = StatefulConsensusEngine::restore(
        EngineGeneration::from_bytes([0x42; 8]),
        workers,
        0,
        xln_rscore_engine::derive_signer_key(SEED, "1").expect("signer key"),
        "1".to_string(),
        std::sync::Arc::default(),
        Vec::new(),
    )
    .expect("payer engine");
    let mut payee_engine = StatefulConsensusEngine::restore(
        EngineGeneration::from_bytes([0x42; 8]),
        workers,
        0,
        xln_rscore_engine::derive_signer_key(SEED, "1").expect("signer key"),
        "1".to_string(),
        std::sync::Arc::default(),
        Vec::new(),
    )
    .expect("payee engine");
    for (entity, signer) in &payer_signers {
        payer_engine
            .register_signer(*entity, signer_key(signer), signer)
            .expect("payer signer");
    }
    for (entity, signer) in &payee_signers {
        payee_engine
            .register_signer(*entity, signer_key(signer), signer)
            .expect("payee signer");
    }
    payer_engine
        .upsert_accounts(payer_seeds)
        .expect("payer seeds");
    payee_engine
        .upsert_accounts(payee_seeds)
        .expect("payee seeds");

    let mut inputs = 0_usize;
    let mut committed = 0_usize;
    let started = Instant::now();
    for round in 0..rounds {
        let timestamp = 1_700_000_000_000 + round as u64;
        let admissions: Vec<(AccountId, Vec<AccountTx>)> = pairs
            .iter()
            .map(|pair| {
                (
                    pair.account_id,
                    vec![AccountTx::DirectPayment {
                        token_id: TokenId::new(1).expect("token"),
                        amount: BigInt::from(5),
                        route: vec![pair.payee.to_string()],
                        description: None,
                        from_entity_id: pair.payer.to_string(),
                        to_entity_id: pair.payee.to_string(),
                        delivery_mode: DeliveryMode::Direct,
                        trusted_gateway_entity_id: None,
                    }],
                )
            })
            .collect();
        payer_engine.admit_txs(admissions).expect("admit");
        let proposals = payer_engine
            .propose_frames(timestamp, 100, None)
            .expect("propose");
        assert_eq!(proposals.len(), accounts, "every account proposes");

        let frames: Vec<AccountInputRow> = proposals
            .iter()
            .enumerate()
            .map(|(index, proposal)| {
                // Proposals come back in account order, not the order the
                // pairs were built in.
                let pair = &pairs[by_account_id[proposal.account_id.as_bytes()]];
                AccountInputRow {
                    operation_index: index as u64,
                    // The payee holds this account under the payer's id.
                    account_id: AccountId::from_bytes(pair.payer_entity),
                    from_entity_id: pair.payer_entity,
                    kind: AccountInputKind::Frame(Box::new(
                        proposal.incoming().expect("the attempt produced a frame"),
                    )),
                }
            })
            .collect();
        inputs += frames.len();
        // The receiver judges enforcement on its own clock, which here is the
        // same wall clock the proposer used.
        let clock = ReceiverClock {
            entity_timestamp: timestamp,
            finalized_j_height: 100,
        };
        let applied = payee_engine
            .apply_inputs(clock, frames)
            .expect("apply frames");

        let mut acks = Vec::with_capacity(applied.len());
        for (index, result) in applied.iter().enumerate() {
            let pair = &pairs[by_payee_account_id[result.account_id.as_bytes()]];
            let AccountInputVerdict::FrameCommitted {
                height,
                state_hash,
                ack_hanko,
                ..
            } = &result.verdict
            else {
                panic!("expected a commit: {:?}", result.verdict);
            };
            committed += 1;
            acks.push(AccountInputRow {
                operation_index: index as u64,
                account_id: pair.account_id,
                from_entity_id: pair.payee_entity,
                kind: AccountInputKind::Ack {
                    height: *height,
                    state_hash: *state_hash,
                    hanko: ack_hanko.clone(),
                    dispute: None,
                },
            });
        }
        inputs += acks.len();
        for result in payer_engine.apply_inputs(clock, acks).expect("apply acks") {
            assert!(
                matches!(result.verdict, AccountInputVerdict::AckCommitted { .. }),
                "expected an ack commit: {:?}",
                result.verdict,
            );
        }
    }
    let elapsed = started.elapsed();
    let payments = accounts * rounds;
    println!(
        "accounts={accounts} rounds={rounds} workers={workers} payments={payments} \
         accountInputs={inputs} committedFrames={committed} totalMs={:.0} \
         accountInputsPerSec={:.0} paymentsPerSec={:.0}",
        elapsed.as_secs_f64() * 1000.0,
        inputs as f64 / elapsed.as_secs_f64(),
        payments as f64 / elapsed.as_secs_f64(),
    );
    assert_eq!(
        payer_engine.accounts_root().len(),
        32,
        "roots stay computable",
    );
}

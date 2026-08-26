//! One H1 Account module, exercised through its production two-visit API.
//!
//! Each measured payment leg includes H1 proposal/signature and the next
//! inbound peer ACK verification. Peer Hanko construction is deliberately
//! outside `engineMs`: it is work performed by counterparties, not by H1.
//! This is an Account-module replay diagnostic, never authoritative live TPS.
//!
//! `cargo run --release --example bench_consensus -- [accounts] [rounds] [workers]`

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use num_bigint::BigInt;
use xln_rscore_batch::{
    AccountId, AccountInputKind, AccountInputRow, AccountInputVerdict, AccountPeerInput,
    AccountSeed, EngineGeneration, EntityInboundRequest, EntityOutboundRequest, ReceiverClock,
    StatefulConsensusEngine,
};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountIdentity, AccountPeerEnvelope, AccountReplica,
    AccountState, AccountTx, BoardDelays, DeliveryMode, Delta, DepositoryAddress, EntityId,
    IncomingAck, SigningIdentity, TokenId, WatchSeed,
};
use xln_rscore_hanko::build_single_signer_hanko;

const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
const CHAIN_ID: u64 = 31_337;

struct Peer {
    account_id: AccountId,
    entity: EntityId,
    entity_bytes: [u8; 32],
    private_key: [u8; 32],
}

fn arg(index: usize, fallback: usize) -> usize {
    std::env::args()
        .nth(index)
        .and_then(|value| value.parse().ok())
        .unwrap_or(fallback)
}

fn identity(label: &str) -> ([u8; 32], EntityId, [u8; 32]) {
    let signing = SigningIdentity::lazy_from_seed(SEED, label, 1, 1, BoardDelays::default())
        .expect("identity");
    let bytes = *signing.entity_id();
    let entity = EntityId::parse(&format!("0x{}", hex_of(&bytes))).expect("entity");
    let key = xln_rscore_engine::derive_signer_key(SEED, label).expect("signer key");
    (bytes, entity, key)
}

fn domain() -> AccountDomain {
    AccountDomain::new(
        CHAIN_ID,
        DepositoryAddress::parse(&format!("0x{}", "88".repeat(20))).expect("depository"),
    )
    .expect("domain")
}

fn watch_seed() -> WatchSeed {
    WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed")
}

fn account_state(hub: &EntityId, peer: &EntityId) -> AccountState {
    let (left, right) = if hub.to_string() < peer.to_string() {
        (hub.clone(), peer.clone())
    } else {
        (peer.clone(), hub.clone())
    };
    let identity = AccountIdentity::new(domain(), left, right, watch_seed()).expect("account id");
    let delta = Delta::new(
        TokenId::new(1).expect("token"),
        BigInt::from(1_000_000_000_u64),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(500_000_000_u64),
        BigInt::from(500_000_000_u64),
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

fn peer_input(hub: [u8; 32], peer: [u8; 32], kind: AccountInputKind) -> AccountPeerInput {
    AccountPeerInput {
        envelope: AccountPeerEnvelope {
            from_entity_id: peer,
            to_entity_id: hub,
            domain: domain(),
            dispute_config: AccountDisputeConfig::new(10, 10).expect("dispute config"),
            watch_seed: Some(watch_seed()),
        },
        kind,
    }
}

fn payment(hub: &EntityId, peer: &EntityId) -> AccountTx {
    AccountTx::DirectPayment {
        token_id: TokenId::new(1).expect("token"),
        amount: BigInt::from(5),
        route: vec![peer.to_string()],
        description: None,
        from_entity_id: hub.to_string(),
        to_entity_id: peer.to_string(),
        delivery_mode: DeliveryMode::Direct,
        trusted_gateway_entity_id: None,
    }
}

fn main() {
    let accounts = arg(1, 4_096);
    let rounds = arg(2, 3);
    let workers = arg(3, 8);
    let (hub_bytes, hub, hub_key) = identity("h1-hub");
    let peers = (0..accounts)
        .map(|index| {
            let (entity_bytes, entity, private_key) = identity(&format!("peer-{index}"));
            Peer {
                account_id: AccountId::from_bytes(entity_bytes),
                entity,
                entity_bytes,
                private_key,
            }
        })
        .collect::<Vec<_>>();
    let seeds = peers
        .iter()
        .map(|peer| AccountSeed {
            account_id: peer.account_id,
            replica: AccountReplica::new(hub.clone(), account_state(&hub, &peer.entity))
                .expect("replica"),
            consensus: None,
        })
        .collect::<Vec<_>>();
    let restore_at = Instant::now();
    let mut engine = StatefulConsensusEngine::restore(
        EngineGeneration::from_bytes([0x42; 8]),
        workers,
        0,
        hub_key,
        "h1-hub".to_string(),
        std::sync::Arc::default(),
        seeds,
    )
    .expect("engine");
    let restore = restore_at.elapsed();
    let by_account = peers
        .iter()
        .enumerate()
        .map(|(index, peer)| (peer.account_id, index))
        .collect::<BTreeMap<_, _>>();

    let mut expected_root = engine.accounts_root();
    let mut pending_acks = Vec::new();
    let mut engine_inbound = Duration::ZERO;
    let mut engine_outbound = Duration::ZERO;
    let wall_at = Instant::now();
    for round in 0..rounds {
        let timestamp = 1_700_000_000_000 + round as u64 * 2;
        let inbound_at = Instant::now();
        let inbound = engine
            .entity_inbound(EntityInboundRequest {
                owner_entity_id: hub_bytes,
                expected_accounts_root: expected_root,
                clock: ReceiverClock {
                    entity_timestamp: timestamp,
                    finalized_j_height: 100,
                },
                rows: std::mem::take(&mut pending_acks),
                post_accounts: false,
            })
            .expect("inbound");
        engine_inbound += inbound_at.elapsed();
        for result in inbound.applied {
            assert!(
                matches!(result.verdict, AccountInputVerdict::AckCommitted { .. }),
                "peer ack must commit"
            );
        }

        let admits = peers
            .iter()
            .map(|peer| (peer.account_id, vec![payment(&hub, &peer.entity)]))
            .collect::<Vec<_>>();
        let propose = peers.iter().map(|peer| peer.account_id).collect::<Vec<_>>();
        let outbound_at = Instant::now();
        let outbound = engine
            .entity_outbound(EntityOutboundRequest {
                owner_entity_id: hub_bytes,
                timestamp: timestamp + 1,
                j_height: 100,
                creates: Vec::new(),
                admits,
                propose,
                materialize: Vec::new(),
                failed_htlc_routes: Vec::new(),
                post_accounts: false,
            })
            .expect("outbound");
        engine_outbound += outbound_at.elapsed();
        expected_root = outbound.accounts_root;
        assert_eq!(outbound.proposals.len(), accounts);
        pending_acks = outbound
            .proposals
            .into_iter()
            .enumerate()
            .map(|(operation_index, proposal)| {
                let proposed = proposal.proposed.expect("signed proposal");
                let peer = &peers[by_account[&proposal.account_id]];
                let hanko = build_single_signer_hanko(
                    &peer.entity_bytes,
                    &proposed.state_hash,
                    &peer.private_key,
                    1,
                    1,
                    xln_rscore_hanko::claims::BoardDelays::default(),
                )
                .expect("peer hanko");
                AccountInputRow {
                    operation_index: operation_index as u64,
                    account_id: peer.account_id,
                    input: peer_input(
                        hub_bytes,
                        peer.entity_bytes,
                        AccountInputKind::Ack(IncomingAck {
                            height: proposed.frame.height,
                            frame_hash: proposed.state_hash,
                            frame_hanko: Some(hanko),
                            dispute: None,
                        }),
                    ),
                }
            })
            .collect();
    }

    let drain_at = Instant::now();
    let drained = engine
        .entity_inbound(EntityInboundRequest {
            owner_entity_id: hub_bytes,
            expected_accounts_root: expected_root,
            clock: ReceiverClock {
                entity_timestamp: 1_700_000_100_000,
                finalized_j_height: 100,
            },
            rows: pending_acks,
            post_accounts: false,
        })
        .expect("drain inbound");
    engine_inbound += drain_at.elapsed();
    assert_eq!(drained.applied.len(), accounts);
    let finish_at = Instant::now();
    let finished = engine
        .entity_outbound(EntityOutboundRequest {
            owner_entity_id: hub_bytes,
            timestamp: 1_700_000_100_001,
            j_height: 100,
            creates: Vec::new(),
            admits: Vec::new(),
            propose: Vec::new(),
            materialize: Vec::new(),
            failed_htlc_routes: Vec::new(),
            post_accounts: false,
        })
        .expect("drain outbound");
    engine_outbound += finish_at.elapsed();

    let engine_time = engine_inbound + engine_outbound;
    let payments = accounts * rounds;
    let metrics = engine.account_shard_metrics();
    let mut worker_nanos = vec![0_u64; workers];
    for row in &metrics {
        worker_nanos[usize::from(row.worker)] += row.work_nanos + row.fold_nanos;
    }
    let active_shards = metrics
        .iter()
        .filter(|row| row.work_items > 0 || row.fold_leaves > 0)
        .count();
    println!(
        "accounts={accounts} rounds={rounds} workers={workers} logicalShards=4096 activeShards={active_shards} payments={payments} restoreMs={:.1} engineMs={:.1} inboundMs={:.1} outboundMs={:.1} wallMs={:.1} replayPayPerSec={:.0} root={} workerNanos={worker_nanos:?}",
        restore.as_secs_f64() * 1_000.0,
        engine_time.as_secs_f64() * 1_000.0,
        engine_inbound.as_secs_f64() * 1_000.0,
        engine_outbound.as_secs_f64() * 1_000.0,
        wall_at.elapsed().as_secs_f64() * 1_000.0,
        payments as f64 / engine_time.as_secs_f64(),
        hex_of(&finished.accounts_root),
    );
}

fn hex_of(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut output, byte| {
        let _ = write!(output, "{byte:02x}");
        output
    })
}

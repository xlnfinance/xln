use super::*;
#[path = "secret_ack_signed.rs"]
mod signed;
use ethabi::ethereum_types::U256;
use sha3::{Digest, Keccak256};
use xln_rscore_entity_kernel::j_batch::{InitialDisputeProof, ProofBody};
use xln_rscore_entity_kernel::{JBatchState, PaybookEntry, PaybookState, ResidentEntityResult};

#[derive(Clone, Copy, Default)]
pub(super) struct Case {
    pub peers: usize,
    pub locks_per_peer: usize,
    pub queued_starts: usize,
    pub missing_lock: bool,
    pub unknown_account: bool,
    pub active_dispute: bool,
    pub expired_lock: bool,
    pub ready_proof: bool,
    pub manual_prepare: bool,
}

pub(super) const DUE: u64 = TIMESTAMP + 120_000;

fn pending_entry(index: u8, peer: &EntityId, deadline: u64) -> PaybookEntry {
    PaybookEntry {
        hashlock: format!("0x{}", hex::encode(Keccak256::digest([index; 32]))),
        description: None,
        token_id: Some(1),
        amount: Some(BigInt::from(100)),
        started_at_ms: None,
        originated: false,
        inbound_entity: Some(peer.to_string()),
        outbound_entity: None,
        inbound_settled: false,
        outbound_settled: true,
        secret: Some(format!("0x{}", hex::encode([index; 32]))),
        secret_ack_pending: true,
        secret_ack_started_at: Some(TIMESTAMP),
        secret_ack_deadline_at: Some(deadline),
        pending_fee: None,
        created_timestamp: TIMESTAMP,
    }
}

fn queued_batch(count: usize) -> JBatchState {
    let mut state = JBatchState::default();
    state.batch.dispute_starts = (0..count)
        .map(|index| InitialDisputeProof {
            counterentity: [index as u8; 32],
            nonce: U256::from(1),
            proposer_is_left: true,
            proofbody_hash: [0; 32],
            watch_seed: [0; 32],
            sig: vec![],
            initial_proofbody: ProofBody {
                watch_seed: [0; 32],
                left_response_seconds: 10,
                right_response_seconds: 10,
                offdeltas: vec![],
                token_ids: vec![],
                transformers: vec![],
            },
            starter_initial_arguments: vec![],
            starter_counter_arguments: vec![],
            starter_counter_proof_commitment: [0; 32],
        })
        .collect();
    state
}

pub(super) fn run_case(
    workers: usize,
    case: Case,
) -> (ResidentEntityResult, ResidentConsensusEngine, Vec<EntityId>) {
    let hub = entity(&identity("hub"));
    // Deliberately reverse lexicographic peer order. Deadlines, not account ids,
    // decide which counterparty gets the last available dispute slot.
    let mut peers = (0..case.peers)
        .map(|i| entity(&identity(&format!("ack-peer-{i}"))))
        .collect::<Vec<_>>();
    peers.sort();
    peers.reverse();
    let mut entries = Vec::new();
    let mut seeds = Vec::new();
    for (peer_index, peer) in peers.iter().enumerate() {
        let mut replica = AccountReplica::new(hub.clone(), account_state(&hub, peer)).unwrap();
        for lock_index in 0..case.locks_per_peer {
            let entry = pending_entry(
                (peer_index * 4 + lock_index + 1) as u8,
                peer,
                DUE - 10 + peer_index as u64,
            );
            if !case.missing_lock {
                let tx = AccountTx::HtlcLock(HtlcLockTx {
                    lock_id: entry.hashlock.clone(),
                    hashlock: HtlcHashlock::parse(&entry.hashlock).unwrap(),
                    timelock: BigInt::from(if case.expired_lock { DUE } else { DUE + 60_000 }),
                    reveal_before_height: 1_000,
                    amount: BigInt::from(100),
                    token_id: TokenId::new(1).unwrap(),
                    delivery_mode: None,
                    envelope: None,
                });
                replica = SequentialAccountEngine::apply_with_context(
                    &replica,
                    replica.owner_side().opposite(),
                    &tx,
                    &AccountExecutionContext::with_market(
                        1_000,
                        TIMESTAMP,
                        100,
                        0,
                        100,
                        support::market(),
                    ),
                )
                .unwrap()
                .committed()
                .expect("committed production lock");
            }
            entries.push(entry);
        }
        let mut consensus = if case.ready_proof {
            assert_eq!(case.locks_per_peer, 1);
            signed::signed_inbound_lock(&hub, peer, entries.last().unwrap())
        } else {
            AccountConsensus::new(replica)
        };
        if case.active_dispute {
            consensus
                .replace_entity_dispute_lifecycle(
                    "disputed",
                    None,
                    Some(CanonicalValue::Object(vec![])),
                )
                .unwrap();
        }
        seeds.push(AccountSeed {
            account_id: AccountId::from_bytes(*peer.as_bytes()),
            replica: consensus.replica().clone(),
            consensus: Some(consensus.consensus_snapshot()),
        });
    }
    let mut accounts = ResidentConsensusEngine::restore(
        EngineGeneration::from_bytes([0x76; 8]),
        workers,
        0,
        derive_signer_key(SEED, "hub").unwrap(),
        "hub".into(),
        support::market(),
        seeds,
    )
    .unwrap();
    let mut state = EntityStateSlice::empty(hub.to_string(), DUE);
    if !case.unknown_account {
        for peer in &peers {
            state.known_accounts.insert(peer.to_string());
        }
    }
    state.crontab = Some(CrontabState::default());
    let mut jobs = entries
        .iter()
        .map(|entry| xln_rscore_entity_kernel::ScheduledWakeJob {
            kind: xln_rscore_entity_kernel::ScheduledWakeJobKind::Hook,
            id: format!("htlc-secret-ack:{}", entry.hashlock),
            due_at: entry.secret_ack_deadline_at.unwrap(),
        })
        .collect::<Vec<_>>();
    jobs.sort();
    state.paybook = PaybookState::from_entries(entries, BigInt::from(0)).unwrap();
    if case.queued_starts > 0 {
        state.j_batch_state = Some(queued_batch(case.queued_starts));
    }
    let nonces = state.entity_command_nonces.clone();
    let root = accounts.accounts_root();
    let mut request = wake_request(&hub, root, jobs, 1);
    if case.manual_prepare {
        request.operations.push(ResidentEntityOperation::Local(vec![
            AdmittedLocalEntityTx {
                signer_id: "hub".into(),
                board_epoch: 0,
                tx: LocalEntityTx::Financial(
                    decode_local_entity_financial_tx(
                        &xln_rscore_entity_kernel::CanonicalEntityTx::from_frame_projection(
                            EntityTxKind::PrepareDispute,
                            CanonicalValue::Object(vec![
                                (
                                    "counterpartyEntityId".into(),
                                    CanonicalValue::String(peers[0].to_string()),
                                ),
                                (
                                    "description".into(),
                                    CanonicalValue::String(
                                        "manual-must-not-replace-scheduler-intent".into(),
                                    ),
                                ),
                                (
                                    "minCooldownMs".into(),
                                    CanonicalValue::Number(
                                        CanonicalNumber::try_from_u64(5_000).unwrap(),
                                    ),
                                ),
                            ]),
                        )
                        .unwrap(),
                    )
                    .unwrap()
                    .unwrap(),
                ),
            },
        ]));
    }
    let result = apply_resident_entity_round(
        &mut accounts,
        state,
        request,
        &DeterministicContext::hlt_default(),
    )
    .expect("secret ACK timeout must not halt the resident round");
    assert!(
        result.routed_entity_outputs.is_empty(),
        "preparation stays in this certified frame"
    );
    assert_eq!(result.state.entity_command_nonces, nonces);
    (result, accounts, peers)
}

fn wake_request(
    hub: &EntityId,
    root: [u8; 32],
    jobs: Vec<xln_rscore_entity_kernel::ScheduledWakeJob>,
    height: u64,
) -> ResidentEntityRequest {
    ResidentEntityRequest {
        inbound: EntityInboundRequest {
            owner_entity_id: *hub.as_bytes(),
            owning_entity_is_hub: false,
            expected_accounts_root: root,
            clock: ReceiverClock {
                entity_timestamp: DUE,
                finalized_j_height: 100,
            },
            rows: Vec::new(),
            post_accounts: false,
        },
        local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
        entity_height: height,
        outbound_timestamp: DUE,
        outbound_j_height: 100,
        checkpoint_due: false,
        post_accounts: false,
        runtime_seed: None,
        scheduled_wake: Some(ScheduledWake {
            version: 1,
            proposer_signer_id: "hub".into(),
            due_at: DUE - 10,
            jobs,
        }),
        propose_accounts_now: Vec::new(),
        expected_proposer_signer_id: "hub".into(),
        finalized_j_events: None,
        entity_authority: Some(single_signer_authority("hub")),
        local_account_genesis_policy: None,
        cross_j_opening_sibling_views: Vec::new(),
        operations: Vec::new(),
    }
}

pub(super) fn repeat_wake(
    state: EntityStateSlice,
    accounts: &mut ResidentConsensusEngine,
) -> ResidentEntityResult {
    let hub = EntityId::parse(&state.entity_id).unwrap();
    let mut jobs = state
        .paybook
        .entries
        .iter()
        .map(|(_, entry)| xln_rscore_entity_kernel::ScheduledWakeJob {
            kind: xln_rscore_entity_kernel::ScheduledWakeJobKind::Hook,
            id: format!("htlc-secret-ack:{}", entry.hashlock),
            due_at: entry.secret_ack_deadline_at.unwrap(),
        })
        .collect::<Vec<_>>();
    jobs.sort();
    let request = wake_request(&hub, accounts.accounts_root(), jobs, 2);
    apply_resident_entity_round(
        accounts,
        state,
        request,
        &DeterministicContext::hlt_default(),
    )
    .unwrap()
}

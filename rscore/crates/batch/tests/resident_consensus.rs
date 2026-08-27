mod fixture;

use std::sync::Arc;

use num_bigint::BigInt;
use xln_rscore_batch::{
    AccountAdmissionResult, AccountId, AccountSeed, BatchError, EngineGeneration,
    EntityInboundRequest, EntityOutboundRequest, EntityRoundResult, FailedHtlcRoute,
    ResidentConsensusEngine,
};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountEnvelope, AccountIdentity, AccountReplica,
    AccountState, AccountTx, DepositoryAddress, HtlcHashlock, HtlcLockTx, HtlcResolveOutcome,
    HtlcResolveTx, TokenId, WatchSeed, canonical_tx_digest,
};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

const TIMESTAMP: u64 = 1_700_000_000_000;
const REVISION: u64 = 7;

fn resident(
    workers: usize,
    signer: &str,
    revision: u64,
    market: Arc<xln_rscore_engine::SwapMarketPolicy>,
    seeds: Vec<AccountSeed>,
) -> ResidentConsensusEngine {
    ResidentConsensusEngine::restore(
        EngineGeneration::from_bytes([0x42; 8]),
        workers,
        revision,
        fixture::signer_key(signer),
        signer.to_string(),
        market,
        seeds,
    )
    .expect("resident restore")
}

fn funded_seed() -> (AccountSeed, fixture::Pair) {
    let pair = fixture::pair();
    let (left, right) = if pair.payer.to_string() < pair.payee.to_string() {
        (pair.payer.clone(), pair.payee.clone())
    } else {
        (pair.payee.clone(), pair.payer.clone())
    };
    let replica = AccountReplica::new(pair.payer.clone(), fixture::account_state(&left, &right))
        .expect("payer replica");
    (
        AccountSeed {
            account_id: pair.payer_account,
            replica,
            consensus: None,
        },
        pair,
    )
}

fn mixed_txs(pair: &fixture::Pair) -> Vec<AccountTx> {
    let mut txs = fixture::payment(pair, 25).1;
    txs.extend(fixture::swap_offer(pair).1);
    txs.push(AccountTx::HtlcLock(HtlcLockTx {
        lock_id: format!("0x{}", "4b".repeat(32)),
        hashlock: HtlcHashlock::parse(&format!("0x{}", "5a".repeat(32))).expect("hashlock"),
        timelock: BigInt::from(TIMESTAMP + 60_000),
        reveal_before_height: 200,
        amount: BigInt::from(10),
        token_id: TokenId::new(1).expect("token"),
        delivery_mode: None,
        envelope: None,
    }));
    txs
}

fn enter_resident(engine: &mut ResidentConsensusEngine, owner: [u8; 32]) {
    engine
        .entity_inbound(EntityInboundRequest {
            owner_entity_id: owner,
            expected_accounts_root: engine.accounts_root(),
            clock: fixture::clock(TIMESTAMP),
            rows: Vec::new(),
            post_accounts: false,
        })
        .expect("resident inbound");
}

fn outbound_request(
    owner: [u8; 32],
    account_id: AccountId,
    txs: Vec<AccountTx>,
) -> EntityOutboundRequest {
    EntityOutboundRequest {
        owner_entity_id: owner,
        timestamp: TIMESTAMP,
        j_height: 100,
        creates: Vec::new(),
        admits: vec![(account_id, txs)],
        propose: vec![account_id],
        materialize: Vec::new(),
        failed_htlc_routes: Vec::new(),
        checkpoint_due: false,
        post_accounts: true,
    }
}

fn empty_checkpoint_request(owner: [u8; 32]) -> EntityOutboundRequest {
    EntityOutboundRequest {
        owner_entity_id: owner,
        timestamp: TIMESTAMP,
        j_height: 100,
        creates: Vec::new(),
        admits: Vec::new(),
        propose: Vec::new(),
        materialize: Vec::new(),
        failed_htlc_routes: Vec::new(),
        checkpoint_due: true,
        post_accounts: false,
    }
}

#[test]
fn explicit_existing_import_exports_every_seed_until_acked_but_normal_restore_is_clean() {
    let (seed, pair) = funded_seed();
    let mut imported = ResidentConsensusEngine::import_existing(
        EngineGeneration::from_bytes([0x42; 8]),
        4,
        fixture::signer_key("payer-0"),
        "payer-0".to_string(),
        fixture::market(),
        vec![seed.clone()],
    )
    .expect("explicit existing import");
    let imported_root = imported.accounts_root();
    enter_resident(&mut imported, pair.payer_entity);
    let first = imported
        .entity_outbound(empty_checkpoint_request(pair.payer_entity))
        .expect("first imported checkpoint")
        .checkpoint
        .expect("first imported manifest");
    assert_eq!(first.base_revision(), 0);
    assert_eq!(first.revision(), 0);
    assert_eq!(first.accounts_root(), imported_root);
    assert_eq!(first.token.account_count, 1);
    assert_eq!(first.accounts.len(), 1);
    assert_eq!(first.accounts[0].account_id, pair.payer_account);

    let retried = imported
        .entity_outbound(empty_checkpoint_request(pair.payer_entity))
        .expect("retry imported checkpoint before ack")
        .checkpoint
        .expect("retry imported manifest");
    assert_eq!(retried.token, first.token);
    assert_eq!(retried.accounts.len(), 1);
    assert_eq!(retried.accounts[0].account_id, first.accounts[0].account_id);
    assert_eq!(
        retried.accounts[0].account_leaf,
        first.accounts[0].account_leaf
    );
    assert_eq!(retried.accounts[0].sections, first.accounts[0].sections);
    assert_eq!(
        retried.accounts[0].put_count(),
        first.accounts[0].put_count()
    );
    assert_eq!(
        retried.accounts[0].del_count(),
        first.accounts[0].del_count()
    );

    let mut restored = resident(4, "payer-0", 0, fixture::market(), vec![seed]);
    enter_resident(&mut restored, pair.payer_entity);
    let clean = restored
        .entity_outbound(empty_checkpoint_request(pair.payer_entity))
        .expect("normal restore checkpoint")
        .checkpoint
        .expect("normal restore manifest");
    assert_eq!(clean.accounts_root(), imported_root);
    assert_eq!(clean.token.account_count, 1);
    assert!(clean.accounts.is_empty());
}

fn owned_peer_account(
    payer: &xln_rscore_engine::EntityId,
    peer_label: &str,
) -> (AccountId, AccountSeed) {
    let (peer_bytes, peer) = fixture::entity_of(peer_label);
    let (left, right) = if payer < &peer {
        (payer.clone(), peer)
    } else {
        (peer, payer.clone())
    };
    (
        AccountId::from_bytes(peer_bytes),
        AccountSeed {
            account_id: AccountId::from_bytes(peer_bytes),
            replica: AccountReplica::new(payer.clone(), fixture::account_state(&left, &right))
                .expect("owned peer replica"),
            consensus: None,
        },
    )
}

fn expired_forward_lock(lock_id: String, hashlock: HtlcHashlock) -> AccountTx {
    AccountTx::HtlcLock(HtlcLockTx {
        lock_id,
        hashlock,
        timelock: BigInt::from(TIMESTAMP - 1),
        reveal_before_height: 200,
        amount: BigInt::from(10),
        token_id: TokenId::new(1).expect("token"),
        delivery_mode: None,
        envelope: None,
    })
}

#[test]
fn independent_failed_forwards_use_frontier_barriers_and_match_1_and_8_workers() {
    let (_, payer) = fixture::entity_of("payer-0");
    let owner = *payer.as_bytes();
    const PAIR_COUNT: usize = 4;
    const ORDER: [usize; 4] = [2, 0, 3, 1];
    let mut seeds = Vec::new();
    let mut downstreams = Vec::new();
    let mut upstreams = Vec::new();
    let mut hashlocks = Vec::new();
    let mut down_locks = Vec::new();
    let mut up_locks = Vec::new();
    for index in 0..PAIR_COUNT {
        let (downstream, down_seed) = owned_peer_account(&payer, &format!("down-peer-{index}"));
        let (upstream, up_seed) = owned_peer_account(&payer, &format!("up-peer-{index}"));
        seeds.push(down_seed);
        seeds.push(up_seed);
        downstreams.push(downstream);
        upstreams.push(upstream);
        hashlocks.push(
            HtlcHashlock::parse(&format!("0x{}", format!("{:02x}", 0x50 + index).repeat(32)))
                .expect("hashlock"),
        );
        down_locks.push(format!("0x{}", format!("{:02x}", 0x40 + index).repeat(32)));
        up_locks.push(format!("0x{}", format!("{:02x}", 0x30 + index).repeat(32)));
    }
    let propose = ORDER
        .iter()
        .map(|index| downstreams[*index])
        .collect::<Vec<_>>();
    let discovered = ORDER
        .iter()
        .map(|index| upstreams[*index])
        .collect::<Vec<_>>();
    let request = || EntityOutboundRequest {
        owner_entity_id: owner,
        timestamp: TIMESTAMP,
        j_height: 100,
        creates: Vec::new(),
        admits: ORDER
            .iter()
            .map(|index| {
                (
                    downstreams[*index],
                    vec![expired_forward_lock(
                        down_locks[*index].clone(),
                        hashlocks[*index].clone(),
                    )],
                )
            })
            .collect(),
        propose: propose.clone(),
        materialize: Vec::new(),
        failed_htlc_routes: ORDER
            .iter()
            .map(|index| FailedHtlcRoute {
                hashlock: *hashlocks[*index].bytes(),
                outbound_account_id: downstreams[*index],
                outbound_lock_id: down_locks[*index].clone(),
                inbound_account_id: upstreams[*index],
                inbound_lock_id: up_locks[*index].clone(),
            })
            .collect(),
        checkpoint_due: false,
        post_accounts: true,
    };

    let mut expected_rows = None;
    for workers in [1, 8] {
        let mut engine = resident(workers, "payer-0", REVISION, Arc::default(), seeds.clone());
        enter_resident(&mut engine, owner);
        let result = engine
            .entity_outbound(request())
            .expect("independent failed-forward frontier");
        let proposal_ids = result
            .proposals
            .iter()
            .map(|row| row.account_id)
            .collect::<Vec<_>>();
        let expected_ids = propose
            .iter()
            .chain(discovered.iter())
            .copied()
            .collect::<Vec<_>>();
        assert_eq!(proposal_ids, expected_ids, "workers={workers}");
        assert_eq!(result.proposals.len(), 8, "workers={workers}");
        for (proposal, inbound) in result.proposals.iter().take(4).zip(&discovered) {
            assert_eq!(proposal.failed_htlc_locks.len(), 1, "workers={workers}");
            assert_eq!(
                proposal.failed_htlc_locks[0]
                    .upstream_resolution
                    .as_ref()
                    .map(|row| row.account_id),
                Some(*inbound),
                "workers={workers}",
            );
        }
        let barriers = ResidentConsensusEngine::last_htlc_frontier_barriers();
        eprintln!("htlc_frontier_barriers={barriers} workers={workers}");
        assert_eq!(barriers, 3, "two propose frontiers plus one batched admit");
        assert!(
            barriers < PAIR_COUNT * 2,
            "frontier barriers must not scale with account count"
        );
        let signature = (
            result.accounts_root,
            result.revision,
            result.admissions.clone(),
            result.touched.clone(),
            result
                .proposals
                .iter()
                .map(|row| {
                    (
                        row.account_id,
                        row.proposed.as_ref().map(|frame| frame.state_hash),
                        row.failed_htlc_locks
                            .iter()
                            .map(|failed| {
                                (
                                    failed.hashlock,
                                    failed.lock_id.clone(),
                                    failed.reason.clone(),
                                    failed.upstream_resolution.as_ref().map(|row| {
                                        (row.account_id, row.lock_id.clone(), row.reason.clone())
                                    }),
                                )
                            })
                            .collect::<Vec<_>>(),
                    )
                })
                .collect::<Vec<_>>(),
        );
        if let Some(expected) = &expected_rows {
            assert_eq!(&signature, expected, "workers={workers}");
        } else {
            expected_rows = Some(signature);
        }
    }
}

type ProposalSignature = (
    [u8; 32],
    u64,
    Vec<AccountAdmissionResult>,
    Vec<(AccountId, [u8; 32])>,
    Vec<(
        AccountId,
        Option<[u8; 32]>,
        Vec<(
            [u8; 32],
            String,
            String,
            Option<(AccountId, String, String)>,
        )>,
    )>,
);

fn proposal_signature(result: &EntityRoundResult) -> ProposalSignature {
    (
        result.accounts_root,
        result.revision,
        result.admissions.clone(),
        result.touched.clone(),
        result
            .proposals
            .iter()
            .map(|row| {
                (
                    row.account_id,
                    row.proposed.as_ref().map(|frame| frame.state_hash),
                    row.failed_htlc_locks
                        .iter()
                        .map(|failed| {
                            (
                                failed.hashlock,
                                failed.lock_id.clone(),
                                failed.reason.clone(),
                                failed.upstream_resolution.as_ref().map(|row| {
                                    (row.account_id, row.lock_id.clone(), row.reason.clone())
                                }),
                            )
                        })
                        .collect::<Vec<_>>(),
                )
            })
            .collect::<Vec<_>>(),
    )
}

#[test]
fn proposed_inbound_waits_for_outbound_resolution_and_matches_1_and_8_workers() {
    let (_, payer) = fixture::entity_of("payer-0");
    let owner = *payer.as_bytes();
    let hashlock = HtlcHashlock::parse(&format!("0x{}", "5a".repeat(32))).expect("hashlock");
    let down_lock = format!("0x{}", "4b".repeat(32));
    let up_lock = format!("0x{}", "3c".repeat(32));
    let (downstream, down_seed) = owned_peer_account(&payer, "down-peer-dep");
    let (upstream, up_seed) = owned_peer_account(&payer, "up-peer-dep");
    let seeds = vec![down_seed, up_seed];
    let request = || EntityOutboundRequest {
        owner_entity_id: owner,
        timestamp: TIMESTAMP,
        j_height: 100,
        creates: Vec::new(),
        admits: vec![
            (
                downstream,
                vec![expired_forward_lock(down_lock.clone(), hashlock.clone())],
            ),
            (
                upstream,
                vec![AccountTx::SetCreditLimit {
                    token_id: TokenId::new(1).expect("token"),
                    amount: BigInt::from(123),
                }],
            ),
        ],
        propose: vec![downstream, upstream],
        materialize: Vec::new(),
        failed_htlc_routes: vec![FailedHtlcRoute {
            hashlock: *hashlock.bytes(),
            outbound_account_id: downstream,
            outbound_lock_id: down_lock.clone(),
            inbound_account_id: upstream,
            inbound_lock_id: up_lock.clone(),
        }],
        checkpoint_due: false,
        post_accounts: true,
    };

    let mut expected_rows = None;
    for workers in [1, 8] {
        let mut engine = resident(workers, "payer-0", REVISION, Arc::default(), seeds.clone());
        enter_resident(&mut engine, owner);
        let result = engine
            .entity_outbound(request())
            .expect("dependent A->B both proposed");
        let proposal_ids = result
            .proposals
            .iter()
            .map(|row| row.account_id)
            .collect::<Vec<_>>();
        assert_eq!(
            proposal_ids,
            vec![downstream, upstream],
            "workers={workers}"
        );
        assert_eq!(result.proposals.len(), 2, "workers={workers}");
        assert_eq!(
            result.proposals[0].failed_htlc_locks.len(),
            1,
            "workers={workers}"
        );
        assert_eq!(
            result.proposals[0].failed_htlc_locks[0]
                .upstream_resolution
                .as_ref()
                .map(|row| (row.account_id, row.lock_id.as_str())),
            Some((upstream, up_lock.as_str())),
            "workers={workers}",
        );
        let upstream_reason = result.proposals[0].failed_htlc_locks[0]
            .upstream_resolution
            .as_ref()
            .expect("upstream resolution")
            .reason
            .clone();
        let resolution_digest = canonical_tx_digest(&AccountTx::HtlcResolve(HtlcResolveTx {
            lock_id: up_lock.clone(),
            outcome: HtlcResolveOutcome::Error {
                reason: Some(upstream_reason),
            },
        }))
        .expect("resolution digest");
        let inbound = &result.proposals[1];
        assert!(
            inbound.proposed.as_ref().is_some_and(|frame| {
                frame.frame.txs.iter().any(|tx| {
                    canonical_tx_digest(tx).is_ok_and(|digest| digest == resolution_digest)
                })
            }) || inbound
                .dropped
                .iter()
                .any(|row| row.tx_digest == resolution_digest),
            "B must process A's failed-forward resolution before proposing workers={workers}",
        );
        let barriers = ResidentConsensusEngine::last_htlc_frontier_barriers();
        eprintln!("dependent_htlc_frontier_barriers={barriers} workers={workers}");
        assert_eq!(barriers, 3, "A propose, batched admit, B propose");
        let signature = proposal_signature(&result);
        if let Some(expected) = &expected_rows {
            assert_eq!(&signature, expected, "workers={workers}");
        } else {
            expected_rows = Some(signature);
        }
    }
}

#[test]
fn resident_result_is_root_identical_with_1_2_4_8_16_workers() {
    let (seed, pair) = funded_seed();
    let mut expected = None;
    for workers in [1, 2, 4, 8, 16] {
        let mut engine = resident(
            workers,
            "payer-0",
            REVISION,
            fixture::market(),
            vec![seed.clone()],
        );
        enter_resident(&mut engine, pair.payer_entity);
        let result = engine
            .entity_outbound(outbound_request(
                pair.payer_entity,
                pair.payer_account,
                mixed_txs(&pair),
            ))
            .expect("resident outbound");
        let signature = (
            result.revision,
            result.accounts_root,
            result.touched,
            result.proposals[0]
                .proposed
                .as_ref()
                .expect("frame")
                .state_hash,
        );
        if let Some(expected) = &expected {
            assert_eq!(&signature, expected, "workers={workers}");
        } else {
            expected = Some(signature);
        }
    }
}

#[test]
fn resident_refuses_to_guess_proposability_for_an_unrepresented_settlement_workspace() {
    let (mut seed, _) = funded_seed();
    seed.replica.set_settlement_workspace_present(true);
    let error = match ResidentConsensusEngine::restore(
        EngineGeneration::from_bytes([0x42; 8]),
        1,
        REVISION,
        fixture::signer_key("payer-0"),
        "payer-0".to_string(),
        fixture::market(),
        vec![seed],
    ) {
        Ok(_) => panic!("settlement eligibility cannot be inferred from a presence bit"),
        Err(error) => error,
    };
    assert_eq!(error, BatchError::ProposabilitySettlementUnrepresented,);
}

#[test]
fn failed_outbound_restores_the_exact_post_inbound_head() {
    let (seed, pair) = funded_seed();
    let mut engine = resident(4, "payer-0", REVISION, fixture::market(), vec![seed]);
    enter_resident(&mut engine, pair.payer_entity);
    let root = engine.accounts_root();
    let revision = engine.revision();
    let count = engine.account_count();
    let proposable = engine
        .proposable_account_ids()
        .expect("pre-error proposer index");
    let (created, owner, _) = genesis_seed("payer-0", "new-peer");
    assert_eq!(owner, pair.payer_entity);
    let error = match engine.entity_outbound(EntityOutboundRequest {
        owner_entity_id: pair.payer_entity,
        timestamp: TIMESTAMP,
        j_height: 100,
        creates: vec![created],
        admits: vec![(pair.payer_account, fixture::payment(&pair, 25).1)],
        propose: Vec::new(),
        materialize: vec![AccountId::from_bytes([0xfe; 32])],
        failed_htlc_routes: Vec::new(),
        checkpoint_due: false,
        post_accounts: false,
    }) {
        Ok(_) => panic!("unknown materialization account must fail"),
        Err(error) => error,
    };
    assert!(matches!(
        error,
        xln_rscore_batch::BatchError::AccountNotFound { .. }
            | xln_rscore_batch::BatchError::CandidateAccountNotFound(_)
    ));
    assert_eq!(engine.accounts_root(), root);
    assert_eq!(engine.revision(), revision);
    assert_eq!(engine.account_count(), count);
    assert_eq!(
        engine
            .proposable_account_ids()
            .expect("post-error proposer index"),
        proposable,
    );
}

fn number(value: u32) -> CanonicalValue {
    CanonicalValue::Number(CanonicalNumber::from_u32(value))
}

fn genesis_seed(owner_signer: &str, peer_signer: &str) -> (AccountSeed, [u8; 32], [u8; 32]) {
    let (owner_bytes, owner) = fixture::entity_of(owner_signer);
    let (peer_bytes, peer) = fixture::entity_of(peer_signer);
    let (left, right) = if owner < peer {
        (owner.clone(), peer.clone())
    } else {
        (peer.clone(), owner.clone())
    };
    let state = AccountState::new(
        AccountIdentity::new(
            test_domain(),
            left,
            right,
            WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
        )
        .expect("identity"),
        AccountDisputeConfig::new(10, 10).expect("dispute"),
        Vec::new(),
    )
    .expect("state");
    let mut replica = AccountReplica::new(owner, state).expect("replica");
    replica.set_delta_transformer([0x77; 20]);
    replica.set_envelope(genesis_envelope(&replica));
    (
        AccountSeed {
            account_id: AccountId::from_bytes(peer_bytes),
            replica,
            consensus: None,
        },
        owner_bytes,
        peer_bytes,
    )
}

fn test_domain() -> AccountDomain {
    AccountDomain::new(
        31_337,
        DepositoryAddress::parse(&format!("0x{}", "88".repeat(20))).expect("depository"),
    )
    .expect("domain")
}

fn genesis_envelope(replica: &AccountReplica) -> AccountEnvelope {
    let zero = CanonicalValue::String(format!("0x{}", "00".repeat(32)));
    AccountEnvelope::new(
        vec![
            (
                "status".to_string(),
                CanonicalValue::String("active".to_string()),
            ),
            ("currentHeight".to_string(), number(0)),
            ("rollbackCount".to_string(), number(0)),
            (
                "proofHeader".to_string(),
                CanonicalValue::Object(vec![
                    (
                        "fromEntity".to_string(),
                        CanonicalValue::String(replica.owner().to_string()),
                    ),
                    (
                        "toEntity".to_string(),
                        CanonicalValue::String(replica.counterparty().to_string()),
                    ),
                    ("nextProofNonce".to_string(), number(1)),
                ]),
            ),
            (
                "currentFrameHash".to_string(),
                CanonicalValue::String(String::new()),
            ),
            ("pendingWithdrawals".to_string(), zero.clone()),
            (
                "shadow".to_string(),
                CanonicalValue::Object(vec![(
                    "rebalance".to_string(),
                    CanonicalValue::Object(vec![
                        (
                            "policyRoot".to_string(),
                            CanonicalValue::String(format!("0x{}", "00".repeat(32))),
                        ),
                        ("submittedAtByTokenRoot".to_string(), zero),
                    ]),
                )]),
            ),
        ],
        Vec::new(),
    )
    .expect("H0 envelope")
}

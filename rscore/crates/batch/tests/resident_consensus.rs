mod fixture;

use std::sync::Arc;

use num_bigint::BigInt;
use xln_rscore_batch::{
    AccountEnvelopeUpdate, AccountId, AccountInputBoardAuthority, AccountInputRow,
    AccountInputVerdict, AccountPhaseKind, AccountSeed, CertifiedSettlementHankoDraft,
    EngineGeneration, EntityInboundRequest, EntityOutboundRequest, FailedHtlcFollowup,
    PendingSettlementHankoDraft, ResidentConsensusEngine,
};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountEnvelope, AccountIdentity, AccountReplica,
    AccountState, AccountTx, DepositoryAddress, HtlcHashlock, HtlcLockTx, HtlcResolveOutcome,
    HtlcResolveTx, SettlementHankoDraft, TokenId, WatchSeed,
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
    let hashlock = format!("0x{}", "5a".repeat(32));
    txs.push(AccountTx::HtlcLock(HtlcLockTx {
        lock_id: hashlock.clone(),
        hashlock: HtlcHashlock::parse(&hashlock).expect("hashlock"),
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
        local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
        timestamp: TIMESTAMP,
        j_height: 100,
        creates: Vec::new(),
        envelope_updates: Vec::new(),
        unsigned_settlement_txs: Vec::new(),
        proposal_work: vec![(account_id, txs, false)],
        checkpoint_due: false,
        post_accounts: true,
    }
}

fn force_ack_request(
    owner: [u8; 32],
    account_id: AccountId,
    txs: Vec<AccountTx>,
) -> EntityOutboundRequest {
    let mut request = outbound_request(owner, account_id, txs);
    request.proposal_work[0].2 = true;
    request
}

fn empty_checkpoint_request(owner: [u8; 32]) -> EntityOutboundRequest {
    EntityOutboundRequest {
        owner_entity_id: owner,
        local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
        timestamp: TIMESTAMP,
        j_height: 100,
        creates: Vec::new(),
        envelope_updates: Vec::new(),
        unsigned_settlement_txs: Vec::new(),
        proposal_work: Vec::new(),
        checkpoint_due: true,
        post_accounts: false,
    }
}

/// A funded seed whose rebalance shadow trees are both empty, so a test can
/// assert the exact rows one envelope transition produced.
fn seed_with_empty_shadow() -> (AccountSeed, fixture::Pair) {
    let (mut seed, pair) = funded_seed();
    let empty_root = format!("0x{}", hex::encode(xln_rscore_protocol::EMPTY_RADIX_ROOT));
    seed.replica.set_envelope(
        AccountEnvelope::new(
            vec![
                ("status".into(), CanonicalValue::String("active".into())),
                (
                    "shadow".into(),
                    CanonicalValue::Object(vec![(
                        "rebalance".into(),
                        CanonicalValue::Object(vec![
                            (
                                "policyRoot".into(),
                                CanonicalValue::String(empty_root.clone()),
                            ),
                            (
                                "submittedAtByTokenRoot".into(),
                                CanonicalValue::String(empty_root),
                            ),
                        ]),
                    )]),
                ),
            ],
            Vec::new(),
        )
        .expect("empty shadow"),
    );
    (seed, pair)
}

/// The R2C "already submitted" marker is Entity-owned coordination that is
/// nonetheless hashed into the Entity Account leaf. It therefore travels as one
/// narrow typed transition — never a generic envelope field write — and
/// `submitted_at: None` is the release.
#[test]
fn entity_owned_rebalance_submitted_marker_sets_and_releases_one_token() {
    let (seed, pair) = seed_with_empty_shadow();
    let mut engine = resident(2, "payer-0", REVISION, Arc::default(), vec![seed]);
    enter_resident(&mut engine, pair.payer_entity);
    let stamp = |engine: &mut ResidentConsensusEngine, submitted_at: Option<u64>| {
        engine
            .entity_outbound(EntityOutboundRequest {
                owner_entity_id: pair.payer_entity,
                local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
                timestamp: TIMESTAMP,
                j_height: 100,
                creates: Vec::new(),
                envelope_updates: vec![(
                    pair.payer_account,
                    vec![AccountEnvelopeUpdate::SetRebalanceSubmittedAt {
                        token_id: 1,
                        submitted_at,
                    }],
                )],
                unsigned_settlement_txs: Vec::new(),
                proposal_work: vec![(pair.payer_account, Vec::new(), false)],
                checkpoint_due: false,
                post_accounts: true,
            })
            .expect("submitted marker")
    };

    let set = stamp(&mut engine, Some(TIMESTAMP));
    assert_eq!(
        set.post_accounts
            .first()
            .expect("materialized account")
            .header
            .envelope
            .rebalance_shadow_submitted_rows(),
        [(1, TIMESTAMP)]
    );

    enter_resident(&mut engine, pair.payer_entity);
    let released = stamp(&mut engine, None);
    assert!(
        released
            .post_accounts
            .first()
            .expect("materialized account")
            .header
            .envelope
            .rebalance_shadow_submitted_rows()
            .is_empty()
    );
}

#[test]
fn entity_owned_rebalance_policy_updates_the_resident_leaf_and_checkpoint_body() {
    let (mut seed, pair) = funded_seed();
    let empty_root = format!("0x{}", hex::encode(xln_rscore_protocol::EMPTY_RADIX_ROOT));
    seed.replica.set_envelope(
        AccountEnvelope::new(
            vec![
                ("status".into(), CanonicalValue::String("active".into())),
                (
                    "shadow".into(),
                    CanonicalValue::Object(vec![(
                        "rebalance".into(),
                        CanonicalValue::Object(vec![
                            (
                                "policyRoot".into(),
                                CanonicalValue::String(empty_root.clone()),
                            ),
                            (
                                "submittedAtByTokenRoot".into(),
                                CanonicalValue::String(empty_root),
                            ),
                        ]),
                    )]),
                ),
            ],
            Vec::new(),
        )
        .expect("empty shadow"),
    );
    let mut engine = resident(2, "payer-0", REVISION, Arc::default(), vec![seed]);
    enter_resident(&mut engine, pair.payer_entity);
    let policy = CanonicalValue::Object(vec![
        (
            "r2cRequestSoftLimit".into(),
            CanonicalValue::BigInt(10_u8.into()),
        ),
        ("hardLimit".into(), CanonicalValue::BigInt(20_u8.into())),
        (
            "maxAcceptableFee".into(),
            CanonicalValue::BigInt(1_u8.into()),
        ),
    ]);
    let result = engine
        .entity_outbound(EntityOutboundRequest {
            owner_entity_id: pair.payer_entity,
            local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
            timestamp: TIMESTAMP,
            j_height: 100,
            creates: Vec::new(),
            envelope_updates: vec![(
                pair.payer_account,
                vec![AccountEnvelopeUpdate::SetRebalancePolicy {
                    token_id: 1,
                    policy: policy.clone(),
                }],
            )],
            unsigned_settlement_txs: Vec::new(),
            proposal_work: vec![(pair.payer_account, Vec::new(), false)],
            checkpoint_due: false,
            post_accounts: true,
        })
        .expect("policy update");
    let row = result.post_accounts.first().expect("materialized account");
    assert_eq!(
        row.header.envelope.rebalance_shadow_policy_rows(),
        [(1, policy)]
    );
}

#[test]
fn prepared_account_ignores_a_signed_peer_frame_before_replay_or_commit() {
    let (payer_seed, pair) = funded_seed();
    let (left, right) = if pair.payer < pair.payee {
        (pair.payer.clone(), pair.payee.clone())
    } else {
        (pair.payee.clone(), pair.payer.clone())
    };
    let payee_seed = AccountSeed {
        account_id: pair.payee_account,
        replica: AccountReplica::new(pair.payee.clone(), fixture::account_state(&left, &right))
            .expect("payee replica"),
        consensus: None,
    };
    let mut payer = resident(1, "payer-0", REVISION, fixture::market(), vec![payer_seed]);
    let mut payee = resident(1, "payee-0", REVISION, fixture::market(), vec![payee_seed]);

    enter_resident(&mut payer, pair.payer_entity);
    let pending = payer
        .entity_outbound(outbound_request(
            pair.payer_entity,
            pair.payer_account,
            fixture::payment(&pair, 25).1,
        ))
        .expect("payer pending frame");
    assert!(pending.proposals[0].proposed.is_some());

    enter_resident(&mut payee, pair.payee_entity);
    let signed_peer = payee
        .entity_outbound(outbound_request(
            pair.payee_entity,
            pair.payee_account,
            vec![AccountTx::DirectPayment {
                token_id: TokenId::new(1).expect("token"),
                amount: BigInt::from(17),
                route: vec![pair.payer.to_string()],
                description: None,
                from_entity_id: pair.payee.to_string(),
                to_entity_id: pair.payer.to_string(),
                delivery_mode: xln_rscore_engine::DeliveryMode::Direct,
                trusted_gateway_entity_id: None,
            }],
        ))
        .expect("signed peer frame")
        .proposals
        .into_iter()
        .next()
        .and_then(|proposal| proposal.outbound_input)
        .expect("peer AccountInput");

    enter_resident(&mut payer, pair.payer_entity);
    let frozen = payer
        .entity_outbound(EntityOutboundRequest {
            owner_entity_id: pair.payer_entity,
            local_certified_board_authority: AccountInputBoardAuthority::Lazy,
            timestamp: TIMESTAMP,
            j_height: 100,
            creates: Vec::new(),
            envelope_updates: vec![(
                pair.payer_account,
                vec![AccountEnvelopeUpdate::ReplaceDisputeLifecycle {
                    status: "dispute_preparing".into(),
                    dispute_prepare: Some(CanonicalValue::Object(Vec::new())),
                    active_dispute: None,
                }],
            )],
            unsigned_settlement_txs: Vec::new(),
            proposal_work: Vec::new(),
            checkpoint_due: false,
            post_accounts: true,
        })
        .expect("freeze payer account");
    let frozen_account = &frozen.post_accounts[0];
    assert!(frozen_account.consensus.pending.is_none());
    assert!(frozen_account.consensus.current.is_none());
    let frozen_root = frozen.accounts_root;

    let ignored = payer
        .entity_inbound(EntityInboundRequest {
            owner_entity_id: pair.payer_entity,
            expected_accounts_root: frozen_root,
            clock: fixture::clock(TIMESTAMP),
            rows: vec![AccountInputRow {
                operation_index: 0,
                account_id: pair.payer_account,
                genesis_policy: None,
                certified_board_authority: AccountInputBoardAuthority::Lazy,
                local_certified_board_authority: AccountInputBoardAuthority::Lazy,
                input: signed_peer,
            }],
            post_accounts: false,
        })
        .expect("frozen Account input is a no-op");

    assert_eq!(ignored.accounts_root, frozen_root);
    assert!(matches!(
        ignored.applied[0].verdict,
        AccountInputVerdict::Failed(ref reason) if reason == "ACCOUNT_INPUT_STATUS_FROZEN"
    ));
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

#[test]
fn failed_htlc_uses_one_exact_continuation_and_matches_workers() {
    let (_, owner_entity) = fixture::entity_of("payer-0");
    let owner = *owner_entity.as_bytes();
    let (downstream_bytes, downstream_peer) = fixture::entity_of("downstream-peer");
    let (upstream_bytes, upstream_peer) = fixture::entity_of("upstream-peer");
    let downstream = AccountId::from_bytes(downstream_bytes);
    let upstream = AccountId::from_bytes(upstream_bytes);
    let seed = |account_id, peer: xln_rscore_engine::EntityId| {
        let (left, right) = if owner_entity < peer {
            (owner_entity.clone(), peer)
        } else {
            (peer, owner_entity.clone())
        };
        AccountSeed {
            account_id,
            replica: AccountReplica::new(
                owner_entity.clone(),
                fixture::account_state(&left, &right),
            )
            .expect("owned account"),
            consensus: None,
        }
    };
    let seeds = vec![
        seed(downstream, downstream_peer),
        seed(upstream, upstream_peer),
    ];
    let hashlock_text = format!("0x{}", "5a".repeat(32));
    let hashlock = HtlcHashlock::parse(&hashlock_text).expect("hashlock");
    let mut expected = None;
    for workers in [1, 8] {
        let mut engine = resident(workers, "payer-0", REVISION, Arc::default(), seeds.clone());
        enter_resident(&mut engine, owner);
        let prepared = engine
            .prepare_entity_outbound(EntityOutboundRequest {
                owner_entity_id: owner,
                local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
                timestamp: TIMESTAMP,
                j_height: 100,
                creates: Vec::new(),
                envelope_updates: Vec::new(),
                unsigned_settlement_txs: Vec::new(),
                proposal_work: vec![(
                    downstream,
                    vec![AccountTx::HtlcLock(HtlcLockTx {
                        lock_id: hashlock_text.clone(),
                        hashlock: hashlock.clone(),
                        timelock: BigInt::from(TIMESTAMP - 1),
                        reveal_before_height: 200,
                        amount: BigInt::from(10),
                        token_id: TokenId::new(1).expect("token"),
                        delivery_mode: None,
                        envelope: None,
                    })],
                    false,
                )],
                checkpoint_due: false,
                post_accounts: true,
            })
            .expect("first outbound wave");
        let failed = &prepared.proposals()[0].failed_htlc_locks[0];
        let reason = format!("forward_failed:{}", failed.reason);
        let result = engine
            .finish_entity_outbound(
                prepared,
                vec![FailedHtlcFollowup {
                    failed_account_id: downstream,
                    hashlock: *hashlock.bytes(),
                    upstream_account_id: upstream,
                    tx: AccountTx::HtlcResolve(HtlcResolveTx {
                        lock_id: hashlock_text.clone(),
                        outcome: HtlcResolveOutcome::Error {
                            reason: Some(reason.clone()),
                        },
                    }),
                    reason,
                }],
            )
            .expect("one continuation wave");
        assert_eq!(result.proposals.len(), 2, "workers={workers}");
        assert_eq!(
            result.proposals[1].account_id, upstream,
            "workers={workers}"
        );
        assert_eq!(result.admissions.len(), 2, "workers={workers}");
        let phases = engine.account_phase_metrics();
        let failed = phases
            .iter()
            .find(|metric| metric.kind == AccountPhaseKind::OutboundFailedHtlcFollowup)
            .expect("failed HTLC metric");
        let settlement = phases
            .iter()
            .find(|metric| metric.kind == AccountPhaseKind::OutboundSettlementHankoAttach)
            .expect("settlement metric");
        assert_eq!(failed.invocations, 1, "workers={workers}");
        assert_eq!(failed.continuation_rounds, 1, "workers={workers}");
        assert_eq!(failed.worker_rows.iter().sum::<u64>(), failed.touched_rows);
        assert_eq!(settlement.invocations, 0, "workers={workers}");
        assert_eq!(
            result.proposals[0].failed_htlc_locks[0]
                .upstream_resolution
                .as_ref()
                .map(|row| (row.account_id, row.lock_id.as_str())),
            Some((upstream, hashlock_text.as_str())),
            "workers={workers}",
        );
        let signature = (result.accounts_root, result.revision, result.touched);
        if let Some(expected) = &expected {
            assert_eq!(&signature, expected, "workers={workers}");
        } else {
            expected = Some(signature);
        }
    }
}

#[cfg(any())]
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
        local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
        timestamp: TIMESTAMP,
        j_height: 100,
        creates: Vec::new(),
        envelope_updates: Vec::new(),
        unsigned_settlement_txs: Vec::new(),
        proposal_work: ORDER
            .iter()
            .map(|index| {
                (
                    downstreams[*index],
                    vec![expired_forward_lock(
                        down_locks[*index].clone(),
                        hashlocks[*index].clone(),
                    )],
                    false,
                )
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

#[cfg(any())]
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
        local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
        timestamp: TIMESTAMP,
        j_height: 100,
        creates: Vec::new(),
        envelope_updates: Vec::new(),
        unsigned_settlement_txs: Vec::new(),
        proposal_work: vec![
            (
                downstream,
                vec![expired_forward_lock(down_lock.clone(), hashlock.clone())],
                false,
            ),
            (
                upstream,
                vec![AccountTx::SetCreditLimit {
                    token_id: TokenId::new(1).expect("token"),
                    amount: BigInt::from(123),
                }],
                false,
            ),
        ],
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
fn unsigned_settlement_transition_is_sealed_before_certified_hankos_attach() {
    let (seed, pair) = funded_seed();
    let mut engine = resident(4, "payer-0", REVISION, fixture::market(), vec![seed]);
    enter_resident(&mut engine, pair.payer_entity);
    let prior_root = engine.accounts_root();
    let unsigned = AccountTx::SettleTransition {
        data: CanonicalValue::Object(vec![
            ("kind".into(), CanonicalValue::String("hanko".into())),
            (
                "settlementHash".into(),
                CanonicalValue::String(format!("0x{}", "11".repeat(32))),
            ),
            (
                "postProof".into(),
                CanonicalValue::Object(vec![(
                    "disputeHash".into(),
                    CanonicalValue::String(format!("0x{}", "22".repeat(32))),
                )]),
            ),
        ]),
    };
    let draft = SettlementHankoDraft {
        tx: unsigned.clone(),
        settlement_hash: Some([0x11; 32]),
        dispute_hash: [0x22; 32],
        settlement_nonce: 1,
        proof_nonce: 2,
    };
    let result = engine
        .entity_outbound(EntityOutboundRequest {
            owner_entity_id: pair.payer_entity,
            local_certified_board_authority: AccountInputBoardAuthority::Lazy,
            timestamp: TIMESTAMP,
            j_height: 100,
            creates: Vec::new(),
            envelope_updates: Vec::new(),
            unsigned_settlement_txs: vec![(pair.payer_account, unsigned)],
            proposal_work: Vec::new(),
            checkpoint_due: false,
            post_accounts: false,
        })
        .expect("pre-certification Account stage");
    assert!(
        result.proposals.is_empty(),
        "unsigned transition cannot be sent"
    );
    assert_eq!(
        result.accounts_root, prior_root,
        "an unsigned local queue entry is recovery state, not Entity state"
    );
    assert_eq!(
        engine
            .account_status(pair.payer_account, Vec::new())
            .expect("status")
            .expect("account")
            .mempool_len,
        1,
    );

    engine
        .attach_certified_settlement_hankos(vec![CertifiedSettlementHankoDraft {
            pending: PendingSettlementHankoDraft {
                account_id: pair.payer_account,
                draft,
            },
            settlement_hanko: Some(vec![0x31, 0x32]),
            dispute_hanko: vec![0x41, 0x42],
        }])
        .expect("attach manifest witnesses");
    let phases = engine.account_phase_metrics();
    let failed = phases
        .iter()
        .find(|metric| metric.kind == AccountPhaseKind::OutboundFailedHtlcFollowup)
        .expect("failed HTLC metric");
    let settlement = phases
        .iter()
        .find(|metric| metric.kind == AccountPhaseKind::OutboundSettlementHankoAttach)
        .expect("settlement metric");
    assert_eq!(failed.invocations, 0);
    assert_eq!(settlement.invocations, 1);
    assert_eq!(settlement.continuation_rounds, 1);
    assert_eq!(
        settlement.worker_rows.iter().sum::<u64>(),
        settlement.touched_rows
    );
    assert_eq!(engine.accounts_root(), result.accounts_root);
    assert_eq!(
        engine
            .account_status(pair.payer_account, Vec::new())
            .expect("status")
            .expect("account")
            .mempool_len,
        1,
        "witness attachment replaces rather than appends",
    );
}

#[test]
fn create_admit_propose_and_force_ack_share_one_outbound_worker_wave() {
    let mut expected = None;
    for workers in [1, 4] {
        let (payer_seed, pair) = funded_seed();
        let (left, right) = if pair.payer < pair.payee {
            (pair.payer.clone(), pair.payee.clone())
        } else {
            (pair.payee.clone(), pair.payer.clone())
        };
        let payee_seed = AccountSeed {
            account_id: pair.payee_account,
            replica: AccountReplica::new(pair.payee.clone(), fixture::account_state(&left, &right))
                .expect("payee replica"),
            consensus: None,
        };
        let mut payee = resident(1, "payee-0", 0, fixture::market(), vec![payee_seed]);
        enter_resident(&mut payee, pair.payee_entity);
        let signed_peer = payee
            .entity_outbound(outbound_request(
                pair.payee_entity,
                pair.payee_account,
                vec![AccountTx::DirectPayment {
                    token_id: TokenId::new(1).expect("token"),
                    amount: BigInt::from(17),
                    route: vec![pair.payer.to_string()],
                    description: None,
                    from_entity_id: pair.payee.to_string(),
                    to_entity_id: pair.payer.to_string(),
                    delivery_mode: xln_rscore_engine::DeliveryMode::Direct,
                    trusted_gateway_entity_id: None,
                }],
            ))
            .expect("signed peer frame")
            .proposals
            .into_iter()
            .next()
            .and_then(|proposal| proposal.outbound_input)
            .expect("peer AccountInput");

        let (created, owner, _) = genesis_seed("payer-0", "new-peer");
        assert_eq!(owner, pair.payer_entity);
        let created_account = created.account_id;
        let create_tx = AccountTx::AddDelta {
            token_id: TokenId::new(1).expect("token"),
        };
        let local_tx = fixture::payment(&pair, 25).1;
        let mut engine = resident(workers, "payer-0", 0, fixture::market(), vec![payer_seed]);
        engine
            .entity_inbound(EntityInboundRequest {
                owner_entity_id: owner,
                expected_accounts_root: engine.accounts_root(),
                clock: fixture::clock(TIMESTAMP),
                rows: vec![AccountInputRow {
                    operation_index: 0,
                    account_id: pair.payer_account,
                    genesis_policy: None,
                    certified_board_authority: AccountInputBoardAuthority::Lazy,
                    local_certified_board_authority: AccountInputBoardAuthority::Lazy,
                    input: signed_peer,
                }],
                post_accounts: false,
            })
            .expect("accepted peer frame");
        let result = engine
            .entity_outbound(EntityOutboundRequest {
                owner_entity_id: owner,
                local_certified_board_authority: AccountInputBoardAuthority::Lazy,
                timestamp: TIMESTAMP,
                j_height: 100,
                creates: vec![created],
                envelope_updates: Vec::new(),
                unsigned_settlement_txs: Vec::new(),
                proposal_work: vec![
                    (pair.payer_account, local_tx.clone(), true),
                    (created_account, vec![create_tx.clone()], false),
                ],
                checkpoint_due: false,
                post_accounts: false,
            })
            .expect("one-wave create/admit/propose");

        let outbound = engine
            .account_phase_metrics()
            .into_iter()
            .find(|metric| metric.kind == AccountPhaseKind::OutboundReset)
            .expect("outbound phase metric");
        assert_eq!(outbound.invocations, 1, "workers={workers}");
        assert_eq!(outbound.touched_rows, 2, "workers={workers}");
        assert_eq!(result.admissions.len(), 2, "workers={workers}");
        assert_eq!(result.proposals.len(), 2, "workers={workers}");
        assert_eq!(result.proposals[0].account_id, pair.payer_account);
        assert_eq!(result.proposals[1].account_id, created_account);
        let acked = &result.proposals[0];
        let incoming = acked.incoming_ref().expect("local proposed Account frame");
        assert_eq!(incoming.frame.txs, local_tx, "workers={workers}");
        assert!(
            matches!(
                &acked.outbound_input,
                Some(xln_rscore_batch::AccountInput {
                    kind: xln_rscore_batch::AccountInputKind::AckFrame { ack: Some(_), .. },
                    ..
                })
            ),
            "force ACK stays bundled workers={workers}",
        );
        assert_eq!(
            result.proposals[1]
                .incoming_ref()
                .expect("created Account proposal")
                .frame
                .txs,
            vec![create_tx],
            "create and admission share the proposal wave workers={workers}",
        );
        let signature = (
            result.accounts_root,
            result.revision,
            result.touched.clone(),
            result
                .proposals
                .iter()
                .map(|proposal| {
                    (
                        proposal.account_id,
                        proposal.proposed.as_ref().map(|row| row.state_hash),
                        proposal
                            .incoming_ref()
                            .map(|incoming| incoming.frame.clone()),
                    )
                })
                .collect::<Vec<_>>(),
        );
        if let Some(expected) = &expected {
            assert_eq!(&signature, expected, "worker-count parity");
        } else {
            expected = Some(signature);
        }
    }
}

/// At-least-once transport retries the exact pending ACK(H1)+proposal(H2).
/// The first delivery may already have advanced the peer to H2. A delayed,
/// authenticated standalone ACK(H1) is therefore an exact predecessor no-op;
/// the pending ACK(H1)+proposal(H2) retry must still preserve its full bundle.
#[test]
fn duplicate_predecessor_retries_pending_bundle_and_reacks_duplicate_successor() {
    let (payer_seed, pair) = funded_seed();
    let (left, right) = if pair.payer < pair.payee {
        (pair.payer.clone(), pair.payee.clone())
    } else {
        (pair.payee.clone(), pair.payer.clone())
    };
    let payee_seed = AccountSeed {
        account_id: pair.payee_account,
        replica: AccountReplica::new(pair.payee.clone(), fixture::account_state(&left, &right))
            .expect("payee replica"),
        consensus: None,
    };
    let mut payer = resident(1, "payer-0", 0, fixture::market(), vec![payer_seed]);
    let mut payee = resident(1, "payee-0", 0, fixture::market(), vec![payee_seed]);

    enter_resident(&mut payee, pair.payee_entity);
    let predecessor = payee
        .entity_outbound(outbound_request(
            pair.payee_entity,
            pair.payee_account,
            vec![AccountTx::DirectPayment {
                token_id: TokenId::new(1).expect("token"),
                amount: BigInt::from(17),
                route: vec![pair.payer.to_string()],
                description: None,
                from_entity_id: pair.payee.to_string(),
                to_entity_id: pair.payer.to_string(),
                delivery_mode: xln_rscore_engine::DeliveryMode::Direct,
                trusted_gateway_entity_id: None,
            }],
        ))
        .expect("payee H1")
        .proposals
        .into_iter()
        .next()
        .and_then(|row| row.outbound_input)
        .expect("payee H1 input");

    let receive = |engine: &mut ResidentConsensusEngine, owner_entity_id, account_id, input| {
        engine
            .entity_inbound(EntityInboundRequest {
                owner_entity_id,
                expected_accounts_root: engine.accounts_root(),
                clock: fixture::clock(TIMESTAMP),
                rows: vec![AccountInputRow {
                    operation_index: 0,
                    account_id,
                    genesis_policy: None,
                    certified_board_authority: AccountInputBoardAuthority::Lazy,
                    local_certified_board_authority: AccountInputBoardAuthority::Lazy,
                    input,
                }],
                post_accounts: false,
            })
            .expect("receive Account input")
    };

    receive(
        &mut payer,
        pair.payer_entity,
        pair.payer_account,
        predecessor.clone(),
    );
    let original_bundle = payer
        .entity_outbound(force_ack_request(
            pair.payer_entity,
            pair.payer_account,
            fixture::payment(&pair, 25).1,
        ))
        .expect("payer ACK H1 plus H2")
        .proposals
        .into_iter()
        .next()
        .and_then(|row| row.outbound_input)
        .expect("pending ACK H1 plus H2");
    assert!(matches!(
        original_bundle.kind,
        xln_rscore_batch::AccountInputKind::AckFrame { ack: Some(_), .. }
    ));
    let stale_standalone_ack = match &original_bundle.kind {
        xln_rscore_batch::AccountInputKind::AckFrame { ack: Some(ack), .. } => {
            xln_rscore_batch::AccountInput {
                envelope: original_bundle.envelope.clone(),
                kind: xln_rscore_batch::AccountInputKind::Ack(ack.clone()),
            }
        }
        _ => panic!("original bundle must carry ACK H1"),
    };

    receive(
        &mut payee,
        pair.payee_entity,
        pair.payee_account,
        original_bundle.clone(),
    );
    let first_h2_ack = payee
        .entity_outbound(force_ack_request(
            pair.payee_entity,
            pair.payee_account,
            Vec::new(),
        ))
        .expect("payee commits H2")
        .proposals
        .into_iter()
        .next()
        .and_then(|row| row.outbound_input)
        .expect("payee ACK H2");
    let root_after_h2 = payee.accounts_root();

    receive(
        &mut payer,
        pair.payer_entity,
        pair.payer_account,
        predecessor,
    );
    let retry = payer
        .entity_outbound(force_ack_request(
            pair.payer_entity,
            pair.payer_account,
            Vec::new(),
        ))
        .expect("retry pending bundle")
        .proposals
        .into_iter()
        .next()
        .and_then(|row| row.outbound_input)
        .expect("exact pending bundle retry");
    assert_eq!(retry.envelope, original_bundle.envelope);
    match (&retry.kind, &original_bundle.kind) {
        (
            xln_rscore_batch::AccountInputKind::AckFrame {
                ack: retry_ack,
                frame: retry_frame,
            },
            xln_rscore_batch::AccountInputKind::AckFrame {
                ack: original_ack,
                frame: original_frame,
            },
        ) => {
            assert_eq!(retry_ack, original_ack);
            assert_eq!(retry_frame, original_frame);
        }
        _ => panic!("retry must preserve exact ACK+successor kind"),
    }

    let duplicate = receive(&mut payee, pair.payee_entity, pair.payee_account, retry);
    assert!(matches!(
        duplicate.applied[0].verdict,
        AccountInputVerdict::FrameDuplicate { height: 2, .. }
    ));
    let repeated_h2_ack = payee
        .entity_outbound(force_ack_request(
            pair.payee_entity,
            pair.payee_account,
            Vec::new(),
        ))
        .expect("re-ACK duplicate H2")
        .proposals
        .into_iter()
        .next()
        .and_then(|row| row.outbound_input)
        .expect("repeated ACK H2");
    assert_eq!(payee.accounts_root(), root_after_h2);
    assert_eq!(repeated_h2_ack.envelope, first_h2_ack.envelope);
    match (&repeated_h2_ack.kind, &first_h2_ack.kind) {
        (
            xln_rscore_batch::AccountInputKind::Ack(repeated),
            xln_rscore_batch::AccountInputKind::Ack(original),
        ) => assert_eq!(repeated, original),
        _ => panic!("duplicate H2 must re-emit ACK H2"),
    }

    let delayed_predecessor = receive(
        &mut payee,
        pair.payee_entity,
        pair.payee_account,
        stale_standalone_ack,
    );
    assert!(matches!(
        delayed_predecessor.applied[0].verdict,
        AccountInputVerdict::AckAccepted { height: 1 }
    ));
    assert_eq!(payee.accounts_root(), root_after_h2);
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
        local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
        timestamp: TIMESTAMP,
        j_height: 100,
        creates: vec![created],
        envelope_updates: Vec::new(),
        unsigned_settlement_txs: Vec::new(),
        proposal_work: vec![
            (pair.payer_account, fixture::payment(&pair, 25).1, false),
            (AccountId::from_bytes([0xfe; 32]), Vec::new(), false),
        ],
        checkpoint_due: false,
        post_accounts: false,
    }) {
        Ok(_) => panic!("unknown materialization account must fail"),
        Err(error) => error,
    };
    assert!(
        matches!(
            error,
            xln_rscore_batch::BatchError::AccountNotFound { .. }
                | xln_rscore_batch::BatchError::CandidateAccountNotFound(_)
        ),
        "unexpected outbound error: {error:?}"
    );
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

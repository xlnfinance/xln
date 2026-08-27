mod support;

use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;
use xln_rscore_batch::{
    AccountId, AccountInputKind, AccountInputRow, AccountPeerInput, AccountSeed, EngineGeneration,
    EntityInboundRequest, ResidentConsensusEngine,
};
use xln_rscore_engine::{
    AccountConsensus, AccountDisputeConfig, AccountDomain, AccountExecutionContext,
    AccountIdentity, AccountPeerEnvelope, AccountReplica, AccountSettledEvent, AccountState,
    AccountTx, AccountVerdict, BoardDelays, DeliveryMode, Delta, DepositoryAddress, EntityId,
    HtlcHashlock, HtlcLockTx, HtlcResolveOutcome, IncomingFrame, JEventClaimTx, JEventMetadata,
    JurisdictionEvent, OpaqueHtlcCiphertext, ProposalOutcome, ReceiverClock,
    SequentialAccountEngine, SigningIdentity, TokenId, WatchSeed, derive_signer_key,
    propose_account_frame,
};
use xln_rscore_entity_kernel::{
    CrontabState, DeterministicContext, DirectPaymentEntityTx, EntityKernelCommitments,
    EntityKernelOutput, EntityStateSlice, FinalizedJEventBatch, HtlcPaymentEntityTx, JClaimIngress,
    JReserveUpdate, LocalEntityFinancialTx, OrderbookState, OriginatedHtlcDeliveryMode,
    PreparedOriginatedHtlcPayment, ResidentEntityError, ResidentEntityRequest,
    ResidentJEventProjection, ScheduledHook, ScheduledWake, SchedulerError,
    apply_resident_entity_round, collect_due_scheduled_wake_jobs,
};

const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
const TIMESTAMP: u64 = 1_700_000_000_000;

fn identity(label: &str) -> SigningIdentity {
    SigningIdentity::lazy_from_seed(SEED, label, 1, 1, BoardDelays::default())
        .expect("signing identity")
}

fn entity(identity: &SigningIdentity) -> EntityId {
    EntityId::parse(&format!("0x{}", hex::encode(identity.entity_id()))).expect("entity")
}

fn domain() -> AccountDomain {
    AccountDomain::new(
        31_337,
        DepositoryAddress::parse("0x8888888888888888888888888888888888888888").expect("depository"),
    )
    .expect("domain")
}

fn account_state(first: &EntityId, second: &EntityId) -> AccountState {
    let (left, right) = if first < second {
        (first.clone(), second.clone())
    } else {
        (second.clone(), first.clone())
    };
    let capacity = BigInt::from(10_u8).pow(30);
    let deltas = [1, 2]
        .into_iter()
        .map(|token_id| {
            Delta::new(
                TokenId::new(token_id).expect("token"),
                capacity.clone(),
                BigInt::from(0),
                BigInt::from(0),
                capacity.clone(),
                capacity.clone(),
                BigInt::from(0),
                BigInt::from(0),
                BigInt::from(0),
                BigInt::from(0),
            )
            .expect("delta")
        })
        .collect();
    AccountState::new(
        AccountIdentity::new(
            domain(),
            left,
            right,
            WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
        )
        .expect("account identity"),
        AccountDisputeConfig::new(10, 10).expect("dispute config"),
        deltas,
    )
    .expect("account state")
}

fn offer_tx(offer_id: &str, ask: bool) -> AccountTx {
    let base = BigInt::from(10_u8).pow(18);
    let quote = BigInt::from(25_000_000_u64) * BigInt::from(100_u8);
    let (give_token_id, give_decimals, give_amount, want_token_id, want_decimals, want_amount) =
        if ask {
            (2, 18, base, 1, 6, quote)
        } else {
            (1, 6, quote, 2, 18, base)
        };
    let max_fee = &want_amount / BigInt::from(10_000_u32);
    AccountTx::SwapOffer {
        offer_id: offer_id.to_string(),
        give_token_id,
        give_token_decimals: give_decimals,
        give_amount,
        want_token_id,
        want_token_decimals: want_decimals,
        min_net_receive: &want_amount - &max_fee,
        want_amount,
        max_fee,
        time_in_force: Some(0),
        price_ticks: Some(BigInt::from(25_000_000_u64)),
    }
}

fn peer_proposal(
    label: &str,
    hub: &EntityId,
    operation_index: u64,
    tx: AccountTx,
) -> (AccountSeed, AccountInputRow, EntityId) {
    let peer_identity = identity(label);
    let peer = entity(&peer_identity);
    let account_id = AccountId::from_bytes(*peer.as_bytes());
    let state = account_state(&peer, hub);
    let mut peer_account = AccountConsensus::new(
        AccountReplica::new(peer.clone(), state.clone()).expect("peer replica"),
    );
    peer_account
        .admit_txs(vec![tx], "resident-entity-test")
        .expect("peer admission");
    let ProposalOutcome::Proposed(proposed) = propose_account_frame(
        &mut peer_account,
        &peer_identity,
        TIMESTAMP,
        100,
        &support::market(),
    )
    .expect("peer proposal") else {
        panic!("peer must propose")
    };
    let proposed = *proposed;
    let seed = AccountSeed {
        account_id,
        replica: AccountReplica::new(hub.clone(), state).expect("hub replica"),
        consensus: None,
    };
    let row = AccountInputRow {
        operation_index,
        account_id,
        genesis_policy: None,
        certified_board_authority: xln_rscore_batch::PeerBoardAuthority::Lazy,
        local_certified_board_authority: xln_rscore_batch::PeerBoardAuthority::Lazy,
        input: AccountPeerInput {
            envelope: AccountPeerEnvelope {
                from_entity_id: *peer.as_bytes(),
                to_entity_id: *hub.as_bytes(),
                domain: domain(),
                dispute_config: AccountDisputeConfig::new(10, 10).expect("dispute config"),
                watch_seed: Some(
                    WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
                ),
            },
            kind: AccountInputKind::Frame(Box::new(IncomingFrame {
                frame: proposed.frame,
                state_hash: proposed.state_hash,
                frame_hanko: Some(proposed.hanko),
                dispute: None,
            })),
        },
    };
    (seed, row, peer)
}

#[test]
fn authenticated_j_projection_joins_the_single_outbound_account_visit() {
    let hub_identity = identity("hub");
    let peer_identity = identity("j-peer");
    let hub = entity(&hub_identity);
    let peer = entity(&peer_identity);
    let peer_id = AccountId::from_bytes(*peer.as_bytes());
    let mut accounts = ResidentConsensusEngine::restore(
        EngineGeneration::from_bytes([0x47; 8]),
        4,
        0,
        derive_signer_key(SEED, "hub").expect("hub key"),
        "hub".to_string(),
        support::market(),
        vec![AccountSeed {
            account_id: peer_id,
            replica: AccountReplica::new(hub.clone(), account_state(&hub, &peer))
                .expect("hub replica"),
            consensus: None,
        }],
    )
    .expect("resident accounts");
    let before_root = accounts.accounts_root();
    let event = JurisdictionEvent::AccountSettled(AccountSettledEvent {
        metadata: JEventMetadata {
            block_number: Some(43),
            block_hash: Some([0x43; 32]),
            transaction_hash: Some([0x44; 32]),
            log_index: Some(1),
            event_index: None,
        },
        left_entity: hub.clone(),
        right_entity: peer.clone(),
        token_id: TokenId::new(1).expect("token"),
        left_reserve: BigInt::from(7),
        right_reserve: BigInt::from(9),
        collateral: BigInt::from(11),
        ondelta: BigInt::from(-3),
        nonce: 0,
    });
    let claim = AccountTx::JEventClaim(JEventClaimTx {
        j_height: 43,
        j_block_hash: [0x43; 32],
        events: vec![event],
        left_proof: None,
        right_proof: None,
    });
    let mut state = EntityStateSlice::empty(hub.to_string(), TIMESTAMP);
    state.known_accounts.insert(peer.to_string());
    let result = apply_resident_entity_round(
        &mut accounts,
        state,
        ResidentEntityRequest {
            inbound: EntityInboundRequest {
                owner_entity_id: *hub.as_bytes(),
                expected_accounts_root: before_root,
                clock: ReceiverClock {
                    entity_timestamp: TIMESTAMP,
                    finalized_j_height: 0,
                },
                rows: Vec::new(),
                post_accounts: false,
            },
            entity_height: 1,
            outbound_timestamp: TIMESTAMP,
            outbound_j_height: 43,
            checkpoint_due: false,
            post_accounts: false,
            scheduled_wake: None,
            expected_proposer_signer_id: "hub".into(),
            hub_rebalance_has_pending_work: false,
            finalized_j_events: Some(ResidentJEventProjection {
                scanned_through: 43,
                batches: vec![FinalizedJEventBatch {
                    j_height: 43,
                    j_block_hash: [0x43; 32],
                    reserve_updates: vec![JReserveUpdate {
                        token_id: 1,
                        own_reserve: BigInt::from(7),
                        counterparty_id: peer.clone(),
                    }],
                    account_claims: vec![JClaimIngress {
                        account_id: peer.clone(),
                        tx: claim,
                    }],
                }],
                active_account_ids: BTreeSet::from([peer.to_string()]),
            }),
            local_financial_txs: Vec::new(),
        },
        &DeterministicContext::hlt_default(),
    )
    .expect("resident J round");
    assert_eq!(result.state.last_finalized_j_height, 43);
    assert_eq!(result.state.reserves.get(&1), Some(&BigInt::from(7)));
    assert_ne!(result.outbound.accounts_root, before_root);
    assert_eq!(result.outbound.proposals.len(), 1);
    let proposed = result.outbound.proposals[0]
        .outbound_input
        .as_ref()
        .expect("one outbound Account input");
    assert!(matches!(&proposed.kind, AccountInputKind::Frame(_)));
}

#[test]
fn local_direct_and_originated_htlc_join_one_resident_account_proposal() {
    let hub_identity = identity("hub");
    let peer_identity = identity("local-peer");
    let hub = entity(&hub_identity);
    let peer = entity(&peer_identity);
    let peer_id = AccountId::from_bytes(*peer.as_bytes());
    let mut accounts = ResidentConsensusEngine::restore(
        EngineGeneration::from_bytes([0x46; 8]),
        4,
        0,
        derive_signer_key(SEED, "hub").expect("hub key"),
        "hub".to_string(),
        support::market(),
        vec![AccountSeed {
            account_id: peer_id,
            replica: AccountReplica::new(hub.clone(), account_state(&hub, &peer))
                .expect("hub replica"),
            consensus: None,
        }],
    )
    .expect("resident accounts");
    let base_root = accounts.accounts_root();
    let tx_hash = format!("0x{}", "aa".repeat(32));
    let hashlock = format!("0x{}", "bb".repeat(32));
    let lock_id = format!("0x{}", "cc".repeat(32));
    let route = vec![hub.to_string(), peer.to_string()];
    let mut context = DeterministicContext::hlt_default();
    context.originated_htlcs.insert(
        tx_hash.clone(),
        PreparedOriginatedHtlcPayment {
            tx_hash: tx_hash.clone(),
            target_entity_id: peer.to_string(),
            token_id: 1,
            recipient_amount: BigInt::from(100),
            route: route.clone(),
            description: "resident exact".into(),
            delivery_mode: OriginatedHtlcDeliveryMode::Instant,
            started_at_ms: TIMESTAMP,
            hashlock: hashlock.clone(),
            sender_lock_amount: BigInt::from(110),
            max_sender_debit: BigInt::from(120),
            total_fee: BigInt::from(10),
            lock_id: lock_id.clone(),
            timelock: BigInt::from(TIMESTAMP + 60_000),
            reveal_before_height: 200,
            next_hop_entity_id: peer.to_string(),
            envelope: OpaqueHtlcCiphertext::from_packed(vec![0x55; 48]).expect("opaque envelope"),
        },
    );
    let mut state = EntityStateSlice::empty(hub.to_string(), TIMESTAMP);
    state.known_accounts.insert(peer.to_string());
    let result = apply_resident_entity_round(
        &mut accounts,
        state,
        ResidentEntityRequest {
            inbound: EntityInboundRequest {
                owner_entity_id: *hub.as_bytes(),
                expected_accounts_root: base_root,
                clock: ReceiverClock {
                    entity_timestamp: TIMESTAMP,
                    finalized_j_height: 100,
                },
                rows: Vec::new(),
                post_accounts: false,
            },
            entity_height: 1,
            outbound_timestamp: TIMESTAMP,
            outbound_j_height: 100,
            checkpoint_due: false,
            post_accounts: false,
            scheduled_wake: None,
            expected_proposer_signer_id: "hub".into(),
            hub_rebalance_has_pending_work: false,
            finalized_j_events: None,
            local_financial_txs: vec![
                LocalEntityFinancialTx::DirectPayment(DirectPaymentEntityTx {
                    target_entity_id: peer.to_string(),
                    token_id: TokenId::new(1).expect("token"),
                    amount: BigInt::from(7),
                    route: route.clone(),
                    description: Some(String::new()),
                    delivery_mode: DeliveryMode::Direct,
                    trusted_gateway_entity_id: None,
                }),
                LocalEntityFinancialTx::HtlcPayment(HtlcPaymentEntityTx {
                    target_entity_id: peer.to_string(),
                    token_id: TokenId::new(1).expect("token"),
                    amount: BigInt::from(100),
                    max_sender_debit: BigInt::from(120),
                    route,
                    description: Some("resident exact".into()),
                    delivery_mode: OriginatedHtlcDeliveryMode::Instant,
                    started_at_ms: Some(TIMESTAMP),
                    hashlock: Some(hashlock.clone()),
                    tx_hash,
                }),
            ],
        },
        &context,
    )
    .expect("fused local financial round");
    assert_eq!(result.non_mutating_wake_targets, vec![hub.to_string()]);
    assert_eq!(result.outbound.admissions.len(), 1);
    let proposal = result.outbound.proposals[0]
        .proposed
        .as_ref()
        .expect("outbound proposal");
    assert!(matches!(
        proposal.frame.txs.as_slice(),
        [AccountTx::DirectPayment { description, .. }, AccountTx::HtlcLock(lock)]
            if description.as_deref() == Some(format!("Payment to {peer}").as_str())
                && lock.lock_id == lock_id
    ));
    assert!(result.state.htlc_routes.contains_key(&hashlock));
    assert!(result
        .outputs
        .iter()
        .any(|output| matches!(output, EntityKernelOutput::HtlcInitiated { lock_id: id, .. } if id == &lock_id)));
    assert_ne!(result.outbound.accounts_root, base_root);
}

#[test]
fn resident_entity_fuses_inbound_paybook_and_outbound_account_visit() {
    let payer_identity = identity("payer");
    let hub_identity = identity("hub");
    let next_identity = identity("next");
    let payer = entity(&payer_identity);
    let hub = entity(&hub_identity);
    let next = entity(&next_identity);
    let payer_id = AccountId::from_bytes(*payer.as_bytes());
    let next_id = AccountId::from_bytes(*next.as_bytes());
    let payer_account_state = account_state(&payer, &hub);
    let next_account_state = account_state(&hub, &next);

    let mut payer_account = AccountConsensus::new(
        AccountReplica::new(payer.clone(), payer_account_state.clone()).expect("payer replica"),
    );
    let payment = AccountTx::DirectPayment {
        token_id: TokenId::new(1).expect("token"),
        amount: BigInt::from(100),
        route: vec![hub.to_string(), next.to_string()],
        description: None,
        from_entity_id: payer.to_string(),
        to_entity_id: hub.to_string(),
        delivery_mode: DeliveryMode::Trusted,
        trusted_gateway_entity_id: Some(hub.to_string()),
    };
    payer_account
        .admit_txs(vec![payment], "resident-entity-test")
        .expect("admit payment");
    let ProposalOutcome::Proposed(proposed) = propose_account_frame(
        &mut payer_account,
        &payer_identity,
        TIMESTAMP,
        100,
        &support::market(),
    )
    .expect("payer proposal") else {
        panic!("payer must propose")
    };
    let proposed = *proposed;

    let seeds = vec![
        AccountSeed {
            account_id: payer_id,
            replica: AccountReplica::new(hub.clone(), payer_account_state)
                .expect("hub payer replica"),
            consensus: None,
        },
        AccountSeed {
            account_id: next_id,
            replica: AccountReplica::new(hub.clone(), next_account_state)
                .expect("hub next replica"),
            consensus: None,
        },
    ];
    let mut accounts = ResidentConsensusEngine::restore(
        EngineGeneration::from_bytes([0x42; 8]),
        4,
        0,
        derive_signer_key(SEED, "hub").expect("hub key"),
        "hub".to_string(),
        support::market(),
        seeds,
    )
    .expect("resident accounts");
    let base_root = accounts.accounts_root();
    let inbound = EntityInboundRequest {
        owner_entity_id: *hub.as_bytes(),
        expected_accounts_root: base_root,
        clock: ReceiverClock {
            entity_timestamp: TIMESTAMP,
            finalized_j_height: 100,
        },
        rows: vec![AccountInputRow {
            operation_index: 0,
            account_id: payer_id,
            genesis_policy: None,
            certified_board_authority: xln_rscore_batch::PeerBoardAuthority::Lazy,
            local_certified_board_authority: xln_rscore_batch::PeerBoardAuthority::Lazy,
            input: AccountPeerInput {
                envelope: AccountPeerEnvelope {
                    from_entity_id: *payer.as_bytes(),
                    to_entity_id: *hub.as_bytes(),
                    domain: domain(),
                    dispute_config: AccountDisputeConfig::new(10, 10).expect("dispute config"),
                    watch_seed: Some(
                        WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
                    ),
                },
                kind: AccountInputKind::Frame(Box::new(IncomingFrame {
                    frame: proposed.frame,
                    state_hash: proposed.state_hash,
                    frame_hanko: Some(proposed.hanko),
                    dispute: None,
                })),
            },
        }],
        post_accounts: false,
    };
    let mut state = EntityStateSlice::empty(hub.to_string(), TIMESTAMP);
    state.known_accounts = BTreeSet::from([payer.to_string(), next.to_string()]);
    let result = apply_resident_entity_round(
        &mut accounts,
        state,
        ResidentEntityRequest {
            inbound,
            entity_height: 1,
            outbound_timestamp: TIMESTAMP,
            outbound_j_height: 100,
            checkpoint_due: false,
            post_accounts: false,
            scheduled_wake: None,
            expected_proposer_signer_id: "hub".to_string(),
            hub_rebalance_has_pending_work: false,
            finalized_j_events: None,
            local_financial_txs: Vec::new(),
        },
        &DeterministicContext::hlt_default(),
    )
    .expect("resident entity round");

    assert_eq!(result.inbound.applied.len(), 1);
    assert_eq!(result.outbound.admissions.len(), 1);
    assert_eq!(result.outbound.proposals.len(), 1);
    assert!(
        !result.entity_frame_events.is_empty(),
        "Account ingress/proposal status events are signed by the Entity frame"
    );
    let payer_text = payer.to_string();
    let payer_suffix = &payer_text[payer_text.len() - 4..];
    assert!(
        result.entity_frame_events.iter().any(|event| matches!(
            event,
            xln_rscore_entity_kernel::EntityFrameEvent::Status { message }
                if message == &format!("🤝 Accepted frame 1 from Entity {payer_suffix}")
        )),
        "peer-frame acceptance is part of the canonical Entity event list",
    );
    assert_eq!(
        result
            .secondary_hashes
            .iter()
            .filter(|entry| entry.kind == xln_rscore_entity_kernel::HashType::AccountFrame)
            .count(),
        2,
        "the inbound Account frame and outbound Account frame are both in the manifest"
    );
    let proposal = result.outbound.proposals[0]
        .proposed
        .as_ref()
        .expect("forward proposal");
    assert_eq!(result.outbound.proposals[0].account_id, next_id);
    assert_eq!(proposal.frame.txs.len(), 1);
    let AccountTx::DirectPayment {
        from_entity_id,
        to_entity_id,
        route,
        ..
    } = &proposal.frame.txs[0]
    else {
        panic!("paybook must produce a direct payment")
    };
    assert_eq!(from_entity_id, &hub.to_string());
    assert_eq!(to_entity_id, &next.to_string());
    assert_eq!(route, &[next.to_string()]);
    assert_ne!(result.outbound.accounts_root, base_root);
}

#[test]
fn resident_entity_same_j_swap_is_root_identical_across_worker_counts() {
    let hub_identity = identity("hub");
    let hub = entity(&hub_identity);
    let (maker_seed, maker_row, maker) = peer_proposal("maker", &hub, 0, offer_tx("maker", true));
    let (taker_seed, taker_row, taker) = peer_proposal("taker", &hub, 1, offer_tx("taker", false));
    let seeds = vec![maker_seed, taker_seed];
    let rows = vec![maker_row, taker_row];
    let mut oracle: Option<([u8; 32], EntityKernelCommitments, Vec<[u8; 32]>)> = None;

    for workers in [1, 2, 4, 8, 16] {
        let mut accounts = ResidentConsensusEngine::restore(
            EngineGeneration::from_bytes([0x43; 8]),
            workers,
            0,
            derive_signer_key(SEED, "hub").expect("hub key"),
            "hub".to_string(),
            support::market(),
            seeds.clone(),
        )
        .expect("resident accounts");
        let mut state = EntityStateSlice::empty(hub.to_string(), TIMESTAMP);
        state.known_accounts = BTreeSet::from([maker.to_string(), taker.to_string()]);
        state.orderbook = Some(OrderbookState::empty(10_000));
        let expected_accounts_root = accounts.accounts_root();
        let result = apply_resident_entity_round(
            &mut accounts,
            state,
            ResidentEntityRequest {
                inbound: EntityInboundRequest {
                    owner_entity_id: *hub.as_bytes(),
                    expected_accounts_root,
                    clock: ReceiverClock {
                        entity_timestamp: TIMESTAMP,
                        finalized_j_height: 100,
                    },
                    rows: rows.clone(),
                    post_accounts: false,
                },
                entity_height: 1,
                outbound_timestamp: TIMESTAMP,
                outbound_j_height: 100,
                checkpoint_due: false,
                post_accounts: false,
                scheduled_wake: None,
                expected_proposer_signer_id: "hub".to_string(),
                hub_rebalance_has_pending_work: false,
                finalized_j_events: None,
                local_financial_txs: Vec::new(),
            },
            &DeterministicContext::hlt_default(),
        )
        .expect("resident swap round");
        assert_eq!(result.inbound.applied.len(), 2);
        assert_eq!(result.outbound.admissions.len(), 2);
        assert_eq!(result.outbound.proposals.len(), 2);
        assert_eq!(
            result.outputs,
            vec![EntityKernelOutput::SwapMatched {
                entity_id: hub.to_string(),
                count: 1,
            }]
        );
        let hashes = result
            .outbound
            .proposals
            .iter()
            .map(|row| {
                let proposed = row.proposed.as_ref().expect("swap resolve proposal");
                assert!(matches!(
                    proposed.frame.txs.as_slice(),
                    [AccountTx::SwapResolve { .. }]
                ));
                proposed.state_hash
            })
            .collect::<Vec<_>>();
        let book = &result.state.orderbook.as_ref().expect("orderbook").books["1/2"];
        assert_eq!(book.trade_count, 1);
        let evidence = (result.outbound.accounts_root, result.commitments, hashes);
        if let Some(expected) = &oracle {
            assert_eq!(&evidence, expected, "worker count {workers}");
        } else {
            oracle = Some(evidence);
        }
    }
}

#[test]
fn due_htlc_timeout_is_admitted_and_proposed_in_the_same_resident_round() {
    let hub_identity = identity("hub");
    let peer_identity = identity("timeout-peer");
    let hub = entity(&hub_identity);
    let peer = entity(&peer_identity);
    let peer_id = AccountId::from_bytes(*peer.as_bytes());
    let lock_id = format!("0x{}", "ab".repeat(32));
    let lock = AccountTx::HtlcLock(HtlcLockTx {
        lock_id: lock_id.clone(),
        hashlock: HtlcHashlock::parse(&format!("0x{}", "cd".repeat(32))).expect("hashlock"),
        timelock: BigInt::from(TIMESTAMP + 60_000),
        reveal_before_height: 1_000,
        amount: BigInt::from(100),
        token_id: TokenId::new(1).expect("token"),
        delivery_mode: None,
        envelope: None,
    });
    let base = AccountReplica::new(hub.clone(), account_state(&hub, &peer)).expect("replica");
    let transition = SequentialAccountEngine::apply_with_context(
        &base,
        base.owner_side(),
        &lock,
        &AccountExecutionContext::with_market(1_000, TIMESTAMP, 100, 0, 100, support::market()),
    )
    .expect("lock transition");
    assert_eq!(transition.verdict(), &AccountVerdict::Applied);
    let locked = transition.committed().expect("locked account");
    let mut accounts = ResidentConsensusEngine::restore(
        EngineGeneration::from_bytes([0x44; 8]),
        4,
        0,
        derive_signer_key(SEED, "hub").expect("hub key"),
        "hub".to_string(),
        support::market(),
        vec![AccountSeed {
            account_id: peer_id,
            replica: locked,
            consensus: None,
        }],
    )
    .expect("resident accounts");
    let base_root = accounts.accounts_root();
    let due_at = TIMESTAMP + 60_000;
    let crontab = CrontabState {
        tasks: BTreeMap::new(),
        hooks: BTreeMap::from([(
            format!("htlc-timeout:{lock_id}"),
            ScheduledHook::htlc_timeout(peer.to_string(), lock_id.clone(), due_at),
        )]),
    };
    let jobs = collect_due_scheduled_wake_jobs(&crontab, due_at, false).expect("due jobs");
    let mut state = EntityStateSlice::empty(hub.to_string(), due_at);
    state.known_accounts.insert(peer.to_string());
    state.crontab = Some(crontab);
    let result = apply_resident_entity_round(
        &mut accounts,
        state,
        ResidentEntityRequest {
            inbound: EntityInboundRequest {
                owner_entity_id: *hub.as_bytes(),
                expected_accounts_root: base_root,
                clock: ReceiverClock {
                    entity_timestamp: due_at,
                    finalized_j_height: 100,
                },
                rows: Vec::new(),
                post_accounts: false,
            },
            entity_height: 1,
            outbound_timestamp: due_at,
            outbound_j_height: 100,
            checkpoint_due: false,
            post_accounts: false,
            scheduled_wake: Some(ScheduledWake {
                version: 1,
                proposer_signer_id: "hub".to_string(),
                due_at,
                jobs,
            }),
            expected_proposer_signer_id: "hub".to_string(),
            hub_rebalance_has_pending_work: false,
            finalized_j_events: None,
            local_financial_txs: Vec::new(),
        },
        &DeterministicContext::hlt_default(),
    )
    .expect("scheduled timeout round");

    assert!(result.state.crontab.expect("crontab").hooks.is_empty());
    assert_eq!(result.outbound.admissions.len(), 1);
    let proposal = result.outbound.proposals[0]
        .proposed
        .as_ref()
        .expect("timeout proposal");
    assert_eq!(result.outbound.proposals[0].account_id, peer_id);
    assert!(matches!(
        proposal.frame.txs.as_slice(),
        [AccountTx::HtlcResolve(resolve)]
            if resolve.lock_id == lock_id
                && matches!(
                    &resolve.outcome,
                    HtlcResolveOutcome::Error { reason }
                        if reason.as_deref() == Some("timeout")
                )
    ));
    assert_ne!(result.outbound.accounts_root, base_root);
}

#[test]
fn forged_scheduled_wake_is_rejected_before_resident_account_mutation() {
    let hub_identity = identity("hub");
    let hub = entity(&hub_identity);
    let mut accounts = ResidentConsensusEngine::restore(
        EngineGeneration::from_bytes([0x45; 8]),
        2,
        0,
        derive_signer_key(SEED, "hub").expect("hub key"),
        "hub".to_string(),
        support::market(),
        Vec::new(),
    )
    .expect("empty resident accounts");
    let base_root = accounts.accounts_root();
    let crontab = CrontabState {
        tasks: BTreeMap::new(),
        hooks: BTreeMap::from([(
            "htlc-timeout:forged".to_string(),
            ScheduledHook::htlc_timeout("peer".to_string(), "forged".to_string(), 150),
        )]),
    };
    let jobs = collect_due_scheduled_wake_jobs(&crontab, 200, false).expect("due jobs");
    let mut state = EntityStateSlice::empty(hub.to_string(), 200);
    state.crontab = Some(crontab);
    let result = apply_resident_entity_round(
        &mut accounts,
        state,
        ResidentEntityRequest {
            inbound: EntityInboundRequest {
                owner_entity_id: *hub.as_bytes(),
                expected_accounts_root: base_root,
                clock: ReceiverClock {
                    entity_timestamp: 200,
                    finalized_j_height: 0,
                },
                rows: Vec::new(),
                post_accounts: false,
            },
            entity_height: 1,
            outbound_timestamp: 200,
            outbound_j_height: 0,
            checkpoint_due: false,
            post_accounts: false,
            scheduled_wake: Some(ScheduledWake {
                version: 1,
                proposer_signer_id: "attacker".to_string(),
                due_at: 150,
                jobs,
            }),
            expected_proposer_signer_id: "hub".to_string(),
            hub_rebalance_has_pending_work: false,
            finalized_j_events: None,
            local_financial_txs: Vec::new(),
        },
        &DeterministicContext::hlt_default(),
    );
    let error = match result {
        Ok(_) => panic!("forged wake accepted"),
        Err(error) => error,
    };
    assert!(matches!(
        error,
        ResidentEntityError::Scheduler(SchedulerError::ProposerMismatch)
    ));
    assert_eq!(accounts.accounts_root(), base_root);
}

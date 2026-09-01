mod support;

use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;
use xln_rscore_batch::{
    AccountId, AccountInput, AccountInputKind, AccountInputRow, AccountPhaseKind, AccountSeed,
    EngineGeneration, EntityAccountGenesisPolicy, EntityInboundRequest, ResidentConsensusEngine,
};
use xln_rscore_engine::{
    AccountConsensus, AccountDisputeConfig, AccountDomain, AccountExecutionContext,
    AccountIdentity, AccountInputEnvelope, AccountReplica, AccountSettledEvent, AccountState,
    AccountTx, AccountVerdict, AckFrameOutcome, BoardDelays, CounterpartyDispute, DeliveryMode,
    Delta, DepositoryAddress, EntityId, HtlcHashlock, HtlcLockTx, HtlcResolveOutcome,
    HtlcResolveTx, IncomingAck, IncomingFrame, IncomingOutcome, JEventClaimTx, JEventMetadata,
    JurisdictionEvent, OpaqueHtlcCiphertext, ProposalOutcome, ReceiverClock, ReserveUpdatedEvent,
    SequentialAccountEngine, SigningIdentity, TokenId, WatchSeed, apply_incoming_ack_frame,
    apply_incoming_frame, derive_signer_key, propose_account_frame,
};
use xln_rscore_entity_kernel::{
    AdmittedLocalEntityTx, ConsensusMode, CrontabState, DeterministicContext,
    DirectPaymentEntityTx, EntityConsensusConfig, EntityFrameAuthority, EntityFrameEvent,
    EntityKernelCommitments, EntityKernelOutput, EntityLeaderState, EntityStateSlice,
    FinalizedJEventBatch, HtlcPaymentEntityTx, JClaimIngress, JReserveUpdate, LocalEntityControlTx,
    LocalEntityFinancialTx, LocalEntityTx, OrderbookState, OriginatedHtlcDeliveryMode,
    PreparedOriginatedHtlcPayment, ResidentEntityError, ResidentEntityOperation,
    ResidentEntityRequest, ResidentJEventProjection, ScheduledHook, ScheduledWake, SchedulerError,
    apply_resident_entity_round, collect_due_scheduled_wake_jobs,
};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

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

fn single_signer_authority(signer_id: &str) -> EntityFrameAuthority {
    EntityFrameAuthority {
        config: EntityConsensusConfig {
            mode: ConsensusMode::ProposerBased,
            threshold: 1,
            validators: vec![signer_id.to_string()],
            shares: BTreeMap::from([(signer_id.to_string(), 1)]),
            jurisdiction: None,
        },
        leader_state: EntityLeaderState {
            active_validator_id: signer_id.to_string(),
            view: 0,
            changed_at_height: 0,
        },
    }
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

fn assert_live_pending_recovery_state(
    accounts: &mut ResidentConsensusEngine,
    account_id: AccountId,
    expected_txs: &[AccountTx],
) {
    let checkpoint = accounts
        .export_checkpoint()
        .expect("export live Account recovery envelope");
    let row = checkpoint
        .accounts
        .iter()
        .find(|row| row.account_id == account_id)
        .expect("pending Account remains in recovery envelope");
    assert!(
        row.consensus.mempool.is_empty(),
        "proposed transactions moved from mempool into the pending frame",
    );
    assert_eq!(
        row.consensus
            .pending
            .as_ref()
            .expect("live pending frame")
            .frame
            .txs,
        expected_txs.to_vec(),
    );
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
        cross_jurisdiction: None,
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
        certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
        local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
        input: AccountInput {
            envelope: AccountInputEnvelope {
                from_entity_id: *peer.as_bytes(),
                to_entity_id: *hub.as_bytes(),
                domain: domain(),
                dispute_config: AccountDisputeConfig::new(10, 10).expect("dispute config"),
                watch_seed: Some(
                    WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
                ),
            },
            kind: AccountInputKind::AckFrame {
                ack: None,
                frame: Box::new(IncomingFrame {
                    frame: proposed.frame,
                    state_hash: proposed.state_hash,
                    frame_hanko: Some(proposed.hanko),
                    dispute: None,
                }),
            },
        },
    };
    (seed, row, peer)
}

#[test]
fn inbound_genesis_bundles_required_ack_with_hub_policy_proposal() {
    let hub_identity = identity("hub");
    let peer_identity = identity("genesis-peer");
    let hub = entity(&hub_identity);
    let peer = entity(&peer_identity);
    let account_id = AccountId::from_bytes(*peer.as_bytes());
    let transformer = [0x77; 20];
    let identity = AccountIdentity::new(
        domain(),
        if hub < peer {
            hub.clone()
        } else {
            peer.clone()
        },
        if hub < peer {
            peer.clone()
        } else {
            hub.clone()
        },
        WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
    )
    .expect("account identity");
    let mut peer_replica = AccountReplica::new(
        peer.clone(),
        AccountState::new(
            identity,
            AccountDisputeConfig::new(10, 10).expect("dispute config"),
            Vec::new(),
        )
        .expect("genesis state"),
    )
    .expect("peer replica");
    peer_replica.set_delta_transformer(transformer);
    let mut peer_account = AccountConsensus::new(peer_replica);
    peer_account
        .admit_txs(
            vec![AccountTx::AddDelta {
                token_id: TokenId::new(1).expect("token"),
            }],
            "resident-genesis-bundle-test",
        )
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
    let dispute = proposed.dispute.as_ref().map(|draft| CounterpartyDispute {
        hanko: proposed.dispute_hanko.clone(),
        hash: draft.hash,
        proof_body_hash: draft.proof_body_hash,
        nonce: draft.nonce,
        proposer_is_left: draft.proposer_is_left,
    });
    let mut accounts = ResidentConsensusEngine::restore(
        EngineGeneration::from_bytes([0x51; 8]),
        4,
        0,
        derive_signer_key(SEED, "hub").expect("hub key"),
        "hub".to_string(),
        support::market(),
        Vec::new(),
    )
    .expect("empty resident accounts");
    let mut state = EntityStateSlice::empty(hub.to_string(), TIMESTAMP);
    state.hub_rebalance_config = Some(CanonicalValue::Object(vec![
        (
            "policyVersion".to_string(),
            CanonicalValue::Number(CanonicalNumber::from_u32(1)),
        ),
        (
            "rebalanceLiquidityFeeBps".to_string(),
            CanonicalValue::BigInt(BigInt::from(0)),
        ),
    ]));
    let base_root = accounts.accounts_root();
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
                rows: vec![AccountInputRow {
                    operation_index: 0,
                    account_id,
                    genesis_policy: Some(EntityAccountGenesisPolicy {
                        expected_domain: domain(),
                        shadow_policy_root: xln_rscore_protocol::EMPTY_RADIX_ROOT,
                        shadow_policy_rows: Vec::new(),
                        delta_transformer: transformer,
                        public_pinned: false,
                    }),
                    certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
                    local_certified_board_authority:
                        xln_rscore_batch::AccountInputBoardAuthority::Lazy,
                    input: AccountInput {
                        envelope: AccountInputEnvelope {
                            from_entity_id: *peer.as_bytes(),
                            to_entity_id: *hub.as_bytes(),
                            domain: domain(),
                            dispute_config: AccountDisputeConfig::new(10, 10)
                                .expect("dispute config"),
                            watch_seed: Some(
                                WatchSeed::parse(&format!("0x{}", "99".repeat(32)))
                                    .expect("watch seed"),
                            ),
                        },
                        kind: AccountInputKind::AckFrame {
                            ack: None,
                            frame: Box::new(IncomingFrame {
                                frame: proposed.frame,
                                state_hash: proposed.state_hash,
                                frame_hanko: Some(proposed.hanko),
                                dispute,
                            }),
                        },
                    },
                }],
                post_accounts: false,
            },
            local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
            entity_height: 1,
            outbound_timestamp: TIMESTAMP,
            outbound_j_height: 100,
            checkpoint_due: false,
            post_accounts: false,
            runtime_seed: None,
            scheduled_wake: None,
            expected_proposer_signer_id: "hub".to_string(),
            hub_rebalance_has_pending_work: false,
            finalized_j_events: None,
            entity_authority: Some(single_signer_authority("hub")),
            local_account_genesis_policy: None,
            operations: vec![
                ResidentEntityOperation::Local(vec![AdmittedLocalEntityTx {
                    signer_id: "hub".into(),
                    board_epoch: 0,
                    tx: LocalEntityTx::Control(LocalEntityControlTx::ChatMessage {
                        message: "before-account".into(),
                    }),
                }]),
                ResidentEntityOperation::AccountRange { start: 0, len: 1 },
                ResidentEntityOperation::Local(vec![AdmittedLocalEntityTx {
                    signer_id: "hub".into(),
                    board_epoch: 0,
                    tx: LocalEntityTx::Control(LocalEntityControlTx::ChatMessage {
                        message: "after-account".into(),
                    }),
                }]),
            ],
        },
        &DeterministicContext::hlt_default(),
    )
    .expect("resident genesis round");
    let status = result
        .entity_frame_events
        .iter()
        .filter_map(|event| match event {
            EntityFrameEvent::Status { message } => Some(message.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let before = status
        .iter()
        .position(|message| *message == "before-account")
        .expect("before local event");
    let account = status
        .iter()
        .position(|message| message.starts_with("🤝 Accepted frame"))
        .expect("account event");
    let after = status
        .iter()
        .position(|message| *message == "after-account")
        .expect("after local event");
    assert!(before < account && account < after);
    let outbound = result.outbound.proposals[0]
        .outbound_input
        .as_ref()
        .expect("hub ACK plus proposal");
    assert!(matches!(
        &outbound.kind,
        AccountInputKind::AckFrame { ack: Some(ack), frame }
            if ack.height == 1 && frame.frame.height == 2
    ));
    assert_eq!(
        result.inbound.applied[0].force_ack,
        Some(true),
        "the accepted proposal must transiently force the ACK that the Account worker bundles",
    );
}

#[test]
fn accepted_and_duplicate_account_proposals_force_the_same_pure_ack() {
    let hub_identity = identity("force-ack-hub");
    let hub = entity(&hub_identity);
    let (seed, row, peer) = peer_proposal(
        "force-ack-peer",
        &hub,
        0,
        AccountTx::SetCreditLimit {
            token_id: TokenId::new(1).expect("token"),
            amount: BigInt::from(123),
        },
    );
    let account_id = seed.account_id;
    let mut accounts = ResidentConsensusEngine::restore(
        EngineGeneration::from_bytes([0x5a; 8]),
        4,
        0,
        derive_signer_key(SEED, "force-ack-hub").expect("hub key"),
        "force-ack-hub".to_string(),
        support::market(),
        vec![seed],
    )
    .expect("resident accounts");
    let mut state = EntityStateSlice::empty(hub.to_string(), TIMESTAMP);
    state.known_accounts.insert(peer.to_string());

    let run = |accounts: &mut ResidentConsensusEngine,
               state: EntityStateSlice,
               row: AccountInputRow,
               entity_height: u64| {
        let expected_accounts_root = accounts.accounts_root();
        apply_resident_entity_round(
            accounts,
            state,
            ResidentEntityRequest {
                inbound: EntityInboundRequest {
                    owner_entity_id: *hub.as_bytes(),
                    expected_accounts_root,
                    clock: ReceiverClock {
                        entity_timestamp: TIMESTAMP + entity_height,
                        finalized_j_height: 100,
                    },
                    rows: vec![row],
                    post_accounts: false,
                },
                local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
                entity_height,
                outbound_timestamp: TIMESTAMP + entity_height,
                outbound_j_height: 100,
                checkpoint_due: false,
                post_accounts: false,
                runtime_seed: None,
                scheduled_wake: None,
                expected_proposer_signer_id: "force-ack-hub".to_string(),
                hub_rebalance_has_pending_work: false,
                finalized_j_events: None,
                entity_authority: None,
                local_account_genesis_policy: None,
                operations: vec![ResidentEntityOperation::AccountRange { start: 0, len: 1 }],
            },
            &DeterministicContext::hlt_default(),
        )
        .expect("resident force-ACK round")
    };

    let accepted = run(&mut accounts, state, row.clone(), 1);
    assert_eq!(accepted.inbound.applied[0].force_ack, Some(true));
    assert!(matches!(
        accepted.inbound.applied[0].verdict,
        xln_rscore_batch::AccountInputVerdict::FrameCommitted { height: 1, .. }
    ));
    assert_eq!(accepted.outbound.proposals.len(), 1);
    assert_eq!(accepted.outbound.proposals[0].account_id, account_id);
    let accepted_ack = accepted.outbound.proposals[0]
        .outbound_input
        .as_ref()
        .expect("accepted proposal ACK");
    assert!(matches!(
        &accepted_ack.kind,
        AccountInputKind::Ack(ack) if ack.height == 1
    ));

    let duplicate = run(&mut accounts, accepted.state, row, 2);
    assert_eq!(duplicate.inbound.applied[0].force_ack, Some(true));
    assert!(matches!(
        duplicate.inbound.applied[0].verdict,
        xln_rscore_batch::AccountInputVerdict::FrameDuplicate { height: 1, .. }
    ));
    assert_eq!(duplicate.outbound.proposals.len(), 1);
    let duplicate_ack = duplicate.outbound.proposals[0]
        .outbound_input
        .as_ref()
        .expect("duplicate proposal ACK");
    assert!(matches!(
        &duplicate_ack.kind,
        AccountInputKind::Ack(ack) if ack.height == 1
    ));
    assert_eq!(
        duplicate_ack.envelope, accepted_ack.envelope,
        "a duplicate must be re-ACKed from the same canonical Account envelope",
    );
}

#[test]
fn later_pure_ack_clears_earlier_duplicate_force_in_one_inbound_batch() {
    let hub_identity = identity("cancel-force-hub");
    let peer_identity = identity("cancel-force-peer");
    let hub = entity(&hub_identity);
    let peer = entity(&peer_identity);
    let account_id = AccountId::from_bytes(*peer.as_bytes());
    let state = account_state(&hub, &peer);
    let mut hub_account = AccountConsensus::new(
        AccountReplica::new(hub.clone(), state.clone()).expect("hub replica"),
    );
    let mut peer_account =
        AccountConsensus::new(AccountReplica::new(peer.clone(), state).expect("peer replica"));
    let envelope = |from: &EntityId, to: &EntityId| AccountInputEnvelope {
        from_entity_id: *from.as_bytes(),
        to_entity_id: *to.as_bytes(),
        domain: domain(),
        dispute_config: AccountDisputeConfig::new(10, 10).expect("dispute config"),
        watch_seed: Some(WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed")),
    };

    peer_account
        .admit_txs(
            vec![AccountTx::SetCreditLimit {
                token_id: TokenId::new(1).expect("token"),
                amount: BigInt::from(111),
            }],
            "force-cancel-peer",
        )
        .expect("peer admission");
    let ProposalOutcome::Proposed(first) = propose_account_frame(
        &mut peer_account,
        &peer_identity,
        TIMESTAMP,
        100,
        &support::market(),
    )
    .expect("peer proposal") else {
        panic!("peer must propose")
    };
    let first = *first;
    assert!(matches!(
        apply_incoming_frame(
            &mut hub_account,
            &hub_identity,
            &envelope(&peer, &hub),
            ReceiverClock {
                entity_timestamp: TIMESTAMP,
                finalized_j_height: 100,
            },
            IncomingFrame {
                frame: first.frame.clone(),
                state_hash: first.state_hash,
                frame_hanko: Some(first.hanko.clone()),
                dispute: None,
            },
            &support::market(),
        )
        .expect("hub accepts first"),
        IncomingOutcome::Committed { height: 1, .. }
    ));

    hub_account
        .admit_txs(
            vec![AccountTx::SetCreditLimit {
                token_id: TokenId::new(1).expect("token"),
                amount: BigInt::from(222),
            }],
            "force-cancel-hub",
        )
        .expect("hub admission");
    let ProposalOutcome::Proposed(second) = propose_account_frame(
        &mut hub_account,
        &hub_identity,
        TIMESTAMP + 1,
        100,
        &support::market(),
    )
    .expect("hub proposal") else {
        panic!("hub must propose")
    };
    let second = *second;
    let bundled_ack = second.bundled_ack.clone().expect("H=1 bundled ACK");
    assert!(bundled_ack.dispute.is_none() && second.dispute.is_none());
    let peer_result = apply_incoming_ack_frame(
        &mut peer_account,
        &peer_identity,
        &envelope(&hub, &peer),
        ReceiverClock {
            entity_timestamp: TIMESTAMP + 1,
            finalized_j_height: 100,
        },
        IncomingAck {
            height: bundled_ack.height,
            frame_hash: bundled_ack.frame_hash,
            frame_hanko: Some(bundled_ack.frame_hanko),
            dispute: None,
        },
        IncomingFrame {
            frame: second.frame.clone(),
            state_hash: second.state_hash,
            frame_hanko: Some(second.hanko.clone()),
            dispute: None,
        },
        &support::market(),
    )
    .expect("peer accepts ACK plus H=2");
    let AckFrameOutcome::Applied { frame, .. } = peer_result else {
        panic!("peer must apply ACK plus H=2")
    };
    let IncomingOutcome::Committed {
        height: 2,
        ack_hanko,
        ..
    } = *frame
    else {
        panic!("peer must commit H=2")
    };

    let seed = AccountSeed {
        account_id,
        replica: hub_account.replica().clone(),
        consensus: Some(hub_account.consensus_snapshot()),
    };
    let mut accounts = ResidentConsensusEngine::restore(
        EngineGeneration::from_bytes([0x5b; 8]),
        4,
        0,
        derive_signer_key(SEED, "cancel-force-hub").expect("hub key"),
        "cancel-force-hub".to_string(),
        support::market(),
        vec![seed],
    )
    .expect("resident pending hub account");
    let mut entity_state = EntityStateSlice::empty(hub.to_string(), TIMESTAMP + 2);
    entity_state.known_accounts.insert(peer.to_string());
    let expected_accounts_root = accounts.accounts_root();
    let result = apply_resident_entity_round(
        &mut accounts,
        entity_state,
        ResidentEntityRequest {
            inbound: EntityInboundRequest {
                owner_entity_id: *hub.as_bytes(),
                expected_accounts_root,
                clock: ReceiverClock {
                    entity_timestamp: TIMESTAMP + 2,
                    finalized_j_height: 100,
                },
                rows: vec![
                    AccountInputRow {
                        operation_index: 0,
                        account_id,
                        genesis_policy: None,
                        certified_board_authority:
                            xln_rscore_batch::AccountInputBoardAuthority::Lazy,
                        local_certified_board_authority:
                            xln_rscore_batch::AccountInputBoardAuthority::Lazy,
                        input: AccountInput {
                            envelope: envelope(&peer, &hub),
                            kind: AccountInputKind::AckFrame {
                                ack: None,
                                frame: Box::new(IncomingFrame {
                                    frame: first.frame,
                                    state_hash: first.state_hash,
                                    // Exact current-frame retry: restore must
                                    // retain the peer certificate and compare
                                    // these bytes before forcing an ACK.
                                    frame_hanko: Some(first.hanko),
                                    dispute: None,
                                }),
                            },
                        },
                    },
                    AccountInputRow {
                        operation_index: 1,
                        account_id,
                        genesis_policy: None,
                        certified_board_authority:
                            xln_rscore_batch::AccountInputBoardAuthority::Lazy,
                        local_certified_board_authority:
                            xln_rscore_batch::AccountInputBoardAuthority::Lazy,
                        input: AccountInput {
                            envelope: envelope(&peer, &hub),
                            kind: AccountInputKind::Ack(IncomingAck {
                                height: 2,
                                frame_hash: second.state_hash,
                                frame_hanko: Some(ack_hanko),
                                dispute: None,
                            }),
                        },
                    },
                ],
                post_accounts: false,
            },
            local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
            entity_height: 1,
            outbound_timestamp: TIMESTAMP + 2,
            outbound_j_height: 100,
            checkpoint_due: false,
            post_accounts: false,
            runtime_seed: None,
            scheduled_wake: None,
            expected_proposer_signer_id: "cancel-force-hub".to_string(),
            hub_rebalance_has_pending_work: false,
            finalized_j_events: None,
            entity_authority: None,
            local_account_genesis_policy: None,
            operations: vec![ResidentEntityOperation::AccountRange { start: 0, len: 2 }],
        },
        &DeterministicContext::hlt_default(),
    )
    .expect("duplicate then pure ACK round");

    assert_eq!(result.inbound.applied[0].force_ack, Some(true));
    assert_eq!(result.inbound.applied[1].force_ack, Some(false));
    assert!(matches!(
        result.inbound.applied[0].verdict,
        xln_rscore_batch::AccountInputVerdict::FrameDuplicate { height: 1, .. }
    ));
    assert!(matches!(
        result.inbound.applied[1].verdict,
        xln_rscore_batch::AccountInputVerdict::AckCommitted { height: 2, .. }
    ));
    assert!(
        result.outbound.proposals.is_empty(),
        "the later pure ACK cancels the earlier duplicate force in the same batch",
    );
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
    let mut j_authority = single_signer_authority("hub");
    j_authority.config.jurisdiction = Some(CanonicalValue::Object(vec![
        (
            "chainId".into(),
            CanonicalValue::Number(CanonicalNumber::try_from_u64(31_337).expect("chain id")),
        ),
        (
            "depositoryAddress".into(),
            CanonicalValue::String("0x8888888888888888888888888888888888888888".into()),
        ),
        (
            "entityProviderAddress".into(),
            CanonicalValue::String("0x9999999999999999999999999999999999999999".into()),
        ),
    ]));
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
            local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
            entity_height: 1,
            outbound_timestamp: TIMESTAMP,
            outbound_j_height: 43,
            checkpoint_due: false,
            post_accounts: false,
            runtime_seed: None,
            scheduled_wake: None,
            expected_proposer_signer_id: "hub".into(),
            hub_rebalance_has_pending_work: false,
            finalized_j_events: Some(ResidentJEventProjection {
                scanned_through: 43,
                runtime_seed: "runtime-seed".into(),
                claim: xln_rscore_entity_kernel::JPrefixRangeClaim {
                    jurisdiction_ref: "local".into(),
                    base_height: 42,
                    scanned_through_height: 43,
                    tip_block_hash: format!("0x{}", "43".repeat(32)),
                    event_history_root: format!("0x{}", "44".repeat(32)),
                    range_hash: format!("0x{}", "45".repeat(32)),
                    headers: Vec::new(),
                    blocks: Vec::new(),
                },
                proposer_signer_id: "hub".into(),
                proposer_signature: "0x".into(),
                batches: vec![FinalizedJEventBatch {
                    j_height: 43,
                    j_block_hash: [0x43; 32],
                    events: {
                        let mut events = match &claim {
                            AccountTx::JEventClaim(tx) => tx.events.clone(),
                            _ => Vec::new(),
                        };
                        events.push(JurisdictionEvent::ReserveUpdated(ReserveUpdatedEvent {
                            metadata: JEventMetadata {
                                block_number: Some(43),
                                block_hash: Some([0x43; 32]),
                                transaction_hash: Some([0x44; 32]),
                                log_index: Some(0),
                                event_index: None,
                            },
                            entity: hub.as_hex(),
                            token_id: 1,
                            new_balance: BigInt::from(7),
                        }));
                        xln_rscore_engine::canonical_events(&events).expect("events")
                    },
                    dispute_finalization_evidence: vec![],
                    reserve_updates: vec![JReserveUpdate {
                        token_id: 1,
                        own_reserve: BigInt::from(7),
                    }],
                    account_claims: vec![JClaimIngress {
                        account_id: peer.clone(),
                        tx: claim,
                    }],
                }],
            }),
            entity_authority: Some(j_authority),
            local_account_genesis_policy: None,
            operations: Vec::new(),
        },
        &DeterministicContext::hlt_default(),
    )
    .expect("resident J round");
    assert_eq!(result.state.last_finalized_j_height, 43);
    assert_eq!(result.state.reserves.get(&1), Some(&BigInt::from(7)));
    assert_eq!(result.outbound.accounts_root, before_root);
    assert_eq!(result.outbound.proposals.len(), 1);
    let proposal = &result.outbound.proposals[0];
    let proposed = proposal
        .outbound_input
        .as_ref()
        .expect("one outbound Account input");
    assert!(matches!(
        &proposed.kind,
        AccountInputKind::AckFrame { ack: None, .. }
    ));
    assert_live_pending_recovery_state(
        &mut accounts,
        peer_id,
        &proposal
            .incoming_ref()
            .expect("J-event proposal frame")
            .frame
            .txs,
    );
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
    let lock_id = hashlock.clone();
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
            local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
            entity_height: 1,
            outbound_timestamp: TIMESTAMP,
            outbound_j_height: 100,
            checkpoint_due: false,
            post_accounts: false,
            runtime_seed: None,
            scheduled_wake: None,
            expected_proposer_signer_id: "hub".into(),
            hub_rebalance_has_pending_work: false,
            finalized_j_events: None,
            entity_authority: None,
            local_account_genesis_policy: None,
            operations: vec![ResidentEntityOperation::Local(vec![
                xln_rscore_entity_kernel::AdmittedLocalEntityTx {
                    signer_id: "hub".into(),
                    board_epoch: 0,
                    tx: xln_rscore_entity_kernel::LocalEntityTx::Financial(
                        LocalEntityFinancialTx::DirectPayment(DirectPaymentEntityTx {
                            target_entity_id: peer.to_string(),
                            token_id: TokenId::new(1).expect("token"),
                            amount: BigInt::from(7),
                            route: route.clone(),
                            description: Some(String::new()),
                            delivery_mode: DeliveryMode::Direct,
                            trusted_gateway_entity_id: None,
                        }),
                    ),
                },
                xln_rscore_entity_kernel::AdmittedLocalEntityTx {
                    signer_id: "hub".into(),
                    board_epoch: 0,
                    tx: xln_rscore_entity_kernel::LocalEntityTx::Financial(
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
                    ),
                },
            ])],
        },
        &context,
    )
    .expect("fused local financial round");
    assert_eq!(result.non_mutating_wake_targets, vec![hub.to_string()]);
    assert_eq!(result.outbound.admissions.len(), 1);
    let proposal_row = &result.outbound.proposals[0];
    assert!(proposal_row.proposed.is_some(), "outbound proposal");
    let proposal_frame = &proposal_row.incoming_ref().expect("outbound frame").frame;
    assert!(matches!(
        proposal_frame.txs.as_slice(),
        [AccountTx::DirectPayment { description, .. }, AccountTx::HtlcLock(lock)]
            if description.as_deref() == Some(format!("Payment to {peer}").as_str())
                && lock.lock_id == lock_id
    ));
    assert!(
        result
            .state
            .paybook
            .entry(&hashlock)
            .expect("paybook lookup")
            .is_some()
    );
    assert!(result
        .outputs
        .iter()
        .any(|output| matches!(output, EntityKernelOutput::HtlcInitiated { lock_id: id, .. } if id == &lock_id)));
    assert_eq!(result.outbound.accounts_root, base_root);
    assert_live_pending_recovery_state(&mut accounts, peer_id, &proposal_frame.txs);
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
            certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
            local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
            input: AccountInput {
                envelope: AccountInputEnvelope {
                    from_entity_id: *payer.as_bytes(),
                    to_entity_id: *hub.as_bytes(),
                    domain: domain(),
                    dispute_config: AccountDisputeConfig::new(10, 10).expect("dispute config"),
                    watch_seed: Some(
                        WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
                    ),
                },
                kind: AccountInputKind::AckFrame {
                    ack: None,
                    frame: Box::new(IncomingFrame {
                        frame: proposed.frame,
                        state_hash: proposed.state_hash,
                        frame_hanko: Some(proposed.hanko),
                        dispute: None,
                    }),
                },
            },
        }],
        post_accounts: false,
    };
    let mut state = EntityStateSlice::empty(hub.to_string(), TIMESTAMP);
    state.known_accounts = BTreeSet::from([payer.to_string(), next.to_string()]).into();
    let result = apply_resident_entity_round(
        &mut accounts,
        state,
        ResidentEntityRequest {
            inbound,
            local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
            entity_height: 1,
            outbound_timestamp: TIMESTAMP,
            outbound_j_height: 100,
            checkpoint_due: false,
            post_accounts: false,
            runtime_seed: None,
            scheduled_wake: None,
            expected_proposer_signer_id: "hub".to_string(),
            hub_rebalance_has_pending_work: false,
            finalized_j_events: None,
            entity_authority: None,
            local_account_genesis_policy: None,
            operations: vec![ResidentEntityOperation::AccountRange { start: 0, len: 1 }],
        },
        &DeterministicContext::hlt_default(),
    )
    .expect("resident entity round");

    assert_eq!(result.inbound.applied.len(), 1);
    assert_eq!(result.outbound.admissions.len(), 1);
    assert_eq!(
        result
            .outbound
            .proposals
            .iter()
            .filter(|row| row.proposed.is_some())
            .count(),
        1,
    );
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
    let proposal_row = result
        .outbound
        .proposals
        .iter()
        .find(|row| row.account_id == next_id)
        .expect("forward proposal row");
    assert!(proposal_row.proposed.is_some(), "forward proposal");
    let proposal_frame = &proposal_row.incoming_ref().expect("forward frame").frame;
    assert_eq!(proposal_frame.txs.len(), 1);
    let AccountTx::DirectPayment {
        from_entity_id,
        to_entity_id,
        route,
        ..
    } = &proposal_frame.txs[0]
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
    let expected_proposal_order = vec![maker_seed.account_id, taker_seed.account_id];
    let seeds = vec![maker_seed, taker_seed];
    let rows = vec![maker_row, taker_row];
    type SwapParityEvidence = (
        [u8; 32],
        EntityKernelCommitments,
        Vec<EntityKernelOutput>,
        Vec<(AccountId, [u8; 32])>,
    );
    let mut oracle: Option<SwapParityEvidence> = None;

    for workers in [1, 4, 16] {
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
        state.known_accounts = BTreeSet::from([maker.to_string(), taker.to_string()]).into();
        state.orderbook = Some(OrderbookState::empty(10_000));
        let expected_accounts_root = accounts.accounts_root();
        let stage_invocations_before = accounts.entity_stage_invocations();
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
                local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
                entity_height: 1,
                outbound_timestamp: TIMESTAMP,
                outbound_j_height: 100,
                checkpoint_due: false,
                post_accounts: false,
                runtime_seed: None,
                scheduled_wake: None,
                expected_proposer_signer_id: "hub".to_string(),
                hub_rebalance_has_pending_work: false,
                finalized_j_events: None,
                entity_authority: Some(single_signer_authority("hub")),
                local_account_genesis_policy: None,
                operations: vec![
                    ResidentEntityOperation::AccountRange { start: 0, len: 1 },
                    ResidentEntityOperation::Local(vec![AdmittedLocalEntityTx {
                        signer_id: "hub".into(),
                        board_epoch: 0,
                        tx: LocalEntityTx::Control(LocalEntityControlTx::ChatMessage {
                            message: "between-independent-account-ranges".into(),
                        }),
                    }]),
                    ResidentEntityOperation::AccountRange { start: 1, len: 1 },
                ],
            },
            &DeterministicContext::hlt_default(),
        )
        .expect("resident swap round");
        assert_eq!(
            accounts.entity_stage_invocations() - stage_invocations_before,
            1,
            "Paybook slots and independent Orderbook pairs share one Stage2 dispatch at W{workers}",
        );
        let inbound_metric = accounts
            .account_phase_metrics()
            .into_iter()
            .find(|metric| metric.kind == AccountPhaseKind::Inbound)
            .expect("inbound phase metric");
        assert_eq!(
            inbound_metric.invocations, 1,
            "multiple AccountRange operations use one inbound worker phase at W{workers}",
        );
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
        let proposals = result
            .outbound
            .proposals
            .iter()
            .map(|row| {
                let proposed = row.proposed.as_ref().expect("swap resolve proposal");
                let frame = &row.incoming_ref().expect("swap resolve frame").frame;
                assert!(matches!(
                    frame.txs.as_slice(),
                    [AccountTx::SwapResolve { .. }]
                ));
                (row.account_id, proposed.state_hash)
            })
            .collect::<Vec<_>>();
        assert_eq!(
            proposals
                .iter()
                .map(|(account_id, _)| *account_id)
                .collect::<Vec<_>>(),
            expected_proposal_order,
            "outbound proposals retain the Account input positions",
        );
        let status = result
            .entity_frame_events
            .iter()
            .filter_map(|event| match event {
                EntityFrameEvent::Status { message } => Some(message.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        let maker_event = status
            .iter()
            .position(|message| message.starts_with("🤝 Accepted frame"))
            .expect("first Account event");
        let local_event = status
            .iter()
            .position(|message| *message == "between-independent-account-ranges")
            .expect("interleaved local event");
        let taker_event = status
            .iter()
            .rposition(|message| message.starts_with("🤝 Accepted frame"))
            .expect("second Account event");
        assert!(maker_event < local_event && local_event < taker_event);
        let book = &result.state.orderbook.as_ref().expect("orderbook").books["1/2"];
        assert_eq!(book.trade_count, 1);
        let evidence = (
            result.outbound.accounts_root,
            result.commitments,
            result.outputs,
            proposals,
        );
        if let Some(expected) = &oracle {
            assert_eq!(&evidence, expected, "worker count {workers}");
        } else {
            oracle = Some(evidence);
        }
    }
}

#[test]
fn failed_books_stage_rolls_back_account_candidate_and_exact_retry_matches_fresh_engine() {
    let hub_identity = identity("books-rollback-hub");
    let hub = entity(&hub_identity);
    let (seed, row, maker) = peer_proposal(
        "books-rollback-maker",
        &hub,
        0,
        offer_tx("books-rollback-offer", true),
    );
    let seeds = vec![seed];
    let make_engine = || {
        ResidentConsensusEngine::restore(
            EngineGeneration::from_bytes([0x61; 8]),
            4,
            0,
            derive_signer_key(SEED, "books-rollback-hub").expect("hub key"),
            "books-rollback-hub".to_string(),
            support::market(),
            seeds.clone(),
        )
        .expect("resident accounts")
    };
    let make_state = |with_orderbook: bool| {
        let mut state = EntityStateSlice::empty(hub.to_string(), TIMESTAMP);
        state.known_accounts.insert(maker.to_string());
        if with_orderbook {
            state.orderbook = Some(OrderbookState::empty(10_000));
        }
        state
    };
    let make_request = |expected_accounts_root, row: AccountInputRow| ResidentEntityRequest {
        inbound: EntityInboundRequest {
            owner_entity_id: *hub.as_bytes(),
            expected_accounts_root,
            clock: ReceiverClock {
                entity_timestamp: TIMESTAMP,
                finalized_j_height: 100,
            },
            rows: vec![row],
            post_accounts: false,
        },
        local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
        entity_height: 1,
        outbound_timestamp: TIMESTAMP,
        outbound_j_height: 100,
        checkpoint_due: false,
        post_accounts: false,
        runtime_seed: None,
        scheduled_wake: None,
        expected_proposer_signer_id: "books-rollback-hub".to_string(),
        hub_rebalance_has_pending_work: false,
        finalized_j_events: None,
        entity_authority: None,
        local_account_genesis_policy: None,
        operations: vec![ResidentEntityOperation::AccountRange { start: 0, len: 1 }],
    };

    let mut retried_engine = make_engine();
    let base_root = retried_engine.accounts_root();
    let base_revision = retried_engine.revision();
    let error = match apply_resident_entity_round(
        &mut retried_engine,
        make_state(false),
        make_request(base_root, row.clone()),
        &DeterministicContext::hlt_default(),
    ) {
        Ok(_) => panic!("an offer cannot enter stage 2 without the canonical orderbook extension"),
        Err(error) => error,
    };
    assert!(
        error.to_string().contains("ORDERBOOK_EXTENSION_REQUIRED"),
        "unexpected stage-2 failure: {error}",
    );
    assert_eq!(retried_engine.accounts_root(), base_root);
    assert_eq!(retried_engine.revision(), base_revision);

    let retried = apply_resident_entity_round(
        &mut retried_engine,
        make_state(true),
        make_request(base_root, row.clone()),
        &DeterministicContext::hlt_default(),
    )
    .expect("exact retry after books-stage rollback");

    let mut fresh_engine = make_engine();
    let fresh = apply_resident_entity_round(
        &mut fresh_engine,
        make_state(true),
        make_request(base_root, row),
        &DeterministicContext::hlt_default(),
    )
    .expect("fresh-engine oracle");
    let evidence = |result: &xln_rscore_entity_kernel::ResidentEntityResult| {
        (
            result.outbound.accounts_root,
            result.commitments.clone(),
            result.outputs.clone(),
            result
                .outbound
                .proposals
                .iter()
                .map(|proposal| {
                    (
                        proposal.account_id,
                        proposal.incoming_ref().map(|frame| frame.state_hash),
                    )
                })
                .collect::<Vec<_>>(),
        )
    };
    assert_eq!(evidence(&retried), evidence(&fresh));
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
        hashlock: HtlcHashlock::parse(&lock_id).expect("hashlock"),
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
        hooks: xln_rscore_entity_kernel::ScheduledHookMap::restore(BTreeMap::from([(
            format!("htlc-timeout:{lock_id}"),
            ScheduledHook::htlc_timeout(peer.to_string(), lock_id.clone(), due_at),
        )]))
        .expect("scheduled hooks"),
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
            local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
            entity_height: 1,
            outbound_timestamp: due_at,
            outbound_j_height: 100,
            checkpoint_due: false,
            post_accounts: false,
            runtime_seed: None,
            scheduled_wake: Some(ScheduledWake {
                version: 1,
                proposer_signer_id: "hub".to_string(),
                due_at,
                jobs,
            }),
            expected_proposer_signer_id: "hub".to_string(),
            hub_rebalance_has_pending_work: false,
            finalized_j_events: None,
            entity_authority: None,
            local_account_genesis_policy: None,
            operations: Vec::new(),
        },
        &DeterministicContext::hlt_default(),
    )
    .expect("scheduled timeout round");

    assert!(result.state.crontab.expect("crontab").hooks.is_empty());
    assert_eq!(result.outbound.admissions.len(), 1);
    let proposal_row = &result.outbound.proposals[0];
    assert!(proposal_row.proposed.is_some(), "timeout proposal");
    assert_eq!(result.outbound.proposals[0].account_id, peer_id);
    assert!(matches!(
        proposal_row
            .incoming_ref()
            .expect("timeout frame")
            .frame
            .txs
            .as_slice(),
        [AccountTx::HtlcResolve(resolve)]
            if resolve.lock_id == lock_id
                && matches!(
                    &resolve.outcome,
                    HtlcResolveOutcome::Error { reason }
                        if reason.as_deref() == Some("timeout")
                )
    ));
    assert_eq!(result.outbound.accounts_root, base_root);
    assert_live_pending_recovery_state(
        &mut accounts,
        peer_id,
        &proposal_row
            .incoming_ref()
            .expect("timeout recovery frame")
            .frame
            .txs,
    );
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
        hooks: xln_rscore_entity_kernel::ScheduledHookMap::restore(BTreeMap::from([(
            "htlc-timeout:forged".to_string(),
            ScheduledHook::htlc_timeout("peer".to_string(), "forged".to_string(), 150),
        )]))
        .expect("scheduled hooks"),
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
            local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
            entity_height: 1,
            outbound_timestamp: 200,
            outbound_j_height: 0,
            checkpoint_due: false,
            post_accounts: false,
            runtime_seed: None,
            scheduled_wake: Some(ScheduledWake {
                version: 1,
                proposer_signer_id: "attacker".to_string(),
                due_at: 150,
                jobs,
            }),
            expected_proposer_signer_id: "hub".to_string(),
            hub_rebalance_has_pending_work: false,
            finalized_j_events: None,
            entity_authority: None,
            local_account_genesis_policy: None,
            operations: Vec::new(),
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

/// The Account deadline reducer is only half the protocol: authenticated
/// secret evidence inside the 30-second reserve must cross the resident
/// Account→Entity boundary, enter Paybook, and queue the dispute lifecycle.
#[test]
fn reserve_window_secret_is_consumed_by_the_resident_entity_dispute_flow() {
    use sha3::{Digest as _, Keccak256};

    let hub_identity = identity("reserve-dispute-hub");
    let peer_identity = identity("reserve-dispute-peer");
    let hub = entity(&hub_identity);
    let peer = entity(&peer_identity);
    let account_id = AccountId::from_bytes(*peer.as_bytes());
    let transformer = [0x77_u8; 20];
    let shared_state = account_state(&hub, &peer);
    let mut hub_replica =
        AccountReplica::new(hub.clone(), shared_state.clone()).expect("hub replica");
    hub_replica.set_delta_transformer(transformer);
    let mut peer_replica = AccountReplica::new(peer.clone(), shared_state).expect("peer replica");
    peer_replica.set_delta_transformer(transformer);
    let mut hub_account = AccountConsensus::new(hub_replica);
    let mut peer_account = AccountConsensus::new(peer_replica);
    let secret_bytes = [0x7c_u8; 32];
    let secret = format!("0x{}", hex::encode(secret_bytes));
    let hashlock = format!(
        "0x{}",
        hex::encode(<[u8; 32]>::from(Keccak256::digest(secret_bytes)))
    );
    let timelock = TIMESTAMP + 100_000;
    peer_account
        .admit_txs(
            vec![AccountTx::HtlcLock(HtlcLockTx {
                lock_id: hashlock.clone(),
                hashlock: HtlcHashlock::parse(&hashlock).expect("hashlock"),
                timelock: BigInt::from(timelock),
                reveal_before_height: 200,
                amount: BigInt::from(50),
                token_id: TokenId::new(1).expect("token"),
                delivery_mode: None,
                envelope: None,
            })],
            "reserve dispute lock",
        )
        .expect("admit lock");
    let ProposalOutcome::Proposed(lock_frame) = propose_account_frame(
        &mut peer_account,
        &peer_identity,
        TIMESTAMP,
        100,
        &support::market(),
    )
    .expect("propose lock") else {
        panic!("peer lock proposal missing")
    };
    let lock_frame = *lock_frame;
    let lock_dispute = lock_frame
        .dispute
        .as_ref()
        .map(|draft| CounterpartyDispute {
            hanko: lock_frame.dispute_hanko.clone(),
            hash: draft.hash,
            proof_body_hash: draft.proof_body_hash,
            nonce: draft.nonce,
            proposer_is_left: draft.proposer_is_left,
        });
    let IncomingOutcome::Committed {
        ack_hanko,
        ack_dispute,
        ack_dispute_hanko,
        ..
    } = apply_incoming_frame(
        &mut hub_account,
        &hub_identity,
        &AccountInputEnvelope {
            from_entity_id: *peer.as_bytes(),
            to_entity_id: *hub.as_bytes(),
            domain: domain(),
            dispute_config: AccountDisputeConfig::new(10, 10).expect("dispute config"),
            watch_seed: Some(
                WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
            ),
        },
        ReceiverClock {
            entity_timestamp: TIMESTAMP,
            finalized_j_height: 100,
        },
        IncomingFrame {
            frame: lock_frame.frame.clone(),
            state_hash: lock_frame.state_hash,
            frame_hanko: Some(lock_frame.hanko.clone()),
            dispute: lock_dispute,
        },
        &support::market(),
    )
    .expect("hub commits lock")
    else {
        panic!("hub did not commit lock")
    };
    let ack_dispute = ack_dispute.map(|draft| CounterpartyDispute {
        hanko: ack_dispute_hanko,
        hash: draft.hash,
        proof_body_hash: draft.proof_body_hash,
        nonce: draft.nonce,
        proposer_is_left: draft.proposer_is_left,
    });
    let ack = xln_rscore_engine::apply_incoming_ack(
        &mut peer_account,
        &AccountInputEnvelope {
            from_entity_id: *hub.as_bytes(),
            to_entity_id: *peer.as_bytes(),
            domain: domain(),
            dispute_config: AccountDisputeConfig::new(10, 10).expect("dispute config"),
            watch_seed: Some(
                WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
            ),
        },
        IncomingAck {
            height: 1,
            frame_hash: lock_frame.state_hash,
            frame_hanko: Some(ack_hanko),
            dispute: ack_dispute,
        },
    )
    .expect("peer accepts lock ACK");
    assert!(matches!(
        ack,
        xln_rscore_engine::AckOutcome::Committed { .. }
    ));

    peer_account
        .admit_txs(
            vec![AccountTx::HtlcResolve(HtlcResolveTx {
                lock_id: hashlock.clone(),
                outcome: HtlcResolveOutcome::Secret {
                    secret: secret.clone(),
                },
            })],
            "reserve dispute secret",
        )
        .expect("admit secret");
    let ProposalOutcome::Proposed(resolve_frame) = propose_account_frame(
        &mut peer_account,
        &peer_identity,
        timelock - 20_000,
        100,
        &support::market(),
    )
    .expect("propose secret") else {
        panic!("peer secret proposal missing")
    };
    let resolve_frame = *resolve_frame;
    let expected_reason = format!(
        "HTLC_SECRET_ENFORCEMENT_WINDOW_TOO_SHORT: lock={hashlock} reserve=30000ms localTimestamp={}",
        timelock - 10_000,
    );
    let expected_frame_hash = format!("0x{}", hex::encode(resolve_frame.state_hash));
    let expected_frame_hanko = format!("0x{}", hex::encode(&resolve_frame.hanko));
    let resolve_dispute = resolve_frame
        .dispute
        .as_ref()
        .map(|draft| CounterpartyDispute {
            hanko: resolve_frame.dispute_hanko.clone(),
            hash: draft.hash,
            proof_body_hash: draft.proof_body_hash,
            nonce: draft.nonce,
            proposer_is_left: draft.proposer_is_left,
        });
    let seed = AccountSeed {
        account_id,
        replica: hub_account.replica().clone(),
        consensus: Some(hub_account.consensus_snapshot()),
    };
    let mut accounts = ResidentConsensusEngine::restore(
        EngineGeneration::from_bytes([0x7d; 8]),
        4,
        0,
        derive_signer_key(SEED, "reserve-dispute-hub").expect("hub key"),
        "reserve-dispute-hub".to_string(),
        support::market(),
        vec![seed],
    )
    .expect("resident account");
    let mut state = EntityStateSlice::empty(hub.to_string(), timelock - 10_000);
    state.known_accounts.insert(peer.to_string());
    state.crontab = Some(CrontabState::default());
    let expected_accounts_root = accounts.accounts_root();
    let result = apply_resident_entity_round(
        &mut accounts,
        state,
        ResidentEntityRequest {
            inbound: EntityInboundRequest {
                owner_entity_id: *hub.as_bytes(),
                expected_accounts_root,
                clock: ReceiverClock {
                    entity_timestamp: timelock - 10_000,
                    finalized_j_height: 100,
                },
                rows: vec![AccountInputRow {
                    operation_index: 0,
                    account_id,
                    genesis_policy: None,
                    certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
                    local_certified_board_authority:
                        xln_rscore_batch::AccountInputBoardAuthority::Lazy,
                    input: AccountInput {
                        envelope: AccountInputEnvelope {
                            from_entity_id: *peer.as_bytes(),
                            to_entity_id: *hub.as_bytes(),
                            domain: domain(),
                            dispute_config: AccountDisputeConfig::new(10, 10)
                                .expect("dispute config"),
                            watch_seed: Some(
                                WatchSeed::parse(&format!("0x{}", "99".repeat(32)))
                                    .expect("watch seed"),
                            ),
                        },
                        kind: AccountInputKind::AckFrame {
                            ack: None,
                            frame: Box::new(IncomingFrame {
                                frame: resolve_frame.frame,
                                state_hash: resolve_frame.state_hash,
                                frame_hanko: Some(resolve_frame.hanko),
                                dispute: resolve_dispute,
                            }),
                        },
                    },
                }],
                post_accounts: false,
            },
            local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
            entity_height: 1,
            outbound_timestamp: timelock - 10_000,
            outbound_j_height: 100,
            checkpoint_due: true,
            post_accounts: false,
            runtime_seed: None,
            scheduled_wake: None,
            expected_proposer_signer_id: "reserve-dispute-hub".to_string(),
            hub_rebalance_has_pending_work: false,
            finalized_j_events: None,
            entity_authority: None,
            local_account_genesis_policy: None,
            operations: vec![ResidentEntityOperation::AccountRange { start: 0, len: 1 }],
        },
        &DeterministicContext::hlt_default(),
    )
    .expect("resident dispute-required round");

    assert!(matches!(
        result.inbound.applied[0].verdict,
        xln_rscore_batch::AccountInputVerdict::FrameDisputeRequired { .. }
    ));
    assert_eq!(
        result
            .state
            .paybook
            .entry(&hashlock)
            .expect("paybook lookup")
            .and_then(|entry| entry.secret.as_deref()),
        Some(secret.as_str()),
    );
    assert_eq!(
        result
            .state
            .j_batch_state
            .as_ref()
            .expect("dispute batch")
            .batch
            .dispute_starts
            .len(),
        1,
    );
    let status = result
        .entity_frame_events
        .iter()
        .filter_map(|event| match event {
            EntityFrameEvent::Status { message } => Some(message.as_str()),
            EntityFrameEvent::Text { .. } => None,
        })
        .collect::<Vec<_>>();
    let prepare_status = status
        .iter()
        .position(|message| message.starts_with("⚔️ Dispute started vs "))
        .expect("prepare-dispute status");
    let unsafe_status = status
        .iter()
        .position(|message| *message == "⚠️ Unsafe account frame rejected; dispute start queued")
        .expect("unsafe-frame status");
    assert!(
        prepare_status < unsafe_status,
        "TS emits PrepareDispute before its final unsafe-frame disposition",
    );
    assert_eq!(
        result.routed_entity_outputs.len(),
        1,
        "upstream unsafe secret only persists; the sole output is JBroadcast",
    );
    assert_eq!(result.routed_entity_outputs[0].entity_id, hub.to_string());
    assert!(matches!(
        result.routed_entity_outputs[0].entity_txs.as_slice(),
        [xln_rscore_entity_kernel::LocalEntityOutputTx::Projected(tx)]
            if tx.kind == xln_rscore_entity_kernel::EntityTxKind::JBroadcast
    ));
    let checkpoint = result.outbound.checkpoint.expect("checkpoint");
    let account = checkpoint
        .accounts
        .iter()
        .find(|row| row.account_id == account_id)
        .expect("changed account checkpoint");
    let shadow = account
        .header
        .envelope
        .field("shadow")
        .expect("shadow evidence");
    let CanonicalValue::Object(shadow_fields) = shadow else {
        panic!("shadow is not an object")
    };
    let evidence = shadow_fields
        .iter()
        .find_map(|(name, value)| (name == "rejectedFrameEvidence").then_some(value))
        .expect("rejected-frame evidence");
    let CanonicalValue::Object(evidence_fields) = evidence else {
        panic!("rejected-frame evidence is not an object")
    };
    let evidence_field = |name: &str| {
        evidence_fields
            .iter()
            .find_map(|(field, value)| (field == name).then_some(value))
            .unwrap_or_else(|| panic!("missing rejected-frame evidence field {name}"))
    };
    assert_eq!(
        evidence_field("reason"),
        &CanonicalValue::String(expected_reason),
    );
    assert_eq!(
        evidence_field("frameHash"),
        &CanonicalValue::String(expected_frame_hash),
    );
    assert_eq!(
        evidence_field("frameHanko"),
        &CanonicalValue::String(expected_frame_hanko),
    );
}

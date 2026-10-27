use super::*;
use sha3::{Digest, Keccak256};
use xln_rscore_entity_kernel::{PaybookEntry, PaybookState};

#[test]
fn fixpay_2_refund_waits_for_downstream_finality_and_known_secret_never_refunds() {
    let hub_label = "fixpay-hub";
    let hub = entity(&identity(hub_label));
    let payer_signer = identity("fixpay-alice");
    let payer = entity(&payer_signer);
    let bob = entity(&identity("fixpay-bob"));
    let hash = format!("0x{}", hex::encode(Keccak256::digest([0xab; 32])));
    for (coverage, secret_known, outbound_live, pending, local, blocked) in [
        (100, false, true, false, false, true),
        (110, false, true, false, false, true),
        (111, false, true, false, false, true),
        (111, false, false, false, false, false),
        (111, true, false, false, false, true),
        (111, false, false, true, false, true),
        (111, false, false, true, true, true),
    ] {
        let lock_tx = |deadline: u64, height: u64| {
            AccountTx::HtlcLock(HtlcLockTx {
                lock_id: hash.clone(),
                hashlock: HtlcHashlock::parse(&hash).unwrap(),
                timelock: (TIMESTAMP + deadline).into(),
                reveal_before_height: height,
                amount: 100.into(),
                token_id: TokenId::new(1).unwrap(),
                delivery_mode: None,
                envelope: None,
            })
        };
        let payer_base = AccountReplica::new(payer.clone(), account_state(&payer, &hub)).unwrap();
        let inbound_state = SequentialAccountEngine::apply_with_context(
            &payer_base,
            payer_base.owner_side(),
            &lock_tx(120_000, 120),
            &AccountExecutionContext::new(TIMESTAMP, TIMESTAMP, 90, 0, 90),
        )
        .unwrap()
        .committed()
        .unwrap()
        .state()
        .clone();
        let mut payer_account = AccountConsensus::new(
            AccountReplica::new(payer.clone(), inbound_state.clone()).unwrap(),
        );
        payer_account
            .admit_txs(
                vec![AccountTx::HtlcResolve(HtlcResolveTx {
                    lock_id: hash.clone(),
                    outcome: HtlcResolveOutcome::Error {
                        reason: Some("timeout".into()),
                    },
                })],
                "fixpay",
            )
            .unwrap();
        let ProposalOutcome::Proposed(proposed) = propose_account_frame(
            &mut payer_account,
            &payer_signer,
            TIMESTAMP + 120_000,
            coverage,
            &support::market(),
        )
        .unwrap() else {
            panic!("timeout proposal")
        };
        let outbound_base = AccountReplica::new(hub.clone(), account_state(&hub, &bob)).unwrap();
        let outbound = SequentialAccountEngine::apply_with_context(
            &outbound_base,
            outbound_base.owner_side(),
            &lock_tx(110_000, 110),
            &AccountExecutionContext::new(TIMESTAMP, TIMESTAMP, 90, 0, 90),
        )
        .unwrap()
        .committed()
        .unwrap();
        let mut downstream = AccountConsensus::new(if outbound_live {
            outbound
        } else {
            outbound_base
        });
        if pending {
            downstream
                .admit_txs(vec![lock_tx(110_000, 110)], "lost-ack")
                .unwrap();
            assert!(matches!(
                propose_account_frame(
                    &mut downstream,
                    &identity(hub_label),
                    TIMESTAMP,
                    90,
                    &support::market()
                )
                .unwrap(),
                ProposalOutcome::Proposed(_)
            ));
            assert!(downstream.replica().state().htlc_lock(&hash).is_none());
            assert!(!downstream.pending().unwrap().hanko.is_empty());
        }
        let payer_id = AccountId::from_bytes(*payer.as_bytes());
        let mut accounts = ResidentConsensusEngine::restore(
            EngineGeneration::from_bytes([0x72; 8]),
            1,
            0,
            derive_signer_key(SEED, hub_label).unwrap(),
            hub_label.into(),
            support::market(),
            vec![
                AccountSeed {
                    account_id: payer_id,
                    replica: AccountReplica::new(hub.clone(), inbound_state).unwrap(),
                    consensus: None,
                },
                AccountSeed {
                    account_id: AccountId::from_bytes(*bob.as_bytes()),
                    replica: downstream.replica().clone(),
                    consensus: Some(downstream.consensus_snapshot()),
                },
            ],
        )
        .unwrap();
        let mut state = EntityStateSlice::empty(hub.to_string(), TIMESTAMP + 120_000);
        state.last_finalized_j_height = coverage;
        state.known_accounts = BTreeSet::from([payer.to_string(), bob.to_string()]).into();
        state.paybook = PaybookState::from_entries(
            [PaybookEntry {
                hashlock: hash.clone(),
                description: None,
                token_id: Some(1),
                amount: Some(100.into()),
                started_at_ms: None,
                originated: false,
                inbound_entity: Some(payer.to_string()),
                outbound_entity: Some(bob.to_string()),
                inbound_settled: false,
                outbound_settled: false,
                secret: secret_known.then(|| format!("0x{}", "ab".repeat(32))),
                secret_ack_pending: false,
                secret_ack_started_at: None,
                secret_ack_deadline_at: None,
                pending_fee: None,
                created_timestamp: TIMESTAMP,
            }],
            0.into(),
        )
        .unwrap();
        let root = accounts.accounts_root();
        let mut request = ResidentEntityRequest {
            inbound: EntityInboundRequest {
                owner_entity_id: *hub.as_bytes(),
                expected_accounts_root: root,
                clock: ReceiverClock {
                    entity_timestamp: TIMESTAMP + 120_000,
                    finalized_j_height: coverage,
                },
                owning_entity_is_hub: false,
                post_accounts: false,
                rows: vec![AccountInputRow {
                    operation_index: 0,
                    account_id: payer_id,
                    genesis_policy: None,
                    certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
                    local_certified_board_authority:
                        xln_rscore_batch::AccountInputBoardAuthority::Lazy,
                    input: AccountInput {
                        envelope: AccountInputEnvelope {
                            from_entity_id: *payer.as_bytes(),
                            to_entity_id: *hub.as_bytes(),
                            domain: domain(),
                            dispute_config: AccountDisputeConfig::new(10, 10).unwrap(),
                            watch_seed: Some(
                                WatchSeed::parse(&format!("0x{}", "99".repeat(32))).unwrap(),
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
            },
            local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
            entity_height: 1,
            outbound_timestamp: TIMESTAMP + 120_000,
            outbound_j_height: coverage,
            checkpoint_due: false,
            post_accounts: false,
            runtime_seed: None,
            scheduled_wake: None,
            propose_accounts_now: vec![],
            expected_proposer_signer_id: hub_label.into(),
            finalized_j_events: None,
            entity_authority: None,
            local_account_genesis_policy: None,
            cross_j_opening_sibling_views: vec![],
            operations: vec![ResidentEntityOperation::AccountRange { start: 0, len: 1 }],
        };
        if local {
            request.inbound.rows.clear();
            let tx = CanonicalEntityTx::from_frame_projection(
                EntityTxKind::ProcessHtlcTimeouts,
                CanonicalValue::Object(vec![(
                    "expiredLocks".into(),
                    CanonicalValue::Array(vec![CanonicalValue::Object(vec![
                        (
                            "accountId".into(),
                            CanonicalValue::String(payer.to_string()),
                        ),
                        ("lockId".into(), CanonicalValue::String(hash.clone())),
                    ])]),
                )]),
            )
            .unwrap();
            request.operations = vec![ResidentEntityOperation::Local(vec![
                AdmittedLocalEntityTx {
                    signer_id: hub_label.into(),
                    board_epoch: 0,
                    tx: LocalEntityTx::Financial(
                        decode_local_entity_financial_tx(&tx).unwrap().unwrap(),
                    ),
                },
            ])];
        }
        let result = apply_resident_entity_round_core(
            &mut accounts,
            state,
            request,
            &DeterministicContext::hlt_default(),
        );
        if local {
            let result = result.expect("local timeout round");
            assert!(
                result.outbound.proposals.is_empty(),
                "local refund proposed before downstream ACK"
            );
        } else if blocked {
            assert!(
                matches!(result, Err(ResidentEntityError::InboundAdmissionRejected { ref detail, .. })
                if detail.starts_with("HTLC_INBOUND_TIMEOUT_")),
                "unsafe refund accepted at {coverage}"
            );
        } else {
            assert!(result.is_ok(), "covered unrevealed refund");
        }
    }
}

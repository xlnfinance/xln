use super::*;
use ethabi::ethereum_types::U256;
use xln_rscore_entity_kernel::j_batch::{FinalDisputeProof, proof_body_from_engine};
use xln_rscore_entity_kernel::{JBatchState, ScheduledHookKind, schedule_hook};

fn number(value: u64) -> CanonicalValue {
    CanonicalValue::Number(CanonicalNumber::try_from_u64(value).unwrap())
}

fn run_due_dispute(
    workers: usize,
    queued: bool,
    manual: bool,
    abort_sent: bool,
) -> (xln_rscore_entity_kernel::ResidentEntityResult, [u8; 32]) {
    let owner = entity(&identity("hub"));
    let peer = entity(&identity("dispute-peer"));
    let now = TIMESTAMP + 20_000;
    let mut replica = AccountReplica::new(owner.clone(), account_state(&owner, &peer)).unwrap();
    replica.set_delta_transformer([0x77; 20]);
    let owner_left = owner < peer;
    let proof_hash = xln_rscore_engine::proof_body_hash(&replica, &[0x77; 20]).unwrap();
    let body = proof_body_from_engine(
        xln_rscore_engine::build_dispute_proof_body(&replica, &[0x77; 20]).unwrap(),
    )
    .unwrap();
    let mut consensus = AccountConsensus::new(replica);
    // Observed on-chain proof binds the actual canonical Account state; no
    // fabricated signature or opaque body is accepted by the finalize path.
    consensus
        .replace_entity_dispute_lifecycle(
            "disputed",
            None,
            Some(CanonicalValue::Object(vec![
                ("startedByLeft".into(), CanonicalValue::Bool(owner_left)),
                (
                    "initialProofbodyHash".into(),
                    CanonicalValue::String(format!("0x{}", hex::encode(proof_hash))),
                ),
                ("initialNonce".into(), number(1)),
                (
                    "initialProposerIsLeft".into(),
                    CanonicalValue::Bool(owner_left),
                ),
                ("disputeTimeout".into(), number(now / 1_000)),
                ("jNonce".into(), number(1)),
                ("observedOnChain".into(), CanonicalValue::Bool(true)),
                ("finalizeQueued".into(), CanonicalValue::Bool(false)),
                (
                    "starterInitialArguments".into(),
                    CanonicalValue::String("0x".into()),
                ),
                (
                    "starterCounterArguments".into(),
                    CanonicalValue::String("0x".into()),
                ),
                (
                    "starterCounterProofCommitment".into(),
                    CanonicalValue::String(format!("0x{}", "00".repeat(32))),
                ),
            ])),
        )
        .unwrap();
    let seed = AccountSeed {
        account_id: AccountId::from_bytes(*peer.as_bytes()),
        replica: consensus.replica().clone(),
        consensus: Some(consensus.consensus_snapshot()),
    };
    let mut accounts = ResidentConsensusEngine::restore(
        EngineGeneration::from_bytes([0x78; 8]),
        workers,
        0,
        derive_signer_key(SEED, "hub").unwrap(),
        "hub".into(),
        support::market(),
        vec![seed],
    )
    .unwrap();
    let mut state = EntityStateSlice::empty(owner.to_string(), now);
    state.known_accounts.insert(peer.to_string());
    let mut crontab = CrontabState::default();
    crontab.tasks.clear();
    schedule_hook(
        &mut crontab,
        ScheduledHook {
            id: format!("dispute-deadline:{peer}"),
            trigger_at: now,
            kind: ScheduledHookKind::DisputeDeadline {
                account_id: peer.to_string(),
            },
        },
    )
    .unwrap();
    let jobs = collect_due_scheduled_wake_jobs(&crontab, now, false).unwrap();
    state.crontab = Some(crontab);
    if queued {
        state.j_batch_state = Some(JBatchState::default());
        state
            .j_batch_state
            .as_mut()
            .unwrap()
            .batch
            .dispute_finalizations
            .push(FinalDisputeProof {
                counterentity: *peer.as_bytes(),
                initial_nonce: U256::from(1),
                final_nonce: U256::from(1),
                proposer_is_left: owner_left,
                initial_proofbody_hash: proof_hash,
                final_proofbody: body,
                starter_arguments: vec![],
                other_arguments: vec![],
                sig: vec![],
                started_by_left: owner_left,
                cooperative: false,
                submit_not_before_timestamp: Some(now / 1_000),
            });
    }
    let mut authority = single_signer_authority("hub");
    authority.config.jurisdiction = Some(CanonicalValue::Object(vec![
        ("name".into(), CanonicalValue::String("test".into())),
        ("chainId".into(), number(31_337)),
        (
            "depositoryAddress".into(),
            CanonicalValue::String(format!("0x{}", "88".repeat(20))),
        ),
        (
            "entityProviderAddress".into(),
            CanonicalValue::String(format!("0x{}", "99".repeat(20))),
        ),
    ]));
    if abort_sent {
        // Real canonical broadcast prepares an ordinary pending batch. The
        // due dispute must see it before the later user's abort removes it.
        let mut batch = JBatchState::default();
        batch
            .batch
            .reserve_to_reserve
            .push(xln_rscore_entity_kernel::j_batch::ReserveToReserve {
                receiving_entity: *peer.as_bytes(),
                token_id: U256::from(1),
                amount: U256::from(1),
            });
        state.j_batch_state = Some(batch);
        xln_rscore_entity_kernel::apply_local_entity_control_tx(
            &mut state,
            LocalEntityControlTx::JBroadcast {
                fee_overrides: None,
            },
            &mut Vec::new(),
            &authority,
            0,
        )
        .unwrap();
    }
    let request = ResidentEntityRequest {
        inbound: EntityInboundRequest {
            owner_entity_id: *owner.as_bytes(),
            owning_entity_is_hub: false,
            expected_accounts_root: accounts.accounts_root(),
            clock: ReceiverClock {
                entity_timestamp: now,
                finalized_j_height: 100,
            },
            rows: vec![],
            post_accounts: false,
        },
        local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
        entity_height: 1,
        outbound_timestamp: now,
        outbound_j_height: 100,
        checkpoint_due: false,
        post_accounts: false,
        runtime_seed: None,
        scheduled_wake: Some(ScheduledWake {
            version: 1,
            proposer_signer_id: "hub".into(),
            due_at: now,
            jobs,
        }),
        propose_accounts_now: vec![],
        expected_proposer_signer_id: "hub".into(),
        finalized_j_events: None,
        entity_authority: Some(authority),
        local_account_genesis_policy: None,
        cross_j_opening_sibling_views: vec![],
        operations: if abort_sent {
            vec![ResidentEntityOperation::Local(vec![
                AdmittedLocalEntityTx {
                    signer_id: "hub".into(),
                    board_epoch: 0,
                    tx: LocalEntityTx::Control(LocalEntityControlTx::JAbortSentBatch {
                        reason: None,
                        requeue_to_current: false,
                    }),
                },
            ])]
        } else if manual {
            vec![ResidentEntityOperation::Local(vec![
                AdmittedLocalEntityTx {
                    signer_id: "hub".into(),
                    board_epoch: 0,
                    tx: LocalEntityTx::Control(LocalEntityControlTx::JBroadcast {
                        fee_overrides: None,
                    }),
                },
            ])]
        } else {
            vec![]
        },
    };
    let result = apply_resident_entity_round(
        &mut accounts,
        state,
        request,
        &DeterministicContext::hlt_default(),
    )
    .unwrap();
    // These exact committed leaf fields distinguish TS wake-before-manual
    // semantics from broadcasting first and rearming the hook by 1 second.
    let fields = accounts
        .account_envelope_fields(AccountId::from_bytes(*peer.as_bytes()))
        .unwrap()
        .unwrap();
    let field = |name: &str| {
        fields
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value)
            .unwrap()
    };
    assert_eq!(field("status"), &CanonicalValue::String("disputed".into()));
    let CanonicalValue::Object(active) = field("activeDispute") else {
        panic!("observed dispute must remain active until J receipt");
    };
    assert_eq!(
        active
            .iter()
            .find(|(key, _)| key == "finalizeQueued")
            .map(|(_, value)| value),
        Some(&CanonicalValue::Bool(!abort_sent))
    );
    let hooks = &result.state.crontab.as_ref().unwrap().hooks;
    if abort_sent {
        assert_eq!(hooks.len(), 1, "wake sees sent batch before abort");
        let (_, hook) = hooks.iter().next().unwrap();
        assert_eq!(hook.id, format!("dispute-deadline:{peer}"));
        assert_eq!(hook.trigger_at, now + 1_000);
    } else {
        assert!(
            hooks.is_empty(),
            "TS consumes the due hook before manual broadcast"
        );
    }
    (result, accounts.accounts_root())
}

fn assert_same_frame(
    workers: usize,
    queued: bool,
    manual: bool,
) -> (EntityKernelCommitments, [u8; 32]) {
    let (result, root) = run_due_dispute(workers, queued, manual, false);
    assert!(
        result.routed_entity_outputs.is_empty(),
        "due finalization must never escape as a self-output"
    );
    let batch = result
        .state
        .j_batch_state
        .as_ref()
        .expect("same-frame J batch");
    assert_eq!(batch.broadcast_count, 1, "exactly one broadcast");
    assert!(batch.batch.dispute_finalizations.is_empty());
    assert_eq!(
        batch
            .sent_batch
            .as_ref()
            .expect("same-frame sent batch")
            .batch
            .dispute_finalizations
            .len(),
        1
    );
    assert_eq!(
        result
            .secondary_hashes
            .iter()
            .filter(|hash| matches!(hash.kind, xln_rscore_entity_kernel::HashType::JBatch))
            .count(),
        1
    );
    assert_eq!(result.state.height, 1);
    (result.commitments, root)
}

#[test]
fn due_dispute_finalize_and_broadcast_commit_in_same_entity_frame() {
    assert_eq!(
        assert_same_frame(1, false, false),
        assert_same_frame(4, false, false)
    );
}
#[test]
fn queued_dispute_finalize_broadcasts_without_deferred_self_output() {
    assert_eq!(
        assert_same_frame(1, true, false),
        assert_same_frame(4, true, false)
    );
}
#[test]
fn manual_broadcast_with_due_dispute_does_not_broadcast_twice() {
    assert_eq!(
        assert_same_frame(1, true, true),
        assert_same_frame(4, true, true)
    );
}

#[test]
fn scheduled_dispute_deadline_precedes_abort_without_manual_broadcast() {
    let run = |workers| {
        let (result, root) = run_due_dispute(workers, false, false, true);
        let batch = result.state.j_batch_state.as_ref().unwrap();
        assert!(
            batch.sent_batch.is_none(),
            "the later abort removes the old batch"
        );
        assert_eq!(
            batch.broadcast_count, 1,
            "wake must not create a replacement batch"
        );
        assert!(batch.batch.dispute_finalizations.is_empty());
        assert!(result.routed_entity_outputs.is_empty());
        assert!(
            result
                .secondary_hashes
                .iter()
                .all(|hash| !matches!(hash.kind, xln_rscore_entity_kernel::HashType::JBatch))
        );
        assert!(result.j_outputs.is_empty());
        (result.commitments, root)
    };
    assert_eq!(run(1), run(4));
}

//! One runtime frame as one call: admit, apply, propose — against a candidate
//! the runtime can still abort if its own record does not become durable.

mod fixture;

use fixture::{Stand, clock, payment, stand};
use xln_rscore_batch::{
    AccountAdmissionVerdict, AccountId, AccountInputKind, AccountInputVerdict, AccountSeed,
    BatchError, EngineGeneration, EntityProposalSelection, EntityWave, EntityWaveOps,
    StatefulConsensusEngine, WaveOp, WaveOpsRequest, WaveProposalRequest, WaveRequest, WaveResult,
};
use xln_rscore_engine::{
    AccountConsensus, AccountDisputeConfig, AccountDomain, AccountEnvelope, AccountIdentity,
    AccountReplica, AccountState, AccountTx, DepositoryAddress, ReserveSide, TokenId, WatchSeed,
};
use xln_rscore_protocol::CanonicalValue;

fn fresh_engine(signer_id: &str) -> StatefulConsensusEngine {
    StatefulConsensusEngine::restore(
        EngineGeneration::from_bytes([0x42; 8]),
        4,
        0,
        fixture::signer_key(signer_id),
        signer_id.to_string(),
        std::sync::Arc::default(),
        Vec::new(),
    )
    .expect("fresh authority engine")
}

fn genesis_seed(owner_signer: &str, peer_signer: &str) -> (AccountSeed, [u8; 32], [u8; 32]) {
    let (owner_bytes, owner) = fixture::entity_of(owner_signer);
    let (peer_bytes, peer) = fixture::entity_of(peer_signer);
    let (left, right) = if owner < peer {
        (owner.clone(), peer.clone())
    } else {
        (peer.clone(), owner.clone())
    };
    let identity = AccountIdentity::new(
        AccountDomain::new(
            31_337,
            DepositoryAddress::parse(&format!("0x{}", "88".repeat(20))).expect("depository"),
        )
        .expect("domain"),
        left,
        right,
        WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
    )
    .expect("identity");
    let state = AccountState::new(
        identity,
        AccountDisputeConfig::new(10, 10).expect("dispute config"),
        Vec::new(),
    )
    .expect("genesis state");
    let mut replica = AccountReplica::new(owner, state).expect("genesis replica");
    replica.set_envelope(canonical_genesis_envelope(&replica, false));
    replica.set_delta_transformer([0x77; 20]);
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

fn canonical_genesis_envelope(replica: &AccountReplica, public_pinned: bool) -> AccountEnvelope {
    canonical_genesis_envelope_with_policy(
        replica,
        public_pinned,
        &format!("0x{}", "00".repeat(32)),
    )
}

fn canonical_genesis_envelope_with_policy(
    replica: &AccountReplica,
    public_pinned: bool,
    policy_root: &str,
) -> AccountEnvelope {
    let zero_root = CanonicalValue::String(format!("0x{}", "00".repeat(32)));
    let mut fields = vec![(
        "status".to_string(),
        CanonicalValue::String("active".to_string()),
    )];
    if public_pinned {
        fields.push(("publicPinned".to_string(), CanonicalValue::Bool(true)));
    }
    fields.extend([
        ("currentHeight".to_string(), CanonicalValue::Number(0.0)),
        ("rollbackCount".to_string(), CanonicalValue::Number(0.0)),
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
                ("nextProofNonce".to_string(), CanonicalValue::Number(1.0)),
            ]),
        ),
        (
            "currentFrameHash".to_string(),
            CanonicalValue::String(String::new()),
        ),
        ("pendingWithdrawals".to_string(), zero_root.clone()),
        (
            "shadow".to_string(),
            CanonicalValue::Object(vec![(
                "rebalance".to_string(),
                CanonicalValue::Object(vec![
                    (
                        "policyRoot".to_string(),
                        CanonicalValue::String(policy_root.to_string()),
                    ),
                    ("submittedAtByTokenRoot".to_string(), zero_root),
                ]),
            )]),
        ),
    ]);
    AccountEnvelope::new(fields, Vec::new()).expect("canonical H=0 envelope")
}

fn replace_genesis_envelope_field(
    seed: &mut AccountSeed,
    field: &str,
    replacement: CanonicalValue,
) {
    let mut fields = seed.replica.envelope().fields().to_vec();
    let entry = fields
        .iter_mut()
        .find(|(name, _)| name == field)
        .expect("genesis field");
    entry.1 = replacement;
    let mempool = seed.replica.envelope().mempool().to_vec();
    let envelope = AccountEnvelope::new(fields, mempool).expect("replacement envelope");
    seed.replica.set_envelope(envelope);
}

fn create_op(operation_index: u64, seed: AccountSeed) -> WaveOp {
    WaveOp::Create {
        operation_index,
        seed: Box::new(seed),
    }
}

fn prepare_error(engine: &mut StatefulConsensusEngine, request: WaveRequest) -> BatchError {
    match engine.prepare_wave(request) {
        Ok(_) => panic!("expected wave preparation to fail"),
        Err(error) => error,
    }
}

fn wave(stand: &Stand, timestamp: u64) -> WaveRequest {
    wave_amount(stand, timestamp, 25)
}

fn wave_amount(stand: &Stand, timestamp: u64, amount: i64) -> WaveRequest {
    fixture::wave_of(fixture::admit_ops(stand, amount), timestamp, true)
}

fn run_staged_wave(engine: &mut StatefulConsensusEngine, request: WaveRequest) -> WaveResult {
    let selections = request
        .entities
        .iter()
        .filter(|entity| entity.propose)
        .map(|entity| {
            let mut account_ids = entity
                .ops
                .iter()
                .map(WaveOp::account_id)
                .collect::<Vec<_>>();
            account_ids.sort();
            account_ids.dedup();
            EntityProposalSelection {
                owner_entity_id: entity.owner_entity_id,
                account_ids,
            }
        })
        .collect();
    engine.prepare_wave(request).expect("prepare staged wave");
    engine
        .propose_wave(WaveProposalRequest {
            entities: selections,
        })
        .expect("propose staged wave");
    engine.seal_wave().expect("seal staged wave")
}

/// The wave does all three steps and reports what each produced.
#[test]
fn one_call_admits_applies_and_proposes() {
    let mut stand = stand(3);
    let request = wave(&stand, 1_700_000_000_000);
    let result = run_staged_wave(&mut stand.payer, request);
    assert_eq!(result.proposals.len(), 3);
    assert!(result.applied.is_empty());
    assert_eq!(result.accounts_root, stand.payer.accounts_root());
    assert!(stand.payer.wave_pending());

    let root = stand
        .payer
        .commit_wave(result.candidate_id)
        .expect("commit");
    assert_eq!(root, result.accounts_root);
    assert!(!stand.payer.wave_pending());
}

/// A runtime that could not make its own record durable takes the wave back,
/// and the engine is exactly where it was.
#[test]
fn an_aborted_wave_leaves_no_trace() {
    let mut stand = stand(3);
    let before_root = stand.payer.accounts_root();
    let before_revision = stand.payer.revision();

    let request = wave(&stand, 1_700_000_000_000);
    let result = stand.payer.prepare_wave(request).expect("wave");
    assert_ne!(result.accounts_root, before_root);

    let revision = stand.payer.abort_wave(result.candidate_id).expect("abort");
    assert_eq!(revision, before_revision);
    assert_eq!(stand.payer.accounts_root(), before_root);
    assert!(!stand.payer.wave_pending());

    // And the same wave can be run again, reaching the same candidate.
    let request = wave(&stand, 1_700_000_000_000);
    let again = stand.payer.prepare_wave(request).expect("wave again");
    assert_eq!(again.accounts_root, result.accounts_root);
    assert_eq!(again.revision, result.revision);
    assert_ne!(
        again.candidate_id, result.candidate_id,
        "a deterministic re-execution is still a distinct candidate attempt",
    );
    assert!(matches!(
        stand.payer.abort_wave(result.candidate_id),
        Err(BatchError::WaveCandidate { .. }),
    ));
    stand
        .payer
        .abort_wave(again.candidate_id)
        .expect("current candidate remains abortable");
}

/// Nothing else may touch the engine while a wave is uncommitted: a second
/// mutation could not be rolled back to the state the runtime agreed on.
#[test]
fn a_pending_wave_closes_every_other_door() {
    let mut stand = stand(2);
    let request = wave(&stand, 1_700_000_000_000);
    let result = stand.payer.prepare_wave(request).expect("wave");
    assert!(matches!(
        stand.payer.prepare_wave(wave(&stand, 1_700_000_000_001)),
        Err(BatchError::WavePending),
    ));
    assert!(matches!(
        stand.payer.checkpoint_changes(),
        Err(BatchError::WavePending),
    ));
    assert!(matches!(
        stand
            .payer
            .checkpoint_changes_for_wave(xln_rscore_batch::CandidateId::from_bytes([0xff; 32])),
        Err(BatchError::WaveOpen),
    ));
    assert!(matches!(
        stand.payer.checkpoint_changes_for_wave(result.candidate_id),
        Err(BatchError::WaveOpen),
    ));
    let sealed = stand.payer.seal_wave().expect("seal");
    let candidate_checkpoint = stand
        .payer
        .checkpoint_changes_for_wave(sealed.candidate_id)
        .expect("candidate checkpoint");
    assert_eq!(candidate_checkpoint.accounts_root(), sealed.accounts_root);
    assert_eq!(candidate_checkpoint.revision(), sealed.revision);
    assert_eq!(
        candidate_checkpoint.restore_token().base_revision,
        sealed.revision,
    );
    assert!(matches!(
        stand.payer.commit_checkpoint(&candidate_checkpoint.token),
        Err(BatchError::WavePending),
    ));
    // Only the candidate that was prepared may be committed.
    assert!(matches!(
        stand
            .payer
            .commit_wave(xln_rscore_batch::CandidateId::from_bytes([0xff; 32])),
        Err(BatchError::WaveCandidate { .. }),
    ));
    stand
        .payer
        .commit_wave(sealed.candidate_id)
        .expect("commit");
    stand
        .payer
        .commit_checkpoint(&candidate_checkpoint.token)
        .expect("checkpoint after runtime WAL");
    assert_eq!(
        stand.payer.checkpoint_token().expect("durable token"),
        candidate_checkpoint.restore_token(),
    );
    assert!(matches!(
        stand.payer.commit_wave(sealed.candidate_id),
        Err(BatchError::WaveMissing),
    ));
}

/// The full round trip between two engines, each driven by one wave per side:
/// the payer proposes, the payee applies and acks, the payer commits on the
/// ack — and the ack is where the effects come back.
#[test]
fn two_engines_settle_a_payment_in_three_waves() {
    let mut stand = stand(2);
    let timestamp = 1_700_000_000_000;
    let request = wave(&stand, timestamp);
    let proposed = run_staged_wave(&mut stand.payer, request);
    stand
        .payer
        .commit_wave(proposed.candidate_id)
        .expect("commit propose");

    let frames = fixture::frame_ops(&stand, &proposed.proposals);
    let request = fixture::wave_of(frames, timestamp, false);
    let applied: WaveResult = run_staged_wave(&mut stand.payee, request);
    stand
        .payee
        .commit_wave(applied.candidate_id)
        .expect("commit apply");
    assert_eq!(applied.applied.len(), 2);
    for (row, proposal) in applied.applied.iter().zip(&proposed.proposals) {
        let AccountInputVerdict::FrameCommitted {
            committed_frame, ..
        } = &row.verdict
        else {
            panic!("expected a frame commit: {:?}", row.verdict);
        };
        assert!(committed_frame.committed_via_new_frame);
        assert_eq!(
            &committed_frame.frame,
            &proposal.proposed.as_ref().expect("proposed frame").frame,
        );
    }

    let acks = fixture::ack_ops(&stand, &applied.applied);
    let request = fixture::wave_of(acks, timestamp, false);
    let acked = run_staged_wave(&mut stand.payer, request);
    stand
        .payer
        .commit_wave(acked.candidate_id)
        .expect("commit ack");
    for (row, proposal) in acked.applied.iter().zip(&proposed.proposals) {
        let AccountInputVerdict::AckCommitted {
            committed_frame, ..
        } = &row.verdict
        else {
            panic!("expected an ack commit: {:?}", row.verdict);
        };
        assert!(!committed_frame.committed_via_new_frame);
        assert_eq!(
            &committed_frame.frame,
            &proposal.proposed.as_ref().expect("proposed frame").frame,
        );
    }
    // The two engines key their accounts by the counterparty, so their trees
    // are different shapes. What must agree is the account itself: same
    // height, same financial root, on both sides of every pair.
    for pair in &stand.pairs {
        let payer = stand
            .payer
            .account(&pair.payer_account)
            .expect("payer view");
        let payee = stand
            .payee
            .account(&pair.payee_account)
            .expect("payee view");
        assert_eq!(payer.current_height(), 1);
        assert_eq!(payee.current_height(), 1);
        assert_eq!(
            payer
                .replica()
                .state()
                .payment_profile_account_state_root()
                .expect("payer root"),
            payee
                .replica()
                .state()
                .payment_profile_account_state_root()
                .expect("payee root"),
        );
    }
}

/// The market tables arrive with Hello and belong to the frame, not to the
/// account tree. An engine that never received them cannot propose a swap at
/// all — which is the check that catches a runtime that forgot to install
/// them, instead of a frame priced against an empty registry.
#[test]
fn the_market_from_hello_reaches_the_proposal() {
    let mut without = fixture::stand(1);
    without
        .payer
        .admit_txs(vec![fixture::swap_offer(&without.pairs[0])])
        .expect("admit");
    let Err(error) = without.payer.propose_frames(1_700_000_000_000, 100, None) else {
        panic!("an empty market cannot price an offer");
    };
    assert!(
        error.to_string().contains("SWAP_MARKET_POLICY_MISSING"),
        "{error}"
    );

    let mut with = fixture::stand_with_market(1, fixture::market());
    with.payer
        .admit_txs(vec![fixture::swap_offer(&with.pairs[0])])
        .expect("admit");
    let proposals = with
        .payer
        .propose_frames(1_700_000_000_000, 100, None)
        .expect("propose");
    assert_eq!(proposals.len(), 1);
    let proposed = proposals[0].proposed.as_ref().expect("a frame");
    assert_eq!(proposed.frame.txs.len(), 1);
    assert!(proposals[0].dropped.is_empty());
}

/// A wave reports the accounts it moved, each with the leaf the Entity tree
/// would commit for it. The root says that two engines differ; these say
/// which account does.
#[test]
fn a_wave_reports_every_leaf_it_moved() {
    let mut stand = stand(2);
    let request = wave(&stand, 1_700_000_000_000);
    let first = run_staged_wave(&mut stand.payer, request);

    assert_eq!(first.touched.len(), 2);
    for (account_id, leaf) in &first.touched {
        let account = stand.payer.account(account_id).expect("account");
        assert_eq!(*leaf, account.entity_account_leaf().expect("leaf"));
    }
    assert!(
        first.touched.windows(2).all(|pair| pair[0].0 < pair[1].0),
        "leaves are in account order, so the digest over them is stable"
    );
    assert_eq!(first.post_accounts.len(), first.touched.len());
    for ((account_id, leaf), post_account) in first.touched.iter().zip(&first.post_accounts) {
        let account = stand.payer.account(account_id).expect("account");
        assert_eq!(post_account.account_id, *account_id);
        assert_eq!(post_account.account_leaf, *leaf);
        assert_eq!(
            post_account.header.signer_id,
            stand
                .payer
                .signer_of(account.replica().owner().as_bytes())
                .expect("account signer")
        );
        // Rows are a diff against the account the caller already holds: a
        // window that only moved consensus state changes no state leaf at all.
        assert_eq!(post_account.del_count(), 0, "this window deletes nothing");
        assert!(
            post_account.consensus.pending.is_some(),
            "the materialization carries the post-proposal envelope"
        );
    }

    // Aborting and re-running the same wave reaches the same tree.
    stand.payer.abort_wave(first.candidate_id).expect("abort");
    let request = wave(&stand, 1_700_000_000_000);
    let again = run_staged_wave(&mut stand.payer, request);
    assert_eq!(again.accounts_root, first.accounts_root);
    assert_eq!(again.touched, first.touched);
}

/// A window where nothing survives still moves the account: the transactions
/// left the mempool, so the leaf changed. The attempt is reported with no
/// frame and with the rows it dropped — an engine that reported nothing here
/// would be silently ahead of the one it is compared against.
#[test]
fn a_window_that_proposes_nothing_still_reports_what_it_dropped() {
    let mut stand = stand(1);
    // More than the account can cover: rejected, and not the kind of rejection
    // that is retried, so the transaction leaves the mempool for good.
    stand
        .payer
        .admit_txs(vec![payment(&stand.pairs[0], 10_000_000_000)])
        .expect("admit");
    let before = stand.payer.accounts_root();

    let owner = stand.pairs[0].payer_entity;
    let account_id = stand.pairs[0].payer_account;
    stand
        .payer
        .prepare_wave(fixture::propose_only_wave(owner, 1_700_000_000_000))
        .expect("prepare");
    let result = stand
        .payer
        .propose_wave(WaveProposalRequest {
            entities: vec![EntityProposalSelection {
                owner_entity_id: owner,
                account_ids: vec![account_id],
            }],
        })
        .expect("propose");

    assert_eq!(result.proposals.len(), 1, "the attempt is reported");
    assert!(result.proposals[0].proposed.is_none(), "no frame survived");
    assert_eq!(result.proposals[0].dropped.len(), 1);
    let dropped = &result.proposals[0].dropped[0];
    assert_eq!(dropped.index, 0);
    assert_eq!(dropped.disposition, xln_rscore_engine::Disposition::Removed);
    assert!(!dropped.code.is_empty());
    assert_ne!(dropped.tx_digest, [0; 32]);

    // The account moved even though no frame did, and the wave says so.
    assert_ne!(result.accounts_root, before);
    assert_eq!(result.touched.len(), 1);
    assert_eq!(result.touched[0].0, stand.pairs[0].payer_account);
}

/// Operation indices are stable arrival identities. They must increase and be
/// unique, while gaps remain legal when a multi-owner collector sends only one
/// owner's subset to this engine.
#[test]
fn operation_indices_are_monotonic_unique_and_allow_gaps() {
    let mut stand = stand(1);
    let pair = &stand.pairs[0];
    let row = |operation_index: u64| {
        fixture::input_row(
            operation_index,
            pair.payer_account,
            pair.payee_entity,
            pair.payer_entity,
            AccountInputKind::Ack(xln_rscore_engine::IncomingAck {
                height: 1,
                frame_hash: [0; 32],
                frame_hanko: Some(Vec::new()),
                dispute: None,
            }),
        )
    };

    let duplicate = stand
        .payer
        .apply_inputs(clock(1_700_000_000_000), vec![row(0), row(0)]);
    assert!(
        matches!(
            duplicate,
            Err(BatchError::OperationIndex {
                actual: 0,
                after: Some(0)
            })
        ),
        "{duplicate:?}"
    );

    let gap = stand
        .payer
        .apply_inputs(clock(1_700_000_000_000), vec![row(0), row(2)])
        .expect("gapped subset");
    assert_eq!(gap[0].operation_index, 0);
    assert_eq!(gap[1].operation_index, 2);
}

/// Local admission is itself an ordered candidate operation. Lifecycle rows
/// are idempotent across both queued and pending work, while direct payments
/// deliberately retain exact multiplicity.
#[test]
fn admission_receipts_match_lifecycle_dedupe_and_payment_multiplicity() {
    let timestamp = 1_700_000_000_000;
    let mut stand = fixture::stand_with_market(1, fixture::market());
    let pair = &stand.pairs[0];
    let (account_id, offer) = fixture::swap_offer(pair);
    let mut repeated_offer = offer.clone();
    repeated_offer.extend(offer.clone());
    let initial = stand
        .payer
        .prepare_wave(fixture::wave_of(
            vec![(
                pair.payer_entity,
                WaveOp::Admit {
                    operation_index: 10,
                    account_id,
                    txs: repeated_offer,
                },
            )],
            timestamp,
            true,
        ))
        .expect("admit duplicate lifecycle rows");
    assert!(matches!(
        initial.admissions[0].verdict,
        AccountAdmissionVerdict::Admitted { count: 1 }
    ));
    stand
        .payer
        .propose_wave(WaveProposalRequest {
            entities: vec![EntityProposalSelection {
                owner_entity_id: pair.payer_entity,
                account_ids: vec![account_id],
            }],
        })
        .expect("move offer to pending");
    let sealed = stand.payer.seal_wave().expect("seal offer");
    stand
        .payer
        .commit_wave(sealed.candidate_id)
        .expect("commit offer");

    let pending_duplicate = stand
        .payer
        .prepare_wave(fixture::wave_of(
            vec![(
                pair.payer_entity,
                WaveOp::Admit {
                    operation_index: 20,
                    account_id,
                    txs: offer,
                },
            )],
            timestamp + 1,
            false,
        ))
        .expect("admit pending duplicate");
    assert!(matches!(
        pending_duplicate.admissions[0].verdict,
        AccountAdmissionVerdict::Admitted { count: 0 }
    ));
    stand
        .payer
        .abort_wave(pending_duplicate.candidate_id)
        .expect("abort duplicate probe");

    let (_, payments) = payment(pair, 25);
    let mut repeated_payments = payments.clone();
    repeated_payments.extend(payments);
    let payment_result = stand
        .payer
        .prepare_wave(fixture::wave_of(
            vec![(
                pair.payer_entity,
                WaveOp::Admit {
                    operation_index: 30,
                    account_id,
                    txs: repeated_payments,
                },
            )],
            timestamp + 2,
            false,
        ))
        .expect("admit repeated payments");
    assert!(matches!(
        payment_result.admissions[0].verdict,
        AccountAdmissionVerdict::Admitted { count: 2 }
    ));
}

#[test]
fn apply_continues_candidate_global_indices_and_rolls_back_a_bad_step() {
    let timestamp = 1_700_000_000_000;
    let mut stand = stand(1);
    let pair = &stand.pairs[0];
    let (account_id, txs) = payment(pair, 10);
    let prepared = stand
        .payer
        .prepare_wave(fixture::wave_of(
            vec![(
                pair.payer_entity,
                WaveOp::Admit {
                    operation_index: 10,
                    account_id,
                    txs: txs.clone(),
                },
            )],
            timestamp,
            false,
        ))
        .expect("prepare");
    let root_before_bad_step = prepared.accounts_root;
    let repeated = stand.payer.apply_wave_ops(WaveOpsRequest {
        entities: vec![EntityWaveOps {
            owner_entity_id: pair.payer_entity,
            ops: vec![WaveOp::Admit {
                operation_index: 10,
                account_id,
                txs: txs.clone(),
            }],
        }],
    });
    assert!(matches!(
        repeated,
        Err(BatchError::OperationIndex {
            actual: 10,
            after: Some(10)
        })
    ));
    assert_eq!(stand.payer.accounts_root(), root_before_bad_step);

    let continued = stand
        .payer
        .apply_wave_ops(WaveOpsRequest {
            entities: vec![EntityWaveOps {
                owner_entity_id: pair.payer_entity,
                ops: vec![WaveOp::Admit {
                    operation_index: 12,
                    account_id,
                    txs,
                }],
            }],
        })
        .expect("gapped continuation");
    assert_eq!(continued.admissions[0].operation_index, 12);
}

/// Every Entity stamps its own proposals. A wave that carried one timestamp
/// for the whole runtime frame would sign one Entity's frame with another
/// Entity's clock, and the frame hash is what both engines are compared on.
#[test]
fn each_entity_stamps_its_proposals_with_its_own_clock() {
    let mut stand = stand(2);
    let first = 1_700_000_000_000;
    let second = first + 4_000;
    let ops = fixture::admit_ops(&stand, 25);
    let mut request = fixture::wave_of(ops, first, true);
    assert_eq!(request.entities.len(), 2, "one group per owner Entity");
    request.entities[1].timestamp = second;
    request.entities[1].clock = clock(second);

    let result = run_staged_wave(&mut stand.payer, request);
    assert_eq!(result.proposals.len(), 2);
    for row in &result.proposals {
        let proposed = row.proposed.as_ref().expect("frame");
        let owner = if row.account_id == stand.pairs[0].payer_account {
            first
        } else {
            second
        };
        assert_eq!(proposed.frame.timestamp, owner, "{:?}", row.account_id);
    }
}

/// And every Entity judges arrivals on its own clock. Here one Entity's clock
/// is far enough behind the frame it receives to reject it for skew while its
/// neighbour, in the same wave, commits the same kind of frame.
#[test]
fn each_entity_judges_arrivals_with_its_own_clock() {
    let mut stand = stand(2);
    let timestamp = 1_700_000_000_000;
    let request = wave(&stand, timestamp);
    let proposed = run_staged_wave(&mut stand.payer, request);
    stand
        .payer
        .commit_wave(proposed.candidate_id)
        .expect("commit");

    let ops = fixture::frame_ops(&stand, &proposed.proposals);
    let mut request = fixture::wave_of(ops, timestamp, false);
    assert_eq!(request.entities.len(), 2);
    // A minute behind the frame it is being handed: past the 30s skew bound.
    let behind = timestamp - 60_000;
    request.entities[0].clock = clock(behind);
    request.entities[0].timestamp = behind;

    let applied = stand.payee.prepare_wave(request).expect("apply");
    assert_eq!(applied.applied.len(), 2);
    let stale = applied
        .applied
        .iter()
        .find(|row| row.operation_index == 0)
        .expect("first verdict");
    let current = applied
        .applied
        .iter()
        .find(|row| row.operation_index == 1)
        .expect("second verdict");
    match &stale.verdict {
        AccountInputVerdict::FrameRejected { reason } => {
            assert!(reason.contains("skew"), "{reason}");
        }
        other => panic!("expected a skew rejection, got {other:?}"),
    }
    assert!(
        matches!(current.verdict, AccountInputVerdict::FrameCommitted { .. }),
        "{:?}",
        current.verdict,
    );
}

/// Two groups for one Entity would give it two clocks, and the wave would have
/// no single answer about what has expired for it.
#[test]
fn two_groups_for_one_entity_are_refused() {
    let mut stand = stand(1);
    let timestamp = 1_700_000_000_000;
    let (account_id, txs) = payment(&stand.pairs[0], 25);
    let group = |ops: Vec<WaveOp>, timestamp: u64| EntityWave {
        owner_entity_id: stand.pairs[0].payer_entity,
        timestamp,
        j_height: 100,
        clock: clock(timestamp),
        ops,
        propose: true,
    };
    let refused = stand.payer.prepare_wave(WaveRequest {
        entities: vec![
            group(
                vec![WaveOp::Admit {
                    operation_index: 0,
                    account_id,
                    txs,
                }],
                timestamp,
            ),
            group(Vec::new(), timestamp + 1_000),
        ],
        post_accounts: true,
    });
    assert!(
        matches!(refused, Err(BatchError::WaveEntityDuplicate { .. })),
        "{:?}",
        refused.err()
    );
    assert!(!stand.payer.wave_pending(), "nothing was left half-applied");
}

/// A group naming an account it does not own is refused: the account says who
/// owns it, and that is not what the group claimed.
#[test]
fn an_account_named_by_another_entity_is_refused() {
    let mut stand = stand(2);
    let timestamp = 1_700_000_000_000;
    let (account_id, txs) = payment(&stand.pairs[0], 25);
    let refused = stand.payer.prepare_wave(WaveRequest {
        entities: vec![EntityWave {
            // The second pair's Entity, claiming the first pair's account.
            owner_entity_id: stand.pairs[1].payer_entity,
            timestamp,
            j_height: 100,
            clock: clock(timestamp),
            ops: vec![WaveOp::Admit {
                operation_index: 0,
                account_id,
                txs,
            }],
            propose: false,
        }],
        post_accounts: true,
    });
    assert!(
        matches!(refused, Err(BatchError::WaveAccountOwner { .. })),
        "{:?}",
        refused.err()
    );
}

/// Indices are checked across the whole wave, not within a group: the driver
/// numbers its raw inputs once per runtime frame and matches the Nth verdict
/// back to the Nth input.
#[test]
fn input_indices_are_sequential_across_entity_groups() {
    let mut stand = stand(2);
    let timestamp = 1_700_000_000_000;
    let request = wave(&stand, timestamp);
    let proposed = run_staged_wave(&mut stand.payer, request);
    stand
        .payer
        .commit_wave(proposed.candidate_id)
        .expect("commit");

    let mut ops = fixture::frame_ops(&stand, &proposed.proposals);
    // Both groups now start at zero, which is exactly the collision the check
    // exists for: two verdicts would answer to the same raw input.
    if let (_, WaveOp::Input(row)) = &mut ops[1] {
        row.operation_index = 0;
    }
    let refused = stand
        .payee
        .prepare_wave(fixture::wave_of(ops, timestamp, false));
    assert!(
        matches!(
            refused,
            Err(BatchError::OperationIndex {
                actual: 0,
                after: Some(0)
            })
        ),
        "{:?}",
        refused.err()
    );
}

/// Admissions and peer inputs interleave inside one runtime frame (measured:
/// 10 of 40 runtime frames in a same-jurisdiction swap recording), and the
/// order is not cosmetic. A losing proposal returns its transactions to the
/// front of the queue and drops the ones already queued; whether our own
/// admission was already there decides how many copies survive.
#[test]
fn an_account_replays_its_operations_in_arrival_order() {
    let queued = |admit_first: bool| -> usize {
        let mut stand = fixture::stand_with_market(6, fixture::market());
        let timestamp = 1_700_000_000_000;
        let index = stand
            .pairs
            .iter()
            .position(|pair| {
                stand
                    .payee
                    .account(&pair.payee_account)
                    .expect("payee view")
                    .replica()
                    .owner_side()
                    == xln_rscore_engine::Side::Right
            })
            .expect("one pair has the payee on the RIGHT side");
        let pair = &stand.pairs[index];
        let account_id = pair.payee_account;
        let (_, offer) = fixture::swap_offer(pair);

        // The payee proposes its own frame carrying the offer: that is the
        // proposal the LEFT entity's frame will beat.
        stand
            .payee
            .admit_txs(vec![(account_id, offer.clone())])
            .expect("payee admit");
        stand
            .payee
            .propose_frames(timestamp, 100, Some(&[account_id]))
            .expect("payee propose");

        // The payer proposes at the same height, which is the collision.
        let request = wave(&stand, timestamp);
        let proposed = run_staged_wave(&mut stand.payer, request);
        stand
            .payer
            .commit_wave(proposed.candidate_id)
            .expect("commit");
        let incoming = fixture::frame_ops(&stand, &proposed.proposals)
            .into_iter()
            .find(|(_, op)| op.account_id() == account_id)
            .expect("the payee's own account");

        let admit = (
            pair.payee_entity,
            WaveOp::Admit {
                operation_index: 0,
                account_id,
                txs: offer,
            },
        );
        let ops = if admit_first {
            vec![admit, incoming]
        } else {
            vec![incoming, admit]
        };
        // Indices are per wave, so the input's index depends on where it sits.
        let mut ops = ops;
        for (operation_index, (_, op)) in ops.iter_mut().enumerate() {
            match op {
                WaveOp::Admit {
                    operation_index: index,
                    ..
                } => *index = operation_index as u64,
                WaveOp::Input(row) => row.operation_index = operation_index as u64,
                WaveOp::Create {
                    operation_index: index,
                    ..
                } => *index = operation_index as u64,
            }
        }
        let request = fixture::wave_of(ops, timestamp, false);
        let applied = run_staged_wave(&mut stand.payee, request);
        stand
            .payee
            .commit_wave(applied.candidate_id)
            .expect("commit");
        stand
            .payee
            .account(&account_id)
            .expect("payee view")
            .mempool()
            .len()
    };

    // Lifecycle admissions are idempotent across both pending and queued work,
    // so the exact offer survives once whichever order the collision took.
    assert_eq!(queued(true), 1);
    assert_eq!(queued(false), 1);
}

#[test]
fn create_local_genesis_proposes_height_one_and_survives_checkpoint_commit() {
    let timestamp = 1_700_000_000_000;
    let (seed, owner, peer) = genesis_seed("1", "2");
    let mut engine = fresh_engine("1");
    let prepared = engine
        .prepare_wave(fixture::wave_of(
            vec![
                (owner, create_op(0, seed)),
                (
                    owner,
                    WaveOp::Admit {
                        operation_index: 1,
                        account_id: AccountId::from_bytes(peer),
                        txs: vec![AccountTx::AddDelta {
                            token_id: TokenId::new(1).expect("token"),
                        }],
                    },
                ),
            ],
            timestamp,
            true,
        ))
        .expect("create and admit");
    assert_eq!(prepared.admissions.len(), 1);
    assert_eq!(prepared.touched.len(), 1);
    assert_eq!(prepared.post_accounts.len(), 1);
    assert_eq!(engine.account_count(), 1);

    let proposed = engine
        .propose_wave(WaveProposalRequest {
            entities: vec![EntityProposalSelection {
                owner_entity_id: owner,
                account_ids: vec![AccountId::from_bytes(peer)],
            }],
        })
        .expect("propose genesis frame");
    let frame = &proposed.proposals[0]
        .proposed
        .as_ref()
        .expect("height-one frame")
        .frame;
    assert_eq!(frame.height, 1);
    assert_eq!(frame.prev_frame_hash, "genesis");

    let sealed = engine.seal_wave().expect("seal");
    let checkpoint = engine
        .checkpoint_changes_for_wave(sealed.candidate_id)
        .expect("candidate checkpoint");
    assert_eq!(checkpoint.accounts.len(), 1);
    engine
        .commit_wave(sealed.candidate_id)
        .expect("commit wave");
    engine
        .commit_checkpoint(&checkpoint.token)
        .expect("commit checkpoint");
    assert!(engine.account(&AccountId::from_bytes(peer)).is_some());
    assert_eq!(
        engine
            .checkpoint_token()
            .expect("checkpoint token")
            .account_count,
        1
    );
}

#[test]
fn create_inbound_genesis_applies_the_peers_height_one_frame() {
    let timestamp = 1_700_000_000_000;
    let (left_seed, left, right) = genesis_seed("1", "2");
    let mut left_engine = fresh_engine("1");
    left_engine
        .prepare_wave(fixture::wave_of(
            vec![
                (left, create_op(0, left_seed)),
                (
                    left,
                    WaveOp::Admit {
                        operation_index: 1,
                        account_id: AccountId::from_bytes(right),
                        txs: vec![AccountTx::AddDelta {
                            token_id: TokenId::new(1).expect("token"),
                        }],
                    },
                ),
            ],
            timestamp,
            true,
        ))
        .expect("left create");
    let proposed = left_engine
        .propose_wave(WaveProposalRequest {
            entities: vec![EntityProposalSelection {
                owner_entity_id: left,
                account_ids: vec![AccountId::from_bytes(right)],
            }],
        })
        .expect("left proposal");
    let proposal = &proposed.proposals[0];
    let mut incoming = proposal.incoming().expect("incoming frame");
    if let Some(draft) = proposal
        .proposed
        .as_ref()
        .and_then(|proposed| proposed.dispute.as_ref())
    {
        incoming.dispute = Some(xln_rscore_engine::CounterpartyDispute {
            hanko: Some(
                fixture::signing_identity("1")
                    .sign_frame(&draft.hash)
                    .expect("dispute Hanko"),
            ),
            hash: draft.hash,
            proof_body_hash: draft.proof_body_hash,
            nonce: draft.nonce,
            proposer_is_left: draft.proposer_is_left,
        });
    }
    let sealed = left_engine.seal_wave().expect("seal left");
    left_engine
        .commit_wave(sealed.candidate_id)
        .expect("commit left");

    let (right_seed, right_owner, left_peer) = genesis_seed("2", "1");
    assert_eq!(right_owner, right);
    assert_eq!(left_peer, left);
    let mut right_engine = fresh_engine("2");
    let applied = right_engine
        .prepare_wave(fixture::wave_of(
            vec![
                (right, create_op(0, right_seed)),
                (
                    right,
                    WaveOp::Input(Box::new(fixture::input_row(
                        1,
                        AccountId::from_bytes(left),
                        left,
                        right,
                        AccountInputKind::Frame(Box::new(incoming)),
                    ))),
                ),
            ],
            timestamp,
            false,
        ))
        .expect("create and apply inbound genesis");
    assert_eq!(applied.applied.len(), 1);
    assert!(
        matches!(
            applied.applied[0].verdict,
            AccountInputVerdict::FrameCommitted { height: 1, .. }
        ),
        "{:?}",
        applied.applied[0].verdict
    );
    assert_eq!(applied.touched.len(), 1);
    assert_eq!(applied.post_accounts.len(), 1);
}

#[test]
fn create_is_removed_by_abort_and_by_a_failed_prepare() {
    let timestamp = 1_700_000_000_000;
    let (seed, owner, peer) = genesis_seed("1", "2");
    let mut engine = fresh_engine("1");
    let base_root = engine.accounts_root();
    let base_revision = engine.revision();
    let prepared = engine
        .prepare_wave(fixture::wave_of(
            vec![(owner, create_op(0, seed.clone()))],
            timestamp,
            false,
        ))
        .expect("create candidate");
    assert!(engine.account(&AccountId::from_bytes(peer)).is_some());
    assert!(engine.signer_of(&owner).is_some());
    engine
        .abort_wave(prepared.candidate_id)
        .expect("abort create");
    assert_eq!(engine.accounts_root(), base_root);
    assert_eq!(engine.revision(), base_revision);
    assert!(engine.account(&AccountId::from_bytes(peer)).is_none());
    assert!(engine.signer_of(&owner).is_none());

    let missing = AccountId::from_bytes([0xaa; 32]);
    let refused = prepare_error(
        &mut engine,
        fixture::wave_of(
            vec![
                (owner, create_op(0, seed)),
                (
                    owner,
                    WaveOp::Admit {
                        operation_index: 1,
                        account_id: missing,
                        txs: vec![AccountTx::AddDelta {
                            token_id: TokenId::new(1).expect("token"),
                        }],
                    },
                ),
            ],
            timestamp,
            false,
        ),
    );
    assert!(matches!(refused, BatchError::AccountNotFound { .. }));
    assert_eq!(engine.accounts_root(), base_root);
    assert_eq!(engine.revision(), base_revision);
    assert!(!engine.wave_pending());
    assert!(engine.signer_of(&owner).is_none());
}

#[test]
fn create_rejects_duplicate_existing_and_after_use() {
    let timestamp = 1_700_000_000_000;
    let (seed, owner, peer) = genesis_seed("1", "2");
    let mut duplicate_engine = fresh_engine("1");
    let duplicate = prepare_error(
        &mut duplicate_engine,
        fixture::wave_of(
            vec![
                (owner, create_op(0, seed.clone())),
                (owner, create_op(1, seed.clone())),
            ],
            timestamp,
            false,
        ),
    );
    assert!(matches!(duplicate, BatchError::WaveCreateDuplicate(_)));
    assert_eq!(duplicate_engine.account_count(), 0);

    let mut existing_engine = fresh_engine("1");
    existing_engine
        .prepare_wave(fixture::wave_of(
            vec![
                (owner, create_op(0, seed.clone())),
                (
                    owner,
                    WaveOp::Admit {
                        operation_index: 1,
                        account_id: AccountId::from_bytes(peer),
                        txs: vec![AccountTx::AddDelta {
                            token_id: TokenId::new(1).expect("token"),
                        }],
                    },
                ),
            ],
            timestamp,
            false,
        ))
        .expect("create existing base");
    let sealed = existing_engine.seal_wave().expect("seal");
    existing_engine
        .commit_wave(sealed.candidate_id)
        .expect("commit create");
    let existing = prepare_error(
        &mut existing_engine,
        fixture::wave_of(
            vec![(owner, create_op(0, seed.clone()))],
            timestamp + 1,
            false,
        ),
    );
    assert!(matches!(existing, BatchError::WaveCreateExisting(_)));

    let mut after_use_engine = fresh_engine("1");
    let missing = after_use_engine
        .prepare_wave(fixture::wave_of(
            vec![(
                owner,
                WaveOp::Input(Box::new(fixture::input_row(
                    0,
                    AccountId::from_bytes(peer),
                    peer,
                    owner,
                    AccountInputKind::Ack(xln_rscore_engine::IncomingAck {
                        height: 1,
                        frame_hash: [0; 32],
                        frame_hanko: Some(Vec::new()),
                        dispute: None,
                    }),
                ))),
            )],
            timestamp,
            false,
        ))
        .expect("missing input is a typed verdict");
    assert!(matches!(
        missing.applied[0].verdict,
        AccountInputVerdict::Failed(_)
    ));
    let after_use = after_use_engine.apply_wave_ops(WaveOpsRequest {
        entities: vec![EntityWaveOps {
            owner_entity_id: owner,
            ops: vec![create_op(1, seed)],
        }],
    });
    assert!(matches!(after_use, Err(BatchError::WaveCreateAfterUse(_))));
    assert_eq!(after_use_engine.account_count(), 0);
    after_use_engine
        .abort_wave(missing.candidate_id)
        .expect("abort missing-input candidate");
}

#[test]
fn create_rejects_wrong_owner_counterparty_and_non_genesis_material() {
    let timestamp = 1_700_000_000_000;
    let (seed, owner, peer) = genesis_seed("1", "2");

    let mut wrong_owner_engine = fresh_engine("1");
    let wrong_owner = prepare_error(
        &mut wrong_owner_engine,
        fixture::wave_of(vec![(peer, create_op(0, seed.clone()))], timestamp, false),
    );
    assert!(matches!(wrong_owner, BatchError::WaveAccountOwner { .. }));

    let mut wrong_id_seed = seed.clone();
    wrong_id_seed.account_id = AccountId::from_bytes([0xab; 32]);
    let mut wrong_id_engine = fresh_engine("1");
    let wrong_id = prepare_error(
        &mut wrong_id_engine,
        fixture::wave_of(vec![(owner, create_op(0, wrong_id_seed))], timestamp, false),
    );
    assert!(matches!(
        wrong_id,
        BatchError::WaveCreateCounterparty { .. }
    ));

    let mut consensus_seed = seed.clone();
    consensus_seed.consensus =
        Some(AccountConsensus::new(consensus_seed.replica.clone()).consensus_snapshot());
    let mut consensus_engine = fresh_engine("1");
    let consensus = prepare_error(
        &mut consensus_engine,
        fixture::wave_of(
            vec![(owner, create_op(0, consensus_seed))],
            timestamp,
            false,
        ),
    );
    assert!(matches!(consensus, BatchError::WaveCreateConsensus(_)));

    let mut mempool_seed = seed.clone();
    let genesis_fields = mempool_seed.replica.envelope().fields().to_vec();
    mempool_seed.replica.set_envelope(
        AccountEnvelope::new(
            genesis_fields,
            vec![CanonicalValue::String("queued-at-genesis".into())],
        )
        .expect("envelope"),
    );
    let mut mempool_engine = fresh_engine("1");
    let mempool = prepare_error(
        &mut mempool_engine,
        fixture::wave_of(vec![(owner, create_op(0, mempool_seed))], timestamp, false),
    );
    assert!(matches!(mempool, BatchError::WaveCreateMempool { .. }));

    let mut transformer_seed = seed.clone();
    transformer_seed.replica = AccountReplica::new(
        transformer_seed.replica.owner().clone(),
        transformer_seed.replica.state().clone(),
    )
    .expect("replica without transformer");
    let mut transformer_engine = fresh_engine("1");
    let transformer = prepare_error(
        &mut transformer_engine,
        fixture::wave_of(
            vec![(owner, create_op(0, transformer_seed))],
            timestamp,
            false,
        ),
    );
    assert!(matches!(transformer, BatchError::WaveCreateTransformer(_)));

    let (_, owner_entity) = fixture::entity_of("1");
    let (_, peer_entity) = fixture::entity_of("2");
    let (left, right) = if owner_entity < peer_entity {
        (owner_entity.clone(), peer_entity.clone())
    } else {
        (peer_entity.clone(), owner_entity.clone())
    };
    let mut non_genesis_replica =
        AccountReplica::new(owner_entity, fixture::account_state(&left, &right))
            .expect("funded replica");
    non_genesis_replica.set_delta_transformer([0x77; 20]);
    let non_genesis_seed = AccountSeed {
        account_id: AccountId::from_bytes(peer),
        replica: non_genesis_replica,
        consensus: None,
    };
    let mut non_genesis_engine = fresh_engine("1");
    let non_genesis = prepare_error(
        &mut non_genesis_engine,
        fixture::wave_of(
            vec![(owner, create_op(0, non_genesis_seed))],
            timestamp,
            false,
        ),
    );
    assert!(matches!(
        non_genesis,
        BatchError::WaveCreateNonGenesis { .. }
    ));
}

#[test]
fn create_requires_the_exact_canonical_h0_entity_envelope() {
    let timestamp = 1_700_000_000_000;
    let (seed, owner, _) = genesis_seed("1", "2");
    let mut variants: Vec<(&str, AccountSeed)> = Vec::new();

    let mut inactive = seed.clone();
    replace_genesis_envelope_field(
        &mut inactive,
        "status",
        CanonicalValue::String("inactive".to_string()),
    );
    variants.push(("inactive status", inactive));

    let mut wrong_height = seed.clone();
    replace_genesis_envelope_field(
        &mut wrong_height,
        "currentHeight",
        CanonicalValue::Number(1.0),
    );
    variants.push(("nonzero height", wrong_height));

    let mut wrong_proof = seed.clone();
    let proof = CanonicalValue::Object(vec![
        (
            "fromEntity".to_string(),
            CanonicalValue::String(wrong_proof.replica.owner().to_string()),
        ),
        (
            "toEntity".to_string(),
            CanonicalValue::String(wrong_proof.replica.counterparty().to_string()),
        ),
        ("nextProofNonce".to_string(), CanonicalValue::Number(0.0)),
    ]);
    replace_genesis_envelope_field(&mut wrong_proof, "proofHeader", proof);
    variants.push(("nonce zero", wrong_proof));

    let mut nonempty_withdrawals = seed.clone();
    replace_genesis_envelope_field(
        &mut nonempty_withdrawals,
        "pendingWithdrawals",
        CanonicalValue::String(format!("0x{}", "01".repeat(32))),
    );
    variants.push(("nonempty withdrawals", nonempty_withdrawals));

    let mut nonempty_shadow = seed.clone();
    replace_genesis_envelope_field(
        &mut nonempty_shadow,
        "shadow",
        CanonicalValue::Object(vec![(
            "rebalance".to_string(),
            CanonicalValue::Object(vec![
                (
                    "policyRoot".to_string(),
                    CanonicalValue::String(format!("0x{}", "00".repeat(32))),
                ),
                (
                    "submittedAtByTokenRoot".to_string(),
                    CanonicalValue::String(format!("0x{}", "02".repeat(32))),
                ),
            ]),
        )]),
    );
    variants.push(("nonempty submitted-at shadow", nonempty_shadow));

    let mut malformed_policy_root = seed.clone();
    replace_genesis_envelope_field(
        &mut malformed_policy_root,
        "shadow",
        CanonicalValue::Object(vec![(
            "rebalance".to_string(),
            CanonicalValue::Object(vec![
                (
                    "policyRoot".to_string(),
                    CanonicalValue::String(format!("0x{}", "AB".repeat(32))),
                ),
                (
                    "submittedAtByTokenRoot".to_string(),
                    CanonicalValue::String(format!("0x{}", "00".repeat(32))),
                ),
            ]),
        )]),
    );
    variants.push(("noncanonical policy root", malformed_policy_root));

    let mut false_pin = seed.clone();
    let mut false_pin_fields = false_pin.replica.envelope().fields().to_vec();
    false_pin_fields.push(("publicPinned".to_string(), CanonicalValue::Bool(false)));
    false_pin
        .replica
        .set_envelope(AccountEnvelope::new(false_pin_fields, Vec::new()).expect("false pin"));
    variants.push(("false pin must be omitted", false_pin));

    let mut extra = seed.clone();
    let mut extra_fields = extra.replica.envelope().fields().to_vec();
    extra_fields.push(("activeDispute".to_string(), CanonicalValue::Null));
    extra
        .replica
        .set_envelope(AccountEnvelope::new(extra_fields, Vec::new()).expect("extra field"));
    variants.push(("extra carried field", extra));

    let mut duplicate = seed;
    let mut duplicate_fields = duplicate.replica.envelope().fields().to_vec();
    duplicate_fields.push((
        "status".to_string(),
        CanonicalValue::String("active".to_string()),
    ));
    duplicate.replica.set_envelope(
        AccountEnvelope::new(duplicate_fields, Vec::new()).expect("duplicate field envelope"),
    );
    variants.push(("duplicate field", duplicate));

    for (label, variant) in variants {
        let mut engine = fresh_engine("1");
        let error = prepare_error(
            &mut engine,
            fixture::wave_of(vec![(owner, create_op(0, variant))], timestamp, false),
        );
        assert!(
            matches!(error, BatchError::WaveCreateEnvelope { .. }),
            "{label}: {error:?}"
        );
        assert_eq!(engine.account_count(), 0, "{label}");
    }
}

#[test]
fn create_is_rebuilt_from_canonical_fields_and_must_be_used_before_seal() {
    let timestamp = 1_700_000_000_000;
    let (mut seed, owner, peer) = genesis_seed("1", "2");
    let policy_root = format!("0x{}", "03".repeat(32));
    let pinned_envelope = canonical_genesis_envelope_with_policy(&seed.replica, true, &policy_root);
    seed.replica.set_envelope(pinned_envelope);
    let expected_genesis_leaf = seed
        .replica
        .entity_account_leaf()
        .expect("TS H=0 leaf shape");
    let mut engine = fresh_engine("1");
    let prepared = engine
        .prepare_wave(fixture::wave_of(
            vec![(owner, create_op(0, seed))],
            timestamp,
            false,
        ))
        .expect("staged create");
    assert_eq!(
        engine
            .account(&AccountId::from_bytes(peer))
            .expect("created account")
            .entity_account_leaf()
            .expect("Rust H=0 leaf"),
        expected_genesis_leaf,
        "sanitized reconstruction preserves the canonical Entity leaf"
    );
    let unused = match engine.seal_wave() {
        Ok(_) => panic!("bare Create cannot seal"),
        Err(error) => error,
    };
    assert!(matches!(unused, BatchError::WaveCreateUnused(_)));

    let empty = engine
        .apply_wave_ops(WaveOpsRequest {
            entities: vec![EntityWaveOps {
                owner_entity_id: owner,
                ops: vec![WaveOp::Admit {
                    operation_index: 1,
                    account_id: AccountId::from_bytes(peer),
                    txs: Vec::new(),
                }],
            }],
        })
        .expect("empty admission is a typed no-op");
    assert!(matches!(
        empty.admissions[0].verdict,
        AccountAdmissionVerdict::Admitted { count: 0 }
    ));
    assert!(matches!(
        engine.seal_wave(),
        Err(BatchError::WaveCreateUnused(_))
    ));

    let rejected = engine
        .apply_wave_ops(WaveOpsRequest {
            entities: vec![EntityWaveOps {
                owner_entity_id: owner,
                ops: vec![WaveOp::Admit {
                    operation_index: 2,
                    account_id: AccountId::from_bytes(peer),
                    txs: vec![AccountTx::ReserveToCollateral {
                        token_id: TokenId::new(1).expect("token"),
                        collateral: "10".to_string(),
                        ondelta: "0".to_string(),
                        side: ReserveSide::Receiving,
                        block_number: 1,
                        transaction_hash: format!("0x{}", "ee".repeat(32)),
                    }],
                }],
            }],
        })
        .expect("unsupported frame tx is a typed rejection");
    assert!(matches!(
        rejected.admissions[0].verdict,
        AccountAdmissionVerdict::Rejected { .. }
    ));
    assert!(matches!(
        engine.seal_wave(),
        Err(BatchError::WaveCreateUnused(_))
    ));

    let applied = engine
        .apply_wave_ops(WaveOpsRequest {
            entities: vec![EntityWaveOps {
                owner_entity_id: owner,
                ops: vec![WaveOp::Admit {
                    operation_index: 3,
                    account_id: AccountId::from_bytes(peer),
                    txs: vec![AccountTx::AddDelta {
                        token_id: TokenId::new(1).expect("token"),
                    }],
                }],
            }],
        })
        .expect("first real account operation");
    assert_eq!(applied.admissions.len(), 1);
    let raw_fields = engine
        .account(&AccountId::from_bytes(peer))
        .expect("created account")
        .replica()
        .envelope()
        .fields();
    assert_eq!(
        raw_fields
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        vec!["status", "publicPinned", "pendingWithdrawals", "shadow"],
        "derived H=0 fields are rebuilt by AccountConsensus, never carried"
    );
    let sealed = engine.seal_wave().expect("used Create can seal");
    engine.commit_wave(sealed.candidate_id).expect("commit");
    assert_ne!(sealed.revision, prepared.revision);
}

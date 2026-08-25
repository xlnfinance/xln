//! One runtime frame as one call: admit, apply, propose — against a candidate
//! the runtime can still abort if its own record does not become durable.

mod fixture;

use fixture::{Stand, clock, payment, stand};
use xln_rscore_batch::{
    AccountAdmissionVerdict, AccountInputKind, AccountInputRow, AccountInputVerdict, BatchError,
    EntityProposalSelection, EntityWave, EntityWaveOps, StatefulConsensusEngine, WaveOp,
    WaveOpsRequest, WaveProposalRequest, WaveRequest, WaveResult,
};

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

    let root = stand.payer.commit_wave(result.revision).expect("commit");
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

    let revision = stand.payer.abort_wave(result.revision).expect("abort");
    assert_eq!(revision, before_revision);
    assert_eq!(stand.payer.accounts_root(), before_root);
    assert!(!stand.payer.wave_pending());

    // And the same wave can be run again, reaching the same candidate.
    let request = wave(&stand, 1_700_000_000_000);
    let again = stand.payer.prepare_wave(request).expect("wave again");
    assert_eq!(again.accounts_root, result.accounts_root);
    assert_eq!(again.revision, result.revision);
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
        stand.payer.admit_txs(vec![payment(&stand.pairs[0], 5)]),
        Err(BatchError::WavePending),
    ));
    assert!(matches!(
        stand.payer.propose_frames(1_700_000_000_002, 100, None),
        Err(BatchError::WavePending),
    ));
    assert!(matches!(
        stand.payer.checkpoint_changes(),
        Err(BatchError::WavePending),
    ));
    assert!(matches!(
        stand.payer.checkpoint_changes_for_wave(result.revision - 1),
        Err(BatchError::WaveOpen),
    ));
    assert!(matches!(
        stand.payer.checkpoint_changes_for_wave(result.revision),
        Err(BatchError::WaveOpen),
    ));
    let sealed = stand.payer.seal_wave().expect("seal");
    let candidate_checkpoint = stand
        .payer
        .checkpoint_changes_for_wave(sealed.revision)
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
    // Only the revision that was prepared may be committed.
    assert!(matches!(
        stand.payer.commit_wave(sealed.revision - 1),
        Err(BatchError::WaveRevision { .. }),
    ));
    stand.payer.commit_wave(sealed.revision).expect("commit");
    stand
        .payer
        .commit_checkpoint(&candidate_checkpoint.token)
        .expect("checkpoint after runtime WAL");
    assert_eq!(
        stand.payer.checkpoint_token().expect("durable token"),
        candidate_checkpoint.restore_token(),
    );
    assert!(matches!(
        stand.payer.commit_wave(sealed.revision),
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
        .commit_wave(proposed.revision)
        .expect("commit propose");

    let frames = fixture::frame_ops(&stand, &proposed.proposals);
    let request = fixture::wave_of(frames, timestamp, false);
    let applied: WaveResult = run_staged_wave(&mut stand.payee, request);
    stand
        .payee
        .commit_wave(applied.revision)
        .expect("commit apply");
    assert_eq!(applied.applied.len(), 2);
    for row in &applied.applied {
        assert!(
            matches!(row.verdict, AccountInputVerdict::FrameCommitted { .. }),
            "{:?}",
            row.verdict,
        );
    }

    let acks = fixture::ack_ops(&stand, &applied.applied);
    let request = fixture::wave_of(acks, timestamp, false);
    let acked = run_staged_wave(&mut stand.payer, request);
    stand.payer.commit_wave(acked.revision).expect("commit ack");
    for row in &acked.applied {
        assert!(
            matches!(row.verdict, AccountInputVerdict::AckCommitted { .. }),
            "{:?}",
            row.verdict,
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
        assert!(
            post_account.put_count() > 0,
            "full account rows, not a diff"
        );
        assert_eq!(post_account.del_count(), 0, "full rows delete nothing");
        assert!(
            post_account.consensus.pending.is_some(),
            "the materialization carries the post-proposal envelope"
        );
    }

    // Aborting and re-running the same wave reaches the same tree.
    stand.payer.abort_wave(first.revision).expect("abort");
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
    let row = |operation_index: u64| AccountInputRow {
        operation_index,
        account_id: pair.payer_account,
        from_entity_id: pair.payee_entity,
        kind: AccountInputKind::Ack {
            height: 1,
            state_hash: [0; 32],
            hanko: Vec::new(),
            dispute: None,
        },
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
        .commit_wave(sealed.revision)
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
        .abort_wave(pending_duplicate.revision)
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
    stand.payer.commit_wave(proposed.revision).expect("commit");

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
    stand.payer.commit_wave(proposed.revision).expect("commit");

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
        stand.payer.commit_wave(proposed.revision).expect("commit");
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
            }
        }
        let request = fixture::wave_of(ops, timestamp, false);
        let applied = run_staged_wave(&mut stand.payee, request);
        stand.payee.commit_wave(applied.revision).expect("commit");
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

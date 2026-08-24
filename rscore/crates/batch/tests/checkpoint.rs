//! The canonical database checkpoint, from both ends: what the engine emits
//! after work, and what an engine restored from those rows holds.
//!
//! The `Database` here is a stand-in for the runtime's canonical store: it
//! applies whatever a checkpoint says and can hand every account back. If a
//! restored engine reaches a different accounts root, the checkpoint is not a
//! checkpoint, and these tests fail rather than the next crash discovering it.

mod fixture;

use std::collections::BTreeMap;

use fixture::{clock, engine, payment, round, stand};
use xln_rscore_batch::{
    AccountCheckpointRows, AccountId, AccountInputKind, AccountInputRow, AccountInputVerdict,
    AccountRestore, AccountsCheckpoint, BatchError, CheckpointExpectation,
};
use xln_rscore_engine::{
    AccountReplica, AccountState, AccountStateSeed, AckOutcome, ConsensusSnapshot, Delta,
    IncomingFrame, IncomingOutcome,
};
use xln_rscore_protocol::{PersistentNodeChanges, PersistentNodeRecord, PersistentNodeRef};

// ---------------------------------------------------------------- the store

/// One section of one account, as leaf rows keyed the way the tree keys them.
struct Section<V> {
    leaves: BTreeMap<Vec<u8>, V>,
    branches: BTreeMap<Vec<u8>, usize>,
}

impl<V> Default for Section<V> {
    fn default() -> Self {
        Self {
            leaves: BTreeMap::new(),
            branches: BTreeMap::new(),
        }
    }
}

impl<V: Clone> Section<V> {
    fn apply(&mut self, changes: &PersistentNodeChanges<V>) {
        for record in &changes.puts {
            match record {
                PersistentNodeRecord::Leaf { key, value, .. } => {
                    self.leaves.insert(key.clone(), value.clone());
                }
                PersistentNodeRecord::Branch { path, children } => {
                    self.branches.insert(path.clone(), children.len());
                }
            }
        }
        for record in &changes.dels {
            match record {
                PersistentNodeRef::Leaf { key, .. } => {
                    self.leaves.remove(key);
                }
                PersistentNodeRef::Branch { path } => {
                    self.branches.remove(path);
                }
            }
        }
    }

    fn values(&self) -> Vec<V> {
        self.leaves.values().cloned().collect()
    }
}

#[derive(Default)]
struct AccountRow {
    header: Option<xln_rscore_batch::AccountCheckpointHeader>,
    consensus: Option<ConsensusSnapshot>,
    account_leaf: [u8; 32],
    deltas: Section<Delta>,
    locks: Section<xln_rscore_engine::HtlcLock>,
    lending: Section<xln_rscore_engine::LendingIntentKind>,
    offers: Section<xln_rscore_engine::SwapOffer>,
    policies: Section<xln_rscore_engine::BilateralRebalanceFeePolicy>,
}

/// The runtime's canonical store, reduced to what a checkpoint touches.
#[derive(Default)]
struct Database {
    accounts: BTreeMap<AccountId, AccountRow>,
    /// The revision the last durable write covered — what the runtime would
    /// pass back to `commit_checkpoint`.
    written_revision: u64,
    /// The tree root that revision produced. A real store keeps it for the
    /// same reason this one does: without it a partial load looks valid.
    accounts_root: [u8; 32],
}

impl Database {
    fn write(&mut self, checkpoint: &AccountsCheckpoint) {
        for rows in &checkpoint.accounts {
            let row = self.accounts.entry(rows.account_id).or_default();
            row.header = Some(rows.header.clone());
            row.consensus = Some(rows.consensus.clone());
            row.account_leaf = rows.account_leaf;
            row.deltas.apply(&rows.deltas);
            row.locks.apply(&rows.locks);
            row.lending.apply(&rows.lending_intents);
            row.offers.apply(&rows.swap_offers);
            row.policies.apply(&rows.rebalance_fee_policies);
        }
        for account_id in &checkpoint.removed {
            self.accounts.remove(account_id);
        }
        self.written_revision = checkpoint.revision;
        self.accounts_root = checkpoint.accounts_root;
    }

    fn expectation(&self) -> CheckpointExpectation {
        CheckpointExpectation {
            revision: self.written_revision,
            accounts_root: self.accounts_root,
            account_count: self.accounts.len(),
        }
    }

    fn restore_rows(&self) -> Vec<AccountRestore> {
        self.accounts
            .iter()
            .map(|(account_id, row)| {
                let header = row.header.as_ref().expect("header");
                let state = AccountState::restore_full(AccountStateSeed {
                    identity: header.identity.clone(),
                    dispute_config: header.dispute_config,
                    deltas: row.deltas.values(),
                    locks: row.locks.values(),
                    j_nonce: header.j_nonce,
                    last_finalized_j_height: header.last_finalized_j_height,
                    carried: header.carried.clone(),
                    rebalance_fee_policies: Vec::new(),
                    swap_offers: row.offers.values(),
                    lending_intents: Vec::new(),
                })
                .expect("state");
                let mut replica =
                    AccountReplica::new(header.owner.clone(), state).expect("replica");
                replica.set_envelope(header.envelope.clone());
                AccountRestore {
                    account_id: *account_id,
                    replica,
                    consensus: row.consensus.as_ref().expect("consensus").clone(),
                    signer_id: header.signer_id.clone(),
                    account_leaf: row.account_leaf,
                }
            })
            .collect()
    }
}

fn rows_for<'a>(
    checkpoint: &'a AccountsCheckpoint,
    account_id: &AccountId,
) -> Option<&'a AccountCheckpointRows> {
    checkpoint
        .accounts
        .iter()
        .find(|rows| rows.account_id == *account_id)
}

// ------------------------------------------------------------------ tests

/// A database that has never seen this engine gets every account whole.
#[test]
fn the_first_checkpoint_carries_every_account() {
    let stand = stand(4);
    let checkpoint = stand.payer.checkpoint_changes().expect("checkpoint");
    assert_eq!(checkpoint.base_revision, 0);
    assert_eq!(checkpoint.revision, stand.payer.revision());
    assert_eq!(checkpoint.accounts.len(), 4);
    assert!(checkpoint.removed.is_empty());
    assert_eq!(checkpoint.accounts_root, stand.payer.accounts_root());
    for rows in &checkpoint.accounts {
        assert!(
            rows.deltas
                .puts
                .iter()
                .any(|record| matches!(record, PersistentNodeRecord::Leaf { .. })),
            "a seeded account carries its delta leaf",
        );
        assert!(rows.deltas.dels.is_empty());
        assert!(rows.locks.puts.is_empty(), "no locks on a fresh account");
        assert_eq!(rows.consensus.mempool.len(), 0);
        assert!(rows.consensus.current.is_none());
        assert!(rows.consensus.pending.is_none());
    }
}

/// Once committed, an idle engine has nothing more to say.
#[test]
fn a_committed_checkpoint_leaves_nothing_behind() {
    let mut stand = stand(3);
    let checkpoint = stand.payer.checkpoint_changes().expect("checkpoint");
    stand
        .payer
        .commit_checkpoint(checkpoint.revision)
        .expect("commit");
    let next = stand.payer.checkpoint_changes().expect("checkpoint");
    assert!(next.is_empty(), "{next:?}");
    assert_eq!(next.base_revision, checkpoint.revision);
    assert_eq!(next.revision, checkpoint.revision);
}

/// Only the accounts that moved are in the next checkpoint, and only the
/// sections that moved inside them.
#[test]
fn only_what_moved_is_shipped() {
    let mut stand = stand(3);
    let first = stand.payer.checkpoint_changes().expect("checkpoint");
    stand
        .payer
        .commit_checkpoint(first.revision)
        .expect("commit");

    let moved = stand.pairs[1].payer_account;
    stand
        .payer
        .admit_txs(vec![payment(&stand.pairs[1], 25)])
        .expect("admit");
    let proposals = stand
        .payer
        .propose_frames(1_700_000_000_000, 100, None)
        .expect("propose");
    assert_eq!(proposals.len(), 1);

    let checkpoint = stand.payer.checkpoint_changes().expect("checkpoint");
    assert_eq!(checkpoint.accounts.len(), 1);
    let rows = rows_for(&checkpoint, &moved).expect("moved account");
    // The proposal is in flight: the committed state has not moved, so no
    // delta row moved either — but the frame itself must be durable.
    assert!(
        rows.deltas.puts.is_empty(),
        "committed deltas are unchanged"
    );
    let pending = rows.consensus.pending.as_ref().expect("pending frame");
    assert_eq!(pending.frame.height, 1);
    assert_eq!(pending.frame.txs.len(), 1);
    assert!(rows.consensus.current.is_none());
}

/// A payment that both sides commit moves the delta leaf, and only it.
#[test]
fn a_committed_payment_moves_one_delta_leaf() {
    let mut stand = stand(2);
    let first = stand.payer.checkpoint_changes().expect("checkpoint");
    stand
        .payer
        .commit_checkpoint(first.revision)
        .expect("commit");
    round(&mut stand, 1_700_000_000_000, 25);

    let checkpoint = stand.payer.checkpoint_changes().expect("checkpoint");
    assert_eq!(checkpoint.accounts.len(), 2);
    for rows in &checkpoint.accounts {
        let leaves = rows
            .deltas
            .puts
            .iter()
            .filter(|record| matches!(record, PersistentNodeRecord::Leaf { .. }))
            .count();
        assert_eq!(leaves, 1, "one token moved");
        assert!(rows.locks.puts.is_empty());
        assert!(rows.swap_offers.puts.is_empty());
        assert_eq!(rows.consensus.current.as_ref().expect("current").height, 1);
        assert!(rows.consensus.pending.is_none());
        assert!(rows.consensus.mempool.is_empty());
    }
}

/// The whole point: an engine rebuilt from the database is the same engine.
#[test]
fn an_engine_restored_from_the_database_reproduces_the_accounts_root() {
    let mut stand = stand(4);
    let mut database = Database::default();
    for round_index in 0..3 {
        round(&mut stand, 1_700_000_000_000 + round_index, 25);
        let checkpoint = stand.payer.checkpoint_changes().expect("checkpoint");
        database.write(&checkpoint);
        stand
            .payer
            .commit_checkpoint(checkpoint.revision)
            .expect("commit");
    }

    let live_root = stand.payer.accounts_root();
    let mut restored = engine();
    let root = restored
        .restore_accounts(database.restore_rows(), &database.expectation())
        .expect("restore");
    assert_eq!(root, live_root);
    assert_eq!(restored.account_count(), stand.payer.account_count());
    for pair in &stand.pairs {
        let live = stand.payer.account(&pair.payer_account).expect("live");
        let back = restored.account(&pair.payer_account).expect("restored");
        assert_eq!(back.current_height(), live.current_height());
        assert_eq!(
            back.entity_account_leaf().expect("restored leaf"),
            live.entity_account_leaf().expect("live leaf"),
        );
    }
    // A restored engine is its own checkpoint base: nothing is owed to the
    // database until it does new work.
    let after = restored.checkpoint_changes().expect("checkpoint");
    assert!(after.is_empty(), "{after:?}");
}

/// A crash between writing a checkpoint and acknowledging it costs a replay,
/// not a hole: the next checkpoint still carries everything since the last
/// acknowledged one.
#[test]
fn an_unacknowledged_checkpoint_is_carried_into_the_next_one() {
    let mut stand = stand(2);
    let first = stand.payer.checkpoint_changes().expect("checkpoint");
    stand
        .payer
        .commit_checkpoint(first.revision)
        .expect("commit");
    let mut written = Database::default();
    written.write(&first);

    round(&mut stand, 1_700_000_000_000, 25);
    // Read, and then lose the write: no commit_checkpoint follows.
    let lost = stand.payer.checkpoint_changes().expect("checkpoint");
    assert!(!lost.is_empty());

    round(&mut stand, 1_700_000_000_001, 30);
    let recovered = stand.payer.checkpoint_changes().expect("checkpoint");
    assert_eq!(recovered.base_revision, first.revision);
    assert!(recovered.revision > lost.revision);

    written.write(&recovered);
    let mut restored = engine();
    let root = restored
        .restore_accounts(written.restore_rows(), &written.expectation())
        .expect("restore");
    assert_eq!(root, stand.payer.accounts_root());
}

/// Only the revision that was read may be acknowledged.
#[test]
fn commit_checkpoint_refuses_any_other_revision() {
    let mut stand = stand(2);
    let checkpoint = stand.payer.checkpoint_changes().expect("checkpoint");
    assert!(matches!(
        stand.payer.commit_checkpoint(checkpoint.revision - 1),
        Err(BatchError::CheckpointRevision { .. }),
    ));
    assert!(matches!(
        stand.payer.commit_checkpoint(checkpoint.revision + 1),
        Err(BatchError::CheckpointRevision { .. }),
    ));
    // The engine moves on, and the stale read may no longer be acknowledged.
    round(&mut stand, 1_700_000_000_000, 25);
    assert!(matches!(
        stand.payer.commit_checkpoint(checkpoint.revision),
        Err(BatchError::CheckpointRevision { .. }),
    ));
    let fresh = stand.payer.checkpoint_changes().expect("checkpoint");
    stand
        .payer
        .commit_checkpoint(fresh.revision)
        .expect("commit");
}

/// A frame in flight survives the restart: the restored engine holds the same
/// pending frame, and the peer's ack still commits it.
#[test]
fn a_pending_frame_survives_a_restore_and_still_commits() {
    let mut stand = stand(1);
    let pair_payer_account = stand.pairs[0].payer_account;
    stand
        .payer
        .admit_txs(vec![payment(&stand.pairs[0], 25)])
        .expect("admit");
    let proposals = stand
        .payer
        .propose_frames(1_700_000_000_000, 100, None)
        .expect("propose");
    let proposal = &proposals[0];
    let frame = IncomingFrame {
        height: proposal.frame.height,
        timestamp: proposal.frame.timestamp,
        j_height: proposal.frame.j_height,
        txs: proposal.frame.txs.clone(),
        prev_frame_hash: proposal.frame.prev_frame_hash.clone(),
        account_state_root: proposal.frame.account_state_root,
        by_left: proposal.frame.by_left,
        state_hash: proposal.state_hash,
        hanko: proposal.hanko.clone(),
    };

    let mut database = Database::default();
    let checkpoint = stand.payer.checkpoint_changes().expect("checkpoint");
    database.write(&checkpoint);
    stand
        .payer
        .commit_checkpoint(checkpoint.revision)
        .expect("commit");

    // The payer process dies here. Everything below runs on the rebuilt one.
    let mut restored = engine();
    restored
        .register_signer(stand.pairs[0].payer_entity, "payer-0")
        .expect("signer");
    let root = restored
        .restore_accounts(database.restore_rows(), &database.expectation())
        .expect("restore");
    assert_eq!(root, stand.payer.accounts_root());
    let pending = restored
        .account(&pair_payer_account)
        .expect("account")
        .pending()
        .expect("pending frame");
    assert_eq!(pending.state_hash, proposal.state_hash);

    // The peer never saw the crash: it commits the frame and acks it.
    let applied = stand
        .payee
        .apply_inputs(
            clock(1_700_000_000_000),
            vec![AccountInputRow {
                input_index: 0,
                account_id: stand.pairs[0].payee_account,
                from_entity_id: stand.pairs[0].payer_entity,
                kind: AccountInputKind::Frame(Box::new(frame)),
            }],
        )
        .expect("apply frame");
    let AccountInputVerdict::Frame(IncomingOutcome::Committed {
        height,
        state_hash,
        ack_hanko,
        ..
    }) = &applied[0].verdict
    else {
        panic!("expected a commit: {:?}", applied[0].verdict);
    };

    let acked = restored
        .apply_inputs(
            clock(1_700_000_000_000),
            vec![AccountInputRow {
                input_index: 0,
                account_id: pair_payer_account,
                from_entity_id: stand.pairs[0].payee_entity,
                kind: AccountInputKind::Ack {
                    height: *height,
                    state_hash: *state_hash,
                    hanko: ack_hanko.clone(),
                },
            }],
        )
        .expect("apply ack");
    let AccountInputVerdict::Ack(AckOutcome::Committed {
        height, outputs, ..
    }) = &acked[0].verdict
    else {
        panic!("expected an ack commit: {:?}", acked[0].verdict);
    };
    assert_eq!(*height, 1);
    // A one-hop payment has nothing to forward, so this frame's effect list is
    // empty — the point here is that the ack is what carries it, rebuilt by
    // the restore's own replay. `outputs_are_held_until_the_peer_acks` in the
    // engine tests covers a frame that does produce one.
    assert!(outputs.is_empty());
    assert_eq!(
        restored.accounts_root(),
        {
            // The engine that never crashed, driven the same way.
            let acked_live = stand
                .payer
                .apply_inputs(
                    clock(1_700_000_000_000),
                    vec![AccountInputRow {
                        input_index: 0,
                        account_id: pair_payer_account,
                        from_entity_id: stand.pairs[0].payee_entity,
                        kind: AccountInputKind::Ack {
                            height: *height,
                            state_hash: *state_hash,
                            hanko: ack_hanko.clone(),
                        },
                    }],
                )
                .expect("apply ack");
            assert!(matches!(
                acked_live[0].verdict,
                AccountInputVerdict::Ack(AckOutcome::Committed { .. })
            ));
            stand.payer.accounts_root()
        },
        "a restored engine and a live one agree after the same ack",
    );
}

/// A database that lost a delta row cannot be restored at all: the account
/// rebuilds into a different leaf than the checkpoint recorded, and the
/// restore says so instead of coming up on a state nobody signed.
#[test]
fn a_truncated_database_is_refused() {
    let mut stand = stand(2);
    let mut database = Database::default();
    round(&mut stand, 1_700_000_000_000, 25);
    let checkpoint = stand.payer.checkpoint_changes().expect("checkpoint");
    database.write(&checkpoint);
    let victim = stand.pairs[0].payer_account;
    database
        .accounts
        .get_mut(&victim)
        .expect("row")
        .deltas
        .leaves
        .clear();

    let mut restored = engine();
    let error = restored
        .restore_accounts(database.restore_rows(), &database.expectation())
        .expect_err("a truncated row is not an account");
    assert!(
        matches!(error, BatchError::CheckpointAccountLeaf { .. }),
        "{error:?}",
    );
}

/// A load that is missing whole accounts is refused too: any subset of rows
/// rebuilds into a perfectly valid tree, so only the recorded count and root
/// can tell a complete load from a partial one.
#[test]
fn a_partial_load_is_refused() {
    let mut stand = stand(3);
    let mut database = Database::default();
    round(&mut stand, 1_700_000_000_000, 25);
    let checkpoint = stand.payer.checkpoint_changes().expect("checkpoint");
    database.write(&checkpoint);

    let expectation = database.expectation();
    let mut rows = database.restore_rows();
    rows.pop();
    let mut restored = engine();
    let error = restored
        .restore_accounts(rows, &expectation)
        .expect_err("a short load is not a checkpoint");
    assert!(
        matches!(error, BatchError::CheckpointIncomplete { .. }),
        "{error:?}",
    );

    // And a load that is complete but claims the wrong root is refused on the
    // root, not silently accepted.
    let mut wrong_root = database.expectation();
    wrong_root.accounts_root[0] ^= 0x01;
    let error = restored
        .restore_accounts(database.restore_rows(), &wrong_root)
        .expect_err("a root that does not match is not a checkpoint");
    assert!(
        matches!(error, BatchError::CheckpointRoot { .. }),
        "{error:?}"
    );
}

/// A restore replaces the store; accounts the database no longer holds do not
/// survive in memory.
#[test]
fn a_restore_replaces_whatever_the_engine_held() {
    // The database holds one account, taken from an engine that only ever had
    // that one.
    let mut source = stand(1);
    let mut database = Database::default();
    round(&mut source, 1_700_000_000_000, 25);
    let checkpoint = source.payer.checkpoint_changes().expect("checkpoint");
    database.write(&checkpoint);

    // The engine loading it holds three, two of which the database has never
    // heard of.
    let mut live = stand(3);
    round(&mut live, 1_700_000_000_000, 25);
    assert_eq!(live.payer.account_count(), 3);
    let root = live
        .payer
        .restore_accounts(database.restore_rows(), &database.expectation())
        .expect("restore");
    assert_eq!(root, source.payer.accounts_root());
    assert_eq!(live.payer.account_count(), 1);
    for pair in &live.pairs[1..] {
        assert!(
            live.payer.account(&pair.payer_account).is_none(),
            "an account the database does not hold must not survive",
        );
    }
}

/// Two admissions for one account in a single wave both land: neither row is
/// silently dropped by the tree write.
#[test]
fn a_wave_with_two_rows_for_one_account_keeps_both() {
    let mut stand = stand(2);
    let account_id = stand.pairs[0].payer_account;
    stand
        .payer
        .admit_txs(vec![
            payment(&stand.pairs[0], 5),
            payment(&stand.pairs[0], 7),
            payment(&stand.pairs[1], 9),
        ])
        .expect("admit");
    assert_eq!(
        stand
            .payer
            .account(&account_id)
            .expect("account")
            .mempool()
            .len(),
        2,
    );
    let proposals = stand
        .payer
        .propose_frames(1_700_000_000_000, 100, None)
        .expect("propose");
    assert_eq!(proposals.len(), 2);
    let rows = proposals
        .iter()
        .find(|row| row.account_id == account_id)
        .expect("row");
    assert_eq!(rows.frame.txs.len(), 2);
}

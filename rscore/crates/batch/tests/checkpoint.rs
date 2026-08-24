//! The canonical database checkpoint, from both ends: what the engine emits
//! after work, and what an engine restored from those rows holds.
//!
//! The `Database` here is a stand-in for the runtime's canonical store: it
//! applies whatever a checkpoint says and can hand every account back. If a
//! restored engine reaches a different accounts root, the checkpoint is not a
//! checkpoint, and these tests fail rather than the next crash discovering it.

use std::collections::BTreeMap;

use num_bigint::BigInt;
use xln_rscore_batch::{
    AccountCheckpointRows, AccountId, AccountInputKind, AccountInputRow, AccountInputVerdict,
    AccountRestore, AccountSeed, AccountsCheckpoint, BatchError, EngineGeneration, ReceiverClock,
    StatefulConsensusEngine,
};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountIdentity, AccountReplica, AccountState,
    AccountStateSeed, AccountTx, AckOutcome, BoardDelays, ConsensusSnapshot, DeliveryMode, Delta,
    DepositoryAddress, EntityId, IncomingFrame, IncomingOutcome, SigningIdentity, TokenId,
    WatchSeed,
};
use xln_rscore_protocol::{PersistentNodeChanges, PersistentNodeRecord, PersistentNodeRef};

const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
const WORKERS: usize = 4;

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
}

impl Database {
    fn write(&mut self, checkpoint: &AccountsCheckpoint) {
        for rows in &checkpoint.accounts {
            let row = self.accounts.entry(rows.account_id).or_default();
            row.header = Some(rows.header.clone());
            row.consensus = Some(rows.consensus.clone());
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
                }
            })
            .collect()
    }
}

// ------------------------------------------------------------- the fixture

fn hex_of(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn entity_of(signer_id: &str) -> ([u8; 32], EntityId) {
    let identity = SigningIdentity::lazy_from_seed(SEED, signer_id, 1, 1, BoardDelays::default())
        .expect("identity");
    let bytes = *identity.entity_id();
    let parsed = EntityId::parse(&format!("0x{}", hex_of(&bytes))).expect("entity");
    (bytes, parsed)
}

fn account_state(left: &EntityId, right: &EntityId) -> AccountState {
    let domain = AccountDomain::new(
        31_337,
        DepositoryAddress::parse(&format!("0x{}", "88".repeat(20))).expect("depository"),
    )
    .expect("domain");
    let identity = AccountIdentity::new(
        domain,
        left.clone(),
        right.clone(),
        WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
    )
    .expect("identity");
    let delta = Delta::new(
        TokenId::new(1).expect("token"),
        BigInt::from(1_000_000_000),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(500_000_000),
        BigInt::from(500_000_000),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(0),
    )
    .expect("delta");
    AccountState::new(
        identity,
        AccountDisputeConfig::new(10, 10).expect("dispute config"),
        vec![delta],
    )
    .expect("state")
}

struct Pair {
    payer_account: AccountId,
    payee_account: AccountId,
    payer: EntityId,
    payee: EntityId,
    payer_entity: [u8; 32],
    payee_entity: [u8; 32],
}

struct Stand {
    payer: StatefulConsensusEngine,
    payee: StatefulConsensusEngine,
    pairs: Vec<Pair>,
}

fn engine() -> StatefulConsensusEngine {
    StatefulConsensusEngine::restore(
        EngineGeneration::from_bytes([0x42; 8]),
        WORKERS,
        0,
        SEED.to_string(),
        "1".to_string(),
        Vec::new(),
    )
    .expect("engine")
}

fn stand(accounts: usize) -> Stand {
    let mut payer_engine = engine();
    let mut payee_engine = engine();
    let mut payer_seeds = Vec::with_capacity(accounts);
    let mut payee_seeds = Vec::with_capacity(accounts);
    let mut pairs = Vec::with_capacity(accounts);
    for index in 0..accounts {
        let payer_signer = format!("payer-{index}");
        let payee_signer = format!("payee-{index}");
        let (payer_bytes, payer) = entity_of(&payer_signer);
        let (payee_bytes, payee) = entity_of(&payee_signer);
        let (left, right) = if payer.to_string() < payee.to_string() {
            (payer.clone(), payee.clone())
        } else {
            (payee.clone(), payer.clone())
        };
        let state = account_state(&left, &right);
        payer_engine
            .register_signer(payer_bytes, &payer_signer)
            .expect("payer signer");
        payee_engine
            .register_signer(payee_bytes, &payee_signer)
            .expect("payee signer");
        payer_seeds.push(AccountSeed {
            account_id: AccountId::from_bytes(payee_bytes),
            replica: AccountReplica::new(payer.clone(), state.clone()).expect("payer replica"),
        });
        payee_seeds.push(AccountSeed {
            account_id: AccountId::from_bytes(payer_bytes),
            replica: AccountReplica::new(payee.clone(), state).expect("payee replica"),
        });
        pairs.push(Pair {
            payer_account: AccountId::from_bytes(payee_bytes),
            payee_account: AccountId::from_bytes(payer_bytes),
            payer,
            payee,
            payer_entity: payer_bytes,
            payee_entity: payee_bytes,
        });
    }
    payer_engine.upsert_accounts(payer_seeds).expect("payer seeds");
    payee_engine.upsert_accounts(payee_seeds).expect("payee seeds");
    Stand {
        payer: payer_engine,
        payee: payee_engine,
        pairs,
    }
}

/// The receiver's clock, level with the frame being applied.
fn clock(timestamp: u64) -> ReceiverClock {
    ReceiverClock {
        entity_timestamp: timestamp,
        finalized_j_height: 100,
    }
}

fn payment(pair: &Pair, amount: i64) -> (AccountId, Vec<AccountTx>) {
    (
        pair.payer_account,
        vec![AccountTx::DirectPayment {
            token_id: TokenId::new(1).expect("token"),
            amount: BigInt::from(amount),
            route: vec![pair.payee.to_string()],
            description: None,
            from_entity_id: pair.payer.to_string(),
            to_entity_id: pair.payee.to_string(),
            delivery_mode: DeliveryMode::Direct,
            trusted_gateway_entity_id: None,
        }],
    )
}

fn pair_by_payer_account(pairs: &[Pair], account_id: &AccountId) -> usize {
    pairs
        .iter()
        .position(|pair| pair.payer_account == *account_id)
        .expect("pair")
}

fn pair_by_payee_account(pairs: &[Pair], account_id: &AccountId) -> usize {
    pairs
        .iter()
        .position(|pair| pair.payee_account == *account_id)
        .expect("pair")
}

/// One payment per pair, all the way to both sides committing it.
fn round(stand: &mut Stand, timestamp: u64, amount: i64) {
    let admissions: Vec<(AccountId, Vec<AccountTx>)> =
        stand.pairs.iter().map(|pair| payment(pair, amount)).collect();
    stand.payer.admit_txs(admissions).expect("admit");
    let proposals = stand
        .payer
        .propose_frames(timestamp, 100, None)
        .expect("propose");
    let frames: Vec<AccountInputRow> = proposals
        .iter()
        .enumerate()
        .map(|(index, proposal)| {
            let pair = &stand.pairs[pair_by_payer_account(&stand.pairs, &proposal.account_id)];
            AccountInputRow {
                input_index: index as u32,
                account_id: pair.payee_account,
                from_entity_id: pair.payer_entity,
                kind: AccountInputKind::Frame(Box::new(IncomingFrame {
                    height: proposal.frame.height,
                    timestamp: proposal.frame.timestamp,
                    j_height: proposal.frame.j_height,
                    txs: proposal.frame.txs.clone(),
                    prev_frame_hash: proposal.frame.prev_frame_hash.clone(),
                    account_state_root: proposal.frame.account_state_root,
                    by_left: proposal.frame.by_left,
                    state_hash: proposal.state_hash,
                    hanko: proposal.hanko.clone(),
                })),
            }
        })
        .collect();
    let applied = stand
        .payee
        .apply_inputs(clock(timestamp), frames)
        .expect("apply frames");
    let acks: Vec<AccountInputRow> = applied
        .iter()
        .enumerate()
        .map(|(index, result)| {
            let pair = &stand.pairs[pair_by_payee_account(&stand.pairs, &result.account_id)];
            let AccountInputVerdict::Frame(IncomingOutcome::Committed {
                height,
                state_hash,
                ack_hanko,
                ..
            }) = &result.verdict
            else {
                panic!("expected a commit: {:?}", result.verdict);
            };
            AccountInputRow {
                input_index: index as u32,
                account_id: pair.payer_account,
                from_entity_id: pair.payee_entity,
                kind: AccountInputKind::Ack {
                    height: *height,
                    state_hash: *state_hash,
                    hanko: ack_hanko.clone(),
                },
            }
        })
        .collect();
    let acked = stand
        .payer
        .apply_inputs(clock(timestamp), acks)
        .expect("apply acks");
    for result in &acked {
        assert!(
            matches!(
                result.verdict,
                AccountInputVerdict::Ack(AckOutcome::Committed { .. })
            ),
            "expected an ack commit: {:?}",
            result.verdict,
        );
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
            rows.deltas.puts.iter().any(|record| matches!(
                record,
                PersistentNodeRecord::Leaf { .. }
            )),
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
    assert!(rows.deltas.puts.is_empty(), "committed deltas are unchanged");
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
        .restore_accounts(database.restore_rows())
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
        .restore_accounts(written.restore_rows())
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
        .restore_accounts(database.restore_rows())
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
        .apply_inputs(clock(1_700_000_000_000), vec![AccountInputRow {
            input_index: 0,
            account_id: stand.pairs[0].payee_account,
            from_entity_id: stand.pairs[0].payer_entity,
            kind: AccountInputKind::Frame(Box::new(frame)),
        }])
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
        .apply_inputs(clock(1_700_000_000_000), vec![AccountInputRow {
            input_index: 0,
            account_id: pair_payer_account,
            from_entity_id: stand.pairs[0].payee_entity,
            kind: AccountInputKind::Ack {
                height: *height,
                state_hash: *state_hash,
                hanko: ack_hanko.clone(),
            },
        }])
        .expect("apply ack");
    assert!(
        matches!(
            acked[0].verdict,
            AccountInputVerdict::Ack(AckOutcome::Committed { height: 1, .. })
        ),
        "{:?}",
        acked[0].verdict,
    );
    assert_eq!(
        restored.accounts_root(),
        {
            // The engine that never crashed, driven the same way.
            let acked_live = stand
                .payer
                .apply_inputs(clock(1_700_000_000_000), vec![AccountInputRow {
                    input_index: 0,
                    account_id: pair_payer_account,
                    from_entity_id: stand.pairs[0].payee_entity,
                    kind: AccountInputKind::Ack {
                        height: *height,
                        state_hash: *state_hash,
                        hanko: ack_hanko.clone(),
                    },
                }])
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

/// A database that lost a delta row cannot be restored into a matching engine.
/// The mismatch surfaces as a different accounts root, not as a silent fork.
#[test]
fn a_truncated_database_does_not_reproduce_the_root() {
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
    let root = restored
        .restore_accounts(database.restore_rows())
        .expect("restore");
    assert_ne!(root, stand.payer.accounts_root());
}

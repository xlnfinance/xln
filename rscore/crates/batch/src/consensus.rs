//! The authoritative account store: replicas the engine itself drives.
//!
//! The mirror engine in `stateful.rs` applies transitions the runtime already
//! decided. This one owns the accounts instead — their mempools, their frames
//! and their signatures — so a wave costs one message rather than one replica
//! shell per frame. Both keep the same commitment: a radix-16 Patricia tree
//! keyed by account id, leaf digest = the Entity's account leaf.

use std::collections::{BTreeMap, BTreeSet};

use rayon::prelude::*;
use rayon::{ThreadPool, ThreadPoolBuilder};
use xln_rscore_engine::{
    AccountConsensus, AccountFrame, AckOutcome, BoardDelays, IncomingFrame, IncomingOutcome,
    ProposalOutcome, ReceiverClock, SigningIdentity, StateError, apply_incoming_ack,
    apply_incoming_frame, propose_account_frame,
};
use xln_rscore_protocol::{PersistentNodeRecord, PersistentNodeRef, PersistentRadixMap};

use crate::checkpoint::{AccountRestore, AccountsCheckpoint, CheckpointExpectation, account_rows};
use crate::stateful::MAX_BATCH_WORKERS;
use crate::{AccountId, AccountSeed, BatchError, EngineGeneration};

/// What arrives for one account: either the peer's frame or their ack of ours.
#[derive(Clone, Debug)]
pub enum AccountInputKind {
    Frame(Box<IncomingFrame>),
    Ack {
        height: u64,
        state_hash: [u8; 32],
        hanko: Vec<u8>,
    },
}

#[derive(Clone, Debug)]
pub struct AccountInputRow {
    pub input_index: u32,
    pub account_id: AccountId,
    /// The entity that signed this input, which the engine authenticates
    /// against the account's own counterparty before applying anything.
    pub from_entity_id: [u8; 32],
    pub kind: AccountInputKind,
}

#[derive(Debug)]
pub enum AccountInputVerdict {
    Frame(IncomingOutcome),
    Ack(AckOutcome),
    /// The account is not in this engine, or its transition faulted. The
    /// runtime decides what to do; the engine never guesses.
    Failed(String),
}

#[derive(Debug)]
pub struct AccountInputResult {
    pub input_index: u32,
    pub account_id: AccountId,
    pub verdict: AccountInputVerdict,
}

#[derive(Debug)]
/// Everything one runtime frame asks of the accounts.
pub struct WaveRequest {
    /// The clock the proposed frames are stamped with.
    pub timestamp: u64,
    pub j_height: u64,
    /// The runtime's own clock, which decides what has expired.
    pub clock: ReceiverClock,
    pub admissions: Vec<(AccountId, Vec<xln_rscore_engine::AccountTx>)>,
    pub inputs: Vec<AccountInputRow>,
    /// Whether to propose after applying. A runtime that only wants to drain
    /// its inbox says no.
    pub propose: bool,
}

/// What the wave produced, against a candidate that is not yet committed.
pub struct WaveResult {
    pub revision: u64,
    pub accounts_root: [u8; 32],
    pub applied: Vec<AccountInputResult>,
    pub proposals: Vec<ProposalRow>,
}

/// The committed store as it was before the wave, kept until the runtime says
/// its own record is durable.
struct PendingWave {
    base_accounts: PersistentRadixMap<AccountConsensus>,
    base_revision: u64,
}

/// A proposal to send. It carries no outputs: what the frame produced is
/// released with the peer's ack, never before.
pub struct ProposalRow {
    pub account_id: AccountId,
    pub frame: AccountFrame,
    pub state_hash: [u8; 32],
    pub hanko: Vec<u8>,
    pub dropped: usize,
}

/// One account's work returned from the pool: the account it belongs to, the
/// state it reached, and whatever the caller asked for.
type ProposalWork = Result<(AccountId, AccountConsensus, Option<ProposalRow>), BatchError>;
type InputWork = Result<(AccountId, AccountConsensus, Vec<AccountInputResult>), BatchError>;

pub struct StatefulConsensusEngine {
    engine_generation: EngineGeneration,
    revision: u64,
    pool: ThreadPool,
    accounts: PersistentRadixMap<AccountConsensus>,
    /// The accounts tree as of the last checkpoint the runtime took, so the
    /// next checkpoint ships only what moved. The runtime asks for this every
    /// hundred or so frames; between those it never pays for the diff.
    checkpoint: PersistentRadixMap<AccountConsensus>,
    checkpoint_revision: u64,
    /// The runtime seed and signer this process signs with. Every account
    /// derives its identity from them, bound to its own owner entity.
    seed: String,
    signer_id: String,
    identities: BTreeMap<[u8; 32], SigningIdentity>,
    pending: Option<PendingWave>,
}

impl StatefulConsensusEngine {
    pub fn restore(
        engine_generation: EngineGeneration,
        worker_count: usize,
        revision: u64,
        seed: String,
        signer_id: String,
        seeds: Vec<AccountSeed>,
    ) -> Result<Self, BatchError> {
        if worker_count == 0 || worker_count > MAX_BATCH_WORKERS {
            return Err(BatchError::InvalidWorkerCount(worker_count));
        }
        if seed.is_empty() || signer_id.is_empty() {
            return Err(BatchError::SignerRequired);
        }
        let pool = ThreadPoolBuilder::new()
            .num_threads(worker_count)
            .thread_name(|index| format!("rscore-consensus-{index}"))
            .build()
            .map_err(|error| BatchError::ThreadPoolBuild(error.to_string()))?;
        let mut engine = Self {
            engine_generation,
            revision,
            pool,
            accounts: PersistentRadixMap::empty(),
            checkpoint: PersistentRadixMap::empty(),
            checkpoint_revision: revision,
            seed,
            signer_id,
            identities: BTreeMap::new(),
            pending: None,
        };
        engine.upsert_accounts(seeds)?;
        Ok(engine)
    }

    pub const fn engine_generation(&self) -> EngineGeneration {
        self.engine_generation
    }

    pub const fn revision(&self) -> u64 {
        self.revision
    }

    pub fn worker_count(&self) -> usize {
        self.pool.current_num_threads()
    }

    pub fn accounts_root(&self) -> [u8; 32] {
        self.accounts.root_hash()
    }

    pub fn account(&self, account_id: &AccountId) -> Option<&AccountConsensus> {
        self.accounts.get(account_id.as_bytes())
    }

    pub fn account_count(&self) -> usize {
        self.accounts.len()
    }

    /// Seed or replace accounts. Their consensus state starts empty: a fresh
    /// account has no frames and no queue.
    pub fn upsert_accounts(&mut self, seeds: Vec<AccountSeed>) -> Result<[u8; 32], BatchError> {
        self.assert_no_pending_wave()?;
        let mut entries = Vec::with_capacity(seeds.len());
        let mut seen = BTreeSet::new();
        for seed in seeds {
            // Two seeds for one account in a wave is a caller bug: one of them
            // would be silently discarded by the tree write.
            if !seen.insert(seed.account_id) {
                return Err(BatchError::DuplicateAccount(seed.account_id));
            }
            self.ensure_identity(seed.replica.owner().as_bytes())?;
            let account = AccountConsensus::new(seed.replica);
            let leaf = leaf_root(seed.account_id, &account)?;
            entries.push((seed.account_id.as_bytes().to_vec(), account, leaf));
        }
        if entries.is_empty() {
            return Ok(self.accounts.root_hash());
        }
        self.accounts = self.put_accounts(entries)?;
        self.revision += 1;
        Ok(self.accounts.root_hash())
    }

    /// Admit local transactions into the accounts' mempools.
    ///
    /// A wave may carry several rows for the same account. They are merged in
    /// row order onto one copy: cloning the pre-wave account per row and
    /// writing each back would keep only the last row's transactions, and the
    /// rest would vanish without an error.
    pub fn admit_txs(
        &mut self,
        requests: Vec<(AccountId, Vec<xln_rscore_engine::AccountTx>)>,
    ) -> Result<[u8; 32], BatchError> {
        self.assert_no_pending_wave()?;
        let mut merged: BTreeMap<AccountId, Vec<xln_rscore_engine::AccountTx>> = BTreeMap::new();
        for (account_id, txs) in requests {
            merged.entry(account_id).or_default().extend(txs);
        }
        let mut entries = Vec::with_capacity(merged.len());
        for (account_id, txs) in merged {
            let mut account = self
                .accounts
                .get(account_id.as_bytes())
                .ok_or(BatchError::AccountNotFound {
                    input_index: 0,
                    account_id,
                })?
                .clone();
            account
                .admit_txs(txs, "rscoreConsensus:admit")
                .map_err(|error| state_error(account_id, &error))?;
            let leaf = leaf_root(account_id, &account)?;
            entries.push((account_id.as_bytes().to_vec(), account, leaf));
        }
        if entries.is_empty() {
            return Ok(self.accounts.root_hash());
        }
        self.accounts = self.put_accounts(entries)?;
        self.revision += 1;
        Ok(self.accounts.root_hash())
    }

    /// Propose a frame for every account that has something to propose. Frame
    /// building, hashing and signing all happen on the pool, one account per
    /// core, because signatures are the expensive part of a wave.
    pub fn propose_frames(
        &mut self,
        timestamp: u64,
        j_height: u64,
        selected: Option<&[AccountId]>,
    ) -> Result<Vec<ProposalRow>, BatchError> {
        self.assert_no_pending_wave()?;
        let candidates: Vec<(AccountId, AccountConsensus)> = match selected {
            Some(ids) => ids
                .iter()
                .filter_map(|account_id| {
                    self.accounts
                        .get(account_id.as_bytes())
                        .map(|account| (*account_id, account.clone()))
                })
                .filter(|(_, account)| proposable(account))
                .collect(),
            None => self
                .accounts
                .iter()
                .filter(|(_, account)| proposable(account))
                .map(|(key, account)| (AccountId::from_key(key), account.clone()))
                .collect(),
        };
        if candidates.is_empty() {
            return Ok(Vec::new());
        }
        let identities = &self.identities;
        let proposals: Vec<ProposalWork> = self.pool.install(|| {
            candidates
                .into_par_iter()
                .map(|(account_id, mut account)| {
                    let identity = identities
                        .get(account.replica().owner().as_bytes())
                        .ok_or(BatchError::SignerRequired)?;
                    let outcome =
                        propose_account_frame(&mut account, identity, timestamp, j_height)
                            .map_err(|error| state_error(account_id, &error))?;
                    let row = match outcome {
                        ProposalOutcome::Idle { .. } => None,
                        ProposalOutcome::Proposed(proposed) => Some(ProposalRow {
                            account_id,
                            frame: proposed.frame,
                            state_hash: proposed.state_hash,
                            hanko: proposed.hanko,
                            dropped: proposed.dropped.len(),
                        }),
                    };
                    Ok((account_id, account, row))
                })
                .collect()
        });
        let mut entries = Vec::with_capacity(proposals.len());
        let mut rows = Vec::new();
        for proposal in proposals {
            let (account_id, account, row) = proposal?;
            let leaf = leaf_root(account_id, &account)?;
            entries.push((account_id.as_bytes().to_vec(), account, leaf));
            if let Some(row) = row {
                rows.push(row);
            }
        }
        self.accounts = self.put_accounts(entries)?;
        self.revision += 1;
        rows.sort_by_key(|row| *row.account_id.as_bytes());
        Ok(rows)
    }

    /// Apply inputs that arrived from peers. Inputs for one account keep their
    /// order; different accounts run on different cores, which is where the
    /// signature verification parallelises.
    /// Apply inputs against the runtime's own clock. Enforcement decisions —
    /// whether a lock has expired — are judged with `clock`, never with the
    /// clock the peer signed into the frame.
    pub fn apply_inputs(
        &mut self,
        clock: ReceiverClock,
        rows: Vec<AccountInputRow>,
    ) -> Result<Vec<AccountInputResult>, BatchError> {
        self.assert_no_pending_wave()?;
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        let mut by_account: BTreeMap<AccountId, Vec<AccountInputRow>> = BTreeMap::new();
        let mut missing = Vec::new();
        for row in rows {
            if self.accounts.get(row.account_id.as_bytes()).is_none() {
                missing.push(AccountInputResult {
                    input_index: row.input_index,
                    account_id: row.account_id,
                    verdict: AccountInputVerdict::Failed(format!(
                        "RSCORE_CONSENSUS_ACCOUNT_NOT_FOUND:{}",
                        hex_of(row.account_id.as_bytes())
                    )),
                });
                continue;
            }
            by_account.entry(row.account_id).or_default().push(row);
        }
        let work: Vec<(AccountId, AccountConsensus, Vec<AccountInputRow>)> = by_account
            .into_iter()
            .map(|(account_id, rows)| {
                let account = self
                    .accounts
                    .get(account_id.as_bytes())
                    .expect("presence checked above")
                    .clone();
                (account_id, account, rows)
            })
            .collect();
        let identities = &self.identities;
        let applied: Vec<InputWork> = self.pool.install(|| {
            work.into_par_iter()
                .map(|(account_id, mut account, rows)| {
                    let identity = identities
                        .get(account.replica().owner().as_bytes())
                        .ok_or(BatchError::SignerRequired)?;
                    let mut results = Vec::with_capacity(rows.len());
                    for row in rows {
                        let verdict =
                            apply_one(&mut account, identity, &row.from_entity_id, clock, row.kind);
                        results.push(AccountInputResult {
                            input_index: row.input_index,
                            account_id,
                            verdict,
                        });
                    }
                    Ok((account_id, account, results))
                })
                .collect()
        });
        let mut entries = Vec::with_capacity(applied.len());
        let mut results = missing;
        for outcome in applied {
            let (account_id, account, rows) = outcome?;
            let leaf = leaf_root(account_id, &account)?;
            entries.push((account_id.as_bytes().to_vec(), account, leaf));
            results.extend(rows);
        }
        self.accounts = self.put_accounts(entries)?;
        self.revision += 1;
        results.sort_by_key(|result| result.input_index);
        Ok(results)
    }

    /// One runtime wave, applied to a candidate the caller can still abort.
    ///
    /// This is the whole conversation for a runtime frame: admit what the
    /// Entity queued, apply what the peers sent, propose what is now
    /// proposable — one call, one crossing of the process boundary, with the
    /// pool loaded once instead of three times.
    ///
    /// Nothing here is durable. The committed store is kept aside until
    /// `commit_wave`, so the runtime can write its own log first and
    /// `abort_wave` if that write fails. Effects released by an ack ride back
    /// in the result and belong to the caller only once it has committed.
    pub fn prepare_wave(&mut self, request: WaveRequest) -> Result<WaveResult, BatchError> {
        if self.pending.is_some() {
            return Err(BatchError::WavePending);
        }
        let base_accounts = self.accounts.clone();
        let base_revision = self.revision;
        let outcome = self.run_wave(request);
        match outcome {
            Ok(result) => {
                self.pending = Some(PendingWave {
                    base_accounts,
                    base_revision,
                });
                Ok(result)
            }
            Err(error) => {
                // A wave that failed halfway leaves nothing behind: the caller
                // sees the error against the state it started from.
                self.accounts = base_accounts;
                self.revision = base_revision;
                Err(error)
            }
        }
    }

    fn run_wave(&mut self, request: WaveRequest) -> Result<WaveResult, BatchError> {
        let WaveRequest {
            timestamp,
            j_height,
            clock,
            admissions,
            inputs,
            propose,
        } = request;
        if !admissions.is_empty() {
            self.admit_txs(admissions)?;
        }
        let applied = if inputs.is_empty() {
            Vec::new()
        } else {
            self.apply_inputs(clock, inputs)?
        };
        let proposals = if propose {
            self.propose_frames(timestamp, j_height, None)?
        } else {
            Vec::new()
        };
        Ok(WaveResult {
            revision: self.revision,
            accounts_root: self.accounts.root_hash(),
            applied,
            proposals,
        })
    }

    /// Keep the wave: the runtime has made its own record of it durable.
    pub fn commit_wave(&mut self, revision: u64) -> Result<[u8; 32], BatchError> {
        if self.pending.is_none() {
            return Err(BatchError::WaveMissing);
        }
        if revision != self.revision {
            return Err(BatchError::WaveRevision {
                actual: revision,
                expected: self.revision,
            });
        }
        self.pending = None;
        Ok(self.accounts.root_hash())
    }

    /// Drop the wave and everything it touched. The caller could not make its
    /// own record durable, so this engine must not be ahead of it.
    pub fn abort_wave(&mut self, revision: u64) -> Result<u64, BatchError> {
        let Some(pending) = self.pending.take() else {
            return Err(BatchError::WaveMissing);
        };
        if revision != self.revision {
            let expected = self.revision;
            self.pending = Some(pending);
            return Err(BatchError::WaveRevision {
                actual: revision,
                expected,
            });
        }
        self.accounts = pending.base_accounts;
        self.revision = pending.base_revision;
        Ok(self.revision)
    }

    /// Whether a wave is waiting for the runtime's word.
    pub const fn wave_pending(&self) -> bool {
        self.pending.is_some()
    }

    /// Every other entry point is closed while a wave is uncommitted: the
    /// engine holds exactly one candidate, and a second mutation on top of it
    /// could not be rolled back to the state the runtime agreed on.
    fn assert_no_pending_wave(&self) -> Result<(), BatchError> {
        if self.pending.is_some() {
            return Err(BatchError::WavePending);
        }
        Ok(())
    }

    /// Bind an entity this runtime signs for to its signer id. A runtime that
    /// hosts several entities derives a different key for each; without this
    /// they would all sign as the session's default signer.
    pub fn register_signer(
        &mut self,
        entity_id: [u8; 32],
        signer_id: &str,
    ) -> Result<(), BatchError> {
        let identity = SigningIdentity::from_seed(
            &self.seed,
            signer_id,
            entity_id,
            1,
            1,
            BoardDelays::default(),
        )
        .map_err(|error| BatchError::Signing(error.to_string()))?;
        self.identities.insert(entity_id, identity);
        Ok(())
    }

    /// Everything that moved since the last committed checkpoint. The runtime
    /// writes these rows into its canonical database and calls
    /// `commit_checkpoint` once the write is durable; nothing is dropped until
    /// then, so a crash in between replays from the previous checkpoint.
    pub fn checkpoint_changes(&self) -> Result<AccountsCheckpoint, BatchError> {
        // A wave the runtime has not committed is not part of the world yet,
        // so it must not reach the database that outlives this process.
        self.assert_no_pending_wave()?;
        let diff = self.accounts.node_changes_since(&self.checkpoint);
        let mut accounts = Vec::new();
        for record in &diff.puts {
            let PersistentNodeRecord::Leaf { key, value, .. } = record else {
                continue;
            };
            let account_id = account_id_of(key)?;
            let owner = value.replica().owner().as_bytes();
            let signer_id = self
                .signer_of(owner)
                .ok_or(BatchError::SignerRequired)?
                .to_string();
            accounts.push(account_rows(
                account_id,
                value,
                self.checkpoint.get(key),
                leaf_root(account_id, value)?,
                &signer_id,
            ));
        }
        let mut removed = Vec::new();
        for record in &diff.dels {
            let PersistentNodeRef::Leaf { key, .. } = record else {
                continue;
            };
            // A leaf may move within the tree without leaving it: a deletion
            // that the same revision also puts back is a reshape, not a drop.
            if self.accounts.get(key).is_none() {
                removed.push(account_id_of(key)?);
            }
        }
        Ok(AccountsCheckpoint {
            base_revision: self.checkpoint_revision,
            revision: self.revision,
            accounts_root: self.accounts.root_hash(),
            accounts,
            removed,
        })
    }

    /// Accept a checkpoint the runtime has made durable. Only the exact
    /// revision that was read may be committed: anything else would leave the
    /// database missing the rows written in between.
    pub fn commit_checkpoint(&mut self, revision: u64) -> Result<(), BatchError> {
        self.assert_no_pending_wave()?;
        if revision != self.revision {
            return Err(BatchError::CheckpointRevision {
                actual: revision,
                expected: self.revision,
            });
        }
        self.checkpoint = self.accounts.clone();
        self.checkpoint_revision = revision;
        Ok(())
    }

    /// Load accounts back from a checkpoint the database holds.
    ///
    /// This replaces the store rather than merging into it: a restore is what
    /// the database says the world is, and an account the database no longer
    /// has must not survive in memory. The result is checked against what the
    /// checkpoint recorded — every account leaf, the account count, the tree
    /// root and the revision — because any subset of rows rebuilds into a
    /// perfectly valid tree that simply is not this one.
    pub fn restore_accounts(
        &mut self,
        rows: Vec<AccountRestore>,
        expected: &CheckpointExpectation,
    ) -> Result<[u8; 32], BatchError> {
        self.assert_no_pending_wave()?;
        if rows.len() != expected.account_count {
            return Err(BatchError::CheckpointIncomplete {
                actual: rows.len(),
                expected: expected.account_count,
            });
        }
        let mut entries = Vec::with_capacity(rows.len());
        for row in rows {
            self.register_signer(*row.replica.owner().as_bytes(), &row.signer_id)?;
            let account = AccountConsensus::restore_from_checkpoint(row.replica, row.consensus)
                .map_err(|error| state_error(row.account_id, &error))?;
            let leaf = leaf_root(row.account_id, &account)?;
            if leaf != row.account_leaf {
                return Err(BatchError::CheckpointAccountLeaf {
                    account_id: row.account_id,
                    actual: hex_of(&leaf),
                    expected: hex_of(&row.account_leaf),
                });
            }
            entries.push((row.account_id.as_bytes().to_vec(), account, leaf));
        }
        let mut restored = StatefulConsensusEngine::empty_accounts();
        std::mem::swap(&mut self.accounts, &mut restored);
        if !entries.is_empty() {
            self.accounts = self.put_accounts(entries)?;
        }
        let root = self.accounts.root_hash();
        if root != expected.accounts_root {
            return Err(BatchError::CheckpointRoot {
                actual: hex_of(&root),
                expected: hex_of(&expected.accounts_root),
            });
        }
        self.revision = expected.revision;
        self.checkpoint = self.accounts.clone();
        self.checkpoint_revision = self.revision;
        Ok(root)
    }

    fn empty_accounts() -> PersistentRadixMap<AccountConsensus> {
        PersistentRadixMap::empty()
    }

    /// Resolve the signer for an entity we host. The session's default signer
    /// is only assumed when it actually is this entity's signer — a lazy
    /// entity id is the hash of its own board, so that is checkable. Guessing
    /// wrong would have this engine sign frames the peer cannot verify, and
    /// the mistake would only surface at the counterparty.
    fn ensure_identity(&mut self, entity_id: &[u8; 32]) -> Result<(), BatchError> {
        if self.identities.contains_key(entity_id) {
            return Ok(());
        }
        let signer_id = self.signer_id.clone();
        let identity = SigningIdentity::from_seed(
            &self.seed,
            &signer_id,
            *entity_id,
            1,
            1,
            BoardDelays::default(),
        )
        .map_err(|error| BatchError::Signing(error.to_string()))?;
        if !identity.binds_lazy_entity() {
            return Err(BatchError::SignerUnknownEntity {
                entity_id: hex_of(entity_id),
            });
        }
        self.identities.insert(*entity_id, identity);
        Ok(())
    }

    /// The signer id bound to an entity, so a checkpoint can carry it and a
    /// restore can rebuild the mapping instead of guessing.
    pub fn signer_of(&self, entity_id: &[u8; 32]) -> Option<&str> {
        self.identities
            .get(entity_id)
            .map(|identity| identity.signer_id())
    }

    fn put_accounts(
        &self,
        entries: Vec<(Vec<u8>, AccountConsensus, [u8; 32])>,
    ) -> Result<PersistentRadixMap<AccountConsensus>, BatchError> {
        self.accounts
            .updated_batch(entries, |slots| {
                self.pool.install(|| {
                    let mut results = slots
                        .into_par_iter()
                        .map(xln_rscore_protocol::SlotWork::apply)
                        .collect::<Vec<_>>()
                        .into_iter();
                    std::array::from_fn(|_| {
                        results.next().unwrap_or_else(|| {
                            Err(xln_rscore_protocol::PersistentRadixMapError::EmptyKey)
                        })
                    })
                })
            })
            .map_err(|error| BatchError::AccountsTree {
                account_id: AccountId::from_bytes([0; 32]),
                detail: error.to_string(),
            })
    }
}

fn apply_one(
    account: &mut AccountConsensus,
    identity: &SigningIdentity,
    from_entity_id: &[u8; 32],
    clock: ReceiverClock,
    kind: AccountInputKind,
) -> AccountInputVerdict {
    match kind {
        AccountInputKind::Frame(frame) => {
            match apply_incoming_frame(account, identity, from_entity_id, clock, *frame) {
                Ok(outcome) => AccountInputVerdict::Frame(outcome),
                Err(error) => AccountInputVerdict::Failed(error.to_string()),
            }
        }
        AccountInputKind::Ack {
            height,
            state_hash,
            hanko,
        } => match apply_incoming_ack(account, from_entity_id, height, &state_hash, &hanko) {
            Ok(outcome) => AccountInputVerdict::Ack(outcome),
            Err(error) => AccountInputVerdict::Failed(error.to_string()),
        },
    }
}

fn proposable(account: &AccountConsensus) -> bool {
    account.pending().is_none() && !account.mempool().is_empty()
}

/// The leaf commits the consensus state too, so a queued transaction or a new
/// frame moves the tree even when the financial root did not change.
fn leaf_root(account_id: AccountId, account: &AccountConsensus) -> Result<[u8; 32], BatchError> {
    account
        .entity_account_leaf()
        .map_err(|error| BatchError::AccountsTree {
            account_id,
            detail: error.to_string(),
        })
}

fn state_error(account_id: AccountId, error: &StateError) -> BatchError {
    BatchError::AccountsTree {
        account_id,
        detail: error.to_string(),
    }
}

fn hex_of(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

/// The account id a tree key names. The tree is keyed by the id itself, so a
/// key of any other width is a corrupt tree rather than an unknown account.
fn account_id_of(key: &[u8]) -> Result<AccountId, BatchError> {
    let bytes: [u8; 32] = key
        .try_into()
        .map_err(|_| BatchError::CheckpointAccountKey { width: key.len() })?;
    Ok(AccountId::from_bytes(bytes))
}

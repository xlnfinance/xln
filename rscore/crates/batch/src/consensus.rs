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
    AccountConsensus, AccountFrame, AckOutcome, BoardDelays, Disposition, IncomingFrame,
    IncomingOutcome, ProposalOutcome, ReceiverClock, SigningIdentity, StateError,
    apply_incoming_ack, apply_incoming_frame, canonical_tx_digest, propose_account_frame,
};
use xln_rscore_protocol::{PersistentNodeRecord, PersistentNodeRef, PersistentRadixMap};

use crate::checkpoint::{
    AccountRestore, AccountsCheckpoint, CheckpointExpectation, CheckpointToken, account_rows,
};
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
    /// One group per owner Entity, each with its own clocks and its own work.
    /// The whole wave is still one candidate: prepared together, committed or
    /// aborted together, under one accounts root.
    pub entities: Vec<EntityWave>,
}

/// One thing the authority did to one account, in the order it did it.
///
/// Measured, not assumed: in a same-jurisdiction swap recording, 10 of 40
/// Runtime frames admit a transaction to an account *after* a peer input for
/// that same account was already applied (payments: 0 of 60). A wave that put
/// every admission ahead of every input would build a different mempool out of
/// identical traffic, and the two engines would sign different frames.
#[derive(Clone, Debug)]
pub enum WaveOp {
    Admit {
        account_id: AccountId,
        txs: Vec<xln_rscore_engine::AccountTx>,
    },
    Input(AccountInputRow),
}

impl WaveOp {
    pub const fn account_id(&self) -> AccountId {
        match self {
            Self::Admit { account_id, .. } => *account_id,
            Self::Input(row) => row.account_id,
        }
    }
}

/// One Entity's part of a wave: its own clocks, its own ordered work, and its
/// own decision whether to propose.
///
/// A runtime hosts several Entities, and each judges expiry with its own
/// entity timestamp and finalized J height. One clock for the whole runtime
/// frame would settle one Entity's HTLC against a neighbour's J height, which
/// is a divergence no root would catch until the frame was already signed.
#[derive(Clone, Debug)]
pub struct EntityWave {
    /// The Entity that owns every account named in `ops`. Checked against each
    /// account's own owner, never trusted.
    pub owner_entity_id: [u8; 32],
    /// The clock this Entity stamps the frames it proposes with.
    pub timestamp: u64,
    pub j_height: u64,
    /// The clock this Entity judges arrivals with.
    pub clock: ReceiverClock,
    pub ops: Vec<WaveOp>,
    /// Whether this Entity proposes once its work is applied. An Entity that
    /// only wants to drain its inbox says no.
    pub propose: bool,
}

/// What the wave produced, against a candidate that is not yet committed.
pub struct WaveResult {
    pub revision: u64,
    pub accounts_root: [u8; 32],
    pub applied: Vec<AccountInputResult>,
    pub proposals: Vec<ProposalRow>,
    /// Every account the wave moved, with the leaf it now commits. The root
    /// alone says that something differs; these say which account does.
    pub touched: Vec<(AccountId, [u8; 32])>,
}

/// The committed store as it was before the wave, kept until the runtime says
/// its own record is durable.
struct PendingWave {
    base_accounts: PersistentRadixMap<AccountConsensus>,
    base_revision: u64,
}

/// One attempt to propose, whether or not it produced a frame. A window where
/// every transaction was rejected still moves the account — the mempool is
/// part of the leaf — so the attempt is reported with no frame rather than
/// not reported at all, or the two engines would silently disagree about a
/// tree they both changed.
pub struct ProposalRow {
    pub account_id: AccountId,
    /// The signed frame, absent when nothing survived the window.
    ///
    /// It carries no outputs: what the frame produced is released with the
    /// peer's ack, never before.
    pub proposed: Option<ProposedRow>,
    /// Every transaction the window could not include, named by the digest of
    /// its canonical form. A count would say that something was dropped
    /// without saying what, which is not enough to compare two engines.
    pub dropped: Vec<DroppedRow>,
}

/// The frame an attempt produced.
pub struct ProposedRow {
    pub frame: AccountFrame,
    pub state_hash: [u8; 32],
    pub hanko: Vec<u8>,
}

impl ProposalRow {
    /// The frame as the counterparty receives it, or `None` when the attempt
    /// produced none.
    pub fn incoming(&self) -> Option<xln_rscore_engine::IncomingFrame> {
        self.proposed
            .as_ref()
            .map(|proposed| xln_rscore_engine::IncomingFrame {
                height: proposed.frame.height,
                timestamp: proposed.frame.timestamp,
                j_height: proposed.frame.j_height,
                txs: proposed.frame.txs.clone(),
                prev_frame_hash: proposed.frame.prev_frame_hash.clone(),
                account_state_root: proposed.frame.account_state_root,
                by_left: proposed.frame.by_left,
                state_hash: proposed.state_hash,
                hanko: proposed.hanko.clone(),
            })
    }
}

/// One transaction the proposal window rejected.
pub struct DroppedRow {
    pub index: usize,
    pub tx_digest: [u8; 32],
    pub code: &'static str,
    pub message: String,
    pub disposition: Disposition,
}

fn dropped_rows(
    account_id: AccountId,
    dropped: &[xln_rscore_engine::DroppedTx],
) -> Result<Vec<DroppedRow>, BatchError> {
    dropped
        .iter()
        .map(|dropped| {
            Ok(DroppedRow {
                index: dropped.index,
                tx_digest: canonical_tx_digest(&dropped.tx)
                    .map_err(|error| state_error(account_id, &error))?,
                code: dropped.rejection.code(),
                message: dropped.rejection.message(),
                disposition: dropped.disposition,
            })
        })
        .collect()
}

/// One account's work returned from the pool: the account it belongs to, the
/// state it reached, and whatever the caller asked for.
type ProposalWork = Result<(AccountId, AccountConsensus, ProposalRow), BatchError>;
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
    /// Registry market tables, installed by the runtime with Hello. Not
    /// account state: they cannot be derived from the tree, and a frame priced
    /// against the wrong tables is a divergence the roots would not catch
    /// until after it is signed.
    swap_market: std::sync::Arc<xln_rscore_engine::SwapMarketPolicy>,
    pending: Option<PendingWave>,
}

impl StatefulConsensusEngine {
    pub fn restore(
        engine_generation: EngineGeneration,
        worker_count: usize,
        revision: u64,
        seed: String,
        signer_id: String,
        swap_market: std::sync::Arc<xln_rscore_engine::SwapMarketPolicy>,
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
            swap_market,
            pending: None,
        };
        engine.upsert_accounts(seeds)?;
        // Seeding is not a state change: the engine comes up at the revision
        // it was restored to, not one past it, or every restart would report a
        // revision the runtime never wrote.
        engine.revision = revision;
        engine.checkpoint_revision = revision;
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
        self.propose_candidates(candidates, timestamp, j_height)
    }

    /// Build, hash and sign one clock's worth of proposals. Split out of
    /// `propose_frames` because a wave proposes per Entity: the accounts are
    /// selected once, then each Entity's group is stamped with its own clock.
    fn propose_candidates(
        &mut self,
        candidates: Vec<(AccountId, AccountConsensus)>,
        timestamp: u64,
        j_height: u64,
    ) -> Result<Vec<ProposalRow>, BatchError> {
        if candidates.is_empty() {
            return Ok(Vec::new());
        }
        let identities = &self.identities;
        let swap_market = &self.swap_market;
        let proposals: Vec<ProposalWork> = self.pool.install(|| {
            candidates
                .into_par_iter()
                .map(|(account_id, mut account)| {
                    let identity = identities
                        .get(account.replica().owner().as_bytes())
                        .ok_or(BatchError::SignerRequired)?;
                    let outcome = propose_account_frame(
                        &mut account,
                        identity,
                        timestamp,
                        j_height,
                        swap_market,
                    )
                    .map_err(|error| state_error(account_id, &error))?;
                    let row = match outcome {
                        ProposalOutcome::Idle { dropped } => ProposalRow {
                            account_id,
                            proposed: None,
                            dropped: dropped_rows(account_id, &dropped)?,
                        },
                        ProposalOutcome::Proposed(proposed) => ProposalRow {
                            account_id,
                            proposed: Some(ProposedRow {
                                frame: proposed.frame,
                                state_hash: proposed.state_hash,
                                hanko: proposed.hanko,
                            }),
                            dropped: dropped_rows(account_id, &proposed.dropped)?,
                        },
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
            rows.push(row);
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
        // The driver matches its own Nth raw input against the Nth verdict, so
        // the indices must be exactly 0..n-1 in order. A duplicate would make
        // two verdicts collide in that map and a gap would shift every later
        // one — either way the comparison would still line up somewhere and
        // report agreement about the wrong input.
        for (position, row) in rows.iter().enumerate() {
            let expected = u32::try_from(position).unwrap_or(u32::MAX);
            if row.input_index != expected {
                return Err(BatchError::InputIndex {
                    actual: row.input_index,
                    expected,
                });
            }
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
        let swap_market = &self.swap_market;
        let applied: Vec<InputWork> = self.pool.install(|| {
            work.into_par_iter()
                .map(|(account_id, mut account, rows)| {
                    let identity = identities
                        .get(account.replica().owner().as_bytes())
                        .ok_or(BatchError::SignerRequired)?;
                    let mut results = Vec::with_capacity(rows.len());
                    for row in rows {
                        let verdict = apply_one(
                            &mut account,
                            identity,
                            &row.from_entity_id,
                            clock,
                            row.kind,
                            swap_market,
                        );
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

    /// Apply every Entity's ordered work, one account per core.
    ///
    /// The order is per account and comes from the request: admissions and
    /// peer inputs interleave inside one runtime frame, so they run in the
    /// sequence the authority observed rather than in two phases. Accounts are
    /// independent of one another, which is where signature verification
    /// parallelises.
    fn run_entity_ops(
        &mut self,
        entities: &[EntityWave],
    ) -> Result<Vec<AccountInputResult>, BatchError> {
        // A second group for the same Entity carries a second clock for it,
        // and the wave would have no single answer about what has expired.
        let mut owners: BTreeSet<[u8; 32]> = BTreeSet::new();
        for entity in entities {
            if !owners.insert(entity.owner_entity_id) {
                return Err(BatchError::WaveEntityDuplicate {
                    entity_id: hex_of(&entity.owner_entity_id),
                });
            }
        }
        // The driver matches its own Nth raw input against the Nth verdict, so
        // the indices must be exactly 0..n-1 in the order they were sent. A
        // duplicate would make two verdicts collide in that map and a gap
        // would shift every later one — either way the comparison would still
        // line up somewhere and report agreement about the wrong input.
        let mut expected: u32 = 0;
        for entity in entities {
            for op in &entity.ops {
                let WaveOp::Input(row) = op else { continue };
                if row.input_index != expected {
                    return Err(BatchError::InputIndex {
                        actual: row.input_index,
                        expected,
                    });
                }
                expected = expected.saturating_add(1);
            }
        }
        struct AccountWork {
            clock: ReceiverClock,
            ops: Vec<WaveOp>,
        }
        let mut work: BTreeMap<AccountId, AccountWork> = BTreeMap::new();
        let mut missing: Vec<AccountInputResult> = Vec::new();
        for entity in entities {
            for op in &entity.ops {
                let account_id = op.account_id();
                let Some(account) = self.accounts.get(account_id.as_bytes()) else {
                    match op {
                        // An input for an account this engine does not hold is
                        // reported as a verdict; the runtime decides what to do
                        // with it.
                        WaveOp::Input(row) => {
                            missing.push(AccountInputResult {
                                input_index: row.input_index,
                                account_id,
                                verdict: AccountInputVerdict::Failed(format!(
                                    "RSCORE_CONSENSUS_ACCOUNT_NOT_FOUND:{}",
                                    hex_of(account_id.as_bytes())
                                )),
                            });
                            continue;
                        }
                        // Nothing could have queued a transaction for an
                        // account that does not exist: that is a driver bug,
                        // not a rejected input.
                        WaveOp::Admit { .. } => {
                            return Err(BatchError::AccountNotFound {
                                input_index: 0,
                                account_id,
                            });
                        }
                    }
                };
                // The group says who owns this account, and so does the
                // account. The engine believes the account.
                if account.replica().owner().as_bytes() != &entity.owner_entity_id {
                    return Err(BatchError::WaveAccountOwner {
                        account_id,
                        entity_id: hex_of(&entity.owner_entity_id),
                    });
                }
                work.entry(account_id)
                    .or_insert_with(|| AccountWork {
                        clock: entity.clock,
                        ops: Vec::new(),
                    })
                    .ops
                    .push(op.clone());
            }
        }
        if work.is_empty() {
            return Ok(missing);
        }
        let units: Vec<(AccountId, AccountConsensus, AccountWork)> = work
            .into_iter()
            .map(|(account_id, unit)| {
                let account = self
                    .accounts
                    .get(account_id.as_bytes())
                    .expect("presence checked above")
                    .clone();
                (account_id, account, unit)
            })
            .collect();
        let identities = &self.identities;
        let swap_market = &self.swap_market;
        let applied: Vec<InputWork> = self.pool.install(|| {
            units
                .into_par_iter()
                .map(|(account_id, mut account, unit)| {
                    let identity = identities
                        .get(account.replica().owner().as_bytes())
                        .ok_or(BatchError::SignerRequired)?;
                    let AccountWork { clock, ops } = unit;
                    let mut results = Vec::new();
                    for op in ops {
                        match op {
                            WaveOp::Admit { txs, .. } => account
                                .admit_txs(txs, "rscoreConsensus:admit")
                                .map_err(|error| state_error(account_id, &error))?,
                            WaveOp::Input(row) => {
                                let verdict = apply_one(
                                    &mut account,
                                    identity,
                                    &row.from_entity_id,
                                    clock,
                                    row.kind,
                                    swap_market,
                                );
                                results.push(AccountInputResult {
                                    input_index: row.input_index,
                                    account_id,
                                    verdict,
                                });
                            }
                        }
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
        if !entries.is_empty() {
            self.accounts = self.put_accounts(entries)?;
            self.revision += 1;
        }
        results.sort_by_key(|result| result.input_index);
        Ok(results)
    }

    /// Propose for every Entity in the wave that asked to, each stamped with
    /// its own clock. An Entity that is not in this wave carries no clock here
    /// and proposes nothing, however proposable its accounts look.
    fn propose_for_entities(
        &mut self,
        entities: &[EntityWave],
    ) -> Result<Vec<ProposalRow>, BatchError> {
        let mut clocks: BTreeMap<[u8; 32], (u64, u64)> = BTreeMap::new();
        for entity in entities {
            if entity.propose {
                clocks.insert(entity.owner_entity_id, (entity.timestamp, entity.j_height));
            }
        }
        if clocks.is_empty() {
            return Ok(Vec::new());
        }
        let mut by_owner: BTreeMap<[u8; 32], Vec<(AccountId, AccountConsensus)>> = BTreeMap::new();
        for (key, account) in self.accounts.iter() {
            if !proposable(account) {
                continue;
            }
            let owner = *account.replica().owner().as_bytes();
            if !clocks.contains_key(&owner) {
                continue;
            }
            by_owner
                .entry(owner)
                .or_default()
                .push((AccountId::from_key(key), account.clone()));
        }
        let mut rows = Vec::new();
        for (owner, candidates) in by_owner {
            let (timestamp, j_height) = clocks
                .get(&owner)
                .copied()
                .expect("owner selected from the same map");
            rows.extend(self.propose_candidates(candidates, timestamp, j_height)?);
        }
        rows.sort_by_key(|row| *row.account_id.as_bytes());
        Ok(rows)
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
        let WaveRequest { entities } = request;
        let mut touched: BTreeSet<AccountId> = BTreeSet::new();
        for entity in &entities {
            touched.extend(entity.ops.iter().map(WaveOp::account_id));
        }
        let applied = self.run_entity_ops(&entities)?;
        let proposals = self.propose_for_entities(&entities)?;
        touched.extend(proposals.iter().map(|row| row.account_id));
        let mut leaves = Vec::with_capacity(touched.len());
        for account_id in touched {
            let Some(account) = self.accounts.get(account_id.as_bytes()) else {
                // An input for an account this engine does not hold is
                // reported as a verdict, not as a leaf.
                continue;
            };
            leaves.push((account_id, leaf_root(account_id, account)?));
        }
        Ok(WaveResult {
            revision: self.revision,
            accounts_root: self.accounts.root_hash(),
            applied,
            proposals,
            touched: leaves,
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
        let identity = self.derive_identity(entity_id, signer_id)?;
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
            token: self.checkpoint_token()?,
            accounts,
            removed,
        })
    }

    /// The token for the state as it stands: what a restore must reproduce.
    pub fn checkpoint_token(&self) -> Result<CheckpointToken, BatchError> {
        Ok(CheckpointToken {
            base_revision: self.checkpoint_revision,
            revision: self.revision,
            accounts_root: self.accounts.root_hash(),
            signer_digest: self.signer_digest()?,
            account_count: self.accounts.len(),
        })
    }

    fn signer_digest(&self) -> Result<[u8; 32], BatchError> {
        let mut rows = Vec::with_capacity(self.accounts.len());
        for (key, account) in self.accounts.iter() {
            let owner = account.replica().owner();
            let signer_id = self
                .signer_of(owner.as_bytes())
                .ok_or(BatchError::SignerRequired)?;
            rows.push((account_id_of(key)?, *owner.as_bytes(), signer_id));
        }
        Ok(crate::checkpoint::signer_digest(rows.into_iter()))
    }

    /// Accept a checkpoint the runtime has made durable.
    ///
    /// The token must be the one that was read: a revision alone would let an
    /// acknowledgement land on a different checkpoint — same number, different
    /// accounts, or the same accounts signed by someone else.
    pub fn commit_checkpoint(&mut self, token: &CheckpointToken) -> Result<(), BatchError> {
        self.assert_no_pending_wave()?;
        let current = self.checkpoint_token()?;
        if *token != current {
            return Err(BatchError::CheckpointToken {
                actual: format!(
                    "{}:{}:{}",
                    token.revision,
                    hex_of(&token.accounts_root),
                    hex_of(&token.signer_digest)
                ),
                expected: format!(
                    "{}:{}:{}",
                    current.revision,
                    hex_of(&current.accounts_root),
                    hex_of(&current.signer_digest)
                ),
            });
        }
        self.checkpoint = self.accounts.clone();
        self.checkpoint_revision = current.revision;
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
        // Everything is built beside the live store. A restore that fails must
        // leave this engine exactly as it was, not half-loaded from a database
        // that turned out not to match.
        let mut identities: BTreeMap<[u8; 32], SigningIdentity> = BTreeMap::new();
        let mut signer_rows = Vec::with_capacity(rows.len());
        let mut entries = Vec::with_capacity(rows.len());
        for row in rows {
            let owner = *row.replica.owner().as_bytes();
            let identity = self.derive_identity(owner, &row.signer_id)?;
            identities.insert(owner, identity);
            let account = AccountConsensus::restore_from_checkpoint(
                row.replica,
                row.consensus,
                &self.swap_market,
            )
            .map_err(|error| state_error(row.account_id, &error))?;
            let leaf = leaf_root(row.account_id, &account)?;
            if leaf != row.account_leaf {
                return Err(BatchError::CheckpointAccountLeaf {
                    account_id: row.account_id,
                    actual: hex_of(&leaf),
                    expected: hex_of(&row.account_leaf),
                });
            }
            signer_rows.push((row.account_id, owner, row.signer_id));
            entries.push((row.account_id.as_bytes().to_vec(), account, leaf));
        }
        let restored = self.put_into(&PersistentRadixMap::empty(), entries)?;
        let root = restored.root_hash();
        if root != expected.accounts_root {
            return Err(BatchError::CheckpointRoot {
                actual: hex_of(&root),
                expected: hex_of(&expected.accounts_root),
            });
        }
        let digest = crate::checkpoint::signer_digest(
            signer_rows
                .iter()
                .map(|(account_id, owner, signer_id)| (*account_id, *owner, signer_id.as_str())),
        );
        if digest != expected.signer_digest {
            return Err(BatchError::CheckpointSignerDigest {
                actual: hex_of(&digest),
                expected: hex_of(&expected.signer_digest),
            });
        }
        // Only now, with every check passed, does this become the engine.
        self.accounts = restored;
        self.identities = identities;
        self.revision = expected.revision;
        self.checkpoint = self.accounts.clone();
        self.checkpoint_revision = expected.revision;
        Ok(root)
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
        let identity = self.derive_identity(*entity_id, &signer_id)?;
        self.identities.insert(*entity_id, identity);
        Ok(())
    }

    /// Derive the key for one entity and prove it belongs to it. The proof is
    /// the lazy entity id: it is the hash of the board this key alone defines,
    /// so a signer id that is not this entity's cannot pass.
    fn derive_identity(
        &self,
        entity_id: [u8; 32],
        signer_id: &str,
    ) -> Result<SigningIdentity, BatchError> {
        let identity = SigningIdentity::from_seed(
            &self.seed,
            signer_id,
            entity_id,
            1,
            1,
            BoardDelays::default(),
        )
        .map_err(|error| BatchError::Signing(error.to_string()))?;
        if !identity.binds_lazy_entity() {
            return Err(BatchError::SignerUnknownEntity {
                entity_id: hex_of(&entity_id),
            });
        }
        Ok(identity)
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
        self.put_into(&self.accounts, entries)
    }

    /// The same batched write against any base, so a restore can build its
    /// tree without the live one having to be replaced first.
    fn put_into(
        &self,
        base: &PersistentRadixMap<AccountConsensus>,
        entries: Vec<(Vec<u8>, AccountConsensus, [u8; 32])>,
    ) -> Result<PersistentRadixMap<AccountConsensus>, BatchError> {
        base.updated_batch(entries, |slots| {
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
    swap_market: &std::sync::Arc<xln_rscore_engine::SwapMarketPolicy>,
) -> AccountInputVerdict {
    match kind {
        AccountInputKind::Frame(frame) => {
            match apply_incoming_frame(
                account,
                identity,
                from_entity_id,
                clock,
                *frame,
                swap_market,
            ) {
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

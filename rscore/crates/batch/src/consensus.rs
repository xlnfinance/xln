//! The authoritative account store: replicas the engine itself drives.
//!
//! The mirror engine in `stateful.rs` applies transitions the runtime already
//! decided. This one owns the accounts instead — their mempools, their frames
//! and their signatures — so a wave costs one message rather than one replica
//! shell per frame. Both keep the same commitment: a radix-16 Patricia tree
//! keyed by account id, leaf digest = the Entity's account leaf.

use std::collections::BTreeMap;

use rayon::prelude::*;
use rayon::{ThreadPool, ThreadPoolBuilder};
use xln_rscore_engine::{
    AccountConsensus, AccountFrame, AccountOutput, AckOutcome, BoardDelays, IncomingFrame,
    IncomingOutcome, ProposalOutcome, SigningIdentity, StateError, apply_incoming_ack,
    apply_incoming_frame, propose_account_frame,
};
use xln_rscore_protocol::PersistentRadixMap;

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
pub struct ProposalRow {
    pub account_id: AccountId,
    pub frame: AccountFrame,
    pub state_hash: [u8; 32],
    pub hanko: Vec<u8>,
    pub outputs: Vec<AccountOutput>,
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
    /// The runtime seed and signer this process signs with. Every account
    /// derives its identity from them, bound to its own owner entity.
    seed: String,
    signer_id: String,
    identities: BTreeMap<[u8; 32], SigningIdentity>,
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
            seed,
            signer_id,
            identities: BTreeMap::new(),
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
        let mut entries = Vec::with_capacity(seeds.len());
        for seed in seeds {
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
    pub fn admit_txs(
        &mut self,
        requests: Vec<(AccountId, Vec<xln_rscore_engine::AccountTx>)>,
    ) -> Result<[u8; 32], BatchError> {
        let mut entries = Vec::with_capacity(requests.len());
        for (account_id, txs) in requests {
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
                            outputs: proposed.outputs,
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
    pub fn apply_inputs(
        &mut self,
        rows: Vec<AccountInputRow>,
    ) -> Result<Vec<AccountInputResult>, BatchError> {
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
                            apply_one(&mut account, identity, &row.from_entity_id, row.kind);
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

    fn ensure_identity(&mut self, entity_id: &[u8; 32]) -> Result<(), BatchError> {
        if self.identities.contains_key(entity_id) {
            return Ok(());
        }
        let signer_id = self.signer_id.clone();
        self.register_signer(*entity_id, &signer_id)
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
    kind: AccountInputKind,
) -> AccountInputVerdict {
    match kind {
        AccountInputKind::Frame(frame) => {
            match apply_incoming_frame(account, identity, from_entity_id, *frame) {
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

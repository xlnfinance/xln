//! One Entity input's two visits to the Account layer.
//!
//! An Entity frame touches its accounts exactly twice. On the way in it hands
//! over everything that arrived from peers; the accounts apply it, sharded by
//! account across the pool, and hand back what happened. The Entity then runs
//! its own payment and order-book logic on those events, and on the way out it
//! hands over the transactions that logic produced and names the accounts that
//! should now propose. The second visit returns what to send onward.
//!
//! There is nothing between the two: no per-operation call, no staged
//! candidate, no account body crossing back so the caller can re-derive what
//! the engine already committed.

use std::collections::{BTreeMap, BTreeSet};

use xln_rscore_engine::{AccountTx, ReceiverClock};
use xln_rscore_protocol::PersistentRadixMap;

use crate::checkpoint::{AccountCheckpointRows, account_rows};
use crate::consensus::{
    AccountAdmissionResult, AccountAdmissionVerdict, AccountInputResult, AccountInputRow,
    ProposalRow, StatefulConsensusEngine, leaf_root, state_error,
};
use crate::error::BatchError;
use crate::types::{AccountId, AccountSeed};
use xln_rscore_engine::{AccountConsensus, SigningIdentity};

fn hex_of(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut text, byte| {
        let _ = write!(text, "{byte:02x}");
        text
    })
}

/// The committed tree as it stood when something abortable opened.
///
/// A Runtime frame is one transaction, and so is each Entity input inside it:
/// either can be abandoned after its accounts have already moved. Savepoints
/// nest for exactly that reason. The tree is persistent, so holding one costs
/// a pointer, not a copy.
pub(crate) struct RuntimeSavepoint {
    accounts: PersistentRadixMap<AccountConsensus>,
    identities: BTreeMap<[u8; 32], SigningIdentity>,
    revision: u64,
}

impl RuntimeSavepoint {
    pub(crate) fn into_parts(
        self,
    ) -> (
        PersistentRadixMap<AccountConsensus>,
        BTreeMap<[u8; 32], SigningIdentity>,
        u64,
    ) {
        (self.accounts, self.identities, self.revision)
    }
}

/// Everything one Entity input carries inward.
#[derive(Debug)]
pub struct EntityInboundRequest {
    /// The Entity that owns every named account. Checked, never trusted.
    pub owner_entity_id: [u8; 32],
    /// The clock this Entity judges arrivals with.
    pub clock: ReceiverClock,
    pub rows: Vec<AccountInputRow>,
    pub post_accounts: bool,
}

/// Everything one Entity input carries outward.
#[derive(Debug)]
pub struct EntityOutboundRequest {
    pub owner_entity_id: [u8; 32],
    /// The clock this Entity stamps the frames it proposes with.
    pub timestamp: u64,
    pub j_height: u64,
    /// Accounts created at financial genesis by this Entity input.
    pub creates: Vec<AccountSeed>,
    /// Transactions the Entity's own logic produced, per account.
    pub admits: Vec<(AccountId, Vec<AccountTx>)>,
    /// The accounts asked to propose once their transactions are queued.
    pub propose: Vec<AccountId>,
    pub post_accounts: bool,
}

/// What one visit changed.
#[derive(Default)]
pub struct EntityRoundResult {
    pub revision: u64,
    pub accounts_root: [u8; 32],
    pub applied: Vec<AccountInputResult>,
    pub admissions: Vec<AccountAdmissionResult>,
    pub proposals: Vec<ProposalRow>,
    /// Every named account whose leaf moved, with the leaf it now commits.
    pub touched: Vec<(AccountId, [u8; 32])>,
    /// Node changes for the touched accounts, when the caller asked for them.
    pub post_accounts: Vec<AccountCheckpointRows>,
}

/// Phase timers, printed to stderr when XLN_RSCORE_PHASE_LOG is set.
///
/// Diagnostic only: the caller measures the round as a whole, and this says
/// which half of it the time went to.
pub mod phase {
    use std::sync::atomic::{AtomicU64, Ordering};
    pub static APPLY: AtomicU64 = AtomicU64::new(0);
    pub static ADMIT: AtomicU64 = AtomicU64::new(0);
    pub static PROPOSE: AtomicU64 = AtomicU64::new(0);
    pub static SETTLE: AtomicU64 = AtomicU64::new(0);
    pub static SNAPSHOT: AtomicU64 = AtomicU64::new(0);
    pub static ROUNDS: AtomicU64 = AtomicU64::new(0);

    pub fn enabled() -> bool {
        static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        *ON.get_or_init(|| std::env::var("XLN_RSCORE_PHASE_LOG").as_deref() == Ok("1"))
    }

    pub fn add(counter: &AtomicU64, started: std::time::Instant) {
        if !enabled() {
            return;
        }
        counter.fetch_add(started.elapsed().as_micros() as u64, Ordering::Relaxed);
    }

    pub fn tick() {
        if !enabled() {
            return;
        }
        let rounds = ROUNDS.fetch_add(1, Ordering::Relaxed) + 1;
        if rounds % 4000 != 0 {
            return;
        }
        eprintln!(
            "PHASE rounds={rounds} apply={} admit={} propose={} settle={} snapshot={}",
            APPLY.load(Ordering::Relaxed),
            ADMIT.load(Ordering::Relaxed),
            PROPOSE.load(Ordering::Relaxed),
            SETTLE.load(Ordering::Relaxed),
            SNAPSHOT.load(Ordering::Relaxed),
        );
    }
}

impl StatefulConsensusEngine {
    /// Mark a point every account can be put back to.
    pub fn push_savepoint(&mut self) -> Result<(u64, [u8; 32]), BatchError> {
        let savepoint = RuntimeSavepoint {
            accounts: self.accounts_snapshot(),
            identities: self.identities_snapshot(),
            revision: self.revision(),
        };
        self.savepoints_mut().push(savepoint);
        Ok((self.revision(), self.accounts_root()))
    }

    /// Keep everything done since the innermost savepoint.
    pub fn keep_savepoint(&mut self) -> Result<(u64, [u8; 32]), BatchError> {
        if self.savepoints_mut().pop().is_none() {
            return Err(BatchError::WaveMissing);
        }
        Ok((self.revision(), self.accounts_root()))
    }

    /// Put every account back to the innermost savepoint.
    pub fn undo_savepoint(&mut self) -> Result<(u64, [u8; 32]), BatchError> {
        let savepoint = self.savepoints_mut().pop().ok_or(BatchError::WaveMissing)?;
        self.restore_savepoint(savepoint);
        Ok((self.revision(), self.accounts_root()))
    }

    /// Apply everything that arrived from peers and report what happened.
    pub fn entity_inbound(
        &mut self,
        request: EntityInboundRequest,
    ) -> Result<EntityRoundResult, BatchError> {
        let named: BTreeSet<AccountId> = request.rows.iter().map(|row| row.account_id).collect();
        self.assert_owner(request.owner_entity_id, &named)?;
        let snapshot_at = std::time::Instant::now();
        let base = self.accounts_snapshot();
        phase::add(&phase::SNAPSHOT, snapshot_at);
        let apply_at = std::time::Instant::now();
        let applied = self.apply_inputs(request.clock, request.rows)?;
        phase::add(&phase::APPLY, apply_at);
        let settle_at = std::time::Instant::now();
        let mut result = self.settle(&base, &named, request.post_accounts)?;
        phase::add(&phase::SETTLE, settle_at);
        phase::tick();
        result.applied = applied;
        Ok(result)
    }

    /// Queue what the Entity decided, propose, and report what to send onward.
    pub fn entity_outbound(
        &mut self,
        request: EntityOutboundRequest,
    ) -> Result<EntityRoundResult, BatchError> {
        let mut named: BTreeSet<AccountId> =
            request.creates.iter().map(|seed| seed.account_id).collect();
        named.extend(request.admits.iter().map(|(account_id, _)| *account_id));
        named.extend(request.propose.iter().copied());
        let created: BTreeSet<AccountId> =
            request.creates.iter().map(|seed| seed.account_id).collect();
        self.assert_owner(
            request.owner_entity_id,
            &named.difference(&created).copied().collect(),
        )?;
        let snapshot_at = std::time::Instant::now();
        let base = self.accounts_snapshot();
        phase::add(&phase::SNAPSHOT, snapshot_at);
        if !request.creates.is_empty() {
            self.upsert_accounts(request.creates)?;
        }
        let admit_at = std::time::Instant::now();
        let admissions = self.admit_named(request.admits)?;
        phase::add(&phase::ADMIT, admit_at);
        let propose_at = std::time::Instant::now();
        let proposals = if request.propose.is_empty() {
            Vec::new()
        } else {
            self.propose_frames(request.timestamp, request.j_height, Some(&request.propose))?
        };
        phase::add(&phase::PROPOSE, propose_at);
        let settle_at = std::time::Instant::now();
        let mut result = self.settle(&base, &named, request.post_accounts)?;
        phase::add(&phase::SETTLE, settle_at);
        phase::tick();
        result.admissions = admissions;
        result.proposals = proposals;
        Ok(result)
    }

    /// Queue the Entity's own transactions and say how many each account took.
    fn admit_named(
        &mut self,
        admits: Vec<(AccountId, Vec<AccountTx>)>,
    ) -> Result<Vec<AccountAdmissionResult>, BatchError> {
        if admits.is_empty() {
            return Ok(Vec::new());
        }
        let counted: Vec<(AccountId, usize)> = admits
            .iter()
            .map(|(account_id, txs)| (*account_id, txs.len()))
            .collect();
        self.admit_txs(admits)?;
        Ok(counted
            .into_iter()
            .enumerate()
            .map(|(index, (account_id, count))| AccountAdmissionResult {
                operation_index: index as u64,
                account_id,
                verdict: AccountAdmissionVerdict::Admitted { count },
            })
            .collect())
    }

    /// Refuse an account this Entity does not own before anything executes.
    fn assert_owner(
        &self,
        owner_entity_id: [u8; 32],
        named: &BTreeSet<AccountId>,
    ) -> Result<(), BatchError> {
        for account_id in named {
            let Some(account) = self.account(account_id) else {
                return Err(BatchError::AccountNotFound {
                    input_index: 0,
                    account_id: *account_id,
                });
            };
            if account.replica().owner().as_bytes() != &owner_entity_id {
                return Err(BatchError::WaveAccountOwner {
                    account_id: *account_id,
                    entity_id: hex_of(&owner_entity_id),
                });
            }
        }
        Ok(())
    }

    /// Collect the leaf, and the changes, of every account the round named.
    ///
    /// Named rather than moved: an arrival the account refused still has to
    /// answer with the leaf the Entity commits for it, and the caller reads
    /// its own copy back from the same row either way.
    fn settle(
        &self,
        base: &PersistentRadixMap<AccountConsensus>,
        named: &BTreeSet<AccountId>,
        post_accounts: bool,
    ) -> Result<EntityRoundResult, BatchError> {
        let mut result = EntityRoundResult {
            revision: self.revision(),
            accounts_root: self.accounts_root(),
            ..EntityRoundResult::default()
        };
        for account_id in named {
            let Some(account) = self.account(account_id) else {
                continue;
            };
            let leaf = leaf_root(*account_id, account)?;
            let previous = base.get(account_id.as_bytes());
            result.touched.push((*account_id, leaf));
            if post_accounts {
                result.post_accounts.push(
                    account_rows(*account_id, account, previous, leaf, self.signer_id())
                        .map_err(|error| state_error(*account_id, &error))?,
                );
            }
        }
        Ok(result)
    }
}

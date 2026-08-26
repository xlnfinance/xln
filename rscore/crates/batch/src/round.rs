//! One Entity input's two visits to the Account layer.
//!
//! An Entity frame touches its accounts exactly twice. On the way in it hands
//! over everything that arrived from peers; the accounts apply it, sharded by
//! account across the pool, and hand back what happened. The Entity then runs
//! its own payment and order-book logic on those events, and on the way out it
//! hands over the transactions that logic produced and names the accounts that
//! should now propose. The second visit returns what to send onward.
//!
//! There is no per-operation call between the two. The inbound visit may return
//! the changed Account bodies because Entity order-book and routing logic read
//! that post-inbound state. The outbound visit returns the final bodies and
//! effects that the parent commits and routes.

use std::collections::{BTreeMap, BTreeSet};

use xln_rscore_engine::{AccountTx, ReceiverClock};
use xln_rscore_protocol::PersistentRadixMap;

use crate::checkpoint::{AccountCheckpointRows, account_rows};
use crate::consensus::{
    AccountAdmissionResult, AccountInputResult, AccountInputRow, ProposalRow,
    StatefulConsensusEngine, state_error,
};
use crate::error::BatchError;
use crate::fanout::map_accounts;
use crate::types::{AccountId, AccountSeed};
use xln_rscore_engine::{AccountConsensus, SigningIdentity};

fn hex_of(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut text, byte| {
        let _ = write!(text, "{byte:02x}");
        text
    })
}

pub(crate) struct EntityRoundBase {
    owner_entity_id: [u8; 32],
    base_accounts: PersistentRadixMap<AccountConsensus>,
    base_identities: BTreeMap<[u8; 32], SigningIdentity>,
    base_revision: u64,
    inbound_accounts: PersistentRadixMap<AccountConsensus>,
    inbound_revision: u64,
    complete: bool,
}

/// Everything one Entity input carries inward.
#[derive(Debug)]
pub struct EntityInboundRequest {
    /// The Entity that owns every named account. Checked, never trusted.
    pub owner_entity_id: [u8; 32],
    /// The Account-forest root held by the parent Entity before this attempt.
    /// A prior path-copy candidate is accepted or dropped from this assertion;
    /// there is deliberately no separate Commit/Abort command.
    pub expected_accounts_root: [u8; 32],
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
    /// Accounts changed on the inbound visit whose final bodies the parent
    /// needs only after all Entity-derived work has run.
    pub materialize: Vec<AccountId>,
    /// Active forwarded-payment routes whose downstream Account may reject a
    /// lock during this proposal pass. These are Entity-owned routing facts,
    /// supplied before execution so Rust can enqueue the exact upstream
    /// resolve and finish the canonical worklist without a third process call.
    pub failed_htlc_routes: Vec<FailedHtlcRoute>,
    pub post_accounts: bool,
}

#[derive(Clone, Debug)]
pub struct FailedHtlcRoute {
    pub hashlock: [u8; 32],
    pub outbound_account_id: AccountId,
    pub outbound_lock_id: String,
    pub inbound_account_id: AccountId,
    pub inbound_lock_id: String,
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
    pub static OUTBOUND: AtomicU64 = AtomicU64::new(0);
    pub static SETTLE: AtomicU64 = AtomicU64::new(0);
    pub static SNAPSHOT: AtomicU64 = AtomicU64::new(0);
    pub static ROUNDS: AtomicU64 = AtomicU64::new(0);

    pub fn enabled() -> bool {
        static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        *ON.get_or_init(|| std::env::var("XLN_RSCORE_PHASE_LOG").as_deref() == Ok("1"))
    }

    fn log_every() -> u64 {
        static EVERY: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
        *EVERY.get_or_init(|| {
            std::env::var("XLN_RSCORE_PHASE_LOG_EVERY")
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|value| *value > 0)
                .unwrap_or(4_000)
        })
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
        if !rounds.is_multiple_of(log_every()) {
            return;
        }
        eprintln!(
            "PHASE rounds={rounds} apply={} outbound={} settle={} snapshot={}",
            APPLY.load(Ordering::Relaxed),
            OUTBOUND.load(Ordering::Relaxed),
            SETTLE.load(Ordering::Relaxed),
            SNAPSHOT.load(Ordering::Relaxed),
        );
    }
}

impl StatefulConsensusEngine {
    /// Reconcile the previous attempt from the parent Entity's canonical head.
    ///
    /// A completed candidate whose root became the parent's head is promoted
    /// by dropping only its base pointer. If the parent still names the base,
    /// the candidate is discarded by restoring that pointer. An inbound-only
    /// attempt is never a candidate and is always restored before retry.
    pub fn reconcile_parent_accounts_root(&mut self, expected: [u8; 32]) -> Result<(), BatchError> {
        let Some(round) = self.take_entity_round_base() else {
            let actual = self.accounts_root();
            return if actual == expected {
                Ok(())
            } else {
                Err(BatchError::EntityHeadRoot {
                    actual: hex_of(&expected),
                    base: hex_of(&actual),
                    candidate: hex_of(&actual),
                })
            };
        };
        let base_root = round.base_accounts.root_hash();
        let candidate_root = self.accounts_root();
        if round.complete && expected == candidate_root {
            return Ok(());
        }
        if expected == base_root {
            self.restore_entity_snapshot(
                round.base_accounts,
                round.base_identities,
                round.base_revision,
            );
            return Ok(());
        }
        self.set_entity_round_base(round);
        Err(BatchError::EntityHeadRoot {
            actual: hex_of(&expected),
            base: hex_of(&base_root),
            candidate: hex_of(&candidate_root),
        })
    }

    fn restore_entity_round_base(&mut self) {
        if let Some(round) = self.take_entity_round_base() {
            self.restore_entity_snapshot(
                round.base_accounts,
                round.base_identities,
                round.base_revision,
            );
        }
    }

    fn restore_entity_round_inbound(&mut self) {
        let Some(mut round) = self.take_entity_round_base() else {
            return;
        };
        self.restore_entity_snapshot(
            round.inbound_accounts.clone(),
            round.base_identities.clone(),
            round.inbound_revision,
        );
        round.complete = false;
        self.set_entity_round_base(round);
    }

    /// Apply everything that arrived from peers and report what happened.
    pub fn entity_inbound(
        &mut self,
        request: EntityInboundRequest,
    ) -> Result<EntityRoundResult, BatchError> {
        self.reconcile_parent_accounts_root(request.expected_accounts_root)?;
        let named: BTreeSet<AccountId> = request.rows.iter().map(|row| row.account_id).collect();
        self.assert_owner(request.owner_entity_id, &named)?;
        let snapshot_at = std::time::Instant::now();
        let base = self.accounts_snapshot();
        let base_identities = self.identities_snapshot();
        let base_revision = self.revision();
        self.set_entity_round_base(EntityRoundBase {
            owner_entity_id: request.owner_entity_id,
            base_accounts: base.clone(),
            base_identities,
            base_revision,
            inbound_accounts: base.clone(),
            inbound_revision: base_revision,
            complete: false,
        });
        phase::add(&phase::SNAPSHOT, snapshot_at);
        let outcome = (|| {
            let apply_at = std::time::Instant::now();
            let applied = self.apply_inputs(request.clock, request.rows)?;
            phase::add(&phase::APPLY, apply_at);
            let inbound_accounts = self.accounts_snapshot();
            let inbound_revision = self.revision();
            let mut round = self
                .take_entity_round_base()
                .ok_or(BatchError::EntityRoundMissing)?;
            round.inbound_accounts = inbound_accounts;
            round.inbound_revision = inbound_revision;
            self.set_entity_round_base(round);
            let settle_at = std::time::Instant::now();
            let mut result = self.settle(&base, &named, request.post_accounts)?;
            phase::add(&phase::SETTLE, settle_at);
            phase::tick();
            result.applied = applied;
            Ok(result)
        })();
        if outcome.is_err() {
            self.restore_entity_round_base();
        }
        outcome
    }

    /// Queue what the Entity decided, propose, and report what to send onward.
    pub fn entity_outbound(
        &mut self,
        request: EntityOutboundRequest,
    ) -> Result<EntityRoundResult, BatchError> {
        let EntityOutboundRequest {
            owner_entity_id,
            timestamp,
            j_height,
            creates,
            admits,
            propose,
            materialize,
            failed_htlc_routes,
            post_accounts,
        } = request;
        let mut named: BTreeSet<AccountId> = creates.iter().map(|seed| seed.account_id).collect();
        named.extend(admits.iter().map(|(account_id, _)| *account_id));
        named.extend(propose.iter().copied());
        named.extend(materialize.iter().copied());
        for route in &failed_htlc_routes {
            named.insert(route.outbound_account_id);
            named.insert(route.inbound_account_id);
        }
        let created: BTreeSet<AccountId> = creates.iter().map(|seed| seed.account_id).collect();
        self.assert_owner(
            owner_entity_id,
            &named.difference(&created).copied().collect(),
        )?;
        let round = self
            .entity_round_base()
            .ok_or(BatchError::EntityRoundMissing)?;
        if round.owner_entity_id != owner_entity_id {
            return Err(BatchError::EntityRoundOwner {
                actual: hex_of(&owner_entity_id),
                expected: hex_of(&round.owner_entity_id),
            });
        }
        let snapshot_at = std::time::Instant::now();
        let base = round.base_accounts.clone();
        phase::add(&phase::SNAPSHOT, snapshot_at);
        let outcome = (|| {
            if !creates.is_empty() {
                self.upsert_accounts(creates.clone())?;
            }
            let outbound_at = std::time::Instant::now();
            let (mut admissions, mut proposals) =
                self.admit_and_propose(admits.clone(), &propose, timestamp, j_height)?;
            if Self::proposals_need_htlc_followup(&proposals, &failed_htlc_routes)? {
                self.restore_entity_round_inbound();
                if !creates.is_empty() {
                    self.upsert_accounts(creates)?;
                }
                let (ordered_admissions, ordered_proposals, generated_accounts) = self
                    .admit_and_propose_htlc_fixed_point(
                        admits,
                        &propose,
                        timestamp,
                        j_height,
                        &failed_htlc_routes,
                    )?;
                admissions = ordered_admissions;
                proposals = ordered_proposals;
                named.extend(generated_accounts);
            }
            phase::add(&phase::OUTBOUND, outbound_at);
            let settle_at = std::time::Instant::now();
            let mut result = self.settle(&base, &named, post_accounts)?;
            phase::add(&phase::SETTLE, settle_at);
            phase::tick();
            result.admissions = admissions;
            result.proposals = proposals;
            let mut round = self
                .take_entity_round_base()
                .ok_or(BatchError::EntityRoundMissing)?;
            round.complete = true;
            self.set_entity_round_base(round);
            Ok(result)
        })();
        if outcome.is_err() {
            self.restore_entity_round_inbound();
        }
        outcome
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
        let ids = named.iter().copied().collect::<Vec<_>>();
        let settled = map_accounts(
            self.pool(),
            ids,
            |account_id| *account_id,
            |account_id| {
                let Some((account, leaf)) = self.account_with_leaf(&account_id) else {
                    return Ok(None);
                };
                let post_account = if post_accounts {
                    let previous = base.get(account_id.as_bytes());
                    Some(
                        account_rows(account_id, account, previous, leaf, self.signer_id())
                            .map_err(|error| state_error(account_id, &error))?,
                    )
                } else {
                    None
                };
                Ok(Some((account_id, leaf, post_account)))
            },
        );
        for row in settled {
            let Some((account_id, leaf, post_account)) = row? else {
                continue;
            };
            result.touched.push((account_id, leaf));
            if let Some(post_account) = post_account {
                result.post_accounts.push(post_account);
            }
        }
        Ok(result)
    }
}

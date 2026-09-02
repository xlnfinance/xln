//! Canonical two-visit Account authority over permanently resident shards.
//!
//! The parent Entity calls this machine once with peer arrivals and once with
//! the Entity-derived admissions/proposal worklist. Account replicas and every
//! Patricia node below the three-nibble boundary stay in their owner worker;
//! only verdicts, effects, proposal envelopes, and compact shard commitments
//! cross back to the coordinator.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use num_bigint::BigInt;
use xln_rscore_engine::{
    AccountConsensus, AccountProposalSelection, AccountTx, CanonicalValue, SigningIdentity,
    SwapMarketPolicy, SwapOfferSnapshot, TokenId, address_of_private_key,
    propose_account_frame_with_selection,
};

use crate::checkpoint::{AccountCheckpointRows, AccountsCheckpoint, account_rows};
use crate::consensus::{
    AccountAdmissionResult, AccountAdmissionVerdict, AccountInputResult, AccountInputRow,
    ProposalRow, UpstreamHtlcResolutionRow, active, apply_one, apply_one_without_mutation,
    build_signing_identity, force_ack_directive, has_rebalance_work, inbound_genesis_account,
    leaf_root, outbound_ack_input, proposable, proposal_row, restore_checkpoint_account,
    restore_seed_account, state_error, validate_genesis_seed, verdict_commits_genesis,
};
use crate::parallel::{OutboundContinuationKind, ResidentAccountAction, ResidentAccountForest};
use crate::round::{
    BatchAccountSelection, EntityInboundRequest, EntityOutboundRequest, EntityRoundResult,
    FailedHtlcFollowup,
};
use crate::{
    AccountId, AccountRestore, AccountSeed, BatchError, CheckpointToken, EngineGeneration,
    MAX_BATCH_WORKERS,
};

#[derive(Clone)]
struct InboundWork {
    rows: Vec<AccountInputRow>,
}

struct InboundOutcome {
    applied: Vec<AccountInputResult>,
    leaf: [u8; 32],
    created_checkpoint: Option<AccountCheckpointRows>,
    changed: bool,
    proposable: bool,
    has_rebalance_work: bool,
}

/// Borrow the resident head until an Account transition can actually mutate.
/// This keeps duplicate/stale/rejected inputs from deep-cloning the replica,
/// while preserving the existing owned candidate for rollback and Put.
enum CloneOnMutation<'a, T> {
    Borrowed(&'a T),
    Owned(T),
}

impl<'a, T> CloneOnMutation<'a, T> {
    fn as_ref(&self) -> &T {
        match self {
            Self::Borrowed(value) => value,
            Self::Owned(value) => value,
        }
    }

    fn make_mut(&mut self) -> &mut T
    where
        T: Clone,
    {
        if let Self::Borrowed(value) = self {
            *self = Self::Owned((*value).clone());
        }
        match self {
            Self::Borrowed(_) => unreachable!("borrowed candidate was promoted"),
            Self::Owned(value) => value,
        }
    }

    fn into_owned(self) -> Option<T> {
        match self {
            Self::Borrowed(_) => None,
            Self::Owned(value) => Some(value),
        }
    }
}

#[derive(Clone)]
struct OutboundWork {
    create: Option<AccountSeed>,
    envelope_updates: Vec<crate::AccountEnvelopeUpdate>,
    admissions: Vec<AccountTx>,
    /// `None` is envelope/admission-only work. Admissions are independent and
    /// always applied before this exact post-admission proposal selection.
    proposal_selection: Option<BatchAccountSelection>,
    /// Same-round response obligation only. It is never Account state.
    force_ack: bool,
    seal: bool,
}

struct OutboundOutcome {
    proposal: Option<ProposalRow>,
    proposable: bool,
    has_rebalance_work: bool,
}

struct MaterializedAccount {
    leaf: [u8; 32],
    checkpoint: Option<AccountCheckpointRows>,
}

/// First outbound Account wave retained only until the parent Entity resolves
/// actual failed hashlocks by point lookup. It never crosses process or WAL
/// boundaries and owns no copy of Account state.
pub struct PreparedEntityOutbound {
    owner: [u8; 32],
    identity: Arc<SigningIdentity>,
    identity_is_new: bool,
    timestamp: u64,
    j_height: u64,
    local_board_authority: Option<xln_rscore_engine::CertifiedBoardAuthority>,
    checkpoint_due: bool,
    post_accounts: bool,
    admissions: Vec<AccountAdmissionResult>,
    proposals: Vec<ProposalRow>,
    named: BTreeSet<AccountId>,
    round_leafs: BTreeMap<AccountId, [u8; 32]>,
}

/// One bootstrap-only projection of Account-owned orderbook authorization.
/// It is rebuilt from the resident Account head and is never persisted in the
/// Entity snapshot or committed as a second financial state.
pub struct ResidentOrderbookAccountSnapshot {
    pub account_id: AccountId,
    pub offers: Vec<SwapOfferSnapshot>,
    pub resolving_offer_ids: BTreeSet<String>,
}

impl PreparedEntityOutbound {
    pub fn proposals(&self) -> &[ProposalRow] {
        &self.proposals
    }
}

/// The only Account-state projection local Entity financial admission needs.
/// Account replicas and radix nodes remain resident on their owner workers;
/// the coordinator receives one status bit and requested owner capacities.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResidentAccountFinancialView {
    pub active: bool,
    pub owner_side: xln_rscore_engine::Side,
    pub owner_in_capacity: BTreeMap<TokenId, BigInt>,
    pub owner_out_capacity: BTreeMap<TokenId, BigInt>,
    pub owner_own_credit_limit: BTreeMap<TokenId, BigInt>,
    pub owner_peer_credit_limit: BTreeMap<TokenId, BigInt>,
    pub settlement_workspace: Option<CanonicalValue>,
    pub settlement_transition_pending: bool,
    pub settlement_execution: Result<xln_rscore_engine::PreparedSettlementExecution, String>,
    pub rebalance_active_quote: Option<CanonicalValue>,
    pub htlc_locks: BTreeMap<String, xln_rscore_engine::HtlcLock>,
    pub pulls: BTreeMap<String, CanonicalValue>,
    pub swap_offers: BTreeMap<String, SwapOfferSnapshot>,
    pub pending_cross_pull_close_ids: std::collections::BTreeSet<String>,
    pub pending_cross_swap_ack_ids: std::collections::BTreeSet<String>,
    pub dispute: Option<ResidentAccountDisputeView>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResidentHubRebalanceFeeState {
    pub request_id: String,
    pub fee_paid_upfront: BigInt,
    pub policy_version: u64,
    pub requested_at: u64,
    pub refund: bool,
    pub refunded_amount: Option<BigInt>,
}

/// Bounded projection for the derived rebalance-work IDs only. It is read
/// from the current resident head and never persisted as scheduler state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResidentHubRebalanceAccountView {
    pub pending_frame: bool,
    pub settlement_transition_pending: bool,
    pub settlement_workspace: Option<CanonicalValue>,
    pub requested_rebalance: Vec<(TokenId, BigInt)>,
    pub requested_fee_state: Vec<(TokenId, ResidentHubRebalanceFeeState)>,
    pub submitted_at_by_token: Vec<(u32, u64)>,
    pub deltas: Vec<xln_rscore_engine::Delta>,
    pub owner_side: xln_rscore_engine::Side,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ResidentAccountFinancialViewRequest {
    pub token_ids: Vec<TokenId>,
    pub htlc_lock_ids: Vec<String>,
    pub pull_ids: Vec<String>,
    pub swap_offer_ids: Vec<String>,
    pub dispute: bool,
}

/// Exact pre-round Account facts needed by default-proposer cross-J
/// materialization. Values are point-read from the current resident head;
/// this is not a cache, index, replica copy, or committed state section.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResidentCrossJMaterializationView {
    pub pull_ids: BTreeSet<String>,
    pub swap_offer_ids: BTreeSet<String>,
    pub pending_cross_pull_close_ids: BTreeSet<String>,
}

/// Transient sibling-Account evidence used only while choosing an atomic
/// cross-J opening cohort. The worker returns no ordinary Account traffic and
/// Runtime never persists this projection beside a frame or checkpoint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResidentCrossJOpeningAccountView {
    pub counterparty_entity_id: String,
    pub mempool: Vec<AccountTx>,
    pub pending_frame_txs: Option<Vec<AccountTx>>,
}

fn cross_j_opening_txs(txs: &[AccountTx]) -> Vec<AccountTx> {
    txs.iter()
        .filter(|tx| match tx {
            AccountTx::CrossPullLock {
                data: CanonicalValue::Object(fields),
            } => {
                let has = |name: &str| fields.iter().any(|(field, _)| field == name);
                has("crossJurisdiction") && has("crossJurisdictionRoute")
            }
            AccountTx::SwapOffer {
                cross_jurisdiction, ..
            } => cross_jurisdiction.is_some(),
            _ => false,
        })
        .cloned()
        .collect()
}

fn pending_cross_j_ids(account: &AccountConsensus) -> (BTreeSet<String>, BTreeSet<String>) {
    let canonical_text = |value: &CanonicalValue, name: &str| match value {
        CanonicalValue::Object(fields) => fields.iter().find_map(|(key, value)| {
            (key == name)
                .then_some(value)
                .and_then(|value| match value {
                    CanonicalValue::String(value) => Some(value.clone()),
                    _ => None,
                })
        }),
        _ => None,
    };
    let mut pending_cross_pull_close_ids = BTreeSet::new();
    let mut pending_cross_swap_ack_ids = BTreeSet::new();
    let mut collect = |txs: &[AccountTx]| {
        for tx in txs {
            match tx {
                AccountTx::CrossPullClose { data } => {
                    if let Some(pull_id) = canonical_text(data, "pullId") {
                        pending_cross_pull_close_ids.insert(pull_id);
                    }
                }
                AccountTx::CrossSwapFillAck { data } => {
                    if let Some(offer_id) = canonical_text(data, "offerId") {
                        pending_cross_swap_ack_ids.insert(offer_id);
                    }
                }
                _ => {}
            }
        }
    };
    if let Some(pending) = account.pending() {
        collect(&pending.frame.txs);
    }
    collect(account.mempool());
    (pending_cross_pull_close_ids, pending_cross_swap_ack_ids)
}

/// Point projection for one explicitly disputed Account.  The worker remains
/// the sole owner of Account state; Entity receives only the exact evidence it
/// must place in JBatch and the bounded order/argument plan derived from that
/// same frozen head.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResidentAccountDisputeView {
    pub status: String,
    pub dispute_prepare: Option<CanonicalValue>,
    pub active_dispute: Option<CanonicalValue>,
    pub local_dispute: Option<xln_rscore_engine::DisputeDraft>,
    pub counterparty_dispute: Option<xln_rscore_engine::CounterpartyDispute>,
    pub proof_body: Result<xln_rscore_engine::DisputeProofBody, String>,
    pub j_nonce: u64,
    pub owner_is_left: bool,
    pub delta_transformer: Option<[u8; 20]>,
    pub payment_hashlocks: Vec<String>,
    pub pull_ids: Vec<String>,
    pub pull_count: usize,
    pub swap_offers: Vec<SwapOfferSnapshot>,
    pub pending_swap_fill_ratios: BTreeMap<String, u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingSettlementHankoDraft {
    pub account_id: AccountId,
    pub draft: xln_rscore_engine::SettlementHankoDraft,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeferredSettlementApproval {
    Wait { account_id: AccountId },
    Invalid { account_id: AccountId },
    Ready(Box<PendingSettlementHankoDraft>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CertifiedSettlementHankoDraft {
    pub pending: PendingSettlementHankoDraft,
    pub settlement_hanko: Option<Vec<u8>>,
    pub dispute_hanko: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResidentAccountStatusView {
    pub status: String,
    pub active: bool,
    pub dispute_observed_on_chain: bool,
    pub dispute_observed_block_number: Option<u64>,
    pub settlement_workspace_hash: Option<String>,
    pub settlement_workspace_status: Option<String>,
    pub j_nonce: u64,
    pub current_height: u64,
    pub pending_frame_height: Option<u64>,
    pub mempool_len: usize,
    pub tokens: BTreeMap<TokenId, Option<xln_rscore_engine::Delta>>,
    pub owner_out_capacity: BTreeMap<TokenId, BigInt>,
    pub owner_own_credit_limit: BTreeMap<TokenId, BigInt>,
    pub owner_peer_credit_limit: BTreeMap<TokenId, BigInt>,
}

/// The production Account authority: one value-owning forest, not an adapter
/// around the legacy shared map.
pub struct ResidentConsensusEngine {
    engine_generation: EngineGeneration,
    forest: ResidentAccountForest<AccountConsensus>,
    private_key: [u8; 32],
    signer_id: Arc<str>,
    identities: BTreeMap<[u8; 32], Arc<SigningIdentity>>,
    swap_market: Arc<SwapMarketPolicy>,
    round_owner: Option<[u8; 32]>,
    base_proposable: BTreeSet<AccountId>,
    inbound_proposable: Option<BTreeSet<AccountId>>,
    candidate_proposable: Option<BTreeSet<AccountId>>,
    base_rebalance_work: BTreeSet<AccountId>,
    inbound_rebalance_work: Option<BTreeSet<AccountId>>,
    candidate_rebalance_work: Option<BTreeSet<AccountId>>,
    /// RAM-only owner projection of every accepted Account, maintained
    /// incrementally so checkpoint metadata never rescans resident workers.
    /// Owners are written exactly once at genesis and never change, so the
    /// projection follows the same accept/rollback lifecycle as the
    /// proposable sets: pending adds merge on candidate acceptance and drop
    /// on base rollback. Derived state: a restart rebuilds it from restore.
    signer_owners: BTreeMap<AccountId, [u8; 32]>,
    inbound_owner_adds: BTreeMap<AccountId, [u8; 32]>,
    candidate_owner_adds: BTreeMap<AccountId, [u8; 32]>,
    /// Identity inserted only for the currently open Entity frame. It is
    /// removed if a later Books/proposal step aborts that frame.
    round_identity_added: Option<[u8; 32]>,
    round_abort_armed: bool,
}

#[derive(Clone, Copy)]
enum SeedRestoreMode {
    Durable { revision: u64 },
    OfflineImport,
}

impl ResidentConsensusEngine {
    /// Identity shared with the parent Entity signer. Runtime verifies this
    /// once, allowing Account-worker signatures to enter the Entity manifest
    /// without a hot-path ECDSA recovery.
    pub fn local_signer_binding(&self) -> Result<(&str, [u8; 20]), BatchError> {
        let address = address_of_private_key(&self.private_key)
            .ok_or_else(|| BatchError::Signing("address".to_string()))?;
        Ok((&self.signer_id, address))
    }

    /// Restore every Account exactly once and move it into its permanent
    /// worker-owned shard and reconstruct the canonical Account forest root.
    pub fn restore(
        engine_generation: EngineGeneration,
        worker_count: usize,
        revision: u64,
        private_key: [u8; 32],
        signer_id: String,
        swap_market: Arc<SwapMarketPolicy>,
        seeds: Vec<AccountSeed>,
    ) -> Result<Self, BatchError> {
        Self::restore_seeded(
            engine_generation,
            worker_count,
            private_key,
            signer_id,
            swap_market,
            seeds,
            SeedRestoreMode::Durable { revision },
        )
    }

    /// Import a pre-authority Account forest exactly once. Unlike an exact
    /// durable restore, every seeded Account is dirty against an empty
    /// checkpoint baseline so the first Runtime checkpoint persists the full
    /// authority before a signed Runtime frame may reference it.
    pub fn import_existing(
        engine_generation: EngineGeneration,
        worker_count: usize,
        private_key: [u8; 32],
        signer_id: String,
        swap_market: Arc<SwapMarketPolicy>,
        seeds: Vec<AccountSeed>,
    ) -> Result<Self, BatchError> {
        Self::restore_seeded(
            engine_generation,
            worker_count,
            private_key,
            signer_id,
            swap_market,
            seeds,
            SeedRestoreMode::OfflineImport,
        )
    }

    fn restore_seeded(
        engine_generation: EngineGeneration,
        worker_count: usize,
        private_key: [u8; 32],
        signer_id: String,
        swap_market: Arc<SwapMarketPolicy>,
        seeds: Vec<AccountSeed>,
        mode: SeedRestoreMode,
    ) -> Result<Self, BatchError> {
        if worker_count == 0 || worker_count > MAX_BATCH_WORKERS {
            return Err(BatchError::InvalidWorkerCount(worker_count));
        }
        if private_key == [0; 32] || signer_id.is_empty() {
            return Err(BatchError::SignerRequired);
        }
        let mut identities = BTreeMap::new();
        for seed in &seeds {
            let owner = *seed.replica.owner().as_bytes();
            if let std::collections::btree_map::Entry::Vacant(entry) = identities.entry(owner) {
                entry.insert(Arc::new(build_signing_identity(
                    owner,
                    private_key,
                    &signer_id,
                )?));
            }
        }
        let entries = seeds
            .into_iter()
            .map(|seed| restore_seed_account(seed, &swap_market))
            .collect::<Result<Vec<_>, _>>()?;
        let base_proposable = proposable_from_entries(&entries)?;
        let base_rebalance_work = rebalance_work_from_entries(&entries)?;
        let signer_owners = entries
            .iter()
            .map(|(account_id, account, _)| (*account_id, *account.replica().owner().as_bytes()))
            .collect::<BTreeMap<_, _>>();
        let forest = match mode {
            SeedRestoreMode::Durable { revision } => {
                ResidentAccountForest::restore(worker_count, revision, entries)?
            }
            SeedRestoreMode::OfflineImport => {
                ResidentAccountForest::import_existing(worker_count, entries)?
            }
        };
        Ok(Self {
            engine_generation,
            forest,
            private_key,
            signer_id: Arc::from(signer_id),
            identities,
            swap_market,
            round_owner: None,
            base_proposable,
            inbound_proposable: None,
            candidate_proposable: None,
            base_rebalance_work,
            inbound_rebalance_work: None,
            candidate_rebalance_work: None,
            signer_owners,
            inbound_owner_adds: BTreeMap::new(),
            candidate_owner_adds: BTreeMap::new(),
            round_identity_added: None,
            round_abort_armed: false,
        })
    }

    /// Restore the exact durable Account authority directly into resident
    /// worker shards. Every check completes before an engine is returned; no
    /// legacy forest or second live copy of the Account values is constructed.
    pub fn restore_exact(
        engine_generation: EngineGeneration,
        worker_count: usize,
        private_key: [u8; 32],
        default_signer_id: String,
        swap_market: Arc<SwapMarketPolicy>,
        expected: CheckpointToken,
        rows: Vec<AccountRestore>,
    ) -> Result<Self, BatchError> {
        if worker_count == 0 || worker_count > MAX_BATCH_WORKERS {
            return Err(BatchError::InvalidWorkerCount(worker_count));
        }
        if private_key == [0; 32] || default_signer_id.is_empty() {
            return Err(BatchError::SignerRequired);
        }
        if rows.len() != expected.account_count {
            return Err(BatchError::CheckpointIncomplete {
                actual: rows.len(),
                expected: expected.account_count,
            });
        }

        let mut seen = BTreeSet::new();
        let mut identities = BTreeMap::new();
        let mut signer_rows = Vec::with_capacity(rows.len());
        let mut entries = Vec::with_capacity(rows.len());
        for row in rows {
            if !seen.insert(row.account_id) {
                return Err(BatchError::DuplicateAccount(row.account_id));
            }
            let owner = *row.replica.owner().as_bytes();
            if row.signer_id != default_signer_id {
                return Err(BatchError::SignerRebind {
                    entity_id: root_hex(owner),
                    actual: row.signer_id,
                    expected: default_signer_id.clone(),
                });
            }
            if let std::collections::btree_map::Entry::Vacant(entry) = identities.entry(owner) {
                entry.insert(Arc::new(build_signing_identity(
                    owner,
                    private_key,
                    &default_signer_id,
                )?));
            }
            let restored = restore_checkpoint_account(row, &swap_market)?;
            signer_rows.push((restored.account_id, restored.owner, restored.signer_id));
            entries.push((restored.account_id, restored.account, restored.leaf));
        }

        let base_proposable = proposable_from_entries(&entries)?;
        let base_rebalance_work = rebalance_work_from_entries(&entries)?;
        let forest = ResidentAccountForest::restore(worker_count, expected.revision, entries)?;
        if forest.len() != expected.account_count {
            return Err(BatchError::CheckpointIncomplete {
                actual: forest.len(),
                expected: expected.account_count,
            });
        }
        if forest.revision() != expected.revision {
            return Err(BatchError::CheckpointRevision {
                actual: forest.revision(),
                expected: expected.revision,
            });
        }
        let root = forest.accounts_root();
        if root != expected.accounts_root {
            return Err(BatchError::CheckpointRoot {
                actual: root_hex(root),
                expected: root_hex(expected.accounts_root),
            });
        }
        let digest = crate::checkpoint::signer_digest(
            signer_rows
                .iter()
                .map(|(account_id, owner, signer_id)| (*account_id, *owner, signer_id.as_str())),
        );
        if digest != expected.signer_digest {
            return Err(BatchError::CheckpointSignerDigest {
                actual: root_hex(digest),
                expected: root_hex(expected.signer_digest),
            });
        }
        Ok(Self {
            engine_generation,
            forest,
            private_key,
            signer_id: Arc::from(default_signer_id),
            identities,
            swap_market,
            round_owner: None,
            base_proposable,
            inbound_proposable: None,
            candidate_proposable: None,
            base_rebalance_work,
            inbound_rebalance_work: None,
            candidate_rebalance_work: None,
            signer_owners: signer_rows
                .iter()
                .map(|(account_id, owner, _)| (*account_id, *owner))
                .collect(),
            inbound_owner_adds: BTreeMap::new(),
            candidate_owner_adds: BTreeMap::new(),
            round_identity_added: None,
            round_abort_armed: false,
        })
    }

    pub const fn engine_generation(&self) -> EngineGeneration {
        self.engine_generation
    }

    pub fn worker_count(&self) -> usize {
        self.forest.worker_count()
    }

    /// Abort only the current in-memory Entity frame. The parent-selected
    /// Account head remains the base; no durable state or alternate root is
    /// introduced.
    pub fn abort_entity_round(&mut self) -> Result<(), BatchError> {
        if !self.round_abort_armed {
            return Ok(());
        }
        self.forest.abort_entity_round()?;
        self.inbound_proposable = None;
        self.candidate_proposable = None;
        self.inbound_rebalance_work = None;
        self.candidate_rebalance_work = None;
        self.inbound_owner_adds.clear();
        self.candidate_owner_adds.clear();
        self.round_owner = None;
        if let Some(owner) = self.round_identity_added.take() {
            self.identities.remove(&owner);
        }
        self.round_abort_armed = false;
        Ok(())
    }

    pub fn complete_entity_round(&mut self) {
        self.round_identity_added = None;
        self.round_abort_armed = false;
    }

    /// Reuse the configured resident worker set for pure, ordered batches
    /// that precede an Account phase. The callback cannot access worker state.
    pub fn map_stateless_ordered<T, R, F>(
        &mut self,
        items: Vec<T>,
        apply: F,
    ) -> Result<Vec<R>, BatchError>
    where
        T: Send + 'static,
        R: Send + 'static,
        F: Fn(T) -> R + Send + Sync + 'static,
    {
        self.forest.map_stateless_ordered(items, apply)
    }

    pub fn map_entity_stage_ordered<T, R, F>(
        &mut self,
        items: Vec<T>,
        apply: F,
    ) -> Result<Vec<R>, BatchError>
    where
        T: Send + 'static,
        R: Send + 'static,
        F: Fn(T) -> R + Send + Sync + 'static,
    {
        self.forest.map_entity_stage_ordered(items, apply)
    }

    pub fn revision(&self) -> u64 {
        self.forest.revision()
    }

    pub fn accounts_root(&self) -> [u8; 32] {
        self.forest.accounts_root()
    }

    pub fn account_count(&self) -> usize {
        self.forest.len()
    }

    /// Rebuild the RAM-only matcher authorization index from the canonical
    /// Account heads. This single bounded scan is used only at Entity
    /// bootstrap/recovery; live frames update the index from committed Account
    /// outputs and never rescan the forest.
    pub fn orderbook_account_snapshots(
        &mut self,
    ) -> Result<Vec<ResidentOrderbookAccountSnapshot>, BatchError> {
        self.forest
            .read_all(|account_id, account| {
                let identity = account.replica().state().identity();
                let offers = account
                    .replica()
                    .state()
                    .swap_offers()
                    .map(|offer| {
                        offer.snapshot(identity.left().to_string(), identity.right().to_string())
                    })
                    .collect();
                let mut resolving_offer_ids = BTreeSet::new();
                let mut collect = |txs: &[AccountTx]| {
                    for tx in txs {
                        if let AccountTx::SwapResolve { offer_id, .. } = tx {
                            resolving_offer_ids.insert(offer_id.clone());
                        }
                    }
                };
                if let Some(pending) = account.pending() {
                    collect(&pending.frame.txs);
                }
                collect(account.mempool());
                Ok(ResidentOrderbookAccountSnapshot {
                    account_id,
                    offers,
                    resolving_offer_ids,
                })
            })
            .map(|rows| rows.into_iter().map(|(_, row)| row).collect())
    }

    /// Export the exact dirty Account rows only after the parent Entity has
    /// attached every fresh witness to the resident candidate.
    pub fn export_checkpoint(&mut self) -> Result<AccountsCheckpoint, BatchError> {
        let signer_digest = self.checkpoint_signer_digest()?;
        let account_count = self.forest.len();
        let signer_id = Arc::clone(&self.signer_id);
        let exported =
            self.forest
                .export_checkpoint_dirty(move |account_id, account, previous| {
                    let leaf = leaf_root(account_id, account)?;
                    account_rows(account_id, account, previous, leaf, &signer_id)
                        .map_err(|error| state_error(account_id, &error))
                })?;
        Ok(AccountsCheckpoint {
            token: CheckpointToken {
                base_revision: exported.base_revision,
                revision: exported.revision,
                accounts_root: exported.accounts_root,
                signer_digest,
                account_count,
            },
            accounts: exported
                .rows
                .into_iter()
                .map(|(_, account)| account)
                .collect(),
            removed: exported.removed,
        })
    }

    pub fn account_shard_metrics(&self) -> Vec<crate::AccountShardMetric> {
        self.forest.metrics()
    }

    /// Accumulated wall-clock observability per resident phase kind.
    /// Timing-only: never influences committed roots or replay parity.
    pub fn account_phase_metrics(&self) -> Vec<crate::AccountPhaseMetric> {
        self.forest.phase_metrics()
    }

    pub fn entity_worker_metrics(&self) -> (&[u64], &[u64]) {
        self.forest.entity_worker_metrics()
    }

    pub fn entity_stage_invocations(&self) -> u64 {
        self.forest.entity_stage_invocations()
    }

    /// Exact resident worklist before Entity adds same-round transactions.
    /// Values stay inside their owner workers; only matching Account ids cross
    /// back to the coordinator.
    pub fn proposable_account_ids(&self) -> Result<Vec<AccountId>, BatchError> {
        Ok(self.active_proposable()?.iter().copied().collect())
    }

    /// Exact pre-round worklist selected by the parent Account root.
    ///
    /// The live envelope may still hold both a base and prior candidate. A
    /// caller assembling positional Entity outputs must select the same branch
    /// as inbound before recording the frame-start work prefix.
    pub fn selected_proposable_account_ids(
        &self,
        expected_accounts_root: [u8; 32],
    ) -> Result<Vec<AccountId>, BatchError> {
        // TS primes the frame worklist after the inbound Account stage
        // (application.ts prepare → primeEntityFrameAccountWork), so an ACK
        // admitted this frame already made its Account proposable. Once the
        // inbound phase ran, its set is the canonical frame-start prefix; the
        // branch check only matters before any inbound work exists.
        if let Some(inbound) = self.inbound_proposable.as_ref() {
            return Ok(inbound.iter().copied().collect());
        }
        let selected = if self
            .forest
            .expected_uses_candidate(expected_accounts_root)?
        {
            self.candidate_proposable
                .as_ref()
                .ok_or(BatchError::EntityRoundMissing)?
        } else {
            &self.base_proposable
        };
        Ok(selected.iter().copied().collect())
    }

    pub fn has_proposable_accounts(&self) -> Result<bool, BatchError> {
        Ok(!self.active_proposable()?.is_empty())
    }

    pub fn rebalance_account_ids(&self) -> Result<Vec<AccountId>, BatchError> {
        Ok(self.active_rebalance_work()?.iter().copied().collect())
    }

    pub fn has_rebalance_work(&self) -> Result<bool, BatchError> {
        Ok(!self.active_rebalance_work()?.is_empty())
    }

    pub fn hub_rebalance_views(
        &mut self,
        account_ids: Vec<AccountId>,
    ) -> Result<Vec<(AccountId, ResidentHubRebalanceAccountView)>, BatchError> {
        self.forest.read_outbound(
            account_ids
                .into_iter()
                .map(|account_id| (account_id, ()))
                .collect(),
            |account_id, account, _, ()| {
                let state = account.replica().state();
                let settlement_transition_pending = account
                    .mempool()
                    .iter()
                    .chain(
                        account
                            .pending()
                            .into_iter()
                            .flat_map(|pending| pending.frame.txs.iter()),
                    )
                    .any(|tx| matches!(tx, AccountTx::SettleTransition { .. }));
                let requested_rebalance = state
                    .requested_rebalance_entries()
                    .map_err(|error| state_error(account_id, &error))?;
                let requested_fee_state = state
                    .requested_rebalance_fee_entries()
                    .map_err(|error| state_error(account_id, &error))?
                    .into_iter()
                    .map(|(token_id, fee)| {
                        (
                            token_id,
                            ResidentHubRebalanceFeeState {
                                request_id: fee.request_id,
                                fee_paid_upfront: fee.fee_paid_upfront,
                                policy_version: fee.policy_version,
                                requested_at: fee.requested_at,
                                refund: fee.refund.is_some(),
                                refunded_amount: fee
                                    .refund
                                    .as_ref()
                                    .map(|refund| refund.refunded_amount.clone()),
                            },
                        )
                    })
                    .collect();
                Ok(ResidentHubRebalanceAccountView {
                    pending_frame: account.pending().is_some(),
                    settlement_transition_pending,
                    settlement_workspace: state.settlement_workspace().cloned(),
                    requested_rebalance,
                    requested_fee_state,
                    submitted_at_by_token: account
                        .replica()
                        .envelope()
                        .rebalance_shadow_submitted_rows(),
                    deltas: state.deltas().cloned().collect(),
                    owner_side: account.replica().owner_side(),
                })
            },
        )
    }

    /// Exact work predicate for the committed Account root selected by the
    /// parent Runtime before it derives an on-demand scheduled wake.
    pub fn selected_has_rebalance_work(
        &self,
        expected_accounts_root: [u8; 32],
    ) -> Result<bool, BatchError> {
        let selected = if self
            .forest
            .expected_uses_candidate(expected_accounts_root)?
        {
            self.candidate_rebalance_work
                .as_ref()
                .ok_or(BatchError::EntityRoundMissing)?
        } else {
            &self.base_rebalance_work
        };
        Ok(!selected.is_empty())
    }

    /// Read the committed active/inactive bit only for Accounts named by one
    /// authenticated J-event range. This stays shard-parallel and never scans
    /// the forest or materializes Account replicas at the coordinator.
    pub fn active_account_ids(
        &mut self,
        account_ids: Vec<AccountId>,
    ) -> Result<BTreeSet<AccountId>, BatchError> {
        let rows = self.forest.read_outbound(
            account_ids
                .into_iter()
                .map(|account_id| (account_id, ()))
                .collect(),
            |_, account, _, ()| active(account),
        )?;
        Ok(rows
            .into_iter()
            .filter_map(|(account_id, active)| active.then_some(account_id))
            .collect())
    }

    /// Check due HTLC lock ids on their owner workers without materializing
    /// Account replicas at the coordinator. The caller groups lock ids by
    /// Account because the resident worker protocol admits one row per shard
    /// key in a phase.
    pub fn active_htlc_locks(
        &mut self,
        requests: Vec<(AccountId, Vec<String>)>,
    ) -> Result<BTreeSet<(AccountId, String)>, BatchError> {
        let rows = self
            .forest
            .read_outbound(requests, |_, account, _, lock_ids| {
                Ok(lock_ids
                    .into_iter()
                    .filter(|lock_id| account.replica().state().htlc_lock(lock_id).is_some())
                    .collect::<Vec<_>>())
            })?;
        Ok(rows
            .into_iter()
            .flat_map(|(account_id, lock_ids)| {
                lock_ids
                    .into_iter()
                    .map(move |lock_id| (account_id, lock_id))
            })
            .collect())
    }

    /// Point-read only the pre-round Account facts used to materialize a
    /// cross-J setup/clear command. The Runtime seed never enters workers;
    /// workers return only membership in the explicitly requested ids.
    pub fn cross_j_materialization_views(
        &mut self,
        requests: Vec<(AccountId, ResidentAccountFinancialViewRequest)>,
    ) -> Result<Vec<(AccountId, ResidentCrossJMaterializationView)>, BatchError> {
        self.forest.read_head(requests, |_, account, request| {
            let pulls = request
                .pull_ids
                .into_iter()
                .filter(|pull_id| account.replica().state().pull(pull_id).is_some())
                .collect();
            let swap_offers = request
                .swap_offer_ids
                .into_iter()
                .filter(|offer_id| account.replica().state().swap_offer(offer_id).is_some())
                .collect();
            let (pending_cross_pull_close_ids, _) = pending_cross_j_ids(account);
            Ok(ResidentCrossJMaterializationView {
                pull_ids: pulls,
                swap_offer_ids: swap_offers,
                pending_cross_pull_close_ids,
            })
        })
    }

    /// Point-read the opening-only view for the exact positional worklist. A
    /// pending frame freezes a cohort only when it contains an opening
    /// `cross_pull_lock`; unrelated pending frames do not hide queued opening
    /// work in the Account mempool. Missing ids fail loudly instead of being
    /// omitted from the returned vector.
    pub fn cross_j_opening_account_views(
        &mut self,
        account_ids: Vec<AccountId>,
    ) -> Result<Vec<ResidentCrossJOpeningAccountView>, BatchError> {
        self.forest
            .read_head(
                account_ids
                    .into_iter()
                    .map(|account_id| (account_id, ()))
                    .collect(),
                |account_id, account, ()| {
                    let mempool = cross_j_opening_txs(account.mempool());
                    let pending_frame_txs = account.pending().and_then(|pending| {
                        let opening = cross_j_opening_txs(&pending.frame.txs);
                        opening
                            .iter()
                            .any(|tx| matches!(tx, AccountTx::CrossPullLock { .. }))
                            .then_some(opening)
                    });
                    Ok(ResidentCrossJOpeningAccountView {
                        counterparty_entity_id: format!("0x{}", root_hex(*account_id.as_bytes())),
                        mempool,
                        pending_frame_txs,
                    })
                },
            )
            .map(|rows| rows.into_iter().map(|(_, view)| view).collect())
    }

    /// Read canonical Account availability and owner-perspective capacities
    /// after the inbound visit. This mirrors the narrow fields consulted by
    /// TypeScript's `validatePreparedHtlcPayment`; it never materializes or
    /// copies an Account replica at the Entity coordinator.
    pub fn local_financial_views(
        &mut self,
        requests: Vec<(AccountId, ResidentAccountFinancialViewRequest)>,
    ) -> Result<Vec<(AccountId, ResidentAccountFinancialView)>, BatchError> {
        self.forest
            .read_outbound(requests, |account_id, account, _, request| {
                let ResidentAccountFinancialViewRequest {
                    token_ids,
                    htlc_lock_ids,
                    pull_ids,
                    swap_offer_ids,
                    dispute,
                } = request;
                let active = match account
                    .replica()
                    .envelope()
                    .fields()
                    .iter()
                    .find(|(name, _)| name == "status")
                    .map(|(_, value)| value)
                {
                    None => true,
                    Some(CanonicalValue::String(value)) => value == "active",
                    Some(_) => false,
                };
                let owner_side = account.replica().owner_side();
                let htlc_locks = htlc_lock_ids
                    .into_iter()
                    .filter_map(|lock_id| {
                        account
                            .replica()
                            .state()
                            .htlc_lock(&lock_id)
                            .cloned()
                            .map(|lock| (lock_id, lock))
                    })
                    .collect();
                let settlement_transition_pending = account.pending().is_some_and(|pending| {
                    pending
                        .frame
                        .txs
                        .iter()
                        .any(|tx| matches!(tx, AccountTx::SettleTransition { .. }))
                }) || account
                    .mempool()
                    .iter()
                    .any(|tx| matches!(tx, AccountTx::SettleTransition { .. }));
                let mut owner_in_capacity = BTreeMap::new();
                let mut owner_out_capacity = BTreeMap::new();
                let mut owner_own_credit_limit = BTreeMap::new();
                let mut owner_peer_credit_limit = BTreeMap::new();
                for token_id in token_ids {
                    let Some(delta) = account.replica().state().delta(token_id) else {
                        continue;
                    };
                    let perspective = delta.perspective(owner_side);
                    owner_in_capacity.insert(token_id, perspective.in_capacity);
                    owner_out_capacity.insert(token_id, perspective.out_capacity);
                    owner_own_credit_limit.insert(token_id, perspective.own_credit_limit);
                    let mut projected = perspective.peer_credit_limit;
                    let project = |txs: &[AccountTx], projected: &mut BigInt| {
                        for tx in txs {
                            match tx {
                                AccountTx::SetCreditLimit {
                                    token_id: tx_token,
                                    amount,
                                } if tx_token == &token_id => *projected = amount.clone(),
                                AccountTx::LendingCredit {
                                    token_id: tx_token,
                                    credit_limit,
                                    ..
                                } if tx_token == &token_id => *projected = credit_limit.clone(),
                                _ => {}
                            }
                        }
                    };
                    if let Some(pending) = account.pending() {
                        project(&pending.frame.txs, &mut projected);
                    }
                    project(account.mempool(), &mut projected);
                    owner_peer_credit_limit.insert(token_id, projected);
                }
                let state = account.replica().state();
                let pulls = pull_ids
                    .into_iter()
                    .filter_map(|pull_id| state.pull(&pull_id).cloned().map(|pull| (pull_id, pull)))
                    .collect();
                let left = state.identity().left().as_hex();
                let right = state.identity().right().as_hex();
                let swap_offers = swap_offer_ids
                    .into_iter()
                    .filter_map(|offer_id| {
                        state
                            .swap_offer(&offer_id)
                            .map(|offer| (offer_id, offer.snapshot(left.clone(), right.clone())))
                    })
                    .collect();
                let (pending_cross_pull_close_ids, pending_cross_swap_ack_ids) =
                    pending_cross_j_ids(account);
                let dispute = dispute
                    .then(|| -> Result<ResidentAccountDisputeView, BatchError> {
                        let replica = account.replica();
                        let state = replica.state();
                        let left = state.identity().left().as_hex();
                        let right = state.identity().right().as_hex();
                        let swap_offers = state
                            .swap_offers()
                            .map(|offer| offer.snapshot(left.clone(), right.clone()))
                            .collect();
                        let payment_hashlocks = state
                            .htlc_locks()
                            .map(|lock| lock.hashlock().as_str().to_string())
                            .collect();
                        let mut pending_swap_fill_ratios = BTreeMap::new();
                        let mut collect = |txs: &[AccountTx]| {
                            for tx in txs {
                                let AccountTx::SwapResolve {
                                    offer_id,
                                    fill_ratio,
                                    ..
                                } = tx
                                else {
                                    continue;
                                };
                                if *fill_ratio > 0 {
                                    pending_swap_fill_ratios
                                        .entry(offer_id.clone())
                                        .or_insert(*fill_ratio);
                                }
                            }
                        };
                        if let Some(pending) = account.pending() {
                            collect(&pending.frame.txs);
                        }
                        collect(account.mempool());
                        let delta_transformer = replica.delta_transformer().copied();
                        Ok(ResidentAccountDisputeView {
                            status: replica
                                .envelope()
                                .field("status")
                                .and_then(|value| match value {
                                    CanonicalValue::String(value) => Some(value.clone()),
                                    _ => None,
                                })
                                .unwrap_or_else(|| "active".into()),
                            dispute_prepare: replica.envelope().field("disputePrepare").cloned(),
                            active_dispute: replica.envelope().field("activeDispute").cloned(),
                            local_dispute: account.dispute().cloned(),
                            counterparty_dispute: account.counterparty_dispute().cloned(),
                            proof_body: delta_transformer
                                .ok_or_else(|| "DELTA_TRANSFORMER_MISSING".to_string())
                                .and_then(|address| {
                                    xln_rscore_engine::build_dispute_proof_body(replica, &address)
                                        .map_err(|error| error.to_string())
                                }),
                            j_nonce: state.j_nonce(),
                            owner_is_left: replica.owner_side() == xln_rscore_engine::Side::Left,
                            delta_transformer,
                            payment_hashlocks,
                            pull_ids: state
                                .pull_ids()
                                .map_err(|error| BatchError::FinancialView(error.to_string()))?,
                            pull_count: state.pull_count(),
                            swap_offers,
                            pending_swap_fill_ratios,
                        })
                    })
                    .transpose()?;
                Ok(ResidentAccountFinancialView {
                    active,
                    owner_side,
                    owner_in_capacity,
                    owner_out_capacity,
                    owner_own_credit_limit,
                    owner_peer_credit_limit,
                    settlement_workspace: account.replica().state().settlement_workspace().cloned(),
                    settlement_transition_pending,
                    settlement_execution: xln_rscore_engine::prepare_settlement_execution(
                        account.replica(),
                    ),
                    rebalance_active_quote: account
                        .replica()
                        .envelope()
                        .rebalance_active_quote()
                        .map_err(|error| BatchError::AccountsTree {
                        account_id,
                        detail: error.to_string(),
                    })?,
                    htlc_locks,
                    pulls,
                    swap_offers,
                    pending_cross_pull_close_ids,
                    pending_cross_swap_ack_ids,
                    dispute,
                })
            })
    }

    pub fn deferred_settlement_approvals(
        &mut self,
        requests: Vec<(AccountId, String)>,
    ) -> Result<Vec<DeferredSettlementApproval>, BatchError> {
        Ok(self
            .forest
            .read_outbound(requests, |account_id, account, _, approved_hash| {
                let pending_transition = account.pending().is_some_and(|pending| {
                    pending
                        .frame
                        .txs
                        .iter()
                        .any(|tx| matches!(tx, AccountTx::SettleTransition { .. }))
                }) || account
                    .mempool()
                    .iter()
                    .any(|tx| matches!(tx, AccountTx::SettleTransition { .. }));
                if pending_transition {
                    return Ok(DeferredSettlementApproval::Wait { account_id });
                }
                let Some(CanonicalValue::Object(workspace)) =
                    account.replica().state().settlement_workspace()
                else {
                    return Ok(DeferredSettlementApproval::Invalid { account_id });
                };
                let get = |name: &str| {
                    workspace
                        .iter()
                        .find_map(|(key, value)| (key == name).then_some(value))
                };
                let Some(CanonicalValue::String(current_hash)) = get("workspaceHash") else {
                    return Err(BatchError::AccountsTree {
                        account_id,
                        detail: "SETTLEMENT_WORKSPACE_HASH_INVALID".into(),
                    });
                };
                let Some(CanonicalValue::String(status)) = get("status") else {
                    return Err(BatchError::AccountsTree {
                        account_id,
                        detail: "SETTLEMENT_WORKSPACE_STATUS_INVALID".into(),
                    });
                };
                if current_hash != &approved_hash || status == "submitted" {
                    return Ok(DeferredSettlementApproval::Invalid { account_id });
                }
                let proof_pinned = [
                    "settlementHash",
                    "leftHanko",
                    "rightHanko",
                    "postSettlementDisputeProof",
                ]
                .iter()
                .any(|name| get(name).is_some());
                if !account.mempool().is_empty() && !proof_pinned {
                    return Ok(DeferredSettlementApproval::Wait { account_id });
                }
                let draft = account
                    .settlement_hanko_draft()
                    .map_err(|error| state_error(account_id, &error))?;
                Ok(DeferredSettlementApproval::Ready(Box::new(
                    PendingSettlementHankoDraft { account_id, draft },
                )))
            })?
            .into_iter()
            .map(|(_, disposition)| disposition)
            .collect())
    }

    /// Attach witnesses produced by the just-certified Entity frame and admit
    /// the now-complete Hanko transitions to the existing outbound candidate.
    /// Account tx hashing excludes these post-commit witnesses, so every leaf
    /// and the already-certified accounts root remain byte-identical.
    pub fn attach_certified_settlement_hankos(
        &mut self,
        drafts: Vec<CertifiedSettlementHankoDraft>,
    ) -> Result<(), BatchError> {
        if drafts.is_empty() {
            return Ok(());
        }
        let account_ids = drafts
            .iter()
            .map(|draft| draft.pending.account_id)
            .collect::<Vec<_>>();
        self.forest.apply_outbound_continue(
            OutboundContinuationKind::SettlementHankoAttach,
            drafts
                .into_iter()
                .map(|draft| (draft.pending.account_id, draft))
                .collect(),
            |account_id, current, certified| {
                let mut account = current
                    .ok_or(BatchError::CandidateAccountNotFound(account_id))?
                    .clone();
                let before = leaf_root(account_id, &account)?;
                account
                    .attach_certified_settlement_hanko(
                        certified.pending.draft,
                        certified.settlement_hanko.as_deref(),
                        &certified.dispute_hanko,
                    )
                    .map_err(|error| state_error(account_id, &error))?;
                let after = leaf_root(account_id, &account)?;
                if before != after {
                    return Err(BatchError::AccountsTree {
                        account_id,
                        detail: "SETTLEMENT_POST_COMMIT_WITNESS_MOVED_ACCOUNT_LEAF".into(),
                    });
                }
                Ok(ResidentAccountAction::Put {
                    value: account,
                    value_digest: after,
                    result: (),
                })
            },
        )?;
        if let Some(proposable) = &mut self.candidate_proposable {
            proposable.extend(account_ids);
        }
        Ok(())
    }

    /// Canonical on-demand operator projection for one Account. The Account
    /// stays resident on its shard worker and only the requested token rows
    /// cross the boundary; no full forest scan or durable read model exists.
    pub fn account_status(
        &mut self,
        account_id: AccountId,
        token_ids: Vec<TokenId>,
    ) -> Result<Option<ResidentAccountStatusView>, BatchError> {
        if !self.signer_owners.contains_key(&account_id) {
            return Ok(None);
        }
        let mut rows =
            self.forest
                .read_head(vec![(account_id, token_ids)], |_, account, token_ids| {
                    let envelope = account.replica().envelope();
                    let field = |wanted: &str| {
                        envelope
                            .fields()
                            .iter()
                            .find_map(|(name, value)| (name == wanted).then_some(value))
                    };
                    let status = match field("status") {
                        None => "active".to_string(),
                        Some(CanonicalValue::String(value)) => value.clone(),
                        Some(_) => "invalid".to_string(),
                    };
                    let active_dispute = match field("activeDispute") {
                        Some(CanonicalValue::Object(fields)) => Some(fields),
                        _ => None,
                    };
                    let dispute_field = |wanted: &str| {
                        active_dispute.and_then(|fields| {
                            fields
                                .iter()
                                .find_map(|(name, value)| (name == wanted).then_some(value))
                        })
                    };
                    let settlement_workspace =
                        match account.replica().state().settlement_workspace() {
                            Some(CanonicalValue::Object(fields)) => Some(fields),
                            _ => None,
                        };
                    let settlement_text = |wanted: &str| {
                        settlement_workspace.and_then(|fields| {
                            fields.iter().find_map(|(name, value)| {
                                (name == wanted)
                                    .then_some(value)
                                    .and_then(|value| match value {
                                        CanonicalValue::String(value) => Some(value.clone()),
                                        _ => None,
                                    })
                            })
                        })
                    };
                    let owner_side = account.replica().owner_side();
                    let mut tokens = BTreeMap::new();
                    let mut owner_out_capacity = BTreeMap::new();
                    let mut owner_own_credit_limit = BTreeMap::new();
                    let mut owner_peer_credit_limit = BTreeMap::new();
                    for token_id in token_ids {
                        let delta = account.replica().state().delta(token_id).cloned();
                        if let Some(delta) = delta.as_ref() {
                            let perspective = delta.perspective(owner_side);
                            owner_out_capacity.insert(token_id, perspective.out_capacity);
                            owner_own_credit_limit.insert(token_id, perspective.own_credit_limit);
                            owner_peer_credit_limit.insert(token_id, perspective.peer_credit_limit);
                        }
                        tokens.insert(token_id, delta);
                    }
                    Ok(ResidentAccountStatusView {
                        active: status == "active",
                        status,
                        dispute_observed_on_chain: matches!(
                            dispute_field("observedOnChain"),
                            Some(CanonicalValue::Bool(true))
                        ),
                        dispute_observed_block_number: match dispute_field("observedBlockNumber") {
                            Some(CanonicalValue::Number(value)) => value.as_str().parse().ok(),
                            _ => None,
                        },
                        settlement_workspace_hash: settlement_text("workspaceHash"),
                        settlement_workspace_status: settlement_text("status"),
                        j_nonce: account.replica().state().j_nonce(),
                        current_height: account.current_height(),
                        pending_frame_height: account.pending().map(|pending| pending.frame.height),
                        mempool_len: account.mempool().len(),
                        tokens,
                        owner_out_capacity,
                        owner_own_credit_limit,
                        owner_peer_credit_limit,
                    })
                })?;
        Ok(rows.pop().map(|(_, status)| status))
    }

    /// Diagnostic read of one Account's projected leaf fields: the exact
    /// values hashed into its Entity account leaf. Replay mismatch reporting only;
    /// no durable read model and no full forest scan.
    pub fn account_envelope_fields(
        &mut self,
        account_id: AccountId,
    ) -> Result<Option<Vec<(String, CanonicalValue)>>, BatchError> {
        if !self.signer_owners.contains_key(&account_id) {
            return Ok(None);
        }
        let mut rows =
            self.forest
                .read_head(vec![(account_id, ())], |account_id, account, ()| {
                    account
                        .projected_leaf_fields()
                        .map_err(|error| crate::consensus::state_error(account_id, &error))
                })?;
        Ok(rows.pop().map(|(_, fields)| fields))
    }

    fn active_proposable(&self) -> Result<&BTreeSet<AccountId>, BatchError> {
        Ok(self
            .candidate_proposable
            .as_ref()
            .or(self.inbound_proposable.as_ref())
            .unwrap_or(&self.base_proposable))
    }

    fn active_rebalance_work(&self) -> Result<&BTreeSet<AccountId>, BatchError> {
        Ok(self
            .candidate_rebalance_work
            .as_ref()
            .or(self.inbound_rebalance_work.as_ref())
            .unwrap_or(&self.base_rebalance_work))
    }

    /// First and only inward visit for one Entity input.
    pub fn entity_inbound(
        &mut self,
        request: EntityInboundRequest,
    ) -> Result<EntityRoundResult, BatchError> {
        self.entity_inbound_inner(request, false, true)
    }

    /// Resident Entity-frame ingress. Intermediate Account commitments are
    /// intentionally not requested; the final proposal phase seals the union
    /// of all dirty Account shards once.
    pub fn entity_inbound_unsealed(
        &mut self,
        request: EntityInboundRequest,
        continue_inbound: bool,
    ) -> Result<EntityRoundResult, BatchError> {
        self.entity_inbound_inner(request, continue_inbound, false)
    }

    fn entity_inbound_inner(
        &mut self,
        request: EntityInboundRequest,
        continue_inbound: bool,
        need_accounts_root: bool,
    ) -> Result<EntityRoundResult, BatchError> {
        let post_accounts = request.post_accounts;
        let uses_candidate = if continue_inbound {
            if self.inbound_proposable.is_none()
                || self.inbound_rebalance_work.is_none()
                || self.round_owner != Some(request.owner_entity_id)
            {
                return Err(BatchError::EntityRoundMissing);
            }
            false
        } else {
            let uses_candidate = self
                .forest
                .expected_uses_candidate(request.expected_accounts_root)?;
            if uses_candidate
                && (self.candidate_proposable.is_none() || self.candidate_rebalance_work.is_none())
            {
                return Err(BatchError::EntityRoundMissing);
            }
            uses_candidate
        };
        if !continue_inbound {
            // The prior frame completed successfully if its identity survived
            // until another parent-selected inbound began.
            self.round_identity_added = None;
        }
        validate_operation_indices(&request.rows)?;
        let applied_count = request.rows.len();
        let mut grouped = BTreeMap::<AccountId, Vec<AccountInputRow>>::new();
        for row in request.rows {
            grouped.entry(row.account_id).or_default().push(row);
        }
        let entries = grouped
            .into_iter()
            .map(|(account_id, rows)| (account_id, InboundWork { rows }))
            .collect();
        let owner = request.owner_entity_id;
        let (identity, identity_is_new) = self.identity_candidate(owner, true)?;
        let worker_identity = Arc::clone(&identity);
        let market = Arc::clone(&self.swap_market);
        let signer_id = Arc::clone(&self.signer_id);
        let clock = request.clock;
        let apply = move |account_id, current: Option<&AccountConsensus>, work: InboundWork| {
            let created = current.is_none();
            let mut account = match current {
                Some(account) => {
                    if work.rows.iter().any(|row| row.genesis_policy.is_some()) {
                        return Err(BatchError::InboundGenesis {
                            account_id,
                            detail: "POLICY_FOR_EXISTING".to_string(),
                        });
                    }
                    CloneOnMutation::Borrowed(account)
                }
                None => {
                    let first = work.rows.first().ok_or(BatchError::InboundGenesis {
                        account_id,
                        detail: "INPUT_REQUIRED".to_string(),
                    })?;
                    let policy =
                        first
                            .genesis_policy
                            .as_ref()
                            .ok_or(BatchError::InboundGenesis {
                                account_id,
                                detail: "POLICY_REQUIRED".to_string(),
                            })?;
                    if work
                        .rows
                        .iter()
                        .skip(1)
                        .any(|row| row.genesis_policy.is_some())
                    {
                        return Err(BatchError::InboundGenesis {
                            account_id,
                            detail: "POLICY_NOT_FIRST_ONLY".to_string(),
                        });
                    }
                    CloneOnMutation::Owned(inbound_genesis_account(
                        account_id,
                        owner,
                        &first.input,
                        policy,
                    )?)
                }
            };
            assert_account_owner(account_id, account.as_ref(), owner)?;
            let mut applied = Vec::with_capacity(work.rows.len());
            let mut created_checkpoint = None;
            let mut changed = false;
            for (row_index, row) in work.rows.into_iter().enumerate() {
                let authority = row.certified_board_authority.certified()?;
                let local_authority = row.local_certified_board_authority.certified()?;
                let pure_ack = matches!(&row.input.kind, crate::AccountInputKind::Ack(_));
                let security = xln_rscore_engine::IncomingFrameSecurityContext {
                    clock,
                    peer_certified_board_authority: authority,
                    local_certified_board_authority: local_authority,
                };
                let (verdict, row_changed) = match apply_one_without_mutation(
                    account_id,
                    account.as_ref(),
                    &worker_identity,
                    &row.input,
                    security,
                ) {
                    Some(verdict) => (verdict, false),
                    None => apply_one(
                        account_id,
                        account.make_mut(),
                        &worker_identity,
                        row.input,
                        security,
                        &market,
                    ),
                };
                if created && row_index == 0 && !verdict_commits_genesis(&verdict) {
                    return Err(BatchError::InboundGenesis {
                        account_id,
                        detail: format!("H1_NOT_COMMITTED:{verdict:?}"),
                    });
                }
                if created && row_index == 0 {
                    let genesis_leaf = leaf_root(account_id, account.as_ref())?;
                    created_checkpoint = Some(
                        account_rows(account_id, account.as_ref(), None, genesis_leaf, &signer_id)
                            .map_err(|error| state_error(account_id, &error))?,
                    );
                }
                changed |= row_changed;
                applied.push(AccountInputResult {
                    operation_index: row.operation_index,
                    account_id,
                    force_ack: force_ack_directive(pure_ack, &verdict),
                    verdict,
                });
            }
            let leaf = if need_accounts_root || post_accounts || created {
                leaf_root(account_id, account.as_ref())?
            } else {
                // The resident Entity path consumes only the touched Account
                // id before outbound. Its final leaf is sealed once after all
                // Entity-derived proposals have run.
                [0; 32]
            };
            let result = InboundOutcome {
                applied,
                leaf,
                created_checkpoint,
                changed,
                proposable: proposable(account.as_ref())?,
                has_rebalance_work: has_rebalance_work(account.as_ref())?,
            };
            if changed && !need_accounts_root && !created {
                Ok(ResidentAccountAction::PutUnsealed {
                    value: account
                        .into_owned()
                        .ok_or_else(|| BatchError::AccountsTree {
                            account_id,
                            detail: "ACCOUNT_CHANGED_WITHOUT_CANDIDATE".to_string(),
                        })?,
                    result,
                })
            } else if changed {
                Ok(ResidentAccountAction::Put {
                    value: account
                        .into_owned()
                        .ok_or_else(|| BatchError::AccountsTree {
                            account_id,
                            detail: "ACCOUNT_CHANGED_WITHOUT_CANDIDATE".to_string(),
                        })?,
                    value_digest: leaf,
                    result,
                })
            } else {
                Ok(ResidentAccountAction::Keep(result))
            }
        };
        let (batch_revision, batch_accounts_root, batch_rows) = if need_accounts_root {
            let batch =
                self.forest
                    .apply_inbound(request.expected_accounts_root, entries, apply)?;
            (batch.revision, Some(batch.accounts_root), batch.rows)
        } else if continue_inbound {
            let batch = self
                .forest
                .apply_inbound_continue_unsealed(entries, apply)?;
            (batch.revision, None, batch.rows)
        } else {
            let batch = self.forest.apply_inbound_unsealed(
                request.expected_accounts_root,
                entries,
                apply,
            )?;
            (batch.revision, None, batch.rows)
        };
        self.round_abort_armed = true;
        // The parent named the candidate (or the base) and the workers already
        // reconciled to it, so promotion is a move: one clone seeds the new
        // inbound worklist instead of the previous clone-clone-move dance.
        let mut inbound_proposable = if continue_inbound {
            self.inbound_proposable
                .take()
                .ok_or(BatchError::EntityRoundMissing)?
        } else if uses_candidate {
            let promoted = self
                .candidate_proposable
                .take()
                .ok_or(BatchError::EntityRoundMissing)?;
            self.base_proposable = promoted.clone();
            self.signer_owners.append(&mut self.inbound_owner_adds);
            self.signer_owners.append(&mut self.candidate_owner_adds);
            promoted
        } else {
            self.inbound_owner_adds.clear();
            self.candidate_owner_adds.clear();
            self.base_proposable.clone()
        };
        let mut inbound_rebalance_work = if continue_inbound {
            self.inbound_rebalance_work
                .take()
                .ok_or(BatchError::EntityRoundMissing)?
        } else if uses_candidate {
            let promoted = self
                .candidate_rebalance_work
                .take()
                .ok_or(BatchError::EntityRoundMissing)?;
            self.base_rebalance_work = promoted.clone();
            promoted
        } else {
            self.base_rebalance_work.clone()
        };
        let mut result = EntityRoundResult {
            revision: batch_revision,
            // Unsealed callers must never consume this pre-round root as a
            // post-ingress commitment. It exists only because the public
            // round result remains shared with the sealed direct API.
            accounts_root: batch_accounts_root.unwrap_or(request.expected_accounts_root),
            ..EntityRoundResult::default()
        };
        let mut created_any = false;
        let mut changed_account_ids = BTreeSet::new();
        let mut applied_by_position = std::iter::repeat_with(|| None)
            .take(applied_count)
            .collect::<Vec<Option<AccountInputResult>>>();
        for (account_id, _leaf, outcome) in batch_rows {
            if outcome.changed {
                changed_account_ids.insert(account_id);
            }
            set_proposable(&mut inbound_proposable, account_id, outcome.proposable);
            set_work_membership(
                &mut inbound_rebalance_work,
                account_id,
                outcome.has_rebalance_work,
            );
            for applied in outcome.applied {
                let index = usize::try_from(applied.operation_index).map_err(|_| {
                    BatchError::OperationIndex {
                        actual: applied.operation_index,
                        after: None,
                    }
                })?;
                let slot =
                    applied_by_position
                        .get_mut(index)
                        .ok_or(BatchError::OperationIndex {
                            actual: applied.operation_index,
                            after: None,
                        })?;
                if slot.replace(applied).is_some() {
                    return Err(BatchError::OperationIndex {
                        actual: index as u64,
                        after: None,
                    });
                }
            }
            result.touched.push((account_id, outcome.leaf));
            if let Some(created) = outcome.created_checkpoint {
                created_any = true;
                self.inbound_owner_adds.insert(account_id, owner);
                result.created_accounts.push(created);
            }
        }
        if post_accounts {
            result.post_accounts = self
                .materialize(changed_account_ids, true)?
                .into_iter()
                .map(|(account_id, row)| {
                    row.checkpoint.ok_or(BatchError::AccountsTree {
                        account_id,
                        detail: "INBOUND_POST_ACCOUNT_MISSING".to_string(),
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
        }
        result.applied = applied_by_position
            .into_iter()
            .collect::<Option<Vec<_>>>()
            .ok_or(BatchError::OperationIndex {
                actual: u64::try_from(applied_count).unwrap_or(u64::MAX),
                after: None,
            })?;
        // An exact empty checkpoint still belongs to one Entity authority.
        // Its empty inbound half has no Account row from which to retain the
        // derived signer, but the matching checkpoint-only outbound half must
        // be able to commit the empty forest. Non-empty forests still require
        // a real created Account before admitting a new owner binding.
        if identity_is_new && (created_any || self.forest.len() == 0) {
            self.identities.insert(owner, identity);
            self.round_identity_added = Some(owner);
        }
        self.inbound_proposable = Some(inbound_proposable);
        self.candidate_proposable = None;
        self.inbound_rebalance_work = Some(inbound_rebalance_work);
        self.candidate_rebalance_work = None;
        self.round_owner = Some(owner);
        Ok(result)
    }

    /// Ordinary outward visit. The resident Entity path uses the explicit
    /// prepare/finish pair below so only actual failed hashlocks trigger one
    /// batched continuation; direct process callers finish with none.
    pub fn entity_outbound(
        &mut self,
        request: EntityOutboundRequest,
    ) -> Result<EntityRoundResult, BatchError> {
        let prepared = self.prepare_entity_outbound(request)?;
        self.finish_entity_outbound(prepared, Vec::new())
    }

    pub fn prepare_entity_outbound(
        &mut self,
        request: EntityOutboundRequest,
    ) -> Result<PreparedEntityOutbound, BatchError> {
        let outcome = self.prepare_entity_outbound_attempt(request);
        if outcome.is_err() {
            self.reset_outbound_candidate()?;
        }
        outcome
    }

    fn prepare_entity_outbound_attempt(
        &mut self,
        mut request: EntityOutboundRequest,
    ) -> Result<PreparedEntityOutbound, BatchError> {
        let owner = request.owner_entity_id;
        let local_board_authority = request
            .local_certified_board_authority
            .certified()?
            .copied();
        let expected_owner = self.round_owner.ok_or(BatchError::EntityRoundMissing)?;
        if owner != expected_owner {
            return Err(BatchError::EntityRoundOwner {
                actual: root_hex(owner),
                expected: root_hex(expected_owner),
            });
        }
        let (identity, identity_is_new) =
            self.identity_candidate(owner, !request.creates.is_empty())?;
        let original_admissions = admission_results(&request.proposal_work);
        let (fast_entries, named, proposal_order) = outbound_work(&mut request)?;

        let mut round_leafs = BTreeMap::new();
        let mut fast = self.run_outbound(
            false,
            fast_entries,
            owner,
            Arc::clone(&identity),
            request.timestamp,
            request.j_height,
            local_board_authority,
            &mut round_leafs,
        )?;
        let proposals = proposals_from(&mut fast.rows, &proposal_order);
        Ok(PreparedEntityOutbound {
            owner,
            identity,
            identity_is_new,
            timestamp: request.timestamp,
            j_height: request.j_height,
            local_board_authority,
            checkpoint_due: request.checkpoint_due,
            post_accounts: request.post_accounts,
            admissions: original_admissions,
            proposals,
            named,
            round_leafs,
        })
    }

    pub fn finish_entity_outbound(
        &mut self,
        prepared: PreparedEntityOutbound,
        followups: Vec<FailedHtlcFollowup>,
    ) -> Result<EntityRoundResult, BatchError> {
        let outcome = self.finish_entity_outbound_attempt(prepared, followups);
        if outcome.is_err() {
            self.reset_outbound_candidate()?;
        }
        outcome
    }

    fn finish_entity_outbound_attempt(
        &mut self,
        mut prepared: PreparedEntityOutbound,
        followups: Vec<FailedHtlcFollowup>,
    ) -> Result<EntityRoundResult, BatchError> {
        let mut grouped = BTreeMap::<AccountId, Vec<AccountTx>>::new();
        let mut follow_order = Vec::new();
        let mut seen = BTreeSet::new();
        for followup in followups {
            let hashlock = format!("0x{}", root_hex(followup.hashlock));
            let valid_tx = matches!(
                &followup.tx,
                AccountTx::HtlcResolve(resolve)
                    if resolve.lock_id == hashlock
                        && matches!(
                            &resolve.outcome,
                            xln_rscore_engine::HtlcResolveOutcome::Error { reason: Some(reason) }
                                if reason == &followup.reason
                        )
            );
            if !valid_tx {
                return Err(BatchError::HtlcFollowupTx {
                    account_id: followup.upstream_account_id,
                    hashlock,
                });
            }
            if !seen.insert((followup.failed_account_id, followup.hashlock)) {
                return Err(BatchError::HtlcFollowupUnmatched {
                    account_id: followup.failed_account_id,
                    hashlock,
                });
            }
            let failed = prepared
                .proposals
                .iter_mut()
                .find(|proposal| proposal.account_id == followup.failed_account_id)
                .and_then(|proposal| {
                    proposal
                        .failed_htlc_locks
                        .iter_mut()
                        .find(|failed| failed.hashlock == followup.hashlock)
                })
                .filter(|failed| failed.upstream_resolution.is_none())
                .ok_or_else(|| BatchError::HtlcFollowupUnmatched {
                    account_id: followup.failed_account_id,
                    hashlock: hashlock.clone(),
                })?;
            failed.upstream_resolution = Some(UpstreamHtlcResolutionRow {
                account_id: followup.upstream_account_id,
                lock_id: hashlock,
                reason: followup.reason,
            });
            prepared.admissions.push(AccountAdmissionResult {
                operation_index: prepared.admissions.len() as u64,
                account_id: followup.upstream_account_id,
                verdict: AccountAdmissionVerdict::Admitted { count: 1 },
            });
            if !grouped.contains_key(&followup.upstream_account_id) {
                follow_order.push(followup.upstream_account_id);
            }
            grouped
                .entry(followup.upstream_account_id)
                .or_default()
                .push(followup.tx);
            prepared.named.insert(followup.upstream_account_id);
        }
        if !grouped.is_empty() {
            let entries = follow_order
                .iter()
                .map(|account_id| {
                    let txs = grouped
                        .remove(account_id)
                        .expect("follow-up account is ordered");
                    (
                        *account_id,
                        OutboundWork {
                            create: None,
                            envelope_updates: Vec::new(),
                            admissions: txs.clone(),
                            proposal_selection: Some(BatchAccountSelection::Selected(txs)),
                            force_ack: false,
                            seal: true,
                        },
                    )
                })
                .collect();
            let mut batch = self.run_outbound(
                true,
                entries,
                prepared.owner,
                Arc::clone(&prepared.identity),
                prepared.timestamp,
                prepared.j_height,
                prepared.local_board_authority,
                &mut prepared.round_leafs,
            )?;
            let continued = proposals_from(&mut batch.rows, &follow_order);
            if let Some((proposal, failed)) = continued.iter().find_map(|proposal| {
                proposal
                    .failed_htlc_locks
                    .first()
                    .map(|failed| (proposal, failed))
            }) {
                return Err(BatchError::HtlcFollowupCascade {
                    account_id: proposal.account_id,
                    hashlock: root_hex(failed.hashlock),
                });
            }
            prepared.proposals.extend(continued);
        }
        // Every named Account was applied by an outbound phase this round, so
        // its exact post-round leaf is already in the worker replies. Reading
        // the values again would repeat the same visit and the same hash;
        // only `post_accounts` still needs full checkpoint-row encoding.
        let materialized = if prepared.post_accounts {
            self.materialize(prepared.named, true)?
        } else {
            prepared
                .named
                .iter()
                .map(|account_id| {
                    prepared
                        .round_leafs
                        .get(account_id)
                        .copied()
                        .map(|leaf| {
                            (
                                *account_id,
                                MaterializedAccount {
                                    leaf,
                                    checkpoint: None,
                                },
                            )
                        })
                        .ok_or(BatchError::CandidateAccountNotFound(*account_id))
                })
                .collect::<Result<Vec<_>, _>>()?
        };
        let checkpoint = if prepared.checkpoint_due {
            Some(self.export_checkpoint()?)
        } else {
            None
        };
        let mut result = EntityRoundResult {
            revision: checkpoint
                .as_ref()
                .map_or_else(|| self.forest.revision(), AccountsCheckpoint::revision),
            accounts_root: checkpoint.as_ref().map_or_else(
                || self.forest.accounts_root(),
                AccountsCheckpoint::accounts_root,
            ),
            admissions: prepared.admissions,
            proposals: prepared.proposals,
            checkpoint,
            ..EntityRoundResult::default()
        };
        for (account_id, row) in materialized {
            result.touched.push((account_id, row.leaf));
            if let Some(checkpoint) = row.checkpoint {
                result.post_accounts.push(checkpoint);
            }
        }
        if prepared.identity_is_new {
            self.identities.insert(prepared.owner, prepared.identity);
        }
        Ok(result)
    }

    fn reset_outbound_candidate(&mut self) -> Result<(), BatchError> {
        self.forest
            .apply_outbound::<(), (), _>(Vec::new(), |account_id, _, ()| {
                Err(BatchError::AccountNotFound {
                    input_index: 0,
                    account_id,
                })
            })?;
        self.candidate_proposable = None;
        self.candidate_rebalance_work = None;
        self.candidate_owner_adds.clear();
        Ok(())
    }

    // One internal dispatch point for every outbound wave phase; the extra
    // round-leaf sink argument is cheaper than a context struct rebuilt per
    // phase.
    #[allow(clippy::too_many_arguments)]
    fn run_outbound(
        &mut self,
        continue_candidate: bool,
        entries: Vec<(AccountId, OutboundWork)>,
        owner: [u8; 32],
        identity: Arc<SigningIdentity>,
        timestamp: u64,
        j_height: u64,
        local_board_authority: Option<xln_rscore_engine::CertifiedBoardAuthority>,
        round_leafs: &mut BTreeMap<AccountId, [u8; 32]>,
    ) -> Result<crate::parallel::ResidentAccountBatch<OutboundOutcome>, BatchError> {
        let context = OutboundApplyContext {
            owner,
            identity,
            timestamp,
            j_height,
            local_board_authority,
            swap_market: Arc::clone(&self.swap_market),
        };
        let apply =
            move |account_id: AccountId, current: Option<&AccountConsensus>, work: OutboundWork| {
                apply_outbound_work(account_id, current, work, &context)
            };
        // Continuation owns the candidate set: on any error this round the
        // caller resets to the inbound snapshot anyway, so moving instead of
        // cloning cannot leave a live set behind. The inbound set itself must
        // survive every retry and is therefore the only clone left.
        let mut next_proposable = if continue_candidate {
            self.candidate_proposable
                .take()
                .or_else(|| self.inbound_proposable.clone())
                .ok_or(BatchError::EntityRoundMissing)?
        } else {
            self.inbound_proposable
                .clone()
                .ok_or(BatchError::EntityRoundMissing)?
        };
        let mut next_rebalance_work = if continue_candidate {
            self.candidate_rebalance_work
                .take()
                .or_else(|| self.inbound_rebalance_work.clone())
                .ok_or(BatchError::EntityRoundMissing)?
        } else {
            self.inbound_rebalance_work
                .clone()
                .ok_or(BatchError::EntityRoundMissing)?
        };
        let created_ids = entries
            .iter()
            .filter(|(_, work)| work.create.is_some())
            .map(|(account_id, _)| *account_id)
            .collect::<Vec<_>>();
        let batch = if continue_candidate {
            self.forest.apply_outbound_continue(
                OutboundContinuationKind::FailedHtlcFollowup,
                entries,
                apply,
            )?
        } else {
            // A reset discards the previous candidate together with any
            // Accounts only that candidate created.
            self.candidate_owner_adds.clear();
            self.forest.apply_outbound(entries, apply)?
        };
        for account_id in created_ids {
            self.candidate_owner_adds.insert(account_id, owner);
        }
        for (account_id, leaf, outcome) in &batch.rows {
            set_proposable(&mut next_proposable, *account_id, outcome.proposable);
            set_work_membership(
                &mut next_rebalance_work,
                *account_id,
                outcome.has_rebalance_work,
            );
            // The worker already sealed this exact leaf while applying the
            // phase; a later within-round phase overwrites it, so the final
            // map entry is always the round's closing commitment.
            round_leafs.insert(*account_id, *leaf);
        }
        self.candidate_proposable = Some(next_proposable);
        self.candidate_rebalance_work = Some(next_rebalance_work);
        Ok(batch)
    }

    fn materialize(
        &mut self,
        account_ids: BTreeSet<AccountId>,
        include_checkpoint: bool,
    ) -> Result<Vec<(AccountId, MaterializedAccount)>, BatchError> {
        let signer_id = Arc::clone(&self.signer_id);
        self.forest.read_outbound(
            account_ids
                .into_iter()
                .map(|account_id| (account_id, ()))
                .collect(),
            move |account_id, account, base, ()| {
                let leaf = leaf_root(account_id, account)?;
                let checkpoint = include_checkpoint
                    .then(|| {
                        account_rows(account_id, account, base, leaf, &signer_id)
                            .map_err(|error| state_error(account_id, &error))
                    })
                    .transpose()?;
                Ok(MaterializedAccount { leaf, checkpoint })
            },
        )
    }

    fn identity_candidate(
        &self,
        owner: [u8; 32],
        creating: bool,
    ) -> Result<(Arc<SigningIdentity>, bool), BatchError> {
        if let Some(identity) = self.identities.get(&owner) {
            return Ok((Arc::clone(identity), false));
        }
        if !creating {
            return Err(BatchError::SignerRequired);
        }
        let identity = Arc::new(build_signing_identity(
            owner,
            self.private_key,
            &self.signer_id,
        )?);
        Ok((identity, true))
    }

    /// Checkpoint signer metadata from the incremental RAM owner projection.
    /// The digest formula and row order are unchanged: rows are every Account
    /// at the active head sorted by id, exactly what a full resident scan
    /// produced. Debug builds still run that scan as an oracle.
    fn checkpoint_signer_digest(&mut self) -> Result<[u8; 32], BatchError> {
        let pending = self
            .inbound_owner_adds
            .iter()
            .chain(self.candidate_owner_adds.iter())
            .map(|(account_id, owner)| (*account_id, *owner))
            .collect::<BTreeMap<_, _>>();
        let total = self.signer_owners.len() + pending.len();
        if total != self.forest.len() {
            return Err(BatchError::CheckpointIncomplete {
                actual: total,
                expected: self.forest.len(),
            });
        }
        let mut rows = Vec::with_capacity(total);
        {
            let mut base = self.signer_owners.iter().peekable();
            let mut adds = pending.iter().peekable();
            loop {
                let take_base = match (base.peek(), adds.peek()) {
                    (Some((left, _)), Some((right, _))) => left < right,
                    (Some(_), None) => true,
                    (None, Some(_)) => false,
                    (None, None) => break,
                };
                let (account_id, owner) = if take_base {
                    base.next().expect("peeked base row")
                } else {
                    adds.next().expect("peeked pending row")
                };
                rows.push((*account_id, *owner));
            }
        }
        let signer_id = Arc::clone(&self.signer_id);
        let digest = crate::checkpoint::signer_digest(
            rows.iter()
                .map(|(account_id, owner)| (*account_id, *owner, signer_id.as_ref())),
        );
        #[cfg(debug_assertions)]
        {
            let scanned = self
                .forest
                .read_all(|_, account| Ok(*account.replica().owner().as_bytes()))?;
            let oracle = crate::checkpoint::signer_digest(
                scanned
                    .iter()
                    .map(|(account_id, owner)| (*account_id, *owner, signer_id.as_ref())),
            );
            assert_eq!(digest, oracle, "RSCORE_SIGNER_DIGEST_PROJECTION_DIVERGED");
        }
        Ok(digest)
    }
}

struct OutboundApplyContext {
    owner: [u8; 32],
    identity: Arc<SigningIdentity>,
    timestamp: u64,
    j_height: u64,
    local_board_authority: Option<xln_rscore_engine::CertifiedBoardAuthority>,
    swap_market: Arc<SwapMarketPolicy>,
}

fn apply_outbound_work(
    account_id: AccountId,
    current: Option<&AccountConsensus>,
    work: OutboundWork,
    context: &OutboundApplyContext,
) -> Result<ResidentAccountAction<AccountConsensus, OutboundOutcome>, BatchError> {
    let mut changed = false;
    let mut account = match (current, work.create) {
        (Some(_), Some(_)) => return Err(BatchError::WaveCreateExisting(account_id)),
        (Some(account), None) => account.clone(),
        (None, Some(seed)) => {
            changed = true;
            validate_genesis_seed(context.owner, &seed)?
        }
        (None, None) => {
            return Err(BatchError::AccountNotFound {
                input_index: 0,
                account_id,
            });
        }
    };
    assert_account_owner(account_id, &account, context.owner)?;
    account.set_local_board_authority(context.local_board_authority);
    if !work.admissions.is_empty() {
        account
            .admit_txs(work.admissions, "rscoreConsensus:admit")
            .map_err(|error| state_error(account_id, &error))?;
        changed = true;
    }
    for update in work.envelope_updates {
        match update {
            crate::AccountEnvelopeUpdate::ClearRebalanceActiveQuote => {
                account
                    .clear_rebalance_active_quote()
                    .map_err(|error| state_error(account_id, &error))?;
                changed = true;
            }
            crate::AccountEnvelopeUpdate::SetRejectedFrameEvidence {
                reason,
                frame_hash,
                frame_hanko,
            } => {
                account
                    .set_entity_rejected_frame_evidence(reason, frame_hash, frame_hanko)
                    .map_err(|error| state_error(account_id, &error))?;
                changed = true;
            }
            crate::AccountEnvelopeUpdate::SetRebalancePolicy { token_id, policy } => {
                let token_id =
                    TokenId::new(token_id).map_err(|error| BatchError::AccountsTree {
                        account_id,
                        detail: error.to_string(),
                    })?;
                account
                    .set_rebalance_shadow_policy(token_id, policy)
                    .map_err(|error| state_error(account_id, &error))?;
                changed = true;
            }
            crate::AccountEnvelopeUpdate::SetRebalanceSubmittedAt {
                token_id,
                submitted_at,
            } => {
                let token_id =
                    TokenId::new(token_id).map_err(|error| BatchError::AccountsTree {
                        account_id,
                        detail: error.to_string(),
                    })?;
                account
                    .set_rebalance_submitted_at(token_id, submitted_at)
                    .map_err(|error| state_error(account_id, &error))?;
                changed = true;
            }
            crate::AccountEnvelopeUpdate::ReplaceDisputeLifecycle {
                status,
                dispute_prepare,
                active_dispute,
            } => {
                account
                    .replace_entity_dispute_lifecycle(&status, dispute_prepare, active_dispute)
                    .map_err(|error| state_error(account_id, &error))?;
                changed = true;
            }
            crate::AccountEnvelopeUpdate::ApplyDisputeStarted(finality) => {
                account
                    .apply_entity_dispute_started(finality)
                    .map_err(|error| state_error(account_id, &error))?;
                changed = true;
            }
            crate::AccountEnvelopeUpdate::ApplyDisputeFinality(finality) => {
                account
                    .apply_entity_dispute_finality(finality)
                    .map_err(|error| state_error(account_id, &error))?;
                changed = true;
            }
            crate::AccountEnvelopeUpdate::ConfirmDisputeBookRemoval { order_id } => {
                account
                    .confirm_dispute_book_removal(&order_id)
                    .map_err(|error| state_error(account_id, &error))?;
                changed = true;
            }
        }
    }
    let selection = match work.proposal_selection {
        None | Some(BatchAccountSelection::WaitForSibling) => None,
        Some(BatchAccountSelection::WholeMempool) => Some(AccountProposalSelection::WholeMempool),
        Some(BatchAccountSelection::Selected(txs)) => Some(AccountProposalSelection::Selected(txs)),
    };
    let proposal = if let (true, Some(selection)) = (proposable(&account)?, selection) {
        let outcome = propose_account_frame_with_selection(
            &mut account,
            &context.identity,
            context.timestamp,
            context.j_height,
            selection,
            &context.swap_market,
        )
        .map_err(|error| state_error(account_id, &error))?;
        changed = true;
        let mut row = proposal_row(account_id, outcome, &account)?;
        if work.force_ack && row.outbound_input.is_none() {
            row.outbound_input =
                Some(
                    outbound_ack_input(&account).ok_or_else(|| BatchError::AccountsTree {
                        account_id,
                        detail: "ACCOUNT_FORCE_ACK_STATE_MISSING".to_string(),
                    })?,
                );
        }
        if work.force_ack
            && !row.outbound_input.as_ref().is_some_and(|input| {
                matches!(
                    &input.kind,
                    crate::AccountInputKind::Ack(_)
                        | crate::AccountInputKind::AckFrame { ack: Some(_), .. }
                )
            })
        {
            return Err(BatchError::AccountsTree {
                account_id,
                detail: "ACCOUNT_FORCE_ACK_NOT_BUNDLED".to_string(),
            });
        }
        Some(row)
    } else if work.force_ack {
        Some(ProposalRow {
            account_id,
            outbound_input: Some(outbound_ack_input(&account).ok_or_else(|| {
                BatchError::AccountsTree {
                    account_id,
                    detail: "ACCOUNT_FORCE_ACK_STATE_MISSING".to_string(),
                }
            })?),
            proposed: None,
            dropped: Vec::new(),
            failed_htlc_locks: Vec::new(),
        })
    } else {
        None
    };
    let result = OutboundOutcome {
        proposal,
        proposable: proposable(&account)?,
        has_rebalance_work: has_rebalance_work(&account)?,
    };
    if changed || work.seal {
        let leaf = leaf_root(account_id, &account)?;
        Ok(ResidentAccountAction::Put {
            value: account,
            value_digest: leaf,
            result,
        })
    } else {
        Ok(ResidentAccountAction::Keep(result))
    }
}

fn admission_results(
    admits: &[(AccountId, Vec<AccountTx>, BatchAccountSelection, bool)],
) -> Vec<AccountAdmissionResult> {
    admits
        .iter()
        .filter(|(_, txs, _, _)| !txs.is_empty())
        .enumerate()
        .map(|(index, (account_id, txs, _, _))| AccountAdmissionResult {
            operation_index: index as u64,
            account_id: *account_id,
            verdict: AccountAdmissionVerdict::Admitted { count: txs.len() },
        })
        .collect()
}

fn proposable_from_entries(
    entries: &[(AccountId, AccountConsensus, [u8; 32])],
) -> Result<BTreeSet<AccountId>, BatchError> {
    let mut ready = BTreeSet::new();
    for (account_id, account, _) in entries {
        if proposable(account)? {
            ready.insert(*account_id);
        }
    }
    Ok(ready)
}

fn rebalance_work_from_entries(
    entries: &[(AccountId, AccountConsensus, [u8; 32])],
) -> Result<BTreeSet<AccountId>, BatchError> {
    let mut ready = BTreeSet::new();
    for (account_id, account, _) in entries {
        if has_rebalance_work(account)? {
            ready.insert(*account_id);
        }
    }
    Ok(ready)
}

fn set_proposable(accounts: &mut BTreeSet<AccountId>, account_id: AccountId, ready: bool) {
    if ready {
        accounts.insert(account_id);
    } else {
        accounts.remove(&account_id);
    }
}

fn set_work_membership(accounts: &mut BTreeSet<AccountId>, account_id: AccountId, ready: bool) {
    if ready {
        accounts.insert(account_id);
    } else {
        accounts.remove(&account_id);
    }
}

type OutboundWorkSet = (
    Vec<(AccountId, OutboundWork)>,
    BTreeSet<AccountId>,
    Vec<AccountId>,
);

fn outbound_work(request: &mut EntityOutboundRequest) -> Result<OutboundWorkSet, BatchError> {
    let mut grouped = BTreeMap::<AccountId, OutboundWork>::new();
    for seed in &request.creates {
        if grouped
            .insert(
                seed.account_id,
                OutboundWork {
                    create: Some(seed.clone()),
                    envelope_updates: Vec::new(),
                    admissions: Vec::new(),
                    proposal_selection: None,
                    force_ack: false,
                    seal: true,
                },
            )
            .is_some()
        {
            return Err(BatchError::DuplicateAccount(seed.account_id));
        }
    }
    let mut selected = BTreeSet::new();
    for (account_id, tx) in std::mem::take(&mut request.unsigned_settlement_txs) {
        if !selected.insert(account_id) {
            return Err(BatchError::DuplicateAccount(account_id));
        }
        grouped
            .entry(account_id)
            .or_insert(OutboundWork {
                create: None,
                envelope_updates: Vec::new(),
                admissions: Vec::new(),
                proposal_selection: None,
                force_ack: false,
                seal: true,
            })
            .admissions
            .push(tx);
    }
    let unsigned_accounts = selected.clone();
    let mut proposal_order = Vec::with_capacity(request.proposal_work.len());
    for (account_id, txs, selection, force_ack) in std::mem::take(&mut request.proposal_work) {
        if !selected.insert(account_id) {
            // A same-round ACK obligation may target the Account whose
            // settlement transition is waiting for this Entity frame's
            // manifest Hanko. Merge only that empty response directive; a
            // second financial admission remains a hard duplicate.
            if !unsigned_accounts.contains(&account_id) || !txs.is_empty() {
                return Err(BatchError::DuplicateAccount(account_id));
            }
            proposal_order.push(account_id);
            grouped
                .get_mut(&account_id)
                .expect("unsigned settlement row exists")
                .force_ack |= force_ack;
            continue;
        }
        proposal_order.push(account_id);
        let work = grouped.entry(account_id).or_insert(OutboundWork {
            create: None,
            envelope_updates: Vec::new(),
            admissions: Vec::new(),
            proposal_selection: None,
            force_ack,
            seal: true,
        });
        work.admissions.extend(txs);
        work.proposal_selection = Some(selection);
        work.force_ack |= force_ack;
    }
    for (account_id, updates) in std::mem::take(&mut request.envelope_updates) {
        grouped
            .entry(account_id)
            .or_insert(OutboundWork {
                create: None,
                envelope_updates: Vec::new(),
                admissions: Vec::new(),
                proposal_selection: None,
                force_ack: false,
                seal: true,
            })
            .envelope_updates
            .extend(updates);
    }
    let named = grouped.keys().copied().collect::<BTreeSet<_>>();
    Ok((grouped.into_iter().collect(), named, proposal_order))
}

fn proposals_from(
    rows: &mut [(AccountId, [u8; 32], OutboundOutcome)],
    order: &[AccountId],
) -> Vec<ProposalRow> {
    let mut by_account = rows
        .iter_mut()
        .filter_map(|(account_id, _, outcome)| {
            outcome.proposal.take().map(|row| (*account_id, row))
        })
        .collect::<BTreeMap<_, _>>();
    order
        .iter()
        .filter_map(|account_id| by_account.remove(account_id))
        .collect()
}

fn validate_operation_indices(rows: &[AccountInputRow]) -> Result<(), BatchError> {
    for (expected, row) in rows.iter().enumerate() {
        let expected = u64::try_from(expected).map_err(|_| BatchError::OperationIndex {
            actual: row.operation_index,
            after: None,
        })?;
        if row.operation_index != expected {
            return Err(BatchError::OperationIndex {
                actual: row.operation_index,
                after: expected.checked_sub(1),
            });
        }
    }
    Ok(())
}

fn assert_account_owner(
    account_id: AccountId,
    account: &AccountConsensus,
    owner: [u8; 32],
) -> Result<(), BatchError> {
    if account.replica().owner().as_bytes() == &owner {
        return Ok(());
    }
    Err(BatchError::WaveAccountOwner {
        account_id,
        entity_id: root_hex(owner),
    })
}

fn root_hex(bytes: [u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut text = String::with_capacity(64);
    for byte in bytes {
        text.push(HEX[usize::from(byte >> 4)] as char);
        text.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    text
}

#[cfg(test)]
mod clone_on_mutation_tests {
    use super::{CloneOnMutation, cross_j_opening_txs};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use xln_rscore_engine::{AccountTx, CanonicalValue, TokenId};

    struct CloneProbe {
        value: u64,
        clones: Arc<AtomicUsize>,
    }

    impl Clone for CloneProbe {
        fn clone(&self) -> Self {
            self.clones.fetch_add(1, Ordering::Relaxed);
            Self {
                value: self.value,
                clones: Arc::clone(&self.clones),
            }
        }
    }

    #[test]
    fn borrowed_candidate_clones_only_when_mutation_is_requested() {
        let clones = Arc::new(AtomicUsize::new(0));
        let resident = CloneProbe {
            value: 7,
            clones: Arc::clone(&clones),
        };
        let candidate = CloneOnMutation::Borrowed(&resident);

        // Read-only classification and Keep consume only the borrowed head.
        assert_eq!(candidate.as_ref().value, 7);
        assert!(candidate.into_owned().is_none());
        assert_eq!(clones.load(Ordering::Relaxed), 0);

        let mut candidate = CloneOnMutation::Borrowed(&resident);
        candidate.make_mut().value = 8;
        assert_eq!(candidate.as_ref().value, 8);
        assert_eq!(clones.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn cross_j_opening_projection_excludes_ordinary_and_incomplete_txs() {
        let opening = AccountTx::CrossPullLock {
            data: CanonicalValue::Object(vec![
                (
                    "crossJurisdiction".into(),
                    CanonicalValue::Object(Vec::new()),
                ),
                (
                    "crossJurisdictionRoute".into(),
                    CanonicalValue::Object(Vec::new()),
                ),
            ]),
        };
        let incomplete = AccountTx::CrossPullLock {
            data: CanonicalValue::Object(vec![(
                "crossJurisdiction".into(),
                CanonicalValue::Object(Vec::new()),
            )]),
        };
        let ordinary = AccountTx::AddDelta {
            token_id: TokenId::new(1).expect("token"),
        };
        assert_eq!(
            cross_j_opening_txs(&[ordinary, incomplete, opening.clone()]),
            vec![opening]
        );
    }
}

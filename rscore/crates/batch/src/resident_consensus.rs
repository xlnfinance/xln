//! Canonical two-visit Account authority over permanently resident shards.
//!
//! The parent Entity calls this machine once with peer arrivals and once with
//! the Entity-derived admissions/proposal worklist. Account replicas and every
//! Patricia node below the three-nibble boundary stay in their owner worker;
//! only verdicts, effects, proposal envelopes, and compact shard commitments
//! cross back to the coordinator.

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use num_bigint::BigInt;
use xln_rscore_engine::{
    AccountConsensus, AccountTx, CanonicalValue, HtlcResolveOutcome, HtlcResolveTx,
    SigningIdentity, SwapMarketPolicy, TokenId, address_of_private_key, propose_account_frame,
};

use crate::checkpoint::{AccountCheckpointRows, AccountsCheckpoint, account_rows};
use crate::consensus::{
    AccountAdmissionResult, AccountAdmissionVerdict, AccountInputResult, AccountInputRow,
    FailedHtlcLockRow, ProposalRow, UpstreamHtlcResolutionRow, account_response_directive,
    apply_one, build_signing_identity, inbound_genesis_account, leaf_root, proposable,
    proposal_row, restore_checkpoint_account, restore_seed_account, state_error,
    validate_genesis_seed, verdict_commits_genesis,
};
use crate::parallel::{ResidentAccountAction, ResidentAccountForest};
use crate::round::{
    EntityInboundRequest, EntityOutboundRequest, EntityRoundResult, FailedHtlcRoute,
};
use crate::{
    AccountId, AccountRestore, AccountSeed, BatchError, CheckpointToken, EngineGeneration,
    MAX_BATCH_WORKERS,
};

thread_local! {
    static HTLC_FRONTIER_BARRIERS: Cell<usize> = const { Cell::new(0) };
}

#[derive(Clone)]
struct InboundWork {
    rows: Vec<AccountInputRow>,
}

struct InboundOutcome {
    applied: Vec<AccountInputResult>,
    leaf: [u8; 32],
    created_checkpoint: Option<AccountCheckpointRows>,
    proposable: bool,
}

#[derive(Clone)]
struct OutboundWork {
    create: Option<AccountSeed>,
    txs: Option<Vec<AccountTx>>,
    propose: bool,
}

struct OutboundOutcome {
    proposal: Option<ProposalRow>,
    proposable: bool,
}

struct MaterializedAccount {
    leaf: [u8; 32],
    checkpoint: Option<AccountCheckpointRows>,
}

/// The only Account-state projection local Entity financial admission needs.
/// Account replicas and radix nodes remain resident on their owner workers;
/// the coordinator receives one status bit and requested owner capacities.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResidentAccountFinancialView {
    pub active: bool,
    pub owner_in_capacity: BTreeMap<TokenId, BigInt>,
    pub owner_out_capacity: BTreeMap<TokenId, BigInt>,
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
    /// RAM-only owner projection of every accepted Account, maintained
    /// incrementally so checkpoint metadata never rescans resident workers.
    /// Owners are written exactly once at genesis and never change, so the
    /// projection follows the same accept/rollback lifecycle as the
    /// proposable sets: pending adds merge on candidate acceptance and drop
    /// on base rollback. Derived state: a restart rebuilds it from restore.
    signer_owners: BTreeMap<AccountId, [u8; 32]>,
    inbound_owner_adds: BTreeMap<AccountId, [u8; 32]>,
    candidate_owner_adds: BTreeMap<AccountId, [u8; 32]>,
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
    /// worker-owned shard. The reconstructed forest root is the same leaf/root
    /// commitment used by `StatefulConsensusEngine`.
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
            signer_owners,
            inbound_owner_adds: BTreeMap::new(),
            candidate_owner_adds: BTreeMap::new(),
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
            signer_owners: signer_rows
                .iter()
                .map(|(account_id, owner, _)| (*account_id, *owner))
                .collect(),
            inbound_owner_adds: BTreeMap::new(),
            candidate_owner_adds: BTreeMap::new(),
        })
    }

    pub const fn engine_generation(&self) -> EngineGeneration {
        self.engine_generation
    }

    pub fn worker_count(&self) -> usize {
        self.forest.worker_count()
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

    /// Integration tests compile this crate without `cfg(test)`, so the
    /// barrier counter cannot live on the production struct. The thread-local
    /// is RAM-only and is not part of any Account/Entity root.
    #[doc(hidden)]
    pub fn last_htlc_frontier_barriers() -> usize {
        HTLC_FRONTIER_BARRIERS.with(Cell::get)
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

    /// Attach freshly certified local dispute witnesses to the worker-owned
    /// Account replicas. Hanko bytes are envelope evidence, so every leaf and
    /// the aggregate Account root must remain byte-identical.
    pub fn attach_local_dispute_hankos(
        &mut self,
        account_ids: &[AccountId],
        witnesses: BTreeMap<[u8; 32], Vec<u8>>,
    ) -> Result<(), BatchError> {
        if witnesses.is_empty() {
            return Ok(());
        }
        let before_root = self.forest.accounts_root();
        let expected = witnesses.keys().copied().collect::<BTreeSet<_>>();
        let witnesses = Arc::new(witnesses);
        let rows = self.forest.apply_outbound_continue(
            account_ids.iter().copied().map(|account_id| (account_id, ())).collect(),
            move |account_id, account, ()| {
                let mut account = account.ok_or(BatchError::CandidateAccountNotFound(account_id))?;
                let hashes = account.unsigned_local_dispute_hashes();
                if hashes.is_empty() {
                    return Ok(ResidentAccountAction::Keep(None));
                }
                let before_leaf = leaf_root(account_id, &account)?;
                for hash in &hashes {
                    let hanko = match witnesses.get(hash).cloned() {
                        Some(hanko) => hanko,
                        None => {
                            let snapshot = account.consensus_snapshot();
                            let current = snapshot.dispute.as_ref().is_some_and(|draft| draft.hash == *hash);
                            let last_ack = snapshot
                                .last_outbound_ack
                                .as_ref()
                                .and_then(|ack| ack.dispute.as_ref())
                                .is_some_and(|draft| draft.hash == *hash);
                            let proposal = snapshot
                                .pending
                                .as_ref()
                                .and_then(|pending| pending.proposal_dispute.as_ref())
                                .is_some_and(|draft| draft.hash == *hash);
                            let bundled_ack = snapshot
                                .pending
                                .as_ref()
                                .and_then(|pending| pending.bundled_ack.as_ref())
                                .and_then(|ack| ack.dispute.as_ref())
                                .is_some_and(|draft| draft.hash == *hash);
                            return Err(BatchError::Signing(format!(
                                "LOCAL_DISPUTE_HANKO_MISSING:account={}:hash={}:available={}:current={current}:lastAck={last_ack}:proposal={proposal}:bundledAck={bundled_ack}",
                                root_hex(*account_id.as_bytes()),
                                root_hex(*hash),
                                witnesses.len(),
                            )));
                        }
                    };
                    account
                        .attach_local_dispute_hanko(*hash, hanko)
                        .map_err(|error| state_error(account_id, &error))?;
                }
                let after_leaf = leaf_root(account_id, &account)?;
                if after_leaf != before_leaf {
                    return Err(BatchError::CheckpointAccountLeaf {
                        account_id,
                        actual: root_hex(after_leaf),
                        expected: root_hex(before_leaf),
                    });
                }
                Ok(ResidentAccountAction::ReplaceEnvelope {
                    value: account,
                    expected_digest: after_leaf,
                    result: Some(hashes),
                })
            },
        )?;
        let attached = rows
            .rows
            .into_iter()
            .filter_map(|(_, _, hashes)| hashes)
            .flatten()
            .collect::<BTreeSet<_>>();
        if attached != expected {
            return Err(BatchError::Signing(
                "LOCAL_DISPUTE_HANKO_UNUSED".to_string(),
            ));
        }
        let after_root = self.forest.accounts_root();
        if after_root != before_root {
            return Err(BatchError::CheckpointRoot {
                actual: root_hex(after_root),
                expected: root_hex(before_root),
            });
        }
        Ok(())
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

    /// Exact resident worklist before Entity adds same-round transactions.
    /// Values stay inside their owner workers; only matching Account ids cross
    /// back to the coordinator.
    pub fn proposable_account_ids(&self) -> Result<Vec<AccountId>, BatchError> {
        Ok(self.active_proposable()?.iter().copied().collect())
    }

    pub fn has_proposable_accounts(&self) -> Result<bool, BatchError> {
        Ok(!self.active_proposable()?.is_empty())
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

    /// Read canonical Account availability and owner-perspective capacities
    /// after the inbound visit. This mirrors the narrow fields consulted by
    /// TypeScript's `validatePreparedHtlcPayment`; it never materializes or
    /// copies an Account replica at the Entity coordinator.
    pub fn local_financial_views(
        &mut self,
        requests: Vec<(AccountId, Vec<TokenId>)>,
    ) -> Result<Vec<(AccountId, ResidentAccountFinancialView)>, BatchError> {
        self.forest
            .read_outbound(requests, |_, account, _, token_ids| {
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
                let mut owner_in_capacity = BTreeMap::new();
                let mut owner_out_capacity = BTreeMap::new();
                for token_id in token_ids {
                    let Some(delta) = account.replica().state().delta(token_id) else {
                        continue;
                    };
                    let perspective = delta.perspective(owner_side);
                    owner_in_capacity.insert(token_id, perspective.in_capacity);
                    owner_out_capacity.insert(token_id, perspective.out_capacity);
                }
                Ok(ResidentAccountFinancialView {
                    active,
                    owner_in_capacity,
                    owner_out_capacity,
                })
            })
    }

    fn active_proposable(&self) -> Result<&BTreeSet<AccountId>, BatchError> {
        Ok(self
            .candidate_proposable
            .as_ref()
            .or(self.inbound_proposable.as_ref())
            .unwrap_or(&self.base_proposable))
    }

    /// First and only inward visit for one Entity input.
    pub fn entity_inbound(
        &mut self,
        request: EntityInboundRequest,
    ) -> Result<EntityRoundResult, BatchError> {
        if request.post_accounts {
            return Err(BatchError::EntityInboundPostAccounts);
        }
        let uses_candidate = self
            .forest
            .expected_uses_candidate(request.expected_accounts_root)?;
        if uses_candidate && self.candidate_proposable.is_none() {
            return Err(BatchError::EntityRoundMissing);
        }
        validate_operation_indices(&request.rows)?;
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
        let batch = self.forest.apply_inbound(
            request.expected_accounts_root,
            entries,
            move |account_id, current, work| {
                let created = current.is_none();
                let mut account =
                    match current {
                        Some(account) => {
                            if work.rows.iter().any(|row| row.genesis_policy.is_some()) {
                                return Err(BatchError::InboundGenesis {
                                    account_id,
                                    detail: "POLICY_FOR_EXISTING".to_string(),
                                });
                            }
                            account
                        }
                        None => {
                            let first = work.rows.first().ok_or(BatchError::InboundGenesis {
                                account_id,
                                detail: "INPUT_REQUIRED".to_string(),
                            })?;
                            let policy = first.genesis_policy.as_ref().ok_or(
                                BatchError::InboundGenesis {
                                    account_id,
                                    detail: "POLICY_REQUIRED".to_string(),
                                },
                            )?;
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
                            inbound_genesis_account(account_id, owner, &first.input, policy)?
                        }
                    };
                assert_account_owner(account_id, &account, owner)?;
                let mut applied = Vec::with_capacity(work.rows.len());
                let mut created_checkpoint = None;
                let mut changed = false;
                for (row_index, row) in work.rows.into_iter().enumerate() {
                    let authority = row.certified_board_authority.certified()?;
                    let local_authority = row.local_certified_board_authority.certified()?;
                    let pure_ack = matches!(&row.input.kind, crate::AccountInputKind::Ack(_));
                    let (verdict, row_changed) = apply_one(
                        account_id,
                        &mut account,
                        &worker_identity,
                        row.input,
                        xln_rscore_engine::IncomingFrameSecurityContext {
                            clock,
                            peer_certified_board_authority: authority,
                            local_certified_board_authority: local_authority,
                        },
                        &market,
                    );
                    if created && row_index == 0 && !verdict_commits_genesis(&verdict) {
                        return Err(BatchError::InboundGenesis {
                            account_id,
                            detail: format!("H1_NOT_COMMITTED:{verdict:?}"),
                        });
                    }
                    if created && row_index == 0 {
                        let genesis_leaf = leaf_root(account_id, &account)?;
                        created_checkpoint = Some(
                            account_rows(account_id, &account, None, genesis_leaf, &signer_id)
                                .map_err(|error| state_error(account_id, &error))?,
                        );
                    }
                    changed |= row_changed;
                    let response = account_response_directive(&account, pure_ack, &verdict);
                    applied.push(AccountInputResult {
                        operation_index: row.operation_index,
                        account_id,
                        verdict,
                        response,
                    });
                }
                let leaf = leaf_root(account_id, &account)?;
                let result = InboundOutcome {
                    applied,
                    leaf,
                    created_checkpoint,
                    proposable: proposable(&account)?,
                };
                if changed {
                    Ok(ResidentAccountAction::Put {
                        value: account,
                        value_digest: leaf,
                        result,
                    })
                } else {
                    Ok(ResidentAccountAction::Keep(result))
                }
            },
        )?;
        // The parent named the candidate (or the base) and the workers already
        // reconciled to it, so promotion is a move: one clone seeds the new
        // inbound worklist instead of the previous clone-clone-move dance.
        let mut inbound_proposable = if uses_candidate {
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
        let mut result = EntityRoundResult {
            revision: batch.revision,
            accounts_root: batch.accounts_root,
            ..EntityRoundResult::default()
        };
        let mut created_any = false;
        for (account_id, _leaf, outcome) in batch.rows {
            set_proposable(&mut inbound_proposable, account_id, outcome.proposable);
            result.applied.extend(outcome.applied);
            result.touched.push((account_id, outcome.leaf));
            if let Some(created) = outcome.created_checkpoint {
                created_any = true;
                self.inbound_owner_adds.insert(account_id, owner);
                result.created_accounts.push(created);
            }
        }
        result.applied.sort_by_key(|row| row.operation_index);
        // An exact empty checkpoint still belongs to one Entity authority.
        // Its empty inbound half has no Account row from which to retain the
        // derived signer, but the matching checkpoint-only outbound half must
        // be able to commit the empty forest. Non-empty forests still require
        // a real created Account before admitting a new owner binding.
        if identity_is_new && (created_any || self.forest.len() == 0) {
            self.identities.insert(owner, identity);
        }
        self.inbound_proposable = Some(inbound_proposable);
        self.candidate_proposable = None;
        self.round_owner = Some(owner);
        Ok(result)
    }

    /// Second and only outward visit. Failed forwarded HTLCs run their rare
    /// cross-account fixed point inside this call; the parent never performs a
    /// third Account IPC round.
    pub fn entity_outbound(
        &mut self,
        request: EntityOutboundRequest,
    ) -> Result<EntityRoundResult, BatchError> {
        let outcome = self.entity_outbound_attempt(request);
        if outcome.is_err() {
            self.reset_outbound_candidate()?;
        }
        outcome
    }

    fn entity_outbound_attempt(
        &mut self,
        request: EntityOutboundRequest,
    ) -> Result<EntityRoundResult, BatchError> {
        let owner = request.owner_entity_id;
        let expected_owner = self.round_owner.ok_or(BatchError::EntityRoundMissing)?;
        if owner != expected_owner {
            return Err(BatchError::EntityRoundOwner {
                actual: root_hex(owner),
                expected: root_hex(expected_owner),
            });
        }
        reset_htlc_frontier_barriers();
        let (identity, identity_is_new) =
            self.identity_candidate(owner, !request.creates.is_empty())?;
        let original_admissions = admission_results(&request.admits);
        let create_entries = create_work(&request.creates)?;
        let (fast_entries, mut named) = outbound_work(&request)?;
        validate_routes(&request.failed_htlc_routes)?;

        let mut round_leafs = BTreeMap::new();
        if !create_entries.is_empty() {
            self.run_outbound(
                false,
                create_entries,
                owner,
                Arc::clone(&identity),
                0,
                0,
                &mut round_leafs,
            )?;
        }
        let fast = self.run_outbound(
            !request.creates.is_empty(),
            fast_entries,
            owner,
            Arc::clone(&identity),
            request.timestamp,
            request.j_height,
            &mut round_leafs,
        )?;
        let mut proposals = proposals_from(&fast.rows, &request.propose)?;
        let needs_fixed_point =
            proposals_need_htlc_followup(&proposals, &request.failed_htlc_routes);
        let mut admissions = original_admissions;
        if needs_fixed_point {
            let fixed = self.run_htlc_fixed_point(
                owner,
                Arc::clone(&identity),
                &request,
                &mut named,
                admissions,
                &mut round_leafs,
            )?;
            admissions = fixed.0;
            proposals = fixed.1;
        }
        // Every named Account was applied by an outbound phase this round, so
        // its exact post-round leaf is already in the worker replies. Reading
        // the values again would repeat the same visit and the same hash;
        // only `post_accounts` still needs full checkpoint-row encoding.
        let materialized = if request.post_accounts {
            self.materialize(named, true)?
        } else {
            named
                .iter()
                .map(|account_id| {
                    round_leafs
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
        let checkpoint = if request.checkpoint_due {
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
            admissions,
            proposals,
            checkpoint,
            ..EntityRoundResult::default()
        };
        for (account_id, row) in materialized {
            result.touched.push((account_id, row.leaf));
            if let Some(checkpoint) = row.checkpoint {
                result.post_accounts.push(checkpoint);
            }
        }
        if identity_is_new {
            self.identities.insert(owner, identity);
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
        round_leafs: &mut BTreeMap<AccountId, [u8; 32]>,
    ) -> Result<crate::parallel::ResidentAccountBatch<OutboundOutcome>, BatchError> {
        let context = OutboundApplyContext {
            owner,
            identity,
            timestamp,
            j_height,
            swap_market: Arc::clone(&self.swap_market),
        };
        let apply = move |account_id, current, work: OutboundWork| {
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
        let created_ids = entries
            .iter()
            .filter(|(_, work)| work.create.is_some())
            .map(|(account_id, _)| *account_id)
            .collect::<Vec<_>>();
        let batch = if continue_candidate {
            self.forest.apply_outbound_continue(entries, apply)?
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
            // The worker already sealed this exact leaf while applying the
            // phase; a later within-round phase overwrites it, so the final
            // map entry is always the round's closing commitment.
            round_leafs.insert(*account_id, *leaf);
        }
        self.candidate_proposable = Some(next_proposable);
        Ok(batch)
    }

    fn run_htlc_fixed_point(
        &mut self,
        owner: [u8; 32],
        identity: Arc<SigningIdentity>,
        request: &EntityOutboundRequest,
        named: &mut BTreeSet<AccountId>,
        mut admissions: Vec<AccountAdmissionResult>,
        round_leafs: &mut BTreeMap<AccountId, [u8; 32]>,
    ) -> Result<(Vec<AccountAdmissionResult>, Vec<ProposalRow>), BatchError> {
        let creates = create_work(&request.creates)?;
        self.run_outbound(
            false,
            creates,
            owner,
            Arc::clone(&identity),
            0,
            0,
            round_leafs,
        )?;

        let admitted = admission_work(&request.admits);
        if !admitted.is_empty() {
            self.run_outbound(
                true,
                admitted,
                owner,
                Arc::clone(&identity),
                0,
                0,
                round_leafs,
            )?;
        }
        let routes = request
            .failed_htlc_routes
            .iter()
            .map(|route| (route.hashlock, route))
            .collect::<BTreeMap<_, _>>();
        let (mut scheduled, mut order) = initial_htlc_worklist(&request.propose)?;
        let mut remaining = scheduled.clone();
        let mut proposals = Vec::new();
        reset_htlc_frontier_barriers();
        while !remaining.is_empty() {
            let frontier_ids = htlc_ready_frontier(&order, &remaining, &request.failed_htlc_routes);
            let frontier_ids = if frontier_ids.is_empty() {
                // TS does not reject cycles. It drains the earliest remaining
                // worklist position, then continues. Match that break.
                let Some(first) = order.iter().copied().find(|id| remaining.contains(id)) else {
                    break;
                };
                vec![first]
            } else {
                frontier_ids
            };
            for account_id in &frontier_ids {
                remaining.remove(account_id);
            }
            record_htlc_frontier_barrier();
            let batch = self.run_outbound(
                true,
                htlc_propose_work(&frontier_ids),
                owner,
                Arc::clone(&identity),
                request.timestamp,
                request.j_height,
                round_leafs,
            )?;
            let followup = htlc_followup_from_proposals(
                batch.rows,
                &routes,
                &mut scheduled,
                named,
                &mut admissions,
                &mut proposals,
            )?;
            if !followup.admit.is_empty() {
                record_htlc_frontier_barrier();
                self.run_outbound(
                    true,
                    followup.admit,
                    owner,
                    Arc::clone(&identity),
                    0,
                    0,
                    round_leafs,
                )?;
            }
            for account_id in followup.newly_scheduled {
                order.push(account_id);
                remaining.insert(account_id);
            }
        }
        Ok((admissions, proposals))
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
    swap_market: Arc<SwapMarketPolicy>,
}

fn apply_outbound_work(
    account_id: AccountId,
    current: Option<AccountConsensus>,
    work: OutboundWork,
    context: &OutboundApplyContext,
) -> Result<ResidentAccountAction<AccountConsensus, OutboundOutcome>, BatchError> {
    let mut changed = false;
    let mut account = match (current, work.create) {
        (Some(_), Some(_)) => return Err(BatchError::WaveCreateExisting(account_id)),
        (Some(account), None) => account,
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
    if let Some(txs) = work.txs {
        account
            .admit_txs(txs, "rscoreConsensus:admit")
            .map_err(|error| state_error(account_id, &error))?;
        changed = true;
    }
    let proposal = if work.propose {
        if proposable(&account)? {
            let outcome = propose_account_frame(
                &mut account,
                &context.identity,
                context.timestamp,
                context.j_height,
                &context.swap_market,
            )
            .map_err(|error| state_error(account_id, &error))?;
            changed = true;
            Some(proposal_row(account_id, outcome, &account)?)
        } else {
            Some(ProposalRow {
                account_id,
                outbound_input: None,
                proposed: None,
                dropped: Vec::new(),
                failed_htlc_locks: Vec::new(),
            })
        }
    } else {
        None
    };
    let result = OutboundOutcome {
        proposal,
        proposable: proposable(&account)?,
    };
    if changed {
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

fn admission_results(admits: &[(AccountId, Vec<AccountTx>)]) -> Vec<AccountAdmissionResult> {
    admits
        .iter()
        .enumerate()
        .map(|(index, (account_id, txs))| AccountAdmissionResult {
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

fn set_proposable(accounts: &mut BTreeSet<AccountId>, account_id: AccountId, ready: bool) {
    if ready {
        accounts.insert(account_id);
    } else {
        accounts.remove(&account_id);
    }
}

fn create_work(creates: &[AccountSeed]) -> Result<Vec<(AccountId, OutboundWork)>, BatchError> {
    let mut seen = BTreeSet::new();
    let mut work = Vec::with_capacity(creates.len());
    for seed in creates {
        if !seen.insert(seed.account_id) {
            return Err(BatchError::DuplicateAccount(seed.account_id));
        }
        work.push((
            seed.account_id,
            OutboundWork {
                create: Some(seed.clone()),
                txs: None,
                propose: false,
            },
        ));
    }
    Ok(work)
}

fn admission_work(admits: &[(AccountId, Vec<AccountTx>)]) -> Vec<(AccountId, OutboundWork)> {
    let mut grouped = BTreeMap::<AccountId, Vec<AccountTx>>::new();
    for (account_id, txs) in admits {
        grouped.entry(*account_id).or_default().extend(txs.clone());
    }
    grouped
        .into_iter()
        .map(|(account_id, txs)| {
            (
                account_id,
                OutboundWork {
                    create: None,
                    txs: Some(txs),
                    propose: false,
                },
            )
        })
        .collect()
}

type OutboundWorkSet = (Vec<(AccountId, OutboundWork)>, BTreeSet<AccountId>);

fn outbound_work(request: &EntityOutboundRequest) -> Result<OutboundWorkSet, BatchError> {
    let mut grouped = BTreeMap::<AccountId, OutboundWork>::new();
    for seed in &request.creates {
        grouped.insert(
            seed.account_id,
            OutboundWork {
                create: None,
                txs: None,
                propose: false,
            },
        );
    }
    for (account_id, txs) in &request.admits {
        let work = grouped.entry(*account_id).or_insert(OutboundWork {
            create: None,
            txs: Some(Vec::new()),
            propose: false,
        });
        work.txs.get_or_insert_with(Vec::new).extend(txs.clone());
    }
    let mut selected = BTreeSet::new();
    for account_id in &request.propose {
        if !selected.insert(*account_id) {
            return Err(BatchError::DuplicateAccount(*account_id));
        }
        grouped
            .entry(*account_id)
            .or_insert(OutboundWork {
                create: None,
                txs: None,
                propose: false,
            })
            .propose = true;
    }
    for account_id in &request.materialize {
        grouped.entry(*account_id).or_insert(OutboundWork {
            create: None,
            txs: None,
            propose: false,
        });
    }
    for route in &request.failed_htlc_routes {
        for account_id in [route.outbound_account_id, route.inbound_account_id] {
            grouped.entry(account_id).or_insert(OutboundWork {
                create: None,
                txs: None,
                propose: false,
            });
        }
    }
    let mut named = grouped.keys().copied().collect::<BTreeSet<_>>();
    named.extend(request.materialize.iter().copied());
    for route in &request.failed_htlc_routes {
        named.insert(route.outbound_account_id);
        named.insert(route.inbound_account_id);
    }
    Ok((grouped.into_iter().collect(), named))
}

fn proposals_from(
    rows: &[(AccountId, [u8; 32], OutboundOutcome)],
    order: &[AccountId],
) -> Result<Vec<ProposalRow>, BatchError> {
    let mut by_account = rows
        .iter()
        .filter_map(|(account_id, _, outcome)| {
            outcome.proposal.clone().map(|row| (*account_id, row))
        })
        .collect::<BTreeMap<_, _>>();
    order
        .iter()
        .map(|account_id| {
            by_account
                .remove(account_id)
                .ok_or(BatchError::AccountNotFound {
                    input_index: 0,
                    account_id: *account_id,
                })
        })
        .collect()
}

fn proposals_need_htlc_followup(proposals: &[ProposalRow], routes: &[FailedHtlcRoute]) -> bool {
    let hashlocks = routes
        .iter()
        .map(|route| route.hashlock)
        .collect::<BTreeSet<_>>();
    proposals.iter().any(|proposal| {
        proposal
            .failed_htlc_locks
            .iter()
            .any(|failed| hashlocks.contains(&failed.hashlock))
    })
}

fn validate_routes(routes: &[FailedHtlcRoute]) -> Result<(), BatchError> {
    let mut seen = BTreeSet::new();
    for route in routes {
        if !seen.insert(route.hashlock) {
            return Err(BatchError::FailedHtlcRouteDuplicate {
                hashlock: root_hex(route.hashlock),
            });
        }
    }
    Ok(())
}

struct HtlcFollowup {
    admit: Vec<(AccountId, OutboundWork)>,
    newly_scheduled: Vec<AccountId>,
}

fn reset_htlc_frontier_barriers() {
    HTLC_FRONTIER_BARRIERS.with(|count| count.set(0));
}

fn record_htlc_frontier_barrier() {
    HTLC_FRONTIER_BARRIERS.with(|count| count.set(count.get() + 1));
}

fn initial_htlc_worklist(
    propose: &[AccountId],
) -> Result<(BTreeSet<AccountId>, Vec<AccountId>), BatchError> {
    let mut scheduled = BTreeSet::new();
    let mut order = Vec::with_capacity(propose.len());
    for account_id in propose {
        if !scheduled.insert(*account_id) {
            return Err(BatchError::DuplicateAccount(*account_id));
        }
        order.push(*account_id);
    }
    Ok((scheduled, order))
}

fn htlc_propose_work(account_ids: &[AccountId]) -> Vec<(AccountId, OutboundWork)> {
    account_ids
        .iter()
        .map(|account_id| {
            (
                *account_id,
                OutboundWork {
                    create: None,
                    txs: None,
                    propose: true,
                },
            )
        })
        .collect()
}

fn htlc_ready_frontier(
    order: &[AccountId],
    remaining: &BTreeSet<AccountId>,
    routes: &[FailedHtlcRoute],
) -> Vec<AccountId> {
    let mut blocked = BTreeSet::new();
    for route in routes {
        if route.outbound_account_id == route.inbound_account_id {
            continue;
        }
        if remaining.contains(&route.outbound_account_id)
            && remaining.contains(&route.inbound_account_id)
        {
            blocked.insert(route.inbound_account_id);
        }
    }
    order
        .iter()
        .copied()
        .filter(|account_id| remaining.contains(account_id) && !blocked.contains(account_id))
        .collect()
}

fn htlc_followup_from_proposals(
    rows: Vec<(AccountId, [u8; 32], OutboundOutcome)>,
    routes: &BTreeMap<[u8; 32], &FailedHtlcRoute>,
    scheduled: &mut BTreeSet<AccountId>,
    named: &mut BTreeSet<AccountId>,
    admissions: &mut Vec<AccountAdmissionResult>,
    proposals: &mut Vec<ProposalRow>,
) -> Result<HtlcFollowup, BatchError> {
    let mut pending_order = Vec::new();
    let mut pending_txs = BTreeMap::<AccountId, Vec<AccountTx>>::new();
    let mut newly_scheduled = Vec::new();
    for (account_id, _leaf, outcome) in rows {
        let mut proposal = outcome.proposal.ok_or(BatchError::AccountNotFound {
            input_index: 0,
            account_id,
        })?;
        for failed in &mut proposal.failed_htlc_locks {
            let Some(route) = matched_failed_htlc_route(account_id, failed, routes)? else {
                continue;
            };
            let reason = format!("forward_failed:{}", failed.reason);
            let inbound = route.inbound_account_id;
            if !pending_txs.contains_key(&inbound) {
                pending_order.push(inbound);
            }
            pending_txs
                .entry(inbound)
                .or_default()
                .push(AccountTx::HtlcResolve(HtlcResolveTx {
                    lock_id: route.inbound_lock_id.clone(),
                    outcome: HtlcResolveOutcome::Error {
                        reason: Some(reason.clone()),
                    },
                }));
            admissions.push(AccountAdmissionResult {
                operation_index: admissions.len() as u64,
                account_id: inbound,
                verdict: AccountAdmissionVerdict::Admitted { count: 1 },
            });
            failed.upstream_resolution = Some(UpstreamHtlcResolutionRow {
                account_id: inbound,
                lock_id: route.inbound_lock_id.clone(),
                reason,
            });
            named.insert(inbound);
            if scheduled.insert(inbound) {
                newly_scheduled.push(inbound);
            }
        }
        proposals.push(proposal);
    }
    Ok(HtlcFollowup {
        admit: pending_order
            .into_iter()
            .map(|account_id| {
                (
                    account_id,
                    OutboundWork {
                        create: None,
                        txs: pending_txs.remove(&account_id),
                        propose: false,
                    },
                )
            })
            .collect(),
        newly_scheduled,
    })
}

fn matched_failed_htlc_route<'a>(
    account_id: AccountId,
    failed: &FailedHtlcLockRow,
    routes: &BTreeMap<[u8; 32], &'a FailedHtlcRoute>,
) -> Result<Option<&'a FailedHtlcRoute>, BatchError> {
    let Some(route) = routes.get(&failed.hashlock) else {
        return Ok(None);
    };
    if route.outbound_account_id != account_id || route.outbound_lock_id != failed.lock_id {
        return Err(BatchError::FailedHtlcRouteMismatch {
            hashlock: root_hex(failed.hashlock),
            account: root_hex(*account_id.as_bytes()),
            lock_id: failed.lock_id.clone(),
        });
    }
    Ok(Some(*route))
}

fn validate_operation_indices(rows: &[AccountInputRow]) -> Result<(), BatchError> {
    for pair in rows.windows(2) {
        if pair[0].operation_index >= pair[1].operation_index {
            return Err(BatchError::OperationIndex {
                actual: pair[1].operation_index,
                after: Some(pair[0].operation_index),
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

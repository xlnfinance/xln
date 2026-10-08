//! Single-writer live Runtime service.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use sha3::{Digest as _, Keccak256};
use thiserror::Error;

use crate::j_submit::{
    DurableEntityProviderActionAttempt, DurableGovernanceAttempt, DurableJAttempt,
    DurableJSubmitAttempt, EntityProviderActionResultData, EntityProviderActionResultOutcome,
    GovernanceResultData, GovernanceResultOutcome, JAdapterFailure, JMaintenanceIntent,
    JSubmitConfig, JSubmitError, JSubmitOutcome, JSubmitResultData, JSubmitResultOutcome,
    JSubmitter, decode_pending_j_submit_attempts,
};
use crate::transport::{
    DirectRuntimeIngress, DirectRuntimeIngressMetrics, InboundEntityInputs, InboundRuntimeEvent,
    PublicationBacklog, RuntimeTransportError,
};
use crate::{EntityInfraMaterializer, RuntimeEntityInput, RuntimeLiveInput};
use crate::{
    FinalizedJHeader, FinalizedWatcherCursor, HttpJsonRpc, JWatcherConfig, JWatcherPoll, RuntimeTx,
    observation_from_poll, poll_finalized_j_events,
};
use ethabi::ethereum_types::U256;
use xln_rscore_batch::{AccountId, ResidentAccountStatusView};
use xln_rscore_engine::TokenId;

use super::{DurableRuntimeProcessor, DurableRuntimeProcessorError, RuntimeProcessReport};

const TIMESTAMP_DRIFT_MS: u64 = 30_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const JBLOCK_LIVENESS_INTERVAL: u64 = 100;
const J_WATCHER_MAX_BLOCKS_PER_POLL: u64 = 256;
const MAX_INBOUND_EVENTS_PER_POLL: usize = 64;

#[path = "startup/readiness.rs"]
mod startup;
#[path = "startup/metadata.rs"]
mod startup_metadata;

fn remaining_frame_delay(delay: Duration, started: Option<Instant>, now: Instant) -> Duration {
    started
        .map(|started| delay.saturating_sub(now.saturating_duration_since(started)))
        .unwrap_or_default()
}
/// Owns the authenticated socket queue, the one durable Runtime writer and
/// the Entity infrastructure materializer. Transport threads can only enqueue;
/// this object is the sole mutation path into R/E/A state.
pub struct ResidentRuntimeService {
    processor: DurableRuntimeProcessor,
    ingress: DirectRuntimeIngress,
    materializer: Box<dyn EntityInfraMaterializer>,
    finalized_j_height: u64,
    held_inbound: VecDeque<InboundEntityInputs>,
    pending_runtime_txs: VecDeque<RuntimeTx>,
    /// Socket completions can arrive between Runtime frames. Carry only their
    /// transient telemetry into the next frame report; publication ordering
    /// and retry ownership remain entirely inside `DirectOutboxPublisher`.
    deferred_publication: DeferredPublicationTelemetry,
    j_submit_operator_key: Option<[u8; 32]>,
    j_watchers: VecDeque<LiveJWatcher>,
    /// Process-local scheduler state. Persisting wall-clock progress would add
    /// a second recovery authority beside the WAL; only Runtime config belongs
    /// in durable state.
    last_live_frame_started_at: Option<Instant>,
    delivery_ready: bool,
}

#[derive(Default)]
struct DeferredPublicationTelemetry {
    outputs: usize,
    envelopes: usize,
    bytes: usize,
}

impl DeferredPublicationTelemetry {
    fn add(&mut self, report: RuntimeProcessReport) -> Result<(), ResidentRuntimeServiceError> {
        self.outputs = self
            .outputs
            .checked_add(report.outputs_published)
            .ok_or(DurableRuntimeProcessorError::ReportOverflow)?;
        self.envelopes = self
            .envelopes
            .checked_add(report.envelopes_published)
            .ok_or(DurableRuntimeProcessorError::ReportOverflow)?;
        self.bytes = self
            .bytes
            .checked_add(report.durable_bytes_published)
            .ok_or(DurableRuntimeProcessorError::ReportOverflow)?;
        Ok(())
    }

    fn merge_into(
        &mut self,
        report: &mut RuntimeProcessReport,
    ) -> Result<(), ResidentRuntimeServiceError> {
        report.outputs_published = report
            .outputs_published
            .checked_add(self.outputs)
            .ok_or(DurableRuntimeProcessorError::ReportOverflow)?;
        report.envelopes_published = report
            .envelopes_published
            .checked_add(self.envelopes)
            .ok_or(DurableRuntimeProcessorError::ReportOverflow)?;
        report.durable_bytes_published = report
            .durable_bytes_published
            .checked_add(self.bytes)
            .ok_or(DurableRuntimeProcessorError::ReportOverflow)?;
        *self = Self::default();
        Ok(())
    }
}

struct LiveJWatcher {
    rpc: HttpJsonRpc,
    config: JWatcherConfig,
    cursor: FinalizedWatcherCursor,
    signer_id: String,
    jurisdiction_ref: String,
    depository_text: String,
    poll_interval: Duration,
    next_poll: Instant,
    pending_scan: Option<PendingJScan>,
    startup_target: u64,
    authenticated_through: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PendingJScan {
    base_height: u64,
    scanned_through: u64,
    tip_hash: [u8; 32],
    headers: Vec<FinalizedJHeader>,
}

impl ResidentRuntimeService {
    pub fn new(
        mut processor: DurableRuntimeProcessor,
        ingress: DirectRuntimeIngress,
        materializer: Box<dyn EntityInfraMaterializer>,
    ) -> Result<Self, ResidentRuntimeServiceError> {
        processor
            .hydrate_live_token_catalogs()
            .map_err(ResidentRuntimeServiceError::JWatcher)?;
        let replica = processor.replica()?;
        let durable_runtime_id = replica.durable.runtime_id();
        let finalized_j_height = replica.state.finalized_j_height;
        if ingress.runtime_id() != durable_runtime_id {
            return Err(ResidentRuntimeServiceError::RuntimeId {
                durable: durable_runtime_id.into(),
                ingress: ingress.runtime_id().into(),
            });
        }
        let j_watchers = live_j_watchers(replica, &BTreeSet::new())?;
        processor.attach_inbound_sessions(ingress.sessions());
        // A crash can happen after fsync but before the best-effort socket
        // write. There is intentionally no transport receipt or delivered
        // marker: replay every durable outbox row from the checkpoint floor
        // before accepting new input and let bilateral Account consensus
        // de-duplicate an exact resend.
        let retried = processor.retry_publication()?;
        let mut deferred_publication = DeferredPublicationTelemetry::default();
        if let Some(report) = retried {
            deferred_publication.add(report)?;
        }
        let mut service = Self {
            processor,
            ingress,
            materializer,
            finalized_j_height,
            held_inbound: VecDeque::new(),
            pending_runtime_txs: VecDeque::new(),
            deferred_publication,
            j_submit_operator_key: None,
            j_watchers,
            last_live_frame_started_at: None,
            delivery_ready: false,
        };
        if !recover_pending_j_actions(service.processor.replica()?)?.is_empty() {
            return Err(ResidentRuntimeServiceError::JSubmit(
                "PENDING_ATTEMPT_WITHOUT_OPERATOR_KEY".into(),
            ));
        }
        service.refresh_startup_readiness()?;
        Ok(service)
    }

    /// Production constructor. The Entity signer key is the same operator-key
    /// policy used by TS; no environment-only second key or sidecar exists.
    pub fn new_with_j_submit_key(
        processor: DurableRuntimeProcessor,
        ingress: DirectRuntimeIngress,
        materializer: Box<dyn EntityInfraMaterializer>,
        operator_private_key: [u8; 32],
    ) -> Result<Self, ResidentRuntimeServiceError> {
        let mut service = Self::new_without_pending_guard(processor, ingress, materializer)?;
        service.j_submit_operator_key = Some(operator_private_key);
        let pending = recover_pending_j_actions(service.processor.replica()?)?;
        service.execute_committed_j_attempts(pending)?;
        service.refresh_startup_readiness()?;
        Ok(service)
    }

    fn new_without_pending_guard(
        mut processor: DurableRuntimeProcessor,
        ingress: DirectRuntimeIngress,
        materializer: Box<dyn EntityInfraMaterializer>,
    ) -> Result<Self, ResidentRuntimeServiceError> {
        processor
            .hydrate_live_token_catalogs()
            .map_err(ResidentRuntimeServiceError::JWatcher)?;
        let replica = processor.replica()?;
        let durable_runtime_id = replica.durable.runtime_id();
        let finalized_j_height = replica.state.finalized_j_height;
        if ingress.runtime_id() != durable_runtime_id {
            return Err(ResidentRuntimeServiceError::RuntimeId {
                durable: durable_runtime_id.into(),
                ingress: ingress.runtime_id().into(),
            });
        }
        let j_watchers = live_j_watchers(replica, &BTreeSet::new())?;
        processor.attach_inbound_sessions(ingress.sessions());
        let retried = processor.retry_publication()?;
        let mut deferred_publication = DeferredPublicationTelemetry::default();
        if let Some(report) = retried {
            deferred_publication.add(report)?;
        }
        Ok(Self {
            processor,
            ingress,
            materializer,
            finalized_j_height,
            held_inbound: VecDeque::new(),
            pending_runtime_txs: VecDeque::new(),
            deferred_publication,
            j_submit_operator_key: None,
            j_watchers,
            last_live_frame_started_at: None,
            delivery_ready: false,
        })
    }

    // Insert inside ResidentRuntimeService, adjacent to process_local_entity_inputs.
    // Caller is the authenticated process adapter after command frontier admission.
    pub fn process_adapter_entity_inputs(
        &mut self,
        entity_inputs: Vec<RuntimeEntityInput>,
        marker: crate::RuntimeAdapterCommandMarker,
    ) -> Result<Option<RuntimeProcessReport>, ResidentRuntimeServiceError> {
        if !self.delivery_ready {
            return Err(ResidentRuntimeServiceError::JWatcher(
                "STARTUP_CATCHUP_PENDING".into(),
            ));
        }
        self.wait_for_live_frame_slot()?;
        let frame_started = Instant::now();
        self.pending_runtime_txs
            .push_back(RuntimeTx::RecordRuntimeAdapterCommand(marker));
        let report = self.process_entity_inputs_at(entity_inputs, None, wall_clock_ms()?)?;
        self.note_live_frame(frame_started, report.is_some());
        Ok(report)
    }

    /// Mirrors TS ensureLocalRuntimeOwner: an existing exact Entity/signer is
    /// idempotent, otherwise the canonical import must become durable first.
    /// The caller supplies custody over private IPC, never an unauthenticated RPC.
    pub fn adopt_custody_owner(
        &mut self,
        signer: &str,
        key: [u8; 32],
        entity_seed: &str,
        jurisdiction: Value,
        profile_name: &str,
    ) -> Result<Value, ResidentRuntimeServiceError> {
        let (entity_id, input) =
            crate::custody_owner_import(signer, key, entity_seed, jurisdiction, profile_name)
                .map_err(ResidentRuntimeServiceError::JWatcher)?;
        let owner = crate::RuntimeEntityKey::new(entity_id, signer)
            .map_err(|error| ResidentRuntimeServiceError::JWatcher(error.to_string()))?;
        self.processor
            .install_custody_key(signer, key)
            .map_err(ResidentRuntimeServiceError::JWatcher)?;
        self.sync_committed()?;
        let replica = self.processor.replica()?;
        let created = !replica.state.e_replicas.contains_key(&owner);
        if !created && !replica.e_replicas.contains_key(&owner) {
            return Err(ResidentRuntimeServiceError::JWatcher(
                "BRAINVAULT_OWNER_LIVE_MISSING".into(),
            ));
        }
        if created {
            self.process_custody_import(signer, key, input)?;
            self.sync_committed()?;
        }
        let replica = self.processor.replica()?;
        if !replica.state.e_replicas.contains_key(&owner)
            || !replica.e_replicas.contains_key(&owner)
        {
            return Err(ResidentRuntimeServiceError::JWatcher(
                "BRAINVAULT_OWNER_COMMIT_MISSING".into(),
            ));
        }
        Ok(
            serde_json::json!({"entityId": format!("0x{}", hex::encode(entity_id)),
            "created": created, "height": replica.state.height}),
        )
    }

    /// Caller proves the admin capability before scheduling this operation.
    /// `input` is built from private worker custody and committed J selection.
    /// Public completion still requires sync_committed + resident owner verification.
    pub fn process_custody_import(
        &mut self,
        signer: &str,
        key: [u8; 32],
        input: crate::ImportReplica,
    ) -> Result<Option<RuntimeProcessReport>, ResidentRuntimeServiceError> {
        if !self.delivery_ready {
            return Err(ResidentRuntimeServiceError::JWatcher(
                "STARTUP_CATCHUP_PENDING".into(),
            ));
        }
        self.processor
            .install_custody_key(signer, key)
            .map_err(ResidentRuntimeServiceError::JWatcher)?;
        self.wait_for_live_frame_slot()?;
        let frame_started = Instant::now();
        self.pending_runtime_txs
            .push_back(RuntimeTx::ImportReplica(input));
        let report = self.process_entity_inputs_at(vec![], None, wall_clock_ms()?)?;
        self.note_live_frame(frame_started, report.is_some());
        Ok(report)
    }

    pub fn local_address(&self) -> std::net::SocketAddr {
        self.ingress.local_address()
    }

    pub fn encryption_public_key(&self) -> String {
        self.ingress.encryption_public_key()
    }

    pub fn runtime_id(&self) -> &str {
        self.ingress.runtime_id()
    }

    pub fn delivery_ready(&self) -> bool {
        self.delivery_ready
    }

    pub fn min_frame_delay_ms(&self) -> Result<u64, ResidentRuntimeServiceError> {
        Ok(self
            .processor
            .replica()?
            .durable
            .runtime_config()
            .min_frame_delay_ms)
    }

    pub fn ingress_metrics(&self) -> DirectRuntimeIngressMetrics {
        self.ingress.metrics()
    }

    pub fn last_session_error(&self) -> Option<String> {
        self.ingress.last_session_error()
    }

    pub fn open_runtime_ids(&self) -> Result<Vec<String>, ResidentRuntimeServiceError> {
        self.ingress.open_runtime_ids().map_err(Into::into)
    }

    pub fn processor(&self) -> &DurableRuntimeProcessor {
        &self.processor
    }

    /// Read one exact committed WAL frame for an operator query, never history scans.
    pub fn adapter_storage_head(&mut self) -> Result<Value, ResidentRuntimeServiceError> {
        self.processor.adapter_storage_head().map_err(Into::into)
    }

    pub fn adapter_restore_sources(
        &mut self,
    ) -> Result<crate::restore::NativeConcreteRestoreSources, ResidentRuntimeServiceError> {
        self.processor.adapter_restore_sources().map_err(Into::into)
    }

    pub fn read_durable_frame(
        &mut self,
        height: u64,
    ) -> Result<crate::storage::native::RecoveredWalFrame, ResidentRuntimeServiceError> {
        self.processor
            .read_durable_frame(height)
            .map_err(Into::into)
    }

    pub fn read_account_views(
        &mut self,
        entity_key: &crate::RuntimeEntityKey,
        account_ids: Vec<xln_rscore_batch::AccountId>,
        project: fn(
            &xln_rscore_engine::AccountConsensus,
        )
            -> Result<xln_rscore_protocol::CanonicalValue, xln_rscore_engine::StateError>,
    ) -> Result<
        Vec<(
            xln_rscore_batch::AccountId,
            xln_rscore_protocol::CanonicalValue,
        )>,
        ResidentRuntimeServiceError,
    > {
        self.sync_committed()?;
        self.processor
            .read_account_views(entity_key, account_ids, project)
            .map_err(Into::into)
    }

    pub fn account_status(
        &mut self,
        entity_key: &crate::RuntimeEntityKey,
        account_id: AccountId,
        token_ids: Vec<TokenId>,
    ) -> Result<Option<ResidentAccountStatusView>, ResidentRuntimeServiceError> {
        self.processor
            .account_status(entity_key, account_id, token_ids)
            .map_err(Into::into)
    }

    pub fn publication_backlog(&self) -> PublicationBacklog {
        self.processor.publication_backlog()
    }

    /// Barrier over the pipelined committer: returns once every produced
    /// frame is durable and its publication attempt finished. Callers that
    /// acknowledge a specific commit to an operator use this before replying.
    pub fn sync_committed(
        &mut self,
    ) -> Result<Option<RuntimeProcessReport>, ResidentRuntimeServiceError> {
        let mut report = self.processor.sync_committed()?;
        if let Some(report) = &mut report {
            let attempts = std::mem::take(&mut report.post_commit_j_attempts);
            self.execute_committed_j_attempts(attempts)?;
        }
        Ok(report)
    }

    pub fn advance_finalized_j_height(
        &mut self,
        height: u64,
    ) -> Result<(), ResidentRuntimeServiceError> {
        if height < self.finalized_j_height {
            return Err(ResidentRuntimeServiceError::JHeightRegression {
                previous: self.finalized_j_height,
                next: height,
            });
        }
        self.finalized_j_height = height;
        Ok(())
    }

    /// Wait for one authenticated transport batch. A timeout still checks
    /// Account mempools and deterministic scheduled wakes; if neither is due,
    /// no Runtime frame or disk write is produced.
    ///
    /// Ready authenticated messages are coalesced into the largest whole-message
    /// FIFO prefix that fits one Runtime frame. Overflow remains bounded in RAM.
    pub fn process_next(
        &mut self,
        timeout: Duration,
    ) -> Result<Option<RuntimeProcessReport>, ResidentRuntimeServiceError> {
        let available = self.available_frame_inputs()?;
        self.collect_inbound_until_frame_slot(timeout, available)?;
        let frame_started = Instant::now();
        if let Some(report) = self.poll_and_commit_j_watcher()? {
            self.note_live_frame(frame_started, true);
            self.refresh_startup_readiness()?;
            return Ok(Some(report));
        }
        let (entity_inputs, queued_at) = self.take_frame_inbound()?;
        let report = self.process_entity_inputs_at(entity_inputs, queued_at, wall_clock_ms()?)?;
        self.note_live_frame(frame_started, report.is_some());
        self.refresh_startup_readiness()?;
        Ok(report)
    }

    fn poll_and_commit_j_watcher(
        &mut self,
    ) -> Result<Option<RuntimeProcessReport>, ResidentRuntimeServiceError> {
        // Imported sovereign Entities join the same watcher path on their next live poll.
        // Existing scans/cursors remain intact; never reset an in-flight authenticated range.
        let watched = self
            .j_watchers
            .iter()
            .map(|watcher| {
                (
                    *watcher.config.entity_id.as_bytes(),
                    watcher.signer_id.clone(),
                )
            })
            .collect();
        self.j_watchers
            .extend(live_j_watchers(self.processor.replica()?, &watched)?);
        let count = self.j_watchers.len();
        let mut selected = None;
        for _ in 0..count {
            let mut watcher = self.j_watchers.pop_front().expect("bounded watcher queue");
            if let Some(prefix_input) = crate::machine::build_pending_local_j_prefix_entity_input(
                self.processor.replica()?,
                watcher.config.entity_id.as_bytes(),
                &watcher.signer_id,
            )
            .map_err(|error| ResidentRuntimeServiceError::JWatcher(error.to_string()))?
            {
                let report = self
                    .process_entity_inputs_at(vec![prefix_input], None, wall_clock_ms()?)?
                    .ok_or_else(|| {
                        ResidentRuntimeServiceError::JWatcher(
                            "PENDING_PREFIX_FRAME_NOT_PRODUCED".into(),
                        )
                    })?;
                self.sync_committed()?.ok_or_else(|| {
                    ResidentRuntimeServiceError::JWatcher("FSYNC_REPORT_MISSING".into())
                })?;
                self.j_watchers.push_back(watcher);
                return Ok(Some(report));
            }
            if Instant::now() < watcher.next_poll {
                self.j_watchers.push_back(watcher);
                continue;
            }
            watcher.next_poll = Instant::now() + watcher.poll_interval;
            let certified_height = self
                .processor
                .replica()?
                .entity_slot(watcher.config.entity_id.as_bytes(), &watcher.signer_id)
                .ok_or_else(|| ResidentRuntimeServiceError::JWatcher("ENTITY_SLOT_MISSING".into()))?
                .0
                .entity
                .last_finalized_j_height;
            let certified_height = self
                .j_watchers
                .iter()
                .filter(|other| {
                    other.config.chain_id == watcher.config.chain_id
                        && other.config.depository_address == watcher.config.depository_address
                })
                .try_fold(certified_height, |minimum, other| {
                    let state = self
                        .processor
                        .replica()?
                        .entity_slot(other.config.entity_id.as_bytes(), &other.signer_id)
                        .ok_or_else(|| {
                            ResidentRuntimeServiceError::JWatcher("ENTITY_SLOT_MISSING".into())
                        })?
                        .0;
                    Ok::<_, ResidentRuntimeServiceError>(
                        minimum.min(state.entity.last_finalized_j_height),
                    )
                })?;
            let durable_height = durable_watcher_cursor_height(
                self.processor.replica()?,
                watcher.config.chain_id,
                &watcher.depository_text,
            )?;
            if let Some(cursor_height) = certified_watcher_cursor_candidate(
                watcher.cursor.scanned_through,
                certified_height,
                durable_height,
            ) {
                self.pending_runtime_txs.push_back(watcher_cursor_tx(
                    watcher.depository_text.clone(),
                    watcher.config.chain_id,
                    &FinalizedWatcherCursor {
                        scanned_through: cursor_height,
                        block_hash: None,
                    },
                ));
                let report = self
                    .process_entity_inputs_at(Vec::new(), None, wall_clock_ms()?)?
                    .ok_or_else(|| {
                        ResidentRuntimeServiceError::JWatcher(
                            "CERTIFIED_CURSOR_FRAME_NOT_PRODUCED".into(),
                        )
                    })?;
                self.sync_committed()?.ok_or_else(|| {
                    ResidentRuntimeServiceError::JWatcher("FSYNC_REPORT_MISSING".into())
                })?;
                self.j_watchers.push_back(watcher);
                return Ok(Some(report));
            }
            if !self.delivery_ready && watcher.authenticated_through >= watcher.startup_target {
                self.j_watchers.push_back(watcher);
                continue;
            }
            let poll = poll_finalized_j_events(&watcher.rpc, &watcher.config, &watcher.cursor)
                .map_err(|error| ResidentRuntimeServiceError::JWatcher(error.to_string()))?;
            watcher.authenticated_through = poll.cursor.scanned_through;
            if poll.cursor == watcher.cursor {
                self.j_watchers.push_back(watcher);
                continue;
            }
            selected = Some((watcher, poll));
            break;
        }
        let Some((mut watcher, poll)) = selected else {
            return Ok(None);
        };
        let next_cursor = poll.cursor.clone();
        let has_semantic_batches = !poll.batches.is_empty();
        let pending = extend_pending_j_scan(watcher.pending_scan.take(), &watcher.cursor, &poll)?;
        let entity_base_height = self
            .processor
            .replica()?
            .entity_slot(watcher.config.entity_id.as_bytes(), &watcher.signer_id)
            .ok_or_else(|| ResidentRuntimeServiceError::JWatcher("ENTITY_SLOT_MISSING".into()))?
            .0
            .entity
            .last_finalized_j_height;
        let liveness_due = j_scan_liveness_due(pending.scanned_through, entity_base_height);
        if !has_semantic_batches && !liveness_due {
            watcher.cursor = next_cursor;
            watcher.pending_scan = Some(pending);
            self.j_watchers.push_back(watcher);
            return Ok(None);
        }
        let observation = observation_from_poll(
            watcher.config.entity_id.clone(),
            watcher.signer_id.clone(),
            watcher.jurisdiction_ref.clone(),
            JWatcherPoll {
                cursor: next_cursor.clone(),
                headers: pending.headers.clone(),
                batches: poll.batches,
            },
        )
        .map_err(|error| ResidentRuntimeServiceError::JWatcher(error.to_string()))?;
        let prefix_input = crate::machine::build_local_j_prefix_entity_input(
            self.processor.replica()?,
            &observation,
        )
        .map_err(|error| ResidentRuntimeServiceError::JWatcher(error.to_string()))?;
        self.pending_runtime_txs
            .extend(ordered_j_observation_txs(&observation));
        self.finalized_j_height = self.finalized_j_height.max(next_cursor.scanned_through);
        let report = self
            .process_entity_inputs_at(prefix_input.into_iter().collect(), None, wall_clock_ms()?)?
            .ok_or_else(|| {
                ResidentRuntimeServiceError::JWatcher("RUNTIME_FRAME_NOT_PRODUCED".into())
            })?;
        self.sync_committed()?
            .ok_or_else(|| ResidentRuntimeServiceError::JWatcher("FSYNC_REPORT_MISSING".into()))?;
        watcher.cursor = next_cursor;
        watcher.pending_scan = None;
        self.j_watchers.push_back(watcher);
        Ok(Some(report))
    }

    fn collect_inbound_until_frame_slot(
        &mut self,
        timeout: Duration,
        available: usize,
    ) -> Result<(), ResidentRuntimeServiceError> {
        let now = Instant::now();
        let cadence_wait = self.remaining_live_frame_delay(now)?;
        let first_wait = timeout.max(cadence_wait);
        if self.held_inbound.is_empty()
            && let Some(batch) = self.recv_inbound_batch(first_wait)?
        {
            self.held_inbound.push_back(batch);
        }
        let mut held_inputs = self
            .held_inbound
            .iter()
            .map(|batch| batch.entity_inputs.len())
            .sum::<usize>();
        loop {
            while held_inputs < available
                && let Some(batch) = self.try_recv_inbound_batch()?
            {
                held_inputs = held_inputs.saturating_add(batch.entity_inputs.len());
                self.held_inbound.push_back(batch);
            }
            let remaining = self.remaining_live_frame_delay(Instant::now())?;
            if remaining.is_zero() {
                break;
            }
            if held_inputs >= available {
                std::thread::sleep(remaining);
                continue;
            }
            let Some(batch) = self.recv_inbound_batch(remaining)? else {
                break;
            };
            held_inputs = held_inputs.saturating_add(batch.entity_inputs.len());
            self.held_inbound.push_back(batch);
        }
        Ok(())
    }

    fn remaining_live_frame_delay(
        &self,
        now: Instant,
    ) -> Result<Duration, ResidentRuntimeServiceError> {
        // One formula owns live cadence: Runtime frames start at least the
        // committed delay apart. Frame work consumes that budget, so only the
        // remainder is slept. Completion timestamps, socket quiet gaps and
        // durable timer fields would each create a competing batching policy.
        Ok(remaining_frame_delay(
            Duration::from_millis(self.min_frame_delay_ms()?),
            self.last_live_frame_started_at,
            now,
        ))
    }

    fn wait_for_live_frame_slot(&self) -> Result<(), ResidentRuntimeServiceError> {
        let remaining = self.remaining_live_frame_delay(Instant::now())?;
        if !remaining.is_zero() {
            std::thread::sleep(remaining);
        }
        Ok(())
    }

    fn note_live_frame(&mut self, started: Instant, produced: bool) {
        if produced {
            self.last_live_frame_started_at = Some(started);
        }
    }

    fn recv_inbound_batch(
        &mut self,
        timeout: Duration,
    ) -> Result<Option<InboundEntityInputs>, ResidentRuntimeServiceError> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(None);
            }
            let Some(event) = self.ingress.recv_event_timeout(remaining)? else {
                return Ok(None);
            };
            if let Some(batch) = self.accept_inbound_event(event)? {
                return Ok(Some(batch));
            }
        }
    }

    fn try_recv_inbound_batch(
        &mut self,
    ) -> Result<Option<InboundEntityInputs>, ResidentRuntimeServiceError> {
        // Invalid peers may keep the socket queue nonempty. Give the writer
        // its frame slot after a bounded scan instead of draining forever.
        for _ in 0..MAX_INBOUND_EVENTS_PER_POLL {
            let Some(event) = self.ingress.try_recv_event()? else {
                return Ok(None);
            };
            if let Some(batch) = self.accept_inbound_event(event)? {
                return Ok(Some(batch));
            }
        }
        Ok(None)
    }

    fn accept_inbound_event(
        &mut self,
        event: InboundRuntimeEvent,
    ) -> Result<Option<InboundEntityInputs>, ResidentRuntimeServiceError> {
        match event {
            InboundRuntimeEvent::EntityInputs(batch) => {
                match self.validate_inbound_batch(&batch) {
                    Ok(()) => Ok(Some(batch)),
                    Err(ResidentRuntimeServiceError::InboundRoute(error)) => {
                        // This is untrusted pre-admission traffic. Reject only
                        // this batch; storage/consensus errors remain fail-stop.
                        eprintln!(
                            "RRS_DIRECT_RUNTIME_OUTPUT_REJECTED:{}",
                            truncate_failure(error.to_string())
                        );
                        Ok(None)
                    }
                    Err(error) => Err(error),
                }
            }
            InboundRuntimeEvent::GossipAnnouncement(gossip) => {
                for profile in gossip.profiles {
                    if let Err(error) = self
                        .processor
                        .admit_authenticated_profile(&gossip.peer_runtime_id, &profile)
                    {
                        self.ingress.note_profile_rejection(&error.to_string());
                    }
                }
                Ok(None)
            }
        }
    }

    fn validate_inbound_batch(
        &self,
        batch: &InboundEntityInputs,
    ) -> Result<(), ResidentRuntimeServiceError> {
        let replica = self.processor.replica()?;
        for input in &batch.entity_inputs {
            let key = crate::RuntimeEntityKey {
                entity_id: *input.entity_id(),
                signer_id: input.signer_id().to_owned(),
            };
            // Address errors belong to the peer, before the durable writer
            // takes ownership. Check committed membership only: a missing live
            // slot for an existing committed owner remains an invariant fault.
            if !replica.state.e_replicas.contains_key(&key) {
                return Err(super::EntityRouteError::InboundEntityOwner {
                    entity_id: format!("0x{}", hex::encode(input.entity_id())),
                    signer_id: input.signer_id().to_owned(),
                }
                .into());
            }
        }
        self.processor
            .entity_routes()
            .validate_inbound_runtime_outputs(&batch.peer_runtime_id, &batch.entity_inputs)?;
        Ok(())
    }

    fn available_frame_inputs(&self) -> Result<usize, ResidentRuntimeServiceError> {
        let replica = self.processor.replica()?;
        Ok(replica
            .limits
            .max_mempool_entity_inputs
            .saturating_sub(replica.mempool.entity_input_count()))
    }

    /// Move the largest whole-message FIFO prefix that fits the Runtime
    /// mempool. A transport envelope is never split, and overflow remains in
    /// the bounded RAM queue for the next durable frame.
    fn take_frame_inbound(
        &mut self,
    ) -> Result<(Vec<RuntimeEntityInput>, Option<u64>), ResidentRuntimeServiceError> {
        let available = self.available_frame_inputs()?;
        Ok(coalesce_inbound_prefix(&mut self.held_inbound, available))
    }

    /// Deterministic seam used by tests and replayed live traces. `now` is an
    /// external observation; the resolved timestamp is recorded in the WAL.
    pub fn process_batch_at(
        &mut self,
        batch: Option<InboundEntityInputs>,
        now: u64,
    ) -> Result<Option<RuntimeProcessReport>, ResidentRuntimeServiceError> {
        if let Some(batch) = batch.as_ref() {
            self.validate_inbound_batch(batch)?;
        }
        let queued_at = batch.as_ref().and_then(|batch| batch.ingress_timestamp);
        let entity_inputs = batch.map(|batch| batch.entity_inputs).unwrap_or_default();
        self.process_entity_inputs_at(entity_inputs, queued_at, now)
    }

    /// Commit locally submitted Entity inputs through the same live
    /// reducer -> WAL fsync -> publication path as authenticated socket
    /// ingress. The process-local result remains transient; command ids are
    /// never copied into Runtime state or storage.
    pub fn process_local_entity_inputs(
        &mut self,
        entity_inputs: Vec<RuntimeEntityInput>,
    ) -> Result<Option<RuntimeProcessReport>, ResidentRuntimeServiceError> {
        if !self.delivery_ready {
            return Err(ResidentRuntimeServiceError::JWatcher(
                "STARTUP_CATCHUP_PENDING".into(),
            ));
        }
        self.wait_for_live_frame_slot()?;
        let frame_started = Instant::now();
        let report = self.process_entity_inputs_at(entity_inputs, None, wall_clock_ms()?)?;
        self.note_live_frame(frame_started, report.is_some());
        Ok(report)
    }

    /// Unpaced deterministic seam. Replay and tests supply the exact external
    /// timestamp and must never inherit live wall-clock scheduling.
    pub fn process_local_entity_inputs_at(
        &mut self,
        entity_inputs: Vec<RuntimeEntityInput>,
        now: u64,
    ) -> Result<Option<RuntimeProcessReport>, ResidentRuntimeServiceError> {
        self.process_entity_inputs_at(entity_inputs, None, now)
    }

    fn process_entity_inputs_at(
        &mut self,
        entity_inputs: Vec<RuntimeEntityInput>,
        queued_at: Option<u64>,
        now: u64,
    ) -> Result<Option<RuntimeProcessReport>, ResidentRuntimeServiceError> {
        if let Some(report) = self.processor.retry_publication()? {
            self.deferred_publication.add(report)?;
        }
        let previous = self.processor.replica()?.state.timestamp;
        let queued_at = queued_at.unwrap_or(now);
        let timestamp = resolve_live_timestamp(previous, queued_at, now)?;
        let mut runtime_txs = self.pending_runtime_txs.drain(..).collect::<Vec<_>>();
        if self.j_submit_operator_key.is_some() {
            let due = crate::j_submit::lifecycle::collect_due_j_submit_retries(
                self.processor.replica()?,
                timestamp,
                &runtime_txs,
                &entity_inputs,
            )
            .map_err(|error| ResidentRuntimeServiceError::JSubmit(error.to_string()))?;
            runtime_txs.extend(due);
        }
        let profile_identity = crate::signed_profile::ProfileTransportIdentity {
            runtime_id: self.runtime_id().to_string(),
            runtime_encryption_public_key: self.encryption_public_key(),
            ws_url: format!("ws://{}/ws", self.local_address()),
        };
        self.materializer.set_paybook_reachability(
            self.processor.entity_routes(),
            self.ingress.sessions(),
            profile_identity,
        );
        let mut report = self.processor.process_live(
            RuntimeLiveInput {
                runtime_txs,
                entity_inputs,
                timestamp,
                finalized_j_height: self.finalized_j_height,
            },
            self.materializer.as_mut(),
        )?;
        let attempts = std::mem::take(&mut report.post_commit_j_attempts);
        self.execute_committed_j_attempts(attempts)?;
        // A frame happened iff the projector produced commitments; with the
        // pipelined committer, `durable_height` names the previous frame's
        // completed commit, not this one.
        if report.commitments.is_none() {
            return Ok(None);
        }
        self.deferred_publication.merge_into(&mut report)?;
        Ok(Some(report))
    }

    fn execute_committed_j_attempts(
        &mut self,
        attempts: Vec<DurableJAttempt>,
    ) -> Result<(), ResidentRuntimeServiceError> {
        if attempts.is_empty() {
            return Ok(());
        }
        for attempt in attempts {
            match attempt {
                DurableJAttempt::ScheduleRuntimeTx(tx) => self.pending_runtime_txs.push_back(tx),
                DurableJAttempt::Batch(attempt) => {
                    // A recovered outbox can predate signing. The committed result
                    // journal retires the attempt regardless of its raw bytes.
                    if crate::j_submit::lifecycle::prepared_attempt_completed(
                        self.processor.replica()?,
                        &attempt,
                    ) {
                        continue;
                    }
                    let operator_key = self.j_submit_operator_key.ok_or_else(|| {
                        ResidentRuntimeServiceError::JSubmit("OPERATOR_KEY_MISSING".into())
                    })?;
                    let mut minimum_nonce = None;
                    for tx in &self.pending_runtime_txs {
                        if let RuntimeTx::RecordJPreparedTransaction(data) = tx
                            && data.jurisdiction_name == attempt.jurisdiction_name
                            && data.raw_transaction.starts_with("0x02")
                        {
                            let wire = crate::j_submit::prepared_wire::decode_prepared_transaction(
                                &data.raw_transaction,
                                false,
                            )
                            .map_err(|e| ResidentRuntimeServiceError::JSubmit(e.to_string()))?;
                            let next = wire.nonce.checked_add(1).ok_or_else(|| {
                                ResidentRuntimeServiceError::JSubmit(
                                    "PREPARED_NONCE_OVERFLOW".into(),
                                )
                            })?;
                            minimum_nonce = Some(minimum_nonce.unwrap_or(0).max(next));
                        }
                    }
                    let result = submit_committed_attempt(
                        self.processor.replica()?,
                        operator_key,
                        &attempt,
                        minimum_nonce,
                    );
                    self.pending_runtime_txs.push_back(result);
                }
                DurableJAttempt::EntityProvider(attempt) => {
                    let operator_key = self.j_submit_operator_key.ok_or_else(|| {
                        ResidentRuntimeServiceError::JSubmit("OPERATOR_KEY_MISSING".into())
                    })?;
                    let result = submit_committed_provider_attempt(
                        self.processor.replica()?,
                        operator_key,
                        &attempt,
                    );
                    self.pending_runtime_txs
                        .push_back(RuntimeTx::RecordEntityProviderActionSubmitResult(result));
                }
                DurableJAttempt::Governance(attempt) => {
                    let operator_key = self.j_submit_operator_key.ok_or_else(|| {
                        ResidentRuntimeServiceError::JSubmit("OPERATOR_KEY_MISSING".into())
                    })?;
                    let result = submit_committed_governance_attempt(
                        self.processor.replica()?,
                        operator_key,
                        &attempt,
                    );
                    self.pending_runtime_txs
                        .push_back(RuntimeTx::RecordGovernanceJSubmitResult(result));
                }
                DurableJAttempt::Maintenance(intent) => {
                    let operator_key = self.j_submit_operator_key.ok_or_else(|| {
                        ResidentRuntimeServiceError::JSubmit("OPERATOR_KEY_MISSING".into())
                    })?;
                    submit_committed_maintenance(self.processor.replica()?, operator_key, &intent)?;
                }
            }
        }
        Ok(())
    }

    pub fn shutdown(&mut self) -> Result<(), ResidentRuntimeServiceError> {
        self.ingress.shutdown()?;
        Ok(())
    }
}

fn live_submit_context(
    replica: &crate::RuntimeReplica,
    jurisdiction_name: &str,
    operator_private_key: [u8; 32],
) -> Result<(HttpJsonRpc, JSubmitConfig, [u8; 20]), JSubmitError> {
    let row = replica
        .durable
        .j_replicas()
        .as_array()
        .and_then(|rows| {
            rows.iter().find(|row| {
                row.as_array().is_some_and(|pair| {
                    pair.first().and_then(Value::as_str) == Some(jurisdiction_name)
                })
            })
        })
        .and_then(Value::as_array)
        .and_then(|pair| pair.get(1))
        .and_then(Value::as_object)
        .ok_or(JSubmitError::Transaction("jurisdiction-replica"))?;
    let chain_id = row
        .get("chainId")
        .and_then(Value::as_u64)
        .ok_or(JSubmitError::Transaction("chain-id"))?;
    let depository_address = row
        .get("contracts")
        .and_then(Value::as_object)
        .and_then(|contracts| contracts.get("depository"))
        .and_then(Value::as_str)
        .and_then(parse_address)
        .ok_or(JSubmitError::Transaction("depository"))?;
    let entity_provider_address = row
        .get("contracts")
        .and_then(Value::as_object)
        .and_then(|contracts| contracts.get("entityProvider"))
        .and_then(Value::as_str)
        .and_then(parse_address)
        .ok_or(JSubmitError::Transaction("entity-provider"))?;
    let endpoint = row
        .get("rpcs")
        .and_then(Value::as_array)
        .and_then(|rpcs| rpcs.iter().find_map(Value::as_str))
        .ok_or(JSubmitError::Transaction("rpc"))?;
    Ok((
        HttpJsonRpc::for_committed_j(endpoint, row)
            .map_err(|error| JSubmitError::Rpc(error.to_string()))?,
        JSubmitConfig {
            chain_id,
            depository_address,
            operator_private_key,
            max_fee_per_gas: U256::from(200_000_000_000_u64),
            gas_headroom_bps: 12_000,
        },
        entity_provider_address,
    ))
}

fn submit_committed_maintenance(
    replica: &crate::RuntimeReplica,
    operator_private_key: [u8; 32],
    intent: &JMaintenanceIntent,
) -> Result<(), ResidentRuntimeServiceError> {
    match intent {
        JMaintenanceIntent::MintReserves {
            jurisdiction_name,
            entity_id,
            token_id,
            amount,
            ..
        } => {
            let (rpc, config, _) =
                live_submit_context(replica, jurisdiction_name, operator_private_key)
                    .map_err(|error| ResidentRuntimeServiceError::JSubmit(error.to_string()))?;
            JSubmitter::new(&rpc, config)
                .and_then(|submitter| submitter.submit_mint_reserves(entity_id, *token_id, amount))
                .map_err(|error| ResidentRuntimeServiceError::JSubmit(error.to_string()))?;
            Ok(())
        }
        JMaintenanceIntent::ActivateBoard {
            jurisdiction_name,
            target_entity_id,
            ..
        } => {
            let (rpc, config, entity_provider) =
                live_submit_context(replica, jurisdiction_name, operator_private_key)
                    .map_err(|error| ResidentRuntimeServiceError::JSubmit(error.to_string()))?;
            JSubmitter::new(&rpc, config)
                .and_then(|submitter| {
                    submitter.submit_activate_board(
                        entity_provider,
                        target_entity_id,
                        &operator_private_key,
                    )
                })
                .map_err(|error| ResidentRuntimeServiceError::JSubmit(error.to_string()))?;
            Ok(())
        }
    }
}

fn recover_pending_j_actions(
    replica: &crate::RuntimeReplica,
) -> Result<Vec<DurableJAttempt>, ResidentRuntimeServiceError> {
    let mut actions = decode_pending_j_submit_attempts(replica.durable.infrastructure())
        .map_err(|error| ResidentRuntimeServiceError::JSubmit(error.to_string()))?
        .into_iter()
        .filter(|attempt| !crate::j_submit::lifecycle::prepared_attempt_completed(replica, attempt))
        .map(DurableJAttempt::Batch)
        .collect::<Vec<_>>();
    actions.extend(
        crate::j_submit::decode_pending_entity_provider_attempts(replica.durable.infrastructure())
            .map_err(|error| ResidentRuntimeServiceError::JSubmit(error.to_string()))?
            .into_iter()
            .map(DurableJAttempt::EntityProvider),
    );
    actions.extend(
        crate::j_submit::decode_pending_governance_attempts(replica.durable.infrastructure())
            .map_err(|error| ResidentRuntimeServiceError::JSubmit(error.to_string()))?
            .into_iter()
            .map(DurableJAttempt::Governance),
    );
    Ok(actions)
}

fn extend_pending_j_scan(
    pending: Option<PendingJScan>,
    cursor: &FinalizedWatcherCursor,
    poll: &JWatcherPoll,
) -> Result<PendingJScan, ResidentRuntimeServiceError> {
    if pending.as_ref().is_some_and(|value| {
        value.scanned_through != cursor.scanned_through || cursor.block_hash != Some(value.tip_hash)
    }) {
        return Err(ResidentRuntimeServiceError::JWatcher(
            "PENDING_SCAN_CURSOR_MISMATCH".into(),
        ));
    }
    let base_height = pending
        .as_ref()
        .map_or(cursor.scanned_through, |value| value.base_height);
    let mut headers = pending.map_or_else(Vec::new, |value| value.headers);
    let expected_first = headers
        .last()
        .map_or(cursor.scanned_through + 1, |value| value.j_height + 1);
    if poll.headers.first().map(|value| value.j_height) != Some(expected_first)
        || poll
            .headers
            .windows(2)
            .any(|pair| pair[0].j_height + 1 != pair[1].j_height)
        || poll.headers.last().map(|value| value.j_height) != Some(poll.cursor.scanned_through)
    {
        return Err(ResidentRuntimeServiceError::JWatcher(
            "PENDING_SCAN_HEADER_RANGE".into(),
        ));
    }
    headers.extend(poll.headers.iter().cloned());
    let tip_hash = poll
        .cursor
        .block_hash
        .ok_or_else(|| ResidentRuntimeServiceError::JWatcher("PENDING_SCAN_TIP_HASH".into()))?;
    Ok(PendingJScan {
        base_height,
        scanned_through: poll.cursor.scanned_through,
        tip_hash,
        headers,
    })
}

fn certified_watcher_cursor_candidate(
    transient_scanned_height: u64,
    certified_height: u64,
    durable_height: u64,
) -> Option<u64> {
    let candidate = transient_scanned_height.min(certified_height);
    (candidate > durable_height).then_some(candidate)
}

fn j_scan_liveness_due(scanned_through: u64, entity_base_height: u64) -> bool {
    scanned_through.saturating_sub(entity_base_height) >= JBLOCK_LIVENESS_INTERVAL
}

fn ordered_j_observation_txs(observation: &crate::j_watcher::ObserveJRange) -> Vec<RuntimeTx> {
    let mut txs = observation
        .batches
        .iter()
        .map(|batch| {
            RuntimeTx::ObserveJRange(crate::j_watcher::ObserveJRange {
                scanned_through_height: batch.j_height,
                tip_block_hash: batch.j_block_hash,
                headers_present: false,
                headers: Vec::new(),
                batches: vec![batch.clone()],
                ..observation.clone()
            })
        })
        .collect::<Vec<_>>();
    txs.push(RuntimeTx::ObserveJRange(crate::j_watcher::ObserveJRange {
        batches: Vec::new(),
        ..observation.clone()
    }));
    txs
}

fn coalesce_inbound_prefix(
    held: &mut VecDeque<InboundEntityInputs>,
    available: usize,
) -> (Vec<RuntimeEntityInput>, Option<u64>) {
    let mut entity_inputs = Vec::new();
    let mut queued_at: Option<u64> = None;
    while let Some(batch) = held.front() {
        if entity_inputs
            .len()
            .checked_add(batch.entity_inputs.len())
            .is_none_or(|count| count > available)
        {
            break;
        }
        let mut batch = held.pop_front().expect("front above");
        queued_at = match (queued_at, batch.ingress_timestamp) {
            (Some(left), Some(right)) => Some(left.max(right)),
            (left @ Some(_), None) => left,
            (None, right) => right,
        };
        entity_inputs.append(&mut batch.entity_inputs);
    }
    (entity_inputs, queued_at)
}

fn wall_clock_ms() -> Result<u64, ResidentRuntimeServiceError> {
    let value = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ResidentRuntimeServiceError::ClockBeforeEpoch)?
        .as_millis();
    u64::try_from(value)
        .ok()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or(ResidentRuntimeServiceError::ClockUnsafe)
}

fn watcher_cursor_tx(
    depository_address: String,
    chain_id: u64,
    cursor: &FinalizedWatcherCursor,
) -> RuntimeTx {
    RuntimeTx::AdvanceJWatcherCursor {
        depository_address,
        chain_id,
        block_number: cursor.scanned_through,
    }
}

fn resolve_live_timestamp(
    previous: u64,
    queued_at: u64,
    now: u64,
) -> Result<u64, ResidentRuntimeServiceError> {
    if [previous, queued_at, now]
        .iter()
        .any(|value| *value > MAX_SAFE_INTEGER)
    {
        return Err(ResidentRuntimeServiceError::ClockUnsafe);
    }
    let future_limit = now
        .checked_add(TIMESTAMP_DRIFT_MS)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or(ResidentRuntimeServiceError::ClockUnsafe)?;
    if previous > future_limit {
        return Err(ResidentRuntimeServiceError::ClockAhead { previous, now });
    }
    Ok(previous.max(queued_at.min(future_limit)))
}

fn submit_committed_attempt(
    replica: &crate::RuntimeReplica,
    operator_private_key: [u8; 32],
    attempt: &DurableJSubmitAttempt,
    minimum_nonce: Option<u64>,
) -> RuntimeTx {
    let base = || JSubmitResultData {
        entity_id: format!("0x{}", hex::encode(attempt.sealed.entity_id)),
        signer_id: format!("0x{}", hex::encode(attempt.sealed.signer_id)),
        jurisdiction_name: attempt.jurisdiction_name.clone(),
        batch_hash: attempt.batch_hash.clone(),
        entity_nonce: attempt.sealed.nonce.low_u64(),
        batch_generation: attempt.batch_generation,
        attempt_id: attempt.attempt_id.clone(),
        attempt_number: attempt.attempt_number,
        attempted_at: attempt.attempted_at,
        outcome: JSubmitResultOutcome::Submitted,
        message: None,
        adapter_failure: None,
        transaction_hash: None,
    };
    let mut replacement_evidence = None;
    let mut submit = || -> Result<crate::j_submit::JSubmitPreparation, JSubmitError> {
        let row = replica
            .durable
            .j_replicas()
            .as_array()
            .and_then(|rows| {
                rows.iter().find(|row| {
                    row.as_array().is_some_and(|pair| {
                        pair.first().and_then(Value::as_str)
                            == Some(attempt.jurisdiction_name.as_str())
                    })
                })
            })
            .and_then(Value::as_array)
            .and_then(|pair| pair.get(1))
            .and_then(Value::as_object)
            .ok_or(JSubmitError::Transaction("jurisdiction-replica"))?;
        let chain_id = row
            .get("chainId")
            .and_then(Value::as_u64)
            .ok_or(JSubmitError::Transaction("chain-id"))?;
        let depository = row
            .get("contracts")
            .and_then(Value::as_object)
            .and_then(|contracts| contracts.get("depository"))
            .and_then(Value::as_str)
            .ok_or(JSubmitError::Transaction("depository"))?;
        let depository_address =
            parse_address(depository).ok_or(JSubmitError::Transaction("depository"))?;
        let endpoint = row
            .get("rpcs")
            .and_then(Value::as_array)
            .and_then(|rpcs| rpcs.iter().find_map(Value::as_str))
            .ok_or(JSubmitError::Transaction("rpc"))?;
        let rpc = HttpJsonRpc::for_committed_j(endpoint, row)
            .map_err(|error| JSubmitError::Rpc(error.to_string()))?;
        let submitter = JSubmitter::new(
            &rpc,
            JSubmitConfig {
                chain_id,
                depository_address,
                operator_private_key,
                max_fee_per_gas: U256::from(200_000_000_000_u64),
                gas_headroom_bps: 12_000,
            },
        )?;
        if let Some(raw) = &attempt.raw_transaction {
            if let Some((next, evidence)) = submitter.prepare_native_replacement(raw)? {
                replacement_evidence = Some(evidence);
                return Ok(crate::j_submit::JSubmitPreparation::Prepared(next));
            }
            return submitter
                .broadcast_prepared(raw, &[])
                .map(crate::j_submit::JSubmitPreparation::Resolved);
        }
        let (entity_state, entity_replica) = replica
            .entity_slot(
                &attempt.sealed.entity_id,
                &format!("0x{}", hex::encode(attempt.sealed.signer_id)),
            )
            .ok_or(JSubmitError::Transaction("local-entity-slot"))?;
        if let Some(local) = entity_replica.replica_metadata().get("jSubmitState")
            && local.get("batchHash").and_then(Value::as_str) == Some(attempt.batch_hash.as_str())
            && local.get("entityNonce").and_then(Value::as_u64)
                == Some(attempt.sealed.nonce.low_u64())
            && local.get("batchGeneration").and_then(Value::as_u64)
                == Some(attempt.batch_generation)
            && let Some(hash) = local.get("txHash").and_then(Value::as_str)
        {
            let transaction_hash: [u8; 32] = hash
                .strip_prefix("0x")
                .and_then(|value| hex::decode(value).ok())
                .and_then(|bytes| bytes.try_into().ok())
                .ok_or(JSubmitError::Transaction("known-transaction-hash"))?;
            // Recovered pending I/O polls the same transaction; no second sender nonce.
            return Ok(crate::j_submit::JSubmitPreparation::Resolved(
                submitter.receipt_status(&transaction_hash, &[])?.unwrap_or(
                    JSubmitOutcome::Broadcast {
                        transaction_hash,
                        transaction_nonce: 0,
                    },
                ),
            ));
        }
        let current_board = entity_state
            .certified_board_authority()
            .current_board_hash(&attempt.sealed.entity_id);
        let authority = |entity_id: &[u8; 32], board_hash: &[u8; 32], _claim_index: usize| {
            entity_id == &attempt.sealed.entity_id && current_board.as_ref() == Some(board_hash)
        };
        submitter.prepare_batch(
            &attempt.sealed,
            attempt.fee_overrides.as_ref(),
            Some(&operator_private_key),
            Some(&authority),
            &[],
            minimum_nonce,
        )
    };
    let outcome = match submit() {
        Ok(crate::j_submit::JSubmitPreparation::Prepared(raw_transaction)) => {
            if let Some(evidence) = replacement_evidence {
                let value = serde_json::json!({"jurisdictionName":attempt.jurisdiction_name,"attemptId":attempt.attempt_id,
                    "previousTransactionHash":evidence["oldTransactionHash"],"rawTransaction":raw_transaction,"evidence":evidence});
                return RuntimeTx::ReplaceJPreparedTransaction(
                    crate::j_submit::decode_replacement(&value)
                        .expect("validated native replacement callback"),
                );
            }
            return RuntimeTx::RecordJPreparedTransaction(
                crate::j_submit::JPreparedTransactionData {
                    jurisdiction_name: attempt.jurisdiction_name.clone(),
                    attempt_id: attempt.attempt_id.clone(),
                    raw_transaction,
                },
            );
        }
        Ok(crate::j_submit::JSubmitPreparation::Resolved(outcome)) => Ok(outcome),
        Err(error) => Err(error),
    };
    let result = match outcome {
        Ok(JSubmitOutcome::MinedAwaitingAuthentication {
            transaction_hash, ..
        }) => {
            let mut result = base();
            result.transaction_hash = Some(format!("0x{}", hex::encode(transaction_hash)));
            result
        }
        Ok(JSubmitOutcome::Broadcast {
            transaction_hash, ..
        }) => {
            let mut result = base();
            let message = "J_SUBMIT_TRANSACTION_NOT_MINED".to_string();
            result.outcome = JSubmitResultOutcome::TransientFailure;
            result.message = Some(message.clone());
            result.transaction_hash = Some(format!("0x{}", hex::encode(transaction_hash)));
            result.adapter_failure = Some(JAdapterFailure {
                category: "transient".into(),
                code: "J_SUBMIT_TRANSACTION_NOT_MINED".into(),
                message,
            });
            result
        }
        Ok(JSubmitOutcome::Authenticated(evidence)) => {
            let mut result = base();
            result.outcome = JSubmitResultOutcome::Reconciled;
            result.transaction_hash = Some(format!("0x{}", hex::encode(evidence.transaction_hash)));
            result
        }
        Ok(JSubmitOutcome::AwaitingAuthenticatedEvidence) => {
            let mut result = base();
            result.outcome = JSubmitResultOutcome::EventBarrier;
            result.message = Some("authenticated-j-events-before-submit".into());
            result
        }
        Err(error) => {
            let mut result = base();
            let transient = matches!(error, JSubmitError::Rpc(_));
            let message = truncate_failure(error.to_string());
            result.outcome = if transient {
                JSubmitResultOutcome::TransientFailure
            } else {
                JSubmitResultOutcome::TerminalFailure
            };
            result.message = Some(message.clone());
            result.adapter_failure = Some(JAdapterFailure {
                category: if transient { "transient" } else { "terminal" }.into(),
                code: if transient {
                    "J_SUBMIT_TRANSIENT"
                } else {
                    "J_SUBMIT_FATAL"
                }
                .into(),
                message,
            });
            result
        }
    };
    RuntimeTx::RecordJSubmitResult(result)
}

fn submit_committed_provider_attempt(
    replica: &crate::RuntimeReplica,
    operator_private_key: [u8; 32],
    attempt: &DurableEntityProviderActionAttempt,
) -> EntityProviderActionResultData {
    let entity_id = attempt.intent.entity_id.clone();
    let signer_id = format!("0x{}", hex::encode(attempt.signer_id));
    let action_hash = format!("0x{}", hex::encode(attempt.intent.action_hash));
    let base = || EntityProviderActionResultData {
        entity_id: entity_id.clone(),
        signer_id: signer_id.clone(),
        jurisdiction_name: attempt.jurisdiction_name.clone(),
        action_hash: action_hash.clone(),
        action_nonce: attempt.intent.action_nonce,
        generation: attempt.intent.generation,
        attempt_id: attempt.attempt_id.clone(),
        attempt_number: attempt.attempt_number,
        attempted_at: attempt.attempted_at,
        outcome: EntityProviderActionResultOutcome::Submitted,
        message: None,
        adapter_failure: None,
        transaction_hash: None,
    };
    let submit = || -> Result<JSubmitOutcome, JSubmitError> {
        let entity_word =
            parse_word(&entity_id).ok_or(JSubmitError::Transaction("provider-entity-id"))?;
        let (entity_state, _) = replica
            .entity_slot(&entity_word, &signer_id)
            .ok_or(JSubmitError::Transaction("provider-local-entity-slot"))?;
        let still_pending = replica
            .entity_slot(&entity_word, &signer_id)
            .map(|(state, _)| state)
            .and_then(|state| state.entity.entity_provider_action_state.as_ref())
            .and_then(|state| state.pending.as_ref())
            .is_some_and(|intent| intent == &attempt.intent);
        if !still_pending {
            return Ok(JSubmitOutcome::AwaitingAuthenticatedEvidence);
        }
        let operator = xln_rscore_crypto::address_of_private_key(&operator_private_key)
            .ok_or(JSubmitError::Transaction("operator-key"))?;
        if operator != attempt.signer_id {
            return Err(JSubmitError::Transaction("provider-signer-mismatch"));
        }
        let row = replica
            .durable
            .j_replicas()
            .as_array()
            .and_then(|rows| {
                rows.iter().find(|row| {
                    row.as_array().is_some_and(|pair| {
                        pair.first().and_then(Value::as_str)
                            == Some(attempt.jurisdiction_name.as_str())
                    })
                })
            })
            .and_then(Value::as_array)
            .and_then(|pair| pair.get(1))
            .and_then(Value::as_object)
            .ok_or(JSubmitError::Transaction("jurisdiction-replica"))?;
        let chain_id = row
            .get("chainId")
            .and_then(Value::as_u64)
            .ok_or(JSubmitError::Transaction("chain-id"))?;
        let depository = row
            .get("contracts")
            .and_then(Value::as_object)
            .and_then(|contracts| contracts.get("depository"))
            .and_then(Value::as_str)
            .and_then(parse_address)
            .ok_or(JSubmitError::Transaction("depository"))?;
        let endpoint = row
            .get("rpcs")
            .and_then(Value::as_array)
            .and_then(|rpcs| rpcs.iter().find_map(Value::as_str))
            .ok_or(JSubmitError::Transaction("rpc"))?;
        let rpc = HttpJsonRpc::for_committed_j(endpoint, row)
            .map_err(|error| JSubmitError::Rpc(error.to_string()))?;
        let submitter = JSubmitter::new(
            &rpc,
            JSubmitConfig {
                chain_id,
                depository_address: depository,
                operator_private_key,
                max_fee_per_gas: U256::from(200_000_000_000_u64),
                gas_headroom_bps: 12_000,
            },
        )?;
        let current_board = entity_state
            .certified_board_authority()
            .current_board_hash(&entity_word);
        let authority = |claimed_entity: &[u8; 32], board_hash: &[u8; 32], _claim_index: usize| {
            claimed_entity == &entity_word && current_board.as_ref() == Some(board_hash)
        };
        submitter.submit_entity_provider_action(
            &attempt.intent,
            &attempt.hanko,
            &operator_private_key,
            Some(&authority),
        )
    };
    match submit() {
        Ok(JSubmitOutcome::MinedAwaitingAuthentication {
            transaction_hash, ..
        }) => {
            let mut result = base();
            result.transaction_hash = Some(format!("0x{}", hex::encode(transaction_hash)));
            result
        }
        Ok(JSubmitOutcome::Broadcast {
            transaction_hash, ..
        }) => {
            let mut result = base();
            let message = "ENTITY_PROVIDER_ACTION_TRANSACTION_NOT_MINED".to_string();
            result.outcome = EntityProviderActionResultOutcome::TransientFailure;
            result.message = Some(message.clone());
            result.transaction_hash = Some(format!("0x{}", hex::encode(transaction_hash)));
            result.adapter_failure = Some(JAdapterFailure {
                category: "transient".into(),
                code: "ENTITY_PROVIDER_ACTION_TRANSACTION_NOT_MINED".into(),
                message,
            });
            result
        }
        Ok(JSubmitOutcome::Authenticated(evidence)) => {
            let mut result = base();
            result.outcome = EntityProviderActionResultOutcome::Reconciled;
            result.transaction_hash = Some(format!("0x{}", hex::encode(evidence.transaction_hash)));
            result
        }
        Ok(JSubmitOutcome::AwaitingAuthenticatedEvidence) => {
            let mut result = base();
            let stale = parse_word(&entity_id)
                .and_then(|entity_word| replica.entity_slot(&entity_word, &signer_id))
                .map(|(state, _)| state)
                .and_then(|state| state.entity.entity_provider_action_state.as_ref())
                .and_then(|state| state.pending.as_ref())
                .is_none();
            result.outcome = if stale {
                EntityProviderActionResultOutcome::Reconciled
            } else {
                EntityProviderActionResultOutcome::TransientFailure
            };
            result.message = Some(
                if stale {
                    "entity-provider-action-finalized-before-submit"
                } else {
                    "entity-provider-action-awaiting-authenticated-event"
                }
                .into(),
            );
            result
        }
        Err(reason) => {
            let mut result = base();
            let transient = matches!(reason, JSubmitError::Rpc(_));
            let message = truncate_failure(reason.to_string());
            result.outcome = if transient {
                EntityProviderActionResultOutcome::TransientFailure
            } else {
                EntityProviderActionResultOutcome::TerminalFailure
            };
            result.message = Some(message.clone());
            result.adapter_failure = Some(JAdapterFailure {
                category: if transient { "transient" } else { "terminal" }.into(),
                code: if transient {
                    "J_SUBMIT_TRANSIENT"
                } else {
                    "J_SUBMIT_FATAL"
                }
                .into(),
                message,
            });
            result
        }
    }
}

fn submit_committed_governance_attempt(
    replica: &crate::RuntimeReplica,
    operator_private_key: [u8; 32],
    attempt: &DurableGovernanceAttempt,
) -> GovernanceResultData {
    let entity_id = format!("0x{}", hex::encode(attempt.shareholder_entity_id));
    let signer_id = format!("0x{}", hex::encode(attempt.signer_id));
    let proposal_hash = format!("0x{}", hex::encode(attempt.proposal_hash));
    let payload_hash = format!("0x{}", hex::encode(attempt.payload_hash));
    let base = || GovernanceResultData {
        jurisdiction_name: attempt.jurisdiction_name.clone(),
        entity_id: entity_id.clone(),
        signer_id: signer_id.clone(),
        proposal_hash: proposal_hash.clone(),
        payload_hash: payload_hash.clone(),
        attempt_id: attempt.attempt_id.clone(),
        attempt_number: attempt.attempt_number,
        attempted_at: attempt.attempted_at,
        outcome: GovernanceResultOutcome::Submitted,
        message: None,
        adapter_failure: None,
        transaction_hash: None,
    };
    let submit = || -> Result<JSubmitOutcome, JSubmitError> {
        let operator = xln_rscore_crypto::address_of_private_key(&operator_private_key)
            .ok_or(JSubmitError::Transaction("operator-key"))?;
        if operator != attempt.signer_id {
            return Err(JSubmitError::Transaction("governance-signer-mismatch"));
        }
        let pending =
            crate::j_submit::decode_pending_governance_attempts(replica.durable.infrastructure())
                .map_err(|_| JSubmitError::Transaction("governance-pending-invalid"))?;
        let pending_count = pending
            .iter()
            .filter(|row| row.attempt_id == attempt.attempt_id)
            .count();
        if pending_count == 0 {
            return Ok(JSubmitOutcome::AwaitingAuthenticatedEvidence);
        }
        if pending_count != 1 {
            return Err(JSubmitError::Transaction("governance-pending-duplicated"));
        }
        let (entity_state, _) = replica
            .entity_slot(&attempt.shareholder_entity_id, &signer_id)
            .ok_or(JSubmitError::Transaction("governance-local-entity-slot"))?;
        let (rpc, config, entity_provider) =
            live_submit_context(replica, &attempt.jurisdiction_name, operator_private_key)?;
        let submitter = JSubmitter::new(&rpc, config)?;
        let supporter_hankos = attempt
            .supporter_votes
            .iter()
            .map(|vote| (&vote.entity_id, vote.hanko.as_slice()))
            .collect::<Vec<_>>();
        let authority = |claimed_entity: &[u8; 32], board_hash: &[u8; 32], _claim_index: usize| {
            entity_state
                .certified_board_authority()
                .current_board_hash(claimed_entity)
                .as_ref()
                == Some(board_hash)
        };
        submitter.submit_control_board_proposal(crate::j_submit::ControlBoardProposal {
            entity_provider,
            shareholder_entity_id: &attempt.shareholder_entity_id,
            target_entity_id: &attempt.target_entity_id,
            new_board_hash: &attempt.new_board_hash,
            target_board_epoch: attempt.target_board_epoch,
            action_nonce: attempt.action_nonce,
            proposal_hash: &attempt.proposal_hash,
            supporter_hankos: &supporter_hankos,
            signer_key: &operator_private_key,
            board_authority: Some(&authority),
        })
    };
    match submit() {
        Ok(JSubmitOutcome::MinedAwaitingAuthentication {
            transaction_hash, ..
        }) => {
            let mut result = base();
            result.transaction_hash = Some(format!("0x{}", hex::encode(transaction_hash)));
            result
        }
        Ok(JSubmitOutcome::Broadcast {
            transaction_hash, ..
        }) => {
            let mut result = base();
            let message = "GOVERNANCE_TRANSACTION_NOT_MINED".to_string();
            result.outcome = GovernanceResultOutcome::TransientFailure;
            result.message = Some(message.clone());
            result.transaction_hash = Some(format!("0x{}", hex::encode(transaction_hash)));
            result.adapter_failure = Some(JAdapterFailure {
                category: "transient".into(),
                code: "GOVERNANCE_TRANSACTION_NOT_MINED".into(),
                message,
            });
            result
        }
        Ok(JSubmitOutcome::Authenticated(evidence)) => {
            let mut result = base();
            result.outcome = GovernanceResultOutcome::Reconciled;
            result.transaction_hash = Some(format!("0x{}", hex::encode(evidence.transaction_hash)));
            result
        }
        Ok(JSubmitOutcome::AwaitingAuthenticatedEvidence) => {
            let mut result = base();
            result.outcome = GovernanceResultOutcome::Reconciled;
            result.message = Some("governance-finalized-before-submit".into());
            result
        }
        Err(reason) => {
            let mut result = base();
            let transient = matches!(reason, JSubmitError::Rpc(_));
            let message = truncate_failure(reason.to_string());
            result.outcome = if transient {
                GovernanceResultOutcome::TransientFailure
            } else {
                GovernanceResultOutcome::TerminalFailure
            };
            result.message = Some(message.clone());
            result.adapter_failure = Some(JAdapterFailure {
                category: if transient { "transient" } else { "terminal" }.into(),
                code: if transient {
                    "J_SUBMIT_TRANSIENT"
                } else {
                    "J_SUBMIT_FATAL"
                }
                .into(),
                message,
            });
            result
        }
    }
}

fn live_j_watchers(
    replica: &crate::RuntimeReplica,
    watched: &BTreeSet<([u8; 32], String)>,
) -> Result<VecDeque<LiveJWatcher>, ResidentRuntimeServiceError> {
    let mut candidates = Vec::new();
    for (entity_key, entity_replica) in &replica.e_replicas {
        if watched.contains(&(entity_key.entity_id, entity_key.signer_id.clone())) {
            continue;
        }
        let Some(entity_state) = replica.state.e_replicas.get(entity_key) else {
            return Err(ResidentRuntimeServiceError::JWatcher(
                "ENTITY_STATE_MISSING".into(),
            ));
        };
        if !is_current_board_watcher(entity_replica)? {
            continue;
        }
        let Some(jurisdiction) = entity_replica
            .entity_consensus
            .state
            .authority
            .config
            .jurisdiction
            .as_ref()
        else {
            continue;
        };
        let xln_rscore_protocol::CanonicalValue::Object(fields) = jurisdiction else {
            return Err(ResidentRuntimeServiceError::JWatcher(
                "JURISDICTION_OBJECT".into(),
            ));
        };
        let get = |name: &str| {
            fields
                .iter()
                .find_map(|(key, value)| (key == name).then_some(value))
        };
        let chain_id = canonical_u64(get("chainId"))
            .ok_or_else(|| ResidentRuntimeServiceError::JWatcher("CHAIN_ID_MISSING".into()))?;
        let depository_text = canonical_text(get("depositoryAddress"))
            .ok_or_else(|| ResidentRuntimeServiceError::JWatcher("DEPOSITORY_MISSING".into()))?;
        let entity_provider_text =
            canonical_text(get("entityProviderAddress")).ok_or_else(|| {
                ResidentRuntimeServiceError::JWatcher("ENTITY_PROVIDER_MISSING".into())
            })?;
        let depository_address = parse_address(&depository_text)
            .ok_or_else(|| ResidentRuntimeServiceError::JWatcher("DEPOSITORY_INVALID".into()))?;
        let entity_provider_address = parse_address(&entity_provider_text).ok_or_else(|| {
            ResidentRuntimeServiceError::JWatcher("ENTITY_PROVIDER_INVALID".into())
        })?;
        let rows = replica
            .durable
            .j_replicas()
            .as_array()
            .ok_or_else(|| ResidentRuntimeServiceError::JWatcher("J_REPLICAS_ARRAY".into()))?;
        let matches = rows
            .iter()
            .filter_map(|row| {
                let pair = row.as_array().filter(|pair| pair.len() == 2)?;
                let value = pair[1].as_object()?;
                let candidate_chain = value.get("chainId").and_then(Value::as_u64)?;
                let address = value.get("contracts")?.get("depository")?.as_str()?;
                (candidate_chain == chain_id && address.eq_ignore_ascii_case(&depository_text))
                    .then_some(value)
            })
            .collect::<Vec<_>>();
        let [j_replica] = matches.as_slice() else {
            return Err(ResidentRuntimeServiceError::JWatcher(
                if matches.is_empty() {
                    "J_REPLICA_NOT_FOUND"
                } else {
                    "J_REPLICA_AMBIGUOUS"
                }
                .into(),
            ));
        };
        if !j_replica
            .get("contracts")
            .and_then(|value| value.get("entityProvider"))
            .and_then(Value::as_str)
            .is_some_and(|address| address.eq_ignore_ascii_case(&entity_provider_text))
        {
            return Err(ResidentRuntimeServiceError::JWatcher(
                "ENTITY_PROVIDER_MISMATCH".into(),
            ));
        }
        let endpoint = j_replica
            .get("rpcs")
            .and_then(Value::as_array)
            .and_then(|rows| rows.iter().find_map(Value::as_str))
            .ok_or_else(|| ResidentRuntimeServiceError::JWatcher("RPC_MISSING".into()))?;
        // Entity history owns its authenticated recovery anchor. The shared J
        // cursor may lag a committed Entity certificate (including at the first
        // checkpoint); clamping to it asks for a pruned historical hash and can
        // halt recovery. Other Entities resume their own anchors independently.
        let cursor_height =
            committed_entity_j_height(entity_replica.replica_metadata(), &entity_state.entity)?;
        let confirmation_depth = j_replica
            .get("watcherConfirmationDepth")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let block_delay = j_replica
            .get("blockDelayMs")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value >= 0.0)
            .unwrap_or(1_000.0);
        let hash_ladders = watched_hash_ladders(
            &entity_state.entity,
            &format!("0x{}", hex::encode(entity_key.entity_id)),
        )?;
        let rpc = HttpJsonRpc::for_committed_j(endpoint, j_replica)
            .map_err(|error| ResidentRuntimeServiceError::JWatcher(error.to_string()))?;
        let cursor_hash = if unobserved_deployment_boundary(
            entity_replica.replica_metadata(),
            &entity_state.entity,
            j_replica
                .get("entityProviderDeploymentBlock")
                .and_then(Value::as_u64),
            cursor_height,
        ) {
            // This is a configured scan start, NOT certified history. Read only this
            // exact parent header; normal polling rechecks it and authenticates all receipts.
            crate::j_watcher::read_initial_watcher_anchor(&rpc, cursor_height)
                .map_err(|e| ResidentRuntimeServiceError::JWatcher(e.to_string()))?
        } else {
            committed_cursor_hash(
                entity_replica.replica_metadata(),
                &entity_state.entity,
                cursor_height,
            )?
        };
        let erc20_tokens =
            crate::j_watcher::read_erc20_token_registry(&rpc, &depository_address)
                .map_err(|error| ResidentRuntimeServiceError::JWatcher(error.to_string()))?;
        let external_wallets = watched_external_wallets(
            entity_state.entity.external_wallet.as_ref(),
            &erc20_tokens,
            &format!("0x{}", hex::encode(entity_key.entity_id)),
        )?;
        candidates.push(LiveJWatcher {
            rpc,
            config: JWatcherConfig {
                chain_id,
                depository_address,
                entity_provider_address,
                entity_id: xln_rscore_engine::EntityId::parse(&format!(
                    "0x{}",
                    hex::encode(entity_key.entity_id)
                ))
                .map_err(|error| ResidentRuntimeServiceError::JWatcher(error.to_string()))?,
                erc20_tokens,
                external_wallets,
                hash_ladders,
                confirmation_depth,
                max_blocks_per_poll: J_WATCHER_MAX_BLOCKS_PER_POLL,
            },
            cursor: FinalizedWatcherCursor {
                scanned_through: cursor_height,
                block_hash: cursor_hash,
            },
            signer_id: entity_replica.signer_id.clone(),
            jurisdiction_ref: format!("stack:{chain_id}:{}", depository_text.to_ascii_lowercase()),
            depository_text: depository_text.to_ascii_lowercase(),
            poll_interval: Duration::from_millis(block_delay.ceil().min(u64::MAX as f64) as u64),
            next_poll: Instant::now(),
            pending_scan: None,
            startup_target: 0,
            authenticated_through: 0,
        });
    }
    let mut targets = BTreeMap::new();
    for watcher in &mut candidates {
        let stack = (watcher.config.chain_id, watcher.config.depository_address);
        watcher.startup_target = match targets.get(&stack) {
            Some(target) => *target,
            None => {
                let target =
                    crate::j_watcher::capture_startup_target(&watcher.rpc, &watcher.config)
                        .map_err(|error| {
                            ResidentRuntimeServiceError::JWatcher(error.to_string())
                        })?;
                targets.insert(stack, target);
                target
            }
        };
    }
    Ok(candidates.into())
}

fn is_current_board_watcher(
    replica: &crate::RuntimeEntityReplica,
) -> Result<bool, ResidentRuntimeServiceError> {
    let config = &replica.entity_consensus.state.authority.config;
    let signer = replica.signer_id.trim();
    let validators = config
        .validators
        .iter()
        .filter(|value| value.trim().eq_ignore_ascii_case(signer))
        .count();
    if validators == 0 {
        return Ok(false);
    }
    let shares = config
        .shares
        .iter()
        .filter(|(value, _)| value.trim().eq_ignore_ascii_case(signer))
        .map(|(_, shares)| *shares)
        .collect::<Vec<_>>();
    if validators != 1 || !matches!(shares.as_slice(), [share] if *share > 0) {
        return Err(ResidentRuntimeServiceError::JWatcher(format!(
            "CURRENT_BOARD_SIGNER_INVALID:{signer}"
        )));
    }
    Ok(true)
}

fn watched_external_wallets(
    wallet: Option<&xln_rscore_entity_kernel::ExternalWalletState>,
    registry: &BTreeMap<[u8; 20], u64>,
    entity_id: &str,
) -> Result<Vec<crate::WatchedExternalWallet>, ResidentRuntimeServiceError> {
    let Some(wallet) = wallet else {
        return Ok(Vec::new());
    };
    let entity_id = xln_rscore_engine::EntityId::parse(entity_id)
        .map_err(|error| ResidentRuntimeServiceError::JWatcher(error.to_string()))?;
    let mut owners = BTreeMap::<[u8; 20], crate::WatchedExternalWallet>::new();
    for (owner, value) in wallet.balances() {
        // Native currency is committed in the same canonical wallet map but
        // has no ERC20 Transfer topic or token-registry row. It is refreshed
        // only by an authenticated snapshot, exactly like the TS watcher.
        if value.token_address == [0; 20] {
            continue;
        }
        let token_id = registry.get(&value.token_address).copied().ok_or_else(|| {
            ResidentRuntimeServiceError::JWatcher(format!(
                "WALLET_TOKEN_NOT_REGISTERED:{}",
                hex::encode(value.token_address)
            ))
        })?;
        if value.token_id.is_some_and(|value| value != token_id) {
            return Err(ResidentRuntimeServiceError::JWatcher(format!(
                "WALLET_TOKEN_ID_MISMATCH:{}:{token_id}",
                hex::encode(value.token_address)
            )));
        }
        owners
            .entry(owner)
            .or_insert_with(|| crate::WatchedExternalWallet {
                entity_id: entity_id.clone(),
                owner,
                watch_after_block: 0,
                balances: BTreeMap::new(),
                allowances: BTreeMap::new(),
            })
            .balances
            .insert(value.token_address, (token_id, value.j_height));
    }
    for (owner, value) in wallet.allowances() {
        if !registry.contains_key(&value.token_address) {
            return Err(ResidentRuntimeServiceError::JWatcher(format!(
                "WALLET_TOKEN_NOT_REGISTERED:{}",
                hex::encode(value.token_address)
            )));
        }
        owners
            .entry(owner)
            .or_insert_with(|| crate::WatchedExternalWallet {
                entity_id: entity_id.clone(),
                owner,
                watch_after_block: 0,
                balances: BTreeMap::new(),
                allowances: BTreeMap::new(),
            })
            .allowances
            .insert((value.token_address, value.spender), value.j_height);
    }
    Ok(owners.into_values().collect())
}

fn canonical_field<'a>(
    value: &'a xln_rscore_protocol::CanonicalValue,
    name: &str,
) -> Option<&'a xln_rscore_protocol::CanonicalValue> {
    match value {
        xln_rscore_protocol::CanonicalValue::Object(fields) => fields
            .iter()
            .find_map(|(key, value)| (key == name).then_some(value)),
        _ => None,
    }
}

fn canonical_nested_text<'a>(
    value: &'a xln_rscore_protocol::CanonicalValue,
    parent: &str,
    name: &str,
) -> Option<&'a str> {
    match canonical_field(canonical_field(value, parent)?, name)? {
        xln_rscore_protocol::CanonicalValue::String(value) => Some(value),
        _ => None,
    }
}

fn watched_hash_ladders(
    state: &xln_rscore_entity_kernel::EntityStateSlice,
    entity_id: &str,
) -> Result<BTreeSet<crate::WatchedHashLadder>, ResidentRuntimeServiceError> {
    let mut watched = BTreeSet::new();
    let Some(routes) = state.cross_jurisdiction_swaps.as_ref() else {
        return Ok(watched);
    };
    for (_, route) in routes.keyed_values() {
        for (leg_name, pull_name, target_role) in [
            ("source", "sourcePull", false),
            ("target", "targetPull", true),
        ] {
            let Some(local) = canonical_nested_text(route, leg_name, "entityId") else {
                continue;
            };
            let Some(writer) = canonical_nested_text(route, leg_name, "counterpartyEntityId")
            else {
                continue;
            };
            let Some(pull) = canonical_field(route, pull_name) else {
                continue;
            };
            if !local.eq_ignore_ascii_case(entity_id) {
                continue;
            }
            let full_hash = canonical_field(pull, "fullHash")
                .and_then(|value| match value {
                    xln_rscore_protocol::CanonicalValue::String(value) => parse_digest(value),
                    _ => None,
                })
                .ok_or_else(|| {
                    ResidentRuntimeServiceError::JWatcher(format!(
                        "HASH_LADDER_FULL_HASH_INVALID:{leg_name}"
                    ))
                })?;
            let partial_root = canonical_field(pull, "partialRoot")
                .and_then(|value| match value {
                    xln_rscore_protocol::CanonicalValue::String(value) => parse_digest(value),
                    _ => None,
                })
                .ok_or_else(|| {
                    ResidentRuntimeServiceError::JWatcher(format!(
                        "HASH_LADDER_PARTIAL_ROOT_INVALID:{leg_name}"
                    ))
                })?;
            let writer = xln_rscore_engine::EntityId::parse(writer).map_err(|error| {
                ResidentRuntimeServiceError::JWatcher(format!("HASH_LADDER_WRITER_INVALID:{error}"))
            })?;
            let counterparty = xln_rscore_engine::EntityId::parse(local).map_err(|error| {
                ResidentRuntimeServiceError::JWatcher(format!(
                    "HASH_LADDER_COUNTERPARTY_INVALID:{error}"
                ))
            })?;
            let mut bytes = [0_u8; 64];
            bytes[..32].copy_from_slice(&full_hash);
            bytes[32..].copy_from_slice(&partial_root);
            watched.insert(crate::WatchedHashLadder {
                writer,
                counterparty,
                ladder_hash: Keccak256::digest(bytes).into(),
                target_role,
            });
        }
    }
    Ok(watched)
}

fn committed_entity_j_height(
    metadata: &Value,
    state: &xln_rscore_entity_kernel::EntityStateSlice,
) -> Result<u64, ResidentRuntimeServiceError> {
    match metadata
        .get("jHistory")
        .and_then(|history| history.get("scannedThroughHeight"))
    {
        Some(Value::Number(value)) => value
            .as_u64()
            .ok_or_else(|| ResidentRuntimeServiceError::JWatcher("ENTITY_CURSOR_INVALID".into())),
        Some(_) => Err(ResidentRuntimeServiceError::JWatcher(
            "ENTITY_CURSOR_INVALID".into(),
        )),
        None => Ok(state.last_finalized_j_height),
    }
}

fn durable_watcher_cursor_height(
    replica: &crate::RuntimeReplica,
    chain_id: u64,
    depository: &str,
) -> Result<u64, ResidentRuntimeServiceError> {
    let rows = replica
        .durable
        .j_replicas()
        .as_array()
        .ok_or_else(|| ResidentRuntimeServiceError::JWatcher("J_REPLICAS_ARRAY".into()))?;
    let matches = rows
        .iter()
        .filter_map(|row| {
            let pair = row.as_array().filter(|pair| pair.len() == 2)?;
            let value = pair[1].as_object()?;
            let candidate_chain = value.get("chainId").and_then(Value::as_u64)?;
            let candidate_depository = value.get("contracts")?.get("depository")?.as_str()?;
            (candidate_chain == chain_id && candidate_depository.eq_ignore_ascii_case(depository))
                .then_some(value)
        })
        .collect::<Vec<_>>();
    let [j_replica] = matches.as_slice() else {
        return Err(ResidentRuntimeServiceError::JWatcher(
            if matches.is_empty() {
                "J_REPLICA_NOT_FOUND"
            } else {
                "J_REPLICA_AMBIGUOUS"
            }
            .into(),
        ));
    };
    match crate::canonical_value_from_tagged_json(
        j_replica
            .get("blockNumber")
            .ok_or_else(|| ResidentRuntimeServiceError::JWatcher("CURSOR_MISSING".into()))?,
    )
    .map_err(|error| ResidentRuntimeServiceError::JWatcher(error.to_string()))?
    {
        xln_rscore_protocol::CanonicalValue::BigInt(value) => u64::try_from(value)
            .map_err(|_| ResidentRuntimeServiceError::JWatcher("CURSOR_INVALID".into())),
        _ => Err(ResidentRuntimeServiceError::JWatcher(
            "CURSOR_INVALID".into(),
        )),
    }
}

fn canonical_text(value: Option<&xln_rscore_protocol::CanonicalValue>) -> Option<String> {
    match value? {
        xln_rscore_protocol::CanonicalValue::String(value) => {
            Some(value.trim().to_ascii_lowercase())
        }
        _ => None,
    }
}
fn canonical_u64(value: Option<&xln_rscore_protocol::CanonicalValue>) -> Option<u64> {
    match value? {
        xln_rscore_protocol::CanonicalValue::Number(value) => value.as_str().parse().ok(),
        xln_rscore_protocol::CanonicalValue::BigInt(value) => u64::try_from(value.clone()).ok(),
        _ => None,
    }
}

fn unobserved_deployment_boundary(
    metadata: &Value,
    state: &xln_rscore_entity_kernel::EntityStateSlice,
    deployment: Option<u64>,
    height: u64,
) -> bool {
    deployment.and_then(|value| value.checked_sub(1)) == Some(height)
        && state.last_finalized_j_height == height
        && state.j_history_finality.is_none()
        && metadata.get("jHistory").is_none_or(Value::is_null)
}

fn committed_cursor_hash(
    metadata: &Value,
    state: &xln_rscore_entity_kernel::EntityStateSlice,
    height: u64,
) -> Result<Option<[u8; 32]>, ResidentRuntimeServiceError> {
    if height == 0 {
        return Ok(None);
    }
    if let Some(history) = metadata.get("jHistory") {
        if history.get("scannedThroughHeight").and_then(Value::as_u64) == Some(height)
            && let Some(hash) = history.get("tipBlockHash").and_then(Value::as_str)
        {
            return parse_digest(hash).map(Some).ok_or_else(|| {
                ResidentRuntimeServiceError::JWatcher("CURSOR_HASH_INVALID".into())
            });
        }
        if let Some(rows) = history
            .get("blockHashes")
            .and_then(|value| value.get("value"))
            .and_then(Value::as_array)
            && let Some(hash) = rows.iter().find_map(|row| {
                let pair = row.as_array()?;
                (pair.first()?.as_u64() == Some(height))
                    .then(|| pair.get(1)?.as_str())
                    .flatten()
            })
        {
            return parse_digest(hash).map(Some).ok_or_else(|| {
                ResidentRuntimeServiceError::JWatcher("CURSOR_HASH_INVALID".into())
            });
        }
    }
    if state.last_finalized_j_height == height
        && let Some(finality) = state.j_history_finality.as_ref()
    {
        let json = crate::tagged_json_from_canonical_value(finality)
            .map_err(|error| ResidentRuntimeServiceError::JWatcher(error.to_string()))?;
        if let Some(hash) = json.get("tipBlockHash").and_then(Value::as_str) {
            return parse_digest(hash).map(Some).ok_or_else(|| {
                ResidentRuntimeServiceError::JWatcher("CURSOR_HASH_INVALID".into())
            });
        }
    }
    Err(ResidentRuntimeServiceError::JWatcher(format!(
        "CURSOR_HASH_MISSING:{height}"
    )))
}

fn parse_digest(value: &str) -> Option<[u8; 32]> {
    let raw = value.strip_prefix("0x")?;
    if raw.len() != 64 {
        return None;
    }
    hex::decode(raw).ok()?.try_into().ok()
}

fn parse_address(value: &str) -> Option<[u8; 20]> {
    let body = value.strip_prefix("0x")?;
    if body.len() != 40 {
        return None;
    }
    hex::decode(body).ok()?.try_into().ok()
}

fn parse_word(value: &str) -> Option<[u8; 32]> {
    let raw = value.strip_prefix("0x")?;
    let bytes = hex::decode(raw).ok()?;
    bytes.try_into().ok()
}

fn truncate_failure(value: String) -> String {
    let length = value.encode_utf16().count();
    if length <= 4_096 {
        return value;
    }
    let suffix = format!("...[truncated:{length}]");
    let keep = 4_096_usize.saturating_sub(suffix.encode_utf16().count());
    let mut units = value.encode_utf16().take(keep).collect::<Vec<_>>();
    while String::from_utf16(&units).is_err() {
        units.pop();
    }
    format!(
        "{}{suffix}",
        String::from_utf16(&units).expect("valid truncation")
    )
}

#[derive(Debug, Error)]
pub enum ResidentRuntimeServiceError {
    #[error("RRS_LIVE_RUNTIME_ID:durable={durable}:ingress={ingress}")]
    RuntimeId { durable: String, ingress: String },
    #[error("RRS_LIVE_CLOCK_BEFORE_EPOCH")]
    ClockBeforeEpoch,
    #[error("RRS_LIVE_CLOCK_UNSAFE")]
    ClockUnsafe,
    #[error("RRS_LIVE_J_SUBMIT:{0}")]
    JSubmit(String),
    #[error("RRS_LIVE_J_WATCHER:{0}")]
    JWatcher(String),
    #[error("RRS_LIVE_CLOCK_AHEAD:previous={previous}:now={now}")]
    ClockAhead { previous: u64, now: u64 },
    #[error("RRS_LIVE_J_HEIGHT_REGRESSION:previous={previous}:next={next}")]
    JHeightRegression { previous: u64, next: u64 },
    #[error("RRS_LIVE_RUNTIME_CONFIG:{0}")]
    RuntimeConfig(&'static str),
    #[error("{0}")]
    Processor(Box<DurableRuntimeProcessorError>),
    #[error(transparent)]
    Transport(#[from] RuntimeTransportError),
    #[error(transparent)]
    InboundRoute(#[from] super::EntityRouteError),
}

impl From<DurableRuntimeProcessorError> for ResidentRuntimeServiceError {
    fn from(error: DurableRuntimeProcessorError) -> Self {
        Self::Processor(Box::new(error))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejected_runtime_output_does_not_stop_live_ingress_or_admit_batch_prefix() {
        use crate::processor::{
            EntityRoute, EntityRouteTable, RuntimeDurableEnvelope, RuntimeSignerLabel,
        };
        use crate::storage::native::{NativeRuntimeStore, NativeStorageConfig};
        use crate::transport::{DirectRuntimeIngressConfig, derive_local_runtime_id};
        use std::net::{IpAddr, Ipv4Addr, SocketAddr};

        let seed = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
        let label = "runtime";
        let runtime_id = derive_local_runtime_id(seed, label).expect("local Runtime");
        let peer = format!("0x{}", "22".repeat(20));
        let source = format!("0x{}", "33".repeat(32));
        let source_signer = format!("0x{}", "44".repeat(20));
        let mut replica = crate::machine::tests::replica(crate::RuntimeLimits::hlt())
            .expect("real resident Account and Entity");
        // This ingress test owns no J domain (its Entity jurisdiction is None).
        // Build the supported no-J runtime, rather than unrelated RPC-less J replicas.
        replica.durable = RuntimeDurableEnvelope::decode(
            &json!({
                "runtimeId":runtime_id,"runtimeConfig":{"minFrameDelayMs":5},
                "infrastructure":{},"jReplicas":[]
            }),
            [0; 32],
        )
        .expect("canonical no-J ingress runtime");
        let target = replica
            .state
            .e_replicas
            .keys()
            .next()
            .expect("target")
            .clone();
        let initial_root = replica.state.e_replicas[&target].accounts_root;
        let initial_height = replica.state.height;
        let directory = std::env::temp_dir().join(format!(
            "xln-source-ingress-rejection-{}-{}",
            std::process::id(),
            wall_clock_ms().expect("clock")
        ));
        let store = NativeRuntimeStore::open(&directory, NativeStorageConfig::default())
            .expect("real native WAL");
        let routes = EntityRouteTable::new([
            EntityRoute {
                target_entity_id: source.clone(),
                target_runtime_id: peer.clone(),
                target_signer_id: source_signer.clone(),
                websocket_url: None,
            },
            EntityRoute {
                target_entity_id: format!("0x{}", "ff".repeat(32)),
                target_runtime_id: peer.clone(),
                target_signer_id: source_signer.clone(),
                websocket_url: None,
            },
        ])
        .expect("pinned source and honest Account peer");
        let processor = DurableRuntimeProcessor::new(
            replica,
            store,
            routes,
            seed,
            RuntimeSignerLabel::new(label).expect("Runtime signer"),
        )
        .expect("real durable processor");
        let ingress = DirectRuntimeIngress::bind(DirectRuntimeIngressConfig::production(
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            seed,
            label,
        ))
        .expect("real ingress");
        let mut service = ResidentRuntimeService::new(
            processor,
            ingress,
            Box::new(crate::CanonicalEntityInfraMaterializer::new()),
        )
        .expect("live service");
        let wire = json!({
            "entityId": format!("0x{}", hex::encode(target.entity_id)),
            "signerId": target.signer_id, "runtimeId": runtime_id, "from": peer,
            "sourceRuntimeFrame": {"height": 1, "timestamp": 100},
            "entityTxs": [{"type": "runtimeOutput", "data": {
                "protocol": "cross-j", "sourceEntityId": source, "sourceSignerId": source_signer,
                "targetEntityId": format!("0x{}", hex::encode(target.entity_id)),
                "entityTxs": [{"type": "crossJurisdictionFillNotice", "data": {
                    "orderId": "ingress-rejection", "fillSeq": 1, "cumulativeFillRatio": 100
                }}]
            }}]
        });
        let valid = RuntimeEntityInput::decode(wire.clone()).expect("valid wrapper");
        let mut forged_wire = wire;
        forged_wire["entityTxs"][0]["data"]["sourceSignerId"] =
            json!(format!("0x{}", "55".repeat(20)));
        let forged = RuntimeEntityInput::decode(forged_wire).expect("well-formed forgery");
        let batch = |inputs: Vec<RuntimeEntityInput>| InboundEntityInputs {
            peer_runtime_id: peer.clone(),
            message_id: "source-binding".into(),
            source_runtime_height: 1,
            source_runtime_timestamp: 100,
            ingress_timestamp: Some(100),
            entity_tx_count: inputs.len() as u64,
            entity_inputs: inputs,
        };
        assert!(
            service
                .accept_inbound_event(InboundRuntimeEvent::EntityInputs(batch(vec![
                    valid.clone(),
                    forged.clone()
                ])))
                .expect("hostile ingress is nonfatal")
                .is_none()
        );
        assert!(
            service.held_inbound.is_empty(),
            "no valid prefix was admitted"
        );
        let unchanged = service
            .processor
            .replica()
            .expect("processor stays healthy");
        assert_eq!(unchanged.state.height, initial_height);
        assert_eq!(
            unchanged.state.e_replicas[&target].accounts_root,
            initial_root
        );
        assert_eq!(unchanged.mempool.entity_input_count(), 0);
        assert!(matches!(
            service.process_batch_at(Some(batch(vec![forged])), 100),
            Err(ResidentRuntimeServiceError::InboundRoute(_)),
        ));
        // A peer can address an unknown Entity or the wrong validator. Neither
        // row may reach the durable reducer and poison its resident state.
        for (entity_id, signer_id) in [
            (format!("0x{}", "ee".repeat(32)), target.signer_id.clone()),
            (
                format!("0x{}", hex::encode(target.entity_id)),
                "unknown-validator".into(),
            ),
        ] {
            let unknown = RuntimeEntityInput::decode(json!({
                "entityId":entity_id,"signerId":signer_id,
                "runtimeId":runtime_id,"from":peer,
                "sourceRuntimeFrame":{"height":1,"timestamp":100},"entityTxs":[]
            }))
            .expect("well-formed hostile destination");
            assert!(
                matches!(
                    service.process_batch_at(Some(batch(vec![unknown])), 100),
                    Err(ResidentRuntimeServiceError::InboundRoute(_))
                ),
                "unknown remote destination must be rejected before durable processing"
            );
            assert_eq!(
                service
                    .processor
                    .replica()
                    .expect("not poisoned")
                    .state
                    .height,
                initial_height
            );
        }
        let admitted = service
            .accept_inbound_event(InboundRuntimeEvent::EntityInputs(batch(vec![valid])))
            .expect("following authenticated source remains accepted")
            .expect("semantic validation belongs to the reducer");
        service
            .process_batch_at(Some(admitted), 100)
            .expect("missing cross route must reject without halting live Runtime");
        let rejected = service
            .processor
            .replica()
            .expect("typed reject preserves Runtime");
        assert_eq!(
            rejected.state.e_replicas[&target].accounts_root,
            initial_root
        );
        assert_eq!(rejected.mempool.entity_input_count(), 0);
        let after_reject_height = rejected.state.height;
        let honest = RuntimeEntityInput::decode(json!({
            "entityId": format!("0x{}", hex::encode(target.entity_id)),
            "signerId": target.signer_id,
            "entityTxs": [{"type":"extendCredit", "data":{
                "counterpartyEntityId":format!("0x{}", "ff".repeat(32)),
                "tokenId":1, "amount":{"__xlnType":"BigInt", "value":"7"}
            }}]
        }))
        .expect("honest financial input");
        service
            .process_local_entity_inputs_at(vec![honest], 101)
            .expect("honest successor commits")
            .expect("honest successor makes progress");
        assert!(
            service
                .processor
                .replica()
                .expect("healthy successor")
                .state
                .height
                > after_reject_height
        );
        let before_tail = service.processor.replica().unwrap().state.height;
        let mixed = [
            json!({"type":"requestCrossJurisdictionClear", "data":{"orderId":"missing-planning-route"}}),
            json!({"type":"extendCredit", "data":{
                "counterpartyEntityId":format!("0x{}", "ff".repeat(32)),
                "tokenId":1, "amount":{"__xlnType":"BigInt", "value":"8"}
            }})
        ].into_iter().map(|tx| RuntimeEntityInput::decode(json!({
            "entityId": format!("0x{}", hex::encode(target.entity_id)),
            "signerId": target.signer_id, "entityTxs":[tx]
        })).expect("same-signer command")).collect();
        let tail_report = service
            .process_local_entity_inputs_at(mixed, 102)
            .expect("planning reject evicts one command, not the signer lane")
            .expect("honest tail is certified");
        assert_eq!(tail_report.entity_txs_selected, 1);
        // A service turn may admit only one queued Runtime envelope. Process
        // the remaining real work before asserting the queue is drained.
        for now in 103..107 {
            if service
                .processor
                .replica()
                .unwrap()
                .mempool
                .entity_input_count()
                == 0
            {
                break;
            }
            service
                .process_batch_at(None, now)
                .expect("queued honest successor progresses");
        }
        let after_tail = service.processor.replica().expect("healthy mixed queue");
        assert!(after_tail.state.height > before_tail);
        assert_eq!(after_tail.mempool.entity_input_count(), 0);
        assert!(after_tail.e_replicas[&target].entity_mempool.is_empty());
        service.shutdown().expect("shutdown real ingress");
        drop(service);
        std::fs::remove_dir_all(directory).expect("remove fixture WAL");
    }

    fn entity_input() -> RuntimeEntityInput {
        RuntimeEntityInput::decode(json!({
            "entityId": format!("0x{}", "11".repeat(32)),
            "signerId": format!("0x{}", "22".repeat(20)),
            "entityTxs": [],
        }))
        .expect("entity input")
    }

    fn inbound(count: usize, timestamp: Option<u64>) -> InboundEntityInputs {
        InboundEntityInputs {
            peer_runtime_id: "peer".into(),
            message_id: "message".into(),
            source_runtime_height: 1,
            source_runtime_timestamp: 1,
            ingress_timestamp: timestamp,
            entity_tx_count: 0,
            entity_inputs: (0..count).map(|_| entity_input()).collect(),
        }
    }

    #[test]
    fn ready_socket_batches_coalesce_as_one_whole_message_fifo_prefix() {
        let mut held = VecDeque::from([
            inbound(2, Some(100)),
            inbound(3, Some(120)),
            inbound(6, Some(110)),
        ]);
        let (inputs, queued_at) = coalesce_inbound_prefix(&mut held, 5);
        assert_eq!(inputs.len(), 5);
        assert_eq!(queued_at, Some(120));
        assert_eq!(held.len(), 1);
        assert_eq!(held.front().map(|batch| batch.entity_inputs.len()), Some(6));
    }

    #[test]
    fn live_frame_delay_is_one_start_to_start_remainder() {
        let started = Instant::now();
        assert_eq!(
            remaining_frame_delay(
                Duration::from_millis(100),
                Some(started),
                started + Duration::from_millis(75),
            ),
            Duration::from_millis(25),
        );
        assert_eq!(
            remaining_frame_delay(
                Duration::from_millis(100),
                Some(started),
                started + Duration::from_millis(125),
            ),
            Duration::ZERO,
        );
        assert_eq!(
            remaining_frame_delay(Duration::ZERO, Some(started), started),
            Duration::ZERO,
        );
        assert_eq!(
            remaining_frame_delay(Duration::from_millis(100), None, started),
            Duration::ZERO,
        );
    }

    #[test]
    fn timestamp_matches_typescript_clamp() {
        assert_eq!(resolve_live_timestamp(100, 150, 200).expect("clock"), 150);
        assert_eq!(resolve_live_timestamp(175, 150, 200).expect("clock"), 175);
        assert_eq!(
            resolve_live_timestamp(100, 50_000, 200).expect("clamped clock"),
            30_200
        );
        assert!(matches!(
            resolve_live_timestamp(30_201, 200, 200),
            Err(ResidentRuntimeServiceError::ClockAhead { .. })
        ));
    }

    #[test]
    fn custody_import_at_deployment_minus_one_is_not_a_missing_certified_cursor() {
        let mut state =
            xln_rscore_entity_kernel::EntityStateSlice::empty(format!("0x{}", "11".repeat(32)), 0);
        state.last_finalized_j_height = 2;
        assert!(unobserved_deployment_boundary(
            &json!({}),
            &state,
            Some(3),
            2
        ));
        assert!(committed_cursor_hash(&json!({}), &state, 2).is_err());
        assert!(!unobserved_deployment_boundary(
            &json!({}),
            &state,
            Some(4),
            2
        ));
        assert!(!unobserved_deployment_boundary(&json!({}), &state, None, 2));
        assert!(!unobserved_deployment_boundary(
            &json!({"jHistory":{}}),
            &state,
            Some(3),
            2
        ));
        state.j_history_finality = Some(
            crate::canonical_value_from_tagged_json(
                &json!({"tipBlockHash":format!("0x{}","ab".repeat(32))}),
            )
            .unwrap(),
        );
        assert!(!unobserved_deployment_boundary(
            &json!({}),
            &state,
            Some(3),
            2
        ));
        assert_eq!(
            committed_cursor_hash(&json!({}), &state, 2).unwrap(),
            Some([0xab; 32])
        );
    }
    #[test]
    fn recovery_uses_entity_anchor_when_shared_j_cursor_lags() {
        let hash = format!("0x{}", "3b".repeat(32));
        let metadata = json!({"jHistory": {
            "scannedThroughHeight": 29, "tipBlockHash": hash,
            "blockHashes": {"__xlnType":"Map", "value":[[29, hash]]}
        }});
        let state =
            xln_rscore_entity_kernel::EntityStateSlice::empty(format!("0x{}", "11".repeat(32)), 0);
        let height = committed_entity_j_height(&metadata, &state).unwrap();
        assert_eq!(height, 29);
        assert_eq!(
            committed_cursor_hash(&metadata, &state, height).unwrap(),
            Some([0x3b; 32])
        );
        // A shared cursor of 24 is not permission to invent an old hash.
        assert!(committed_cursor_hash(&metadata, &state, 24).is_err());
    }

    #[test]
    fn watcher_cursor_uses_its_chain_height_not_runtime_global_maximum() {
        let cursor = FinalizedWatcherCursor {
            scanned_through: 73,
            block_hash: Some([0x44; 32]),
        };
        assert_eq!(
            watcher_cursor_tx("0x1111".into(), 31338, &cursor),
            RuntimeTx::AdvanceJWatcherCursor {
                depository_address: "0x1111".into(),
                chain_id: 31338,
                block_number: 73,
            }
        );
    }

    fn watcher_poll(from: u64, through: u64) -> JWatcherPoll {
        JWatcherPoll {
            cursor: FinalizedWatcherCursor {
                scanned_through: through,
                block_hash: Some([u8::try_from(through).expect("small height"); 32]),
            },
            headers: (from..=through)
                .map(|height| FinalizedJHeader {
                    j_height: height,
                    j_block_hash: [u8::try_from(height).expect("small height"); 32],
                })
                .collect(),
            batches: Vec::new(),
        }
    }

    #[test]
    fn transient_j_scan_keeps_the_complete_suffix_until_liveness_or_semantic_work() {
        let base = FinalizedWatcherCursor::default();
        let first_poll = watcher_poll(1, 21);
        let first = extend_pending_j_scan(None, &base, &first_poll).expect("first suffix");
        assert_eq!(first.base_height, 0);
        assert_eq!(first.headers.len(), 21);
        assert!(first.scanned_through < JBLOCK_LIVENESS_INTERVAL);

        let second_cursor = first_poll.cursor.clone();
        let second_poll = watcher_poll(22, 24);
        let complete = extend_pending_j_scan(Some(first), &second_cursor, &second_poll)
            .expect("complete suffix");
        assert_eq!(complete.headers.len(), 24);
        assert_eq!(
            complete.headers.first().map(|header| header.j_height),
            Some(1)
        );
        assert_eq!(
            complete.headers.last().map(|header| header.j_height),
            Some(24)
        );
    }

    #[test]
    fn transient_j_scan_rejects_a_suffix_gap_instead_of_advancing() {
        let base = FinalizedWatcherCursor::default();
        let first_poll = watcher_poll(1, 21);
        let first = extend_pending_j_scan(None, &base, &first_poll).expect("first suffix");
        let gap = watcher_poll(23, 24);
        assert!(matches!(
            extend_pending_j_scan(Some(first), &first_poll.cursor, &gap),
            Err(ResidentRuntimeServiceError::JWatcher(reason))
                if reason == "PENDING_SCAN_HEADER_RANGE"
        ));
    }

    #[test]
    fn rust_live_j_poll_constants_match_typescript() {
        assert_eq!(JBLOCK_LIVENESS_INTERVAL, 100);
        assert_eq!(J_WATCHER_MAX_BLOCKS_PER_POLL, 256);
        assert!(!j_scan_liveness_due(99, 0));
        assert!(j_scan_liveness_due(100, 0));
        assert!(j_scan_liveness_due(101, 0));
        assert!(!j_scan_liveness_due(149, 50));
        assert!(j_scan_liveness_due(150, 50));
    }

    #[test]
    fn certified_cursor_waits_for_authenticated_transient_rescan_after_restart() {
        assert_eq!(certified_watcher_cursor_candidate(0, 120, 0), None);
        assert_eq!(certified_watcher_cursor_candidate(120, 120, 0), Some(120),);
        assert_eq!(certified_watcher_cursor_candidate(120, 120, 120), None);
    }

    #[test]
    fn semantic_j_blocks_precede_one_header_only_scan_tip_in_chain_order() {
        let batch = |height: u64| xln_rscore_entity_kernel::FinalizedJEventBatch {
            j_height: height,
            j_block_hash: [u8::try_from(height).expect("small height"); 32],
            events: Vec::new(),
            dispute_finalization_evidence: Vec::new(),
            reserve_updates: Vec::new(),
            account_claims: Vec::new(),
        };
        let observation = crate::j_watcher::ObserveJRange {
            entity_id: xln_rscore_engine::EntityId::parse(&format!("0x{}", "11".repeat(32)))
                .expect("entity id"),
            signer_id: format!("0x{}", "22".repeat(20)),
            jurisdiction_ref: format!("stack:31337:0x{}", "33".repeat(20)),
            scanned_through_height: 24,
            tip_block_hash: [24; 32],
            headers_present: true,
            headers: (1..=24)
                .map(|height| FinalizedJHeader {
                    j_height: height,
                    j_block_hash: [u8::try_from(height).expect("small height"); 32],
                })
                .collect(),
            batches: vec![batch(22), batch(24)],
        };
        let txs = ordered_j_observation_txs(&observation);
        let observed = txs
            .iter()
            .map(|tx| match tx {
                RuntimeTx::ObserveJRange(value) => (
                    value.scanned_through_height,
                    value.headers_present,
                    value.headers.len(),
                    value
                        .batches
                        .iter()
                        .map(|batch| batch.j_height)
                        .collect::<Vec<_>>(),
                ),
                _ => panic!("unexpected RuntimeTx"),
            })
            .collect::<Vec<_>>();
        assert_eq!(
            observed,
            vec![
                (22, false, 0, vec![22]),
                (24, false, 0, vec![24]),
                (24, true, 24, Vec::new()),
            ],
        );
    }
}

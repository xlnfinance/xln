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
    FinalizedWatcherCursor, HttpJsonRpc, JWatcherConfig, RuntimeTx, observation_from_poll,
    poll_finalized_j_events,
};
use ethabi::ethereum_types::U256;
use xln_rscore_batch::{AccountId, ResidentAccountStatusView};
use xln_rscore_engine::TokenId;

use super::{DurableRuntimeProcessor, DurableRuntimeProcessorError, RuntimeProcessReport};

const TIMESTAMP_DRIFT_MS: u64 = 30_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
/// One bounded collection window per Runtime frame. At the 10k-op/s target a
/// 2ms quiet-gap policy fragmented one economic burst into 10-60-row frames,
/// repeating projection/WAL/publication hundreds of times and starving the
/// shard workers. Ten milliseconds still bounds admission latency while
/// yielding roughly 100 independent Account inputs per steady target wave.
// Bound queue coalescing without delaying the dependent Account ACK/proposal
// chain. A measured 100 ms trial reduced w1 843.99 -> 786.84 pay/s and made
// w4 slower than w1 (770.03 pay/s): protocol feedback latency dominated any
// batching gain. Frame-size telemetry owns any future change to this value.
const INBOUND_COALESCE_WINDOW: Duration = Duration::from_millis(10);

/// Owns the authenticated socket queue, the one durable Runtime writer and
/// the Entity infrastructure materializer. Transport threads can only enqueue;
/// this object is the sole mutation path into R/E/A state.
pub struct ResidentRuntimeService {
    processor: DurableRuntimeProcessor,
    ingress: DirectRuntimeIngress,
    materializer: Box<dyn EntityInfraMaterializer>,
    finalized_j_height: u64,
    hub_rebalance_has_pending_work: bool,
    held_inbound: VecDeque<InboundEntityInputs>,
    pending_runtime_txs: VecDeque<RuntimeTx>,
    /// Socket completions can arrive between Runtime frames. Carry only their
    /// transient telemetry into the next frame report; publication ordering
    /// and retry ownership remain entirely inside `DirectOutboxPublisher`.
    deferred_publication: DeferredPublicationTelemetry,
    j_submit_operator_key: Option<[u8; 32]>,
    j_watchers: VecDeque<LiveJWatcher>,
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
}

impl ResidentRuntimeService {
    pub fn new(
        mut processor: DurableRuntimeProcessor,
        ingress: DirectRuntimeIngress,
        materializer: Box<dyn EntityInfraMaterializer>,
    ) -> Result<Self, ResidentRuntimeServiceError> {
        let replica = processor.replica()?;
        let durable_runtime_id = replica.durable.runtime_id();
        let finalized_j_height = replica.state.finalized_j_height;
        if ingress.runtime_id() != durable_runtime_id {
            return Err(ResidentRuntimeServiceError::RuntimeId {
                durable: durable_runtime_id.into(),
                ingress: ingress.runtime_id().into(),
            });
        }
        let j_watchers = live_j_watchers(replica)?;
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
        let service = Self {
            processor,
            ingress,
            materializer,
            finalized_j_height,
            hub_rebalance_has_pending_work: false,
            held_inbound: VecDeque::new(),
            pending_runtime_txs: VecDeque::new(),
            deferred_publication,
            j_submit_operator_key: None,
            j_watchers,
        };
        if !recover_pending_j_actions(service.processor.replica()?)?.is_empty() {
            return Err(ResidentRuntimeServiceError::JSubmit(
                "PENDING_ATTEMPT_WITHOUT_OPERATOR_KEY".into(),
            ));
        }
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
        Ok(service)
    }

    fn new_without_pending_guard(
        mut processor: DurableRuntimeProcessor,
        ingress: DirectRuntimeIngress,
        materializer: Box<dyn EntityInfraMaterializer>,
    ) -> Result<Self, ResidentRuntimeServiceError> {
        let replica = processor.replica()?;
        let durable_runtime_id = replica.durable.runtime_id();
        let finalized_j_height = replica.state.finalized_j_height;
        if ingress.runtime_id() != durable_runtime_id {
            return Err(ResidentRuntimeServiceError::RuntimeId {
                durable: durable_runtime_id.into(),
                ingress: ingress.runtime_id().into(),
            });
        }
        let j_watchers = live_j_watchers(replica)?;
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
            hub_rebalance_has_pending_work: false,
            held_inbound: VecDeque::new(),
            pending_runtime_txs: VecDeque::new(),
            deferred_publication,
            j_submit_operator_key: None,
            j_watchers,
        })
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

    pub fn set_hub_rebalance_pending(&mut self, pending: bool) {
        self.hub_rebalance_has_pending_work = pending;
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
        if let Some(report) = self.poll_and_commit_j_watcher()? {
            return Ok(Some(report));
        }
        let available = self.available_frame_inputs()?;
        self.take_inbound_if_idle(timeout, available)?;
        let (entity_inputs, queued_at) = self.take_frame_inbound()?;
        self.process_entity_inputs_at(entity_inputs, queued_at, wall_clock_ms()?)
    }

    fn poll_and_commit_j_watcher(
        &mut self,
    ) -> Result<Option<RuntimeProcessReport>, ResidentRuntimeServiceError> {
        let count = self.j_watchers.len();
        let mut selected = None;
        for _ in 0..count {
            let mut watcher = self.j_watchers.pop_front().expect("bounded watcher queue");
            if Instant::now() < watcher.next_poll {
                self.j_watchers.push_back(watcher);
                continue;
            }
            watcher.next_poll = Instant::now() + watcher.poll_interval;
            let poll = poll_finalized_j_events(&watcher.rpc, &watcher.config, &watcher.cursor)
                .map_err(|error| ResidentRuntimeServiceError::JWatcher(error.to_string()))?;
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
        let observation = observation_from_poll(
            watcher.config.entity_id.clone(),
            watcher.signer_id.clone(),
            watcher.jurisdiction_ref.clone(),
            poll,
        )
        .map_err(|error| ResidentRuntimeServiceError::JWatcher(error.to_string()))?;
        self.pending_runtime_txs
            .push_back(RuntimeTx::ObserveJRange(observation));
        self.pending_runtime_txs.push_back(watcher_cursor_tx(
            watcher.depository_text.clone(),
            watcher.config.chain_id,
            &next_cursor,
        ));
        self.finalized_j_height = self.finalized_j_height.max(next_cursor.scanned_through);
        let report = self
            .process_entity_inputs_at(Vec::new(), None, wall_clock_ms()?)?
            .ok_or_else(|| {
                ResidentRuntimeServiceError::JWatcher("RUNTIME_FRAME_NOT_PRODUCED".into())
            })?;
        self.sync_committed()?
            .ok_or_else(|| ResidentRuntimeServiceError::JWatcher("FSYNC_REPORT_MISSING".into()))?;
        watcher.cursor = next_cursor;
        self.j_watchers.push_back(watcher);
        Ok(Some(report))
    }

    fn take_inbound_if_idle(
        &mut self,
        timeout: Duration,
        available: usize,
    ) -> Result<(), ResidentRuntimeServiceError> {
        let first_arrived = if self.held_inbound.is_empty() {
            match self.recv_inbound_batch(timeout)? {
                Some(batch) => {
                    self.held_inbound.push_back(batch);
                    true
                }
                None => false,
            }
        } else {
            false
        };
        let deadline = first_arrived.then(|| Instant::now() + INBOUND_COALESCE_WINDOW);
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
            if !first_arrived || held_inputs >= available {
                break;
            }
            let remaining = deadline
                .expect("first-arrival deadline")
                .saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            // Hold the bounded window through transient gaps between reactor
            // groups. A quiet-gap policy ended the frame at the first 2ms
            // scheduling hole and paid another full WAL cycle immediately.
            let Some(batch) = self.recv_inbound_batch(remaining)? else {
                break;
            };
            held_inputs = held_inputs.saturating_add(batch.entity_inputs.len());
            self.held_inbound.push_back(batch);
        }
        Ok(())
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
            if let Some(batch) = self.accept_inbound_event(event) {
                return Ok(Some(batch));
            }
        }
    }

    fn try_recv_inbound_batch(
        &mut self,
    ) -> Result<Option<InboundEntityInputs>, ResidentRuntimeServiceError> {
        loop {
            let Some(event) = self.ingress.try_recv_event()? else {
                return Ok(None);
            };
            if let Some(batch) = self.accept_inbound_event(event) {
                return Ok(Some(batch));
            }
        }
    }

    fn accept_inbound_event(&mut self, event: InboundRuntimeEvent) -> Option<InboundEntityInputs> {
        match event {
            InboundRuntimeEvent::EntityInputs(batch) => Some(batch),
            InboundRuntimeEvent::GossipAnnouncement(gossip) => {
                for profile in gossip.profiles {
                    if let Err(error) = self
                        .processor
                        .admit_authenticated_profile(&gossip.peer_runtime_id, &profile)
                    {
                        self.ingress.note_profile_rejection(&error.to_string());
                    }
                }
                None
            }
        }
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
        let queued_at = batch.as_ref().and_then(|batch| batch.ingress_timestamp);
        let entity_inputs = batch.map(|batch| batch.entity_inputs).unwrap_or_default();
        self.process_entity_inputs_at(entity_inputs, queued_at, now)
    }

    /// Commit locally submitted Entity inputs through the same live
    /// reducer -> WAL fsync -> publication path as authenticated socket
    /// ingress. The process-local result remains transient; command ids are
    /// never copied into Runtime state or storage.
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
        let runtime_txs = self.pending_runtime_txs.drain(..).collect();
        self.materializer
            .set_paybook_reachability(self.processor.entity_routes(), self.ingress.sessions());
        let mut report = self.processor.process_live(
            RuntimeLiveInput {
                runtime_txs,
                entity_inputs,
                timestamp,
                finalized_j_height: self.finalized_j_height,
                hub_rebalance_has_pending_work: self.hub_rebalance_has_pending_work,
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
                    let operator_key = self.j_submit_operator_key.ok_or_else(|| {
                        ResidentRuntimeServiceError::JSubmit("OPERATOR_KEY_MISSING".into())
                    })?;
                    let result =
                        submit_committed_attempt(self.processor.replica()?, operator_key, &attempt);
                    println!(
                        "RSCORE_J_SUBMIT_RESULT:batch={}:attempt={}:outcome={:?}",
                        attempt.batch_hash, attempt.attempt_number, result.outcome
                    );
                    self.pending_runtime_txs
                        .push_back(RuntimeTx::RecordJSubmitResult(result));
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
        HttpJsonRpc::new(endpoint).map_err(|error| JSubmitError::Rpc(error.to_string()))?,
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
) -> JSubmitResultData {
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
    let submit = || -> Result<JSubmitOutcome, JSubmitError> {
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
        let rpc =
            HttpJsonRpc::new(endpoint).map_err(|error| JSubmitError::Rpc(error.to_string()))?;
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
        let (_, entity_replica) = replica
            .entity_slot(
                &attempt.sealed.entity_id,
                &format!("0x{}", hex::encode(attempt.sealed.signer_id)),
            )
            .ok_or(JSubmitError::Transaction("local-entity-slot"))?;
        let current_board = entity_replica
            .certified_board_registry
            .current_board_hash(&attempt.sealed.entity_id);
        let authority = |entity_id: &[u8; 32], board_hash: &[u8; 32], _claim_index: usize| {
            entity_id == &attempt.sealed.entity_id && current_board.as_ref() == Some(board_hash)
        };
        submitter.submit(
            &attempt.sealed,
            attempt.fee_overrides.as_ref(),
            Some(&operator_private_key),
            Some(&authority),
            &[],
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
    }
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
        let (_, entity_replica) = replica
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
        let rpc =
            HttpJsonRpc::new(endpoint).map_err(|error| JSubmitError::Rpc(error.to_string()))?;
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
        let current_board = entity_replica
            .certified_board_registry
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
        let (_, entity_replica) = replica
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
            entity_replica
                .certified_board_registry
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
) -> Result<VecDeque<LiveJWatcher>, ResidentRuntimeServiceError> {
    let mut candidates = Vec::new();
    for (entity_key, entity_replica) in &replica.e_replicas {
        let Some(entity_state) = replica.state.e_replicas.get(entity_key) else {
            return Err(ResidentRuntimeServiceError::JWatcher(
                "ENTITY_STATE_MISSING".into(),
            ));
        };
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
        let endpoint = j_replica
            .get("rpcs")
            .and_then(Value::as_array)
            .and_then(|rows| rows.iter().find_map(Value::as_str))
            .ok_or_else(|| ResidentRuntimeServiceError::JWatcher("RPC_MISSING".into()))?;
        let global_cursor_height = match crate::canonical_value_from_tagged_json(
            j_replica
                .get("blockNumber")
                .ok_or_else(|| ResidentRuntimeServiceError::JWatcher("CURSOR_MISSING".into()))?,
        )
        .map_err(|error| ResidentRuntimeServiceError::JWatcher(error.to_string()))?
        {
            xln_rscore_protocol::CanonicalValue::BigInt(value) => u64::try_from(value)
                .map_err(|_| ResidentRuntimeServiceError::JWatcher("CURSOR_INVALID".into()))?,
            _ => {
                return Err(ResidentRuntimeServiceError::JWatcher(
                    "CURSOR_INVALID".into(),
                ));
            }
        };
        let cursor_height =
            committed_entity_j_height(entity_replica.replica_metadata(), &entity_state.entity)?
                .min(global_cursor_height);
        let cursor_hash = committed_cursor_hash(
            entity_replica.replica_metadata(),
            &entity_state.entity,
            cursor_height,
        )?;
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
        let erc20_tokens = committed_erc20_tokens(j_replica)?;
        let external_wallets = watched_external_wallets(
            entity_state.entity.external_wallet.as_ref(),
            &erc20_tokens,
            &format!("0x{}", hex::encode(entity_key.entity_id)),
        )?;
        candidates.push(LiveJWatcher {
            rpc: HttpJsonRpc::new(endpoint)
                .map_err(|error| ResidentRuntimeServiceError::JWatcher(error.to_string()))?,
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
                max_blocks_per_poll: 128,
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
        });
    }
    Ok(candidates.into())
}

fn committed_erc20_tokens(
    j_replica: &serde_json::Map<String, Value>,
) -> Result<BTreeMap<[u8; 20], u64>, ResidentRuntimeServiceError> {
    let rows = j_replica
        .get("tokenRegistry")
        .and_then(Value::as_array)
        .ok_or_else(|| ResidentRuntimeServiceError::JWatcher("TOKEN_REGISTRY_MISSING".into()))?;
    let mut registry = BTreeMap::new();
    let mut ids = BTreeSet::new();
    for (index, value) in rows.iter().enumerate() {
        let row = value.as_object().ok_or_else(|| {
            ResidentRuntimeServiceError::JWatcher(format!("TOKEN_REGISTRY_ROW:{index}"))
        })?;
        let token_id = row
            .get("tokenId")
            .and_then(Value::as_u64)
            .filter(|id| *id > 0)
            .ok_or_else(|| {
                ResidentRuntimeServiceError::JWatcher(format!("TOKEN_REGISTRY_ID:{index}"))
            })?;
        if !ids.insert(token_id) {
            return Err(ResidentRuntimeServiceError::JWatcher(format!(
                "TOKEN_REGISTRY_ID_DUPLICATE:{token_id}"
            )));
        }
        let token_type = row
            .get("tokenType")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                ResidentRuntimeServiceError::JWatcher(format!("TOKEN_REGISTRY_TYPE:{index}"))
            })?;
        let address = row
            .get("address")
            .and_then(Value::as_str)
            .and_then(parse_address)
            .ok_or_else(|| {
                ResidentRuntimeServiceError::JWatcher(format!("TOKEN_REGISTRY_ADDRESS:{index}"))
            })?;
        if token_type == 0 && registry.insert(address, token_id).is_some() {
            return Err(ResidentRuntimeServiceError::JWatcher(format!(
                "TOKEN_REGISTRY_ADDRESS_DUPLICATE:{}",
                hex::encode(address)
            )));
        }
    }
    Ok(registry)
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
    #[error("{0}")]
    Processor(Box<DurableRuntimeProcessorError>),
    #[error(transparent)]
    Transport(#[from] RuntimeTransportError),
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
}

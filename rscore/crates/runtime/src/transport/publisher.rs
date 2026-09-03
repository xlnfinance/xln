use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use crate::storage::native::{DurableRuntimeFrame, NativeRuntimeStore};

use super::RuntimeTransportError;
use super::crypto::{EncryptionIdentity, derive_local_runtime_id, encryption_identity};
use super::inbound::{InboundSessionTable, OutboundCompletion, QueueOwnedResult};
use super::routing::{
    DirectRouteTable, OutboundEnvelope, PreparedEnvelopeBatch, normalize_entity_id,
    prepare_envelopes, prepare_envelopes_from_values,
};
use super::session::{DirectSession, SessionConfig};

const DEFAULT_MAX_QUEUE_ROWS: usize = 10_000;
const DEFAULT_MAX_QUEUE_BYTES: usize = 512 * 1024 * 1024;
const DEFAULT_MAX_ENVELOPE_ROWS: usize = 10_000;
const DEFAULT_MAX_PLAINTEXT_BYTES: usize = 256 * 1024 * 1024;
const DEFAULT_MAX_MESSAGE_BYTES: usize = 256 * 1024 * 1024;
const TARGET_RETRY_BACKOFF: Duration = Duration::from_millis(100);

fn profile_publication() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("XLN_RSCORE_PROFILE_PUBLICATION").as_deref() == Ok("1"))
}

#[derive(Clone, Debug)]
pub struct DirectOutboxPublisherConfig {
    pub source_seed: String,
    pub source_signer_id: String,
    pub routes: DirectRouteTable,
    pub local_entity_signers: BTreeMap<String, String>,
    pub max_queue_rows: usize,
    pub max_queue_bytes: usize,
    pub max_envelope_rows: usize,
    pub max_plaintext_bytes: usize,
    pub max_message_bytes: usize,
    pub reconnect_attempts: usize,
    pub io_timeout: Duration,
}

impl DirectOutboxPublisherConfig {
    pub fn production(
        source_seed: impl Into<String>,
        source_signer_id: impl Into<String>,
        routes: DirectRouteTable,
    ) -> Self {
        Self {
            source_seed: source_seed.into(),
            source_signer_id: source_signer_id.into(),
            routes,
            local_entity_signers: BTreeMap::new(),
            max_queue_rows: DEFAULT_MAX_QUEUE_ROWS,
            max_queue_bytes: DEFAULT_MAX_QUEUE_BYTES,
            max_envelope_rows: DEFAULT_MAX_ENVELOPE_ROWS,
            max_plaintext_bytes: DEFAULT_MAX_PLAINTEXT_BYTES,
            max_message_bytes: DEFAULT_MAX_MESSAGE_BYTES,
            reconnect_attempts: 2,
            io_timeout: Duration::from_secs(10),
        }
    }

    pub fn with_local_entity(
        mut self,
        entity_id: &str,
        signer_id: &str,
    ) -> Result<Self, RuntimeTransportError> {
        let entity_id = normalize_entity_id(entity_id)?;
        let signer_id = signer_id.trim().to_ascii_lowercase();
        if signer_id.is_empty() {
            return Err(RuntimeTransportError::Config("local-signer-id"));
        }
        if self
            .local_entity_signers
            .insert(entity_id.clone(), signer_id)
            .is_some()
        {
            return Err(RuntimeTransportError::Route(format!(
                "duplicate-local:{entity_id}"
            )));
        }
        Ok(self)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PublicationReport {
    pub durable_height: u64,
    pub rows_published: usize,
    pub envelopes_published: usize,
    pub durable_bytes: usize,
    pub reconnects: usize,
    pub targets_pending: usize,
    pub rows_pending: usize,
    pub bytes_pending: usize,
    pub failed_targets: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PublicationBacklog {
    pub targets: usize,
    pub rows: usize,
    pub bytes: usize,
    pub failures: BTreeMap<String, String>,
}

pub struct DirectOutboxPublisher {
    config: DirectOutboxPublisherConfig,
    source_runtime_id: String,
    identity: EncryptionIdentity,
    sessions: BTreeMap<String, DirectSession>,
    inbound: InboundSessionTable,
    pending: BTreeMap<String, VecDeque<OutboundEnvelope>>,
    /// At most one socket write per target is in flight. This preserves each
    /// target's canonical FIFO while allowing the single Runtime writer to
    /// start the next independent frame instead of waiting for every socket.
    /// Completion is transient transport state and is never persisted.
    in_flight: BTreeMap<String, InFlightEnvelope>,
    inbound_completion_tx: SyncSender<OutboundCompletion>,
    inbound_completion_rx: Receiver<OutboundCompletion>,
    target_order: VecDeque<String>,
    retry_after: BTreeMap<String, Instant>,
    last_errors: BTreeMap<String, String>,
    pending_rows: usize,
    pending_bytes: usize,
    last_staged_height: Option<u64>,
}

struct InFlightEnvelope {
    envelope: Arc<OutboundEnvelope>,
}

impl DirectOutboxPublisher {
    pub fn new(config: DirectOutboxPublisherConfig) -> Result<Self, RuntimeTransportError> {
        validate_config(&config)?;
        let (inbound_completion_tx, inbound_completion_rx) =
            sync_channel(config.max_queue_rows.max(1));
        let source_runtime_id =
            derive_local_runtime_id(&config.source_seed, &config.source_signer_id)?;
        let identity = encryption_identity(&config.source_seed);
        Ok(Self {
            config,
            source_runtime_id,
            identity,
            sessions: BTreeMap::new(),
            inbound: InboundSessionTable::default(),
            pending: BTreeMap::new(),
            in_flight: BTreeMap::new(),
            inbound_completion_tx,
            inbound_completion_rx,
            target_order: VecDeque::new(),
            retry_after: BTreeMap::new(),
            last_errors: BTreeMap::new(),
            pending_rows: 0,
            pending_bytes: 0,
            last_staged_height: None,
        })
    }

    /// Bind the Hub's authenticated inbound sessions. Route selection then
    /// prefers an open inbound session and only dials hub-to-hub peers that
    /// never connected to us.
    pub fn attach_inbound_sessions(&mut self, inbound: InboundSessionTable) {
        self.inbound = inbound;
    }

    /// Publish only rows proven durable by the exact token returned after
    /// LevelDB sync and directory fsync. A successful WebSocket write retires
    /// the envelope in memory; the transport has deliberately no positive ACK.
    pub fn publish_durable(
        &mut self,
        store: &mut NativeRuntimeStore,
        durable: &DurableRuntimeFrame,
    ) -> Result<PublicationReport, RuntimeTransportError> {
        let total_started = Instant::now();
        if self
            .last_staged_height
            .is_some_and(|height| durable.height() <= height)
        {
            let mut report = PublicationReport {
                durable_height: durable.height(),
                ..PublicationReport::default()
            };
            self.flush_pending(&mut report)?;
            return Ok(report);
        }
        let prepared = self.prepare_durable(store, durable)?;
        let prepare_done = total_started.elapsed();
        let row_count = prepared.row_count;
        let envelope_count = prepared.envelopes.len();
        let durable_bytes = prepared.bytes;
        self.ensure_queue_capacity(&prepared)?;
        let capacity_done = total_started.elapsed();
        let mut report = PublicationReport {
            durable_height: durable.height(),
            durable_bytes: prepared.bytes,
            ..PublicationReport::default()
        };
        self.stage(prepared)?;
        let stage_done = total_started.elapsed();
        self.last_staged_height = Some(durable.height());
        self.flush_pending(&mut report)?;
        if profile_publication() {
            let total = total_started.elapsed();
            eprintln!(
                "RSCORE_PUBLICATION_PHASE h={} prepare={} capacity={} stage={} flush={} total={} rows={} envelopes={} bytes={} inflight={} pendingTargets={} pendingRows={}",
                durable.height(),
                prepare_done.as_micros(),
                capacity_done.saturating_sub(prepare_done).as_micros(),
                stage_done.saturating_sub(capacity_done).as_micros(),
                total.saturating_sub(stage_done).as_micros(),
                total.as_micros(),
                row_count,
                envelope_count,
                durable_bytes,
                self.in_flight.len(),
                self.pending.len(),
                self.pending_rows,
            );
        }
        Ok(report)
    }

    /// Replay-only terminal for the production durable path. It re-reads the
    /// fsynced rows and performs the identical decode, local signer binding
    /// and queue budgeting, then deliberately performs no socket I/O.
    /// Reachability is transient and cannot invalidate committed outbox bytes.
    pub fn validate_durable(
        &mut self,
        store: &mut NativeRuntimeStore,
        durable: &DurableRuntimeFrame,
    ) -> Result<PublicationReport, RuntimeTransportError> {
        let prepared = self.prepare_durable(store, durable)?;
        Ok(PublicationReport {
            durable_height: durable.height(),
            rows_published: prepared.row_count,
            envelopes_published: prepared.envelopes.len(),
            durable_bytes: prepared.bytes,
            reconnects: 0,
            ..PublicationReport::default()
        })
    }

    fn prepare_durable(
        &mut self,
        store: &mut NativeRuntimeStore,
        durable: &DurableRuntimeFrame,
    ) -> Result<PreparedEnvelopeBatch, RuntimeTransportError> {
        let rows = store.publication_outputs(durable)?;
        let prepared = match durable.take_resident_output_values() {
            Some(values) => prepare_envelopes_from_values(
                &self.source_runtime_id,
                rows.as_ref(),
                values,
                &self.config.local_entity_signers,
                self.config.max_envelope_rows,
                self.config.max_plaintext_bytes,
            )?,
            None => prepare_envelopes(
                &self.source_runtime_id,
                rows.as_ref(),
                &self.config.local_entity_signers,
                self.config.max_envelope_rows,
                self.config.max_plaintext_bytes,
            )?,
        };
        Ok(prepared)
    }

    pub(crate) fn can_stage(
        &self,
        store: &mut NativeRuntimeStore,
        durable: &DurableRuntimeFrame,
    ) -> Result<bool, RuntimeTransportError> {
        let prepared = self.decode_durable(store, durable)?;
        Ok(
            self.pending_rows.saturating_add(prepared.row_count) <= self.config.max_queue_rows
                && self.pending_bytes.saturating_add(prepared.bytes) <= self.config.max_queue_bytes,
        )
    }

    fn decode_durable(
        &self,
        store: &mut NativeRuntimeStore,
        durable: &DurableRuntimeFrame,
    ) -> Result<PreparedEnvelopeBatch, RuntimeTransportError> {
        let rows = store.publication_outputs(durable)?;
        let prepared = prepare_envelopes(
            &self.source_runtime_id,
            rows.as_ref(),
            &self.config.local_entity_signers,
            self.config.max_envelope_rows,
            self.config.max_plaintext_bytes,
        )?;
        if prepared.row_count > self.config.max_queue_rows
            || prepared.bytes > self.config.max_queue_bytes
        {
            return Err(RuntimeTransportError::Queue {
                rows: prepared.row_count,
                bytes: prepared.bytes,
            });
        }
        Ok(prepared)
    }

    fn ensure_queue_capacity(
        &self,
        prepared: &PreparedEnvelopeBatch,
    ) -> Result<(), RuntimeTransportError> {
        let rows = self
            .pending_rows
            .checked_add(prepared.row_count)
            .ok_or(RuntimeTransportError::Config("queue-row-overflow"))?;
        let bytes = self
            .pending_bytes
            .checked_add(prepared.bytes)
            .ok_or(RuntimeTransportError::Config("queue-byte-overflow"))?;
        if rows > self.config.max_queue_rows || bytes > self.config.max_queue_bytes {
            return Err(RuntimeTransportError::Queue { rows, bytes });
        }
        Ok(())
    }

    fn stage(&mut self, prepared: PreparedEnvelopeBatch) -> Result<(), RuntimeTransportError> {
        for envelope in prepared.envelopes {
            let target = envelope.target_runtime_id.clone();
            if !self.pending.contains_key(&target) {
                self.pending.insert(target.clone(), VecDeque::new());
                self.target_order.push_back(target.clone());
            }
            self.pending_rows = self
                .pending_rows
                .checked_add(envelope.row_count)
                .ok_or(RuntimeTransportError::Config("queue-row-overflow"))?;
            self.pending_bytes = self
                .pending_bytes
                .checked_add(envelope.durable_bytes)
                .ok_or(RuntimeTransportError::Config("queue-byte-overflow"))?;
            self.pending
                .get_mut(&target)
                .ok_or(RuntimeTransportError::Config("target-queue-missing"))?
                .push_back(envelope);
        }
        Ok(())
    }

    pub(crate) fn retry_pending(&mut self) -> Result<PublicationReport, RuntimeTransportError> {
        let mut report = PublicationReport {
            durable_height: self.last_staged_height.unwrap_or(0),
            ..PublicationReport::default()
        };
        self.flush_pending(&mut report)?;
        Ok(report)
    }

    fn flush_pending(
        &mut self,
        report: &mut PublicationReport,
    ) -> Result<(), RuntimeTransportError> {
        self.collect_inbound_completions(report)?;
        let mut blocked = BTreeSet::new();
        loop {
            let targets = self.target_order.len();
            let mut batch = Vec::with_capacity(targets);
            for _ in 0..targets {
                let target = self
                    .target_order
                    .pop_front()
                    .ok_or(RuntimeTransportError::Config("target-order-missing"))?;
                let retry_ready = !blocked.contains(&target)
                    && !self.in_flight.contains_key(&target)
                    && (self.inbound.has_open(&target)?
                        || self
                            .retry_after
                            .get(&target)
                            .is_none_or(|deadline| *deadline <= Instant::now()));
                let envelope = retry_ready
                    .then(|| self.pending.get_mut(&target).and_then(VecDeque::pop_front))
                    .flatten();
                if let Some(envelope) = envelope {
                    batch.push((target, envelope));
                } else {
                    self.finish_target(target);
                }
            }
            if batch.is_empty() {
                break;
            }
            for (target, envelope) in batch {
                let (envelope, result) = match self
                    .inbound
                    .queue_owned_if_open(envelope, &self.inbound_completion_tx)
                {
                    QueueOwnedResult::Queued { envelope } => {
                        if self
                            .in_flight
                            .insert(target, InFlightEnvelope { envelope })
                            .is_some()
                        {
                            return Err(RuntimeTransportError::Config(
                                "target-in-flight-duplicate",
                            ));
                        }
                        continue;
                    }
                    QueueOwnedResult::Missing(envelope) => {
                        let result = self.publish_direct_one(&envelope);
                        (envelope, result)
                    }
                    QueueOwnedResult::Rejected { envelope, error } => (envelope, Err(error)),
                };
                match result {
                    Ok(reconnects) => {
                        self.finish_published(report, &target, &envelope, reconnects)?
                    }
                    Err(error) => {
                        self.retain_failed(&target, envelope, &error)?;
                        blocked.insert(target.clone());
                    }
                }
                self.finish_target(target);
            }
        }
        report.targets_pending = self.pending.len();
        report.rows_pending = self.pending_rows;
        report.bytes_pending = self.pending_bytes;
        report.failed_targets = self.last_errors.keys().cloned().collect();
        Ok(())
    }

    fn collect_inbound_completions(
        &mut self,
        report: &mut PublicationReport,
    ) -> Result<(), RuntimeTransportError> {
        while let Ok(completion) = self.inbound_completion_rx.try_recv() {
            let target = completion.envelope.target_runtime_id.clone();
            let in_flight = self
                .in_flight
                .remove(&target)
                .ok_or(RuntimeTransportError::Config("target-in-flight-missing"))?;
            drop(completion.envelope);
            match completion.result {
                Ok(()) => self.finish_published(report, &target, &in_flight.envelope, 0)?,
                Err(error) => self.retain_failed(
                    &target,
                    Arc::try_unwrap(in_flight.envelope)
                        .expect("reactor drops envelope before reporting completion"),
                    &error,
                )?,
            }
            self.finish_target(target);
        }
        Ok(())
    }

    fn finish_published(
        &mut self,
        report: &mut PublicationReport,
        target: &str,
        envelope: &OutboundEnvelope,
        reconnects: usize,
    ) -> Result<(), RuntimeTransportError> {
        report.reconnects = report
            .reconnects
            .checked_add(reconnects)
            .ok_or(RuntimeTransportError::Config("report-reconnect-overflow"))?;
        report.rows_published = report
            .rows_published
            .checked_add(envelope.row_count)
            .ok_or(RuntimeTransportError::Config("report-row-overflow"))?;
        report.envelopes_published = report
            .envelopes_published
            .checked_add(1)
            .ok_or(RuntimeTransportError::Config("report-envelope-overflow"))?;
        self.pending_rows -= envelope.row_count;
        self.pending_bytes -= envelope.durable_bytes;
        self.retry_after.remove(target);
        self.last_errors.remove(target);
        Ok(())
    }

    fn retain_failed(
        &mut self,
        target: &str,
        envelope: OutboundEnvelope,
        error: &RuntimeTransportError,
    ) -> Result<(), RuntimeTransportError> {
        self.pending
            .get_mut(target)
            .ok_or(RuntimeTransportError::Config("target-queue-lost"))?
            .push_front(envelope);
        self.last_errors.insert(target.into(), error.to_string());
        self.retry_after
            .insert(target.into(), Instant::now() + TARGET_RETRY_BACKOFF);
        Ok(())
    }

    fn finish_target(&mut self, target: String) {
        if self
            .pending
            .get(&target)
            .is_some_and(|queue| queue.is_empty())
            && !self.in_flight.contains_key(&target)
        {
            self.pending.remove(&target);
            self.retry_after.remove(&target);
            self.last_errors.remove(&target);
        } else {
            self.target_order.push_back(target);
        }
    }

    pub fn close(mut self) {
        for (_, session) in std::mem::take(&mut self.sessions) {
            session.close();
        }
    }

    pub fn backlog(&self) -> PublicationBacklog {
        PublicationBacklog {
            targets: self.pending.len(),
            rows: self.pending_rows,
            bytes: self.pending_bytes,
            failures: self.last_errors.clone(),
        }
    }

    fn publish_direct_one(
        &mut self,
        envelope: &OutboundEnvelope,
    ) -> Result<usize, RuntimeTransportError> {
        let mut reconnects = 0;
        let mut last_error = String::new();
        for attempt in 0..=self.config.reconnect_attempts {
            if !self.sessions.contains_key(&envelope.target_runtime_id) {
                if attempt > 0 {
                    reconnects += 1;
                }
                match self.connect(&envelope.target_runtime_id) {
                    Ok(session) => {
                        self.sessions
                            .insert(envelope.target_runtime_id.clone(), session);
                    }
                    Err(error) => {
                        last_error = error.to_string();
                        continue;
                    }
                }
            }
            let result = self
                .sessions
                .get_mut(&envelope.target_runtime_id)
                .ok_or_else(|| RuntimeTransportError::Route("session-missing".into()))?
                .send_envelope(envelope);
            match result {
                Ok(()) => return Ok(reconnects),
                Err(error) => {
                    last_error = error.to_string();
                    if let Some(session) = self.sessions.remove(&envelope.target_runtime_id) {
                        session.close();
                    }
                }
            }
        }
        Err(RuntimeTransportError::ReconnectExhausted {
            target: envelope.target_runtime_id.clone(),
            attempts: self.config.reconnect_attempts + 1,
            last: last_error,
        })
    }

    fn connect(&self, target: &str) -> Result<DirectSession, RuntimeTransportError> {
        DirectSession::connect(SessionConfig {
            url: self.config.routes.url(target)?,
            target_runtime_id: target,
            source_runtime_id: &self.source_runtime_id,
            source_seed: &self.config.source_seed,
            source_signer_id: &self.config.source_signer_id,
            identity: &self.identity,
            io_timeout: self.config.io_timeout,
            max_message_bytes: self.config.max_message_bytes,
        })
    }
}

fn validate_config(config: &DirectOutboxPublisherConfig) -> Result<(), RuntimeTransportError> {
    if config.source_signer_id.trim().is_empty() {
        return Err(RuntimeTransportError::Config("signer-id"));
    }
    if config.max_queue_rows == 0
        || config.max_queue_bytes == 0
        || config.max_envelope_rows == 0
        || config.max_plaintext_bytes == 0
        || config.max_message_bytes == 0
        || config.io_timeout.is_zero()
    {
        return Err(RuntimeTransportError::Config("limits"));
    }
    if config.max_envelope_rows > config.max_queue_rows
        || config.max_plaintext_bytes > config.max_message_bytes
    {
        return Err(RuntimeTransportError::Config("limit-order"));
    }
    Ok(())
}

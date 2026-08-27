use std::collections::BTreeMap;
use std::time::Duration;

use crate::storage::native::{DurableRuntimeFrame, NativeRuntimeStore};

use super::RuntimeTransportError;
use super::crypto::{EncryptionIdentity, derive_local_runtime_id, encryption_identity};
use super::routing::{
    DirectRouteTable, OutboundEnvelope, PreparedEnvelopeBatch, normalize_entity_id,
    prepare_envelopes,
};
use super::session::{DirectSession, SessionConfig};

const DEFAULT_MAX_QUEUE_ROWS: usize = 10_000;
const DEFAULT_MAX_QUEUE_BYTES: usize = 64 * 1024 * 1024;
const DEFAULT_MAX_ENVELOPE_ROWS: usize = 10_000;
const DEFAULT_MAX_PLAINTEXT_BYTES: usize = 24 * 1024 * 1024;
const DEFAULT_MAX_MESSAGE_BYTES: usize = 32 * 1024 * 1024;

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
}

pub struct DirectOutboxPublisher {
    config: DirectOutboxPublisherConfig,
    source_runtime_id: String,
    identity: EncryptionIdentity,
    sessions: BTreeMap<String, DirectSession>,
    pending: Option<PendingPublication>,
    last_published_height: Option<u64>,
}

struct PendingPublication {
    height: u64,
    durable_bytes: usize,
    envelopes: Vec<OutboundEnvelope>,
    next_envelope: usize,
}

impl DirectOutboxPublisher {
    pub fn new(config: DirectOutboxPublisherConfig) -> Result<Self, RuntimeTransportError> {
        validate_config(&config)?;
        let source_runtime_id =
            derive_local_runtime_id(&config.source_seed, &config.source_signer_id)?;
        let identity = encryption_identity(&config.source_seed);
        Ok(Self {
            config,
            source_runtime_id,
            identity,
            sessions: BTreeMap::new(),
            pending: None,
            last_published_height: None,
        })
    }

    /// Publish only rows proven durable by the exact token returned after
    /// LevelDB sync and directory fsync. A successful WebSocket write retires
    /// the envelope in memory; the transport has deliberately no positive ACK.
    pub fn publish_durable(
        &mut self,
        store: &mut NativeRuntimeStore,
        durable: &DurableRuntimeFrame,
    ) -> Result<PublicationReport, RuntimeTransportError> {
        let prepared = self.prepare_durable(store, durable)?;
        if self
            .last_published_height
            .is_some_and(|height| durable.height() <= height)
        {
            return Ok(PublicationReport {
                durable_height: durable.height(),
                ..PublicationReport::default()
            });
        }
        if let Some(pending) = &self.pending
            && pending.height != durable.height()
        {
            return Err(RuntimeTransportError::PendingFrame {
                pending: pending.height,
                requested: durable.height(),
            });
        }
        if self.pending.is_none() {
            self.pending = Some(PendingPublication {
                height: durable.height(),
                durable_bytes: prepared.bytes,
                envelopes: prepared.envelopes,
                next_envelope: 0,
            });
        }
        self.resume_pending()
    }

    /// Replay-only terminal for the production durable path. It re-reads the
    /// fsynced rows, performs the identical decode, local/remote binding,
    /// queue budgeting and route validation, then deliberately performs no
    /// socket I/O. No delivery receipt or durable marker is created.
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
        })
    }

    fn prepare_durable(
        &mut self,
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
        for envelope in &prepared.envelopes {
            self.config.routes.url(&envelope.target_runtime_id)?;
        }
        Ok(prepared)
    }

    fn resume_pending(&mut self) -> Result<PublicationReport, RuntimeTransportError> {
        let pending = self
            .pending
            .as_ref()
            .ok_or(RuntimeTransportError::Config("pending-missing"))?;
        let mut report = PublicationReport {
            durable_height: pending.height,
            durable_bytes: pending.durable_bytes,
            ..PublicationReport::default()
        };
        loop {
            let envelope = self
                .pending
                .as_ref()
                .and_then(|pending| pending.envelopes.get(pending.next_envelope))
                .cloned();
            let Some(envelope) = envelope else { break };
            report.reconnects += self.publish_one(&envelope)?;
            report.rows_published = report
                .rows_published
                .checked_add(envelope.row_count)
                .ok_or(RuntimeTransportError::Config("report-row-overflow"))?;
            report.envelopes_published += 1;
            self.pending
                .as_mut()
                .ok_or(RuntimeTransportError::Config("pending-lost"))?
                .next_envelope += 1;
        }
        self.last_published_height = Some(report.durable_height);
        self.pending = None;
        Ok(report)
    }

    pub fn close(mut self) {
        for (_, session) in std::mem::take(&mut self.sessions) {
            session.close();
        }
    }

    fn publish_one(&mut self, envelope: &OutboundEnvelope) -> Result<usize, RuntimeTransportError> {
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

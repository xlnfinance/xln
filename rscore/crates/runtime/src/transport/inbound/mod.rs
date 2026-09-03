//! Canonical authenticated direct-Runtime WebSocket ingress.
//!
//! A session may enqueue only fully authenticated and strictly decoded
//! `RuntimeEntityInput` rows.  The receiver belongs to the single durable
//! Runtime writer; transport threads never mutate Runtime state and never send
//! a delivery receipt.

pub(in crate::transport) mod envelope;
mod frame;
mod gossip;
mod listener;
mod reactor;
mod reply;
mod session;

use std::collections::{BTreeMap, BTreeSet};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{
    Receiver, RecvTimeoutError, SyncSender, TryRecvError, TrySendError, sync_channel,
};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub use envelope::InboundEntityInputs;
pub use reply::InboundSessionTable;
pub(crate) use reply::{OutboundCompletion, QueueOwnedResult};

#[derive(Debug)]
pub(crate) struct InboundGossipAnnouncement {
    pub peer_runtime_id: String,
    pub profiles: Vec<serde_json::Value>,
}

#[derive(Debug)]
pub(crate) enum InboundRuntimeEvent {
    EntityInputs(InboundEntityInputs),
    GossipAnnouncement(InboundGossipAnnouncement),
}

use super::RuntimeTransportError;
use super::crypto::{EncryptionIdentity, encryption_identity};

const DEFAULT_MAX_MESSAGE_BYTES: usize = 256 * 1024 * 1024;

pub struct DirectRuntimeIngressConfig {
    pub bind_address: SocketAddr,
    pub path: String,
    pub io_timeout: Duration,
    pub hello_skew: Duration,
    pub max_message_bytes: usize,
    pub queue_capacity: usize,
    runtime_seed: String,
    runtime_signer_label: String,
}

impl DirectRuntimeIngressConfig {
    pub fn production(
        bind_address: SocketAddr,
        runtime_seed: impl Into<String>,
        runtime_signer_label: impl Into<String>,
    ) -> Self {
        Self {
            bind_address,
            path: "/ws".into(),
            io_timeout: Duration::from_secs(30),
            hello_skew: Duration::from_secs(30),
            max_message_bytes: DEFAULT_MAX_MESSAGE_BYTES,
            queue_capacity: 4_096,
            runtime_seed: runtime_seed.into(),
            runtime_signer_label: runtime_signer_label.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DirectRuntimeIngressMetrics {
    pub accepted_connections: u64,
    pub authenticated_sessions: u64,
    pub rejected_sessions: u64,
    pub accepted_batches: u64,
    pub accepted_entity_inputs: u64,
    pub pending_batches: u64,
    pub pending_batches_high_water: u64,
    pub backpressure_events: u64,
    pub backpressure_wait_micros: u64,
    pub backpressure_wait_max_micros: u64,
    pub queue_rejections: u64,
    pub open_sessions: u64,
}

#[derive(Default)]
struct IngressCounters {
    accepted_connections: AtomicU64,
    authenticated_sessions: AtomicU64,
    rejected_sessions: AtomicU64,
    accepted_batches: AtomicU64,
    accepted_entity_inputs: AtomicU64,
    pending_batches: AtomicU64,
    pending_batches_high_water: AtomicU64,
    backpressure_events: AtomicU64,
    backpressure_wait_micros: AtomicU64,
    backpressure_wait_max_micros: AtomicU64,
    queue_rejections: AtomicU64,
}

struct ValidatedIngressConfig {
    path: String,
    io_timeout: Duration,
    hello_skew: Duration,
    max_message_bytes: usize,
    runtime_signer_key: [u8; 32],
    runtime_id: String,
    encryption_identity: EncryptionIdentity,
}

pub(super) struct SharedIngress {
    config: ValidatedIngressConfig,
    sender: SyncSender<InboundRuntimeEvent>,
    stop: AtomicBool,
    active_peers: Mutex<BTreeSet<String>>,
    sockets: Mutex<BTreeMap<u64, TcpStream>>,
    replies: InboundSessionTable,
    last_error: Mutex<Option<String>>,
    fatal_error: Mutex<Option<String>>,
    counters: IngressCounters,
}

pub struct DirectRuntimeIngress {
    local_address: SocketAddr,
    runtime_id: String,
    receiver: Receiver<InboundRuntimeEvent>,
    shared: Arc<SharedIngress>,
    listener: Option<JoinHandle<()>>,
}

impl DirectRuntimeIngress {
    pub fn bind(config: DirectRuntimeIngressConfig) -> Result<Self, RuntimeTransportError> {
        validate_config(&config)?;
        let listener = TcpListener::bind(config.bind_address)
            .map_err(|error| RuntimeTransportError::WebSocket(error.to_string()))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| RuntimeTransportError::WebSocket(error.to_string()))?;
        let local_address = listener
            .local_addr()
            .map_err(|error| RuntimeTransportError::WebSocket(error.to_string()))?;
        let runtime_signer_key = xln_rscore_crypto::derive_signer_key(
            &config.runtime_seed,
            &config.runtime_signer_label,
        )
        .map_err(|_| RuntimeTransportError::Crypto("signer-key"))?;
        let runtime_address = xln_rscore_crypto::address_of_private_key(&runtime_signer_key)
            .ok_or(RuntimeTransportError::Crypto("runtime-id"))?;
        let runtime_id = format!("0x{}", super::crypto::hex_lower(&runtime_address));
        let (sender, receiver) = sync_channel(config.queue_capacity);
        let shared = Arc::new(SharedIngress {
            config: ValidatedIngressConfig {
                path: config.path,
                io_timeout: config.io_timeout,
                hello_skew: config.hello_skew,
                max_message_bytes: config.max_message_bytes,
                encryption_identity: encryption_identity(&config.runtime_seed),
                runtime_signer_key,
                runtime_id: runtime_id.clone(),
            },
            sender,
            stop: AtomicBool::new(false),
            active_peers: Mutex::new(BTreeSet::new()),
            sockets: Mutex::new(BTreeMap::new()),
            replies: InboundSessionTable::default(),
            last_error: Mutex::new(None),
            fatal_error: Mutex::new(None),
            counters: IngressCounters::default(),
        });
        let listener_shared = Arc::clone(&shared);
        let listener_thread = thread::Builder::new()
            .name("rrs-direct-ingress".into())
            .spawn(move || listener::run(listener, listener_shared))
            .map_err(|error| RuntimeTransportError::WebSocket(error.to_string()))?;
        Ok(Self {
            local_address,
            runtime_id,
            receiver,
            shared,
            listener: Some(listener_thread),
        })
    }

    pub fn local_address(&self) -> SocketAddr {
        self.local_address
    }

    pub fn runtime_id(&self) -> &str {
        &self.runtime_id
    }

    pub fn encryption_public_key(&self) -> String {
        super::crypto::static_public_hex(&self.shared.config.encryption_identity)
    }

    pub fn sessions(&self) -> InboundSessionTable {
        self.shared.replies.clone()
    }

    pub fn has_open_session(&self, runtime_id: &str) -> Result<bool, RuntimeTransportError> {
        self.shared.replies.has_open(runtime_id)
    }

    pub fn open_runtime_ids(&self) -> Result<Vec<String>, RuntimeTransportError> {
        self.shared.replies.runtime_ids()
    }

    pub(crate) fn recv_event_timeout(
        &self,
        timeout: Duration,
    ) -> Result<Option<InboundRuntimeEvent>, RuntimeTransportError> {
        self.check_fatal()?;
        match self.receiver.recv_timeout(timeout) {
            Ok(value) => {
                self.shared
                    .counters
                    .pending_batches
                    .fetch_sub(1, Ordering::Relaxed);
                Ok(Some(value))
            }
            Err(RecvTimeoutError::Timeout) => {
                self.check_fatal()?;
                Ok(None)
            }
            Err(RecvTimeoutError::Disconnected) => Err(RuntimeTransportError::Inbound(
                "writer-channel-disconnected".into(),
            )),
        }
    }

    /// Drain one already-authenticated batch without waiting. The live
    /// single-writer uses this to coalesce the bounded channel FIFO into one
    /// Runtime frame instead of paying one WAL fsync per socket message.
    pub(crate) fn try_recv_event(
        &self,
    ) -> Result<Option<InboundRuntimeEvent>, RuntimeTransportError> {
        self.check_fatal()?;
        match self.receiver.try_recv() {
            Ok(value) => {
                self.shared
                    .counters
                    .pending_batches
                    .fetch_sub(1, Ordering::Relaxed);
                Ok(Some(value))
            }
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => Err(RuntimeTransportError::Inbound(
                "writer-channel-disconnected".into(),
            )),
        }
    }

    #[cfg(test)]
    pub fn recv_timeout(
        &self,
        timeout: Duration,
    ) -> Result<Option<InboundEntityInputs>, RuntimeTransportError> {
        match self.recv_event_timeout(timeout)? {
            Some(InboundRuntimeEvent::EntityInputs(batch)) => Ok(Some(batch)),
            Some(InboundRuntimeEvent::GossipAnnouncement(_)) => Err(
                RuntimeTransportError::Inbound("unexpected-gossip-in-test-receiver".into()),
            ),
            None => Ok(None),
        }
    }

    pub fn metrics(&self) -> DirectRuntimeIngressMetrics {
        let counters = &self.shared.counters;
        DirectRuntimeIngressMetrics {
            accepted_connections: counters.accepted_connections.load(Ordering::Relaxed),
            authenticated_sessions: counters.authenticated_sessions.load(Ordering::Relaxed),
            rejected_sessions: counters.rejected_sessions.load(Ordering::Relaxed),
            accepted_batches: counters.accepted_batches.load(Ordering::Relaxed),
            accepted_entity_inputs: counters.accepted_entity_inputs.load(Ordering::Relaxed),
            pending_batches: counters.pending_batches.load(Ordering::Relaxed),
            pending_batches_high_water: counters.pending_batches_high_water.load(Ordering::Relaxed),
            backpressure_events: counters.backpressure_events.load(Ordering::Relaxed),
            backpressure_wait_micros: counters.backpressure_wait_micros.load(Ordering::Relaxed),
            backpressure_wait_max_micros: counters
                .backpressure_wait_max_micros
                .load(Ordering::Relaxed),
            queue_rejections: counters.queue_rejections.load(Ordering::Relaxed),
            open_sessions: self.shared.replies.len().unwrap_or(0),
        }
    }

    pub fn last_session_error(&self) -> Option<String> {
        self.shared
            .last_error
            .lock()
            .ok()
            .and_then(|value| value.clone())
    }

    pub(crate) fn note_profile_rejection(&self, error: &str) {
        eprintln!("RRS_DIRECT_PROFILE_REJECTED:{error}");
        if let Ok(mut slot) = self.shared.last_error.lock() {
            *slot = Some(error.to_string());
        }
    }

    pub fn shutdown(&mut self) -> Result<(), RuntimeTransportError> {
        self.shared.stop.store(true, Ordering::Release);
        listener::close_registered_sockets(&self.shared);
        if let Some(listener) = self.listener.take() {
            listener
                .join()
                .map_err(|_| RuntimeTransportError::Inbound("listener-panicked".into()))?;
        }
        self.check_fatal()
    }

    fn check_fatal(&self) -> Result<(), RuntimeTransportError> {
        let error = self
            .shared
            .fatal_error
            .lock()
            .map_err(|_| RuntimeTransportError::Inbound("fatal-lock".into()))?
            .clone();
        match error {
            Some(error) => Err(RuntimeTransportError::Inbound(error)),
            None => Ok(()),
        }
    }
}

impl Drop for DirectRuntimeIngress {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

fn validate_config(config: &DirectRuntimeIngressConfig) -> Result<(), RuntimeTransportError> {
    if config.runtime_seed.is_empty() {
        return Err(RuntimeTransportError::Config("ingress-runtime-seed"));
    }
    if config.runtime_signer_label.trim().is_empty() {
        return Err(RuntimeTransportError::Config("ingress-signer-label"));
    }
    if !config.path.starts_with('/') || config.path.contains('?') || config.path.contains('#') {
        return Err(RuntimeTransportError::Config("ingress-path"));
    }
    if config.io_timeout.is_zero() || config.hello_skew.is_zero() {
        return Err(RuntimeTransportError::Config("ingress-timeout"));
    }
    if config.max_message_bytes < 1_024 || config.queue_capacity == 0 {
        return Err(RuntimeTransportError::Config("ingress-bounds"));
    }
    Ok(())
}

fn enqueue_batch(
    shared: &SharedIngress,
    mut batch: InboundEntityInputs,
) -> Result<(), RuntimeTransportError> {
    let input_count = u64::try_from(batch.entity_inputs.len())
        .map_err(|_| RuntimeTransportError::Inbound("input-count".into()))?;
    let pending = shared
        .counters
        .pending_batches
        .fetch_add(1, Ordering::Relaxed)
        .saturating_add(1);
    shared
        .counters
        .pending_batches_high_water
        .fetch_max(pending, Ordering::Relaxed);
    let mut blocked_at: Option<Instant> = None;
    loop {
        match shared
            .sender
            .try_send(InboundRuntimeEvent::EntityInputs(batch))
        {
            Ok(()) => {
                if let Some(blocked_at) = blocked_at {
                    let waited =
                        u64::try_from(blocked_at.elapsed().as_micros()).unwrap_or(u64::MAX);
                    shared
                        .counters
                        .backpressure_wait_micros
                        .fetch_add(waited, Ordering::Relaxed);
                    shared
                        .counters
                        .backpressure_wait_max_micros
                        .fetch_max(waited, Ordering::Relaxed);
                }
                shared
                    .counters
                    .accepted_batches
                    .fetch_add(1, Ordering::Relaxed);
                shared
                    .counters
                    .accepted_entity_inputs
                    .fetch_add(input_count, Ordering::Relaxed);
                return Ok(());
            }
            Err(TrySendError::Full(InboundRuntimeEvent::EntityInputs(returned))) => {
                if blocked_at.is_none() {
                    blocked_at = Some(Instant::now());
                    shared
                        .counters
                        .backpressure_events
                        .fetch_add(1, Ordering::Relaxed);
                }
                if shared.stop.load(Ordering::Acquire) {
                    shared
                        .counters
                        .pending_batches
                        .fetch_sub(1, Ordering::Relaxed);
                    return Err(RuntimeTransportError::Inbound("writer-stopped".into()));
                }
                batch = returned;
                thread::sleep(Duration::from_micros(100));
            }
            Err(TrySendError::Full(InboundRuntimeEvent::GossipAnnouncement(_))) => {
                unreachable!("batch enqueue returns its own event")
            }
            Err(TrySendError::Disconnected(_)) => {
                shared
                    .counters
                    .pending_batches
                    .fetch_sub(1, Ordering::Relaxed);
                shared
                    .counters
                    .queue_rejections
                    .fetch_add(1, Ordering::Relaxed);
                return Err(RuntimeTransportError::Inbound(
                    "writer-channel-disconnected".into(),
                ));
            }
        }
    }
}

fn enqueue_gossip(
    shared: &SharedIngress,
    mut gossip: InboundGossipAnnouncement,
) -> Result<(), RuntimeTransportError> {
    let pending = shared
        .counters
        .pending_batches
        .fetch_add(1, Ordering::Relaxed)
        .saturating_add(1);
    shared
        .counters
        .pending_batches_high_water
        .fetch_max(pending, Ordering::Relaxed);
    loop {
        match shared
            .sender
            .try_send(InboundRuntimeEvent::GossipAnnouncement(gossip))
        {
            Ok(()) => return Ok(()),
            Err(TrySendError::Full(InboundRuntimeEvent::GossipAnnouncement(returned))) => {
                if shared.stop.load(Ordering::Acquire) {
                    shared
                        .counters
                        .pending_batches
                        .fetch_sub(1, Ordering::Relaxed);
                    return Err(RuntimeTransportError::Inbound("writer-stopped".into()));
                }
                gossip = returned;
                thread::sleep(Duration::from_micros(100));
            }
            Err(TrySendError::Full(InboundRuntimeEvent::EntityInputs(_))) => {
                unreachable!("gossip enqueue returns its own event")
            }
            Err(TrySendError::Disconnected(_)) => {
                shared
                    .counters
                    .pending_batches
                    .fetch_sub(1, Ordering::Relaxed);
                return Err(RuntimeTransportError::Inbound(
                    "writer-channel-disconnected".into(),
                ));
            }
        }
    }
}

fn session_failed(shared: &SharedIngress, error: &RuntimeTransportError) {
    eprintln!("RRS_DIRECT_SESSION_FAILED:{error}");
    shared
        .counters
        .rejected_sessions
        .fetch_add(1, Ordering::Relaxed);
    if let Ok(mut slot) = shared.last_error.lock() {
        *slot = Some(error.to_string());
    }
}

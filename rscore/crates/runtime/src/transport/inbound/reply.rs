//! Retained authenticated inbound sessions used for Hub → user reply.
//!
//! A sovereign user dials the Hub. After handshake this table is the canonical
//! route for that `target_runtime_id`. Selection is exclusive: an open inbound
//! session never falls through to an outbound TCP dial.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TryRecvError, TrySendError};
use std::sync::{Mutex, OnceLock, Weak};

use mio::Waker;

use super::super::RuntimeTransportError;
use super::super::routing::{OutboundEnvelope, normalize_runtime_id};
use super::{SharedIngress, reactor::ReactorIngress};

pub(crate) struct OutboundWork {
    pub envelope: Arc<OutboundEnvelope>,
    pub done: SyncSender<OutboundCompletion>,
}

pub(crate) struct OutboundCompletion {
    pub envelope: Arc<OutboundEnvelope>,
    pub result: Result<(), RuntimeTransportError>,
}

pub(crate) enum QueueOwnedResult {
    Missing(OutboundEnvelope),
    Deferred(OutboundEnvelope),
    Rejected {
        envelope: OutboundEnvelope,
        error: RuntimeTransportError,
    },
    Queued {
        envelope: Arc<OutboundEnvelope>,
    },
}

struct InboundReplyHandle {
    work: SyncSender<OutboundWork>,
    waker: Arc<Waker>,
    ready: Arc<AtomicBool>,
}

#[derive(Clone, Default)]
pub struct InboundSessionTable {
    inner: Arc<Mutex<BTreeMap<String, InboundReplyHandle>>>,
    owner: Arc<OnceLock<SessionOwner>>,
}

struct SessionOwner {
    shared: Weak<SharedIngress>,
    reactors: Vec<ReactorIngress>,
}

pub(crate) struct ReplyGuard {
    peer: String,
    table: InboundSessionTable,
}

/// The existing one-slot reply queue and its route have one lifetime, including
/// the short handoff before mio registration. Failed adoption must return every
/// queued WAL envelope to the publisher instead of leaving it in flight forever.
pub(super) struct SessionReplies {
    receiver: Receiver<OutboundWork>,
    guard: Option<ReplyGuard>,
}

impl SessionReplies {
    pub fn new(receiver: Receiver<OutboundWork>, guard: ReplyGuard) -> Self {
        Self {
            receiver,
            guard: Some(guard),
        }
    }
    pub fn try_recv(&self) -> Result<OutboundWork, TryRecvError> {
        self.receiver.try_recv()
    }
}

impl Drop for SessionReplies {
    fn drop(&mut self) {
        // Remove the route first: no concurrent publisher may append a work
        // item after the remaining queue is drained.
        drop(self.guard.take());
        while let Ok(work) = self.receiver.try_recv() {
            let _ = work.done.send(OutboundCompletion {
                envelope: work.envelope,
                result: Err(RuntimeTransportError::Inbound(
                    "session-closed-before-write".into(),
                )),
            });
        }
    }
}

impl InboundSessionTable {
    /// Public signed rows cross this boundary only after their Runtime WAL fsync.
    /// The cache is transport RAM; reconnect resends, never a durable authority.
    pub fn publish_profiles(
        &self,
        profiles: Vec<serde_json::Value>,
    ) -> Result<(), RuntimeTransportError> {
        if profiles.is_empty() {
            return Ok(());
        }
        let owner = self.owner.get().ok_or(RuntimeTransportError::Config(
            "direct-ingress-owner-missing",
        ))?;
        let shared = owner
            .shared
            .upgrade()
            .ok_or(RuntimeTransportError::Config("direct-ingress-owner-closed"))?;
        let mut rows = BTreeMap::new();
        for profile in profiles {
            let id = profile["entityId"]
                .as_str()
                .ok_or(RuntimeTransportError::Config("profile-entity-id"))?
                .to_owned();
            if profile["runtimeId"].as_str() != Some(&shared.config.runtime_id)
                || rows.insert(id, profile).is_some()
            {
                return Err(RuntimeTransportError::Config("profile-owner-or-duplicate"));
            }
        }
        let mut cache = shared
            .profiles
            .lock()
            .map_err(|_| RuntimeTransportError::Config("profile-cache-poisoned"))?;
        let changed = rows
            .into_iter()
            .filter(|(id, value)| cache.rows.get(id).is_none_or(|(_, old)| old != value))
            .collect::<Vec<_>>();
        if changed.is_empty() {
            return Ok(());
        }
        cache.revision = cache
            .revision
            .checked_add(1)
            .ok_or(RuntimeTransportError::Config("profile-revision-overflow"))?;
        let revision = cache.revision;
        for (id, value) in changed {
            cache.rows.insert(id, (revision, value));
        }
        drop(cache);
        self.wake_all()
    }

    pub(super) fn bind_owner(
        &self,
        shared: &Arc<SharedIngress>,
        reactors: Vec<ReactorIngress>,
    ) -> Result<(), RuntimeTransportError> {
        if reactors.is_empty() {
            return Err(RuntimeTransportError::Config("ingress-reactors-empty"));
        }
        self.owner
            .set(SessionOwner {
                shared: Arc::downgrade(shared),
                reactors,
            })
            .map_err(|_| RuntimeTransportError::Config("ingress-owner-already-bound"))
    }

    pub(in crate::transport) fn adopt_outgoing(
        &self,
        session: super::super::session::DirectSession,
    ) -> Result<(), RuntimeTransportError> {
        let owner = self.owner.get().ok_or(RuntimeTransportError::Config(
            "direct-ingress-owner-missing",
        ))?;
        let shared = owner
            .shared
            .upgrade()
            .ok_or(RuntimeTransportError::Config("direct-ingress-owner-closed"))?;
        if shared.stop.load(Ordering::Acquire) {
            return Err(RuntimeTransportError::Config(
                "direct-ingress-owner-stopped",
            ));
        }
        let session = super::session::accept_outgoing(session, &shared)?;
        let index = match usize::try_from(session.serial) {
            Ok(serial) => serial % owner.reactors.len(),
            Err(_) => {
                super::listener::remove_socket(&shared, session.serial);
                return Err(RuntimeTransportError::Config("session-token"));
            }
        };
        owner.reactors[index].submit(session, &shared)
    }

    pub(in crate::transport) fn set_delivery_ready(
        &self,
        ready: bool,
    ) -> Result<(), RuntimeTransportError> {
        let owner = self.owner.get().ok_or(RuntimeTransportError::Config(
            "direct-ingress-owner-missing",
        ))?;
        let shared = owner
            .shared
            .upgrade()
            .ok_or(RuntimeTransportError::Config("direct-ingress-owner-closed"))?;
        if shared.local_ready.swap(ready, Ordering::AcqRel) != ready {
            self.wake_all()?;
        }
        Ok(())
    }
    pub fn has_open(&self, runtime_id: &str) -> Result<bool, RuntimeTransportError> {
        let Ok(runtime_id) = normalize_runtime_id(runtime_id) else {
            return Ok(false);
        };
        Ok(self.lock()?.contains_key(&runtime_id))
    }

    pub fn can_deliver(&self, runtime_id: &str) -> Result<bool, RuntimeTransportError> {
        let Ok(runtime_id) = normalize_runtime_id(runtime_id) else {
            return Ok(false);
        };
        Ok(self
            .lock()?
            .get(&runtime_id)
            .is_some_and(|handle| handle.ready.load(Ordering::Acquire)))
    }

    pub fn len(&self) -> Result<u64, RuntimeTransportError> {
        u64::try_from(self.lock()?.len())
            .map_err(|_| RuntimeTransportError::Inbound("open-sessions".into()))
    }

    pub fn is_empty(&self) -> Result<bool, RuntimeTransportError> {
        Ok(self.lock()?.is_empty())
    }

    /// Authenticated live peers for native health. This is a transient socket
    /// projection, never Runtime state or durable routing authority.
    pub fn runtime_ids(&self) -> Result<Vec<String>, RuntimeTransportError> {
        Ok(self.lock()?.keys().cloned().collect())
    }

    pub(in crate::transport) fn register(
        &self,
        peer: &str,
        work: SyncSender<OutboundWork>,
        waker: Arc<Waker>,
        ready: Arc<AtomicBool>,
    ) -> Result<ReplyGuard, RuntimeTransportError> {
        let mut sessions = self.lock()?;
        if sessions.contains_key(peer) {
            return Err(RuntimeTransportError::Handshake(format!(
                "duplicate-runtime:{peer}"
            )));
        }
        sessions.insert(peer.into(), InboundReplyHandle { work, waker, ready });
        Ok(ReplyGuard {
            peer: peer.into(),
            table: self.clone(),
        })
    }

    pub(in crate::transport) fn queue_owned_if_open(
        &self,
        envelope: OutboundEnvelope,
        completions: &SyncSender<OutboundCompletion>,
    ) -> QueueOwnedResult {
        let sessions = match self.lock() {
            Ok(sessions) => sessions,
            Err(error) => return QueueOwnedResult::Rejected { envelope, error },
        };
        let Some(handle) = sessions.get(&envelope.target_runtime_id) else {
            return QueueOwnedResult::Missing(envelope);
        };
        if !handle.ready.load(Ordering::Acquire) {
            return QueueOwnedResult::Deferred(envelope);
        }
        let envelope = Arc::new(envelope);
        match handle.work.try_send(OutboundWork {
            envelope: Arc::clone(&envelope),
            done: completions.clone(),
        }) {
            Ok(()) => {}
            Err(TrySendError::Full(work)) => {
                drop(work);
                return QueueOwnedResult::Rejected {
                    envelope: Arc::try_unwrap(envelope)
                        .expect("queue rejection retains sole envelope owner"),
                    error: RuntimeTransportError::Inbound("session-backpressure".into()),
                };
            }
            Err(TrySendError::Disconnected(work)) => {
                drop(work);
                return QueueOwnedResult::Rejected {
                    envelope: Arc::try_unwrap(envelope)
                        .expect("closed queue retains sole envelope owner"),
                    error: RuntimeTransportError::Inbound("session-closed".into()),
                };
            }
        }
        // The reactor also polls on a bounded idle interval. If wake reports a
        // closed poller, channel disconnect is observed by the retained Arc.
        let _ = handle.waker.wake();
        QueueOwnedResult::Queued { envelope }
    }

    pub(super) fn wake_all(&self) -> Result<(), RuntimeTransportError> {
        for handle in self.lock()?.values() {
            handle
                .waker
                .wake()
                .map_err(|error| RuntimeTransportError::WebSocket(error.to_string()))?;
        }
        Ok(())
    }

    fn lock(
        &self,
    ) -> Result<
        std::sync::MutexGuard<'_, BTreeMap<String, InboundReplyHandle>>,
        RuntimeTransportError,
    > {
        self.inner
            .lock()
            .map_err(|_| RuntimeTransportError::Inbound("session-lock".into()))
    }
}

impl Drop for ReplyGuard {
    fn drop(&mut self) {
        if let Ok(mut sessions) = self.table.inner.lock() {
            sessions.remove(&self.peer);
        }
    }
}

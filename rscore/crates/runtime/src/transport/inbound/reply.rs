//! Retained authenticated inbound sessions used for Hub → user reply.
//!
//! A sovereign user dials the Hub. After handshake this table is the canonical
//! route for that `target_runtime_id`. Selection is exclusive: an open inbound
//! session never falls through to an outbound TCP dial.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc::{SyncSender, TrySendError};

use mio::Waker;

use super::super::RuntimeTransportError;
use super::super::routing::{OutboundEnvelope, normalize_runtime_id};

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
}

#[derive(Clone, Default)]
pub struct InboundSessionTable {
    inner: Arc<Mutex<BTreeMap<String, InboundReplyHandle>>>,
}

pub(crate) struct ReplyGuard {
    peer: String,
    table: InboundSessionTable,
}

impl InboundSessionTable {
    pub fn has_open(&self, runtime_id: &str) -> Result<bool, RuntimeTransportError> {
        let Ok(runtime_id) = normalize_runtime_id(runtime_id) else {
            return Ok(false);
        };
        Ok(self.lock()?.contains_key(&runtime_id))
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
    ) -> Result<ReplyGuard, RuntimeTransportError> {
        let mut sessions = self.lock()?;
        if sessions
            .insert(peer.into(), InboundReplyHandle { work, waker })
            .is_some()
        {
            return Err(RuntimeTransportError::Handshake(format!(
                "duplicate-runtime:{peer}"
            )));
        }
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

//! Retained authenticated inbound sessions used for Hub → user reply.
//!
//! A sovereign user dials the Hub. After handshake this table is the canonical
//! route for that `target_runtime_id`. Selection is exclusive: an open inbound
//! session never falls through to an outbound TCP dial.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc::{RecvTimeoutError, SyncSender, TrySendError, sync_channel};
use std::time::Duration;

use mio::Waker;

use super::super::RuntimeTransportError;
use super::super::routing::{OutboundEnvelope, normalize_runtime_id};

pub(crate) struct OutboundWork {
    pub envelope: OutboundEnvelope,
    pub done: SyncSender<Result<(), RuntimeTransportError>>,
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

    /// Send on an authenticated inbound session when one exists.
    ///
    /// Returns `Ok(false)` only when this peer never dialed us, so the caller
    /// may use DirectOutboxPublisher. Any failure after a session was selected
    /// is loud and must not fall through to a second dial.
    pub(in crate::transport) fn publish_if_open(
        &self,
        envelope: &OutboundEnvelope,
        timeout: Duration,
    ) -> Result<bool, RuntimeTransportError> {
        let Some(done_rx) = self.queue_if_open(envelope)? else {
            return Ok(false);
        };
        match done_rx.recv_timeout(timeout) {
            Ok(Ok(())) => Ok(true),
            Ok(Err(error)) => Err(error),
            Err(RecvTimeoutError::Timeout) => {
                Err(RuntimeTransportError::Inbound("session-io-timeout".into()))
            }
            Err(RecvTimeoutError::Disconnected) => {
                Err(RuntimeTransportError::Inbound("session-closed".into()))
            }
        }
    }

    fn queue_if_open(
        &self,
        envelope: &OutboundEnvelope,
    ) -> Result<
        Option<std::sync::mpsc::Receiver<Result<(), RuntimeTransportError>>>,
        RuntimeTransportError,
    > {
        let sessions = self.lock()?;
        let Some(handle) = sessions.get(&envelope.target_runtime_id) else {
            return Ok(None);
        };
        let (done_tx, done_rx) = sync_channel(1);
        match handle.work.try_send(OutboundWork {
            envelope: envelope.clone(),
            done: done_tx,
        }) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                return Err(RuntimeTransportError::Inbound(
                    "session-backpressure".into(),
                ));
            }
            Err(TrySendError::Disconnected(_)) => {
                return Err(RuntimeTransportError::Inbound("session-closed".into()));
            }
        }
        handle
            .waker
            .wake()
            .map_err(|error| RuntimeTransportError::WebSocket(error.to_string()))?;
        Ok(Some(done_rx))
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use mio::{Poll, Token, Waker};
    use serde_json::json;

    use super::*;

    #[test]
    fn publish_if_open_times_out_without_a_delivery_receipt() {
        let table = InboundSessionTable::default();
        let poll = Poll::new().expect("poll");
        let waker = Arc::new(Waker::new(poll.registry(), Token(0)).expect("waker"));
        let (work_tx, _work_rx) = sync_channel(1);
        let peer = format!("0x{}", "11".repeat(20));
        let _guard = table.register(&peer, work_tx, waker).expect("register");
        let envelope = OutboundEnvelope {
            target_runtime_id: peer.clone(),
            source_height: 1,
            source_timestamp: 1,
            entity_id: None,
            transaction_count: 0,
            value: json!({}),
            row_count: 1,
        };
        let started = Instant::now();
        let error = table
            .publish_if_open(&envelope, Duration::from_millis(50))
            .expect_err("bounded timeout");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(error.to_string().contains("session-io-timeout"));
        assert!(table.has_open(&peer).expect("session remains open"));
    }
}

//! Fixed-size authenticated socket reactors.
//!
//! Handshakes are bounded separately; once authenticated, many sovereign
//! Runtime sockets share one `mio` poller. No financial ordering or delivery
//! acknowledgement is added: every decoded envelope still enters the single
//! Runtime writer queue and every reply completes only after the socket write.

use std::collections::{BTreeMap, VecDeque};
use std::os::fd::AsRawFd;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TryRecvError, sync_channel};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use mio::unix::SourceFd;
use mio::{Events, Interest, Poll, Token, Waker};

use super::super::RuntimeTransportError;
use super::super::crypto::static_public_hex;
use super::super::entity_inputs_frame::{
    ReadinessFrameContext, SessionCounters, SessionFrameContext, decode_delivery_ready,
    send_delivery_ready, send_entity_inputs, send_profiles, take_profile_batch,
};
use super::super::wire::{Socket, tcp_stream, try_read_value};
use super::frame::FrameState;
use super::reply::{OutboundCompletion, OutboundWork, SessionReplies};
use super::session::{AcceptedHello, AcceptedSession, PeerGuard, SessionSide};
use super::{SharedIngress, enqueue_batch, enqueue_gossip, session_failed};

const WAKE_TOKEN: Token = Token(0);
const ACCEPTED_SESSION_QUEUE: usize = 2_048;
const POLL_IDLE: Duration = Duration::from_millis(100);

#[derive(Clone)]
pub(super) struct ReactorIngress {
    sender: SyncSender<QueuedSession>,
    waker: Arc<Waker>,
}

struct QueuedSession {
    session: AcceptedSession,
    work: SessionReplies,
    peer_ready: Arc<AtomicBool>,
}

impl ReactorIngress {
    pub fn submit(
        &self,
        session: AcceptedSession,
        shared: &Arc<SharedIngress>,
    ) -> Result<(), RuntimeTransportError> {
        let serial = session.serial;
        let peer_ready = Arc::new(AtomicBool::new(session.peer_ready));
        let (work_tx, work) = sync_channel(1);
        let reply = match shared.replies.register(
            &session.accepted.peer_runtime_id,
            work_tx,
            Arc::clone(&self.waker),
            Arc::clone(&peer_ready),
        ) {
            Ok(reply) => reply,
            Err(error) => {
                super::listener::remove_socket(shared, serial);
                return Err(error);
            }
        };
        let outgoing = matches!(session.side, SessionSide::Client);
        let queued = QueuedSession {
            session,
            work: SessionReplies::new(work, reply),
            peer_ready,
        };
        // The committer may be waiting for fsync while the sole writer is not
        // draining ingress. Never make outgoing registration wait on a reactor
        // stalled by that same bounded channel; the durable outbox will retry.
        let sent = if outgoing {
            self.sender.try_send(queued).map_err(|error| {
                RuntimeTransportError::Inbound(format!("reactor-admission:{error}"))
            })
        } else {
            self.sender
                .send(queued)
                .map_err(|_| RuntimeTransportError::Inbound("reactor-closed".into()))
        };
        if let Err(error) = sent {
            super::listener::remove_socket(shared, serial);
            return Err(error);
        }
        self.waker
            .wake()
            .map_err(|error| RuntimeTransportError::WebSocket(error.to_string()))
    }

    pub fn wake(&self) {
        let _ = self.waker.wake();
    }
}

pub(super) struct ReactorHandle {
    pub ingress: ReactorIngress,
    join: JoinHandle<()>,
}

impl ReactorHandle {
    pub fn spawn(index: usize, shared: Arc<SharedIngress>) -> Result<Self, RuntimeTransportError> {
        let poll =
            Poll::new().map_err(|error| RuntimeTransportError::WebSocket(error.to_string()))?;
        let waker = Arc::new(
            Waker::new(poll.registry(), WAKE_TOKEN)
                .map_err(|error| RuntimeTransportError::WebSocket(error.to_string()))?,
        );
        let (sender, receiver) = sync_channel(ACCEPTED_SESSION_QUEUE);
        let ingress = ReactorIngress {
            sender,
            waker: Arc::clone(&waker),
        };
        let join = thread::Builder::new()
            .name(format!("rrs-direct-reactor-{index}"))
            .spawn(move || run(poll, receiver, shared))
            .map_err(|error| RuntimeTransportError::Inbound(format!("reactor-spawn:{error}")))?;
        Ok(Self { ingress, join })
    }

    pub fn join(self) -> Result<(), RuntimeTransportError> {
        self.join
            .join()
            .map_err(|_| RuntimeTransportError::Inbound("reactor-panicked".into()))
    }
}

struct LiveSession {
    serial: u64,
    socket: Socket,
    accepted: AcceptedHello,
    keys: super::super::crypto::SessionKeys,
    side: SessionSide,
    audience: String,
    challenge: String,
    outbound: SessionCounters,
    inbound: FrameState,
    work: SessionReplies,
    pending_write: Option<OutboundWork>,
    pending_control: bool,
    announced_ready: Option<bool>,
    announced_profiles: u64,
    pending_profiles: VecDeque<serde_json::Value>,
    peer_ready: Arc<AtomicBool>,
    encryption_public_hex: String,
    _peer: PeerGuard,
}

impl LiveSession {
    fn fail_queued_outbound(&mut self, reason: &str) {
        if let Some(work) = self.pending_write.take() {
            let _ = work.done.send(OutboundCompletion {
                envelope: work.envelope,
                result: Err(RuntimeTransportError::Inbound(reason.into())),
            });
        }
        while let Ok(work) = self.work.try_recv() {
            let _ = work.done.send(OutboundCompletion {
                envelope: work.envelope,
                result: Err(RuntimeTransportError::Inbound(reason.into())),
            });
        }
    }

    fn read(&mut self, shared: &SharedIngress) -> Result<(), RuntimeTransportError> {
        while let Some(message) = try_read_value(&mut self.socket)? {
            match message.get("type").and_then(serde_json::Value::as_str) {
                Some("entity_inputs") => {
                    let batch = super::frame::decode(
                        message,
                        &self.accepted,
                        self.side.incoming_key(&self.keys),
                        &self.audience,
                        &self.challenge,
                        &shared.config.runtime_id,
                        &mut self.inbound,
                    )?;
                    if !shared.local_ready.load(Ordering::Acquire) {
                        return Err(RuntimeTransportError::Inbound(
                            "DIRECT_RECIPIENT_NOT_READY".into(),
                        ));
                    }
                    enqueue_batch(shared, batch)?;
                }
                Some("delivery_ready") => {
                    let ready = decode_delivery_ready(
                        message,
                        &mut ReadinessFrameContext {
                            key: self.side.incoming_key(&self.keys),
                            from: &self.accepted.peer_runtime_id,
                            to: &shared.config.runtime_id,
                            encryption_public_hex: &self.accepted.peer_static_public_hex,
                            audience: &self.audience,
                            challenge: &self.challenge,
                            auth_timestamp: &mut self.inbound.auth_timestamp,
                        },
                    )?;
                    self.peer_ready.store(ready, Ordering::Release);
                }
                Some("gossip_announce") => {
                    let gossip = super::gossip::decode(
                        message,
                        &self.accepted,
                        self.side.incoming_key(&self.keys),
                        &self.audience,
                        &self.challenge,
                        &shared.config.runtime_id,
                        &mut self.inbound,
                    )?;
                    enqueue_gossip(shared, gossip)?;
                }
                Some(kind) => {
                    return Err(RuntimeTransportError::Inbound(format!(
                        "unsupported-direct-message:{kind}"
                    )));
                }
                None => return Err(RuntimeTransportError::Inbound("message-type".into())),
            }
        }
        Ok(())
    }

    fn write(&mut self, shared: &SharedIngress) -> Result<bool, RuntimeTransportError> {
        if self.pending_write.is_some() || self.pending_control {
            return Ok(true);
        }
        let ready = shared.local_ready.load(Ordering::Acquire);
        if self.announced_ready != Some(ready) {
            let result = send_delivery_ready(
                &mut self.socket,
                ready,
                &mut SessionFrameContext {
                    key: self.side.outgoing_key(&self.keys),
                    from: &shared.config.runtime_id,
                    to: &self.accepted.peer_runtime_id,
                    encryption_public_hex: &self.encryption_public_hex,
                    audience: &self.audience,
                    challenge: &self.challenge,
                    counters: &mut self.outbound,
                },
                shared.config.max_message_bytes,
            );
            self.announced_ready = Some(ready);
            if let Err(error) = result {
                if !is_would_block(&error) {
                    return Err(error);
                }
                self.pending_control = true;
                return Ok(true);
            }
        }
        // Hold across dequeue/send: post-fsync publication takes this same lock
        // before enqueueing financial work, preventing old-profile/new-data races.
        let cache = shared
            .profiles
            .lock()
            .map_err(|_| RuntimeTransportError::Config("profile-cache-poisoned"))?;
        if self.pending_profiles.is_empty() && cache.revision != self.announced_profiles {
            self.pending_profiles.extend(
                cache
                    .rows
                    .values()
                    .filter(|(revision, _)| *revision > self.announced_profiles)
                    .map(|(_, value)| value.clone()),
            );
            self.announced_profiles = cache.revision;
        }
        if !self.pending_profiles.is_empty() {
            let mut frame = SessionFrameContext {
                key: self.side.outgoing_key(&self.keys),
                from: &shared.config.runtime_id,
                to: &self.accepted.peer_runtime_id,
                encryption_public_hex: &self.encryption_public_hex,
                audience: &self.audience,
                challenge: &self.challenge,
                counters: &mut self.outbound,
            };
            let profiles = take_profile_batch(
                &mut self.pending_profiles,
                &frame,
                shared.config.max_message_bytes,
            )?;
            let result = send_profiles(
                &mut self.socket,
                profiles,
                &mut frame,
                shared.config.max_message_bytes,
            );
            if let Err(error) = result {
                if !is_would_block(&error) {
                    return Err(error);
                }
                self.pending_control = true;
                return Ok(true);
            }
            // Recheck the latest committed revision on the next writer turn,
            // including updates that arrived while older chunks were pending.
            return Ok(true);
        }
        // Read controls before taking the existing one-slot work queue. False
        // retains unsent work; an already buffered frame finishes exactly once.
        if !self.peer_ready.load(Ordering::Acquire) {
            return Ok(false);
        }
        loop {
            match self.work.try_recv() {
                Ok(work) => {
                    let result = send_entity_inputs(
                        &mut self.socket,
                        &work.envelope,
                        &mut SessionFrameContext {
                            key: self.side.outgoing_key(&self.keys),
                            from: &shared.config.runtime_id,
                            to: &self.accepted.peer_runtime_id,
                            encryption_public_hex: &self.encryption_public_hex,
                            audience: &self.audience,
                            challenge: &self.challenge,
                            counters: &mut self.outbound,
                        },
                        shared.config.max_message_bytes,
                    );
                    match result {
                        Ok(()) => {
                            let _ = work.done.send(OutboundCompletion {
                                envelope: work.envelope,
                                result: Ok(()),
                            });
                        }
                        Err(error) if is_would_block(&error) => {
                            // tungstenite has queued the frame internally; a
                            // writable event completes its flush without
                            // blocking every other sovereign session.
                            self.pending_write = Some(work);
                            return Ok(true);
                        }
                        Err(error) => {
                            let completion_error =
                                RuntimeTransportError::Inbound(error.to_string());
                            let _ = work.done.send(OutboundCompletion {
                                envelope: work.envelope,
                                result: Err(completion_error),
                            });
                            return Err(error);
                        }
                    }
                }
                Err(TryRecvError::Empty) => return Ok(false),
                Err(TryRecvError::Disconnected) => {
                    return Err(RuntimeTransportError::Inbound("session-closed".into()));
                }
            }
        }
    }

    fn flush_pending(&mut self) -> Result<bool, RuntimeTransportError> {
        if self.pending_write.is_none() && !self.pending_control {
            return Ok(false);
        }
        match self.socket.flush() {
            Ok(()) => {
                self.pending_control = false;
                if let Some(work) = self.pending_write.take() {
                    let _ = work.done.send(OutboundCompletion {
                        envelope: work.envelope,
                        result: Ok(()),
                    });
                }
                Ok(false)
            }
            Err(tungstenite::Error::Io(error))
                if error.kind() == std::io::ErrorKind::WouldBlock =>
            {
                Ok(true)
            }
            Err(error) => {
                let runtime_error = RuntimeTransportError::WebSocket(error.to_string());
                if let Some(work) = self.pending_write.take() {
                    let _ = work.done.send(OutboundCompletion {
                        envelope: work.envelope,
                        result: Err(RuntimeTransportError::Inbound(runtime_error.to_string())),
                    });
                }
                Err(runtime_error)
            }
        }
    }
}

impl Drop for LiveSession {
    fn drop(&mut self) {
        self.fail_queued_outbound("session-reactor-dropped");
    }
}

fn run(mut poll: Poll, accepted: Receiver<QueuedSession>, shared: Arc<SharedIngress>) {
    let mut events = Events::with_capacity(1_024);
    let mut sessions = BTreeMap::<Token, LiveSession>::new();
    while !shared.stop.load(Ordering::Acquire) {
        if let Err(error) = poll.poll(&mut events, Some(POLL_IDLE)) {
            set_fatal(&shared, &format!("reactor-poll:{error}"));
            break;
        }
        drain_accepted(&mut poll, &accepted, &shared, &mut sessions);
        let wake = events.iter().any(|event| event.token() == WAKE_TOKEN);
        let io_events = events
            .iter()
            .filter(|event| event.token() != WAKE_TOKEN)
            .map(|event| (event.token(), event.is_readable(), event.is_writable()))
            .collect::<Vec<_>>();
        let tokens = if wake {
            sessions.keys().copied().collect::<Vec<_>>()
        } else {
            io_events.into_iter().map(|(token, _, _)| token).collect()
        };
        for token in tokens {
            let Some(session) = sessions.get_mut(&token) else {
                continue;
            };
            let result = session
                .read(&shared)
                .and_then(|()| session.flush_pending())
                .and_then(|_| session.write(&shared));
            match result {
                Ok(writable) => {
                    if let Err(error) = set_write_interest(&poll, token, &mut sessions, writable) {
                        close_session(&poll, token, &shared, &mut sessions, error);
                    }
                }
                Err(error) => close_session(&poll, token, &shared, &mut sessions, error),
            }
        }
    }
    for token in sessions.keys().copied().collect::<Vec<_>>() {
        remove_session(&poll, token, &shared, &mut sessions);
    }
}

fn drain_accepted(
    poll: &mut Poll,
    accepted: &Receiver<QueuedSession>,
    shared: &Arc<SharedIngress>,
    sessions: &mut BTreeMap<Token, LiveSession>,
) {
    while let Ok(session) = accepted.try_recv() {
        let serial = session.session.serial;
        if let Err(error) = install_session(poll, session, shared, sessions) {
            super::listener::remove_socket(shared, serial);
            session_failed(shared, &error);
        }
    }
}

fn install_session(
    poll: &mut Poll,
    queued: QueuedSession,
    shared: &Arc<SharedIngress>,
    sessions: &mut BTreeMap<Token, LiveSession>,
) -> Result<(), RuntimeTransportError> {
    let QueuedSession {
        session,
        work,
        peer_ready,
    } = queued;
    let Ok(token_value) = usize::try_from(session.serial) else {
        return Err(RuntimeTransportError::Inbound("session-token".into()));
    };
    let token = Token(token_value);
    let raw_fd = tcp_stream(&session.socket)?.as_raw_fd();
    if let Err(error) = poll
        .registry()
        .register(&mut SourceFd(&raw_fd), token, Interest::READABLE)
    {
        return Err(RuntimeTransportError::WebSocket(error.to_string()));
    }
    let serial = session.serial;
    sessions.insert(
        token,
        LiveSession {
            serial,
            socket: session.socket,
            accepted: session.accepted,
            keys: session.keys,
            side: session.side,
            audience: session.audience,
            challenge: session.challenge,
            outbound: session.outbound,
            inbound: session.inbound,
            work,
            pending_write: None,
            pending_control: false,
            announced_ready: session.announced_ready,
            announced_profiles: 0,
            pending_profiles: VecDeque::new(),
            peer_ready,
            encryption_public_hex: static_public_hex(&shared.config.encryption_identity),
            _peer: session.peer_guard,
        },
    );
    Ok(())
}

fn set_write_interest(
    poll: &Poll,
    token: Token,
    sessions: &mut BTreeMap<Token, LiveSession>,
    writable: bool,
) -> Result<(), RuntimeTransportError> {
    let session = sessions
        .get_mut(&token)
        .ok_or_else(|| RuntimeTransportError::Inbound("reactor-session-missing".into()))?;
    let raw_fd = tcp_stream(&session.socket)?.as_raw_fd();
    let interest = if writable {
        Interest::READABLE | Interest::WRITABLE
    } else {
        Interest::READABLE
    };
    poll.registry()
        .reregister(&mut SourceFd(&raw_fd), token, interest)
        .map_err(|error| RuntimeTransportError::WebSocket(error.to_string()))
}

fn is_would_block(error: &RuntimeTransportError) -> bool {
    match error {
        RuntimeTransportError::WebSocket(message) => {
            message.contains("WouldBlock")
                || message.contains("would block")
                || message.contains("Resource temporarily unavailable")
        }
        _ => false,
    }
}

fn close_session(
    poll: &Poll,
    token: Token,
    shared: &Arc<SharedIngress>,
    sessions: &mut BTreeMap<Token, LiveSession>,
    error: RuntimeTransportError,
) {
    session_failed(shared, &error);
    remove_session(poll, token, shared, sessions);
}

fn remove_session(
    poll: &Poll,
    token: Token,
    shared: &Arc<SharedIngress>,
    sessions: &mut BTreeMap<Token, LiveSession>,
) {
    let Some(mut session) = sessions.remove(&token) else {
        return;
    };
    if let Ok(stream) = tcp_stream(&session.socket) {
        let _ = poll
            .registry()
            .deregister(&mut SourceFd(&stream.as_raw_fd()));
    }
    super::listener::remove_socket(shared, session.serial);
    let _ = session.socket.close(None);
}

fn set_fatal(shared: &SharedIngress, error: &str) {
    shared.stop.store(true, Ordering::Release);
    if let Ok(mut slot) = shared.fatal_error.lock()
        && slot.is_none()
    {
        *slot = Some(error.into());
    }
}

//! Fixed-size authenticated socket reactors.
//!
//! Handshakes are bounded separately; once authenticated, many sovereign
//! Runtime sockets share one `mio` poller. No financial ordering or delivery
//! acknowledgement is added: every decoded envelope still enters the single
//! Runtime writer queue and every reply completes only after the socket write.

use std::collections::BTreeMap;
use std::os::fd::AsRawFd;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{Receiver, SyncSender, TryRecvError, sync_channel};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use mio::unix::SourceFd;
use mio::{Events, Interest, Poll, Token, Waker};

use super::super::RuntimeTransportError;
use super::super::crypto::static_public_hex;
use super::super::entity_inputs_frame::{SessionCounters, SessionFrameContext, send_entity_inputs};
use super::super::wire::try_read_value;
use super::frame::FrameState;
use super::reply::{OutboundCompletion, OutboundWork, ReplyGuard};
use super::session::{AcceptedHello, AcceptedSession, PeerGuard};
use super::{SharedIngress, enqueue_batch, enqueue_gossip, session_failed};

const WAKE_TOKEN: Token = Token(0);
const ACCEPTED_SESSION_QUEUE: usize = 2_048;
const POLL_IDLE: Duration = Duration::from_millis(100);

#[derive(Clone)]
pub(super) struct ReactorIngress {
    sender: SyncSender<AcceptedSession>,
    waker: Arc<Waker>,
}

impl ReactorIngress {
    pub fn submit(&self, session: AcceptedSession) -> Result<(), RuntimeTransportError> {
        self.sender
            .send(session)
            .map_err(|_| RuntimeTransportError::Inbound("reactor-closed".into()))?;
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
            .spawn(move || run(poll, receiver, waker, shared))
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
    socket: tungstenite::WebSocket<std::net::TcpStream>,
    accepted: AcceptedHello,
    keys: super::super::crypto::SessionKeys,
    audience: String,
    challenge: String,
    outbound: SessionCounters,
    inbound: FrameState,
    work: Receiver<OutboundWork>,
    pending_write: Option<OutboundWork>,
    encryption_public_hex: String,
    _reply: ReplyGuard,
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
                        &self.keys,
                        &self.audience,
                        &self.challenge,
                        &shared.config.runtime_id,
                        &mut self.inbound,
                    )?;
                    enqueue_batch(shared, batch)?;
                }
                Some("gossip_announce") => {
                    let gossip = super::gossip::decode(
                        message,
                        &self.accepted,
                        &self.keys,
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
        if self.pending_write.is_some() {
            return Ok(true);
        }
        loop {
            match self.work.try_recv() {
                Ok(work) => {
                    let result = send_entity_inputs(
                        &mut self.socket,
                        &work.envelope,
                        &mut SessionFrameContext {
                            key: &self.keys.s2c,
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
                            if self.outbound.encryption_sequence == 1
                                && self.outbound.auth_timestamp != 2
                            {
                                return Err(RuntimeTransportError::Inbound(
                                    "entity-inputs-hello-ack-auth-not-consumed".into(),
                                ));
                            }
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
        if self.pending_write.is_none() {
            return Ok(false);
        }
        match self.socket.flush() {
            Ok(()) => {
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

fn run(
    mut poll: Poll,
    accepted: Receiver<AcceptedSession>,
    waker: Arc<Waker>,
    shared: Arc<SharedIngress>,
) {
    let mut events = Events::with_capacity(1_024);
    let mut sessions = BTreeMap::<Token, LiveSession>::new();
    while !shared.stop.load(Ordering::Acquire) {
        if let Err(error) = poll.poll(&mut events, Some(POLL_IDLE)) {
            set_fatal(&shared, &format!("reactor-poll:{error}"));
            break;
        }
        drain_accepted(&mut poll, &accepted, &waker, &shared, &mut sessions);
        let wake = events.iter().any(|event| event.token() == WAKE_TOKEN);
        let io_events = events
            .iter()
            .filter(|event| event.token() != WAKE_TOKEN)
            .map(|event| (event.token(), event.is_readable(), event.is_writable()))
            .collect::<Vec<_>>();
        if wake {
            let tokens = sessions.keys().copied().collect::<Vec<_>>();
            for token in tokens {
                let result = sessions
                    .get_mut(&token)
                    .expect("resident reactor token")
                    .write(&shared);
                match result {
                    Ok(writable) => {
                        if let Err(error) =
                            set_write_interest(&poll, token, &mut sessions, writable)
                        {
                            close_session(&poll, token, &shared, &mut sessions, error);
                        }
                    }
                    Err(error) => close_session(&poll, token, &shared, &mut sessions, error),
                }
            }
        }
        for (token, readable, writable) in io_events {
            if writable && sessions.contains_key(&token) {
                let result = sessions
                    .get_mut(&token)
                    .expect("resident reactor token")
                    .flush_pending();
                match result {
                    Ok(needs_writable) => {
                        if let Err(error) =
                            set_write_interest(&poll, token, &mut sessions, needs_writable)
                        {
                            close_session(&poll, token, &shared, &mut sessions, error);
                        }
                    }
                    Err(error) => close_session(&poll, token, &shared, &mut sessions, error),
                }
            }
            if readable
                && let Some(session) = sessions.get_mut(&token)
                && let Err(error) = session.read(&shared)
            {
                close_session(&poll, token, &shared, &mut sessions, error);
            }
        }
    }
    for token in sessions.keys().copied().collect::<Vec<_>>() {
        remove_session(&poll, token, &shared, &mut sessions);
    }
}

fn drain_accepted(
    poll: &mut Poll,
    accepted: &Receiver<AcceptedSession>,
    waker: &Arc<Waker>,
    shared: &Arc<SharedIngress>,
    sessions: &mut BTreeMap<Token, LiveSession>,
) {
    while let Ok(session) = accepted.try_recv() {
        if let Err(failure) = install_session(poll, session, waker, shared, sessions) {
            let (session, error) = *failure;
            super::listener::remove_socket(shared, session.serial);
            session_failed(shared, &error);
        }
    }
}

fn install_session(
    poll: &mut Poll,
    session: AcceptedSession,
    waker: &Arc<Waker>,
    shared: &Arc<SharedIngress>,
    sessions: &mut BTreeMap<Token, LiveSession>,
) -> Result<(), Box<(AcceptedSession, RuntimeTransportError)>> {
    let Ok(token_value) = usize::try_from(session.serial) else {
        return Err(Box::new((
            session,
            RuntimeTransportError::Inbound("session-token".into()),
        )));
    };
    let token = Token(token_value);
    let raw_fd = session.socket.get_ref().as_raw_fd();
    if let Err(error) = poll
        .registry()
        .register(&mut SourceFd(&raw_fd), token, Interest::READABLE)
    {
        return Err(Box::new((
            session,
            RuntimeTransportError::WebSocket(error.to_string()),
        )));
    }
    let (work_tx, work_rx) = sync_channel(1);
    let reply = match shared.replies.register(
        &session.accepted.peer_runtime_id,
        work_tx,
        Arc::clone(waker),
    ) {
        Ok(reply) => reply,
        Err(error) => {
            let _ = poll.registry().deregister(&mut SourceFd(&raw_fd));
            return Err(Box::new((session, error)));
        }
    };
    let serial = session.serial;
    sessions.insert(
        token,
        LiveSession {
            serial,
            socket: session.socket,
            accepted: session.accepted,
            keys: session.keys,
            audience: session.audience,
            challenge: session.challenge,
            outbound: session.outbound,
            inbound: FrameState::default(),
            work: work_rx,
            pending_write: None,
            encryption_public_hex: static_public_hex(&shared.config.encryption_identity),
            _reply: reply,
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
    let raw_fd = session.socket.get_ref().as_raw_fd();
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
    let raw_fd = session.socket.get_ref().as_raw_fd();
    let _ = poll.registry().deregister(&mut SourceFd(&raw_fd));
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

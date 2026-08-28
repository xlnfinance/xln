use std::net::TcpStream;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use serde_json::Value;
use tungstenite::WebSocket;
use tungstenite::handshake::server::{Callback, ErrorResponse, Request, Response};
use tungstenite::protocol::WebSocketConfig;

use super::super::RuntimeTransportError;
use super::super::crypto::{
    SessionKeys, derive_session_keys, ephemeral_identity, ephemeral_public_hex, frame_digest,
    hello_digest, hex_lower, parse_public_hex, sign_with_key, static_public_hex,
    verify_peer_signature,
};
use super::super::entity_inputs_frame::SessionCounters;
use super::super::wire::{object, read_value, send_value, unix_ms};
use super::SharedIngress;

pub(super) struct PeerGuard {
    peer: String,
    shared: Arc<SharedIngress>,
}

struct PathCallback(String);

impl Callback for PathCallback {
    fn on_request(self, request: &Request, response: Response) -> Result<Response, ErrorResponse> {
        if request.uri().path() == self.0 {
            return Ok(response);
        }
        Err(tungstenite::http::Response::builder()
            .status(tungstenite::http::StatusCode::NOT_FOUND)
            .body(Some("websocket path".into()))
            .unwrap_or_else(|_| tungstenite::http::Response::new(Some("websocket path".into()))))
    }
}

impl Drop for PeerGuard {
    fn drop(&mut self) {
        if let Ok(mut peers) = self.shared.active_peers.lock() {
            peers.remove(&self.peer);
        }
    }
}

pub(super) struct AcceptedSession {
    pub serial: u64,
    pub socket: WebSocket<TcpStream>,
    pub accepted: AcceptedHello,
    pub keys: SessionKeys,
    pub audience: String,
    pub challenge: String,
    pub outbound: SessionCounters,
    pub peer_guard: PeerGuard,
}

pub(super) fn accept(
    stream: TcpStream,
    serial: u64,
    shared: Arc<SharedIngress>,
) -> Result<AcceptedSession, RuntimeTransportError> {
    stream
        .set_nodelay(true)
        .map_err(|error| RuntimeTransportError::WebSocket(error.to_string()))?;
    stream
        .set_read_timeout(Some(shared.config.io_timeout))
        .and_then(|()| stream.set_write_timeout(Some(shared.config.io_timeout)))
        .map_err(|error| RuntimeTransportError::WebSocket(error.to_string()))?;
    let websocket_config = WebSocketConfig::default()
        .max_message_size(Some(shared.config.max_message_bytes))
        .max_frame_size(Some(shared.config.max_message_bytes));
    let mut socket = tungstenite::accept_hdr_with_config(
        stream,
        PathCallback(shared.config.path.clone()),
        Some(websocket_config),
    )
    .map_err(|error| RuntimeTransportError::WebSocket(error.to_string()))?;

    let challenge = challenge()?;
    let audience = format!("xln-runtime:{}", shared.config.runtime_id);
    send_value(
        &mut socket,
        &object([
            ("type", Value::String("hello_challenge".into())),
            ("challenge", Value::String(challenge.clone())),
            ("audience", Value::String(audience.clone())),
        ]),
        shared.config.max_message_bytes,
    )?;
    let hello = read_value(&mut socket)?;
    let accepted = accept_hello(&shared, &hello, &challenge, &audience)?;
    let peer_guard = register_peer(&shared, &accepted.peer_runtime_id)?;

    let server_ephemeral = ephemeral_identity()?;
    let session_public = ephemeral_public_hex(&server_ephemeral);
    let keys = derive_session_keys(
        &server_ephemeral,
        &accepted.peer_session_public,
        &challenge,
        &audience,
    )?;
    let unsigned_ack = object([
        ("type", Value::String("hello_ack".into())),
        ("from", Value::String(shared.config.runtime_id.clone())),
        (
            "fromEncryptionPubKey",
            Value::String(static_public_hex(&shared.config.encryption_identity)),
        ),
        ("to", Value::String(accepted.peer_runtime_id.clone())),
        ("sessionPubKey", Value::String(session_public)),
    ]);
    // Canonical TS: outboundAuthTimestamp starts at 0; hello_ack does ++ so
    // auth.timestamp=1 with no encSeq. The first returned entity_inputs must then
    // be auth.timestamp=2 and encSeq=1 on this same counter, or RuntimeWsClient
    // rejects it as session replay (lastInboundAuthTimestamp already 1).
    let mut outbound = SessionCounters::default();
    let auth_timestamp = outbound.consume_hello_ack_auth()?;
    let signature = sign_with_key(
        &shared.config.runtime_signer_key,
        &frame_digest(&unsigned_ack, &audience, &challenge, auth_timestamp)?,
    )?;
    let mut acknowledgement = unsigned_ack
        .as_object()
        .cloned()
        .ok_or_else(|| RuntimeTransportError::Handshake("ack-object".into()))?;
    acknowledgement.insert(
        "auth".into(),
        object([
            ("nonce", Value::String(challenge.clone())),
            ("timestamp", Value::from(auth_timestamp)),
            ("signature", Value::String(signature)),
        ]),
    );
    send_value(
        &mut socket,
        &Value::Object(acknowledgement),
        shared.config.max_message_bytes,
    )?;
    // The timeout bounds the unauthenticated handshake only. An authenticated
    // peer may legitimately stay idle; shutdown closes the registered stream
    // and unblocks this read without inventing ping/receipt state.
    socket
        .get_mut()
        .set_read_timeout(None)
        .map_err(|error| RuntimeTransportError::WebSocket(error.to_string()))?;
    socket
        .get_mut()
        .set_nonblocking(true)
        .map_err(|error| RuntimeTransportError::WebSocket(error.to_string()))?;
    shared
        .counters
        .authenticated_sessions
        .fetch_add(1, Ordering::Relaxed);
    Ok(AcceptedSession {
        serial,
        socket,
        accepted,
        keys,
        audience,
        challenge,
        outbound,
        peer_guard,
    })
}

pub(super) struct AcceptedHello {
    pub peer_runtime_id: String,
    pub peer_static_public_hex: String,
    pub peer_session_public: [u8; 32],
}

fn accept_hello(
    shared: &SharedIngress,
    value: &Value,
    challenge: &str,
    audience: &str,
) -> Result<AcceptedHello, RuntimeTransportError> {
    let object = value
        .as_object()
        .ok_or_else(|| RuntimeTransportError::Handshake("hello-object".into()))?;
    super::envelope::exact_fields(
        object,
        &[
            "v",
            "type",
            "from",
            "fromEncryptionPubKey",
            "timestamp",
            "audience",
            "sessionPubKey",
            "auth",
        ],
        &[],
        "hello",
    )?;
    if object.get("v").and_then(Value::as_u64) != Some(1)
        || object.get("type").and_then(Value::as_str) != Some("hello")
        || object.get("audience").and_then(Value::as_str) != Some(audience)
    {
        return Err(RuntimeTransportError::Handshake("hello-header".into()));
    }
    let peer_runtime_id =
        super::super::routing::normalize_runtime_id(super::envelope::text(object, "from")?)?;
    if peer_runtime_id == shared.config.runtime_id {
        return Err(RuntimeTransportError::Handshake("hello-self".into()));
    }
    let peer_static_public_hex = super::envelope::text(object, "fromEncryptionPubKey")?;
    parse_public_hex(peer_static_public_hex)?;
    let peer_session_public_hex = super::envelope::text(object, "sessionPubKey")?;
    let peer_session_public = parse_public_hex(peer_session_public_hex)?;
    let timestamp = super::envelope::safe_u64(object, "timestamp")?;
    let now = unix_ms()?;
    let skew = now.abs_diff(timestamp);
    if skew > duration_ms(shared.config.hello_skew)? {
        return Err(RuntimeTransportError::Handshake(format!(
            "hello-skew:{skew}"
        )));
    }
    let auth = object
        .get("auth")
        .and_then(Value::as_object)
        .ok_or_else(|| RuntimeTransportError::Handshake("hello-auth".into()))?;
    super::envelope::exact_fields(
        auth,
        &["nonce", "timestamp", "signature"],
        &[],
        "hello-auth",
    )?;
    if auth.get("nonce").and_then(Value::as_str) != Some(challenge)
        || super::envelope::safe_u64(auth, "timestamp")? != timestamp
    {
        return Err(RuntimeTransportError::Handshake(
            "hello-auth-binding".into(),
        ));
    }
    let signature = super::envelope::text(auth, "signature")?;
    verify_peer_signature(
        &peer_runtime_id,
        &hello_digest(
            &peer_runtime_id,
            peer_static_public_hex,
            timestamp,
            challenge,
            audience,
            peer_session_public_hex,
        ),
        signature,
    )?;
    Ok(AcceptedHello {
        peer_runtime_id,
        peer_static_public_hex: peer_static_public_hex.to_ascii_lowercase(),
        peer_session_public,
    })
}

fn register_peer(
    shared: &Arc<SharedIngress>,
    peer: &str,
) -> Result<PeerGuard, RuntimeTransportError> {
    let mut peers = shared
        .active_peers
        .lock()
        .map_err(|_| RuntimeTransportError::Inbound("peer-lock".into()))?;
    if !peers.insert(peer.into()) {
        return Err(RuntimeTransportError::Handshake(format!(
            "duplicate-runtime:{peer}"
        )));
    }
    Ok(PeerGuard {
        peer: peer.into(),
        shared: Arc::clone(shared),
    })
}

fn challenge() -> Result<String, RuntimeTransportError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| RuntimeTransportError::Crypto("random"))?;
    Ok(format!("0x{}", hex_lower(&bytes)))
}

fn duration_ms(duration: std::time::Duration) -> Result<u64, RuntimeTransportError> {
    u64::try_from(duration.as_millis())
        .map_err(|_| RuntimeTransportError::Config("hello-skew-range"))
}

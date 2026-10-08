//! Authenticated encrypted `entity_inputs` frames for one direct session.

use std::io::{Read, Write};

use serde_json::Value;
use tungstenite::WebSocket;

use super::RuntimeTransportError;
use super::crypto::{encrypt_session, frame_mac, verify_frame_mac};
use super::inbound::envelope::{exact_fields, safe_u64, text};
use super::msgpack::encode_transport;
use super::routing::OutboundEnvelope;
use super::wire::{object, send_value, typed_array};

#[derive(Default)]
pub(super) struct SessionCounters {
    pub message_counter: u64,
    pub auth_timestamp: u64,
    pub encryption_sequence: u64,
}

impl SessionCounters {
    /// hello_ack is ECDSA-bound and consumes the first outbound auth tick
    /// without an encSeq. Only encrypted financial frames consume encSeq.
    pub(super) fn consume_hello_ack_auth(&mut self) -> Result<u64, RuntimeTransportError> {
        if self.encryption_sequence != 0 || self.message_counter != 0 || self.auth_timestamp != 0 {
            return Err(RuntimeTransportError::Crypto("hello-ack-auth-dirty"));
        }
        self.auth_timestamp = self
            .auth_timestamp
            .checked_add(1)
            .ok_or(RuntimeTransportError::Crypto("hello-ack-auth-timestamp"))?;
        Ok(self.auth_timestamp)
    }
}

pub(super) struct SessionFrameContext<'a> {
    pub key: &'a [u8; 32],
    pub from: &'a str,
    pub to: &'a str,
    pub encryption_public_hex: &'a str,
    pub audience: &'a str,
    pub challenge: &'a str,
    pub counters: &'a mut SessionCounters,
}

pub(super) fn send_entity_inputs<S: Read + Write>(
    socket: &mut WebSocket<S>,
    envelope: &OutboundEnvelope,
    frame: &mut SessionFrameContext<'_>,
    max_message_bytes: usize,
) -> Result<(), RuntimeTransportError> {
    if envelope.target_runtime_id != frame.to {
        return Err(RuntimeTransportError::Route("session-target".into()));
    }
    bump_counters(frame.counters)?;
    let unsigned = unsigned_frame(envelope, frame)?;
    send_value(socket, &sign_frame(&unsigned, frame)?, max_message_bytes)
}

/// Same canonical gossip envelope/MAC as TS; gossip spends no encryption nonce.
pub(super) fn send_profiles<S: Read + Write>(
    socket: &mut WebSocket<S>,
    profiles: Vec<Value>,
    frame: &mut SessionFrameContext<'_>,
    max_message_bytes: usize,
) -> Result<(), RuntimeTransportError> {
    frame.counters.auth_timestamp = frame
        .counters
        .auth_timestamp
        .checked_add(1)
        .ok_or(RuntimeTransportError::Crypto("auth-timestamp"))?;
    let timestamp = profiles
        .iter()
        .filter_map(|p| p["lastUpdated"].as_u64())
        .max()
        .ok_or(RuntimeTransportError::Config("profile-timestamp"))?;
    let unsigned = profile_unsigned(profiles, timestamp, frame, frame.counters.auth_timestamp);
    send_value(socket, &sign_frame(&unsigned, frame)?, max_message_bytes)
}

fn profile_unsigned(
    profiles: Vec<Value>,
    timestamp: u64,
    frame: &SessionFrameContext<'_>,
    auth_timestamp: u64,
) -> Value {
    object([
        ("type", Value::String("gossip_announce".into())),
        (
            "id",
            Value::String(format!("rrs_gossip_{}", auth_timestamp)),
        ),
        ("from", Value::String(frame.from.into())),
        (
            "fromEncryptionPubKey",
            Value::String(frame.encryption_public_hex.into()),
        ),
        ("to", Value::String(frame.to.into())),
        ("timestamp", Value::from(timestamp)),
        (
            "payload",
            object([
                ("profiles", Value::Array(profiles)),
                ("jurisdictions", Value::Array(Vec::new())),
            ]),
        ),
    ])
}

/// Bound the exact MessagePack payload plus worst-case array/header overhead.
/// Never split a signed profile or lower the profile's Account disclosure limit.
pub(super) fn take_profile_batch(
    pending: &mut std::collections::VecDeque<Value>,
    frame: &SessionFrameContext<'_>,
    max_bytes: usize,
) -> Result<Vec<Value>, RuntimeTransportError> {
    let next = frame
        .counters
        .auth_timestamp
        .checked_add(1)
        .ok_or(RuntimeTransportError::Crypto("auth-timestamp"))?;
    let unsigned = profile_unsigned(Vec::new(), 9_007_199_254_740_991, frame, next);
    let mut envelope = sign_frame(&unsigned, frame)?;
    envelope["v"] = Value::from(1);
    envelope["auth"]["timestamp"] = Value::from(next);
    // Empty array is one byte; an array of at most 1000 rows needs at most three.
    let mut bytes = super::msgpack::encode_framed(&envelope)?.len() + 2;
    let mut batch = Vec::new();
    while batch.len() < 1000 {
        let Some(profile) = pending.front() else {
            break;
        };
        let size = encode_transport(profile)?.len();
        if bytes
            .checked_add(size)
            .is_none_or(|total| total > max_bytes)
        {
            break;
        }
        bytes += size;
        batch.push(
            pending
                .pop_front()
                .ok_or(RuntimeTransportError::Config("profile-queue-empty"))?,
        );
    }
    if batch.is_empty() {
        return Err(RuntimeTransportError::Config(
            "single-profile-message-budget",
        ));
    }
    Ok(batch)
}

fn bump_counters(counters: &mut SessionCounters) -> Result<(), RuntimeTransportError> {
    counters.message_counter = counters
        .message_counter
        .checked_add(1)
        .ok_or(RuntimeTransportError::Crypto("message-counter"))?;
    counters.auth_timestamp = counters
        .auth_timestamp
        .checked_add(1)
        .ok_or(RuntimeTransportError::Crypto("auth-timestamp"))?;
    counters.encryption_sequence = counters
        .encryption_sequence
        .checked_add(1)
        .ok_or(RuntimeTransportError::Crypto("encryption-sequence"))?;
    Ok(())
}

fn unsigned_frame(
    envelope: &OutboundEnvelope,
    frame: &SessionFrameContext<'_>,
) -> Result<Value, RuntimeTransportError> {
    let plaintext = encode_transport(&envelope.value)?;
    let ciphertext = encrypt_session(&plaintext, frame.key, frame.counters.encryption_sequence)?;
    let id = format!(
        "rrs_{}_{}",
        envelope.source_height, frame.counters.message_counter
    );
    let mut fields = vec![
        ("type", Value::String("entity_inputs".into())),
        ("id", Value::String(id)),
        ("from", Value::String(frame.from.into())),
        (
            "fromEncryptionPubKey",
            Value::String(frame.encryption_public_hex.into()),
        ),
        ("to", Value::String(frame.to.into())),
        ("encSeq", Value::from(frame.counters.encryption_sequence)),
        ("timestamp", Value::from(envelope.source_timestamp)),
        ("payload", typed_array(ciphertext)),
        ("encrypted", Value::Bool(true)),
        ("txs", Value::from(envelope.transaction_count)),
    ];
    if let Some(entity_id) = &envelope.entity_id {
        fields.push(("entityId", Value::String(entity_id.clone())));
    }
    Ok(object(fields))
}

fn sign_frame(
    unsigned: &Value,
    frame: &SessionFrameContext<'_>,
) -> Result<Value, RuntimeTransportError> {
    let mac = frame_mac(
        frame.key,
        unsigned,
        frame.audience,
        frame.challenge,
        frame.counters.auth_timestamp,
    )?;
    let mut signed = unsigned
        .as_object()
        .cloned()
        .ok_or_else(|| RuntimeTransportError::MessagePack("frame-object".into()))?;
    signed.insert(
        "auth".into(),
        object([
            ("nonce", Value::String(frame.challenge.into())),
            ("timestamp", Value::from(frame.counters.auth_timestamp)),
            ("mac", Value::String(mac)),
        ]),
    );
    Ok(Value::Object(signed))
}

/// Readiness belongs to the authenticated session, not financial state. Its
/// monotone MAC tick shares the gossip/financial replay guard; it never spends
/// an encryption nonce. A MAC from an older hello cannot open a new session.
pub(super) fn send_delivery_ready<S: Read + Write>(
    socket: &mut WebSocket<S>,
    ready: bool,
    frame: &mut SessionFrameContext<'_>,
    max_message_bytes: usize,
) -> Result<(), RuntimeTransportError> {
    frame.counters.auth_timestamp = frame
        .counters
        .auth_timestamp
        .checked_add(1)
        .ok_or(RuntimeTransportError::Crypto("auth-timestamp"))?;
    let unsigned = object([
        ("type", Value::String("delivery_ready".into())),
        (
            "id",
            Value::String(format!("rrs_ready_{}", frame.counters.auth_timestamp)),
        ),
        ("from", Value::String(frame.from.into())),
        (
            "fromEncryptionPubKey",
            Value::String(frame.encryption_public_hex.into()),
        ),
        ("to", Value::String(frame.to.into())),
        ("payload", Value::Bool(ready)),
    ]);
    send_value(socket, &sign_frame(&unsigned, frame)?, max_message_bytes)
}

pub(super) struct ReadinessFrameContext<'a> {
    pub key: &'a [u8; 32],
    pub from: &'a str,
    pub to: &'a str,
    pub encryption_public_hex: &'a str,
    pub audience: &'a str,
    pub challenge: &'a str,
    pub auth_timestamp: &'a mut u64,
}

pub(super) fn decode_delivery_ready(
    value: Value,
    frame: &mut ReadinessFrameContext<'_>,
) -> Result<bool, RuntimeTransportError> {
    let object = value
        .as_object()
        .ok_or_else(|| RuntimeTransportError::Inbound("readiness-object".into()))?;
    exact_fields(
        object,
        &[
            "v",
            "type",
            "id",
            "from",
            "fromEncryptionPubKey",
            "to",
            "payload",
            "auth",
        ],
        &[],
        "readiness",
    )?;
    if object.get("v").and_then(Value::as_u64) != Some(1)
        || text(object, "type")? != "delivery_ready"
        || super::routing::normalize_runtime_id(text(object, "from")?)? != frame.from
        || super::routing::normalize_runtime_id(text(object, "to")?)? != frame.to
        || text(object, "fromEncryptionPubKey")?.to_ascii_lowercase() != frame.encryption_public_hex
        || text(object, "id")?.is_empty()
        || text(object, "id")?.len() > 512
    {
        return Err(RuntimeTransportError::Inbound("readiness-route".into()));
    }
    let ready = object
        .get("payload")
        .and_then(Value::as_bool)
        .ok_or_else(|| RuntimeTransportError::Inbound("readiness-boolean".into()))?;
    let auth = object
        .get("auth")
        .and_then(Value::as_object)
        .ok_or_else(|| RuntimeTransportError::Inbound("readiness-auth".into()))?;
    exact_fields(auth, &["nonce", "timestamp", "mac"], &[], "readiness-auth")?;
    let timestamp = safe_u64(auth, "timestamp")?;
    if text(auth, "nonce")? != frame.challenge || timestamp <= *frame.auth_timestamp {
        return Err(RuntimeTransportError::Inbound(
            "readiness-auth-replay".into(),
        ));
    }
    let mut unsigned = object.clone();
    unsigned.remove("v");
    unsigned.remove("auth");
    verify_frame_mac(
        frame.key,
        &Value::Object(unsigned),
        frame.audience,
        frame.challenge,
        timestamp,
        text(auth, "mac")?,
    )?;
    *frame.auth_timestamp = timestamp;
    Ok(ready)
}

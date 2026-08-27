//! Authenticated encrypted `entity_inputs` frames for one direct session.

use std::io::{Read, Write};

use serde_json::Value;
use tungstenite::WebSocket;

use super::RuntimeTransportError;
use super::crypto::{encrypt_session, frame_mac};
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
    /// without an encSeq. Later MAC frames bump both counters together.
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

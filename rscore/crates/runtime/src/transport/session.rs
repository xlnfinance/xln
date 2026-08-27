use std::time::Duration;

use serde_json::Value;

use super::RuntimeTransportError;
use super::crypto::{
    EncryptionIdentity, SessionKeys, derive_session_keys, encrypt_session, ephemeral_identity,
    ephemeral_public_hex, frame_mac, hello_digest, parse_public_hex, sign, static_public_hex,
};
use super::msgpack::encode_transport;
use super::routing::OutboundEnvelope;
use super::wire::{
    Socket, object, read_value, required_text, send_value, set_timeouts, typed_array, unix_ms,
    verify_acknowledgement,
};

pub(super) struct DirectSession {
    target_runtime_id: String,
    source_runtime_id: String,
    audience: String,
    challenge: String,
    encryption_public_hex: String,
    keys: SessionKeys,
    socket: Socket,
    message_counter: u64,
    auth_timestamp: u64,
    encryption_sequence: u64,
    max_message_bytes: usize,
}

pub(super) struct SessionConfig<'a> {
    pub url: &'a str,
    pub target_runtime_id: &'a str,
    pub source_runtime_id: &'a str,
    pub source_seed: &'a str,
    pub source_signer_id: &'a str,
    pub identity: &'a EncryptionIdentity,
    pub io_timeout: Duration,
    pub max_message_bytes: usize,
}

impl DirectSession {
    pub(super) fn connect(config: SessionConfig<'_>) -> Result<Self, RuntimeTransportError> {
        let (mut socket, _) = tungstenite::connect(config.url)
            .map_err(|error| RuntimeTransportError::WebSocket(error.to_string()))?;
        set_timeouts(&mut socket, config.io_timeout)?;
        let challenge_message = read_value(&mut socket)?;
        let challenge = required_text(&challenge_message, "challenge")?;
        if required_text(&challenge_message, "type")? != "hello_challenge" {
            return Err(RuntimeTransportError::Handshake("challenge-type".into()));
        }
        let audience = required_text(&challenge_message, "audience")?;
        let expected_audience = format!("xln-runtime:{}", config.target_runtime_id);
        if audience != expected_audience {
            return Err(RuntimeTransportError::Handshake(format!(
                "audience:expected={expected_audience}:actual={audience}",
            )));
        }

        let ephemeral = ephemeral_identity()?;
        let static_public = static_public_hex(config.identity);
        let ephemeral_public = ephemeral_public_hex(&ephemeral);
        let timestamp = unix_ms()?;
        let signature = sign(
            config.source_seed,
            config.source_signer_id,
            &hello_digest(
                config.source_runtime_id,
                &static_public,
                timestamp,
                &challenge,
                &audience,
                &ephemeral_public,
            ),
        )?;
        let hello = object([
            ("type", Value::String("hello".into())),
            ("from", Value::String(config.source_runtime_id.into())),
            ("fromEncryptionPubKey", Value::String(static_public.clone())),
            ("timestamp", Value::from(timestamp)),
            ("audience", Value::String(audience.clone())),
            ("sessionPubKey", Value::String(ephemeral_public)),
            (
                "auth",
                object([
                    ("nonce", Value::String(challenge.clone())),
                    ("signature", Value::String(signature)),
                    ("timestamp", Value::from(timestamp)),
                ]),
            ),
        ]);
        send_value(&mut socket, &hello, config.max_message_bytes)?;

        let acknowledgement = read_value(&mut socket)?;
        verify_acknowledgement(
            &acknowledgement,
            config.target_runtime_id,
            config.source_runtime_id,
            &audience,
            &challenge,
        )?;
        let server_session_public =
            parse_public_hex(&required_text(&acknowledgement, "sessionPubKey")?)?;
        let keys = derive_session_keys(&ephemeral, &server_session_public, &challenge, &audience)?;
        Ok(Self {
            target_runtime_id: config.target_runtime_id.into(),
            source_runtime_id: config.source_runtime_id.into(),
            audience,
            challenge,
            encryption_public_hex: static_public,
            keys,
            socket,
            message_counter: 0,
            auth_timestamp: 0,
            encryption_sequence: 0,
            max_message_bytes: config.max_message_bytes,
        })
    }

    pub(super) fn send_envelope(
        &mut self,
        envelope: &OutboundEnvelope,
    ) -> Result<(), RuntimeTransportError> {
        if envelope.target_runtime_id != self.target_runtime_id {
            return Err(RuntimeTransportError::Route("session-target".into()));
        }
        self.message_counter = self
            .message_counter
            .checked_add(1)
            .ok_or(RuntimeTransportError::Crypto("message-counter"))?;
        self.auth_timestamp = self
            .auth_timestamp
            .checked_add(1)
            .ok_or(RuntimeTransportError::Crypto("auth-timestamp"))?;
        self.encryption_sequence = self
            .encryption_sequence
            .checked_add(1)
            .ok_or(RuntimeTransportError::Crypto("encryption-sequence"))?;
        let plaintext = encode_transport(&envelope.value)?;
        let ciphertext = encrypt_session(&plaintext, &self.keys.c2s, self.encryption_sequence)?;
        let id = format!("rrs_{}_{}", envelope.source_height, self.message_counter,);
        let mut fields = vec![
            ("type", Value::String("entity_inputs".into())),
            ("id", Value::String(id)),
            ("from", Value::String(self.source_runtime_id.clone())),
            (
                "fromEncryptionPubKey",
                Value::String(self.encryption_public_hex.clone()),
            ),
            ("to", Value::String(self.target_runtime_id.clone())),
            ("encSeq", Value::from(self.encryption_sequence)),
            ("timestamp", Value::from(envelope.source_timestamp)),
            ("payload", typed_array(ciphertext)),
            ("encrypted", Value::Bool(true)),
            ("txs", Value::from(envelope.transaction_count)),
        ];
        if let Some(entity_id) = &envelope.entity_id {
            fields.push(("entityId", Value::String(entity_id.clone())));
        }
        let unsigned = object(fields);
        let mac = frame_mac(
            &self.keys.c2s,
            &unsigned,
            &self.audience,
            &self.challenge,
            self.auth_timestamp,
        )?;
        let mut signed = unsigned
            .as_object()
            .cloned()
            .ok_or_else(|| RuntimeTransportError::MessagePack("frame-object".into()))?;
        signed.insert(
            "auth".into(),
            object([
                ("nonce", Value::String(self.challenge.clone())),
                ("timestamp", Value::from(self.auth_timestamp)),
                ("mac", Value::String(mac)),
            ]),
        );
        send_value(
            &mut self.socket,
            &Value::Object(signed),
            self.max_message_bytes,
        )
    }

    pub(super) fn close(mut self) {
        let _ = self.socket.close(None);
    }
}

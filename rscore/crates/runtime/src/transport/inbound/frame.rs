use serde_json::Value;

use super::super::RuntimeTransportError;
use super::super::crypto::{SessionKeys, decrypt_session, verify_frame_mac};
use super::super::routing::{normalize_entity_id, normalize_runtime_id};
use super::envelope::{InboundEntityInputs, exact_fields, safe_u64, text, typed_array};
use super::session::AcceptedHello;

#[derive(Default)]
pub(super) struct FrameState {
    auth_timestamp: u64,
    encryption_sequence: u64,
}

pub(super) fn decode(
    value: Value,
    peer: &AcceptedHello,
    keys: &SessionKeys,
    audience: &str,
    challenge: &str,
    local_runtime_id: &str,
    state: &mut FrameState,
) -> Result<InboundEntityInputs, RuntimeTransportError> {
    let object = value
        .as_object()
        .ok_or_else(|| RuntimeTransportError::Inbound("frame-object".into()))?;
    exact_fields(
        object,
        &[
            "v",
            "type",
            "id",
            "from",
            "fromEncryptionPubKey",
            "to",
            "encSeq",
            "timestamp",
            "payload",
            "encrypted",
            "txs",
            "auth",
        ],
        &["entityId"],
        "frame",
    )?;
    if object.get("v").and_then(Value::as_u64) != Some(1)
        || object.get("type").and_then(Value::as_str) != Some("entity_inputs")
        || object.get("encrypted").and_then(Value::as_bool) != Some(true)
    {
        return Err(RuntimeTransportError::Inbound("frame-header".into()));
    }
    let from = normalize_runtime_id(text(object, "from")?)?;
    let to = normalize_runtime_id(text(object, "to")?)?;
    if from != peer.peer_runtime_id || to != local_runtime_id {
        return Err(RuntimeTransportError::Inbound("frame-route".into()));
    }
    if text(object, "fromEncryptionPubKey")?.to_ascii_lowercase() != peer.peer_static_public_hex {
        return Err(RuntimeTransportError::Inbound("frame-static-key".into()));
    }
    if let Some(entity_id) = object.get("entityId") {
        normalize_entity_id(
            entity_id
                .as_str()
                .ok_or_else(|| RuntimeTransportError::Inbound("frame-entity-id".into()))?,
        )?;
    }
    let message_id = text(object, "id")?;
    if message_id.len() > 512 {
        return Err(RuntimeTransportError::Inbound("frame-id-length".into()));
    }
    let encryption_sequence = safe_u64(object, "encSeq")?;
    if encryption_sequence
        != state
            .encryption_sequence
            .checked_add(1)
            .ok_or_else(|| RuntimeTransportError::Inbound("enc-seq-overflow".into()))?
    {
        return Err(RuntimeTransportError::Inbound("enc-seq-order".into()));
    }
    let ingress_timestamp = safe_u64(object, "timestamp")?;
    let transaction_count = safe_u64(object, "txs")?;
    let auth = object
        .get("auth")
        .and_then(Value::as_object)
        .ok_or_else(|| RuntimeTransportError::Inbound("frame-auth".into()))?;
    exact_fields(auth, &["nonce", "timestamp", "mac"], &[], "frame-auth")?;
    let auth_timestamp = safe_u64(auth, "timestamp")?;
    if auth.get("nonce").and_then(Value::as_str) != Some(challenge)
        || auth_timestamp <= state.auth_timestamp
    {
        return Err(RuntimeTransportError::Inbound("frame-auth-order".into()));
    }
    let mut unsigned = object.clone();
    unsigned.remove("v");
    unsigned.remove("auth");
    verify_frame_mac(
        &keys.c2s,
        &Value::Object(unsigned),
        audience,
        challenge,
        auth_timestamp,
        text(auth, "mac")?,
    )?;
    let ciphertext = typed_array(
        object
            .get("payload")
            .ok_or_else(|| RuntimeTransportError::Inbound("frame-payload".into()))?,
    )?;
    let plaintext = decrypt_session(&ciphertext, &keys.c2s, encryption_sequence)?;
    let batch = super::envelope::decode_envelope(
        &plaintext,
        &peer.peer_runtime_id,
        local_runtime_id,
        message_id.into(),
        Some(ingress_timestamp),
    )?;
    if batch.entity_tx_count != transaction_count {
        return Err(RuntimeTransportError::Inbound(format!(
            "frame-tx-count:declared={transaction_count}:decoded={}",
            batch.entity_tx_count,
        )));
    }
    state.auth_timestamp = auth_timestamp;
    state.encryption_sequence = encryption_sequence;
    Ok(batch)
}

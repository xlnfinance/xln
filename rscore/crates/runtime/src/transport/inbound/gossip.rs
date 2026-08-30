use serde_json::Value;

use super::super::RuntimeTransportError;
use super::super::crypto::verify_frame_mac;
use super::InboundGossipAnnouncement;
use super::envelope::{exact_fields, safe_u64, text};
use super::frame::FrameState;
use super::session::AcceptedHello;

const MAX_PROFILES: usize = 1_000;

pub(super) fn decode(
    value: Value,
    peer: &AcceptedHello,
    keys: &super::super::crypto::SessionKeys,
    audience: &str,
    challenge: &str,
    local_runtime_id: &str,
    state: &mut FrameState,
) -> Result<InboundGossipAnnouncement, RuntimeTransportError> {
    let object = value
        .as_object()
        .ok_or_else(|| RuntimeTransportError::Inbound("gossip-object".into()))?;
    exact_fields(
        object,
        &[
            "v",
            "type",
            "id",
            "from",
            "fromEncryptionPubKey",
            "to",
            "timestamp",
            "payload",
            "auth",
        ],
        &[],
        "gossip",
    )?;
    if object.get("v").and_then(Value::as_u64) != Some(1)
        || object.get("type").and_then(Value::as_str) != Some("gossip_announce")
    {
        return Err(RuntimeTransportError::Inbound("gossip-header".into()));
    }
    if text(object, "from")? != peer.peer_runtime_id || text(object, "to")? != local_runtime_id {
        return Err(RuntimeTransportError::Inbound("gossip-route".into()));
    }
    if text(object, "fromEncryptionPubKey")?.to_ascii_lowercase() != peer.peer_static_public_hex {
        return Err(RuntimeTransportError::Inbound("gossip-static-key".into()));
    }
    let id = text(object, "id")?;
    if id.is_empty() || id.len() > 512 {
        return Err(RuntimeTransportError::Inbound("gossip-id".into()));
    }
    safe_u64(object, "timestamp")?;
    let auth = object
        .get("auth")
        .and_then(Value::as_object)
        .ok_or_else(|| RuntimeTransportError::Inbound("gossip-auth".into()))?;
    exact_fields(auth, &["nonce", "timestamp", "mac"], &[], "gossip-auth")?;
    let auth_timestamp = safe_u64(auth, "timestamp")?;
    if auth.get("nonce").and_then(Value::as_str) != Some(challenge)
        || auth_timestamp <= state.auth_timestamp
    {
        return Err(RuntimeTransportError::Inbound("gossip-auth-order".into()));
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
    let payload = object
        .get("payload")
        .and_then(Value::as_object)
        .ok_or_else(|| RuntimeTransportError::Inbound("gossip-payload".into()))?;
    exact_fields(
        payload,
        &["profiles", "jurisdictions"],
        &[],
        "gossip-payload",
    )?;
    let profiles = payload
        .get("profiles")
        .and_then(Value::as_array)
        .filter(|profiles| profiles.len() <= MAX_PROFILES)
        .ok_or_else(|| RuntimeTransportError::Inbound("gossip-profiles".into()))?
        .clone();
    let jurisdictions = payload
        .get("jurisdictions")
        .and_then(Value::as_array)
        .ok_or_else(|| RuntimeTransportError::Inbound("gossip-jurisdictions".into()))?;
    if !jurisdictions.is_empty() {
        return Err(RuntimeTransportError::Inbound(
            "gossip-jurisdictions-unsupported".into(),
        ));
    }
    state.auth_timestamp = auth_timestamp;
    Ok(InboundGossipAnnouncement {
        peer_runtime_id: peer.peer_runtime_id.clone(),
        profiles,
    })
}

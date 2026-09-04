use serde_json::{Map, Value};
use sha3::{Digest as _, Keccak256};
use thiserror::Error;
use xln_rscore_engine::CertifiedBoardAuthority;
use xln_rscore_hanko::verify_canonical_hanko;
use xln_rscore_protocol::encode_canonical_consensus_bytes;

const ENTITY_ID_BYTES: usize = 32;
const RUNTIME_ID_BYTES: usize = 20;
const SECP256K1_HALF_ORDER: [u8; 32] = [
    0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4, 0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct VerifiedProfileRoute {
    pub entity_id: String,
    pub runtime_id: String,
    pub signer_id: String,
    pub last_updated: u64,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub(super) enum ProfileRouteError {
    #[error("RRS_PROFILE_ROUTE:{0}")]
    Invalid(&'static str),
    #[error("RRS_PROFILE_ROUTE_AUTHORITY:{0}")]
    Authority(String),
}

pub(super) fn profile_entity_id(profile: &Value) -> Result<[u8; 32], ProfileRouteError> {
    let text = profile
        .as_object()
        .and_then(|profile| profile.get("entityId"))
        .and_then(Value::as_str)
        .ok_or(ProfileRouteError::Invalid("ENTITY_ID"))?;
    parse_hex(text, ENTITY_ID_BYTES)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(ProfileRouteError::Invalid("ENTITY_ID"))
}

pub(super) fn verify_profile_route(
    profile: &Value,
    authenticated_runtime_id: &str,
    authority: Option<&CertifiedBoardAuthority>,
) -> Result<VerifiedProfileRoute, ProfileRouteError> {
    let profile = profile
        .as_object()
        .ok_or(ProfileRouteError::Invalid("OBJECT"))?;
    exact_fields(
        profile,
        &[
            "entityId",
            "entityEncryptionPublicKey",
            "name",
            "avatar",
            "bio",
            "website",
            "lastUpdated",
            "runtimeId",
            "runtimeEncPubKey",
            "runtimeSignature",
            "publicAccounts",
            "wsUrl",
            "relays",
            "metadata",
            "accounts",
        ],
    )?;
    let entity_id = normalized_hex(text(profile, "entityId")?, ENTITY_ID_BYTES, "ENTITY_ID")?;
    let entity_bytes: [u8; 32] = parse_hex(&entity_id, ENTITY_ID_BYTES)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(ProfileRouteError::Invalid("ENTITY_ID"))?;
    let runtime_id = normalized_hex(text(profile, "runtimeId")?, RUNTIME_ID_BYTES, "RUNTIME_ID")?;
    let authenticated_runtime_id = normalized_hex(
        authenticated_runtime_id,
        RUNTIME_ID_BYTES,
        "AUTHENTICATED_RUNTIME_ID",
    )?;
    if runtime_id != authenticated_runtime_id {
        return Err(ProfileRouteError::Invalid("RUNTIME_BINDING"));
    }
    normalized_hex(
        text(profile, "entityEncryptionPublicKey")?,
        32,
        "ENTITY_ENCRYPTION_KEY",
    )?;
    normalized_hex(
        text(profile, "runtimeEncPubKey")?,
        32,
        "RUNTIME_ENCRYPTION_KEY",
    )?;
    for field in ["name", "avatar", "bio", "website"] {
        let value = text(profile, field)?;
        if field == "name" && value.trim().is_empty() {
            return Err(ProfileRouteError::Invalid("NAME"));
        }
    }
    let last_updated = profile
        .get("lastUpdated")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
        .ok_or(ProfileRouteError::Invalid("LAST_UPDATED"))?;
    array(profile, "publicAccounts")?;
    array(profile, "relays")?;
    array(profile, "accounts")?;
    if !profile
        .get("wsUrl")
        .is_some_and(|value| value.is_null() || value.as_str().is_some())
    {
        return Err(ProfileRouteError::Invalid("WS_URL"));
    }
    let metadata = object(profile, "metadata")?;
    let descriptor = profile_descriptor(profile, metadata)?;
    let canonical = crate::canonical_value_from_tagged_json(&descriptor)
        .map_err(|_| ProfileRouteError::Invalid("DESCRIPTOR"))?;
    let descriptor_bytes = encode_canonical_consensus_bytes(&canonical)
        .map_err(|_| ProfileRouteError::Invalid("DESCRIPTOR_ENCODING"))?;
    let profile_hash: [u8; 32] = Keccak256::digest(descriptor_bytes).into();
    let hanko = hex_bytes(text(metadata, "profileHanko")?, "PROFILE_HANKO")?;
    let verified = if let Some(authority) = authority {
        if authority.entity_id != entity_bytes {
            return Err(ProfileRouteError::Invalid("AUTHORITY_ENTITY"));
        }
        let accepts = |entity: &[u8; 32], board: &[u8; 32], _index: usize| {
            entity == &entity_bytes && board == &authority.registered_board_hash
        };
        verify_canonical_hanko(&hanko, &profile_hash, Some(&entity_bytes), Some(&accepts))
    } else {
        verify_canonical_hanko(&hanko, &profile_hash, Some(&entity_bytes), None)
    }
    .map_err(|error| ProfileRouteError::Authority(error.to_string()))?;
    let target = verified
        .claims
        .last()
        .ok_or(ProfileRouteError::Invalid("CLAIM"))?;
    let first_member = target
        .semantic
        .members
        .first()
        .ok_or(ProfileRouteError::Invalid("FIRST_MEMBER"))?
        .entity_id;
    if first_member[..12].iter().any(|byte| *byte != 0) {
        return Err(ProfileRouteError::Invalid("FIRST_MEMBER"));
    }
    let signer = &first_member[12..];
    let route = serde_json::json!({
        "domain": "xln-profile-runtime-route-v1",
        "profileHash": render_hex(&profile_hash),
        "entityId": entity_id,
        "runtimeId": runtime_id,
        "runtimeEncPubKey": profile["runtimeEncPubKey"].clone(),
        "lastUpdated": last_updated,
        "wsUrl": profile["wsUrl"].clone(),
        "relays": profile["relays"].clone(),
        "mirrors": metadata.get("mirrors").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
    });
    let route_json =
        serde_json::to_vec(&route).map_err(|_| ProfileRouteError::Invalid("ROUTE_ENCODING"))?;
    let route_hash: [u8; 32] = Keccak256::digest(route_json).into();
    let signature = signature(text(profile, "runtimeSignature")?)?;
    let recovered = xln_rscore_crypto::recover_signer_address(&route_hash, &signature)
        .ok_or(ProfileRouteError::Invalid("RUNTIME_SIGNATURE"))?;
    if recovered.as_slice() != signer {
        return Err(ProfileRouteError::Invalid("RUNTIME_SIGNATURE_SIGNER"));
    }
    Ok(VerifiedProfileRoute {
        entity_id: render_hex(&entity_bytes),
        runtime_id: authenticated_runtime_id,
        signer_id: render_hex(signer),
        last_updated,
    })
}

fn profile_descriptor(
    profile: &Map<String, Value>,
    metadata: &Map<String, Value>,
) -> Result<Value, ProfileRouteError> {
    let mut descriptor_metadata = Map::new();
    for required in ["isHub", "routingFeePPM", "baseFee"] {
        descriptor_metadata.insert(
            required.into(),
            metadata
                .get(required)
                .cloned()
                .ok_or(ProfileRouteError::Invalid("METADATA_REQUIRED"))?,
        );
    }
    for optional in [
        "entityKind",
        "sectors",
        "swapTakerFeeBps",
        "jurisdiction",
        "hubName",
        "policyVersion",
        "rebalanceBaseFee",
        "rebalanceLiquidityFeeBps",
        "rebalanceGasFee",
        "rebalanceTimeoutMs",
    ] {
        if let Some(value) = metadata.get(optional) {
            descriptor_metadata.insert(optional.into(), value.clone());
        }
    }
    let mut descriptor = Map::new();
    for field in [
        "entityId",
        "entityEncryptionPublicKey",
        "name",
        "avatar",
        "bio",
        "website",
        "publicAccounts",
        "accounts",
    ] {
        descriptor.insert(
            field.into(),
            profile
                .get(field)
                .cloned()
                .ok_or(ProfileRouteError::Invalid("DESCRIPTOR_FIELD"))?,
        );
    }
    descriptor.insert("metadata".into(), Value::Object(descriptor_metadata));
    Ok(Value::Object(descriptor))
}

fn signature(value: &str) -> Result<[u8; 65], ProfileRouteError> {
    let bytes = parse_hex(value, 65).ok_or(ProfileRouteError::Invalid("RUNTIME_SIGNATURE"))?;
    let signature: [u8; 65] = bytes
        .try_into()
        .map_err(|_| ProfileRouteError::Invalid("RUNTIME_SIGNATURE"))?;
    if !matches!(signature[64], 0 | 1)
        || signature[..32].iter().all(|byte| *byte == 0)
        || signature[32..64].iter().all(|byte| *byte == 0)
        || signature[32..64] > SECP256K1_HALF_ORDER[..]
    {
        return Err(ProfileRouteError::Invalid("RUNTIME_SIGNATURE_CANONICAL"));
    }
    Ok(signature)
}

fn exact_fields(object: &Map<String, Value>, fields: &[&str]) -> Result<(), ProfileRouteError> {
    if object.len() != fields.len()
        || fields.iter().any(|field| !object.contains_key(*field))
        || object.keys().any(|field| !fields.contains(&field.as_str()))
    {
        return Err(ProfileRouteError::Invalid("FIELDS"));
    }
    Ok(())
}

fn text<'a>(
    object: &'a Map<String, Value>,
    field: &'static str,
) -> Result<&'a str, ProfileRouteError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .ok_or(ProfileRouteError::Invalid(field))
}

fn object<'a>(
    object: &'a Map<String, Value>,
    field: &'static str,
) -> Result<&'a Map<String, Value>, ProfileRouteError> {
    object
        .get(field)
        .and_then(Value::as_object)
        .ok_or(ProfileRouteError::Invalid(field))
}

fn array<'a>(
    object: &'a Map<String, Value>,
    field: &'static str,
) -> Result<&'a Vec<Value>, ProfileRouteError> {
    object
        .get(field)
        .and_then(Value::as_array)
        .ok_or(ProfileRouteError::Invalid(field))
}

fn normalized_hex(
    value: &str,
    width: usize,
    field: &'static str,
) -> Result<String, ProfileRouteError> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized != value || parse_hex(&normalized, width).is_none() {
        return Err(ProfileRouteError::Invalid(field));
    }
    Ok(normalized)
}

fn hex_bytes(value: &str, field: &'static str) -> Result<Vec<u8>, ProfileRouteError> {
    let body = value
        .strip_prefix("0x")
        .filter(|body| body.len() % 2 == 0)
        .ok_or(ProfileRouteError::Invalid(field))?;
    hex::decode(body).map_err(|_| ProfileRouteError::Invalid(field))
}

fn parse_hex(value: &str, width: usize) -> Option<Vec<u8>> {
    let body = value
        .strip_prefix("0x")
        .filter(|body| body.len() == width * 2)?;
    hex::decode(body).ok()
}

fn render_hex(value: &[u8]) -> String {
    format!("0x{}", hex::encode(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use xln_rscore_hanko::{
        BoardDelays, BoardMember, build_single_signer_hanko_envelope, lazy_entity_id,
    };

    #[test]
    fn authenticated_lazy_profile_binds_exact_runtime_and_default_proposer() {
        let private_key = [7_u8; 32];
        let address = xln_rscore_crypto::address_of_private_key(&private_key).expect("address");
        let mut member = [0_u8; 32];
        member[12..].copy_from_slice(&address);
        let entity_id = lazy_entity_id(
            &[BoardMember {
                entity_id: member,
                weight: 1,
            }],
            1,
            BoardDelays::default(),
        );
        let runtime_id = format!("0x{}", "22".repeat(20));
        let mut profile = serde_json::json!({
            "entityId": render_hex(&entity_id),
            "entityEncryptionPublicKey": format!("0x{}", "33".repeat(32)),
            "name": "user",
            "avatar": "",
            "bio": "",
            "website": "",
            "lastUpdated": 9,
            "runtimeId": runtime_id,
            "runtimeEncPubKey": format!("0x{}", "44".repeat(32)),
            "runtimeSignature": format!("0x{}", "00".repeat(65)),
            "publicAccounts": [],
            "wsUrl": "ws://127.0.0.1:9000/ws",
            "relays": [],
            "metadata": {
                "routingFeePPM": 1,
                "baseFee": {"__xlnType":"BigInt","value":"0"},
                "profileHanko": "0x",
                "isHub": false,
            },
            "accounts": [],
        });
        let fields = profile.as_object().expect("profile");
        let metadata = fields["metadata"].as_object().expect("metadata");
        let descriptor = profile_descriptor(fields, metadata).expect("descriptor");
        let canonical = crate::canonical_value_from_tagged_json(&descriptor).expect("canonical");
        let profile_hash: [u8; 32] = Keccak256::digest(
            encode_canonical_consensus_bytes(&canonical).expect("descriptor bytes"),
        )
        .into();
        let hanko = build_single_signer_hanko_envelope(
            &entity_id,
            &profile_hash,
            &private_key,
            1,
            1,
            BoardDelays::default(),
        )
        .expect("hanko");
        profile["metadata"]["profileHanko"] = Value::String(render_hex(&hanko));
        let route = serde_json::json!({
            "domain": "xln-profile-runtime-route-v1",
            "profileHash": render_hex(&profile_hash),
            "entityId": render_hex(&entity_id),
            "runtimeId": runtime_id,
            "runtimeEncPubKey": profile["runtimeEncPubKey"].clone(),
            "lastUpdated": 9,
            "wsUrl": profile["wsUrl"].clone(),
            "relays": [],
            "mirrors": [],
        });
        let route_hash: [u8; 32] =
            Keccak256::digest(serde_json::to_vec(&route).expect("route bytes")).into();
        let signature = xln_rscore_crypto::sign_digest(&private_key, &route_hash).expect("sign");
        profile["runtimeSignature"] = Value::String(render_hex(&signature));

        let verified = verify_profile_route(&profile, &runtime_id, None).expect("verified");
        assert_eq!(verified.entity_id, render_hex(&entity_id));
        assert_eq!(verified.runtime_id, runtime_id);
        assert_eq!(verified.signer_id, render_hex(&address));
        assert_eq!(verified.last_updated, 9);
    }
}

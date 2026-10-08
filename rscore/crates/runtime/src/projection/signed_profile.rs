//! Signed public projection of an actual owned Entity slot.
use crate::{RuntimeEntityReplica, RuntimeEntityState};
use serde_json::Value;
use sha3::{Digest, Keccak256};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue, encode_canonical_consensus_bytes};

#[derive(Clone, Debug)]
pub struct ProfileTransportIdentity {
    pub runtime_id: String,
    pub runtime_encryption_public_key: String,
    pub ws_url: String,
}

fn bytes_hex(value: &[u8]) -> String {
    format!("0x{}", hex::encode(value))
}
fn keccak(value: &[u8]) -> [u8; 32] {
    Keccak256::digest(value).into()
}

fn canonical_field<'a>(value: &'a CanonicalValue, field: &str) -> Option<&'a CanonicalValue> {
    let CanonicalValue::Object(fields) = value else {
        return None;
    };
    fields
        .iter()
        .find_map(|(name, value)| (name == field).then_some(value))
}

fn profile_jurisdiction(value: Option<&CanonicalValue>) -> Option<CanonicalValue> {
    let value = value?;
    let name = canonical_field(value, "name")?.clone();
    let chain_id = canonical_field(value, "chainId")?.clone();
    let depository = canonical_field(value, "depositoryAddress")?.clone();
    let provider = canonical_field(value, "entityProviderAddress")?.clone();
    Some(CanonicalValue::Object(vec![
        ("name".into(), name),
        ("chainId".into(), chain_id),
        ("depositoryAddress".into(), depository),
        ("entityProviderAddress".into(), provider),
    ]))
}

fn profile_swap_taker_fee_bps(hub_config: Option<&CanonicalValue>) -> Result<Option<u16>, String> {
    let Some(config) = hub_config else {
        return Ok(None);
    };
    let value = canonical_field(config, "swapTakerFeeBps")
        .ok_or_else(|| "RRS_RUNTIME_PROFILE_SWAP_TAKER_FEE_MISSING".to_string())?;
    let CanonicalValue::Number(value) = value else {
        return Err("RRS_RUNTIME_PROFILE_SWAP_TAKER_FEE_TYPE".into());
    };
    value
        .as_str()
        .parse::<u16>()
        .ok()
        .filter(|fee| *fee <= 10_000)
        .map(Some)
        .ok_or_else(|| "RRS_RUNTIME_PROFILE_SWAP_TAKER_FEE_RANGE".to_string())
}

pub fn signed_entity_profile(
    entity_state: &RuntimeEntityState,
    entity_replica: &RuntimeEntityReplica,
    last_updated: u64,
    transport: &ProfileTransportIdentity,
    routing_fee_ppm: u32,
    routing_base_fee: &num_bigint::BigInt,
    account_rows: Vec<(xln_rscore_batch::AccountId, CanonicalValue)>,
) -> Result<Value, String> {
    let entity = &entity_state.entity;
    let authority = &entity_replica.entity_consensus.state.authority.config;
    let jurisdiction = profile_jurisdiction(authority.jurisdiction.as_ref());
    let swap_taker_fee_bps = profile_swap_taker_fee_bps(entity.hub_rebalance_config.as_ref())?;
    let mut metadata = vec![
        ("isHub".into(), CanonicalValue::Bool(entity.profile.is_hub)),
        (
            "routingFeePPM".into(),
            CanonicalValue::Number(CanonicalNumber::from_u32(routing_fee_ppm)),
        ),
        (
            "baseFee".into(),
            CanonicalValue::BigInt(routing_base_fee.clone()),
        ),
    ];
    if let Some(kind) = &entity.profile.entity_kind {
        metadata.push(("entityKind".into(), CanonicalValue::String(kind.clone())));
    }
    if !entity.profile.sectors.is_empty() {
        metadata.push((
            "sectors".into(),
            CanonicalValue::Array(
                entity
                    .profile
                    .sectors
                    .iter()
                    .cloned()
                    .map(CanonicalValue::String)
                    .collect(),
            ),
        ));
    }
    if let Some(jurisdiction) = &jurisdiction {
        metadata.push(("jurisdiction".into(), jurisdiction.clone()));
    }
    if let Some(fee) = swap_taker_fee_bps {
        metadata.push((
            "swapTakerFeeBps".into(),
            CanonicalValue::Number(CanonicalNumber::from_u16(fee)),
        ));
    }
    let mut descriptor = CanonicalValue::Object(vec![
        (
            "entityId".into(),
            CanonicalValue::String(entity.entity_id.clone()),
        ),
        (
            "entityEncryptionPublicKey".into(),
            CanonicalValue::String(bytes_hex(&entity.entity_encryption_public_key)),
        ),
        (
            "name".into(),
            CanonicalValue::String(entity.profile.name.clone()),
        ),
        (
            "avatar".into(),
            CanonicalValue::String(entity.profile.avatar.clone()),
        ),
        (
            "bio".into(),
            CanonicalValue::String(entity.profile.bio.clone()),
        ),
        (
            "website".into(),
            CanonicalValue::String(entity.profile.website.clone()),
        ),
        ("publicAccounts".into(), CanonicalValue::Array(Vec::new())),
        ("accounts".into(), CanonicalValue::Array(Vec::new())),
        ("metadata".into(), CanonicalValue::Object(metadata)),
    ]);
    let (accounts, public_accounts) =
        crate::signed_profile_accounts::apply_accounts(&mut descriptor, account_rows)?;
    let descriptor_bytes = encode_canonical_consensus_bytes(&descriptor)
        .map_err(|error| format!("RRS_RUNTIME_PROFILE_ENCODE:{error}"))?;
    let profile_digest = keccak(&descriptor_bytes);
    let last_updated = last_updated.max(1);
    let runtime_id = &transport.runtime_id;
    let runtime_encryption_public_key = &transport.runtime_encryption_public_key;
    let ws_url = &transport.ws_url;
    let route = serde_json::json!({
        "domain": "xln-profile-runtime-route-v1",
        "profileHash": bytes_hex(&profile_digest),
        "entityId": entity.entity_id,
        "runtimeId": runtime_id,
        "runtimeEncPubKey": runtime_encryption_public_key,
        "lastUpdated": last_updated,
        "wsUrl": ws_url,
        "relays": [],
        "mirrors": [],
    });
    let route_bytes = serde_json::to_vec(&route)
        .map_err(|error| format!("RRS_RUNTIME_PROFILE_ROUTE_JSON:{error}"))?;
    let (hanko, route_signature) = entity_replica
        .entity_signer
        .sign_public_projection(&profile_digest, &keccak(&route_bytes))
        .map_err(|error| format!("RRS_RUNTIME_PROFILE_SIGN:{error}"))?;
    let jurisdiction_json = jurisdiction
        .as_ref()
        .map(crate::tagged_json_from_canonical_value)
        .transpose()
        .map_err(|error| format!("RRS_RUNTIME_PROFILE_JURISDICTION:{error}"))?;
    let mut profile_metadata = serde_json::json!({
        "isHub": entity.profile.is_hub,
        "routingFeePPM": routing_fee_ppm,
        "baseFee": {"__xlnType":"BigInt","value":routing_base_fee.to_string()},
        "profileHanko": bytes_hex(&hanko),
    });
    let profile_metadata = profile_metadata
        .as_object_mut()
        .ok_or_else(|| "RRS_RUNTIME_PROFILE_METADATA".to_string())?;
    if let Some(kind) = &entity.profile.entity_kind {
        profile_metadata.insert("entityKind".into(), Value::String(kind.clone()));
    }
    if !entity.profile.sectors.is_empty() {
        profile_metadata.insert(
            "sectors".into(),
            Value::Array(
                entity
                    .profile
                    .sectors
                    .iter()
                    .cloned()
                    .map(Value::String)
                    .collect(),
            ),
        );
    }
    if let Some(jurisdiction) = jurisdiction_json {
        profile_metadata.insert("jurisdiction".into(), jurisdiction);
    }
    if let Some(fee) = swap_taker_fee_bps {
        profile_metadata.insert("swapTakerFeeBps".into(), Value::from(fee));
    }
    Ok(serde_json::json!({
        "entityId": entity.entity_id,
        "entityEncryptionPublicKey": bytes_hex(&entity.entity_encryption_public_key),
        "name": entity.profile.name,
        "avatar": entity.profile.avatar,
        "bio": entity.profile.bio,
        "website": entity.profile.website,
        "lastUpdated": last_updated,
        "runtimeId": runtime_id,
        "runtimeEncPubKey": runtime_encryption_public_key,
        "runtimeSignature": bytes_hex(&route_signature),
        "publicAccounts": public_accounts,
        "wsUrl": ws_url,
        "relays": [],
        "metadata": profile_metadata,
        "accounts": accounts,
    }))
}

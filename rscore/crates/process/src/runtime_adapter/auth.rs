use base64::{
    Engine,
    alphabet::URL_SAFE,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use serde_json::{Value, json};
use sha3::{Digest, Keccak256};
use std::collections::BTreeSet;
use xln_rscore_crypto::hmac::{HmacSha256, hmac};
use xln_rscore_crypto::{
    address_of_private_key, compressed_public_key, derive_signer_key, recover_signer_address,
    sign_digest,
};

// Process-local custody only. No auth secret, token, or identity key enters RJEA.
pub struct AdapterAuthConfig {
    auth_seed: String,
    runtime_key: [u8; 32],
    runtime_id: String,
    public_key: String,
    audience: String,
    max_ttl_ms: u64,
}

pub struct AdapterSession {
    pub level: String,
    pub lane_id: String,
    pub expires_at_ms: Option<u64>,
    pub identity_proof: Value,
    pub lane_kind: String,
}

fn keccak(bytes: &[u8]) -> [u8; 32] {
    Keccak256::digest(bytes).into()
}
fn hash_text(value: &str) -> String {
    format!("0x{}", hex::encode(keccak(value.as_bytes())))
}
fn normalized_hex(value: &str, size: usize) -> Result<String, String> {
    let value = value.trim().to_lowercase();
    if value.len() != 2 + size * 2
        || !value.starts_with("0x")
        || !value[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("RADAPTER_HEX_INVALID".into());
    }
    Ok(value)
}
fn token_field(value: &str) -> Option<String> {
    let field = value.trim();
    (!field.is_empty() && field.len() <= 256).then(|| field.to_string())
}
fn decode_field(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return None;
    }
    // Buffer.from(base64url) accepts nonzero trailing bits; match that existing
    // wire reader rather than introducing an incompatible second token format.
    let engine = GeneralPurpose::new(
        &URL_SAFE,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    let bytes = engine.decode(value).ok()?;
    token_field(&String::from_utf8_lossy(&bytes))
}

impl AdapterAuthConfig {
    pub fn new(
        auth_seed: String,
        runtime_seed: &str,
        runtime_id: &str,
        audience: Option<&str>,
        max_ttl_ms: u64,
    ) -> Result<Self, String> {
        let auth_seed = auth_seed.trim().to_string();
        if auth_seed.is_empty() {
            return Err("RADAPTER_AUTH_SEED_REQUIRED".into());
        }
        if runtime_seed.trim().is_empty() {
            return Err("RADAPTER_SERVER_IDENTITY_RUNTIME_SEED_REQUIRED".into());
        }
        let runtime_key =
            derive_signer_key(runtime_seed.trim(), "1").map_err(|error| error.to_string())?;
        let runtime_id = normalized_hex(runtime_id, 20)?;
        let address =
            address_of_private_key(&runtime_key).ok_or("RADAPTER_IDENTITY_KEY_INVALID")?;
        if runtime_id != format!("0x{}", hex::encode(address)) {
            return Err("RADAPTER_SERVER_IDENTITY_SEED_MISMATCH".into());
        }
        let public_key = format!(
            "0x{}",
            hex::encode(
                compressed_public_key(&runtime_key).ok_or("RADAPTER_IDENTITY_KEY_INVALID")?
            )
        );
        let audience = token_field(&audience.unwrap_or(&runtime_id).to_lowercase())
            .ok_or("RADAPTER_AUTH_AUDIENCE_REQUIRED")?;
        Ok(Self {
            auth_seed,
            runtime_key,
            runtime_id,
            public_key,
            audience,
            max_ttl_ms,
        })
    }
}

struct Capability {
    level: &'static str,
    expiry: u64,
    key_id: String,
    token_id: String,
}

fn capability(
    config: &AdapterAuthConfig,
    token: &str,
    now: u64,
    revoked: &BTreeSet<String>,
) -> Option<Capability> {
    let parts: Vec<_> = token.trim().split('.').collect();
    if parts.len() != 7 || parts[0] != "xlnra1" {
        return None;
    }
    let level = match parts[1] {
        "read" | "inspect" => "inspect",
        "full" | "admin" => "admin",
        _ => return None,
    };
    // TS accepts Number(exp) and floors it. Generated tokens use decimal integer ms.
    let raw_expiry = parts[2].trim();
    let expiry_number = if let Some(hex) = raw_expiry
        .strip_prefix("0x")
        .or_else(|| raw_expiry.strip_prefix("0X"))
    {
        u64::from_str_radix(hex, 16).ok()? as f64
    } else if let Some(binary) = raw_expiry
        .strip_prefix("0b")
        .or_else(|| raw_expiry.strip_prefix("0B"))
    {
        u64::from_str_radix(binary, 2).ok()? as f64
    } else if let Some(octal) = raw_expiry
        .strip_prefix("0o")
        .or_else(|| raw_expiry.strip_prefix("0O"))
    {
        u64::from_str_radix(octal, 8).ok()? as f64
    } else {
        raw_expiry.parse::<f64>().ok()?
    }
    .floor();
    if !expiry_number.is_finite() || !(0.0..=9_007_199_254_740_991.0).contains(&expiry_number) {
        return None;
    }
    let expiry = expiry_number as u64;
    if expiry <= now || expiry - now > config.max_ttl_ms {
        return None;
    }
    let audience = decode_field(parts[3])?;
    let key_id = decode_field(parts[4])?;
    let token_id = decode_field(parts[5])?;
    if audience != config.audience || revoked.contains(&token_id) {
        return None;
    }
    let body = format!("xln-radapter-v1:cap:{level}:{expiry}:{audience}:{key_id}:{token_id}");
    let expected = hex::encode(hmac::<HmacSha256>(
        config.auth_seed.as_bytes(),
        body.as_bytes(),
    ));
    let actual = parts[6].as_bytes();
    if actual.len() != expected.len() {
        return None;
    }
    let different = actual
        .iter()
        .zip(expected.as_bytes())
        .fold(0u8, |value, (a, b)| value | (a ^ b));
    (different == 0).then_some(Capability {
        level,
        expiry,
        key_id,
        token_id,
    })
}

fn identity(config: &AdapterAuthConfig, challenge: &str) -> Result<Value, String> {
    let digest = keccak(
        format!(
            "xln-radapter-server-identity-v1:{}:{}:{challenge}",
            config.runtime_id, config.public_key
        )
        .as_bytes(),
    );
    let mut signature =
        sign_digest(&config.runtime_key, &digest).ok_or("RADAPTER_IDENTITY_SIGN_FAILED")?;
    signature[64] += 27; // ethers SigningKey.serialized, never personal_sign/EIP-191.
    let public_bytes = hex::decode(&config.public_key[2..]).map_err(|error| error.to_string())?;
    Ok(
        json!({"runtimeId":config.runtime_id,"identityPublicKey":config.public_key,
        "identitySignature":format!("0x{}",hex::encode(signature)),
        "identityFingerprint":format!("0x{}",hex::encode(keccak(&public_bytes)))}),
    )
}

fn owner_proof(config: &AdapterAuthConfig, challenge: &str, token: &str, signature: &str) -> bool {
    let Ok(bytes) = hex::decode(signature.trim().strip_prefix("0x").unwrap_or("")) else {
        return false;
    };
    let mut signature: [u8; 65] = match bytes.len() {
        65 => bytes.try_into().expect("checked signature length"),
        64 => {
            let mut signature = [0u8; 65];
            signature[..64].copy_from_slice(&bytes);
            signature[64] = (signature[32] >> 7) + 27;
            signature[32] &= 0x7f;
            signature
        }
        _ => return false,
    };
    // Match ethers Signature.s (reject high top bit) and getNormalizedV.
    // EIP-155 aliases are accepted by the canonical TS recovery boundary too.
    if signature[32] & 0x80 != 0 {
        return false;
    }
    signature[64] = match signature[64] {
        0 | 27 => 27,
        1 | 28 => 28,
        value if value >= 35 => {
            if value & 1 == 1 {
                27
            } else {
                28
            }
        }
        _ => return false,
    };
    let digest = keccak(
        format!(
            "xln-radapter-owner-lane-v1:{}:{challenge}:{}",
            config.runtime_id,
            hash_text(token.trim())
        )
        .as_bytes(),
    );
    recover_signer_address(&digest, &signature)
        .is_some_and(|address| format!("0x{}", hex::encode(address)) == config.runtime_id)
}

pub fn authenticate(
    config: &AdapterAuthConfig,
    request: &Value,
    now_ms: u64,
    revoked: &BTreeSet<String>,
) -> Result<AdapterSession, String> {
    let token = request
        .get("key")
        .and_then(Value::as_str)
        .ok_or("E_UNAUTHORIZED")?;
    let auth = capability(config, token, now_ms, revoked).ok_or("E_UNAUTHORIZED")?;
    let challenge = normalized_hex(
        request
            .get("challenge")
            .and_then(Value::as_str)
            .ok_or("E_BAD_QUERY")?,
        32,
    )
    .map_err(|_| "E_BAD_QUERY".to_string())?;
    let signature = request
        .get("ownerSignature")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if !signature.is_empty() && !owner_proof(config, &challenge, token, signature) {
        return Err("E_UNAUTHORIZED".into());
    }
    let owner = !signature.is_empty();
    let lane_id = if owner {
        hash_text(&format!(
            "xln-radapter-owner-command-lane-v1\0{}",
            config.runtime_id
        ))
    } else {
        hash_text(&format!(
            "xln-radapter-command-lane-v1\0{}\0{}",
            auth.key_id, auth.token_id
        ))
    };
    Ok(AdapterSession {
        level: auth.level.into(),
        lane_id,
        expires_at_ms: Some(auth.expiry),
        identity_proof: identity(config, &challenge)?,
        lane_kind: if owner { "owner" } else { "capability" }.into(),
    })
}

#[cfg(test)]
#[path = "auth_tests.rs"]
mod tests;

/// HTTP operator endpoints use the same expiring audience-bound capability as the adapter.
pub fn authorize_http_admin(
    config: &AdapterAuthConfig,
    token: &str,
    now_ms: u64,
) -> Result<(), String> {
    let revoked = std::env::var("XLN_RADAPTER_REVOKED_JTIS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect();
    let auth = capability(config, token, now_ms, &revoked).ok_or("E_UNAUTHORIZED")?;
    if auth.level != "admin" {
        return Err("E_FORBIDDEN".into());
    }
    Ok(())
}

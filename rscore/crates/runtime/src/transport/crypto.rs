use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use sha3::Keccak256;
use x25519_dalek::{PublicKey, StaticSecret};

use super::RuntimeTransportError;
use super::msgpack::encode_framed;

type HmacSha256 = Hmac<Sha256>;

const ENCRYPTION_DOMAIN: &[u8] = b"xln-p2p-encryption-v1";
const HELLO_DOMAIN: &str = "xln-ws-hello:v1";
const FRAME_DOMAIN: &str = "xln-ws-frame:v1";
const SESSION_INFO: &str = "xln-ws-session:v1";

pub(super) struct EncryptionIdentity {
    pub public: [u8; 32],
}

pub(super) struct EphemeralIdentity {
    private: StaticSecret,
    pub public: [u8; 32],
}

#[derive(Clone)]
pub(super) struct SessionKeys {
    pub c2s: [u8; 32],
}

pub(super) fn encryption_identity(seed: &str) -> EncryptionIdentity {
    let mut material = Vec::with_capacity(ENCRYPTION_DOMAIN.len() + seed.len());
    material.extend_from_slice(ENCRYPTION_DOMAIN);
    material.extend_from_slice(seed.as_bytes());
    let mut private: [u8; 32] = Sha256::digest(material).into();
    private[0] &= 248;
    private[31] = (private[31] & 127) | 64;
    let private = StaticSecret::from(private);
    let public = *PublicKey::from(&private).as_bytes();
    EncryptionIdentity { public }
}

pub(super) fn ephemeral_identity() -> Result<EphemeralIdentity, RuntimeTransportError> {
    let mut private = [0_u8; 32];
    getrandom::fill(&mut private).map_err(|_| RuntimeTransportError::Crypto("random"))?;
    let private = StaticSecret::from(private);
    let public = *PublicKey::from(&private).as_bytes();
    Ok(EphemeralIdentity { private, public })
}

pub(super) fn derive_session_keys(
    ephemeral: &EphemeralIdentity,
    peer_public: &[u8; 32],
    challenge: &str,
    audience: &str,
) -> Result<SessionKeys, RuntimeTransportError> {
    let shared = ephemeral
        .private
        .diffie_hellman(&PublicKey::from(*peer_public));
    if shared.as_bytes().iter().all(|byte| *byte == 0) {
        return Err(RuntimeTransportError::Crypto("x25519-low-order"));
    }
    let hkdf = Hkdf::<Sha256>::new(Some(challenge.as_bytes()), shared.as_bytes());
    let mut c2s = [0_u8; 32];
    let mut s2c = [0_u8; 32];
    hkdf.expand(
        format!("{SESSION_INFO}:{audience}:c2s").as_bytes(),
        &mut c2s,
    )
    .map_err(|_| RuntimeTransportError::Crypto("hkdf-c2s"))?;
    hkdf.expand(
        format!("{SESSION_INFO}:{audience}:s2c").as_bytes(),
        &mut s2c,
    )
    .map_err(|_| RuntimeTransportError::Crypto("hkdf-s2c"))?;
    Ok(SessionKeys { c2s })
}

pub(super) fn hello_digest(
    runtime_id: &str,
    encryption_public_hex: &str,
    timestamp: u64,
    challenge: &str,
    audience: &str,
    session_public_hex: &str,
) -> [u8; 32] {
    let preimage = format!(
        "{HELLO_DOMAIN}:{audience}:{runtime_id}:{}:{timestamp}:{challenge}:session:{}",
        encryption_public_hex.to_ascii_lowercase(),
        session_public_hex.to_ascii_lowercase(),
    );
    Keccak256::digest(preimage.as_bytes()).into()
}

pub(super) fn frame_digest(
    unsigned: &Value,
    audience: &str,
    challenge: &str,
    timestamp: u64,
) -> Result<[u8; 32], RuntimeTransportError> {
    let preimage = Value::Array(vec![
        Value::String(FRAME_DOMAIN.into()),
        Value::String(audience.into()),
        Value::String(challenge.into()),
        Value::from(timestamp),
        unsigned.clone(),
    ]);
    Ok(Keccak256::digest(encode_framed(&preimage)?).into())
}

pub(super) fn frame_mac(
    key: &[u8; 32],
    unsigned: &Value,
    audience: &str,
    challenge: &str,
    timestamp: u64,
) -> Result<String, RuntimeTransportError> {
    let preimage = Value::Array(vec![
        Value::String(FRAME_DOMAIN.into()),
        Value::String(audience.into()),
        Value::String(challenge.into()),
        Value::from(timestamp),
        unsigned.clone(),
    ]);
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key)
        .map_err(|_| RuntimeTransportError::Crypto("hmac-key"))?;
    mac.update(&encode_framed(&preimage)?);
    Ok(hex_lower(&mac.finalize().into_bytes()))
}

pub(super) fn sign(
    seed: &str,
    signer_id: &str,
    digest: &[u8; 32],
) -> Result<String, RuntimeTransportError> {
    let key = xln_rscore_crypto::derive_signer_key(seed, signer_id)
        .map_err(|_| RuntimeTransportError::Crypto("signer-key"))?;
    let signature = xln_rscore_crypto::sign_digest(&key, digest)
        .ok_or(RuntimeTransportError::Crypto("sign"))?;
    Ok(format!("0x{}", hex_lower(&signature)))
}

pub(super) fn verify_peer_signature(
    runtime_id: &str,
    digest: &[u8; 32],
    signature: &str,
) -> Result<(), RuntimeTransportError> {
    let bytes = decode_hex::<65>(signature)?;
    let recovered = xln_rscore_crypto::recover_signer_address(digest, &bytes)
        .ok_or(RuntimeTransportError::Crypto("peer-signature"))?;
    if format!("0x{}", hex_lower(&recovered)) != runtime_id {
        return Err(RuntimeTransportError::Crypto("peer-runtime-id"));
    }
    Ok(())
}

pub(super) fn encrypt_session(
    plaintext: &[u8],
    key: &[u8; 32],
    sequence: u64,
) -> Result<Vec<u8>, RuntimeTransportError> {
    if sequence > 9_007_199_254_740_991 {
        return Err(RuntimeTransportError::Crypto("sequence"));
    }
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| RuntimeTransportError::Crypto("aead-key"))?;
    let mut nonce = [0_u8; 12];
    nonce[4..].copy_from_slice(&sequence.to_be_bytes());
    cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext)
        .map_err(|_| RuntimeTransportError::Crypto("encrypt"))
}

pub(super) fn static_public_hex(identity: &EncryptionIdentity) -> String {
    format!("0x{}", hex_lower(&identity.public))
}

pub(super) fn ephemeral_public_hex(identity: &EphemeralIdentity) -> String {
    format!("0x{}", hex_lower(&identity.public))
}

pub(super) fn parse_public_hex(value: &str) -> Result<[u8; 32], RuntimeTransportError> {
    decode_hex(value)
}

pub(crate) fn derive_local_runtime_id(
    seed: &str,
    signer_id: &str,
) -> Result<String, RuntimeTransportError> {
    let address = xln_rscore_crypto::derive_signer_address(seed, signer_id)
        .map_err(|_| RuntimeTransportError::Crypto("runtime-id"))?;
    Ok(format!("0x{}", hex_lower(&address)))
}

fn decode_hex<const N: usize>(value: &str) -> Result<[u8; N], RuntimeTransportError> {
    let body = value.strip_prefix("0x").unwrap_or(value);
    if body.len() != N * 2 {
        return Err(RuntimeTransportError::Crypto("hex-length"));
    }
    let mut output = [0_u8; N];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&body[index * 2..index * 2 + 2], 16)
            .map_err(|_| RuntimeTransportError::Crypto("hex"))?;
    }
    Ok(output)
}

pub(super) fn hex_lower(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

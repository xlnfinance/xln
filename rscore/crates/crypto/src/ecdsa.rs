//! secp256k1 signing and recovery over a raw 32-byte digest.
//!
//! Parity target: `signDigestBytesWithPrivateKey` and
//! `recoverAddressFromDigestSignature` in core/account/crypto.ts. Both sides
//! sign the digest directly — no message prefix, no second hash — and both
//! produce RFC 6979 deterministic signatures with a low `s`.

use secp256k1::ecdsa::{RecoverableSignature, RecoveryId};
use secp256k1::{Message, Secp256k1, SecretKey, SignOnly, VerifyOnly};
use sha3::{Digest, Keccak256};
use std::sync::OnceLock;

fn verify_context() -> &'static Secp256k1<VerifyOnly> {
    static CONTEXT: OnceLock<Secp256k1<VerifyOnly>> = OnceLock::new();
    CONTEXT.get_or_init(Secp256k1::verification_only)
}

fn sign_context() -> &'static Secp256k1<SignOnly> {
    static CONTEXT: OnceLock<Secp256k1<SignOnly>> = OnceLock::new();
    CONTEXT.get_or_init(Secp256k1::signing_only)
}

/// Accept both encodings of the recovery byte: 0/1 as the raw parity, and
/// 27/28 as Ethereum writes it.
pub fn normalize_recovery_byte(value: u8) -> Option<u8> {
    match value {
        0 | 1 => Some(value),
        27 | 28 => Some(value - 27),
        _ => None,
    }
}

/// The Ethereum address of a public key: last 20 bytes of its keccak hash.
pub fn address_of_public_key(public_key: &secp256k1::PublicKey) -> [u8; 20] {
    let uncompressed = public_key.serialize_uncompressed();
    let hash = Keccak256::digest(&uncompressed[1..]);
    let mut address = [0_u8; 20];
    address.copy_from_slice(&hash[12..]);
    address
}

/// Recover the signer address, or `None` when the signature does not belong to
/// any public key over this digest.
pub fn recover_signer_address(digest: &[u8; 32], signature: &[u8; 65]) -> Option<[u8; 20]> {
    let recovery = RecoveryId::try_from(i32::from(normalize_recovery_byte(signature[64])?)).ok()?;
    let recoverable = RecoverableSignature::from_compact(&signature[..64], recovery).ok()?;
    let recovered = verify_context()
        .recover_ecdsa(Message::from_digest(*digest), &recoverable)
        .ok()?;
    Some(address_of_public_key(&recovered))
}

/// Sign a digest. The returned byte 64 is the raw parity (0 or 1), matching
/// what `signDigestBytesWithPrivateKey` returns as `recovery`.
pub fn sign_digest(private_key: &[u8; 32], digest: &[u8; 32]) -> Option<[u8; 65]> {
    let secret = SecretKey::from_byte_array(*private_key).ok()?;
    let signed = sign_context().sign_ecdsa_recoverable(Message::from_digest(*digest), &secret);
    let (recovery, compact) = signed.serialize_compact();
    let mut signature = [0_u8; 65];
    signature[..64].copy_from_slice(&compact);
    signature[64] = u8::try_from(i32::from(recovery)).ok()?;
    Some(signature)
}

/// The address a private key signs as.
pub fn address_of_private_key(private_key: &[u8; 32]) -> Option<[u8; 20]> {
    let secret = SecretKey::from_byte_array(*private_key).ok()?;
    Some(address_of_public_key(&secret.public_key(sign_context())))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Vectors produced by the TypeScript signer (scratchpad/keyvec.ts).
    #[test]
    fn signs_and_recovers_the_typescript_vector() {
        let private_key: [u8; 32] =
            hex::decode("309b1f6e8dd69428a1954d7ab5ef05460264d9885d1cee151ccb277b9f27d01e")
                .expect("key")
                .try_into()
                .expect("32 bytes");
        let digest = [0x3b_u8; 32];
        let signature = sign_digest(&private_key, &digest).expect("signature");
        assert_eq!(
            hex::encode(&signature[..64]),
            "61332b5c9c7f39991b3a588f0bc51d3411b81c0c2e0242d7bd9bd748b77b4403\
             2414936d7b252c4d0de2693d61a6d05f6a71dea6970b0f4a5ffb2f10005b940a",
        );
        assert_eq!(signature[64], 1);
        assert_eq!(
            hex::encode(recover_signer_address(&digest, &signature).expect("address")),
            "8993c66ca61106471efbaae153d3be7200185caa",
        );
        assert_eq!(
            hex::encode(address_of_private_key(&private_key).expect("address")),
            "8993c66ca61106471efbaae153d3be7200185caa",
        );
    }
}

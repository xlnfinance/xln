//! Signature recovery for incoming account inputs.
//!
//! An account input arrives from outside and is worth nothing until its Hanko
//! is checked. TypeScript recovers the signer address from the frame digest
//! and compares it to the expected signer (`recoverAddressFromDigestSignature`
//! in core/account/crypto.ts); this is the same operation, byte for byte, so a
//! signature either side accepts the other accepts too.

use secp256k1::ecdsa::{RecoverableSignature, RecoveryId};
use secp256k1::{Message, Secp256k1, VerifyOnly};
use sha3::{Digest as _, Keccak256};

/// Address recovered from a 32-byte digest and a 65-byte `r||s||v` signature,
/// or `None` when the signature is malformed or does not recover.
///
/// `v` is the raw recovery id (0 or 1); the 27/28 form is normalized by the
/// caller, exactly as the TypeScript parser does before recovery.
fn context() -> &'static Secp256k1<VerifyOnly> {
    static CONTEXT: std::sync::OnceLock<Secp256k1<VerifyOnly>> = std::sync::OnceLock::new();
    CONTEXT.get_or_init(Secp256k1::verification_only)
}

pub fn recover_signer_address(digest: &[u8; 32], signature: &[u8; 65]) -> Option<[u8; 20]> {
    let recovery = RecoveryId::try_from(i32::from(signature[64])).ok()?;
    let recoverable = RecoverableSignature::from_compact(&signature[..64], recovery).ok()?;
    let message = Message::from_digest(*digest);
    let public_key = context().recover_ecdsa(message, &recoverable).ok()?;
    // Ethereum address: last 20 bytes of keccak256 over the uncompressed key
    // without its 0x04 prefix.
    let uncompressed = public_key.serialize_uncompressed();
    let hash = Keccak256::digest(&uncompressed[1..]);
    let mut address = [0_u8; 20];
    address.copy_from_slice(&hash[12..]);
    Some(address)
}

/// Normalize the recovery byte the way the canonical signature parser does:
/// 27/28 are the Ethereum encoding of 0/1, anything else is rejected.
pub fn normalize_recovery_byte(value: u8) -> Option<u8> {
    match value {
        0 | 1 => Some(value),
        27 | 28 => Some(value - 27),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_recovery_byte, recover_signer_address};

    fn bytes_from_hex<const N: usize>(hex: &str) -> [u8; N] {
        let mut out = [0_u8; N];
        for (index, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).expect("hex");
        }
        out
    }

    /// Vectors produced by the TypeScript signer itself (runtimeSeed 0x5d…,
    /// signer labels "1" and "2", digest 0xab…). The address recovered here
    /// must be the address TypeScript derived for that signer, or the two
    /// engines disagree about who signed an account input.
    fn vector(signature_hex: &str, expected_hex: &str) {
        let digest = [0xab_u8; 32];
        let mut signature: [u8; 65] = bytes_from_hex(signature_hex);
        signature[64] = normalize_recovery_byte(signature[64]).expect("recovery byte");
        let expected: [u8; 20] = bytes_from_hex(expected_hex);
        assert_eq!(recover_signer_address(&digest, &signature), Some(expected));
    }

    #[test]
    fn recovers_the_addresses_typescript_signed_with() {
        vector(
            "63927be5d02311a7ddfc0638c99b1db530b3af33038d22200dc8816727fd877e59eed0a4116bfbf185eeea98635bbbbf8447d79b33d8bd72735bb0289b5a8a0f01",
            "44a28d6d721db54121c1aca2f3d18756823ea604",
        );
        vector(
            "632c9698a46a141669f7ee6e7b9d7b03f714ad65dc2242a61cfdb0f6210965b16e75f23de97f99084f0222b7072d7f19b7b78dcf22fe03d78a265c15d74de52e00",
            "719ae8d8bef33e48ae998a484f68589ee7336d28",
        );
    }

    #[test]
    fn a_tampered_signature_never_recovers_the_real_signer() {
        let digest = [0xab_u8; 32];
        let mut signature = [0x11_u8; 65];
        signature[64] = 0;
        assert_ne!(
            recover_signer_address(&digest, &signature),
            Some(bytes_from_hex::<20>(
                "44a28d6d721db54121c1aca2f3d18756823ea604"
            )),
        );
        assert_eq!(normalize_recovery_byte(4), None);
        assert_eq!(normalize_recovery_byte(27), Some(0));
        assert_eq!(normalize_recovery_byte(28), Some(1));
    }
}

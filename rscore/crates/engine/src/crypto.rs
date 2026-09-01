//! Signature work on the account boundary.
//!
//! An account input arrives from outside and is worth nothing until its Hanko
//! is checked, so the engine recovers and signs itself rather than trusting a
//! digest and signer prepared elsewhere. The primitives live in the shared
//! crypto crate (parity target: core/account/crypto.ts); this module is the
//! account machine's view of them.

pub use xln_rscore_crypto::{
    EcdsaRecoveryProfileSnapshot, address_of_private_key, derive_signer_address, derive_signer_key,
    ecdsa_recovery_profile_snapshot, normalize_recovery_byte, recover_signer_address, sign_digest,
};

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

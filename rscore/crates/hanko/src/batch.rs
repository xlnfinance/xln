//! Building a Hanko this runtime signs itself.
//!
//! Parity target: `buildSingleSignerHanko` (core/hanko/batch.ts) and the
//! single-validator shape of `buildQuorumHanko` (core/hanko/signing.ts) — one
//! claim, one signature, no placeholders.

use xln_rscore_crypto::sign_digest;

use crate::abi::{Word, word_from_usize};
use crate::claims::BoardDelays;
use crate::codec::{HankoEnvelope, WireClaim, encode_hanko_envelope, pack_hanko_signatures};
use crate::{HankoError, HankoResult};

/// Sign `digest` with one key and wrap it as the entity's Hanko.
///
/// `weight` and `threshold` are the validator's share and the quorum's
/// threshold; a lazy single-signer entity uses 1 and 1.
pub fn build_single_signer_hanko(
    entity_id: &Word,
    digest: &[u8; 32],
    private_key: &[u8; 32],
    weight: u128,
    threshold: u128,
    delays: BoardDelays,
) -> HankoResult<Vec<u8>> {
    let signed = sign_digest(private_key, digest).ok_or(HankoError::SigningFailed)?;
    encode_single_signer_hanko_from_signature(entity_id, signed, weight, threshold, delays)
}

/// Wrap an already-produced raw ECDSA signature as the same single-signer
/// Hanko. Entity consensus retains the raw 0/1-recovery signature in
/// `collectedSigs` and the ABI Hanko needs 27/28; signing the digest again is
/// both waste and an avoidable second crypto path.
pub fn encode_single_signer_hanko_from_signature(
    entity_id: &Word,
    mut signature: [u8; 65],
    weight: u128,
    threshold: u128,
    delays: BoardDelays,
) -> HankoResult<Vec<u8>> {
    if signature[64] > 1 {
        return Err(HankoError::Invalid("HANKO_RAW_SIGNATURE_RECOVERY_INVALID"));
    }
    signature[64] += 27;
    let packed = pack_hanko_signatures(&[signature])?;
    encode_hanko_envelope(&HankoEnvelope {
        placeholders: Vec::new(),
        packed_signatures: packed,
        claims: vec![WireClaim {
            entity_id: *entity_id,
            entity_indexes: vec![word_from_usize(0)],
            weights: vec![word_from_u128(weight)],
            threshold: word_from_u128(threshold),
            board_change_delay: delays.board_change_delay,
            control_change_delay: delays.control_change_delay,
            dividend_change_delay: delays.dividend_change_delay,
        }],
    })
}

fn word_from_u128(value: u128) -> Word {
    let mut word = [0_u8; 32];
    word[16..].copy_from_slice(&value.to_be_bytes());
    word
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claims::verify_canonical_hanko;

    /// Vector produced by `buildSingleSignerHanko` (scratchpad/keyvec.ts) for a
    /// lazy entity, whose id is its own board hash.
    #[test]
    fn matches_the_typescript_single_signer_hanko() {
        let private_key: [u8; 32] =
            hex::decode("309b1f6e8dd69428a1954d7ab5ef05460264d9885d1cee151ccb277b9f27d01e")
                .expect("key")
                .try_into()
                .expect("32 bytes");
        let entity_id: Word =
            hex::decode("1b7a1f31158ced332b779dd6b985ff695b22358470d1cbf6fac0c6db84478d08")
                .expect("entity")
                .try_into()
                .expect("32 bytes");
        let digest = [0x3b_u8; 32];
        let hanko = build_single_signer_hanko(
            &entity_id,
            &digest,
            &private_key,
            1,
            1,
            BoardDelays::default(),
        )
        .expect("hanko");
        assert_eq!(hex::encode(&hanko), TYPESCRIPT_HANKO);

        let signed = sign_digest(&private_key, &digest).expect("raw signature");
        let reused = encode_single_signer_hanko_from_signature(
            &entity_id,
            signed,
            1,
            1,
            BoardDelays::default(),
        )
        .expect("reused signature hanko");
        assert_eq!(reused, hanko);

        let verified =
            verify_canonical_hanko(&hanko, &digest, Some(&entity_id), None).expect("verified");
        assert_eq!(verified.target_entity_id, entity_id);
        assert_eq!(verified.claims[0].board_hash, entity_id);
    }

    #[test]
    fn rejects_a_non_raw_recovery_byte() {
        let mut signature = [1_u8; 65];
        signature[64] = 27;
        assert!(matches!(
            encode_single_signer_hanko_from_signature(
                &[2_u8; 32],
                signature,
                1,
                1,
                BoardDelays::default(),
            ),
            Err(HankoError::Invalid("HANKO_RAW_SIGNATURE_RECOVERY_INVALID"))
        ));
    }

    /// The same bytes verified against the wrong digest must fail, and so must
    /// a flipped signature byte.
    #[test]
    fn rejects_a_foreign_digest_and_a_tampered_signature() {
        let hanko = hex::decode(TYPESCRIPT_HANKO).expect("hanko");
        let entity_id: Word =
            hex::decode("1b7a1f31158ced332b779dd6b985ff695b22358470d1cbf6fac0c6db84478d08")
                .expect("entity")
                .try_into()
                .expect("32 bytes");
        assert!(verify_canonical_hanko(&hanko, &[0x3c_u8; 32], Some(&entity_id), None).is_err());
        let mut tampered = hanko.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        assert!(verify_canonical_hanko(&tampered, &[0x3b_u8; 32], Some(&entity_id), None).is_err());
    }

    const TYPESCRIPT_HANKO: &str = "\
0000000000000000000000000000000000000000000000000000000000000020\
0000000000000000000000000000000000000000000000000000000000000060\
0000000000000000000000000000000000000000000000000000000000000080\
0000000000000000000000000000000000000000000000000000000000000100\
0000000000000000000000000000000000000000000000000000000000000000\
0000000000000000000000000000000000000000000000000000000000000041\
61332b5c9c7f39991b3a588f0bc51d3411b81c0c2e0242d7bd9bd748b77b4403\
2414936d7b252c4d0de2693d61a6d05f6a71dea6970b0f4a5ffb2f10005b940a\
0100000000000000000000000000000000000000000000000000000000000000\
0000000000000000000000000000000000000000000000000000000000000001\
0000000000000000000000000000000000000000000000000000000000000020\
1b7a1f31158ced332b779dd6b985ff695b22358470d1cbf6fac0c6db84478d08\
00000000000000000000000000000000000000000000000000000000000000e0\
0000000000000000000000000000000000000000000000000000000000000120\
0000000000000000000000000000000000000000000000000000000000000001\
0000000000000000000000000000000000000000000000000000000000000000\
0000000000000000000000000000000000000000000000000000000000000000\
0000000000000000000000000000000000000000000000000000000000000000\
0000000000000000000000000000000000000000000000000000000000000001\
0000000000000000000000000000000000000000000000000000000000000000\
0000000000000000000000000000000000000000000000000000000000000001\
0000000000000000000000000000000000000000000000000000000000000001";
}

//! Building a Hanko this runtime signs itself.
//!
//! Parity targets: `buildSingleSignerHanko` (core/hanko/batch.ts) for the
//! chain-bound proof — one claim, one signature, no placeholders, compacted to
//! the 65-byte form when it proves the signer's own lazy 1-of-1 entity — and
//! the single-validator shape of `buildQuorumHanko` (core/hanko/signing.ts),
//! which stays a full envelope for off-chain consensus.

use xln_rscore_crypto::sign_digest;

use crate::abi::{Word, word_from_usize};
use crate::claims::BoardDelays;
use crate::codec::{HankoEnvelope, WireClaim, encode_hanko_envelope, pack_hanko_signatures};
use crate::short::compact_hanko_for_chain;
use crate::{HankoError, HankoResult};

/// Chain-bound single-signer Hanko: sign `digest` with one key and wrap it as
/// the entity's Hanko; a signer proving its own lazy 1-of-1 entity gets the
/// 65-byte form, every other board keeps the full envelope.
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
    let envelope = build_single_signer_hanko_envelope(
        entity_id,
        digest,
        private_key,
        weight,
        threshold,
        delays,
    )?;
    compact_hanko_for_chain(&envelope, digest)
}

/// The same proof as a full envelope regardless of board shape: the wire form
/// off-chain consensus exchanges and `verify_canonical_hanko` accepts.
pub fn build_single_signer_hanko_envelope(
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
        member_signatures: Vec::new(),
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
    use crate::short::{is_short_hanko, recover_short_hanko_entity_id};

    /// Vectors produced by the TypeScript implementation in this worktree
    /// (ethers 6.17, scratchpad `hankovec.ts`):
    /// ```ts
    /// const key = '0x309b1f6e…d01e'; const digest = '0x' + '3b'.repeat(32);
    /// const lazy = lazySingleSignerEntityId(new ethers.Wallet(key).address);
    /// encodeSignedHanko({ digest, privateKeys: [ethers.getBytes(key)], placeholders: [],
    ///   claims: [{ entityId, entityIndexes: [0n], weights: [1n], threshold: 1n,
    ///              ...resolveHankoBoardDelays() }], memberSignatures: [] })  // *_ENVELOPE
    /// buildSingleSignerHanko(lazy, digest, key)                              // LAZY_SHORT
    /// ```
    const PRIVATE_KEY: &str = "309b1f6e8dd69428a1954d7ab5ef05460264d9885d1cee151ccb277b9f27d01e";
    const LAZY_ENTITY: &str = "1b7a1f31158ced332b779dd6b985ff695b22358470d1cbf6fac0c6db84478d08";
    const DIGEST: [u8; 32] = [0x3b_u8; 32];

    fn key() -> [u8; 32] {
        hex::decode(PRIVATE_KEY)
            .expect("key")
            .try_into()
            .expect("32 bytes")
    }
    fn lazy_entity() -> Word {
        hex::decode(LAZY_ENTITY)
            .expect("entity")
            .try_into()
            .expect("32 bytes")
    }

    #[test]
    fn lazy_entity_matches_the_typescript_short_hanko() {
        let hanko = build_single_signer_hanko(
            &lazy_entity(),
            &DIGEST,
            &key(),
            1,
            1,
            BoardDelays::default(),
        )
        .expect("hanko");
        assert_eq!(hex::encode(&hanko), LAZY_SHORT);
        assert!(is_short_hanko(&hanko));
        assert_eq!(
            recover_short_hanko_entity_id(&hanko, &DIGEST).expect("recover"),
            lazy_entity()
        );
        // The envelope form verifies off-chain and compacts to the same bytes.
        let envelope = build_single_signer_hanko_envelope(
            &lazy_entity(),
            &DIGEST,
            &key(),
            1,
            1,
            BoardDelays::default(),
        )
        .expect("envelope");
        assert_eq!(hex::encode(&envelope), LAZY_ENVELOPE);
        assert_eq!(
            compact_hanko_for_chain(&envelope, &DIGEST).expect("compact"),
            hanko
        );
        let signed = sign_digest(&key(), &DIGEST).expect("raw signature");
        let reused = encode_single_signer_hanko_from_signature(
            &lazy_entity(),
            signed,
            1,
            1,
            BoardDelays::default(),
        )
        .expect("reused signature hanko");
        assert_eq!(reused, envelope);
        let verified = verify_canonical_hanko(&envelope, &DIGEST, Some(&lazy_entity()), None)
            .expect("verified");
        assert_eq!(verified.target_entity_id, lazy_entity());
        assert_eq!(verified.claims[0].board_hash, lazy_entity());
        assert!(verified.envelope.member_signatures.is_empty());
    }

    #[test]
    fn other_entity_keeps_the_typescript_envelope() {
        let entity_id = [0x02_u8; 32];
        let hanko =
            build_single_signer_hanko(&entity_id, &DIGEST, &key(), 1, 1, BoardDelays::default())
                .expect("hanko");
        assert_eq!(hex::encode(&hanko), OTHER_ENVELOPE);
        assert_eq!(
            compact_hanko_for_chain(&hanko, &DIGEST).expect("compact"),
            hanko
        );
        let quorum = build_single_signer_hanko(
            &lazy_entity(),
            &DIGEST,
            &key(),
            2,
            2,
            BoardDelays::default(),
        )
        .expect("quorum hanko");
        assert!(!is_short_hanko(&quorum));
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
    /// a flipped signature byte; the short form is not an off-chain proof.
    #[test]
    fn rejects_a_foreign_digest_a_tampered_signature_and_the_short_form() {
        let hanko = hex::decode(LAZY_ENVELOPE).expect("hanko");
        let entity_id = lazy_entity();
        assert!(verify_canonical_hanko(&hanko, &[0x3c_u8; 32], Some(&entity_id), None).is_err());
        let mut tampered = hanko.clone();
        // Last byte of the packed signature payload (the `s` word tail).
        let packed_end = 5 * 32 + 32 + 32 + 64;
        tampered[packed_end - 1] ^= 0x01;
        assert!(verify_canonical_hanko(&tampered, &DIGEST, Some(&entity_id), None).is_err());
        let short = hex::decode(LAZY_SHORT).expect("short");
        assert!(verify_canonical_hanko(&short, &DIGEST, Some(&entity_id), None).is_err());
        assert!(
            recover_short_hanko_entity_id(&short, &[0x3c_u8; 32]).is_ok_and(|id| id != entity_id)
        );
    }

    #[test]
    fn member_signatures_must_align_with_placeholders() {
        let mut envelope =
            crate::codec::decode_hanko_envelope(&hex::decode(LAZY_ENVELOPE).expect("hanko"))
                .expect("envelope");
        envelope.member_signatures = vec![Vec::new()];
        assert_eq!(
            encode_hanko_envelope(&envelope),
            Err(HankoError::Invalid("HANKO_MEMBER_SIGNATURES_INVALID"))
        );
    }

    const LAZY_SHORT: &str = "\
61332b5c9c7f39991b3a588f0bc51d3411b81c0c2e0242d7bd9bd748b77b4403\
2414936d7b252c4d0de2693d61a6d05f6a71dea6970b0f4a5ffb2f10005b940a1c";

    const LAZY_ENVELOPE: &str = "\
0000000000000000000000000000000000000000000000000000000000000020\
0000000000000000000000000000000000000000000000000000000000000080\
00000000000000000000000000000000000000000000000000000000000000a0\
0000000000000000000000000000000000000000000000000000000000000120\
00000000000000000000000000000000000000000000000000000000000002c0\
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
0000000000000000000000000000000000000000000000000000000000000001\
0000000000000000000000000000000000000000000000000000000000000000";

    const OTHER_ENVELOPE: &str = "\
0000000000000000000000000000000000000000000000000000000000000020\
0000000000000000000000000000000000000000000000000000000000000080\
00000000000000000000000000000000000000000000000000000000000000a0\
0000000000000000000000000000000000000000000000000000000000000120\
00000000000000000000000000000000000000000000000000000000000002c0\
0000000000000000000000000000000000000000000000000000000000000000\
0000000000000000000000000000000000000000000000000000000000000041\
61332b5c9c7f39991b3a588f0bc51d3411b81c0c2e0242d7bd9bd748b77b4403\
2414936d7b252c4d0de2693d61a6d05f6a71dea6970b0f4a5ffb2f10005b940a\
0100000000000000000000000000000000000000000000000000000000000000\
0000000000000000000000000000000000000000000000000000000000000001\
0000000000000000000000000000000000000000000000000000000000000020\
0202020202020202020202020202020202020202020202020202020202020202\
00000000000000000000000000000000000000000000000000000000000000e0\
0000000000000000000000000000000000000000000000000000000000000120\
0000000000000000000000000000000000000000000000000000000000000001\
0000000000000000000000000000000000000000000000000000000000000000\
0000000000000000000000000000000000000000000000000000000000000000\
0000000000000000000000000000000000000000000000000000000000000000\
0000000000000000000000000000000000000000000000000000000000000001\
0000000000000000000000000000000000000000000000000000000000000000\
0000000000000000000000000000000000000000000000000000000000000001\
0000000000000000000000000000000000000000000000000000000000000001\
0000000000000000000000000000000000000000000000000000000000000000";
}

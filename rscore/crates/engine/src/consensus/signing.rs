//! Who signs an account frame, and how its counterparty checks the signature.
//!
//! Parity targets: `buildQuorumHanko` (core/hanko/signing.ts) for the
//! single-validator shape, and `verifyHankoForHash` (same file) for the check.
//! The engine holds the runtime seed and derives its own key, so an outgoing
//! frame never leaves without a signature and an incoming one is never trusted
//! before recovery.

use xln_rscore_hanko::{
    BoardDelays, encode_single_signer_hanko_from_signature, verify_canonical_hanko,
};

use crate::error::StateError;

/// Exact board-registry record resolved by the parent Entity for one Entity.
///
/// Account never accepts this from an `AccountInput`. The parent resolves it
/// from its certified registry, binds it to `entity_id`, and hands this typed
/// value to the reducer beside the untrusted peer bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CertifiedBoardAuthority {
    pub entity_id: [u8; 32],
    pub registered_board_hash: [u8; 32],
    pub previous_board_hash: [u8; 32],
    /// Exclusive Unix-second boundary, exactly like
    /// `CertifiedBoardRecord.previousBoardValidUntil` in TypeScript.
    pub previous_board_valid_until: u64,
    pub activated_at_j_height: u64,
    pub activation_log_index: u64,
}

impl CertifiedBoardAuthority {
    pub fn assert_entity(&self, expected_entity_id: &[u8; 32]) -> Result<(), StateError> {
        if &self.entity_id != expected_entity_id {
            return Err(StateError::BoardAuthorityPeerMismatch {
                expected: render_word(expected_entity_id),
                resolved: render_word(&self.entity_id),
            });
        }
        Ok(())
    }
}

fn render_word(value: &[u8; 32]) -> String {
    use std::fmt::Write as _;
    value.iter().fold(String::from("0x"), |mut text, byte| {
        let _ = write!(text, "{byte:02x}");
        text
    })
}

/// The board this runtime signs for. Single-validator only: a quorum needs the
/// certified registry TypeScript owns, and the engine says so rather than
/// signing something the jurisdiction would reject.
#[derive(Clone)]
pub struct SigningIdentity {
    entity_id: [u8; 32],
    private_key: [u8; 32],
    weight: u128,
    threshold: u128,
    delays: BoardDelays,
    signer_id: String,
}

#[cfg(test)]
std::thread_local! {
    static TEST_SIGN_FRAME_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn reset_test_sign_frame_calls() {
    TEST_SIGN_FRAME_CALLS.with(|calls| calls.set(0));
}

#[cfg(test)]
pub(crate) fn test_sign_frame_calls() -> usize {
    TEST_SIGN_FRAME_CALLS.with(std::cell::Cell::get)
}

impl std::fmt::Debug for SigningIdentity {
    /// Never render the key: this struct is logged with the account it signs
    /// for, and a leaked seed is every account at once.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SigningIdentity")
            .field("entityId", &hex_of(&self.entity_id))
            .field("signerId", &self.signer_id)
            .field("weight", &self.weight)
            .field("threshold", &self.threshold)
            .finish_non_exhaustive()
    }
}

fn hex_of(bytes: &[u8]) -> String {
    // Nibble table, not `write!`: the formatter machinery showed up in the
    // engine profile, and every frame formats its predecessor's hash.
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = Vec::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[usize::from(byte >> 4)]);
        output.push(DIGITS[usize::from(byte & 0x0f)]);
    }
    // Every byte written is an ASCII hex digit.
    String::from_utf8(output).unwrap_or_default()
}

impl SigningIdentity {
    /// Derive the signer key from the runtime seed, exactly as the runtime
    /// does for the same signer id.
    pub fn from_seed(
        seed: &str,
        signer_id: &str,
        entity_id: [u8; 32],
        weight: u128,
        threshold: u128,
        delays: BoardDelays,
    ) -> Result<Self, StateError> {
        let private_key = crate::derive_signer_key(seed, signer_id)
            .map_err(|error| StateError::Signing(error.to_string()))?;
        Ok(Self::from_key(
            private_key,
            signer_id,
            entity_id,
            weight,
            threshold,
            delays,
        ))
    }

    /// The same identity from the key itself. The runtime derives keys from
    /// labels of its own choosing, which this process cannot reconstruct from
    /// an address; it hands over one key instead of the seed that makes them
    /// all.
    pub fn from_key(
        private_key: [u8; 32],
        signer_id: &str,
        entity_id: [u8; 32],
        weight: u128,
        threshold: u128,
        delays: BoardDelays,
    ) -> Self {
        Self {
            entity_id,
            private_key,
            weight,
            threshold,
            delays,
            signer_id: signer_id.to_string(),
        }
    }

    /// The lazy entity one key alone defines.
    pub fn lazy_from_key(
        private_key: [u8; 32],
        signer_id: &str,
        weight: u128,
        threshold: u128,
        delays: BoardDelays,
    ) -> Result<Self, StateError> {
        let address = crate::address_of_private_key(&private_key)
            .ok_or_else(|| StateError::Signing("address".to_string()))?;
        let mut member_entity_id = [0_u8; 32];
        member_entity_id[12..].copy_from_slice(&address);
        let entity_id = xln_rscore_hanko::lazy_entity_id(
            &[xln_rscore_hanko::BoardMember {
                entity_id: member_entity_id,
                weight,
            }],
            threshold,
            delays,
        );
        Ok(Self::from_key(
            private_key,
            signer_id,
            entity_id,
            weight,
            threshold,
            delays,
        ))
    }

    /// The lazy entity this key alone defines: id equals board hash, so its
    /// Hankos verify without the certified registry.
    pub fn lazy_from_seed(
        seed: &str,
        signer_id: &str,
        weight: u128,
        threshold: u128,
        delays: BoardDelays,
    ) -> Result<Self, StateError> {
        let private_key = crate::derive_signer_key(seed, signer_id)
            .map_err(|error| StateError::Signing(error.to_string()))?;
        Self::lazy_from_key(private_key, signer_id, weight, threshold, delays)
    }

    pub const fn entity_id(&self) -> &[u8; 32] {
        &self.entity_id
    }

    /// The signer id this key was derived from, so a checkpoint can carry the
    /// entity-to-signer mapping instead of a restore guessing it.
    pub fn signer_id(&self) -> &str {
        &self.signer_id
    }

    /// Whether this key alone defines the entity it signs for — a lazy entity
    /// id is the hash of its own board, so the binding is checkable without
    /// the certified registry. A registered board is not, and returns false.
    pub fn binds_lazy_entity(&self) -> bool {
        let Some(address) = crate::address_of_private_key(&self.private_key) else {
            return false;
        };
        let mut member_entity_id = [0_u8; 32];
        member_entity_id[12..].copy_from_slice(&address);
        let derived = xln_rscore_hanko::lazy_entity_id(
            &[xln_rscore_hanko::BoardMember {
                entity_id: member_entity_id,
                weight: self.weight,
            }],
            self.threshold,
            self.delays,
        );
        derived == self.entity_id
    }

    /// The signer address this identity recovers to, which the runtime uses to
    /// confirm the engine derived the key it expected.
    pub fn signer_address(&self) -> Result<[u8; 20], StateError> {
        crate::address_of_private_key(&self.private_key)
            .ok_or_else(|| StateError::Signing("address".to_string()))
    }

    /// Sign one account frame digest and wrap it as this entity's Hanko.
    pub fn sign_frame(&self, digest: &[u8; 32]) -> Result<Vec<u8>, StateError> {
        #[cfg(test)]
        TEST_SIGN_FRAME_CALLS.with(|calls| calls.set(calls.get() + 1));
        self.sign_frame_with_raw(digest).map(|(_, hanko)| hanko)
    }

    /// Produce the manifest signature and its Hanko in one signing operation.
    ///
    /// The raw signature is not caller-supplied: this method creates it from
    /// this identity's private key and immediately wraps those exact bytes.
    /// Therefore recovering the just-created signature back to the same key
    /// would add a full ECDSA verification without strengthening the boundary.
    /// Untrusted incoming Hankos still go through `verify_canonical_hanko`.
    pub fn sign_frame_with_raw(
        &self,
        digest: &[u8; 32],
    ) -> Result<([u8; 65], Vec<u8>), StateError> {
        let signature = crate::sign_digest(&self.private_key, digest)
            .ok_or_else(|| StateError::Signing("signature".to_string()))?;
        let hanko = encode_single_signer_hanko_from_signature(
            &self.entity_id,
            signature,
            self.weight,
            self.threshold,
            self.delays,
        )
        .map_err(|error| StateError::Signing(error.to_string()))?;
        Ok((signature, hanko))
    }

    /// Encode a raw signature already retained in an Entity manifest as this
    /// identity's Hanko. Recovery is checked against the identity before the
    /// signature is wrapped, so a caller cannot pair a foreign `collectedSigs`
    /// entry with our authority claim.
    pub fn encode_frame_hanko(
        &self,
        digest: &[u8; 32],
        signature: &[u8; 65],
    ) -> Result<Vec<u8>, StateError> {
        let expected = self.signer_address()?;
        if crate::recover_signer_address(digest, signature) != Some(expected) {
            return Err(StateError::Signing(
                "ENTITY_RAW_SIGNATURE_SIGNER_MISMATCH".to_string(),
            ));
        }
        encode_single_signer_hanko_from_signature(
            &self.entity_id,
            *signature,
            self.weight,
            self.threshold,
            self.delays,
        )
        .map_err(|error| StateError::Signing(error.to_string()))
    }
}

/// Check a peer's Hanko over a frame digest. Only self-authorising claims are
/// decided here; a registered-board claim is rejected unless the parent calls
/// the authority-aware incoming entrypoint with its exact certified hash.
pub fn verify_frame_hanko(
    hanko: &[u8],
    digest: &[u8; 32],
    expected_entity_id: &[u8; 32],
) -> Result<(), StateError> {
    verify_peer_hanko(
        hanko,
        digest,
        expected_entity_id,
        StateError::FrameHankoInvalid,
    )
}

/// Verify fresh bilateral money evidence against the Entity-certified current
/// board. Previous-board grace is deliberately impossible on this entrypoint.
pub fn verify_frame_hanko_with_authority(
    hanko: &[u8],
    digest: &[u8; 32],
    expected_entity_id: &[u8; 32],
    authority: Option<&CertifiedBoardAuthority>,
) -> Result<(), StateError> {
    verify_peer_hanko_with_authority(
        hanko,
        digest,
        expected_entity_id,
        authority,
        None,
        StateError::FrameHankoInvalid,
    )
}

/// Verify the second half of an already-authored bilateral frame certificate.
///
/// Unlike a fresh proposal, an ACK may have been issued before a certified
/// board rotation and delivered afterwards. The exact previous board remains
/// valid only until the registry's exclusive grace boundary; the digest and
/// peer Entity binding are unchanged.
pub fn verify_ack_hanko_with_authority(
    hanko: &[u8],
    digest: &[u8; 32],
    expected_entity_id: &[u8; 32],
    authority: Option<&CertifiedBoardAuthority>,
    entity_timestamp_ms: u64,
) -> Result<(), StateError> {
    verify_peer_hanko_with_authority(
        hanko,
        digest,
        expected_entity_id,
        authority,
        Some(entity_timestamp_ms / 1_000),
        StateError::FrameHankoInvalid,
    )
}

/// Verify historical dispute evidence. Like the ACK-certificate lane above,
/// it may use the exact previous certified board only before the exclusive
/// seven-day expiry; fresh frames and board refreshes stay current-board-only.
pub fn verify_dispute_hanko_with_authority(
    hanko: &[u8],
    digest: &[u8; 32],
    expected_entity_id: &[u8; 32],
    authority: Option<&CertifiedBoardAuthority>,
    entity_timestamp_ms: u64,
    allow_previous_board: bool,
) -> Result<(), StateError> {
    verify_peer_hanko_with_authority(
        hanko,
        digest,
        expected_entity_id,
        authority,
        allow_previous_board.then_some(entity_timestamp_ms / 1_000),
        StateError::DisputeHankoInvalid,
    )
}

fn verify_peer_hanko_with_authority(
    hanko: &[u8],
    digest: &[u8; 32],
    expected_entity_id: &[u8; 32],
    authority: Option<&CertifiedBoardAuthority>,
    previous_board_at_seconds: Option<u64>,
    invalid: fn(String) -> StateError,
) -> Result<(), StateError> {
    let Some(authority) = authority else {
        return verify_peer_hanko(hanko, digest, expected_entity_id, invalid);
    };
    authority.assert_entity(expected_entity_id)?;
    let validates_certified_board =
        |entity_id: &[u8; 32], board_hash: &[u8; 32], _claim_index: usize| {
            if entity_id != expected_entity_id {
                return false;
            }
            if board_hash == &authority.registered_board_hash {
                return true;
            }
            previous_board_at_seconds.is_some_and(|timestamp| {
                authority.previous_board_hash != [0_u8; 32]
                    && board_hash == &authority.previous_board_hash
                    && timestamp < authority.previous_board_valid_until
            })
        };
    match verify_canonical_hanko(
        hanko,
        digest,
        Some(expected_entity_id),
        Some(&validates_certified_board),
    ) {
        Ok(_) => Ok(()),
        Err(xln_rscore_hanko::HankoError::BoardAuthorityUnavailable) => {
            Err(StateError::BoardAuthorityUnavailable)
        }
        Err(error) => Err(invalid(error.to_string())),
    }
}

fn verify_peer_hanko(
    hanko: &[u8],
    digest: &[u8; 32],
    expected_entity_id: &[u8; 32],
    invalid: fn(String) -> StateError,
) -> Result<(), StateError> {
    match verify_canonical_hanko(hanko, digest, Some(expected_entity_id), None) {
        Ok(_) => Ok(()),
        Err(xln_rscore_hanko::HankoError::BoardAuthorityUnavailable) => {
            Err(StateError::BoardAuthorityUnavailable)
        }
        Err(error) => Err(invalid(error.to_string())),
    }
}

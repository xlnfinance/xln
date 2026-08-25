//! Who signs an account frame, and how its counterparty checks the signature.
//!
//! Parity targets: `buildQuorumHanko` (core/hanko/signing.ts) for the
//! single-validator shape, and `verifyHankoForHash` (same file) for the check.
//! The engine holds the runtime seed and derives its own key, so an outgoing
//! frame never leaves without a signature and an incoming one is never trusted
//! before recovery.

use xln_rscore_hanko::{BoardDelays, build_single_signer_hanko, verify_canonical_hanko};

use crate::error::StateError;

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
    use std::fmt::Write as _;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
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
        build_single_signer_hanko(
            &self.entity_id,
            digest,
            &self.private_key,
            self.weight,
            self.threshold,
            self.delays,
        )
        .map_err(|error| StateError::Signing(error.to_string()))
    }
}

/// Check a peer's Hanko over a frame digest. Only self-authorising claims are
/// decided here; anything that needs the certified board registry is reported
/// so the caller can route the input to TypeScript instead of guessing.
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

/// Check the counterparty's Hanko over the exact dispute digest rebuilt from
/// the committed Account identity. A frame Hanko cannot certify this message:
/// the two digests have different Solidity domains and both signatures must
/// be verified independently before either witness is retained.
pub fn verify_dispute_hanko(
    hanko: &[u8],
    digest: &[u8; 32],
    expected_entity_id: &[u8; 32],
) -> Result<(), StateError> {
    verify_peer_hanko(
        hanko,
        digest,
        expected_entity_id,
        StateError::DisputeHankoInvalid,
    )
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

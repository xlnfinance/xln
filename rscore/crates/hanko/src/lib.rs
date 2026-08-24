//! The Hanko proof: how an entity signs, and how its counterparty checks.
//!
//! Mirrors `core/hanko` file for file — abi, codec, claims, batch — so the two
//! implementations can be audited side by side. Board authority beyond a
//! self-authorising claim needs the certified registry TypeScript owns, and is
//! reported as `BoardAuthorityUnavailable` rather than guessed.

pub mod abi;
pub mod batch;
pub mod claims;
pub mod codec;

pub use batch::build_single_signer_hanko;
pub use claims::{
    BoardDelays, BoardMember, SemanticClaim, VerifiedHanko, hash_hanko_board_claim, lazy_entity_id,
    verify_canonical_hanko,
};
pub use codec::{HankoEnvelope, decode_hanko_envelope, encode_hanko_envelope};

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum HankoError {
    #[error("HANKO_ABI_OUT_OF_BOUNDS:{0}")]
    AbiOutOfBounds(usize),
    #[error("HANKO_ABI_SIZE_INVALID:{0}")]
    AbiSizeInvalid(usize),
    #[error("{0}")]
    Invalid(&'static str),
    /// The claim is structurally sound but only the certified board registry
    /// can say whether it speaks for its entity.
    #[error("HANKO_BOARD_AUTHORITY_UNAVAILABLE")]
    BoardAuthorityUnavailable,
    #[error("HANKO_SIGNING_FAILED")]
    SigningFailed,
}

pub type HankoResult<T> = Result<T, HankoError>;

#![forbid(unsafe_code)]

//! Signing, recovery and key derivation shared by the account engine and the
//! Hanko codec.
//!
//! Mirrors what TypeScript splits across core/account/crypto.ts and
//! core/protocol/crypto: the same seed, the same derivation, the same
//! deterministic signatures.

pub mod bip32;
pub mod bip39;
pub mod ecdsa;
pub mod hmac;
pub mod keys;

pub use ecdsa::{
    address_of_private_key, address_of_public_key, normalize_recovery_byte, recover_signer_address,
    sign_digest,
};
pub use keys::{KeyDerivationError, derive_signer_address, derive_signer_key};

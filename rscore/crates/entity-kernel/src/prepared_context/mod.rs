//! Proposer-only HTLC onion materialization.
//!
//! The resulting `PreparedHtlcEntry` rows are deterministic Entity-frame
//! context. Validators consume those rows after independently checking the
//! binding and onion decryption against the committed Account frame.

mod htlc;

pub use htlc::{
    DecodedOnionLayer, DecryptedHtlcLayer, DecryptedHtlcMaterializeInput,
    HtlcMaterializeEnvironment, HtlcMaterializeInput, PreparedAccountView, PreparedContextError,
    compute_htlc_envelope_context_hash, decode_onion_layer, decrypt_htlc_materialize_inputs,
    decrypt_opaque_htlc_layer, materialize_decrypted_htlc_entries,
    materialize_htlc_prepared_entries, required_htlc_account_tokens,
};

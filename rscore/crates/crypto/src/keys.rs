//! Signer keys derived from the runtime seed.
//!
//! Parity target: `deriveSignerKeySync` / `deriveSignerAddressSync` in
//! core/account/crypto.ts. Numeric signer ids take the BIP-39 + BIP-44 route
//! (the seed text is a mnemonic, or the entropy that encodes one); every other
//! label is an HMAC of the seed. The runtime hands the engine the same seed,
//! so both sides land on the same private key.

use sha2::{Digest, Sha256};

use crate::bip32::ExtendedKey;
use crate::bip39::{entropy_to_mnemonic, mnemonic_to_seed, validate_mnemonic};
use crate::ecdsa::address_of_private_key;
use crate::hmac::{HmacSha256, hmac};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum KeyDerivationError {
    #[error("NONCANONICAL_SIGNER_PREFIX:{0}")]
    NonCanonicalSignerPrefix(String),
    #[error("SIGNER_KEY_SCOPE_REQUIRED")]
    EmptySeed,
    #[error("SIGNER_KEY_DERIVATION_FAILED:{0}")]
    Derivation(String),
}

/// `null` in TypeScript: the id is a label, not a board index.
fn parse_signer_index(signer_id: &str) -> Result<Option<u32>, KeyDerivationError> {
    let trimmed = signer_id.trim();
    if trimmed.len() > 1
        && trimmed.starts_with('s')
        && trimmed[1..]
            .chars()
            .all(|character| character.is_ascii_digit())
    {
        return Err(KeyDerivationError::NonCanonicalSignerPrefix(
            signer_id.to_string(),
        ));
    }
    if trimmed.is_empty() || !trimmed.chars().all(|character| character.is_ascii_digit()) {
        return Ok(None);
    }
    // TypeScript parses through a float, so an id past 2^53 is not finite as an
    // integer any more; the runtime never mints one, and a parse failure here
    // is the same rejection.
    let raw: u64 = trimmed
        .parse()
        .map_err(|_| KeyDerivationError::Derivation(format!("signer index {trimmed}")))?;
    let index = if raw > 0 { raw - 1 } else { 0 };
    u32::try_from(index)
        .map(Some)
        .map_err(|_| KeyDerivationError::Derivation(format!("signer index {trimmed}")))
}

/// The mnemonic a seed resolves to: itself when it already is one, otherwise
/// the phrase encoding `sha256(seed)`.
fn resolve_mnemonic(seed: &str) -> Result<String, KeyDerivationError> {
    let normalized = seed.trim().to_lowercase();
    let normalized = normalized
        .split_ascii_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if validate_mnemonic(&normalized) {
        return Ok(normalized);
    }
    let entropy = Sha256::digest(seed.as_bytes());
    entropy_to_mnemonic(&entropy)
        .ok_or_else(|| KeyDerivationError::Derivation("entropy".to_string()))
}

/// The account path ethers builds for an indexed account: one hardened
/// account, indexed on the address leg (`getIndexedAccountPath`).
fn indexed_account_path(index: u32) -> String {
    format!("m/44'/60'/0'/0/{index}")
}

pub fn derive_signer_key(seed: &str, signer_id: &str) -> Result<[u8; 32], KeyDerivationError> {
    if seed.is_empty() {
        return Err(KeyDerivationError::EmptySeed);
    }
    let Some(index) = parse_signer_index(signer_id)? else {
        let material = hmac::<HmacSha256>(seed.as_bytes(), signer_id.as_bytes());
        return <[u8; 32]>::try_from(material.as_slice())
            .map_err(|_| KeyDerivationError::Derivation("hmac".to_string()));
    };
    let mnemonic = resolve_mnemonic(seed)?;
    let extended = ExtendedKey::from_seed(&mnemonic_to_seed(&mnemonic))
        .ok_or_else(|| KeyDerivationError::Derivation("master".to_string()))?;
    let derived = extended
        .derive_path(&indexed_account_path(index))
        .ok_or_else(|| KeyDerivationError::Derivation("path".to_string()))?;
    Ok(derived.secret.secret_bytes())
}

pub fn derive_signer_address(seed: &str, signer_id: &str) -> Result<[u8; 20], KeyDerivationError> {
    let key = derive_signer_key(seed, signer_id)?;
    address_of_private_key(&key)
        .ok_or_else(|| KeyDerivationError::Derivation("address".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Vectors produced by the TypeScript deriver (scratchpad/keyvec.ts), over
    /// both seed shapes the runtime uses: hex text and a free-form phrase.
    #[test]
    fn matches_typescript_derivation_vectors() {
        let cases: [(&str, &str, &str, &str); 10] = [
            (
                "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a",
                "1",
                "309b1f6e8dd69428a1954d7ab5ef05460264d9885d1cee151ccb277b9f27d01e",
                "8993c66ca61106471efbaae153d3be7200185caa",
            ),
            (
                "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a",
                "2",
                "2ce89ceb500c7ede526d25d6e511cb28acaa283680dcb8975e571ccffdd1143d",
                "7ec887a160ec056ff7ba197277e1e79e006029bd",
            ),
            (
                "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a",
                "7",
                "d06e0075e0105dfd6aa134a38c6ca45e6e4d47b438184b17f019dab2d731e504",
                "4cf63b133b89ce63819b397c2a713f2fbb8d3fb2",
            ),
            (
                "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a",
                "alice",
                "178df9fade9c8910886aeee7cef60ade86f8ff3bec90f0bb4e6762fc44dfeef4",
                "873a62d283912bea879edc99ce1d6f6844361d3d",
            ),
            (
                "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a",
                "hub-1",
                "530e3c7e364f96b94e36a22156c9856cc299d1d569bddfdacbef987d57abba09",
                "72ab68518090cd9a70a9012e672b9a64ffcfdb38",
            ),
            (
                "canonical test seed for xln rscore",
                "1",
                "106c4c9b9bafdf5fbd2b5967921cc241b49a235172e3de020087561df7c07460",
                "9da615edc99974ba4c4a764e3b72553c68fbb627",
            ),
            (
                "canonical test seed for xln rscore",
                "2",
                "ed62390f13e7912ace45b6813eae20b533226dfee0900972c377276b27107cbe",
                "ba88be0c294a373c6b9f68c3235d844848395bb4",
            ),
            (
                "canonical test seed for xln rscore",
                "7",
                "846560bb89f27d0d9b9233dcd519e0a5df0a554e0d839e5bf9cf517443941909",
                "0e54147c0571395ef9cb5d0cea9cb28fd9622b37",
            ),
            (
                "canonical test seed for xln rscore",
                "alice",
                "d6e9c3b4b2caebb5ee3c952d9cad968f43c4039c393f6646a8a9e14895620713",
                "ebb5588cc222afad36276bf93eecfcde97ad1925",
            ),
            (
                "canonical test seed for xln rscore",
                "hub-1",
                "454f30cda8c7998acc2e7db22e25241828258f6db71a292d7ffa5a54be0b9dde",
                "b0ef20d98c9da14ff7dd106e6a9462ba7bf17def",
            ),
        ];
        for (seed, signer_id, private_key, address) in cases {
            assert_eq!(
                hex::encode(derive_signer_key(seed, signer_id).expect("key")),
                private_key,
                "private key for {signer_id}",
            );
            assert_eq!(
                hex::encode(derive_signer_address(seed, signer_id).expect("address")),
                address,
                "address for {signer_id}",
            );
        }
    }

    #[test]
    fn rejects_the_noncanonical_signer_prefix() {
        assert_eq!(
            derive_signer_key("seed", "s1"),
            Err(KeyDerivationError::NonCanonicalSignerPrefix(
                "s1".to_string()
            )),
        );
    }
}

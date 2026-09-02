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
    #[error(
        "SIGNER_INDEX_INVALID: signerId \"{0}\" must be a canonical decimal integer from 1 to 2147483648"
    )]
    InvalidSignerIndex(String),
    #[error("SIGNER_KEY_SCOPE_REQUIRED")]
    EmptySeed,
    #[error("SIGNER_KEY_DERIVATION_FAILED:{0}")]
    Derivation(String),
}

/// JavaScript's `\s`, which is what `resolveMnemonic` collapses. Rust's own
/// `is_whitespace` covers all of it except the byte-order mark.
fn is_js_whitespace(character: char) -> bool {
    character.is_whitespace() || character == '\u{feff}'
}

/// `null` in TypeScript: the id is a label, not a board index.
fn parse_signer_index(signer_id: &str) -> Result<Option<u32>, KeyDerivationError> {
    const MAX_SIGNER_NUMBER: &str = "2147483648";

    let trimmed = signer_id.trim_matches(is_js_whitespace);
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
    // Signer numbers are one-based while the final non-hardened BIP-32 path
    // leg is zero-based and strictly below 2^31. An invalid all-digit value
    // must never fall through to HMAC label derivation and select another key.
    if trimmed.starts_with('0')
        || trimmed.len() > MAX_SIGNER_NUMBER.len()
        || (trimmed.len() == MAX_SIGNER_NUMBER.len() && trimmed > MAX_SIGNER_NUMBER)
    {
        return Err(KeyDerivationError::InvalidSignerIndex(
            signer_id.to_string(),
        ));
    }
    let signer_number = trimmed
        .parse::<u32>()
        .map_err(|_| KeyDerivationError::InvalidSignerIndex(signer_id.to_string()))?;
    Ok(Some(signer_number - 1))
}

/// The mnemonic a seed resolves to: itself when it already is one, otherwise
/// the phrase encoding `sha256(seed)`.
fn resolve_mnemonic(seed: &str) -> Result<String, KeyDerivationError> {
    // TypeScript trims the seed text once and derives everything from that
    // trimmed value, mnemonic or not: a seed read from a file with a trailing
    // newline must still mint the same key.
    let seed_text = seed.trim();
    let lowered = seed_text.to_lowercase();
    let normalized = lowered
        .split(is_js_whitespace)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if validate_mnemonic(&normalized) {
        return Ok(normalized);
    }
    let entropy = Sha256::digest(seed_text.as_bytes());
    entropy_to_mnemonic(&entropy)
        .ok_or_else(|| KeyDerivationError::Derivation("entropy".to_string()))
}

/// The account path ethers builds for an indexed account: one hardened
/// account, indexed on the address leg (`getIndexedAccountPath`).
fn indexed_account_path(index: u32) -> String {
    format!("m/44'/60'/0'/0/{index}")
}

pub fn derive_signer_key(seed: &str, signer_id: &str) -> Result<[u8; 32], KeyDerivationError> {
    let Some(index) = parse_signer_index(signer_id)? else {
        // The label route never touches the signer keystore, so TypeScript
        // derives it even for an empty seed. Only the indexed route requires a
        // scope, and rejects an empty one.
        let material = hmac::<HmacSha256>(seed.as_bytes(), signer_id.as_bytes());
        return <[u8; 32]>::try_from(material.as_slice())
            .map_err(|_| KeyDerivationError::Derivation("hmac".to_string()));
    };
    if seed.is_empty() {
        return Err(KeyDerivationError::EmptySeed);
    }
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

    const SIGNER_INDEX_VECTOR_SEED: &str = "signer-index-boundary-seed";
    const SIGNER_INDEX_VECTORS: &str =
        include_str!("../../../../core/__tests__/account/tooling/signer-index-vectors.txt");

    #[test]
    fn matches_shared_strict_signer_index_boundary_vectors() {
        for row in SIGNER_INDEX_VECTORS
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
        {
            let (signer_id, expected) = row.split_once('|').expect("valid signer index vector");
            let result = derive_signer_key(SIGNER_INDEX_VECTOR_SEED, signer_id);
            if expected == "SIGNER_INDEX_INVALID" {
                assert_eq!(
                    result,
                    Err(KeyDerivationError::InvalidSignerIndex(
                        signer_id.to_string()
                    )),
                    "invalid signer index {signer_id}",
                );
                continue;
            }
            assert_eq!(
                hex::encode(result.expect("signer key")),
                expected,
                "private key for {signer_id}",
            );
        }
    }

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

    /// Seeds arrive from files and environments with stray whitespace, and a
    /// mnemonic may be joined by non-breaking spaces. Both sides must land on
    /// the same key regardless.
    #[test]
    fn normalises_the_seed_the_way_typescript_does() {
        let padded =
            derive_signer_key("  canonical test seed for xln rscore  ", "1").expect("padded seed");
        assert_eq!(
            hex::encode(padded),
            "106c4c9b9bafdf5fbd2b5967921cc241b49a235172e3de020087561df7c07460",
        );
        let spaced = "abandon abandon abandon abandon abandon abandon abandon abandon \
                      abandon abandon abandon about";
        let nbsp = spaced.replace(' ', "\u{a0}");
        // Vectors from the TypeScript deriver (scratchpad/normvec.ts): the
        // mnemonic route, reached through either spacing.
        for phrase in [spaced, nbsp.as_str()] {
            assert_eq!(
                hex::encode(derive_signer_key(phrase, "1").expect("mnemonic seed")),
                "1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727",
            );
        }
    }

    /// The label route works without a seed scope.
    #[test]
    fn derives_non_numeric_labels_the_way_typescript_does() {
        assert_eq!(
            hex::encode(derive_signer_key("", "alice").expect("empty seed, label route")),
            "ce3837f76a54a635191b1704ac7672264fc17c3397ff52e7dacfc1ef3603a493",
        );
        assert_eq!(
            derive_signer_key("", "1"),
            Err(KeyDerivationError::EmptySeed)
        );
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

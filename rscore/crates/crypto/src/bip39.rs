//! BIP-39 mnemonic encoding, only as far as key derivation needs it.
//!
//! Parity target: `resolveMnemonic` in core/account/crypto.ts. A seed that is
//! already a valid mnemonic is used verbatim; anything else is hashed to 32
//! bytes of entropy and re-encoded as a 24-word phrase.

use sha2::{Digest, Sha256};

use crate::hmac::pbkdf2_sha512_one_block;

const WORDLIST: &str = include_str!("wordlist_english.txt");
const PBKDF2_ROUNDS: u32 = 2048;

fn words() -> &'static [&'static str] {
    use std::sync::OnceLock;
    static WORDS: OnceLock<Vec<&'static str>> = OnceLock::new();
    WORDS.get_or_init(|| WORDLIST.split_ascii_whitespace().collect())
}

/// Encode entropy as a mnemonic. Entropy must be 16..=32 bytes, a multiple of
/// four, exactly as BIP-39 requires.
pub fn entropy_to_mnemonic(entropy: &[u8]) -> Option<String> {
    if entropy.len() < 16 || entropy.len() > 32 || !entropy.len().is_multiple_of(4) {
        return None;
    }
    let checksum_bits = entropy.len() / 4;
    let checksum = Sha256::digest(entropy)[0];
    let mut bits = Vec::with_capacity(entropy.len() * 8 + checksum_bits);
    for byte in entropy {
        for shift in (0..8).rev() {
            bits.push((byte >> shift) & 1);
        }
    }
    for shift in 0..checksum_bits {
        bits.push((checksum >> (7 - shift)) & 1);
    }
    let vocabulary = words();
    let mut phrase = String::with_capacity(bits.len() / 11 * 8);
    for chunk in bits.chunks(11) {
        let index = chunk
            .iter()
            .fold(0_usize, |value, bit| (value << 1) | usize::from(*bit));
        if !phrase.is_empty() {
            phrase.push(' ');
        }
        phrase.push_str(vocabulary[index]);
    }
    Some(phrase)
}

/// Whether a phrase is a valid mnemonic: known words, and a checksum that
/// matches the entropy they encode.
pub fn validate_mnemonic(phrase: &str) -> bool {
    let vocabulary = words();
    let parts: Vec<&str> = phrase.split_ascii_whitespace().collect();
    if parts.len() < 12 || parts.len() > 24 || !parts.len().is_multiple_of(3) {
        return false;
    }
    let mut bits = Vec::with_capacity(parts.len() * 11);
    for part in &parts {
        let Ok(index) = vocabulary.binary_search(part) else {
            return false;
        };
        for shift in (0..11).rev() {
            bits.push(((index >> shift) & 1) as u8);
        }
    }
    let entropy_bits = parts.len() * 11 * 32 / 33;
    let entropy: Vec<u8> = bits[..entropy_bits]
        .chunks(8)
        .map(|chunk| chunk.iter().fold(0_u8, |value, bit| (value << 1) | *bit))
        .collect();
    let checksum = Sha256::digest(&entropy)[0];
    bits[entropy_bits..]
        .iter()
        .enumerate()
        .all(|(shift, bit)| *bit == (checksum >> (7 - shift)) & 1)
}

/// BIP-39 seed: PBKDF2-HMAC-SHA-512 over the phrase with the `mnemonic` salt.
/// Passphrases are not derived anywhere in the TypeScript runtime, so the salt
/// has no suffix.
pub fn mnemonic_to_seed(phrase: &str) -> [u8; 64] {
    pbkdf2_sha512_one_block(phrase.as_bytes(), b"mnemonic", PBKDF2_ROUNDS)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The canonical all-zero-entropy vector from the BIP-39 specification.
    #[test]
    fn matches_bip39_reference_vector() {
        let mnemonic = entropy_to_mnemonic(&[0_u8; 16]).expect("mnemonic");
        assert_eq!(
            mnemonic,
            "abandon abandon abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon about",
        );
        assert!(validate_mnemonic(&mnemonic));
        assert_eq!(
            hex::encode(mnemonic_to_seed(&mnemonic)),
            "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1\
             9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4",
        );
    }

    #[test]
    fn rejects_a_broken_checksum() {
        assert!(!validate_mnemonic(
            "abandon abandon abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon abandon"
        ));
        assert!(!validate_mnemonic("not even a word list"));
    }
}

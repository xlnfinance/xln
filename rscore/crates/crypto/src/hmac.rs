//! HMAC and PBKDF2 over SHA-256/SHA-512.
//!
//! TypeScript reaches for `@noble/hashes`; this is the same construction with
//! the two digests the key derivation needs, so no dependency carries it.

use sha2::{Digest, Sha256, Sha512};

/// One HMAC instantiation: block size, output size, and the digest itself.
pub trait HmacDigest {
    const BLOCK: usize;
    const OUTPUT: usize;
    fn digest(chunks: &[&[u8]]) -> Vec<u8>;
}

pub struct HmacSha256;
pub struct HmacSha512;

impl HmacDigest for HmacSha256 {
    const BLOCK: usize = 64;
    const OUTPUT: usize = 32;

    fn digest(chunks: &[&[u8]]) -> Vec<u8> {
        let mut hasher = Sha256::new();
        for chunk in chunks {
            hasher.update(chunk);
        }
        hasher.finalize().to_vec()
    }
}

impl HmacDigest for HmacSha512 {
    const BLOCK: usize = 128;
    const OUTPUT: usize = 64;

    fn digest(chunks: &[&[u8]]) -> Vec<u8> {
        let mut hasher = Sha512::new();
        for chunk in chunks {
            hasher.update(chunk);
        }
        hasher.finalize().to_vec()
    }
}

pub fn hmac<D: HmacDigest>(key: &[u8], message: &[u8]) -> Vec<u8> {
    let mut padded = vec![0_u8; D::BLOCK];
    if key.len() > D::BLOCK {
        padded[..D::OUTPUT].copy_from_slice(&D::digest(&[key]));
    } else {
        padded[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = vec![0x36_u8; D::BLOCK];
    let mut outer_pad = vec![0x5c_u8; D::BLOCK];
    for index in 0..D::BLOCK {
        inner_pad[index] ^= padded[index];
        outer_pad[index] ^= padded[index];
    }
    let inner = D::digest(&[&inner_pad, message]);
    D::digest(&[&outer_pad, &inner])
}

/// PBKDF2 for a single output block, which is all BIP-39 asks for (64 bytes
/// from HMAC-SHA-512).
pub fn pbkdf2_sha512_one_block(password: &[u8], salt: &[u8], rounds: u32) -> [u8; 64] {
    let mut block = Vec::with_capacity(salt.len() + 4);
    block.extend_from_slice(salt);
    block.extend_from_slice(&1_u32.to_be_bytes());
    let mut current = hmac::<HmacSha512>(password, &block);
    let mut output = current.clone();
    for _ in 1..rounds {
        current = hmac::<HmacSha512>(password, &current);
        for (accumulated, next) in output.iter_mut().zip(current.iter()) {
            *accumulated ^= next;
        }
    }
    let mut result = [0_u8; 64];
    result.copy_from_slice(&output);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 4231 test case 2.
    #[test]
    fn matches_rfc4231_vectors() {
        let mac = hmac::<HmacSha256>(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(
            hex::encode(mac),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
        );
        let mac = hmac::<HmacSha512>(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(
            hex::encode(mac),
            "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea250554\
             9758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737",
        );
    }

    /// A long key is hashed down first — the branch the short vectors skip.
    #[test]
    fn hashes_keys_longer_than_the_block() {
        let mac = hmac::<HmacSha256>(
            &[0xaa_u8; 131],
            b"Test Using Larger Than Block-Size Key - Hash Key First",
        );
        assert_eq!(
            hex::encode(mac),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
        );
    }
}

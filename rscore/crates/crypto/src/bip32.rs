//! BIP-32 private derivation over secp256k1, enough for the account paths the
//! runtime uses (`m/44'/60'/n'/0/0`).

use secp256k1::{Secp256k1, SecretKey, SignOnly};
use std::sync::OnceLock;

use crate::hmac::{HmacSha512, hmac};

const HARDENED: u32 = 0x8000_0000;

fn context() -> &'static Secp256k1<SignOnly> {
    static CONTEXT: OnceLock<Secp256k1<SignOnly>> = OnceLock::new();
    CONTEXT.get_or_init(Secp256k1::signing_only)
}

#[derive(Clone)]
pub struct ExtendedKey {
    pub secret: SecretKey,
    pub chain_code: [u8; 32],
}

impl ExtendedKey {
    /// Master key from a BIP-39 seed.
    pub fn from_seed(seed: &[u8]) -> Option<Self> {
        let material = hmac::<HmacSha512>(b"Bitcoin seed", seed);
        Self::split(&material)
    }

    fn split(material: &[u8]) -> Option<Self> {
        let secret =
            SecretKey::from_byte_array(<[u8; 32]>::try_from(&material[..32]).ok()?).ok()?;
        let mut chain_code = [0_u8; 32];
        chain_code.copy_from_slice(&material[32..]);
        Some(Self { secret, chain_code })
    }

    pub fn derive_child(&self, index: u32) -> Option<Self> {
        let mut data = Vec::with_capacity(37);
        if index >= HARDENED {
            data.push(0);
            data.extend_from_slice(&self.secret.secret_bytes());
        } else {
            data.extend_from_slice(&self.secret.public_key(context()).serialize());
        }
        data.extend_from_slice(&index.to_be_bytes());
        let material = hmac::<HmacSha512>(&self.chain_code, &data);
        let tweak =
            secp256k1::Scalar::from_be_bytes(<[u8; 32]>::try_from(&material[..32]).ok()?).ok()?;
        let secret = self.secret.add_tweak(&tweak).ok()?;
        let mut chain_code = [0_u8; 32];
        chain_code.copy_from_slice(&material[32..]);
        Some(Self { secret, chain_code })
    }

    /// Derive along a path written the way ethers writes it: `m/44'/60'/0'/0/0`.
    pub fn derive_path(&self, path: &str) -> Option<Self> {
        let mut current = self.clone();
        for (position, segment) in path.split('/').enumerate() {
            if position == 0 {
                if segment != "m" {
                    return None;
                }
                continue;
            }
            let hardened = segment.ends_with('\'') || segment.ends_with('h');
            let digits = segment.trim_end_matches(['\'', 'h']);
            let index: u32 = digits.parse().ok()?;
            if index >= HARDENED {
                return None;
            }
            current = current.derive_child(if hardened { index + HARDENED } else { index })?;
        }
        Some(current)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// BIP-32 test vector 1: chain m/0'.
    #[test]
    fn matches_bip32_reference_vector() {
        let seed = hex::decode("000102030405060708090a0b0c0d0e0f").expect("seed");
        let master = ExtendedKey::from_seed(&seed).expect("master");
        assert_eq!(
            hex::encode(master.secret.secret_bytes()),
            "e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35",
        );
        let child = master.derive_path("m/0'").expect("child");
        assert_eq!(
            hex::encode(child.secret.secret_bytes()),
            "edb2e14f9ee77d26dd93b4ecede8d16ed408ce149b6cd80b0715a2d911a0afea",
        );
        let deep = master.derive_path("m/0'/1/2'/2/1000000000").expect("deep");
        assert_eq!(
            hex::encode(deep.secret.secret_bytes()),
            "471b76e389e528d6de6d816857e012c5455051cad6660850e58372a6c3e6e7c8",
        );
    }
}

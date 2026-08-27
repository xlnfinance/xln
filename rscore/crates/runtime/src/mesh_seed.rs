//! Exact Rust mirror of `core/orchestrator/mesh/mesh-seeds.ts`.

use thiserror::Error;
use xln_rscore_crypto::hmac::{HmacSha256, hmac};

const DOMAIN: &str = "xln:mesh-child-seed:v1";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MeshSeedError {
    #[error("XLN_MESH_ROOT_SEED_MISSING")]
    MissingRoot,
    #[error("XLN_MESH_CHILD_SEED_PURPOSE_MISSING")]
    MissingPurpose,
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len().saturating_mul(2));
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

pub fn derive_mesh_child_seed(root_seed: &str, purpose: &str) -> Result<String, MeshSeedError> {
    if root_seed.is_empty() {
        return Err(MeshSeedError::MissingRoot);
    }
    let purpose = purpose.trim().to_lowercase();
    if purpose.is_empty() {
        return Err(MeshSeedError::MissingPurpose);
    }
    let message = format!("{DOMAIN}|{purpose}");
    Ok(hex(&hmac::<HmacSha256>(
        root_seed.as_bytes(),
        message.as_bytes(),
    )))
}

#[cfg(test)]
mod tests {
    use super::derive_mesh_child_seed;

    #[test]
    fn matches_typescript_mesh_seed_derivation() {
        assert_eq!(
            derive_mesh_child_seed("root", "runtime:H1").expect("valid fixture"),
            "c702821b13ff485c9a0dd3ea115ed5a4887d1d5d692e393379e930ed9949cacf",
        );
    }
}

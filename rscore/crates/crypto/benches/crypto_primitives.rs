//! Diagnostic-only benchmark for the exact Rust crypto primitives xln uses.
//! It emits wall time, never TPS. Run through `bun run bench:crypto:rust` so
//! the machine-wide stand lock is held for the full trial.

use secp256k1::ecdsa::{RecoverableSignature, RecoveryId};
use secp256k1::{Message, Secp256k1, SecretKey};
use sha2::{Digest as _, Sha256};
use sha3::Keccak256;
use std::hint::black_box;
use std::time::Instant;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret};
use xln_rscore_crypto::hmac::{HmacSha256, hmac};
use xln_rscore_crypto::{recover_signer_address, sign_digest};

fn parallel_micros<F>(count: usize, workers: usize, operation: &F) -> (u64, u128)
where
    F: Fn(usize) -> u64 + Sync,
{
    let started = Instant::now();
    let checksum = std::thread::scope(|scope| {
        let handles = (0..workers)
            .map(|worker| {
                let start = count * worker / workers;
                let end = count * (worker + 1) / workers;
                scope.spawn(move || {
                    (start..end).fold(0_u64, |checksum, index| {
                        checksum ^ black_box(operation(index))
                    })
                })
            })
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .map(|handle| handle.join().expect("crypto benchmark worker"))
            .fold(0_u64, |left, right| left ^ right)
    });
    (checksum, started.elapsed().as_micros())
}

fn numeric_arguments() -> Vec<usize> {
    std::env::args()
        .skip(1)
        .filter_map(|value| {
            if value == "--bench" {
                None
            } else {
                Some(value.parse::<usize>().expect("positive integer argument"))
            }
        })
        .map(|value| value.max(1))
        .collect()
}

fn main() {
    let arguments = numeric_arguments();
    let count = arguments.first().copied().unwrap_or(1_000);
    let max_workers = arguments.get(1).copied().unwrap_or(16);
    let private_key = [7_u8; 32];
    let digest = [11_u8; 32];
    let payload = [0x2b_u8; 64];
    let x25519_private = [13_u8; 32];
    let x25519_peer_public = X25519PublicKey::from(&StaticSecret::from([17_u8; 32]));
    let signature = sign_digest(&private_key, &digest).expect("signature");
    let secret = SecretKey::from_byte_array(private_key).expect("private key");
    let public_key = secret.public_key(&Secp256k1::signing_only());
    let recovery_id = RecoveryId::try_from(i32::from(signature[64])).expect("recovery id");
    let standard = RecoverableSignature::from_compact(&signature[..64], recovery_id)
        .expect("recoverable signature")
        .to_standard();

    for workers in [1_usize, 4, 8, 16]
        .into_iter()
        .filter(|workers| *workers <= max_workers)
    {
        let (keccak_checksum, keccak_us) = parallel_micros(count, workers, &|_| {
            u64::from(Keccak256::digest(payload)[0])
        });
        let (sha_checksum, sha_us) =
            parallel_micros(count, workers, &|_| u64::from(Sha256::digest(payload)[0]));
        let (hmac_checksum, hmac_us) = parallel_micros(count, workers, &|_| {
            u64::from(hmac::<HmacSha256>(&private_key, &payload)[0])
        });
        let (x25519_checksum, x25519_us) = parallel_micros(count, workers, &|_| {
            u64::from(
                StaticSecret::from(x25519_private)
                    .diffie_hellman(&x25519_peer_public)
                    .to_bytes()[0],
            )
        });
        let (sign_checksum, sign_us) = parallel_micros(count, workers, &|_| {
            u64::from(sign_digest(&private_key, &digest).expect("sign")[0])
        });
        let (recover_checksum, recover_us) = parallel_micros(count, workers, &|_| {
            u64::from(recover_signer_address(&digest, &signature).expect("recover")[0])
        });
        let verify = Secp256k1::verification_only();
        let (verify_checksum, verify_us) = parallel_micros(count, workers, &|_| {
            u64::from(
                verify
                    .verify_ecdsa(Message::from_digest(digest), &standard, &public_key)
                    .is_ok(),
            )
        });
        println!(
            "{{\"schema\":\"xln-crypto-primitives-diagnostic-v1\",\"authority\":\"DIAGNOSTIC_ONLY_NOT_TPS\",\"engine\":\"rust-production-primitives\",\"count\":{count},\"workers\":{workers},\"inputBytes\":{},\"wallMs\":{{\"keccak256\":{},\"sha256\":{},\"hmacSha256\":{},\"x25519\":{},\"ecdsaSign\":{},\"ecdsaRecoverAddress\":{},\"ecdsaKnownKeyVerify\":{}}},\"checksum\":{}}}",
            payload.len(),
            keccak_us as f64 / 1_000.0,
            sha_us as f64 / 1_000.0,
            hmac_us as f64 / 1_000.0,
            x25519_us as f64 / 1_000.0,
            sign_us as f64 / 1_000.0,
            recover_us as f64 / 1_000.0,
            verify_us as f64 / 1_000.0,
            keccak_checksum
                ^ sha_checksum
                ^ hmac_checksum
                ^ x25519_checksum
                ^ sign_checksum
                ^ recover_checksum
                ^ verify_checksum,
        );
    }
}

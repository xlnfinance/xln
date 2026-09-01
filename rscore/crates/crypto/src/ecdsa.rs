//! secp256k1 signing and recovery over a raw 32-byte digest.
//!
//! Parity target: `signDigestBytesWithPrivateKey` and
//! `recoverAddressFromDigestSignature` in core/account/crypto.ts. Both sides
//! sign the digest directly — no message prefix, no second hash — and both
//! produce RFC 6979 deterministic signatures with a low `s`.

use secp256k1::ecdsa::{RecoverableSignature, RecoveryId};
use secp256k1::{Message, Secp256k1, SecretKey, SignOnly, VerifyOnly};
use sha3::{Digest, Keccak256};
use std::cell::RefCell;
use std::collections::{HashSet, VecDeque};
use std::sync::OnceLock;
use std::time::Instant;

const RECOVERY_PROFILE_RECENT_INPUTS: usize = 2_048;

/// Transient per-thread evidence for locating repeated ECDSA recovery work.
///
/// Resident Account workers are permanent threads, so their snapshots are
/// naturally per-worker. These counters never enter a replica, frame, root or
/// WAL record and are active only under an explicit profiling environment.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EcdsaRecoveryProfileSnapshot {
    /// All attempted recoveries, including malformed signatures.
    pub calls: u64,
    /// Inputs repeated within the last 2,048 unique `(digest, signature)`
    /// pairs on this thread. The bounded window makes the metric DoS-safe.
    pub exact_repeats: u64,
    /// Curve recovery plus address derivation; profiler bookkeeping excluded.
    pub wall_nanos: u64,
}

impl EcdsaRecoveryProfileSnapshot {
    #[must_use]
    pub fn saturating_delta(self, earlier: Self) -> Self {
        Self {
            calls: self.calls.saturating_sub(earlier.calls),
            exact_repeats: self.exact_repeats.saturating_sub(earlier.exact_repeats),
            wall_nanos: self.wall_nanos.saturating_sub(earlier.wall_nanos),
        }
    }
}

#[derive(Default)]
struct EcdsaRecoveryProfile {
    snapshot: EcdsaRecoveryProfileSnapshot,
    recent: HashSet<[u8; 97]>,
    order: VecDeque<[u8; 97]>,
}

impl EcdsaRecoveryProfile {
    fn record(&mut self, digest: &[u8; 32], signature: &[u8; 65], wall_nanos: u64) {
        let mut key = [0_u8; 97];
        key[..32].copy_from_slice(digest);
        key[32..].copy_from_slice(signature);
        self.snapshot.calls = self.snapshot.calls.saturating_add(1);
        self.snapshot.wall_nanos = self.snapshot.wall_nanos.saturating_add(wall_nanos);
        if self.recent.contains(&key) {
            self.snapshot.exact_repeats = self.snapshot.exact_repeats.saturating_add(1);
            return;
        }
        if self.order.len() == RECOVERY_PROFILE_RECENT_INPUTS
            && let Some(expired) = self.order.pop_front()
        {
            self.recent.remove(&expired);
        }
        self.recent.insert(key);
        self.order.push_back(key);
    }
}

std::thread_local! {
    static ECDSA_RECOVERY_PROFILE: RefCell<EcdsaRecoveryProfile> = RefCell::default();
}

fn recovery_profile_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("XLN_RSCORE_PROFILE_CRYPTO").as_deref() == Ok("1")
            || std::env::var("XLN_RSCORE_PROFILE_ENTITY").as_deref() == Ok("1")
    })
}

#[must_use]
pub fn ecdsa_recovery_profile_snapshot() -> EcdsaRecoveryProfileSnapshot {
    if !recovery_profile_enabled() {
        return EcdsaRecoveryProfileSnapshot::default();
    }
    ECDSA_RECOVERY_PROFILE.with(|profile| profile.borrow().snapshot)
}

fn verify_context() -> &'static Secp256k1<VerifyOnly> {
    static CONTEXT: OnceLock<Secp256k1<VerifyOnly>> = OnceLock::new();
    CONTEXT.get_or_init(Secp256k1::verification_only)
}

fn sign_context() -> &'static Secp256k1<SignOnly> {
    static CONTEXT: OnceLock<Secp256k1<SignOnly>> = OnceLock::new();
    CONTEXT.get_or_init(Secp256k1::signing_only)
}

/// Accept both encodings of the recovery byte: 0/1 as the raw parity, and
/// 27/28 as Ethereum writes it.
pub fn normalize_recovery_byte(value: u8) -> Option<u8> {
    match value {
        0 | 1 => Some(value),
        27 | 28 => Some(value - 27),
        _ => None,
    }
}

/// The Ethereum address of a public key: last 20 bytes of its keccak hash.
pub fn address_of_public_key(public_key: &secp256k1::PublicKey) -> [u8; 20] {
    let uncompressed = public_key.serialize_uncompressed();
    let hash = Keccak256::digest(&uncompressed[1..]);
    let mut address = [0_u8; 20];
    address.copy_from_slice(&hash[12..]);
    address
}

/// Recover the signer address, or `None` when the signature does not belong to
/// any public key over this digest.
pub fn recover_signer_address(digest: &[u8; 32], signature: &[u8; 65]) -> Option<[u8; 20]> {
    let profiling = recovery_profile_enabled();
    let started = profiling.then(Instant::now);
    let result = (|| {
        let recovery =
            RecoveryId::try_from(i32::from(normalize_recovery_byte(signature[64])?)).ok()?;
        let recoverable = RecoverableSignature::from_compact(&signature[..64], recovery).ok()?;
        let recovered = verify_context()
            .recover_ecdsa(Message::from_digest(*digest), &recoverable)
            .ok()?;
        Some(address_of_public_key(&recovered))
    })();
    if let Some(started) = started {
        let wall_nanos = u64::try_from(started.elapsed().as_nanos()).unwrap_or(u64::MAX);
        ECDSA_RECOVERY_PROFILE.with(|profile| {
            profile.borrow_mut().record(digest, signature, wall_nanos);
        });
    }
    result
}

/// Sign a digest. The returned byte 64 is the raw parity (0 or 1), matching
/// what `signDigestBytesWithPrivateKey` returns as `recovery`.
pub fn sign_digest(private_key: &[u8; 32], digest: &[u8; 32]) -> Option<[u8; 65]> {
    let secret = SecretKey::from_byte_array(*private_key).ok()?;
    let signed = sign_context().sign_ecdsa_recoverable(Message::from_digest(*digest), &secret);
    let (recovery, compact) = signed.serialize_compact();
    let mut signature = [0_u8; 65];
    signature[..64].copy_from_slice(&compact);
    signature[64] = u8::try_from(i32::from(recovery)).ok()?;
    Some(signature)
}

/// The address a private key signs as.
pub fn address_of_private_key(private_key: &[u8; 32]) -> Option<[u8; 20]> {
    let secret = SecretKey::from_byte_array(*private_key).ok()?;
    Some(address_of_public_key(&secret.public_key(sign_context())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_profile_counts_exact_recent_inputs() {
        let mut profile = EcdsaRecoveryProfile::default();
        let digest = [3_u8; 32];
        let signature = [4_u8; 65];
        profile.record(&digest, &signature, 11);
        profile.record(&digest, &signature, 13);
        profile.record(&[5_u8; 32], &signature, 17);
        assert_eq!(
            profile.snapshot,
            EcdsaRecoveryProfileSnapshot {
                calls: 3,
                exact_repeats: 1,
                wall_nanos: 41,
            }
        );
        assert_eq!(
            profile
                .snapshot
                .saturating_delta(EcdsaRecoveryProfileSnapshot {
                    calls: 1,
                    exact_repeats: 0,
                    wall_nanos: 10,
                }),
            EcdsaRecoveryProfileSnapshot {
                calls: 2,
                exact_repeats: 1,
                wall_nanos: 31,
            }
        );
    }

    /// Vectors produced by the TypeScript signer (scratchpad/keyvec.ts).
    #[test]
    fn signs_and_recovers_the_typescript_vector() {
        let private_key: [u8; 32] =
            hex::decode("309b1f6e8dd69428a1954d7ab5ef05460264d9885d1cee151ccb277b9f27d01e")
                .expect("key")
                .try_into()
                .expect("32 bytes");
        let digest = [0x3b_u8; 32];
        let signature = sign_digest(&private_key, &digest).expect("signature");
        assert_eq!(
            hex::encode(&signature[..64]),
            "61332b5c9c7f39991b3a588f0bc51d3411b81c0c2e0242d7bd9bd748b77b4403\
             2414936d7b252c4d0de2693d61a6d05f6a71dea6970b0f4a5ffb2f10005b940a",
        );
        assert_eq!(signature[64], 1);
        assert_eq!(
            hex::encode(recover_signer_address(&digest, &signature).expect("address")),
            "8993c66ca61106471efbaae153d3be7200185caa",
        );
        assert_eq!(
            hex::encode(address_of_private_key(&private_key).expect("address")),
            "8993c66ca61106471efbaae153d3be7200185caa",
        );
    }
}

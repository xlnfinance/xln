use std::collections::BTreeMap;
use std::sync::OnceLock;

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use hkdf::Hkdf;
use num_bigint::{BigInt, Sign};
use sha2::{Digest as _, Sha256};
use sha3::Keccak256;
use thiserror::Error;
use x25519_dalek::{PublicKey, StaticSecret};
use xln_rscore_engine::{HTLC_OPAQUE_CIPHERTEXT_VERSION, OpaqueHtlcCiphertext};

use crate::{HtlcPreparedBinding, HtlcPreparedOutcome, PreparedHtlcEntry};

const CONTEXT_DOMAIN: &[u8] = b"xln:htlc-envelope-context:binary";
const AEAD_CONTEXT_PREFIX: &[u8; 24] = b"xln:htlc-opaque:aes-gcm:";
const AEAD_CONTEXT_BYTES: usize = AEAD_CONTEXT_PREFIX.len() + 2 + 64;
const MAX_HTLC_BINARY_LAYER_BYTES: usize = (10_000_000 - 1_000_000) * 3 / 4;
const MAX_ENTITY_HTLC_NOTE_BYTES: usize = 256;
const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MIN_TIMELOCK_DELTA_MS: u64 = 10_000;
const MIN_FORWARD_TIMELOCK_MS: u64 = 20_000;
const MIN_REVEAL_HEIGHT_DELTA_BLOCKS: u64 = 3;
const MAX_ROUTING_FEE_PPM: u32 = 999_999;
const PPM_DENOMINATOR: u64 = 1_000_000;
const DIRECTIONAL_UTIL_STEP_PPM: u64 = 50_000;
const DIRECTIONAL_UTIL_CAP_PPM: u64 = 500_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedAccountView {
    pub online: bool,
    pub out_capacity: BigInt,
    pub in_capacity: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HtlcMaterializeInput {
    pub binding: HtlcPreparedBinding,
    pub envelope: OpaqueHtlcCiphertext,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HtlcMaterializeEnvironment {
    pub entity_encryption_public_key: [u8; 32],
    pub entity_encryption_private_key: [u8; 32],
    pub entity_timestamp: u64,
    pub last_finalized_j_height: u64,
    pub routing_fee_ppm: u32,
    pub routing_base_fee: BigInt,
    pub accounts: BTreeMap<(String, u16), PreparedAccountView>,
}

/// One authenticated onion layer before Account-capacity policy is applied.
/// Decryption and Account reads are deliberately split so the Runtime can
/// collect every referenced `(nextHop, token)` and issue one worker batch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecryptedHtlcMaterializeInput {
    pub binding: HtlcPreparedBinding,
    pub layer: DecryptedHtlcLayer,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DecryptedHtlcLayer {
    Reject { reason: &'static str },
    Decoded(DecodedOnionLayer),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DecodedOnionLayer {
    Final {
        secret: String,
        description: Option<String>,
        started_at_ms: Option<u64>,
    },
    Forward {
        next_hop: String,
        inner_envelope: OpaqueHtlcCiphertext,
        forward_amount: BigInt,
    },
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum PreparedContextError {
    #[error("HTLC_ENTITY_ENCRYPTION_KEYPAIR_MISMATCH")]
    KeypairMismatch,
    #[error("HTLC_X25519_LOW_ORDER_SHARED_SECRET")]
    LowOrderSharedSecret,
    #[error("HTLC_ENCRYPTION_CONTEXT_INVALID:{detail}")]
    ContextInvalid { detail: &'static str },
    #[error("HTLC_CIPHERTEXT_AUTHENTICATION_FAILED")]
    AuthenticationFailed,
    #[error("HTLC_ONION_LAYER_INVALID:{detail}")]
    OnionInvalid { detail: &'static str },
    #[error("HTLC_PREPARED_BINDING_INVALID:{detail}")]
    BindingInvalid { detail: &'static str },
    #[error("HTLC_PREPARED_BINDING_CONFLICT:{key}")]
    BindingConflict { key: String },
}

fn lower_hex<const N: usize>(
    value: &str,
    field: &'static str,
) -> Result<[u8; N], PreparedContextError> {
    if value.len() != N * 2 + 2 || !value.starts_with("0x") || value != value.to_ascii_lowercase() {
        return Err(PreparedContextError::BindingInvalid { detail: field });
    }
    let mut output = [0_u8; N];
    for (index, target) in output.iter_mut().enumerate() {
        *target = u8::from_str_radix(&value[2 + index * 2..4 + index * 2], 16)
            .map_err(|_| PreparedContextError::BindingInvalid { detail: field })?;
    }
    Ok(output)
}

fn prefixed_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2 + 2);
    output.push_str("0x");
    for byte in bytes {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}

fn uint256_bytes(value: &BigInt, field: &'static str) -> Result<[u8; 32], PreparedContextError> {
    let (sign, bytes) = value.to_bytes_be();
    if sign == Sign::Minus || bytes.len() > 32 {
        return Err(PreparedContextError::BindingInvalid { detail: field });
    }
    let mut output = [0_u8; 32];
    output[32 - bytes.len()..].copy_from_slice(&bytes);
    Ok(output)
}

/// Exact TS `computeHtlcEnvelopeContextHash` preimage and Keccak-256 digest.
pub fn compute_htlc_envelope_context_hash(
    binding: &HtlcPreparedBinding,
) -> Result<[u8; 32], PreparedContextError> {
    let from = lower_hex::<32>(&binding.from_entity_id, "FROM_ENTITY")?;
    let to = lower_hex::<32>(&binding.to_entity_id, "TO_ENTITY")?;
    let hashlock = lower_hex::<32>(&binding.hashlock, "HASHLOCK")?;
    let amount = uint256_bytes(&binding.amount, "AMOUNT")?;
    let timelock = uint256_bytes(&binding.timelock, "TIMELOCK")?;
    if binding.domain.chain_id() == 0
        || binding.domain.chain_id() > JS_MAX_SAFE_INTEGER
        || binding.reveal_before_height > JS_MAX_SAFE_INTEGER
    {
        return Err(PreparedContextError::BindingInvalid { detail: "NUMBER" });
    }
    let mut digest = Keccak256::new();
    digest.update(CONTEXT_DOMAIN);
    digest.update(from);
    digest.update(to);
    digest.update(binding.domain.chain_id().to_be_bytes());
    digest.update(binding.domain.depository_address().as_bytes());
    digest.update(hashlock);
    digest.update(u64::from(binding.token_id).to_be_bytes());
    digest.update(amount);
    digest.update(timelock);
    digest.update(binding.reveal_before_height.to_be_bytes());
    Ok(digest.finalize().into())
}

fn derive_aead_key(shared: &[u8; 32], context: &[u8]) -> Result<[u8; 32], PreparedContextError> {
    if shared.iter().all(|byte| *byte == 0) {
        return Err(PreparedContextError::LowOrderSharedSecret);
    }
    static SALT: OnceLock<[u8; 32]> = OnceLock::new();
    let salt = SALT.get_or_init(|| {
        let mut digest = Sha256::new();
        digest.update(HTLC_OPAQUE_CIPHERTEXT_VERSION.as_bytes());
        digest.update(b":hkdf-salt");
        digest.finalize().into()
    });
    let hkdf = Hkdf::<Sha256>::new(Some(salt), shared);
    let mut key = [0_u8; 32];
    hkdf.expand(context, &mut key)
        .map_err(|_| PreparedContextError::ContextInvalid { detail: "HKDF" })?;
    Ok(key)
}

fn aead_context(context_hash: &[u8; 32]) -> [u8; AEAD_CONTEXT_BYTES] {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut context = [0_u8; AEAD_CONTEXT_BYTES];
    context[..AEAD_CONTEXT_PREFIX.len()].copy_from_slice(AEAD_CONTEXT_PREFIX);
    let hex_offset = AEAD_CONTEXT_PREFIX.len();
    context[hex_offset..hex_offset + 2].copy_from_slice(b"0x");
    for (index, byte) in context_hash.iter().enumerate() {
        context[hex_offset + 2 + index * 2] = HEX[usize::from(byte >> 4)];
        context[hex_offset + 3 + index * 2] = HEX[usize::from(byte & 0x0f)];
    }
    context
}

fn decrypt_opaque_htlc_layer_with_private(
    envelope: &OpaqueHtlcCiphertext,
    entity_public_key: &[u8; 32],
    private: &StaticSecret,
    context_hash: &[u8; 32],
) -> Result<Vec<u8>, PreparedContextError> {
    let packed = envelope.packed();
    if packed.len() < 48 {
        return Err(PreparedContextError::OnionInvalid { detail: "SIZE" });
    }
    let ephemeral_bytes: [u8; 32] =
        packed[..32]
            .try_into()
            .map_err(|_| PreparedContextError::OnionInvalid {
                detail: "EPHEMERAL",
            })?;
    let shared = private.diffie_hellman(&PublicKey::from(ephemeral_bytes));
    let context = aead_context(context_hash);
    let key = derive_aead_key(shared.as_bytes(), &context)?;
    let mut nonce_digest = Sha256::new();
    nonce_digest.update(ephemeral_bytes);
    nonce_digest.update(entity_public_key);
    nonce_digest.update(context);
    let nonce_digest = nonce_digest.finalize();
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| PreparedContextError::ContextInvalid { detail: "AEAD_KEY" })?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce_digest[..12]),
            Payload {
                msg: &packed[32..],
                aad: &context,
            },
        )
        .map_err(|_| PreparedContextError::AuthenticationFailed)?;
    if plaintext.len() > MAX_HTLC_BINARY_LAYER_BYTES {
        return Err(PreparedContextError::OnionInvalid {
            detail: "PLAINTEXT_SIZE",
        });
    }
    Ok(plaintext)
}

/// X25519 + HKDF-SHA256 + AES-256-GCM counterpart of
/// `decryptOpaqueHtlcBytes`. Authentication failures are peer-rejectable;
/// invalid local key provisioning remains a loud infrastructure error.
pub fn decrypt_opaque_htlc_layer(
    envelope: &OpaqueHtlcCiphertext,
    entity_public_key: &[u8; 32],
    entity_private_key: &[u8; 32],
    context_hash: &[u8; 32],
) -> Result<Vec<u8>, PreparedContextError> {
    let private = StaticSecret::from(*entity_private_key);
    if PublicKey::from(&private).as_bytes() != entity_public_key {
        return Err(PreparedContextError::KeypairMismatch);
    }
    decrypt_opaque_htlc_layer_with_private(envelope, entity_public_key, &private, context_hash)
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Result<Self, PreparedContextError> {
        if bytes.len() > MAX_HTLC_BINARY_LAYER_BYTES {
            return Err(PreparedContextError::OnionInvalid { detail: "SIZE" });
        }
        Ok(Self { bytes, offset: 0 })
    }

    fn raw(&mut self, count: usize) -> Result<&'a [u8], PreparedContextError> {
        let end = self
            .offset
            .checked_add(count)
            .filter(|end| *end <= self.bytes.len())
            .ok_or(PreparedContextError::OnionInvalid {
                detail: "TRUNCATED",
            })?;
        let output = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(output)
    }

    fn u8(&mut self) -> Result<u8, PreparedContextError> {
        Ok(self.raw(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, PreparedContextError> {
        let bytes: [u8; 2] = self
            .raw(2)?
            .try_into()
            .map_err(|_| PreparedContextError::OnionInvalid { detail: "U16" })?;
        Ok(u16::from_be_bytes(bytes))
    }

    fn u32(&mut self) -> Result<u32, PreparedContextError> {
        let bytes: [u8; 4] = self
            .raw(4)?
            .try_into()
            .map_err(|_| PreparedContextError::OnionInvalid { detail: "U32" })?;
        Ok(u32::from_be_bytes(bytes))
    }

    fn u64(&mut self) -> Result<u64, PreparedContextError> {
        let bytes: [u8; 8] = self
            .raw(8)?
            .try_into()
            .map_err(|_| PreparedContextError::OnionInvalid { detail: "U64" })?;
        Ok(u64::from_be_bytes(bytes))
    }

    fn sized(&mut self) -> Result<&'a [u8], PreparedContextError> {
        let size = usize::try_from(self.u32()?)
            .map_err(|_| PreparedContextError::OnionInvalid { detail: "LENGTH" })?;
        self.raw(size)
    }

    fn text(&mut self) -> Result<String, PreparedContextError> {
        let size = usize::from(self.u16()?);
        String::from_utf8(self.raw(size)?.to_vec())
            .map_err(|_| PreparedContextError::OnionInvalid { detail: "UTF8" })
    }

    fn finish(self) -> Result<(), PreparedContextError> {
        if self.offset == self.bytes.len() {
            Ok(())
        } else {
            Err(PreparedContextError::OnionInvalid { detail: "TRAILING" })
        }
    }
}

fn decode_inner_ciphertext(bytes: &[u8]) -> Result<OpaqueHtlcCiphertext, PreparedContextError> {
    let mut reader = Reader::new(bytes)?;
    if reader.raw(4)? != b"XLMR" || reader.u8()? != 1 {
        return Err(PreparedContextError::OnionInvalid {
            detail: "CIPHERTEXT_HEADER",
        });
    }
    let packed = reader.sized()?.to_vec();
    reader.finish()?;
    OpaqueHtlcCiphertext::from_packed(packed).map_err(|_| PreparedContextError::OnionInvalid {
        detail: "CIPHERTEXT",
    })
}

/// Exact inverse of TS `encodeOnionLayer` (XLON/v2).
pub fn decode_onion_layer(bytes: &[u8]) -> Result<DecodedOnionLayer, PreparedContextError> {
    let mut reader = Reader::new(bytes)?;
    if reader.raw(4)? != b"XLON" || reader.u8()? != 2 {
        return Err(PreparedContextError::OnionInvalid { detail: "HEADER" });
    }
    match reader.u8()? {
        1 => {
            let secret = prefixed_hex(reader.raw(32)?);
            let flags = reader.u8()?;
            if flags & !3 != 0 {
                return Err(PreparedContextError::OnionInvalid { detail: "FLAGS" });
            }
            let description = if flags & 1 != 0 {
                let value = reader.text()?;
                if value.len() > MAX_ENTITY_HTLC_NOTE_BYTES {
                    return Err(PreparedContextError::OnionInvalid {
                        detail: "DESCRIPTION",
                    });
                }
                Some(value)
            } else {
                None
            };
            let started_at_ms = if flags & 2 != 0 {
                let value = reader.u64()?;
                if value == 0 || value > JS_MAX_SAFE_INTEGER {
                    return Err(PreparedContextError::OnionInvalid {
                        detail: "STARTED_AT",
                    });
                }
                Some(value)
            } else {
                None
            };
            reader.finish()?;
            Ok(DecodedOnionLayer::Final {
                secret,
                description,
                started_at_ms,
            })
        }
        2 => {
            let next_hop = reader.text()?;
            let forward_amount = BigInt::from_bytes_be(Sign::Plus, reader.raw(32)?);
            if forward_amount <= BigInt::from(0) {
                return Err(PreparedContextError::OnionInvalid {
                    detail: "FORWARD_AMOUNT",
                });
            }
            let inner_envelope = decode_inner_ciphertext(reader.sized()?)?;
            reader.finish()?;
            Ok(DecodedOnionLayer::Forward {
                next_hop,
                inner_envelope,
                forward_amount,
            })
        }
        _ => Err(PreparedContextError::OnionInvalid { detail: "KIND" }),
    }
}

fn non_negative(value: &BigInt) -> BigInt {
    if value < &BigInt::from(0) {
        BigInt::from(0)
    } else {
        value.clone()
    }
}

fn directional_fee_ppm(base: u32, account: &PreparedAccountView) -> u32 {
    let base = base.min(MAX_ROUTING_FEE_PPM);
    let out = non_negative(&account.out_capacity);
    let inbound = non_negative(&account.in_capacity);
    let total = &out + &inbound;
    if total == BigInt::from(0) {
        return base;
    }
    let million = BigInt::from(PPM_DENOMINATOR);
    let mut utilization = ((&total - &out) * &million) / &total;
    utilization = utilization.min(BigInt::from(DIRECTIONAL_UTIL_CAP_PPM));
    utilization = (&utilization / BigInt::from(DIRECTIONAL_UTIL_STEP_PPM))
        * BigInt::from(DIRECTIONAL_UTIL_STEP_PPM);
    let effective = BigInt::from(base) + BigInt::from(base) * utilization / million;
    match u32::try_from(effective) {
        Ok(value) => value.min(MAX_ROUTING_FEE_PPM),
        Err(_) => MAX_ROUTING_FEE_PPM,
    }
}

fn reject(binding: HtlcPreparedBinding, reason: &str) -> PreparedHtlcEntry {
    PreparedHtlcEntry {
        binding,
        outcome: HtlcPreparedOutcome::Reject {
            reason: reason.to_string(),
        },
    }
}

fn validate_materialize_input(input: &HtlcMaterializeInput) -> Result<(), PreparedContextError> {
    if input.binding.amount <= BigInt::from(0)
        || input.binding.timelock <= BigInt::from(0)
        || input.binding.account_height == 0
        || input.binding.reveal_before_height == 0
        || prefixed_hex(&input.envelope.integrity_hash()) != input.binding.envelope_hash
    {
        return Err(PreparedContextError::BindingInvalid {
            detail: "ECONOMICS_OR_ENVELOPE",
        });
    }
    Ok(())
}

/// Authenticate and decode the selected inbound layers without consulting
/// Account state. Peer-controlled ciphertext failures become one rejected
/// row; local key provisioning remains a fatal infrastructure error.
pub fn decrypt_htlc_materialize_inputs(
    inputs: Vec<HtlcMaterializeInput>,
    entity_public_key: &[u8; 32],
    entity_private_key: &[u8; 32],
) -> Result<Vec<DecryptedHtlcMaterializeInput>, PreparedContextError> {
    let private = StaticSecret::from(*entity_private_key);
    if PublicKey::from(&private).as_bytes() != entity_public_key {
        return Err(PreparedContextError::KeypairMismatch);
    }
    inputs
        .into_iter()
        .map(|input| {
            validate_materialize_input(&input)?;
            let context_hash = compute_htlc_envelope_context_hash(&input.binding)?;
            let layer = match decrypt_opaque_htlc_layer_with_private(
                &input.envelope,
                entity_public_key,
                &private,
                &context_hash,
            ) {
                Ok(plaintext) => match decode_onion_layer(&plaintext) {
                    Ok(layer) => DecryptedHtlcLayer::Decoded(layer),
                    Err(PreparedContextError::OnionInvalid { .. }) => DecryptedHtlcLayer::Reject {
                        reason: "ciphertext_invalid",
                    },
                    Err(error) => return Err(error),
                },
                Err(
                    PreparedContextError::AuthenticationFailed
                    | PreparedContextError::LowOrderSharedSecret,
                ) => DecryptedHtlcLayer::Reject {
                    reason: "decrypt_failed",
                },
                Err(error) => return Err(error),
            };
            Ok(DecryptedHtlcMaterializeInput {
                binding: input.binding,
                layer,
            })
        })
        .collect()
}

/// Minimal Account reads required by the decrypted forward layers.
pub fn required_htlc_account_tokens(
    inputs: &[DecryptedHtlcMaterializeInput],
) -> BTreeMap<String, Vec<u16>> {
    let mut requested = BTreeMap::<String, Vec<u16>>::new();
    for input in inputs {
        let DecryptedHtlcLayer::Decoded(DecodedOnionLayer::Forward { next_hop, .. }) = &input.layer
        else {
            continue;
        };
        let tokens = requested.entry(next_hop.clone()).or_default();
        if !tokens.contains(&input.binding.token_id) {
            tokens.push(input.binding.token_id);
            tokens.sort_unstable();
        }
    }
    requested
}

fn materialize_decrypted_one(
    input: DecryptedHtlcMaterializeInput,
    env: &HtlcMaterializeEnvironment,
) -> Result<PreparedHtlcEntry, PreparedContextError> {
    match input.layer {
        DecryptedHtlcLayer::Reject { reason } => Ok(reject(input.binding, reason)),
        DecryptedHtlcLayer::Decoded(layer) => match layer {
            DecodedOnionLayer::Final {
                secret,
                description,
                started_at_ms,
            } => Ok(PreparedHtlcEntry {
                binding: input.binding,
                outcome: HtlcPreparedOutcome::Final {
                    secret,
                    description,
                    started_at_ms,
                },
            }),
            DecodedOnionLayer::Forward {
                next_hop,
                inner_envelope,
                forward_amount,
            } => {
                lower_hex::<32>(&next_hop, "NEXT_HOP")?;
                let Some(account) = env
                    .accounts
                    .get(&(next_hop.clone(), input.binding.token_id))
                else {
                    return Ok(reject(input.binding, "next_hop_account_missing"));
                };
                if !account.online {
                    return Ok(reject(input.binding, "next_hop_offline"));
                }
                if account.out_capacity < forward_amount {
                    return Ok(reject(input.binding, "insufficient_capacity"));
                }
                let fee_ppm = directional_fee_ppm(env.routing_fee_ppm, account);
                let required_fee = non_negative(&env.routing_base_fee)
                    + &input.binding.amount * BigInt::from(fee_ppm) / BigInt::from(PPM_DENOMINATOR);
                if &input.binding.amount - &forward_amount < required_fee {
                    return Ok(reject(input.binding, "fee_below_policy"));
                }
                let minimum_timestamp = env
                    .entity_timestamp
                    .checked_add(MIN_FORWARD_TIMELOCK_MS)
                    .ok_or(PreparedContextError::BindingInvalid {
                    detail: "TIMESTAMP_OVERFLOW",
                })?;
                let minimum_timelock = minimum_timestamp.checked_add(MIN_TIMELOCK_DELTA_MS).ok_or(
                    PreparedContextError::BindingInvalid {
                        detail: "TIMESTAMP_OVERFLOW",
                    },
                )?;
                let timelock_safe = input.binding.timelock > BigInt::from(minimum_timelock);
                let reveal_safe = input.binding.reveal_before_height
                    > env
                        .last_finalized_j_height
                        .checked_add(MIN_REVEAL_HEIGHT_DELTA_BLOCKS)
                        .ok_or(PreparedContextError::BindingInvalid {
                            detail: "HEIGHT_OVERFLOW",
                        })?;
                if !timelock_safe || !reveal_safe {
                    return Ok(reject(input.binding, "deadline_unsafe"));
                }
                Ok(PreparedHtlcEntry {
                    binding: input.binding,
                    outcome: HtlcPreparedOutcome::Forward {
                        next_hop_entity_id: next_hop,
                        forward_amount,
                        inner_envelope,
                    },
                })
            }
        },
    }
}

/// Apply liveness, capacity, fee and deadline policy after the Runtime has
/// completed its single batched Account read.
pub fn materialize_decrypted_htlc_entries(
    inputs: Vec<DecryptedHtlcMaterializeInput>,
    env: &HtlcMaterializeEnvironment,
) -> Result<Vec<PreparedHtlcEntry>, PreparedContextError> {
    let mut output = Vec::<PreparedHtlcEntry>::with_capacity(inputs.len());
    let mut seen = std::collections::BTreeMap::<String, usize>::new();
    for input in inputs {
        let key = format!(
            "{}:{}",
            input.binding.account_frame_hash, input.binding.hashlock
        );
        let entry = materialize_decrypted_one(input, env)?;
        if let Some(previous) = seen.get(&key).and_then(|index| output.get(*index)) {
            if previous != &entry {
                return Err(PreparedContextError::BindingConflict { key });
            }
            continue;
        }
        seen.insert(key, output.len());
        output.push(entry);
    }
    Ok(output)
}

/// Materialize and canonicalize all inbound onion rows. Identical duplicate
/// deliveries collapse; contradictory facts for one `(frameHash, lockId)` are
/// fatal exactly like the TypeScript frame-context boundary.
pub fn materialize_htlc_prepared_entries(
    inputs: Vec<HtlcMaterializeInput>,
    env: &HtlcMaterializeEnvironment,
) -> Result<Vec<PreparedHtlcEntry>, PreparedContextError> {
    let decrypted = decrypt_htlc_materialize_inputs(
        inputs,
        &env.entity_encryption_public_key,
        &env.entity_encryption_private_key,
    )?;
    materialize_decrypted_htlc_entries(decrypted, env)
}

#[cfg(test)]
mod tests {
    use super::*;
    use xln_rscore_engine::{AccountDomain, DepositoryAddress};

    fn decode_hex<const N: usize>(value: &str) -> [u8; N] {
        lower_hex::<N>(value, "TEST").expect("test hex")
    }

    fn golden_binding() -> HtlcPreparedBinding {
        HtlcPreparedBinding {
            from_entity_id: format!("0x{}", "11".repeat(32)),
            to_entity_id: format!("0x{}", "22".repeat(32)),
            domain: AccountDomain::new(
                31_337,
                DepositoryAddress::parse(&format!("0x{}", "33".repeat(20))).expect("depository"),
            )
            .expect("domain"),
            account_frame_hash: format!("0x{}", "77".repeat(32)),
            account_height: 1,
            envelope_hash: "0x1b5fc4d2d3579f354e8fef129658b96b5e275d0dd623428a9357441811e787c1"
                .to_string(),
            hashlock: format!("0x{}", "55".repeat(32)),
            token_id: 7,
            amount: BigInt::from(123_456_789_u64),
            timelock: BigInt::from(987_654_321_u64),
            reveal_before_height: 1_234,
        }
    }

    #[test]
    fn matches_typescript_context_hash_and_decrypts_final_layer() {
        let binding = golden_binding();
        assert_eq!(
            prefixed_hex(&compute_htlc_envelope_context_hash(&binding).expect("context")),
            "0x9b94710457f5228c8956ad0d46c62edb0f426cd27d5dfdbdb6729deacd762616",
        );
        let private_key =
            decode_hex::<32>("0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20");
        let public_key =
            decode_hex::<32>("0x07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c");
        let envelope = OpaqueHtlcCiphertext::parse(
            HTLC_OPAQUE_CIPHERTEXT_VERSION,
            "EyxEK+AQ+9V+cmAzKKp25x/MwVA6riGTJ9FNnJmT9HICUR2hh3m4QkbXs2jc1x2BebzxGNFx/fyl2TH6CABq/GdmvSQCiNm7Yv2wZ2m6s434RXwI687JlOPA7YbyXPh0v/B8QlM1OKEdSpTNKviT",
        )
        .expect("golden envelope");
        let plaintext = decrypt_opaque_htlc_layer(
            &envelope,
            &public_key,
            &private_key,
            &compute_htlc_envelope_context_hash(&binding).expect("context"),
        )
        .expect("decrypt");
        assert_eq!(
            hex::encode(&plaintext),
            "584c4f4e0201666666666666666666666666666666666666666666666666666666666666666603000e727573742d74732d676f6c64656e0000000000000309",
        );
        assert_eq!(
            decode_onion_layer(&plaintext).expect("decode"),
            DecodedOnionLayer::Final {
                secret: format!("0x{}", "66".repeat(32)),
                description: Some("rust-ts-golden".to_string()),
                started_at_ms: Some(777),
            },
        );
    }

    #[test]
    fn authentication_failure_is_one_rejected_input_not_a_batch_failure() {
        let private_key =
            decode_hex::<32>("0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20");
        let public_key = *PublicKey::from(&StaticSecret::from(private_key)).as_bytes();
        let mut packed = vec![1_u8; 48];
        packed[0] = 7;
        let envelope = OpaqueHtlcCiphertext::from_packed(packed).expect("shape-valid envelope");
        let mut binding = golden_binding();
        binding.envelope_hash = prefixed_hex(&envelope.integrity_hash());
        let rows = materialize_htlc_prepared_entries(
            vec![HtlcMaterializeInput { binding, envelope }],
            &HtlcMaterializeEnvironment {
                entity_encryption_public_key: public_key,
                entity_encryption_private_key: private_key,
                entity_timestamp: 1,
                last_finalized_j_height: 1,
                routing_fee_ppm: 1,
                routing_base_fee: BigInt::from(0),
                accounts: BTreeMap::new(),
            },
        )
        .expect("peer auth failure is materialized");
        assert!(matches!(
            rows[0].outcome,
            HtlcPreparedOutcome::Reject { ref reason } if reason == "decrypt_failed"
        ));
    }

    #[test]
    fn one_peer_with_two_tokens_reads_each_token_capacity() {
        let next_hop = format!("0x{}", "88".repeat(32));
        let inner_envelope =
            OpaqueHtlcCiphertext::from_packed(vec![1_u8; 48]).expect("inner envelope");
        let rows = [7_u16, 8_u16]
            .into_iter()
            .map(|token_id| {
                let mut binding = golden_binding();
                binding.hashlock = format!("0x{:064x}", token_id);
                binding.account_frame_hash = format!("0x{:064x}", token_id + 100);
                binding.token_id = token_id;
                binding.amount = BigInt::from(200);
                DecryptedHtlcMaterializeInput {
                    binding,
                    layer: DecryptedHtlcLayer::Decoded(DecodedOnionLayer::Forward {
                        next_hop: next_hop.clone(),
                        inner_envelope: inner_envelope.clone(),
                        forward_amount: BigInt::from(100),
                    }),
                }
            })
            .collect();
        let accounts = BTreeMap::from([
            (
                (next_hop.clone(), 7),
                PreparedAccountView {
                    online: true,
                    out_capacity: BigInt::from(1_000),
                    in_capacity: BigInt::from(0),
                },
            ),
            (
                (next_hop, 8),
                PreparedAccountView {
                    online: true,
                    out_capacity: BigInt::from(0),
                    in_capacity: BigInt::from(0),
                },
            ),
        ]);
        let materialized = materialize_decrypted_htlc_entries(
            rows,
            &HtlcMaterializeEnvironment {
                entity_encryption_public_key: [0; 32],
                entity_encryption_private_key: [0; 32],
                entity_timestamp: 1,
                last_finalized_j_height: 1,
                routing_fee_ppm: 1,
                routing_base_fee: BigInt::from(0),
                accounts,
            },
        )
        .expect("materialize both tokens");
        assert!(matches!(
            materialized[0].outcome,
            HtlcPreparedOutcome::Forward { .. }
        ));
        assert!(matches!(
            materialized[1].outcome,
            HtlcPreparedOutcome::Reject { ref reason } if reason == "insufficient_capacity"
        ));
    }
}

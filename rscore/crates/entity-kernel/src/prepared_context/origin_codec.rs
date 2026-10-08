//! Proposer-side counterpart of the canonical TS XLON/v2 opaque codec.
use super::*;

fn text(output: &mut Vec<u8>, value: &str) -> Result<(), PreparedContextError> {
    let length = u16::try_from(value.len()).map_err(|_| PreparedContextError::OnionInvalid {
        detail: "TEXT_SIZE",
    })?;
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(value.as_bytes());
    Ok(())
}

/// Encode a layer without introducing randomness or exposing its secret in context.
pub fn encode_onion_layer(layer: &DecodedOnionLayer) -> Result<Vec<u8>, PreparedContextError> {
    let mut output = b"XLON\x02".to_vec();
    match layer {
        DecodedOnionLayer::Final {
            secret,
            description,
            started_at_ms,
        } => {
            output.push(1);
            let raw = secret
                .strip_prefix("0x")
                .filter(|value| value.len() == 64)
                .ok_or(PreparedContextError::OnionInvalid { detail: "SECRET" })?;
            let mut bytes = [0_u8; 32];
            hex::decode_to_slice(raw, &mut bytes)
                .map_err(|_| PreparedContextError::OnionInvalid { detail: "SECRET" })?;
            output.extend_from_slice(&bytes);
            output.push(u8::from(description.is_some()) | (u8::from(started_at_ms.is_some()) << 1));
            if let Some(description) = description {
                text(&mut output, description)?;
            }
            if let Some(timestamp) = started_at_ms {
                if *timestamp == 0 || *timestamp > JS_MAX_SAFE_INTEGER {
                    return Err(PreparedContextError::OnionInvalid {
                        detail: "STARTED_AT",
                    });
                }
                output.extend_from_slice(&timestamp.to_be_bytes());
            }
        }
        DecodedOnionLayer::Forward {
            next_hop,
            inner_envelope,
            forward_amount,
        } => {
            output.push(2);
            text(&mut output, next_hop)?;
            output.extend_from_slice(&uint256_bytes(forward_amount, "FORWARD_AMOUNT")?);
            let packed = inner_envelope.packed();
            let inner_length = u32::try_from(packed.len())
                .ok()
                .and_then(|length| length.checked_add(9))
                .ok_or(PreparedContextError::OnionInvalid {
                    detail: "CIPHERTEXT_SIZE",
                })?;
            output.extend_from_slice(&inner_length.to_be_bytes());
            output.extend_from_slice(b"XLMR\x01");
            output.extend_from_slice(&(inner_length - 9).to_be_bytes());
            output.extend_from_slice(packed);
        }
    }
    if output.len() > MAX_HTLC_BINARY_LAYER_BYTES {
        return Err(PreparedContextError::OnionInvalid {
            detail: "PLAINTEXT_SIZE",
        });
    }
    Ok(output)
}

/// Caller supplies fresh proposer entropy; validators only receive the ciphertext.
/// The nonce is derived exactly as TS from the ephemeral/recipient keys and binding.
pub fn encrypt_opaque_htlc_layer(
    plaintext: &[u8],
    recipient_public_key: &[u8; 32],
    context_hash: &[u8; 32],
    ephemeral_private_key: &[u8; 32],
) -> Result<OpaqueHtlcCiphertext, PreparedContextError> {
    if plaintext.len() > MAX_HTLC_BINARY_LAYER_BYTES {
        return Err(PreparedContextError::OnionInvalid {
            detail: "PLAINTEXT_SIZE",
        });
    }
    let private = StaticSecret::from(*ephemeral_private_key);
    let ephemeral_public = PublicKey::from(&private);
    let shared = private.diffie_hellman(&PublicKey::from(*recipient_public_key));
    let context = aead_context(context_hash);
    let key = derive_aead_key(shared.as_bytes(), &context)?;
    let mut nonce_digest = Sha256::new();
    nonce_digest.update(ephemeral_public.as_bytes());
    nonce_digest.update(recipient_public_key);
    nonce_digest.update(context);
    let nonce_digest = nonce_digest.finalize();
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| PreparedContextError::ContextInvalid { detail: "AEAD_KEY" })?;
    let encrypted = cipher
        .encrypt(
            Nonce::from_slice(&nonce_digest[..12]),
            Payload {
                msg: plaintext,
                aad: &context,
            },
        )
        .map_err(|_| PreparedContextError::AuthenticationFailed)?;
    let mut packed = ephemeral_public.as_bytes().to_vec();
    packed.extend_from_slice(&encrypted);
    OpaqueHtlcCiphertext::from_packed(packed).map_err(|_| PreparedContextError::OnionInvalid {
        detail: "CIPHERTEXT",
    })
}

#[cfg(test)]
#[path = "origin_codec_tests.rs"]
mod tests;

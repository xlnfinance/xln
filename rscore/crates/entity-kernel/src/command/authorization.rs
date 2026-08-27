use xln_rscore_engine::recover_signer_address;

use crate::EntityFrameAuthority;

use super::value::{fixed_hex, hex};
use super::{
    EntityCommandBoard, EntityCommandDisposition, EntityCommandError, EntityCommandNonceState,
    SignedEntityCommandV1, get_entity_command_disposition, invalid,
};

fn uint_word(value: u64) -> [u8; 32] {
    let mut output = [0_u8; 32];
    output[24..].copy_from_slice(&value.to_be_bytes());
    output
}

/// Exact singleton `keccak256(abi.encode(Board))` used by TS `encodeBoard`.
pub fn current_entity_command_board_hash(
    authority: &EntityFrameAuthority,
    signer_address: &str,
) -> Result<String, EntityCommandError> {
    let authority = authority
        .validate_and_normalize()
        .map_err(|error| invalid(error.to_string()))?;
    if !authority
        .is_single_signer()
        .map_err(|error| invalid(error.to_string()))?
    {
        return Err(invalid("ENTITY_COMMAND_SINGLE_SIGNER_BOARD_REQUIRED"));
    }
    let signer_id = authority.config.validators[0].clone();
    let signer = fixed_hex::<20>(signer_address, "BOARD_PROPOSER_EOA_REQUIRED")?;
    let mut encoded = Vec::with_capacity(32 * 11);
    for value in [
        32,
        u64::from(authority.config.threshold),
        192,
        256,
        0,
        0,
        0,
        1,
    ] {
        encoded.extend_from_slice(&uint_word(value));
    }
    let mut signer_word = [0_u8; 32];
    signer_word[12..].copy_from_slice(&signer);
    encoded.extend_from_slice(&signer_word);
    encoded.extend_from_slice(&uint_word(1));
    encoded.extend_from_slice(&uint_word(u64::from(authority.config.shares[&signer_id])));
    use sha3::{Digest as _, Keccak256};
    Ok(hex(&Keccak256::digest(encoded)))
}

#[allow(clippy::too_many_arguments)]
pub fn assert_signed_entity_command(
    entity_id: &str,
    authority: &EntityFrameAuthority,
    signer_address: &str,
    board_epoch: u64,
    stack_key: &str,
    nonce_state: Option<&EntityCommandNonceState>,
    command: &SignedEntityCommandV1,
) -> Result<(EntityCommandBoard, EntityCommandDisposition), EntityCommandError> {
    if command.entity_id != entity_id {
        return Err(invalid(format!(
            "ENTITY_COMMAND_ENTITY_MISMATCH:{}:{entity_id}",
            command.entity_id
        )));
    }
    if command.stack_key != stack_key {
        return Err(invalid(format!(
            "ENTITY_COMMAND_STACK_MISMATCH:{}:{stack_key}",
            command.stack_key
        )));
    }
    let normalized = authority
        .validate_and_normalize()
        .map_err(|error| invalid(error.to_string()))?;
    let board_hash = current_entity_command_board_hash(&normalized, signer_address)?;
    if command.board_hash != board_hash {
        return Err(invalid(format!(
            "ENTITY_COMMAND_BOARD_MISMATCH:{}:{board_hash}",
            command.board_hash
        )));
    }
    if command.board_epoch != board_epoch {
        return Err(invalid(format!(
            "ENTITY_COMMAND_EPOCH_MISMATCH:{}:{board_epoch}",
            command.board_epoch
        )));
    }
    let signer_id = normalized.config.validators[0].clone();
    if command.author_signer_id != signer_id {
        return Err(invalid(format!(
            "ENTITY_COMMAND_AUTHOR_NOT_ON_BOARD:{}",
            command.author_signer_id
        )));
    }
    let signer = hex(&fixed_hex::<20>(
        signer_address,
        "ENTITY_COMMAND_BOARD_SIGNER_INVALID",
    )?);
    if command.author_signer != signer {
        return Err(invalid(format!(
            "ENTITY_COMMAND_AUTHOR_EOA_MISMATCH:{}:{signer}",
            command.author_signer
        )));
    }
    let digest = fixed_hex::<32>(&command.command_hash, "ENTITY_COMMAND_HASH_INVALID")?;
    let recovered = recover_signer_address(&digest, &command.signature).map(|value| hex(&value));
    if recovered.as_deref() != Some(command.author_signer.as_str()) {
        return Err(invalid(format!(
            "ENTITY_COMMAND_SIGNATURE_MISMATCH:{signer_id}:{}",
            command.author_signer
        )));
    }
    let board = EntityCommandBoard {
        board_hash,
        board_epoch,
        stack_key: stack_key.into(),
        signer_id,
        signer,
    };
    super::nonce::validate_nonce_state(nonce_state, &board)?;
    let disposition = get_entity_command_disposition(nonce_state, command)?;
    Ok((board, disposition))
}

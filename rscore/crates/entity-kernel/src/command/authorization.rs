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

fn board_entity_id(value: &str) -> Result<[u8; 32], EntityCommandError> {
    if let Ok(address) = fixed_hex::<20>(value, "BOARD_VALIDATOR_ADDRESS_REQUIRED") {
        let mut output = [0_u8; 32];
        output[12..].copy_from_slice(&address);
        return Ok(output);
    }
    fixed_hex::<32>(value, "BOARD_VALIDATOR_ENTITY_ID_REQUIRED")
}

/// Exact `keccak256(abi.encode(Board))` used by TS `encodeBoard` for any
/// weighted board. Validator order is authority order; shares are looked up
/// by canonical signer id and encoded in the same positional order.
pub fn current_entity_command_board_hash(
    authority: &EntityFrameAuthority,
    _local_signer_address: &str,
) -> Result<String, EntityCommandError> {
    let authority = authority
        .validate_and_normalize()
        .map_err(|error| invalid(error.to_string()))?;
    // TypeScript requires the first validator to be an EOA even though later
    // members may be bytes32 Entity ids.
    fixed_hex::<20>(
        &authority.config.validators[0],
        "BOARD_PROPOSER_EOA_REQUIRED",
    )?;
    let count = authority.config.validators.len();
    let entity_ids = authority
        .config
        .validators
        .iter()
        .map(|validator| board_entity_id(validator))
        .collect::<Result<Vec<_>, _>>()?;
    let powers = authority
        .config
        .validators
        .iter()
        .map(|validator| {
            authority
                .config
                .shares
                .get(validator)
                .copied()
                .ok_or_else(|| invalid(format!("ENTITY_FRAME_AUTHORITY_SHARE_MISSING:{validator}")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let ids_offset = 32 * 6;
    let powers_offset = ids_offset + 32 + 32 * count;
    let mut encoded = Vec::with_capacity(32 * (9 + count * 2));
    for value in [
        32,
        u64::from(authority.config.threshold),
        u64::try_from(ids_offset).map_err(|_| invalid("ENTITY_COMMAND_BOARD_SIZE"))?,
        u64::try_from(powers_offset).map_err(|_| invalid("ENTITY_COMMAND_BOARD_SIZE"))?,
        0,
        0,
        0,
    ] {
        encoded.extend_from_slice(&uint_word(value));
    }
    encoded.extend_from_slice(&uint_word(
        u64::try_from(count).map_err(|_| invalid("ENTITY_COMMAND_BOARD_SIZE"))?,
    ));
    for entity_id in entity_ids {
        encoded.extend_from_slice(&entity_id);
    }
    encoded.extend_from_slice(&uint_word(
        u64::try_from(count).map_err(|_| invalid("ENTITY_COMMAND_BOARD_SIZE"))?,
    ));
    for power in powers {
        encoded.extend_from_slice(&uint_word(u64::from(power)));
    }
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
    let signer_id = command.author_signer_id.clone();
    if !normalized.config.validators.contains(&signer_id) {
        return Err(invalid(format!(
            "ENTITY_COMMAND_AUTHOR_NOT_ON_BOARD:{signer_id}"
        )));
    }
    let signer = hex(&fixed_hex::<20>(
        &signer_id,
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

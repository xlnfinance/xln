use std::collections::BTreeMap;

use num_bigint::BigInt;
use xln_rscore_protocol::CanonicalValue;

use super::value::{fixed_hex, number, object_value};
use super::{
    EntityCommandBoard, EntityCommandDisposition, EntityCommandError, EntityCommandNonceRecord,
    EntityCommandNonceState, MAX_ENTITY_COMMAND_SIGNERS, SignedEntityCommandV1, invalid,
};

pub(super) fn validate_nonce_state(
    state: Option<&EntityCommandNonceState>,
    board: &EntityCommandBoard,
) -> Result<(), EntityCommandError> {
    let Some(state) = state else { return Ok(()) };
    if state.version != 1 {
        return Err(invalid("ENTITY_COMMAND_NONCE_STATE_INVALID"));
    }
    fixed_hex::<32>(
        &state.board_hash,
        "ENTITY_COMMAND_NONCE_STATE_BOARD_HASH_INVALID",
    )?;
    let current = state.board_hash == board.board_hash && state.board_epoch == board.board_epoch;
    let limit = if current {
        1
    } else {
        MAX_ENTITY_COMMAND_SIGNERS
    };
    if state.by_signer.len() > limit {
        return Err(invalid(format!(
            "ENTITY_COMMAND_NONCE_STATE_OVERSIZED:{}",
            state.by_signer.len()
        )));
    }
    for (signer, record) in &state.by_signer {
        if signer.is_empty() || signer.trim().to_lowercase() != *signer {
            return Err(invalid("ENTITY_COMMAND_NONCE_STATE_SIGNER_INVALID"));
        }
        if current && signer != &board.signer_id {
            return Err(invalid(format!(
                "ENTITY_COMMAND_NONCE_STATE_UNKNOWN_SIGNER:{signer}"
            )));
        }
        if record.nonce < BigInt::from(1_u8) {
            return Err(invalid(format!(
                "ENTITY_COMMAND_NONCE_STATE_VALUE_INVALID:{signer}"
            )));
        }
        fixed_hex::<32>(
            &record.command_hash,
            "ENTITY_COMMAND_NONCE_STATE_HASH_INVALID",
        )?;
    }
    Ok(())
}

pub fn normalize_entity_command_nonce_board(
    state: &mut Option<EntityCommandNonceState>,
    board: &EntityCommandBoard,
) -> Result<(), EntityCommandError> {
    validate_nonce_state(state.as_ref(), board)?;
    let Some(stored) = state else { return Ok(()) };
    if stored.board_hash != board.board_hash || stored.board_epoch != board.board_epoch {
        *stored = EntityCommandNonceState {
            version: 1,
            board_hash: board.board_hash.clone(),
            board_epoch: board.board_epoch,
            by_signer: BTreeMap::new(),
        };
    }
    Ok(())
}

pub fn get_entity_command_disposition(
    state: Option<&EntityCommandNonceState>,
    command: &SignedEntityCommandV1,
) -> Result<EntityCommandDisposition, EntityCommandError> {
    let current = state.filter(|state| {
        state.board_hash == command.board_hash && state.board_epoch == command.board_epoch
    });
    let latest = current.and_then(|state| state.by_signer.get(&command.author_signer_id));
    let Some(latest) = latest else {
        if command.nonce != BigInt::from(1_u8) {
            return Err(invalid(format!(
                "ENTITY_COMMAND_NONCE_MISMATCH:{}:1",
                command.nonce
            )));
        }
        return Ok(EntityCommandDisposition::Next);
    };
    if command.nonce == latest.nonce {
        return Ok(if command.command_hash == latest.command_hash {
            EntityCommandDisposition::Retry
        } else {
            EntityCommandDisposition::Cancel
        });
    }
    if command.nonce < latest.nonce {
        return Ok(EntityCommandDisposition::Cancel);
    }
    let expected = &latest.nonce + BigInt::from(1_u8);
    if command.nonce != expected {
        return Err(invalid(format!(
            "ENTITY_COMMAND_NONCE_MISMATCH:{}:{expected}",
            command.nonce
        )));
    }
    Ok(EntityCommandDisposition::Next)
}

pub fn advance_entity_command_nonce(
    state: &mut Option<EntityCommandNonceState>,
    board: &EntityCommandBoard,
    command: &SignedEntityCommandV1,
) -> Result<EntityCommandDisposition, EntityCommandError> {
    normalize_entity_command_nonce_board(state, board)?;
    let disposition = get_entity_command_disposition(state.as_ref(), command)?;
    if disposition != EntityCommandDisposition::Next {
        return Ok(disposition);
    }
    let state = state.get_or_insert_with(|| EntityCommandNonceState {
        version: 1,
        board_hash: board.board_hash.clone(),
        board_epoch: board.board_epoch,
        by_signer: BTreeMap::new(),
    });
    state.by_signer.insert(
        command.author_signer_id.clone(),
        EntityCommandNonceRecord {
            nonce: command.nonce.clone(),
            command_hash: command.command_hash.clone(),
        },
    );
    Ok(disposition)
}

pub fn canonical_entity_command_nonces(
    state: &EntityCommandNonceState,
) -> Result<CanonicalValue, EntityCommandError> {
    fixed_hex::<32>(
        &state.board_hash,
        "ENTITY_COMMAND_NONCE_STATE_BOARD_HASH_INVALID",
    )?;
    if state.version != 1 || state.by_signer.len() > MAX_ENTITY_COMMAND_SIGNERS {
        return Err(invalid("ENTITY_COMMAND_NONCE_STATE_INVALID"));
    }
    let mut rows = Vec::with_capacity(state.by_signer.len());
    for (signer, record) in &state.by_signer {
        if signer.is_empty()
            || signer.trim().to_lowercase() != *signer
            || record.nonce < BigInt::from(1_u8)
        {
            return Err(invalid("ENTITY_COMMAND_NONCE_STATE_VALUE_INVALID"));
        }
        fixed_hex::<32>(
            &record.command_hash,
            "ENTITY_COMMAND_NONCE_STATE_HASH_INVALID",
        )?;
        rows.push((
            CanonicalValue::String(signer.clone()),
            object_value(vec![
                ("nonce", CanonicalValue::BigInt(record.nonce.clone())),
                (
                    "commandHash",
                    CanonicalValue::String(record.command_hash.clone()),
                ),
            ]),
        ));
    }
    Ok(object_value(vec![
        ("version", number(1)?),
        (
            "boardHash",
            CanonicalValue::String(state.board_hash.clone()),
        ),
        ("boardEpoch", number(state.board_epoch)?),
        ("bySigner", CanonicalValue::Map(rows)),
    ]))
}

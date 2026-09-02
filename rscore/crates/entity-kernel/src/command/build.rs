use num_bigint::BigInt;
use xln_rscore_protocol::CanonicalValue;

use crate::{CanonicalEntityTx, EntitySingleSigner, EntityTxKind};

use super::hash::{hash_collective_action_txs, hash_entity_command_body, hash_entity_command_txs};
use super::value::{fixed_hex, hex, number, object_value};
use super::{
    EntityCommandBoard, EntityCommandError, EntityCommandNonceState, SignedEntityCommandV1,
    decode_signed_entity_command, invalid, is_individual_entity_command_tx_kind,
};

fn next_nonce(state: Option<&EntityCommandNonceState>, board: &EntityCommandBoard) -> BigInt {
    state
        .filter(|state| {
            state.board_hash == board.board_hash && state.board_epoch == board.board_epoch
        })
        .and_then(|state| state.by_signer.get(&board.signer_id))
        .map(|record| &record.nonce + BigInt::from(1_u8))
        .unwrap_or_else(|| BigInt::from(1_u8))
}

fn proposal_tx(
    board: &EntityCommandBoard,
    txs: Vec<CanonicalValue>,
) -> Result<CanonicalValue, EntityCommandError> {
    let action_hash = hash_collective_action_txs(&txs)?;
    Ok(object_value(vec![
        ("type", CanonicalValue::String("propose".into())),
        (
            "data",
            object_value(vec![
                ("proposer", CanonicalValue::String(board.signer_id.clone())),
                (
                    "action",
                    object_value(vec![
                        ("type", CanonicalValue::String("entity_transaction".into())),
                        (
                            "data",
                            object_value(vec![
                                ("version", number(1)?),
                                ("actionHash", CanonicalValue::String(action_hash)),
                                ("txs", CanonicalValue::Array(txs)),
                            ]),
                        ),
                    ]),
                ),
            ]),
        ),
    ]))
}

fn signed_command_value(
    signer: &EntitySingleSigner,
    board: &EntityCommandBoard,
    nonce: BigInt,
    entity_id: &str,
    txs: Vec<CanonicalValue>,
) -> Result<CanonicalValue, EntityCommandError> {
    let txs_hash = hash_entity_command_txs(&txs)?;
    let command_hash = hash_entity_command_body(
        1,
        entity_id,
        &board.stack_key,
        &board.board_hash,
        board.board_epoch,
        &board.signer_id,
        &board.signer,
        &nonce,
        &txs_hash,
    )?;
    let digest = fixed_hex::<32>(&command_hash, "ENTITY_COMMAND_HASH_INVALID")?;
    let signature = signer
        .sign_raw_digest(&digest)
        .ok_or_else(|| invalid("ENTITY_COMMAND_SIGNING_FAILED"))?;
    Ok(object_value(vec![
        ("version", number(1)?),
        ("entityId", CanonicalValue::String(entity_id.into())),
        ("stackKey", CanonicalValue::String(board.stack_key.clone())),
        (
            "boardHash",
            CanonicalValue::String(board.board_hash.clone()),
        ),
        ("boardEpoch", number(board.board_epoch)?),
        (
            "authorSignerId",
            CanonicalValue::String(board.signer_id.clone()),
        ),
        ("authorSigner", CanonicalValue::String(board.signer.clone())),
        ("nonce", CanonicalValue::BigInt(nonce)),
        ("txsHash", CanonicalValue::String(txs_hash)),
        ("txs", CanonicalValue::Array(txs)),
        ("signature", CanonicalValue::String(hex(&signature))),
    ]))
}

/// Canonical TypeScript `prepareLocallyAuthoredEntityTxs` collective lane.
/// The outer signed command is committed in the Entity frame; its derived
/// financial transactions execute locally but never replace the signed bytes.
pub fn build_locally_authored_entity_command(
    signer: &EntitySingleSigner,
    board: &EntityCommandBoard,
    nonce_state: Option<&EntityCommandNonceState>,
    entity_id: &str,
    txs: &[CanonicalEntityTx],
) -> Result<(SignedEntityCommandV1, CanonicalEntityTx), EntityCommandError> {
    if txs.is_empty() {
        return Err(invalid("ENTITY_COMMAND_TX_COUNT_INVALID:0"));
    }
    if signer.signer_id() != board.signer_id
        || signer.signer_address().map(|value| hex(&value)).as_deref() != Some(&board.signer)
    {
        return Err(invalid("ENTITY_COMMAND_SIGNER_BINDING_MISMATCH"));
    }
    let raw = txs
        .iter()
        .map(CanonicalEntityTx::canonical_value)
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| invalid("ENTITY_COMMAND_TX_FRAME_DATA_MISSING"))?;
    let individual_count = txs
        .iter()
        .filter(|tx| is_individual_entity_command_tx_kind(tx.kind))
        .count();
    let command_txs = match individual_count {
        0 => vec![proposal_tx(board, raw)?],
        count if count == txs.len() => raw,
        _ => {
            return Err(invalid("ENTITY_COMMAND_AUTHORIZATION_RUN_MIXED"));
        }
    };
    let value = signed_command_value(
        signer,
        board,
        next_nonce(nonce_state, board),
        entity_id,
        command_txs,
    )?;
    let command = decode_signed_entity_command(&value)?;
    let projected = CanonicalEntityTx::from_frame_projection(EntityTxKind::EntityCommand, value)
        .map_err(|error| invalid(error.to_string()))?;
    Ok((command, projected))
}

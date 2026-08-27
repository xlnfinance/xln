use xln_rscore_protocol::CanonicalValue;

use crate::{
    CanonicalEntityTx, EntityTxKind, LocalEntityFinancialTx, decode_local_entity_financial_tx,
};

use super::hash::{
    assert_txs_shape, hash_collective_action_txs, hash_entity_command_body, hash_entity_command_txs,
};
use super::value::{
    canonical_hex, exact_fields, exact_number, field, fixed_hex, object, positive_bigint, safe_u64,
    signer, string,
};
use super::{EntityCommandError, SignedEntityCommandV1, invalid};

fn assert_canonical_signature(signature: &[u8; 65]) -> Result<(), EntityCommandError> {
    const HALF_CURVE_ORDER: [u8; 32] = [
        0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4, 0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b,
        0x20, 0xa0,
    ];
    let invalid_scalar = signature[..32].iter().all(|byte| *byte == 0)
        || signature[32..64].iter().all(|byte| *byte == 0)
        || signature[32..64] > HALF_CURVE_ORDER[..];
    if signature[64] > 1 || invalid_scalar {
        return Err(invalid("ENTITY_COMMAND_SIGNATURE_INVALID"));
    }
    Ok(())
}

fn decode_native_action_txs(
    value: &CanonicalValue,
) -> Result<Vec<LocalEntityFinancialTx>, EntityCommandError> {
    let CanonicalValue::Array(txs) = value else {
        return Err(invalid(
            "ENTITY_COLLECTIVE_ACTION_TX_COUNT_INVALID:not-array",
        ));
    };
    assert_txs_shape(txs)?;
    let mut output = Vec::with_capacity(txs.len());
    for tx in txs {
        let entries = object(tx, "proposal.action.tx")?;
        exact_fields(entries, &["type", "data"], "proposal.action.tx")?;
        let kind_text = string(
            field(entries, "type", "proposal.action.tx")?,
            "ENTITY_COLLECTIVE_ACTION_TX_INVALID",
        )?;
        if matches!(
            kind_text.as_str(),
            "boardHandover"
                | "entityCommand"
                | "runtimeOutput"
                | "scheduledWake"
                | "j_event"
                | "accountInput"
        ) {
            return Err(invalid(format!(
                "ENTITY_COLLECTIVE_ACTION_TX_FORBIDDEN:{kind_text}"
            )));
        }
        let kind = EntityTxKind::parse(&kind_text).map_err(|error| invalid(error.to_string()))?;
        let tx = CanonicalEntityTx::from_frame_projection(
            kind,
            field(entries, "data", "proposal.action.tx")?.clone(),
        )
        .map_err(|error| invalid(error.to_string()))?;
        output.push(
            decode_local_entity_financial_tx(&tx)
                .map_err(|error| invalid(error.to_string()))?
                .ok_or_else(|| invalid(format!("ENTITY_TX_NATIVE_UNSUPPORTED:{kind_text}")))?,
        );
    }
    Ok(output)
}

fn decode_proposal(
    tx: &CanonicalValue,
    author: &str,
) -> Result<Vec<LocalEntityFinancialTx>, EntityCommandError> {
    let tx = object(tx, "command.tx")?;
    exact_fields(tx, &["type", "data"], "command.tx")?;
    let kind = string(
        field(tx, "type", "command.tx")?,
        "ENTITY_COMMAND_TX_INVALID",
    )?;
    if kind != "propose" {
        return Err(invalid(format!(
            "ENTITY_COMMAND_COLLECTIVE_ACTION_REQUIRES_PROPOSAL:{kind}"
        )));
    }
    let data = object(field(tx, "data", "command.tx")?, "command.propose")?;
    exact_fields(data, &["proposer", "action"], "command.propose")?;
    let proposer = signer(field(data, "proposer", "command.propose")?)?;
    if proposer != author {
        return Err(invalid(format!(
            "ENTITY_COMMAND_AUTHOR_FIELD_MISMATCH:propose.proposer:{proposer}:{author}"
        )));
    }
    let action = object(field(data, "action", "command.propose")?, "proposal.action")?;
    exact_fields(action, &["type", "data"], "proposal.action")?;
    if string(
        field(action, "type", "proposal.action")?,
        "ENTITY_PROPOSAL_ACTION_TYPE_INVALID",
    )? != "entity_transaction"
    {
        return Err(invalid("ENTITY_PROPOSAL_ACTION_TYPE_INVALID"));
    }
    let data = object(
        field(action, "data", "proposal.action")?,
        "proposal.action.data",
    )?;
    exact_fields(
        data,
        &["version", "actionHash", "txs"],
        "proposal.action.data",
    )?;
    exact_number(
        field(data, "version", "proposal.action.data")?,
        1,
        "ENTITY_PROPOSAL_TRANSACTION_DATA_INVALID",
    )?;
    let claimed = canonical_hex::<32>(
        field(data, "actionHash", "proposal.action.data")?,
        "ENTITY_PROPOSAL_ACTION_HASH_INVALID",
    )?;
    let txs = match field(data, "txs", "proposal.action.data")? {
        CanonicalValue::Array(txs) => txs,
        _ => {
            return Err(invalid(
                "ENTITY_COLLECTIVE_ACTION_TX_COUNT_INVALID:not-array",
            ));
        }
    };
    let computed = hash_collective_action_txs(txs)?;
    if claimed != computed {
        return Err(invalid(format!(
            "ENTITY_PROPOSAL_ACTION_HASH_MISMATCH:{claimed}:{computed}"
        )));
    }
    decode_native_action_txs(&CanonicalValue::Array(txs.clone()))
}

pub fn decode_signed_entity_command(
    value: &CanonicalValue,
) -> Result<SignedEntityCommandV1, EntityCommandError> {
    let command = object(value, "command")?;
    exact_fields(
        command,
        &[
            "version",
            "entityId",
            "stackKey",
            "boardHash",
            "boardEpoch",
            "authorSignerId",
            "authorSigner",
            "nonce",
            "txsHash",
            "txs",
            "signature",
        ],
        "command",
    )?;
    exact_number(
        field(command, "version", "command")?,
        1,
        "ENTITY_COMMAND_VERSION_INVALID",
    )?;
    let entity_id = canonical_hex::<32>(
        field(command, "entityId", "command")?,
        "ENTITY_COMMAND_ENTITY_ID_INVALID",
    )?;
    let stack_key = canonical_hex::<32>(
        field(command, "stackKey", "command")?,
        "ENTITY_COMMAND_STACK_KEY_INVALID",
    )?;
    let board_hash = canonical_hex::<32>(
        field(command, "boardHash", "command")?,
        "ENTITY_COMMAND_BOARD_HASH_INVALID",
    )?;
    let board_epoch = safe_u64(
        field(command, "boardEpoch", "command")?,
        "ENTITY_COMMAND_BOARD_EPOCH_INVALID",
    )?;
    let author_signer_id = signer(field(command, "authorSignerId", "command")?)?;
    let author_signer = canonical_hex::<20>(
        field(command, "authorSigner", "command")?,
        "ENTITY_COMMAND_AUTHOR_SIGNER_INVALID",
    )?;
    let nonce = positive_bigint(
        field(command, "nonce", "command")?,
        "ENTITY_COMMAND_NONCE_INVALID",
    )?;
    let txs_hash = canonical_hex::<32>(
        field(command, "txsHash", "command")?,
        "ENTITY_COMMAND_TXS_HASH_INVALID",
    )?;
    let txs = match field(command, "txs", "command")? {
        CanonicalValue::Array(txs) => txs.clone(),
        _ => return Err(invalid("ENTITY_COMMAND_TX_COUNT_INVALID:not-array")),
    };
    let computed_txs_hash = hash_entity_command_txs(&txs)?;
    if txs_hash != computed_txs_hash {
        return Err(invalid(format!(
            "ENTITY_COMMAND_TXS_HASH_MISMATCH:{txs_hash}:{computed_txs_hash}"
        )));
    }
    let mut native_txs = Vec::new();
    for tx in &txs {
        native_txs.extend(decode_proposal(tx, &author_signer_id)?);
    }
    let signature_text = canonical_hex::<65>(
        field(command, "signature", "command")?,
        "ENTITY_COMMAND_SIGNATURE_INVALID",
    )?;
    let signature = fixed_hex::<65>(&signature_text, "ENTITY_COMMAND_SIGNATURE_INVALID")?;
    assert_canonical_signature(&signature)?;
    let command_hash = hash_entity_command_body(
        1,
        &entity_id,
        &stack_key,
        &board_hash,
        board_epoch,
        &author_signer_id,
        &author_signer,
        &nonce,
        &txs_hash,
    )?;
    Ok(SignedEntityCommandV1 {
        version: 1,
        entity_id,
        stack_key,
        board_hash,
        board_epoch,
        author_signer_id,
        author_signer,
        nonce,
        txs_hash,
        txs,
        signature,
        command_hash,
        native_txs,
    })
}

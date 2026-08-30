use std::collections::BTreeMap;

use xln_rscore_engine::JurisdictionEvent;
use xln_rscore_protocol::CanonicalValue;

use crate::{
    CanonicalEntityTx, ConsensusMode, EntityConsensusConfig, EntityFrameAuthority,
    EntityKernelError, EntityLeaderState, EntityTxKind, FinalizedJEventBatch,
    current_entity_command_board_hash,
};

fn invalid(detail: impl Into<String>) -> EntityKernelError {
    EntityKernelError::BoardHandoverInvalid {
        detail: detail.into(),
    }
}

fn word(value: &[u8; 32]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(66);
    output.push_str("0x");
    for byte in value {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

fn object<'a>(
    value: &'a CanonicalValue,
    path: &str,
) -> Result<&'a [(String, CanonicalValue)], EntityKernelError> {
    match value {
        CanonicalValue::Object(fields) => Ok(fields),
        _ => Err(invalid(format!("OBJECT_REQUIRED:{path}"))),
    }
}

fn field<'a>(
    fields: &'a [(String, CanonicalValue)],
    name: &str,
    path: &str,
) -> Result<&'a CanonicalValue, EntityKernelError> {
    fields
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
        .ok_or_else(|| invalid(format!("FIELD_REQUIRED:{path}.{name}")))
}

fn exact_fields(
    fields: &[(String, CanonicalValue)],
    expected: &[&str],
    path: &str,
) -> Result<(), EntityKernelError> {
    if fields.len() != expected.len() {
        return Err(invalid(format!("FIELDS_INVALID:{path}")));
    }
    for expected in expected {
        if !fields.iter().any(|(field, _)| field == expected) {
            return Err(invalid(format!("FIELD_REQUIRED:{path}.{expected}")));
        }
    }
    Ok(())
}

fn text(value: &CanonicalValue, path: &str) -> Result<String, EntityKernelError> {
    match value {
        CanonicalValue::String(value) if !value.is_empty() => Ok(value.clone()),
        _ => Err(invalid(format!("TEXT_REQUIRED:{path}"))),
    }
}

fn positive_u16(value: &CanonicalValue, path: &str) -> Result<u16, EntityKernelError> {
    let CanonicalValue::BigInt(value) = value else {
        return Err(invalid(format!("BIGINT_REQUIRED:{path}")));
    };
    u16::try_from(value.clone())
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| invalid(format!("POSITIVE_U16_REQUIRED:{path}")))
}

fn canonical_signer(value: &CanonicalValue, path: &str) -> Result<String, EntityKernelError> {
    let value = text(value, path)?;
    if value != value.trim().to_lowercase() {
        return Err(invalid(format!("SIGNER_NON_CANONICAL:{path}:{value}")));
    }
    Ok(value)
}

fn decode_config(
    current: &EntityFrameAuthority,
    tx: &CanonicalEntityTx,
) -> Result<EntityConsensusConfig, EntityKernelError> {
    let data = object(
        tx.frame_data()
            .ok_or_else(|| invalid("BOARD_HANDOVER_DATA_MISSING"))?,
        "boardHandover.data",
    )?;
    exact_fields(data, &["board"], "boardHandover.data")?;
    let board = object(field(data, "board", "boardHandover.data")?, "board")?;
    exact_fields(
        board,
        &["mode", "threshold", "validators", "shares"],
        "board",
    )?;
    let mode = match text(field(board, "mode", "board")?, "board.mode")?.as_str() {
        "proposer-based" => ConsensusMode::ProposerBased,
        "gossip-based" => ConsensusMode::GossipBased,
        value => return Err(invalid(format!("MODE_INVALID:{value}"))),
    };
    if mode != current.config.mode {
        return Err(invalid("BOARD_HANDOVER_MODE_CHANGE_FORBIDDEN"));
    }
    let validators = match field(board, "validators", "board")? {
        CanonicalValue::Array(values) => values
            .iter()
            .enumerate()
            .map(|(index, value)| canonical_signer(value, &format!("board.validators.{index}")))
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err(invalid("BOARD_HANDOVER_VALIDATORS_ARRAY_REQUIRED")),
    };
    let mut shares = BTreeMap::new();
    for (signer, share) in object(field(board, "shares", "board")?, "board.shares")? {
        if signer != &signer.trim().to_lowercase() {
            return Err(invalid(format!(
                "BOARD_HANDOVER_SHARE_SIGNER_NON_CANONICAL:{signer}"
            )));
        }
        if shares
            .insert(
                signer.clone(),
                positive_u16(share, &format!("board.shares.{signer}"))?,
            )
            .is_some()
        {
            return Err(invalid(format!("BOARD_HANDOVER_SHARE_DUPLICATE:{signer}")));
        }
    }
    let config = EntityConsensusConfig {
        mode,
        threshold: positive_u16(field(board, "threshold", "board")?, "board.threshold")?,
        validators,
        shares,
        // Jurisdiction is authority carried by the existing state. It is not
        // present in the handover preimage and cannot be changed by this tx.
        jurisdiction: current.config.jurisdiction.clone(),
    };
    EntityFrameAuthority {
        leader_state: EntityLeaderState {
            active_validator_id: config.validators.first().cloned().unwrap_or_default(),
            view: 0,
            changed_at_height: 0,
        },
        config,
    }
    .validate_and_normalize()
    .map(|authority| authority.config)
    .map_err(|error| invalid(error.to_string()))
}

/// Resolve the post-frame authority for the exact TS board-handover shape.
///
/// The J watcher batches are the typed form of the same `j_event` transaction
/// already inserted into `txs`; they are not a second oracle. Runtime creates
/// both values once from the authenticated receipt range and passes them
/// through the same transition.
pub fn resolve_board_handover_authority(
    current: &EntityFrameAuthority,
    entity_id: &[u8; 32],
    next_height: u64,
    txs: &[CanonicalEntityTx],
    batches: &[FinalizedJEventBatch],
) -> Result<EntityFrameAuthority, EntityKernelError> {
    let handovers = txs
        .iter()
        .filter(|tx| tx.kind == EntityTxKind::BoardHandover)
        .collect::<Vec<_>>();
    if handovers.is_empty() {
        return Ok(current.clone());
    }
    if handovers.len() != 1 {
        return Err(invalid(format!(
            "BOARD_HANDOVER_COUNT_INVALID:{}",
            handovers.len()
        )));
    }
    if txs.len() != 2
        || txs[0].kind != EntityTxKind::JEvent
        || txs[1].kind != EntityTxKind::BoardHandover
    {
        return Err(invalid(format!(
            "BOARD_HANDOVER_FRAME_SHAPE_INVALID:{}",
            txs.iter()
                .map(|tx| tx.kind.as_str())
                .collect::<Vec<_>>()
                .join(",")
        )));
    }
    let config = decode_config(current, handovers[0])?;
    let mut expected = current_entity_command_board_hash(current, "")
        .map_err(|error| invalid(error.to_string()))?;
    let mut activation_count = 0_usize;
    for event in batches.iter().flat_map(|batch| &batch.events) {
        let JurisdictionEvent::BoardActivated(event) = event else {
            continue;
        };
        if event.entity_id.as_bytes() != entity_id {
            continue;
        }
        let previous = word(&event.previous_board_hash);
        if previous != expected {
            return Err(invalid(format!(
                "BOARD_HANDOVER_ACTIVATION_CHAIN_INVALID:{previous}:{expected}"
            )));
        }
        expected = word(&event.new_board_hash);
        activation_count = activation_count
            .checked_add(1)
            .ok_or_else(|| invalid("BOARD_HANDOVER_ACTIVATION_COUNT_OVERFLOW"))?;
    }
    if activation_count == 0 {
        return Err(invalid("BOARD_HANDOVER_ACTIVATION_MISSING"));
    }
    let post = EntityFrameAuthority {
        leader_state: EntityLeaderState {
            active_validator_id: config
                .validators
                .first()
                .cloned()
                .ok_or_else(|| invalid("BOARD_HANDOVER_VALIDATOR_MISSING"))?,
            view: 0,
            changed_at_height: next_height,
        },
        config,
    }
    .validate_and_normalize()
    .map_err(|error| invalid(error.to_string()))?;
    let post_hash =
        current_entity_command_board_hash(&post, "").map_err(|error| invalid(error.to_string()))?;
    if post_hash != expected {
        return Err(invalid(format!(
            "BOARD_HANDOVER_CONFIG_HASH_MISMATCH:{post_hash}:{expected}"
        )));
    }
    Ok(post)
}

#[cfg(test)]
mod tests {
    use num_bigint::BigInt;
    use xln_rscore_engine::{BoardActivatedEvent, EntityId, JEventMetadata};

    use super::*;

    fn text(value: impl Into<String>) -> CanonicalValue {
        CanonicalValue::String(value.into())
    }

    fn config(signer: &str) -> EntityFrameAuthority {
        EntityFrameAuthority {
            config: EntityConsensusConfig {
                mode: ConsensusMode::ProposerBased,
                threshold: 1,
                validators: vec![signer.into()],
                shares: BTreeMap::from([(signer.into(), 1)]),
                jurisdiction: None,
            },
            leader_state: EntityLeaderState {
                active_validator_id: signer.into(),
                view: 0,
                changed_at_height: 0,
            },
        }
    }

    fn handover(signer: &str) -> CanonicalEntityTx {
        CanonicalEntityTx::from_frame_projection(
            EntityTxKind::BoardHandover,
            CanonicalValue::Object(vec![(
                "board".into(),
                CanonicalValue::Object(vec![
                    ("mode".into(), text("proposer-based")),
                    ("threshold".into(), CanonicalValue::BigInt(1.into())),
                    (
                        "validators".into(),
                        CanonicalValue::Array(vec![text(signer)]),
                    ),
                    (
                        "shares".into(),
                        CanonicalValue::Object(vec![(
                            signer.into(),
                            CanonicalValue::BigInt(1.into()),
                        )]),
                    ),
                ]),
            )]),
        )
        .expect("handover projection")
    }

    fn activation_batch(
        entity_id: EntityId,
        previous_board_hash: [u8; 32],
        new_board_hash: [u8; 32],
    ) -> FinalizedJEventBatch {
        FinalizedJEventBatch {
            j_height: 9,
            j_block_hash: [0x90; 32],
            events: vec![JurisdictionEvent::BoardActivated(BoardActivatedEvent {
                metadata: JEventMetadata {
                    block_number: Some(9),
                    block_hash: Some([0x90; 32]),
                    transaction_hash: Some([0x91; 32]),
                    log_index: Some(0),
                    event_index: None,
                },
                entity_id,
                previous_board_hash,
                new_board_hash,
                previous_board_valid_until: BigInt::from(100_u8),
            })],
            dispute_finalization_evidence: Vec::new(),
            reserve_updates: Vec::new(),
            account_claims: Vec::new(),
        }
    }

    fn bytes(value: &str) -> [u8; 32] {
        let body = value.strip_prefix("0x").expect("hex prefix");
        let mut output = [0_u8; 32];
        for (index, byte) in output.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&body[index * 2..index * 2 + 2], 16).expect("hex");
        }
        output
    }

    #[test]
    fn exact_j_event_handover_chain_changes_one_post_authority() {
        let old_signer = format!("0x{}", "11".repeat(20));
        let new_signer = format!("0x{}", "22".repeat(20));
        let current = config(&old_signer);
        let candidate = config(&new_signer);
        let old_hash =
            bytes(&current_entity_command_board_hash(&current, "").expect("current board hash"));
        let new_hash =
            bytes(&current_entity_command_board_hash(&candidate, "").expect("next board hash"));
        let entity_id = EntityId::parse(&format!("0x{}", "33".repeat(32))).expect("entity");
        let txs = vec![
            CanonicalEntityTx::from_frame_projection(
                EntityTxKind::JEvent,
                CanonicalValue::Object(Vec::new()),
            )
            .expect("J event"),
            handover(&new_signer),
        ];
        let post = resolve_board_handover_authority(
            &current,
            entity_id.as_bytes(),
            7,
            &txs,
            &[activation_batch(entity_id.clone(), old_hash, new_hash)],
        )
        .expect("authorized handover");
        assert_eq!(post.config, candidate.config);
        assert_eq!(post.leader_state.active_validator_id, new_signer);
        assert_eq!(post.leader_state.view, 0);
        assert_eq!(post.leader_state.changed_at_height, 7);
    }

    #[test]
    fn handover_rejects_any_extra_frame_transaction() {
        let signer = format!("0x{}", "11".repeat(20));
        let current = config(&signer);
        let error = resolve_board_handover_authority(
            &current,
            &[0x33; 32],
            1,
            &[
                CanonicalEntityTx::from_frame_projection(
                    EntityTxKind::JEvent,
                    CanonicalValue::Object(Vec::new()),
                )
                .expect("J event"),
                handover(&signer),
                CanonicalEntityTx::from_frame_projection(
                    EntityTxKind::Chat,
                    CanonicalValue::Object(Vec::new()),
                )
                .expect("chat"),
            ],
            &[],
        )
        .expect_err("extra transaction must fail");
        assert!(
            error
                .to_string()
                .contains("BOARD_HANDOVER_FRAME_SHAPE_INVALID")
        );
    }
}

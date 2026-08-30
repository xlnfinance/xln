use xln_rscore_abi::AbiValue;
use xln_rscore_engine::{JEventMetadata, JurisdictionEvent, ProofBody, ProofTransformerClause};

use super::{JEventWireError, integer, invalid, tuple};

/// Positional tags are append-only.  `AccountSettled = 0` is the deployed
/// shape; the remaining canonical TS catalog follows at tags 1 through 17.
pub fn encode_jurisdiction_event(event: &JurisdictionEvent) -> Result<AbiValue, JEventWireError> {
    xln_rscore_engine::canonical_event_key(event)
        .map_err(|error| invalid(format!("INVALID:{error}")))?;
    Ok(match event {
        JurisdictionEvent::AccountSettled(value) => tuple(vec![
            integer(0),
            metadata(&value.metadata),
            bytes(value.left_entity.as_bytes()),
            bytes(value.right_entity.as_bytes()),
            integer(value.token_id.get()),
            big(&value.left_reserve),
            big(&value.right_reserve),
            big(&value.collateral),
            big(&value.ondelta),
            integer(value.nonce),
        ]),
        JurisdictionEvent::FoundationBootstrapped(value) => tuple(vec![
            integer(1),
            metadata(&value.metadata),
            bytes(&value.recipient),
            bytes(&value.board_hash),
            big(&value.control_token_id),
            big(&value.dividend_token_id),
        ]),
        JurisdictionEvent::EntityRegistered(value) => tuple(vec![
            integer(2),
            metadata(&value.metadata),
            bytes(value.entity_id.as_bytes()),
            big(&value.entity_number),
            bytes(&value.board_hash),
        ]),
        JurisdictionEvent::BoardActivated(value) => tuple(vec![
            integer(3),
            metadata(&value.metadata),
            bytes(value.entity_id.as_bytes()),
            bytes(&value.previous_board_hash),
            bytes(&value.new_board_hash),
            big(&value.previous_board_valid_until),
        ]),
        JurisdictionEvent::ReserveUpdated(value) => tuple(vec![
            integer(4),
            metadata(&value.metadata),
            AbiValue::Text(value.entity.clone()),
            integer(value.token_id),
            big(&value.new_balance),
        ]),
        JurisdictionEvent::ExternalWalletSnapshot(value) => tuple(vec![
            integer(5),
            metadata(&value.metadata),
            AbiValue::Text(value.entity_id.clone()),
            bytes(&value.owner),
            optional_big(value.native_balance.as_ref()),
            tuple(
                value
                    .token_balances
                    .iter()
                    .map(|balance| {
                        tuple(vec![
                            bytes(&balance.token_address),
                            optional_i64(balance.token_id),
                            big(&balance.balance),
                        ])
                    })
                    .collect(),
            ),
            tuple(
                value
                    .allowances
                    .iter()
                    .map(|allowance| {
                        tuple(vec![
                            bytes(&allowance.token_address),
                            bytes(&allowance.spender),
                            big(&allowance.allowance),
                        ])
                    })
                    .collect(),
            ),
        ]),
        JurisdictionEvent::ExternalWalletDelta(value) => tuple(vec![
            integer(6),
            metadata(&value.metadata),
            AbiValue::Text(value.entity_id.clone()),
            bytes(&value.owner),
            bytes(&value.token_address),
            optional_i64(value.token_id),
            optional_big(value.balance_delta.as_ref()),
            value
                .spender
                .map_or(AbiValue::Nil, |address| bytes(&address)),
            optional_big(value.allowance.as_ref()),
        ]),
        JurisdictionEvent::SecretRevealed(value) => tuple(vec![
            integer(7),
            metadata(&value.metadata),
            AbiValue::Text(value.hashlock.clone()),
            AbiValue::Text(value.revealer.clone()),
            AbiValue::Text(value.secret.clone()),
        ]),
        JurisdictionEvent::HankoBatchProcessed(value) => tuple(vec![
            integer(8),
            metadata(&value.metadata),
            bytes(value.entity_id.as_bytes()),
            bytes(&value.batch_hash),
            integer(value.nonce),
        ]),
        JurisdictionEvent::EntityProviderActionExecuted(value) => tuple(vec![
            integer(9),
            metadata(&value.metadata),
            bytes(value.entity_id.as_bytes()),
            big(&value.action_nonce),
            bytes(&value.action_hash),
            integer(value.action_kind),
        ]),
        JurisdictionEvent::EntityProviderActionCancelled(value) => tuple(vec![
            integer(10),
            metadata(&value.metadata),
            bytes(value.entity_id.as_bytes()),
            big(&value.action_nonce),
            bytes(&value.cancelled_action_hash),
            integer(value.cancelled_action_kind),
            bytes(&value.cancel_hash),
        ]),
        JurisdictionEvent::DebtCreated(value) => tuple(vec![
            integer(11),
            metadata(&value.metadata),
            AbiValue::Text(value.debtor.clone()),
            AbiValue::Text(value.creditor.clone()),
            integer(value.token_id),
            big(&value.amount),
            integer(value.debt_index),
        ]),
        JurisdictionEvent::DisputeStarted(value) => tuple(vec![
            integer(12),
            metadata(&value.metadata),
            AbiValue::Text(value.sender.clone()),
            AbiValue::Text(value.counterentity.clone()),
            big(&value.nonce),
            AbiValue::Bool(value.proposer_is_left),
            AbiValue::Text(value.proofbody_hash.clone()),
            bytes(&value.watch_seed),
            bytes(&value.starter_initial_arguments),
            bytes(&value.starter_counter_arguments),
            bytes(&value.starter_counter_proof_commitment),
            proof_body(&value.initial_proofbody),
            integer(value.dispute_timeout),
            integer(value.dispute_start_timestamp),
            integer(value.left_response_seconds),
            integer(value.right_response_seconds),
            optional_i64(value.batch_nonce),
        ]),
        JurisdictionEvent::DisputeFinalized(value) => tuple(vec![
            integer(13),
            metadata(&value.metadata),
            AbiValue::Text(value.sender.clone()),
            AbiValue::Text(value.counterentity.clone()),
            big(&value.initial_nonce),
            AbiValue::Text(value.initial_proofbody_hash.clone()),
            AbiValue::Text(value.final_proofbody_hash.clone()),
            AbiValue::Text(value.finalization_evidence_hash.clone()),
            proof_body(&value.final_proofbody),
            optional_i64(value.batch_nonce),
        ]),
        JurisdictionEvent::CounterDisputeRegistered(value) => tuple(vec![
            integer(14),
            metadata(&value.metadata),
            AbiValue::Text(value.sender.clone()),
            AbiValue::Text(value.counterentity.clone()),
            integer(value.nonce),
            AbiValue::Bool(value.proposer_is_left),
            bytes(&value.proofbody_hash),
            proof_body(&value.counter_proofbody),
        ]),
        JurisdictionEvent::HashLadderRevealRegistered(value) => tuple(vec![
            integer(15),
            metadata(&value.metadata),
            AbiValue::Text(value.entity.clone()),
            AbiValue::Text(value.counterparty_entity.clone()),
            bytes(&value.ladder_hash),
            integer(value.fill_ratio),
            bytes(&value.full_secret),
            tuple(value.reveals.iter().map(|reveal| bytes(reveal)).collect()),
            AbiValue::Bool(value.target_role),
            integer(value.revealed_at),
        ]),
        JurisdictionEvent::DebtEnforced(value) => tuple(vec![
            integer(16),
            metadata(&value.metadata),
            AbiValue::Text(value.debtor.clone()),
            AbiValue::Text(value.creditor.clone()),
            integer(value.token_id),
            big(&value.amount_paid),
            big(&value.remaining_amount),
            integer(value.new_debt_index),
        ]),
        JurisdictionEvent::DebtForgiven(value) => tuple(vec![
            integer(17),
            metadata(&value.metadata),
            AbiValue::Text(value.debtor.clone()),
            AbiValue::Text(value.creditor.clone()),
            integer(value.token_id),
            big(&value.amount_forgiven),
            integer(value.debt_index),
        ]),
    })
}

fn metadata(value: &JEventMetadata) -> AbiValue {
    tuple(vec![
        value.block_number.map_or(AbiValue::Nil, integer),
        value
            .block_hash
            .map_or(AbiValue::Nil, |value| bytes(&value)),
        value
            .transaction_hash
            .map_or(AbiValue::Nil, |value| bytes(&value)),
        value.log_index.map_or(AbiValue::Nil, integer),
        value.event_index.map_or(AbiValue::Nil, integer),
    ])
}

fn proof_body(value: &ProofBody) -> AbiValue {
    tuple(vec![
        AbiValue::Text(value.watch_seed.clone()),
        integer(value.left_response_seconds),
        integer(value.right_response_seconds),
        tuple(value.offdeltas.iter().map(big).collect()),
        tuple(value.token_ids.iter().map(big).collect()),
        tuple(value.transformers.iter().map(transformer).collect()),
    ])
}

fn transformer(value: &ProofTransformerClause) -> AbiValue {
    tuple(vec![
        AbiValue::Text(value.transformer_address.clone()),
        AbiValue::Text(value.encoded_batch.clone()),
        tuple(
            value
                .allowances
                .iter()
                .map(|allowance| {
                    tuple(vec![
                        big(&allowance.delta_index),
                        big(&allowance.right_allowance),
                        big(&allowance.left_allowance),
                    ])
                })
                .collect(),
        ),
    ])
}

fn big(value: &num_bigint::BigInt) -> AbiValue {
    AbiValue::Text(value.to_string())
}

fn optional_big(value: Option<&num_bigint::BigInt>) -> AbiValue {
    value.map_or(AbiValue::Nil, big)
}

fn optional_i64(value: Option<i64>) -> AbiValue {
    value.map_or(AbiValue::Nil, integer)
}

fn bytes(value: &[u8]) -> AbiValue {
    AbiValue::Bytes(value.to_vec())
}

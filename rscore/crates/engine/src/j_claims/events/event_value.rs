use xln_rscore_protocol::CanonicalValue;

use super::event_types::JurisdictionEvent;
use super::event_value_support::{
    address, boolean, bytes, entity, external_allowance, hash, i64_number, metadata_fields, object,
    proof_body, push_i64, text, token_balance, u64_number,
};
use super::events::validate_event;
use crate::StateError;

pub fn canonical_event_value(event: &JurisdictionEvent) -> Result<CanonicalValue, StateError> {
    validate_event(event)?;
    let mut fields = metadata_fields(event.metadata())?;
    fields.push(("type".into(), text(event.kind())));
    fields.push(("data".into(), canonical_event_data_value(event)?));
    Ok(CanonicalValue::Object(fields))
}

pub(crate) fn canonical_event_data_value(
    event: &JurisdictionEvent,
) -> Result<CanonicalValue, StateError> {
    Ok(match event {
        JurisdictionEvent::AccountSettled(value) => object(vec![
            ("leftEntity", entity(&value.left_entity)),
            ("rightEntity", entity(&value.right_entity)),
            ("tokenId", u64_number(u64::from(value.token_id.get()))?),
            ("leftReserve", text(&value.left_reserve.to_string())),
            ("rightReserve", text(&value.right_reserve.to_string())),
            ("collateral", text(&value.collateral.to_string())),
            ("ondelta", text(&value.ondelta.to_string())),
            ("nonce", u64_number(value.nonce)?),
        ]),
        JurisdictionEvent::FoundationBootstrapped(value) => object(vec![
            ("recipient", address(&value.recipient)),
            ("boardHash", hash(&value.board_hash)),
            ("controlTokenId", text(&value.control_token_id.to_string())),
            (
                "dividendTokenId",
                text(&value.dividend_token_id.to_string()),
            ),
        ]),
        JurisdictionEvent::EntityRegistered(value) => object(vec![
            ("entityId", entity(&value.entity_id)),
            ("entityNumber", text(&value.entity_number.to_string())),
            ("boardHash", hash(&value.board_hash)),
        ]),
        JurisdictionEvent::BoardActivated(value) => object(vec![
            ("entityId", entity(&value.entity_id)),
            ("previousBoardHash", hash(&value.previous_board_hash)),
            ("newBoardHash", hash(&value.new_board_hash)),
            (
                "previousBoardValidUntil",
                text(&value.previous_board_valid_until.to_string()),
            ),
        ]),
        JurisdictionEvent::ReserveUpdated(value) => object(vec![
            ("entity", text(&value.entity)),
            ("tokenId", i64_number(value.token_id)?),
            ("newBalance", text(&value.new_balance.to_string())),
        ]),
        JurisdictionEvent::ExternalWalletSnapshot(value) => {
            let mut fields = vec![
                ("entityId", text(&value.entity_id)),
                ("owner", address(&value.owner)),
            ];
            if let Some(balance) = &value.native_balance {
                fields.push(("nativeBalance", text(&balance.to_string())));
            }
            if !value.token_balances.is_empty() {
                fields.push((
                    "tokenBalances",
                    CanonicalValue::Array(
                        value
                            .token_balances
                            .iter()
                            .map(token_balance)
                            .collect::<Result<Vec<_>, _>>()?,
                    ),
                ));
            }
            if !value.allowances.is_empty() {
                fields.push((
                    "allowances",
                    CanonicalValue::Array(
                        value.allowances.iter().map(external_allowance).collect(),
                    ),
                ));
            }
            object(fields)
        }
        JurisdictionEvent::ExternalWalletDelta(value) => {
            let mut fields = vec![
                ("entityId", text(&value.entity_id)),
                ("owner", address(&value.owner)),
                ("tokenAddress", address(&value.token_address)),
            ];
            push_i64(&mut fields, "tokenId", value.token_id)?;
            if let Some(balance) = &value.balance_delta {
                fields.push(("balanceDelta", text(&balance.to_string())));
            }
            if let (Some(spender), Some(allowance)) = (&value.spender, &value.allowance) {
                fields.push(("spender", address(spender)));
                fields.push(("allowance", text(&allowance.to_string())));
            }
            object(fields)
        }
        JurisdictionEvent::SecretRevealed(value) => object(vec![
            ("hashlock", text(&value.hashlock)),
            ("revealer", text(&value.revealer)),
            ("secret", text(&value.secret)),
        ]),
        JurisdictionEvent::HankoBatchProcessed(value) => object(vec![
            ("entityId", entity(&value.entity_id)),
            ("batchHash", hash(&value.batch_hash)),
            ("nonce", u64_number(value.nonce)?),
        ]),
        JurisdictionEvent::EntityProviderActionExecuted(value) => object(vec![
            ("entityId", entity(&value.entity_id)),
            ("actionNonce", text(&value.action_nonce.to_string())),
            ("actionHash", hash(&value.action_hash)),
            ("actionKind", u64_number(u64::from(value.action_kind))?),
        ]),
        JurisdictionEvent::EntityProviderActionCancelled(value) => object(vec![
            ("entityId", entity(&value.entity_id)),
            ("actionNonce", text(&value.action_nonce.to_string())),
            ("cancelledActionHash", hash(&value.cancelled_action_hash)),
            (
                "cancelledActionKind",
                u64_number(u64::from(value.cancelled_action_kind))?,
            ),
            ("cancelHash", hash(&value.cancel_hash)),
        ]),
        JurisdictionEvent::DebtCreated(value) => object(vec![
            ("debtor", text(&value.debtor)),
            ("creditor", text(&value.creditor)),
            ("tokenId", i64_number(value.token_id)?),
            ("amount", text(&value.amount.to_string())),
            ("debtIndex", i64_number(value.debt_index)?),
        ]),
        JurisdictionEvent::DisputeStarted(value) => {
            let mut fields = vec![
                ("sender", text(&value.sender)),
                ("counterentity", text(&value.counterentity)),
                ("nonce", text(&value.nonce.to_string())),
                ("proposerIsLeft", boolean(value.proposer_is_left)),
                ("proofbodyHash", text(&value.proofbody_hash)),
                ("watchSeed", hash(&value.watch_seed)),
                (
                    "starterInitialArguments",
                    bytes(&value.starter_initial_arguments),
                ),
                (
                    "starterCounterArguments",
                    bytes(&value.starter_counter_arguments),
                ),
                (
                    "starterCounterProofCommitment",
                    hash(&value.starter_counter_proof_commitment),
                ),
                ("initialProofbody", proof_body(&value.initial_proofbody)?),
                ("disputeTimeout", u64_number(value.dispute_timeout)?),
                (
                    "disputeStartTimestamp",
                    u64_number(value.dispute_start_timestamp)?,
                ),
                (
                    "leftResponseSeconds",
                    u64_number(value.left_response_seconds)?,
                ),
                (
                    "rightResponseSeconds",
                    u64_number(value.right_response_seconds)?,
                ),
            ];
            push_i64(&mut fields, "batchNonce", value.batch_nonce)?;
            object(fields)
        }
        JurisdictionEvent::DisputeFinalized(value) => {
            let mut fields = vec![
                ("sender", text(&value.sender)),
                ("counterentity", text(&value.counterentity)),
                ("initialNonce", text(&value.initial_nonce.to_string())),
                ("initialProofbodyHash", text(&value.initial_proofbody_hash)),
                ("finalProofbodyHash", text(&value.final_proofbody_hash)),
                (
                    "finalizationEvidenceHash",
                    text(&value.finalization_evidence_hash),
                ),
                ("finalProofbody", proof_body(&value.final_proofbody)?),
            ];
            push_i64(&mut fields, "batchNonce", value.batch_nonce)?;
            object(fields)
        }
        JurisdictionEvent::CounterDisputeRegistered(value) => object(vec![
            ("sender", text(&value.sender)),
            ("counterentity", text(&value.counterentity)),
            ("nonce", i64_number(value.nonce)?),
            ("proposerIsLeft", boolean(value.proposer_is_left)),
            ("proofbodyHash", hash(&value.proofbody_hash)),
            ("counterProofbody", proof_body(&value.counter_proofbody)?),
        ]),
        JurisdictionEvent::HashLadderRevealRegistered(value) => object(vec![
            ("entity", text(&value.entity)),
            ("counterpartyEntity", text(&value.counterparty_entity)),
            ("ladderHash", hash(&value.ladder_hash)),
            ("fillRatio", u64_number(u64::from(value.fill_ratio))?),
            ("fullSecret", hash(&value.full_secret)),
            (
                "reveals",
                CanonicalValue::Array(value.reveals.iter().map(hash).collect()),
            ),
            ("targetRole", boolean(value.target_role)),
            ("revealedAt", u64_number(value.revealed_at)?),
        ]),
        JurisdictionEvent::DebtEnforced(value) => object(vec![
            ("debtor", text(&value.debtor)),
            ("creditor", text(&value.creditor)),
            ("tokenId", i64_number(value.token_id)?),
            ("amountPaid", text(&value.amount_paid.to_string())),
            ("remainingAmount", text(&value.remaining_amount.to_string())),
            ("newDebtIndex", i64_number(value.new_debt_index)?),
        ]),
        JurisdictionEvent::DebtForgiven(value) => object(vec![
            ("debtor", text(&value.debtor)),
            ("creditor", text(&value.creditor)),
            ("tokenId", i64_number(value.token_id)?),
            ("amountForgiven", text(&value.amount_forgiven.to_string())),
            ("debtIndex", i64_number(value.debt_index)?),
        ]),
    })
}

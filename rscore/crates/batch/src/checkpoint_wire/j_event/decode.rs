use num_bigint::BigInt;
use xln_rscore_abi::AbiValue;
use xln_rscore_engine::{
    AccountSettledEvent, BoardActivatedEvent, CounterDisputeRegisteredEvent, DebtCreatedEvent,
    DebtEnforcedEvent, DebtForgivenEvent, DisputeFinalizedEvent, DisputeStartedEvent, EntityId,
    EntityProviderActionCancelledEvent, EntityProviderActionExecutedEvent, EntityRegisteredEvent,
    ExternalAllowance, ExternalTokenBalance, ExternalWalletDeltaEvent, ExternalWalletSnapshotEvent,
    FoundationBootstrappedEvent, HankoBatchProcessedEvent, HashLadderRevealRegisteredEvent,
    JEventMetadata, JurisdictionEvent, ProofAllowance, ProofBody, ProofTransformerClause,
    ReserveUpdatedEvent, SecretRevealedEvent, TokenId,
};

use super::{JEventWireError, invalid};

pub fn decode_jurisdiction_event(value: &AbiValue) -> Result<JurisdictionEvent, JEventWireError> {
    let fields = list(value, "EVENT")?;
    let tag = tag(
        fields.first().ok_or_else(|| invalid("EVENT_TAG_MISSING"))?,
        "EVENT_TAG",
    )?;
    let event = match tag {
        0 => {
            let row = exact(fields, 10, "ACCOUNT_SETTLED")?;
            JurisdictionEvent::AccountSettled(AccountSettledEvent {
                metadata: metadata(&row[1])?,
                left_entity: entity(&row[2], "LEFT_ENTITY")?,
                right_entity: entity(&row[3], "RIGHT_ENTITY")?,
                token_id: token(&row[4])?,
                left_reserve: big(&row[5], "LEFT_RESERVE")?,
                right_reserve: big(&row[6], "RIGHT_RESERVE")?,
                collateral: big(&row[7], "COLLATERAL")?,
                ondelta: big(&row[8], "ONDELTA")?,
                nonce: u64_value(&row[9], "NONCE")?,
            })
        }
        1 => {
            let row = exact(fields, 6, "FOUNDATION_BOOTSTRAPPED")?;
            JurisdictionEvent::FoundationBootstrapped(FoundationBootstrappedEvent {
                metadata: metadata(&row[1])?,
                recipient: fixed(&row[2], "RECIPIENT")?,
                board_hash: fixed(&row[3], "BOARD_HASH")?,
                control_token_id: big(&row[4], "CONTROL_TOKEN_ID")?,
                dividend_token_id: big(&row[5], "DIVIDEND_TOKEN_ID")?,
            })
        }
        2 => {
            let row = exact(fields, 5, "ENTITY_REGISTERED")?;
            JurisdictionEvent::EntityRegistered(EntityRegisteredEvent {
                metadata: metadata(&row[1])?,
                entity_id: entity(&row[2], "ENTITY_ID")?,
                entity_number: big(&row[3], "ENTITY_NUMBER")?,
                board_hash: fixed(&row[4], "BOARD_HASH")?,
            })
        }
        3 => {
            let row = exact(fields, 6, "BOARD_ACTIVATED")?;
            JurisdictionEvent::BoardActivated(BoardActivatedEvent {
                metadata: metadata(&row[1])?,
                entity_id: entity(&row[2], "ENTITY_ID")?,
                previous_board_hash: fixed(&row[3], "PREVIOUS_BOARD_HASH")?,
                new_board_hash: fixed(&row[4], "NEW_BOARD_HASH")?,
                previous_board_valid_until: big(&row[5], "PREVIOUS_BOARD_VALID_UNTIL")?,
            })
        }
        4 => {
            let row = exact(fields, 5, "RESERVE_UPDATED")?;
            JurisdictionEvent::ReserveUpdated(ReserveUpdatedEvent {
                metadata: metadata(&row[1])?,
                entity: text(&row[2], "ENTITY")?,
                token_id: i64_value(&row[3], "TOKEN_ID")?,
                new_balance: big(&row[4], "NEW_BALANCE")?,
            })
        }
        5 => decode_wallet_snapshot(fields)?,
        6 => decode_wallet_delta(fields)?,
        7 => {
            let row = exact(fields, 5, "SECRET_REVEALED")?;
            JurisdictionEvent::SecretRevealed(SecretRevealedEvent {
                metadata: metadata(&row[1])?,
                hashlock: text(&row[2], "HASHLOCK")?,
                revealer: text(&row[3], "REVEALER")?,
                secret: text(&row[4], "SECRET")?,
            })
        }
        8 => {
            let row = exact(fields, 5, "HANKO_BATCH_PROCESSED")?;
            JurisdictionEvent::HankoBatchProcessed(HankoBatchProcessedEvent {
                metadata: metadata(&row[1])?,
                entity_id: entity(&row[2], "ENTITY_ID")?,
                batch_hash: fixed(&row[3], "BATCH_HASH")?,
                nonce: u64_value(&row[4], "NONCE")?,
            })
        }
        9 => {
            let row = exact(fields, 6, "ACTION_EXECUTED")?;
            JurisdictionEvent::EntityProviderActionExecuted(EntityProviderActionExecutedEvent {
                metadata: metadata(&row[1])?,
                entity_id: entity(&row[2], "ENTITY_ID")?,
                action_nonce: big(&row[3], "ACTION_NONCE")?,
                action_hash: fixed(&row[4], "ACTION_HASH")?,
                action_kind: u8_value(&row[5], "ACTION_KIND")?,
            })
        }
        10 => {
            let row = exact(fields, 7, "ACTION_CANCELLED")?;
            JurisdictionEvent::EntityProviderActionCancelled(EntityProviderActionCancelledEvent {
                metadata: metadata(&row[1])?,
                entity_id: entity(&row[2], "ENTITY_ID")?,
                action_nonce: big(&row[3], "ACTION_NONCE")?,
                cancelled_action_hash: fixed(&row[4], "CANCELLED_ACTION_HASH")?,
                cancelled_action_kind: u8_value(&row[5], "CANCELLED_ACTION_KIND")?,
                cancel_hash: fixed(&row[6], "CANCEL_HASH")?,
            })
        }
        11 => {
            let row = exact(fields, 7, "DEBT_CREATED")?;
            JurisdictionEvent::DebtCreated(DebtCreatedEvent {
                metadata: metadata(&row[1])?,
                debtor: text(&row[2], "DEBTOR")?,
                creditor: text(&row[3], "CREDITOR")?,
                token_id: i64_value(&row[4], "TOKEN_ID")?,
                amount: big(&row[5], "AMOUNT")?,
                debt_index: i64_value(&row[6], "DEBT_INDEX")?,
            })
        }
        12 => decode_dispute_started(fields)?,
        13 => decode_dispute_finalized(fields)?,
        14 => {
            let row = exact(fields, 8, "COUNTER_DISPUTE_REGISTERED")?;
            JurisdictionEvent::CounterDisputeRegistered(CounterDisputeRegisteredEvent {
                metadata: metadata(&row[1])?,
                sender: text(&row[2], "SENDER")?,
                counterentity: text(&row[3], "COUNTERENTITY")?,
                nonce: i64_value(&row[4], "NONCE")?,
                proposer_is_left: boolean(&row[5], "PROPOSER_IS_LEFT")?,
                proofbody_hash: fixed(&row[6], "PROOFBODY_HASH")?,
                counter_proofbody: proof_body(&row[7])?,
            })
        }
        15 => decode_hash_ladder(fields)?,
        16 => {
            let row = exact(fields, 8, "DEBT_ENFORCED")?;
            JurisdictionEvent::DebtEnforced(DebtEnforcedEvent {
                metadata: metadata(&row[1])?,
                debtor: text(&row[2], "DEBTOR")?,
                creditor: text(&row[3], "CREDITOR")?,
                token_id: i64_value(&row[4], "TOKEN_ID")?,
                amount_paid: big(&row[5], "AMOUNT_PAID")?,
                remaining_amount: big(&row[6], "REMAINING_AMOUNT")?,
                new_debt_index: i64_value(&row[7], "NEW_DEBT_INDEX")?,
            })
        }
        17 => {
            let row = exact(fields, 7, "DEBT_FORGIVEN")?;
            JurisdictionEvent::DebtForgiven(DebtForgivenEvent {
                metadata: metadata(&row[1])?,
                debtor: text(&row[2], "DEBTOR")?,
                creditor: text(&row[3], "CREDITOR")?,
                token_id: i64_value(&row[4], "TOKEN_ID")?,
                amount_forgiven: big(&row[5], "AMOUNT_FORGIVEN")?,
                debt_index: i64_value(&row[6], "DEBT_INDEX")?,
            })
        }
        value => return Err(invalid(format!("EVENT_TAG:{value}"))),
    };
    xln_rscore_engine::canonical_event_key(&event)
        .map_err(|error| invalid(format!("EVENT_INVALID:{error}")))?;
    Ok(event)
}

fn decode_wallet_snapshot(fields: &[AbiValue]) -> Result<JurisdictionEvent, JEventWireError> {
    let row = exact(fields, 7, "WALLET_SNAPSHOT")?;
    let token_balances = list(&row[5], "TOKEN_BALANCES")?
        .iter()
        .map(|value| {
            let entry = exact(list(value, "TOKEN_BALANCE")?, 3, "TOKEN_BALANCE")?;
            Ok(ExternalTokenBalance {
                token_address: fixed(&entry[0], "TOKEN_ADDRESS")?,
                token_id: optional_i64(&entry[1], "TOKEN_ID")?,
                balance: big(&entry[2], "BALANCE")?,
            })
        })
        .collect::<Result<Vec<_>, JEventWireError>>()?;
    let allowances = list(&row[6], "ALLOWANCES")?
        .iter()
        .map(|value| {
            let entry = exact(list(value, "ALLOWANCE")?, 3, "ALLOWANCE")?;
            Ok(ExternalAllowance {
                token_address: fixed(&entry[0], "TOKEN_ADDRESS")?,
                spender: fixed(&entry[1], "SPENDER")?,
                allowance: big(&entry[2], "ALLOWANCE_VALUE")?,
            })
        })
        .collect::<Result<Vec<_>, JEventWireError>>()?;
    Ok(JurisdictionEvent::ExternalWalletSnapshot(
        ExternalWalletSnapshotEvent {
            metadata: metadata(&row[1])?,
            entity_id: text(&row[2], "ENTITY_ID")?,
            owner: fixed(&row[3], "OWNER")?,
            native_balance: optional_big(&row[4], "NATIVE_BALANCE")?,
            token_balances,
            allowances,
        },
    ))
}

fn decode_wallet_delta(fields: &[AbiValue]) -> Result<JurisdictionEvent, JEventWireError> {
    let row = exact(fields, 9, "WALLET_DELTA")?;
    Ok(JurisdictionEvent::ExternalWalletDelta(
        ExternalWalletDeltaEvent {
            metadata: metadata(&row[1])?,
            entity_id: text(&row[2], "ENTITY_ID")?,
            owner: fixed(&row[3], "OWNER")?,
            token_address: fixed(&row[4], "TOKEN_ADDRESS")?,
            token_id: optional_i64(&row[5], "TOKEN_ID")?,
            balance_delta: optional_big(&row[6], "BALANCE_DELTA")?,
            spender: optional_fixed(&row[7], "SPENDER")?,
            allowance: optional_big(&row[8], "ALLOWANCE")?,
        },
    ))
}

fn decode_dispute_started(fields: &[AbiValue]) -> Result<JurisdictionEvent, JEventWireError> {
    let row = exact(fields, 17, "DISPUTE_STARTED")?;
    Ok(JurisdictionEvent::DisputeStarted(DisputeStartedEvent {
        metadata: metadata(&row[1])?,
        sender: text(&row[2], "SENDER")?,
        counterentity: text(&row[3], "COUNTERENTITY")?,
        nonce: big(&row[4], "NONCE")?,
        proposer_is_left: boolean(&row[5], "PROPOSER_IS_LEFT")?,
        proofbody_hash: text(&row[6], "PROOFBODY_HASH")?,
        watch_seed: fixed(&row[7], "WATCH_SEED")?,
        starter_initial_arguments: raw_bytes(&row[8], "STARTER_INITIAL_ARGUMENTS")?,
        starter_counter_arguments: raw_bytes(&row[9], "STARTER_COUNTER_ARGUMENTS")?,
        starter_counter_proof_commitment: fixed(&row[10], "COUNTER_PROOF_COMMITMENT")?,
        initial_proofbody: proof_body(&row[11])?,
        dispute_timeout: u64_value(&row[12], "DISPUTE_TIMEOUT")?,
        dispute_start_timestamp: u64_value(&row[13], "DISPUTE_START_TIMESTAMP")?,
        left_response_seconds: u64_value(&row[14], "LEFT_RESPONSE_SECONDS")?,
        right_response_seconds: u64_value(&row[15], "RIGHT_RESPONSE_SECONDS")?,
        batch_nonce: optional_i64(&row[16], "BATCH_NONCE")?,
    }))
}

fn decode_dispute_finalized(fields: &[AbiValue]) -> Result<JurisdictionEvent, JEventWireError> {
    let row = exact(fields, 10, "DISPUTE_FINALIZED")?;
    Ok(JurisdictionEvent::DisputeFinalized(DisputeFinalizedEvent {
        metadata: metadata(&row[1])?,
        sender: text(&row[2], "SENDER")?,
        counterentity: text(&row[3], "COUNTERENTITY")?,
        initial_nonce: big(&row[4], "INITIAL_NONCE")?,
        initial_proofbody_hash: text(&row[5], "INITIAL_PROOFBODY_HASH")?,
        final_proofbody_hash: text(&row[6], "FINAL_PROOFBODY_HASH")?,
        finalization_evidence_hash: text(&row[7], "FINALIZATION_EVIDENCE_HASH")?,
        final_proofbody: proof_body(&row[8])?,
        batch_nonce: optional_i64(&row[9], "BATCH_NONCE")?,
    }))
}

fn decode_hash_ladder(fields: &[AbiValue]) -> Result<JurisdictionEvent, JEventWireError> {
    let row = exact(fields, 10, "HASH_LADDER_REVEAL")?;
    let reveals = exact(list(&row[7], "REVEALS")?, 4, "REVEALS")?;
    let reveals = [
        fixed(&reveals[0], "REVEAL")?,
        fixed(&reveals[1], "REVEAL")?,
        fixed(&reveals[2], "REVEAL")?,
        fixed(&reveals[3], "REVEAL")?,
    ];
    Ok(JurisdictionEvent::HashLadderRevealRegistered(
        HashLadderRevealRegisteredEvent {
            metadata: metadata(&row[1])?,
            entity: text(&row[2], "ENTITY")?,
            counterparty_entity: text(&row[3], "COUNTERPARTY_ENTITY")?,
            ladder_hash: fixed(&row[4], "LADDER_HASH")?,
            fill_ratio: u16_value(&row[5], "FILL_RATIO")?,
            full_secret: fixed(&row[6], "FULL_SECRET")?,
            reveals,
            target_role: boolean(&row[8], "TARGET_ROLE")?,
            revealed_at: u64_value(&row[9], "REVEALED_AT")?,
        },
    ))
}

fn metadata(value: &AbiValue) -> Result<JEventMetadata, JEventWireError> {
    let row = exact(list(value, "METADATA")?, 5, "METADATA")?;
    Ok(JEventMetadata {
        block_number: optional_u64(&row[0], "BLOCK_NUMBER")?,
        block_hash: optional_fixed(&row[1], "BLOCK_HASH")?,
        transaction_hash: optional_fixed(&row[2], "TRANSACTION_HASH")?,
        log_index: optional_u64(&row[3], "LOG_INDEX")?,
        event_index: optional_u64(&row[4], "EVENT_INDEX")?,
    })
}

fn proof_body(value: &AbiValue) -> Result<ProofBody, JEventWireError> {
    let row = exact(list(value, "PROOF_BODY")?, 6, "PROOF_BODY")?;
    Ok(ProofBody {
        watch_seed: text(&row[0], "WATCH_SEED")?,
        left_response_seconds: u64_value(&row[1], "LEFT_RESPONSE_SECONDS")?,
        right_response_seconds: u64_value(&row[2], "RIGHT_RESPONSE_SECONDS")?,
        offdeltas: big_list(&row[3], "OFFDELTAS")?,
        token_ids: big_list(&row[4], "TOKEN_IDS")?,
        transformers: list(&row[5], "TRANSFORMERS")?
            .iter()
            .map(transformer)
            .collect::<Result<Vec<_>, _>>()?,
    })
}

fn transformer(value: &AbiValue) -> Result<ProofTransformerClause, JEventWireError> {
    let row = exact(list(value, "TRANSFORMER")?, 3, "TRANSFORMER")?;
    Ok(ProofTransformerClause {
        transformer_address: text(&row[0], "TRANSFORMER_ADDRESS")?,
        encoded_batch: text(&row[1], "ENCODED_BATCH")?,
        allowances: list(&row[2], "ALLOWANCES")?
            .iter()
            .map(|value| {
                let row = exact(list(value, "ALLOWANCE")?, 3, "ALLOWANCE")?;
                Ok(ProofAllowance {
                    delta_index: big(&row[0], "DELTA_INDEX")?,
                    right_allowance: big(&row[1], "RIGHT_ALLOWANCE")?,
                    left_allowance: big(&row[2], "LEFT_ALLOWANCE")?,
                })
            })
            .collect::<Result<Vec<_>, JEventWireError>>()?,
    })
}

fn big_list(value: &AbiValue, code: &str) -> Result<Vec<BigInt>, JEventWireError> {
    list(value, code)?
        .iter()
        .map(|value| big(value, code))
        .collect()
}

fn entity(value: &AbiValue, code: &str) -> Result<EntityId, JEventWireError> {
    EntityId::parse(&format!("0x{}", hex::encode(fixed::<32>(value, code)?)))
        .map_err(|error| invalid(format!("{code}:{error}")))
}

fn token(value: &AbiValue) -> Result<TokenId, JEventWireError> {
    let value = u64_value(value, "TOKEN_ID")?;
    let value = u32::try_from(value).map_err(|_| invalid(format!("TOKEN_ID:{value}")))?;
    TokenId::new(value).map_err(|error| invalid(format!("TOKEN_ID:{error}")))
}

fn list<'a>(value: &'a AbiValue, code: &str) -> Result<&'a [AbiValue], JEventWireError> {
    match value {
        AbiValue::Tuple(value) => Ok(value.fields()),
        _ => Err(invalid(format!("{code}_TUPLE"))),
    }
}

fn exact<'a>(
    value: &'a [AbiValue],
    length: usize,
    code: &str,
) -> Result<&'a [AbiValue], JEventWireError> {
    if value.len() != length {
        return Err(invalid(format!("{code}_ARITY:{}:{length}", value.len())));
    }
    Ok(value)
}

fn tag(value: &AbiValue, code: &str) -> Result<u8, JEventWireError> {
    u8_value(value, code)
}

fn integer(value: &AbiValue, code: &str) -> Result<i128, JEventWireError> {
    match value {
        AbiValue::Integer(value) => Ok(*value),
        _ => Err(invalid(format!("{code}_INTEGER"))),
    }
}

fn u64_value(value: &AbiValue, code: &str) -> Result<u64, JEventWireError> {
    u64::try_from(integer(value, code)?).map_err(|_| invalid(format!("{code}_U64")))
}

fn i64_value(value: &AbiValue, code: &str) -> Result<i64, JEventWireError> {
    i64::try_from(integer(value, code)?).map_err(|_| invalid(format!("{code}_I64")))
}

fn u16_value(value: &AbiValue, code: &str) -> Result<u16, JEventWireError> {
    u16::try_from(integer(value, code)?).map_err(|_| invalid(format!("{code}_U16")))
}

fn u8_value(value: &AbiValue, code: &str) -> Result<u8, JEventWireError> {
    u8::try_from(integer(value, code)?).map_err(|_| invalid(format!("{code}_U8")))
}

fn optional_u64(value: &AbiValue, code: &str) -> Result<Option<u64>, JEventWireError> {
    match value {
        AbiValue::Nil => Ok(None),
        value => Ok(Some(u64_value(value, code)?)),
    }
}

fn optional_i64(value: &AbiValue, code: &str) -> Result<Option<i64>, JEventWireError> {
    match value {
        AbiValue::Nil => Ok(None),
        value => Ok(Some(i64_value(value, code)?)),
    }
}

fn text(value: &AbiValue, code: &str) -> Result<String, JEventWireError> {
    match value {
        AbiValue::Text(value) => Ok(value.clone()),
        _ => Err(invalid(format!("{code}_TEXT"))),
    }
}

fn big(value: &AbiValue, code: &str) -> Result<BigInt, JEventWireError> {
    text(value, code)?
        .parse()
        .map_err(|_| invalid(format!("{code}_BIGINT")))
}

fn optional_big(value: &AbiValue, code: &str) -> Result<Option<BigInt>, JEventWireError> {
    match value {
        AbiValue::Nil => Ok(None),
        value => Ok(Some(big(value, code)?)),
    }
}

fn boolean(value: &AbiValue, code: &str) -> Result<bool, JEventWireError> {
    match value {
        AbiValue::Bool(value) => Ok(*value),
        _ => Err(invalid(format!("{code}_BOOL"))),
    }
}

fn raw_bytes(value: &AbiValue, code: &str) -> Result<Vec<u8>, JEventWireError> {
    match value {
        AbiValue::Bytes(value) => Ok(value.clone()),
        _ => Err(invalid(format!("{code}_BYTES"))),
    }
}

fn fixed<const N: usize>(value: &AbiValue, code: &str) -> Result<[u8; N], JEventWireError> {
    let bytes = raw_bytes(value, code)?;
    bytes
        .try_into()
        .map_err(|value: Vec<u8>| invalid(format!("{code}_WIDTH:{}:{N}", value.len())))
}

fn optional_fixed<const N: usize>(
    value: &AbiValue,
    code: &str,
) -> Result<Option<[u8; N]>, JEventWireError> {
    match value {
        AbiValue::Nil => Ok(None),
        value => Ok(Some(fixed(value, code)?)),
    }
}

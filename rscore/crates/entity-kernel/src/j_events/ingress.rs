use std::collections::{BTreeMap, BTreeSet};

use ethabi::{ParamType, Token, ethereum_types::U256};
use num_bigint::{BigInt, Sign};
use sha3::{Digest, Keccak256};
use xln_rscore_engine::{
    AccountDisputeFinality, AccountDisputeStartedFinality, AccountTx, CanonicalValue, EntityId,
    ExternalWalletDeltaEvent, ExternalWalletSnapshotEvent, HtlcResolveOutcome, HtlcResolveTx,
    JEventClaimTx, JurisdictionEvent, SecretRevealedEvent, TokenId, canonical_events,
    normalize_dispute_finalization_evidence,
};
use xln_rscore_protocol::CanonicalNumber;

use crate::j_batch::JBatchTerminalFailure;
use crate::{
    AccountEnvelopeMutation, AccountProposalWork, CanonicalEntityTx, EntityFrameEvent,
    EntityKernelError, EntityProviderActionPayload, EntityProviderActionState, EntityStateSlice,
    EntityTxKind, ExternalWalletAllowanceRecord, ExternalWalletBalanceRecord, ExternalWalletState,
    JBatchStatus, LocalEntityOutput, LocalEntityOutputTx, ScheduledHook, ScheduledHookKind,
};

use super::{
    EntityJEventIngress, FinalizedJEventBatch, JClaimIngress, JEventClaimQueued, JReserveUpdate,
};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

type ClaimKey = (String, u64, [u8; 32]);

struct ValidatedBatch {
    events: Vec<JurisdictionEvent>,
    evidence: Vec<xln_rscore_engine::DisputeFinalizationEvidence>,
    claims: Vec<(ClaimKey, Vec<JurisdictionEvent>)>,
    queued: Vec<JEventClaimQueued>,
}

const NATIVE_EXTERNAL_TOKEN_ADDRESS: [u8; 20] = [0; 20];

fn invalid(detail: impl Into<String>) -> EntityKernelError {
    EntityKernelError::JEventInvalid {
        detail: detail.into(),
    }
}

fn account_text(value: &EntityId) -> String {
    value.as_hex()
}

fn prefixed_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::from("0x"), |mut output, byte| {
        let _ = write!(output, "{byte:02x}");
        output
    })
}

fn push_status(events: &mut Vec<EntityFrameEvent>, message: impl Into<String>) {
    events.push(EntityFrameEvent::Status {
        message: message.into(),
    });
}

fn number(value: u64, field: &'static str) -> Result<CanonicalValue, EntityKernelError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|_| invalid(format!("{field}:SAFE_INTEGER")))
}

fn safe_bigint_u64(value: &BigInt, field: &'static str) -> Result<u64, EntityKernelError> {
    u64::try_from(value)
        .ok()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid(format!("{field}:{value}")))
}

fn safe_i64_u64(value: i64, field: &'static str) -> Result<u64, EntityKernelError> {
    u64::try_from(value)
        .ok()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid(format!("{field}:{value}")))
}

fn hex_word(value: &str, field: &'static str) -> Result<[u8; 32], EntityKernelError> {
    let payload = value
        .strip_prefix("0x")
        .filter(|payload| payload.len() == 64)
        .ok_or_else(|| invalid(field))?;
    let mut output = [0_u8; 32];
    for (index, pair) in payload.as_bytes().chunks_exact(2).enumerate() {
        let nibble = |byte: u8| match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        };
        output[index] = (nibble(pair[0]).ok_or_else(|| invalid(field))? << 4)
            | nibble(pair[1]).ok_or_else(|| invalid(field))?;
    }
    Ok(output)
}

fn object_field<'a>(value: &'a CanonicalValue, name: &str) -> Option<&'a CanonicalValue> {
    let CanonicalValue::Object(fields) = value else {
        return None;
    };
    fields
        .iter()
        .find_map(|(field, value)| (field == name).then_some(value))
}

fn object_u64(value: &CanonicalValue, name: &str) -> Option<u64> {
    match object_field(value, name) {
        Some(CanonicalValue::Number(value)) => value.as_str().parse().ok(),
        _ => None,
    }
}

fn object_bool(value: &CanonicalValue, name: &str) -> Option<bool> {
    match object_field(value, name) {
        Some(CanonicalValue::Bool(value)) => Some(*value),
        _ => None,
    }
}

fn object_text<'a>(value: &'a CanonicalValue, name: &str) -> Option<&'a str> {
    match object_field(value, name) {
        Some(CanonicalValue::String(value)) => Some(value),
        _ => None,
    }
}

fn set_object_field(
    value: &mut CanonicalValue,
    name: &'static str,
    next: CanonicalValue,
) -> Result<(), EntityKernelError> {
    let CanonicalValue::Object(fields) = value else {
        return Err(invalid("ACCOUNT_ACTIVE_DISPUTE_OBJECT"));
    };
    if let Some((_, value)) = fields.iter_mut().find(|(field, _)| field == name) {
        *value = next;
    } else {
        fields.push((name.into(), next));
    }
    Ok(())
}

fn event_block(event: &JurisdictionEvent) -> u64 {
    event
        .metadata()
        .block_number
        .expect("validated event block number")
}

fn event_tx_prefix(event: &JurisdictionEvent) -> String {
    let hash = prefixed_hex(
        &event
            .metadata()
            .transaction_hash
            .expect("validated event transaction hash"),
    );
    hash[..10].to_string()
}

fn suffix(value: &str, count: usize) -> &str {
    &value[value.len().saturating_sub(count)..]
}

fn token_metadata(token_id: u16) -> Result<(u32, &'static str), EntityKernelError> {
    match token_id {
        1 => Ok((6, "USDC")),
        2 => Ok((18, "WETH")),
        3 => Ok((6, "USDT")),
        4 => Ok((6, "TRX")),
        5 => Ok((18, "SUN")),
        _ => Err(invalid(format!("TOKEN_METADATA_UNAVAILABLE:{token_id}"))),
    }
}

fn format_token_amount(token_id: u16, amount: &BigInt) -> Result<String, EntityKernelError> {
    let (decimals, symbol) = token_metadata(token_id)?;
    let negative = amount.sign() == Sign::Minus;
    let mut digits = amount.to_str_radix(10);
    if negative {
        digits.remove(0);
    }
    let decimals = usize::try_from(decimals).expect("u32 decimals fit usize");
    let formatted = if digits.len() <= decimals {
        let zeros = "0".repeat(decimals + 1 - digits.len());
        let padded = format!("{zeros}{digits}");
        let split = padded.len() - decimals;
        let integer = &padded[..split];
        let fraction = padded[split..].trim_end_matches('0');
        format!(
            "{integer}.{}",
            if fraction.is_empty() { "0" } else { fraction }
        )
    } else {
        let split = digits.len() - decimals;
        let integer = &digits[..split];
        let fraction = digits[split..].trim_end_matches('0');
        format!(
            "{integer}.{}",
            if fraction.is_empty() { "0" } else { fraction }
        )
    };
    Ok(format!(
        "{}{formatted} {symbol}",
        if negative { "-" } else { "" }
    ))
}

fn validate_active_accounts(
    state: &EntityStateSlice,
    active_accounts: &BTreeSet<String>,
) -> Result<(), EntityKernelError> {
    for account_id in active_accounts {
        EntityId::parse(account_id).map_err(|_| invalid("ACTIVE_ACCOUNT_ID"))?;
        if !state.known_accounts.contains(account_id) {
            return Err(invalid(format!("ACTIVE_ACCOUNT_UNKNOWN:{account_id}")));
        }
    }
    Ok(())
}

fn event_binding(
    owner: &EntityId,
    event: &JurisdictionEvent,
    batch: &FinalizedJEventBatch,
) -> Result<(EntityId, u16), EntityKernelError> {
    let JurisdictionEvent::AccountSettled(settled) = event else {
        return Err(invalid("ACCOUNT_CLAIM_EVENT_KIND"));
    };
    if settled.metadata.block_number != Some(batch.j_height)
        || settled.metadata.block_hash != Some(batch.j_block_hash)
        || settled.metadata.transaction_hash.is_none()
        || settled.metadata.log_index.is_none()
    {
        return Err(invalid("ACCOUNT_SETTLED_METADATA_BINDING"));
    }
    if settled.token_id.get() == 0 {
        return Err(invalid("ACCOUNT_SETTLED_TOKEN_ZERO"));
    }
    let counterparty = if &settled.left_entity == owner {
        settled.right_entity.clone()
    } else if &settled.right_entity == owner {
        settled.left_entity.clone()
    } else {
        return Err(invalid("ACCOUNT_SETTLED_OWNER_MISMATCH"));
    };
    Ok((counterparty, settled.token_id.get()))
}

fn validate_event_coordinates(
    event: &JurisdictionEvent,
    batch: &FinalizedJEventBatch,
) -> Result<(), EntityKernelError> {
    let metadata = event.metadata();
    if metadata.block_number != Some(batch.j_height)
        || metadata.block_hash != Some(batch.j_block_hash)
        || metadata.transaction_hash.is_none()
        || metadata.log_index.is_none()
    {
        return Err(invalid("J_EVENT_METADATA_BINDING"));
    }
    Ok(())
}

fn reserve_projection(
    owner: &EntityId,
    events: &[JurisdictionEvent],
) -> Result<Vec<JReserveUpdate>, EntityKernelError> {
    let owner = owner.as_hex();
    events
        .iter()
        .filter_map(|event| match event {
            JurisdictionEvent::ReserveUpdated(update)
                if update.entity.eq_ignore_ascii_case(&owner) =>
            {
                Some(update)
            }
            _ => None,
        })
        .map(|update| {
            let token_id =
                u16::try_from(update.token_id).map_err(|_| invalid("RESERVE_UPDATED_TOKEN"))?;
            if update.new_balance < BigInt::from(0) {
                return Err(invalid("RESERVE_UPDATED_BALANCE_NEGATIVE"));
            }
            Ok(JReserveUpdate {
                token_id,
                own_reserve: update.new_balance.clone(),
            })
        })
        .collect()
}

fn action_nonce(value: &BigInt) -> Result<U256, EntityKernelError> {
    let (sign, bytes) = value.to_bytes_be();
    if sign != Sign::Plus || bytes.is_empty() || bytes.len() > 32 {
        return Err(invalid(format!(
            "ENTITY_PROVIDER_ACTION_EVENT_NONCE_INVALID:{value}"
        )));
    }
    Ok(U256::from_big_endian(&bytes))
}

fn executable_action_identity(
    pending: &crate::EntityProviderActionIntent,
) -> Result<([u8; 32], u8), EntityKernelError> {
    match &pending.payload {
        EntityProviderActionPayload::Transfer { .. } => Ok((pending.action_hash, 0)),
        EntityProviderActionPayload::ReleaseControlShares { .. } => Ok((pending.action_hash, 1)),
        EntityProviderActionPayload::Cancel {
            cancelled_action_hash,
            cancelled_action_kind,
        } if *cancelled_action_kind <= 1 => Ok((*cancelled_action_hash, *cancelled_action_kind)),
        EntityProviderActionPayload::Cancel { .. } => {
            Err(invalid("ENTITY_PROVIDER_CANCEL_EVENT_KIND_INVALID"))
        }
    }
}

fn apply_entity_provider_receipt(
    state: &mut EntityStateSlice,
    event: &JurisdictionEvent,
) -> Result<(), EntityKernelError> {
    let (entity_id, nonce, action_hash, action_kind, cancel_hash) = match event {
        JurisdictionEvent::EntityProviderActionExecuted(value) => {
            if value.action_kind > 1 {
                return Err(invalid("ENTITY_PROVIDER_ACTION_EVENT_KIND_INVALID"));
            }
            (
                &value.entity_id,
                action_nonce(&value.action_nonce)?,
                value.action_hash,
                value.action_kind,
                None,
            )
        }
        JurisdictionEvent::EntityProviderActionCancelled(value) => {
            if value.cancelled_action_kind > 1 {
                return Err(invalid("ENTITY_PROVIDER_CANCEL_EVENT_KIND_INVALID"));
            }
            (
                &value.entity_id,
                action_nonce(&value.action_nonce)?,
                value.cancelled_action_hash,
                value.cancelled_action_kind,
                Some(value.cancel_hash),
            )
        }
        _ => return Ok(()),
    };
    if !entity_id.as_hex().eq_ignore_ascii_case(&state.entity_id) {
        return Err(invalid(format!(
            "ENTITY_PROVIDER_ACTION_EVENT_ENTITY_MISMATCH:{}:{}",
            entity_id.as_hex(),
            state.entity_id
        )));
    }
    let current = state
        .entity_provider_action_state
        .clone()
        .unwrap_or_default();
    let expected_nonce = current
        .confirmed_nonce
        .checked_add(U256::one())
        .ok_or_else(|| invalid("ENTITY_PROVIDER_ACTION_EVENT_NONCE_OVERFLOW"))?;
    if nonce != expected_nonce {
        return Err(invalid(format!(
            "ENTITY_PROVIDER_ACTION_EVENT_NONCE_MISMATCH:{nonce}:{expected_nonce}"
        )));
    }
    if let Some(pending) = current.pending.as_ref() {
        let (expected_hash, expected_kind) = executable_action_identity(pending)?;
        let cancel_intent_matches = cancel_hash.is_none_or(|received_cancel_hash| {
            !matches!(pending.payload, EntityProviderActionPayload::Cancel { .. })
                || pending.action_hash == received_cancel_hash
        });
        if pending.action_nonce != nonce
            || expected_hash != action_hash
            || expected_kind != action_kind
            || !cancel_intent_matches
        {
            return Err(invalid("ENTITY_PROVIDER_ACTION_RECEIPT_MISMATCH"));
        }
    }
    state.entity_provider_action_state = Some(EntityProviderActionState {
        confirmed_nonce: nonce,
        generation: current.generation,
        pending: None,
    });
    Ok(())
}

/// Build the one canonical Entity/Account projection of an authenticated J
/// event block. Watcher live ingress and Runtime-WAL replay both call this;
/// neither is allowed to maintain its own reserve/account derivation.
pub fn project_finalized_j_event_batch(
    owner: &EntityId,
    j_height: u64,
    j_block_hash: [u8; 32],
    events: Vec<JurisdictionEvent>,
    evidence: Vec<xln_rscore_engine::DisputeFinalizationEvidence>,
) -> Result<FinalizedJEventBatch, EntityKernelError> {
    let events = canonical_events(&events).map_err(|error| invalid(error.to_string()))?;
    let evidence = normalize_dispute_finalization_evidence(&evidence)
        .map_err(|error| invalid(error.to_string()))?;
    let reserve_updates = reserve_projection(owner, &events)?;
    let mut by_account = BTreeMap::<EntityId, Vec<JurisdictionEvent>>::new();
    for event in &events {
        let JurisdictionEvent::AccountSettled(settled) = event else {
            continue;
        };
        if settled.metadata.block_number != Some(j_height)
            || settled.metadata.block_hash != Some(j_block_hash)
            || settled.metadata.transaction_hash.is_none()
            || settled.metadata.log_index.is_none()
        {
            return Err(invalid("ACCOUNT_SETTLED_METADATA_BINDING"));
        }
        let counterparty = if &settled.left_entity == owner {
            settled.right_entity.clone()
        } else if &settled.right_entity == owner {
            settled.left_entity.clone()
        } else {
            return Err(invalid("ACCOUNT_SETTLED_OWNER_MISMATCH"));
        };
        by_account
            .entry(counterparty)
            .or_default()
            .push(event.clone());
    }
    let account_claims = by_account
        .into_iter()
        .map(|(account_id, events)| JClaimIngress {
            account_id,
            tx: AccountTx::JEventClaim(JEventClaimTx {
                j_height,
                j_block_hash,
                events,
                left_proof: None,
                right_proof: None,
            }),
        })
        .collect();
    Ok(FinalizedJEventBatch {
        j_height,
        j_block_hash,
        events,
        dispute_finalization_evidence: evidence,
        reserve_updates,
        account_claims,
    })
}

fn apply_reserve_event(
    state: &mut EntityStateSlice,
    event: &JurisdictionEvent,
) -> Result<(), EntityKernelError> {
    let owner = state.entity_id.to_ascii_lowercase();
    let update = match event {
        JurisdictionEvent::ReserveUpdated(value) if value.entity.eq_ignore_ascii_case(&owner) => {
            Some((value.token_id, value.new_balance.clone()))
        }
        JurisdictionEvent::ReserveUpdated(_) => None,
        JurisdictionEvent::AccountSettled(value) if value.left_entity.as_hex() == owner => {
            Some((i64::from(value.token_id.get()), value.left_reserve.clone()))
        }
        JurisdictionEvent::AccountSettled(value) if value.right_entity.as_hex() == owner => {
            Some((i64::from(value.token_id.get()), value.right_reserve.clone()))
        }
        JurisdictionEvent::AccountSettled(_) => None,
        _ => return Err(invalid("J_RESERVE_EVENT_KIND")),
    };
    let Some((token_id, balance)) = update else {
        return Ok(());
    };
    let token_id = u16::try_from(token_id).map_err(|_| invalid("J_RESERVE_EVENT_TOKEN"))?;
    if balance < BigInt::from(0) {
        return Err(invalid("J_RESERVE_EVENT_BALANCE_NEGATIVE"));
    }
    state.reserves.insert(token_id, balance);
    Ok(())
}

fn validate_batch(
    owner: &EntityId,
    state: &EntityStateSlice,
    authority: Option<&crate::EntityFrameAuthority>,
    active_accounts: &BTreeSet<String>,
    batch: &FinalizedJEventBatch,
) -> Result<ValidatedBatch, EntityKernelError> {
    if batch.j_height == 0 || batch.j_height > MAX_SAFE_INTEGER {
        return Err(invalid("J_HEIGHT"));
    }
    let mut claims = Vec::new();
    let mut global_events = Vec::new();
    let ordered_batch_events =
        canonical_events(&batch.events).map_err(|error| invalid(error.to_string()))?;
    if ordered_batch_events != batch.events {
        return Err(invalid("J_EVENT_BLOCK_ORDER"));
    }
    for event in &ordered_batch_events {
        validate_event_coordinates(event, batch)?;
        if let JurisdictionEvent::ExternalWalletSnapshot(value) = event {
            validate_external_wallet_audience(state, authority, &value.entity_id, &value.owner)?;
        }
        if let JurisdictionEvent::ExternalWalletDelta(value) = event {
            validate_external_wallet_audience(state, authority, &value.entity_id, &value.owner)?;
        }
    }
    let evidence = normalize_dispute_finalization_evidence(&batch.dispute_finalization_evidence)
        .map_err(|error| invalid(error.to_string()))?;
    if evidence != batch.dispute_finalization_evidence {
        return Err(invalid("J_DISPUTE_EVIDENCE_ORDER"));
    }
    let finalized = ordered_batch_events
        .iter()
        .filter_map(|event| match event {
            JurisdictionEvent::DisputeFinalized(value) => Some(value),
            _ => None,
        })
        .collect::<Vec<_>>();
    if finalized.len() != evidence.len()
        || finalized.iter().any(|event| {
            !evidence.iter().any(|sidecar| {
                sidecar.sender.eq_ignore_ascii_case(&event.sender)
                    && sidecar
                        .counterentity
                        .eq_ignore_ascii_case(&event.counterentity)
                    && sidecar.initial_nonce == event.initial_nonce.to_string()
                    && sidecar
                        .initial_proofbody_hash
                        .eq_ignore_ascii_case(&event.initial_proofbody_hash)
                    && sidecar
                        .final_proofbody_hash
                        .eq_ignore_ascii_case(&event.final_proofbody_hash)
            })
        })
    {
        return Err(invalid("J_DISPUTE_EVIDENCE_BINDING"));
    }
    for ingress in &batch.account_claims {
        let account_id = account_text(&ingress.account_id);
        let AccountTx::JEventClaim(claim) = &ingress.tx else {
            return Err(EntityKernelError::UnsupportedJEventIngress {
                kind: super::account_tx_kind(&ingress.tx),
            });
        };
        validate_claim_coordinates(claim, batch)?;
        let events = canonical_events(&claim.events).map_err(|error| invalid(error.to_string()))?;
        for event in &events {
            let (counterparty, _) = event_binding(owner, event, batch)?;
            if counterparty != ingress.account_id {
                return Err(invalid("ACCOUNT_SETTLED_COUNTERPARTY_MISMATCH"));
            }
        }
        global_events.extend(events.iter().cloned());
        if state.known_accounts.contains(&account_id) && active_accounts.contains(&account_id) {
            claims.push(((account_id, claim.j_height, claim.j_block_hash), events));
        }
    }
    let ordered_events = if global_events.is_empty() {
        Vec::new()
    } else {
        canonical_events(&global_events).map_err(|error| invalid(error.to_string()))?
    };
    let expected_account_events = ordered_batch_events
        .iter()
        .filter(|event| matches!(event, JurisdictionEvent::AccountSettled(_)))
        .cloned()
        .collect::<Vec<_>>();
    if ordered_events != expected_account_events {
        return Err(invalid("ACCOUNT_SETTLED_CLAIM_PROJECTION"));
    }
    let mut queued = Vec::new();
    for event in &ordered_events {
        let (counterparty, token_id) = event_binding(owner, event, batch)?;
        let account_id = account_text(&counterparty);
        if state.known_accounts.contains(&account_id) && active_accounts.contains(&account_id) {
            queued.push(JEventClaimQueued {
                entity_id: state.entity_id.clone(),
                counterparty_id: account_id,
                token_id,
                j_height: batch.j_height,
            });
        }
    }
    let reserve_updates = reserve_projection(owner, &ordered_batch_events)?;
    if reserve_updates != batch.reserve_updates {
        return Err(invalid("ACCOUNT_SETTLED_RESERVE_PROJECTION"));
    }
    Ok(ValidatedBatch {
        events: ordered_batch_events,
        evidence,
        claims,
        queued,
    })
}

fn apply_known_htlc_secret(
    state: &mut EntityStateSlice,
    paybook: &mut crate::paybook::PaybookChanges,
    hashlock: &str,
    secret: &str,
    block_number: u64,
    proposals: &mut BTreeMap<String, Vec<AccountTx>>,
    frame_events: &mut Vec<EntityFrameEvent>,
) -> Result<(), EntityKernelError> {
    let hashlock = hashlock.to_ascii_lowercase();
    let secret = secret.to_ascii_lowercase();
    let Some(mut route) = paybook.entry(state, &hashlock)?.cloned() else {
        // The canonical Paybook owns all live payment routing. Recovering by
        // scanning every Account would create a second payment index and an
        // O(accounts*locks) finalized-event path.
        return Ok(());
    };
    if route.secret.is_none() {
        route.secret = Some(secret.clone());
        if route
            .pending_fee
            .as_ref()
            .is_some_and(|value| value != &BigInt::from(0))
        {
            state.paybook.fees_earned += route
                .pending_fee
                .take()
                .expect("checked non-zero pending fee");
        }
        if let Some(account_id) = &route.inbound_entity {
            proposals
                .entry(account_id.clone())
                .or_default()
                .push(AccountTx::HtlcResolve(HtlcResolveTx {
                    lock_id: hashlock.clone(),
                    outcome: HtlcResolveOutcome::Secret {
                        secret: secret.clone(),
                    },
                }));
        }
        paybook.put(route)?;
    }
    frame_events.push(EntityFrameEvent::Status {
        message: format!(
            "🔓 HTLC reveal observed: {}... | Block {}",
            &hashlock[..hashlock.len().min(10)],
            block_number
        ),
    });
    Ok(())
}

fn apply_secret_revealed(
    state: &mut EntityStateSlice,
    paybook: &mut crate::paybook::PaybookChanges,
    event: &SecretRevealedEvent,
    proposals: &mut BTreeMap<String, Vec<AccountTx>>,
    frame_events: &mut Vec<EntityFrameEvent>,
) -> Result<(), EntityKernelError> {
    apply_known_htlc_secret(
        state,
        paybook,
        &event.hashlock,
        &event.secret,
        event
            .metadata
            .block_number
            .expect("validated event coordinates"),
        proposals,
        frame_events,
    )
}

/// Solidity soft-decodes malformed dynamic dispute arguments as no evidence.
/// Keep that boundary exact: only the first DeltaTransformer argument slot may
/// reveal HTLC secrets, and duplicate words retain their first position.
fn dispute_initial_secrets(arguments: &[u8]) -> Vec<[u8; 32]> {
    if arguments.is_empty() {
        return Vec::new();
    }
    let outer = ParamType::Array(Box::new(ParamType::Bytes));
    let Ok(mut decoded) = ethabi::decode(&[outer], arguments) else {
        return Vec::new();
    };
    let Some(Token::Array(argument_slots)) = decoded.pop() else {
        return Vec::new();
    };
    let Some(Token::Bytes(delta_arguments)) = argument_slots.first() else {
        return Vec::new();
    };
    if delta_arguments.is_empty() {
        return Vec::new();
    }
    let delta = ParamType::Tuple(vec![
        ParamType::Array(Box::new(ParamType::Uint(16))),
        ParamType::Array(Box::new(ParamType::FixedBytes(32))),
    ]);
    let Ok(mut decoded) = ethabi::decode(&[delta], delta_arguments) else {
        return Vec::new();
    };
    let Some(Token::Tuple(fields)) = decoded.pop() else {
        return Vec::new();
    };
    let Some(Token::Array(secrets)) = fields.get(1) else {
        return Vec::new();
    };
    let mut seen = BTreeSet::new();
    secrets
        .iter()
        .filter_map(|secret| match secret {
            Token::FixedBytes(bytes) => <[u8; 32]>::try_from(bytes.as_slice()).ok(),
            _ => None,
        })
        .filter(|secret| seen.insert(*secret))
        .collect()
}

fn queue_j_broadcast(
    state: &EntityStateSlice,
    outputs: &mut Vec<LocalEntityOutput>,
) -> Result<(), EntityKernelError> {
    if outputs.iter().any(|output| {
        output.entity_id.eq_ignore_ascii_case(&state.entity_id)
            && output.entity_txs.iter().any(|tx| {
                matches!(tx, LocalEntityOutputTx::Projected(projected) if projected.kind == EntityTxKind::JBroadcast)
            })
    }) {
        return Ok(());
    }
    let projected = CanonicalEntityTx::from_frame_projection(
        EntityTxKind::JBroadcast,
        CanonicalValue::Object(Vec::new()),
    )
    .map_err(|error| invalid(format!("J_BATCH_AUTO_BROADCAST_TX:{error}")))?;
    outputs.push(LocalEntityOutput {
        entity_id: state.entity_id.clone(),
        target_signer_id: None,
        entity_txs: vec![LocalEntityOutputTx::Projected(projected)],
    });
    Ok(())
}

fn apply_hanko_batch_processed(
    state: &mut EntityStateSlice,
    event: &xln_rscore_engine::HankoBatchProcessedEvent,
    dispute_views: &BTreeMap<String, xln_rscore_batch::ResidentAccountDisputeView>,
    routed_outputs: &mut Vec<LocalEntityOutput>,
    frame_events: &mut Vec<EntityFrameEvent>,
) -> Result<(), EntityKernelError> {
    if event.entity_id.as_hex() != state.entity_id.to_ascii_lowercase() {
        return Ok(());
    }
    if event.nonce == 0 || event.nonce > MAX_SAFE_INTEGER {
        return Err(invalid(format!(
            "J_BATCH_EVENT_NONCE_INVALID:{}",
            event.nonce
        )));
    }
    let batch_state = state.j_batch_state.get_or_insert_with(Default::default);
    let matches_pending = batch_state.sent_batch.as_ref().is_some_and(|sent| {
        sent.entity_nonce == event.nonce && sent.batch_hash == event.batch_hash
    });
    let current_nonce = batch_state.entity_nonce.unwrap_or(0);
    batch_state.entity_nonce = Some(current_nonce.max(event.nonce));
    if !matches_pending {
        let Some(sent) = batch_state.sent_batch.as_mut() else {
            return Ok(());
        };
        if event.nonce < sent.entity_nonce {
            return Ok(());
        }
        let event_hash = prefixed_hex(&event.batch_hash);
        let pending_hash = prefixed_hex(&sent.batch_hash);
        let message = format!(
            "J_BATCH_NONCE_CONSUMED_BY_DIFFERENT_HASH:{event_hash}:pending={pending_hash}:pendingNonce={}:finalizedNonce={}",
            sent.entity_nonce, event.nonce
        );
        sent.terminal_failure = Some(JBatchTerminalFailure {
            message,
            failed_at: state.timestamp,
            failure: None,
        });
        batch_state.status = JBatchStatus::Failed;
        frame_events.push(EntityFrameEvent::Status {
            message: format!(
                "❌ Pending jBatch nonce {} quarantined: chain finalized different batch {event_hash} at nonce {}",
                sent.entity_nonce, event.nonce
            ),
        });
        return Ok(());
    }
    batch_state.sent_batch = None;
    let flushed =
        crate::cross_j::flush_deferred_hash_ladder_reveals(state, dispute_views, routed_outputs)?;
    let batch_state = state.j_batch_state.get_or_insert_with(Default::default);
    batch_state.status = if crate::local_control::has_queued_batch_work(batch_state) {
        JBatchStatus::Accumulating
    } else {
        JBatchStatus::Empty
    };
    if (batch_state.auto_broadcast_draft || flushed > 0)
        && crate::local_control::has_queued_batch_work(batch_state)
    {
        queue_j_broadcast(state, routed_outputs)?;
    }
    frame_events.push(EntityFrameEvent::Status {
        message: format!(
            "✅ jBatch finalized (nonce {}) | Block {}",
            event.nonce,
            event
                .metadata
                .block_number
                .expect("validated event coordinates")
        ),
    });
    Ok(())
}

fn dispute_account<'a>(
    state: &EntityStateSlice,
    sender: &str,
    counterentity: &str,
    views: &'a BTreeMap<String, xln_rscore_batch::ResidentAccountDisputeView>,
) -> Result<
    Option<(
        String,
        bool,
        &'a xln_rscore_batch::ResidentAccountDisputeView,
    )>,
    EntityKernelError,
> {
    let owner = state.entity_id.to_ascii_lowercase();
    let sender = sender.to_ascii_lowercase();
    let counterentity = counterentity.to_ascii_lowercase();
    let (counterparty, we_are_starter) = if sender == owner {
        (counterentity, true)
    } else if counterentity == owner {
        (sender, false)
    } else {
        return Ok(None);
    };
    if !state.known_accounts.contains(&counterparty) {
        return Ok(None);
    }
    let view = views
        .get(&counterparty)
        .ok_or_else(|| invalid(format!("J_DISPUTE_ACCOUNT_VIEW_MISSING:{counterparty}")))?;
    Ok(Some((counterparty, we_are_starter, view)))
}

fn require_frozen_proof_body(
    event_body: &xln_rscore_engine::ProofBody,
    expected_hash: [u8; 32],
    view: &xln_rscore_batch::ResidentAccountDisputeView,
    context: &'static str,
) -> Result<crate::j_batch::ProofBody, EntityKernelError> {
    let event_body = crate::proof_body_from_j_event(event_body)
        .map_err(|error| invalid(format!("{context}:EVENT_PROOFBODY:{error}")))?;
    let event_hash = crate::proof_body_hash(&event_body)
        .map_err(|error| invalid(format!("{context}:EVENT_PROOFBODY_HASH:{error}")))?;
    if event_hash != expected_hash {
        return Err(invalid(format!(
            "{context}:EVENT_PROOFBODY_HASH_MISMATCH:{}:{}",
            prefixed_hex(&expected_hash),
            prefixed_hex(&event_hash)
        )));
    }
    let resident_body = crate::proof_body_from_engine(
        view.proof_body
            .clone()
            .map_err(|error| invalid(format!("{context}:ACCOUNT_PROOFBODY:{error}")))?,
    )
    .map_err(|error| invalid(format!("{context}:ACCOUNT_PROOFBODY:{error}")))?;
    if event_body != resident_body {
        let resident_hash = crate::proof_body_hash(&resident_body)
            .map_err(|error| invalid(format!("{context}:ACCOUNT_PROOFBODY_HASH:{error}")))?;
        return Err(invalid(format!(
            "DISPUTE_FROZEN_ACCOUNT_STATE_MISMATCH:{context}:{}:{}",
            prefixed_hex(&expected_hash),
            prefixed_hex(&resident_hash)
        )));
    }
    Ok(event_body)
}

fn sync_j_batch_nonce(
    state: &mut EntityStateSlice,
    sender: &str,
    batch_nonce: Option<i64>,
    events: &mut Vec<EntityFrameEvent>,
) -> Result<(), EntityKernelError> {
    if !sender.eq_ignore_ascii_case(&state.entity_id) {
        return Ok(());
    }
    let Some(batch_nonce) = batch_nonce else {
        return Ok(());
    };
    let nonce = safe_i64_u64(batch_nonce, "J_BATCH_EVENT_NONCE_INVALID")?;
    if nonce == 0 {
        return Err(invalid("J_BATCH_EVENT_NONCE_ZERO"));
    }
    let Some(batch) = state.j_batch_state.as_mut() else {
        return Ok(());
    };
    let current = batch.entity_nonce.unwrap_or(0);
    if nonce > current {
        batch.entity_nonce = Some(nonce);
        push_status(
            events,
            format!("↻ Synced J batch nonce from event ({current} → {nonce})"),
        );
    }
    Ok(())
}

fn refresh_j_batch_status(state: &mut crate::JBatchState) {
    state.status = if state.sent_batch.is_some() {
        JBatchStatus::Sent
    } else if crate::local_control::has_queued_batch_work(state) {
        JBatchStatus::Accumulating
    } else {
        JBatchStatus::Empty
    };
}

fn retire_started_dispute_ops(
    state: &mut EntityStateSlice,
    counterparty: [u8; 32],
    initial_hash: [u8; 32],
    preserve_matching_sent: bool,
    outputs: &mut Vec<LocalEntityOutput>,
) -> Result<usize, EntityKernelError> {
    let Some(batch) = state.j_batch_state.as_mut() else {
        return Ok(0);
    };
    let mut removed =
        crate::j_batch::scrub_dispute_starts_for_counterparty(&mut batch.batch, &counterparty)
            + crate::j_batch::scrub_counter_disputes_for_active_start(
                &mut batch.batch,
                &counterparty,
                &initial_hash,
            );
    let mut recovered = 0;
    for row in &mut batch.recovery_batches {
        let count = crate::j_batch::scrub_dispute_starts_for_counterparty(row, &counterparty)
            + crate::j_batch::scrub_counter_disputes_for_active_start(
                row,
                &counterparty,
                &initial_hash,
            );
        removed += count;
        recovered += count;
    }
    crate::j_batch::prune_empty_recovery_batches(batch);
    let sent_matches = preserve_matching_sent
        && batch.sent_batch.as_ref().is_some_and(|sent| {
            sent.batch
                .dispute_starts
                .iter()
                .any(|row| row.counterentity == counterparty && row.proofbody_hash == initial_hash)
        });
    let mut removed_sent = 0;
    if !sent_matches && let Some(sent) = batch.sent_batch.as_ref() {
        let mut remainder = sent.batch.clone();
        removed_sent =
            crate::j_batch::scrub_dispute_starts_for_counterparty(&mut remainder, &counterparty)
                + crate::j_batch::scrub_counter_disputes_for_active_start(
                    &mut remainder,
                    &counterparty,
                    &initial_hash,
                );
        if removed_sent > 0 {
            batch.sent_batch = None;
            crate::j_batch::prepend_recovery_batch(batch, remainder);
        }
    }
    removed += removed_sent;
    refresh_j_batch_status(batch);
    let queue = (recovered > 0 || removed_sent > 0)
        && batch.sent_batch.is_none()
        && crate::local_control::has_queued_batch_work(batch);
    if queue {
        queue_j_broadcast(state, outputs)?;
    }
    Ok(removed)
}

fn retire_counter_dispute_ops(
    state: &mut EntityStateSlice,
    counterparty: [u8; 32],
    nonce: u64,
    proposer_is_left: bool,
    proof_body_hash: [u8; 32],
    outputs: &mut Vec<LocalEntityOutput>,
) -> Result<usize, EntityKernelError> {
    let Some(batch) = state.j_batch_state.as_mut() else {
        return Ok(0);
    };
    let mut removed = crate::j_batch::scrub_counter_disputes_superseded_by_observed(
        &mut batch.batch,
        &counterparty,
        nonce,
        proposer_is_left,
        &proof_body_hash,
        false,
    )
    .map_err(|error| invalid(error.to_string()))?;
    let mut recovered = 0;
    for row in &mut batch.recovery_batches {
        let count = crate::j_batch::scrub_counter_disputes_superseded_by_observed(
            row,
            &counterparty,
            nonce,
            proposer_is_left,
            &proof_body_hash,
            false,
        )
        .map_err(|error| invalid(error.to_string()))?;
        removed += count;
        recovered += count;
    }
    crate::j_batch::prune_empty_recovery_batches(batch);
    let mut removed_sent = 0;
    if let Some(sent) = batch.sent_batch.as_ref() {
        let mut remainder = sent.batch.clone();
        removed_sent = crate::j_batch::scrub_counter_disputes_superseded_by_observed(
            &mut remainder,
            &counterparty,
            nonce,
            proposer_is_left,
            &proof_body_hash,
            true,
        )
        .map_err(|error| invalid(error.to_string()))?;
        if removed_sent > 0 {
            batch.sent_batch = None;
            crate::j_batch::prepend_recovery_batch(batch, remainder);
        }
    }
    removed += removed_sent;
    refresh_j_batch_status(batch);
    let queue = (recovered > 0 || removed_sent > 0)
        && batch.sent_batch.is_none()
        && crate::local_control::has_queued_batch_work(batch);
    if queue {
        queue_j_broadcast(state, outputs)?;
    }
    Ok(removed)
}

fn sent_batch_owns_finality_ack(
    state: &EntityStateSlice,
    counterparty: [u8; 32],
    initial_hash: [u8; 32],
    batch_nonce: Option<i64>,
) -> bool {
    let Some(nonce) = batch_nonce.and_then(|value| u64::try_from(value).ok()) else {
        return false;
    };
    state.j_batch_state.as_ref().is_some_and(|batch| {
        batch.sent_batch.as_ref().is_some_and(|sent| {
            sent.entity_nonce == nonce
                && sent.batch.dispute_finalizations.iter().any(|row| {
                    row.counterentity == counterparty && row.initial_proofbody_hash == initial_hash
                })
        })
    })
}

fn retire_finalized_dispute_ops(
    state: &mut EntityStateSlice,
    counterparty: [u8; 32],
    preserve_sent: bool,
    outputs: &mut Vec<LocalEntityOutput>,
) -> Result<usize, EntityKernelError> {
    let Some(batch) = state.j_batch_state.as_mut() else {
        return Ok(0);
    };
    let scrub = |row: &mut crate::JBatch| {
        crate::j_batch::scrub_dispute_finalizations_for_counterparty(row, &counterparty)
            + crate::j_batch::scrub_counter_disputes_for_counterparty(row, &counterparty)
            + crate::j_batch::scrub_source_registrations_for_counterparty(row, &counterparty)
    };
    let mut removed = scrub(&mut batch.batch);
    let mut recovered = 0;
    for row in &mut batch.recovery_batches {
        let count = scrub(row);
        removed += count;
        recovered += count;
    }
    crate::j_batch::prune_empty_recovery_batches(batch);
    let mut removed_sent = 0;
    if !preserve_sent && let Some(sent) = batch.sent_batch.as_ref() {
        let mut remainder = sent.batch.clone();
        removed_sent = scrub(&mut remainder);
        if removed_sent > 0 {
            batch.sent_batch = None;
            crate::j_batch::prepend_recovery_batch(batch, remainder);
        }
    }
    removed += removed_sent;
    refresh_j_batch_status(batch);
    let queue = (recovered > 0 || removed_sent > 0)
        && batch.sent_batch.is_none()
        && crate::local_control::has_queued_batch_work(batch);
    if queue {
        queue_j_broadcast(state, outputs)?;
    }
    Ok(removed)
}

fn validate_external_wallet_audience(
    state: &EntityStateSlice,
    authority: Option<&crate::EntityFrameAuthority>,
    event_entity_id: &str,
    owner: &[u8; 20],
) -> Result<(), EntityKernelError> {
    validate_wallet_event_entity(state, event_entity_id)?;
    let authority = authority.ok_or_else(|| invalid("EXTERNAL_WALLET_AUTHORITY_MISSING"))?;
    let owner = prefixed_hex(owner);
    if !authority
        .config
        .validators
        .iter()
        .any(|validator| validator.trim().eq_ignore_ascii_case(&owner))
    {
        return Err(invalid(format!("EXTERNAL_WALLET_OWNER_NOT_SIGNER:{owner}")));
    }
    Ok(())
}

fn event_transaction_hash(event: &JurisdictionEvent) -> Result<[u8; 32], EntityKernelError> {
    event
        .metadata()
        .transaction_hash
        .ok_or_else(|| invalid("EXTERNAL_WALLET_TRANSACTION_HASH"))
}

fn validate_wallet_event_entity(
    state: &EntityStateSlice,
    event_entity_id: &str,
) -> Result<(), EntityKernelError> {
    if !event_entity_id.eq_ignore_ascii_case(&state.entity_id) {
        return Err(invalid(format!(
            "EXTERNAL_WALLET_ENTITY_MISMATCH:{event_entity_id}:{}",
            state.entity_id
        )));
    }
    Ok(())
}

fn apply_wallet_snapshot(
    state: &mut EntityStateSlice,
    event: &ExternalWalletSnapshotEvent,
) -> Result<(), EntityKernelError> {
    validate_wallet_event_entity(state, &event.entity_id)?;
    let j_height = event
        .metadata
        .block_number
        .ok_or_else(|| invalid("EXTERNAL_WALLET_BLOCK_NUMBER"))?;
    let transaction_hash = Some(event_transaction_hash(
        &JurisdictionEvent::ExternalWalletSnapshot(event.clone()),
    )?);
    let wallet = state
        .external_wallet
        .get_or_insert_with(ExternalWalletState::empty);
    if let Some(balance) = &event.native_balance {
        wallet.put_balance(
            event.owner,
            ExternalWalletBalanceRecord {
                token_address: NATIVE_EXTERNAL_TOKEN_ADDRESS,
                token_id: Some(0),
                balance: balance.clone(),
                j_height,
                transaction_hash,
            },
        )?;
    }
    for balance in &event.token_balances {
        let token_id = balance
            .token_id
            .map(|value| {
                u64::try_from(value).map_err(|_| invalid("EXTERNAL_WALLET_TOKEN_ID_NEGATIVE"))
            })
            .transpose()?;
        wallet.put_balance(
            event.owner,
            ExternalWalletBalanceRecord {
                token_address: balance.token_address,
                token_id,
                balance: balance.balance.clone(),
                j_height,
                transaction_hash,
            },
        )?;
    }
    for allowance in &event.allowances {
        wallet.put_allowance(
            event.owner,
            ExternalWalletAllowanceRecord {
                token_address: allowance.token_address,
                spender: allowance.spender,
                allowance: allowance.allowance.clone(),
                j_height,
                transaction_hash,
            },
        )?;
    }
    Ok(())
}

fn apply_wallet_delta(
    state: &mut EntityStateSlice,
    event: &ExternalWalletDeltaEvent,
) -> Result<(), EntityKernelError> {
    validate_wallet_event_entity(state, &event.entity_id)?;
    let j_height = event
        .metadata
        .block_number
        .ok_or_else(|| invalid("EXTERNAL_WALLET_BLOCK_NUMBER"))?;
    let transaction_hash = Some(event_transaction_hash(
        &JurisdictionEvent::ExternalWalletDelta(event.clone()),
    )?);
    let wallet = state
        .external_wallet
        .as_mut()
        .ok_or_else(|| invalid("EXTERNAL_WALLET_BASELINE_MISSING"))?;
    if let Some(delta) = &event.balance_delta {
        let current = wallet
            .balance(&event.owner, &event.token_address)
            .cloned()
            .ok_or_else(|| invalid("EXTERNAL_WALLET_BASELINE_MISSING:BALANCE"))?;
        let balance = current.balance + delta;
        if balance < BigInt::from(0) {
            return Err(invalid("EXTERNAL_WALLET_BALANCE_UNDERFLOW"));
        }
        let token_id = event
            .token_id
            .map(|value| {
                u64::try_from(value).map_err(|_| invalid("EXTERNAL_WALLET_TOKEN_ID_NEGATIVE"))
            })
            .transpose()?
            .or(current.token_id);
        wallet.put_balance(
            event.owner,
            ExternalWalletBalanceRecord {
                token_address: event.token_address,
                token_id,
                balance,
                j_height,
                transaction_hash,
            },
        )?;
    }
    if event.allowance.is_some() || event.spender.is_some() {
        let spender = event
            .spender
            .ok_or_else(|| invalid("EXTERNAL_WALLET_SPENDER_MISSING"))?;
        let current = wallet
            .allowance(&event.owner, &event.token_address, &spender)
            .cloned()
            .ok_or_else(|| invalid("EXTERNAL_WALLET_BASELINE_MISSING:ALLOWANCE"))?;
        wallet.put_allowance(
            event.owner,
            ExternalWalletAllowanceRecord {
                token_address: event.token_address,
                spender,
                allowance: event.allowance.clone().unwrap_or(current.allowance),
                j_height,
                transaction_hash,
            },
        )?;
    }
    Ok(())
}

fn apply_wallet_event(
    state: &mut EntityStateSlice,
    event: &JurisdictionEvent,
) -> Result<(), EntityKernelError> {
    match event {
        JurisdictionEvent::ExternalWalletSnapshot(event) => apply_wallet_snapshot(state, event),
        JurisdictionEvent::ExternalWalletDelta(event) => apply_wallet_delta(state, event),
        _ => Err(invalid("EXTERNAL_WALLET_EVENT_KIND")),
    }
}

fn validate_claim_coordinates(
    claim: &JEventClaimTx,
    batch: &FinalizedJEventBatch,
) -> Result<(), EntityKernelError> {
    if claim.j_height != batch.j_height
        || claim.j_block_hash != batch.j_block_hash
        || claim.left_proof.is_some()
        || claim.right_proof.is_some()
    {
        return Err(invalid("J_CLAIM_WATCHER_BINDING"));
    }
    Ok(())
}

fn dispute_started_active_value(
    event: &xln_rscore_engine::DisputeStartedEvent,
    view: &xln_rscore_batch::ResidentAccountDisputeView,
    we_are_starter: bool,
    initial_hash: [u8; 32],
    initial_nonce: u64,
) -> Result<CanonicalValue, EntityKernelError> {
    let started_by_left = if we_are_starter {
        view.owner_is_left
    } else {
        !view.owner_is_left
    };
    let mut fields = vec![
        (
            "startedByLeft".into(),
            CanonicalValue::Bool(started_by_left),
        ),
        (
            "initialProofbodyHash".into(),
            CanonicalValue::String(prefixed_hex(&initial_hash)),
        ),
        (
            "initialNonce".into(),
            number(initial_nonce, "J_EVENT_DISPUTE_INITIAL_NONCE")?,
        ),
        (
            "initialProposerIsLeft".into(),
            CanonicalValue::Bool(event.proposer_is_left),
        ),
        (
            "disputeTimeout".into(),
            number(event.dispute_timeout, "J_EVENT_DISPUTE_TIMEOUT")?,
        ),
        (
            "disputeStartTimestamp".into(),
            number(
                event.dispute_start_timestamp,
                "J_EVENT_DISPUTE_START_TIMESTAMP",
            )?,
        ),
        (
            "jNonce".into(),
            number(initial_nonce, "J_EVENT_DISPUTE_J_NONCE")?,
        ),
        (
            "starterInitialArguments".into(),
            CanonicalValue::String(prefixed_hex(&event.starter_initial_arguments)),
        ),
        (
            "starterCounterArguments".into(),
            CanonicalValue::String(prefixed_hex(&event.starter_counter_arguments)),
        ),
        (
            "starterCounterProofCommitment".into(),
            CanonicalValue::String(prefixed_hex(&event.starter_counter_proof_commitment)),
        ),
        ("observedOnChain".into(), CanonicalValue::Bool(true)),
        (
            "observedBlockNumber".into(),
            number(
                event
                    .metadata
                    .block_number
                    .expect("validated event block number"),
                "J_EVENT_BLOCK",
            )?,
        ),
    ];
    if let Some(batch_nonce) = event.batch_nonce {
        fields.push((
            "batchNonce".into(),
            number(
                safe_i64_u64(batch_nonce, "J_EVENT_BATCH_NONCE")?,
                "J_EVENT_BATCH_NONCE",
            )?,
        ));
    }
    if let Some(recovery) = view
        .dispute_prepare
        .as_ref()
        .and_then(|value| object_field(value, "crossJurisdictionRecovery"))
    {
        fields.push(("crossJurisdictionRecovery".into(), recovery.clone()));
    }
    fields.push(("finalizeQueued".into(), CanonicalValue::Bool(false)));
    Ok(CanonicalValue::Object(fields))
}

#[expect(
    clippy::too_many_arguments,
    reason = "the pure transition keeps each adversarial proof input and output sink explicit"
)]
fn queue_selected_pull_counter_proof(
    state: &mut EntityStateSlice,
    event: &xln_rscore_engine::DisputeStartedEvent,
    runtime_seed: &str,
    counterparty: &str,
    view: &xln_rscore_batch::ResidentAccountDisputeView,
    initial_hash: [u8; 32],
    initial_nonce: u64,
    active: &CanonicalValue,
    body: &crate::j_batch::ProofBody,
    outputs: &mut Vec<LocalEntityOutput>,
    frame_events: &mut Vec<EntityFrameEvent>,
) -> Result<bool, EntityKernelError> {
    let started_by_left = object_bool(active, "startedByLeft")
        .ok_or_else(|| invalid("J_DISPUTE_STARTED_ROLE_MISSING"))?;
    if view.owner_is_left == started_by_left {
        return Ok(false);
    }
    let Some(counter) = view.counterparty_dispute.as_ref() else {
        return Ok(false);
    };
    let Some(signature) = counter.hanko.clone().filter(|value| !value.is_empty()) else {
        return Ok(false);
    };
    if counter.nonce < initial_nonce
        || (counter.nonce == initial_nonce && (!counter.proposer_is_left || event.proposer_is_left))
    {
        return Ok(false);
    }
    let delta_transformer = view
        .delta_transformer
        .ok_or_else(|| invalid("J_COUNTER_DISPUTE_DELTA_TRANSFORMER_MISSING"))?;
    if !crate::cross_j::proof_body_has_signed_pulls(body, delta_transformer)? {
        return Ok(false);
    }
    let body_hash = crate::proof_body_hash(body)
        .map_err(|error| invalid(format!("J_COUNTER_DISPUTE_PROOFBODY_HASH:{error}")))?;
    if body_hash != counter.proof_body_hash {
        return Err(invalid(format!(
            "DISPUTE_FROZEN_ACCOUNT_STATE_MISMATCH:counter:{}:{}:{}",
            counterparty,
            prefixed_hex(&counter.proof_body_hash),
            prefixed_hex(&body_hash)
        )));
    }
    let now_sec = state.timestamp / 1_000;
    if now_sec >= event.dispute_timeout {
        push_status(
            frame_events,
            format!(
                "❌ Pull counter-proof {} missed T={}",
                counter.nonce, event.dispute_timeout
            ),
        );
        return Ok(false);
    }
    let counterentity = hex_word(counterparty, "J_COUNTER_DISPUTE_COUNTERPARTY")?;
    let candidate = crate::j_batch::CounterDisputeProof {
        counterentity,
        initial_nonce: U256::from(initial_nonce),
        initial_proofbody_hash: initial_hash,
        counter_nonce: U256::from(counter.nonce),
        proposer_is_left: counter.proposer_is_left,
        counter_proofbody: body.clone(),
        sig: signature,
    };
    let j_state = state.j_batch_state.get_or_insert_with(Default::default);
    if let Some(existing) = j_state
        .batch
        .counter_disputes
        .iter_mut()
        .find(|row| row.counterentity == counterentity)
    {
        if existing.initial_nonce != candidate.initial_nonce
            || existing.initial_proofbody_hash != candidate.initial_proofbody_hash
        {
            return Err(invalid(format!(
                "J_COUNTER_DISPUTE_INITIAL_BINDING_CONFLICT:{counterparty}"
            )));
        }
        let existing_hash = crate::proof_body_hash(&existing.counter_proofbody)
            .map_err(|error| invalid(format!("J_COUNTER_DISPUTE_PROOFBODY_HASH:{error}")))?;
        if candidate.counter_nonce < existing.counter_nonce
            || (candidate.counter_nonce == existing.counter_nonce
                && candidate.proposer_is_left != existing.proposer_is_left
                && !candidate.proposer_is_left)
        {
            return Err(invalid(format!(
                "J_COUNTER_DISPUTE_NONCE_REGRESSION:{counterparty}"
            )));
        }
        let exact = candidate.counter_nonce == existing.counter_nonce
            && candidate.proposer_is_left == existing.proposer_is_left;
        if exact {
            if body_hash != existing_hash {
                return Err(invalid(format!(
                    "J_COUNTER_DISPUTE_HASH_CONFLICT:{counterparty}:{}",
                    counter.nonce
                )));
            }
        } else {
            *existing = candidate;
        }
    } else {
        if crate::j_batch::batch_op_count(&j_state.batch) >= 50
            || j_state.batch.counter_disputes.len() >= 8
        {
            return Err(invalid("J_COUNTER_DISPUTE_BATCH_LIMIT_EXCEEDED"));
        }
        j_state.batch.counter_disputes.push(candidate);
    }
    j_state.status = JBatchStatus::Accumulating;
    if j_state.sent_batch.is_some() {
        j_state.auto_broadcast_draft = true;
    }
    crate::cross_j::queue_source_hub_claim_registrations(
        state,
        counterparty,
        runtime_seed,
        body,
        delta_transformer,
        view.owner_is_left,
        Some(active),
        outputs,
    )?;
    crate::encode_j_batch(
        &state
            .j_batch_state
            .as_ref()
            .expect("counter proof initialized jBatch")
            .batch,
    )
    .map_err(|error| invalid(format!("J_COUNTER_DISPUTE_BATCH:{error}")))?;
    push_status(
        frame_events,
        format!(
            "🛡️ Locked newer Pull state N{} before dispute T",
            counter.nonce
        ),
    );
    Ok(true)
}

#[expect(
    clippy::too_many_arguments,
    reason = "the pure transition keeps event authority, account evidence, and output sinks explicit"
)]
fn apply_dispute_started(
    state: &mut EntityStateSlice,
    event: &xln_rscore_engine::DisputeStartedEvent,
    runtime_seed: &str,
    views: &BTreeMap<String, xln_rscore_batch::ResidentAccountDisputeView>,
    paybook_changes: &mut crate::paybook::PaybookChanges,
    event_proposals: &mut BTreeMap<String, Vec<AccountTx>>,
    mutations: &mut Vec<(String, AccountEnvelopeMutation)>,
    outputs: &mut Vec<LocalEntityOutput>,
    frame_events: &mut Vec<EntityFrameEvent>,
) -> Result<(), EntityKernelError> {
    let Some((counterparty, we_are_starter, view)) =
        dispute_account(state, &event.sender, &event.counterentity, views)?
    else {
        return Ok(());
    };
    let initial_hash = hex_word(&event.proofbody_hash, "J_EVENT_DISPUTE_PROOFBODY_HASH")?;
    let body = require_frozen_proof_body(
        &event.initial_proofbody,
        initial_hash,
        view,
        "jEvent.disputeStarted",
    )?;
    if body.watch_seed != event.watch_seed
        || u64::from(body.left_response_seconds) != event.left_response_seconds
        || u64::from(body.right_response_seconds) != event.right_response_seconds
        || event.dispute_start_timestamp == 0
        || event.dispute_timeout
            != event
                .dispute_start_timestamp
                .checked_add(event.left_response_seconds)
                .and_then(|value| value.checked_add(event.right_response_seconds))
                .ok_or_else(|| invalid("J_EVENT_DISPUTE_CLOCK_OVERFLOW"))?
    {
        return Err(invalid(format!(
            "ACCOUNT_DISPUTE_CLOCK_MISMATCH:{}:{}:{}:{}",
            event.dispute_start_timestamp,
            event.dispute_timeout,
            event.left_response_seconds,
            event.right_response_seconds
        )));
    }
    let initial_nonce = safe_bigint_u64(&event.nonce, "J_EVENT_DISPUTE_NONCE_INVALID")?;
    let mut active =
        dispute_started_active_value(event, view, we_are_starter, initial_hash, initial_nonce)?;
    if !we_are_starter {
        let current = object_field(&active, "crossJurisdictionRecovery");
        if let Some(recovery) =
            crate::cross_j::target_recovery_value(state, &counterparty, view, current)?
        {
            set_object_field(&mut active, "crossJurisdictionRecovery", recovery)?;
        }
    }
    sync_j_batch_nonce(state, &event.sender, event.batch_nonce, frame_events)?;
    let counterparty_word = hex_word(&counterparty, "J_EVENT_DISPUTE_COUNTERPARTY")?;
    let removed = retire_started_dispute_ops(
        state,
        counterparty_word,
        initial_hash,
        we_are_starter,
        outputs,
    )?;
    if removed > 0 {
        push_status(
            frame_events,
            format!(
                "🧹 Removed {removed} stale dispute-start op(s) for {}",
                suffix(&counterparty, 4)
            ),
        );
    }
    let counter_proof_queued = queue_selected_pull_counter_proof(
        state,
        event,
        runtime_seed,
        &counterparty,
        view,
        initial_hash,
        initial_nonce,
        &active,
        &body,
        outputs,
        frame_events,
    )?;
    if !counter_proof_queued {
        crate::cross_j::queue_source_hub_claim_registrations(
            state,
            &counterparty,
            runtime_seed,
            &body,
            view.delta_transformer
                .ok_or_else(|| invalid("J_DISPUTE_DELTA_TRANSFORMER_MISSING"))?,
            view.owner_is_left,
            Some(&active),
            outputs,
        )?;
    }
    let mut flushed_reveals = 0_usize;
    for route_id in crate::cross_j::target_recovery_route_ids(state, &counterparty, view)? {
        flushed_reveals += crate::cross_j::flush_pending_target_reveal_for_route(
            state,
            &route_id,
            &counterparty,
            outputs,
        )?;
    }
    if (counter_proof_queued || flushed_reveals > 0) && removed == 0 {
        queue_j_broadcast(state, outputs)?;
    }
    for secret in dispute_initial_secrets(&event.starter_initial_arguments) {
        let hashlock = prefixed_hex(&<[u8; 32]>::from(Keccak256::digest(secret)));
        apply_known_htlc_secret(
            state,
            paybook_changes,
            &hashlock,
            &prefixed_hex(&secret),
            event
                .metadata
                .block_number
                .expect("validated event block number"),
            event_proposals,
            frame_events,
        )?;
    }
    mutations.push((
        counterparty.clone(),
        AccountEnvelopeMutation::ApplyDisputeStarted(AccountDisputeStartedFinality {
            active_dispute: active,
            j_nonce: initial_nonce,
        }),
    ));
    outputs.extend(crate::cross_j::queue_sibling_dispute_fanout(
        state,
        &counterparty,
        event
            .metadata
            .block_number
            .expect("validated event block number"),
    )?);
    if let Some(crontab) = state.crontab.as_mut() {
        let delay = if we_are_starter { 1 } else { 5_000 };
        crate::schedule_hook(
            crontab,
            ScheduledHook {
                id: format!("dispute-deadline:{counterparty}"),
                trigger_at: state
                    .timestamp
                    .checked_add(delay)
                    .ok_or_else(|| invalid("DISPUTE_DEADLINE_OVERFLOW"))?,
                kind: ScheduledHookKind::DisputeDeadline {
                    account_id: counterparty.clone(),
                },
            },
        )?;
    }
    push_status(
        frame_events,
        format!(
            "⚔️ DISPUTE {} with {}, timeout: unix {}",
            if we_are_starter { "STARTED" } else { "vs us" },
            suffix(&counterparty, 4),
            event.dispute_timeout
        ),
    );
    Ok(())
}

fn apply_counter_dispute_registered(
    state: &mut EntityStateSlice,
    event: &xln_rscore_engine::CounterDisputeRegisteredEvent,
    runtime_seed: &str,
    views: &BTreeMap<String, xln_rscore_batch::ResidentAccountDisputeView>,
    mutations: &mut Vec<(String, AccountEnvelopeMutation)>,
    outputs: &mut Vec<LocalEntityOutput>,
    frame_events: &mut Vec<EntityFrameEvent>,
) -> Result<(), EntityKernelError> {
    let Some((counterparty, _, view)) =
        dispute_account(state, &event.sender, &event.counterentity, views)?
    else {
        return Ok(());
    };
    let body = require_frozen_proof_body(
        &event.counter_proofbody,
        event.proofbody_hash,
        view,
        "jEvent.counterDisputeRegistered",
    )?;
    let nonce = safe_i64_u64(event.nonce, "COUNTER_DISPUTE_NONCE_INVALID")?;
    let mut active = view.active_dispute.clone().ok_or_else(|| {
        invalid(format!(
            "COUNTER_DISPUTE_ACTIVE_ACCOUNT_MISSING:{counterparty}"
        ))
    })?;
    let initial_nonce = object_u64(&active, "initialNonce")
        .ok_or_else(|| invalid("COUNTER_DISPUTE_INITIAL_NONCE_MISSING"))?;
    let initial_role = object_bool(&active, "initialProposerIsLeft")
        .ok_or_else(|| invalid("COUNTER_DISPUTE_INITIAL_ROLE_MISSING"))?;
    if nonce < initial_nonce
        || (nonce == initial_nonce && (!event.proposer_is_left || initial_role))
    {
        return Err(invalid(format!(
            "COUNTER_DISPUTE_NONCE_STALE:{nonce}:{initial_nonce}"
        )));
    }
    if let Some(selected_nonce) = object_u64(&active, "selectedCounterNonce") {
        let selected_role = object_bool(&active, "selectedCounterProposerIsLeft")
            .ok_or_else(|| invalid("COUNTER_DISPUTE_SELECTED_ROLE_MISSING"))?;
        let selected_hash = object_text(&active, "selectedCounterProofbodyHash")
            .ok_or_else(|| invalid("COUNTER_DISPUTE_SELECTED_HASH_MISSING"))?;
        if nonce < selected_nonce {
            return Err(invalid(format!(
                "COUNTER_DISPUTE_NONCE_REGRESSION:{nonce}:{selected_nonce}"
            )));
        }
        if nonce == selected_nonce
            && event.proposer_is_left == selected_role
            && !selected_hash.eq_ignore_ascii_case(&prefixed_hex(&event.proofbody_hash))
        {
            return Err(invalid(format!("COUNTER_DISPUTE_HASH_CONFLICT:{nonce}")));
        }
        if nonce == selected_nonce
            && event.proposer_is_left != selected_role
            && !event.proposer_is_left
        {
            return Err(invalid(format!("COUNTER_DISPUTE_ROLE_REGRESSION:{nonce}")));
        }
    }
    set_object_field(
        &mut active,
        "selectedCounterNonce",
        number(nonce, "COUNTER_DISPUTE_NONCE")?,
    )?;
    set_object_field(
        &mut active,
        "selectedCounterProofbodyHash",
        CanonicalValue::String(prefixed_hex(&event.proofbody_hash)),
    )?;
    set_object_field(
        &mut active,
        "selectedCounterProposerIsLeft",
        CanonicalValue::Bool(event.proposer_is_left),
    )?;
    let current_recovery = object_field(&active, "crossJurisdictionRecovery").cloned();
    if let Some(recovery) = crate::cross_j::target_recovery_value(
        state,
        &counterparty,
        view,
        current_recovery.as_ref(),
    )? {
        set_object_field(&mut active, "crossJurisdictionRecovery", recovery)?;
    } else if let CanonicalValue::Object(fields) = &mut active {
        fields.retain(|(name, _)| name != "crossJurisdictionRecovery");
    }
    crate::cross_j::queue_source_hub_claim_registrations(
        state,
        &counterparty,
        runtime_seed,
        &body,
        view.delta_transformer
            .ok_or_else(|| invalid("J_COUNTER_DISPUTE_DELTA_TRANSFORMER_MISSING"))?,
        view.owner_is_left,
        Some(&active),
        outputs,
    )?;
    mutations.push((
        counterparty.clone(),
        AccountEnvelopeMutation::ReplaceDisputeLifecycle {
            status: "disputed".into(),
            dispute_prepare: None,
            active_dispute: Some(active),
        },
    ));
    let removed = retire_counter_dispute_ops(
        state,
        hex_word(&counterparty, "COUNTER_DISPUTE_COUNTERPARTY")?,
        nonce,
        event.proposer_is_left,
        event.proofbody_hash,
        outputs,
    )?;
    if removed > 0 {
        push_status(
            frame_events,
            format!("🧹 Retired {removed} superseded counter-proof operation(s)"),
        );
    }
    push_status(
        frame_events,
        format!(
            "🛡️ Counter-proof N{nonce} locked for {}",
            suffix(&counterparty, 4)
        ),
    );
    Ok(())
}

fn apply_dispute_finalized(
    state: &mut EntityStateSlice,
    event: &xln_rscore_engine::DisputeFinalizedEvent,
    evidence: &[xln_rscore_engine::DisputeFinalizationEvidence],
    views: &BTreeMap<String, xln_rscore_batch::ResidentAccountDisputeView>,
    mutations: &mut Vec<(String, AccountEnvelopeMutation)>,
    outputs: &mut Vec<LocalEntityOutput>,
    frame_events: &mut Vec<EntityFrameEvent>,
) -> Result<(), EntityKernelError> {
    let Some((counterparty, we_are_finalizer, view)) =
        dispute_account(state, &event.sender, &event.counterentity, views)?
    else {
        return Ok(());
    };
    let initial_hash = hex_word(
        &event.initial_proofbody_hash,
        "J_EVENT_DISPUTE_INITIAL_PROOFBODY_HASH",
    )?;
    let final_hash = hex_word(
        &event.final_proofbody_hash,
        "J_EVENT_DISPUTE_FINAL_PROOFBODY_HASH",
    )?;
    let final_body = require_frozen_proof_body(
        &event.final_proofbody,
        final_hash,
        view,
        "jEvent.disputeFinalized",
    )?;
    let initial_nonce = safe_bigint_u64(
        &event.initial_nonce,
        "J_EVENT_DISPUTE_INITIAL_NONCE_INVALID",
    )?;
    let primary = evidence
        .iter()
        .find(|row| {
            row.sender.eq_ignore_ascii_case(&event.sender)
                && row.counterentity.eq_ignore_ascii_case(&event.counterentity)
                && row.initial_nonce == event.initial_nonce.to_string()
                && row
                    .initial_proofbody_hash
                    .eq_ignore_ascii_case(&event.initial_proofbody_hash)
                && row
                    .final_proofbody_hash
                    .eq_ignore_ascii_case(&event.final_proofbody_hash)
        })
        .ok_or_else(|| invalid("J_EVENT_DISPUTE_FINALIZATION_EVIDENCE_MISSING"))?;
    let final_nonce = primary
        .final_nonce
        .parse::<u64>()
        .ok()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid("J_EVENT_DISPUTE_FINAL_NONCE_INVALID"))?;
    let active = view.active_dispute.as_ref();
    let matches_selected = active.is_some_and(|active| {
        object_u64(active, "selectedCounterNonce") == Some(final_nonce)
            && object_bool(active, "selectedCounterProposerIsLeft")
                == Some(primary.proposer_is_left)
            && object_text(active, "selectedCounterProofbodyHash")
                .is_some_and(|hash| hash.eq_ignore_ascii_case(&event.final_proofbody_hash))
    });
    let exact_initial_unilateral = matches!(primary.sig.as_str(), "" | "0x")
        && !matches_selected
        && final_nonce == initial_nonce
        && active.and_then(|active| object_bool(active, "initialProposerIsLeft"))
            == Some(primary.proposer_is_left)
        && final_hash == initial_hash;
    let event_j_nonce = if exact_initial_unilateral {
        initial_nonce
            .checked_add(1)
            .ok_or_else(|| invalid("J_EVENT_DISPUTE_FINAL_NONCE_OVERFLOW"))?
    } else {
        final_nonce
    };
    let finalized_j_nonce = view.j_nonce.max(event_j_nonce);
    let finalized_token_ids = final_body
        .token_ids
        .iter()
        .map(|value| {
            if *value > U256::from(u32::MAX) {
                return Err(invalid("J_EVENT_DISPUTE_FINAL_TOKEN_ID_INVALID"));
            }
            TokenId::new(value.low_u32()).map_err(|error| invalid(error.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    // TS observes the submitting Entity's batch nonce before applying Account
    // finality. The emitted status order is protocol-visible in EntityFrame;
    // moving this below finality changes the frame hash even when state agrees.
    sync_j_batch_nonce(state, &event.sender, event.batch_nonce, frame_events)?;
    mutations.push((
        counterparty.clone(),
        AccountEnvelopeMutation::ApplyDisputeFinality(AccountDisputeFinality {
            finalized_j_nonce,
            finalized_token_ids,
        }),
    ));
    let removed_deferred = state
        .deferred_account_proposals
        .as_mut()
        .map(|rows| rows.remove(&counterparty))
        .transpose()?
        .flatten()
        .is_some();
    if removed_deferred {
        push_status(
            frame_events,
            format!(
                "🧹 Invalidated stale settlement intent after dispute finality with {}",
                suffix(&counterparty, 4)
            ),
        );
    }
    if view.active_dispute.is_some() {
        if let Some(crontab) = state.crontab.as_mut() {
            crate::cancel_hook(crontab, &format!("dispute-deadline:{counterparty}"))?;
        }
        push_status(
            frame_events,
            format!(
                "✅ DISPUTE FINALIZED with {} (nonce {initial_nonce})",
                suffix(&counterparty, 4)
            ),
        );
    }
    let counterparty_word = hex_word(&counterparty, "J_EVENT_DISPUTE_COUNTERPARTY")?;
    let preserve_sent = we_are_finalizer
        && sent_batch_owns_finality_ack(state, counterparty_word, initial_hash, event.batch_nonce);
    let removed = retire_finalized_dispute_ops(state, counterparty_word, preserve_sent, outputs)?;
    if removed > 0 {
        push_status(
            frame_events,
            format!(
                "🧹 Removed {removed} stale dispute-finalize op(s) for {}",
                suffix(&counterparty, 4)
            ),
        );
    }
    Ok(())
}

fn apply_hash_ladder_recovery_result(
    state: &EntityStateSlice,
    event: &xln_rscore_engine::HashLadderRevealRegisteredEvent,
    matching_pull_ids: &[String],
    views: &BTreeMap<String, xln_rscore_batch::ResidentAccountDisputeView>,
    mutations: &mut Vec<(String, AccountEnvelopeMutation)>,
) -> Result<(), EntityKernelError> {
    if !event.entity.eq_ignore_ascii_case(&state.entity_id) || matching_pull_ids.is_empty() {
        return Ok(());
    }
    let account_id = event.counterparty_entity.to_ascii_lowercase();
    let Some(view) = views.get(&account_id) else {
        return Ok(());
    };
    let Some(mut active) = view.active_dispute.clone() else {
        return Ok(());
    };
    let Some(mut recovery) = object_field(&active, "crossJurisdictionRecovery").cloned() else {
        return Ok(());
    };
    let required = match object_field(&recovery, "requiredPullIds") {
        Some(CanonicalValue::Array(values)) => values,
        _ => return Err(invalid("HASH_LADDER_RECOVERY_REQUIRED_PULL_IDS_INVALID")),
    };
    let matching = matching_pull_ids.iter().collect::<BTreeSet<_>>();
    let mut results = match object_field(&recovery, "resultsByPullId") {
        Some(CanonicalValue::Object(fields)) => fields.clone(),
        _ => return Err(invalid("HASH_LADDER_RECOVERY_RESULTS_INVALID")),
    };
    let mut dirty = false;
    for value in required {
        let CanonicalValue::String(pull_id) = value else {
            return Err(invalid("HASH_LADDER_RECOVERY_PULL_ID_INVALID"));
        };
        if matching.contains(pull_id) && !results.iter().any(|(existing, _)| existing == pull_id) {
            results.push((
                pull_id.clone(),
                CanonicalValue::String(event.fill_ratio.to_string()),
            ));
            dirty = true;
        }
    }
    if !dirty {
        return Ok(());
    }
    set_object_field(
        &mut recovery,
        "resultsByPullId",
        CanonicalValue::Object(results),
    )?;
    set_object_field(&mut active, "crossJurisdictionRecovery", recovery)?;
    mutations.push((
        account_id,
        AccountEnvelopeMutation::ReplaceDisputeLifecycle {
            status: view.status.clone(),
            dispute_prepare: view.dispute_prepare.clone(),
            active_dispute: Some(active),
        },
    ));
    Ok(())
}

fn apply_hash_ladder_reveal_registered(
    state: &mut EntityStateSlice,
    event: &xln_rscore_engine::HashLadderRevealRegisteredEvent,
    views: &BTreeMap<String, xln_rscore_batch::ResidentAccountDisputeView>,
    mutations: &mut Vec<(String, AccountEnvelopeMutation)>,
    outputs: &mut Vec<LocalEntityOutput>,
    frame_events: &mut Vec<EntityFrameEvent>,
) -> Result<(), EntityKernelError> {
    let applied = crate::cross_j::apply_hash_ladder_reveal_registered(state, event)?;
    apply_hash_ladder_recovery_result(
        state,
        event,
        &applied.matching_recovery_pull_ids,
        views,
        mutations,
    )?;
    if applied.port_lane_count > 0 {
        push_status(
            frame_events,
            format!(
                "🌉 Cross-j reveal observed: porting ratio {} to {} target lane(s)",
                event.fill_ratio, applied.port_lane_count
            ),
        );
    }
    outputs.extend(applied.outputs);
    Ok(())
}

/// Apply an authenticated watcher range using the exact TS Entity semantics:
/// reserves follow EVM log order, while Account claims are merged and sorted
/// independently by Account id, J height and block hash.
///
/// `active_accounts` is explicit because Account status belongs to the child
/// replica, not Entity state. Missing and non-active Accounts still update the
/// Entity reserve but do not receive a bilateral claim.
pub fn apply_finalized_j_event_batches(
    state: &mut EntityStateSlice,
    finalized_through: u64,
    batches: &[FinalizedJEventBatch],
    runtime_seed: &str,
    authority: Option<&crate::EntityFrameAuthority>,
    active_accounts: &BTreeSet<String>,
    dispute_views: &BTreeMap<String, xln_rscore_batch::ResidentAccountDisputeView>,
) -> Result<EntityJEventIngress, EntityKernelError> {
    let mut paybook_changes = crate::paybook::PaybookChanges::default();
    let result = apply_finalized_j_event_batches_in_frame(
        state,
        finalized_through,
        batches,
        runtime_seed,
        authority,
        active_accounts,
        dispute_views,
        &mut paybook_changes,
    )?;
    paybook_changes.commit_sequential(state)?;
    Ok(result)
}

#[expect(
    clippy::too_many_arguments,
    reason = "the frame-local Paybook overlay is explicit consensus state"
)]
pub(crate) fn apply_finalized_j_event_batches_in_frame(
    state: &mut EntityStateSlice,
    finalized_through: u64,
    batches: &[FinalizedJEventBatch],
    runtime_seed: &str,
    authority: Option<&crate::EntityFrameAuthority>,
    active_accounts: &BTreeSet<String>,
    dispute_views: &BTreeMap<String, xln_rscore_batch::ResidentAccountDisputeView>,
    paybook_changes: &mut crate::paybook::PaybookChanges,
) -> Result<EntityJEventIngress, EntityKernelError> {
    validate_active_accounts(state, active_accounts)?;
    if finalized_through < state.last_finalized_j_height || finalized_through > MAX_SAFE_INTEGER {
        return Err(invalid("FINALIZED_HEIGHT_REGRESSION"));
    }
    let owner = EntityId::parse(&state.entity_id).map_err(|_| invalid("ENTITY_ID"))?;
    let mut prior_height = state.last_finalized_j_height;
    let mut validated = Vec::with_capacity(batches.len());
    for batch in batches {
        if batch.j_height <= prior_height || batch.j_height > finalized_through {
            return Err(invalid("J_BATCH_ORDER"));
        }
        prior_height = batch.j_height;
        validated.push(validate_batch(
            &owner,
            state,
            authority,
            active_accounts,
            batch,
        )?);
    }

    let mut grouped = BTreeMap::<ClaimKey, Vec<JurisdictionEvent>>::new();
    let mut event_proposals = BTreeMap::<String, Vec<AccountTx>>::new();
    let mut queued_claims = Vec::new();
    let mut routed_entity_outputs = Vec::new();
    let mut frame_events = Vec::new();
    let mut account_envelope_mutations = Vec::new();
    for batch in validated {
        let ValidatedBatch {
            events,
            evidence,
            claims,
            queued,
        } = batch;
        for event in events {
            match &event {
                JurisdictionEvent::FoundationBootstrapped(_)
                | JurisdictionEvent::EntityRegistered(_)
                | JurisdictionEvent::BoardActivated(_) => {
                    let jurisdiction = authority
                        .and_then(|authority| authority.config.jurisdiction.as_ref())
                        .ok_or_else(|| invalid("CERTIFIED_BOARD_ENTITY_JURISDICTION_MISSING"))?;
                    let stack_key = crate::certified_board_stack_key(jurisdiction)?;
                    let registry = state
                        .certified_board_state
                        .get_or_insert_with(|| crate::CertifiedBoardState::empty(stack_key));
                    if registry.stack_key != stack_key {
                        return Err(invalid("CERTIFIED_BOARD_STACK_MISMATCH"));
                    }
                    registry.apply_j_event(&event)?;
                    push_status(
                        &mut frame_events,
                        format!(
                            "🔐 BOARD AUTHORITY: {} | Block {}",
                            event.kind(),
                            event_block(&event)
                        ),
                    );
                }
                JurisdictionEvent::ReserveUpdated(value) => {
                    apply_reserve_event(state, &event)?;
                    push_status(
                        &mut frame_events,
                        format!(
                            "📊 RESERVE: {} raw units of token #{} | Block {} | Tx {}...",
                            value.new_balance,
                            value.token_id,
                            event_block(&event),
                            event_tx_prefix(&event)
                        ),
                    );
                }
                JurisdictionEvent::AccountSettled(value) => {
                    apply_reserve_event(state, &event)?;
                    let owner = state.entity_id.to_ascii_lowercase();
                    let counterparty = if value.left_entity.as_hex() == owner {
                        Some(value.right_entity.as_hex())
                    } else if value.right_entity.as_hex() == owner {
                        Some(value.left_entity.as_hex())
                    } else {
                        None
                    };
                    if let Some(counterparty) = counterparty.filter(|counterparty| {
                        state.known_accounts.contains(counterparty)
                            && active_accounts.contains(counterparty)
                    }) {
                        push_status(
                            &mut frame_events,
                            format!(
                                "⚖️ OBSERVED: {} | coll={} | j-block {} (awaiting 2-of-2)",
                                suffix(&counterparty, 4),
                                format_token_amount(value.token_id.get(), &value.collateral)?,
                                event_block(&event)
                            ),
                        );
                    }
                }
                JurisdictionEvent::ExternalWalletSnapshot(_)
                | JurisdictionEvent::ExternalWalletDelta(_) => {
                    apply_wallet_event(state, &event)?;
                    let (wallet_owner, kind) = match &event {
                        JurisdictionEvent::ExternalWalletSnapshot(value) => {
                            (prefixed_hex(&value.owner), "snapshot")
                        }
                        JurisdictionEvent::ExternalWalletDelta(value) => {
                            (prefixed_hex(&value.owner), "delta")
                        }
                        _ => unreachable!("matched external wallet event"),
                    };
                    push_status(
                        &mut frame_events,
                        format!(
                            "💼 EXTERNAL: {} {kind} | Block {} | Tx {}...",
                            &wallet_owner[..10],
                            event_block(&event),
                            event_tx_prefix(&event)
                        ),
                    );
                }
                JurisdictionEvent::EntityProviderActionExecuted(value) => {
                    apply_entity_provider_receipt(state, &event)?;
                    push_status(
                        &mut frame_events,
                        format!(
                            "✅ EntityProvider action finalized (nonce {}) | Block {}",
                            value.action_nonce,
                            event_block(&event)
                        ),
                    );
                }
                JurisdictionEvent::EntityProviderActionCancelled(value) => {
                    apply_entity_provider_receipt(state, &event)?;
                    push_status(
                        &mut frame_events,
                        format!(
                            "🛑 EntityProvider action cancelled (nonce {}) | Block {}",
                            value.action_nonce,
                            event_block(&event)
                        ),
                    );
                }
                JurisdictionEvent::DebtCreated(value) => {
                    crate::debt::apply_created(state, value)?;
                    push_status(
                        &mut frame_events,
                        format!(
                            "🔴 DEBT: {} owes {} raw units of token #{} to {} | Block {}",
                            suffix(&value.debtor, 8),
                            value.amount,
                            value.token_id,
                            suffix(&value.creditor, 8),
                            event_block(&event)
                        ),
                    );
                }
                JurisdictionEvent::DebtEnforced(value) => {
                    crate::debt::apply_enforced(state, value)?;
                    push_status(
                        &mut frame_events,
                        format!(
                            "✅ DEBT PAID: {} raw units of token #{} to {} | Block {}",
                            value.amount_paid,
                            value.token_id,
                            suffix(&value.creditor, 8),
                            event_block(&event)
                        ),
                    );
                }
                JurisdictionEvent::DebtForgiven(value) => {
                    crate::debt::apply_forgiven(state, value)?;
                    push_status(
                        &mut frame_events,
                        format!(
                            "🩶 DEBT FORGIVEN: {} raw units of token #{} between {} and {} | Block {} · debt #{}",
                            value.amount_forgiven,
                            value.token_id,
                            suffix(&value.debtor, 8),
                            suffix(&value.creditor, 8),
                            event_block(&event),
                            value.debt_index
                        ),
                    );
                }
                JurisdictionEvent::SecretRevealed(value) => apply_secret_revealed(
                    state,
                    paybook_changes,
                    value,
                    &mut event_proposals,
                    &mut frame_events,
                )?,
                JurisdictionEvent::HankoBatchProcessed(value) => apply_hanko_batch_processed(
                    state,
                    value,
                    dispute_views,
                    &mut routed_entity_outputs,
                    &mut frame_events,
                )?,
                JurisdictionEvent::DisputeStarted(value) => apply_dispute_started(
                    state,
                    value,
                    runtime_seed,
                    dispute_views,
                    paybook_changes,
                    &mut event_proposals,
                    &mut account_envelope_mutations,
                    &mut routed_entity_outputs,
                    &mut frame_events,
                )?,
                JurisdictionEvent::CounterDisputeRegistered(value) => {
                    apply_counter_dispute_registered(
                        state,
                        value,
                        runtime_seed,
                        dispute_views,
                        &mut account_envelope_mutations,
                        &mut routed_entity_outputs,
                        &mut frame_events,
                    )?
                }
                JurisdictionEvent::DisputeFinalized(value) => apply_dispute_finalized(
                    state,
                    value,
                    &evidence,
                    dispute_views,
                    &mut account_envelope_mutations,
                    &mut routed_entity_outputs,
                    &mut frame_events,
                )?,
                JurisdictionEvent::HashLadderRevealRegistered(value) => {
                    apply_hash_ladder_reveal_registered(
                        state,
                        value,
                        dispute_views,
                        &mut account_envelope_mutations,
                        &mut routed_entity_outputs,
                        &mut frame_events,
                    )?
                }
            }
        }
        for (key, events) in claims {
            grouped.entry(key).or_default().extend(events);
        }
        queued_claims.extend(queued);
    }
    state.last_finalized_j_height = finalized_through;

    let mut proposals = event_proposals;
    for ((account_id, j_height, j_block_hash), events) in grouped {
        let events = canonical_events(&events).map_err(|error| invalid(error.to_string()))?;
        proposals
            .entry(account_id)
            .or_default()
            .push(AccountTx::JEventClaim(JEventClaimTx {
                j_height,
                j_block_hash,
                events,
                left_proof: None,
                right_proof: None,
            }));
    }
    Ok(EntityJEventIngress {
        proposal_work: proposals
            .into_iter()
            .map(|(account_id, txs)| AccountProposalWork { account_id, txs })
            .collect(),
        account_envelope_mutations,
        queued_claims,
        routed_entity_outputs,
        frame_events,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use xln_rscore_engine::{
        EntityProviderActionCancelledEvent, EntityProviderActionExecutedEvent,
        HankoBatchProcessedEvent, JEventMetadata,
    };

    fn entity(byte: u8) -> EntityId {
        EntityId::parse(&format!("0x{}", format!("{byte:02x}").repeat(32))).expect("entity")
    }

    fn pending_state() -> EntityStateSlice {
        let owner = entity(0x11).as_hex();
        let mut state = EntityStateSlice::empty(owner.clone(), 1);
        state.entity_provider_action_state = Some(EntityProviderActionState {
            confirmed_nonce: U256::zero(),
            generation: 7,
            pending: Some(crate::EntityProviderActionIntent {
                entity_id: owner,
                entity_number: U256::from(0x11_u8),
                chain_id: U256::from(31_337_u64),
                entity_provider_address: [0x22; 20],
                board_epoch: U256::from(3_u8),
                action_nonce: U256::one(),
                action_hash: [0x44; 32],
                generation: 7,
                created_at: 10,
                payload: EntityProviderActionPayload::Transfer {
                    to: [0x33; 20],
                    token_id: U256::from(1_u8),
                    amount: U256::from(2_u8),
                },
            }),
        });
        state
    }

    #[test]
    fn provider_execution_receipt_advances_exact_pending_identity() {
        let mut state = pending_state();
        apply_entity_provider_receipt(
            &mut state,
            &JurisdictionEvent::EntityProviderActionExecuted(EntityProviderActionExecutedEvent {
                metadata: JEventMetadata::default(),
                entity_id: entity(0x11),
                action_nonce: BigInt::from(1),
                action_hash: [0x44; 32],
                action_kind: 0,
            }),
        )
        .expect("receipt");
        let action = state.entity_provider_action_state.expect("action state");
        assert_eq!(action.confirmed_nonce, U256::one());
        assert_eq!(action.generation, 7);
        assert!(action.pending.is_none());
    }

    #[test]
    fn provider_cancel_receipt_rejects_wrong_cancel_hash_without_mutation() {
        let mut state = pending_state();
        let pending = state
            .entity_provider_action_state
            .as_mut()
            .and_then(|action| action.pending.as_mut())
            .expect("pending");
        pending.action_hash = [0x66; 32];
        pending.payload = EntityProviderActionPayload::Cancel {
            cancelled_action_hash: [0x44; 32],
            cancelled_action_kind: 0,
        };
        let before = state.entity_provider_action_state.clone();
        let error = apply_entity_provider_receipt(
            &mut state,
            &JurisdictionEvent::EntityProviderActionCancelled(EntityProviderActionCancelledEvent {
                metadata: JEventMetadata::default(),
                entity_id: entity(0x11),
                action_nonce: BigInt::from(1),
                cancelled_action_hash: [0x44; 32],
                cancelled_action_kind: 0,
                cancel_hash: [0x55; 32],
            }),
        )
        .expect_err("wrong receipt must fail");
        assert!(error.to_string().contains("RECEIPT_MISMATCH"));
        assert_eq!(state.entity_provider_action_state, before);
    }

    fn sent_batch(nonce: u64, hash: [u8; 32]) -> crate::SentJBatch {
        crate::SentJBatch {
            batch: crate::JBatch::default(),
            batch_hash: hash,
            encoded_batch: vec![1, 2, 3],
            entity_nonce: nonce,
            first_submitted_at: 1,
            last_submitted_at: 2,
            submit_attempts: 1,
            fee_overrides: None,
            transaction_hash: None,
            last_failure: None,
            terminal_failure: None,
        }
    }

    #[test]
    fn hanko_batch_ack_matches_hash_and_nonce_then_queues_one_self_broadcast() {
        let mut state = EntityStateSlice::empty(entity(0x11).as_hex(), 77);
        let mut batch = crate::JBatch::default();
        batch.flashloans.push(crate::j_batch::Flashloan {
            token_id: U256::one(),
            amount: U256::one(),
        });
        state.j_batch_state = Some(crate::JBatchState {
            batch,
            sent_batch: Some(sent_batch(3, [0x44; 32])),
            auto_broadcast_draft: true,
            status: JBatchStatus::Sent,
            ..Default::default()
        });
        let event = HankoBatchProcessedEvent {
            metadata: JEventMetadata {
                block_number: Some(9),
                ..Default::default()
            },
            entity_id: entity(0x11),
            batch_hash: [0x44; 32],
            nonce: 3,
        };
        let mut outputs = Vec::new();
        let mut events = Vec::new();
        apply_hanko_batch_processed(
            &mut state,
            &event,
            &BTreeMap::new(),
            &mut outputs,
            &mut events,
        )
        .expect("batch ack");
        let batch = state.j_batch_state.expect("batch state");
        assert!(batch.sent_batch.is_none());
        assert_eq!(batch.entity_nonce, Some(3));
        assert_eq!(batch.status, JBatchStatus::Accumulating);
        assert_eq!(outputs.len(), 1);
        assert!(matches!(
            outputs[0].entity_txs.as_slice(),
            [LocalEntityOutputTx::Projected(tx)] if tx.kind == EntityTxKind::JBroadcast
        ));
        assert_eq!(
            events,
            vec![EntityFrameEvent::Status {
                message: "✅ jBatch finalized (nonce 3) | Block 9".into()
            }]
        );
    }

    #[test]
    fn hanko_batch_different_hash_quarantines_pending_payload() {
        let mut state = EntityStateSlice::empty(entity(0x11).as_hex(), 77);
        state.j_batch_state = Some(crate::JBatchState {
            sent_batch: Some(sent_batch(3, [0x44; 32])),
            status: JBatchStatus::Sent,
            ..Default::default()
        });
        let event = HankoBatchProcessedEvent {
            metadata: JEventMetadata {
                block_number: Some(9),
                ..Default::default()
            },
            entity_id: entity(0x11),
            batch_hash: [0x55; 32],
            nonce: 3,
        };
        let mut outputs = Vec::new();
        let mut events = Vec::new();
        apply_hanko_batch_processed(
            &mut state,
            &event,
            &BTreeMap::new(),
            &mut outputs,
            &mut events,
        )
        .expect("mismatch is committed quarantine state");
        let batch = state.j_batch_state.expect("batch state");
        assert_eq!(batch.status, JBatchStatus::Failed);
        assert!(batch.sent_batch.unwrap().terminal_failure.is_some());
        assert!(outputs.is_empty());
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn hanko_batch_ack_flushes_deferred_target_registry_reveal() {
        let source_user = entity(0x11);
        let source_hub = entity(0x22);
        let target_hub = entity(0x33);
        let target_user = entity(0x44);
        let mut route = ladder_route(
            &source_user,
            &source_hub,
            &target_hub,
            &target_user,
            [0x55; 32],
            [0x66; 32],
        );
        set_object_field(
            &mut route,
            "pendingTargetRegistryReveal",
            CanonicalValue::Object(vec![
                ("fillRatio".into(), number(17, "TEST_RATIO").expect("ratio")),
                (
                    "fullSecret".into(),
                    CanonicalValue::String(prefixed_hex(&[0x77; 32])),
                ),
                (
                    "reveals".into(),
                    CanonicalValue::Array(
                        [[0x81; 32], [0x82; 32], [0x83; 32], [0x84; 32]]
                            .iter()
                            .map(|value| CanonicalValue::String(prefixed_hex(value)))
                            .collect(),
                    ),
                ),
            ]),
        )
        .expect("pending reveal");
        let mut state = EntityStateSlice::empty(target_user.as_hex(), 77_000);
        state.known_accounts.insert(target_hub.as_hex());
        state.cross_jurisdiction_swaps = Some(
            crate::EntityCanonicalCollection::from_entries([("route-1".into(), route)])
                .expect("route collection"),
        );
        state.j_batch_state = Some(crate::JBatchState {
            sent_batch: Some(sent_batch(3, [0x44; 32])),
            status: JBatchStatus::Sent,
            ..Default::default()
        });
        let event = HankoBatchProcessedEvent {
            metadata: JEventMetadata {
                block_number: Some(9),
                ..Default::default()
            },
            entity_id: target_user.clone(),
            batch_hash: [0x44; 32],
            nonce: 3,
        };
        let active =
            CanonicalValue::Object(vec![("observedOnChain".into(), CanonicalValue::Bool(true))]);
        let views = BTreeMap::from([(target_hub.as_hex(), dispute_view(Some(active)))]);
        let mut outputs = Vec::new();
        apply_hanko_batch_processed(&mut state, &event, &views, &mut outputs, &mut Vec::new())
            .expect("batch ack");
        let batch = state.j_batch_state.as_ref().expect("batch");
        assert_eq!(batch.batch.hash_ladder_registrations.len(), 1);
        assert!(batch.batch.hash_ladder_registrations[0].target_role);
        assert_eq!(
            batch.batch.hash_ladder_registrations[0].witness.fill_ratio,
            17
        );
        let route = state
            .cross_jurisdiction_swaps
            .as_ref()
            .and_then(|routes| routes.get("route-1"))
            .expect("route");
        assert!(object_field(route, "pendingTargetRegistryReveal").is_none());
        assert_eq!(outputs.len(), 1);
    }

    #[test]
    fn secret_reveal_is_one_paybook_lookup_and_one_account_proposal() {
        let mut state = EntityStateSlice::empty(entity(0x11).as_hex(), 77);
        let counterparty = entity(0x22).as_hex();
        let hashlock = format!("0x{}", "33".repeat(32));
        state.paybook = crate::PaybookState::from_entries(
            [crate::PaybookEntry {
                hashlock: hashlock.clone(),
                description: None,
                token_id: Some(1),
                amount: Some(BigInt::from(100)),
                started_at_ms: Some(1),
                originated: false,
                inbound_entity: Some(counterparty.clone()),
                outbound_entity: None,
                inbound_settled: false,
                outbound_settled: false,
                secret: None,
                secret_ack_pending: false,
                secret_ack_started_at: None,
                secret_ack_deadline_at: None,
                pending_fee: Some(BigInt::from(3)),
                created_timestamp: 1,
            }],
            BigInt::from(0),
        )
        .expect("paybook");
        let event = SecretRevealedEvent {
            metadata: JEventMetadata {
                block_number: Some(9),
                ..Default::default()
            },
            hashlock: hashlock.to_ascii_uppercase().replacen("0X", "0x", 1),
            revealer: entity(0x44).as_hex(),
            secret: format!("0x{}", "55".repeat(32)),
        };
        let mut changes = crate::paybook::PaybookChanges::default();
        let mut proposals = BTreeMap::new();
        let mut events = Vec::new();
        apply_secret_revealed(
            &mut state,
            &mut changes,
            &event,
            &mut proposals,
            &mut events,
        )
        .expect("reveal");
        changes.commit_sequential(&mut state).expect("commit");
        let route = state
            .paybook
            .entry(&hashlock)
            .expect("lookup")
            .expect("route");
        assert_eq!(route.secret.as_deref(), Some(event.secret.as_str()));
        assert!(route.pending_fee.is_none());
        assert_eq!(state.paybook.fees_earned, BigInt::from(3));
        assert!(matches!(
            proposals.get(&counterparty).map(Vec::as_slice),
            Some([AccountTx::HtlcResolve(HtlcResolveTx {
                lock_id,
                outcome: HtlcResolveOutcome::Secret { secret },
            })]) if lock_id == &hashlock && secret == &event.secret
        ));
        assert_eq!(events.len(), 1);
    }

    fn dispute_view(
        active_dispute: Option<CanonicalValue>,
    ) -> xln_rscore_batch::ResidentAccountDisputeView {
        xln_rscore_batch::ResidentAccountDisputeView {
            status: if active_dispute.is_some() {
                "disputed".into()
            } else {
                "active".into()
            },
            dispute_prepare: None,
            active_dispute,
            local_dispute: None,
            counterparty_dispute: None,
            proof_body: Ok(xln_rscore_engine::DisputeProofBody {
                watch_seed: [0x33; 32],
                left_response_seconds: 10,
                right_response_seconds: 20,
                offdeltas: vec![BigInt::from(7)],
                token_ids: vec![1],
                transformers: Vec::new(),
            }),
            j_nonce: 2,
            owner_is_left: true,
            delta_transformer: Some([0x44; 20]),
            payment_hashlocks: Vec::new(),
            pull_ids: Vec::new(),
            pull_count: 0,
            swap_offers: Vec::new(),
            pending_swap_fill_ratios: BTreeMap::new(),
        }
    }

    fn ladder_route(
        source_user: &EntityId,
        source_hub: &EntityId,
        target_hub: &EntityId,
        target_user: &EntityId,
        full_hash: [u8; 32],
        partial_root: [u8; 32],
    ) -> CanonicalValue {
        let pull = |id: &str| {
            CanonicalValue::Object(vec![
                ("pullId".into(), CanonicalValue::String(id.into())),
                (
                    "fullHash".into(),
                    CanonicalValue::String(prefixed_hex(&full_hash)),
                ),
                (
                    "partialRoot".into(),
                    CanonicalValue::String(prefixed_hex(&partial_root)),
                ),
            ])
        };
        CanonicalValue::Object(vec![
            ("orderId".into(), CanonicalValue::String("route-1".into())),
            ("status".into(), CanonicalValue::String("resting".into())),
            (
                "sourceSignerId".into(),
                CanonicalValue::String("source-user-signer".into()),
            ),
            (
                "sourceHubSignerId".into(),
                CanonicalValue::String("source-hub-signer".into()),
            ),
            (
                "targetHubSignerId".into(),
                CanonicalValue::String("target-hub-signer".into()),
            ),
            (
                "targetSignerId".into(),
                CanonicalValue::String("target-user-signer".into()),
            ),
            (
                "source".into(),
                CanonicalValue::Object(vec![
                    (
                        "entityId".into(),
                        CanonicalValue::String(source_user.as_hex()),
                    ),
                    (
                        "counterpartyEntityId".into(),
                        CanonicalValue::String(source_hub.as_hex()),
                    ),
                ]),
            ),
            (
                "target".into(),
                CanonicalValue::Object(vec![
                    (
                        "entityId".into(),
                        CanonicalValue::String(target_hub.as_hex()),
                    ),
                    (
                        "counterpartyEntityId".into(),
                        CanonicalValue::String(target_user.as_hex()),
                    ),
                ]),
            ),
            ("sourcePull".into(), pull("source-pull")),
            ("targetPull".into(), pull("target-pull")),
        ])
    }

    fn ladder_event(
        source_user: &EntityId,
        source_hub: &EntityId,
        full_secret: [u8; 32],
        full_hash: [u8; 32],
        partial_root: [u8; 32],
    ) -> xln_rscore_engine::HashLadderRevealRegisteredEvent {
        let mut commitment = [0_u8; 64];
        commitment[..32].copy_from_slice(&full_hash);
        commitment[32..].copy_from_slice(&partial_root);
        xln_rscore_engine::HashLadderRevealRegisteredEvent {
            metadata: JEventMetadata {
                block_number: Some(9),
                ..Default::default()
            },
            entity: source_hub.as_hex(),
            counterparty_entity: source_user.as_hex(),
            ladder_hash: Keccak256::digest(commitment).into(),
            fill_ratio: u16::MAX,
            full_secret,
            reveals: [[0; 32]; 4],
            target_role: false,
            revealed_at: 100,
        }
    }

    #[test]
    fn hash_ladder_event_updates_registry_and_worker_owned_dispute_recovery() {
        let source_user = entity(0x11);
        let source_hub = entity(0x22);
        let target_hub = entity(0x33);
        let target_user = entity(0x44);
        let full_secret = [0x55; 32];
        let full_hash: [u8; 32] = Keccak256::digest(full_secret).into();
        let partial_root = [0x66; 32];
        let route = ladder_route(
            &source_user,
            &source_hub,
            &target_hub,
            &target_user,
            full_hash,
            partial_root,
        );
        let mut state = EntityStateSlice::empty(source_hub.as_hex(), 1_000);
        state.cross_jurisdiction_swaps = Some(
            crate::EntityCanonicalCollection::from_entries([("route-1".into(), route)])
                .expect("route collection"),
        );
        let recovery = CanonicalValue::Object(vec![
            (
                "requiredPullIds".into(),
                CanonicalValue::Array(vec![CanonicalValue::String("source-pull".into())]),
            ),
            ("resultsByPullId".into(), CanonicalValue::Object(Vec::new())),
        ]);
        let active = CanonicalValue::Object(vec![("crossJurisdictionRecovery".into(), recovery)]);
        let views = BTreeMap::from([(source_user.as_hex(), dispute_view(Some(active)))]);
        let mut mutations = Vec::new();
        let mut outputs = Vec::new();
        let mut frame_events = Vec::new();
        apply_hash_ladder_reveal_registered(
            &mut state,
            &ladder_event(
                &source_user,
                &source_hub,
                full_secret,
                full_hash,
                partial_root,
            ),
            &views,
            &mut mutations,
            &mut outputs,
            &mut frame_events,
        )
        .expect("registry event");

        let stored = state
            .cross_jurisdiction_swaps
            .as_ref()
            .and_then(|routes| routes.get("route-1"))
            .expect("updated route");
        assert_eq!(object_u64(stored, "sourceRegistryFillRatio"), Some(65_535));
        assert_eq!(
            object_field(stored, "sourceRegistryRecord")
                .and_then(|record| object_u64(record, "revealedAt")),
            Some(100)
        );
        let [
            (
                _,
                AccountEnvelopeMutation::ReplaceDisputeLifecycle {
                    active_dispute: Some(active),
                    ..
                },
            ),
        ] = mutations.as_slice()
        else {
            panic!("one recovery mutation expected")
        };
        let results = object_field(active, "crossJurisdictionRecovery")
            .and_then(|recovery| object_field(recovery, "resultsByPullId"))
            .and_then(|results| object_text(results, "source-pull"));
        assert_eq!(results, Some("65535"));
        assert!(outputs.is_empty());
    }

    #[test]
    fn source_user_ports_one_verified_salvage_to_target_lane() {
        let source_user = entity(0x11);
        let source_hub = entity(0x22);
        let target_hub = entity(0x33);
        let target_user = entity(0x44);
        let full_secret = [0x55; 32];
        let full_hash: [u8; 32] = Keccak256::digest(full_secret).into();
        let partial_root = [0x66; 32];
        let route = ladder_route(
            &source_user,
            &source_hub,
            &target_hub,
            &target_user,
            full_hash,
            partial_root,
        );
        let mut state = EntityStateSlice::empty(source_user.as_hex(), 1_000);
        state.cross_jurisdiction_swaps = Some(
            crate::EntityCanonicalCollection::from_entries([("route-1".into(), route)])
                .expect("route collection"),
        );
        let mut outputs = Vec::new();
        apply_hash_ladder_reveal_registered(
            &mut state,
            &ladder_event(
                &source_user,
                &source_hub,
                full_secret,
                full_hash,
                partial_root,
            ),
            &BTreeMap::new(),
            &mut Vec::new(),
            &mut outputs,
            &mut Vec::new(),
        )
        .expect("port reveal");
        assert!(matches!(
            outputs.as_slice(),
            [LocalEntityOutput { entity_id, entity_txs, .. }]
                if entity_id == &target_user.as_hex()
                    && matches!(entity_txs.as_slice(), [LocalEntityOutputTx::Projected(tx)]
                        if tx.kind == EntityTxKind::CrossJurisdictionSalvage)
        ));
    }

    fn event_proof_body() -> xln_rscore_engine::ProofBody {
        xln_rscore_engine::ProofBody {
            watch_seed: prefixed_hex(&[0x33; 32]),
            left_response_seconds: 10,
            right_response_seconds: 20,
            offdeltas: vec![BigInt::from(7)],
            token_ids: vec![BigInt::from(1)],
            transformers: Vec::new(),
        }
    }

    fn event_proof_hash() -> [u8; 32] {
        let body = crate::proof_body_from_j_event(&event_proof_body()).expect("event body");
        crate::proof_body_hash(&body).expect("event body hash")
    }

    fn dispute_started_event(
        owner: &EntityId,
        counterparty: &EntityId,
    ) -> xln_rscore_engine::DisputeStartedEvent {
        xln_rscore_engine::DisputeStartedEvent {
            metadata: JEventMetadata {
                block_number: Some(9),
                ..Default::default()
            },
            sender: owner.as_hex(),
            counterentity: counterparty.as_hex(),
            nonce: BigInt::from(3),
            proposer_is_left: false,
            proofbody_hash: prefixed_hex(&event_proof_hash()),
            watch_seed: [0x33; 32],
            starter_initial_arguments: vec![1, 2],
            starter_counter_arguments: vec![3, 4],
            starter_counter_proof_commitment: [0x55; 32],
            initial_proofbody: event_proof_body(),
            dispute_timeout: 130,
            dispute_start_timestamp: 100,
            left_response_seconds: 10,
            right_response_seconds: 20,
            batch_nonce: None,
        }
    }

    #[test]
    fn dispute_started_is_one_worker_owned_account_mutation() {
        let owner = entity(0x11);
        let counterparty = entity(0x22);
        let mut state = EntityStateSlice::empty(owner.as_hex(), 1_000);
        state.known_accounts.insert(counterparty.as_hex());
        let views = BTreeMap::from([(counterparty.as_hex(), dispute_view(None))]);
        let mut mutations = Vec::new();
        let mut paybook = crate::paybook::PaybookChanges::default();
        let mut proposals = BTreeMap::new();
        let mut outputs = Vec::new();
        let mut events = Vec::new();
        apply_dispute_started(
            &mut state,
            &dispute_started_event(&owner, &counterparty),
            "runtime-seed",
            &views,
            &mut paybook,
            &mut proposals,
            &mut mutations,
            &mut outputs,
            &mut events,
        )
        .expect("started");
        let [
            (
                account,
                AccountEnvelopeMutation::ApplyDisputeStarted(AccountDisputeStartedFinality {
                    active_dispute,
                    j_nonce,
                }),
            ),
        ] = mutations.as_slice()
        else {
            panic!("one typed dispute mutation expected")
        };
        assert_eq!(account, &counterparty.as_hex());
        assert_eq!(*j_nonce, 3);
        assert_eq!(object_bool(active_dispute, "startedByLeft"), Some(true));
        assert_eq!(object_u64(active_dispute, "observedBlockNumber"), Some(9));
        assert_eq!(object_u64(active_dispute, "disputeTimeout"), Some(130));
        assert!(
            state
                .crontab
                .as_ref()
                .expect("crontab")
                .hooks
                .iter()
                .any(|(id, _)| id == &format!("dispute-deadline:{}", counterparty.as_hex()))
        );
        assert!(outputs.is_empty());
    }

    #[test]
    fn dispute_started_decodes_first_delta_argument_secrets_into_paybook() {
        let owner = entity(0x11);
        let counterparty = entity(0x22);
        let secret = [0x77; 32];
        let hashlock = prefixed_hex(&<[u8; 32]>::from(Keccak256::digest(secret)));
        let mut state = EntityStateSlice::empty(owner.as_hex(), 1_000);
        state.known_accounts.insert(counterparty.as_hex());
        state.paybook = crate::PaybookState::from_entries(
            [crate::PaybookEntry {
                hashlock: hashlock.clone(),
                description: None,
                token_id: Some(1),
                amount: Some(BigInt::from(100)),
                started_at_ms: Some(1),
                originated: false,
                inbound_entity: Some(counterparty.as_hex()),
                outbound_entity: None,
                inbound_settled: false,
                outbound_settled: false,
                secret: None,
                secret_ack_pending: false,
                secret_ack_started_at: None,
                secret_ack_deadline_at: None,
                pending_fee: None,
                created_timestamp: 1,
            }],
            BigInt::from(0),
        )
        .expect("paybook");
        let delta_arguments = ethabi::encode(&[Token::Tuple(vec![
            Token::Array(Vec::new()),
            Token::Array(vec![Token::FixedBytes(secret.to_vec())]),
        ])]);
        let mut event = dispute_started_event(&owner, &counterparty);
        event.starter_initial_arguments =
            ethabi::encode(&[Token::Array(vec![Token::Bytes(delta_arguments)])]);
        let views = BTreeMap::from([(counterparty.as_hex(), dispute_view(None))]);
        let mut paybook = crate::paybook::PaybookChanges::default();
        let mut proposals = BTreeMap::new();
        apply_dispute_started(
            &mut state,
            &event,
            "runtime-seed",
            &views,
            &mut paybook,
            &mut proposals,
            &mut Vec::new(),
            &mut Vec::new(),
            &mut Vec::new(),
        )
        .expect("dispute start");
        paybook
            .commit_sequential(&mut state)
            .expect("paybook commit");
        assert_eq!(
            state
                .paybook
                .entry(&hashlock)
                .expect("lookup")
                .expect("route")
                .secret
                .as_deref(),
            Some(prefixed_hex(&secret).as_str())
        );
        assert!(matches!(
            proposals.get(&counterparty.as_hex()).map(Vec::as_slice),
            Some([AccountTx::HtlcResolve(HtlcResolveTx {
                lock_id,
                outcome: HtlcResolveOutcome::Secret { secret: revealed },
            })]) if lock_id == &hashlock && revealed == &prefixed_hex(&secret)
        ));
    }

    #[test]
    fn dispute_started_queues_newer_pull_counter_proof_before_deadline() {
        let owner = entity(0x11);
        let counterparty = entity(0x22);
        let delta_transformer = [0x44; 20];
        let encoded_batch = ethabi::encode(&[Token::Tuple(vec![
            Token::Array(Vec::new()),
            Token::Array(Vec::new()),
            Token::Array(vec![Token::Tuple(vec![
                Token::Uint(U256::zero()),
                Token::Int(U256::from(100_u64)),
                Token::Uint(U256::from(17_u8)),
                Token::FixedBytes(vec![0x55; 32]),
                Token::FixedBytes(vec![0x66; 32]),
                Token::Bool(false),
            ])]),
        ])]);
        let engine_body = xln_rscore_engine::DisputeProofBody {
            watch_seed: [0x33; 32],
            left_response_seconds: 10,
            right_response_seconds: 20,
            offdeltas: vec![BigInt::from(7)],
            token_ids: vec![1],
            transformers: vec![xln_rscore_engine::DisputeTransformerClause {
                transformer_address: delta_transformer,
                encoded_batch: encoded_batch.clone(),
                allowances: Vec::new(),
            }],
        };
        let event_body = xln_rscore_engine::ProofBody {
            watch_seed: prefixed_hex(&[0x33; 32]),
            left_response_seconds: 10,
            right_response_seconds: 20,
            offdeltas: vec![BigInt::from(7)],
            token_ids: vec![BigInt::from(1)],
            transformers: vec![xln_rscore_engine::ProofTransformerClause {
                transformer_address: prefixed_hex(&delta_transformer),
                encoded_batch: prefixed_hex(&encoded_batch),
                allowances: Vec::new(),
            }],
        };
        let body = crate::proof_body_from_engine(engine_body.clone()).expect("body");
        let body_hash = crate::proof_body_hash(&body).expect("hash");
        let mut view = dispute_view(None);
        view.owner_is_left = true;
        view.proof_body = Ok(engine_body);
        view.counterparty_dispute = Some(xln_rscore_engine::CounterpartyDispute {
            hanko: Some(vec![0x99; 65]),
            hash: [0x88; 32],
            proof_body_hash: body_hash,
            nonce: 4,
            proposer_is_left: true,
        });
        let views = BTreeMap::from([(counterparty.as_hex(), view)]);
        let mut event = dispute_started_event(&owner, &counterparty);
        event.sender = counterparty.as_hex();
        event.counterentity = owner.as_hex();
        event.initial_proofbody = event_body;
        event.proofbody_hash = prefixed_hex(&body_hash);
        let mut state = EntityStateSlice::empty(owner.as_hex(), 101_000);
        state.known_accounts.insert(counterparty.as_hex());
        let mut outputs = Vec::new();
        apply_dispute_started(
            &mut state,
            &event,
            "runtime-seed",
            &views,
            &mut crate::paybook::PaybookChanges::default(),
            &mut BTreeMap::new(),
            &mut Vec::new(),
            &mut outputs,
            &mut Vec::new(),
        )
        .expect("counter proof");
        let queued = &state
            .j_batch_state
            .as_ref()
            .expect("jBatch")
            .batch
            .counter_disputes;
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].counter_nonce, U256::from(4_u8));
        assert_eq!(queued[0].counter_proofbody, body);
        assert_eq!(outputs.len(), 1);
    }

    #[test]
    fn dispute_started_rejects_event_body_not_equal_to_resident_account() {
        let owner = entity(0x11);
        let counterparty = entity(0x22);
        let mut state = EntityStateSlice::empty(owner.as_hex(), 1_000);
        state.known_accounts.insert(counterparty.as_hex());
        let views = BTreeMap::from([(counterparty.as_hex(), dispute_view(None))]);
        let mut event = dispute_started_event(&owner, &counterparty);
        event.initial_proofbody.offdeltas[0] = BigInt::from(8);
        let mut mutations = Vec::new();
        let mut paybook = crate::paybook::PaybookChanges::default();
        let mut proposals = BTreeMap::new();
        let error = apply_dispute_started(
            &mut state,
            &event,
            "runtime-seed",
            &views,
            &mut paybook,
            &mut proposals,
            &mut mutations,
            &mut Vec::new(),
            &mut Vec::new(),
        )
        .expect_err("mismatched event proof must fail");
        assert!(error.to_string().contains("EVENT_PROOFBODY_HASH_MISMATCH"));
        assert!(mutations.is_empty());
    }

    #[test]
    fn counter_then_finality_selects_left_equal_nonce_and_clears_account_epoch() {
        let owner = entity(0x11);
        let counterparty = entity(0x22);
        let mut state = EntityStateSlice::empty(owner.as_hex(), 1_000);
        state.known_accounts.insert(counterparty.as_hex());
        state.j_batch_state = Some(crate::JBatchState {
            entity_nonce: Some(0),
            ..Default::default()
        });
        let base_view = dispute_view(None);
        let start = dispute_started_event(&owner, &counterparty);
        let active = dispute_started_active_value(&start, &base_view, true, event_proof_hash(), 3)
            .expect("active");
        let mut views = BTreeMap::from([(counterparty.as_hex(), dispute_view(Some(active)))]);
        let counter = xln_rscore_engine::CounterDisputeRegisteredEvent {
            metadata: JEventMetadata {
                block_number: Some(10),
                ..Default::default()
            },
            sender: counterparty.as_hex(),
            counterentity: owner.as_hex(),
            nonce: 3,
            proposer_is_left: true,
            proofbody_hash: event_proof_hash(),
            counter_proofbody: event_proof_body(),
        };
        let mut mutations = Vec::new();
        apply_counter_dispute_registered(
            &mut state,
            &counter,
            "runtime-seed",
            &views,
            &mut mutations,
            &mut Vec::new(),
            &mut Vec::new(),
        )
        .expect("counter");
        let AccountEnvelopeMutation::ReplaceDisputeLifecycle {
            active_dispute: Some(selected),
            ..
        } = &mutations[0].1
        else {
            panic!("selected lifecycle expected")
        };
        assert_eq!(object_u64(selected, "selectedCounterNonce"), Some(3));
        assert_eq!(
            object_bool(selected, "selectedCounterProposerIsLeft"),
            Some(true)
        );
        views
            .get_mut(&counterparty.as_hex())
            .expect("view")
            .active_dispute = Some(selected.clone());
        mutations.clear();
        let finalized = xln_rscore_engine::DisputeFinalizedEvent {
            metadata: JEventMetadata {
                block_number: Some(11),
                ..Default::default()
            },
            sender: owner.as_hex(),
            counterentity: counterparty.as_hex(),
            initial_nonce: BigInt::from(3),
            initial_proofbody_hash: prefixed_hex(&event_proof_hash()),
            final_proofbody_hash: prefixed_hex(&event_proof_hash()),
            finalization_evidence_hash: prefixed_hex(&[0x77; 32]),
            final_proofbody: event_proof_body(),
            batch_nonce: Some(1),
        };
        let evidence = xln_rscore_engine::DisputeFinalizationEvidence {
            sender: owner.as_hex(),
            counterentity: counterparty.as_hex(),
            initial_nonce: "3".into(),
            final_nonce: "3".into(),
            initial_proofbody_hash: prefixed_hex(&event_proof_hash()),
            final_proofbody_hash: prefixed_hex(&event_proof_hash()),
            proposer_is_left: true,
            left_arguments: "0x".into(),
            right_arguments: "0x".into(),
            started_by_left: true,
            sig: "0x12".into(),
        };
        let mut frame_events = Vec::new();
        apply_dispute_finalized(
            &mut state,
            &finalized,
            &[evidence],
            &views,
            &mut mutations,
            &mut Vec::new(),
            &mut frame_events,
        )
        .expect("finality");
        assert!(matches!(
            mutations.as_slice(),
            [(
                account,
                AccountEnvelopeMutation::ApplyDisputeFinality(AccountDisputeFinality {
                    finalized_j_nonce: 3,
                    finalized_token_ids,
                })
            )] if account == &counterparty.as_hex() && finalized_token_ids == &[TokenId::new(1).expect("token")]
        ));
        assert_eq!(
            frame_events,
            vec![
                EntityFrameEvent::Status {
                    message: "↻ Synced J batch nonce from event (0 → 1)".into(),
                },
                EntityFrameEvent::Status {
                    message: format!(
                        "✅ DISPUTE FINALIZED with {} (nonce 3)",
                        suffix(&counterparty.as_hex(), 4),
                    ),
                },
            ],
            "inside the five-event H2008 vector, sync must remain between Debt and Dispute Finalized",
        );
    }
}

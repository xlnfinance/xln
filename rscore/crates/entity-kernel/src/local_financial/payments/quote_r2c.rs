use ethabi::ethereum_types::U256;
use num_bigint::BigInt;
use xln_rscore_engine::{AccountTx, DeliveryMode, TokenId};
use xln_rscore_protocol::CanonicalValue;

use crate::{EntityFrameEvent, EntityKernelError, EntityStateSlice};

use super::types::{AccountEnvelopeMutation, LocalAccountFinancialView, QuoteBackedR2cEntityTx};

const QUOTE_EXPIRY_MS: u64 = 300_000;

fn invalid(detail: impl Into<String>) -> EntityKernelError {
    EntityKernelError::local("r2c", detail.into())
}

fn object(value: &CanonicalValue) -> Result<&[(String, CanonicalValue)], EntityKernelError> {
    match value {
        CanonicalValue::Object(fields) => Ok(fields),
        _ => Err(invalid("REBALANCE_QUOTE_OBJECT")),
    }
}

fn field<'a>(
    fields: &'a [(String, CanonicalValue)],
    name: &str,
) -> Result<&'a CanonicalValue, EntityKernelError> {
    fields
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
        .ok_or_else(|| invalid(format!("REBALANCE_QUOTE_FIELD_MISSING:{name}")))
}

fn number(fields: &[(String, CanonicalValue)], name: &str) -> Result<u64, EntityKernelError> {
    let CanonicalValue::Number(value) = field(fields, name)? else {
        return Err(invalid(format!("REBALANCE_QUOTE_NUMBER:{name}")));
    };
    value
        .as_str()
        .parse::<u64>()
        .ok()
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or_else(|| invalid(format!("REBALANCE_QUOTE_NUMBER:{name}")))
}

fn bigint(fields: &[(String, CanonicalValue)], name: &str) -> Result<BigInt, EntityKernelError> {
    match field(fields, name)? {
        CanonicalValue::BigInt(value) => Ok(value.clone()),
        _ => Err(invalid(format!("REBALANCE_QUOTE_BIGINT:{name}"))),
    }
}

fn boolean(fields: &[(String, CanonicalValue)], name: &str) -> Result<bool, EntityKernelError> {
    match field(fields, name)? {
        CanonicalValue::Bool(value) => Ok(*value),
        _ => Err(invalid(format!("REBALANCE_QUOTE_BOOL:{name}"))),
    }
}

fn word(value: &str) -> Result<[u8; 32], EntityKernelError> {
    let payload = value
        .strip_prefix("0x")
        .ok_or_else(|| invalid("ENTITY_ID"))?;
    if payload.len() != 64 {
        return Err(invalid("ENTITY_ID"));
    }
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&payload[index * 2..index * 2 + 2], 16)
            .map_err(|_| invalid("ENTITY_ID"))?;
    }
    Ok(output)
}

fn u256(value: &BigInt) -> Result<U256, EntityKernelError> {
    U256::from_dec_str(&value.to_string()).map_err(|_| invalid("AMOUNT_U256"))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn apply(
    state: &mut EntityStateSlice,
    tx: QuoteBackedR2cEntityTx,
    account_views: &std::collections::BTreeMap<String, LocalAccountFinancialView>,
    account_txs: &mut Vec<(String, AccountTx)>,
    events: &mut Vec<EntityFrameEvent>,
    envelope_mutations: &mut Vec<(String, AccountEnvelopeMutation)>,
) -> Result<(), EntityKernelError> {
    let receiving = tx
        .receiving_entity_id
        .clone()
        .unwrap_or_else(|| state.entity_id.clone());
    if receiving != state.entity_id {
        events.push(EntityFrameEvent::Status {
            message: "❌ Rebalance fee unsupported for remote reserve → account deposits".into(),
        });
        return Ok(());
    }
    if !state.known_accounts.contains(&tx.counterparty_entity_id) {
        events.push(EntityFrameEvent::Status {
            message: format!(
                "❌ Cannot deposit collateral: no account with {}",
                &tx.counterparty_entity_id[tx.counterparty_entity_id.len() - 4..]
            ),
        });
        return Ok(());
    }
    let view = account_views
        .get(&tx.counterparty_entity_id)
        .ok_or_else(|| invalid("ACCOUNT_VIEW_MISSING"))?;
    let Some(quote) = view.rebalance_active_quote.as_ref() else {
        events.push(EntityFrameEvent::Status {
            message: format!(
                "❌ Rebalance fee: no active quote for {}",
                &tx.counterparty_entity_id[tx.counterparty_entity_id.len() - 4..]
            ),
        });
        return Ok(());
    };
    let quote = object(quote)?;
    let quote_id = number(quote, "quoteId")?;
    let fee_token = TokenId::new(
        u32::try_from(number(quote, "feeTokenId")?).map_err(|_| invalid("FEE_TOKEN"))?,
    )
    .map_err(|_| invalid("FEE_TOKEN"))?;
    let fee_amount = bigint(quote, "feeAmount")?;
    if quote_id != tx.rebalance_quote_id {
        events.push(EntityFrameEvent::Status {
            message: format!(
                "❌ Rebalance fee: quoteId mismatch (expected {quote_id}, got {})",
                tx.rebalance_quote_id
            ),
        });
        return Ok(());
    }
    if !boolean(quote, "accepted")? {
        events.push(EntityFrameEvent::Status {
            message: "❌ Rebalance fee: quote not accepted".into(),
        });
        return Ok(());
    }
    if state.timestamp > quote_id.saturating_add(QUOTE_EXPIRY_MS) {
        envelope_mutations.push((
            tx.counterparty_entity_id,
            AccountEnvelopeMutation::ClearRebalanceActiveQuote,
        ));
        events.push(EntityFrameEvent::Status {
            message: format!(
                "❌ Rebalance fee: quote expired (age: {}ms)",
                state.timestamp.saturating_sub(quote_id)
            ),
        });
        return Ok(());
    }
    if tx.rebalance_fee_amount.as_ref() != Some(&fee_amount) {
        events.push(EntityFrameEvent::Status {
            message: format!(
                "❌ Rebalance fee: amount mismatch (expected {fee_amount}, got {})",
                tx.rebalance_fee_amount
                    .as_ref()
                    .map_or_else(|| "undefined".into(), ToString::to_string)
            ),
        });
        return Ok(());
    }
    if tx.rebalance_fee_token_id != Some(fee_token) {
        events.push(EntityFrameEvent::Status {
            message: format!(
                "❌ Rebalance fee: tokenId mismatch (expected {}, got {})",
                fee_token.get(),
                tx.rebalance_fee_token_id
                    .map_or_else(|| "undefined".into(), |token| token.get().to_string())
            ),
        });
        return Ok(());
    }
    if fee_amount > BigInt::from(0) {
        account_txs.push((
            tx.counterparty_entity_id.clone(),
            AccountTx::DirectPayment {
                token_id: fee_token,
                amount: fee_amount,
                route: vec![state.entity_id.clone()],
                description: Some(format!(
                    "rebalance fee (quoteId: {})",
                    tx.rebalance_quote_id
                )),
                from_entity_id: tx.counterparty_entity_id.clone(),
                to_entity_id: state.entity_id.clone(),
                delivery_mode: DeliveryMode::Direct,
                trusted_gateway_entity_id: None,
            },
        ));
    }
    envelope_mutations.push((
        tx.counterparty_entity_id.clone(),
        AccountEnvelopeMutation::ClearRebalanceActiveQuote,
    ));
    crate::local_control::queue_reserve_to_collateral(
        state,
        word(&receiving)?,
        word(&tx.counterparty_entity_id)?,
        u64::from(tx.token_id.get()),
        u256(&tx.amount)?,
    )?;
    events.push(EntityFrameEvent::Status {
        message: format!(
            "📦 Queued R→C: {} token {} to {}↔{} (use j_broadcast to commit)",
            tx.amount,
            tx.token_id.get(),
            &receiving[receiving.len() - 4..],
            &tx.counterparty_entity_id[tx.counterparty_entity_id.len() - 4..]
        ),
    });
    Ok(())
}

use num_bigint::BigInt;
use xln_rscore_engine::{AccountTx, DeliveryMode};

use crate::{EntityFrameEvent, EntityKernelError, EntityStateSlice};

use super::types::DirectPaymentEntityTx;

const MAX_ROUTE_HOPS: usize = 100;
const MAX_PAYMENT_AMOUNT_BITS: u64 = 128;

pub(super) fn apply_direct_payment(
    state: &EntityStateSlice,
    tx: DirectPaymentEntityTx,
    account_txs: &mut Vec<(String, AccountTx)>,
    events: &mut Vec<EntityFrameEvent>,
    wake_targets: &mut Vec<String>,
) -> Result<(), EntityKernelError> {
    if tx.amount < BigInt::from(1) || tx.amount.bits() > MAX_PAYMENT_AMOUNT_BITS {
        events.push(EntityFrameEvent::Status {
            message: "❌ Payment failed: amount out of bounds".into(),
        });
        return Ok(());
    }
    if tx.route.is_empty() || tx.route.len() > MAX_ROUTE_HOPS {
        return Err(EntityKernelError::local("directPayment", "ROUTE"));
    }
    if tx.route.first() != Some(&state.entity_id) || tx.route.last() != Some(&tx.target_entity_id) {
        return Err(EntityKernelError::local("directPayment", "ROUTE_BINDING"));
    }
    match tx.delivery_mode {
        DeliveryMode::Direct if tx.trusted_gateway_entity_id.is_some() || tx.route.len() != 2 => {
            return Err(EntityKernelError::local("directPayment", "DIRECT_ROUTE"));
        }
        DeliveryMode::Trusted => {
            let gateway = tx
                .route
                .get(1)
                .ok_or_else(|| EntityKernelError::local("directPayment", "GATEWAY"))?;
            if tx.route.len() != 3
                || tx.trusted_gateway_entity_id.as_ref() != Some(gateway)
                || gateway == &state.entity_id
                || gateway == &tx.target_entity_id
            {
                return Err(EntityKernelError::local("directPayment", "GATEWAY"));
            }
        }
        DeliveryMode::Direct => {}
    }
    if tx.route.len() == 1 {
        events.push(EntityFrameEvent::Status {
            message: format!(
                "💰 Received payment of {} (token {})",
                tx.amount,
                tx.token_id.get()
            ),
        });
        return Ok(());
    }
    let next_hop = tx.route[1].clone();
    if !state.known_accounts.contains(&next_hop) {
        return Err(EntityKernelError::AccountMissing {
            account_id: next_hop,
        });
    }
    let description = Some(match tx.description {
        Some(value) if !value.is_empty() => value,
        _ => format!("Payment to {}", tx.target_entity_id),
    });
    account_txs.push((
        next_hop.clone(),
        AccountTx::DirectPayment {
            token_id: tx.token_id,
            amount: tx.amount.clone(),
            route: tx.route[1..].to_vec(),
            description,
            from_entity_id: state.entity_id.clone(),
            to_entity_id: next_hop,
            delivery_mode: tx.delivery_mode,
            trusted_gateway_entity_id: tx.trusted_gateway_entity_id,
        },
    ));
    events.push(EntityFrameEvent::Status {
        message: format!(
            "💸 Sending {} (token {}) to {} via {} hops",
            tx.amount,
            tx.token_id.get(),
            tx.target_entity_id,
            tx.route.len() - 1
        ),
    });
    wake_targets.push(state.entity_id.clone());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entity(byte: &str) -> String {
        format!("0x{}", byte.repeat(32))
    }

    #[test]
    fn empty_description_uses_the_exact_ts_default_and_emits_one_self_wake() {
        let owner = entity("11");
        let peer = entity("22");
        let mut state = EntityStateSlice::empty(owner.clone(), 100);
        state.known_accounts.insert(peer.clone());
        let mut account_txs = Vec::new();
        let mut events = Vec::new();
        let mut wakes = Vec::new();
        apply_direct_payment(
            &state,
            DirectPaymentEntityTx {
                target_entity_id: peer.clone(),
                token_id: xln_rscore_engine::TokenId::new(1).expect("token"),
                amount: BigInt::from(7),
                route: vec![owner.clone(), peer.clone()],
                description: Some(String::new()),
                delivery_mode: DeliveryMode::Direct,
                trusted_gateway_entity_id: None,
            },
            &mut account_txs,
            &mut events,
            &mut wakes,
        )
        .expect("direct payment");
        assert_eq!(wakes, vec![owner.clone()]);
        assert!(matches!(
            account_txs.as_slice(),
            [(account_id, AccountTx::DirectPayment { description, .. })]
                if account_id == &peer
                    && description.as_deref() == Some(format!("Payment to {peer}").as_str())
        ));
    }
}

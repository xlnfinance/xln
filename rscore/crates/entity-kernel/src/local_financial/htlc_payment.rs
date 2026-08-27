use std::collections::BTreeMap;

use num_bigint::BigInt;
use xln_rscore_engine::{AccountTx, HtlcDeliveryMode, HtlcHashlock, HtlcLockTx, TokenId};

use crate::{
    DeterministicContext, EntityFrameEvent, EntityKernelError, EntityKernelOutput,
    EntityStateSlice, HtlcRoute, LockBookEntry, OriginatedHtlcDeliveryMode,
};

use super::types::{HtlcPaymentEntityTx, LocalAccountFinancialView};

const MAX_ENTITY_HTLC_NOTE_BYTES: usize = 256;

fn invalid(detail: impl Into<String>) -> EntityKernelError {
    EntityKernelError::local("htlcPayment", detail)
}

fn valid_hash(value: &str) -> bool {
    value.strip_prefix("0x").is_some_and(|payload| {
        payload.len() == 64
            && payload
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn validate_raw(tx: &HtlcPaymentEntityTx) -> Result<(), EntityKernelError> {
    if tx.amount <= BigInt::from(0) {
        return Err(invalid("HTLC_PAYMENT_AMOUNT_INVALID"));
    }
    if tx.max_sender_debit <= BigInt::from(0) {
        return Err(invalid("HTLC_PAYMENT_MAX_SENDER_DEBIT_INVALID"));
    }
    if tx.max_sender_debit < tx.amount {
        return Err(invalid("HTLC_PAYMENT_MAX_SENDER_DEBIT_BELOW_AMOUNT"));
    }
    if tx.description.as_ref().is_some_and(|description| {
        description.trim() != description || description.len() > MAX_ENTITY_HTLC_NOTE_BYTES
    }) {
        return Err(invalid("HTLC_PAYMENT_DESCRIPTION_INVALID"));
    }
    if tx.hashlock.as_ref().is_some_and(|value| !valid_hash(value)) {
        return Err(invalid("HTLC_PAYMENT_HASHLOCK_INVALID"));
    }
    Ok(())
}

fn delivery_mode(value: OriginatedHtlcDeliveryMode) -> HtlcDeliveryMode {
    match value {
        OriginatedHtlcDeliveryMode::Instant => HtlcDeliveryMode::Instant,
        OriginatedHtlcDeliveryMode::Async => HtlcDeliveryMode::Async,
    }
}

fn require_capacity<'a>(
    tx_hash: &str,
    account_id: &str,
    token_id: TokenId,
    required: &BigInt,
    account_views: &'a BTreeMap<String, LocalAccountFinancialView>,
) -> Result<&'a LocalAccountFinancialView, EntityKernelError> {
    let view = account_views.get(account_id).ok_or_else(|| {
        invalid(format!(
            "HTLC_PAYMENT_OUTBOUND_ACCOUNT_UNAVAILABLE:{tx_hash}"
        ))
    })?;
    if !view.active {
        return Err(invalid(format!(
            "HTLC_PAYMENT_OUTBOUND_ACCOUNT_UNAVAILABLE:{tx_hash}"
        )));
    }
    if view
        .owner_out_capacity
        .get(&token_id)
        .is_none_or(|available| available < required)
    {
        return Err(invalid(format!(
            "HTLC_PAYMENT_OUTBOUND_CAPACITY_INSUFFICIENT:{tx_hash}"
        )));
    }
    Ok(view)
}

pub(super) fn apply_htlc_payment(
    state: &mut EntityStateSlice,
    tx: HtlcPaymentEntityTx,
    context: &DeterministicContext,
    account_views: &BTreeMap<String, LocalAccountFinancialView>,
    account_txs: &mut Vec<(String, AccountTx)>,
    outputs: &mut Vec<EntityKernelOutput>,
    events: &mut Vec<EntityFrameEvent>,
) -> Result<(), EntityKernelError> {
    validate_raw(&tx)?;
    let prepared = context.originated_htlcs.get(&tx.tx_hash).ok_or_else(|| {
        invalid(format!(
            "HTLC_PAYMENT_PREPARED_CONTEXT_REQUIRED:{}",
            tx.tx_hash
        ))
    })?;
    if prepared.target_entity_id != tx.target_entity_id
        || prepared.token_id != tx.token_id.get()
        || prepared.recipient_amount != tx.amount
        || prepared.max_sender_debit != tx.max_sender_debit
        || prepared.delivery_mode != tx.delivery_mode
        || tx
            .started_at_ms
            .is_some_and(|value| prepared.started_at_ms != value)
    {
        return Err(invalid(format!(
            "HTLC_PAYMENT_PREPARED_CONTEXT_MISMATCH:{}",
            tx.tx_hash
        )));
    }
    if tx
        .hashlock
        .as_ref()
        .is_some_and(|value| value != &prepared.hashlock)
        || (!tx.route.is_empty() && tx.route != prepared.route)
        || tx.description.as_deref().unwrap_or("") != prepared.description
        || prepared.route.first() != Some(&state.entity_id)
        || prepared.route.last() != Some(&prepared.target_entity_id)
        || prepared.route.get(1) != Some(&prepared.next_hop_entity_id)
        || prepared.started_at_ms != state.timestamp
        || prepared.total_fee != &prepared.sender_lock_amount - &prepared.recipient_amount
        || prepared.sender_lock_amount > prepared.max_sender_debit
    {
        return Err(invalid(format!(
            "HTLC_PAYMENT_PREPARED_CONTEXT_MISMATCH:{}",
            tx.tx_hash
        )));
    }
    if state.htlc_routes.contains_key(&prepared.hashlock) {
        return Err(invalid(format!(
            "HTLC_PAYMENT_HASHLOCK_ALREADY_ACTIVE:{}",
            prepared.hashlock
        )));
    }
    require_capacity(
        &tx.tx_hash,
        &prepared.next_hop_entity_id,
        tx.token_id,
        &prepared.sender_lock_amount,
        account_views,
    )?;
    let hashlock = HtlcHashlock::parse(&prepared.hashlock)
        .map_err(|_| invalid("HTLC_PAYMENT_HASHLOCK_INVALID"))?;

    state.htlc_routes.insert(
        prepared.hashlock.clone(),
        HtlcRoute {
            hashlock: prepared.hashlock.clone(),
            token_id: Some(prepared.token_id),
            amount: Some(prepared.recipient_amount.clone()),
            started_at_ms: Some(prepared.started_at_ms),
            originated: true,
            inbound_entity: None,
            inbound_lock_id: None,
            outbound_entity: Some(prepared.next_hop_entity_id.clone()),
            outbound_lock_id: Some(prepared.lock_id.clone()),
            inbound_settled: false,
            outbound_settled: false,
            secret: None,
            secret_ack_pending: false,
            secret_ack_started_at: None,
            secret_ack_deadline_at: None,
            pending_fee: None,
            created_timestamp: state.timestamp,
        },
    );
    state.lock_book.insert(
        prepared.lock_id.clone(),
        LockBookEntry {
            lock_id: prepared.lock_id.clone(),
            account_id: prepared.next_hop_entity_id.clone(),
            token_id: prepared.token_id,
            amount: prepared.sender_lock_amount.clone(),
            hashlock: prepared.hashlock.clone(),
            timelock: prepared.timelock.clone(),
            outgoing: true,
            created_at: BigInt::from(state.timestamp),
        },
    );
    outputs.push(EntityKernelOutput::HtlcInitiated {
        entity_id: state.entity_id.clone(),
        from_entity: state.entity_id.clone(),
        to_entity: prepared.target_entity_id.clone(),
        token_id: prepared.token_id,
        amount: prepared.recipient_amount.clone(),
        sender_amount: prepared.sender_lock_amount.clone(),
        fee: prepared.total_fee.clone(),
        hashlock: prepared.hashlock.clone(),
        lock_id: prepared.lock_id.clone(),
        route: prepared.route.clone(),
        description: (!prepared.description.is_empty()).then(|| prepared.description.clone()),
        started_at_ms: prepared.started_at_ms,
    });
    account_txs.push((
        prepared.next_hop_entity_id.clone(),
        AccountTx::HtlcLock(HtlcLockTx {
            lock_id: prepared.lock_id.clone(),
            hashlock,
            timelock: prepared.timelock.clone(),
            reveal_before_height: prepared.reveal_before_height,
            amount: prepared.sender_lock_amount.clone(),
            token_id: tx.token_id,
            delivery_mode: Some(delivery_mode(prepared.delivery_mode)),
            envelope: Some(prepared.envelope.clone()),
        }),
    ));
    events.push(EntityFrameEvent::Status {
        message: format!(
            "🔒 HTLC: Recipient {}, sender lock {} (fee {}) to {} via {} hops",
            prepared.recipient_amount,
            prepared.sender_lock_amount,
            prepared.total_fee,
            &prepared.target_entity_id[prepared.target_entity_id.len() - 4..],
            prepared.route.len() - 1,
        ),
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PreparedOriginatedHtlcPayment;
    use xln_rscore_engine::OpaqueHtlcCiphertext;

    fn entity(byte: &str) -> String {
        format!("0x{}", byte.repeat(32))
    }

    #[test]
    fn originated_context_becomes_one_lock_and_exact_entity_effect() {
        let owner = entity("11");
        let next = entity("22");
        let target = entity("33");
        let tx_hash = entity("aa");
        let hashlock = entity("bb");
        let lock_id = entity("cc");
        let token_id = TokenId::new(1).expect("token");
        let envelope = OpaqueHtlcCiphertext::from_packed(vec![0x44; 48]).expect("envelope");
        let prepared = PreparedOriginatedHtlcPayment {
            tx_hash: tx_hash.clone(),
            target_entity_id: target.clone(),
            token_id: 1,
            recipient_amount: BigInt::from(100),
            route: vec![owner.clone(), next.clone(), target.clone()],
            description: "note".into(),
            delivery_mode: OriginatedHtlcDeliveryMode::Instant,
            started_at_ms: 1_000,
            hashlock: hashlock.clone(),
            sender_lock_amount: BigInt::from(110),
            max_sender_debit: BigInt::from(120),
            total_fee: BigInt::from(10),
            lock_id: lock_id.clone(),
            timelock: BigInt::from(2_000),
            reveal_before_height: 50,
            next_hop_entity_id: next.clone(),
            envelope,
        };
        let mut context = DeterministicContext::hlt_default();
        context.originated_htlcs.insert(tx_hash.clone(), prepared);
        let views = BTreeMap::from([(
            next.clone(),
            LocalAccountFinancialView {
                active: true,
                owner_out_capacity: BTreeMap::from([(token_id, BigInt::from(1_000))]),
            },
        )]);
        let mut state = EntityStateSlice::empty(owner.clone(), 1_000);
        state.known_accounts.insert(next.clone());
        let mut account_txs = Vec::new();
        let mut outputs = Vec::new();
        let mut events = Vec::new();
        apply_htlc_payment(
            &mut state,
            HtlcPaymentEntityTx {
                target_entity_id: target.clone(),
                token_id,
                amount: BigInt::from(100),
                max_sender_debit: BigInt::from(120),
                route: vec![owner.clone(), next.clone(), target.clone()],
                description: Some("note".into()),
                delivery_mode: OriginatedHtlcDeliveryMode::Instant,
                started_at_ms: Some(1_000),
                hashlock: Some(hashlock.clone()),
                tx_hash,
            },
            &context,
            &views,
            &mut account_txs,
            &mut outputs,
            &mut events,
        )
        .expect("originated payment");
        assert!(state.htlc_routes.contains_key(&hashlock));
        assert!(state.lock_book.contains_key(&lock_id));
        assert!(matches!(
            account_txs.as_slice(),
            [(account_id, AccountTx::HtlcLock(lock))]
                if account_id == &next
                    && lock.lock_id == lock_id
                    && lock.amount == BigInt::from(110)
        ));
        assert_eq!(
            outputs,
            vec![EntityKernelOutput::HtlcInitiated {
                entity_id: owner.clone(),
                from_entity: owner,
                to_entity: target,
                token_id: 1,
                amount: BigInt::from(100),
                sender_amount: BigInt::from(110),
                fee: BigInt::from(10),
                hashlock,
                lock_id,
                route: vec![entity("11"), next, entity("33")],
                description: Some("note".into()),
                started_at_ms: 1_000,
            }]
        );
        assert_eq!(events.len(), 1);
    }
}

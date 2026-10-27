use sha3::{Digest as _, Keccak256};
use xln_rscore_engine::{AccountTx, HtlcResolveOutcome, HtlcResolveTx};

use crate::paybook::PaybookChanges;
use crate::{EntityFrameEvent, EntityKernelError, EntityStateSlice, PaybookEntry};

use super::types::{LocalAccountFinancialView, ResolveHtlcLockEntityTx};

fn secret_hash(secret: &str) -> Result<String, EntityKernelError> {
    let raw = secret
        .strip_prefix("0x")
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| EntityKernelError::local("resolveHtlcLock", "SECRET_BYTES32"))?;
    let bytes = hex::decode(raw)
        .map_err(|_| EntityKernelError::local("resolveHtlcLock", "SECRET_BYTES32"))?;
    Ok(format!("0x{}", hex::encode(Keccak256::digest(bytes))))
}

pub(super) fn apply(
    state: &EntityStateSlice,
    paybook: &mut PaybookChanges,
    mut tx: ResolveHtlcLockEntityTx,
    account_views: &std::collections::BTreeMap<String, LocalAccountFinancialView>,
    account_txs: &mut Vec<(String, AccountTx)>,
    events: &mut Vec<EntityFrameEvent>,
    wake_targets: &mut Vec<String>,
) -> Result<(), EntityKernelError> {
    tx.secret = tx.secret.to_ascii_lowercase();
    let account_id = tx.counterparty_entity_id.to_ascii_lowercase();
    if !state.known_accounts.contains(&account_id) {
        return Err(EntityKernelError::AccountMissing { account_id });
    }
    let view = account_views
        .get(&account_id)
        .ok_or_else(|| EntityKernelError::local("resolveHtlcLock", "ACCOUNT_VIEW_MISSING"))?;
    let lock = view
        .htlc_locks
        .get(&tx.lock_id)
        .ok_or_else(|| EntityKernelError::local("resolveHtlcLock", "HTLC_RESOLVE_LOCK_MISSING"))?;
    if lock.lock_id() != tx.lock_id
        || lock.hashlock().as_str() != tx.lock_id
        || secret_hash(&tx.secret)? != lock.hashlock().as_str()
    {
        return Err(EntityKernelError::local(
            "resolveHtlcLock",
            "HTLC_RESOLVE_HASHLOCK_MISMATCH",
        ));
    }

    let local_sent = lock.sender() == view.owner_side;
    let mut entry = paybook
        .entry(state, &tx.lock_id)?
        .cloned()
        .unwrap_or(PaybookEntry {
            hashlock: tx.lock_id.clone(),
            description: None,
            token_id: Some(lock.token_id().get()),
            amount: Some(lock.amount().clone()),
            started_at_ms: None,
            originated: false,
            inbound_entity: None,
            outbound_entity: None,
            inbound_settled: false,
            outbound_settled: false,
            secret: None,
            secret_ack_pending: false,
            secret_ack_started_at: None,
            secret_ack_deadline_at: None,
            pending_fee: None,
            created_timestamp: state.timestamp,
        });
    if entry
        .secret
        .as_ref()
        .is_some_and(|secret| !secret.eq_ignore_ascii_case(&tx.secret))
        || entry
            .token_id
            .is_some_and(|token| token != lock.token_id().get())
        || !local_sent
            && entry
                .amount
                .as_ref()
                .is_some_and(|amount| amount != lock.amount())
    {
        return Err(EntityKernelError::local(
            "resolveHtlcLock",
            "PAYBOOK_RESOLVE_CONFLICT",
        ));
    }
    let endpoint = if local_sent {
        &mut entry.outbound_entity
    } else {
        &mut entry.inbound_entity
    };
    if endpoint
        .as_ref()
        .is_some_and(|existing| !existing.eq_ignore_ascii_case(&account_id))
    {
        return Err(EntityKernelError::local(
            "resolveHtlcLock",
            "PAYBOOK_ENTITY_CONFLICT",
        ));
    }
    *endpoint = Some(account_id.clone());
    entry.secret = Some(tx.secret.clone());
    paybook.put(entry)?;

    account_txs.push((
        account_id.clone(),
        AccountTx::HtlcResolve(HtlcResolveTx {
            lock_id: tx.lock_id,
            outcome: HtlcResolveOutcome::Secret { secret: tx.secret },
        }),
    ));
    events.push(EntityFrameEvent::Status {
        message: format!("🔓 HTLC resolve queued for {account_id}"),
    });
    wake_targets.push(state.entity_id.clone());
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use num_bigint::BigInt;
    use xln_rscore_engine::{HtlcHashlock, HtlcLock, Side, TokenId};

    use super::*;

    #[test]
    fn fixpay_4_fee_bearing_outbound_lock_and_mixed_case_secret() {
        let owner = format!("0x{}", "11".repeat(32));
        let peer = format!("0x{}", "22".repeat(32));
        let secret = format!("0x{}", "ab".repeat(32));
        let lock_id = secret_hash(&secret).unwrap();
        let lock = HtlcLock::restore(
            lock_id.clone(),
            HtlcHashlock::parse(&lock_id).unwrap(),
            100_000.into(),
            100,
            99.into(),
            TokenId::new(1).unwrap(),
            Side::Left,
            1,
            1,
            None,
        )
        .unwrap();
        let mut state = EntityStateSlice::empty(owner, 3);
        state.known_accounts.insert(peer.clone());
        let mut entry = PaybookEntry {
            hashlock: lock_id.clone(),
            description: None,
            token_id: Some(1),
            amount: Some(100.into()),
            started_at_ms: None,
            originated: false,
            inbound_entity: Some("upstream".into()),
            outbound_entity: Some(peer.clone()),
            inbound_settled: false,
            outbound_settled: false,
            secret: Some(secret.clone()),
            secret_ack_pending: false,
            secret_ack_started_at: None,
            secret_ack_deadline_at: None,
            pending_fee: None,
            created_timestamp: 1,
        };
        let view = LocalAccountFinancialView {
            active: true,
            owner_side: Side::Left,
            owner_out_capacity: BTreeMap::new(),
            owner_peer_credit_limit: BTreeMap::new(),
            settlement_workspace: None,
            settlement_transition_pending: false,
            settlement_execution: Err("unused".into()),
            rebalance_active_quote: None,
            htlc_locks: BTreeMap::from([(lock_id.clone(), lock)]),
            pending_htlc_lock_ids: Default::default(),
            pulls: BTreeMap::new(),
            swap_offers: BTreeMap::new(),
            pending_cross_pull_close_ids: Default::default(),
            dispute: None,
        };
        for case_only in [false, true] {
            if case_only {
                entry.amount = Some(99.into());
            }
            let mut changes = PaybookChanges::default();
            changes.put(entry.clone()).unwrap();
            let result = apply(
                &state,
                &mut changes,
                ResolveHtlcLockEntityTx {
                    counterparty_entity_id: peer.clone(),
                    lock_id: lock_id.clone(),
                    secret: if case_only {
                        format!("0x{}", "AB".repeat(32))
                    } else {
                        secret.clone()
                    },
                    cross_jurisdiction_route_id: None,
                    description: None,
                },
                &BTreeMap::from([(peer.clone(), view.clone())]),
                &mut vec![],
                &mut vec![],
                &mut vec![],
            );
            assert!(result.is_ok(), "fee/case parity: {result:?}");
        }
    }

    #[test]
    fn verified_account_lock_is_recorded_once_in_paybook_and_queued() {
        let owner = format!("0x{}", "11".repeat(32));
        let peer = format!("0x{}", "22".repeat(32));
        let secret = format!("0x{}", "55".repeat(32));
        let lock_id = secret_hash(&secret).expect("secret hash");
        let token = TokenId::new(1).expect("token");
        let lock = HtlcLock::restore(
            lock_id.clone(),
            HtlcHashlock::parse(&lock_id).expect("hashlock"),
            BigInt::from(100),
            10,
            BigInt::from(7),
            token,
            Side::Right,
            1,
            2,
            None,
        )
        .expect("lock");
        let mut state = EntityStateSlice::empty(owner.clone(), 3);
        state.known_accounts.insert(peer.clone());
        let views = BTreeMap::from([(
            peer.clone(),
            LocalAccountFinancialView {
                active: true,
                owner_side: Side::Left,
                owner_out_capacity: BTreeMap::new(),
                owner_peer_credit_limit: BTreeMap::new(),
                settlement_workspace: None,
                settlement_transition_pending: false,
                settlement_execution: Err("unused".into()),
                rebalance_active_quote: None,
                htlc_locks: BTreeMap::from([(lock_id.clone(), lock)]),
                pending_htlc_lock_ids: Default::default(),
                pulls: BTreeMap::new(),
                swap_offers: BTreeMap::new(),
                pending_cross_pull_close_ids: Default::default(),
                dispute: None,
            },
        )]);
        let mut changes = PaybookChanges::default();
        let mut account_txs = Vec::new();
        let mut events = Vec::new();
        let mut wakes = Vec::new();
        apply(
            &state,
            &mut changes,
            ResolveHtlcLockEntityTx {
                counterparty_entity_id: peer.clone(),
                lock_id: lock_id.clone(),
                secret: secret.clone(),
                cross_jurisdiction_route_id: Some("route-1".into()),
                description: None,
            },
            &views,
            &mut account_txs,
            &mut events,
            &mut wakes,
        )
        .expect("resolve");
        changes
            .commit_sequential(&mut state)
            .expect("commit paybook");
        let entry = state
            .paybook
            .entry(&lock_id)
            .expect("lookup")
            .expect("entry");
        assert_eq!(entry.secret.as_deref(), Some(secret.as_str()));
        assert_eq!(entry.inbound_entity.as_deref(), Some(peer.as_str()));
        assert!(matches!(
            account_txs.as_slice(),
            [(account, AccountTx::HtlcResolve(HtlcResolveTx { lock_id: queued, .. }))]
                if account == &peer && queued == &lock_id
        ));
        assert_eq!(wakes, vec![owner]);
    }
}

use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;
use xln_rscore_engine::EntityId;

use crate::{
    CrontabState, EntityConsensusSection, EntityKernelError, EntityReferral, EntityStateSlice,
    HtlcRoute, LockBookEntry, OrderbookConsensusMetadata, OrderbookState, OrderbookStateSnapshot,
    compute_entity_owned_sections,
};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityStateSnapshot {
    pub entity_id: String,
    pub height: u64,
    pub timestamp: u64,
    pub entity_command_nonces: Option<crate::EntityCommandNonceState>,
    pub last_finalized_j_height: u64,
    pub reserves: BTreeMap<u16, BigInt>,
    pub known_accounts: BTreeSet<String>,
    pub htlc_routes: BTreeMap<String, HtlcRoute>,
    pub htlc_fees_earned: BigInt,
    pub lock_book: BTreeMap<String, LockBookEntry>,
    pub crontab: Option<CrontabState>,
    pub orderbook: Option<OrderbookStateSnapshot>,
    pub orderbook_metadata: Option<OrderbookConsensusMetadata>,
    pub expected_owned_sections: Vec<EntityConsensusSection>,
}

fn invalid(detail: impl Into<String>) -> EntityKernelError {
    EntityKernelError::SnapshotInvalid {
        detail: detail.into(),
    }
}

fn require_entity(value: &str, field: &str) -> Result<(), EntityKernelError> {
    EntityId::parse(value)
        .map(|_| ())
        .map_err(|_| invalid(format!("{field}:ENTITY_ID")))
}

fn require_hex32(value: &str, field: &str) -> Result<(), EntityKernelError> {
    let Some(payload) = value.strip_prefix("0x") else {
        return Err(invalid(format!("{field}:HEX32")));
    };
    if payload.len() != 64
        || !payload
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid(format!("{field}:HEX32")));
    }
    Ok(())
}

fn validate_routes(
    routes: &BTreeMap<String, HtlcRoute>,
    known_accounts: &BTreeSet<String>,
) -> Result<(), EntityKernelError> {
    for (key, route) in routes {
        if key != &route.hashlock {
            return Err(invalid("HTLC_ROUTE_KEY"));
        }
        require_hex32(&route.hashlock, "HTLC_ROUTE_HASHLOCK")?;
        for entity in [
            route.inbound_entity.as_ref(),
            route.outbound_entity.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            require_entity(entity, "HTLC_ROUTE_ENTITY")?;
            if !known_accounts.contains(entity) {
                return Err(invalid("HTLC_ROUTE_ACCOUNT_UNKNOWN"));
            }
        }
        for lock_id in [
            route.inbound_lock_id.as_ref(),
            route.outbound_lock_id.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            require_hex32(lock_id, "HTLC_ROUTE_LOCK_ID")?;
        }
        if let Some(secret) = route.secret.as_ref() {
            require_hex32(secret, "HTLC_ROUTE_SECRET")?;
        }
        if route
            .amount
            .as_ref()
            .is_some_and(|value| value <= &BigInt::from(0))
            || route
                .pending_fee
                .as_ref()
                .is_some_and(|value| value < &BigInt::from(0))
        {
            return Err(invalid("HTLC_ROUTE_AMOUNT"));
        }
    }
    Ok(())
}

fn validate_locks(
    locks: &BTreeMap<String, LockBookEntry>,
    known_accounts: &BTreeSet<String>,
) -> Result<(), EntityKernelError> {
    for (key, lock) in locks {
        if key != &lock.lock_id {
            return Err(invalid("LOCK_BOOK_KEY"));
        }
        require_hex32(&lock.lock_id, "LOCK_BOOK_LOCK_ID")?;
        require_hex32(&lock.hashlock, "LOCK_BOOK_HASHLOCK")?;
        require_entity(&lock.account_id, "LOCK_BOOK_ACCOUNT")?;
        if !known_accounts.contains(&lock.account_id)
            || lock.amount <= BigInt::from(0)
            || lock.timelock <= BigInt::from(0)
            || lock.created_at < BigInt::from(0)
        {
            return Err(invalid("LOCK_BOOK_VALUE"));
        }
    }
    Ok(())
}

fn validate_reserves(reserves: &BTreeMap<u16, BigInt>) -> Result<(), EntityKernelError> {
    if reserves
        .iter()
        .any(|(token_id, amount)| *token_id == 0 || amount < &BigInt::from(0))
    {
        return Err(invalid("ENTITY_RESERVES"));
    }
    Ok(())
}

fn validate_metadata(
    entity_id: &str,
    metadata: &OrderbookConsensusMetadata,
) -> Result<(), EntityKernelError> {
    let profile = &metadata.hub_profile;
    require_entity(&profile.entity_id, "HUB_PROFILE_ENTITY")?;
    require_entity(
        &profile.usd_quote_authority_entity_id,
        "HUB_PROFILE_USD_AUTHORITY",
    )?;
    let spread = &profile.spread_distribution;
    let total = spread
        .maker_bps
        .checked_add(spread.taker_bps)
        .and_then(|value| value.checked_add(spread.hub_bps))
        .and_then(|value| value.checked_add(spread.maker_referrer_bps))
        .and_then(|value| value.checked_add(spread.taker_referrer_bps))
        .ok_or_else(|| invalid("HUB_PROFILE_SPREAD_OVERFLOW"))?;
    if profile.entity_id != entity_id || total != 10_000 || profile.min_trade_size < BigInt::from(0)
    {
        return Err(invalid("HUB_PROFILE_VALUE"));
    }
    let mut pairs = BTreeSet::new();
    if profile
        .supported_pairs
        .iter()
        .any(|pair| pair.is_empty() || !pairs.insert(pair))
    {
        return Err(invalid("HUB_PROFILE_PAIRS"));
    }
    for (
        key,
        EntityReferral {
            entity_id,
            referrer_id,
            ..
        },
    ) in &metadata.referrals
    {
        if key != entity_id {
            return Err(invalid("ENTITY_REFERRAL_KEY"));
        }
        require_entity(entity_id, "ENTITY_REFERRAL_ENTITY")?;
        if let Some(referrer_id) = referrer_id {
            require_entity(referrer_id, "ENTITY_REFERRAL_REFERRER")?;
        }
    }
    Ok(())
}

pub fn restore_entity_state(
    snapshot: EntityStateSnapshot,
    accounts_root: [u8; 32],
    account_count: usize,
) -> Result<EntityStateSlice, EntityKernelError> {
    require_entity(&snapshot.entity_id, "ENTITY")?;
    if snapshot.height > MAX_SAFE_INTEGER
        || snapshot.timestamp > MAX_SAFE_INTEGER
        || snapshot.last_finalized_j_height > MAX_SAFE_INTEGER
        || snapshot.htlc_fees_earned < BigInt::from(0)
        || snapshot.known_accounts.len() != account_count
    {
        return Err(invalid("ENTITY_SCALAR_OR_ACCOUNT_COUNT"));
    }
    for account_id in &snapshot.known_accounts {
        require_entity(account_id, "KNOWN_ACCOUNT")?;
    }
    validate_reserves(&snapshot.reserves)?;
    validate_routes(&snapshot.htlc_routes, &snapshot.known_accounts)?;
    validate_locks(&snapshot.lock_book, &snapshot.known_accounts)?;
    match (&snapshot.orderbook, &snapshot.orderbook_metadata) {
        (Some(_), Some(metadata)) => validate_metadata(&snapshot.entity_id, metadata)?,
        (None, None) => {}
        _ => return Err(invalid("ENTITY_ORDERBOOK_METADATA_MISMATCH")),
    }
    let state = EntityStateSlice {
        entity_id: snapshot.entity_id,
        height: snapshot.height,
        timestamp: snapshot.timestamp,
        entity_command_nonces: snapshot.entity_command_nonces,
        last_finalized_j_height: snapshot.last_finalized_j_height,
        reserves: snapshot.reserves,
        known_accounts: snapshot.known_accounts,
        htlc_routes: snapshot.htlc_routes,
        htlc_fees_earned: snapshot.htlc_fees_earned,
        lock_book: snapshot.lock_book,
        crontab: snapshot.crontab,
        orderbook: snapshot
            .orderbook
            .map(OrderbookState::restore)
            .transpose()?,
        orderbook_metadata: snapshot.orderbook_metadata,
    };
    let actual = compute_entity_owned_sections(&state, accounts_root, account_count)?;
    if actual != snapshot.expected_owned_sections {
        return Err(invalid("ENTITY_OWNED_SECTIONS_MISMATCH"));
    }
    Ok(state)
}

pub fn capture_entity_state(
    state: &EntityStateSlice,
    accounts_root: [u8; 32],
    account_count: usize,
) -> Result<EntityStateSnapshot, EntityKernelError> {
    Ok(EntityStateSnapshot {
        entity_id: state.entity_id.clone(),
        height: state.height,
        timestamp: state.timestamp,
        entity_command_nonces: state.entity_command_nonces.clone(),
        last_finalized_j_height: state.last_finalized_j_height,
        reserves: state.reserves.clone(),
        known_accounts: state.known_accounts.clone(),
        htlc_routes: state.htlc_routes.clone(),
        htlc_fees_earned: state.htlc_fees_earned.clone(),
        lock_book: state.lock_book.clone(),
        crontab: state.crontab.clone(),
        orderbook: state
            .orderbook
            .as_ref()
            .map(OrderbookState::snapshot)
            .transpose()?,
        orderbook_metadata: state.orderbook_metadata.clone(),
        expected_owned_sections: compute_entity_owned_sections(
            state,
            accounts_root,
            account_count,
        )?,
    })
}

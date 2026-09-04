use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;
use xln_rscore_engine::EntityId;
use xln_rscore_protocol::CanonicalValue;

use crate::{
    CrontabState, EntityCanonicalCollection, EntityConsensusSection, EntityKernelError,
    EntityProfile, EntityReferral, EntityStateSlice, OrderbookConsensusMetadata, OrderbookState,
    OrderbookStateSnapshot, PaybookState, compute_entity_owned_sections,
};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityStateSnapshot {
    pub entity_id: String,
    pub height: u64,
    pub timestamp: u64,
    pub entity_command_nonces: Option<crate::EntityCommandNonceState>,
    pub proposals: crate::EntityProposals,
    pub last_finalized_j_height: u64,
    pub reserves: BTreeMap<u16, BigInt>,
    pub out_debts_by_token: Option<crate::DebtLedger>,
    pub in_debts_by_token: Option<crate::DebtLedger>,
    pub external_wallet: Option<crate::ExternalWalletState>,
    pub deferred_account_proposals: Option<EntityCanonicalCollection>,
    pub settlement_continuations: Option<EntityCanonicalCollection>,
    pub entity_encryption_public_key: [u8; 32],
    pub profile: EntityProfile,
    pub j_batch_state: Option<crate::JBatchState>,
    pub entity_provider_action_state: Option<crate::EntityProviderActionState>,
    pub certified_board_state: Option<crate::CertifiedBoardState>,
    pub known_accounts: BTreeSet<String>,
    pub paybook: PaybookState,
    pub crontab: Option<CrontabState>,
    pub hub_rebalance_config: Option<CanonicalValue>,
    pub orderbook: Option<OrderbookStateSnapshot>,
    pub orderbook_metadata: Option<OrderbookConsensusMetadata>,
    pub swap_trading_pairs: Option<Vec<crate::EntitySwapPair>>,
    pub lending: Option<crate::LendingState>,
    pub cross_jurisdiction_swaps: Option<EntityCanonicalCollection>,
    pub cross_jurisdiction_authorizations: Option<EntityCanonicalCollection>,
    pub cross_jurisdiction_book_admissions: Option<EntityCanonicalCollection>,
    pub j_history_finality: Option<CanonicalValue>,
    pub expected_owned_sections: Vec<EntityConsensusSection>,
}

impl EntityStateSnapshot {
    /// Hydrate only the RAM matcher authorization index from the canonical
    /// resident Account heads. These rows are deliberately absent from the
    /// Entity wire/checkpoint because Account state and Book pages already own
    /// them durably.
    pub fn hydrate_orderbook_accounts(
        &mut self,
        rows: Vec<xln_rscore_batch::ResidentOrderbookAccountSnapshot>,
    ) -> Result<(), EntityKernelError> {
        let Some(orderbook) = self.orderbook.as_mut() else {
            if rows.iter().any(|row| !row.offers.is_empty()) {
                return Err(EntityKernelError::orderbook(
                    "ORDERBOOK_ACCOUNT_OFFERS_WITHOUT_BOOK",
                ));
            }
            return Ok(());
        };
        orderbook.offers.clear();
        orderbook.resolving_offers.clear();
        for row in rows {
            let account_id = format!("0x{}", row.account_id);
            for offer in row.offers {
                let offer_id = offer.offer_id.clone();
                if orderbook
                    .offers
                    .insert(
                        (account_id.clone(), offer_id),
                        crate::SameJOffer::from(offer),
                    )
                    .is_some()
                {
                    return Err(EntityKernelError::orderbook(
                        "ORDERBOOK_ACCOUNT_OFFER_DUPLICATE",
                    ));
                }
            }
            for offer_id in row.resolving_offer_ids {
                let key = (account_id.clone(), offer_id);
                if !orderbook.offers.contains_key(&key) {
                    return Err(EntityKernelError::orderbook(
                        "ORDERBOOK_RESOLVING_OFFER_MISSING",
                    ));
                }
                orderbook.resolving_offers.insert(key);
            }
        }
        Ok(())
    }
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

fn collection_text_key(key: &[u8], field: &str) -> Result<String, EntityKernelError> {
    let length = key
        .get(..2)
        .and_then(|value| <[u8; 2]>::try_from(value).ok())
        .map(u16::from_be_bytes)
        .map(usize::from)
        .ok_or_else(|| invalid(format!("{field}:KEY_PREFIX")))?;
    let payload = key
        .get(2..)
        .filter(|value| value.len() == length)
        .ok_or_else(|| invalid(format!("{field}:KEY_LENGTH")))?;
    String::from_utf8(payload.to_vec()).map_err(|_| invalid(format!("{field}:KEY_UTF8")))
}

fn object_fields<'a>(
    value: &'a CanonicalValue,
    expected: &[&str],
    field: &str,
) -> Result<BTreeMap<&'a str, &'a CanonicalValue>, EntityKernelError> {
    let CanonicalValue::Object(rows) = value else {
        return Err(invalid(format!("{field}:OBJECT")));
    };
    let fields = rows
        .iter()
        .map(|(key, value)| (key.as_str(), value))
        .collect::<BTreeMap<_, _>>();
    let actual = fields.keys().copied().collect::<Vec<_>>();
    let mut expected = expected.to_vec();
    expected.sort_unstable();
    if actual != expected || fields.len() != rows.len() {
        return Err(invalid(format!("{field}:FIELDS")));
    }
    Ok(fields)
}

fn validate_settlement_action(value: &CanonicalValue) -> Result<(), EntityKernelError> {
    let CanonicalValue::Object(rows) = value else {
        return Err(invalid("SETTLEMENT_CONTINUATION_ACTION:OBJECT"));
    };
    let action_type = rows
        .iter()
        .find(|(key, _)| key == "type")
        .and_then(|(_, value)| match value {
            CanonicalValue::String(value) => Some(value.as_str()),
            _ => None,
        })
        .ok_or_else(|| invalid("SETTLEMENT_CONTINUATION_ACTION:TYPE"))?;
    let expected = match action_type {
        "r2r" => vec!["amount", "toEntityId", "tokenId", "type"],
        "r2e" => vec!["amount", "receivingEntity", "tokenId", "type"],
        "r2c" if rows.iter().any(|(key, _)| key == "receivingEntityId") => vec![
            "amount",
            "counterpartyId",
            "receivingEntityId",
            "tokenId",
            "type",
        ],
        "r2c" => vec!["amount", "counterpartyId", "tokenId", "type"],
        _ => return Err(invalid("SETTLEMENT_CONTINUATION_ACTION:TYPE")),
    };
    let fields = object_fields(value, &expected, "SETTLEMENT_CONTINUATION_ACTION")?;
    let CanonicalValue::Number(token_id) = fields["tokenId"] else {
        return Err(invalid("SETTLEMENT_CONTINUATION_ACTION:TOKEN"));
    };
    token_id
        .as_str()
        .parse::<u64>()
        .ok()
        .filter(|value| *value <= xln_rscore_protocol::JS_MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid("SETTLEMENT_CONTINUATION_ACTION:TOKEN"))?;
    if !matches!(fields["amount"], CanonicalValue::BigInt(value) if value > &BigInt::from(0)) {
        return Err(invalid("SETTLEMENT_CONTINUATION_ACTION:AMOUNT"));
    }
    for key in match action_type {
        "r2r" => vec!["toEntityId"],
        "r2e" => vec!["receivingEntity"],
        "r2c" if fields.contains_key("receivingEntityId") => {
            vec!["counterpartyId", "receivingEntityId"]
        }
        "r2c" => vec!["counterpartyId"],
        _ => unreachable!(),
    } {
        let CanonicalValue::String(entity) = fields[key] else {
            return Err(invalid("SETTLEMENT_CONTINUATION_ACTION:ENTITY"));
        };
        require_entity(entity, "SETTLEMENT_CONTINUATION_ACTION_ENTITY")?;
    }
    Ok(())
}

fn validate_settlement_collections(
    deferred: Option<&EntityCanonicalCollection>,
    continuations: Option<&EntityCanonicalCollection>,
    known_accounts: &BTreeSet<String>,
) -> Result<(), EntityKernelError> {
    for (key, value) in deferred
        .into_iter()
        .flat_map(EntityCanonicalCollection::keyed_values)
    {
        let account_id = collection_text_key(key, "DEFERRED_ACCOUNT_PROPOSALS")?;
        require_entity(&account_id, "DEFERRED_ACCOUNT_PROPOSALS_ACCOUNT")?;
        if !known_accounts.contains(&account_id) {
            return Err(invalid("DEFERRED_ACCOUNT_PROPOSALS:ACCOUNT_MISSING"));
        }
        let CanonicalValue::String(workspace_hash) = value else {
            return Err(invalid("DEFERRED_ACCOUNT_PROPOSALS:WORKSPACE_HASH"));
        };
        require_hex32(workspace_hash, "DEFERRED_ACCOUNT_PROPOSALS_WORKSPACE_HASH")?;
    }
    for (key, value) in continuations
        .into_iter()
        .flat_map(EntityCanonicalCollection::keyed_values)
    {
        let account_id = collection_text_key(key, "SETTLEMENT_CONTINUATIONS")?;
        require_entity(&account_id, "SETTLEMENT_CONTINUATIONS_ACCOUNT")?;
        if !known_accounts.contains(&account_id) {
            return Err(invalid("SETTLEMENT_CONTINUATIONS:ACCOUNT_MISSING"));
        }
        let fields = object_fields(
            value,
            &["actions", "broadcast", "workspaceHash"],
            "SETTLEMENT_CONTINUATION",
        )?;
        let CanonicalValue::String(workspace_hash) = fields["workspaceHash"] else {
            return Err(invalid("SETTLEMENT_CONTINUATION:WORKSPACE_HASH"));
        };
        require_hex32(workspace_hash, "SETTLEMENT_CONTINUATION_WORKSPACE_HASH")?;
        if !matches!(fields["broadcast"], CanonicalValue::Bool(_)) {
            return Err(invalid("SETTLEMENT_CONTINUATION:BROADCAST"));
        }
        let CanonicalValue::Array(actions) = fields["actions"] else {
            return Err(invalid("SETTLEMENT_CONTINUATION:ACTIONS"));
        };
        if actions.len() > 1 {
            return Err(invalid("SETTLEMENT_CONTINUATION:ACTIONS_LIMIT"));
        }
        for action in actions {
            validate_settlement_action(action)?;
        }
    }
    Ok(())
}

fn validate_paybook(
    paybook: &PaybookState,
    known_accounts: &BTreeSet<String>,
) -> Result<(), EntityKernelError> {
    for (_, entry) in paybook.entries.iter() {
        require_hex32(&entry.hashlock, "PAYBOOK_HASHLOCK")?;
        for entity in [
            entry.inbound_entity.as_ref(),
            entry.outbound_entity.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            require_entity(entity, "PAYBOOK_ENTITY")?;
            if !known_accounts.contains(entity) {
                return Err(invalid("PAYBOOK_ACCOUNT_UNKNOWN"));
            }
        }
        if let Some(secret) = entry.secret.as_ref() {
            require_hex32(secret, "PAYBOOK_SECRET")?;
        }
        if entry
            .amount
            .as_ref()
            .is_some_and(|value| value <= &BigInt::from(0))
            || entry
                .pending_fee
                .as_ref()
                .is_some_and(|value| value < &BigInt::from(0))
        {
            return Err(invalid("PAYBOOK_AMOUNT"));
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

fn validate_lending(
    entity_id: &str,
    lending: &crate::LendingState,
    known_accounts: &BTreeSet<String>,
) -> Result<(), EntityKernelError> {
    for pool in lending.pools() {
        require_entity(&pool.hub_entity_id, "LENDING_POOL_HUB")?;
        require_entity(&pool.lender_entity_id, "LENDING_POOL_LENDER")?;
        if pool.hub_entity_id != entity_id
            || !known_accounts.contains(&pool.lender_entity_id)
            || pool.token_id == 0
            || pool.principal_amount <= BigInt::from(0)
            || pool.available_amount < BigInt::from(0)
            || pool.borrowed_amount < BigInt::from(0)
            || pool.interest_bps > 10_000
            || pool.term_ms == 0
            || pool.created_at > MAX_SAFE_INTEGER
            || pool.updated_at > MAX_SAFE_INTEGER
        {
            return Err(invalid("LENDING_POOL_VALUE"));
        }
    }
    for loan in lending.loans() {
        require_entity(&loan.hub_entity_id, "LENDING_LOAN_HUB")?;
        require_entity(&loan.borrower_entity_id, "LENDING_LOAN_BORROWER")?;
        require_entity(&loan.lender_entity_id, "LENDING_LOAN_LENDER")?;
        let pool = lending
            .pool(&loan.position_id)
            .ok_or_else(|| invalid("LENDING_LOAN_POOL_MISSING"))?;
        if loan.hub_entity_id != entity_id
            || !known_accounts.contains(&loan.borrower_entity_id)
            || loan.lender_entity_id != pool.lender_entity_id
            || loan.token_id != pool.token_id
            || loan.principal_amount <= BigInt::from(0)
            || loan.interest_amount < BigInt::from(0)
            || loan.repayment_amount != loan.principal_amount.clone() + &loan.interest_amount
            || loan.repaid_amount < BigInt::from(0)
            || loan.repaid_amount > loan.repayment_amount
            || loan.interest_bps > 10_000
            || loan.term_ms == 0
            || loan.opened_at > MAX_SAFE_INTEGER
            || loan.due_at > MAX_SAFE_INTEGER
            || loan.updated_at > MAX_SAFE_INTEGER
        {
            return Err(invalid("LENDING_LOAN_VALUE"));
        }
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

fn validate_swap_trading_pairs(pairs: &[crate::EntitySwapPair]) -> Result<(), EntityKernelError> {
    let mut pair_ids = BTreeSet::new();
    let mut assets = BTreeSet::new();
    for pair in pairs {
        if pair.base_token_id == 0
            || pair.quote_token_id == 0
            || pair.base_token_id == pair.quote_token_id
            || pair.pair_id.is_empty()
            || !pair_ids.insert(pair.pair_id.as_str())
            || !assets.insert((pair.base_token_id, pair.quote_token_id))
        {
            return Err(invalid("ENTITY_SWAP_TRADING_PAIRS_INVALID"));
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
        || snapshot.paybook.fees_earned < BigInt::from(0)
        || snapshot.known_accounts.len() != account_count
    {
        return Err(invalid("ENTITY_SCALAR_OR_ACCOUNT_COUNT"));
    }
    for account_id in &snapshot.known_accounts {
        require_entity(account_id, "KNOWN_ACCOUNT")?;
    }
    validate_settlement_collections(
        snapshot.deferred_account_proposals.as_ref(),
        snapshot.settlement_continuations.as_ref(),
        &snapshot.known_accounts,
    )?;
    validate_reserves(&snapshot.reserves)?;
    if snapshot.out_debts_by_token.as_ref().is_some_and(|ledger| {
        ledger
            .iter()
            .any(|entry| entry.direction != crate::DebtDirection::Out)
    }) || snapshot.in_debts_by_token.as_ref().is_some_and(|ledger| {
        ledger
            .iter()
            .any(|entry| entry.direction != crate::DebtDirection::In)
    }) {
        return Err(invalid("ENTITY_DEBT_LEDGER_DIRECTION"));
    }
    validate_paybook(&snapshot.paybook, &snapshot.known_accounts)?;
    if let Some(lending) = &snapshot.lending {
        validate_lending(&snapshot.entity_id, lending, &snapshot.known_accounts)?;
    }
    if let Some(pairs) = &snapshot.swap_trading_pairs {
        validate_swap_trading_pairs(pairs)?;
    }
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
        proposals: snapshot.proposals,
        last_finalized_j_height: snapshot.last_finalized_j_height,
        reserves: snapshot.reserves,
        out_debts_by_token: snapshot.out_debts_by_token,
        in_debts_by_token: snapshot.in_debts_by_token,
        external_wallet: snapshot.external_wallet,
        deferred_account_proposals: snapshot.deferred_account_proposals,
        settlement_continuations: snapshot.settlement_continuations,
        entity_encryption_public_key: snapshot.entity_encryption_public_key,
        profile: snapshot.profile,
        j_batch_state: snapshot.j_batch_state,
        entity_provider_action_state: snapshot.entity_provider_action_state,
        certified_board_state: snapshot.certified_board_state,
        known_accounts: snapshot.known_accounts.into(),
        paybook: snapshot.paybook,
        crontab: snapshot.crontab,
        hub_rebalance_config: snapshot.hub_rebalance_config,
        orderbook: snapshot
            .orderbook
            .map(OrderbookState::restore)
            .transpose()?,
        orderbook_metadata: snapshot.orderbook_metadata,
        swap_trading_pairs: snapshot.swap_trading_pairs,
        lending: snapshot.lending,
        cross_jurisdiction_swaps: snapshot.cross_jurisdiction_swaps,
        cross_jurisdiction_authorizations: snapshot.cross_jurisdiction_authorizations,
        cross_jurisdiction_book_admissions: snapshot.cross_jurisdiction_book_admissions,
        j_history_finality: snapshot.j_history_finality,
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
        proposals: state.proposals.clone(),
        last_finalized_j_height: state.last_finalized_j_height,
        reserves: state.reserves.clone(),
        out_debts_by_token: state.out_debts_by_token.clone(),
        in_debts_by_token: state.in_debts_by_token.clone(),
        external_wallet: state.external_wallet.clone(),
        deferred_account_proposals: state.deferred_account_proposals.clone(),
        settlement_continuations: state.settlement_continuations.clone(),
        entity_encryption_public_key: state.entity_encryption_public_key,
        profile: state.profile.clone(),
        j_batch_state: state.j_batch_state.clone(),
        entity_provider_action_state: state.entity_provider_action_state.clone(),
        certified_board_state: state.certified_board_state.clone(),
        known_accounts: state.known_accounts.iter().cloned().collect(),
        paybook: state.paybook.clone(),
        crontab: state.crontab.clone(),
        hub_rebalance_config: state.hub_rebalance_config.clone(),
        orderbook: state
            .orderbook
            .as_ref()
            .map(OrderbookState::snapshot)
            .transpose()?,
        orderbook_metadata: state.orderbook_metadata.clone(),
        swap_trading_pairs: state.swap_trading_pairs.clone(),
        lending: state.lending.clone(),
        cross_jurisdiction_swaps: state.cross_jurisdiction_swaps.clone(),
        cross_jurisdiction_authorizations: state.cross_jurisdiction_authorizations.clone(),
        cross_jurisdiction_book_admissions: state.cross_jurisdiction_book_admissions.clone(),
        j_history_finality: state.j_history_finality.clone(),
        expected_owned_sections: compute_entity_owned_sections(
            state,
            accounts_root,
            account_count,
        )?,
    })
}

#[cfg(test)]
mod tests {
    use super::{capture_entity_state, restore_entity_state};
    use crate::{EntityCanonicalCollection, EntityStateSlice};
    use xln_rscore_protocol::CanonicalValue;

    #[test]
    fn entity_encryption_public_key_roundtrips_in_owned_root_and_snapshot() {
        let mut state = EntityStateSlice::empty(format!("0x{}", "11".repeat(32)), 7);
        state.entity_encryption_public_key = [0x44; 32];
        let snapshot = capture_entity_state(&state, [0x55; 32], 0).expect("capture");
        assert_eq!(snapshot.entity_encryption_public_key, [0x44; 32]);
        assert!(
            snapshot
                .expected_owned_sections
                .iter()
                .any(|section| section.field == "entityEncryptionPublicKey")
        );
        let restored = restore_entity_state(snapshot, [0x55; 32], 0).expect("restore");
        assert_eq!(restored.entity_encryption_public_key, [0x44; 32]);
    }

    #[test]
    fn settlement_collections_roundtrip_and_reject_noncanonical_values() {
        let account_id = format!("0x{}", "22".repeat(32));
        let mut state = EntityStateSlice::empty(format!("0x{}", "11".repeat(32)), 7);
        state.known_accounts.insert(account_id.clone());
        state.deferred_account_proposals = Some(
            EntityCanonicalCollection::from_entries([(
                account_id.clone(),
                CanonicalValue::String(format!("0x{}", "33".repeat(32))),
            )])
            .expect("deferred collection"),
        );
        state.settlement_continuations = Some(
            EntityCanonicalCollection::from_entries([(
                account_id.clone(),
                CanonicalValue::Object(vec![
                    ("actions".into(), CanonicalValue::Array(Vec::new())),
                    ("broadcast".into(), CanonicalValue::Bool(true)),
                    (
                        "workspaceHash".into(),
                        CanonicalValue::String(format!("0x{}", "44".repeat(32))),
                    ),
                ]),
            )])
            .expect("continuation collection"),
        );

        let snapshot = capture_entity_state(&state, [0x55; 32], 1).expect("capture");
        let restored = restore_entity_state(snapshot.clone(), [0x55; 32], 1).expect("restore");
        assert_eq!(
            restored.deferred_account_proposals,
            state.deferred_account_proposals
        );
        assert_eq!(
            restored.settlement_continuations,
            state.settlement_continuations
        );

        let mut malformed = snapshot;
        malformed.settlement_continuations = Some(
            EntityCanonicalCollection::from_entries([(
                account_id,
                CanonicalValue::Object(vec![
                    ("actions".into(), CanonicalValue::Array(Vec::new())),
                    ("broadcast".into(), CanonicalValue::String("true".into())),
                    (
                        "workspaceHash".into(),
                        CanonicalValue::String(format!("0x{}", "44".repeat(32))),
                    ),
                ]),
            )])
            .expect("malformed continuation collection"),
        );
        let error = restore_entity_state(malformed, [0x55; 32], 1)
            .expect_err("non-boolean broadcast must fail");
        assert!(format!("{error:?}").contains("SETTLEMENT_CONTINUATION:BROADCAST"));
    }
}

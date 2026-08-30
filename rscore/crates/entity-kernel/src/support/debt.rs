use std::collections::BTreeMap;
use std::fmt;

use num_bigint::BigInt;
use sha2::{Digest as _, Sha256};
use xln_rscore_protocol::{
    CanonicalNumber, CanonicalValue, PersistentRadixMap, encode_canonical_consensus_bytes,
    encode_raw_text_key,
};

use crate::EntityKernelError;
use xln_rscore_engine::{DebtCreatedEvent, DebtEnforcedEvent, DebtForgivenEvent, JEventMetadata};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DebtDirection {
    Out,
    In,
}

impl DebtDirection {
    fn as_str(self) -> &'static str {
        match self {
            Self::Out => "out",
            Self::In => "in",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DebtEventType {
    Created,
    Enforced,
    Forgiven,
}

impl DebtEventType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Created => "DebtCreated",
            Self::Enforced => "DebtEnforced",
            Self::Forgiven => "DebtForgiven",
        }
    }

    fn parse(value: &str) -> Result<Self, EntityKernelError> {
        match value {
            "DebtCreated" => Ok(Self::Created),
            "DebtEnforced" => Ok(Self::Enforced),
            "DebtForgiven" => Ok(Self::Forgiven),
            _ => Err(invalid("LAST_EVENT_TYPE_INVALID")),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DebtEntry {
    pub debt_id: String,
    pub token_id: u64,
    pub debtor: String,
    pub creditor: String,
    pub counterparty: String,
    pub direction: DebtDirection,
    pub created_amount: BigInt,
    pub paid_amount: BigInt,
    pub remaining_amount: BigInt,
    pub created_debt_index: u64,
    pub current_debt_index: u64,
    pub created_at_block: u64,
    pub created_tx_hash: String,
    pub last_updated_block: u64,
    pub last_updated_tx_hash: String,
    pub last_event_type: DebtEventType,
}

#[derive(Clone)]
pub struct DebtLedger {
    entries: PersistentRadixMap<DebtEntry>,
}

impl fmt::Debug for DebtLedger {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_list()
            .entries(self.entries.iter().map(|(_, value)| value))
            .finish()
    }
}

impl PartialEq for DebtLedger {
    fn eq(&self, other: &Self) -> bool {
        self.entries.len() == other.entries.len() && self.entries.iter().eq(other.entries.iter())
    }
}

impl Eq for DebtLedger {}

fn invalid(detail: impl Into<String>) -> EntityKernelError {
    EntityKernelError::CommitmentEncoding {
        detail: format!("DEBT_LEDGER:{}", detail.into()),
    }
}

fn number(field: &str, value: u64) -> Result<CanonicalValue, EntityKernelError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|_| invalid(format!("{field}_UNSAFE:{value}")))
}

fn text(value: impl Into<String>) -> CanonicalValue {
    CanonicalValue::String(value.into())
}

fn key(token_id: u64, debt_id: &str) -> Result<Vec<u8>, EntityKernelError> {
    let encoded_id = encode_raw_text_key(debt_id).map_err(|error| invalid(error.to_string()))?;
    let mut key = Vec::with_capacity(8 + encoded_id.len());
    key.extend_from_slice(&token_id.to_be_bytes());
    key.extend_from_slice(&encoded_id);
    Ok(key)
}

fn validate_entry(entry: &DebtEntry) -> Result<(), EntityKernelError> {
    if entry.debt_id.is_empty()
        || entry.token_id > MAX_SAFE_INTEGER
        || entry.debtor.is_empty()
        || entry.creditor.is_empty()
        || entry.counterparty.is_empty()
        || entry.created_amount <= BigInt::from(0)
        || entry.paid_amount < BigInt::from(0)
        || entry.remaining_amount <= BigInt::from(0)
        || entry.paid_amount.clone() + &entry.remaining_amount != entry.created_amount
        || entry.created_debt_index > MAX_SAFE_INTEGER
        || entry.current_debt_index > MAX_SAFE_INTEGER
        || entry.created_at_block > MAX_SAFE_INTEGER
        || entry.last_updated_block > MAX_SAFE_INTEGER
    {
        return Err(invalid(format!("ENTRY_INVALID:{}", entry.debt_id)));
    }
    Ok(())
}

pub fn canonical_debt_entry(entry: &DebtEntry) -> Result<CanonicalValue, EntityKernelError> {
    validate_entry(entry)?;
    Ok(CanonicalValue::Object(vec![
        ("debtId".into(), text(&entry.debt_id)),
        ("tokenId".into(), number("tokenId", entry.token_id)?),
        ("debtor".into(), text(&entry.debtor)),
        ("creditor".into(), text(&entry.creditor)),
        ("counterparty".into(), text(&entry.counterparty)),
        ("direction".into(), text(entry.direction.as_str())),
        (
            "createdAmount".into(),
            CanonicalValue::BigInt(entry.created_amount.clone()),
        ),
        (
            "paidAmount".into(),
            CanonicalValue::BigInt(entry.paid_amount.clone()),
        ),
        (
            "remainingAmount".into(),
            CanonicalValue::BigInt(entry.remaining_amount.clone()),
        ),
        (
            "createdDebtIndex".into(),
            number("createdDebtIndex", entry.created_debt_index)?,
        ),
        (
            "currentDebtIndex".into(),
            number("currentDebtIndex", entry.current_debt_index)?,
        ),
        ("status".into(), text("open")),
        (
            "createdAtBlock".into(),
            number("createdAtBlock", entry.created_at_block)?,
        ),
        ("createdTxHash".into(), text(&entry.created_tx_hash)),
        (
            "lastUpdatedBlock".into(),
            number("lastUpdatedBlock", entry.last_updated_block)?,
        ),
        (
            "lastUpdatedTxHash".into(),
            text(&entry.last_updated_tx_hash),
        ),
        ("lastEventType".into(), text(entry.last_event_type.as_str())),
    ]))
}

fn digest(value: &CanonicalValue) -> Result<[u8; 32], EntityKernelError> {
    let encoded = encode_canonical_consensus_bytes(value)
        .map_err(|error| invalid(format!("ENCODING:{error}")))?;
    Ok(Sha256::digest(encoded).into())
}

impl DebtLedger {
    pub fn empty() -> Self {
        Self {
            entries: PersistentRadixMap::empty(),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, token_id: u64, debt_id: &str) -> Option<&DebtEntry> {
        key(token_id, debt_id)
            .ok()
            .and_then(|key| self.entries.get(&key))
    }

    pub fn insert(&mut self, entry: DebtEntry) -> Result<Option<DebtEntry>, EntityKernelError> {
        let key = key(entry.token_id, &entry.debt_id)?;
        let prior = self.entries.get(&key).cloned();
        let value = canonical_debt_entry(&entry)?;
        self.entries = self
            .entries
            .updated(key, entry, digest(&value)?)
            .map_err(|error| invalid(error.to_string()))?;
        Ok(prior)
    }

    pub fn remove(
        &mut self,
        token_id: u64,
        debt_id: &str,
    ) -> Result<Option<DebtEntry>, EntityKernelError> {
        let key = key(token_id, debt_id)?;
        let prior = self.entries.get(&key).cloned();
        self.entries = self
            .entries
            .removed(&key)
            .map_err(|error| invalid(error.to_string()))?;
        Ok(prior)
    }

    pub fn open_total(&self, token_id: u64) -> BigInt {
        self.entries
            .iter_prefix(&token_id.to_be_bytes())
            .map(|(_, entry)| entry.remaining_amount.clone())
            .sum()
    }

    pub fn iter(&self) -> impl Iterator<Item = &DebtEntry> {
        self.entries.iter().map(|(_, value)| value)
    }

    pub fn from_entries(
        entries: impl IntoIterator<Item = DebtEntry>,
    ) -> Result<Self, EntityKernelError> {
        let mut ledger = Self::empty();
        for entry in entries {
            let debt_id = entry.debt_id.clone();
            if ledger.insert(entry)?.is_some() {
                return Err(invalid(format!("DUPLICATE:{debt_id}")));
            }
        }
        Ok(ledger)
    }
}

fn event_location(metadata: &JEventMetadata) -> (u64, String) {
    let block = metadata.block_number.unwrap_or(0);
    let transaction = metadata
        .transaction_hash
        .map(|hash| {
            const DIGITS: &[u8; 16] = b"0123456789abcdef";
            let mut output = String::with_capacity(66);
            output.push_str("0x");
            for byte in hash {
                output.push(DIGITS[usize::from(byte >> 4)] as char);
                output.push(DIGITS[usize::from(byte & 0x0f)] as char);
            }
            output
        })
        .unwrap_or_default();
    (block, transaction)
}

fn normalized(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn checked_nonnegative(value: i64, field: &str) -> Result<u64, EntityKernelError> {
    u64::try_from(value).map_err(|_| invalid(format!("{field}_INVALID:{value}")))
}

fn direction(owner: &str, debtor: &str, creditor: &str) -> Option<(DebtDirection, String)> {
    let owner = normalized(owner);
    let debtor = normalized(debtor);
    let creditor = normalized(creditor);
    if owner == debtor {
        Some((DebtDirection::Out, creditor))
    } else if owner == creditor {
        Some((DebtDirection::In, debtor))
    } else {
        None
    }
}

fn ledger_mut(state: &mut crate::EntityStateSlice, direction: DebtDirection) -> &mut DebtLedger {
    match direction {
        DebtDirection::Out => state
            .out_debts_by_token
            .get_or_insert_with(DebtLedger::empty),
        DebtDirection::In => state
            .in_debts_by_token
            .get_or_insert_with(DebtLedger::empty),
    }
}

fn prune_empty(state: &mut crate::EntityStateSlice, direction: DebtDirection) {
    match direction {
        DebtDirection::Out
            if state
                .out_debts_by_token
                .as_ref()
                .is_some_and(DebtLedger::is_empty) =>
        {
            state.out_debts_by_token = None;
        }
        DebtDirection::In
            if state
                .in_debts_by_token
                .as_ref()
                .is_some_and(DebtLedger::is_empty) =>
        {
            state.in_debts_by_token = None;
        }
        _ => {}
    }
}

fn earliest(
    ledger: &DebtLedger,
    token_id: u64,
    debtor: &str,
    creditor: &str,
    preferred_index: Option<u64>,
) -> Option<DebtEntry> {
    let debtor = normalized(debtor);
    let creditor = normalized(creditor);
    let mut entries = ledger
        .iter()
        .filter(|entry| {
            entry.token_id == token_id
                && normalized(&entry.debtor) == debtor
                && normalized(&entry.creditor) == creditor
                && preferred_index.is_none_or(|index| entry.current_debt_index == index)
        })
        .cloned()
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        left.created_debt_index
            .cmp(&right.created_debt_index)
            .then_with(|| left.created_at_block.cmp(&right.created_at_block))
            .then_with(|| left.debt_id.cmp(&right.debt_id))
    });
    entries.into_iter().next()
}

pub(crate) fn apply_created(
    state: &mut crate::EntityStateSlice,
    event: &DebtCreatedEvent,
) -> Result<(), EntityKernelError> {
    let Some((direction, counterparty)) =
        direction(&state.entity_id, &event.debtor, &event.creditor)
    else {
        return Ok(());
    };
    let token_id = checked_nonnegative(event.token_id, "CREATED_TOKEN")?;
    let debt_index = checked_nonnegative(event.debt_index, "CREATED_INDEX")?;
    if event.amount <= BigInt::from(0) {
        return Err(invalid("CREATED_AMOUNT_INVALID"));
    }
    let (block, transaction) = event_location(&event.metadata);
    let debtor = normalized(&event.debtor);
    let creditor = normalized(&event.creditor);
    let debt_id = format!("{debtor}:{token_id}:{debt_index}:{block}:{transaction}");
    let entry = DebtEntry {
        debt_id: debt_id.clone(),
        token_id,
        debtor,
        creditor,
        counterparty,
        direction,
        created_amount: event.amount.clone(),
        paid_amount: BigInt::from(0),
        remaining_amount: event.amount.clone(),
        created_debt_index: debt_index,
        current_debt_index: debt_index,
        created_at_block: block,
        created_tx_hash: transaction.clone(),
        last_updated_block: block,
        last_updated_tx_hash: transaction,
        last_event_type: DebtEventType::Created,
    };
    let ledger = ledger_mut(state, direction);
    if let Some(existing) = ledger.get(token_id, &debt_id) {
        if existing == &entry {
            return Ok(());
        }
        return Err(invalid(format!("CREATED_ID_CONFLICT:{debt_id}")));
    }
    ledger.insert(entry)?;
    Ok(())
}

pub(crate) fn apply_enforced(
    state: &mut crate::EntityStateSlice,
    event: &DebtEnforcedEvent,
) -> Result<(), EntityKernelError> {
    let Some((direction, _)) = direction(&state.entity_id, &event.debtor, &event.creditor) else {
        return Ok(());
    };
    let token_id = checked_nonnegative(event.token_id, "ENFORCED_TOKEN")?;
    let new_index = checked_nonnegative(event.new_debt_index, "ENFORCED_INDEX")?;
    let ledger = match direction {
        DebtDirection::Out => state.out_debts_by_token.as_mut(),
        DebtDirection::In => state.in_debts_by_token.as_mut(),
    }
    .ok_or_else(|| invalid("ENFORCED_MISSING_OPEN_DEBT"))?;
    let mut entry = earliest(ledger, token_id, &event.debtor, &event.creditor, None)
        .ok_or_else(|| invalid("ENFORCED_MISSING_OPEN_DEBT"))?;
    if event.amount_paid <= BigInt::from(0)
        || event.remaining_amount < BigInt::from(0)
        || &event.amount_paid + &event.remaining_amount != entry.remaining_amount
    {
        return Err(invalid(format!(
            "ENFORCED_AMOUNT_MISMATCH:{}",
            entry.debt_id
        )));
    }
    let expected_index = if event.remaining_amount == BigInt::from(0) {
        entry
            .current_debt_index
            .checked_add(1)
            .ok_or_else(|| invalid("ENFORCED_INDEX_OVERFLOW"))?
    } else {
        entry.current_debt_index
    };
    if new_index != expected_index {
        return Err(invalid(format!(
            "ENFORCED_INDEX_MISMATCH:{expected_index}:{new_index}"
        )));
    }
    if event.remaining_amount == BigInt::from(0) {
        ledger.remove(token_id, &entry.debt_id)?;
        prune_empty(state, direction);
        return Ok(());
    }
    let (block, transaction) = event_location(&event.metadata);
    entry.paid_amount += &event.amount_paid;
    entry.remaining_amount = event.remaining_amount.clone();
    entry.current_debt_index = new_index;
    entry.last_updated_block = block;
    entry.last_updated_tx_hash = transaction;
    entry.last_event_type = DebtEventType::Enforced;
    ledger.insert(entry)?;
    Ok(())
}

pub(crate) fn apply_forgiven(
    state: &mut crate::EntityStateSlice,
    event: &DebtForgivenEvent,
) -> Result<(), EntityKernelError> {
    let Some((direction, _)) = direction(&state.entity_id, &event.debtor, &event.creditor) else {
        return Ok(());
    };
    let token_id = checked_nonnegative(event.token_id, "FORGIVEN_TOKEN")?;
    let debt_index = checked_nonnegative(event.debt_index, "FORGIVEN_INDEX")?;
    let ledger = match direction {
        DebtDirection::Out => state.out_debts_by_token.as_mut(),
        DebtDirection::In => state.in_debts_by_token.as_mut(),
    }
    .ok_or_else(|| invalid("FORGIVEN_MISSING_OPEN_DEBT"))?;
    let entry = earliest(
        ledger,
        token_id,
        &event.debtor,
        &event.creditor,
        Some(debt_index),
    )
    .ok_or_else(|| invalid("FORGIVEN_MISSING_OPEN_DEBT"))?;
    if event.amount_forgiven != entry.remaining_amount {
        return Err(invalid(format!(
            "FORGIVEN_AMOUNT_MISMATCH:{}",
            entry.debt_id
        )));
    }
    ledger.remove(token_id, &entry.debt_id)?;
    prune_empty(state, direction);
    Ok(())
}

pub fn canonical_debt_ledger(ledger: &DebtLedger) -> Result<CanonicalValue, EntityKernelError> {
    let mut tokens = BTreeMap::<u64, Vec<&DebtEntry>>::new();
    for entry in ledger.iter() {
        tokens.entry(entry.token_id).or_default().push(entry);
    }
    Ok(CanonicalValue::Map(
        tokens
            .into_iter()
            .map(|(token_id, mut entries)| {
                entries.sort_by(|left, right| left.debt_id.cmp(&right.debt_id));
                Ok((
                    number("tokenId", token_id)?,
                    CanonicalValue::Map(
                        entries
                            .into_iter()
                            .map(|entry| Ok((text(&entry.debt_id), canonical_debt_entry(entry)?)))
                            .collect::<Result<Vec<_>, EntityKernelError>>()?,
                    ),
                ))
            })
            .collect::<Result<Vec<_>, EntityKernelError>>()?,
    ))
}

fn object<'a>(
    value: &'a CanonicalValue,
    path: &str,
) -> Result<&'a [(String, CanonicalValue)], EntityKernelError> {
    match value {
        CanonicalValue::Object(fields) => Ok(fields),
        _ => Err(invalid(format!("OBJECT:{path}"))),
    }
}

fn field<'a>(
    fields: &'a [(String, CanonicalValue)],
    name: &str,
) -> Result<&'a CanonicalValue, EntityKernelError> {
    fields
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
        .ok_or_else(|| invalid(format!("FIELD_MISSING:{name}")))
}

fn string(value: &CanonicalValue, path: &str) -> Result<String, EntityKernelError> {
    match value {
        CanonicalValue::String(value) => Ok(value.clone()),
        _ => Err(invalid(format!("TEXT:{path}"))),
    }
}

fn uint(value: &CanonicalValue, path: &str) -> Result<u64, EntityKernelError> {
    match value {
        CanonicalValue::Number(value) => value
            .as_str()
            .parse::<u64>()
            .ok()
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| invalid(format!("UNSIGNED:{path}"))),
        _ => Err(invalid(format!("UNSIGNED:{path}"))),
    }
}

fn bigint(value: &CanonicalValue, path: &str) -> Result<BigInt, EntityKernelError> {
    match value {
        CanonicalValue::BigInt(value) => Ok(value.clone()),
        _ => Err(invalid(format!("BIGINT:{path}"))),
    }
}

pub fn decode_canonical_debt_entry(value: &CanonicalValue) -> Result<DebtEntry, EntityKernelError> {
    let fields = object(value, "entry")?;
    const NAMES: &[&str] = &[
        "debtId",
        "tokenId",
        "debtor",
        "creditor",
        "counterparty",
        "direction",
        "createdAmount",
        "paidAmount",
        "remainingAmount",
        "createdDebtIndex",
        "currentDebtIndex",
        "status",
        "createdAtBlock",
        "createdTxHash",
        "lastUpdatedBlock",
        "lastUpdatedTxHash",
        "lastEventType",
    ];
    if fields.len() != NAMES.len()
        || fields
            .iter()
            .any(|(name, _)| !NAMES.contains(&name.as_str()))
    {
        return Err(invalid("ENTRY_FIELDS_INVALID"));
    }
    let direction = match string(field(fields, "direction")?, "direction")?.as_str() {
        "out" => DebtDirection::Out,
        "in" => DebtDirection::In,
        _ => return Err(invalid("DIRECTION_INVALID")),
    };
    if string(field(fields, "status")?, "status")? != "open" {
        return Err(invalid("STATUS_INVALID"));
    }
    let last_event = string(field(fields, "lastEventType")?, "lastEventType")?;
    let entry = DebtEntry {
        debt_id: string(field(fields, "debtId")?, "debtId")?,
        token_id: uint(field(fields, "tokenId")?, "tokenId")?,
        debtor: string(field(fields, "debtor")?, "debtor")?,
        creditor: string(field(fields, "creditor")?, "creditor")?,
        counterparty: string(field(fields, "counterparty")?, "counterparty")?,
        direction,
        created_amount: bigint(field(fields, "createdAmount")?, "createdAmount")?,
        paid_amount: bigint(field(fields, "paidAmount")?, "paidAmount")?,
        remaining_amount: bigint(field(fields, "remainingAmount")?, "remainingAmount")?,
        created_debt_index: uint(field(fields, "createdDebtIndex")?, "createdDebtIndex")?,
        current_debt_index: uint(field(fields, "currentDebtIndex")?, "currentDebtIndex")?,
        created_at_block: uint(field(fields, "createdAtBlock")?, "createdAtBlock")?,
        created_tx_hash: string(field(fields, "createdTxHash")?, "createdTxHash")?,
        last_updated_block: uint(field(fields, "lastUpdatedBlock")?, "lastUpdatedBlock")?,
        last_updated_tx_hash: string(field(fields, "lastUpdatedTxHash")?, "lastUpdatedTxHash")?,
        last_event_type: DebtEventType::parse(&last_event)?,
    };
    validate_entry(&entry)?;
    Ok(entry)
}

pub fn decode_canonical_debt_ledger(
    value: &CanonicalValue,
) -> Result<DebtLedger, EntityKernelError> {
    let CanonicalValue::Map(tokens) = value else {
        return Err(invalid("LEDGER_MAP_REQUIRED"));
    };
    let mut entries = Vec::new();
    for (token_key, bucket) in tokens {
        let token_id = uint(token_key, "tokenKey")?;
        let CanonicalValue::Map(bucket) = bucket else {
            return Err(invalid("BUCKET_MAP_REQUIRED"));
        };
        for (debt_key, value) in bucket {
            let debt_id = string(debt_key, "debtKey")?;
            let entry = decode_canonical_debt_entry(value)?;
            if entry.token_id != token_id || entry.debt_id != debt_id {
                return Err(invalid(format!("KEY_MISMATCH:{token_id}:{debt_id}")));
            }
            entries.push(entry);
        }
    }
    DebtLedger::from_entries(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEBTOR: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const CREDITOR: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";

    fn entry(token_id: u64, debt_id: &str, remaining: i64) -> DebtEntry {
        DebtEntry {
            debt_id: debt_id.into(),
            token_id,
            debtor: "0x01".into(),
            creditor: "0x02".into(),
            counterparty: "0x02".into(),
            direction: DebtDirection::Out,
            created_amount: BigInt::from(10),
            paid_amount: BigInt::from(10 - remaining),
            remaining_amount: BigInt::from(remaining),
            created_debt_index: 1,
            current_debt_index: 1,
            created_at_block: 2,
            created_tx_hash: "0xaa".into(),
            last_updated_block: 2,
            last_updated_tx_hash: "0xaa".into(),
            last_event_type: DebtEventType::Created,
        }
    }

    #[test]
    fn token_prefix_total_does_not_scan_other_tokens() {
        let ledger =
            DebtLedger::from_entries([entry(1, "a", 7), entry(1, "b", 3), entry(2, "c", 9)])
                .unwrap();
        assert_eq!(ledger.open_total(1), BigInt::from(10));
        assert_eq!(ledger.open_total(2), BigInt::from(9));
        assert_eq!(ledger.open_total(3), BigInt::from(0));
    }

    #[test]
    fn j_debt_lifecycle_matches_one_open_radix_entry() {
        let metadata = JEventMetadata {
            block_number: Some(7),
            transaction_hash: Some([0xaa; 32]),
            ..JEventMetadata::default()
        };
        let mut state = crate::EntityStateSlice::empty(DEBTOR, 1);
        apply_created(
            &mut state,
            &DebtCreatedEvent {
                metadata: metadata.clone(),
                debtor: DEBTOR.into(),
                creditor: CREDITOR.into(),
                token_id: 3,
                amount: BigInt::from(10),
                debt_index: 4,
            },
        )
        .expect("created");
        assert_eq!(
            state.out_debts_by_token.as_ref().unwrap().open_total(3),
            BigInt::from(10)
        );
        apply_enforced(
            &mut state,
            &DebtEnforcedEvent {
                metadata: metadata.clone(),
                debtor: DEBTOR.into(),
                creditor: CREDITOR.into(),
                token_id: 3,
                amount_paid: BigInt::from(4),
                remaining_amount: BigInt::from(6),
                new_debt_index: 4,
            },
        )
        .expect("partial enforcement");
        assert_eq!(
            state.out_debts_by_token.as_ref().unwrap().open_total(3),
            BigInt::from(6)
        );
        apply_forgiven(
            &mut state,
            &DebtForgivenEvent {
                metadata,
                debtor: DEBTOR.into(),
                creditor: CREDITOR.into(),
                token_id: 3,
                amount_forgiven: BigInt::from(6),
                debt_index: 4,
            },
        )
        .expect("forgiven");
        assert!(state.out_debts_by_token.is_none());
    }
}

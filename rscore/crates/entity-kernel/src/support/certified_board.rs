use num_bigint::{BigInt, Sign};
use sha2::{Digest as _, Sha256};
use sha3::Keccak256;
use xln_rscore_engine::JurisdictionEvent;
use xln_rscore_protocol::{
    CanonicalNumber, CanonicalValue, PersistentRadixMap, encode_canonical_consensus_bytes,
};

use crate::EntityKernelError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CertifiedBoardSource {
    FoundationBootstrapped,
    EntityRegistered,
    BoardActivated,
}

impl CertifiedBoardSource {
    fn text(self) -> &'static str {
        match self {
            Self::FoundationBootstrapped => "FoundationBootstrapped",
            Self::EntityRegistered => "EntityRegistered",
            Self::BoardActivated => "BoardActivated",
        }
    }

    fn code(self) -> u64 {
        match self {
            Self::FoundationBootstrapped => 1,
            Self::EntityRegistered => 2,
            Self::BoardActivated => 3,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CertifiedBoardRecord {
    pub stack_key: [u8; 32],
    pub entity_id: [u8; 32],
    pub board_hash: [u8; 32],
    pub board_epoch: u64,
    pub previous_board_hash: [u8; 32],
    pub previous_board_valid_until: u64,
    pub activated_at_j_height: u64,
    pub log_index: u32,
    pub block_hash: [u8; 32],
    pub transaction_hash: [u8; 32],
    pub source: CertifiedBoardSource,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CertifiedBoardStoragePath {
    Branch { bit: u16, prefix: [u8; 32] },
    Leaf([u8; 32]),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CertifiedBoardStorageNode {
    pub path: CertifiedBoardStoragePath,
    pub hash: [u8; 32],
    pub node: CanonicalValue,
}

#[derive(Clone)]
pub struct CertifiedBoardState {
    pub stack_key: [u8; 32],
    pub board_registry_root: [u8; 32],
    pub finalized_j_height: u64,
    pub finalized_j_block_hash: [u8; 32],
    pub event_history_root: [u8; 32],
    records: PersistentRadixMap<CertifiedBoardRecord>,
}

impl std::fmt::Debug for CertifiedBoardState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CertifiedBoardState")
            .field("stack_key", &self.stack_key)
            .field("board_registry_root", &self.board_registry_root)
            .field("finalized_j_height", &self.finalized_j_height)
            .field("records", &self.records.len())
            .finish()
    }
}

impl PartialEq for CertifiedBoardState {
    fn eq(&self, other: &Self) -> bool {
        self.stack_key == other.stack_key
            && self.board_registry_root == other.board_registry_root
            && self.finalized_j_height == other.finalized_j_height
            && self.finalized_j_block_hash == other.finalized_j_block_hash
            && self.event_history_root == other.event_history_root
            && self.records.iter().eq(other.records.iter())
    }
}

impl Eq for CertifiedBoardState {}

fn invalid(detail: impl Into<String>) -> EntityKernelError {
    EntityKernelError::CommitmentEncoding {
        detail: format!("CERTIFIED_BOARD:{}", detail.into()),
    }
}

fn canonical_address(value: &CanonicalValue, field: &str) -> Result<[u8; 20], EntityKernelError> {
    let CanonicalValue::String(value) = value else {
        return Err(invalid(format!("STACK_{field}_ADDRESS")));
    };
    let body = value
        .strip_prefix("0x")
        .filter(|body| body.len() == 40)
        .ok_or_else(|| invalid(format!("STACK_{field}_ADDRESS")))?;
    let mut bytes = [0_u8; 20];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&body[index * 2..index * 2 + 2], 16)
            .map_err(|_| invalid(format!("STACK_{field}_ADDRESS")))?;
    }
    Ok(bytes)
}

fn jurisdiction_field<'a>(
    value: &'a CanonicalValue,
    field: &str,
) -> Result<&'a CanonicalValue, EntityKernelError> {
    let CanonicalValue::Object(fields) = value else {
        return Err(invalid("STACK_JURISDICTION_OBJECT"));
    };
    fields
        .iter()
        .find_map(|(name, value)| (name == field).then_some(value))
        .ok_or_else(|| invalid(format!("STACK_{field}_MISSING")))
}

/// Exact TS `getCertifiedBoardStackKey` ABI word encoding.
pub fn certified_board_stack_key(
    jurisdiction: &CanonicalValue,
) -> Result<[u8; 32], EntityKernelError> {
    let chain_id = match jurisdiction_field(jurisdiction, "chainId")? {
        CanonicalValue::Number(value) => value.as_str().parse::<u64>().ok(),
        _ => None,
    }
    .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
    .ok_or_else(|| invalid("STACK_CHAIN_ID"))?;
    let depository = canonical_address(
        jurisdiction_field(jurisdiction, "depositoryAddress")?,
        "DEPOSITORY",
    )?;
    let provider = canonical_address(
        jurisdiction_field(jurisdiction, "entityProviderAddress")?,
        "ENTITY_PROVIDER",
    )?;
    let mut encoded = [0_u8; 128];
    encoded[..32].copy_from_slice(&domain(b"xln.certified-board.stack.v1"));
    encoded[56..64].copy_from_slice(&chain_id.to_be_bytes());
    encoded[76..96].copy_from_slice(&depository);
    encoded[108..128].copy_from_slice(&provider);
    Ok(Keccak256::digest(encoded).into())
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::from("0x"), |mut output, byte| {
        let _ = write!(output, "{byte:02x}");
        output
    })
}

fn number(value: u64) -> Result<CanonicalValue, EntityKernelError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|error| invalid(error.to_string()))
}

fn object(entries: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
    CanonicalValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

pub fn canonical_certified_board_record(
    record: &CertifiedBoardRecord,
) -> Result<CanonicalValue, EntityKernelError> {
    Ok(object(vec![
        ("stackKey", CanonicalValue::String(hex(&record.stack_key))),
        ("entityId", CanonicalValue::String(hex(&record.entity_id))),
        ("boardHash", CanonicalValue::String(hex(&record.board_hash))),
        ("boardEpoch", number(record.board_epoch)?),
        (
            "previousBoardHash",
            CanonicalValue::String(hex(&record.previous_board_hash)),
        ),
        (
            "previousBoardValidUntil",
            number(record.previous_board_valid_until)?,
        ),
        ("activatedAtJHeight", number(record.activated_at_j_height)?),
        ("logIndex", number(u64::from(record.log_index))?),
        ("blockHash", CanonicalValue::String(hex(&record.block_hash))),
        (
            "transactionHash",
            CanonicalValue::String(hex(&record.transaction_hash)),
        ),
        (
            "source",
            CanonicalValue::String(record.source.text().to_string()),
        ),
    ]))
}

pub fn canonical_certified_board_state(
    state: &CertifiedBoardState,
) -> Result<CanonicalValue, EntityKernelError> {
    Ok(object(vec![
        ("stackKey", CanonicalValue::String(hex(&state.stack_key))),
        (
            "boardRegistryRoot",
            CanonicalValue::String(hex(&state.board_registry_root)),
        ),
        ("finalizedJHeight", number(state.finalized_j_height)?),
        (
            "finalizedJBlockHash",
            CanonicalValue::String(hex(&state.finalized_j_block_hash)),
        ),
        (
            "eventHistoryRoot",
            CanonicalValue::String(hex(&state.event_history_root)),
        ),
    ]))
}

fn fields<'a>(
    value: &'a CanonicalValue,
    expected: &[&str],
) -> Result<&'a [(String, CanonicalValue)], EntityKernelError> {
    let CanonicalValue::Object(fields) = value else {
        return Err(invalid("STATE_OBJECT"));
    };
    if fields.len() != expected.len()
        || expected
            .iter()
            .any(|name| !fields.iter().any(|(field, _)| field == name))
    {
        return Err(invalid("STATE_FIELDS"));
    }
    Ok(fields)
}

fn field<'a>(
    fields: &'a [(String, CanonicalValue)],
    name: &str,
) -> Result<&'a CanonicalValue, EntityKernelError> {
    fields
        .iter()
        .find_map(|(field, value)| (field == name).then_some(value))
        .ok_or_else(|| invalid(format!("{name}:MISSING")))
}

fn word(value: &CanonicalValue, name: &str) -> Result<[u8; 32], EntityKernelError> {
    let CanonicalValue::String(value) = value else {
        return Err(invalid(format!("{name}:STRING")));
    };
    let payload = value
        .strip_prefix("0x")
        .filter(|payload| payload.len() == 64)
        .ok_or_else(|| invalid(format!("{name}:HEX32")))?;
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&payload[index * 2..index * 2 + 2], 16)
            .map_err(|_| invalid(format!("{name}:HEX32")))?;
    }
    if hex(&output) != *value {
        return Err(invalid(format!("{name}:CANONICAL")));
    }
    Ok(output)
}

fn safe_u64(value: &CanonicalValue, name: &str) -> Result<u64, EntityKernelError> {
    let CanonicalValue::Number(value) = value else {
        return Err(invalid(format!("{name}:NUMBER")));
    };
    value
        .as_str()
        .parse()
        .map_err(|_| invalid(format!("{name}:SAFE_U64")))
}

pub fn decode_canonical_certified_board_state(
    value: &CanonicalValue,
) -> Result<CertifiedBoardState, EntityKernelError> {
    let fields = fields(
        value,
        &[
            "stackKey",
            "boardRegistryRoot",
            "finalizedJHeight",
            "finalizedJBlockHash",
            "eventHistoryRoot",
        ],
    )?;
    Ok(CertifiedBoardState {
        stack_key: word(field(fields, "stackKey")?, "stackKey")?,
        board_registry_root: word(field(fields, "boardRegistryRoot")?, "boardRegistryRoot")?,
        finalized_j_height: safe_u64(field(fields, "finalizedJHeight")?, "finalizedJHeight")?,
        finalized_j_block_hash: word(field(fields, "finalizedJBlockHash")?, "finalizedJBlockHash")?,
        event_history_root: word(field(fields, "eventHistoryRoot")?, "eventHistoryRoot")?,
        records: PersistentRadixMap::empty(),
    })
}

fn digest(value: &CanonicalValue) -> Result<[u8; 32], EntityKernelError> {
    Ok(Sha256::digest(
        encode_canonical_consensus_bytes(value).map_err(|error| invalid(error.to_string()))?,
    )
    .into())
}

fn domain(value: &[u8]) -> [u8; 32] {
    Keccak256::digest(value).into()
}

fn uint_slot(value: u64) -> [u8; 32] {
    let mut slot = [0_u8; 32];
    slot[24..].copy_from_slice(&value.to_be_bytes());
    slot
}

fn hash_slots(slots: &[[u8; 32]]) -> [u8; 32] {
    let mut hash = Keccak256::new();
    for slot in slots {
        hash.update(slot);
    }
    hash.finalize().into()
}

fn record_hash(record: &CertifiedBoardRecord) -> [u8; 32] {
    hash_slots(&[
        domain(b"xln.certified-board.record.v1"),
        record.stack_key,
        record.entity_id,
        record.board_hash,
        uint_slot(record.board_epoch),
        record.previous_board_hash,
        uint_slot(record.previous_board_valid_until),
        uint_slot(record.activated_at_j_height),
        uint_slot(u64::from(record.log_index)),
        record.block_hash,
        record.transaction_hash,
        uint_slot(record.source.code()),
    ])
}

fn entity_key(stack_key: [u8; 32], entity_id: [u8; 32]) -> [u8; 32] {
    hash_slots(&[domain(b"xln.certified-board.key.v1"), stack_key, entity_id])
}

fn key_bit(key: &[u8; 32], bit: usize) -> bool {
    key[bit / 8] & (1 << (7 - bit % 8)) != 0
}

fn masked_prefix(mut key: [u8; 32], bit: u16) -> [u8; 32] {
    let bit = usize::from(bit);
    let whole = bit / 8;
    let remainder = bit % 8;
    if remainder == 0 {
        key[whole..].fill(0);
    } else {
        key[whole] &= u8::MAX << (8 - remainder);
        key[whole + 1..].fill(0);
    }
    key
}

fn project_subtree(
    rows: &[([u8; 32], &CertifiedBoardRecord)],
    nodes: &mut Vec<CertifiedBoardStorageNode>,
) -> Result<[u8; 32], EntityKernelError> {
    if rows.len() == 1 {
        let hash = hash_slots(&[
            domain(b"xln.certified-board.leaf.v1"),
            uint_slot(1),
            rows[0].0,
            record_hash(rows[0].1),
        ]);
        nodes.push(CertifiedBoardStorageNode {
            path: CertifiedBoardStoragePath::Leaf(rows[0].0),
            hash,
            node: object(vec![
                ("version", number(1)?),
                ("type", CanonicalValue::String("leaf".into())),
                ("key", CanonicalValue::String(hex(&rows[0].0))),
                ("record", canonical_certified_board_record(rows[0].1)?),
            ]),
        });
        return Ok(hash);
    }
    let first = rows[0].0;
    let last = rows[rows.len() - 1].0;
    let bit = (0..256)
        .find(|bit| key_bit(&first, *bit) != key_bit(&last, *bit))
        .expect("distinct sorted board keys differ");
    let split = rows
        .iter()
        .position(|(key, _)| key_bit(key, bit))
        .expect("differing bit has right subtree");
    let bit = u16::try_from(bit).map_err(|_| invalid("BRANCH_BIT"))?;
    let left = project_subtree(&rows[..split], nodes)?;
    let right = project_subtree(&rows[split..], nodes)?;
    let hash = hash_slots(&[
        domain(b"xln.certified-board.branch.v1"),
        uint_slot(1),
        uint_slot(u64::from(bit)),
        left,
        right,
    ]);
    nodes.push(CertifiedBoardStorageNode {
        path: CertifiedBoardStoragePath::Branch {
            bit,
            prefix: masked_prefix(rows[0].0, bit),
        },
        hash,
        node: object(vec![
            ("version", number(1)?),
            ("type", CanonicalValue::String("branch".into())),
            ("bit", number(u64::from(bit))?),
            ("left", CanonicalValue::String(hex(&left))),
            ("right", CanonicalValue::String(hex(&right))),
        ]),
    });
    Ok(hash)
}

pub fn project_certified_board_storage_nodes(
    state: &CertifiedBoardState,
) -> Result<Vec<CertifiedBoardStorageNode>, EntityKernelError> {
    let mut rows = state
        .records
        .iter()
        .map(|(_, record)| (entity_key(state.stack_key, record.entity_id), record))
        .collect::<Vec<_>>();
    rows.sort_unstable_by_key(|(key, _)| *key);
    if rows.is_empty() {
        if state.board_registry_root != domain(b"xln.certified-board.empty.v1") {
            return Err(invalid("EMPTY_ROOT_MISMATCH"));
        }
        return Ok(Vec::new());
    }
    let mut nodes = Vec::with_capacity(rows.len().saturating_mul(2).saturating_sub(1));
    let root = project_subtree(&rows, &mut nodes)?;
    if root != state.board_registry_root {
        return Err(invalid("PROJECTED_ROOT_MISMATCH"));
    }
    Ok(nodes)
}

impl CertifiedBoardState {
    pub fn empty(stack_key: [u8; 32]) -> Self {
        Self {
            stack_key,
            board_registry_root: domain(b"xln.certified-board.empty.v1"),
            finalized_j_height: 0,
            finalized_j_block_hash: [0; 32],
            event_history_root: [0; 32],
            records: PersistentRadixMap::empty(),
        }
    }

    pub fn resolve(&self, entity_id: &[u8; 32]) -> Option<&CertifiedBoardRecord> {
        self.records.get(entity_id)
    }

    pub fn records(&self) -> impl Iterator<Item = (&[u8], &CertifiedBoardRecord)> {
        self.records.iter()
    }

    pub fn put(&mut self, record: CertifiedBoardRecord) -> Result<(), EntityKernelError> {
        if record.stack_key != self.stack_key {
            return Err(invalid("STACK_MISMATCH"));
        }
        let value = canonical_certified_board_record(&record)?;
        self.records = self
            .records
            .updated(record.entity_id.to_vec(), record, digest(&value)?)
            .map_err(|error| invalid(error.to_string()))?;
        let mut rows = self
            .records
            .iter()
            .map(|(_, record)| (entity_key(self.stack_key, record.entity_id), record))
            .collect::<Vec<_>>();
        rows.sort_unstable_by_key(|(key, _)| *key);
        let mut nodes = Vec::new();
        self.board_registry_root = project_subtree(&rows, &mut nodes)?;
        Ok(())
    }

    pub fn restore_records(
        &mut self,
        records: impl IntoIterator<Item = CertifiedBoardRecord>,
    ) -> Result<(), EntityKernelError> {
        let expected_root = self.board_registry_root;
        self.records = PersistentRadixMap::empty();
        self.board_registry_root = domain(b"xln.certified-board.empty.v1");
        for record in records {
            if self.resolve(&record.entity_id).is_some() {
                return Err(invalid("RESTORE_ENTITY_DUPLICATE"));
            }
            self.put(record)?;
        }
        if self.board_registry_root != expected_root {
            return Err(invalid("RESTORE_ROOT_MISMATCH"));
        }
        Ok(())
    }

    pub fn advance_finality(
        &mut self,
        finalized_j_height: u64,
        finalized_j_block_hash: [u8; 32],
        event_history_root: [u8; 32],
    ) -> Result<(), EntityKernelError> {
        if finalized_j_height < self.finalized_j_height {
            return Err(invalid(format!(
                "FINALITY_REWIND:{}:{finalized_j_height}",
                self.finalized_j_height
            )));
        }
        self.finalized_j_height = finalized_j_height;
        self.finalized_j_block_hash = finalized_j_block_hash;
        self.event_history_root = event_history_root;
        Ok(())
    }

    pub fn apply_j_event(&mut self, event: &JurisdictionEvent) -> Result<(), EntityKernelError> {
        let metadata = event.metadata();
        let j_height = metadata
            .block_number
            .filter(|height| *height > 0)
            .ok_or_else(|| invalid("J_HEIGHT"))?;
        let block_hash = metadata.block_hash.ok_or_else(|| invalid("BLOCK_HASH"))?;
        let transaction_hash = metadata
            .transaction_hash
            .ok_or_else(|| invalid("TRANSACTION_HASH"))?;
        let log_index = u32::try_from(metadata.log_index.ok_or_else(|| invalid("LOG_INDEX"))?)
            .map_err(|_| invalid("LOG_INDEX"))?;
        let foundation_id = {
            let mut id = [0_u8; 32];
            id[31] = 1;
            id
        };
        let record = match event {
            JurisdictionEvent::FoundationBootstrapped(event) => CertifiedBoardRecord {
                stack_key: self.stack_key,
                entity_id: foundation_id,
                board_hash: event.board_hash,
                board_epoch: 0,
                previous_board_hash: [0; 32],
                previous_board_valid_until: 0,
                activated_at_j_height: j_height,
                log_index,
                block_hash,
                transaction_hash,
                source: CertifiedBoardSource::FoundationBootstrapped,
            },
            JurisdictionEvent::EntityRegistered(event) => {
                if self.resolve(&foundation_id).is_none() {
                    return Err(invalid("STACK_NOT_BOOTSTRAPPED"));
                }
                let entity_id = *event.entity_id.as_bytes();
                let entity_number = BigInt::from_bytes_be(Sign::Plus, &entity_id);
                if event.entity_number != entity_number || event.entity_number <= BigInt::from(0) {
                    return Err(invalid("ENTITY_NUMBER_MISMATCH"));
                }
                CertifiedBoardRecord {
                    stack_key: self.stack_key,
                    entity_id,
                    board_hash: event.board_hash,
                    board_epoch: 0,
                    previous_board_hash: [0; 32],
                    previous_board_valid_until: 0,
                    activated_at_j_height: j_height,
                    log_index,
                    block_hash,
                    transaction_hash,
                    source: CertifiedBoardSource::EntityRegistered,
                }
            }
            JurisdictionEvent::BoardActivated(event) => {
                let entity_id = *event.entity_id.as_bytes();
                let prior = self
                    .resolve(&entity_id)
                    .cloned()
                    .ok_or_else(|| invalid("ACTIVATION_BEFORE_REGISTRATION"))?;
                let order =
                    (j_height, log_index).cmp(&(prior.activated_at_j_height, prior.log_index));
                if order.is_lt() {
                    return Err(invalid("ACTIVATION_STALE"));
                }
                let previous_board_valid_until = event.previous_board_valid_until.to_u64_digits();
                if previous_board_valid_until.0 == Sign::Minus
                    || previous_board_valid_until.1.len() != 1
                    || previous_board_valid_until.1[0] == 0
                {
                    return Err(invalid("PREVIOUS_EXPIRY_INVALID"));
                }
                let record = CertifiedBoardRecord {
                    stack_key: self.stack_key,
                    entity_id,
                    board_hash: event.new_board_hash,
                    board_epoch: if order.is_eq() {
                        prior.board_epoch
                    } else {
                        prior
                            .board_epoch
                            .checked_add(1)
                            .ok_or_else(|| invalid("BOARD_EPOCH_OVERFLOW"))?
                    },
                    previous_board_hash: event.previous_board_hash,
                    previous_board_valid_until: previous_board_valid_until.1[0],
                    activated_at_j_height: j_height,
                    log_index,
                    block_hash,
                    transaction_hash,
                    source: CertifiedBoardSource::BoardActivated,
                };
                if order.is_eq() {
                    if record != prior {
                        return Err(invalid("ACTIVE_CONFLICT"));
                    }
                    return Ok(());
                }
                if record.previous_board_hash != prior.board_hash {
                    return Err(invalid("PREVIOUS_HASH_MISMATCH"));
                }
                record
            }
            _ => return Ok(()),
        };
        if let Some(existing) = self.resolve(&record.entity_id) {
            if existing == &record {
                return Ok(());
            }
            if record.source != CertifiedBoardSource::BoardActivated {
                return Err(invalid("REGISTRATION_CONFLICT"));
            }
        }
        self.put(record)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use xln_rscore_engine::{
        EntityId, EntityRegisteredEvent, FoundationBootstrappedEvent, JEventMetadata,
    };

    fn bytes(value: &str) -> [u8; 32] {
        word(&CanonicalValue::String(value.to_string()), "test").expect("word")
    }

    #[test]
    fn registry_record_and_root_match_typescript_golden() {
        let stack = bytes("0xc1d4b2fb7c36fa7083234ab620075fdec39eea7961d90c9facb36e78e5acb017");
        let mut state = CertifiedBoardState::empty(stack);
        assert_eq!(
            state.board_registry_root,
            bytes("0x8e5d9c40132e5ace5d28b5be7e67e734eb0169df12afe81e07f435723290baac")
        );
        let record = CertifiedBoardRecord {
            stack_key: stack,
            entity_id: [0x11; 32],
            board_hash: [0x44; 32],
            board_epoch: 0,
            previous_board_hash: [0; 32],
            previous_board_valid_until: 0,
            activated_at_j_height: 7,
            log_index: 2,
            block_hash: [0x55; 32],
            transaction_hash: [0x66; 32],
            source: CertifiedBoardSource::EntityRegistered,
        };
        assert_eq!(
            record_hash(&record),
            bytes("0x2813ffaf9d76daa5204778da8d83f9e5c02be9790de955d6c47c3041ed64e0e8")
        );
        state.put(record).expect("insert");
        assert_eq!(
            state.board_registry_root,
            bytes("0x828e78c7a6779aa8c7c317e2b5619bd7c4c72fc7795768eed10da59bd02693a2")
        );
        let nodes = project_certified_board_storage_nodes(&state).expect("project one leaf");
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].hash, state.board_registry_root);
        assert!(matches!(nodes[0].path, CertifiedBoardStoragePath::Leaf(_)));

        let expected_root = state.board_registry_root;
        let records = state
            .records()
            .map(|(_, record)| record.clone())
            .collect::<Vec<_>>();
        let mut restored = CertifiedBoardState {
            stack_key: state.stack_key,
            board_registry_root: expected_root,
            finalized_j_height: state.finalized_j_height,
            finalized_j_block_hash: state.finalized_j_block_hash,
            event_history_root: state.event_history_root,
            records: PersistentRadixMap::empty(),
        };
        restored
            .restore_records(records)
            .expect("restore exact records");
        assert_eq!(restored, state);

        let mut multi = CertifiedBoardState::empty(stack);
        for byte in [0x33_u8, 0x11, 0x22] {
            multi
                .put(CertifiedBoardRecord {
                    stack_key: stack,
                    entity_id: [byte; 32],
                    board_hash: [0x44; 32],
                    board_epoch: 0,
                    previous_board_hash: [0; 32],
                    previous_board_valid_until: 0,
                    activated_at_j_height: 7,
                    log_index: u32::from(byte),
                    block_hash: [0x55; 32],
                    transaction_hash: [0x66; 32],
                    source: CertifiedBoardSource::EntityRegistered,
                })
                .expect("insert");
        }
        assert_eq!(
            multi.board_registry_root,
            bytes("0x29dda28a72b63ad42d371e89c2ee9f1af8d36b59d4f3ab1d8fda23eb88431c54")
        );
        let nodes = project_certified_board_storage_nodes(&multi).expect("project tree");
        assert_eq!(nodes.len(), 5);
        assert_eq!(
            nodes.last().expect("root node").hash,
            multi.board_registry_root
        );
    }

    #[test]
    fn stack_and_registration_event_sequence_match_typescript_golden() {
        let jurisdiction = CanonicalValue::Object(vec![
            (
                "chainId".into(),
                CanonicalValue::Number(CanonicalNumber::from_u32(31_337)),
            ),
            (
                "depositoryAddress".into(),
                CanonicalValue::String(format!("0x{}", "88".repeat(20))),
            ),
            (
                "entityProviderAddress".into(),
                CanonicalValue::String(format!("0x{}", "99".repeat(20))),
            ),
        ]);
        let stack = certified_board_stack_key(&jurisdiction).expect("stack");
        assert_eq!(
            stack,
            bytes("0xb4f6c4ac068d635fd2a654a727e971a2fe1e16c3c7a6a20c434dd50b587040b9")
        );
        let metadata = |height, block, transaction| JEventMetadata {
            block_number: Some(height),
            block_hash: Some([block; 32]),
            transaction_hash: Some([transaction; 32]),
            log_index: Some(0),
            event_index: None,
        };
        let mut state = CertifiedBoardState::empty(stack);
        state
            .apply_j_event(&JurisdictionEvent::FoundationBootstrapped(
                FoundationBootstrappedEvent {
                    metadata: metadata(1, 0xaa, 0xbb),
                    recipient: [0xcc; 20],
                    board_hash: [0x11; 32],
                    control_token_id: BigInt::from(1),
                    dividend_token_id: BigInt::from(2),
                },
            ))
            .expect("foundation");
        let entity_id = EntityId::parse(&format!("0x{}", "22".repeat(32))).expect("entity");
        state
            .apply_j_event(&JurisdictionEvent::EntityRegistered(
                EntityRegisteredEvent {
                    metadata: metadata(2, 0xab, 0xbc),
                    entity_number: BigInt::from_bytes_be(Sign::Plus, entity_id.as_bytes()),
                    entity_id,
                    board_hash: [0x33; 32],
                },
            ))
            .expect("registration");
        assert_eq!(
            state.board_registry_root,
            bytes("0x49402054db24826a8e8b06fdad7e8028519cdbc827f5fdbf2c69f851b828d6ef")
        );
    }
}

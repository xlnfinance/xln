//! Exact inverse of the path-keyed certified-board registry (storage tag 0x2a).

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};
use sha3::{Digest as _, Keccak256};
use thiserror::Error;
use xln_rscore_engine::CertifiedBoardAuthority;
use xln_rscore_entity_kernel::{
    CertifiedBoardRecord as EntityCertifiedBoardRecord, CertifiedBoardSource,
};

use crate::certified_board_registry::EntityCommandCertifiedBoard;
use crate::{CertifiedBoardRegistry, StorageMessagePackError, decode_storage_payload};

use super::HydratedEntityGraph;

const CERTIFIED_BOARD_TAG: u8 = 0x2a;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Error)]
pub enum CertifiedBoardRegistryRestoreError {
    #[error("RRS_RESTORE_CERTIFIED_BOARD:{0}")]
    Invalid(String),
    #[error(transparent)]
    Storage(#[from] StorageMessagePackError),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PhysicalPath {
    Branch { bit: u16, prefix: [u8; 32] },
    Leaf([u8; 32]),
}

#[derive(Clone, Copy, Debug)]
struct CertifiedBoardRecord {
    stack_key: [u8; 32],
    entity_id: [u8; 32],
    board_hash: [u8; 32],
    board_epoch: u64,
    previous_board_hash: [u8; 32],
    previous_board_valid_until: u64,
    activated_at_j_height: u64,
    log_index: u32,
    block_hash: [u8; 32],
    transaction_hash: [u8; 32],
    source: u8,
}

#[derive(Clone, Copy, Debug)]
enum CertifiedBoardNode {
    Branch {
        bit: u16,
        left: [u8; 32],
        right: [u8; 32],
    },
    Leaf {
        key: [u8; 32],
        record: CertifiedBoardRecord,
    },
}

#[derive(Clone, Debug)]
struct StoredNode {
    physical_key: Vec<u8>,
    path: PhysicalPath,
    node: CertifiedBoardNode,
}

pub struct HydratedCertifiedBoardRegistry {
    pub registry: CertifiedBoardRegistry,
    pub records: Vec<EntityCertifiedBoardRecord>,
}

fn invalid(detail: impl Into<String>) -> CertifiedBoardRegistryRestoreError {
    CertifiedBoardRegistryRestoreError::Invalid(detail.into())
}

fn object<'a>(
    value: &'a Value,
    path: &str,
) -> Result<&'a Map<String, Value>, CertifiedBoardRegistryRestoreError> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("OBJECT:{path}")))
}

fn exact_fields(
    value: &Map<String, Value>,
    expected: &[&str],
    path: &str,
) -> Result<(), CertifiedBoardRegistryRestoreError> {
    let mut actual = value.keys().map(String::as_str).collect::<Vec<_>>();
    actual.sort_unstable();
    let mut expected = expected.to_vec();
    expected.sort_unstable();
    if actual == expected {
        Ok(())
    } else {
        Err(invalid(format!("FIELDS:{path}:{}", actual.join(","))))
    }
}

fn word(value: &Value, path: &str) -> Result<[u8; 32], CertifiedBoardRegistryRestoreError> {
    let text = value
        .as_str()
        .filter(|text| text.starts_with("0x") && text.len() == 66)
        .ok_or_else(|| invalid(format!("WORD:{path}")))?;
    if text
        .bytes()
        .skip(2)
        .any(|byte| !byte.is_ascii_digit() && !(b'a'..=b'f').contains(&byte))
    {
        return Err(invalid(format!("WORD:{path}")));
    }
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2 + 2..index * 2 + 4], 16)
            .map_err(|_| invalid(format!("WORD:{path}")))?;
    }
    Ok(output)
}

fn safe_u64(value: &Value, path: &str) -> Result<u64, CertifiedBoardRegistryRestoreError> {
    value
        .as_u64()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid(format!("SAFE_INTEGER:{path}")))
}

fn safe_u32(value: &Value, path: &str) -> Result<u32, CertifiedBoardRegistryRestoreError> {
    u32::try_from(safe_u64(value, path)?).map_err(|_| invalid(format!("U32:{path}")))
}

fn domain(label: &[u8]) -> [u8; 32] {
    Keccak256::digest(label).into()
}

fn uint_slot(value: u64) -> [u8; 32] {
    let mut output = [0_u8; 32];
    output[24..].copy_from_slice(&value.to_be_bytes());
    output
}

fn hash_slots(slots: &[[u8; 32]]) -> [u8; 32] {
    let mut digest = Keccak256::new();
    for slot in slots {
        digest.update(slot);
    }
    digest.finalize().into()
}

fn certified_board_entity_key(stack_key: [u8; 32], entity_id: [u8; 32]) -> [u8; 32] {
    hash_slots(&[domain(b"xln.certified-board.key.v1"), stack_key, entity_id])
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
        uint_slot(u64::from(record.source)),
    ])
}

fn node_hash(node: &CertifiedBoardNode) -> [u8; 32] {
    match node {
        CertifiedBoardNode::Leaf { key, record } => hash_slots(&[
            domain(b"xln.certified-board.leaf.v1"),
            uint_slot(1),
            *key,
            record_hash(record),
        ]),
        CertifiedBoardNode::Branch { bit, left, right } => hash_slots(&[
            domain(b"xln.certified-board.branch.v1"),
            uint_slot(1),
            uint_slot(u64::from(*bit)),
            *left,
            *right,
        ]),
    }
}

fn empty_root() -> [u8; 32] {
    domain(b"xln.certified-board.empty.v1")
}

type CertifiedBoardStateRoots = ([u8; 32], [u8; 32]);

fn parse_state(
    graph: &HydratedEntityGraph,
) -> Result<Option<CertifiedBoardStateRoots>, CertifiedBoardRegistryRestoreError> {
    let core = object(&graph.core, "entity.core")?;
    let Some(value) = core.get("certifiedBoardState") else {
        return Ok(None);
    };
    let state = object(value, "entity.core.certifiedBoardState")?;
    exact_fields(
        state,
        &[
            "stackKey",
            "boardRegistryRoot",
            "finalizedJHeight",
            "finalizedJBlockHash",
            "eventHistoryRoot",
        ],
        "entity.core.certifiedBoardState",
    )?;
    let _ = safe_u64(&state["finalizedJHeight"], "state.finalizedJHeight")?;
    let _ = word(&state["finalizedJBlockHash"], "state.finalizedJBlockHash")?;
    let _ = word(&state["eventHistoryRoot"], "state.eventHistoryRoot")?;
    Ok(Some((
        word(&state["stackKey"], "state.stackKey")?,
        word(&state["boardRegistryRoot"], "state.boardRegistryRoot")?,
    )))
}

fn parse_path(
    key: &[u8],
    owner: &[u8; 32],
) -> Result<PhysicalPath, CertifiedBoardRegistryRestoreError> {
    if key.len() < 34 || key[0] != CERTIFIED_BOARD_TAG || key.get(1..33) != Some(owner) {
        return Err(invalid("PHYSICAL_KEY_OWNER"));
    }
    match &key[33..] {
        [1, leaf @ ..] if leaf.len() == 32 => Ok(PhysicalPath::Leaf(
            leaf.try_into().map_err(|_| invalid("LEAF_PATH"))?,
        )),
        [0, high, low, prefix @ ..] if prefix.len() == 32 => {
            let bit = u16::from_be_bytes([*high, *low]);
            if bit > 255 {
                return Err(invalid("BRANCH_PATH_BIT"));
            }
            let prefix: [u8; 32] = prefix.try_into().map_err(|_| invalid("BRANCH_PATH"))?;
            if masked_prefix(prefix, bit) != prefix {
                return Err(invalid("BRANCH_PATH_NONCANONICAL"));
            }
            Ok(PhysicalPath::Branch { bit, prefix })
        }
        _ => Err(invalid("PHYSICAL_KEY_PATH")),
    }
}

fn parse_record(value: &Value) -> Result<CertifiedBoardRecord, CertifiedBoardRegistryRestoreError> {
    let record = object(value, "node.record")?;
    exact_fields(
        record,
        &[
            "stackKey",
            "entityId",
            "boardHash",
            "boardEpoch",
            "previousBoardHash",
            "previousBoardValidUntil",
            "activatedAtJHeight",
            "logIndex",
            "blockHash",
            "transactionHash",
            "source",
        ],
        "node.record",
    )?;
    let source = match record["source"].as_str() {
        Some("FoundationBootstrapped") => 1,
        Some("EntityRegistered") => 2,
        Some("BoardActivated") => 3,
        _ => return Err(invalid("RECORD_SOURCE")),
    };
    let activated_at_j_height =
        safe_u64(&record["activatedAtJHeight"], "record.activatedAtJHeight")?;
    if activated_at_j_height == 0 {
        return Err(invalid("RECORD_ACTIVATION_HEIGHT"));
    }
    let record = CertifiedBoardRecord {
        stack_key: word(&record["stackKey"], "record.stackKey")?,
        entity_id: word(&record["entityId"], "record.entityId")?,
        board_hash: word(&record["boardHash"], "record.boardHash")?,
        board_epoch: safe_u64(&record["boardEpoch"], "record.boardEpoch")?,
        previous_board_hash: word(&record["previousBoardHash"], "record.previousBoardHash")?,
        previous_board_valid_until: safe_u64(
            &record["previousBoardValidUntil"],
            "record.previousBoardValidUntil",
        )?,
        activated_at_j_height,
        log_index: safe_u32(&record["logIndex"], "record.logIndex")?,
        block_hash: word(&record["blockHash"], "record.blockHash")?,
        transaction_hash: word(&record["transactionHash"], "record.transactionHash")?,
        source,
    };
    let rotation = record.source == 3;
    if rotation != (record.board_epoch > 0)
        || rotation
            != (record.previous_board_hash != [0_u8; 32] && record.previous_board_valid_until > 0)
    {
        return Err(invalid("RECORD_ROTATION_TUPLE"));
    }
    Ok(record)
}

fn parse_node(value: &Value) -> Result<CertifiedBoardNode, CertifiedBoardRegistryRestoreError> {
    let node = object(value, "node")?;
    match node.get("type").and_then(Value::as_str) {
        Some("leaf") => {
            exact_fields(node, &["version", "type", "key", "record"], "node.leaf")?;
            if node["version"].as_u64() != Some(1) {
                return Err(invalid("NODE_VERSION"));
            }
            Ok(CertifiedBoardNode::Leaf {
                key: word(&node["key"], "node.key")?,
                record: parse_record(&node["record"])?,
            })
        }
        Some("branch") => {
            exact_fields(
                node,
                &["version", "type", "bit", "left", "right"],
                "node.branch",
            )?;
            if node["version"].as_u64() != Some(1) {
                return Err(invalid("NODE_VERSION"));
            }
            let bit = u16::try_from(safe_u64(&node["bit"], "node.bit")?)
                .map_err(|_| invalid("NODE_BIT"))?;
            if bit > 255 {
                return Err(invalid("NODE_BIT"));
            }
            let left = word(&node["left"], "node.left")?;
            let right = word(&node["right"], "node.right")?;
            if left == right {
                return Err(invalid("BRANCH_UNARY"));
            }
            Ok(CertifiedBoardNode::Branch { bit, left, right })
        }
        _ => Err(invalid("NODE_TYPE")),
    }
}

fn parse_row(
    physical_key: &[u8],
    bytes: &[u8],
    owner: &[u8; 32],
) -> Result<([u8; 32], StoredNode), CertifiedBoardRegistryRestoreError> {
    let path = parse_path(physical_key, owner)?;
    let value = decode_storage_payload(bytes)?;
    let row = object(&value, "row")?;
    exact_fields(row, &["version", "hash", "node"], "row")?;
    if row["version"].as_u64() != Some(1) {
        return Err(invalid("ROW_VERSION"));
    }
    let hash = word(&row["hash"], "row.hash")?;
    let node = parse_node(&row["node"])?;
    if node_hash(&node) != hash {
        return Err(invalid("ROW_HASH_MISMATCH"));
    }
    Ok((
        hash,
        StoredNode {
            physical_key: physical_key.to_vec(),
            path,
            node,
        },
    ))
}

fn key_bit(key: &[u8; 32], bit: u16) -> u8 {
    let bit = usize::from(bit);
    (key[bit / 8] >> (7 - bit % 8)) & 1
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

struct Walker<'a> {
    nodes: &'a BTreeMap<[u8; 32], StoredNode>,
    stack_key: [u8; 32],
    active: BTreeSet<[u8; 32]>,
    used: BTreeSet<[u8; 32]>,
    authorities: BTreeMap<[u8; 32], CertifiedBoardAuthority>,
    command_boards: BTreeMap<[u8; 32], EntityCommandCertifiedBoard>,
    records: Vec<EntityCertifiedBoardRecord>,
}

impl Walker<'_> {
    fn visit(
        &mut self,
        hash: [u8; 32],
        previous_bit: Option<u16>,
    ) -> Result<[u8; 32], CertifiedBoardRegistryRestoreError> {
        if !self.active.insert(hash) {
            return Err(invalid("NODE_CYCLE"));
        }
        if !self.used.insert(hash) {
            return Err(invalid("NODE_SHARED"));
        }
        let stored = self
            .nodes
            .get(&hash)
            .ok_or_else(|| invalid("NODE_MISSING"))?;
        let result = match stored.node {
            CertifiedBoardNode::Leaf { key, record } => {
                if stored.path != PhysicalPath::Leaf(key) {
                    return Err(invalid("LEAF_PATH_MISMATCH"));
                }
                if record.stack_key != self.stack_key {
                    return Err(invalid("RECORD_STACK_MISMATCH"));
                }
                if certified_board_entity_key(record.stack_key, record.entity_id) != key {
                    return Err(invalid("RECORD_KEY_MISMATCH"));
                }
                let source = match record.source {
                    1 => CertifiedBoardSource::FoundationBootstrapped,
                    2 => CertifiedBoardSource::EntityRegistered,
                    3 => CertifiedBoardSource::BoardActivated,
                    _ => return Err(invalid("RECORD_SOURCE")),
                };
                self.records.push(EntityCertifiedBoardRecord {
                    stack_key: record.stack_key,
                    entity_id: record.entity_id,
                    board_hash: record.board_hash,
                    board_epoch: record.board_epoch,
                    previous_board_hash: record.previous_board_hash,
                    previous_board_valid_until: record.previous_board_valid_until,
                    activated_at_j_height: record.activated_at_j_height,
                    log_index: record.log_index,
                    block_hash: record.block_hash,
                    transaction_hash: record.transaction_hash,
                    source,
                });
                let authority = CertifiedBoardAuthority {
                    entity_id: record.entity_id,
                    registered_board_hash: record.board_hash,
                    previous_board_hash: record.previous_board_hash,
                    previous_board_valid_until: record.previous_board_valid_until,
                    activated_at_j_height: record.activated_at_j_height,
                    activation_log_index: u64::from(record.log_index),
                };
                if self
                    .authorities
                    .insert(record.entity_id, authority)
                    .is_some()
                {
                    return Err(invalid("RECORD_ENTITY_DUPLICATE"));
                }
                self.command_boards.insert(
                    record.entity_id,
                    EntityCommandCertifiedBoard {
                        board_hash: record.board_hash,
                        board_epoch: record.board_epoch,
                    },
                );
                key
            }
            CertifiedBoardNode::Branch { bit, left, right } => {
                if previous_bit.is_some_and(|previous| bit <= previous) {
                    return Err(invalid("BRANCH_ORDER"));
                }
                let left_key = self.visit(left, Some(bit))?;
                let right_key = self.visit(right, Some(bit))?;
                if key_bit(&left_key, bit) != 0 || key_bit(&right_key, bit) != 1 {
                    return Err(invalid("BRANCH_DIRECTION"));
                }
                if stored.path
                    != (PhysicalPath::Branch {
                        bit,
                        prefix: masked_prefix(left_key, bit),
                    })
                {
                    return Err(invalid("BRANCH_PATH_MISMATCH"));
                }
                left_key
            }
        };
        self.active.remove(&hash);
        Ok(result)
    }
}

/// Hydrate and authenticate the only board-authority registry Account inputs
/// may consult. Every 0x2a row must be reachable from the Entity-committed
/// root; only after that proof can a missing exact Entity key mean `Lazy`.
pub fn hydrate_certified_board_registry(
    rows: &BTreeMap<Vec<u8>, Vec<u8>>,
    graph: &HydratedEntityGraph,
) -> Result<CertifiedBoardRegistry, CertifiedBoardRegistryRestoreError> {
    Ok(hydrate_certified_board_state(rows, graph)?.registry)
}

/// Authenticate the path-keyed board tree once and return both consumers of
/// that same proof: Account authority lookup and the Entity machine's records.
pub fn hydrate_certified_board_state(
    rows: &BTreeMap<Vec<u8>, Vec<u8>>,
    graph: &HydratedEntityGraph,
) -> Result<HydratedCertifiedBoardRegistry, CertifiedBoardRegistryRestoreError> {
    let board_rows = rows
        .iter()
        .filter(|(key, _)| {
            key.first() == Some(&CERTIFIED_BOARD_TAG)
                && key.get(1..33) == Some(graph.entity_id.as_slice())
        })
        .collect::<Vec<_>>();
    let Some((stack_key, root)) = parse_state(graph)? else {
        if board_rows.is_empty() {
            return Ok(HydratedCertifiedBoardRegistry {
                registry: CertifiedBoardRegistry::empty(),
                records: Vec::new(),
            });
        }
        return Err(invalid("ROWS_WITHOUT_STATE"));
    };
    if root == empty_root() {
        if !board_rows.is_empty() {
            return Err(invalid("ROWS_FOR_EMPTY_ROOT"));
        }
        return Ok(HydratedCertifiedBoardRegistry {
            registry: CertifiedBoardRegistry::restored(
                stack_key,
                root,
                BTreeMap::new(),
                BTreeMap::new(),
            ),
            records: Vec::new(),
        });
    }
    let mut nodes = BTreeMap::new();
    for (key, value) in board_rows {
        let (hash, node) = parse_row(key, value, &graph.entity_id)?;
        if nodes.insert(hash, node).is_some() {
            return Err(invalid("NODE_HASH_DUPLICATE"));
        }
    }
    let mut walker = Walker {
        nodes: &nodes,
        stack_key,
        active: BTreeSet::new(),
        used: BTreeSet::new(),
        authorities: BTreeMap::new(),
        command_boards: BTreeMap::new(),
        records: Vec::new(),
    };
    walker.visit(root, None)?;
    if walker.used.len() != nodes.len() {
        let orphan = nodes
            .iter()
            .find(|(hash, _)| !walker.used.contains(*hash))
            .map(|(_, node)| node.physical_key.as_slice())
            .unwrap_or_default();
        return Err(invalid(format!("NODE_ORPHAN:{}", hex(orphan))));
    }
    Ok(HydratedCertifiedBoardRegistry {
        registry: CertifiedBoardRegistry::restored(
            stack_key,
            root,
            walker.authorities,
            walker.command_boards,
        ),
        records: walker.records,
    })
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use xln_rscore_batch::{AccountInputBoardAuthority, CertifiedBoardAuthorityResolver};

    fn word_text(byte: u8) -> String {
        format!("0x{}", hex(&[byte; 32]))
    }

    fn fixture_record_words(entity_id: [u8; 32], board_hash: [u8; 32]) -> Value {
        serde_json::json!({
            "stackKey": word_text(0x11),
            "entityId": format!("0x{}", hex(&entity_id)),
            "boardHash": format!("0x{}", hex(&board_hash)),
            "boardEpoch": 7,
            "previousBoardHash": word_text(0x44),
            "previousBoardValidUntil": 1_700_604_800_u64,
            "activatedAtJHeight": 9,
            "logIndex": 3,
            "blockHash": word_text(0x55),
            "transactionHash": word_text(0x66),
            "source": "BoardActivated"
        })
    }

    fn core(root: [u8; 32]) -> HydratedEntityGraph {
        HydratedEntityGraph {
            entity_id: [0xaa; 32],
            core: serde_json::json!({
                "certifiedBoardState": {
                    "stackKey": word_text(0x11),
                    "boardRegistryRoot": format!("0x{}", hex(&root)),
                    "finalizedJHeight": 9,
                    "finalizedJBlockHash": word_text(0x55),
                    "eventHistoryRoot": word_text(0x77)
                }
            }),
            carried_sections: Vec::new(),
        }
    }

    fn encode(value: &Value) -> Vec<u8> {
        let canonical = crate::canonical_value_from_tagged_json(value).expect("canonical fixture");
        crate::encode_storage_payload(&canonical).expect("storage fixture")
    }

    fn leaf_row_words(entity_id: [u8; 32], board_hash: [u8; 32]) -> (Vec<u8>, Vec<u8>, [u8; 32]) {
        let record_value = fixture_record_words(entity_id, board_hash);
        let record = parse_record(&record_value).expect("record fixture");
        let key = certified_board_entity_key(record.stack_key, record.entity_id);
        let node = CertifiedBoardNode::Leaf { key, record };
        let hash = node_hash(&node);
        let mut physical_key = Vec::with_capacity(66);
        physical_key.push(CERTIFIED_BOARD_TAG);
        physical_key.extend_from_slice(&[0xaa; 32]);
        physical_key.push(1);
        physical_key.extend_from_slice(&key);
        let value = serde_json::json!({
            "version": 1,
            "hash": format!("0x{}", hex(&hash)),
            "node": {
                "version": 1,
                "type": "leaf",
                "key": format!("0x{}", hex(&key)),
                "record": record_value
            }
        });
        (physical_key, encode(&value), hash)
    }

    fn leaf_row(entity_byte: u8, board_byte: u8) -> (Vec<u8>, Vec<u8>, [u8; 32]) {
        leaf_row_words([entity_byte; 32], [board_byte; 32])
    }

    #[test]
    fn ts_leaf_vector_hydrates_one_exact_certified_authority() {
        let (key, value, root) = leaf_row(0x22, 0x33);
        assert_eq!(
            hex(&certified_board_entity_key([0x11; 32], [0x22; 32])),
            "c646548a89f4b9264600426c4503718f9d7abd25a12ed4681149653bbb779c27"
        );
        assert_eq!(
            hex(&root),
            "20b786c1f8ecdae119ddcc7e840d4c96b25a3dc195d3eb106100aa91807eab67"
        );
        let hydrated = hydrate_certified_board_state(&BTreeMap::from([(key, value)]), &core(root))
            .expect("restored registry and Entity records");
        assert_eq!(hydrated.records.len(), 1);
        assert_eq!(hydrated.records[0].entity_id, [0x22; 32]);
        assert_eq!(hydrated.records[0].board_hash, [0x33; 32]);
        assert_eq!(
            hydrated.records[0].source,
            CertifiedBoardSource::BoardActivated
        );
        let registry = hydrated.registry;
        assert_eq!(registry.len(), 1);
        assert_eq!(registry.stack_key(), Some(&[0x11; 32]));
        assert_eq!(registry.root(), Some(&root));
        assert!(matches!(
            registry
                .resolve_certified_board(&[0x22; 32])
                .expect("resolved"),
            AccountInputBoardAuthority::Certified(authority)
                if authority.entity_id == [0x22; 32]
                    && authority.registered_board_hash == [0x33; 32]
                    && authority.previous_board_hash == [0x44; 32]
                    && authority.previous_board_valid_until == 1_700_604_800
                    && authority.activated_at_j_height == 9
                    && authority.activation_log_index == 3
        ));
        assert_eq!(
            registry
                .resolve_certified_board(&[0xfe; 32])
                .expect("authenticated absence"),
            AccountInputBoardAuthority::Lazy,
        );
    }

    #[test]
    fn missing_corrupt_and_orphan_registry_rows_fail_before_lookup() {
        let mut invalid_tuple = fixture_record_words([0x22; 32], [0x33; 32]);
        invalid_tuple["source"] = Value::String("EntityRegistered".into());
        assert!(matches!(
            parse_record(&invalid_tuple),
            Err(CertifiedBoardRegistryRestoreError::Invalid(detail))
                if detail == "RECORD_ROTATION_TUPLE"
        ));

        let (key, value, root) = leaf_row(0x22, 0x33);
        let rows = BTreeMap::from([(key.clone(), value.clone())]);
        assert!(matches!(
            hydrate_certified_board_registry(&rows, &core([0x99; 32])),
            Err(CertifiedBoardRegistryRestoreError::Invalid(detail))
                if detail == "NODE_MISSING"
        ));

        let mut corrupt_value = decode_storage_payload(&value).expect("decode fixture");
        corrupt_value["node"]["record"]["boardHash"] = Value::String(word_text(0x34));
        let corrupt_rows = BTreeMap::from([(key.clone(), encode(&corrupt_value))]);
        assert!(matches!(
            hydrate_certified_board_registry(&corrupt_rows, &core(root)),
            Err(CertifiedBoardRegistryRestoreError::Invalid(detail))
                if detail == "ROW_HASH_MISMATCH"
        ));

        let (orphan_key, orphan_value, _) = leaf_row(0x23, 0x35);
        let orphan_rows = BTreeMap::from([(key, value), (orphan_key, orphan_value)]);
        assert!(matches!(
            hydrate_certified_board_registry(&orphan_rows, &core(root)),
            Err(CertifiedBoardRegistryRestoreError::Invalid(detail))
                if detail.starts_with("NODE_ORPHAN:")
        ));
    }

    #[test]
    fn hydrated_checkpoint_registry_installed_on_runtime_accepts_registered_board_frame() {
        use num_bigint::BigInt;
        use std::sync::Arc;
        use xln_rscore_batch::{AccountId, AccountInput, AccountInputKind, AccountInputRow};
        use xln_rscore_engine::{
            AccountConsensus, AccountDisputeConfig, AccountDomain, AccountIdentity,
            AccountInputEnvelope, AccountReplica, AccountState, AccountTx, BoardDelays,
            DeliveryMode, Delta, DepositoryAddress, EntityId, IncomingFrame, ProposalOutcome,
            SigningIdentity, SwapMarketPolicy, TokenId, WatchSeed, propose_account_frame,
        };
        use xln_rscore_entity_kernel::DeterministicContext;
        use xln_rscore_protocol::CanonicalValue;

        let peer_entity_id = [0xff_u8; 32];
        let owner_entity_id = crate::machine::tests::owner_bytes();
        let account_id = AccountId::from_bytes(peer_entity_id);
        let peer =
            EntityId::parse(&format!("0x{}", hex(&peer_entity_id))).expect("registered peer");
        let owner =
            EntityId::parse(&format!("0x{}", hex(&owner_entity_id))).expect("runtime owner");
        let (left, right) = if owner.to_string() < peer.to_string() {
            (owner, peer.clone())
        } else {
            (peer.clone(), owner)
        };
        let delta = Delta::new(
            TokenId::new(1).expect("token"),
            BigInt::from(1_000_000_000),
            BigInt::from(0),
            BigInt::from(0),
            BigInt::from(500_000_000),
            BigInt::from(500_000_000),
            BigInt::from(0),
            BigInt::from(0),
            BigInt::from(0),
            BigInt::from(0),
        )
        .expect("funded delta");
        let mut runtime = crate::machine::tests::replica_with_deltas(
            crate::RuntimeLimits::hlt(),
            vec![delta.clone()],
        )
        .expect("restart fixture");
        let initial_state = AccountState::new(
            AccountIdentity::new(
                AccountDomain::new(
                    31_337,
                    DepositoryAddress::parse(&format!("0x{}", "88".repeat(20)))
                        .expect("depository"),
                )
                .expect("domain"),
                left,
                right,
                WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
            )
            .expect("account identity"),
            AccountDisputeConfig::new(10, 10).expect("dispute config"),
            vec![delta],
        )
        .expect("initial account state");
        let mut peer_account =
            AccountConsensus::new(AccountReplica::new(peer, initial_state).expect("peer replica"));
        peer_account
            .admit_txs(
                vec![AccountTx::DirectPayment {
                    token_id: TokenId::new(1).expect("token"),
                    amount: BigInt::from(700),
                    route: vec![format!("0x{}", hex(&owner_entity_id))],
                    description: None,
                    from_entity_id: format!("0x{}", hex(&peer_entity_id)),
                    to_entity_id: format!("0x{}", hex(&owner_entity_id)),
                    delivery_mode: DeliveryMode::Direct,
                    trusted_gateway_entity_id: None,
                }],
                "registered-board-restart",
            )
            .expect("peer admission");
        let peer_key = [0x31_u8; 32];
        let lazy_board = SigningIdentity::lazy_from_key(
            peer_key,
            "registered-peer",
            2,
            2,
            BoardDelays::default(),
        )
        .expect("board claim");
        let board_hash = *lazy_board.entity_id();
        let registered_signer = SigningIdentity::from_key(
            peer_key,
            "registered-peer",
            peer_entity_id,
            2,
            2,
            BoardDelays::default(),
        );
        let proposed = match propose_account_frame(
            &mut peer_account,
            &registered_signer,
            200,
            9,
            &Arc::new(SwapMarketPolicy::default()),
        )
        .expect("registered proposal")
        {
            ProposalOutcome::Proposed(proposed) => proposed,
            ProposalOutcome::Idle { .. } => panic!("registered proposal unexpectedly idle"),
        };
        let incoming = IncomingFrame {
            frame: proposed.frame,
            state_hash: proposed.state_hash,
            frame_hanko: Some(proposed.hanko),
            dispute: None,
        };
        let (registry_key, registry_value, registry_root) =
            leaf_row_words(peer_entity_id, board_hash);
        let registry = hydrate_certified_board_registry(
            &BTreeMap::from([(registry_key, registry_value)]),
            &core(registry_root),
        )
        .expect("checkpoint board registry");
        let entity_key = runtime
            .state
            .e_replicas
            .keys()
            .next()
            .expect("fixture Entity key")
            .clone();
        runtime
            .e_replicas
            .get_mut(&entity_key)
            .expect("fixture Entity replica")
            .install_certified_board_registry(registry);
        let row = AccountInputRow {
            operation_index: 77,
            account_id,
            genesis_policy: None,
            certified_board_authority: AccountInputBoardAuthority::Unresolved,
            local_certified_board_authority: AccountInputBoardAuthority::Unresolved,
            input: AccountInput {
                envelope: AccountInputEnvelope {
                    from_entity_id: peer_entity_id,
                    to_entity_id: owner_entity_id,
                    domain: AccountDomain::new(
                        31_337,
                        DepositoryAddress::parse(&format!("0x{}", "88".repeat(20)))
                            .expect("depository"),
                    )
                    .expect("domain"),
                    dispute_config: AccountDisputeConfig::new(10, 10).expect("dispute config"),
                    watch_seed: Some(
                        WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
                    ),
                },
                kind: AccountInputKind::AckFrame {
                    ack: None,
                    frame: Box::new(incoming),
                },
            },
        };
        let input = crate::RuntimeInput {
            runtime_txs: Vec::new(),
            entity_inputs: vec![crate::RuntimeEntityInput::fixture_with_account_input(
                serde_json::json!({ "registeredBoardFrame": true }),
                row,
            )],
            frame: crate::RuntimeFrameContext {
                timestamp: 200,
                finalized_j_height: 9,
                hub_rebalance_has_pending_work: false,
                entity_contexts: BTreeMap::from([(
                    entity_key.clone(),
                    std::collections::VecDeque::from([crate::RuntimeEntityFrameContext {
                        execution: DeterministicContext::hlt_default(),
                        canonical: CanonicalValue::Object(Vec::new()),
                    }]),
                )]),
            },
        };
        let initial_root = runtime
            .state
            .e_replicas
            .get(&entity_key)
            .expect("fixture Entity state")
            .accounts_root;
        let applied = crate::apply_runtime(runtime, input).expect("registered frame accepted");
        assert_eq!(applied.account_commits.len(), 1);
        assert_eq!(applied.account_commits[0].frame_height, 1);
        assert_ne!(
            applied
                .replica
                .state
                .e_replicas
                .get(&entity_key)
                .expect("applied Entity state")
                .accounts_root,
            initial_root
        );
    }

    #[test]
    fn empty_root_rejects_any_physical_board_row() {
        let (key, value, _) = leaf_row(0x22, 0x33);
        assert!(matches!(
            hydrate_certified_board_registry(
                &BTreeMap::from([(key, value)]),
                &core(empty_root()),
            ),
            Err(CertifiedBoardRegistryRestoreError::Invalid(detail))
                if detail == "ROWS_FOR_EMPTY_ROOT"
        ));
    }
}

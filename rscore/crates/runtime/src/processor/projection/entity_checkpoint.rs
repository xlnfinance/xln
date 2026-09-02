//! Exact TS-readable path-keyed projection of the native-owned Entity slice.

use std::collections::{BTreeMap, BTreeSet};

use num_bigint::{BigInt, Sign};
use serde_json::{Map, Number, Value};
use sha2::{Digest as _, Sha256};
use thiserror::Error;
use xln_rscore_protocol::{
    CanonicalNumber, CanonicalValue, PersistentNodeRecord, PersistentRadixMap,
    encode_canonical_consensus_bytes, pack_path16,
};

use crate::storage::native::{PathNodeChange, PathNodeKey};
use crate::{
    EntityCheckpointProjectionMetadata, EntityFieldProjectionDescriptor,
    EntityTreeProjectionDescriptor, StorageReplicaMetaEntry,
};

const MAX_FIELD_BYTES: usize = 10_000;
const FIELD_CHUNK_BYTES: usize = MAX_FIELD_BYTES - 1;
// Every scalar produced by `EntityStorageProjection::scalar_fields`, plus the
// certified-head hash (8) and retired scalar collection rows (12/13), is
// replaced from the live native Entity on every checkpoint. Omitting a tag
// leaves a stale imported value beside a newer signed Entity root.
const OWNED_FIELD_TAGS: &[u8] = &[
    1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 26, 27, 29, 34, 35,
    36, 37, 38,
];
const OWNED_TREE_TAGS: &[u8] = &[1, 3, 4, 5, 6, 7, 8, 9];
const ORDERBOOK_GRAPH_TAGS: &[u8] = &[0x23, 0x2d, 0x2e];
const CERTIFIED_BOARD_GRAPH_TAG: u8 = 0x2a;

pub(crate) struct PreparedEntityCheckpoint {
    pub(crate) changes: Vec<PathNodeChange>,
    pub(crate) protocol_fingerprint: [u8; 32],
}

pub(crate) fn prepare_entity_checkpoint(
    state: &crate::RuntimeEntityState,
    replica: &crate::RuntimeEntityReplica,
    replica_meta: &StorageReplicaMetaEntry,
    prior: &BTreeMap<Vec<u8>, Vec<u8>>,
) -> Result<PreparedEntityCheckpoint, EntityCheckpointProjectionError> {
    let owner = replica.entity_id;
    let entity_manifest_present = prior.contains_key(&entity_manifest_key(owner));
    let account_meta_present = prior.contains_key(&account_meta_key(owner));
    if entity_manifest_present != account_meta_present {
        return Err(EntityCheckpointProjectionError::CheckpointBaseIncomplete);
    }
    let retained = if entity_manifest_present {
        crate::restore::entity_projection_metadata(prior)?
    } else {
        EntityCheckpointProjectionMetadata::new(owner, Vec::new(), Vec::new())
    };
    if retained.entity_id() != &owner {
        return Err(EntityCheckpointProjectionError::MetadataOwner);
    }
    let protocol_fingerprint = if account_meta_present {
        let stored = crate::restore::checkpoint_protocol_fingerprint(prior, owner)?;
        if stored != replica.protocol_fingerprint {
            return Err(EntityCheckpointProjectionError::ProtocolFingerprint);
        }
        stored
    } else {
        replica.protocol_fingerprint
    };
    let storage =
        xln_rscore_entity_kernel::project_entity_storage(&state.entity, &replica.entity_consensus)?;
    let mut mutations = BTreeMap::<Vec<u8>, Option<Vec<u8>>>::new();
    let mut fields = retained
        .fields()
        .iter()
        .filter(|(tag, _)| !OWNED_FIELD_TAGS.contains(tag))
        .map(|(tag, descriptor)| (*tag, descriptor.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut projected_fields = storage
        .scalar_fields()
        .map(|(tag, value)| (tag, value.clone()))
        .collect::<BTreeMap<_, _>>();
    let certified_head = replica.entity_consensus.certified_frame_head.as_ref();
    match (state.entity.height, certified_head) {
        (0, None) | (1.., Some(_)) => {}
        (0, Some(_)) => {
            return Err(EntityCheckpointProjectionError::GenesisCertifiedHeadForbidden);
        }
        (1.., None) => return Err(EntityCheckpointProjectionError::CertifiedHeadMissing),
    }
    if let Some(certified_head) = certified_head {
        projected_fields.insert(8, CanonicalValue::String(certified_head.frame.hash.clone()));
    }
    if let Some(tag) = projected_fields
        .keys()
        .find(|tag| !OWNED_FIELD_TAGS.contains(tag))
    {
        return Err(EntityCheckpointProjectionError::ProjectedFieldNotOwned(
            *tag,
        ));
    }
    for tag in OWNED_FIELD_TAGS {
        for key in prior
            .keys()
            .filter(|key| is_entity_field_key(key, &owner, *tag))
        {
            mutations.insert(key.clone(), None);
        }
    }
    for (tag, canonical) in projected_fields {
        let bytes = encode_canonical_storage(canonical)?;
        let descriptor = write_field(&mut mutations, owner, tag, bytes)?;
        fields.insert(tag, descriptor);
    }

    let mut trees = retained
        .trees()
        .iter()
        .filter(|(tag, _)| !OWNED_TREE_TAGS.contains(tag))
        .map(|(tag, descriptor)| (*tag, descriptor.clone()))
        .collect::<BTreeMap<_, _>>();
    for tag in OWNED_TREE_TAGS {
        for key in prior
            .keys()
            .filter(|key| is_entity_tree_key(key, &owner, *tag))
        {
            mutations.insert(key.clone(), None);
        }
    }
    for (namespace, tag, present, values) in [
        ("paybookEntries", 1_u8, true, storage.paybook_entries),
        (
            "deferredAccountProposals",
            8_u8,
            storage.deferred_account_proposals_present,
            storage.deferred_account_proposals,
        ),
        (
            "settlementContinuations",
            9_u8,
            storage.settlement_continuations_present,
            storage.settlement_continuations,
        ),
        (
            "crossJurisdictionSwaps",
            3_u8,
            storage.cross_jurisdiction_swaps_present,
            storage.cross_jurisdiction_swaps,
        ),
        (
            "crossJurisdictionAuthorizations",
            4_u8,
            storage.cross_jurisdiction_authorizations_present,
            storage.cross_jurisdiction_authorizations,
        ),
        (
            "pendingCrossJurisdictionFillAcks",
            5_u8,
            storage.pending_cross_jurisdiction_fill_acks_present,
            storage.pending_cross_jurisdiction_fill_acks,
        ),
        (
            "crossJurisdictionBookAdmissions",
            6_u8,
            storage.cross_jurisdiction_book_admissions_present,
            storage.cross_jurisdiction_book_admissions,
        ),
        (
            "crontabHooks",
            7_u8,
            state.entity.crontab.is_some(),
            storage.crontab_hooks,
        ),
    ] {
        if !present {
            continue;
        }
        let descriptor = write_tree(&mut mutations, owner, namespace, tag, values)?;
        trees.insert(tag, descriptor);
    }
    write_orderbook_graph(
        &mut mutations,
        owner,
        state.entity.orderbook.as_ref(),
        prior,
    )?;
    write_certified_board_graph(
        &mut mutations,
        owner,
        state.entity.certified_board_state.as_ref(),
        prior,
    )?;

    let metadata = EntityCheckpointProjectionMetadata::new(
        owner,
        fields.values().cloned().collect(),
        trees.values().cloned().collect(),
    );
    mutations.insert(entity_manifest_key(owner), Some(manifest_bytes(&metadata)?));
    mutations.insert(replica_meta.key.clone(), Some(replica_meta.value.clone()));
    Ok(PreparedEntityCheckpoint {
        changes: mutations
            .into_iter()
            .map(|(key, value)| {
                Ok(PathNodeChange {
                    key: PathNodeKey::new(key)?,
                    value,
                })
            })
            .collect::<Result<_, crate::storage::native::NativeStorageError>>()?,
        protocol_fingerprint,
    })
}

fn write_certified_board_graph(
    changes: &mut BTreeMap<Vec<u8>, Option<Vec<u8>>>,
    owner: [u8; 32],
    state: Option<&xln_rscore_entity_kernel::CertifiedBoardState>,
    prior: &BTreeMap<Vec<u8>, Vec<u8>>,
) -> Result<(), EntityCheckpointProjectionError> {
    for key in prior
        .keys()
        .filter(|key| is_certified_board_graph_key(key, &owner))
    {
        changes.insert(key.clone(), None);
    }
    let Some(state) = state else {
        return Ok(());
    };
    let mut projected_keys = BTreeSet::new();
    for row in xln_rscore_entity_kernel::project_certified_board_storage_nodes(state)? {
        let mut key = vec![CERTIFIED_BOARD_GRAPH_TAG];
        key.extend_from_slice(&owner);
        match row.path {
            xln_rscore_entity_kernel::CertifiedBoardStoragePath::Leaf(logical_key) => {
                key.push(1);
                key.extend_from_slice(&logical_key);
            }
            xln_rscore_entity_kernel::CertifiedBoardStoragePath::Branch { bit, prefix } => {
                key.push(0);
                key.extend_from_slice(&bit.to_be_bytes());
                key.extend_from_slice(&prefix);
            }
        }
        let value = CanonicalValue::Object(vec![
            (
                "version".into(),
                CanonicalValue::Number(CanonicalNumber::from_u32(1)),
            ),
            ("hash".into(), CanonicalValue::String(hex(&row.hash))),
            ("node".into(), row.node),
        ]);
        if !projected_keys.insert(key.clone()) {
            return Err(EntityCheckpointProjectionError::CertifiedBoard(
                "PATH_COLLISION",
            ));
        }
        changes.insert(key, Some(encode_canonical_storage(value)?));
    }
    Ok(())
}

fn write_orderbook_graph(
    changes: &mut BTreeMap<Vec<u8>, Option<Vec<u8>>>,
    owner: [u8; 32],
    orderbook: Option<&xln_rscore_entity_kernel::OrderbookState>,
    prior: &BTreeMap<Vec<u8>, Vec<u8>>,
) -> Result<(), EntityCheckpointProjectionError> {
    for key in prior
        .keys()
        .filter(|key| is_orderbook_graph_key(key, &owner))
    {
        changes.insert(key.clone(), None);
    }
    let Some(orderbook) = orderbook else {
        return Ok(());
    };
    for (pair, book) in &orderbook.books {
        let snapshot = book.snapshot()?;
        write_orderbook_page_tree(changes, owner, pair, 0, &snapshot.bid_pages)?;
        write_orderbook_page_tree(changes, owner, pair, 1, &snapshot.ask_pages)?;
        let params = object([
            (
                "bucketWidthTicks",
                tagged_bigint(&snapshot.bucket_width_ticks),
            ),
            ("maxOrders", safe_number(snapshot.max_orders)?),
            (
                "stpPolicy",
                Value::Number(Number::from(snapshot.stp_policy)),
            ),
        ]);
        let header = object([
            ("params", params),
            (
                "bidRootHash",
                Value::String(snapshot.expected_bid_pages_root),
            ),
            ("bidLeafCount", safe_number(snapshot.bid_pages.len())?),
            (
                "askRootHash",
                Value::String(snapshot.expected_ask_pages_root),
            ),
            ("askLeafCount", safe_number(snapshot.ask_pages.len())?),
            ("nextSeq", safe_u64(snapshot.next_seq)?),
            ("tradeCount", safe_u64(snapshot.trade_count)?),
            ("tradeQtySum", tagged_bigint(&snapshot.trade_qty_sum)),
            (
                "lastTradePriceTicks",
                tagged_bigint(&snapshot.last_trade_price_ticks),
            ),
            (
                "lastAcceptedUsdAskPriceTicks",
                tagged_bigint(&snapshot.last_accepted_usd_ask_price_ticks),
            ),
            ("eventHash", tagged_bigint(&snapshot.event_hash)),
            (
                "commitmentHash",
                Value::String(snapshot.expected_commitment_hash),
            ),
        ]);
        changes.insert(
            orderbook_header_key(owner, pair)?,
            Some(crate::transport::msgpack::encode_framed(&header)?),
        );
    }
    Ok(())
}

fn write_orderbook_page_tree(
    changes: &mut BTreeMap<Vec<u8>, Option<Vec<u8>>>,
    owner: [u8; 32],
    pair: &str,
    side: u8,
    pages: &[xln_rscore_entity_kernel::BookPricePageSnapshot],
) -> Result<(), EntityCheckpointProjectionError> {
    let mut tree = PersistentRadixMap::empty();
    for page in pages {
        let key = orderbook_page_key(&page.price_ticks, page.page_sequence)?;
        let value = orderbook_page_value(page)?;
        tree = tree.updated(key, value, orderbook_page_digest(page)?)?;
    }
    for record in tree.node_records() {
        match record {
            PersistentNodeRecord::Branch { path, children } => {
                let value = object([(
                    "children",
                    Value::Array(
                        children
                            .into_iter()
                            .map(|child| {
                                object([
                                    ("slot", Value::Number(Number::from(child.slot))),
                                    ("kind", Value::String(child.kind.into())),
                                    (
                                        "path",
                                        Value::Array(
                                            child
                                                .path
                                                .into_iter()
                                                .map(|slot| Value::Number(Number::from(slot)))
                                                .collect(),
                                        ),
                                    ),
                                    ("edgeHash", Value::String(hex(&child.edge_hash))),
                                ])
                            })
                            .collect(),
                    ),
                )]);
                changes.insert(
                    orderbook_branch_key(owner, pair, side, &path)?,
                    Some(crate::transport::msgpack::encode_framed(&value)?),
                );
            }
            PersistentNodeRecord::Leaf { key, value, .. } => {
                changes.insert(
                    orderbook_leaf_key(owner, pair, side, &key)?,
                    Some(crate::transport::msgpack::encode_framed(&value)?),
                );
            }
        }
    }
    Ok(())
}

fn tagged_bigint(value: &BigInt) -> Value {
    object([
        ("__xlnType", Value::String("BigInt".into())),
        ("value", Value::String(value.to_string())),
    ])
}

fn orderbook_page_value(
    page: &xln_rscore_entity_kernel::BookPricePageSnapshot,
) -> Result<Value, EntityCheckpointProjectionError> {
    let slots = page
        .slots
        .iter()
        .map(|entry| {
            entry.as_ref().map_or(Ok(Value::Null), |entry| {
                Ok(object([
                    ("orderId", Value::String(entry.order_id.clone())),
                    ("ownerId", Value::String(entry.owner_id.clone())),
                    ("qtyLots", tagged_bigint(&entry.qty_lots)),
                    ("seq", safe_u64(entry.seq)?),
                ]))
            })
        })
        .collect::<Result<Vec<_>, EntityCheckpointProjectionError>>()?;
    Ok(object([
        ("headSlot", safe_number(page.head_slot)?),
        ("nextSlot", safe_number(page.next_slot)?),
        ("liveCount", safe_number(page.live_count)?),
        ("totalQtyLots", tagged_bigint(&page.total_qty_lots)),
        ("slots", Value::Array(slots)),
    ]))
}

fn unsigned_bigint(value: &BigInt) -> Result<Vec<u8>, EntityCheckpointProjectionError> {
    let (sign, mut bytes) = value.to_bytes_be();
    if sign == Sign::Minus {
        return Err(EntityCheckpointProjectionError::Orderbook(
            "NEGATIVE_BIGINT",
        ));
    }
    if bytes.is_empty() {
        bytes.push(0);
    }
    Ok(bytes)
}

fn digest_field(output: &mut Vec<u8>, bytes: &[u8]) -> Result<(), EntityCheckpointProjectionError> {
    let length = u16::try_from(bytes.len())
        .map_err(|_| EntityCheckpointProjectionError::Orderbook("DIGEST_FIELD_LENGTH"))?;
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(bytes);
    Ok(())
}

fn orderbook_page_digest(
    page: &xln_rscore_entity_kernel::BookPricePageSnapshot,
) -> Result<[u8; 32], EntityCheckpointProjectionError> {
    let mut encoded = Vec::new();
    for value in [page.head_slot, page.next_slot, page.live_count] {
        encoded.extend_from_slice(
            &u16::try_from(value)
                .map_err(|_| EntityCheckpointProjectionError::Orderbook("PAGE_COUNTER"))?
                .to_be_bytes(),
        );
    }
    digest_field(&mut encoded, &unsigned_bigint(&page.total_qty_lots)?)?;
    for entry in &page.slots {
        let Some(entry) = entry else {
            encoded.push(0);
            continue;
        };
        encoded.push(1);
        digest_field(&mut encoded, entry.order_id.as_bytes())?;
        digest_field(&mut encoded, entry.owner_id.as_bytes())?;
        digest_field(&mut encoded, &unsigned_bigint(&entry.qty_lots)?)?;
        digest_field(&mut encoded, &unsigned_bigint(&BigInt::from(entry.seq))?)?;
    }
    Ok(Sha256::digest(encoded).into())
}

fn orderbook_page_key(
    price_ticks: &BigInt,
    sequence: u16,
) -> Result<Vec<u8>, EntityCheckpointProjectionError> {
    let bytes = unsigned_bigint(price_ticks)?;
    let length = u8::try_from(bytes.len())
        .map_err(|_| EntityCheckpointProjectionError::Orderbook("PAGE_KEY_LENGTH"))?;
    let mut key = Vec::with_capacity(bytes.len() + 3);
    key.push(length);
    key.extend_from_slice(&bytes);
    key.extend_from_slice(&sequence.to_be_bytes());
    Ok(key)
}

fn orderbook_prefix(
    tag: u8,
    owner: [u8; 32],
    pair: &str,
) -> Result<Vec<u8>, EntityCheckpointProjectionError> {
    let pair = pair.as_bytes();
    let length = u16::try_from(pair.len())
        .map_err(|_| EntityCheckpointProjectionError::Orderbook("PAIR_LENGTH"))?;
    if pair.is_empty() {
        return Err(EntityCheckpointProjectionError::Orderbook("PAIR_EMPTY"));
    }
    let mut key = Vec::with_capacity(35 + pair.len());
    key.push(tag);
    key.extend_from_slice(&owner);
    key.extend_from_slice(&length.to_be_bytes());
    key.extend_from_slice(pair);
    Ok(key)
}

fn orderbook_header_key(
    owner: [u8; 32],
    pair: &str,
) -> Result<Vec<u8>, EntityCheckpointProjectionError> {
    orderbook_prefix(0x23, owner, pair)
}

fn orderbook_branch_key(
    owner: [u8; 32],
    pair: &str,
    side: u8,
    path: &[u8],
) -> Result<Vec<u8>, EntityCheckpointProjectionError> {
    let mut key = orderbook_prefix(0x2d, owner, pair)?;
    key.push(side);
    key.extend_from_slice(
        &pack_path16(path)
            .map_err(|_| EntityCheckpointProjectionError::Orderbook("BRANCH_PATH"))?,
    );
    Ok(key)
}

fn orderbook_leaf_key(
    owner: [u8; 32],
    pair: &str,
    side: u8,
    logical_key: &[u8],
) -> Result<Vec<u8>, EntityCheckpointProjectionError> {
    let mut key = orderbook_prefix(0x2e, owner, pair)?;
    key.push(side);
    key.extend_from_slice(logical_key);
    Ok(key)
}

fn is_orderbook_graph_key(key: &[u8], owner: &[u8; 32]) -> bool {
    key.first()
        .is_some_and(|tag| ORDERBOOK_GRAPH_TAGS.contains(tag))
        && key.get(1..33) == Some(owner)
}

fn is_certified_board_graph_key(key: &[u8], owner: &[u8; 32]) -> bool {
    key.first() == Some(&CERTIFIED_BOARD_GRAPH_TAG) && key.get(1..33) == Some(owner)
}

fn write_field(
    changes: &mut BTreeMap<Vec<u8>, Option<Vec<u8>>>,
    owner: [u8; 32],
    tag: u8,
    bytes: Vec<u8>,
) -> Result<EntityFieldProjectionDescriptor, EntityCheckpointProjectionError> {
    if bytes.is_empty() {
        return Err(EntityCheckpointProjectionError::FieldEmpty(tag));
    }
    let chunks = if bytes.len() < MAX_FIELD_BYTES {
        vec![bytes.as_slice()]
    } else {
        bytes.chunks(FIELD_CHUNK_BYTES).collect()
    };
    let chunk_count = if bytes.len() < MAX_FIELD_BYTES {
        0
    } else {
        chunks.len()
    };
    for (index, chunk) in chunks.into_iter().enumerate() {
        changes.insert(
            entity_field_key(owner, tag, (chunk_count != 0).then_some(index))?,
            Some(chunk.to_vec()),
        );
    }
    Ok(EntityFieldProjectionDescriptor {
        tag,
        value_hash: Sha256::digest(&bytes).into(),
        byte_length: bytes.len(),
        chunk_count,
    })
}

fn write_tree(
    changes: &mut BTreeMap<Vec<u8>, Option<Vec<u8>>>,
    owner: [u8; 32],
    namespace: &str,
    namespace_tag: u8,
    values: BTreeMap<String, CanonicalValue>,
) -> Result<EntityTreeProjectionDescriptor, EntityCheckpointProjectionError> {
    let mut tree = PersistentRadixMap::empty();
    for (key, value) in values {
        let key_bytes = raw_text_key(&key)?;
        let encoded = encode_canonical_consensus_bytes(&value)?;
        tree = tree.updated(key_bytes, value, Sha256::digest(encoded).into())?;
    }
    for record in tree.node_records() {
        match record {
            PersistentNodeRecord::Branch { path, children } => {
                let value = Value::Object(Map::from_iter([(
                    "children".into(),
                    Value::Array(
                        children
                            .into_iter()
                            .map(|child| {
                                Value::Object(Map::from_iter([
                                    ("slot".into(), Value::Number(u64::from(child.slot).into())),
                                    ("kind".into(), Value::String(child.kind.into())),
                                    (
                                        "path".into(),
                                        Value::Array(
                                            child
                                                .path
                                                .into_iter()
                                                .map(|slot| Value::Number(u64::from(slot).into()))
                                                .collect(),
                                        ),
                                    ),
                                    ("edgeHash".into(), Value::String(hex(&child.edge_hash))),
                                ]))
                            })
                            .collect(),
                    ),
                )]));
                changes.insert(
                    entity_tree_branch_key(owner, namespace_tag, &path)?,
                    Some(crate::transport::msgpack::encode_framed(&value)?),
                );
            }
            PersistentNodeRecord::Leaf { key, value, .. } => {
                let text_key = decode_raw_text_key(&key)?;
                let value = Value::Object(Map::from_iter([
                    ("key".into(), Value::String(text_key)),
                    ("value".into(), super::output::canonical_json(value)?),
                ]));
                changes.insert(
                    entity_tree_leaf_key(owner, namespace_tag, &key),
                    Some(crate::transport::msgpack::encode_framed(&value)?),
                );
            }
        }
    }
    Ok(EntityTreeProjectionDescriptor {
        namespace: namespace.into(),
        namespace_tag,
        root: tree.root_hash(),
        leaf_count: tree.len(),
    })
}

fn manifest_bytes(
    metadata: &EntityCheckpointProjectionMetadata,
) -> Result<Vec<u8>, EntityCheckpointProjectionError> {
    let fields = metadata
        .fields()
        .values()
        .map(|field| {
            Ok(object([
                ("tag", Value::Number(u64::from(field.tag).into())),
                ("valueHash", Value::String(hex(&field.value_hash))),
                ("byteLength", safe_number(field.byte_length)?),
                ("chunkCount", safe_number(field.chunk_count)?),
            ]))
        })
        .collect::<Result<Vec<_>, EntityCheckpointProjectionError>>()?;
    let trees = metadata
        .trees()
        .values()
        .map(|tree| {
            Ok(object([
                ("namespace", Value::String(tree.namespace.clone())),
                ("rootHash", Value::String(hex(&tree.root))),
                ("leafCount", safe_number(tree.leaf_count)?),
            ]))
        })
        .collect::<Result<Vec<_>, EntityCheckpointProjectionError>>()?;
    let bytes = crate::transport::msgpack::encode_framed(&object([
        ("schemaVersion", Value::Number(5_u64.into())),
        ("fields", Value::Array(fields)),
        ("trees", Value::Array(trees)),
    ]))?;
    if bytes.len() >= MAX_FIELD_BYTES {
        return Err(EntityCheckpointProjectionError::ManifestBytes(bytes.len()));
    }
    Ok(bytes)
}

fn encode_canonical_storage(
    value: CanonicalValue,
) -> Result<Vec<u8>, EntityCheckpointProjectionError> {
    Ok(crate::transport::msgpack::encode_framed(
        &super::output::canonical_json(value)?,
    )?)
}

fn raw_text_key(value: &str) -> Result<Vec<u8>, EntityCheckpointProjectionError> {
    let bytes = value.as_bytes();
    let len = u16::try_from(bytes.len())
        .map_err(|_| EntityCheckpointProjectionError::TreeKey(bytes.len()))?;
    let mut key = Vec::with_capacity(bytes.len() + 2);
    key.extend_from_slice(&len.to_be_bytes());
    key.extend_from_slice(bytes);
    Ok(key)
}

fn decode_raw_text_key(value: &[u8]) -> Result<String, EntityCheckpointProjectionError> {
    let len = value
        .get(..2)
        .and_then(|bytes| <[u8; 2]>::try_from(bytes).ok())
        .map(u16::from_be_bytes)
        .map(usize::from)
        .ok_or(EntityCheckpointProjectionError::TreeKey(value.len()))?;
    if value.len() != len + 2 {
        return Err(EntityCheckpointProjectionError::TreeKey(value.len()));
    }
    std::str::from_utf8(&value[2..])
        .map(str::to_owned)
        .map_err(|_| EntityCheckpointProjectionError::TreeKey(value.len()))
}

fn entity_manifest_key(owner: [u8; 32]) -> Vec<u8> {
    let mut key = vec![0x21];
    key.extend_from_slice(&owner);
    key
}

fn account_meta_key(owner: [u8; 32]) -> Vec<u8> {
    let mut key = vec![0x17];
    key.extend_from_slice(&owner);
    key
}

fn entity_field_key(
    owner: [u8; 32],
    tag: u8,
    chunk: Option<usize>,
) -> Result<Vec<u8>, EntityCheckpointProjectionError> {
    let mut key = vec![0x36];
    key.extend_from_slice(&owner);
    key.push(tag);
    if let Some(chunk) = chunk {
        key.extend_from_slice(
            &u32::try_from(chunk)
                .map_err(|_| EntityCheckpointProjectionError::FieldChunk(chunk))?
                .to_be_bytes(),
        );
    }
    Ok(key)
}

fn entity_tree_branch_key(
    owner: [u8; 32],
    namespace: u8,
    path: &[u8],
) -> Result<Vec<u8>, EntityCheckpointProjectionError> {
    let mut key = vec![0x37];
    key.extend_from_slice(&owner);
    key.push(namespace);
    key.extend_from_slice(
        &crate::checkpoint_node_key::pack_radix16_path(path)
            .map_err(EntityCheckpointProjectionError::Radix)?,
    );
    Ok(key)
}

fn entity_tree_leaf_key(owner: [u8; 32], namespace: u8, logical_key: &[u8]) -> Vec<u8> {
    let mut key = vec![0x38];
    key.extend_from_slice(&owner);
    key.push(namespace);
    key.extend_from_slice(logical_key);
    key
}

fn is_entity_field_key(key: &[u8], owner: &[u8; 32], tag: u8) -> bool {
    key.first() == Some(&0x36) && key.get(1..33) == Some(owner) && key.get(33) == Some(&tag)
}

fn is_entity_tree_key(key: &[u8], owner: &[u8; 32], tag: u8) -> bool {
    matches!(key.first(), Some(0x37 | 0x38))
        && key.get(1..33) == Some(owner)
        && key.get(33) == Some(&tag)
}

fn safe_number(value: usize) -> Result<Value, EntityCheckpointProjectionError> {
    let value = u64::try_from(value).map_err(|_| EntityCheckpointProjectionError::Number(value))?;
    if value > 9_007_199_254_740_991 {
        return Err(EntityCheckpointProjectionError::Number(value as usize));
    }
    Ok(Value::Number(Number::from(value)))
}

fn safe_u64(value: u64) -> Result<Value, EntityCheckpointProjectionError> {
    if value > 9_007_199_254_740_991 {
        return Err(EntityCheckpointProjectionError::Orderbook("UNSAFE_NUMBER"));
    }
    Ok(Value::Number(Number::from(value)))
}

fn object<const N: usize>(rows: [(&str, Value); N]) -> Value {
    Value::Object(Map::from_iter(
        rows.into_iter().map(|(key, value)| (key.into(), value)),
    ))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2 + 2);
    output.push_str("0x");
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

#[derive(Debug, Error)]
pub(crate) enum EntityCheckpointProjectionError {
    #[error("RRS_CHECKPOINT_BASE_INCOMPLETE")]
    CheckpointBaseIncomplete,
    #[error("RRS_CHECKPOINT_PROTOCOL_FINGERPRINT")]
    ProtocolFingerprint,
    #[error("RRS_CHECKPOINT_ENTITY_METADATA_OWNER")]
    MetadataOwner,
    #[error("RRS_CHECKPOINT_ENTITY_CERTIFIED_HEAD_MISSING")]
    CertifiedHeadMissing,
    #[error("RRS_CHECKPOINT_ENTITY_GENESIS_CERTIFIED_HEAD_FORBIDDEN")]
    GenesisCertifiedHeadForbidden,
    #[error("RRS_CHECKPOINT_ENTITY_PROJECTED_FIELD_NOT_OWNED:{0}")]
    ProjectedFieldNotOwned(u8),
    #[error("RRS_CHECKPOINT_ENTITY_ORDERBOOK:{0}")]
    Orderbook(&'static str),
    #[error("RRS_CHECKPOINT_ENTITY_CERTIFIED_BOARD:{0}")]
    CertifiedBoard(&'static str),
    #[error("RRS_CHECKPOINT_ENTITY_FIELD_EMPTY:{0}")]
    FieldEmpty(u8),
    #[error("RRS_CHECKPOINT_ENTITY_FIELD_CHUNK:{0}")]
    FieldChunk(usize),
    #[error("RRS_CHECKPOINT_ENTITY_TREE_KEY:{0}")]
    TreeKey(usize),
    #[error("RRS_CHECKPOINT_ENTITY_MANIFEST_BYTES:{0}")]
    ManifestBytes(usize),
    #[error("RRS_CHECKPOINT_ENTITY_NUMBER:{0}")]
    Number(usize),
    #[error("RRS_CHECKPOINT_ENTITY_RADIX:{0}")]
    Radix(String),
    #[error(transparent)]
    Kernel(#[from] xln_rscore_entity_kernel::EntityStorageProjectionError),
    #[error(transparent)]
    EntityKernel(#[from] xln_rscore_entity_kernel::EntityKernelError),
    #[error(transparent)]
    Consensus(#[from] xln_rscore_protocol::ConsensusMessagePackError),
    #[error(transparent)]
    RadixMap(#[from] xln_rscore_protocol::PersistentRadixMapError),
    #[error(transparent)]
    Output(#[from] super::EntityOutputEncodingError),
    #[error(transparent)]
    Transport(#[from] crate::transport::RuntimeTransportError),
    #[error(transparent)]
    Storage(#[from] crate::storage::native::NativeStorageError),
    #[error(transparent)]
    EntityRestore(#[from] crate::restore::EntityGraphRestoreError),
    #[error(transparent)]
    AccountRestore(#[from] crate::restore::PathCheckpointRestoreError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use xln_rscore_entity_kernel::BookPricePageEntrySnapshot;

    /// Generated by the canonical TypeScript `BookPricePageTree` from the
    /// same key and page. This pins the physical checkpoint leaf digest to the
    /// live orderbook commitment instead of allowing a second storage formula.
    #[test]
    fn orderbook_checkpoint_page_root_matches_typescript() {
        let page = xln_rscore_entity_kernel::BookPricePageSnapshot {
            price_ticks: BigInt::from(3_333_u16),
            page_sequence: 0,
            head_slot: 0,
            next_slot: 1,
            live_count: 1,
            total_qty_lots: BigInt::from(25_u8),
            slots: std::iter::once(Some(BookPricePageEntrySnapshot {
                order_id: "order-1".into(),
                owner_id: format!("0x{}", "11".repeat(32)),
                qty_lots: BigInt::from(25_u8),
                seq: 7,
            }))
            .chain(std::iter::repeat_n(None, 15))
            .collect(),
        };
        let mut tree = PersistentRadixMap::empty();
        tree = tree
            .updated(
                orderbook_page_key(&page.price_ticks, page.page_sequence).expect("page key"),
                orderbook_page_value(&page).expect("page value"),
                orderbook_page_digest(&page).expect("page digest"),
            )
            .expect("page tree");
        assert_eq!(
            hex(&tree.root_hash()),
            "0x94d0488a3ad0d863be3ba0467040b870a396110f1c4611f3c10df71b663e0a0b",
        );
    }
}

//! Exact inverse of `core/storage/schema/entity/layout.ts` for one Entity.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};
use sha2::{Digest as _, Sha256};
use thiserror::Error;
use xln_rscore_entity_kernel::EntityConsensusSection;

use crate::{
    EntityCheckpointError, EntityCheckpointProjectionMetadata, EntityFieldProjectionDescriptor,
    EntityTreeProjectionDescriptor, StorageMessagePackError, carried_entity_checkpoint_sections,
    decode_storage_payload,
};

use super::entity_tree::{EntityTreeRestoreError, hydrate_entity_tree};

const STORAGE_SCHEMA_VERSION: u64 = 3;
const MAX_ENTITY_STORAGE_VALUE_BYTES: usize = 10_000;
const ENTITY_PATH_TAGS: &[u8] = &[0x21, 0x36, 0x37, 0x38];

#[derive(Debug, Error)]
pub enum EntityGraphRestoreError {
    #[error("RRS_RESTORE_ENTITY_GRAPH:{0}")]
    Invalid(String),
    #[error(transparent)]
    Storage(#[from] StorageMessagePackError),
    #[error(transparent)]
    Tree(#[from] EntityTreeRestoreError),
    #[error(transparent)]
    Checkpoint(#[from] EntityCheckpointError),
}

pub struct HydratedEntityGraph {
    pub entity_id: [u8; 32],
    /// `StorageEntityCoreDoc` in the canonical tagged-JSON boundary form.
    pub core: Value,
    /// Non-E+A consensus sections carried verbatim through Runtime replay.
    pub carried_sections: Vec<EntityConsensusSection>,
}

type FieldDescriptor = EntityFieldProjectionDescriptor;
type TreeDescriptor = EntityTreeProjectionDescriptor;

struct ParsedEntityManifest {
    root_key: Vec<u8>,
    entity_id: [u8; 32],
    fields: Vec<FieldDescriptor>,
    trees: Vec<TreeDescriptor>,
}

fn invalid(detail: impl Into<String>) -> EntityGraphRestoreError {
    EntityGraphRestoreError::Invalid(detail.into())
}

fn object<'a>(
    value: &'a Value,
    path: &str,
) -> Result<&'a Map<String, Value>, EntityGraphRestoreError> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("OBJECT:{path}")))
}

fn exact_fields(
    value: &Map<String, Value>,
    expected: &[&str],
    path: &str,
) -> Result<(), EntityGraphRestoreError> {
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

fn digest(value: &Value, path: &str) -> Result<[u8; 32], EntityGraphRestoreError> {
    let payload = value
        .as_str()
        .and_then(|value| value.strip_prefix("0x"))
        .filter(|value| value.len() == 64)
        .ok_or_else(|| invalid(format!("DIGEST:{path}")))?;
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&payload[index * 2..index * 2 + 2], 16)
            .map_err(|_| invalid(format!("DIGEST:{path}")))?;
    }
    Ok(output)
}

fn safe_usize(value: &Value, path: &str) -> Result<usize, EntityGraphRestoreError> {
    value
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value <= 9_007_199_254_740_991_usize)
        .ok_or_else(|| invalid(format!("UNSIGNED:{path}")))
}

fn field_name(tag: u8) -> Option<&'static str> {
    Some(match tag {
        1 => "entityId",
        2 => "height",
        3 => "timestamp",
        4 => "nonces",
        5 => "entityCommandNonces",
        6 => "proposals",
        7 => "config",
        8 => "prevFrameHash",
        9 => "leaderState",
        10 => "reserves",
        11 => "externalWallet",
        12 => "deferredAccountProposals",
        13 => "settlementContinuations",
        14 => "lastFinalizedJHeight",
        15 => "jHistoryFinality",
        16 => "certifiedBoardState",
        17 => "crontabState",
        18 => "jBatchState",
        19 => "entityProviderActionState",
        20 => "entityEncryptionPublicKey",
        21 => "profile",
        23 => "htlcFeesEarned",
        26 => "outDebtsByToken",
        27 => "inDebtsByToken",
        29 => "swapTradingPairs",
        34 => "hubRebalanceConfig",
        35 => "orderbookHubProfile",
        36 => "orderbookReferrals",
        37 => "orderbookPairDimensions",
        38 => "lending",
        // Tree-backed fields 22, 28 and 30..33 never appear as scalar rows.
        _ => return None,
    })
}

fn namespace(value: &str) -> Option<(&'static str, u8)> {
    Some(match value {
        "htlcRoutes" => ("htlcRoutes", 1),
        "lockBook" => ("lockBook", 2),
        "crossJurisdictionSwaps" => ("crossJurisdictionSwaps", 3),
        "crossJurisdictionAuthorizations" => ("crossJurisdictionAuthorizations", 4),
        "pendingCrossJurisdictionFillAcks" => ("pendingCrossJurisdictionFillAcks", 5),
        "crossJurisdictionBookAdmissions" => ("crossJurisdictionBookAdmissions", 6),
        "crontabHooks" => ("crontabHooks", 7),
        _ => return None,
    })
}

fn field_descriptor(
    value: &Value,
    index: usize,
) -> Result<FieldDescriptor, EntityGraphRestoreError> {
    let row = object(value, "manifest.field")?;
    exact_fields(
        row,
        &["tag", "valueHash", "byteLength", "chunkCount"],
        "manifest.field",
    )?;
    let tag = row
        .get("tag")
        .and_then(Value::as_u64)
        .and_then(|value| u8::try_from(value).ok())
        .filter(|tag| field_name(*tag).is_some())
        .ok_or_else(|| invalid(format!("FIELD_TAG:{index}")))?;
    let byte_length = safe_usize(&row["byteLength"], "field.byteLength")?;
    if byte_length == 0 {
        return Err(invalid(format!("FIELD_BYTES:{index}")));
    }
    let chunk_count = safe_usize(&row["chunkCount"], "field.chunkCount")?;
    let expected_chunks = if byte_length < MAX_ENTITY_STORAGE_VALUE_BYTES {
        0
    } else {
        byte_length.div_ceil(MAX_ENTITY_STORAGE_VALUE_BYTES - 1)
    };
    if chunk_count != expected_chunks {
        return Err(invalid(format!("FIELD_LAYOUT:{index}")));
    }
    Ok(FieldDescriptor {
        tag,
        value_hash: digest(&row["valueHash"], "field.valueHash")?,
        byte_length,
        chunk_count,
    })
}

fn tree_descriptor(value: &Value, index: usize) -> Result<TreeDescriptor, EntityGraphRestoreError> {
    let row = object(value, "manifest.tree")?;
    exact_fields(
        row,
        &["namespace", "rootHash", "leafCount"],
        "manifest.tree",
    )?;
    let name = row
        .get("namespace")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("TREE_NAMESPACE:{index}")))?;
    let (namespace, namespace_tag) =
        namespace(name).ok_or_else(|| invalid(format!("TREE_NAMESPACE:{index}:{name}")))?;
    Ok(TreeDescriptor {
        namespace: namespace.to_string(),
        namespace_tag,
        root: digest(&row["rootHash"], "tree.rootHash")?,
        leaf_count: safe_usize(&row["leafCount"], "tree.leafCount")?,
    })
}

fn field_key(
    owner: &[u8; 32],
    tag: u8,
    chunk: Option<usize>,
) -> Result<Vec<u8>, EntityGraphRestoreError> {
    let mut key = Vec::with_capacity(if chunk.is_some() { 38 } else { 34 });
    key.push(0x36);
    key.extend_from_slice(owner);
    key.push(tag);
    if let Some(chunk) = chunk {
        key.extend_from_slice(
            &u32::try_from(chunk)
                .map_err(|_| invalid("FIELD_CHUNK_INDEX"))?
                .to_be_bytes(),
        );
    }
    Ok(key)
}

fn read_field(
    rows: &BTreeMap<Vec<u8>, Vec<u8>>,
    owner: &[u8; 32],
    descriptor: &FieldDescriptor,
    used: &mut BTreeSet<Vec<u8>>,
) -> Result<Value, EntityGraphRestoreError> {
    let keys = if descriptor.chunk_count == 0 {
        vec![field_key(owner, descriptor.tag, None)?]
    } else {
        (0..descriptor.chunk_count)
            .map(|index| field_key(owner, descriptor.tag, Some(index)))
            .collect::<Result<Vec<_>, _>>()?
    };
    let mut bytes = Vec::with_capacity(descriptor.byte_length);
    for key in keys {
        let row = rows
            .get(&key)
            .ok_or_else(|| invalid(format!("FIELD_MISSING:{}", descriptor.tag)))?;
        bytes.extend_from_slice(row);
        used.insert(key);
    }
    if bytes.len() != descriptor.byte_length
        || <[u8; 32]>::from(Sha256::digest(&bytes)) != descriptor.value_hash
    {
        return Err(invalid(format!("FIELD_INTEGRITY:{}", descriptor.tag)));
    }
    decode_storage_payload(&bytes).map_err(Into::into)
}

fn wrap_core(core: Value) -> Value {
    Value::Object(Map::from_iter([(
        "state".into(),
        Value::Object(Map::from_iter([("core".into(), core)])),
    )]))
}

fn parse_entity_manifest(
    rows: &BTreeMap<Vec<u8>, Vec<u8>>,
) -> Result<ParsedEntityManifest, EntityGraphRestoreError> {
    let roots = rows
        .iter()
        .filter(|(key, _)| key.len() == 33 && key[0] == 0x21)
        .collect::<Vec<_>>();
    let [(root_key, root_bytes)] = roots.as_slice() else {
        return Err(invalid(format!("ROOT_COUNT:{}", roots.len())));
    };
    let entity_id: [u8; 32] = root_key[1..]
        .try_into()
        .map_err(|_| invalid("ROOT_OWNER"))?;
    let manifest = decode_storage_payload(root_bytes)?;
    let manifest = object(&manifest, "manifest")?;
    exact_fields(manifest, &["schemaVersion", "fields", "trees"], "manifest")?;
    if manifest.get("schemaVersion").and_then(Value::as_u64) != Some(STORAGE_SCHEMA_VERSION) {
        return Err(invalid("MANIFEST_VERSION"));
    }
    let fields = manifest
        .get("fields")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("MANIFEST_FIELDS"))?
        .iter()
        .enumerate()
        .map(|(index, value)| field_descriptor(value, index))
        .collect::<Result<Vec<_>, _>>()?;
    if fields.windows(2).any(|pair| pair[0].tag >= pair[1].tag) {
        return Err(invalid("FIELD_ORDER"));
    }
    let trees = manifest
        .get("trees")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("MANIFEST_TREES"))?
        .iter()
        .enumerate()
        .map(|(index, value)| tree_descriptor(value, index))
        .collect::<Result<Vec<_>, _>>()?;
    let mut namespaces = BTreeSet::new();
    if trees
        .iter()
        .any(|tree| !namespaces.insert(tree.namespace_tag))
    {
        return Err(invalid("TREE_DUPLICATE"));
    }
    Ok(ParsedEntityManifest {
        root_key: (*root_key).clone(),
        entity_id,
        fields,
        trees,
    })
}

/// Read the authenticated projection descriptors from the one canonical
/// path-keyed checkpoint graph. Live Runtime state must not retain a second
/// metadata copy merely to rewrite the next checkpoint.
pub(crate) fn entity_projection_metadata(
    rows: &BTreeMap<Vec<u8>, Vec<u8>>,
) -> Result<EntityCheckpointProjectionMetadata, EntityGraphRestoreError> {
    let manifest = parse_entity_manifest(rows)?;
    Ok(EntityCheckpointProjectionMetadata::new(
        manifest.entity_id,
        manifest.fields,
        manifest.trees,
    ))
}

pub fn hydrate_entity_graph(
    rows: &BTreeMap<Vec<u8>, Vec<u8>>,
) -> Result<HydratedEntityGraph, EntityGraphRestoreError> {
    let manifest = parse_entity_manifest(rows)?;
    let entity_id = manifest.entity_id;
    let fields = manifest.fields;
    let trees = manifest.trees;
    let mut used = BTreeSet::from([manifest.root_key]);
    let mut core = Map::new();
    for descriptor in &fields {
        let name = field_name(descriptor.tag).ok_or_else(|| invalid("FIELD_TAG"))?;
        core.insert(
            name.into(),
            read_field(rows, &entity_id, descriptor, &mut used)?,
        );
    }
    for tree in &trees {
        let hydrated = hydrate_entity_tree(
            rows,
            &entity_id,
            tree.namespace_tag,
            &tree.root,
            tree.leaf_count,
        )?;
        used.extend(hydrated.used_keys);
        if tree.namespace == "crontabHooks" {
            let crontab = core
                .get_mut("crontabState")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| invalid("CRONTAB_TASKS_MISSING"))?;
            crontab.insert("hooks".into(), hydrated.tagged_map);
        } else {
            core.insert(tree.namespace.clone(), hydrated.tagged_map);
        }
    }
    let actual_entity_rows = rows
        .keys()
        .filter(|key| ENTITY_PATH_TAGS.contains(&key[0]))
        .cloned()
        .collect::<BTreeSet<_>>();
    if actual_entity_rows != used {
        return Err(invalid("UNREACHABLE_OR_FOREIGN_ROWS"));
    }
    let core = Value::Object(core);
    let carried_sections = carried_entity_checkpoint_sections(&wrap_core(core.clone()))?;
    Ok(HydratedEntityGraph {
        entity_id,
        core,
        carried_sections,
    })
}

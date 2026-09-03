//! Exact path-keyed Entity replay contexts owned by one Runtime frame.
//!
//! Digests authenticate canonical 0x03 + msgpackr bytes but never address
//! storage. Every row stays at its permanent (height, replica, kind, index)
//! path, so rewriting or pruning a Runtime height never leaves a content DAG.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};
use sha2::{Digest as _, Sha256};
use thiserror::Error;

mod rebuild;

const MAX_ENTITY_CONTEXT_PAYLOAD_BYTES: usize = 10_000;
/// TS `MAX_ENTITY_CONTEXT_MANIFEST_BYTES`: the manifest row is bounded on disk
/// (chunked like the frame record); its logical size follows the frame.
const MAX_ENTITY_CONTEXT_MANIFEST_BYTES: usize = 100_000_000;

fn row_byte_limit(kind: EntityContextPayloadKind) -> usize {
    if kind == EntityContextPayloadKind::Manifest {
        MAX_ENTITY_CONTEXT_MANIFEST_BYTES
    } else {
        MAX_ENTITY_CONTEXT_PAYLOAD_BYTES
    }
}
const REFERENCE_PAGE_SIZE: usize = 64;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub(super) const KEY_ENTITY_CONTEXT_PAYLOAD: u8 = 0x14;

pub type EntityContextPayloadDigest = [u8; 32];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum EntityContextPayloadKind {
    Manifest = 0,
    GossipProfile = 1,
    HtlcEntry = 2,
    HtlcOriginated = 3,
    PeerAssertions = 4,
    GossipProfileDigests = 5,
    HtlcEntryDigests = 6,
    HtlcOriginatedDigests = 7,
    PeerAssertionDigests = 8,
}

impl EntityContextPayloadKind {
    fn from_tag(tag: u8) -> Result<Self, EntityContextPayloadError> {
        match tag {
            0 => Ok(Self::Manifest),
            1 => Ok(Self::GossipProfile),
            2 => Ok(Self::HtlcEntry),
            3 => Ok(Self::HtlcOriginated),
            4 => Ok(Self::PeerAssertions),
            5 => Ok(Self::GossipProfileDigests),
            6 => Ok(Self::HtlcEntryDigests),
            7 => Ok(Self::HtlcOriginatedDigests),
            8 => Ok(Self::PeerAssertionDigests),
            _ => Err(EntityContextPayloadError::PathKind(tag)),
        }
    }

    const fn tag(self) -> u8 {
        self as u8
    }

    const fn label(self) -> &'static str {
        match self {
            Self::Manifest => "manifest",
            Self::GossipProfile => "gossipProfile",
            Self::HtlcEntry => "htlcEntry",
            Self::HtlcOriginated => "htlcOriginated",
            Self::PeerAssertions => "peerAssertions",
            Self::GossipProfileDigests => "gossipProfileDigests",
            Self::HtlcEntryDigests => "htlcEntryDigests",
            Self::HtlcOriginatedDigests => "htlcOriginatedDigests",
            Self::PeerAssertionDigests => "peerAssertionDigests",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityContextPayloadRow {
    replica_id: String,
    kind: EntityContextPayloadKind,
    index: u32,
    value: Vec<u8>,
}

impl EntityContextPayloadRow {
    pub fn new(
        replica_id: impl Into<String>,
        kind: EntityContextPayloadKind,
        index: u32,
        value: Vec<u8>,
    ) -> Result<Self, EntityContextPayloadError> {
        let replica_id = replica_id.into();
        validate_replica_id(&replica_id)?;
        validate_canonical_row(&value, row_byte_limit(kind))?;
        Ok(Self {
            replica_id,
            kind,
            index,
            value,
        })
    }

    /// Hot projector boundary: bytes came directly from the canonical encoder
    /// in this crate, so decoding and re-encoding them here would prove the
    /// encoder against itself while copying the entire context again.
    pub(crate) fn projected(
        replica_id: impl Into<String>,
        kind: EntityContextPayloadKind,
        index: u32,
        value: Vec<u8>,
    ) -> Result<Self, EntityContextPayloadError> {
        let replica_id = replica_id.into();
        validate_replica_id(&replica_id)?;
        if value.is_empty() || value.len() >= row_byte_limit(kind) {
            return Err(EntityContextPayloadError::RowBytes(value.len()));
        }
        Ok(Self {
            replica_id,
            kind,
            index,
            value,
        })
    }

    pub fn replica_id(&self) -> &str {
        &self.replica_id
    }

    pub const fn kind(&self) -> EntityContextPayloadKind {
        self.kind
    }

    pub const fn index(&self) -> u32 {
        self.index
    }

    pub fn value(&self) -> &[u8] {
        &self.value
    }

    pub fn key(&self, height: u64) -> Result<Vec<u8>, EntityContextPayloadError> {
        entity_context_payload_key(height, &self.replica_id, self.kind, self.index)
    }
}

/// A complete set of verified v2 context graphs for one Runtime frame.
/// Construction is the only way to obtain the type; callers cannot attach a
/// hand-written entityContextRefs map to a different row set.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EntityContextPayloadRows {
    rows: Vec<EntityContextPayloadRow>,
    frame_refs: Vec<(String, EntityContextPayloadDigest)>,
}

impl EntityContextPayloadRows {
    pub fn empty() -> Self {
        Self::default()
    }

    pub(crate) fn merge(
        parts: impl IntoIterator<Item = Self>,
    ) -> Result<Self, EntityContextPayloadError> {
        let mut graphs =
            BTreeMap::<String, (EntityContextPayloadDigest, Vec<EntityContextPayloadRow>)>::new();
        for part in parts {
            for (replica_id, digest) in part.frame_refs {
                if graphs
                    .insert(replica_id.clone(), (digest, Vec::new()))
                    .is_some()
                {
                    return Err(EntityContextPayloadError::DuplicatePath {
                        replica: replica_id,
                        kind: EntityContextPayloadKind::Manifest.label(),
                        index: 0,
                    });
                }
            }
            for row in part.rows {
                graphs
                    .get_mut(&row.replica_id)
                    .ok_or_else(|| EntityContextPayloadError::Replica(row.replica_id.clone()))?
                    .1
                    .push(row);
            }
        }
        let mut merged = Self::default();
        for (replica_id, (digest, rows)) in graphs {
            // Every part can only be constructed by `validate` or `projected`.
            // Re-decoding and re-hashing its immutable rows here proves the
            // same closed type twice and dominated live projection CPU.
            merged.rows.extend(rows);
            merged.frame_refs.push((replica_id, digest));
        }
        #[cfg(any(test, debug_assertions))]
        {
            let oracle = Self::validate(merged.rows.clone())?;
            assert_eq!(merged, oracle, "RSCORE_MERGED_CONTEXT_ROWS_DIVERGED");
        }
        Ok(merged)
    }

    pub fn validate(rows: Vec<EntityContextPayloadRow>) -> Result<Self, EntityContextPayloadError> {
        let mut grouped = BTreeMap::<String, BTreeMap<RowPath, ValidatedRow>>::new();
        for row in rows {
            // EntityContextPayloadRow has private fields and its constructor
            // already proved canonical bytes. Decode once here for graph
            // traversal; do not pay for a second full canonical re-encode.
            let value = crate::decode_storage_payload(&row.value)
                .map_err(|error| EntityContextPayloadError::RowCodec(error.to_string()))?;
            let path = RowPath {
                kind: row.kind,
                index: row.index,
            };
            let digest = Sha256::digest(&row.value).into();
            let replica = row.replica_id.clone();
            if grouped
                .entry(replica.clone())
                .or_default()
                .insert(path, ValidatedRow { row, value, digest })
                .is_some()
            {
                return Err(EntityContextPayloadError::DuplicatePath {
                    replica,
                    kind: path.kind.label(),
                    index: path.index,
                });
            }
        }

        let mut ordered_rows = Vec::new();
        let mut frame_refs = Vec::new();
        for (replica_id, replica_rows) in grouped {
            let manifest_digest = validate_replica_graph(&replica_id, &replica_rows)?;
            frame_refs.push((replica_id, manifest_digest));
            ordered_rows.extend(replica_rows.into_values().map(|row| row.row));
        }
        Ok(Self {
            rows: ordered_rows,
            frame_refs,
        })
    }

    /// Assemble rows produced by the typed context projector without a second
    /// decode/graph walk. Recovery/import still uses `validate`; test/debug
    /// builds compare this fast path to that full oracle byte-for-byte.
    pub(crate) fn projected(
        mut rows: Vec<EntityContextPayloadRow>,
        replica_id: String,
        manifest_digest: EntityContextPayloadDigest,
    ) -> Result<Self, EntityContextPayloadError> {
        validate_replica_id(&replica_id)?;
        let mut paths = BTreeSet::new();
        let mut manifest_found = false;
        for row in &rows {
            if row.replica_id != replica_id {
                return Err(EntityContextPayloadError::Replica(row.replica_id.clone()));
            }
            let path = RowPath {
                kind: row.kind,
                index: row.index,
            };
            if !paths.insert(path) {
                return Err(EntityContextPayloadError::DuplicatePath {
                    replica: replica_id.clone(),
                    kind: path.kind.label(),
                    index: path.index,
                });
            }
            if path.kind == EntityContextPayloadKind::Manifest && path.index == 0 {
                manifest_found = true;
                if <[u8; 32]>::from(Sha256::digest(&row.value)) != manifest_digest {
                    return Err(EntityContextPayloadError::Digest {
                        replica: replica_id.clone(),
                        kind: path.kind.label(),
                        index: path.index,
                    });
                }
            }
        }
        if !manifest_found {
            return Err(EntityContextPayloadError::Missing {
                replica: replica_id,
                kind: EntityContextPayloadKind::Manifest.label(),
                index: 0,
            });
        }
        rows.sort_by_key(|row| RowPath {
            kind: row.kind,
            index: row.index,
        });
        let projected = Self {
            rows,
            frame_refs: vec![(replica_id, manifest_digest)],
        };
        #[cfg(any(test, debug_assertions))]
        {
            let oracle = Self::validate(projected.rows.clone())?;
            assert_eq!(projected, oracle, "RSCORE_PROJECTED_CONTEXT_ROWS_DIVERGED");
        }
        Ok(projected)
    }

    pub fn rows(&self) -> &[EntityContextPayloadRow] {
        &self.rows
    }

    pub fn frame_refs(&self) -> &[(String, EntityContextPayloadDigest)] {
        &self.frame_refs
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EntityContextPayloadError {
    #[error("RRS_ENTITY_CONTEXT_REPLICA:{0}")]
    Replica(String),
    #[error("RRS_ENTITY_CONTEXT_HEIGHT:{0}")]
    Height(u64),
    #[error("RRS_ENTITY_CONTEXT_PATH_KIND:{0}")]
    PathKind(u8),
    #[error("RRS_ENTITY_CONTEXT_KEY")]
    Key,
    #[error("RRS_ENTITY_CONTEXT_ROW_BYTES:{0}")]
    RowBytes(usize),
    #[error("RRS_ENTITY_CONTEXT_ROW_CODEC:{0}")]
    RowCodec(String),
    #[error("RRS_ENTITY_CONTEXT_ROW_NONCANONICAL")]
    NonCanonical,
    #[error("RRS_ENTITY_CONTEXT_DUPLICATE:{replica}:{kind}:{index}")]
    DuplicatePath {
        replica: String,
        kind: &'static str,
        index: u32,
    },
    #[error("RRS_ENTITY_CONTEXT_MISSING:{replica}:{kind}:{index}")]
    Missing {
        replica: String,
        kind: &'static str,
        index: u32,
    },
    #[error("RRS_ENTITY_CONTEXT_ORPHAN:{replica}:{kind}:{index}")]
    Orphan {
        replica: String,
        kind: &'static str,
        index: u32,
    },
    #[error("RRS_ENTITY_CONTEXT_FIELDS:{0}")]
    Fields(&'static str),
    #[error("RRS_ENTITY_CONTEXT_VALUE:{0}")]
    Value(&'static str),
    #[error("RRS_ENTITY_CONTEXT_DIGEST:{replica}:{kind}:{index}")]
    Digest {
        replica: String,
        kind: &'static str,
        index: u32,
    },
    #[error("RRS_ENTITY_CONTEXT_FRAME_REFS")]
    FrameRefs,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct RowPath {
    kind: EntityContextPayloadKind,
    index: u32,
}

struct ValidatedRow {
    row: EntityContextPayloadRow,
    value: Value,
    digest: EntityContextPayloadDigest,
}

struct Manifest {
    profile_pages: Vec<EntityContextPayloadDigest>,
    peer_assertion_pages: Vec<EntityContextPayloadDigest>,
    htlc_entry_pages: Vec<EntityContextPayloadDigest>,
    htlc_originated_pages: Vec<EntityContextPayloadDigest>,
}

fn validate_canonical_row(
    bytes: &[u8],
    max_bytes: usize,
) -> Result<Value, EntityContextPayloadError> {
    if bytes.is_empty() || bytes.len() >= max_bytes {
        return Err(EntityContextPayloadError::RowBytes(bytes.len()));
    }
    let value = crate::decode_storage_payload(bytes)
        .map_err(|error| EntityContextPayloadError::RowCodec(error.to_string()))?;
    let canonical = crate::transport::msgpack::encode_framed(&value)
        .map_err(|error| EntityContextPayloadError::RowCodec(error.to_string()))?;
    if canonical != bytes {
        return Err(EntityContextPayloadError::NonCanonical);
    }
    Ok(value)
}

fn validate_replica_graph(
    replica_id: &str,
    rows: &BTreeMap<RowPath, ValidatedRow>,
) -> Result<EntityContextPayloadDigest, EntityContextPayloadError> {
    let manifest_path = RowPath {
        kind: EntityContextPayloadKind::Manifest,
        index: 0,
    };
    let manifest_row = required_row(replica_id, rows, manifest_path)?;
    let manifest = decode_manifest(replica_id, &manifest_row.value)?;
    let mut consumed = BTreeSet::from([manifest_path]);
    validate_paged_rows(
        replica_id,
        rows,
        &mut consumed,
        &manifest.profile_pages,
        EntityContextPayloadKind::GossipProfileDigests,
        EntityContextPayloadKind::GossipProfile,
        "gossipProfile",
    )?;
    validate_paged_rows(
        replica_id,
        rows,
        &mut consumed,
        &manifest.peer_assertion_pages,
        EntityContextPayloadKind::PeerAssertionDigests,
        EntityContextPayloadKind::PeerAssertions,
        "peerAssertions",
    )?;
    validate_paged_rows(
        replica_id,
        rows,
        &mut consumed,
        &manifest.htlc_entry_pages,
        EntityContextPayloadKind::HtlcEntryDigests,
        EntityContextPayloadKind::HtlcEntry,
        "htlcEntry",
    )?;
    validate_paged_rows(
        replica_id,
        rows,
        &mut consumed,
        &manifest.htlc_originated_pages,
        EntityContextPayloadKind::HtlcOriginatedDigests,
        EntityContextPayloadKind::HtlcOriginated,
        "htlcOriginated",
    )?;
    if let Some(path) = rows.keys().find(|path| !consumed.contains(path)) {
        return Err(EntityContextPayloadError::Orphan {
            replica: replica_id.to_owned(),
            kind: path.kind.label(),
            index: path.index,
        });
    }
    Ok(manifest_row.digest)
}

#[allow(clippy::too_many_arguments)]
fn validate_paged_rows(
    replica_id: &str,
    rows: &BTreeMap<RowPath, ValidatedRow>,
    consumed: &mut BTreeSet<RowPath>,
    page_digests: &[EntityContextPayloadDigest],
    page_kind: EntityContextPayloadKind,
    leaf_kind: EntityContextPayloadKind,
    child_kind: &'static str,
) -> Result<(), EntityContextPayloadError> {
    let mut leaf_index = 0_u32;
    for (page_index, expected_page_digest) in page_digests.iter().enumerate() {
        let page_index =
            u32::try_from(page_index).map_err(|_| EntityContextPayloadError::Value("pageIndex"))?;
        let page_path = RowPath {
            kind: page_kind,
            index: page_index,
        };
        let page = required_row(replica_id, rows, page_path)?;
        require_digest(replica_id, page_path, &page.digest, expected_page_digest)?;
        consumed.insert(page_path);
        let child_digests = decode_digest_page(&page.value, child_kind)?;
        let is_last = usize::try_from(page_index)
            .ok()
            .is_some_and(|value| value + 1 == page_digests.len());
        if !is_last && child_digests.len() != REFERENCE_PAGE_SIZE {
            return Err(EntityContextPayloadError::Value("digestPage.size"));
        }
        for expected_leaf_digest in child_digests {
            let leaf_path = RowPath {
                kind: leaf_kind,
                index: leaf_index,
            };
            let leaf = required_row(replica_id, rows, leaf_path)?;
            require_digest(replica_id, leaf_path, &leaf.digest, &expected_leaf_digest)?;
            validate_leaf(&leaf.value, leaf_kind)?;
            consumed.insert(leaf_path);
            leaf_index = leaf_index
                .checked_add(1)
                .ok_or(EntityContextPayloadError::Value("leafIndex"))?;
        }
    }
    Ok(())
}

fn required_row<'a>(
    replica_id: &str,
    rows: &'a BTreeMap<RowPath, ValidatedRow>,
    path: RowPath,
) -> Result<&'a ValidatedRow, EntityContextPayloadError> {
    rows.get(&path)
        .ok_or_else(|| EntityContextPayloadError::Missing {
            replica: replica_id.to_owned(),
            kind: path.kind.label(),
            index: path.index,
        })
}

fn require_digest(
    replica_id: &str,
    path: RowPath,
    actual: &EntityContextPayloadDigest,
    expected: &EntityContextPayloadDigest,
) -> Result<(), EntityContextPayloadError> {
    if actual != expected {
        return Err(EntityContextPayloadError::Digest {
            replica: replica_id.to_owned(),
            kind: path.kind.label(),
            index: path.index,
        });
    }
    Ok(())
}

fn decode_manifest(
    applied_replica_id: &str,
    value: &Value,
) -> Result<Manifest, EntityContextPayloadError> {
    let object = exact_object(
        value,
        &[
            "kind",
            "version",
            "header",
            "profilePageDigests",
            "peerAssertionPageDigests",
            "htlcEntryPageDigests",
            "htlcOriginatedPageDigests",
        ],
        "manifest",
    )?;
    require_text(object, "kind", "manifest.kind", Some("entityContext"))?;
    require_version(object, "manifest.version", 2)?;
    validate_header(
        applied_replica_id,
        required(object, "header", "manifest.header")?,
    )?;
    Ok(Manifest {
        profile_pages: digest_array(object, "profilePageDigests")?,
        peer_assertion_pages: digest_array(object, "peerAssertionPageDigests")?,
        htlc_entry_pages: digest_array(object, "htlcEntryPageDigests")?,
        htlc_originated_pages: digest_array(object, "htlcOriginatedPageDigests")?,
    })
}

fn validate_header(
    applied_replica_id: &str,
    value: &Value,
) -> Result<(), EntityContextPayloadError> {
    let object = exact_object(
        value,
        &[
            "version",
            "proposerReplicaId",
            "entityId",
            "proposerSignerId",
            "parentFrameHash",
            "height",
        ],
        "manifest.header",
    )?;
    require_version(object, "manifest.header.version", 1)?;
    let proposer_replica = require_text(
        object,
        "proposerReplicaId",
        "manifest.header.proposerReplicaId",
        None,
    )?;
    validate_replica_id(proposer_replica)?;
    let entity_id = require_text(object, "entityId", "manifest.header.entityId", None)?;
    validate_fixed_hex(entity_id, 32, "manifest.header.entityId")?;
    let proposer_signer = require_text(
        object,
        "proposerSignerId",
        "manifest.header.proposerSignerId",
        None,
    )?;
    if proposer_replica != format!("{entity_id}:{proposer_signer}") {
        return Err(EntityContextPayloadError::Value(
            "manifest.header.proposerReplicaId",
        ));
    }
    let applied_entity = applied_replica_id
        .split(':')
        .next()
        .ok_or(EntityContextPayloadError::Value("manifest.header.entityId"))?;
    if applied_entity != entity_id {
        return Err(EntityContextPayloadError::Value(
            "manifest.header.appliedEntityId",
        ));
    }
    let parent = require_text(
        object,
        "parentFrameHash",
        "manifest.header.parentFrameHash",
        None,
    )?;
    if parent != "genesis" {
        validate_fixed_hex(parent, 32, "manifest.header.parentFrameHash")?;
    }
    required(object, "height", "manifest.header.height")?
        .as_u64()
        .filter(|height| (1..=MAX_SAFE_INTEGER).contains(height))
        .ok_or(EntityContextPayloadError::Value("manifest.header.height"))?;
    Ok(())
}

fn decode_digest_page(
    value: &Value,
    expected_child_kind: &'static str,
) -> Result<Vec<EntityContextPayloadDigest>, EntityContextPayloadError> {
    let object = exact_object(
        value,
        &["kind", "version", "childKind", "digests"],
        "digestPage",
    )?;
    require_text(object, "kind", "digestPage.kind", Some("digestPage"))?;
    require_version(object, "digestPage.version", 2)?;
    require_text(
        object,
        "childKind",
        "digestPage.childKind",
        Some(expected_child_kind),
    )?;
    let digests = digest_array(object, "digests")?;
    if digests.is_empty() || digests.len() > REFERENCE_PAGE_SIZE {
        return Err(EntityContextPayloadError::Value("digestPage.digests"));
    }
    Ok(digests)
}

fn validate_leaf(
    value: &Value,
    kind: EntityContextPayloadKind,
) -> Result<(), EntityContextPayloadError> {
    let (payload_field, label) = match kind {
        EntityContextPayloadKind::GossipProfile => ("profile", "gossipProfile"),
        EntityContextPayloadKind::HtlcEntry => ("entry", "htlcEntry"),
        EntityContextPayloadKind::HtlcOriginated => ("originated", "htlcOriginated"),
        EntityContextPayloadKind::PeerAssertions => ("assertions", "peerAssertions"),
        _ => return Err(EntityContextPayloadError::Value("leaf.kind")),
    };
    let object = exact_object(value, &["kind", "version", payload_field], "leaf")?;
    require_text(object, "kind", "leaf.kind", Some(label))?;
    require_version(object, "leaf.version", 2)?;
    let payload = required(object, payload_field, "leaf.payload")?;
    if kind == EntityContextPayloadKind::PeerAssertions {
        payload
            .as_array()
            .map(Vec::len)
            .filter(|count| (1..=REFERENCE_PAGE_SIZE).contains(count))
            .ok_or(EntityContextPayloadError::Value(
                "peerAssertions.assertions",
            ))?;
    }
    Ok(())
}

fn exact_object<'a>(
    value: &'a Value,
    expected: &[&str],
    path: &'static str,
) -> Result<&'a Map<String, Value>, EntityContextPayloadError> {
    let object = value
        .as_object()
        .ok_or(EntityContextPayloadError::Fields(path))?;
    let actual = object.keys().map(String::as_str).collect::<BTreeSet<_>>();
    let expected = expected.iter().copied().collect::<BTreeSet<_>>();
    if actual != expected {
        return Err(EntityContextPayloadError::Fields(path));
    }
    Ok(object)
}

fn required<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    path: &'static str,
) -> Result<&'a Value, EntityContextPayloadError> {
    object
        .get(field)
        .ok_or(EntityContextPayloadError::Fields(path))
}

fn require_text<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    path: &'static str,
    expected: Option<&str>,
) -> Result<&'a str, EntityContextPayloadError> {
    let value = required(object, field, path)?
        .as_str()
        .ok_or(EntityContextPayloadError::Value(path))?;
    if expected.is_some_and(|expected| value != expected) {
        return Err(EntityContextPayloadError::Value(path));
    }
    Ok(value)
}

fn require_version(
    object: &Map<String, Value>,
    path: &'static str,
    expected: u64,
) -> Result<(), EntityContextPayloadError> {
    if object.get("version").and_then(Value::as_u64) != Some(expected) {
        return Err(EntityContextPayloadError::Value(path));
    }
    Ok(())
}

fn digest_array(
    object: &Map<String, Value>,
    field: &'static str,
) -> Result<Vec<EntityContextPayloadDigest>, EntityContextPayloadError> {
    object
        .get(field)
        .and_then(Value::as_array)
        .ok_or(EntityContextPayloadError::Value(field))?
        .iter()
        .map(|value| parse_digest(value, field))
        .collect()
}

fn parse_digest(
    value: &Value,
    path: &'static str,
) -> Result<EntityContextPayloadDigest, EntityContextPayloadError> {
    let text = value
        .as_str()
        .ok_or(EntityContextPayloadError::Value(path))?;
    let raw = text
        .strip_prefix("0x")
        .filter(|raw| raw.len() == 64 && raw.bytes().all(is_lower_hex))
        .ok_or(EntityContextPayloadError::Value(path))?;
    let mut digest = [0_u8; 32];
    for (index, byte) in digest.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&raw[index * 2..index * 2 + 2], 16)
            .map_err(|_| EntityContextPayloadError::Value(path))?;
    }
    Ok(digest)
}

fn validate_replica_id(replica_id: &str) -> Result<(), EntityContextPayloadError> {
    if replica_id != replica_id.to_lowercase() {
        return Err(EntityContextPayloadError::Replica(replica_id.to_owned()));
    }
    let parts = replica_id.split(':').collect::<Vec<_>>();
    if !(parts.len() == 2 || parts.len() == 3)
        || !valid_fixed_hex(parts[0], 32)
        || !valid_fixed_hex(parts[1], 20)
        || parts.get(2).is_some_and(|cohort| {
            let bytes = cohort.as_bytes();
            bytes.is_empty()
                || !matches!(bytes.first(), Some(b'1'..=b'9'))
                || !bytes.iter().all(u8::is_ascii_digit)
        })
    {
        return Err(EntityContextPayloadError::Replica(replica_id.to_owned()));
    }
    Ok(())
}

fn validate_fixed_hex(
    value: &str,
    bytes: usize,
    path: &'static str,
) -> Result<(), EntityContextPayloadError> {
    if !valid_fixed_hex(value, bytes) {
        return Err(EntityContextPayloadError::Value(path));
    }
    Ok(())
}

fn valid_fixed_hex(value: &str, bytes: usize) -> bool {
    value
        .strip_prefix("0x")
        .is_some_and(|raw| raw.len() == bytes * 2 && raw.bytes().all(is_lower_hex))
}

fn is_lower_hex(value: u8) -> bool {
    value.is_ascii_digit() || (b'a'..=b'f').contains(&value)
}

pub(super) fn entity_context_payload_key(
    height: u64,
    replica_id: &str,
    kind: EntityContextPayloadKind,
    index: u32,
) -> Result<Vec<u8>, EntityContextPayloadError> {
    if height == 0 {
        return Err(EntityContextPayloadError::Height(height));
    }
    validate_replica_id(replica_id)?;
    let replica = replica_id.as_bytes();
    let replica_len = u16::try_from(replica.len())
        .map_err(|_| EntityContextPayloadError::Replica(replica_id.to_owned()))?;
    let mut key = Vec::with_capacity(16 + replica.len());
    key.push(KEY_ENTITY_CONTEXT_PAYLOAD);
    key.extend_from_slice(&height.to_be_bytes());
    key.extend_from_slice(&replica_len.to_be_bytes());
    key.extend_from_slice(replica);
    key.push(kind.tag());
    key.extend_from_slice(&index.to_be_bytes());
    Ok(key)
}

pub(crate) fn entity_context_height_prefix(
    height: u64,
) -> Result<[u8; 9], EntityContextPayloadError> {
    if height == 0 {
        return Err(EntityContextPayloadError::Height(height));
    }
    let mut prefix = [0_u8; 9];
    prefix[0] = KEY_ENTITY_CONTEXT_PAYLOAD;
    prefix[1..].copy_from_slice(&height.to_be_bytes());
    Ok(prefix)
}

pub(crate) fn parse_entity_context_payload_key(
    key: &[u8],
) -> Result<(u64, String, EntityContextPayloadKind, u32), EntityContextPayloadError> {
    if key.len() < 16 || key.first() != Some(&KEY_ENTITY_CONTEXT_PAYLOAD) {
        return Err(EntityContextPayloadError::Key);
    }
    let height = u64::from_be_bytes(
        key[1..9]
            .try_into()
            .map_err(|_| EntityContextPayloadError::Key)?,
    );
    if height == 0 {
        return Err(EntityContextPayloadError::Height(height));
    }
    let replica_len = usize::from(u16::from_be_bytes(
        key[9..11]
            .try_into()
            .map_err(|_| EntityContextPayloadError::Key)?,
    ));
    let expected_len = 16_usize
        .checked_add(replica_len)
        .ok_or(EntityContextPayloadError::Key)?;
    if key.len() != expected_len {
        return Err(EntityContextPayloadError::Key);
    }
    let replica_end = 11 + replica_len;
    let replica_id = std::str::from_utf8(&key[11..replica_end])
        .map_err(|_| EntityContextPayloadError::Key)?
        .to_owned();
    validate_replica_id(&replica_id)?;
    let kind = EntityContextPayloadKind::from_tag(key[replica_end])?;
    let index = u32::from_be_bytes(
        key[replica_end + 1..]
            .try_into()
            .map_err(|_| EntityContextPayloadError::Key)?,
    );
    Ok((height, replica_id, kind, index))
}

pub(super) fn frame_entity_context_refs(
    frame_bytes: &[u8],
) -> Result<Vec<(String, EntityContextPayloadDigest)>, EntityContextPayloadError> {
    let frame = crate::decode_storage_payload(frame_bytes)
        .map_err(|error| EntityContextPayloadError::RowCodec(error.to_string()))?;
    let object = frame
        .as_object()
        .ok_or(EntityContextPayloadError::FrameRefs)?;
    let Some(value) = object.get("entityContextRefs") else {
        return Ok(Vec::new());
    };
    let refs = exact_object(value, &["__xlnType", "value"], "entityContextRefs")?;
    require_text(refs, "__xlnType", "entityContextRefs", Some("Map"))?;
    let rows = refs
        .get("value")
        .and_then(Value::as_array)
        .ok_or(EntityContextPayloadError::FrameRefs)?;
    let mut result = Vec::with_capacity(rows.len());
    let mut previous = None::<String>;
    for row in rows {
        let pair = row
            .as_array()
            .filter(|pair| pair.len() == 2)
            .ok_or(EntityContextPayloadError::FrameRefs)?;
        let replica = pair[0]
            .as_str()
            .ok_or(EntityContextPayloadError::FrameRefs)?
            .to_owned();
        validate_replica_id(&replica)?;
        if previous
            .as_ref()
            .is_some_and(|previous| previous >= &replica)
        {
            return Err(EntityContextPayloadError::FrameRefs);
        }
        previous = Some(replica.clone());
        result.push((replica, parse_digest(&pair[1], "entityContextRefs.digest")?));
    }
    Ok(result)
}

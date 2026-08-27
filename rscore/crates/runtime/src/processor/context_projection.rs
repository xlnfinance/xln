//! Canonical v1 Entity context to path-keyed v2 WAL rows.

use serde_json::{Map, Value};
use sha2::{Digest as _, Sha256};
use thiserror::Error;
use xln_rscore_protocol::CanonicalValue;

use crate::storage::native::{
    EntityContextPayloadError, EntityContextPayloadKind, EntityContextPayloadRow,
    EntityContextPayloadRows,
};

const PAGE_SIZE: usize = 64;

pub(crate) fn prepare_entity_context_rows(
    applied_replica_id: &str,
    context: &CanonicalValue,
) -> Result<EntityContextPayloadRows, EntityContextProjectionError> {
    let context = super::output::canonical_json(context.clone())?;
    let source = context
        .as_object()
        .ok_or(EntityContextProjectionError::ContextObject)?;
    exact_fields(
        source,
        &[
            "entityId",
            "gossipProfiles",
            "height",
            "htlc",
            "parentFrameHash",
            "peerAssertions",
            "proposerReplicaId",
            "proposerSignerId",
            "version",
        ],
        "context",
    )?;
    let entity_id = text(source, "entityId")?;
    if applied_replica_id.split(':').next() != Some(entity_id) {
        return Err(EntityContextProjectionError::ReplicaBinding);
    }
    let height = source
        .get("height")
        .and_then(Value::as_u64)
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or(EntityContextProjectionError::ContextHeight)?;
    // Multiple certified Entity frames from one replica may commit in one
    // Runtime frame. TS binds each context by applied replica + Entity height.
    let applied_replica_id = format!("{applied_replica_id}:{height}");
    let mut rows = Vec::new();
    let profile_digests = leaf_rows(
        &mut rows,
        &applied_replica_id,
        EntityContextPayloadKind::GossipProfile,
        array(source, "gossipProfiles")?,
        "gossipProfile",
        "profile",
    )?;
    let htlc = source
        .get("htlc")
        .and_then(Value::as_object)
        .ok_or(EntityContextProjectionError::HtlcObject)?;
    exact_fields(htlc, &["entries", "originated", "version"], "htlc")?;
    let htlc_entry_digests = leaf_rows(
        &mut rows,
        &applied_replica_id,
        EntityContextPayloadKind::HtlcEntry,
        array(htlc, "entries")?,
        "htlcEntry",
        "entry",
    )?;
    let htlc_originated_digests = leaf_rows(
        &mut rows,
        &applied_replica_id,
        EntityContextPayloadKind::HtlcOriginated,
        array(htlc, "originated")?,
        "htlcOriginated",
        "originated",
    )?;
    let peer_assertion_digests = chunked_leaf_rows(
        &mut rows,
        &applied_replica_id,
        EntityContextPayloadKind::PeerAssertions,
        array(source, "peerAssertions")?,
    )?;
    let profile_pages = digest_pages(
        &mut rows,
        &applied_replica_id,
        EntityContextPayloadKind::GossipProfileDigests,
        "gossipProfile",
        &profile_digests,
    )?;
    let peer_pages = digest_pages(
        &mut rows,
        &applied_replica_id,
        EntityContextPayloadKind::PeerAssertionDigests,
        "peerAssertions",
        &peer_assertion_digests,
    )?;
    let entry_pages = digest_pages(
        &mut rows,
        &applied_replica_id,
        EntityContextPayloadKind::HtlcEntryDigests,
        "htlcEntry",
        &htlc_entry_digests,
    )?;
    let originated_pages = digest_pages(
        &mut rows,
        &applied_replica_id,
        EntityContextPayloadKind::HtlcOriginatedDigests,
        "htlcOriginated",
        &htlc_originated_digests,
    )?;
    let header = object([
        ("version", required(source, "version")?.clone()),
        (
            "proposerReplicaId",
            required(source, "proposerReplicaId")?.clone(),
        ),
        ("entityId", required(source, "entityId")?.clone()),
        (
            "proposerSignerId",
            required(source, "proposerSignerId")?.clone(),
        ),
        (
            "parentFrameHash",
            required(source, "parentFrameHash")?.clone(),
        ),
        ("height", required(source, "height")?.clone()),
    ]);
    rows.push(row(
        &applied_replica_id,
        EntityContextPayloadKind::Manifest,
        0,
        object([
            ("kind", Value::String("entityContext".into())),
            ("version", Value::from(2)),
            ("header", header),
            ("profilePageDigests", digests_value(&profile_pages)),
            ("peerAssertionPageDigests", digests_value(&peer_pages)),
            ("htlcEntryPageDigests", digests_value(&entry_pages)),
            (
                "htlcOriginatedPageDigests",
                digests_value(&originated_pages),
            ),
        ]),
    )?);
    EntityContextPayloadRows::validate(rows).map_err(EntityContextProjectionError::from)
}

fn leaf_rows(
    rows: &mut Vec<EntityContextPayloadRow>,
    replica_id: &str,
    path_kind: EntityContextPayloadKind,
    values: &[Value],
    kind: &str,
    payload_field: &str,
) -> Result<Vec<[u8; 32]>, EntityContextProjectionError> {
    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let index =
                u32::try_from(index).map_err(|_| EntityContextProjectionError::Index(index))?;
            let row = row(
                replica_id,
                path_kind,
                index,
                Value::Object(Map::from_iter([
                    ("kind".into(), Value::String(kind.into())),
                    ("version".into(), Value::from(2)),
                    (payload_field.into(), value.clone()),
                ])),
            )?;
            let digest = Sha256::digest(row.value()).into();
            rows.push(row);
            Ok(digest)
        })
        .collect()
}

fn chunked_leaf_rows(
    rows: &mut Vec<EntityContextPayloadRow>,
    replica_id: &str,
    kind: EntityContextPayloadKind,
    values: &[Value],
) -> Result<Vec<[u8; 32]>, EntityContextProjectionError> {
    values
        .chunks(PAGE_SIZE)
        .enumerate()
        .map(|(index, chunk)| {
            let index =
                u32::try_from(index).map_err(|_| EntityContextProjectionError::Index(index))?;
            let row = row(
                replica_id,
                kind,
                index,
                object([
                    ("kind", Value::String("peerAssertions".into())),
                    ("version", Value::from(2)),
                    ("assertions", Value::Array(chunk.to_vec())),
                ]),
            )?;
            let digest = Sha256::digest(row.value()).into();
            rows.push(row);
            Ok(digest)
        })
        .collect()
}

fn digest_pages(
    rows: &mut Vec<EntityContextPayloadRow>,
    replica_id: &str,
    path_kind: EntityContextPayloadKind,
    child_kind: &str,
    digests: &[[u8; 32]],
) -> Result<Vec<[u8; 32]>, EntityContextProjectionError> {
    digests
        .chunks(PAGE_SIZE)
        .enumerate()
        .map(|(index, chunk)| {
            let index =
                u32::try_from(index).map_err(|_| EntityContextProjectionError::Index(index))?;
            let row = row(
                replica_id,
                path_kind,
                index,
                object([
                    ("kind", Value::String("digestPage".into())),
                    ("version", Value::from(2)),
                    ("childKind", Value::String(child_kind.into())),
                    ("digests", digests_value(chunk)),
                ]),
            )?;
            let digest = Sha256::digest(row.value()).into();
            rows.push(row);
            Ok(digest)
        })
        .collect()
}

fn row(
    replica_id: &str,
    kind: EntityContextPayloadKind,
    index: u32,
    value: Value,
) -> Result<EntityContextPayloadRow, EntityContextProjectionError> {
    let encoded = crate::transport::msgpack::encode_framed(&value)?;
    EntityContextPayloadRow::new(replica_id, kind, index, encoded)
        .map_err(EntityContextProjectionError::from)
}

fn digests_value(digests: &[[u8; 32]]) -> Value {
    Value::Array(
        digests
            .iter()
            .map(|digest| Value::String(hex(digest)))
            .collect(),
    )
}

fn exact_fields(
    object: &Map<String, Value>,
    expected: &[&str],
    path: &'static str,
) -> Result<(), EntityContextProjectionError> {
    if object.len() == expected.len()
        && object
            .keys()
            .all(|field| expected.contains(&field.as_str()))
    {
        Ok(())
    } else {
        Err(EntityContextProjectionError::Fields(path))
    }
}

fn required<'a>(
    object: &'a Map<String, Value>,
    field: &'static str,
) -> Result<&'a Value, EntityContextProjectionError> {
    object
        .get(field)
        .ok_or(EntityContextProjectionError::Fields(field))
}

fn text<'a>(
    object: &'a Map<String, Value>,
    field: &'static str,
) -> Result<&'a str, EntityContextProjectionError> {
    required(object, field)?
        .as_str()
        .ok_or(EntityContextProjectionError::Fields(field))
}

fn array<'a>(
    object: &'a Map<String, Value>,
    field: &'static str,
) -> Result<&'a [Value], EntityContextProjectionError> {
    required(object, field)?
        .as_array()
        .map(Vec::as_slice)
        .ok_or(EntityContextProjectionError::Fields(field))
}

fn object<const N: usize>(entries: [(&str, Value); N]) -> Value {
    Value::Object(Map::from_iter(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value)),
    ))
}

fn hex(bytes: &[u8; 32]) -> String {
    bytes.iter().fold(String::from("0x"), |mut text, byte| {
        use std::fmt::Write as _;
        let _ = write!(text, "{byte:02x}");
        text
    })
}

#[derive(Debug, Error)]
pub(crate) enum EntityContextProjectionError {
    #[error("RRS_ENTITY_CONTEXT_PROJECTION_OBJECT")]
    ContextObject,
    #[error("RRS_ENTITY_CONTEXT_PROJECTION_HTLC_OBJECT")]
    HtlcObject,
    #[error("RRS_ENTITY_CONTEXT_PROJECTION_FIELDS:{0}")]
    Fields(&'static str),
    #[error("RRS_ENTITY_CONTEXT_PROJECTION_REPLICA_BINDING")]
    ReplicaBinding,
    #[error("RRS_ENTITY_CONTEXT_PROJECTION_HEIGHT")]
    ContextHeight,
    #[error("RRS_ENTITY_CONTEXT_PROJECTION_INDEX:{0}")]
    Index(usize),
    #[error(transparent)]
    Output(#[from] super::EntityOutputEncodingError),
    #[error(transparent)]
    Storage(#[from] EntityContextPayloadError),
    #[error(transparent)]
    Transport(#[from] crate::transport::RuntimeTransportError),
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn exact_context_is_split_and_revalidated_as_v2_rows() {
        let entity = format!("0x{}", "11".repeat(32));
        let signer = format!("0x{}", "22".repeat(20));
        let replica = format!("{entity}:{signer}");
        let source = json!({
            "version":1,"proposerReplicaId":replica,"entityId":entity,
            "proposerSignerId":signer,"parentFrameHash":"genesis","height":1,
            "gossipProfiles":[],"peerAssertions":[],
            "htlc":{"version":1,"entries":[],"originated":[]}
        });
        let canonical = crate::canonical_value_from_tagged_json(&source).expect("context");
        let rows = prepare_entity_context_rows(&replica, &canonical).expect("rows");
        assert_eq!(rows.rows().len(), 1);
        assert_eq!(rows.frame_refs().len(), 1);
        assert_eq!(rows.frame_refs()[0].0, format!("{replica}:1"));
    }
}

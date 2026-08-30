//! Canonical Entity context to path-keyed WAL rows.

use sha2::{Digest as _, Sha256};
use thiserror::Error;
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use crate::storage::native::{
    EntityContextPayloadError, EntityContextPayloadKind, EntityContextPayloadRow,
    EntityContextPayloadRows,
};

const PAGE_SIZE: usize = 64;

pub(crate) fn prepare_entity_context_rows(
    applied_replica_id: &str,
    context: &CanonicalValue,
) -> Result<EntityContextPayloadRows, EntityContextProjectionError> {
    let source = object_ref(context).ok_or(EntityContextProjectionError::ContextObject)?;
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
        .iter()
        .find(|(field, _)| field == "height")
        .and_then(|(_, value)| number_u64(value))
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
        .iter()
        .find(|(field, _)| field == "htlc")
        .and_then(|(_, value)| object_ref(value))
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
    let manifest = row(
        &applied_replica_id,
        EntityContextPayloadKind::Manifest,
        0,
        object([
            ("kind", CanonicalValue::String("entityContext".into())),
            ("version", number(2)),
            ("header", header),
            ("profilePageDigests", digests_value(&profile_pages)),
            ("peerAssertionPageDigests", digests_value(&peer_pages)),
            ("htlcEntryPageDigests", digests_value(&entry_pages)),
            (
                "htlcOriginatedPageDigests",
                digests_value(&originated_pages),
            ),
        ]),
    )?;
    let manifest_digest = Sha256::digest(manifest.value()).into();
    rows.push(manifest);
    EntityContextPayloadRows::projected(rows, applied_replica_id, manifest_digest)
        .map_err(EntityContextProjectionError::from)
}

fn leaf_rows(
    rows: &mut Vec<EntityContextPayloadRow>,
    replica_id: &str,
    path_kind: EntityContextPayloadKind,
    values: &[CanonicalValue],
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
                CanonicalValue::Object(vec![
                    ("kind".into(), CanonicalValue::String(kind.into())),
                    ("version".into(), number(2)),
                    (payload_field.into(), value.clone()),
                ]),
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
    values: &[CanonicalValue],
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
                    ("kind", CanonicalValue::String("peerAssertions".into())),
                    ("version", number(2)),
                    ("assertions", CanonicalValue::Array(chunk.to_vec())),
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
                    ("kind", CanonicalValue::String("digestPage".into())),
                    ("version", number(2)),
                    ("childKind", CanonicalValue::String(child_kind.into())),
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
    value: CanonicalValue,
) -> Result<EntityContextPayloadRow, EntityContextProjectionError> {
    // Keep the existing storage encoder as the byte authority.  The win here
    // is eliminating the eager clone of the entire context; each projected
    // leaf is converted exactly once when its owning row is encoded.
    let value = super::output::canonical_json(value)?;
    let encoded = crate::transport::msgpack::encode_framed(&value)?;
    EntityContextPayloadRow::projected(replica_id, kind, index, encoded)
        .map_err(EntityContextProjectionError::from)
}

fn digests_value(digests: &[[u8; 32]]) -> CanonicalValue {
    CanonicalValue::Array(
        digests
            .iter()
            .map(|digest| CanonicalValue::String(hex(digest)))
            .collect(),
    )
}

fn exact_fields(
    object: &[(String, CanonicalValue)],
    expected: &[&str],
    path: &'static str,
) -> Result<(), EntityContextProjectionError> {
    if object.len() == expected.len()
        && expected
            .iter()
            .all(|expected| object.iter().filter(|(field, _)| field == expected).count() == 1)
    {
        Ok(())
    } else {
        Err(EntityContextProjectionError::Fields(path))
    }
}

fn required<'a>(
    object: &'a [(String, CanonicalValue)],
    field: &'static str,
) -> Result<&'a CanonicalValue, EntityContextProjectionError> {
    object
        .iter()
        .find(|(name, _)| name == field)
        .map(|(_, value)| value)
        .ok_or(EntityContextProjectionError::Fields(field))
}

fn text<'a>(
    object: &'a [(String, CanonicalValue)],
    field: &'static str,
) -> Result<&'a str, EntityContextProjectionError> {
    match required(object, field)? {
        CanonicalValue::String(value) => Ok(value),
        _ => Err(EntityContextProjectionError::Fields(field)),
    }
}

fn array<'a>(
    object: &'a [(String, CanonicalValue)],
    field: &'static str,
) -> Result<&'a [CanonicalValue], EntityContextProjectionError> {
    match required(object, field)? {
        CanonicalValue::Array(values) => Ok(values),
        _ => Err(EntityContextProjectionError::Fields(field)),
    }
}

fn object<const N: usize>(entries: [(&str, CanonicalValue); N]) -> CanonicalValue {
    CanonicalValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

fn object_ref(value: &CanonicalValue) -> Option<&[(String, CanonicalValue)]> {
    match value {
        CanonicalValue::Object(entries) => Some(entries),
        _ => None,
    }
}

fn number(value: u32) -> CanonicalValue {
    CanonicalValue::Number(CanonicalNumber::from_u32(value))
}

fn number_u64(value: &CanonicalValue) -> Option<u64> {
    match value {
        CanonicalValue::Number(value) => value.as_str().parse().ok(),
        _ => None,
    }
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

    #[test]
    fn two_entity_heights_in_one_runtime_frame_keep_distinct_context_paths() {
        let entity = format!("0x{}", "33".repeat(32));
        let signer = format!("0x{}", "44".repeat(20));
        let replica = format!("{entity}:{signer}");
        let context = |height| {
            crate::canonical_value_from_tagged_json(&json!({
                "version":1,"proposerReplicaId":replica,"entityId":entity,
                "proposerSignerId":signer,"parentFrameHash":"genesis","height":height,
                "gossipProfiles":[],"peerAssertions":[],
                "htlc":{"version":1,"entries":[],"originated":[]}
            }))
            .expect("context")
        };
        let merged = EntityContextPayloadRows::merge([
            prepare_entity_context_rows(&replica, &context(46)).expect("height 46"),
            prepare_entity_context_rows(&replica, &context(47)).expect("height 47"),
        ])
        .expect("distinct paths");

        assert_eq!(merged.frame_refs().len(), 2);
        assert_eq!(merged.frame_refs()[0].0, format!("{replica}:46"));
        assert_eq!(merged.frame_refs()[1].0, format!("{replica}:47"));
    }
}

//! Restore complete Entity contexts from one already-verified path graph.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

use super::{EntityContextPayloadError, EntityContextPayloadKind, EntityContextPayloadRows};

impl EntityContextPayloadRows {
    /// Rebuild the exact logical contexts represented by these permanent
    /// `(height, replica, kind, index)` rows. `validate` has already proved the
    /// manifest/page/leaf graph; restore performs no database lookup by hash.
    pub fn rebuild_contexts(&self) -> Result<BTreeMap<String, Value>, EntityContextPayloadError> {
        let mut replicas = BTreeSet::new();
        for row in self.rows() {
            replicas.insert(row.replica_id().to_owned());
        }
        replicas
            .into_iter()
            .map(|replica| Ok((replica.clone(), rebuild_one(self, &replica)?)))
            .collect()
    }
}

fn rebuild_one(
    rows: &EntityContextPayloadRows,
    replica: &str,
) -> Result<Value, EntityContextPayloadError> {
    let values = rows
        .rows()
        .iter()
        .filter(|row| row.replica_id() == replica)
        .map(|row| {
            let value = crate::decode_storage_payload(row.value())
                .map_err(|error| EntityContextPayloadError::RowCodec(error.to_string()))?;
            Ok(((row.kind(), row.index()), value))
        })
        .collect::<Result<BTreeMap<_, _>, EntityContextPayloadError>>()?;
    let manifest = values
        .get(&(EntityContextPayloadKind::Manifest, 0))
        .and_then(Value::as_object)
        .ok_or(EntityContextPayloadError::Value("manifest"))?;
    let mut context = manifest
        .get("header")
        .and_then(Value::as_object)
        .cloned()
        .ok_or(EntityContextPayloadError::Value("manifest.header"))?;
    context.insert(
        "gossipProfiles".into(),
        Value::Array(leaf_values(
            &values,
            EntityContextPayloadKind::GossipProfile,
            "profile",
        )?),
    );
    context.insert(
        "peerAssertions".into(),
        Value::Array(flatten_pages(
            &values,
            EntityContextPayloadKind::PeerAssertions,
            "assertions",
        )?),
    );
    context.insert(
        "htlc".into(),
        Value::Object(Map::from_iter([
            ("version".into(), Value::from(1)),
            (
                "entries".into(),
                Value::Array(leaf_values(
                    &values,
                    EntityContextPayloadKind::HtlcEntry,
                    "entry",
                )?),
            ),
            (
                "originated".into(),
                Value::Array(leaf_values(
                    &values,
                    EntityContextPayloadKind::HtlcOriginated,
                    "originated",
                )?),
            ),
        ])),
    );
    Ok(Value::Object(context))
}

fn leaf_values(
    values: &BTreeMap<(EntityContextPayloadKind, u32), Value>,
    kind: EntityContextPayloadKind,
    field: &'static str,
) -> Result<Vec<Value>, EntityContextPayloadError> {
    values
        .iter()
        .filter(|((row_kind, _), _)| *row_kind == kind)
        .map(|(_, value)| {
            value
                .as_object()
                .and_then(|object| object.get(field))
                .cloned()
                .ok_or(EntityContextPayloadError::Value(field))
        })
        .collect()
}

fn flatten_pages(
    values: &BTreeMap<(EntityContextPayloadKind, u32), Value>,
    kind: EntityContextPayloadKind,
    field: &'static str,
) -> Result<Vec<Value>, EntityContextPayloadError> {
    let mut output = Vec::new();
    for (_, value) in values.iter().filter(|((row_kind, _), _)| *row_kind == kind) {
        output.extend(
            value
                .as_object()
                .and_then(|object| object.get(field))
                .and_then(Value::as_array)
                .ok_or(EntityContextPayloadError::Value(field))?
                .iter()
                .cloned(),
        );
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::storage::native::EntityContextPayloadRow;

    #[test]
    fn verified_path_rows_rebuild_the_exact_logical_context() {
        let entity = format!("0x{}", "11".repeat(32));
        let signer = format!("0x{}", "22".repeat(20));
        let replica = format!("{entity}:{signer}");
        let header = json!({
            "version": 1,
            "proposerReplicaId": replica,
            "entityId": entity,
            "proposerSignerId": signer,
            "parentFrameHash": "genesis",
            "height": 1,
        });
        let manifest = json!({
            "kind": "entityContext",
            "version": 2,
            "header": header,
            "profilePageDigests": [],
            "peerAssertionPageDigests": [],
            "htlcEntryPageDigests": [],
            "htlcOriginatedPageDigests": [],
        });
        let bytes = crate::transport::msgpack::encode_framed(&manifest).expect("manifest bytes");
        let rows = EntityContextPayloadRows::validate(vec![
            EntityContextPayloadRow::new(
                replica.clone(),
                EntityContextPayloadKind::Manifest,
                0,
                bytes,
            )
            .expect("manifest row"),
        ])
        .expect("verified graph");

        assert_eq!(
            rows.rebuild_contexts().expect("rebuilt")[&replica],
            json!({
                "version": 1,
                "proposerReplicaId": replica,
                "entityId": entity,
                "proposerSignerId": signer,
                "parentFrameHash": "genesis",
                "height": 1,
                "gossipProfiles": [],
                "peerAssertions": [],
                "htlc": { "version": 1, "entries": [], "originated": [] },
            }),
        );
    }
}

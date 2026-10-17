use std::collections::BTreeMap;
use std::process::Command;

use super::{entity_key, processor_replica};

#[test]
fn current_typescript_storage_schema_round_trip() {
    let mut replica = processor_replica();
    let key = entity_key(&replica);
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let output = Command::new("bun")
        .current_dir(&root)
        .args([
            "core/__tests__/fixtures/storage/native/schema-roundtrip.ts",
            "emit",
            &format!("0x{}", hex::encode(key.entity_id)),
            &key.signer_id,
        ])
        .output()
        .expect("run production TypeScript storage encoder");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let fixture: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("TS fixture JSON");
    let mut rows = fixture["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (
                hex::decode(row[0].as_str().unwrap()).unwrap(),
                hex::decode(row[1].as_str().unwrap()).unwrap(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let graph = crate::restore::hydrate_entity_graph(&rows)
        .expect("current TS Entity graph must hydrate in Rust");
    assert_eq!(graph.entity_id, key.entity_id);
    let manifest_key = [vec![0x21], key.entity_id.to_vec()].concat();
    let mut obsolete = rows.clone();
    obsolete.insert(
        manifest_key.clone(),
        hex::decode(fixture["oldManifest"].as_str().unwrap()).unwrap(),
    );
    let error = match crate::restore::hydrate_entity_graph(&obsolete) {
        Err(error) => error,
        Ok(_) => panic!("old schema five manifest must fail before hydration"),
    };
    assert_eq!(
        error.to_string(),
        "RRS_RESTORE_ENTITY_GRAPH:MANIFEST_VERSION:expected=6:actual=Some(5)"
    );

    let state = replica.state.e_replicas.get_mut(&key).unwrap();
    let snapshot = crate::restore::entity_snapshot_from_graph(
        &graph,
        state.entity.known_accounts.iter().cloned().collect(),
        state.accounts_root,
        None,
    )
    .expect("restore actual TS Entity fields");
    state.entity = xln_rscore_entity_kernel::restore_entity_state(
        snapshot,
        state.accounts_root,
        state.entity.known_accounts.len(),
    )
    .expect("install restored Entity state");
    let live = replica.e_replicas.get_mut(&key).unwrap();
    live.entity_consensus.state.sections = graph.carried_sections.clone();
    let accounts = super::super::checkpoint_projection::prepare_account_checkpoint(
        &live.accounts.export_checkpoint().unwrap(),
        key.entity_id,
        live.protocol_fingerprint,
        &rows,
    )
    .expect("current Account checkpoint metadata");
    for row in accounts.changes {
        if let Some(value) = row.value {
            rows.insert(row.key.into_bytes(), value);
        }
    }
    let meta = crate::StorageReplicaMetaEntry {
        key: [
            vec![0x26],
            key.entity_id.to_vec(),
            vec![0; 12],
            hex::decode(&key.signer_id[2..]).unwrap(),
        ]
        .concat(),
        value: crate::transport::msgpack::encode_framed(&live.replica_metadata).unwrap(),
    };
    let projected = super::super::entity_checkpoint_projection::prepare_entity_checkpoint(
        state, live, &meta, &rows,
    )
    .expect("project hydrated current Entity through production checkpoint writer");
    for row in projected.changes {
        match row.value {
            Some(value) => {
                rows.insert(row.key.into_bytes(), value);
            }
            None => {
                rows.remove(row.key.as_bytes());
            }
        }
    }
    let projected_graph =
        crate::restore::hydrate_entity_graph(&rows).expect("rehydrate projected graph");
    assert_eq!(projected_graph.core["reserves"], graph.core["reserves"]);
    assert_eq!(projected_graph.core["profile"], graph.core["profile"]);
    assert_eq!(projected_graph.core["entityId"], graph.core["entityId"]);
    use std::io::Write;
    use std::process::Stdio;
    let mut child = Command::new("bun")
        .current_dir(&root)
        .args([
            "core/__tests__/fixtures/storage/native/schema-roundtrip.ts",
            "manifest",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("run production TS manifest decoder");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(hex::encode(rows.get(&manifest_key).unwrap()).as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        "TS_CURRENT_MANIFEST_ACCEPTED"
    );
}

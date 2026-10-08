use super::*;

fn checkpoint_frame() -> Value {
    // Actual immutable cross-j R4 checkpoint, Runtime height 22. These are
    // the complete inputs of the canonical Runtime hash, not replay outputs.
    serde_json::json!({"canonicalEntityHashes": [
        {
            "entityId": "0xea62f299eab5d7eaa2d863cab432a228e1d119a8ee44d495423d46d496769728",
            "hash": "0xf76c7ae7de7928f1ec4eab6d6f05f9d5f27358725c591e84f34c62f879673218",
            "cellCount": 1
        },
        {
            "entityId": "0xf9f90e03903d6799aa09180adde108405afc545407c13032a9cd06577ea5b6b8",
            "hash": "0xf6cebdf3336dce81ecdca6cf82b7fb9a505cd4e184c8ac3220bae8b77e82b2ec",
            "cellCount": 1
        }
    ]})
}

#[test]
fn cross_j_checkpoint_22_reconstructs_the_root_from_both_entities() {
    let entries = checkpoint_entity_hashes(&checkpoint_frame()).expect("two checkpoint owners");
    assert_eq!(entries.len(), 2);
    let actual = compute_canonical_runtime_state_hash(22, 1_788_569_031_627, &entries)
        .expect("canonical Runtime root");
    assert_eq!(
        actual,
        "0x8ee0687144f8402e4544f7b40581e748c68cb528af1d10264180ae26777f4304"
    );
    assert_ne!(
        compute_canonical_runtime_state_hash(22, 1_788_569_031_627, &entries[..1]).unwrap(),
        actual,
    );
}

#[test]
fn checkpoint_rejects_duplicate_entity_owners() {
    let mut frame = checkpoint_frame();
    frame["canonicalEntityHashes"][1] = frame["canonicalEntityHashes"][0].clone();
    assert!(
        checkpoint_entity_hashes(&frame)
            .unwrap_err()
            .starts_with("RUNTIME_REPLAY_CHECKPOINT_DUPLICATE_ENTITY_ID:")
    );
}

#[test]
fn accounts_roots_preserve_every_entity_and_signer_owner() {
    use xln_rscore_entity_kernel::EntityStateSlice;
    use xln_rscore_runtime::{RuntimeEntityKey, RuntimeState};

    let slots = [
        ([1; 32], "alice", [11; 32]),
        ([2; 32], "bob", [22; 32]),
        ([1; 32], "carol", [33; 32]),
    ];
    let mut state = RuntimeState {
        height: 22,
        timestamp: 1_788_569_031_627,
        finalized_j_height: 0,
        e_replicas: slots
            .iter()
            .map(|(entity_id, signer, root)| {
                (
                    RuntimeEntityKey::new(*entity_id, signer).unwrap(),
                    RuntimeEntityState {
                        accounts_root: *root,
                        entity: EntityStateSlice::empty(hex(entity_id), 1_788_569_031_627),
                    },
                )
            })
            .collect(),
    };
    let expected = BTreeMap::from([
        (format!("{}:alice", hex(&[1; 32])), hex(&[11; 32])),
        (format!("{}:bob", hex(&[2; 32])), hex(&[22; 32])),
        (format!("{}:carol", hex(&[1; 32])), hex(&[33; 32])),
    ]);
    assert_eq!(accounts_roots(&state), expected);
    state
        .e_replicas
        .remove(&RuntimeEntityKey::new([2; 32], "bob").unwrap());
    assert_ne!(
        accounts_roots(&state),
        expected,
        "restart must detect an omitted second owner"
    );
}

#[test]
fn actual_tron_jurisdiction_only_checkpoint_reconstructs_empty_owner_root() {
    let entries =
        checkpoint_entity_hashes(&serde_json::json!({"canonicalEntityHashes":[]})).unwrap();
    assert!(entries.is_empty());
    assert_eq!(
        compute_canonical_runtime_state_hash(1, 1791406735110, &entries).unwrap(),
        "0x41ec607e267c0f496f3be298256d77877f3a05b4b6044912b49455328c48a5e9"
    );
    assert!(checkpoint_entity_hashes(&serde_json::json!({})).is_err());
}

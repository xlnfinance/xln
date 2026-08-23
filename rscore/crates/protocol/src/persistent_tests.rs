use crate::{PersistentNodeRecord, PersistentRadixMap};

fn digest(byte: u8) -> [u8; 32] {
    [byte; 32]
}

fn root_hex(map: &PersistentRadixMap<[u8; 32]>) -> String {
    hex::encode(map.root_hash())
}

#[test]
fn matches_typescript_persistent_root_sequence() {
    let empty = PersistentRadixMap::empty();
    let one = empty
        .updated(vec![0x12], digest(1), digest(1))
        .expect("one");
    let two = one.updated(vec![0x1f], digest(2), digest(2)).expect("two");
    let changed = two
        .updated(vec![0x12], digest(3), digest(3))
        .expect("changed");
    let removed = changed.removed(&[0x1f]);
    assert_eq!(root_hex(&empty), "00".repeat(32));
    assert_eq!(
        root_hex(&one),
        "3612ad7fb17df6a27d0d50291e1f11b6150f9614505fe9254ad734a7f1c61edb",
    );
    assert_eq!(
        root_hex(&two),
        "e82863df10afb7be72d389027367fc2ad7bc16e74fbe8227a15884c920c206f7",
    );
    assert_eq!(
        root_hex(&changed),
        "533c9d20d082224c783c46e829406b37ebf458b7f4851f57945deba8ccee8f08",
    );
    assert_eq!(
        root_hex(&removed),
        "5cfc156151b8d22dde3a6bb90a049fd45d186c2f355e3fee4d70ca97ca17b3ae",
    );
    assert_eq!(changed.get(&[0x12]), Some(&digest(3)));
    assert_eq!(changed.get(&[0x1f]), Some(&digest(2)));
}

#[test]
fn matches_typescript_node_record_and_change_order() {
    let one = PersistentRadixMap::empty()
        .updated(vec![0x12], digest(1), digest(1))
        .expect("one");
    let two = one.updated(vec![0x1f], digest(2), digest(2)).expect("two");
    let changed = two
        .updated(vec![0x12], digest(3), digest(3))
        .expect("changed");
    let records = two.node_records();
    assert_eq!(records.len(), 4);
    assert!(matches!(
        &records[0],
        PersistentNodeRecord::Branch { path, children }
            if path.is_empty() && children.len() == 1 && children[0].slot == 1
    ));
    assert!(matches!(
        &records[1],
        PersistentNodeRecord::Branch { path, children }
            if path == &[1] && children.iter().map(|child| child.slot).collect::<Vec<_>>() == [2, 15]
    ));
    assert!(matches!(
        &records[2],
        PersistentNodeRecord::Leaf { path, key, value }
            if path == &[1, 2] && key == &[0x12] && value == &digest(1)
    ));
    let changes = changed.node_changes_since(&two);
    assert_eq!(changes.puts.len(), 3);
    assert!(changes.dels.is_empty());
    assert!(matches!(
        &changes.puts[2],
        PersistentNodeRecord::Leaf { path, key, value }
            if path == &[1, 2] && key == &[0x12] && value == &digest(3)
    ));
}

#[test]
fn deletion_emits_only_unreachable_nodes() {
    let one = PersistentRadixMap::empty()
        .updated(vec![0x12], digest(1), digest(1))
        .expect("one");
    let two = one.updated(vec![0x1f], digest(2), digest(2)).expect("two");
    let removed = two.removed(&[0x1f]);
    let changes = removed.node_changes_since(&two);
    assert!(!changes.puts.is_empty());
    assert_eq!(changes.dels.len(), 2);
}

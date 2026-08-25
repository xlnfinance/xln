use crate::{PersistentNodeRecord, PersistentRadixMap, SlotWork};

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
    assert_eq!(
        changed.get_with_digest(&[0x12]),
        Some((&digest(3), digest(3)))
    );
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

fn sequential_slots<V: Clone, const N: usize>(
    slots: [SlotWork<V>; N],
) -> [Result<crate::SlotOutcome<V>, crate::PersistentRadixMapError>; N] {
    slots.map(SlotWork::apply)
}

#[test]
fn two_level_batch_matches_serial_with_compressed_children() {
    let mut base = PersistentRadixMap::empty();
    for (key, byte) in [
        (vec![0x12, 0x34], 1),
        (vec![0x20, 0x00], 2),
        (vec![0x34, 0x50], 3),
        (vec![0x34, 0x5f], 4),
    ] {
        base = base.updated(key, digest(byte), digest(byte)).expect("base");
    }
    let updates = vec![
        (vec![0x12, 0x34], digest(11), digest(11)),
        (vec![0x1f, 0x00], digest(12), digest(12)),
        (vec![0x34, 0xa0], digest(13), digest(13)),
        (vec![0xfe, 0xdc], digest(14), digest(14)),
    ];
    let mut serial = base.clone();
    for (key, value, value_digest) in updates.clone() {
        serial = serial
            .updated(key, value, value_digest)
            .expect("serial update");
    }
    let batched = base
        .updated_batch_two_levels(updates, sequential_slots)
        .expect("two-level update");
    assert_eq!(batched.len(), serial.len());
    assert_eq!(batched.root_hash(), serial.root_hash());
    assert_eq!(batched.get(&[0x12, 0x34]), Some(&digest(11)));
    assert_eq!(batched.get(&[0xfe, 0xdc]), Some(&digest(14)));
}

#[test]
fn two_level_batch_matches_serial_for_large_replacements_and_inserts() {
    let mut base = PersistentRadixMap::empty();
    for index in 0_u16..768 {
        let key = vec![index as u8, (index >> 8) as u8, 0x55];
        base = base
            .updated(key, digest(index as u8), digest(index as u8))
            .expect("base");
    }
    let updates = (256_u16..1_280)
        .map(|index| {
            let key = vec![index as u8, (index >> 8) as u8, 0x55];
            let byte = (index as u8).wrapping_add(17);
            (key, digest(byte), digest(byte))
        })
        .collect::<Vec<_>>();
    let mut serial = base.clone();
    for (key, value, value_digest) in updates.clone() {
        serial = serial
            .updated(key, value, value_digest)
            .expect("serial update");
    }
    let batched = base
        .updated_batch_two_levels(updates, sequential_slots)
        .expect("two-level update");
    assert_eq!(batched.len(), serial.len());
    assert_eq!(batched.root_hash(), serial.root_hash());
    for index in 256_u16..1_280 {
        let key = [index as u8, (index >> 8) as u8, 0x55];
        let byte = (index as u8).wrapping_add(17);
        assert_eq!(batched.get(&key), Some(&digest(byte)));
    }
}

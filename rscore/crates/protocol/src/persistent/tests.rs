use crate::persistent::{
    PERSISTENT_RADIX_SHARD_COUNT, PersistentRadixMapError, PersistentRadixOverlayWork,
    PersistentRadixShard, PersistentRadixShardCoordinator,
};
use crate::{
    PersistentNodeRecord, PersistentRadixMap, PersistentRadixMutation, SlotWork,
    encode_raw_text_key,
};

fn digest(byte: u8) -> [u8; 32] {
    [byte; 32]
}

fn root_hex(map: &PersistentRadixMap<[u8; 32]>) -> String {
    hex::encode(map.root_hash())
}

fn account_key(prefix: usize, discriminator: u32) -> Vec<u8> {
    assert!(prefix < PERSISTENT_RADIX_SHARD_COUNT);
    let mut key = vec![0_u8; 32];
    key[0] = (prefix >> 4) as u8;
    key[1] = ((prefix & 0x0f) as u8) << 4;
    key[28..].copy_from_slice(&discriminator.to_be_bytes());
    key
}

fn entries(map: &PersistentRadixMap<[u8; 32]>) -> Vec<(Vec<u8>, [u8; 32])> {
    map.iter()
        .map(|(key, value)| (key.to_vec(), *value))
        .collect()
}

fn assert_exact_map(
    actual: &PersistentRadixMap<[u8; 32]>,
    expected: &PersistentRadixMap<[u8; 32]>,
) {
    assert_eq!(actual.len(), expected.len());
    assert_eq!(actual.root_hash(), expected.root_hash());
    assert_eq!(entries(actual), entries(expected));
    assert_eq!(actual.node_records(), expected.node_records());
}

fn top_records(map: &PersistentRadixMap<[u8; 32]>) -> Vec<PersistentNodeRecord<()>> {
    map.node_records()
        .into_iter()
        .filter_map(|record| match record {
            PersistentNodeRecord::Branch { path, children } if path.len() < 3 => {
                Some(PersistentNodeRecord::Branch { path, children })
            }
            _ => None,
        })
        .collect()
}

fn assert_value_free_coordinator_type(_: &PersistentRadixShardCoordinator) {}

#[test]
fn shard_envelope_replacement_preserves_commitment_and_updates_value() {
    let key = account_key(0x7ff, 1);
    let committed = digest(7);
    let shard = PersistentRadixShard::empty(0x7ff)
        .expect("empty shard")
        .updated(key.clone(), "before", committed)
        .expect("insert");
    let descriptor = shard.descriptor();
    let root = shard.root_hash();

    let replaced = shard
        .replaced_value(key.clone(), "after", committed)
        .expect("replace envelope");

    assert_eq!(replaced.get(&key).expect("lookup"), Some(&"after"));
    assert_eq!(replaced.root_hash(), root);
    assert_eq!(replaced.descriptor(), descriptor);
    assert_eq!(replaced.len(), shard.len());
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
    let removed = changed.removed(&[0x1f]).expect("remove");
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
    let removed = two.removed(&[0x1f]).expect("remove");
    let changes = removed.node_changes_since(&two);
    assert!(!changes.puts.is_empty());
    assert_eq!(changes.dels.len(), 2);
}

fn sequential_slots<V: Clone, const N: usize>(
    slots: [SlotWork<V>; N],
) -> [Result<crate::SlotOutcome<V>, crate::PersistentRadixMapError>; N] {
    slots.map(SlotWork::apply)
}

fn sequential_slot_vec<V: Clone>(
    slots: Vec<SlotWork<V>>,
) -> Vec<Result<crate::SlotOutcome<V>, crate::PersistentRadixMapError>> {
    slots.into_iter().map(SlotWork::apply).collect()
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

#[test]
fn two_level_mutation_batch_matches_serial_puts_and_removes() {
    let mut base = PersistentRadixMap::empty();
    for (key, byte) in [
        (vec![0x12, 0x34], 1),
        (vec![0x12, 0x56], 2),
        (vec![0xab, 0xcd], 3),
        (vec![0xfe, 0xdc], 4),
    ] {
        base = base.updated(key, digest(byte), digest(byte)).expect("base");
    }
    let mut serial = base.clone();
    serial = serial.removed(&[0x12, 0x34]).expect("remove existing");
    serial = serial.removed(&[0x44, 0x44]).expect("remove missing");
    serial = serial
        .updated(vec![0xab, 0xcd], digest(13), digest(13))
        .expect("replace");
    serial = serial
        .updated(vec![0x44, 0x44], digest(14), digest(14))
        .expect("insert");
    serial = serial.removed(&[0xfe, 0xdc]).expect("remove lone prefix");

    let batched = base
        .mutated_batch_two_levels(
            vec![
                PersistentRadixMutation::Remove {
                    key: vec![0x12, 0x34],
                },
                PersistentRadixMutation::Remove {
                    key: vec![0x44, 0x44],
                },
                PersistentRadixMutation::Put {
                    key: vec![0xab, 0xcd],
                    value: digest(13),
                    value_digest: digest(13),
                },
                PersistentRadixMutation::Put {
                    key: vec![0x44, 0x44],
                    value: digest(14),
                    value_digest: digest(14),
                },
                PersistentRadixMutation::Remove {
                    key: vec![0xfe, 0xdc],
                },
            ],
            sequential_slots,
        )
        .expect("two-level mutations");

    assert_exact_map(&batched, &serial);
}

#[test]
fn three_level_batch_matches_serial_across_every_prefix() {
    let mut base = PersistentRadixMap::empty();
    for prefix in 0_u16..4096 {
        let key = vec![(prefix >> 4) as u8, ((prefix as u8) & 0x0f) << 4, 0x55];
        base = base
            .updated(key, digest(prefix as u8), digest(prefix as u8))
            .expect("base");
    }
    let updates = (0_u16..4096)
        .map(|prefix| {
            let key = vec![
                (prefix >> 4) as u8,
                (((prefix as u8) & 0x0f) << 4) | 0x0a,
                0x55,
            ];
            let byte = (prefix as u8).wrapping_add(37);
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
        .updated_batch_three_levels(updates, sequential_slot_vec)
        .expect("three-level update");
    assert_eq!(batched.len(), serial.len());
    assert_eq!(batched.root_hash(), serial.root_hash());
}

#[test]
fn three_level_batch_builds_an_empty_tree_in_parallel_shape() {
    let updates = (0_u16..4096)
        .map(|prefix| {
            let key = vec![(prefix >> 4) as u8, ((prefix as u8) & 0x0f) << 4, 0x55];
            (key, digest(prefix as u8), digest(prefix as u8))
        })
        .collect::<Vec<_>>();
    let mut serial = PersistentRadixMap::empty();
    for (key, value, value_digest) in updates.clone() {
        serial = serial
            .updated(key, value, value_digest)
            .expect("serial update");
    }
    let batched = PersistentRadixMap::empty()
        .updated_batch_three_levels(updates, sequential_slot_vec)
        .expect("three-level update");
    assert_eq!(batched.len(), serial.len());
    assert_eq!(batched.root_hash(), serial.root_hash());
}

#[test]
fn three_level_batch_matches_serial_with_compressed_children_and_replacements() {
    let mut base = PersistentRadixMap::empty();
    for (key, byte) in [
        (vec![0x12, 0x34], 1),
        (vec![0x12, 0x3f], 2),
        (vec![0x12, 0x40], 3),
        (vec![0xfe, 0xdc], 4),
    ] {
        base = base.updated(key, digest(byte), digest(byte)).expect("base");
    }
    let updates = vec![
        (vec![0x12, 0x34], digest(11), digest(11)),
        (vec![0x12, 0x3a], digest(12), digest(12)),
        (vec![0x12, 0x4f], digest(13), digest(13)),
        (vec![0xab, 0xcd], digest(14), digest(14)),
    ];
    let mut serial = base.clone();
    for (key, value, value_digest) in updates.clone() {
        serial = serial
            .updated(key, value, value_digest)
            .expect("serial update");
    }
    let batched = base
        .updated_batch_three_levels(updates, sequential_slot_vec)
        .expect("three-level update");
    assert_eq!(batched.len(), serial.len());
    assert_eq!(batched.root_hash(), serial.root_hash());
    assert_eq!(batched.get(&[0x12, 0x34]), Some(&digest(11)));
    assert_eq!(batched.get(&[0xab, 0xcd]), Some(&digest(14)));
}

#[test]
fn three_nibble_shards_round_trip_empty_and_one_leaf_exactly() {
    let empty = PersistentRadixMap::<[u8; 32]>::empty();
    let (empty_shards, empty_top) = empty
        .clone()
        .into_three_nibble_shards()
        .expect("split empty");
    assert_value_free_coordinator_type(&empty_top);
    assert_eq!(empty_shards.len(), PERSISTENT_RADIX_SHARD_COUNT);
    assert!(empty_shards.iter().all(|shard| shard.is_empty()));
    assert_eq!(empty_top.root_hash(), empty.root_hash());
    assert_eq!(empty_top.node_records(), top_records(&empty));
    let empty_rebuilt =
        PersistentRadixMap::from_three_nibble_shards(empty_shards).expect("rebuild empty");
    assert_exact_map(&empty_rebuilt, &empty);

    let key = account_key(0xabc, 7);
    let one = empty
        .updated(key.clone(), digest(7), digest(17))
        .expect("one leaf");
    let (one_shards, one_top) = one.clone().into_three_nibble_shards().expect("split one");
    assert_eq!(one_shards[0xabc].len(), 1);
    assert_eq!(one_shards[0xabc].prefix(), [0x0a, 0x0b, 0x0c]);
    assert_eq!(
        one_shards[0xabc].get(&key).expect("routed get"),
        Some(&digest(7))
    );
    assert_eq!(
        one_shards[0xabc]
            .get_with_digest(&key)
            .expect("routed digest"),
        Some((&digest(7), digest(17)))
    );
    assert_eq!(one_top.root_hash(), one.root_hash());
    assert_eq!(one_top.node_records(), top_records(&one));
    let one_rebuilt =
        PersistentRadixMap::from_three_nibble_shards(one_shards).expect("rebuild one");
    assert_exact_map(&one_rebuilt, &one);
}

#[test]
fn three_nibble_shards_preserve_compressed_prefixes_and_records() {
    let mut serial = PersistentRadixMap::empty();
    for (prefix, discriminator, byte) in [
        (0x123, 0x0000_0001, 1),
        (0x123, 0x0000_0002, 2),
        (0x123, 0x0000_0012, 3),
        (0x124, 0x0000_0001, 4),
        (0xfed, 0x0000_0001, 5),
    ] {
        serial = serial
            .updated(
                account_key(prefix, discriminator),
                digest(byte),
                digest(byte),
            )
            .expect("compressed insert");
    }
    let (shards, top) = serial
        .clone()
        .into_three_nibble_shards()
        .expect("split compressed");
    assert_eq!(shards[0x123].len(), 3);
    assert_eq!(shards[0x124].len(), 1);
    assert_eq!(shards[0xfed].len(), 1);
    assert_eq!(top.root_hash(), serial.root_hash());
    let rebuilt = PersistentRadixMap::from_three_nibble_shards(shards).expect("rebuild compressed");
    assert_exact_map(&rebuilt, &serial);
}

#[test]
fn three_nibble_shards_cover_all_prefixes_with_exact_root_and_records() {
    let mut serial = PersistentRadixMap::empty();
    for prefix in 0..PERSISTENT_RADIX_SHARD_COUNT {
        serial = serial
            .updated(
                account_key(prefix, prefix as u32),
                digest(prefix as u8),
                digest(prefix as u8),
            )
            .expect("prefix insert");
    }
    let (shards, top) = serial
        .clone()
        .into_three_nibble_shards()
        .expect("split every prefix");
    assert!(
        shards
            .iter()
            .enumerate()
            .all(|(index, shard)| shard.index() == index && shard.len() == 1)
    );
    assert_eq!(top.len(), PERSISTENT_RADIX_SHARD_COUNT);
    assert_eq!(top.root_hash(), serial.root_hash());
    assert_eq!(top.node_records(), top_records(&serial));
    let rebuilt =
        PersistentRadixMap::from_three_nibble_shards(shards).expect("rebuild every prefix");
    assert_exact_map(&rebuilt, &serial);
}

#[test]
fn one_dirty_shard_updates_only_compact_top_commitments_exactly() {
    let mut base = PersistentRadixMap::empty();
    for prefix in [0x001, 0x123, 0xabc, 0xabd, 0xfff] {
        base = base
            .updated(
                account_key(prefix, 1),
                digest(prefix as u8),
                digest(prefix as u8),
            )
            .expect("base insert");
    }
    let (mut shards, top) = base.clone().into_three_nibble_shards().expect("split base");
    let previous_top = top.clone();
    let untouched = top.shard_root(0x123).expect("untouched root").cloned();
    let previous_shard = shards[0xabc].clone();
    let changed = previous_shard
        .updated(account_key(0xabc, 1), digest(91), digest(91))
        .expect("replace")
        .updated(account_key(0xabc, 2), digest(92), digest(92))
        .expect("insert");
    let changes = changed
        .node_changes_since(&previous_shard)
        .expect("shard changes");
    assert!(!changes.puts.is_empty());
    let descriptor = changed.descriptor();
    shards[0xabc] = changed;
    let overlay = top
        .sparse_overlay(None, vec![descriptor])
        .expect("dirty top overlay");
    assert_eq!(overlay.dirty_len(), 1);
    assert_eq!(
        overlay.work(),
        PersistentRadixOverlayWork {
            dirty_descriptors: 1,
            second_level_folds: 1,
            first_level_folds: 1,
            root_folds: 1,
        }
    );
    let mut top = top;
    top.apply_sparse_overlay(&overlay)
        .expect("promote dirty overlay");
    assert_eq!(
        top.shard_root(0x123).expect("untouched after"),
        untouched.as_ref()
    );

    let serial = base
        .updated(account_key(0xabc, 1), digest(91), digest(91))
        .expect("serial replace")
        .updated(account_key(0xabc, 2), digest(92), digest(92))
        .expect("serial insert");
    assert_eq!(top.root_hash(), serial.root_hash());
    assert_eq!(top.node_records(), top_records(&serial));
    let top_changes = top.node_changes_since(&previous_top);
    assert!(!top_changes.puts.is_empty());
    let rebuilt = PersistentRadixMap::from_three_nibble_shards(shards).expect("rebuild dirty");
    assert_exact_map(&rebuilt, &serial);
}

#[test]
fn shard_replace_delete_and_duplicate_key_match_serial_exactly() {
    let key_a = account_key(0x456, 1);
    let key_b = account_key(0x456, 2);
    let base = PersistentRadixMap::empty()
        .updated(key_a.clone(), digest(1), digest(1))
        .expect("a")
        .updated(key_b.clone(), digest(2), digest(2))
        .expect("b");
    let (mut shards, top) = base.clone().into_three_nibble_shards().expect("split");
    let previous = shards[0x456].clone();
    let changed = previous
        .updated_batch(vec![
            (key_a.clone(), digest(7), digest(7)),
            (key_a.clone(), digest(8), digest(8)),
        ])
        .expect("duplicate last wins")
        .removed(&key_b)
        .expect("delete b");
    assert_eq!(changed.get(&key_a).expect("get a"), Some(&digest(8)));
    assert_eq!(changed.get(&key_b).expect("get b"), None);
    let descriptor = changed.descriptor();
    shards[0x456] = changed;
    let top = top
        .with_dirty_descriptors(vec![descriptor])
        .expect("update top");
    let serial = base
        .updated(key_a.clone(), digest(7), digest(7))
        .expect("serial 7")
        .updated(key_a, digest(8), digest(8))
        .expect("serial 8")
        .removed(&key_b)
        .expect("serial remove");
    assert_eq!(top.root_hash(), serial.root_hash());
    let rebuilt = PersistentRadixMap::from_three_nibble_shards(shards).expect("rebuild");
    assert_exact_map(&rebuilt, &serial);
}

#[test]
fn shard_boundary_rejects_misrouting_and_duplicate_descriptors() {
    let key = account_key(0x222, 1);
    let map = PersistentRadixMap::empty()
        .updated(key.clone(), digest(1), digest(1))
        .expect("base");
    let (mut shards, top) = map.into_three_nibble_shards().expect("split");
    assert_eq!(
        shards[0x111].get(&key),
        Err(PersistentRadixMapError::ShardKey {
            actual: 0x222,
            expected: 0x111,
        })
    );
    let changed = shards[0x222]
        .updated(key, digest(2), digest(2))
        .expect("change");
    let descriptor = changed.descriptor();
    shards[0x222] = changed;
    assert!(matches!(
        top.with_dirty_descriptors(vec![descriptor.clone(), descriptor]),
        Err(PersistentRadixMapError::DuplicateShard { index: 0x222 })
    ));
    shards[1] = shards[0].clone();
    assert!(matches!(
        PersistentRadixMap::from_three_nibble_shards(shards),
        Err(PersistentRadixMapError::DuplicateShard { index: 0 })
    ));
}

#[test]
fn long_common_prefix_offer_ids_return_error_without_mutating_or_panicking() {
    let accepted_offer_id = "a".repeat(u16::MAX as usize);
    let accepted_key = encode_raw_text_key(&accepted_offer_id).expect("accepted text key");
    let accepted = PersistentRadixMap::empty()
        .updated(accepted_key, digest(1), digest(1))
        .expect("an isolated leaf needs no extension encoding");
    assert_ne!(accepted.root_hash(), [0; 32]);

    let common_prefix = "a".repeat(32_766);
    let first = encode_raw_text_key(&format!("{common_prefix}a")).expect("first offer id");
    let second = encode_raw_text_key(&format!("{common_prefix}b")).expect("second offer id");
    let shard = PersistentRadixShard::<[u8; 32]>::empty(0x7ff).expect("offer-id shard");
    let shard = shard
        .updated(first.clone(), digest(1), digest(1))
        .expect("first long offer remains a leaf");
    let shard_root_before = shard.root_hash();
    assert_eq!(
        shard.updated(second.clone(), digest(2), digest(2)).err(),
        Some(PersistentRadixMapError::ExtensionPathTooLong {
            actual: 65_536,
            maximum: 65_535,
        })
    );
    assert_eq!(shard.root_hash(), shard_root_before);
    let map = PersistentRadixMap::<[u8; 32]>::empty();
    let root_before = map.root_hash();
    let result = map.updated_batch_three_levels(
        vec![
            (first, digest(1), digest(1)),
            (second, digest(2), digest(2)),
        ],
        sequential_slot_vec,
    );

    assert_eq!(
        result.err(),
        Some(PersistentRadixMapError::ExtensionPathTooLong {
            actual: 65_536,
            maximum: 65_535,
        })
    );
    assert_eq!(map.root_hash(), root_before);
    assert!(map.is_empty());
}

#[test]
fn delete_rejects_a_newly_oversized_extension_without_mutating() {
    let mut shallow = vec![0xaa; 2_500];
    shallow.push(0xb0);
    let mut deep_left = vec![0xaa; 35_000];
    deep_left.push(0x10);
    let mut deep_right = vec![0xaa; 35_000];
    deep_right.push(0x20);

    let map = PersistentRadixMap::empty()
        .updated(shallow.clone(), digest(1), digest(1))
        .expect("shallow branch anchor")
        .updated(deep_left, digest(2), digest(2))
        .expect("first deep leaf")
        .updated(deep_right, digest(3), digest(3))
        .expect("deep branch below the anchor");
    let root_before = map.root_hash();

    assert_eq!(
        map.removed(&shallow).err(),
        Some(PersistentRadixMapError::ExtensionPathTooLong {
            actual: 69_999,
            maximum: 65_535,
        })
    );
    assert_eq!(map.root_hash(), root_before);
    assert_eq!(map.len(), 3);
}

#[test]
fn last_with_prefix_matches_ordered_traversal_across_compressed_edges() {
    let rows = [
        (vec![0x10, 0x20, 0x00], 1),
        (vec![0x10, 0x20, 0x7f], 2),
        (vec![0x10, 0x20, 0xff], 3),
        (vec![0x10, 0x21, 0x00], 4),
        (vec![0xab, 0xcd, 0x01], 5),
        (vec![0xab, 0xef, 0x02], 6),
        (vec![0xff, 0x00, 0x00], 7),
    ];
    let mut map = PersistentRadixMap::empty();
    for (key, byte) in rows {
        map = map
            .updated(key, digest(byte), digest(byte))
            .expect("prefix fixture insert");
    }

    for prefix in [
        Vec::new(),
        vec![0x10],
        vec![0x10, 0x20],
        vec![0xab],
        vec![0xab, 0xcd],
        vec![0xff],
        vec![0x11],
    ] {
        let expected = map
            .iter()
            .filter(|(key, _)| key.starts_with(&prefix))
            .last();
        assert_eq!(
            map.last_with_prefix(&prefix),
            expected,
            "prefix={prefix:x?}"
        );
    }
}

#[test]
fn last_with_prefix_visits_one_trie_path_not_every_matching_leaf() {
    let mut map = PersistentRadixMap::empty();
    for index in 0_u32..4_096 {
        let key = index.to_be_bytes().to_vec();
        let byte = index as u8;
        map = map
            .updated(key, digest(byte), digest(byte))
            .expect("scale fixture insert");
    }

    let (key, value) = map.last_with_prefix(&[0, 0]).expect("prefix tail");
    assert_eq!(key, 4_095_u32.to_be_bytes());
    assert_eq!(value, &digest(0xff));
    assert!(
        map.last_with_prefix_node_visits(&[0, 0]) <= 10,
        "a fixed-width Patricia seek must be bounded by key depth, not 4096 leaves",
    );
}

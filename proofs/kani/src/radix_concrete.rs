//! Concrete exhaustive corroboration for C6 (runs under `cargo test`,
//! independent of Kani). The same real rscore radix code, the same 4-key
//! universe, every combination enumerated explicitly:
//!
//! - 24 permutations of the full 4-leaf set -> one root,
//! - 60 ordered sequences over {4 keys + skip} for subsets of size <= 3
//!   -> the canonical subset root,
//! - 16 subsets x 4 keys insert/delete round-trips -> identity root,
//! - 16x15 ordered subset pairs -> pairwise distinct roots,
//! - leaf-hash pairwise distinctness, get()/iter() semantics.
//!
//! These are bounded exhaustive tests, not proofs; they pin the same claims
//! the Kani harnesses cover symbolically and would catch a regression in the
//! real implementation immediately.

use crate::persistent::PersistentRadixMap;
use crate::radix::{EMPTY_RADIX_ROOT, hash_leaf};
use crate::radix_universe::{
    UNIVERSE, digest_of, key_of, map_from_mask, universe_index, value_of,
};

fn keys_mask(keys: &[usize]) -> u8 {
    keys.iter().fold(0u8, |mask, k| mask | (1 << k))
}

#[test]
fn all_permutations_of_full_set_share_one_root() {
    let reference = map_from_mask(0b1111);
    let expected = reference.root_hash();
    let mut permutation = [0usize; 4];
    let mut count = 0;
    for a in 0..4 {
        for b in 0..4 {
            if b == a {
                continue;
            }
            for c in 0..4 {
                if c == a || c == b {
                    continue;
                }
                for d in 0..4 {
                    if d == a || d == b || d == c {
                        continue;
                    }
                    permutation[0] = a;
                    permutation[1] = b;
                    permutation[2] = c;
                    permutation[3] = d;
                    let mut map: PersistentRadixMap<u16> = PersistentRadixMap::empty();
                    for index in permutation {
                        let u = universe_index(index as u8);
                        map = map.updated(key_of(u), value_of(u), digest_of(u)).unwrap();
                    }
                    assert_eq!(map.len(), 4);
                    assert_eq!(map.root_hash(), expected, "permutation {permutation:?}");
                    count += 1;
                }
            }
        }
    }
    assert_eq!(count, 24);
}

#[test]
fn subset_any_order_matches_canonical_root() {
    for i0 in 0..5usize {
        for i1 in 0..5usize {
            for i2 in 0..5usize {
                let slots = [i0, i1, i2];
                let mut seen = [false; 4];
                let mut distinct = true;
                for slot in slots.iter().filter(|s| **s < 4) {
                    if seen[*slot] {
                        distinct = false;
                    }
                    seen[*slot] = true;
                }
                if !distinct {
                    continue;
                }
                let mut mask = 0u8;
                let mut map: PersistentRadixMap<u16> = PersistentRadixMap::empty();
                for slot in slots {
                    if slot < 4 {
                        let u = universe_index(slot as u8);
                        map = map.updated(key_of(u), value_of(u), digest_of(u)).unwrap();
                        mask |= 1 << slot;
                    }
                }
                assert_eq!(
                    map.root_hash(),
                    map_from_mask(mask).root_hash(),
                    "slots {slots:?} mask {mask:b}"
                );
            }
        }
    }
}

#[test]
fn insert_delete_round_trip_is_identity() {
    for mask in 0..16u8 {
        let base = map_from_mask(mask);
        let base_root = base.root_hash();
        for raw in 0..4u8 {
            let u = universe_index(raw);
            let inserted = base
                .updated(key_of(u), value_of(u), digest_of(u))
                .unwrap();
            if mask & (1 << raw) == 0 {
                // Absent key: delete∘insert is the exact identity.
                let round_trip = inserted.removed(&key_of(u)).unwrap();
                assert_eq!(round_trip.root_hash(), base_root, "mask {mask:b} key {raw}");
                assert_eq!(round_trip.len(), base.len());
            } else {
                // Present key with the same digest: insert is a no-op
                // (identical root and length), and delete∘insert equals the
                // base minus that key — NOT the base. The naive
                // "round-trip == identity" formulation is false by design
                // here; this case pins the actual semantics.
                assert_eq!(inserted.root_hash(), base_root, "mask {mask:b} key {raw}");
                assert_eq!(inserted.len(), base.len());
                let without = inserted.removed(&key_of(u)).unwrap();
                assert_eq!(
                    without.root_hash(),
                    map_from_mask(mask & !(1 << raw)).root_hash(),
                    "mask {mask:b} key {raw}"
                );
                assert_eq!(without.len(), base.len() - 1);
            }
        }
    }
}

#[test]
fn different_leaf_sets_have_different_roots() {
    let mut roots = Vec::new();
    for mask in 0..16u8 {
        roots.push(map_from_mask(mask).root_hash());
        if mask == 0 {
            assert_eq!(roots[0], EMPTY_RADIX_ROOT);
        }
    }
    for (mask_a, root_a) in roots.iter().enumerate() {
        for (mask_b, root_b) in roots.iter().enumerate() {
            if mask_a != mask_b {
                assert_ne!(root_a, root_b, "masks {mask_a:b} vs {mask_b:b}");
            }
        }
    }
}

#[test]
fn universe_leaf_hashes_are_pairwise_distinct() {
    for a in 0..4usize {
        for b in (a + 1)..4usize {
            let key_a = UNIVERSE[a].to_vec();
            let key_b = UNIVERSE[b].to_vec();
            assert_ne!(
                hash_leaf(&key_a, &digest_of(universe_index(a as u8))),
                hash_leaf(&key_b, &digest_of(universe_index(b as u8))),
                "leaf hash collision between keys {a} and {b} within the universe"
            );
        }
    }
}

#[test]
fn get_and_iter_semantics_on_universe() {
    for mask in 0..16u8 {
        let map = map_from_mask(mask);
        for raw in 0..4u8 {
            let u = universe_index(raw);
            let included = mask & (1 << raw) != 0;
            let stored = map.get(&UNIVERSE[raw as usize]);
            if included {
                assert_eq!(stored, Some(&(value_of(u))));
            } else {
                assert_eq!(stored, None);
            }
        }
        let iterated = map
            .iter()
            .map(|(key, value)| (key.to_vec(), *value))
            .collect::<Vec<_>>();
        let mut expected = (0..4usize)
            .filter(|index| mask & (1 << index) != 0)
            .map(|index| (UNIVERSE[index].to_vec(), value_of(universe_index(index as u8))))
            .collect::<Vec<_>>();
        assert_eq!(iterated, expected);
        expected.sort();
        // iter() is lexicographic by construction; the filtered universe list
        // is already ascending, so equality above already pins the order.
        assert_eq!(map.len(), expected.len());
    }
}

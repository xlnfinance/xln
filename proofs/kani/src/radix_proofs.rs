//! Kani proof harnesses for claim C6 (bounded radix universe).
//!
//! The verified code is the REAL rscore implementation: the modules included
//! via `#[path]` in `src/lib.rs` are byte-identical to
//! `rscore/crates/protocol/src/{radix,persistent,persistent_node,persistent_records}.rs`
//! (hashes in report.md). Keys are restricted to 2 bytes and at most 4 leaves
//! through the four-element universe in `radix_universe`; every symbolic
//! choice is a small integer constrained by `kani::assume`, so each harness
//! explores a finite, documented set of map shapes:
//!
//! - `c6a_all_permutations_same_root`: 4! = 24 insertion orders of the full
//!   4-leaf universe.
//! - `c6a_subset_any_order_same_root`: every subset of size <= 3 in every
//!   order (60 ordered sequences over 5 symbols: 4 keys + skip).
//! - `c6b_delete_after_insert_is_identity`: 16 base subsets x 4 keys.
//! - `c6c_different_leaf_sets_different_roots`: all 16x15 ordered mask pairs.
//!
//! Value digests are an injective function of the key (`[hi, lo, 0..0]`), so
//! leaf hashes are real SHA-256 outputs over distinct inputs; two different
//! leaf sets colliding on the same root within this universe would be an
//! actual SHA-256 collision between structurally distinct encodings. This is
//! a compression-correctness claim within the bounded universe, NOT a general
//! collision-resistance claim about SHA-256.
//!
//! Kani limitation workaround: the recursive Drop glue of `Arc<Node>` trees
//! is irrelevant to every property here and dominates verification time, so
//! every harness ends with `std::mem::forget` of the built maps. No property
//! depends on deallocation.

use crate::persistent::PersistentRadixMap;
use crate::radix::EMPTY_RADIX_ROOT;
use crate::radix_universe::{
    UNIVERSE_SIZE, digest2_of, digest_of, key2_of, key_of, map2_from_mask, map_from_mask,
    universe_index, value2_of, value_of,
};

fn any_mask() -> u8 {
    let mask: u8 = kani::any();
    kani::assume(mask < (1 << UNIVERSE_SIZE));
    mask
}

// -------------------------------------------------------------------------
// C6a: root_hash depends only on the map contents (path independence)
// -------------------------------------------------------------------------

/// Any permutation of all four universe leaves yields the canonical root.
#[kani::proof]
fn c6a_all_permutations_same_root() {
    let i0: u8 = kani::any();
    let i1: u8 = kani::any();
    let i2: u8 = kani::any();
    let i3: u8 = kani::any();
    kani::assume(i0 < UNIVERSE_SIZE && i1 < UNIVERSE_SIZE);
    kani::assume(i2 < UNIVERSE_SIZE && i3 < UNIVERSE_SIZE);
    kani::assume(i0 != i1 && i0 != i2 && i0 != i3 && i1 != i2 && i1 != i3 && i2 != i3);
    let order = [i0, i1, i2, i3];

    let mut permuted: PersistentRadixMap<u16> = PersistentRadixMap::empty();
    for raw in order {
        let u = universe_index(raw);
        permuted = permuted
            .updated(key_of(u), value_of(u), digest_of(u))
            .expect("universe insert must succeed");
    }
    let reference = map_from_mask(0b1111);
    assert_eq!(permuted.root_hash(), reference.root_hash());
    assert_eq!(permuted.len(), reference.len());

    std::mem::forget(permuted);
    std::mem::forget(reference);
}

/// Every subset of size <= 3 in every insertion order (5-symbol sequences
/// with symbol 4 = "skip", no key repeated) yields the root of that subset
/// built in canonical ascending order.
#[kani::proof]
fn c6a_subset_any_order_same_root() {
    let i0: u8 = kani::any();
    let i1: u8 = kani::any();
    let i2: u8 = kani::any();
    kani::assume(i0 < 5 && i1 < 5 && i2 < 5);
    // Each symbol is either "skip" (4) or a key; non-skip symbols are
    // pairwise distinct.
    let slots = [i0, i1, i2];
    for a in 0..3 {
        for b in (a + 1)..3 {
            if slots[a] < UNIVERSE_SIZE && slots[b] < UNIVERSE_SIZE {
                kani::assume(slots[a] != slots[b]);
            }
        }
    }

    let mut mask = 0u8;
    let mut map: PersistentRadixMap<u16> = PersistentRadixMap::empty();
    for raw in slots {
        if raw < UNIVERSE_SIZE {
            let u = universe_index(raw);
            map = map
                .updated(key_of(u), value_of(u), digest_of(u))
                .expect("universe insert must succeed");
            mask |= 1 << raw;
        }
    }
    let reference = map_from_mask(mask);
    assert_eq!(map.root_hash(), reference.root_hash());
    assert_eq!(map.len(), reference.len());

    std::mem::forget(map);
    std::mem::forget(reference);
}

// -------------------------------------------------------------------------
// C6b: delete ∘ insert == identity (same root before/after)
//
// For an ABSENT key the round trip returns the exact base root and length.
// For an already-present key the identity is false BY DESIGN: the
// digest-equal insert is a no-op and the subsequent delete removes the key;
// that present-key semantics is pinned by c6b_present_key_insert_is_noop
// and by the concrete exhaustive test.
// -------------------------------------------------------------------------

#[kani::proof]
fn c6b_delete_after_insert_is_identity() {
    let mask = any_mask();
    let raw: u8 = kani::any();
    kani::assume(raw < UNIVERSE_SIZE);
    kani::assume(mask & (1 << raw) == 0);
    let u = universe_index(raw);

    let base = map_from_mask(mask);
    let inserted = base
        .updated(key_of(u), value_of(u), digest_of(u))
        .expect("universe insert must succeed");
    let removed = inserted
        .removed(&key_of(u))
        .expect("universe remove must succeed");

    assert_eq!(removed.root_hash(), base.root_hash());
    assert_eq!(removed.len(), base.len());
    // Also on the empty base: insert-then-delete returns the empty root.
    if mask == 0 {
        assert_eq!(removed.root_hash(), EMPTY_RADIX_ROOT);
        assert!(removed.is_empty());
    }

    std::mem::forget(base);
    std::mem::forget(inserted);
    std::mem::forget(removed);
}

/// Present-key semantics: inserting a key that is already stored with the
/// SAME digest is a no-op (identical root and length), and deleting
/// afterwards yields exactly the base-without-that-key state.
#[kani::proof]
fn c6b_present_key_insert_is_noop() {
    let mask = any_mask();
    let raw: u8 = kani::any();
    kani::assume(raw < UNIVERSE_SIZE);
    kani::assume(mask & (1 << raw) != 0);
    let u = universe_index(raw);

    let base = map_from_mask(mask);
    let inserted = base
        .updated(key_of(u), value_of(u), digest_of(u))
        .expect("universe insert must succeed");
    assert_eq!(inserted.root_hash(), base.root_hash());
    assert_eq!(inserted.len(), base.len());

    let without = inserted
        .removed(&key_of(u))
        .expect("universe remove must succeed");
    assert_eq!(without.len(), base.len() - 1);
    assert_eq!(
        without.root_hash(),
        map_from_mask(mask & !(1 << raw)).root_hash()
    );

    std::mem::forget(base);
    std::mem::forget(inserted);
    std::mem::forget(without);
}

// -------------------------------------------------------------------------
// C6c: structural injectivity on the universe (different leaf sets ->
//      different roots; compression correctness, not a crypto claim)
// -------------------------------------------------------------------------

#[kani::proof]
fn c6c_different_leaf_sets_different_roots() {
    let mask_a = any_mask();
    let mask_b = any_mask();
    kani::assume(mask_a != mask_b);

    let map_a = map_from_mask(mask_a);
    let map_b = map_from_mask(mask_b);
    assert_ne!(map_a.root_hash(), map_b.root_hash());

    std::mem::forget(map_a);
    std::mem::forget(map_b);
}

/// Sanity anchor: the empty map hashes to the declared empty root, and the
/// empty root is NOT any reachable non-empty root within the universe.
#[kani::proof]
fn c6c_empty_root_isolated() {
    let mask = any_mask();
    let map = map_from_mask(mask);
    if mask == 0 {
        assert_eq!(map.root_hash(), EMPTY_RADIX_ROOT);
    } else {
        assert_ne!(map.root_hash(), EMPTY_RADIX_ROOT);
    }
    std::mem::forget(map);
}

// -------------------------------------------------------------------------
// Fallback two-key harnesses: same real implementation, minimal symbolic
// branching (the four-key versions above are the primary claims; these
// exist because the recursive Arc drop glue of the real tree multiplies
// symbolic paths combinatorially and the four-key harnesses exceed the
// verification time budget of this toolchain).
// -------------------------------------------------------------------------

#[kani::proof]
fn c6a_two_key_any_order_same_root() {
    let first: bool = kani::any();
    let second_bit = if first { 1 } else { 0 };
    let mut map: PersistentRadixMap<u16> = PersistentRadixMap::empty();
    map = map
        .updated(key2_of(0), value2_of(0), digest2_of(0))
        .expect("universe insert must succeed");
    map = map
        .updated(key2_of(1), value2_of(1), digest2_of(1))
        .expect("universe insert must succeed");
    let _ = second_bit; // both orders covered by the two inserts below

    // Rebuild in the opposite order and compare.
    let mut reversed: PersistentRadixMap<u16> = PersistentRadixMap::empty();
    reversed = reversed
        .updated(key2_of(1), value2_of(1), digest2_of(1))
        .expect("universe insert must succeed");
    reversed = reversed
        .updated(key2_of(0), value2_of(0), digest2_of(0))
        .expect("universe insert must succeed");

    assert_eq!(map.root_hash(), reversed.root_hash());
    std::mem::forget(map);
    std::mem::forget(reversed);
}

#[kani::proof]
fn c6b_two_key_delete_after_insert_is_identity() {
    let mask: u8 = kani::any();
    kani::assume(mask < 4);
    let bit: bool = kani::any();
    let raw = u8::from(bit);
    // Absent-key round trip only; the present-key case is a no-op insert by
    // design and is pinned separately (c6b_present_key_insert_is_noop and
    // the concrete exhaustive test).
    kani::assume(mask & (1 << raw) == 0);

    let base = map2_from_mask(mask);
    let inserted = base
        .updated(key2_of(raw), value2_of(raw), digest2_of(raw))
        .expect("universe insert must succeed");
    let removed = inserted
        .removed(&key2_of(raw))
        .expect("universe remove must succeed");
    assert_eq!(removed.root_hash(), base.root_hash());
    assert_eq!(removed.len(), base.len());

    std::mem::forget(base);
    std::mem::forget(inserted);
    std::mem::forget(removed);
}

#[kani::proof]
fn c6c_two_key_different_leaf_sets_different_roots() {
    let mask_a: u8 = kani::any();
    let mask_b: u8 = kani::any();
    kani::assume(mask_a < 4);
    kani::assume(mask_b < 4);
    kani::assume(mask_a != mask_b);
    let map_a = map2_from_mask(mask_a);
    let map_b = map2_from_mask(mask_b);
    assert_ne!(map_a.root_hash(), map_b.root_hash());
    std::mem::forget(map_a);
    std::mem::forget(map_b);
}

/// Feasibility probe for the Kani toolchain on the real map: one insert,
/// one root hash. Not a C6 claim by itself; it bounds what the symbolic
/// engine can swallow (see report.md "Kani feasibility for C6").
#[kani::proof]
fn c6_probe_single_insert() {
    let bit: bool = kani::any();
    let map: PersistentRadixMap<u16> = PersistentRadixMap::empty()
        .updated(key2_of(u8::from(bit)), value2_of(u8::from(bit)), digest2_of(u8::from(bit)))
        .expect("universe insert must succeed");
    assert_ne!(map.root_hash(), EMPTY_RADIX_ROOT);
    std::mem::forget(map);
}

// -------------------------------------------------------------------------
// Symbolic coverage of the CANONICAL radix16 commitment builder
// (`radix.rs::build_radix16_merkle`, the cold-recompute path). This builder
// is pure (no Arc/OnceLock), so Kani can verify it symbolically where the
// persistent map's drop glue cannot converge. It shares the exact
// hash_leaf/hash_branch16/hash_extension16 encodings used by
// PersistentRadixMap. These harnesses verify the BUILDER on the bounded
// universe; they are not claims that PersistentRadixMap root hashes equal
// builder roots (the map wraps a lone top-level node in a root branch, so
// the two commitments differ at that edge by design).
// -------------------------------------------------------------------------

use crate::radix::{RadixLeaf, build_radix16_merkle};

fn builder_leaves_from_mask(mask: u8) -> Vec<RadixLeaf> {
    (0..UNIVERSE_SIZE)
        .filter(|index| mask & (1 << index) != 0)
        .map(|index| {
            let u = universe_index(index);
            RadixLeaf {
                key: key_of(u),
                value_digest: digest_of(u),
            }
        })
        .collect()
}

#[kani::proof]
fn c6_builder_permutation_independent() {
    let i0: u8 = kani::any();
    let i1: u8 = kani::any();
    let i2: u8 = kani::any();
    let i3: u8 = kani::any();
    kani::assume(i0 < UNIVERSE_SIZE && i1 < UNIVERSE_SIZE);
    kani::assume(i2 < UNIVERSE_SIZE && i3 < UNIVERSE_SIZE);
    kani::assume(i0 != i1 && i0 != i2 && i0 != i3 && i1 != i2 && i1 != i3 && i2 != i3);

    let permuted = [i0, i1, i2, i3]
        .iter()
        .map(|raw| {
            let u = universe_index(*raw);
            RadixLeaf {
                key: key_of(u),
                value_digest: digest_of(u),
            }
        })
        .collect::<Vec<_>>();
    let reference = builder_leaves_from_mask(0b1111);

    let permuted_root = build_radix16_merkle(&permuted).expect("builder").root;
    let reference_root = build_radix16_merkle(&reference).expect("builder").root;
    assert_eq!(permuted_root, reference_root);
}

#[kani::proof]
fn c6_builder_different_leaf_sets_different_roots() {
    let mask_a = any_mask();
    let mask_b = any_mask();
    kani::assume(mask_a != mask_b);

    let root_a = build_radix16_merkle(&builder_leaves_from_mask(mask_a))
        .expect("builder")
        .root;
    let root_b = build_radix16_merkle(&builder_leaves_from_mask(mask_b))
        .expect("builder")
        .root;
    if mask_a == 0 || mask_b == 0 {
        // The empty leaf set yields the declared EMPTY_RADIX_ROOT, distinct
        // from every non-empty root within the universe.
        assert_ne!(root_a, root_b);
    } else {
        assert_ne!(root_a, root_b);
    }
}

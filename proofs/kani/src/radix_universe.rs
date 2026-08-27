//! Shared bounded universe for the C6 radix claims (used by both the Kani
//! harnesses in `radix_proofs` and the concrete exhaustive tests in
//! `radix_concrete`).

use crate::persistent::PersistentRadixMap;

/// Four structurally distinct 2-byte keys chosen to exercise the compressed
/// Patricia shapes available at depth 4 nibbles:
/// - `00 00` vs `00 01` diverge at the LAST nibble (deep shared prefix),
/// - `00 FF` shares the first nibble with both (root fanout + extension),
/// - `FF 00` diverges at the FIRST nibble (root branch fanout).
pub const UNIVERSE: [[u8; 2]; 4] = [[0x00, 0x00], [0x00, 0x01], [0x00, 0xFF], [0xFF, 0x00]];

pub const UNIVERSE_SIZE: u8 = 4;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum U {
    K0,
    K1,
    K2,
    K3,
}

pub fn universe_index(raw: u8) -> U {
    match raw {
        0 => U::K0,
        1 => U::K1,
        2 => U::K2,
        _ => U::K3,
    }
}

pub fn key_of(u: U) -> Vec<u8> {
    UNIVERSE[u as usize].to_vec()
}

/// Injective digest assignment: distinct keys get distinct digests.
pub fn digest_of(u: U) -> [u8; 32] {
    let mut digest = [0u8; 32];
    let key = UNIVERSE[u as usize];
    digest[0] = key[0];
    digest[1] = key[1];
    digest
}

pub fn value_of(u: U) -> u16 {
    u as u16 + 1
}

/// Build the map containing exactly the universe keys selected by the low 4
/// bits of `mask`, inserted in ascending universe order (the canonical
/// reference order for path independence).
pub fn map_from_mask(mask: u8) -> PersistentRadixMap<u16> {
    let mut map: PersistentRadixMap<u16> = PersistentRadixMap::empty();
    for index in 0..UNIVERSE_SIZE {
        if mask & (1 << index) != 0 {
            let u = universe_index(index);
            map = map
                .updated(key_of(u), value_of(u), digest_of(u))
                .expect("universe insert must succeed");
        }
    }
    map
}

/// Reduced two-key universe for the fallback Kani harnesses: `00 00` vs
/// `01 00` diverge at the SECOND nibble, so a two-leaf map exercises the
/// root branch, one path-compressed child branch, and both leaf shapes,
/// while keeping the symbolic branching minimal (1-2 bits per choice).
pub const UNIVERSE2: [[u8; 2]; 2] = [[0x00, 0x00], [0x01, 0x00]];

pub fn key2_of(bit: u8) -> Vec<u8> {
    UNIVERSE2[(bit & 1) as usize].to_vec()
}

pub fn digest2_of(bit: u8) -> [u8; 32] {
    let mut digest = [0u8; 32];
    let key = UNIVERSE2[(bit & 1) as usize];
    digest[0] = key[0];
    digest[1] = key[1];
    digest
}

pub fn value2_of(bit: u8) -> u16 {
    (bit & 1) as u16 + 1
}

pub fn map2_from_mask(mask: u8) -> PersistentRadixMap<u16> {
    let mut map: PersistentRadixMap<u16> = PersistentRadixMap::empty();
    for bit in 0..2u8 {
        if mask & (1 << bit) != 0 {
            map = map
                .updated(key2_of(bit), value2_of(bit), digest2_of(bit))
                .expect("universe insert must succeed");
        }
    }
    map
}

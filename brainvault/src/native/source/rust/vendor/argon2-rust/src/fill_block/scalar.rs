//! Portable scalar `fill_block` / `fill_segment` — the reference behaviour every
//! other backend must reproduce bit for bit.
//!
//! Ported line by line from `phc-winner-argon2/src/ref.c` (`fill_block`,
//! `next_addresses`, `fill_segment`) and
//! `phc-winner-argon2/src/blake2/blamka-round-ref.h` (`fBlaMka`, `G`,
//! `BLAKE2_ROUND_NOMSG`).
//!
//! Everything here is written for auditability against the C: the index
//! expressions are the C's index expressions, and the 16-word round works on a
//! `[u64; 16]` with constant indices so LLVM can still scalar-replace it into
//! registers and unroll the whole thing.

use crate::block::{Block, Instance, Position};
use crate::params::{ADDRESSES_IN_BLOCK, QWORDS_IN_BLOCK};

/// `ARGON2_ADDRESSES_IN_BLOCK` as a `u32`, for the `i % 128` in `fill_segment`.
const ADDRESSES_IN_BLOCK_U32: u32 = ADDRESSES_IN_BLOCK as u32;

// ---------------------------------------------------------------------------
// blamka-round-ref.h
// ---------------------------------------------------------------------------

/// `fBlaMka(x, y)` from `blamka-round-ref.h`:
///
/// ```c
/// const uint64_t m = UINT64_C(0xFFFFFFFF);
/// const uint64_t xy = (x & m) * (y & m);
/// return x + y + 2 * xy;
/// ```
///
/// Every operation is `uint64_t` arithmetic, so the C relies on **unsigned
/// wraparound** for `2 * xy` and for both additions. Rust must spell that out
/// with `wrapping_*`, otherwise the function panics in debug builds. The
/// `(x & m) * (y & m)` product itself cannot overflow — both factors are at most
/// `2^32 - 1` — but it is written with `wrapping_mul` for uniformity.
#[inline(always)]
#[must_use]
pub const fn f_blamka(x: u64, y: u64) -> u64 {
    const M: u64 = 0xFFFF_FFFF;
    let xy = (x & M).wrapping_mul(y & M);
    x.wrapping_add(y).wrapping_add(xy.wrapping_mul(2))
}

/// The BLAMKA `G` quarter-round on four values, returning the new
/// `(a, b, c, d)`.
///
/// ```c
/// a = fBlaMka(a, b);  d = rotr64(d ^ a, 32);
/// c = fBlaMka(c, d);  b = rotr64(b ^ c, 24);
/// a = fBlaMka(a, b);  d = rotr64(d ^ a, 16);
/// c = fBlaMka(c, d);  b = rotr64(b ^ c, 63);
/// ```
///
/// This is the by-value form; [`g`] is the in-place wrapper.
#[inline(always)]
#[must_use]
pub const fn g_values(mut a: u64, mut b: u64, mut c: u64, mut d: u64) -> (u64, u64, u64, u64) {
    a = f_blamka(a, b);
    d = (d ^ a).rotate_right(32);
    c = f_blamka(c, d);
    b = (b ^ c).rotate_right(24);
    a = f_blamka(a, b);
    d = (d ^ a).rotate_right(16);
    c = f_blamka(c, d);
    b = (b ^ c).rotate_right(63);
    (a, b, c, d)
}

/// In-place `G`, mirroring the C macro's lvalue signature.
///
/// The four references must be distinct; the C macro is only ever expanded on
/// four distinct words.
#[inline(always)]
pub fn g(a: &mut u64, b: &mut u64, c: &mut u64, d: &mut u64) {
    let (na, nb, nc, nd) = g_values(*a, *b, *c, *d);
    *a = na;
    *b = nb;
    *c = nc;
    *d = nd;
}

/// `G` on four *slots* of the 16-word round state.
///
/// Always called with literal indices, so after inlining LLVM sees constants,
/// drops the bounds checks and keeps `v` in registers.
#[inline(always)]
fn g_at(v: &mut [u64; 16], ia: usize, ib: usize, ic: usize, id: usize) {
    let (a, b, c, d) = g_values(v[ia], v[ib], v[ic], v[id]);
    v[ia] = a;
    v[ib] = b;
    v[ic] = c;
    v[id] = d;
}

/// `BLAKE2_ROUND_NOMSG` over 16 words: four column `G`s then four diagonal `G`s.
///
/// ```c
/// G(v0, v4,  v8, v12);  G(v1, v5,  v9, v13);
/// G(v2, v6, v10, v14);  G(v3, v7, v11, v15);
/// G(v0, v5, v10, v15);  G(v1, v6, v11, v12);
/// G(v2, v7,  v8, v13);  G(v3, v4,  v9, v14);
/// ```
#[inline(always)]
pub fn blake2_round_nomsg(v: &mut [u64; 16]) {
    // Columns.
    g_at(v, 0, 4, 8, 12);
    g_at(v, 1, 5, 9, 13);
    g_at(v, 2, 6, 10, 14);
    g_at(v, 3, 7, 11, 15);
    // Diagonals.
    g_at(v, 0, 5, 10, 15);
    g_at(v, 1, 6, 11, 12);
    g_at(v, 2, 7, 8, 13);
    g_at(v, 3, 4, 9, 14);
}

// ---------------------------------------------------------------------------
// ref.c
// ---------------------------------------------------------------------------

/// `fill_block()` from `src/ref.c`.
///
/// ```text
/// blockR    = ref_block ^ prev_block
/// block_tmp = blockR (^ next_block, if with_xor)
/// 8 column rounds over blockR.v[16*i .. 16*i+16]
/// 8 row rounds over blockR.v[2i], [2i+1], [2i+16], [2i+17], ..., [2i+112], [2i+113]
/// *next_block = block_tmp ^ blockR
/// ```
///
/// `with_xor` is `false` for version `0x10` always, and `pass != 0` for `0x13`
/// (see [`Instance::with_xor`]). When it is `false` the previous contents of
/// `next_block` are never read, only overwritten.
///
/// # Aliasing
///
/// The signature forbids `ref_block` and `next_block` from being the same block.
/// `next_addresses` needs exactly that, so it copies the address block first —
/// [`Block`] is [`Copy`]:
///
/// ```text
/// let seed = *address_block;
/// fill_block(&Block::ZERO, &seed, address_block, false);
/// ```
#[inline]
pub fn fill_block(prev_block: &Block, ref_block: &Block, next_block: &mut Block, with_xor: bool) {
    // copy_block(&blockR, ref_block); xor_block(&blockR, prev_block);
    let mut block_r = *ref_block;
    for i in 0..QWORDS_IN_BLOCK {
        block_r.0[i] ^= prev_block.0[i];
    }

    // copy_block(&block_tmp, &blockR);
    let mut block_tmp = block_r;
    if with_xor {
        // xor_block(&block_tmp, next_block);
        for i in 0..QWORDS_IN_BLOCK {
            block_tmp.0[i] ^= next_block.0[i];
        }
    }

    // "Apply Blake2 on columns of 64-bit words: (0,1,...,15), then
    //  (16,17,..31)... finally (112,113,...127)"
    //
    // The columns are contiguous, so they can be rounded in place: 128 = 8 * 16
    // exactly, and `rest` is always empty.
    let (columns, rest) = block_r.0.as_chunks_mut::<16>();
    debug_assert!(rest.is_empty());
    for column in columns {
        blake2_round_nomsg(column);
    }

    // "Apply Blake2 on rows of 64-bit words: (0,1,16,17,...112,113), then
    //  (2,3,18,19,...,114,115).. finally (14,15,30,31,...,126,127)"
    //
    // The C names the 16 slots explicitly as 2i, 2i+1, 2i+16, 2i+17, ...,
    // 2i+112, 2i+113 — i.e. v[2j] = 2i + 16j and v[2j+1] = 2i + 16j + 1.
    let mut v = [0u64; 16];
    for i in 0..8 {
        let base = 2 * i;
        for j in 0..8 {
            v[2 * j] = block_r.0[base + 16 * j];
            v[2 * j + 1] = block_r.0[base + 16 * j + 1];
        }
        blake2_round_nomsg(&mut v);
        for j in 0..8 {
            block_r.0[base + 16 * j] = v[2 * j];
            block_r.0[base + 16 * j + 1] = v[2 * j + 1];
        }
    }

    // copy_block(next_block, &block_tmp); xor_block(next_block, &blockR);
    for i in 0..QWORDS_IN_BLOCK {
        next_block.0[i] = block_tmp.0[i] ^ block_r.0[i];
    }
}

/// `next_addresses()` from `src/ref.c`.
///
/// ```c
/// input_block->v[6]++;
/// fill_block(zero_block, input_block, address_block, 0);
/// fill_block(zero_block, address_block, address_block, 0);
/// ```
///
/// The counter is bumped **before** both calls. The second call has
/// `ref == next`; since `with_xor` is `0` the old contents of `next` are never
/// read, so taking a copy of the address block first is exactly equivalent and
/// keeps the `&`/`&mut` split legal.
pub fn next_addresses(address_block: &mut Block, input_block: &mut Block) {
    // uint64_t increment: wraps in C, so wrap here too rather than panic.
    input_block.0[6] = input_block.0[6].wrapping_add(1);
    fill_block(&Block::ZERO, input_block, address_block, false);
    let seed = *address_block;
    fill_block(&Block::ZERO, &seed, address_block, false);
}

/// `fill_segment()` from `src/ref.c`.
///
/// # Safety
///
/// See [`crate::fill_block::FillSegmentFn`]: `instance`'s arena must be valid
/// for `instance.memory_len()` blocks, `position` must be in range, and no
/// other thread may be writing this segment.
///
/// Concretely, the offsets this function computes stay inside the arena as long
/// as the instance is well formed — `lane_length == segment_length * SYNC_POINTS`,
/// `memory_blocks == lane_length * lanes <= memory_len`, `position.lane < lanes`,
/// `position.slice < SYNC_POINTS` — which is what [`Instance::new`] produces
/// from validated [`crate::params::Params`].
pub unsafe fn fill_segment(instance: &Instance, mut position: Position) {
    // `ref.c` opens with `if (instance == NULL) return;`. A `&Instance` is never
    // null, but the two `%` operators below would divide by zero on a degenerate
    // instance and this library must not panic, so guard those instead.
    if instance.lane_length == 0 || instance.lanes == 0 {
        return;
    }

    // type == Argon2_i || (type == Argon2_id && pass == 0 && slice < SYNC_POINTS/2)
    let data_independent_addressing = instance.data_independent_addressing(&position);
    // Version 0x10 always overwrites; 0x13 XORs from pass 1 on. Constant for the
    // whole segment, so it is hoisted out of the loop.
    let with_xor = instance.with_xor(position.pass);

    let mut address_block = Block::ZERO;
    // `input_block.v[0..6]` = pass, lane, slice, memory_blocks, passes, type;
    // `v[6]` is the counter `next_addresses` increments.
    let mut input_block = if data_independent_addressing {
        instance.address_input_block(&position)
    } else {
        Block::ZERO
    };

    let mut starting_index: u32 = 0;
    if position.pass == 0 && position.slice == 0 {
        // The first two blocks of every lane come from `fill_first_blocks`.
        starting_index = 2;
        if data_independent_addressing {
            // "Don't forget to generate the first block of addresses"
            next_addresses(&mut address_block, &mut input_block);
        }
    }

    // curr_offset = lane * lane_length + slice * segment_length + starting_index
    //
    // `wrapping_*` mirrors the C's `uint32_t` arithmetic exactly and keeps this
    // function panic-free; for a well-formed instance nothing here can wrap.
    let mut curr_offset = position
        .lane
        .wrapping_mul(instance.lane_length)
        .wrapping_add(position.slice.wrapping_mul(instance.segment_length))
        .wrapping_add(starting_index);

    // `%` rather than `is_multiple_of` so this line reads exactly like the C's
    // `if (0 == curr_offset % instance->lane_length)`. `lane_length != 0` was
    // checked above, so the division is safe.
    #[allow(clippy::manual_is_multiple_of)]
    let mut prev_offset = if curr_offset % instance.lane_length == 0 {
        // Last block in this lane.
        curr_offset
            .wrapping_add(instance.lane_length)
            .wrapping_sub(1)
    } else {
        // Previous block.
        curr_offset.wrapping_sub(1)
    };

    let mut i = starting_index;
    while i < instance.segment_length {
        // 1.1 Rotating prev_offset if needed.
        if curr_offset % instance.lane_length == 1 {
            prev_offset = curr_offset.wrapping_sub(1);
        }

        // 1.2.1 Taking the pseudo-random value.
        let pseudo_rand: u64 = if data_independent_addressing {
            let slot = (i % ADDRESSES_IN_BLOCK_U32) as usize;
            if slot == 0 {
                next_addresses(&mut address_block, &mut input_block);
            }
            address_block.0[slot]
        } else {
            // SAFETY: `prev_offset` is a block this lane has already finalised
            // (either earlier in this segment, or the last block of the lane on
            // a wrap-around), so it is in bounds and no other lane writes it.
            unsafe { instance.block(prev_offset).0[0] }
        };

        // 1.2.2 Computing the lane of the reference block.
        let mut ref_lane = ((pseudo_rand >> 32) % u64::from(instance.lanes)) as u32;
        if position.pass == 0 && position.slice == 0 {
            // Cannot reference other lanes yet.
            ref_lane = position.lane;
        }

        // 1.2.3 Computing the reference index. `index_alpha` takes the LOW 32
        // bits of `pseudo_rand`.
        position.index = i;
        let ref_index = crate::core::index_alpha(
            instance,
            &position,
            (pseudo_rand & 0xFFFF_FFFF) as u32,
            ref_lane == position.lane,
        );

        // ref_block = memory + lane_length * ref_lane + ref_index
        //
        // The C evaluates this in `uint64_t` (because `ref_lane` is a
        // `uint64_t`); done the same way here so the multiply cannot overflow.
        // For a well-formed instance the sum is < memory_blocks <= u32::MAX.
        let ref_offset_u64 =
            u64::from(instance.lane_length) * u64::from(ref_lane) + u64::from(ref_index);
        debug_assert!(ref_offset_u64 < instance.memory_len() as u64);
        let ref_offset = ref_offset_u64 as u32;

        // 2 Creating a new block.
        //
        // SAFETY: `prev_offset`, `ref_offset` and `curr_offset` are all in
        // bounds for a well-formed instance (see the function contract).
        // `prev_offset` and `ref_offset` may coincide with each other — two
        // `&Block` are allowed to alias — but neither can equal `curr_offset`:
        // `prev_offset != curr_offset` because `lane_length >= 2 * SYNC_POINTS`,
        // and `index_alpha` never returns the block currently being written
        // (its reference area always stops one short of `position.index`).
        // So the `&mut Block` below is genuinely exclusive. Cross-lane safety
        // is the caller's job: within a slice, lane `l` only ever writes its own
        // segment.
        unsafe {
            let prev = instance.block(prev_offset);
            let reference = instance.block(ref_offset);
            let curr = instance.block_mut(curr_offset);
            fill_block(prev, reference, curr, with_xor);
        }

        i += 1;
        curr_offset = curr_offset.wrapping_add(1);
        prev_offset = prev_offset.wrapping_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::params::{Algorithm, Memory, Params, SYNC_POINTS, TagLen, Version};

    // ------------------------------------------------------------------
    // Helpers shared with the C reference harness.
    //
    // Every expected value below was produced by compiling the untouched
    // `phc-winner-argon2/src/ref.c` (which makes the `static` `fill_block` /
    // `next_addresses` reachable) and printing the results:
    //
    //   cc -O2 -std=c99 -Iphc-winner-argon2/include -Iphc-winner-argon2/src \
    //      harness.c phc-winner-argon2/src/core.c \
    //      phc-winner-argon2/src/blake2/blake2b.c phc-winner-argon2/src/thread.c
    // ------------------------------------------------------------------

    /// splitmix64, byte-for-byte the same as the harness's `sm()`.
    fn sm(x: u64) -> u64 {
        let x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = x;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Position-sensitive block digest, the same as the harness's `digest()`.
    /// Unlike a plain XOR fold this notices a permutation of the words, so a
    /// wrong column/row stride cannot slip through.
    fn digest(b: &Block) -> u64 {
        let mut d = 0u64;
        for i in 0..QWORDS_IN_BLOCK {
            d = d.rotate_left(1)
                ^ b.0[i].wrapping_add((i as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15));
        }
        d
    }

    // ------------------------------------------------------------------
    // fBlaMka
    // ------------------------------------------------------------------

    #[test]
    fn f_blamka_wraps_like_the_c_reference() {
        // (x, y, fBlaMka(x, y)) straight out of the C harness.
        const CASES: [(u64, u64, u64); 8] = [
            (0, 0, 0),
            (1, 1, 4),
            (u64::MAX, u64::MAX, 0xFFFF_FFFC_0000_0000),
            (u64::MAX, 1, 0x0000_0001_FFFF_FFFE),
            (0xFFFF_FFFF, 0xFFFF_FFFF, 0xFFFF_FFFE_0000_0000),
            (
                0x0123_4567_89AB_CDEF,
                0xFEDC_BA98_7654_3210,
                0x7F44_F06F_CAC3_19DF,
            ),
            (0x8000_0000_0000_0000, 0x8000_0000_0000_0000, 0),
            (
                0xFFFF_FFFF_0000_0000,
                0xFFFF_FFFF_0000_0000,
                0xFFFF_FFFE_0000_0000,
            ),
        ];
        for (x, y, want) in CASES {
            assert_eq!(f_blamka(x, y), want, "f_blamka({x:#x}, {y:#x})");
        }
    }

    #[test]
    fn f_blamka_at_u64_max_by_hand() {
        // x = y = 2^64 - 1.
        //   lo32(x) = lo32(y) = 0xFFFF_FFFF
        //   xy      = 0xFFFF_FFFF^2      = 0xFFFF_FFFE_0000_0001
        //   2*xy    mod 2^64             = 0xFFFF_FFFC_0000_0002
        //   x + y   mod 2^64             = 0xFFFF_FFFF_FFFF_FFFE
        //   sum     mod 2^64             = 0xFFFF_FFFC_0000_0000
        assert_eq!(f_blamka(u64::MAX, u64::MAX), 0xFFFF_FFFC_0000_0000);

        // 0x8000_0000_0000_0000 twice: the low halves are zero so the product
        // term vanishes and x + y is exactly 2^64, i.e. 0 after wrapping. This
        // is the case a non-wrapping `+` would blow up on first.
        assert_eq!(f_blamka(1 << 63, 1 << 63), 0);

        // The lone `2 * xy` overflow: lo32 halves are 0xFFFF_FFFF, high halves 0.
        assert_eq!(f_blamka(0xFFFF_FFFF, 0xFFFF_FFFF), 0xFFFF_FFFE_0000_0000);
    }

    #[test]
    fn f_blamka_agrees_with_128_bit_arithmetic() {
        // Independent recomputation in u128, where nothing can wrap, truncated
        // at the end. Catches any mis-placed `wrapping_`.
        //
        // The same 512 pairs are folded into a rolling checksum that the C
        // harness printed, so this is tied to `fBlaMka` itself and not only to
        // our reading of it.
        let mut checksum = 0u64;
        for k in 0..512u64 {
            let x = sm(k);
            let y = sm(k ^ 0xDEAD_BEEF);
            let wide = (x as u128) + (y as u128) + 2 * ((x as u32 as u128) * (y as u32 as u128));
            assert_eq!(f_blamka(x, y), wide as u64, "k={k}");
            checksum = checksum.rotate_left(1) ^ f_blamka(x, y);
        }
        assert_eq!(checksum, 0x996d_41e6_56d8_ce81);
    }

    // ------------------------------------------------------------------
    // G
    // ------------------------------------------------------------------

    #[test]
    fn g_matches_a_hand_computation() {
        // a=1 b=2 c=3 d=4, worked through by hand:
        //   a = fBlaMka(1, 2)            = 1 + 2 + 2*(1*2)      = 7
        //   d = rotr64(4 ^ 7, 32)        = rotr64(3, 32)        = 0x0000_0003_0000_0000
        //   c = fBlaMka(3, d)            lo32(d)=0 so xy=0      = 0x0000_0003_0000_0003
        //   b = rotr64(2 ^ c, 24)        rotr64(0x0000_0003_0000_0001, 24)
        //                                                       = 0x0000_0100_0000_0300
        //   a = fBlaMka(7, b)            xy = 7*0x300 = 0x1500  = 0x0000_0100_0000_2D07
        //   d = rotr64(d ^ a, 16)        rotr64(0x0000_0103_0000_2D07, 16)
        //                                                       = 0x2D07_0000_0103_0000
        //   c = fBlaMka(c, d)            xy = 3*0x0103_0000     = 0x2D07_0003_0715_0003
        //   b = rotr64(b ^ c, 63)        = rotl64(0x2D07_0103_0715_0303, 1)
        //                                                       = 0x5A0E_0206_0E2A_0606
        //
        // The C harness prints exactly these four words, so the derivation and
        // the reference agree.
        let (a, b, c, d) = g_values(1, 2, 3, 4);
        assert_eq!(a, 0x0000_0100_0000_2D07);
        assert_eq!(b, 0x5A0E_0206_0E2A_0606);
        assert_eq!(c, 0x2D07_0003_0715_0003);
        assert_eq!(d, 0x2D07_0000_0103_0000);

        // The in-place wrapper must agree with the by-value form.
        let (mut ma, mut mb, mut mc, mut md) = (1u64, 2u64, 3u64, 4u64);
        g(&mut ma, &mut mb, &mut mc, &mut md);
        assert_eq!((ma, mb, mc, md), (a, b, c, d));
    }

    #[test]
    fn g_matches_the_c_reference() {
        // All zeros stay all zeros: fBlaMka(0,0) = 0 and 0 ^ 0 = 0.
        assert_eq!(g_values(0, 0, 0, 0), (0, 0, 0, 0));

        assert_eq!(
            g_values(
                0x0123_4567_89AB_CDEF,
                0xFEDC_BA98_7654_3210,
                0x0F1E_2D3C_4B5A_6978,
                0x8796_A5B4_C3D2_E1F0,
            ),
            (
                0xCF91_AECF_AFA8_73EA,
                0x8EDA_3C2E_E838_7799,
                0x55BD_AD43_0382_0779,
                0x2631_C680_56E0_577A,
            )
        );

        assert_eq!(
            g_values(u64::MAX, u64::MAX, u64::MAX, u64::MAX),
            (
                0x0000_03FB_FFFF_FB00,
                0xE61B_F809_C845_F607,
                0xF30D_FFFB_1BDD_0003,
                0xFB03_FFFF_FC04_FFFF,
            )
        );
    }

    // ------------------------------------------------------------------
    // BLAKE2_ROUND_NOMSG
    // ------------------------------------------------------------------

    #[test]
    fn round_matches_the_c_reference() {
        // v[i] = i + 1
        let mut v = [0u64; 16];
        for (i, w) in v.iter_mut().enumerate() {
            *w = i as u64 + 1;
        }
        blake2_round_nomsg(&mut v);
        assert_eq!(
            v,
            [
                0x0bc5db40e57d9709,
                0x0206082b10b0edc7,
                0x58750add48b3666f,
                0xa0585206373e76d3,
                0xb13ca8c05249fa52,
                0x711b9a138fd5634d,
                0xd2ef60b2d559da2f,
                0x825e29e64229b22b,
                0xb527c841d99daa4f,
                0x9f240f18f0676027,
                0xe20ef0e3ae6144fc,
                0x2c33605bc379d892,
                0x2f53af926a2ecbcc,
                0x2ce4a96c3c371e52,
                0xa93c622a9fd77e7d,
                0x0c146896de254576,
            ]
        );

        // v[i] = splitmix64(i)
        let mut v = [0u64; 16];
        for (i, w) in v.iter_mut().enumerate() {
            *w = sm(i as u64);
        }
        blake2_round_nomsg(&mut v);
        assert_eq!(
            v,
            [
                0xf0296af35d94419d,
                0x087c1887ba1b625d,
                0xa4db3abc9cd8d0d3,
                0xbb10462c257a3db3,
                0x9cebd6a765e0a762,
                0x84cd2fd65ff90878,
                0x746813d108989ba6,
                0x8f51a687069668d6,
                0xc37c65c437b76744,
                0x756ec1a309dec652,
                0x896df8699641cf1a,
                0xcfd09265f4075dd6,
                0xeeb81d07f391b02b,
                0xd3a8b11c337f5434,
                0x28907f9cb45a045d,
                0x8ffa4f1dcca0cb5e,
            ]
        );
    }

    #[test]
    fn round_is_all_zero_on_all_zero() {
        let mut v = [0u64; 16];
        blake2_round_nomsg(&mut v);
        assert_eq!(v, [0u64; 16]);
    }

    #[test]
    fn round_touches_every_word() {
        // Each of the 16 inputs must influence the output; a mistyped index in
        // the G schedule would leave one word inert.
        let base = {
            let mut v = [0u64; 16];
            for (i, w) in v.iter_mut().enumerate() {
                *w = sm(i as u64);
            }
            blake2_round_nomsg(&mut v);
            v
        };
        for k in 0..16 {
            let mut v = [0u64; 16];
            for (i, w) in v.iter_mut().enumerate() {
                *w = sm(i as u64);
            }
            v[k] ^= 1;
            blake2_round_nomsg(&mut v);
            assert_ne!(v, base, "flipping v[{k}] changed nothing");
        }
    }

    // ------------------------------------------------------------------
    // fill_block
    // ------------------------------------------------------------------

    fn test_blocks() -> (Block, Block, Block) {
        let mut prev = Block::ZERO;
        let mut reference = Block::ZERO;
        let mut next = Block::ZERO;
        for i in 0..QWORDS_IN_BLOCK {
            prev.0[i] = sm(i as u64);
            reference.0[i] = sm(1000 + i as u64);
            next.0[i] = sm(2000 + i as u64);
        }
        (prev, reference, next)
    }

    #[test]
    fn fill_block_matches_the_c_reference_without_xor() {
        let (prev, reference, mut next) = test_blocks();
        fill_block(&prev, &reference, &mut next, false);

        assert_eq!(next.0[0], 0x7f887644c9ac80f0);
        assert_eq!(next.0[1], 0x30cb70c258effa95);
        assert_eq!(next.0[2], 0x113d6ef6e7b0d726);
        assert_eq!(next.0[3], 0x0a82137ec3baada8);
        assert_eq!(next.0[124], 0xfea80377e4ead2ca);
        assert_eq!(next.0[125], 0x85c06c7f6c68e64c);
        assert_eq!(next.0[126], 0x179662a7987d324f);
        assert_eq!(next.0[127], 0x585b09251c6b3d70);
        assert_eq!(digest(&next), 0x0fd2dc7cfcc86df1);
    }

    #[test]
    fn fill_block_matches_the_c_reference_with_xor() {
        let (prev, reference, mut next) = test_blocks();
        fill_block(&prev, &reference, &mut next, true);

        assert_eq!(next.0[0], 0xc3574c08bf231223);
        assert_eq!(next.0[1], 0x3121c183ff3852d9);
        assert_eq!(next.0[2], 0x937e28dd9a8f4842);
        assert_eq!(next.0[3], 0x0e227956dcd8ffbd);
        assert_eq!(next.0[124], 0xdda811cac58cd2f2);
        assert_eq!(next.0[125], 0xacc265bdc4e4a39f);
        assert_eq!(next.0[126], 0x25c6d823f105d812);
        assert_eq!(next.0[127], 0x5cc8594ddaa97e7b);
        assert_eq!(digest(&next), 0xd75733f642888273);
    }

    #[test]
    fn fill_block_all_zero_stays_all_zero() {
        // fBlaMka(0, 0) = 0, so an all-zero blockR survives all 16 rounds.
        let mut next = Block::ZERO;
        fill_block(&Block::ZERO, &Block::ZERO, &mut next, false);
        assert_eq!(next, Block::ZERO);
    }

    #[test]
    fn fill_block_with_xor_is_the_plain_result_xor_the_old_block() {
        // out_xor = R ^ old ^ P(R) and out_plain = R ^ P(R), so the two differ
        // by exactly the previous contents of `next`. Any stray read of `next`
        // on the `with_xor == false` path would break this.
        let (prev, reference, old) = test_blocks();

        let mut plain = Block::ZERO;
        fill_block(&prev, &reference, &mut plain, false);

        let mut xored = old;
        fill_block(&prev, &reference, &mut xored, true);

        for i in 0..QWORDS_IN_BLOCK {
            assert_eq!(xored.0[i], plain.0[i] ^ old.0[i], "word {i}");
        }
    }

    #[test]
    fn fill_block_ignores_the_old_contents_when_not_xoring() {
        let (prev, reference, other) = test_blocks();

        let mut from_zero = Block::ZERO;
        fill_block(&prev, &reference, &mut from_zero, false);

        let mut from_other = other;
        fill_block(&prev, &reference, &mut from_other, false);

        assert_eq!(from_zero, from_other);
    }

    #[test]
    fn fill_block_is_symmetric_in_prev_and_ref() {
        // blockR = ref ^ prev, and with_xor = false never reads `next`, so
        // swapping the two inputs cannot change the result. A port that mixed up
        // `copy_block(&blockR, ref_block)` / `xor_block(&blockR, prev_block)`
        // would still pass this, which is why the C-derived digests above matter.
        let (prev, reference, _) = test_blocks();
        let mut a = Block::ZERO;
        let mut b = Block::ZERO;
        fill_block(&prev, &reference, &mut a, false);
        fill_block(&reference, &prev, &mut b, false);
        assert_eq!(a, b);
    }

    #[test]
    fn fill_block_row_rounds_mix_across_the_columns() {
        // Flip one bit in word 0 and require every 16-word column of the output
        // to change. Only the row (strided) pass can carry the change out of
        // column 0, so a wrong row stride shows up here.
        let (prev, reference, _) = test_blocks();

        let mut base = Block::ZERO;
        fill_block(&prev, &reference, &mut base, false);

        let mut flipped_prev = prev;
        flipped_prev.0[0] ^= 1;
        let mut flipped = Block::ZERO;
        fill_block(&flipped_prev, &reference, &mut flipped, false);

        for col in 0..8 {
            let changed = (0..16).any(|j| base.0[16 * col + j] != flipped.0[16 * col + j]);
            assert!(changed, "column {col} did not change");
        }
    }

    // ------------------------------------------------------------------
    // next_addresses
    // ------------------------------------------------------------------

    #[test]
    fn next_addresses_matches_the_c_reference() {
        let mut address_block = Block::ZERO;
        let mut input_block = Block::ZERO;
        // The layout `fill_segment` builds: pass=1 lane=2 slice=3
        // memory_blocks=4096 passes=3 type=2 (Argon2id).
        input_block.0[0] = 1;
        input_block.0[1] = 2;
        input_block.0[2] = 3;
        input_block.0[3] = 4096;
        input_block.0[4] = 3;
        input_block.0[5] = 2;

        next_addresses(&mut address_block, &mut input_block);
        assert_eq!(input_block.0[6], 1, "counter is bumped before the fills");
        assert_eq!(address_block.0[0], 0xd75f3ba6706cbfb9);
        assert_eq!(address_block.0[1], 0x5cc5800fca08c7e4);
        assert_eq!(address_block.0[2], 0xd50460e0684e261a);
        assert_eq!(address_block.0[3], 0x2e0fe0c941d3f086);
        assert_eq!(address_block.0[124], 0xa90d967b5199a2c6);
        assert_eq!(address_block.0[125], 0x97b46ce4d72e8c41);
        assert_eq!(address_block.0[126], 0x6bbc05201e5907ea);
        assert_eq!(address_block.0[127], 0x94b933e808d08af3);
        assert_eq!(digest(&address_block), 0x52f8222d9130e04d);

        next_addresses(&mut address_block, &mut input_block);
        assert_eq!(input_block.0[6], 2);
        assert_eq!(address_block.0[0], 0x4ea6d9b6ab767720);
        assert_eq!(address_block.0[1], 0xa986fc04ab361585);
        assert_eq!(address_block.0[2], 0xe305082f9bdb9286);
        assert_eq!(address_block.0[3], 0xe60684a3eb806bff);
        assert_eq!(address_block.0[124], 0xb041b0fafc36bf89);
        assert_eq!(address_block.0[125], 0x6e13d780f2103c81);
        assert_eq!(address_block.0[126], 0x6e22f0a7af1a590f);
        assert_eq!(address_block.0[127], 0x37da6884c05d497c);
        assert_eq!(digest(&address_block), 0x11ef8dbf2dbc4674);
    }

    #[test]
    fn next_addresses_ignores_the_previous_address_block() {
        // The C leaves `address_block` uninitialised before the first call; that
        // is only sound because `with_xor == 0` never reads it. Prove it.
        let mut input_a = Block::ZERO;
        input_a.0[0] = 7;
        let mut input_b = input_a;

        let mut from_zero = Block::ZERO;
        next_addresses(&mut from_zero, &mut input_a);

        let mut garbage = Block::ZERO;
        garbage.fill(0xA5);
        next_addresses(&mut garbage, &mut input_b);

        assert_eq!(from_zero, garbage);
        assert_eq!(input_a.0[6], input_b.0[6]);
    }

    // ------------------------------------------------------------------
    // fill_segment
    //
    // `fill_block` and `next_addresses` above are pinned word for word, but
    // the surrounding *schedule* — `starting_index = 2`, the `prev_offset`
    // rotation, `ref_lane`, the `i % 128` address re-seed, the version's
    // `with_xor` choice — is where a port usually breaks. These cases drive the
    // whole pass/slice/lane grid over a synthetic arena and compare against the
    // real `fill_segment` from `src/ref.c`, which was linked into a harness via
    //
    //   cc -O2 -std=c99 -Iphc-winner-argon2/include -Iphc-winner-argon2/src \
    //      vh.c phc-winner-argon2/src/core.c \
    //      phc-winner-argon2/src/blake2/blake2b.c phc-winner-argon2/src/thread.c
    //
    // (`#include "ref.c"` makes the `static` functions reachable). The harness
    // ran the identical schedule on the identical pre-filled arena; every
    // digest below is its output.
    // ------------------------------------------------------------------

    /// Position-sensitive digest over a whole arena. The block index `k` is
    /// folded in as well as the word index `i`, so relocating a block — not
    /// just permuting words inside one — changes the result.
    fn arena_digest(blocks: &[Block]) -> u64 {
        let mut d = 0u64;
        for (k, b) in blocks.iter().enumerate() {
            for i in 0..QWORDS_IN_BLOCK {
                d = d.rotate_left(1)
                    ^ b.0[i]
                        .wrapping_add((i as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15))
                        .wrapping_add((k as u64).wrapping_mul(0xD1B5_4A32_D192_ED03));
            }
        }
        d
    }

    /// Run every segment of every slice of every pass, in the same order
    /// `fill_memory_blocks_st` does, and digest the finished arena.
    ///
    /// The arena is pre-filled with splitmix64 rather than with the output of
    /// `fill_first_blocks`. That keeps the test independent of `core.rs` while
    /// still exercising real data flow: on pass 0 slice 0 the first two blocks
    /// of each lane are read but never written, exactly as in a real hash.
    fn run_grid(
        algorithm: Algorithm,
        version: Version,
        m_cost: u32,
        lanes: u32,
        passes: u32,
    ) -> u64 {
        // argon2_ctx step 2, in the C's order.
        let mut memory_blocks = m_cost;
        if memory_blocks < 2 * SYNC_POINTS * lanes {
            memory_blocks = 2 * SYNC_POINTS * lanes;
        }
        let segment_length = memory_blocks / (lanes * SYNC_POINTS);
        memory_blocks = segment_length * (lanes * SYNC_POINTS);

        let mut mem = alloc::vec![Block::ZERO; memory_blocks as usize];
        for (k, b) in mem.iter_mut().enumerate() {
            for i in 0..QWORDS_IN_BLOCK {
                b.0[i] = sm((k as u64) * 128 + i as u64);
            }
        }

        let params = Params::builder()
            .memory(Memory::kib(u64::from(m_cost)))
            .passes(passes)
            .lanes(lanes)
            .threads(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("valid grid params");
        // SAFETY: `mem` outlives `instance` and holds exactly `memory_blocks`
        // blocks, which is what `params.memory_layout()` reports.
        let instance = unsafe {
            Instance::new(
                mem.as_mut_ptr(),
                memory_blocks as usize,
                algorithm,
                version,
                &params,
            )
        };
        assert_eq!(instance.memory_blocks, memory_blocks);
        assert_eq!(instance.segment_length, segment_length);

        for pass in 0..passes {
            for slice in 0..SYNC_POINTS {
                for lane in 0..lanes {
                    // SAFETY: single-threaded, so no other writer; the position
                    // is in range and the arena is valid for `memory_blocks`.
                    unsafe { fill_segment(&instance, Position::new(pass, lane, slice, 0)) };
                }
            }
        }

        arena_digest(&mem)
    }

    #[test]
    fn fill_segment_matches_the_c_reference_across_the_grid() {
        // (algorithm, version, m_cost, lanes, passes, arena digest from ref.c)
        //
        // m_cost 64 gives segment lengths 16/8/5/4 for 1/2/3/4 lanes; m_cost
        // 4096 gives 1024 and 341, which is the only way to make the
        // `i % ADDRESSES_IN_BLOCK == 0` re-seed fire more than once per segment.
        // `lanes = 3` is deliberately not a power of two, and `lanes > 1` with
        // `passes > 1` is what reaches the cross-lane `index == 0` wrapping
        // subtraction in `index_alpha`.
        // `rustfmt::skip` keeps this a readable one-line-per-case table; without
        // it rustfmt explodes every tuple across seven lines.
        #[rustfmt::skip]
        #[allow(clippy::type_complexity)]
        const CASES: &[(Algorithm, Version, u32, u32, u32, u64)] = &[
            (Algorithm::Argon2d, Version::V0x10, 64, 1, 2, 0xf12a025ea1de1960),
            (Algorithm::Argon2d, Version::V0x10, 64, 1, 3, 0x5f5588363467fdee),
            (Algorithm::Argon2d, Version::V0x10, 64, 2, 2, 0x51b18f508d342270),
            (Algorithm::Argon2d, Version::V0x10, 64, 2, 3, 0x929a5928c76a5f56),
            (Algorithm::Argon2d, Version::V0x10, 64, 3, 2, 0xfca100f3c2eae48c),
            (Algorithm::Argon2d, Version::V0x10, 64, 3, 3, 0x66ea9f1ec2f8ece9),
            (Algorithm::Argon2d, Version::V0x10, 64, 4, 2, 0xcd50ab380d7cf0e3),
            (Algorithm::Argon2d, Version::V0x10, 64, 4, 3, 0xd84ce626bd94bf19),
            (Algorithm::Argon2d, Version::V0x10, 4096, 1, 2, 0xbc4cbbafa94befae),
            (Algorithm::Argon2d, Version::V0x10, 4096, 3, 3, 0xc25aa4907cd26ff9),
            (Algorithm::Argon2d, Version::V0x13, 64, 1, 2, 0x05b17bfa0d3f43df),
            (Algorithm::Argon2d, Version::V0x13, 64, 1, 3, 0xca6a8428473a2d23),
            (Algorithm::Argon2d, Version::V0x13, 64, 2, 2, 0xcc07af6e36edb9ba),
            (Algorithm::Argon2d, Version::V0x13, 64, 2, 3, 0xd17f02cb7100a788),
            (Algorithm::Argon2d, Version::V0x13, 64, 3, 2, 0xe772619f11341452),
            (Algorithm::Argon2d, Version::V0x13, 64, 3, 3, 0x7f4b11e643f6593b),
            (Algorithm::Argon2d, Version::V0x13, 64, 4, 2, 0x64cc789324266e40),
            (Algorithm::Argon2d, Version::V0x13, 64, 4, 3, 0x8ee8f4ccd463e169),
            (Algorithm::Argon2d, Version::V0x13, 4096, 1, 2, 0x15618014183a9f84),
            (Algorithm::Argon2d, Version::V0x13, 4096, 3, 3, 0x5f268708c5244a29),
            (Algorithm::Argon2i, Version::V0x10, 64, 1, 2, 0x303d58386ca10f4f),
            (Algorithm::Argon2i, Version::V0x10, 64, 1, 3, 0x02dec35a5ce2d936),
            (Algorithm::Argon2i, Version::V0x10, 64, 2, 2, 0x410aab85521c6af8),
            (Algorithm::Argon2i, Version::V0x10, 64, 2, 3, 0x045dc64632345666),
            (Algorithm::Argon2i, Version::V0x10, 64, 3, 2, 0x1382eddbac33c621),
            (Algorithm::Argon2i, Version::V0x10, 64, 3, 3, 0x29a47361167e232e),
            (Algorithm::Argon2i, Version::V0x10, 64, 4, 2, 0xa5717a331ae8a63c),
            (Algorithm::Argon2i, Version::V0x10, 64, 4, 3, 0x73a50e99b4291fc9),
            (Algorithm::Argon2i, Version::V0x10, 4096, 1, 2, 0x53a74f4ba7839630),
            (Algorithm::Argon2i, Version::V0x10, 4096, 3, 3, 0xfb3572248bff40e5),
            (Algorithm::Argon2i, Version::V0x13, 64, 1, 2, 0xea97e85830ed62cc),
            (Algorithm::Argon2i, Version::V0x13, 64, 1, 3, 0x75d9dfa0abf2e142),
            (Algorithm::Argon2i, Version::V0x13, 64, 2, 2, 0xa959e80937a01de0),
            (Algorithm::Argon2i, Version::V0x13, 64, 2, 3, 0xa07bd47360daecba),
            (Algorithm::Argon2i, Version::V0x13, 64, 3, 2, 0x7e1b71650375da57),
            (Algorithm::Argon2i, Version::V0x13, 64, 3, 3, 0x4f39ef6a3402034b),
            (Algorithm::Argon2i, Version::V0x13, 64, 4, 2, 0xc09188b711c705c1),
            (Algorithm::Argon2i, Version::V0x13, 64, 4, 3, 0x37c468f644860a88),
            (Algorithm::Argon2i, Version::V0x13, 4096, 1, 2, 0xf1000710ea3525f4),
            (Algorithm::Argon2i, Version::V0x13, 4096, 3, 3, 0x2e413ba307304e36),
            (Algorithm::Argon2id, Version::V0x10, 64, 1, 2, 0xc35b7aeb83b3ab77),
            (Algorithm::Argon2id, Version::V0x10, 64, 1, 3, 0x32149ebad1214770),
            (Algorithm::Argon2id, Version::V0x10, 64, 2, 2, 0x424f11079d2600af),
            (Algorithm::Argon2id, Version::V0x10, 64, 2, 3, 0x7a3578b9bbb96636),
            (Algorithm::Argon2id, Version::V0x10, 64, 3, 2, 0x9ebbeebe6bde5cd0),
            (Algorithm::Argon2id, Version::V0x10, 64, 3, 3, 0x64fda5d046291732),
            (Algorithm::Argon2id, Version::V0x10, 64, 4, 2, 0xd38b491f99d32a8b),
            (Algorithm::Argon2id, Version::V0x10, 64, 4, 3, 0x545e3e82dadfe6f6),
            (Algorithm::Argon2id, Version::V0x10, 4096, 1, 2, 0x30c47bee4f55c70b),
            (Algorithm::Argon2id, Version::V0x10, 4096, 3, 3, 0x29227ade27515fe0),
            (Algorithm::Argon2id, Version::V0x13, 64, 1, 2, 0x24bcc59ef5ce3e27),
            (Algorithm::Argon2id, Version::V0x13, 64, 1, 3, 0x7d8c8fab394b0347),
            (Algorithm::Argon2id, Version::V0x13, 64, 2, 2, 0x9a0242806b9123a7),
            (Algorithm::Argon2id, Version::V0x13, 64, 2, 3, 0x51537f42109b6add),
            (Algorithm::Argon2id, Version::V0x13, 64, 3, 2, 0x14179695bb66660b),
            (Algorithm::Argon2id, Version::V0x13, 64, 3, 3, 0x8699933c1ad88935),
            (Algorithm::Argon2id, Version::V0x13, 64, 4, 2, 0xfdbe6cda4b5e6f39),
            (Algorithm::Argon2id, Version::V0x13, 64, 4, 3, 0x62d6a6ae5f301031),
            (Algorithm::Argon2id, Version::V0x13, 4096, 1, 2, 0xc6a6ae82d3429e2e),
            (Algorithm::Argon2id, Version::V0x13, 4096, 3, 3, 0x2ee6aaa18a3929b6),
        ];

        for &(algorithm, version, m_cost, lanes, passes, want) in CASES {
            let got = run_grid(algorithm, version, m_cost, lanes, passes);
            assert_eq!(
                got, want,
                "{algorithm:?} {version:?} m_cost={m_cost} lanes={lanes} passes={passes}"
            );
        }
    }

    #[test]
    fn fill_segment_leaves_the_first_two_blocks_of_pass_0_slice_0_alone() {
        // `starting_index = 2` in ref.c: `fill_first_blocks` already wrote
        // blocks 0 and 1 of every lane, so pass 0 / slice 0 must not touch them.
        let (lanes, m_cost, passes) = (2u32, 64u32, 1u32);
        let segment_length = m_cost / (lanes * SYNC_POINTS);
        let lane_length = segment_length * SYNC_POINTS;

        let mut mem = alloc::vec![Block::ZERO; m_cost as usize];
        for (k, b) in mem.iter_mut().enumerate() {
            for i in 0..QWORDS_IN_BLOCK {
                b.0[i] = sm((k as u64) * 128 + i as u64);
            }
        }
        let before = mem.clone();

        let params = Params::builder()
            .memory(Memory::kib(u64::from(m_cost)))
            .passes(passes)
            .lanes(lanes)
            .threads(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        // SAFETY: `mem` outlives `instance` and holds `m_cost` blocks.
        let instance = unsafe {
            Instance::new(
                mem.as_mut_ptr(),
                m_cost as usize,
                Algorithm::Argon2d,
                Version::V0x13,
                &params,
            )
        };

        for lane in 0..lanes {
            // SAFETY: single-threaded, in-range position, valid arena.
            unsafe { fill_segment(&instance, Position::new(0, lane, 0, 0)) };
        }

        for lane in 0..lanes {
            let base = (lane * lane_length) as usize;
            assert_eq!(mem[base], before[base], "lane {lane} block 0 was written");
            assert_eq!(
                mem[base + 1],
                before[base + 1],
                "lane {lane} block 1 was written"
            );
            // ...and the rest of the segment *was* written.
            assert_ne!(mem[base + 2], before[base + 2], "lane {lane} block 2 stale");
        }
    }

    #[test]
    fn fill_segment_is_a_no_op_on_a_degenerate_instance() {
        // ref.c opens with `if (instance == NULL) return;`. A `&Instance` is
        // never null, but `lane_length == 0` would make the `%` operators divide
        // by zero, and this crate must never panic.
        let mut mem = [Block::ZERO; 8];
        let params = Params::builder()
            .memory(Memory::kib(64))
            .passes(1)
            .lanes(1)
            .threads(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .expect("params");
        // SAFETY: `mem` outlives `instance`; the guard returns before any access.
        let mut instance = unsafe {
            Instance::new(
                mem.as_mut_ptr(),
                mem.len(),
                Algorithm::Argon2i,
                Version::V0x13,
                &params,
            )
        };
        instance.lane_length = 0;
        // SAFETY: the `lane_length == 0` guard makes this return immediately.
        unsafe { fill_segment(&instance, Position::new(0, 0, 0, 0)) };

        instance.lane_length = 8;
        instance.lanes = 0;
        // SAFETY: the `lanes == 0` guard makes this return immediately.
        unsafe { fill_segment(&instance, Position::new(0, 0, 0, 0)) };

        assert_eq!(mem, [Block::ZERO; 8]);
    }
}

//! wasm32 SIMD128 `fill_block` — the 128-bit shape, same as SSE2 and NEON.
//!
//! # Selection is compile-time, and why that is sound here
//!
//! WebAssembly has no portable runtime feature detection: a module that
//! contains SIMD128 instructions simply fails to validate on an engine that
//! lacks them, so the correct deployment story is a compile-time choice —
//! build with `-C target-feature=+simd128` for engines that have it (every
//! current browser, wasmtime, and Node; it has been part of the web
//! baseline since 2021). This module therefore exists only under
//! `cfg!(target_feature = "simd128")`, which is exactly the crate's existing
//! `no_std` pattern: the answer is baked in at compile time and can never
//! dispatch to an instruction the engine lacks.
//!
//! # Where the pieces come from
//!
//! The round structure is the `blamka-round-opt.h`/`opt.c` 128-bit shape,
//! shared with [`super::sse2`] and [`super::neon`]. The instruction mapping:
//!
//! ```text
//!   vmull_u32 / vmull_high_u32  →  u64x2_extmul_low_u32x4 / u64x2_extmul_high_u32x4
//!   vuzp1q_u32 (even 32s of two vectors) → i32x4_shuffle<0,2,4,6>
//!   REV64.4s (ror32)            →  i32x4_shuffle<1,0,3,2>(x, x)
//!   TBL byte rotates (ror24/16) →  i8x16_shuffle with the r24/r16 tables
//!   SHR/ADD-XOR (ror63)         →  v128_xor(u64x2_shr(x, 63), i64x2_add(x, x))
//!   EXT.16b (alignr 8)          →  i64x2_shuffle<1,2>
//!   veorq / vaddq               →  v128_xor / i64x2_add
//! ```
//!
//! `f_blamka2` pairs two BlaMka multiplies so the even-lane gathers are
//! shared, the same trick as NEON's `UZP1`+`UMULL`/`UMULL2` spelling.

// The whole module is compiled only when the engine contract includes
// SIMD128; see the docs above.
#![allow(unsafe_op_in_unsafe_fn)]

use core::arch::wasm32::*;

use crate::block::{Block, Instance, Position};
use crate::core::index_alpha;
use crate::params::QWORDS_IN_BLOCK;

/// `v128` lanes per 1 KiB block: 128 qwords / 2.
const OWORDS_IN_BLOCK: usize = QWORDS_IN_BLOCK / 2;

/// `ADDRESSES_IN_BLOCK` as u32, for the `%` in the address slot walk.
const ADDRESSES_IN_BLOCK_U32: u32 = crate::params::ADDRESSES_IN_BLOCK as u32;

/// `fBlaMka` on two lane pairs at once: `x + y + 2 * (u32)x * (u32)y` per
/// 64-bit lane, with the even-32-bit-lane gathers shared between the pair.
///
/// `i32x4_shuffle<0, 2, 4, 6>` is NEON's `UZP1`: it collects the even 32-bit
/// elements of both operands, after which `extmul_low`/`extmul_high` are the
/// low and high halves of the four products.
#[inline(always)]
fn f_blamka2(x0: v128, y0: v128, x1: v128, y1: v128) -> (v128, v128) {
    let xe = i32x4_shuffle::<0, 2, 4, 6>(x0, x1);
    let ye = i32x4_shuffle::<0, 2, 4, 6>(y0, y1);
    let z0 = u64x2_extmul_low_u32x4(xe, ye);
    let z1 = u64x2_extmul_high_u32x4(xe, ye);
    (
        i64x2_add(i64x2_add(x0, y0), i64x2_add(z0, z0)),
        i64x2_add(i64x2_add(x1, y1), i64x2_add(z1, z1)),
    )
}

/// `rotate_right(32)` per 64-bit lane: swap the two 32-bit halves.
#[inline(always)]
fn ror32(x: v128) -> v128 {
    i32x4_shuffle::<1, 0, 3, 2>(x, x)
}

/// `rotate_right(24)` per 64-bit lane, as a byte shuffle (`blamka-round-opt.h`'s
/// `r24` table).
#[inline(always)]
fn ror24(x: v128) -> v128 {
    i8x16_shuffle::<3, 4, 5, 6, 7, 0, 1, 2, 11, 12, 13, 14, 15, 8, 9, 10>(x, x)
}

/// `rotate_right(16)` per 64-bit lane (`r16` table).
#[inline(always)]
fn ror16(x: v128) -> v128 {
    i8x16_shuffle::<2, 3, 4, 5, 6, 7, 0, 1, 10, 11, 12, 13, 14, 15, 8, 9>(x, x)
}

/// `rotate_right(63)`: `x + x` is `x << 1` and the two halves cannot overlap,
/// so the XOR acts as an OR.
#[inline(always)]
fn ror63(x: v128) -> v128 {
    v128_xor(u64x2_shr(x, 63), i64x2_add(x, x))
}

/// `_mm_alignr_epi8(hi, lo, 8)` = lanes `(lo.lane1, hi.lane0)`.
#[inline(always)]
fn alignr8(hi: v128, lo: v128) -> v128 {
    i64x2_shuffle::<1, 2>(lo, hi)
}

/// `G1` from `blamka-round-opt.h`, on two `v128`s per quarter.
macro_rules! g1 {
    ($a0:ident, $b0:ident, $c0:ident, $d0:ident,
     $a1:ident, $b1:ident, $c1:ident, $d1:ident) => {{
        ($a0, $a1) = f_blamka2($a0, $b0, $a1, $b1);
        $d0 = ror32(v128_xor($d0, $a0));
        $d1 = ror32(v128_xor($d1, $a1));
        ($c0, $c1) = f_blamka2($c0, $d0, $c1, $d1);
        $b0 = ror24(v128_xor($b0, $c0));
        $b1 = ror24(v128_xor($b1, $c1));
    }};
}

/// `G2` from `blamka-round-opt.h`.
macro_rules! g2 {
    ($a0:ident, $b0:ident, $c0:ident, $d0:ident,
     $a1:ident, $b1:ident, $c1:ident, $d1:ident) => {{
        ($a0, $a1) = f_blamka2($a0, $b0, $a1, $b1);
        $d0 = ror16(v128_xor($d0, $a0));
        $d1 = ror16(v128_xor($d1, $a1));
        ($c0, $c1) = f_blamka2($c0, $d0, $c1, $d1);
        $b0 = ror63(v128_xor($b0, $c0));
        $b1 = ror63(v128_xor($b1, $c1));
    }};
}

/// `DIAGONALIZE` from the SSSE3 branch of `blamka-round-opt.h`. The
/// `d0/d1` swap at the end is what puts `v15` in lane 0; it is deliberate
/// and must be kept.
macro_rules! diagonalize {
    ($a0:ident, $b0:ident, $c0:ident, $d0:ident,
     $a1:ident, $b1:ident, $c1:ident, $d1:ident) => {{
        let t0 = alignr8($b1, $b0);
        let t1 = alignr8($b0, $b1);
        $b0 = t0;
        $b1 = t1;

        core::mem::swap(&mut $c0, &mut $c1);

        let t0 = alignr8($d1, $d0);
        let t1 = alignr8($d0, $d1);
        $d0 = t1;
        $d1 = t0;
    }};
}

/// `UNDIAGONALIZE`, the exact inverse.
macro_rules! undiagonalize {
    ($a0:ident, $b0:ident, $c0:ident, $d0:ident,
     $a1:ident, $b1:ident, $c1:ident, $d1:ident) => {{
        let t0 = alignr8($b0, $b1);
        let t1 = alignr8($b1, $b0);
        $b0 = t0;
        $b1 = t1;

        core::mem::swap(&mut $c0, &mut $c1);

        let t0 = alignr8($d0, $d1);
        let t1 = alignr8($d1, $d0);
        $d0 = t1;
        $d1 = t0;
    }};
}

/// One `BLAKE2_ROUND_NOMSG` on the eight `state` slots `$i0..$i7`.
macro_rules! round8 {
    ($s:expr, $i0:expr, $i1:expr, $i2:expr, $i3:expr, $i4:expr, $i5:expr, $i6:expr, $i7:expr) => {{
        let mut a0 = $s[$i0];
        let mut a1 = $s[$i1];
        let mut b0 = $s[$i2];
        let mut b1 = $s[$i3];
        let mut c0 = $s[$i4];
        let mut c1 = $s[$i5];
        let mut d0 = $s[$i6];
        let mut d1 = $s[$i7];

        g1!(a0, b0, c0, d0, a1, b1, c1, d1);
        g2!(a0, b0, c0, d0, a1, b1, c1, d1);
        diagonalize!(a0, b0, c0, d0, a1, b1, c1, d1);
        g1!(a0, b0, c0, d0, a1, b1, c1, d1);
        g2!(a0, b0, c0, d0, a1, b1, c1, d1);
        undiagonalize!(a0, b0, c0, d0, a1, b1, c1, d1);

        $s[$i0] = a0;
        $s[$i1] = a1;
        $s[$i2] = b0;
        $s[$i3] = b1;
        $s[$i4] = c0;
        $s[$i5] = c1;
        $s[$i6] = d0;
        $s[$i7] = d1;
    }};
}

/// `fill_block()` from `opt.c` in the 128-bit shape.
///
/// # Safety
///
/// All three pointers must be valid for a whole [`Block`]. `ref_block` and
/// `next_block` may be the same block (every read completes before the first
/// store); `prev_block` may alias either.
#[target_feature(enable = "simd128")]
unsafe fn fill_block(
    prev_block: *const u64,
    ref_block: *const u64,
    next_block: *mut u64,
    with_xor: bool,
) {
    // SAFETY: the pointers are valid for a whole block by the contract above,
    // and `i < 64` keeps `2 * i + 1 <= 127` in bounds.
    unsafe {
        let mut state: [v128; OWORDS_IN_BLOCK] = [i64x2_splat(0); OWORDS_IN_BLOCK];
        let mut xy: [v128; OWORDS_IN_BLOCK] = [i64x2_splat(0); OWORDS_IN_BLOCK];

        for i in 0..OWORDS_IN_BLOCK {
            let p = v128_load(prev_block.add(2 * i).cast::<v128>());
            let r = v128_load(ref_block.add(2 * i).cast::<v128>());
            let s = v128_xor(p, r);
            state[i] = s;
            xy[i] = if with_xor {
                let n = v128_load(next_block.add(2 * i).cast_const().cast::<v128>());
                v128_xor(s, n)
            } else {
                s
            };
        }

        // Columns: eight contiguous groups of 8 v128s.
        round8!(state, 0, 1, 2, 3, 4, 5, 6, 7);
        round8!(state, 8, 9, 10, 11, 12, 13, 14, 15);
        round8!(state, 16, 17, 18, 19, 20, 21, 22, 23);
        round8!(state, 24, 25, 26, 27, 28, 29, 30, 31);
        round8!(state, 32, 33, 34, 35, 36, 37, 38, 39);
        round8!(state, 40, 41, 42, 43, 44, 45, 46, 47);
        round8!(state, 48, 49, 50, 51, 52, 53, 54, 55);
        round8!(state, 56, 57, 58, 59, 60, 61, 62, 63);

        // Rows: eight groups strided by 8 v128s (16 qwords).
        round8!(state, 0, 8, 16, 24, 32, 40, 48, 56);
        round8!(state, 1, 9, 17, 25, 33, 41, 49, 57);
        round8!(state, 2, 10, 18, 26, 34, 42, 50, 58);
        round8!(state, 3, 11, 19, 27, 35, 43, 51, 59);
        round8!(state, 4, 12, 20, 28, 36, 44, 52, 60);
        round8!(state, 5, 13, 21, 29, 37, 45, 53, 61);
        round8!(state, 6, 14, 22, 30, 38, 46, 54, 62);
        round8!(state, 7, 15, 23, 31, 39, 47, 55, 63);

        for i in 0..OWORDS_IN_BLOCK {
            let out = v128_xor(xy[i], state[i]);
            v128_store(next_block.add(2 * i).cast::<v128>(), out);
        }
    }
}

/// `next_addresses()` from `ref.c`: two `fill_block`s over a zero block.
///
/// # Safety
///
/// Both pointers valid for one `Block`, not aliasing each other. SIMD128,
/// per the module contract.
#[target_feature(enable = "simd128")]
unsafe fn next_addresses(address_block: *mut Block, input_block: *mut Block) {
    let zero = Block::ZERO;
    // SAFETY: `input_block` is valid for writes; the counter wraps in C, so
    // `wrapping_add` here too. Both `fill_block` calls are within contract;
    // the second has `ref == next`, which `fill_block` explicitly permits.
    unsafe {
        (*input_block).0[6] = (*input_block).0[6].wrapping_add(1);
        fill_block(zero.0.as_ptr(), (*input_block).0.as_ptr(), address_block.cast(), false);
        fill_block(zero.0.as_ptr(), (*address_block).0.as_ptr(), address_block.cast(), false);
    }
}

/// `fill_segment()` — same addressing skeleton as every backend; the SIMD
/// work is all inside [`fill_block`].
///
/// # Safety
///
/// As [`super::scalar::fill_segment`], plus: the engine must support SIMD128
/// (this function is only reachable through [`super::fill_segment_fn`] when
/// the crate was compiled with `+simd128`, which is precisely that
/// contract).
#[target_feature(enable = "simd128")]
pub unsafe fn fill_segment(instance: &Instance, mut position: Position) {
    // See `scalar::fill_segment` for the line-by-line commentary; this is the
    // same `ref.c`/`opt.c` skeleton with the backend's `fill_block` at the
    // bottom.
    if instance.lane_length == 0 || instance.lanes == 0 {
        return;
    }

    let data_independent_addressing = instance.data_independent_addressing(&position);
    let with_xor = instance.with_xor(position.pass);

    let mut address_block = Block::ZERO;
    let mut input_block = if data_independent_addressing {
        instance.address_input_block(&position)
    } else {
        Block::ZERO
    };

    let mut starting_index: u32 = 0;
    if position.pass == 0 && position.slice == 0 {
        starting_index = 2;
        if data_independent_addressing {
            // SAFETY: both blocks are live locals, distinct by construction.
            unsafe { next_addresses(&mut address_block, &mut input_block) };
        }
    }

    let mut curr_offset = position
        .lane
        .wrapping_mul(instance.lane_length)
        .wrapping_add(position.slice.wrapping_mul(instance.segment_length))
        .wrapping_add(starting_index);

    #[allow(clippy::manual_is_multiple_of)]
    let mut prev_offset = if curr_offset % instance.lane_length == 0 {
        curr_offset
            .wrapping_add(instance.lane_length)
            .wrapping_sub(1)
    } else {
        curr_offset.wrapping_sub(1)
    };

    let mut i = starting_index;
    while i < instance.segment_length {
        if curr_offset % instance.lane_length == 1 {
            prev_offset = curr_offset.wrapping_sub(1);
        }

        let pseudo_rand: u64 = if data_independent_addressing {
            let slot = (i % ADDRESSES_IN_BLOCK_U32) as usize;
            if slot == 0 {
                // SAFETY: as above.
                unsafe { next_addresses(&mut address_block, &mut input_block) };
            }
            address_block.0[slot]
        } else {
            // SAFETY: `prev_offset` is finalised and in bounds; see scalar.
            unsafe { instance.block(prev_offset).0[0] }
        };

        let mut ref_lane = ((pseudo_rand >> 32) % u64::from(instance.lanes)) as u32;
        if position.pass == 0 && position.slice == 0 {
            ref_lane = position.lane;
        }

        position.index = i;
        let ref_index = index_alpha(
            instance,
            &position,
            (pseudo_rand & 0xFFFF_FFFF) as u32,
            ref_lane == position.lane,
        );

        let ref_offset_u64 =
            u64::from(instance.lane_length) * u64::from(ref_lane) + u64::from(ref_index);
        debug_assert!(ref_offset_u64 < instance.memory_len() as u64);
        let ref_offset = ref_offset_u64 as u32;

        // SAFETY: all three offsets are in bounds for a well-formed instance,
        // and `curr_offset` aliases neither of the reads; see the aliasing
        // argument in `scalar::fill_segment`.
        unsafe {
            let prev = instance.block(prev_offset);
            let reference = instance.block(ref_offset);
            let curr = instance.block_mut(curr_offset);
            fill_block(
                prev.0.as_ptr(),
                reference.0.as_ptr(),
                curr.0.as_mut_ptr(),
                with_xor,
            );
        }

        i += 1;
        curr_offset = curr_offset.wrapping_add(1);
        prev_offset = prev_offset.wrapping_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fill_block::{Backend, detect, scalar};
    use crate::params::{Algorithm, Memory, Params, TagLen, Version};

    /// splitmix64, same stand-in as the other backend suites.
    fn sm(x: u64) -> u64 {
        let x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        let x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        x ^ (x >> 31)
    }

    #[test]
    fn fill_block_matches_scalar_over_random_triples() {
        for round in 0..64u64 {
            let mut prev = Block::ZERO;
            let mut reference = Block::ZERO;
            let mut next = Block::ZERO;
            for i in 0..QWORDS_IN_BLOCK {
                prev.0[i] = sm(round * 400 + i as u64);
                reference.0[i] = sm(round * 400 + 128 + i as u64);
                next.0[i] = sm(round * 400 + 256 + i as u64);
            }
            for with_xor in [false, true] {
                let mut want = next;
                scalar::fill_block(&prev, &reference, &mut want, with_xor);

                let mut got = next;
                // SAFETY: SIMD128 is compiled in (this module only exists
                // then); all three blocks are live and `got` is exclusive.
                unsafe {
                    fill_block(
                        prev.0.as_ptr(),
                        reference.0.as_ptr(),
                        got.0.as_mut_ptr(),
                        with_xor,
                    )
                };
                assert_eq!(got.0, want.0, "round {round}, with_xor {with_xor}");
            }
        }
    }

    #[test]
    fn next_addresses_matches_scalar() {
        let mut input = Block::ZERO;
        for i in 0..QWORDS_IN_BLOCK {
            input.0[i] = sm(i as u64);
        }
        for _ in 0..4 {
            let mut want = Block::ZERO;
            let mut got = Block::ZERO;
            let mut input_want = input;
            let mut input_got = input;
            scalar::next_addresses(&mut want, &mut input_want);
            // SAFETY: both live locals, distinct.
            unsafe { next_addresses(&mut got, &mut input_got) };
            assert_eq!(got.0, want.0);
            assert_eq!(input_got.0, input_want.0, "the counter must advance equally");
            input = input_got;
        }
    }

    #[test]
    fn small_hashes_match_scalar() {
        // Every variant, both versions, multi-lane and multi-pass: the whole
        // segment machinery, not just the round.
        for (alg, ver) in [
            (Algorithm::Argon2d, Version::V0x10),
            (Algorithm::Argon2d, Version::V0x13),
            (Algorithm::Argon2i, Version::V0x10),
            (Algorithm::Argon2i, Version::V0x13),
            (Algorithm::Argon2id, Version::V0x10),
            (Algorithm::Argon2id, Version::V0x13),
        ] {
            let params = Params::builder()
                .memory(Memory::kib(64))
                .passes(3)
                .lanes(4)
                .tag_len(TagLen::bytes(32))
                .build()
                .expect("params");
            let mut want = [0u8; 32];
            let mut got = [0u8; 32];
            // SAFETY: both backends are available in this build (this module
            // only exists under +simd128, and Scalar is always available).
            unsafe {
                crate::core::hash_traced(
                    Backend::Scalar,
                    alg,
                    ver,
                    &params,
                    b"pwd",
                    b"salt-value",
                    &[],
                    &[],
                    &mut want,
                    None,
                )
                .expect("scalar hash");
                crate::core::hash_traced(
                    Backend::Wasm128,
                    alg,
                    ver,
                    &params,
                    b"pwd",
                    b"salt-value",
                    &[],
                    &[],
                    &mut got,
                    None,
                )
                .expect("wasm128 hash");
            }
            assert_eq!(got, want, "{alg:?} {ver:?}");
        }
    }

    #[test]
    fn detection_picks_wasm128_when_compiled_in() {
        // This module only exists under +simd128, so detection must select it.
        assert!(Backend::Wasm128.is_available());
        assert_eq!(detect(), Backend::Wasm128);
    }
}

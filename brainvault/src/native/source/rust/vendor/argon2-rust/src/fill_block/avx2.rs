//! x86-64 AVX2 `fill_block` / `fill_segment`.
//!
//! Ported from the `#elif defined(__AVX2__)` branch of `fill_block` /
//! `next_addresses` / `fill_segment` in `phc-winner-argon2/src/opt.c` and from
//! the `#else /* __AVX2__ */` half of
//! `phc-winner-argon2/src/blake2/blamka-round-opt.h`.
//!
//! # Layout, and why the two passes need different round macros
//!
//! The 1 KiB block is 32 `__m256i`, so `state[j]` holds block words
//! `4j .. 4j+3`. A single `G` step works on four 64-bit lanes at once, so one
//! `(A, B, C, D)` quadruple of registers is four BLAKE2b columns in parallel.
//!
//! **Column pass** (`opt.c:94-97`), four calls of `BLAKE2_ROUND_1`:
//!
//! ```text
//! BLAKE2_ROUND_1(state[8i+0], state[8i+4], state[8i+1], state[8i+5],
//!                state[8i+2], state[8i+6], state[8i+3], state[8i+7])
//! ```
//!
//! Note the argument order is **not** sequential. `BLAKE2_ROUND_1`'s parameters
//! are `(A0, A1, B0, B1, C0, C1, D0, D1)`, so for `i == 0` this binds
//! `A0 = state[0]` (words 0-3), `B0 = state[1]` (4-7), `C0 = state[2]` (8-11),
//! `D0 = state[3]` (12-15) — the 4x4 matrix of words 0..15, one whole column
//! round — and `A1..D1 = state[4..7]`, the matrix of words 16..31. Getting the
//! order wrong still compiles and still produces plausible-looking wrong hashes,
//! which is why the `fill_block_matches_scalar_over_2048_triples` unit test
//! exists.
//!
//! **Row pass** (`opt.c:99-102`), four calls of `BLAKE2_ROUND_2`:
//!
//! ```text
//! BLAKE2_ROUND_2(state[0+i], state[4+i], state[8+i], state[12+i],
//!                state[16+i], state[20+i], state[24+i], state[28+i])
//! ```
//!
//! Here the four lanes of `A0 = state[i]` are words `4i .. 4i+3`, and the row
//! groups the C describes are `2j, 2j+1, 2j+16, 2j+17, ..., 2j+112, 2j+113`.
//! Working through it, lanes 0 and 1 of the `*0` registers plus lanes 0 and 1 of
//! the `*1` registers are the four columns of row group `2i`, and lanes 2 and 3
//! are row group `2i+1`. The four columns of one group are therefore **split
//! across two registers**, so the diagonal step cannot be a plain
//! `permute4x64` — it needs `DIAGONALIZE_2`'s `_mm256_blend_epi32` lane surgery
//! to rotate a 4-element sequence that lives half in `B0` and half in `B1`.
//! That is the whole reason `BLAKE2_ROUND_1` and `BLAKE2_ROUND_2` differ.
//!
//! # Why `#[target_feature]` is on `fill_segment` and not on `fill_block`
//!
//! LLVM will not inline a callee with a richer feature set into a poorer caller.
//! Keeping the boundary at [`fill_segment`] lets `fill_block` inline into it,
//! which is what preserves the `opt.c` trick of carrying the 1 KiB `state` across
//! loop iterations instead of re-reading the previous block every time.
//!
//! # Testing this backend on `aarch64-apple-darwin` — measured, not assumed
//!
//! Rosetta 2 (macOS 26.5.2, Apple M5 Max) *executes* AVX2 but does not advertise
//! it. Measured with a standalone probe compiled for `x86_64-apple-darwin`:
//!
//! ```text
//! cfg sse2 = true   cfg ssse3 = true   cfg avx2 = false   cfg avx512f = false
//! detect sse2 = true   detect ssse3 = true   detect sse4.1 = true
//! detect avx = false   detect avx2 = false   detect avx512f = false
//! vpmuludq + vpaddq + vpermq executed and returned the right answer
//! ```
//!
//! So `Backend::Avx2.is_available()` is `false` here and
//! [`crate::fill_block::detect`] correctly refuses to pick AVX2 — that is the
//! *right* behaviour, not a bug, and it must not be "fixed": on a genuine
//! SSE2-only CPU, selecting AVX2 would be a `SIGILL`.
//!
//! Coverage therefore comes from a **forced** run that deliberately bypasses
//! detection and calls the `#[target_feature(enable = "avx2")]` entry point
//! anyway:
//!
//! ```text
//! RUSTFLAGS="--cfg argon2_force_avx2" \
//!   cargo test --target x86_64-apple-darwin --features internal-api avx2
//! ```
//!
//! `--cfg argon2_force_avx2` is off by default and only ever affects
//! `#[cfg(test)]` code (see `tests::FORCE_UNDETECTED_AVX2`), so a normal build on
//! a real SSE2-only CPU can never take that path. Under Rosetta the hardware
//! genuinely executes the instructions, so those forced tests are real
//! validation rather than a formality.
//!
//! Do **not** reach for `RUSTFLAGS="-C target-feature=+avx2"` instead. It would
//! work — `is_x86_feature_detected!` short-circuits on
//! `cfg!(target_feature = ...)` — but it also compiles *every* backend, `scalar`
//! and `sse2` included, with AVX2 enabled, so the "SSE2" path would stop being an
//! SSE2 path and the comparison would lose its meaning. And never add
//! `+avx512f` to any of those flags — see `avx512.rs`.

use core::arch::x86_64::*;
use core::mem::MaybeUninit;

use crate::block::{Block, Instance, Position};
use crate::params::{ADDRESSES_IN_BLOCK, HWORDS_IN_BLOCK};

/// `ARGON2_ADDRESSES_IN_BLOCK` as a `u32`, for `i % 128` in `fill_segment`.
const ADDRESSES_IN_BLOCK_U32: u32 = ADDRESSES_IN_BLOCK as u32;

// ---------------------------------------------------------------------------
// blamka-round-opt.h, AVX2 path
// ---------------------------------------------------------------------------

/// The `rotr24` shuffle table — `blamka-round-opt.h:186`.
///
/// `_mm256_setr_epi8(3, 4, 5, 6, 7, 0, 1, 2, 11, 12, 13, 14, 15, 8, 9, 10, ...)`
/// repeated for the upper 128-bit lane, because `vpshufb` shuffles each 128-bit
/// lane independently. Within each 8-byte group `table[j] = (j + 3) % 8`, a
/// rotate **right** by 3 bytes = 24 bits.
///
/// Held as a plain byte array rather than `_mm256_setr_epi8` so the lane order
/// is unambiguous: on little-endian, `TABLE[0]` is byte 0 of the vector. LLVM
/// folds the `loadu` into a constant-pool reference, exactly what the C emits.
const R24: [u8; 32] = [
    3, 4, 5, 6, 7, 0, 1, 2, 11, 12, 13, 14, 15, 8, 9, 10, //
    3, 4, 5, 6, 7, 0, 1, 2, 11, 12, 13, 14, 15, 8, 9, 10,
];

/// The `rotr16` shuffle table — `blamka-round-opt.h:187`.
/// `table[j] = (j + 2) % 8`, a rotate right by 16 bits. See [`R24`].
const R16: [u8; 32] = [
    2, 3, 4, 5, 6, 7, 0, 1, 10, 11, 12, 13, 14, 15, 8, 9, //
    2, 3, 4, 5, 6, 7, 0, 1, 10, 11, 12, 13, 14, 15, 8, 9,
];

/// `rotr32` — `blamka-round-opt.h:185`.
/// `_mm256_shuffle_epi32(x, _MM_SHUFFLE(2, 3, 0, 1))`, i.e. swap the two 32-bit
/// halves of every 64-bit lane. `_MM_SHUFFLE(2, 3, 0, 1) == 0b10_11_00_01`.
#[inline(always)]
unsafe fn rotr32(x: __m256i) -> __m256i {
    // SAFETY: `_mm256_shuffle_epi32` is AVX2, which every caller enables.
    unsafe { _mm256_shuffle_epi32::<0b10_11_00_01>(x) }
}

/// `rotr24` — `blamka-round-opt.h:186`.
#[inline(always)]
unsafe fn rotr24(x: __m256i) -> __m256i {
    // SAFETY: `_mm256_shuffle_epi8` and `_mm256_loadu_si256` are AVX2. `loadu`
    // imposes no alignment requirement on `R24`.
    unsafe { _mm256_shuffle_epi8(x, _mm256_loadu_si256(R24.as_ptr().cast())) }
}

/// `rotr16` — `blamka-round-opt.h:187`.
#[inline(always)]
unsafe fn rotr16(x: __m256i) -> __m256i {
    // SAFETY: as `rotr24`.
    unsafe { _mm256_shuffle_epi8(x, _mm256_loadu_si256(R16.as_ptr().cast())) }
}

/// `rotr63` — `blamka-round-opt.h:188`.
/// `_mm256_xor_si256(_mm256_srli_epi64(x, 63), _mm256_add_epi64(x, x))`;
/// `x + x` is the `<< 1` half of a rotate right by 63.
#[inline(always)]
unsafe fn rotr63(x: __m256i) -> __m256i {
    // SAFETY: all three intrinsics are AVX2.
    unsafe { _mm256_xor_si256(_mm256_srli_epi64::<63>(x), _mm256_add_epi64(x, x)) }
}

/// The `fBlaMka` core, written out in `G1_AVX2` / `G2_AVX2` rather than factored
/// into a function — `blamka-round-opt.h:192-194`:
///
/// ```c
/// __m256i ml = _mm256_mul_epu32(A0, B0);
/// ml = _mm256_add_epi64(ml, ml);
/// A0 = _mm256_add_epi64(A0, _mm256_add_epi64(B0, ml));
/// ```
///
/// That is `a + (b + 2 * lo32(a) * lo32(b))`. The SSE2 path spells the same
/// value `(a + b) + (z + z)`; unsigned addition is associative modulo 2^64, so
/// the two agree bit for bit.
#[inline(always)]
unsafe fn muladd(a: __m256i, b: __m256i) -> __m256i {
    // SAFETY: `_mm256_mul_epu32` and `_mm256_add_epi64` are AVX2.
    unsafe {
        let ml = _mm256_mul_epu32(a, b);
        let ml = _mm256_add_epi64(ml, ml);
        _mm256_add_epi64(a, _mm256_add_epi64(b, ml))
    }
}

/// `G1_AVX2` — `blamka-round-opt.h:190-217`. The `rotr32` / `rotr24` half of `G`.
///
/// The C interleaves the `*0` and `*1` register sets for scheduling; they are
/// independent, so the order below (which follows the C) does not affect the
/// result.
#[inline(always)]
#[allow(clippy::too_many_arguments)]
unsafe fn g1(
    a0: &mut __m256i,
    a1: &mut __m256i,
    b0: &mut __m256i,
    b1: &mut __m256i,
    c0: &mut __m256i,
    c1: &mut __m256i,
    d0: &mut __m256i,
    d1: &mut __m256i,
) {
    // SAFETY: `_mm256_xor_si256` is AVX2; `muladd` and the rotations need AVX2,
    // which this function's callers enable.
    unsafe {
        *a0 = muladd(*a0, *b0);
        *d0 = _mm256_xor_si256(*d0, *a0);
        *d0 = rotr32(*d0);

        *c0 = muladd(*c0, *d0);
        *b0 = _mm256_xor_si256(*b0, *c0);
        *b0 = rotr24(*b0);

        *a1 = muladd(*a1, *b1);
        *d1 = _mm256_xor_si256(*d1, *a1);
        *d1 = rotr32(*d1);

        *c1 = muladd(*c1, *d1);
        *b1 = _mm256_xor_si256(*b1, *c1);
        *b1 = rotr24(*b1);
    }
}

/// `G2_AVX2` — `blamka-round-opt.h:219-244`. The `rotr16` / `rotr63` half.
#[inline(always)]
#[allow(clippy::too_many_arguments)]
unsafe fn g2(
    a0: &mut __m256i,
    a1: &mut __m256i,
    b0: &mut __m256i,
    b1: &mut __m256i,
    c0: &mut __m256i,
    c1: &mut __m256i,
    d0: &mut __m256i,
    d1: &mut __m256i,
) {
    // SAFETY: as `g1`.
    unsafe {
        *a0 = muladd(*a0, *b0);
        *d0 = _mm256_xor_si256(*d0, *a0);
        *d0 = rotr16(*d0);

        *c0 = muladd(*c0, *d0);
        *b0 = _mm256_xor_si256(*b0, *c0);
        *b0 = rotr63(*b0);

        *a1 = muladd(*a1, *b1);
        *d1 = _mm256_xor_si256(*d1, *a1);
        *d1 = rotr16(*d1);

        *c1 = muladd(*c1, *d1);
        *b1 = _mm256_xor_si256(*b1, *c1);
        *b1 = rotr63(*b1);
    }
}

/// `DIAGONALIZE_1` — `blamka-round-opt.h:246-255`.
///
/// The column pass keeps all four columns of a matrix inside one register, so
/// the diagonal step is a plain lane rotation of each register:
/// `B` left by 1, `C` by 2, `D` by 3.
///
/// `_MM_SHUFFLE(0, 3, 2, 1) == 0b00_11_10_01` selects lanes `(1, 2, 3, 0)`,
/// a rotate left by 1; `_MM_SHUFFLE(1, 0, 3, 2) == 0b01_00_11_10` is by 2 and
/// `_MM_SHUFFLE(2, 1, 0, 3) == 0b10_01_00_11` is by 3.
#[inline(always)]
unsafe fn diagonalize_1(
    b0: &mut __m256i,
    b1: &mut __m256i,
    c0: &mut __m256i,
    c1: &mut __m256i,
    d0: &mut __m256i,
    d1: &mut __m256i,
) {
    // SAFETY: `_mm256_permute4x64_epi64` is AVX2.
    unsafe {
        *b0 = _mm256_permute4x64_epi64::<0b00_11_10_01>(*b0);
        *c0 = _mm256_permute4x64_epi64::<0b01_00_11_10>(*c0);
        *d0 = _mm256_permute4x64_epi64::<0b10_01_00_11>(*d0);

        *b1 = _mm256_permute4x64_epi64::<0b00_11_10_01>(*b1);
        *c1 = _mm256_permute4x64_epi64::<0b01_00_11_10>(*c1);
        *d1 = _mm256_permute4x64_epi64::<0b10_01_00_11>(*d1);
    }
}

/// `UNDIAGONALIZE_1` — `blamka-round-opt.h:274-283`. [`diagonalize_1`] with the
/// `B` and `D` rotation amounts swapped, which inverts it.
#[inline(always)]
unsafe fn undiagonalize_1(
    b0: &mut __m256i,
    b1: &mut __m256i,
    c0: &mut __m256i,
    c1: &mut __m256i,
    d0: &mut __m256i,
    d1: &mut __m256i,
) {
    // SAFETY: `_mm256_permute4x64_epi64` is AVX2.
    unsafe {
        *b0 = _mm256_permute4x64_epi64::<0b10_01_00_11>(*b0);
        *c0 = _mm256_permute4x64_epi64::<0b01_00_11_10>(*c0);
        *d0 = _mm256_permute4x64_epi64::<0b00_11_10_01>(*d0);

        *b1 = _mm256_permute4x64_epi64::<0b10_01_00_11>(*b1);
        *c1 = _mm256_permute4x64_epi64::<0b01_00_11_10>(*c1);
        *d1 = _mm256_permute4x64_epi64::<0b00_11_10_01>(*d1);
    }
}

/// `DIAGONALIZE_2` — `blamka-round-opt.h:257-272`.
///
/// In the row pass the four columns of one matrix live in lanes
/// `(x0[0], x0[1], x1[0], x1[1])` (and `(x0[2], x0[3], x1[2], x1[3])` for the
/// second matrix), so rotating them means moving data **between** `x0` and `x1`.
///
/// `_mm256_blend_epi32(a, b, 0xCC)` takes 64-bit lanes 1 and 3 from `b`
/// (`0xCC == 0b11001100`, and each 64-bit lane is two 32-bit lanes), and `0x33`
/// takes lanes 0 and 2 from `b`. `_mm256_permute4x64_epi64` with
/// `_MM_SHUFFLE(2, 3, 0, 1) == 0b10_11_00_01` then swaps the lanes within each
/// 128-bit half. Composing the two:
///
/// ```text
/// B0 <- (B0[1], B1[0], B0[3], B1[2])     rotate B left by 1
/// B1 <- (B1[1], B0[0], B1[3], B0[2])
/// C0 <- C1,  C1 <- C0                    rotate C left by 2
/// D0 <- (D1[1], D0[0], D1[3], D0[2])     rotate D left by 3
/// D1 <- (D0[1], D1[0], D0[3], D1[2])
/// ```
#[inline(always)]
unsafe fn diagonalize_2(
    b0: &mut __m256i,
    b1: &mut __m256i,
    c0: &mut __m256i,
    c1: &mut __m256i,
    d0: &mut __m256i,
    d1: &mut __m256i,
) {
    // SAFETY: `_mm256_blend_epi32` and `_mm256_permute4x64_epi64` are AVX2.
    unsafe {
        let tmp1 = _mm256_blend_epi32::<0xCC>(*b0, *b1);
        let tmp2 = _mm256_blend_epi32::<0x33>(*b0, *b1);
        // The C assigns B1 from tmp1 and B0 from tmp2, in that order.
        *b1 = _mm256_permute4x64_epi64::<0b10_11_00_01>(tmp1);
        *b0 = _mm256_permute4x64_epi64::<0b10_11_00_01>(tmp2);

        core::mem::swap(c0, c1);

        let tmp1 = _mm256_blend_epi32::<0xCC>(*d0, *d1);
        let tmp2 = _mm256_blend_epi32::<0x33>(*d0, *d1);
        *d0 = _mm256_permute4x64_epi64::<0b10_11_00_01>(tmp1);
        *d1 = _mm256_permute4x64_epi64::<0b10_11_00_01>(tmp2);
    }
}

/// `UNDIAGONALIZE_2` — `blamka-round-opt.h:285-300`.
///
/// The exact inverse of [`diagonalize_2`]. Note the two differences from it,
/// both of which the C spells out and both of which are easy to lose:
/// `B0`/`B1` take the *opposite* blend of the two, and the `D` pair swaps which
/// mask feeds which register (`0x33` for `D0`, `0xCC` for `D1`).
#[inline(always)]
unsafe fn undiagonalize_2(
    b0: &mut __m256i,
    b1: &mut __m256i,
    c0: &mut __m256i,
    c1: &mut __m256i,
    d0: &mut __m256i,
    d1: &mut __m256i,
) {
    // SAFETY: `_mm256_blend_epi32` and `_mm256_permute4x64_epi64` are AVX2.
    unsafe {
        let tmp1 = _mm256_blend_epi32::<0xCC>(*b0, *b1);
        let tmp2 = _mm256_blend_epi32::<0x33>(*b0, *b1);
        *b0 = _mm256_permute4x64_epi64::<0b10_11_00_01>(tmp1);
        *b1 = _mm256_permute4x64_epi64::<0b10_11_00_01>(tmp2);

        core::mem::swap(c0, c1);

        let tmp1 = _mm256_blend_epi32::<0x33>(*d0, *d1);
        let tmp2 = _mm256_blend_epi32::<0xCC>(*d0, *d1);
        *d0 = _mm256_permute4x64_epi64::<0b10_11_00_01>(tmp1);
        *d1 = _mm256_permute4x64_epi64::<0b10_11_00_01>(tmp2);
    }
}

/// `BLAKE2_ROUND_1` — `blamka-round-opt.h:302-313`. The **column** pass round.
///
/// ```c
/// G1_AVX2(...); G2_AVX2(...);
/// DIAGONALIZE_1(A0, B0, C0, D0, A1, B1, C1, D1);
/// G1_AVX2(...); G2_AVX2(...);
/// UNDIAGONALIZE_1(A0, B0, C0, D0, A1, B1, C1, D1);
/// ```
///
/// Arguments and results are both in the macro's `(A0, A1, B0, B1, C0, C1, D0,
/// D1)` order, so a caller writes the eight results straight back to the eight
/// slots it read.
#[inline(always)]
#[allow(clippy::too_many_arguments)]
unsafe fn blake2_round_1(
    a0: __m256i,
    a1: __m256i,
    b0: __m256i,
    b1: __m256i,
    c0: __m256i,
    c1: __m256i,
    d0: __m256i,
    d1: __m256i,
) -> [__m256i; 8] {
    let (mut a0, mut a1, mut b0, mut b1) = (a0, a1, b0, b1);
    let (mut c0, mut c1, mut d0, mut d1) = (c0, c1, d0, d1);

    // SAFETY: every callee needs AVX2, which this function's caller enables.
    unsafe {
        g1(
            &mut a0, &mut a1, &mut b0, &mut b1, &mut c0, &mut c1, &mut d0, &mut d1,
        );
        g2(
            &mut a0, &mut a1, &mut b0, &mut b1, &mut c0, &mut c1, &mut d0, &mut d1,
        );

        diagonalize_1(&mut b0, &mut b1, &mut c0, &mut c1, &mut d0, &mut d1);

        g1(
            &mut a0, &mut a1, &mut b0, &mut b1, &mut c0, &mut c1, &mut d0, &mut d1,
        );
        g2(
            &mut a0, &mut a1, &mut b0, &mut b1, &mut c0, &mut c1, &mut d0, &mut d1,
        );

        undiagonalize_1(&mut b0, &mut b1, &mut c0, &mut c1, &mut d0, &mut d1);
    }

    [a0, a1, b0, b1, c0, c1, d0, d1]
}

/// `BLAKE2_ROUND_2` — `blamka-round-opt.h:315-326`. The **row** pass round.
///
/// Identical to [`blake2_round_1`] except that the diagonal step is
/// [`diagonalize_2`] / [`undiagonalize_2`], which can rotate a 4-element
/// sequence split across a register pair.
#[inline(always)]
#[allow(clippy::too_many_arguments)]
unsafe fn blake2_round_2(
    a0: __m256i,
    a1: __m256i,
    b0: __m256i,
    b1: __m256i,
    c0: __m256i,
    c1: __m256i,
    d0: __m256i,
    d1: __m256i,
) -> [__m256i; 8] {
    let (mut a0, mut a1, mut b0, mut b1) = (a0, a1, b0, b1);
    let (mut c0, mut c1, mut d0, mut d1) = (c0, c1, d0, d1);

    // SAFETY: every callee needs AVX2, which this function's caller enables.
    unsafe {
        g1(
            &mut a0, &mut a1, &mut b0, &mut b1, &mut c0, &mut c1, &mut d0, &mut d1,
        );
        g2(
            &mut a0, &mut a1, &mut b0, &mut b1, &mut c0, &mut c1, &mut d0, &mut d1,
        );

        diagonalize_2(&mut b0, &mut b1, &mut c0, &mut c1, &mut d0, &mut d1);

        g1(
            &mut a0, &mut a1, &mut b0, &mut b1, &mut c0, &mut c1, &mut d0, &mut d1,
        );
        g2(
            &mut a0, &mut a1, &mut b0, &mut b1, &mut c0, &mut c1, &mut d0, &mut d1,
        );

        undiagonalize_2(&mut b0, &mut b1, &mut c0, &mut c1, &mut d0, &mut d1);
    }

    [a0, a1, b0, b1, c0, c1, d0, d1]
}

// ---------------------------------------------------------------------------
// opt.c, AVX2 path
// ---------------------------------------------------------------------------

/// `fill_block()` — `opt.c:75-108`.
///
/// ```c
/// if (with_xor) { state[i] ^= ref[i];  block_XY[i] = state[i] ^ next[i]; }
/// else          { block_XY[i] = state[i] = state[i] ^ ref[i]; }
/// 4 x BLAKE2_ROUND_1 (columns); 4 x BLAKE2_ROUND_2 (rows);
/// state[i] ^= block_XY[i]; store next[i] = state[i];
/// ```
///
/// `state` is the caller's live 1 KiB register file: on entry it holds the
/// previous block, on exit the block just written to `next_block`. That is what
/// lets `fill_segment` skip re-reading `memory[prev_offset]` every iteration.
///
/// # Safety
///
/// * The CPU must support AVX2.
/// * `ref_block` must be valid for reads of one [`Block`] and `next_block` for
///   reads and writes of one [`Block`].
/// * The two may alias — `next_addresses` calls this with
///   `ref_block == next_block`. That is sound because every load from
///   `ref_block` happens in the first loop and every store to `next_block` in
///   the last, and because raw pointers are used rather than a `&`/`&mut` pair.
///   When `with_xor` is `false` the old contents of `next_block` are never read.
#[inline(always)]
unsafe fn fill_block(
    state: &mut [__m256i; HWORDS_IN_BLOCK],
    ref_block: *const Block,
    next_block: *mut Block,
    with_xor: bool,
) {
    let refp = ref_block.cast::<__m256i>();
    let nextp = next_block.cast::<__m256i>();

    // `opt.c` declares `__m256i block_XY[...];` UNINITIALISED, and so does this.
    //
    // Spelling it `[_mm256_setzero_si256(); HWORDS_IN_BLOCK]` instead costs a
    // real 1 KiB `memset` **per block**: LLVM does not eliminate it, because the
    // two arms of `if with_xor` fill the array in separate basic blocks and
    // dead-store elimination never sees a single whole-array overwrite.
    //
    // Measured, not assumed. Release asm for `x86_64-unknown-linux-musl`,
    // counting inside the `avx2::fill_segment` symbol:
    //
    //   as written (MaybeUninit::uninit)   1807 instructions, 3 memset sites
    //   `[_mm256_setzero_si256(); 32]`     1835 instructions, 6 memset sites
    //
    // `sse2.rs` has the same shape (2122 -> 2145 instructions, 3 -> 6 memset
    // sites). The three extra sites are the three places `fill_block` inlines.
    //
    // SAFETY of the `assume_init` below: both arms write all 32 elements before
    // anything reads one, so the array is fully initialised by the time the
    // final loop runs.
    let mut block_xy: [MaybeUninit<__m256i>; HWORDS_IN_BLOCK] =
        [const { MaybeUninit::uninit() }; HWORDS_IN_BLOCK];

    // SAFETY: the accesses are `loadu`/`storeu`, so no alignment is required,
    // and `i < HWORDS_IN_BLOCK == 32` keeps every one inside the single `Block`
    // each pointer is valid for (`32 * 32 == 1024` bytes). All AVX2.
    unsafe {
        if with_xor {
            for i in 0..HWORDS_IN_BLOCK {
                state[i] = _mm256_xor_si256(state[i], _mm256_loadu_si256(refp.add(i)));
                block_xy[i] = MaybeUninit::new(_mm256_xor_si256(
                    state[i],
                    _mm256_loadu_si256(nextp.add(i).cast_const()),
                ));
            }
        } else {
            for i in 0..HWORDS_IN_BLOCK {
                state[i] = _mm256_xor_si256(state[i], _mm256_loadu_si256(refp.add(i)));
                block_xy[i] = MaybeUninit::new(state[i]);
            }
        }
    }

    // opt.c:94-97 — columns. Mind the argument order; see the module docs.
    //
    // The eight slots are written back one by one rather than through an array
    // of indices: holding the indices in an array makes LLVM spill it and lose
    // the proof that every index is `< 32`, which leaves a `panic_bounds_check`
    // in the emitted code. Verified by disassembly, see the module docs.
    for i in 0..4 {
        let base = 8 * i;
        // SAFETY: `base + 7 <= 31`; the round needs AVX2, as does this function.
        let r = unsafe {
            blake2_round_1(
                state[base],
                state[base + 4],
                state[base + 1],
                state[base + 5],
                state[base + 2],
                state[base + 6],
                state[base + 3],
                state[base + 7],
            )
        };
        state[base] = r[0];
        state[base + 4] = r[1];
        state[base + 1] = r[2];
        state[base + 5] = r[3];
        state[base + 2] = r[4];
        state[base + 6] = r[5];
        state[base + 3] = r[6];
        state[base + 7] = r[7];
    }

    // opt.c:99-102 — rows. Slot `4k + i` for result `k`, i.e. the same
    // `state[0+i], state[4+i], ..., state[28+i]` the C passes.
    for i in 0..4 {
        // SAFETY: `28 + i <= 31`; the round needs AVX2, as does this function.
        let r = unsafe {
            blake2_round_2(
                state[i],
                state[4 + i],
                state[8 + i],
                state[12 + i],
                state[16 + i],
                state[20 + i],
                state[24 + i],
                state[28 + i],
            )
        };
        for (k, value) in r.into_iter().enumerate() {
            state[4 * k + i] = value;
        }
    }

    // SAFETY: as the load loop above.
    unsafe {
        for i in 0..HWORDS_IN_BLOCK {
            state[i] = _mm256_xor_si256(state[i], block_xy[i].assume_init());
            _mm256_storeu_si256(nextp.add(i), state[i]);
        }
    }
}

/// `next_addresses()` — `opt.c:148-172`.
///
/// ```c
/// memset(zero_block, 0, ...); memset(zero2_block, 0, ...);
/// input_block->v[6]++;
/// fill_block(zero_block,  input_block,   address_block, 0);
/// fill_block(zero2_block, address_block, address_block, 0);
/// ```
///
/// The two fresh zeroed states make `blockR = 0 ^ ref = ref`, so this is the
/// same computation as `ref.c`'s `fill_block(zero_block, ref, ...)` even though
/// the argument roles differ. The counter is bumped **before** both calls, and
/// the second call deliberately has `ref == next`; see [`fill_block`]'s safety
/// notes for why that is sound.
///
/// # Safety
///
/// The CPU must support AVX2. `address_block` and `input_block` must each be
/// valid for reads and writes of one [`Block`] and must not alias each other.
#[inline(always)]
unsafe fn next_addresses(address_block: *mut Block, input_block: *mut Block) {
    // SAFETY: `_mm256_setzero_si256` is AVX2, which this function's contract requires.
    let zero = unsafe { _mm256_setzero_si256() };
    let mut zero_state = [zero; HWORDS_IN_BLOCK];
    let mut zero2_state = [zero; HWORDS_IN_BLOCK];

    // SAFETY: `input_block` is valid for reads and writes of one `Block` and
    // does not alias `address_block`. The `uint64_t` increment wraps in C, so
    // `wrapping_add` rather than a `+` that would panic in debug.
    unsafe {
        (*input_block).0[6] = (*input_block).0[6].wrapping_add(1);
    }

    // SAFETY: both pointers are valid for one `Block`; `fill_block` explicitly
    // permits `ref == next`, which the second call relies on.
    unsafe {
        fill_block(
            &mut zero_state,
            input_block.cast_const(),
            address_block,
            false,
        );
        fill_block(
            &mut zero2_state,
            address_block.cast_const(),
            address_block,
            false,
        );
    }
}

/// `fill_segment()` — `opt.c:174-283`, with `state` fixed to `__m256i[32]`.
///
/// `#[inline(always)]` is load-bearing, not a hint: it is what puts this body
/// (and everything it calls) inside [`fill_segment`], which declares
/// `target_feature(enable = "avx2")`, so the intrinsics are selected in the
/// right feature context and `fill_block` keeps `state` live across iterations.
///
/// # Safety
///
/// See [`crate::fill_block::FillSegmentFn`]. The CPU must support AVX2.
#[inline(always)]
unsafe fn fill_segment_impl(instance: &Instance, mut position: Position) {
    // `opt.c:190` is `if (instance == NULL) return;`. A `&Instance` is never
    // null, but the `%` operators below would divide by zero on a degenerate
    // instance and this crate must not panic, so guard those instead. Same
    // guard as `scalar::fill_segment`.
    if instance.lane_length == 0 || instance.lanes == 0 {
        return;
    }

    // opt.c:194-197.
    let data_independent_addressing = instance.data_independent_addressing(&position);
    // Version 0x10 always overwrites; 0x13 XORs from pass 1 on (opt.c:272-281).
    let with_xor = instance.with_xor(position.pass);

    // opt.c:199-208.
    let mut address_block = Block::ZERO;
    let mut input_block = if data_independent_addressing {
        instance.address_input_block(&position)
    } else {
        Block::ZERO
    };

    // opt.c:210-219.
    let mut starting_index: u32 = 0;
    if position.pass == 0 && position.slice == 0 {
        // The first two blocks of every lane come from `fill_first_blocks`.
        starting_index = 2;
        if data_independent_addressing {
            // "Don't forget to generate the first block of addresses".
            // SAFETY: AVX2 per this function's contract; the two locals are
            // distinct `Block`s, so the pointers are valid and do not alias.
            unsafe {
                next_addresses(&raw mut address_block, &raw mut input_block);
            }
        }
    }

    // opt.c:222-223. `wrapping_*` mirrors the C's `uint32_t` arithmetic and
    // keeps this function panic-free; nothing here wraps for a valid instance.
    let mut curr_offset = position
        .lane
        .wrapping_mul(instance.lane_length)
        .wrapping_add(position.slice.wrapping_mul(instance.segment_length))
        .wrapping_add(starting_index);

    // opt.c:225-231.
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

    // opt.c:233 `memcpy(state, ((instance->memory + prev_offset)->v), ARGON2_BLOCK_SIZE);`
    //
    // This is the ONLY read of `memory[prev_offset]` into `state`. It is not
    // repeated inside the loop, and in particular it is NOT repeated when
    // `prev_offset` is rotated at `curr_offset % lane_length == 1`, because at
    // that point `state` already holds the block `fill_block` just produced at
    // `curr_offset - 1`, which is exactly `memory[prev_offset]`.
    //
    // SAFETY: `prev_offset` is in bounds for a well-formed instance — for
    // `pass == 0 && slice == 0` it is `lane*lane_length + 1`, otherwise either
    // `curr_offset - 1` or the last block of this lane. `loadu` needs no
    // alignment and 32 `__m256i` is exactly one `Block`.
    let mut state = unsafe {
        let p = instance
            .block_ptr(prev_offset)
            .cast::<__m256i>()
            .cast_const();
        let mut state = [_mm256_setzero_si256(); HWORDS_IN_BLOCK];
        for (i, slot) in state.iter_mut().enumerate() {
            *slot = _mm256_loadu_si256(p.add(i));
        }
        state
    };

    // opt.c:235-282.
    let mut i = starting_index;
    while i < instance.segment_length {
        // 1.1 Rotating prev_offset if needed (opt.c:237-240).
        if curr_offset % instance.lane_length == 1 {
            prev_offset = curr_offset.wrapping_sub(1);
        }

        // 1.2.1 Taking the pseudo-random value (opt.c:244-251).
        let pseudo_rand: u64 = if data_independent_addressing {
            let slot = (i % ADDRESSES_IN_BLOCK_U32) as usize;
            if slot == 0 {
                // SAFETY: as the `next_addresses` call above.
                unsafe {
                    next_addresses(&raw mut address_block, &raw mut input_block);
                }
            }
            address_block.0[slot]
        } else {
            // The C reads this from memory, not from `state`, even though the
            // two are equal here; kept identical for exact parity with `ref.c`.
            //
            // SAFETY: `prev_offset` is a block this lane has already finalised
            // (earlier in this segment, or the last block of the lane on a
            // wrap-around), so it is in bounds and no other lane writes it.
            unsafe { (*instance.block_ptr(prev_offset)).0[0] }
        };

        // 1.2.2 Computing the lane of the reference block (opt.c:254-259).
        let mut ref_lane = ((pseudo_rand >> 32) % u64::from(instance.lanes)) as u32;
        if position.pass == 0 && position.slice == 0 {
            // Cannot reference other lanes yet.
            ref_lane = position.lane;
        }

        // 1.2.3 (opt.c:264-266) — `index_alpha` takes the LOW 32 bits.
        position.index = i;
        let ref_index = crate::core::index_alpha(
            instance,
            &position,
            (pseudo_rand & 0xFFFF_FFFF) as u32,
            ref_lane == position.lane,
        );

        // opt.c:269-271. Evaluated in `u64` because the C's `ref_lane` is a
        // `uint64_t`; for a well-formed instance the sum is < memory_blocks.
        let ref_offset_u64 =
            u64::from(instance.lane_length) * u64::from(ref_lane) + u64::from(ref_index);
        debug_assert!(ref_offset_u64 < instance.memory_len() as u64);
        let ref_offset = ref_offset_u64 as u32;

        // 2 Creating a new block (opt.c:272-281).
        //
        // SAFETY: `ref_offset` and `curr_offset` are both in bounds for a
        // well-formed instance (see the `FillSegmentFn` contract). They cannot
        // be equal — `index_alpha`'s reference area always stops short of
        // `position.index` — but `fill_block` would tolerate it anyway, and no
        // `&`/`&mut` pair is formed. Cross-lane exclusivity is the caller's job:
        // within a slice, lane `l` writes only its own segment.
        unsafe {
            fill_block(
                &mut state,
                instance.block_ptr(ref_offset).cast_const(),
                instance.block_ptr(curr_offset),
                with_xor,
            );
        }

        i += 1;
        curr_offset = curr_offset.wrapping_add(1);
        prev_offset = prev_offset.wrapping_add(1);
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// AVX2 `fill_segment()`.
///
/// # Safety
///
/// The CPU must support AVX2 — check
/// [`crate::fill_block::Backend::is_available`] or take the pointer from
/// [`crate::fill_block::backend`]. All the requirements of
/// [`crate::fill_block::FillSegmentFn`] apply.
#[target_feature(enable = "avx2")]
pub unsafe fn fill_segment(instance: &Instance, position: Position) {
    // SAFETY: AVX2 is this function's declared feature, so a caller reaching
    // here without it is already unsound; the rest is `FillSegmentFn`'s
    // contract, which the caller upholds.
    unsafe { fill_segment_impl(instance, position) }
}

#[cfg(test)]
mod tests {
    // `argon2_force_avx2` is a deliberate out-of-band cfg (see the module docs
    // and `FORCE_UNDETECTED_AVX2`), not a Cargo feature, so Cargo's
    // `--check-cfg` list cannot know about it.
    #![allow(unexpected_cfgs)]

    use super::super::sse2::test_support::{
        Group, XorShift64Star, assert_fill_block_matches_scalar, check_official_vectors,
        skip_unless_available,
    };
    use super::*;
    use crate::fill_block::{Backend, backend, detect, fill_segment_fn};
    use crate::params::QWORDS_IN_BLOCK;

    /// `fill_block` on whole [`Block`]s, so it can be compared against
    /// `scalar::fill_block`. Loads `prev` into a fresh `state`, exactly as
    /// `fill_segment`'s pre-loop `memcpy` does, then runs one `fill_block`.
    ///
    /// # Safety
    ///
    /// The CPU must support AVX2.
    #[target_feature(enable = "avx2")]
    unsafe fn fill_block_blocks(prev: &Block, reference: &Block, next: &mut Block, with_xor: bool) {
        // SAFETY: AVX2 is declared above. `prev` is one `Block` = 32 `__m256i`,
        // read with `loadu`; `reference` and `next` are distinct live `Block`s.
        unsafe {
            let mut state = [_mm256_setzero_si256(); HWORDS_IN_BLOCK];
            let p = prev.as_ptr().cast::<__m256i>();
            for (i, slot) in state.iter_mut().enumerate() {
                *slot = _mm256_loadu_si256(p.add(i));
            }
            fill_block(&mut state, reference, next, with_xor);
        }
    }

    /// Run the AVX2 tests **even when runtime detection says the CPU has no
    /// AVX2**, by calling the `#[target_feature(enable = "avx2")]` entry point
    /// directly.
    ///
    /// # This is a deliberate, test-only detection bypass
    ///
    /// Calling a `#[target_feature]` function without having detected its
    /// feature is unsound in general. It is acceptable *here, in `#[cfg(test)]`
    /// code only*, because on the development host the hardware really does
    /// execute AVX2 — Rosetta 2 hides `avx2` from `cpuid` but implements the
    /// instructions (measured; see the module docs for the probe output). So the
    /// forced run is genuine validation of real AVX2 execution, not a
    /// formality.
    ///
    /// It is **off by default** and is set out of band, never by a Cargo
    /// feature, so no ordinary build can reach it:
    ///
    /// ```text
    /// RUSTFLAGS="--cfg argon2_force_avx2" \
    ///   cargo test --target x86_64-apple-darwin --features internal-api avx2
    /// ```
    ///
    /// Nothing outside `#[cfg(test)]` reads this flag, and it never touches
    /// [`crate::fill_block::detect`]: on a genuine SSE2-only CPU the library
    /// still refuses to select AVX2, which is the behaviour the
    /// `detection_selects_avx2_only_when_available_and_nothing_wider_is` test
    /// pins — and that test keeps asserting the *unforced* truth even in a
    /// forced run.
    const FORCE_UNDETECTED_AVX2: bool = cfg!(argon2_force_avx2);

    /// Bail out when the host cannot execute AVX2 — `true` means skip.
    ///
    /// On `aarch64-apple-darwin` a plain
    /// `cargo test --target x86_64-apple-darwin` takes this path: Rosetta 2
    /// executes AVX2 but does not advertise it, so `is_available()` is `false`.
    /// The module docs give the `--cfg argon2_force_avx2` that makes these tests
    /// really run, and `ARGON2_REQUIRE_BACKEND=avx2` turns this skip into a
    /// failure so a gate command can prove they did.
    fn skip_without_avx2() -> bool {
        if FORCE_UNDETECTED_AVX2 {
            // Deliberate bypass; see `FORCE_UNDETECTED_AVX2`.
            return false;
        }
        skip_unless_available(Backend::Avx2)
    }

    // ------------------------------------------------------------------
    // Equivalence with the scalar backend
    // ------------------------------------------------------------------

    #[test]
    fn fill_block_matches_scalar_over_2048_triples() {
        if skip_without_avx2() {
            return;
        }
        // SAFETY: `Backend::Avx2.is_available()` confirmed AVX2.
        unsafe {
            assert_fill_block_matches_scalar(
                "avx2",
                fill_block_blocks,
                2048,
                0x0123_4567_89AB_CDEF,
            );
        }
    }

    /// An all-zero block survives every round, because `fBlaMka(0, 0) == 0`.
    #[test]
    fn all_zero_stays_all_zero() {
        if skip_without_avx2() {
            return;
        }
        let mut next = Block::ZERO;
        // SAFETY: AVX2 confirmed.
        unsafe { fill_block_blocks(&Block::ZERO, &Block::ZERO, &mut next, false) };
        assert_eq!(next, Block::ZERO);
    }

    /// `ref == next` with `with_xor == false`, the aliasing `next_addresses`
    /// relies on. The old contents must be ignored entirely.
    #[test]
    fn aliasing_ref_and_next_is_safe_and_ignores_the_old_contents() {
        if skip_without_avx2() {
            return;
        }
        let mut rng = XorShift64Star::new(0xA5A5_5A5A_1234_9876);
        let prev = rng.next_block();
        let reference = rng.next_block();

        let mut want = Block::ZERO;
        crate::fill_block::scalar::fill_block(&prev, &reference, &mut want, false);

        let mut aliased = reference;
        // SAFETY: AVX2 confirmed; `fill_block` documents that `ref` and `next`
        // may be the same block when `with_xor == false`.
        unsafe {
            avx2_fill_block_aliased(&prev, &mut aliased);
        }
        assert_eq!(aliased, want);
    }

    /// The aliased `fill_block` call, behind an AVX2 boundary.
    ///
    /// # Safety
    ///
    /// The CPU must support AVX2.
    #[target_feature(enable = "avx2")]
    unsafe fn avx2_fill_block_aliased(prev: &Block, block: &mut Block) {
        // SAFETY: AVX2 declared; `ref == next` is explicitly permitted when
        // `with_xor == false`.
        unsafe {
            let mut state = [_mm256_setzero_si256(); HWORDS_IN_BLOCK];
            let p = prev.as_ptr().cast::<__m256i>();
            for (i, slot) in state.iter_mut().enumerate() {
                *slot = _mm256_loadu_si256(p.add(i));
            }
            let ptr = &raw mut *block;
            fill_block(&mut state, ptr.cast_const(), ptr, false);
        }
    }

    /// Each of the 128 input words must reach the output. This is the test that
    /// catches a wrong `BLAKE2_ROUND_1` / `BLAKE2_ROUND_2` argument order or a
    /// wrong `DIAGONALIZE_2` blend mask, both of which otherwise compile and
    /// produce plausible-looking wrong hashes.
    #[test]
    fn every_input_word_reaches_the_output() {
        if skip_without_avx2() {
            return;
        }
        let mut rng = XorShift64Star::new(0x1357_9BDF_2468_ACE0);
        let prev = rng.next_block();
        let reference = rng.next_block();

        let base = {
            let mut b = Block::ZERO;
            // SAFETY: AVX2 confirmed.
            unsafe { fill_block_blocks(&prev, &reference, &mut b, false) };
            b
        };

        for w in 0..QWORDS_IN_BLOCK {
            let mut flipped_prev = prev;
            flipped_prev.0[w] ^= 1;
            let mut got = Block::ZERO;
            // SAFETY: AVX2 confirmed.
            unsafe { fill_block_blocks(&flipped_prev, &reference, &mut got, false) };
            assert_ne!(got, base, "flipping prev word {w} changed nothing");
        }
    }

    // ------------------------------------------------------------------
    // Official vectors, with the backend forced
    // ------------------------------------------------------------------

    #[test]
    fn official_vectors_avx2_forced_v0x10_argon2i() {
        if skip_without_avx2() {
            return;
        }
        // SAFETY: `skip_without_avx2()` returned false, so either
        // `Backend::Avx2.is_available()` is true or this is the deliberate,
        // measured Rosetta 2 bypass documented on `FORCE_UNDETECTED_AVX2`.
        unsafe { check_official_vectors(Backend::Avx2, Group::V0x10Argon2i, false) };
    }

    #[test]
    fn official_vectors_avx2_forced_v0x13_argon2i() {
        if skip_without_avx2() {
            return;
        }
        // SAFETY: as above — `skip_without_avx2()` returned false.
        unsafe { check_official_vectors(Backend::Avx2, Group::V0x13Argon2i, false) };
    }

    #[test]
    fn official_vectors_avx2_forced_v0x13_argon2id() {
        if skip_without_avx2() {
            return;
        }
        // SAFETY: as above — `skip_without_avx2()` returned false.
        unsafe { check_official_vectors(Backend::Avx2, Group::V0x13Argon2id, false) };
    }

    #[test]
    #[ignore = "TEST_LARGE_RAM: 1 GiB arena"]
    fn official_vectors_with_the_avx2_backend_forced_including_large_ram() {
        if skip_without_avx2() {
            return;
        }
        // SAFETY: as above — `skip_without_avx2()` returned false.
        unsafe { check_official_vectors(Backend::Avx2, Group::All, true) };
    }

    // ------------------------------------------------------------------
    // Dispatch
    // ------------------------------------------------------------------

    /// Detection must pick AVX2 exactly when the CPU has AVX2 and no AVX-512,
    /// and must never pick it otherwise.
    #[test]
    fn detection_selects_avx2_only_when_available_and_nothing_wider_is() {
        let has_avx2 = Backend::Avx2.is_available();
        let has_avx512 = Backend::Avx512.is_available();

        if has_avx2 && !has_avx512 {
            assert_eq!(
                detect(),
                Backend::Avx2,
                "AVX2 present and no AVX-512, so AVX2 must win"
            );
            assert_eq!(
                backend(),
                Backend::Avx2,
                "the cache must agree with detect()"
            );
        }
        if !has_avx2 {
            assert_ne!(
                detect(),
                Backend::Avx2,
                "AVX2 absent, so it must never be selected"
            );
            assert_ne!(backend(), Backend::Avx2);
        }
        // And `is_available` must agree with a direct probe rather than with a
        // stale cache of its own.
        #[cfg(feature = "std")]
        assert_eq!(has_avx2, std::arch::is_x86_feature_detected!("avx2"));
    }

    #[test]
    fn dispatch_resolves_to_this_module() {
        let f = fill_segment_fn(Backend::Avx2);
        assert!(
            core::ptr::fn_addr_eq(f, fill_segment as unsafe fn(&Instance, Position)),
            "fill_segment_fn(Avx2) must be avx2::fill_segment"
        );
        assert!(!core::ptr::fn_addr_eq(
            f,
            crate::fill_block::scalar::fill_segment as unsafe fn(&Instance, Position)
        ));
    }

    // ------------------------------------------------------------------
    // Forced execution — only compiled with `--cfg argon2_force_avx2`
    //
    // These exist ONLY in a forced run, so their names appearing in the test
    // output is itself the proof that detection was bypassed on purpose. See
    // `FORCE_UNDETECTED_AVX2` for why that is sound on this host and why it can
    // never happen in a normal build.
    // ------------------------------------------------------------------

    #[cfg(argon2_force_avx2)]
    mod forced {
        use super::*;
        use crate::params::{Algorithm, Memory, Params, TagLen, Version};

        /// This module exists only under `--cfg argon2_force_avx2`, so the flag
        /// must be on. A compile-time assertion rather than a runtime one: if the
        /// two ever drift apart the build breaks instead of a test quietly
        /// passing.
        const _: () = assert!(
            FORCE_UNDETECTED_AVX2,
            "mod forced is gated on argon2_force_avx2 but FORCE_UNDETECTED_AVX2 is false"
        );

        /// The forcing really does defeat the skip, and really does *not* work by
        /// weakening detection. If this ever fails, every other test in this
        /// module is silently running unforced.
        #[test]
        fn the_forced_flag_is_active_and_bypasses_detection() {
            assert!(!skip_without_avx2(), "the AVX2 tests must not skip here");
            // ...and it did NOT do so by weakening detection: on this host
            // `is_available()` is still false and `detect()` still refuses AVX2.
            // (On a real AVX2 CPU both flip, which is equally fine.)
            if !Backend::Avx2.is_available() {
                assert_ne!(
                    detect(),
                    Backend::Avx2,
                    "forcing must never make detect() select AVX2"
                );
            }
        }

        /// A second, independently seeded 4096-triple sweep on top of the
        /// 2048-triple one the shared harness runs, so no single seed can hide a
        /// lane-permutation slip.
        #[test]
        fn fill_block_matches_scalar_over_4096_more_triples() {
            // SAFETY: deliberate detection bypass, sound on this host because
            // Rosetta 2 executes AVX2. See `FORCE_UNDETECTED_AVX2`.
            unsafe {
                assert_fill_block_matches_scalar(
                    "avx2-forced",
                    fill_block_blocks,
                    4096,
                    0xC0FF_EE00_1234_5678,
                );
            }
        }

        /// Whole-hash equivalence: AVX2 must produce the same tag as the scalar
        /// backend (and as SSE2) for every shape of the fill loop.
        ///
        /// This is the test that covers what a `fill_block`-only comparison
        /// cannot: `starting_index = 2`, the `prev_offset` rotation at
        /// `curr_offset % lane_length == 1`, the `state`-carried-in-registers
        /// invariant across iterations, the `i % 128` address re-seed, cross-lane
        /// references, and both `with_xor` selections.
        ///
        /// The parameter grid is chosen for structure, not size:
        ///
        /// * `m_cost == 8 * lanes` is the smallest the C accepts (`core.c`
        ///   rejects `m_cost < 8 * lanes`) and is exactly where
        ///   `memory_blocks` bottoms out at `2 * SYNC_POINTS * lanes`, giving
        ///   `segment_length == 2` — the smallest possible segment, where
        ///   `starting_index = 2` means pass 0 slice 0 writes nothing at all;
        /// * `m_cost = 57` is prime, so `segment_length` is not a power of two
        ///   and the arena is re-truncated by the `argon2_ctx` alignment step;
        /// * `lanes = 3` is not a power of two and `lanes > 1` with `t > 1` is
        ///   what reaches the cross-lane wrapping subtraction in `index_alpha`;
        /// * `m_cost = 1024, lanes = 1` gives `segment_length == 256 > 128`, the
        ///   only way to make `next_addresses` fire more than once per segment.
        #[test]
        fn hash_matches_scalar_and_sse2_across_a_parameter_sweep() {
            // Every entry satisfies the C's `m_cost >= 8 * lanes`.
            #[rustfmt::skip]
            const GRID: &[(u32, u32, u32)] = &[
                // (m_cost, t_cost, lanes) — minimal segment_length == 2
                (8, 1, 1), (8, 2, 1), (8, 3, 1),
                (16, 1, 2), (16, 2, 2), (16, 3, 2),
                (24, 1, 3), (24, 2, 3), (24, 3, 3),
                (32, 1, 4), (32, 2, 4), (32, 3, 4),
                // prime m_cost: segment_length 14 / 7 / 4 / 3
                (57, 1, 1), (57, 2, 1), (57, 2, 2), (57, 3, 3), (57, 2, 4),
                // powers of two
                (64, 1, 1), (64, 2, 1), (64, 2, 2), (64, 3, 3), (64, 2, 4),
                (100, 2, 3),
                (256, 2, 1), (256, 2, 3),
                // segment_length 256 > ADDRESSES_IN_BLOCK: next_addresses fires
                // more than once per segment
                (1024, 2, 1), (1024, 2, 3),
            ];
            const ALGORITHMS: [Algorithm; 3] =
                [Algorithm::Argon2d, Algorithm::Argon2i, Algorithm::Argon2id];
            const VERSIONS: [Version; 2] = [Version::V0x10, Version::V0x13];

            let mut compared = 0u32;
            for &(m_cost, t_cost, lanes) in GRID {
                for algorithm in ALGORITHMS {
                    for version in VERSIONS {
                        assert!(
                            m_cost >= 8 * lanes,
                            "grid entry m={m_cost} p={lanes} violates m_cost >= 8 * lanes"
                        );
                        let params = Params::builder()
                            .memory(Memory::kib(u64::from(m_cost)))
                            .passes(t_cost)
                            .lanes(lanes)
                            .tag_len(TagLen::bytes(32))
                            .build()
                            .expect("grid params must be valid");
                        let run = |b: Backend| {
                            let mut out = [0u8; 32];
                            // SAFETY: this whole module only exists under
                            // `--cfg argon2_force_avx2`, the deliberate,
                            // measured Rosetta 2 bypass described on
                            // `FORCE_UNDETECTED_AVX2` — the host executes AVX2
                            // even though `cpuid` hides it. `Scalar` and `Sse2`
                            // need nothing beyond the x86-64 baseline.
                            unsafe {
                                crate::core::hash_traced(
                                    b,
                                    algorithm,
                                    version,
                                    &params,
                                    b"password",
                                    b"somesalt",
                                    &[],
                                    &[],
                                    &mut out,
                                    None,
                                )
                            }
                            .expect("hash must succeed");
                            out
                        };

                        let want = run(Backend::Scalar);
                        // No `format!`: this crate is `no_std`, and `assert_eq!`
                        // takes the format arguments directly anyway.
                        assert_eq!(
                            run(Backend::Avx2),
                            want,
                            "avx2 differs from scalar: {algorithm:?} v{:#x} \
                             m={m_cost} t={t_cost} p={lanes}",
                            version.as_u32()
                        );
                        assert_eq!(
                            run(Backend::Sse2),
                            want,
                            "sse2 differs from scalar: {algorithm:?} v{:#x} \
                             m={m_cost} t={t_cost} p={lanes}",
                            version.as_u32()
                        );
                        compared += 1;
                    }
                }
            }
            assert_eq!(
                compared,
                (GRID.len() * 6) as u32,
                "grid did not run in full"
            );
            assert!(compared >= 150, "grid is too small to be meaningful");
        }
    }
}

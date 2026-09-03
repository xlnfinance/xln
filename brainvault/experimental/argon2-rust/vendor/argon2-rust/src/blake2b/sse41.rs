//! SSE4.1 compression for one BLAKE2b stream.
//!
//! This is a Rust-intrinsics port of the upstream BLAKE2 SSE4.1 schedule. The
//! state is split into low/high pairs of 64-bit lanes, so each instruction runs
//! two of the four independent `G` functions. Message words are kept in eight
//! registers and rearranged with the same unpack, align and blend operations as
//! upstream's `blake2b-load-sse41.h`; loading individual words erased most of
//! this backend's measured advantage.

#[cfg(target_arch = "x86")]
use core::arch::x86::*;
#[cfg(target_arch = "x86_64")]
use core::arch::x86_64::*;

use super::IV;

const R24: [u8; 16] = [3, 4, 5, 6, 7, 0, 1, 2, 11, 12, 13, 14, 15, 8, 9, 10];
const R16: [u8; 16] = [2, 3, 4, 5, 6, 7, 0, 1, 10, 11, 12, 13, 14, 15, 8, 9];

#[inline(always)]
unsafe fn load2(src: *const u64) -> __m128i {
    // SAFETY: the caller provides two readable words; `loadu` is unaligned.
    unsafe { _mm_loadu_si128(src.cast()) }
}

#[inline(always)]
unsafe fn store2(dst: *mut u64, value: __m128i) {
    // SAFETY: the caller provides two writable words; `storeu` is unaligned.
    unsafe { _mm_storeu_si128(dst.cast(), value) }
}

#[inline(always)]
unsafe fn rotr32(x: __m128i) -> __m128i {
    // SAFETY: the caller established SSE4.1 support.
    unsafe { _mm_shuffle_epi32::<0b10_11_00_01>(x) }
}

#[inline(always)]
unsafe fn rotr24(x: __m128i, mask: __m128i) -> __m128i {
    // SAFETY: the caller established SSE4.1, which includes SSSE3.
    unsafe { _mm_shuffle_epi8(x, mask) }
}

#[inline(always)]
unsafe fn rotr16(x: __m128i, mask: __m128i) -> __m128i {
    // SAFETY: the caller established SSE4.1, which includes SSSE3.
    unsafe { _mm_shuffle_epi8(x, mask) }
}

#[inline(always)]
unsafe fn rotr63(x: __m128i) -> __m128i {
    // SAFETY: the caller established SSE4.1; both shifts are in range.
    unsafe { _mm_xor_si128(_mm_srli_epi64::<63>(x), _mm_add_epi64(x, x)) }
}

#[allow(clippy::too_many_arguments)]
#[inline(always)]
unsafe fn g(
    a: &mut __m128i,
    b: &mut __m128i,
    c: &mut __m128i,
    d: &mut __m128i,
    x: __m128i,
    y: __m128i,
    r24: __m128i,
    r16: __m128i,
) {
    // SAFETY: every helper requires at most the SSE4.1 support established by
    // the backend entry point.
    unsafe {
        *a = _mm_add_epi64(_mm_add_epi64(*a, *b), x);
        *d = rotr32(_mm_xor_si128(*d, *a));
        *c = _mm_add_epi64(*c, *d);
        *b = rotr24(_mm_xor_si128(*b, *c), r24);
        *a = _mm_add_epi64(_mm_add_epi64(*a, *b), y);
        *d = rotr16(_mm_xor_si128(*d, *a), r16);
        *c = _mm_add_epi64(*c, *d);
        *b = rotr63(_mm_xor_si128(*b, *c));
    }
}

#[inline(always)]
unsafe fn lo(a: __m128i, b: __m128i) -> __m128i {
    // SAFETY: the caller established SSE4.1 support.
    unsafe { _mm_unpacklo_epi64(a, b) }
}

#[inline(always)]
unsafe fn hi(a: __m128i, b: __m128i) -> __m128i {
    // SAFETY: the caller established SSE4.1 support.
    unsafe { _mm_unpackhi_epi64(a, b) }
}

#[inline(always)]
unsafe fn align8(a: __m128i, b: __m128i) -> __m128i {
    // SAFETY: the caller established SSE4.1, which includes SSSE3; eight is a
    // valid byte offset.
    unsafe { _mm_alignr_epi8::<8>(a, b) }
}

#[inline(always)]
unsafe fn blend_hi(a: __m128i, b: __m128i) -> __m128i {
    // SAFETY: the caller established SSE4.1. `0xf0` takes the high 64-bit word
    // from `b` and the low word from `a`.
    unsafe { _mm_blend_epi16::<0xf0>(a, b) }
}

#[inline(always)]
unsafe fn swap(a: __m128i) -> __m128i {
    // SAFETY: the caller established SSE4.1 support.
    unsafe { _mm_shuffle_epi32::<0b01_00_11_10>(a) }
}

/// Select the two message registers consumed by one quarter of a round.
///
/// This is the upstream `blake2b-load-sse41.h` schedule. `round` and `quarter`
/// are constants at every inlined call site, so this match emits only the
/// selected shuffle sequence.
#[inline(always)]
unsafe fn message(m: &[__m128i; 8], round: usize, quarter: usize) -> (__m128i, __m128i) {
    debug_assert!(round < 12 && quarter < 4);
    let round = match round {
        0..=9 => round,
        10 | 11 => round - 10,
        _ => unreachable!("BLAKE2b has exactly twelve rounds"),
    };
    // SAFETY: the caller established SSE4.1. Every helper below has that same
    // requirement, and the round driver passes quarters 0..=3 only.
    unsafe {
        match (round, quarter) {
            (0, 0) => (lo(m[0], m[1]), lo(m[2], m[3])),
            (0, 1) => (hi(m[0], m[1]), hi(m[2], m[3])),
            (0, 2) => (lo(m[4], m[5]), lo(m[6], m[7])),
            (0, 3) => (hi(m[4], m[5]), hi(m[6], m[7])),

            (1, 0) => (lo(m[7], m[2]), hi(m[4], m[6])),
            (1, 1) => (lo(m[5], m[4]), align8(m[3], m[7])),
            (1, 2) => (swap(m[0]), hi(m[5], m[2])),
            (1, 3) => (lo(m[6], m[1]), hi(m[3], m[1])),

            (2, 0) => (align8(m[6], m[5]), hi(m[2], m[7])),
            (2, 1) => (lo(m[4], m[0]), blend_hi(m[1], m[6])),
            (2, 2) => (blend_hi(m[5], m[1]), hi(m[3], m[4])),
            (2, 3) => (lo(m[7], m[3]), align8(m[2], m[0])),

            (3, 0) => (hi(m[3], m[1]), hi(m[6], m[5])),
            (3, 1) => (hi(m[4], m[0]), lo(m[6], m[7])),
            (3, 2) => (blend_hi(m[1], m[2]), blend_hi(m[2], m[7])),
            (3, 3) => (lo(m[3], m[5]), lo(m[0], m[4])),

            (4, 0) => (hi(m[4], m[2]), lo(m[1], m[5])),
            (4, 1) => (blend_hi(m[0], m[3]), blend_hi(m[2], m[7])),
            (4, 2) => (blend_hi(m[7], m[5]), blend_hi(m[3], m[1])),
            (4, 3) => (align8(m[6], m[0]), blend_hi(m[4], m[6])),

            (5, 0) => (lo(m[1], m[3]), lo(m[0], m[4])),
            (5, 1) => (lo(m[6], m[5]), hi(m[5], m[1])),
            (5, 2) => (blend_hi(m[2], m[3]), hi(m[7], m[0])),
            (5, 3) => (hi(m[6], m[2]), blend_hi(m[7], m[4])),

            (6, 0) => (blend_hi(m[6], m[0]), lo(m[7], m[2])),
            (6, 1) => (hi(m[2], m[7]), align8(m[5], m[6])),
            (6, 2) => (lo(m[0], m[3]), swap(m[4])),
            (6, 3) => (hi(m[3], m[1]), blend_hi(m[1], m[5])),

            (7, 0) => (hi(m[6], m[3]), blend_hi(m[6], m[1])),
            (7, 1) => (align8(m[7], m[5]), hi(m[0], m[4])),
            (7, 2) => (hi(m[2], m[7]), lo(m[4], m[1])),
            (7, 3) => (lo(m[0], m[2]), lo(m[3], m[5])),

            (8, 0) => (lo(m[3], m[7]), align8(m[0], m[5])),
            (8, 1) => (hi(m[7], m[4]), align8(m[4], m[1])),
            (8, 2) => (m[6], align8(m[5], m[0])),
            (8, 3) => (blend_hi(m[1], m[3]), m[2]),

            (9, 0) => (lo(m[5], m[4]), hi(m[3], m[0])),
            (9, 1) => (lo(m[1], m[2]), blend_hi(m[3], m[2])),
            (9, 2) => (hi(m[7], m[4]), hi(m[1], m[6])),
            (9, 3) => (align8(m[7], m[5]), lo(m[6], m[0])),
            _ => unreachable!("a BLAKE2b round has exactly four quarters"),
        }
    }
}

#[inline(always)]
unsafe fn diagonalize(
    bl: &mut __m128i,
    bh: &mut __m128i,
    cl: &mut __m128i,
    ch: &mut __m128i,
    dl: &mut __m128i,
    dh: &mut __m128i,
) {
    // SAFETY: the caller established SSE4.1, which includes SSSE3.
    unsafe {
        let new_bl = align8(*bh, *bl);
        let new_bh = align8(*bl, *bh);
        core::mem::swap(cl, ch);
        let new_dl = align8(*dl, *dh);
        let new_dh = align8(*dh, *dl);
        *bl = new_bl;
        *bh = new_bh;
        *dl = new_dl;
        *dh = new_dh;
    }
}

#[inline(always)]
unsafe fn undiagonalize(
    bl: &mut __m128i,
    bh: &mut __m128i,
    cl: &mut __m128i,
    ch: &mut __m128i,
    dl: &mut __m128i,
    dh: &mut __m128i,
) {
    // SAFETY: the caller established SSE4.1, which includes SSSE3.
    unsafe {
        let new_bl = align8(*bl, *bh);
        let new_bh = align8(*bh, *bl);
        core::mem::swap(cl, ch);
        let new_dl = align8(*dh, *dl);
        let new_dh = align8(*dl, *dh);
        *bl = new_bl;
        *bh = new_bh;
        *dl = new_dl;
        *dh = new_dh;
    }
}

#[allow(clippy::too_many_arguments)]
#[inline(always)]
unsafe fn round(
    al: &mut __m128i,
    ah: &mut __m128i,
    bl: &mut __m128i,
    bh: &mut __m128i,
    cl: &mut __m128i,
    ch: &mut __m128i,
    dl: &mut __m128i,
    dh: &mut __m128i,
    m: &[__m128i; 8],
    r24: __m128i,
    r16: __m128i,
    r: usize,
) {
    // SAFETY: the caller established SSE4.1; the twelve call sites below keep
    // `r` in range and every quarter is a literal in 0..=3.
    unsafe {
        let (xl, xh) = message(m, r, 0);
        let (yl, yh) = message(m, r, 1);
        g(al, bl, cl, dl, xl, yl, r24, r16);
        g(ah, bh, ch, dh, xh, yh, r24, r16);

        diagonalize(bl, bh, cl, ch, dl, dh);
        let (xl, xh) = message(m, r, 2);
        let (yl, yh) = message(m, r, 3);
        g(al, bl, cl, dl, xl, yl, r24, r16);
        g(ah, bh, ch, dh, xh, yh, r24, r16);
        undiagonalize(bl, bh, cl, ch, dl, dh);
    }
}

/// Compress one already-parsed BLAKE2b block.
///
/// # Safety
///
/// The current CPU must support SSE4.1 (and therefore SSSE3 and SSE2).
#[target_feature(enable = "sse4.1")]
pub(super) unsafe fn compress(
    h: &mut [u64; 8],
    t: &[u64; 2],
    f: &[u64; 2],
    words: &[u64; 16],
) {
    // SAFETY: `#[target_feature]` establishes SSE4.1. All loads and stores span
    // exactly two words inside fixed-size arrays.
    unsafe {
        let mut al = load2(h.as_ptr());
        let mut ah = load2(h.as_ptr().add(2));
        let mut bl = load2(h.as_ptr().add(4));
        let mut bh = load2(h.as_ptr().add(6));
        let mut cl = load2(IV.as_ptr());
        let mut ch = load2(IV.as_ptr().add(2));
        let mut dl = _mm_xor_si128(load2(IV.as_ptr().add(4)), load2(t.as_ptr()));
        let mut dh = _mm_xor_si128(load2(IV.as_ptr().add(6)), load2(f.as_ptr()));
        let initial_al = al;
        let initial_ah = ah;
        let initial_bl = bl;
        let initial_bh = bh;

        let m = [
            load2(words.as_ptr()),
            load2(words.as_ptr().add(2)),
            load2(words.as_ptr().add(4)),
            load2(words.as_ptr().add(6)),
            load2(words.as_ptr().add(8)),
            load2(words.as_ptr().add(10)),
            load2(words.as_ptr().add(12)),
            load2(words.as_ptr().add(14)),
        ];
        let r24 = _mm_loadu_si128(R24.as_ptr().cast());
        let r16 = _mm_loadu_si128(R16.as_ptr().cast());

        round(&mut al, &mut ah, &mut bl, &mut bh, &mut cl, &mut ch, &mut dl, &mut dh, &m, r24, r16, 0);
        round(&mut al, &mut ah, &mut bl, &mut bh, &mut cl, &mut ch, &mut dl, &mut dh, &m, r24, r16, 1);
        round(&mut al, &mut ah, &mut bl, &mut bh, &mut cl, &mut ch, &mut dl, &mut dh, &m, r24, r16, 2);
        round(&mut al, &mut ah, &mut bl, &mut bh, &mut cl, &mut ch, &mut dl, &mut dh, &m, r24, r16, 3);
        round(&mut al, &mut ah, &mut bl, &mut bh, &mut cl, &mut ch, &mut dl, &mut dh, &m, r24, r16, 4);
        round(&mut al, &mut ah, &mut bl, &mut bh, &mut cl, &mut ch, &mut dl, &mut dh, &m, r24, r16, 5);
        round(&mut al, &mut ah, &mut bl, &mut bh, &mut cl, &mut ch, &mut dl, &mut dh, &m, r24, r16, 6);
        round(&mut al, &mut ah, &mut bl, &mut bh, &mut cl, &mut ch, &mut dl, &mut dh, &m, r24, r16, 7);
        round(&mut al, &mut ah, &mut bl, &mut bh, &mut cl, &mut ch, &mut dl, &mut dh, &m, r24, r16, 8);
        round(&mut al, &mut ah, &mut bl, &mut bh, &mut cl, &mut ch, &mut dl, &mut dh, &m, r24, r16, 9);
        round(&mut al, &mut ah, &mut bl, &mut bh, &mut cl, &mut ch, &mut dl, &mut dh, &m, r24, r16, 10);
        round(&mut al, &mut ah, &mut bl, &mut bh, &mut cl, &mut ch, &mut dl, &mut dh, &m, r24, r16, 11);

        store2(h.as_mut_ptr(), _mm_xor_si128(initial_al, _mm_xor_si128(al, cl)));
        store2(h.as_mut_ptr().add(2), _mm_xor_si128(initial_ah, _mm_xor_si128(ah, ch)));
        store2(h.as_mut_ptr().add(4), _mm_xor_si128(initial_bl, _mm_xor_si128(bl, dl)));
        store2(h.as_mut_ptr().add(6), _mm_xor_si128(initial_bh, _mm_xor_si128(bh, dh)));
    }
}

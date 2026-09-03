//! AVX2 compression for one BLAKE2b stream.
//!
//! Each vector holds one complete row of the 4x4 BLAKE2b state. A half-round
//! therefore performs four `G` functions in parallel; lane permutations turn
//! rows into diagonals and back between the two half-rounds.

#[cfg(target_arch = "x86")]
use core::arch::x86::*;
#[cfg(target_arch = "x86_64")]
use core::arch::x86_64::*;

use super::{IV, SIGMA};

const R24: [u8; 32] = [
    3, 4, 5, 6, 7, 0, 1, 2, 11, 12, 13, 14, 15, 8, 9, 10, //
    3, 4, 5, 6, 7, 0, 1, 2, 11, 12, 13, 14, 15, 8, 9, 10,
];

const R16: [u8; 32] = [
    2, 3, 4, 5, 6, 7, 0, 1, 10, 11, 12, 13, 14, 15, 8, 9, //
    2, 3, 4, 5, 6, 7, 0, 1, 10, 11, 12, 13, 14, 15, 8, 9,
];

#[inline(always)]
unsafe fn load4(src: *const u64) -> __m256i {
    // SAFETY: the caller provides four readable words; `loadu` has no
    // alignment requirement.
    unsafe { _mm256_loadu_si256(src.cast()) }
}

#[inline(always)]
unsafe fn store4(dst: *mut u64, value: __m256i) {
    // SAFETY: the caller provides four writable words; `storeu` is unaligned.
    unsafe { _mm256_storeu_si256(dst.cast(), value) }
}

#[inline(always)]
unsafe fn set4(a: u64, b: u64, c: u64, d: u64) -> __m256i {
    // SAFETY: the caller established AVX2 support.
    unsafe { _mm256_setr_epi64x(a as i64, b as i64, c as i64, d as i64) }
}

#[inline(always)]
unsafe fn rotr32(x: __m256i) -> __m256i {
    // SAFETY: the caller established AVX2 support.
    unsafe { _mm256_shuffle_epi32::<0b10_11_00_01>(x) }
}

#[inline(always)]
unsafe fn rotr24(x: __m256i) -> __m256i {
    // SAFETY: the caller established AVX2; `R24` provides 32 readable bytes.
    unsafe { _mm256_shuffle_epi8(x, _mm256_loadu_si256(R24.as_ptr().cast())) }
}

#[inline(always)]
unsafe fn rotr16(x: __m256i) -> __m256i {
    // SAFETY: the caller established AVX2; `R16` provides 32 readable bytes.
    unsafe { _mm256_shuffle_epi8(x, _mm256_loadu_si256(R16.as_ptr().cast())) }
}

#[inline(always)]
unsafe fn rotr63(x: __m256i) -> __m256i {
    // SAFETY: the caller established AVX2; the shift immediate is in range.
    unsafe { _mm256_xor_si256(_mm256_srli_epi64::<63>(x), _mm256_add_epi64(x, x)) }
}

#[inline(always)]
unsafe fn g(
    a: &mut __m256i,
    b: &mut __m256i,
    c: &mut __m256i,
    d: &mut __m256i,
    x: __m256i,
    y: __m256i,
) {
    // SAFETY: every helper requires only the AVX2 support established above.
    unsafe {
        *a = _mm256_add_epi64(_mm256_add_epi64(*a, *b), x);
        *d = rotr32(_mm256_xor_si256(*d, *a));
        *c = _mm256_add_epi64(*c, *d);
        *b = rotr24(_mm256_xor_si256(*b, *c));
        *a = _mm256_add_epi64(_mm256_add_epi64(*a, *b), y);
        *d = rotr16(_mm256_xor_si256(*d, *a));
        *c = _mm256_add_epi64(*c, *d);
        *b = rotr63(_mm256_xor_si256(*b, *c));
    }
}

#[inline(always)]
unsafe fn diagonalize(b: &mut __m256i, c: &mut __m256i, d: &mut __m256i) {
    // SAFETY: the caller established AVX2; every lane immediate is valid.
    unsafe {
        // Left rotations by 1, 2 and 3 lanes respectively.
        *b = _mm256_permute4x64_epi64::<0b00_11_10_01>(*b);
        *c = _mm256_permute4x64_epi64::<0b01_00_11_10>(*c);
        *d = _mm256_permute4x64_epi64::<0b10_01_00_11>(*d);
    }
}

#[inline(always)]
unsafe fn undiagonalize(b: &mut __m256i, c: &mut __m256i, d: &mut __m256i) {
    // SAFETY: the caller established AVX2; every lane immediate is valid.
    unsafe {
        *b = _mm256_permute4x64_epi64::<0b10_01_00_11>(*b);
        *c = _mm256_permute4x64_epi64::<0b01_00_11_10>(*c);
        *d = _mm256_permute4x64_epi64::<0b00_11_10_01>(*d);
    }
}

#[inline(always)]
unsafe fn round(
    a: &mut __m256i,
    b: &mut __m256i,
    c: &mut __m256i,
    d: &mut __m256i,
    m: &[u64; 16],
    r: usize,
) {
    let s = &SIGMA[r];
    // SAFETY: the caller established AVX2. The twelve call sites below keep
    // `r` in range, and every SIGMA entry is less than 16.
    unsafe {
        let x = set4(m[s[0]], m[s[2]], m[s[4]], m[s[6]]);
        let y = set4(m[s[1]], m[s[3]], m[s[5]], m[s[7]]);
        g(a, b, c, d, x, y);

        diagonalize(b, c, d);
        let x = set4(m[s[8]], m[s[10]], m[s[12]], m[s[14]]);
        let y = set4(m[s[9]], m[s[11]], m[s[13]], m[s[15]]);
        g(a, b, c, d, x, y);
        undiagonalize(b, c, d);
    }
}

/// Compress one already-parsed BLAKE2b block.
///
/// # Safety
///
/// The current CPU must support AVX2.
#[target_feature(enable = "avx2")]
pub(super) unsafe fn compress(
    h: &mut [u64; 8],
    t: &[u64; 2],
    f: &[u64; 2],
    m: &[u64; 16],
) {
    // SAFETY: `#[target_feature]` establishes AVX2. The fixed-size arrays make
    // every four-word load and store in bounds.
    unsafe {
        let mut a = load4(h.as_ptr());
        let mut b = load4(h.as_ptr().add(4));
        let mut c = load4(IV.as_ptr());
        let flags = set4(t[0], t[1], f[0], f[1]);
        let mut d = _mm256_xor_si256(load4(IV.as_ptr().add(4)), flags);
        let initial_a = a;
        let initial_b = b;

        // Constant call sites let LLVM fold every SIGMA lookup into direct
        // message-word selection instead of a runtime schedule loop.
        round(&mut a, &mut b, &mut c, &mut d, m, 0);
        round(&mut a, &mut b, &mut c, &mut d, m, 1);
        round(&mut a, &mut b, &mut c, &mut d, m, 2);
        round(&mut a, &mut b, &mut c, &mut d, m, 3);
        round(&mut a, &mut b, &mut c, &mut d, m, 4);
        round(&mut a, &mut b, &mut c, &mut d, m, 5);
        round(&mut a, &mut b, &mut c, &mut d, m, 6);
        round(&mut a, &mut b, &mut c, &mut d, m, 7);
        round(&mut a, &mut b, &mut c, &mut d, m, 8);
        round(&mut a, &mut b, &mut c, &mut d, m, 9);
        round(&mut a, &mut b, &mut c, &mut d, m, 10);
        round(&mut a, &mut b, &mut c, &mut d, m, 11);

        let out_a = _mm256_xor_si256(initial_a, _mm256_xor_si256(a, c));
        let out_b = _mm256_xor_si256(initial_b, _mm256_xor_si256(b, d));
        store4(h.as_mut_ptr(), out_a);
        store4(h.as_mut_ptr().add(4), out_b);
    }
}

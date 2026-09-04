//! x86 / x86-64 SSE2 (and SSSE3) `fill_block` / `fill_segment`.
//!
//! Ported from the `#else` (128-bit) branch of `fill_block` / `next_addresses`
//! / `fill_segment` in `phc-winner-argon2/src/opt.c` and from the
//! `!__AVX512F__ && !__AVX2__ && !__XOP__` half of
//! `phc-winner-argon2/src/blake2/blamka-round-opt.h`.
//!
//! # Layout
//!
//! The 1 KiB block is 64 `__m128i`, so `state[j]` holds block words
//! `2j` and `2j+1`. That makes the two passes of `fill_block`:
//!
//! ```text
//! columns:  BLAKE2_ROUND(state[8i+0] .. state[8i+7])   for i in 0..8
//!           -> words 16i .. 16i+15,   the C's "(0,1,...,15), (16,...,31), ..."
//! rows:     BLAKE2_ROUND(state[8k+i] for k in 0..8)    for i in 0..8
//!           -> words 2i, 2i+1, 2i+16, 2i+17, ..., 2i+112, 2i+113
//! ```
//!
//! Within one `BLAKE2_ROUND` the eight registers are `A0 A1 B0 B1 C0 C1 D0 D1`,
//! i.e. `(A0, B0, C0, D0)` is BLAKE2b columns 0 and 1 of the 4x4 matrix and
//! `(A1, B1, C1, D1)` is columns 2 and 3. `DIAGONALIZE` rotates `B` left by one
//! 64-bit slot, `C` by two and `D` by three across the `0`/`1` register pair.
//!
//! # SSE2 versus SSSE3
//!
//! `blamka-round-opt.h` has two spellings of the 128-bit path:
//!
//! | | `__SSSE3__` (`:36-51`, `:107-139`) | plain `__SSE2__` (`:53-54`, `:141-166`) |
//! |---|---|---|
//! | `rotr32` | `pshufd` | `psrlq`/`psllq`/`pxor` |
//! | `rotr24` | `pshufb` with `r24` | `psrlq`/`psllq`/`pxor` |
//! | `rotr16` | `pshufb` with `r16` | `psrlq`/`psllq`/`pxor` |
//! | `rotr63` | `psrlq`/`paddq`/`pxor` | `psrlq`/`psllq`/`pxor` |
//! | `DIAGONALIZE` | `palignr` | `punpckhqdq`/`punpcklqdq` |
//!
//! Both compute the same permutation, so the two produce bit-identical output —
//! the `sse2_and_ssse3_paths_agree` unit test pins that.
//!
//! `core::arch` exposes `_mm_shuffle_epi8` and `_mm_alignr_epi8` on any x86
//! target, so nothing stops a backend *advertised* as SSE2 from quietly
//! executing SSSE3 and faulting on a Pentium 4. This module therefore keeps a
//! genuine SSE2-only implementation and picks between the two by **runtime**
//! SSSE3 detection, cached in an [`AtomicU8`] exactly like the top-level
//! backend choice:
//!
//! * [`fill_segment`] — what `fill_block/mod.rs` dispatches to. Declares only
//!   `sse2`; one relaxed atomic load and one branch decide which of the next two
//!   it tail-calls. That is **per segment** (thousands of blocks), so it costs
//!   nothing measurable, and nothing detects or dispatches inside the block loop.
//!   Measured: the whole symbol is 24 instructions in the release build for
//!   `x86_64-unknown-linux-musl` (19 for `x86_64-apple-darwin`), against 2122
//!   for the `fill_segment_sse2_only` it jumps to.
//! * [`fill_segment_sse2_only`] — declares `sse2`. Contains no SSSE3 intrinsic.
//! * [`fill_segment_ssse3`] — declares `sse2,ssse3`.
//!
//! The split is a `const SSSE3: bool` generic on `#[inline(always)]` helpers, so
//! each of the two `#[target_feature]` entry points gets its own fully inlined
//! copy with the dead branch gone.
//!
//! Verified by disassembly, not by inspection —
//! `cargo rustc --release --target <t> --features internal-api --lib --
//! --emit asm -C lto=off`, then counting mnemonics per `fill_segment*` symbol:
//!
//! | target (baseline) | `fill_segment_sse2_only` | `fill_segment_ssse3` |
//! |---|---|---|
//! | `x86_64-unknown-linux-musl` (`sse` `sse2` only) | **no SSSE3 at all** — `psrlq`x160, `pshufd`x120, `por`x120 | `pshufb`x60, `palignr`x80 |
//! | `x86_64-apple-darwin` (`sse3` `ssse3` `sse4.1`) | `palignr`x80, no `pshufb` | `pshufb`x60, `palignr`x80 |
//!
//! So on a genuine SSE2 baseline the SSE2-only path really is SSE2-only, which
//! is the property that matters for soundness on a Pentium 4. On
//! `x86_64-apple-darwin` LLVM lowers the `punpckhqdq`/`punpcklqdq`
//! `DIAGONALIZE` into `palignr` because that target's baseline *is* Penryn
//! (`rustc --print cfg --target x86_64-apple-darwin` lists `ssse3` and
//! `sse4.1`), which is also why `is_x86_feature_detected!("ssse3")`
//! short-circuits to `true` there. Sound either way: the target contract
//! already guarantees the instruction. It does mean the SSE2-only *codegen*
//! claim cannot be checked on macOS — check it on the musl target.
//!
//! # Why `#[target_feature]` is on `fill_segment*` and not on `fill_block`
//!
//! LLVM will not inline a callee with a richer feature set into a poorer caller.
//! Keeping the boundary at `fill_segment` lets `fill_block` inline into it, which
//! is what preserves the `opt.c` trick of carrying the 1 KiB `state` across loop
//! iterations instead of re-reading the previous block every time.

#[cfg(target_arch = "x86")]
use core::arch::x86::*;
#[cfg(target_arch = "x86_64")]
use core::arch::x86_64::*;
use core::mem::MaybeUninit;
use core::sync::atomic::{AtomicU8, Ordering};

use crate::block::{Block, Instance, Position};
use crate::params::{ADDRESSES_IN_BLOCK, OWORDS_IN_BLOCK};

/// `ARGON2_ADDRESSES_IN_BLOCK` as a `u32`, for `i % 128` in `fill_segment`.
const ADDRESSES_IN_BLOCK_U32: u32 = ADDRESSES_IN_BLOCK as u32;

// ---------------------------------------------------------------------------
// Cached SSSE3 probe
// ---------------------------------------------------------------------------

/// "The SSSE3 probe has not run yet." Not a valid boolean encoding.
const SSSE3_UNKNOWN: u8 = 0xFF;

/// Cached SSSE3 availability: `0` = no, `1` = yes, [`SSSE3_UNKNOWN`] = untested.
///
/// Relaxed throughout. The initialisation race is benign — every thread that
/// runs the probe computes the same answer and stores the same byte — and there
/// is no other data to publish, so no acquire/release is needed. Deliberately
/// not a `OnceLock`: that needs `std`, which this crate does not require.
static SSSE3_CACHE: AtomicU8 = AtomicU8::new(SSSE3_UNKNOWN);

/// Runtime SSSE3 check, or the compile-time cfg without `std`.
///
/// Defined twice under mutually exclusive `cfg`s, so exactly one body exists and
/// there is no dead code — the same shape `fill_block/mod.rs` uses for its own
/// probes.
#[cfg(feature = "std")]
#[inline]
fn probe_ssse3() -> bool {
    std::arch::is_x86_feature_detected!("ssse3")
}

/// Without `std` there is no `cpuid` helper, so fall back to the compile-time
/// feature. That errs towards the SSE2-only path, which always runs.
#[cfg(not(feature = "std"))]
#[inline]
fn probe_ssse3() -> bool {
    cfg!(target_feature = "ssse3")
}

/// Probe and populate the cache. Outlined so [`have_ssse3`] stays tiny.
#[cold]
#[inline(never)]
fn probe_and_cache_ssse3() -> bool {
    let found = probe_ssse3();
    SSSE3_CACHE.store(u8::from(found), Ordering::Relaxed);
    found
}

/// Whether this CPU has SSSE3: one relaxed atomic load after the first call.
#[inline]
fn have_ssse3() -> bool {
    match SSSE3_CACHE.load(Ordering::Relaxed) {
        0 => false,
        1 => true,
        // `SSSE3_UNKNOWN`, or anything else a torn/foreign write could leave.
        _ => probe_and_cache_ssse3(),
    }
}

// ---------------------------------------------------------------------------
// blamka-round-opt.h, 128-bit path
// ---------------------------------------------------------------------------

/// `r24` — `blamka-round-opt.h:38`.
///
/// `_mm_shuffle_epi8` reads `result[j] = x[table[j]]`, so within each 8-byte
/// half `table[j] = (j + 3) % 8` is a rotate **right** by 3 bytes = 24 bits.
/// Held as a plain byte array rather than `_mm_setr_epi8` so the lane order is
/// unambiguous: on little-endian, `TABLE[0]` is byte 0 of the vector. LLVM folds
/// the load into a constant-pool reference, which is what the C emits too.
const R24: [u8; 16] = [3, 4, 5, 6, 7, 0, 1, 2, 11, 12, 13, 14, 15, 8, 9, 10];

/// `r16` — `blamka-round-opt.h:36`. `table[j] = (j + 2) % 8`, a rotate right by
/// 16 bits. See [`R24`] for why this is a byte array.
const R16: [u8; 16] = [2, 3, 4, 5, 6, 7, 0, 1, 10, 11, 12, 13, 14, 15, 8, 9];

/// `fBlaMka` — `blamka-round-opt.h:59-62`.
///
/// ```c
/// const __m128i z = _mm_mul_epu32(x, y);
/// return _mm_add_epi64(_mm_add_epi64(x, y), _mm_add_epi64(z, z));
/// ```
///
/// `_mm_mul_epu32` multiplies the low 32 bits of each 64-bit lane into a full
/// 64-bit product, which is the vector form of the scalar
/// `(x & 0xFFFFFFFF) * (y & 0xFFFFFFFF)`; `z + z` is the `2 *`. Every add is
/// modulo 2^64, matching the scalar `wrapping_add`.
#[inline(always)]
unsafe fn f_blamka(x: __m128i, y: __m128i) -> __m128i {
    // SAFETY: every intrinsic here is SSE2, which every caller enables. The
    // whole body is one block so the SSE2-only variant stays readable.
    unsafe {
        let z = _mm_mul_epu32(x, y);
        _mm_add_epi64(_mm_add_epi64(x, y), _mm_add_epi64(z, z))
    }
}

/// `_mm_roti_epi64(x, -32)`, a rotate right by 32.
///
/// SSSE3: `_mm_shuffle_epi32(x, _MM_SHUFFLE(2, 3, 0, 1))`
/// (`blamka-round-opt.h:42`) — swap the two 32-bit halves of each lane.
/// `_MM_SHUFFLE(2, 3, 0, 1) == 0b10_11_00_01`.
///
/// SSE2: the generic `psrlq | psllq` form of `blamka-round-opt.h:54`.
/// `pshufd` is itself SSE2, so this branch exists only to transcribe the C
/// faithfully; both are one instruction plus, for SSE2, two more.
#[inline(always)]
unsafe fn rot32<const SSSE3: bool>(x: __m128i) -> __m128i {
    // SAFETY: `_mm_shuffle_epi32`, `_mm_srli_epi64`, `_mm_slli_epi64` and
    // `_mm_xor_si128` are all SSE2, enabled by every caller.
    unsafe {
        if SSSE3 {
            _mm_shuffle_epi32::<0b10_11_00_01>(x)
        } else {
            _mm_xor_si128(_mm_srli_epi64::<32>(x), _mm_slli_epi64::<32>(x))
        }
    }
}

/// `_mm_roti_epi64(x, -24)`, a rotate right by 24.
///
/// SSSE3: `_mm_shuffle_epi8(x, r24)` (`blamka-round-opt.h:44`).
/// SSE2: `_mm_xor_si128(_mm_srli_epi64(x, 24), _mm_slli_epi64(x, 40))`
/// (`blamka-round-opt.h:54`, with `64 - 24 == 40`).
///
/// This is one of the only two places the SSSE3 branch really needs SSSE3.
#[inline(always)]
unsafe fn rot24<const SSSE3: bool>(x: __m128i) -> __m128i {
    // SAFETY: the `SSSE3` branch calls `_mm_shuffle_epi8`, which needs SSSE3;
    // it is only instantiated by `fill_segment_ssse3`, which declares
    // `target_feature(enable = "sse2,ssse3")` and is only reached after
    // `have_ssse3()`. The other branch is pure SSE2. The `R24` load is
    // `loadu`, so the array needs no special alignment.
    unsafe {
        if SSSE3 {
            _mm_shuffle_epi8(x, _mm_loadu_si128(R24.as_ptr().cast()))
        } else {
            _mm_xor_si128(_mm_srli_epi64::<24>(x), _mm_slli_epi64::<40>(x))
        }
    }
}

/// `_mm_roti_epi64(x, -16)`, a rotate right by 16.
///
/// SSSE3: `_mm_shuffle_epi8(x, r16)` (`blamka-round-opt.h:46`).
/// SSE2: `psrlq 16 | psllq 48` (`blamka-round-opt.h:54`).
#[inline(always)]
unsafe fn rot16<const SSSE3: bool>(x: __m128i) -> __m128i {
    // SAFETY: as `rot24` — the SSSE3 branch is only instantiated inside
    // `fill_segment_ssse3`.
    unsafe {
        if SSSE3 {
            _mm_shuffle_epi8(x, _mm_loadu_si128(R16.as_ptr().cast()))
        } else {
            _mm_xor_si128(_mm_srli_epi64::<16>(x), _mm_slli_epi64::<48>(x))
        }
    }
}

/// `_mm_roti_epi64(x, -63)`, a rotate right by 63 (equivalently left by 1).
///
/// SSSE3: `_mm_xor_si128(_mm_srli_epi64(x, 63), _mm_add_epi64(x, x))`
/// (`blamka-round-opt.h:48-49`).
/// SSE2: `psrlq 63 | psllq 1` (`blamka-round-opt.h:54`).
///
/// `_mm_add_epi64(x, x)` and `_mm_slli_epi64(x, 1)` are the same value; both
/// branches are SSE2 and only differ in which the C happened to write.
#[inline(always)]
unsafe fn rot63<const SSSE3: bool>(x: __m128i) -> __m128i {
    // SAFETY: all SSE2.
    unsafe {
        if SSSE3 {
            _mm_xor_si128(_mm_srli_epi64::<63>(x), _mm_add_epi64(x, x))
        } else {
            _mm_xor_si128(_mm_srli_epi64::<63>(x), _mm_slli_epi64::<1>(x))
        }
    }
}

/// `G1` — `blamka-round-opt.h:64-83`. Halves the BLAMKA `G`: the `rotr32` /
/// `rotr24` pair.
///
/// ```c
/// A0 = fBlaMka(A0, B0);  A1 = fBlaMka(A1, B1);
/// D0 ^= A0;              D1 ^= A1;
/// D0 = roti(D0, -32);    D1 = roti(D1, -32);
/// C0 = fBlaMka(C0, D0);  C1 = fBlaMka(C1, D1);
/// B0 ^= C0;              B1 ^= C1;
/// B0 = roti(B0, -24);    B1 = roti(B1, -24);
/// ```
#[inline(always)]
#[allow(clippy::too_many_arguments)]
unsafe fn g1<const SSSE3: bool>(
    a0: &mut __m128i,
    b0: &mut __m128i,
    c0: &mut __m128i,
    d0: &mut __m128i,
    a1: &mut __m128i,
    b1: &mut __m128i,
    c1: &mut __m128i,
    d1: &mut __m128i,
) {
    // SAFETY: `_mm_xor_si128` is SSE2; `f_blamka` and the rotations carry their
    // own contracts, which this function's callers satisfy.
    unsafe {
        *a0 = f_blamka(*a0, *b0);
        *a1 = f_blamka(*a1, *b1);

        *d0 = _mm_xor_si128(*d0, *a0);
        *d1 = _mm_xor_si128(*d1, *a1);

        *d0 = rot32::<SSSE3>(*d0);
        *d1 = rot32::<SSSE3>(*d1);

        *c0 = f_blamka(*c0, *d0);
        *c1 = f_blamka(*c1, *d1);

        *b0 = _mm_xor_si128(*b0, *c0);
        *b1 = _mm_xor_si128(*b1, *c1);

        *b0 = rot24::<SSSE3>(*b0);
        *b1 = rot24::<SSSE3>(*b1);
    }
}

/// `G2` — `blamka-round-opt.h:85-104`. The `rotr16` / `rotr63` half.
#[inline(always)]
#[allow(clippy::too_many_arguments)]
unsafe fn g2<const SSSE3: bool>(
    a0: &mut __m128i,
    b0: &mut __m128i,
    c0: &mut __m128i,
    d0: &mut __m128i,
    a1: &mut __m128i,
    b1: &mut __m128i,
    c1: &mut __m128i,
    d1: &mut __m128i,
) {
    // SAFETY: as `g1`.
    unsafe {
        *a0 = f_blamka(*a0, *b0);
        *a1 = f_blamka(*a1, *b1);

        *d0 = _mm_xor_si128(*d0, *a0);
        *d1 = _mm_xor_si128(*d1, *a1);

        *d0 = rot16::<SSSE3>(*d0);
        *d1 = rot16::<SSSE3>(*d1);

        *c0 = f_blamka(*c0, *d0);
        *c1 = f_blamka(*c1, *d1);

        *b0 = _mm_xor_si128(*b0, *c0);
        *b1 = _mm_xor_si128(*b1, *c1);

        *b0 = rot63::<SSSE3>(*b0);
        *b1 = rot63::<SSSE3>(*b1);
    }
}

/// `DIAGONALIZE` — `blamka-round-opt.h:107-122` (SSSE3) and `:141-152` (SSE2).
///
/// Reading the two macros as 64-bit lane permutations, both compute:
///
/// ```text
/// B0 <- (B0[1], B1[0])    B1 <- (B1[1], B0[0])
/// C0 <- C1                C1 <- C0
/// D0 <- (D1[1], D0[0])    D1 <- (D0[1], D1[0])
/// ```
///
/// which rotates the 4-element sequence `(x0[0], x0[1], x1[0], x1[1])` left by
/// one slot for `B`, two for `C` and three for `D` — the BLAKE2b diagonal step.
/// `A` is untouched, which is why it is not a parameter.
///
/// The SSE2 branch is transcribed statement for statement; the C reuses `D0` as
/// the scratch for the `C0`/`C1` swap and depends on `D1`/`B1` still holding
/// their original values at the later lines, so the order below is load-bearing.
#[inline(always)]
unsafe fn diagonalize<const SSSE3: bool>(
    b0: &mut __m128i,
    b1: &mut __m128i,
    c0: &mut __m128i,
    c1: &mut __m128i,
    d0: &mut __m128i,
    d1: &mut __m128i,
) {
    // SAFETY: the SSSE3 branch calls `_mm_alignr_epi8` (SSSE3); it is only
    // instantiated inside `fill_segment_ssse3`. The other branch is
    // `punpckhqdq`/`punpcklqdq`, both SSE2.
    unsafe {
        if SSSE3 {
            // t0 = _mm_alignr_epi8(B1, B0, 8) -> (B0[1], B1[0])
            // t1 = _mm_alignr_epi8(B0, B1, 8) -> (B1[1], B0[0])
            let t0 = _mm_alignr_epi8::<8>(*b1, *b0);
            let t1 = _mm_alignr_epi8::<8>(*b0, *b1);
            *b0 = t0;
            *b1 = t1;

            core::mem::swap(c0, c1);

            let t0 = _mm_alignr_epi8::<8>(*d1, *d0);
            let t1 = _mm_alignr_epi8::<8>(*d0, *d1);
            // Note the C assigns these crossed over: `D0 = t1; D1 = t0;`.
            *d0 = t1;
            *d1 = t0;
        } else {
            let t0 = *d0;
            let t1 = *b0;

            // The C does this with `D0` as scratch: `D0 = C0; C0 = C1; C1 = D0;`.
            core::mem::swap(c0, c1);

            // Both lines read the ORIGINAL `*d1`; the first only writes `*d0`.
            *d0 = _mm_unpackhi_epi64(*d1, _mm_unpacklo_epi64(t0, t0));
            *d1 = _mm_unpackhi_epi64(t0, _mm_unpacklo_epi64(*d1, *d1));
            // Likewise: the first line reads the original `*b0` and `*b1`, the
            // second reads the original `*b1` and `t1` (the original `*b0`).
            *b0 = _mm_unpackhi_epi64(*b0, _mm_unpacklo_epi64(*b1, *b1));
            *b1 = _mm_unpackhi_epi64(*b1, _mm_unpacklo_epi64(t1, t1));
        }
    }
}

/// `UNDIAGONALIZE` — `blamka-round-opt.h:124-139` (SSSE3) and `:154-166` (SSE2).
///
/// The exact inverse of [`diagonalize`]:
///
/// ```text
/// B0 <- (B1[1], B0[0])    B1 <- (B0[1], B1[0])
/// C0 <- C1                C1 <- C0
/// D0 <- (D0[1], D1[0])    D1 <- (D1[1], D0[0])
/// ```
#[inline(always)]
unsafe fn undiagonalize<const SSSE3: bool>(
    b0: &mut __m128i,
    b1: &mut __m128i,
    c0: &mut __m128i,
    c1: &mut __m128i,
    d0: &mut __m128i,
    d1: &mut __m128i,
) {
    // SAFETY: as `diagonalize`.
    unsafe {
        if SSSE3 {
            let t0 = _mm_alignr_epi8::<8>(*b0, *b1);
            let t1 = _mm_alignr_epi8::<8>(*b1, *b0);
            *b0 = t0;
            *b1 = t1;

            core::mem::swap(c0, c1);

            let t0 = _mm_alignr_epi8::<8>(*d0, *d1);
            let t1 = _mm_alignr_epi8::<8>(*d1, *d0);
            *d0 = t1;
            *d1 = t0;
        } else {
            // The C swaps C first here, then saves `t0 = B0` and `t1 = D0`.
            core::mem::swap(c0, c1);

            let t0 = *b0;
            let t1 = *d0;

            *b0 = _mm_unpackhi_epi64(*b1, _mm_unpacklo_epi64(*b0, *b0));
            *b1 = _mm_unpackhi_epi64(t0, _mm_unpacklo_epi64(*b1, *b1));
            *d0 = _mm_unpackhi_epi64(*d0, _mm_unpacklo_epi64(*d1, *d1));
            *d1 = _mm_unpackhi_epi64(*d1, _mm_unpacklo_epi64(t1, t1));
        }
    }
}

/// `BLAKE2_ROUND` — `blamka-round-opt.h:169-180`.
///
/// ```c
/// #define BLAKE2_ROUND(A0, A1, B0, B1, C0, C1, D0, D1) do { \
///     G1(A0, B0, C0, D0, A1, B1, C1, D1);                   \
///     G2(A0, B0, C0, D0, A1, B1, C1, D1);                   \
///     DIAGONALIZE(A0, B0, C0, D0, A1, B1, C1, D1);          \
///     G1(A0, B0, C0, D0, A1, B1, C1, D1);                   \
///     G2(A0, B0, C0, D0, A1, B1, C1, D1);                   \
///     UNDIAGONALIZE(A0, B0, C0, D0, A1, B1, C1, D1);        \
/// } while (0)
/// ```
///
/// Note the macro's own parameter order, `A0 A1 B0 B1 C0 C1 D0 D1`: that is the
/// order `opt.c` passes `state[...]` in, and it is the order of both the
/// arguments and the return value here, so a caller can write the eight results
/// straight back to the eight slots it read.
#[inline(always)]
#[allow(clippy::too_many_arguments)]
unsafe fn blake2_round<const SSSE3: bool>(
    a0: __m128i,
    a1: __m128i,
    b0: __m128i,
    b1: __m128i,
    c0: __m128i,
    c1: __m128i,
    d0: __m128i,
    d1: __m128i,
) -> [__m128i; 8] {
    let (mut a0, mut a1, mut b0, mut b1) = (a0, a1, b0, b1);
    let (mut c0, mut c1, mut d0, mut d1) = (c0, c1, d0, d1);

    // SAFETY: the callees' contracts are satisfied by this function's own
    // contract — it is only instantiated with `SSSE3 == true` from a caller that
    // enables `ssse3`.
    unsafe {
        g1::<SSSE3>(
            &mut a0, &mut b0, &mut c0, &mut d0, &mut a1, &mut b1, &mut c1, &mut d1,
        );
        g2::<SSSE3>(
            &mut a0, &mut b0, &mut c0, &mut d0, &mut a1, &mut b1, &mut c1, &mut d1,
        );

        diagonalize::<SSSE3>(&mut b0, &mut b1, &mut c0, &mut c1, &mut d0, &mut d1);

        g1::<SSSE3>(
            &mut a0, &mut b0, &mut c0, &mut d0, &mut a1, &mut b1, &mut c1, &mut d1,
        );
        g2::<SSSE3>(
            &mut a0, &mut b0, &mut c0, &mut d0, &mut a1, &mut b1, &mut c1, &mut d1,
        );

        undiagonalize::<SSSE3>(&mut b0, &mut b1, &mut c0, &mut c1, &mut d0, &mut d1);
    }

    [a0, a1, b0, b1, c0, c1, d0, d1]
}

// ---------------------------------------------------------------------------
// opt.c, 128-bit path
// ---------------------------------------------------------------------------

/// `fill_block()` — `opt.c:110-145`.
///
/// ```c
/// if (with_xor) { state[i] ^= ref[i];  block_XY[i] = state[i] ^ next[i]; }
/// else          { block_XY[i] = state[i] = state[i] ^ ref[i]; }
/// 8 column rounds; 8 row rounds;
/// state[i] ^= block_XY[i]; store next[i] = state[i];
/// ```
///
/// `state` is the caller's live 1 KiB register file: on entry it holds the
/// previous block, on exit the block just written to `next_block`. That is what
/// lets `fill_segment` skip re-reading `memory[prev_offset]` every iteration.
///
/// # Safety
///
/// * The CPU must support SSE2, and SSSE3 as well when `SSSE3` is `true`.
/// * `ref_block` must be valid for reads of one [`Block`] and `next_block` for
///   reads and writes of one [`Block`].
/// * The two may alias — `next_addresses` calls this with
///   `ref_block == next_block`. That is sound because every load from
///   `ref_block` happens in the first loop and every store to `next_block` in
///   the last, and because raw pointers are used rather than a `&`/`&mut` pair.
///   When `with_xor` is `false` the old contents of `next_block` are never read,
///   so it may also be uninitialised as far as *this* function is concerned.
#[inline(always)]
unsafe fn fill_block<const SSSE3: bool>(
    state: &mut [__m128i; OWORDS_IN_BLOCK],
    ref_block: *const Block,
    next_block: *mut Block,
    with_xor: bool,
) {
    let refp = ref_block.cast::<__m128i>();
    let nextp = next_block.cast::<__m128i>();

    // `opt.c` declares `__m128i block_XY[...];` UNINITIALISED, and so does this.
    //
    // Spelling it `[_mm_setzero_si128(); OWORDS_IN_BLOCK]` instead costs a real
    // 1 KiB `memset` **per block**: LLVM does not eliminate it, because the two
    // arms of `if with_xor` fill the array in separate basic blocks and
    // dead-store elimination never sees a single whole-array overwrite.
    //
    // Measured, not assumed. Release asm for `x86_64-unknown-linux-musl`,
    // counting inside the `fill_segment_sse2_only` symbol:
    //
    //   as written (MaybeUninit::uninit)  2122 instructions, 3 memset sites
    //   `[_mm_setzero_si128(); 64]`       2145 instructions, 6 memset sites
    //
    // `avx2.rs` has the same shape (1807 -> 1835 instructions, 3 -> 6 memset
    // sites). The three extra sites are the three places `fill_block` inlines.
    //
    // SAFETY of the `assume_init` below: both arms write all 64 elements before
    // anything reads one, so the array is fully initialised by the time the
    // final loop runs.
    let mut block_xy: [MaybeUninit<__m128i>; OWORDS_IN_BLOCK] =
        [const { MaybeUninit::uninit() }; OWORDS_IN_BLOCK];

    // SAFETY: the loads and stores are `loadu`/`storeu`, so no alignment is
    // required, and `i < OWORDS_IN_BLOCK == 64` keeps every access inside the
    // one `Block` each pointer is valid for (`64 * 16 == 1024` bytes). The
    // intrinsics are SSE2.
    unsafe {
        if with_xor {
            for i in 0..OWORDS_IN_BLOCK {
                state[i] = _mm_xor_si128(state[i], _mm_loadu_si128(refp.add(i)));
                block_xy[i] = MaybeUninit::new(_mm_xor_si128(
                    state[i],
                    _mm_loadu_si128(nextp.add(i).cast_const()),
                ));
            }
        } else {
            for i in 0..OWORDS_IN_BLOCK {
                state[i] = _mm_xor_si128(state[i], _mm_loadu_si128(refp.add(i)));
                block_xy[i] = MaybeUninit::new(state[i]);
            }
        }
    }

    // opt.c:129-133 — "Apply Blake2 on columns of 64-bit words".
    // BLAKE2_ROUND(state[8i+0], state[8i+1], ..., state[8i+7]).
    for i in 0..8 {
        let base = 8 * i;
        // SAFETY: `base + 7 <= 63`, and the round's contract is this function's.
        let r = unsafe {
            blake2_round::<SSSE3>(
                state[base],
                state[base + 1],
                state[base + 2],
                state[base + 3],
                state[base + 4],
                state[base + 5],
                state[base + 6],
                state[base + 7],
            )
        };
        for (k, value) in r.into_iter().enumerate() {
            state[base + k] = value;
        }
    }

    // opt.c:135-139 — "Apply Blake2 on rows of 64-bit words".
    // BLAKE2_ROUND(state[8*0+i], state[8*1+i], ..., state[8*7+i]).
    for i in 0..8 {
        // SAFETY: `8 * 7 + i <= 63`; the round's contract is this function's.
        let r = unsafe {
            blake2_round::<SSSE3>(
                state[i],
                state[8 + i],
                state[16 + i],
                state[24 + i],
                state[32 + i],
                state[40 + i],
                state[48 + i],
                state[56 + i],
            )
        };
        for (k, value) in r.into_iter().enumerate() {
            state[8 * k + i] = value;
        }
    }

    // SAFETY: as the load loop above.
    unsafe {
        for i in 0..OWORDS_IN_BLOCK {
            state[i] = _mm_xor_si128(state[i], block_xy[i].assume_init());
            _mm_storeu_si128(nextp.add(i), state[i]);
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
/// notes for why that is sound here.
///
/// # Safety
///
/// The CPU must support SSE2, plus SSSE3 when `SSSE3` is `true`.
/// `address_block` and `input_block` must each be valid for reads and writes of
/// one [`Block`] and must not alias each other.
#[inline(always)]
unsafe fn next_addresses<const SSSE3: bool>(address_block: *mut Block, input_block: *mut Block) {
    // SAFETY: `_mm_setzero_si128` is SSE2, which this function's contract requires.
    let zero = unsafe { _mm_setzero_si128() };
    let mut zero_state = [zero; OWORDS_IN_BLOCK];
    let mut zero2_state = [zero; OWORDS_IN_BLOCK];

    // SAFETY: `input_block` is valid for reads and writes of one `Block`, and
    // does not alias `address_block`. The `uint64_t` increment wraps in C, so
    // `wrapping_add` here rather than a `+` that would panic in debug.
    unsafe {
        (*input_block).0[6] = (*input_block).0[6].wrapping_add(1);
    }

    // SAFETY: both pointers are valid for one `Block`; `fill_block` explicitly
    // permits `ref == next`, which the second call relies on.
    unsafe {
        fill_block::<SSSE3>(
            &mut zero_state,
            input_block.cast_const(),
            address_block,
            false,
        );
        fill_block::<SSSE3>(
            &mut zero2_state,
            address_block.cast_const(),
            address_block,
            false,
        );
    }
}

/// `fill_segment()` — `opt.c:174-283`, with the `state` type fixed to
/// `__m128i[64]`.
///
/// `#[inline(always)]` is load-bearing, not a hint: it is what puts this body
/// (and everything it calls) inside a caller that declares the right
/// `target_feature`, so the intrinsics are selected in the right feature context
/// and `fill_block` keeps `state` live across iterations.
///
/// # Safety
///
/// See [`crate::fill_block::FillSegmentFn`]. The CPU must support SSE2, plus
/// SSSE3 when `SSSE3` is `true`.
#[inline(always)]
unsafe fn fill_segment_impl<const SSSE3: bool>(instance: &Instance, mut position: Position) {
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
    // Constant for the whole segment, so it is hoisted out of the loop.
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
            // SAFETY: SSE2/SSSE3 as this function's contract; the two locals are
            // distinct `Block`s, so the pointers are valid and do not alias.
            unsafe {
                next_addresses::<SSSE3>(&raw mut address_block, &raw mut input_block);
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
    // alignment and 64 `__m128i` is exactly one `Block`.
    let mut state = unsafe {
        let p = instance
            .block_ptr(prev_offset)
            .cast::<__m128i>()
            .cast_const();
        let mut state = [_mm_setzero_si128(); OWORDS_IN_BLOCK];
        for (i, slot) in state.iter_mut().enumerate() {
            *slot = _mm_loadu_si128(p.add(i));
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
                    next_addresses::<SSSE3>(&raw mut address_block, &raw mut input_block);
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
            fill_block::<SSSE3>(
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
// Entry points
// ---------------------------------------------------------------------------

/// SSE2 `fill_segment()`, the entry point `fill_block/mod.rs` dispatches to.
///
/// Declares only `sse2`, then picks the SSSE3 or the SSE2-only implementation
/// from the cached runtime probe. That is one relaxed atomic load and one branch
/// **per segment** — a segment is `segment_length` blocks, thousands at any
/// realistic `m_cost` — so the per-block cost is nil, and nothing detects or
/// dispatches inside the block loop.
///
/// # Safety
///
/// The CPU must support SSE2 (baseline on x86-64, runtime-checked on x86 via
/// [`crate::fill_block::Backend::is_available`]). All the requirements of
/// [`crate::fill_block::FillSegmentFn`] apply.
#[target_feature(enable = "sse2")]
pub unsafe fn fill_segment(instance: &Instance, position: Position) {
    if have_ssse3() {
        // SAFETY: `have_ssse3()` just confirmed SSSE3, and the caller upholds
        // `FillSegmentFn`'s contract.
        unsafe { fill_segment_ssse3(instance, position) }
    } else {
        // SAFETY: the caller upholds `FillSegmentFn`'s contract, and SSE2 is
        // this function's own precondition.
        unsafe { fill_segment_sse2_only(instance, position) }
    }
}

/// `fill_segment()` using **only** SSE2 — no `pshufb`, no `palignr`.
///
/// This is `blamka-round-opt.h`'s `#else /* defined(__SSE2__) */` spelling:
/// the rotations are `psrlq`/`psllq`/`pxor` and `DIAGONALIZE` is
/// `punpckhqdq`/`punpcklqdq`. Bit-identical output to [`fill_segment_ssse3`].
///
/// Exposed so a test can force this path on a host whose target baseline
/// includes SSSE3 (which is the case for `x86_64-apple-darwin`).
///
/// # Safety
///
/// As [`fill_segment`], but needs only SSE2.
#[target_feature(enable = "sse2")]
pub unsafe fn fill_segment_sse2_only(instance: &Instance, position: Position) {
    // SAFETY: the caller upholds `FillSegmentFn`'s contract; `SSSE3 == false`
    // instantiates the branch that uses no SSSE3 intrinsic.
    unsafe { fill_segment_impl::<false>(instance, position) }
}

/// `fill_segment()` using the SSSE3 spelling of the rotations and of
/// `DIAGONALIZE` (`blamka-round-opt.h`'s `#if defined(__SSSE3__)` branch).
///
/// # Safety
///
/// As [`fill_segment`], and the CPU must **also** support SSSE3. Take this via
/// [`fill_segment`] unless you have checked
/// `is_x86_feature_detected!("ssse3")` yourself.
#[target_feature(enable = "sse2,ssse3")]
pub unsafe fn fill_segment_ssse3(instance: &Instance, position: Position) {
    // SAFETY: the caller guarantees SSSE3 (this function declares it, so a
    // caller reaching it without the feature is already unsound) and upholds
    // `FillSegmentFn`'s contract.
    unsafe { fill_segment_impl::<true>(instance, position) }
}

// ---------------------------------------------------------------------------
// Shared test support for the three x86 backends
// ---------------------------------------------------------------------------

/// Test-only helpers shared by `sse2.rs`, `avx2.rs` and `avx512.rs`.
///
/// It lives here because `mod.rs` gates `sse2` on
/// `any(target_arch = "x86", target_arch = "x86_64")` and both `avx2` and
/// `avx512` on `target_arch = "x86_64"`, so whenever those two exist this module
/// does too. Nothing outside `#[cfg(test)]` refers to it.
#[cfg(test)]
pub(crate) mod test_support {
    use crate::block::{Block, Instance, Position};
    use crate::error::Error;
    use crate::fill_block::{Backend, FillSegmentFn};
    use crate::memory::{Arena, clear_internal_memory};
    use crate::params::{
        Algorithm, Memory, PREHASH_DIGEST_LENGTH, Params, QWORDS_IN_BLOCK, SYNC_POINTS, TagLen,
        Version,
    };

    // ------------------------------------------------------------------
    // Deterministic PRNG
    // ------------------------------------------------------------------

    /// xorshift64\* — a fixed-seed, fully reproducible generator.
    ///
    /// No `rand` (zero mandatory dependencies) and no wall-clock seeding, so a
    /// failure is always replayable from the constant in the test.
    pub struct XorShift64Star(u64);

    impl XorShift64Star {
        /// `seed` must be non-zero; xorshift has 0 as a fixed point.
        pub const fn new(seed: u64) -> XorShift64Star {
            XorShift64Star(if seed == 0 {
                0x2545_F491_4F6C_DD1D
            } else {
                seed
            })
        }

        pub fn next_u64(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }

        /// A block of 128 pseudo-random words.
        pub fn next_block(&mut self) -> Block {
            let mut b = Block::ZERO;
            for word in &mut b.0 {
                *word = self.next_u64();
            }
            b
        }
    }

    // ------------------------------------------------------------------
    // fill_block equivalence
    // ------------------------------------------------------------------

    /// One `fill_block` call, expressed on whole [`Block`]s.
    ///
    /// A backend's real `fill_block` takes the previous block already loaded
    /// into its SIMD `state`; this wraps that up so a backend can be compared
    /// against `scalar::fill_block`, whose signature is
    /// `(prev, ref, next, with_xor)`.
    pub type FillBlockFn = unsafe fn(&Block, &Block, &mut Block, bool);

    /// Assert `candidate` reproduces `scalar::fill_block` bit for bit over
    /// `rounds` pseudo-random `(prev, ref, next)` triples, for both values of
    /// `with_xor`.
    ///
    /// Every one of the 128 output words is compared, and the first mismatch
    /// reports the iteration, the `with_xor` flag and the word index.
    ///
    /// # Safety
    ///
    /// The CPU must support whatever instruction set `candidate` needs.
    pub unsafe fn assert_fill_block_matches_scalar(
        label: &str,
        candidate: FillBlockFn,
        rounds: u32,
        seed: u64,
    ) {
        let mut rng = XorShift64Star::new(seed);
        let mut checked = 0u32;

        for iteration in 0..rounds {
            let prev = rng.next_block();
            let reference = rng.next_block();
            let original_next = rng.next_block();

            for with_xor in [false, true] {
                let mut want = original_next;
                crate::fill_block::scalar::fill_block(&prev, &reference, &mut want, with_xor);

                let mut got = original_next;
                // SAFETY: the caller guarantees the CPU supports `candidate`.
                unsafe { candidate(&prev, &reference, &mut got, with_xor) };

                for w in 0..QWORDS_IN_BLOCK {
                    assert_eq!(
                        got.0[w], want.0[w],
                        "{label}: iteration {iteration}, with_xor={with_xor}, word {w}: \
                         got {:#018x}, scalar says {:#018x}",
                        got.0[w], want.0[w]
                    );
                }
                checked += 1;
            }
        }

        // Guard against a silently-empty loop.
        assert_eq!(checked, rounds * 2, "{label}: wrong number of comparisons");
    }

    /// Assert two `fill_block` implementations agree with each other, for both
    /// values of `with_xor`. Used to pin the SSE2-only path against the SSSE3
    /// path.
    ///
    /// # Safety
    ///
    /// The CPU must support whatever instruction sets both functions need.
    pub unsafe fn assert_fill_blocks_agree(
        label: &str,
        left: FillBlockFn,
        right: FillBlockFn,
        rounds: u32,
        seed: u64,
    ) {
        let mut rng = XorShift64Star::new(seed);
        for iteration in 0..rounds {
            let prev = rng.next_block();
            let reference = rng.next_block();
            let original_next = rng.next_block();

            for with_xor in [false, true] {
                let mut a = original_next;
                let mut b = original_next;
                // SAFETY: the caller guarantees the CPU supports both.
                unsafe {
                    left(&prev, &reference, &mut a, with_xor);
                    right(&prev, &reference, &mut b, with_xor);
                }
                for w in 0..QWORDS_IN_BLOCK {
                    assert_eq!(
                        a.0[w], b.0[w],
                        "{label}: iteration {iteration}, with_xor={with_xor}, word {w}"
                    );
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // The official vectors, transcribed from src/test.c
    // ------------------------------------------------------------------

    /// One `hashtest()` call from `phc-winner-argon2/src/test.c`.
    pub struct Vector {
        /// Line in `src/test.c` the values came from.
        pub line: u32,
        pub version: Version,
        /// `t_cost`.
        pub t: u32,
        /// The C passes `1 << m` as `m_cost`, so this is the exponent.
        pub m_log2: u32,
        /// `p` — lanes, and (after `argon2_hash`) threads.
        pub p: u32,
        pub pwd: &'static str,
        pub salt: &'static str,
        /// The 32-byte tag, lowercase hex.
        pub hex: &'static str,
        pub algorithm: Algorithm,
        /// `#ifdef TEST_LARGE_RAM` — `m_cost == 1 << 20`, a 1 GiB arena.
        pub large_ram: bool,
    }

    /// Every `hashtest()` in `src/test.c`, in source order.
    ///
    /// Extracted by parsing `test.c` rather than retyped, so a transcription
    /// slip is not possible. 26 entries: 9 for `ARGON2_VERSION_10` + Argon2i,
    /// 9 for `ARGON2_VERSION_NUMBER` + Argon2i, 8 for `ARGON2_VERSION_NUMBER` +
    /// Argon2id. Two of them are behind `#ifdef TEST_LARGE_RAM`.
    ///
    /// `rustfmt::skip` on purpose: one line per `hashtest()` call keeps this
    /// table mechanically diffable against the generator that produced it, so a
    /// future re-extraction from `test.c` shows up as a clean diff rather than a
    /// reflow. Letting rustfmt explode each entry over 12 lines would destroy
    /// that.
    #[rustfmt::skip]
    pub const VECTORS: &[Vector] = &[
        Vector { line: 77, version: Version::V0x10, t: 2, m_log2: 16, p: 1, pwd: "password", salt: "somesalt", hex: "f6c4db4a54e2a370627aff3db6176b94a2a209a62c8e36152711802f7b30c694", algorithm: Algorithm::Argon2i, large_ram: false },
        Vector { line: 82, version: Version::V0x10, t: 2, m_log2: 20, p: 1, pwd: "password", salt: "somesalt", hex: "9690ec55d28d3ed32562f2e73ea62b02b018757643a2ae6e79528459de8106e9", algorithm: Algorithm::Argon2i, large_ram: true },
        Vector { line: 87, version: Version::V0x10, t: 2, m_log2: 18, p: 1, pwd: "password", salt: "somesalt", hex: "3e689aaa3d28a77cf2bc72a51ac53166761751182f1ee292e3f677a7da4c2467", algorithm: Algorithm::Argon2i, large_ram: false },
        Vector { line: 91, version: Version::V0x10, t: 2, m_log2: 8, p: 1, pwd: "password", salt: "somesalt", hex: "fd4dd83d762c49bdeaf57c47bdcd0c2f1babf863fdeb490df63ede9975fccf06", algorithm: Algorithm::Argon2i, large_ram: false },
        Vector { line: 95, version: Version::V0x10, t: 2, m_log2: 8, p: 2, pwd: "password", salt: "somesalt", hex: "b6c11560a6a9d61eac706b79a2f97d68b4463aa3ad87e00c07e2b01e90c564fb", algorithm: Algorithm::Argon2i, large_ram: false },
        Vector { line: 99, version: Version::V0x10, t: 1, m_log2: 16, p: 1, pwd: "password", salt: "somesalt", hex: "81630552b8f3b1f48cdb1992c4c678643d490b2b5eb4ff6c4b3438b5621724b2", algorithm: Algorithm::Argon2i, large_ram: false },
        Vector { line: 103, version: Version::V0x10, t: 4, m_log2: 16, p: 1, pwd: "password", salt: "somesalt", hex: "f212f01615e6eb5d74734dc3ef40ade2d51d052468d8c69440a3a1f2c1c2847b", algorithm: Algorithm::Argon2i, large_ram: false },
        Vector { line: 107, version: Version::V0x10, t: 2, m_log2: 16, p: 1, pwd: "differentpassword", salt: "somesalt", hex: "e9c902074b6754531a3a0be519e5baf404b30ce69b3f01ac3bf21229960109a3", algorithm: Algorithm::Argon2i, large_ram: false },
        Vector { line: 111, version: Version::V0x10, t: 2, m_log2: 16, p: 1, pwd: "password", salt: "diffsalt", hex: "79a103b90fe8aef8570cb31fc8b22259778916f8336b7bdac3892569d4f1c497", algorithm: Algorithm::Argon2i, large_ram: false },
        Vector { line: 156, version: Version::V0x13, t: 2, m_log2: 16, p: 1, pwd: "password", salt: "somesalt", hex: "c1628832147d9720c5bd1cfd61367078729f6dfb6f8fea9ff98158e0d7816ed0", algorithm: Algorithm::Argon2i, large_ram: false },
        Vector { line: 161, version: Version::V0x13, t: 2, m_log2: 20, p: 1, pwd: "password", salt: "somesalt", hex: "d1587aca0922c3b5d6a83edab31bee3c4ebaef342ed6127a55d19b2351ad1f41", algorithm: Algorithm::Argon2i, large_ram: true },
        Vector { line: 166, version: Version::V0x13, t: 2, m_log2: 18, p: 1, pwd: "password", salt: "somesalt", hex: "296dbae80b807cdceaad44ae741b506f14db0959267b183b118f9b24229bc7cb", algorithm: Algorithm::Argon2i, large_ram: false },
        Vector { line: 170, version: Version::V0x13, t: 2, m_log2: 8, p: 1, pwd: "password", salt: "somesalt", hex: "89e9029f4637b295beb027056a7336c414fadd43f6b208645281cb214a56452f", algorithm: Algorithm::Argon2i, large_ram: false },
        Vector { line: 174, version: Version::V0x13, t: 2, m_log2: 8, p: 2, pwd: "password", salt: "somesalt", hex: "4ff5ce2769a1d7f4c8a491df09d41a9fbe90e5eb02155a13e4c01e20cd4eab61", algorithm: Algorithm::Argon2i, large_ram: false },
        Vector { line: 178, version: Version::V0x13, t: 1, m_log2: 16, p: 1, pwd: "password", salt: "somesalt", hex: "d168075c4d985e13ebeae560cf8b94c3b5d8a16c51916b6f4ac2da3ac11bbecf", algorithm: Algorithm::Argon2i, large_ram: false },
        Vector { line: 182, version: Version::V0x13, t: 4, m_log2: 16, p: 1, pwd: "password", salt: "somesalt", hex: "aaa953d58af3706ce3df1aefd4a64a84e31d7f54175231f1285259f88174ce5b", algorithm: Algorithm::Argon2i, large_ram: false },
        Vector { line: 186, version: Version::V0x13, t: 2, m_log2: 16, p: 1, pwd: "differentpassword", salt: "somesalt", hex: "14ae8da01afea8700c2358dcef7c5358d9021282bd88663a4562f59fb74d22ee", algorithm: Algorithm::Argon2i, large_ram: false },
        Vector { line: 190, version: Version::V0x13, t: 2, m_log2: 16, p: 1, pwd: "password", salt: "diffsalt", hex: "b0357cccfbef91f3860b0dba447b2348cbefecadaf990abfe9cc40726c521271", algorithm: Algorithm::Argon2i, large_ram: false },
        Vector { line: 233, version: Version::V0x13, t: 2, m_log2: 16, p: 1, pwd: "password", salt: "somesalt", hex: "09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7", algorithm: Algorithm::Argon2id, large_ram: false },
        Vector { line: 237, version: Version::V0x13, t: 2, m_log2: 18, p: 1, pwd: "password", salt: "somesalt", hex: "78fe1ec91fb3aa5657d72e710854e4c3d9b9198c742f9616c2f085bed95b2e8c", algorithm: Algorithm::Argon2id, large_ram: false },
        Vector { line: 241, version: Version::V0x13, t: 2, m_log2: 8, p: 1, pwd: "password", salt: "somesalt", hex: "9dfeb910e80bad0311fee20f9c0e2b12c17987b4cac90c2ef54d5b3021c68bfe", algorithm: Algorithm::Argon2id, large_ram: false },
        Vector { line: 245, version: Version::V0x13, t: 2, m_log2: 8, p: 2, pwd: "password", salt: "somesalt", hex: "6d093c501fd5999645e0ea3bf620d7b8be7fd2db59c20d9fff9539da2bf57037", algorithm: Algorithm::Argon2id, large_ram: false },
        Vector { line: 249, version: Version::V0x13, t: 1, m_log2: 16, p: 1, pwd: "password", salt: "somesalt", hex: "f6a5adc1ba723dddef9b5ac1d464e180fcd9dffc9d1cbf76cca2fed795d9ca98", algorithm: Algorithm::Argon2id, large_ram: false },
        Vector { line: 253, version: Version::V0x13, t: 4, m_log2: 16, p: 1, pwd: "password", salt: "somesalt", hex: "9025d48e68ef7395cca9079da4c4ec3affb3c8911fe4f86d1a2520856f63172c", algorithm: Algorithm::Argon2id, large_ram: false },
        Vector { line: 257, version: Version::V0x13, t: 2, m_log2: 16, p: 1, pwd: "differentpassword", salt: "somesalt", hex: "0b84d652cf6b0c4beaef0dfe278ba6a80df6696281d7e0d2891b817d8c458fde", algorithm: Algorithm::Argon2id, large_ram: false },
        Vector { line: 261, version: Version::V0x13, t: 2, m_log2: 16, p: 1, pwd: "password", salt: "diffsalt", hex: "bdf32b05ccc42eb15d58fd19b1f856b113da1e9a5874fdcc544308565aa8141c", algorithm: Algorithm::Argon2id, large_ram: false },
    ];

    /// Decode a lowercase hex tag into 32 bytes.
    fn hex32(hex: &str) -> [u8; 32] {
        assert_eq!(hex.len(), 64, "tag must be 64 hex chars");
        let bytes = hex.as_bytes();
        let mut out = [0u8; 32];
        for (i, byte) in out.iter_mut().enumerate() {
            let hi = (bytes[2 * i] as char).to_digit(16).expect("hex digit");
            let lo = (bytes[2 * i + 1] as char).to_digit(16).expect("hex digit");
            *byte = (hi * 16 + lo) as u8;
        }
        out
    }

    /// The three blocks of `hashtest()` calls in `main()` of `src/test.c`.
    ///
    /// Splitting the vector set this way lets the harness run one `#[test]` per
    /// group in parallel. Each group holds exactly one of the three expensive
    /// `m == 1 << 18` vectors, so the wall time is roughly one third of running
    /// them serially.
    #[derive(Copy, Clone, PartialEq, Eq, Debug)]
    pub enum Group {
        /// `test.c:74-113` — `ARGON2_VERSION_10`, Argon2i. 9 vectors.
        V0x10Argon2i,
        /// `test.c:153-192` — `ARGON2_VERSION_NUMBER`, Argon2i. 9 vectors.
        V0x13Argon2i,
        /// `test.c:230-263` — `ARGON2_VERSION_NUMBER`, Argon2id. 8 vectors.
        V0x13Argon2id,
        /// Every vector, in source order.
        All,
    }

    impl Group {
        fn contains(self, v: &Vector) -> bool {
            let is_v10 = v.version.as_u32() == Version::V0x10.as_u32();
            let is_2id = matches!(v.algorithm, Algorithm::Argon2id);
            match self {
                Group::V0x10Argon2i => is_v10,
                Group::V0x13Argon2i => !is_v10 && !is_2id,
                Group::V0x13Argon2id => !is_v10 && is_2id,
                Group::All => true,
            }
        }
    }

    /// Run the official vectors in `group` through `backend` and compare against
    /// `test.c`'s expected tags.
    ///
    /// This forces the backend instead of taking whatever
    /// `crate::fill_block::detect()` picked, which is the point.
    ///
    /// # Safety
    ///
    /// As [`crate::core::hash_traced`]: this CPU must be able to execute
    /// `backend`. Callers get that from `skip_unless_available(backend)`, or —
    /// for the deliberate AVX2 bypass under Rosetta 2 — from the host having
    /// been *measured* to execute the instructions it hides from `cpuid`.
    pub unsafe fn check_official_vectors(backend: Backend, group: Group, include_large_ram: bool) {
        let mut ran = 0u32;
        for v in VECTORS {
            if !group.contains(v) || (v.large_ram && !include_large_ram) {
                continue;
            }
            let params = Params::builder()
                .memory(Memory::kib(1 << v.m_log2))
                .passes(v.t)
                .lanes(v.p)
                .tag_len(TagLen::bytes(32))
                .build()
                .unwrap_or_else(|e| panic!("test.c:{} params rejected: {e}", v.line));
            let mut out = [0u8; 32];
            // SAFETY: forwarded verbatim from this function's own contract —
            // the caller guarantees this CPU can execute `backend`.
            unsafe {
                crate::core::hash_traced(
                    backend,
                    v.algorithm,
                    v.version,
                    &params,
                    v.pwd.as_bytes(),
                    v.salt.as_bytes(),
                    &[],
                    &[],
                    &mut out,
                    None,
                )
            }
            .unwrap_or_else(|e| panic!("test.c:{} hash failed: {e}", v.line));

            assert_eq!(
                out,
                hex32(v.hex),
                "backend {backend}, test.c:{} (v={:#x} t={} m={} p={} {} pwd={:?} salt={:?})",
                v.line,
                v.version.as_u32(),
                v.t,
                1u32 << v.m_log2,
                v.p,
                v.algorithm.as_str(),
                v.pwd,
                v.salt,
            );
            ran += 1;
        }
        let expected = VECTORS
            .iter()
            .filter(|v| group.contains(v) && (include_large_ram || !v.large_ram))
            .count() as u32;
        assert_eq!(ran, expected, "not every vector in {group:?} ran");
        assert!(ran > 0, "{group:?} selected no vectors");
    }

    /// Whether a test needing `backend` has to bail out — `true` means skip.
    ///
    /// The Rust test harness has no notion of a skipped test, so a guarded test
    /// that quietly returns still reports `ok`, which reads as "this backend was
    /// verified" when it was not. Setting the `ARGON2_REQUIRE_BACKEND`
    /// environment variable to a comma-separated list of [`Backend::name`]s
    /// turns a skip into a **failure**, so a gate command can *prove* the
    /// guarded tests really executed:
    ///
    /// ```text
    /// ARGON2_REQUIRE_BACKEND=avx2 RUSTFLAGS="-C target-feature=+avx2" \
    ///   cargo test --target x86_64-apple-darwin --features internal-api
    /// ```
    pub fn skip_unless_available(backend: Backend) -> bool {
        if backend.is_available() {
            return false;
        }
        #[cfg(feature = "std")]
        {
            if let Ok(required) = std::env::var("ARGON2_REQUIRE_BACKEND")
                && required
                    .split(',')
                    .any(|name| name.trim() == backend.name())
            {
                panic!(
                    "ARGON2_REQUIRE_BACKEND lists {backend}, but \
                     Backend::{backend:?}.is_available() is false, so this test \
                     would have been silently skipped"
                );
            }
        }
        true
    }

    /// How many vectors each [`Group`] holds, so a test can assert the split is
    /// exhaustive and non-overlapping.
    pub fn group_sizes() -> [usize; 3] {
        [
            Group::V0x10Argon2i,
            Group::V0x13Argon2i,
            Group::V0x13Argon2id,
        ]
        .map(|g| VECTORS.iter().filter(|v| g.contains(v)).count())
    }

    // ------------------------------------------------------------------
    // Driving a hash with an explicit FillSegmentFn
    // ------------------------------------------------------------------

    /// `core::hash_traced`, but driven by a raw [`FillSegmentFn`] instead of a
    /// [`Backend`].
    ///
    /// `Backend` cannot name an intra-backend variant such as
    /// "SSE2 without SSSE3", so this mirrors the single-threaded
    /// `fill_memory_blocks` loop to let a test force one. It is deliberately
    /// single-threaded: `threads` never affects the tag.
    ///
    /// # Safety
    ///
    /// The CPU must support whatever instruction set `fill` needs.
    #[allow(clippy::too_many_arguments)]
    pub unsafe fn hash_with_fill_segment_fn(
        fill: FillSegmentFn,
        algorithm: Algorithm,
        version: Version,
        params: &Params,
        pwd: &[u8],
        salt: &[u8],
        out: &mut [u8],
    ) -> Result<(), Error> {
        params.validate_for(pwd.len(), salt.len(), 0, 0)?;
        if out.len() != params.tag_len_bytes() {
            return Err(Error::OutPtrMismatch);
        }

        let (memory_blocks, _segment_length, lane_length) = params.memory_layout();
        let mut arena = Arena::new(memory_blocks as usize)?;

        let mut blockhash =
            crate::core::initial_hash(algorithm, version, params, pwd, salt, &[], &[])?;
        let _h0: [u8; PREHASH_DIGEST_LENGTH] = {
            let mut h = [0u8; PREHASH_DIGEST_LENGTH];
            h.copy_from_slice(&blockhash[..PREHASH_DIGEST_LENGTH]);
            h
        };

        let fill_first = crate::core::fill_first_blocks(
            &mut blockhash,
            arena.as_mut_slice(),
            params.lanes(),
            lane_length,
        );
        clear_internal_memory(&mut blockhash);
        fill_first?;

        // SAFETY: `arena` owns `memory_blocks` initialised, 64-byte-aligned
        // `Block`s, outlives `instance`, and `arena.len() == memory_blocks`.
        let instance =
            unsafe { Instance::new(arena.as_mut_ptr(), arena.len(), algorithm, version, params) };

        // The `fill_memory_blocks_traced` loop, single-threaded.
        for pass in 0..instance.passes {
            for slice in 0..SYNC_POINTS {
                for lane in 0..instance.lanes {
                    // SAFETY: single-threaded, so within a slice nothing else
                    // touches the arena; `pass`, `slice` and `lane` are all in
                    // range, and the caller guarantees the CPU supports `fill`.
                    unsafe { fill(&instance, Position::new(pass, lane, slice, 0)) };
                }
            }
        }

        crate::core::finalize(&instance, out)
    }

    /// Run the official vectors through a raw [`FillSegmentFn`].
    ///
    /// The `m_log2 == 18` and `large_ram` vectors are skipped: this path exists
    /// only to cover intra-backend variants, and the cheap vectors already
    /// exercise every code path (both versions, both `with_xor` values,
    /// `p == 1` and `p == 2`, `t` from 1 to 4).
    ///
    /// # Safety
    ///
    /// The CPU must support whatever instruction set `fill` needs.
    pub unsafe fn check_official_vectors_with_fill_fn(label: &str, fill: FillSegmentFn) {
        let mut ran = 0u32;
        for v in VECTORS {
            if v.large_ram || v.m_log2 > 16 {
                continue;
            }
            let params = Params::builder()
                .memory(Memory::kib(1 << v.m_log2))
                .passes(v.t)
                .lanes(v.p)
                .tag_len(TagLen::bytes(32))
                .build()
                .unwrap_or_else(|e| panic!("test.c:{} params rejected: {e}", v.line));
            let mut out = [0u8; 32];
            // SAFETY: the caller guarantees the CPU supports `fill`.
            unsafe {
                hash_with_fill_segment_fn(
                    fill,
                    v.algorithm,
                    v.version,
                    &params,
                    v.pwd.as_bytes(),
                    v.salt.as_bytes(),
                    &mut out,
                )
            }
            .unwrap_or_else(|e| panic!("test.c:{} hash failed: {e}", v.line));

            assert_eq!(out, hex32(v.hex), "{label}, test.c:{}", v.line);
            ran += 1;
        }
        assert!(ran >= 20, "{label}: only {ran} vectors ran");
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{
        Group, XorShift64Star, assert_fill_block_matches_scalar, assert_fill_blocks_agree,
        check_official_vectors, check_official_vectors_with_fill_fn, group_sizes,
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
    /// The CPU must support SSE2, plus SSSE3 when `SSSE3` is `true`.
    unsafe fn fill_block_blocks<const SSSE3: bool>(
        prev: &Block,
        reference: &Block,
        next: &mut Block,
        with_xor: bool,
    ) {
        // SAFETY: `prev` is one `Block` = 64 `__m128i`, read with `loadu`;
        // `reference` and `next` are distinct live `Block`s. The `SSSE3`
        // instantiation matches the caller's declared features.
        unsafe {
            let mut state = [_mm_setzero_si128(); OWORDS_IN_BLOCK];
            let p = prev.as_ptr().cast::<__m128i>();
            for (i, slot) in state.iter_mut().enumerate() {
                *slot = _mm_loadu_si128(p.add(i));
            }
            fill_block::<SSSE3>(&mut state, reference, next, with_xor);
        }
    }

    /// `fill_block_blocks::<false>` behind a `sse2`-only boundary.
    ///
    /// # Safety
    ///
    /// The CPU must support SSE2.
    #[target_feature(enable = "sse2")]
    unsafe fn fill_block_sse2_only(
        prev: &Block,
        reference: &Block,
        next: &mut Block,
        with_xor: bool,
    ) {
        // SAFETY: SSE2 is this function's declared feature.
        unsafe { fill_block_blocks::<false>(prev, reference, next, with_xor) }
    }

    /// `fill_block_blocks::<true>` behind a `sse2,ssse3` boundary.
    ///
    /// # Safety
    ///
    /// The CPU must support SSE2 and SSSE3.
    #[target_feature(enable = "sse2,ssse3")]
    unsafe fn fill_block_ssse3(prev: &Block, reference: &Block, next: &mut Block, with_xor: bool) {
        // SAFETY: SSE2 and SSSE3 are this function's declared features.
        unsafe { fill_block_blocks::<true>(prev, reference, next, with_xor) }
    }

    // ------------------------------------------------------------------
    // Equivalence with the scalar backend
    // ------------------------------------------------------------------

    #[test]
    fn sse2_only_fill_block_matches_scalar_over_2048_triples() {
        assert!(
            Backend::Sse2.is_available(),
            "SSE2 is baseline on x86-64 and runtime-checked on x86"
        );
        // SAFETY: SSE2 confirmed available just above.
        unsafe {
            assert_fill_block_matches_scalar(
                "sse2-only",
                fill_block_sse2_only,
                2048,
                0x0123_4567_89AB_CDEF,
            );
        }
    }

    #[test]
    fn ssse3_fill_block_matches_scalar_over_2048_triples() {
        if !super::probe_ssse3() {
            // No SSSE3 on this CPU: the path is unreachable, nothing to check.
            return;
        }
        // SAFETY: `probe_ssse3()` just confirmed SSSE3, and SSE2 is implied.
        unsafe {
            assert_fill_block_matches_scalar(
                "ssse3",
                fill_block_ssse3,
                2048,
                0x0123_4567_89AB_CDEF,
            );
        }
    }

    /// The two spellings of the 128-bit path in `blamka-round-opt.h` must be
    /// interchangeable. Uses a different seed from the scalar comparisons so a
    /// pathological seed cannot hide a difference.
    #[test]
    fn sse2_and_ssse3_paths_agree() {
        if !super::probe_ssse3() {
            return;
        }
        // SAFETY: SSSE3 confirmed; SSE2 is implied by it on any real CPU and is
        // baseline on x86-64.
        unsafe {
            assert_fill_blocks_agree(
                "sse2-only vs ssse3",
                fill_block_sse2_only,
                fill_block_ssse3,
                2048,
                0xDEAD_BEEF_CAFE_F00D,
            );
        }
    }

    /// An all-zero block survives every round, because `fBlaMka(0, 0) == 0`.
    #[test]
    fn all_zero_stays_all_zero() {
        let mut next = Block::ZERO;
        // SAFETY: SSE2 is baseline on x86-64 and checked on x86 by the caller of
        // `fill_segment`; this test only runs on x86 targets.
        unsafe { fill_block_sse2_only(&Block::ZERO, &Block::ZERO, &mut next, false) };
        assert_eq!(next, Block::ZERO);

        if super::probe_ssse3() {
            let mut next = Block::ZERO;
            // SAFETY: SSSE3 confirmed.
            unsafe { fill_block_ssse3(&Block::ZERO, &Block::ZERO, &mut next, false) };
            assert_eq!(next, Block::ZERO);
        }
    }

    /// `ref == next` with `with_xor == false`, the aliasing `next_addresses`
    /// relies on. The old contents must be ignored entirely.
    #[test]
    fn aliasing_ref_and_next_is_safe_and_ignores_the_old_contents() {
        let mut rng = XorShift64Star::new(0xA5A5_5A5A_1234_9876);
        let prev = rng.next_block();
        let reference = rng.next_block();

        // What the scalar backend gets when ref and next are distinct.
        let mut want = Block::ZERO;
        crate::fill_block::scalar::fill_block(&prev, &reference, &mut want, false);

        // Now with next == ref, through raw pointers into one block.
        let mut aliased = reference;
        // SAFETY: SSE2 is available; `fill_block` documents that `ref` and
        // `next` may be the same block when `with_xor == false`.
        unsafe {
            let mut state = [_mm_setzero_si128(); OWORDS_IN_BLOCK];
            let p = prev.as_ptr().cast::<__m128i>();
            for (i, slot) in state.iter_mut().enumerate() {
                *slot = _mm_loadu_si128(p.add(i));
            }
            let ptr = &raw mut aliased;
            fill_block::<false>(&mut state, ptr.cast_const(), ptr, false);
        }
        assert_eq!(aliased, want);
    }

    /// Each of the 128 input words must reach the output; a mistyped column or
    /// row index would leave one inert.
    #[test]
    fn every_input_word_reaches_the_output() {
        let mut rng = XorShift64Star::new(0x1357_9BDF_2468_ACE0);
        let prev = rng.next_block();
        let reference = rng.next_block();

        let base = {
            let mut b = Block::ZERO;
            // SAFETY: SSE2 available.
            unsafe { fill_block_sse2_only(&prev, &reference, &mut b, false) };
            b
        };

        for w in 0..QWORDS_IN_BLOCK {
            let mut flipped_prev = prev;
            flipped_prev.0[w] ^= 1;
            let mut got = Block::ZERO;
            // SAFETY: SSE2 available.
            unsafe { fill_block_sse2_only(&flipped_prev, &reference, &mut got, false) };
            assert_ne!(got, base, "flipping prev word {w} changed nothing");
        }
    }

    // ------------------------------------------------------------------
    // Official vectors, with the backend forced
    // ------------------------------------------------------------------

    /// The three groups must together cover all 26 vectors with no overlap, so
    /// "one `#[test]` per group" really is the full official set.
    #[test]
    fn the_three_groups_partition_the_official_vector_set() {
        assert_eq!(
            group_sizes(),
            [9, 9, 8],
            "test.c has 9 v0x10-Argon2i, 9 v0x13-Argon2i and 8 v0x13-Argon2id vectors"
        );
        assert_eq!(
            group_sizes().iter().sum::<usize>(),
            super::test_support::VECTORS.len()
        );
        assert_eq!(super::test_support::VECTORS.len(), 26);
    }

    #[test]
    fn official_vectors_sse2_forced_v0x10_argon2i() {
        assert!(Backend::Sse2.is_available());
        // SAFETY: `Backend::Sse2.is_available()` asserted immediately above.
        unsafe { check_official_vectors(Backend::Sse2, Group::V0x10Argon2i, false) };
    }

    #[test]
    fn official_vectors_sse2_forced_v0x13_argon2i() {
        assert!(Backend::Sse2.is_available());
        // SAFETY: `Backend::Sse2.is_available()` asserted immediately above.
        unsafe { check_official_vectors(Backend::Sse2, Group::V0x13Argon2i, false) };
    }

    #[test]
    fn official_vectors_sse2_forced_v0x13_argon2id() {
        assert!(Backend::Sse2.is_available());
        // SAFETY: `Backend::Sse2.is_available()` asserted immediately above.
        unsafe { check_official_vectors(Backend::Sse2, Group::V0x13Argon2id, false) };
    }

    #[test]
    #[ignore = "TEST_LARGE_RAM: 1 GiB arena"]
    fn official_vectors_with_the_sse2_backend_forced_including_large_ram() {
        assert!(Backend::Sse2.is_available());
        // SAFETY: `Backend::Sse2.is_available()` asserted immediately above.
        unsafe { check_official_vectors(Backend::Sse2, Group::All, true) };
    }

    /// The SSE2-only variant, which `Backend` cannot name, over the cheap half
    /// of the official vector set.
    #[test]
    fn official_vectors_with_the_sse2_only_path_forced() {
        // SAFETY: SSE2 is baseline on x86-64 and this test only builds there or
        // on x86, where the harness would not run without it.
        unsafe {
            check_official_vectors_with_fill_fn("sse2-only", fill_segment_sse2_only);
        }
    }

    /// The SSSE3 variant, likewise.
    #[test]
    fn official_vectors_with_the_ssse3_path_forced() {
        if !super::probe_ssse3() {
            return;
        }
        // SAFETY: `probe_ssse3()` confirmed SSSE3.
        unsafe {
            check_official_vectors_with_fill_fn("ssse3", fill_segment_ssse3);
        }
    }

    // ------------------------------------------------------------------
    // Dispatch
    // ------------------------------------------------------------------

    /// Detection must pick SSE2 exactly when the CPU has SSE2 and neither of
    /// the wider backends, and `fill_segment_fn` must hand back this module's
    /// entry point.
    #[test]
    fn detection_selects_sse2_only_when_nothing_wider_is_available() {
        // These tests only compile on x86/x86-64, where SSE2 is either baseline
        // (x86-64) or runtime-detected (x86).
        assert_eq!(
            Backend::Sse2.is_available(),
            super::probe_sse2_for_test(),
            "is_available() must agree with a direct probe"
        );

        let wider = Backend::Avx2.is_available() || Backend::Avx512.is_available();
        if Backend::Sse2.is_available() && !wider {
            assert_eq!(
                detect(),
                Backend::Sse2,
                "SSE2 present and nothing wider, so SSE2 must win"
            );
            assert_eq!(
                backend(),
                Backend::Sse2,
                "the cache must agree with detect()"
            );
        } else if !Backend::Sse2.is_available() {
            assert_ne!(
                detect(),
                Backend::Sse2,
                "SSE2 absent, so it must never be selected"
            );
        }
    }

    #[test]
    fn dispatch_resolves_to_this_module() {
        let f = fill_segment_fn(Backend::Sse2);
        assert!(
            core::ptr::fn_addr_eq(f, fill_segment as unsafe fn(&Instance, Position)),
            "fill_segment_fn(Sse2) must be sse2::fill_segment"
        );
        // And it must not be the scalar fallback.
        assert!(!core::ptr::fn_addr_eq(
            f,
            crate::fill_block::scalar::fill_segment as unsafe fn(&Instance, Position)
        ));
    }

    // ------------------------------------------------------------------
    // The cached SSSE3 probe
    // ------------------------------------------------------------------

    #[test]
    fn ssse3_cache_agrees_with_the_probe_and_is_stable() {
        let first = have_ssse3();
        assert_eq!(first, super::probe_ssse3());
        // Second call takes the cached path.
        assert_eq!(have_ssse3(), first);
        assert_ne!(SSSE3_CACHE.load(Ordering::Relaxed), SSSE3_UNKNOWN);
        assert_eq!(SSSE3_CACHE.load(Ordering::Relaxed), u8::from(first));
    }

    /// A garbage byte in the cache must re-probe, never be read as a boolean.
    #[test]
    fn ssse3_cache_recovers_from_an_unknown_byte() {
        let truth = super::probe_ssse3();
        SSSE3_CACHE.store(SSSE3_UNKNOWN, Ordering::Relaxed);
        assert_eq!(have_ssse3(), truth);
        SSSE3_CACHE.store(0xAB, Ordering::Relaxed);
        assert_eq!(have_ssse3(), truth);
        assert_eq!(SSSE3_CACHE.load(Ordering::Relaxed), u8::from(truth));
    }

    // ------------------------------------------------------------------
    // Rotation tables
    // ------------------------------------------------------------------

    /// `R16` and `R24` must really be byte rotations, and the SSSE3 and SSE2
    /// rotations must agree with `u64::rotate_right`.
    #[test]
    fn rotations_match_scalar_rotate_right() {
        for j in 0..8 {
            assert_eq!(R24[j], ((j + 3) % 8) as u8, "R24 low half at {j}");
            assert_eq!(
                R24[j + 8],
                (((j + 3) % 8) + 8) as u8,
                "R24 high half at {j}"
            );
            assert_eq!(R16[j], ((j + 2) % 8) as u8, "R16 low half at {j}");
            assert_eq!(
                R16[j + 8],
                (((j + 2) % 8) + 8) as u8,
                "R16 high half at {j}"
            );
        }

        let mut rng = XorShift64Star::new(0xFEED_FACE_DEAD_BEEF);
        for _ in 0..256 {
            let lo = rng.next_u64();
            let hi = rng.next_u64();
            // SAFETY: `_mm_set_epi64x` and the SSE2 rotations need only SSE2;
            // the SSSE3 ones are guarded by `probe_ssse3()`.
            unsafe {
                let x = _mm_set_epi64x(hi as i64, lo as i64);
                let mut out = [0u64; 2];

                for (n, sse2, ssse3) in [
                    (32u32, rot32::<false>(x), rot32::<true>(x)),
                    (24, rot24::<false>(x), rot24::<true>(x)),
                    (16, rot16::<false>(x), rot16::<true>(x)),
                    (63, rot63::<false>(x), rot63::<true>(x)),
                ] {
                    _mm_storeu_si128(out.as_mut_ptr().cast(), sse2);
                    assert_eq!(out, [lo.rotate_right(n), hi.rotate_right(n)], "sse2 rot{n}");
                    if super::probe_ssse3() {
                        _mm_storeu_si128(out.as_mut_ptr().cast(), ssse3);
                        assert_eq!(
                            out,
                            [lo.rotate_right(n), hi.rotate_right(n)],
                            "ssse3 rot{n}"
                        );
                    }
                }
            }
        }
    }

    /// `f_blamka` must equal the scalar `f_blamka` in both lanes.
    #[test]
    fn f_blamka_matches_the_scalar_reference() {
        let mut rng = XorShift64Star::new(0x0BAD_C0DE_0BAD_C0DE);
        for _ in 0..512 {
            let (x0, x1) = (rng.next_u64(), rng.next_u64());
            let (y0, y1) = (rng.next_u64(), rng.next_u64());
            // SAFETY: SSE2 only.
            unsafe {
                let r = f_blamka(
                    _mm_set_epi64x(x1 as i64, x0 as i64),
                    _mm_set_epi64x(y1 as i64, y0 as i64),
                );
                let mut out = [0u64; 2];
                _mm_storeu_si128(out.as_mut_ptr().cast(), r);
                assert_eq!(
                    out,
                    [
                        crate::fill_block::scalar::f_blamka(x0, y0),
                        crate::fill_block::scalar::f_blamka(x1, y1),
                    ]
                );
            }
        }
    }

    /// `diagonalize` then `undiagonalize` must be the identity, in both
    /// spellings, and the two spellings must produce the same permutation.
    #[test]
    fn diagonalize_round_trips_and_both_spellings_agree() {
        let mut rng = XorShift64Star::new(0x5EED_5EED_5EED_5EED);
        for _ in 0..256 {
            let mut words = [0u64; 6];
            for w in &mut words {
                *w = rng.next_u64();
            }
            // SAFETY: the `false` instantiations are SSE2-only; the `true` ones
            // are guarded by `probe_ssse3()`.
            unsafe {
                let load = |i: usize| _mm_set_epi64x(words[i] as i64, words[i] as i64 ^ 1);
                let dump = |v: __m128i| {
                    let mut o = [0u64; 2];
                    _mm_storeu_si128(o.as_mut_ptr().cast(), v);
                    o
                };

                let (mut b0, mut b1) = (load(0), load(1));
                let (mut c0, mut c1) = (load(2), load(3));
                let (mut d0, mut d1) = (load(4), load(5));
                let original = [b0, b1, c0, c1, d0, d1].map(dump);

                diagonalize::<false>(&mut b0, &mut b1, &mut c0, &mut c1, &mut d0, &mut d1);
                let after_sse2 = [b0, b1, c0, c1, d0, d1].map(dump);
                undiagonalize::<false>(&mut b0, &mut b1, &mut c0, &mut c1, &mut d0, &mut d1);
                assert_eq!(
                    [b0, b1, c0, c1, d0, d1].map(dump),
                    original,
                    "sse2 round trip"
                );

                if super::probe_ssse3() {
                    diagonalize::<true>(&mut b0, &mut b1, &mut c0, &mut c1, &mut d0, &mut d1);
                    assert_eq!(
                        [b0, b1, c0, c1, d0, d1].map(dump),
                        after_sse2,
                        "the two DIAGONALIZE spellings must agree"
                    );
                    undiagonalize::<true>(&mut b0, &mut b1, &mut c0, &mut c1, &mut d0, &mut d1);
                    assert_eq!(
                        [b0, b1, c0, c1, d0, d1].map(dump),
                        original,
                        "ssse3 round trip"
                    );
                }
            }
        }
    }
}

/// A direct SSE2 probe for the dispatch test, mirroring `mod.rs`'s `have_sse2`.
#[cfg(test)]
fn probe_sse2_for_test() -> bool {
    #[cfg(feature = "std")]
    {
        std::arch::is_x86_feature_detected!("sse2")
    }
    #[cfg(not(feature = "std"))]
    {
        cfg!(target_feature = "sse2")
    }
}

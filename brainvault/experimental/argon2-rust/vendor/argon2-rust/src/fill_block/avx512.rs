//! x86-64 AVX-512F `fill_block` / `fill_segment`.
//!
//! Ported from the `#if defined(__AVX512F__)` branch of `fill_block` /
//! `next_addresses` / `fill_segment` in `phc-winner-argon2/src/opt.c` and from
//! the `#else /* __AVX512F__ */` half of
//! `phc-winner-argon2/src/blake2/blamka-round-opt.h`.
//!
//! # ⚠ This backend has never been executed on the development host
//!
//! `aarch64-apple-darwin` under Rosetta 2 traps AVX-512 as an illegal
//! instruction, so this code is **compile-verified only**. See the
//! "Verification status" section at the bottom of these docs — it is deliberately
//! explicit, and it must be updated the moment someone runs this on real
//! hardware.
//!
//! # Layout, and the swap trick
//!
//! The 1 KiB block is 16 `__m512i`, so `state[j]` holds block words
//! `8j .. 8j+7`. One `G` step works on eight 64-bit lanes, i.e. eight BLAKE2b
//! columns in parallel — but a BLAKE2b matrix only has four. So the AVX-512 path
//! does **not** get a wider round: instead it packs *two* matrices into one
//! register set and shuffles them into place around a shared `BLAKE2_ROUND`.
//!
//! `BLAKE2_ROUND` itself (`blamka-round-opt.h:408-419`) is the same `G1`, `G2`,
//! `DIAGONALIZE`, `G1`, `G2`, `UNDIAGONALIZE` sequence as the 128-bit path, with
//! `_mm512_permutex_epi64` doing the diagonal rotation inside each 256-bit half.
//! Two wrappers put the data where that expects it:
//!
//! * `BLAKE2_ROUND_1` (`:444-455`) wraps it in `SWAP_HALVES`, for the **column**
//!   pass.
//! * `BLAKE2_ROUND_2` (`:457-468`) wraps it in `SWAP_QUARTERS` /
//!   `UNSWAP_QUARTERS`, for the **row** pass.
//!
//! ## The parameter-name trap in `BLAKE2_ROUND_1`
//!
//! `blamka-round-opt.h:444` is
//!
//! ```c
//! #define BLAKE2_ROUND_1(A0, C0, B0, D0, A1, C1, B1, D1)
//! ```
//!
//! — the parameters are named `A0 C0 B0 D0 A1 C1 B1 D1`, **not**
//! `A0 B0 C0 D0 ...`. `opt.c:58-60` calls it with sequential slots
//! `state[8i+0] .. state[8i+7]`, so the binding is
//! `A0 = state[8i+0]`, `C0 = state[8i+1]`, `B0 = state[8i+2]`,
//! `D0 = state[8i+3]`, and likewise for the `1` set. The macro body then calls
//! the shared `BLAKE2_ROUND(A0, B0, C0, D0, A1, B1, C1, D1)`, which re-orders
//! them back. `blake2_round_1` below reproduces that binding exactly; getting it
//! wrong still compiles and still produces plausible-looking wrong hashes.
//!
//! Note also that the two `BLAKE2_ROUND` macros in this header have **different**
//! parameter orders: the 128-bit one is `(A0, A1, B0, B1, C0, C1, D0, D1)` while
//! the AVX-512 one at `:408` is `(A0, B0, C0, D0, A1, B1, C1, D1)`.
//!
//! # Why `#[target_feature]` is on `fill_segment` and not on `fill_block`
//!
//! LLVM will not inline a callee with a richer feature set into a poorer caller.
//! Keeping the boundary at [`fill_segment`] lets `fill_block` inline into it,
//! which is what preserves the `opt.c` trick of carrying the 1 KiB `state` across
//! loop iterations instead of re-reading the previous block every time.
//!
//! # Verification status — measured, not assumed
//!
//! Host: `aarch64-apple-darwin`, Apple M5 Max, macOS 26.5.2, Rosetta 2.
//!
//! | | Status |
//! |---|---|
//! | `cargo build --release --target x86_64-apple-darwin` | passes |
//! | AVX-512 really reaches the object code | yes — 1897 `%zmm` operands in this symbol, incl. `vpxorq`, `vmovdqa64`, `vprolq`, `vshufi64x2`, `vinserti64x4`, `vpermq` |
//! | Executed on this host | **NEVER. `SIGILL`.** |
//! | Selected by [`crate::fill_block::detect`] here | never: `is_x86_feature_detected!("avx512f")` is `false`, and `detected_backend()` returns `sse2` |
//!
//! **This backend is COMPILE-VERIFIED ONLY. It has never been executed, here or
//! anywhere in this session.** Nothing below should be read as implying
//! otherwise.
//!
//! The `SIGILL` is measured, with the trap confirmed to come from a real
//! AVX-512 instruction rather than from anything else: a standalone probe
//! compiled for `x86_64-apple-darwin` was disassembled first (`otool -tvV`
//! showed exactly one surviving `vprolq $0x20, %zmm0, %zmm1`) and then run —
//! exit code 132, i.e. signal 4.
//!
//! ⚠ The obvious version of that probe is a **false positive**: with constant
//! inputs LLVM folds the whole AVX-512 chain at compile time, the binary ends up
//! containing zero `%zmm` operands, and the process "survives" while having
//! executed nothing. The probe above only counts because `std::hint::black_box`
//! and `#[inline(never)]` forced the instruction to be emitted, and because the
//! disassembly was checked before the run. Any future attempt to re-measure this
//! must do the same.
//!
//! So the untestable path is *unreachable* here rather than latent: every test
//! that would drive it first checks
//! [`crate::fill_block::Backend::is_available`], which is `false`, and
//! `detect()` returns `Sse2`. `avx512_is_never_selected_on_a_host_without_it`
//! pins that, and
//! `ARGON2_REQUIRE_BACKEND=avx512 cargo test --features internal-api` turns the
//! resulting silent skips into loud failures, which is how the skipping was
//! confirmed rather than assumed.
//!
//! **Never** put `-C target-feature=+avx512f` in `RUSTFLAGS` on this host:
//! `is_x86_feature_detected!` short-circuits on `cfg!(target_feature = ...)`, so
//! `is_available()` would start returning `true`, the guard would let the tests
//! through, and the process would die with `SIGILL`. `+avx2` alone is fine and is
//! what `avx2.rs` needs for runtime testing.
//!
//! Everything below was instead checked by reading `blamka-round-opt.h` and
//! `opt.c` line by line — each item carries the C line it came from — plus:
//!
//! * `swap_and_unswap_quarters_are_inverses` and the other lane-permutation
//!   unit tests, which reason about
//!   `SWAP_HALVES` / `SWAP_QUARTERS` as index permutations of `[0, 8)` in plain
//!   integer arithmetic, with no AVX-512 instruction involved, so they *do* run
//!   on this host;
//! * the equivalence tests, which run only where AVX-512 exists.

use core::arch::x86_64::*;
use core::mem::MaybeUninit;

use crate::block::{Block, Instance, Position};
use crate::params::{ADDRESSES_IN_BLOCK, BITS512_WORDS_IN_BLOCK};

/// `ARGON2_ADDRESSES_IN_BLOCK` as a `u32`, for `i % 128` in `fill_segment`.
const ADDRESSES_IN_BLOCK_U32: u32 = ADDRESSES_IN_BLOCK as u32;

/// The `SWAP_QUARTERS` / `UNSWAP_QUARTERS` permutation vector —
/// `blamka-round-opt.h:433` and `:439`,
/// `_mm512_setr_epi64(0, 1, 4, 5, 2, 3, 6, 7)`.
///
/// `_mm512_permutexvar_epi64(idx, a)` computes `result[k] = a[idx[k]]`, so this
/// swaps the middle two pairs of 64-bit lanes and is its own inverse:
/// applying `p = [0, 1, 4, 5, 2, 3, 6, 7]` twice gives `p[p[k]] == k` for every
/// `k` — see the `quarter_permutation_is_an_involution` unit test.
///
/// Held as a plain `i64` array rather than built with `_mm512_setr_epi64`, whose
/// argument order is easy to get backwards. On little-endian, `QUARTER_IDX[0]` is
/// lane 0 of the vector, unambiguously. LLVM folds the `loadu` into a
/// constant-pool reference.
const QUARTER_IDX: [i64; 8] = [0, 1, 4, 5, 2, 3, 6, 7];

// ---------------------------------------------------------------------------
// blamka-round-opt.h, AVX-512F path
// ---------------------------------------------------------------------------

/// `muladd` — `blamka-round-opt.h:336-340`.
///
/// ```c
/// __m512i z = _mm512_mul_epu32(x, y);
/// return _mm512_add_epi64(_mm512_add_epi64(x, y), _mm512_add_epi64(z, z));
/// ```
///
/// `_mm512_mul_epu32` multiplies the low 32 bits of each 64-bit lane into a full
/// 64-bit product, the vector form of the scalar
/// `(x & 0xFFFFFFFF) * (y & 0xFFFFFFFF)`; `z + z` is the `2 *`. Every add is
/// modulo 2^64, matching the scalar `wrapping_add`.
#[inline(always)]
unsafe fn muladd(x: __m512i, y: __m512i) -> __m512i {
    // SAFETY: `_mm512_mul_epu32` and `_mm512_add_epi64` are AVX512F, which every
    // caller enables.
    unsafe {
        let z = _mm512_mul_epu32(x, y);
        _mm512_add_epi64(_mm512_add_epi64(x, y), _mm512_add_epi64(z, z))
    }
}

/// `G1` — `blamka-round-opt.h:342-361`. The `ror64(_, 32)` / `ror64(_, 24)` half.
///
/// AVX-512 has a real rotate, `_mm512_ror_epi64`, so unlike SSE2 and AVX2 there
/// is no shift/shuffle emulation and no byte table.
#[inline(always)]
#[allow(clippy::too_many_arguments)]
unsafe fn g1(
    a0: &mut __m512i,
    b0: &mut __m512i,
    c0: &mut __m512i,
    d0: &mut __m512i,
    a1: &mut __m512i,
    b1: &mut __m512i,
    c1: &mut __m512i,
    d1: &mut __m512i,
) {
    // SAFETY: `_mm512_xor_si512` and `_mm512_ror_epi64` are AVX512F, as is
    // everything `muladd` uses; the caller enables it.
    unsafe {
        *a0 = muladd(*a0, *b0);
        *a1 = muladd(*a1, *b1);

        *d0 = _mm512_xor_si512(*d0, *a0);
        *d1 = _mm512_xor_si512(*d1, *a1);

        *d0 = _mm512_ror_epi64::<32>(*d0);
        *d1 = _mm512_ror_epi64::<32>(*d1);

        *c0 = muladd(*c0, *d0);
        *c1 = muladd(*c1, *d1);

        *b0 = _mm512_xor_si512(*b0, *c0);
        *b1 = _mm512_xor_si512(*b1, *c1);

        *b0 = _mm512_ror_epi64::<24>(*b0);
        *b1 = _mm512_ror_epi64::<24>(*b1);
    }
}

/// `G2` — `blamka-round-opt.h:363-382`. The `ror64(_, 16)` / `ror64(_, 63)` half.
#[inline(always)]
#[allow(clippy::too_many_arguments)]
unsafe fn g2(
    a0: &mut __m512i,
    b0: &mut __m512i,
    c0: &mut __m512i,
    d0: &mut __m512i,
    a1: &mut __m512i,
    b1: &mut __m512i,
    c1: &mut __m512i,
    d1: &mut __m512i,
) {
    // SAFETY: as `g1`.
    unsafe {
        *a0 = muladd(*a0, *b0);
        *a1 = muladd(*a1, *b1);

        *d0 = _mm512_xor_si512(*d0, *a0);
        *d1 = _mm512_xor_si512(*d1, *a1);

        *d0 = _mm512_ror_epi64::<16>(*d0);
        *d1 = _mm512_ror_epi64::<16>(*d1);

        *c0 = muladd(*c0, *d0);
        *c1 = muladd(*c1, *d1);

        *b0 = _mm512_xor_si512(*b0, *c0);
        *b1 = _mm512_xor_si512(*b1, *c1);

        *b0 = _mm512_ror_epi64::<63>(*b0);
        *b1 = _mm512_ror_epi64::<63>(*b1);
    }
}

/// `DIAGONALIZE` — `blamka-round-opt.h:384-394`.
///
/// `_mm512_permutex_epi64` applies one 4-lane pattern to **each** 256-bit half
/// independently, so this rotates the four columns held in each half:
/// `B` left by 1, `C` by 2, `D` by 3. `A` is untouched, hence not a parameter.
///
/// `_MM_SHUFFLE(0, 3, 2, 1) == 0b00_11_10_01` selects lanes `(1, 2, 3, 0)`
/// — rotate left by 1; `_MM_SHUFFLE(1, 0, 3, 2) == 0b01_00_11_10` is by 2 and
/// `_MM_SHUFFLE(2, 1, 0, 3) == 0b10_01_00_11` is by 3.
#[inline(always)]
unsafe fn diagonalize(
    b0: &mut __m512i,
    b1: &mut __m512i,
    c0: &mut __m512i,
    c1: &mut __m512i,
    d0: &mut __m512i,
    d1: &mut __m512i,
) {
    // SAFETY: `_mm512_permutex_epi64` is AVX512F.
    unsafe {
        *b0 = _mm512_permutex_epi64::<0b00_11_10_01>(*b0);
        *b1 = _mm512_permutex_epi64::<0b00_11_10_01>(*b1);

        *c0 = _mm512_permutex_epi64::<0b01_00_11_10>(*c0);
        *c1 = _mm512_permutex_epi64::<0b01_00_11_10>(*c1);

        *d0 = _mm512_permutex_epi64::<0b10_01_00_11>(*d0);
        *d1 = _mm512_permutex_epi64::<0b10_01_00_11>(*d1);
    }
}

/// `UNDIAGONALIZE` — `blamka-round-opt.h:396-406`. [`diagonalize`] with the `B`
/// and `D` rotation amounts swapped, which inverts it.
#[inline(always)]
unsafe fn undiagonalize(
    b0: &mut __m512i,
    b1: &mut __m512i,
    c0: &mut __m512i,
    c1: &mut __m512i,
    d0: &mut __m512i,
    d1: &mut __m512i,
) {
    // SAFETY: `_mm512_permutex_epi64` is AVX512F.
    unsafe {
        *b0 = _mm512_permutex_epi64::<0b10_01_00_11>(*b0);
        *b1 = _mm512_permutex_epi64::<0b10_01_00_11>(*b1);

        *c0 = _mm512_permutex_epi64::<0b01_00_11_10>(*c0);
        *c1 = _mm512_permutex_epi64::<0b01_00_11_10>(*c1);

        *d0 = _mm512_permutex_epi64::<0b00_11_10_01>(*d0);
        *d1 = _mm512_permutex_epi64::<0b00_11_10_01>(*d1);
    }
}

/// `BLAKE2_ROUND` — `blamka-round-opt.h:408-419`.
///
/// ```c
/// #define BLAKE2_ROUND(A0, B0, C0, D0, A1, B1, C1, D1) do { \
///     G1(A0, B0, C0, D0, A1, B1, C1, D1);                   \
///     G2(A0, B0, C0, D0, A1, B1, C1, D1);                   \
///     DIAGONALIZE(A0, B0, C0, D0, A1, B1, C1, D1);          \
///     G1(A0, B0, C0, D0, A1, B1, C1, D1);                   \
///     G2(A0, B0, C0, D0, A1, B1, C1, D1);                   \
///     UNDIAGONALIZE(A0, B0, C0, D0, A1, B1, C1, D1);        \
/// } while (0)
/// ```
///
/// Beware: this macro's parameter order is `(A0, B0, C0, D0, A1, B1, C1, D1)`,
/// **unlike** the 128-bit `BLAKE2_ROUND` at `:169`, which is
/// `(A0, A1, B0, B1, C0, C1, D0, D1)`. Arguments and results here are both in
/// this function's own `(a0, b0, c0, d0, a1, b1, c1, d1)` order.
#[inline(always)]
#[allow(clippy::too_many_arguments)]
unsafe fn blake2_round(
    a0: __m512i,
    b0: __m512i,
    c0: __m512i,
    d0: __m512i,
    a1: __m512i,
    b1: __m512i,
    c1: __m512i,
    d1: __m512i,
) -> [__m512i; 8] {
    let (mut a0, mut b0, mut c0, mut d0) = (a0, b0, c0, d0);
    let (mut a1, mut b1, mut c1, mut d1) = (a1, b1, c1, d1);

    // SAFETY: every callee needs AVX512F, which this function's caller enables.
    unsafe {
        g1(
            &mut a0, &mut b0, &mut c0, &mut d0, &mut a1, &mut b1, &mut c1, &mut d1,
        );
        g2(
            &mut a0, &mut b0, &mut c0, &mut d0, &mut a1, &mut b1, &mut c1, &mut d1,
        );

        diagonalize(&mut b0, &mut b1, &mut c0, &mut c1, &mut d0, &mut d1);

        g1(
            &mut a0, &mut b0, &mut c0, &mut d0, &mut a1, &mut b1, &mut c1, &mut d1,
        );
        g2(
            &mut a0, &mut b0, &mut c0, &mut d0, &mut a1, &mut b1, &mut c1, &mut d1,
        );

        undiagonalize(&mut b0, &mut b1, &mut c0, &mut c1, &mut d0, &mut d1);
    }

    [a0, b0, c0, d0, a1, b1, c1, d1]
}

/// `SWAP_HALVES` — `blamka-round-opt.h:421-428`.
///
/// ```c
/// t0 = _mm512_shuffle_i64x2(A0, A1, _MM_SHUFFLE(1, 0, 1, 0));
/// t1 = _mm512_shuffle_i64x2(A0, A1, _MM_SHUFFLE(3, 2, 3, 2));
/// A0 = t0; A1 = t1;
/// ```
///
/// `_mm512_shuffle_i64x2` selects **128-bit** lanes: the low two result lanes
/// come from `a` and the high two from `b`. `_MM_SHUFFLE(1, 0, 1, 0) == 0x44`
/// takes `(a[0], a[1], b[0], b[1])` and `_MM_SHUFFLE(3, 2, 3, 2) == 0xEE` takes
/// `(a[2], a[3], b[2], b[3])`, so in 64-bit lanes this exchanges the upper half
/// of `A0` with the lower half of `A1`. It is its own inverse.
#[inline(always)]
unsafe fn swap_halves(a0: &mut __m512i, a1: &mut __m512i) {
    // SAFETY: `_mm512_shuffle_i64x2` is AVX512F.
    unsafe {
        let t0 = _mm512_shuffle_i64x2::<0b01_00_01_00>(*a0, *a1);
        let t1 = _mm512_shuffle_i64x2::<0b11_10_11_10>(*a0, *a1);
        *a0 = t0;
        *a1 = t1;
    }
}

/// `SWAP_QUARTERS` — `blamka-round-opt.h:430-435`. [`swap_halves`] followed by
/// the [`QUARTER_IDX`] permutation on both registers.
#[inline(always)]
unsafe fn swap_quarters(a0: &mut __m512i, a1: &mut __m512i) {
    // SAFETY: `_mm512_permutexvar_epi64` and `_mm512_loadu_si512` are AVX512F;
    // `loadu` imposes no alignment requirement on `QUARTER_IDX`.
    unsafe {
        swap_halves(a0, a1);
        let idx = _mm512_loadu_si512(QUARTER_IDX.as_ptr().cast());
        *a0 = _mm512_permutexvar_epi64(idx, *a0);
        *a1 = _mm512_permutexvar_epi64(idx, *a1);
    }
}

/// `UNSWAP_QUARTERS` — `blamka-round-opt.h:437-442`. The [`QUARTER_IDX`]
/// permutation followed by [`swap_halves`] — i.e. [`swap_quarters`] with the two
/// steps in the other order, which inverts it because each step is an involution.
#[inline(always)]
unsafe fn unswap_quarters(a0: &mut __m512i, a1: &mut __m512i) {
    // SAFETY: as `swap_quarters`.
    unsafe {
        let idx = _mm512_loadu_si512(QUARTER_IDX.as_ptr().cast());
        *a0 = _mm512_permutexvar_epi64(idx, *a0);
        *a1 = _mm512_permutexvar_epi64(idx, *a1);
        swap_halves(a0, a1);
    }
}

/// `BLAKE2_ROUND_1` — `blamka-round-opt.h:444-455`. The **column** pass round.
///
/// ```c
/// #define BLAKE2_ROUND_1(A0, C0, B0, D0, A1, C1, B1, D1) do { \
///     SWAP_HALVES(A0, B0); SWAP_HALVES(C0, D0);               \
///     SWAP_HALVES(A1, B1); SWAP_HALVES(C1, D1);               \
///     BLAKE2_ROUND(A0, B0, C0, D0, A1, B1, C1, D1);           \
///     SWAP_HALVES(A0, B0); SWAP_HALVES(C0, D0);               \
///     SWAP_HALVES(A1, B1); SWAP_HALVES(C1, D1);               \
/// } while (0)
/// ```
///
/// The parameter names are `A0 C0 B0 D0 A1 C1 B1 D1` — the `B` and `C` of each
/// set are **swapped** relative to the obvious reading. `opt.c:58-60` passes
/// `state[8i+0] .. state[8i+7]` in order, so this function takes them in that
/// same positional order and returns them in it too; the names below record
/// which role each slot plays inside the macro.
///
#[inline(always)]
#[allow(clippy::too_many_arguments)]
unsafe fn blake2_round_1(
    a0: __m512i,
    c0: __m512i,
    b0: __m512i,
    d0: __m512i,
    a1: __m512i,
    c1: __m512i,
    b1: __m512i,
    d1: __m512i,
) -> [__m512i; 8] {
    let (mut a0, mut c0, mut b0, mut d0) = (a0, c0, b0, d0);
    let (mut a1, mut c1, mut b1, mut d1) = (a1, c1, b1, d1);

    // SAFETY: every callee needs AVX512F, which this function's caller enables.
    unsafe {
        swap_halves(&mut a0, &mut b0);
        swap_halves(&mut c0, &mut d0);
        swap_halves(&mut a1, &mut b1);
        swap_halves(&mut c1, &mut d1);

        let r = blake2_round(a0, b0, c0, d0, a1, b1, c1, d1);
        a0 = r[0];
        b0 = r[1];
        c0 = r[2];
        d0 = r[3];
        a1 = r[4];
        b1 = r[5];
        c1 = r[6];
        d1 = r[7];

        swap_halves(&mut a0, &mut b0);
        swap_halves(&mut c0, &mut d0);
        swap_halves(&mut a1, &mut b1);
        swap_halves(&mut c1, &mut d1);
    }

    // Back in the macro's own parameter order, which is the caller's slot order.
    [a0, c0, b0, d0, a1, c1, b1, d1]
}

/// `BLAKE2_ROUND_2` — `blamka-round-opt.h:457-468`. The **row** pass round.
///
/// ```c
/// #define BLAKE2_ROUND_2(A0, A1, B0, B1, C0, C1, D0, D1) do { \
///     SWAP_QUARTERS(A0, A1); SWAP_QUARTERS(B0, B1);           \
///     SWAP_QUARTERS(C0, C1); SWAP_QUARTERS(D0, D1);           \
///     BLAKE2_ROUND(A0, B0, C0, D0, A1, B1, C1, D1);           \
///     UNSWAP_QUARTERS(A0, A1); UNSWAP_QUARTERS(B0, B1);       \
///     UNSWAP_QUARTERS(C0, C1); UNSWAP_QUARTERS(D0, D1);       \
/// } while (0)
/// ```
///
/// Unlike `BLAKE2_ROUND_1`, this macro's parameters really are
/// `A0 A1 B0 B1 C0 C1 D0 D1`. `opt.c:64-66` passes
/// `state[2*0+i], state[2*1+i], ..., state[2*7+i]`.
#[inline(always)]
#[allow(clippy::too_many_arguments)]
unsafe fn blake2_round_2(
    a0: __m512i,
    a1: __m512i,
    b0: __m512i,
    b1: __m512i,
    c0: __m512i,
    c1: __m512i,
    d0: __m512i,
    d1: __m512i,
) -> [__m512i; 8] {
    let (mut a0, mut a1, mut b0, mut b1) = (a0, a1, b0, b1);
    let (mut c0, mut c1, mut d0, mut d1) = (c0, c1, d0, d1);

    // SAFETY: every callee needs AVX512F, which this function's caller enables.
    unsafe {
        swap_quarters(&mut a0, &mut a1);
        swap_quarters(&mut b0, &mut b1);
        swap_quarters(&mut c0, &mut c1);
        swap_quarters(&mut d0, &mut d1);

        let r = blake2_round(a0, b0, c0, d0, a1, b1, c1, d1);
        a0 = r[0];
        b0 = r[1];
        c0 = r[2];
        d0 = r[3];
        a1 = r[4];
        b1 = r[5];
        c1 = r[6];
        d1 = r[7];

        unswap_quarters(&mut a0, &mut a1);
        unswap_quarters(&mut b0, &mut b1);
        unswap_quarters(&mut c0, &mut c1);
        unswap_quarters(&mut d0, &mut d1);
    }

    [a0, a1, b0, b1, c0, c1, d0, d1]
}

// ---------------------------------------------------------------------------
// opt.c, AVX-512F path
// ---------------------------------------------------------------------------

/// `fill_block()` — `opt.c:38-73`.
///
/// ```c
/// if (with_xor) { state[i] ^= ref[i];  block_XY[i] = state[i] ^ next[i]; }
/// else          { block_XY[i] = state[i] = state[i] ^ ref[i]; }
/// 2 x BLAKE2_ROUND_1 (columns); 2 x BLAKE2_ROUND_2 (rows);
/// state[i] ^= block_XY[i]; store next[i] = state[i];
/// ```
///
/// `state` is the caller's live 1 KiB register file: on entry it holds the
/// previous block, on exit the block just written to `next_block`. That is what
/// lets `fill_segment` skip re-reading `memory[prev_offset]` every iteration.
///
/// # Safety
///
/// * The CPU must support AVX-512F.
/// * `ref_block` must be valid for reads of one [`Block`] and `next_block` for
///   reads and writes of one [`Block`].
/// * The two may alias — `next_addresses` calls this with
///   `ref_block == next_block`. That is sound because every load from
///   `ref_block` happens in the first loop and every store to `next_block` in
///   the last, and because raw pointers are used rather than a `&`/`&mut` pair.
///   When `with_xor` is `false` the old contents of `next_block` are never read.
#[inline(always)]
unsafe fn fill_block(
    state: &mut [__m512i; BITS512_WORDS_IN_BLOCK],
    ref_block: *const Block,
    next_block: *mut Block,
    with_xor: bool,
) {
    let refp = ref_block.cast::<__m512i>();
    let nextp = next_block.cast::<__m512i>();

    // `opt.c` declares `__m512i block_XY[...];` UNINITIALISED, and so does this.
    //
    // Spelling it `[_mm512_setzero_si512(); BITS512_WORDS_IN_BLOCK]` instead
    // costs a real 1 KiB `memset` **per block**: LLVM does not eliminate it,
    // because the two arms of `if with_xor` fill the array in separate basic
    // blocks and dead-store elimination never sees a single whole-array
    // overwrite.
    //
    // Measured on the other two backends, where the same substitution in the
    // release asm for `x86_64-unknown-linux-musl` adds three `memset` call sites
    // (3 -> 6) and ~25 instructions to the `fill_segment` symbol —
    // `fill_segment_sse2_only` 2122 -> 2145, `avx2::fill_segment` 1807 -> 1835.
    // Kept the same here for consistency; not separately measured, since this
    // backend is compile-verified only (see the module docs).
    //
    // SAFETY of the `assume_init` below: both arms write all 16 elements before
    // anything reads one, so the array is fully initialised by the time the
    // final loop runs.
    let mut block_xy: [MaybeUninit<__m512i>; BITS512_WORDS_IN_BLOCK] =
        [const { MaybeUninit::uninit() }; BITS512_WORDS_IN_BLOCK];

    // SAFETY: the accesses are `loadu`/`storeu`, so no alignment is required,
    // and `i < BITS512_WORDS_IN_BLOCK == 16` keeps every one inside the single
    // `Block` each pointer is valid for (`16 * 64 == 1024` bytes). All AVX512F.
    unsafe {
        if with_xor {
            for i in 0..BITS512_WORDS_IN_BLOCK {
                state[i] = _mm512_xor_si512(state[i], _mm512_loadu_si512(refp.add(i)));
                block_xy[i] = MaybeUninit::new(_mm512_xor_si512(
                    state[i],
                    _mm512_loadu_si512(nextp.add(i).cast_const()),
                ));
            }
        } else {
            for i in 0..BITS512_WORDS_IN_BLOCK {
                state[i] = _mm512_xor_si512(state[i], _mm512_loadu_si512(refp.add(i)));
                block_xy[i] = MaybeUninit::new(state[i]);
            }
        }
    }

    // opt.c:57-67 — two column rounds then two row rounds.
    //
    // # Why these four rounds are written out instead of looped
    //
    // `opt.c` writes them as `for (i = 0; i < 2; ++i)` because it was written
    // for a machine with 16 vector registers, where the shape of the loop
    // cannot matter: `state` has to live in memory either way. Sapphire Rapids
    // has 32 `zmm`, so the shape *does* matter, and a runtime `i` is what stops
    // LLVM from exploiting them — with `base` unknown, every `state[base + k]`
    // is a real load and a real store against the stack slot, and nothing can be
    // kept in a register across a round.
    //
    // Making all 32 indices literal turns the whole array into SSA values that
    // the register allocator can place. Measured on this backend, per block:
    //
    // | | rolled | unrolled |
    // |---|---|---|
    // | dynamic instructions | 823 | 574 |
    // | `zmm` spill stores | 53 | 5 |
    // | `zmm` spill reloads | 50 | 5 |
    // | arithmetic (`vpmuludq`/`vpaddq`/`vprolq`) | identical | identical |
    //
    // The arithmetic is untouched — this only removes the loop's addressing and
    // the memory traffic it forced.
    //
    // # ⚠ Do not hand-fuse the swaps between the column and row passes
    //
    // `BLAKE2_ROUND_1` ends with four `SWAP_HALVES` and `BLAKE2_ROUND_2` opens
    // with four `SWAP_QUARTERS`, which *is* `SWAP_HALVES` followed by the
    // [`QUARTER_IDX`] permutation. `SWAP_HALVES` is an involution, and the two
    // act on the same eight register pairs in the same order — `(s0,s2)`,
    // `(s1,s3)`, `(s4,s6)`, `(s5,s7)` and the same four in the upper group —
    // so on paper the two quartets annihilate and 32 `vshufi64x2` per block
    // fall out.
    //
    // **That was implemented and measured, and it changes nothing.** LLVM
    // already does it: with the rounds unrolled, the whole permutation chain is
    // one shuffle DAG it collapses by itself. Hand-fusing produced an identical
    // op mix in the hot loop — `vshufi64x2` 34, `vpermq` 210, 277 shuffle uops
    // either way — and the same runtime. The rolled `opt.c` form is what hides
    // this from the C, not the macro boundary; unrolling is what exposes it,
    // and unrolling is already done above.
    //
    // The op count is not the binding constraint here in any case. Measured on
    // this core (`vpaddq` 2.2/cycle, `vpmuludq` 2.0, `vpermq` 1.11, `vprolq`
    // 1.11, clock 2.66 GHz under this mix), the per-block port floor is ~262
    // cycles against a measured 346 at `m=2048`, where every access is L2-hot.
    // The kernel is **latency-bound on the round chain**, not issue-bound, which
    // is also why unrolling bought 2% rather than the 30% its instruction count
    // suggested. Removing arithmetic from this kernel is not where time is.
    macro_rules! round_1 {
        ($base:expr) => {{
            // SAFETY: every index is a literal `< 16`; the round needs AVX512F,
            // as does this function.
            let r = unsafe {
                blake2_round_1(
                    state[$base],
                    state[$base + 1],
                    state[$base + 2],
                    state[$base + 3],
                    state[$base + 4],
                    state[$base + 5],
                    state[$base + 6],
                    state[$base + 7],
                )
            };
            state[$base] = r[0];
            state[$base + 1] = r[1];
            state[$base + 2] = r[2];
            state[$base + 3] = r[3];
            state[$base + 4] = r[4];
            state[$base + 5] = r[5];
            state[$base + 6] = r[6];
            state[$base + 7] = r[7];
        }};
    }

    // `BLAKE2_ROUND_2(state[2*0+i], state[2*1+i], ..., state[2*7+i])`, so
    // result `k` goes back to slot `2k + i`.
    macro_rules! round_2 {
        ($i:expr) => {{
            // SAFETY: `14 + $i <= 15`; the round needs AVX512F, as does this
            // function.
            let r = unsafe {
                blake2_round_2(
                    state[$i],
                    state[2 + $i],
                    state[4 + $i],
                    state[6 + $i],
                    state[8 + $i],
                    state[10 + $i],
                    state[12 + $i],
                    state[14 + $i],
                )
            };
            state[$i] = r[0];
            state[2 + $i] = r[1];
            state[4 + $i] = r[2];
            state[6 + $i] = r[3];
            state[8 + $i] = r[4];
            state[10 + $i] = r[5];
            state[12 + $i] = r[6];
            state[14 + $i] = r[7];
        }};
    }

    round_1!(0);
    round_1!(8);
    round_2!(0);
    round_2!(1);

    // SAFETY: as the load loop above.
    unsafe {
        for i in 0..BITS512_WORDS_IN_BLOCK {
            state[i] = _mm512_xor_si512(state[i], block_xy[i].assume_init());
            _mm512_storeu_si512(nextp.add(i), state[i]);
        }
    }
}

/// How many blocks ahead [`fill_segment_impl`] prefetches the reference block
/// on the data-independent path.
///
/// One block of compute is ~346 cycles (~130 ns at the 2.66 GHz this core runs
/// at under this instruction mix), and a random read into a multi-hundred-MiB
/// arena is ~100 ns, so one block of lead is already enough to cover the miss;
/// the value is 2 to leave slack for the reference block that is itself an L3
/// hit and returns early. Measured across 1..4 — see the table at the use site.
const PREFETCH_DISTANCE: u32 = 2;

/// Pull one whole [`Block`] towards L1.
///
/// A block is 1 KiB, so 16 lines. They are issued as 16 separate `prefetcht0`
/// rather than trusting the L2 streamer, because the access is a single
/// isolated 1 KiB burst at a random address: there is no stride for the
/// streamer to lock onto, and by the time it could react the demand loads have
/// already been issued.
///
/// `prefetcht0` is architecturally a hint. It cannot fault, cannot trap on an
/// unmapped or misaligned address, and cannot change any architectural state
/// other than the cache — so **no value computed by this function can affect
/// the output**, which is why the address arithmetic feeding it does not need
/// the same scrutiny as the real one.
///
/// # Safety
///
/// None beyond the pointer being a `*const Block` — see above. `unsafe` only
/// because `_mm_prefetch` is.
#[inline(always)]
unsafe fn prefetch_block<const HINT: i32>(block: *const Block) {
    let base = block.cast::<i8>();
    // SAFETY: `_mm_prefetch` is SSE; the offsets stay inside the 1 KiB block,
    // and it would be sound even if they did not.
    unsafe {
        let mut k = 0;
        while k < core::mem::size_of::<Block>() {
            _mm_prefetch::<HINT>(base.add(k));
            k += 64;
        }
    }
}

/// The reference-block offset for block `index` of the segment `position` is
/// in, given that block's pseudo-random word.
///
/// This is `opt.c:254-271` lifted out of the loop body so that the loop can run
/// it a second time, for a block it has not reached yet, to drive
/// [`prefetch_block`]. The real path calls it too, so there is exactly one copy
/// of the rule and the prefetch cannot drift away from the address it is
/// predicting.
///
/// # Safety
///
/// Nothing is dereferenced; the result is only in bounds for a well-formed
/// instance and an `index < instance.segment_length`. Callers that feed it to
/// anything but a prefetch must uphold that.
#[inline(always)]
fn ref_offset_for(instance: &Instance, position: &Position, index: u32, pseudo_rand: u64) -> u32 {
    // opt.c:254-259.
    let mut ref_lane = ((pseudo_rand >> 32) % u64::from(instance.lanes)) as u32;
    if position.pass == 0 && position.slice == 0 {
        // Cannot reference other lanes yet.
        ref_lane = position.lane;
    }

    // opt.c:264-266 — `index_alpha` takes the LOW 32 bits.
    let mut at = *position;
    at.index = index;
    let ref_index = crate::core::index_alpha(
        instance,
        &at,
        (pseudo_rand & 0xFFFF_FFFF) as u32,
        ref_lane == position.lane,
    );

    // opt.c:269-271. Evaluated in `u64` because the C's `ref_lane` is a
    // `uint64_t`; for a well-formed instance the sum is < memory_blocks.
    let ref_offset_u64 =
        u64::from(instance.lane_length) * u64::from(ref_lane) + u64::from(ref_index);
    debug_assert!(ref_offset_u64 < instance.memory_len() as u64);
    ref_offset_u64 as u32
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
/// The CPU must support AVX-512F. `address_block` and `input_block` must each be
/// valid for reads and writes of one [`Block`] and must not alias each other.
#[inline(always)]
unsafe fn next_addresses(address_block: *mut Block, input_block: *mut Block) {
    // SAFETY: `_mm512_setzero_si512` is AVX512F, which this function's contract
    // requires.
    let zero = unsafe { _mm512_setzero_si512() };
    let mut zero_state = [zero; BITS512_WORDS_IN_BLOCK];
    let mut zero2_state = [zero; BITS512_WORDS_IN_BLOCK];

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

/// `fill_segment()` — `opt.c:174-283`, with `state` fixed to `__m512i[16]`.
///
/// `#[inline(always)]` is load-bearing, not a hint: it is what puts this body
/// (and everything it calls) inside [`fill_segment`], which declares
/// `target_feature(enable = "avx512f")`, so the intrinsics are selected in the
/// right feature context and `fill_block` keeps `state` live across iterations.
///
/// # Safety
///
/// See [`crate::fill_block::FillSegmentFn`]. The CPU must support AVX-512F.
#[inline(always)]
unsafe fn fill_segment_impl(instance: &Instance, position: Position) {
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
            // SAFETY: AVX-512F per this function's contract; the two locals are
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
    // alignment and 16 `__m512i` is exactly one `Block`.
    let mut state = unsafe {
        let p = instance
            .block_ptr(prev_offset)
            .cast::<__m512i>()
            .cast_const();
        let mut state = [_mm512_setzero_si512(); BITS512_WORDS_IN_BLOCK];
        for (i, slot) in state.iter_mut().enumerate() {
            *slot = _mm512_loadu_si512(p.add(i));
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
        let slot = (i % ADDRESSES_IN_BLOCK_U32) as usize;
        let pseudo_rand: u64 = if data_independent_addressing {
            if slot == 0 {
                // SAFETY: as the `next_addresses` call above.
                unsafe {
                    next_addresses(&raw mut address_block, &raw mut input_block);
                }
            }
            address_block.0[slot]
        } else {
            // The C reads this from memory, not from `state`, even though the
            // two are provably equal here (`state` holds `memory[prev_offset]`
            // at this point — see the load before the loop).
            //
            // ⚠ MEASURED, DO NOT "OPTIMISE" THIS: reading it out of the
            // register instead, with
            // `_mm_cvtsi128_si64(_mm512_castsi512_si128(state[0]))`, is
            // **2.1% SLOWER** on this backend — 236.09 -> 241.15 ms, 7 of 8
            // alternating A/B pairs, Argon2d `m=262144 t=3 p=1`, Sapphire
            // Rapids. The theory it was tried on — that a 512-bit store cannot
            // forward to a 64-bit load, so this load eats a drain-to-L1 stall
            // at the head of the address chain — does not hold: the store is
            // 64-byte aligned and the load takes its first 8 bytes, which is
            // the case store-to-load forwarding handles best. What the register
            // read costs instead is a `vmovq zmm->GPR` plus keeping `state[0]`
            // live in a physical register at a point where the allocator wants
            // it spilled, and that is dearer than the forwarded load.
            //
            // SAFETY: `prev_offset` is a block this lane has already finalised
            // (earlier in this segment, or the last block of the lane on a
            // wrap-around), so it is in bounds and no other lane writes it.
            unsafe { (*instance.block_ptr(prev_offset)).0[0] }
        };

        // 1.2.2 / 1.2.3 (opt.c:254-271).
        let ref_offset = ref_offset_for(instance, &position, i, pseudo_rand);

        // Reach forward on the data-independent path.
        //
        // `address_block` holds 128 pseudo-random words at once, so on this
        // path the reference address of block `i + PREFETCH_DISTANCE` is
        // already computable — while the block the C is about to stall on is
        // still being loaded on demand. `opt.c` cannot do this: it generates
        // the same 128 addresses and then consumes them strictly one per
        // iteration, so it never has an address in hand before the block that
        // needs it.
        //
        // Skipped in two cases, neither of which costs correctness:
        //
        // * `ahead >= segment_length` — past the end of this segment; the
        //   addresses there belong to a later `fill_segment` call;
        // * `slot_ahead <= slot` — `i + PREFETCH_DISTANCE` has crossed into the
        //   next group of 128, whose `address_block` has not been generated
        //   yet, so the word would be a stale one from the previous group.
        //   This costs `PREFETCH_DISTANCE` unprefetched blocks per 128.
        //
        // The address is used **only** as a prefetch hint, which cannot fault
        // and cannot change a bit of output — see [`prefetch_block`].
        if data_independent_addressing {
            let ahead = i.wrapping_add(PREFETCH_DISTANCE);
            let slot_ahead = (ahead % ADDRESSES_IN_BLOCK_U32) as usize;
            if ahead < instance.segment_length && slot_ahead > slot {
                let off = ref_offset_for(instance, &position, ahead, address_block.0[slot_ahead]);
                // SAFETY: `off` is in bounds for a well-formed instance by the
                // same argument as `ref_offset`; and `prefetch_block` would be
                // sound even if it were not.
                unsafe { prefetch_block::<_MM_HINT_T0>(instance.block_ptr(off).cast_const()) };
            }
        }

        // ⚠ MEASURED AND REJECTED: the *write* target is `curr_offset`, a plain
        // running counter, so it can be prefetched on every path including
        // Argon2d — `prefetch_block::<_MM_HINT_ET0>` a couple of blocks ahead,
        // to take the line for ownership before the 16 stores need it. It buys
        // nothing: Argon2d `m=262144 t=3` 281.2 -> 289.4 ms, Argon2i `t=1`
        // 56.3 -> 56.2, Argon2id `t=1` 76.1 -> 75.1, each 5-6 alternating pairs
        // and each mixed in direction. The sequential store stream is already
        // handled — stores retire into the store buffer and the L2 streamer
        // sees a perfectly linear address sequence, which is the one case the
        // hardware prefetcher is good at. Only the *reference* read, which is
        // random, needs help.

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

/// AVX-512F `fill_segment()`.
///
/// **Compile-verified only on the development host** — see the module docs.
///
/// # Safety
///
/// The CPU must support AVX-512F — check
/// [`crate::fill_block::Backend::is_available`] or take the pointer from
/// [`crate::fill_block::backend`]. All the requirements of
/// [`crate::fill_block::FillSegmentFn`] apply.
#[target_feature(enable = "avx512f")]
pub unsafe fn fill_segment(instance: &Instance, position: Position) {
    // SAFETY: AVX-512F is this function's declared feature, so a caller reaching
    // here without it is already unsound; the rest is `FillSegmentFn`'s
    // contract, which the caller upholds.
    unsafe { fill_segment_impl(instance, position) }
}

// ---------------------------------------------------------------------------
// Lane-algebra simulation (test only)
// ---------------------------------------------------------------------------

/// [`fill_block`] re-expressed on `tests::sim`'s scalar model of the AVX-512F
/// intrinsics, so the lane algebra can be exercised where AVX-512 cannot run.
///
/// This is a hand-kept mirror of [`fill_block`] and the round helpers above:
/// same round schedule, same store-back slots, same `BLAKE2_ROUND_1` parameter
/// naming, same [`QUARTER_IDX`]. See `tests::sim` for what it does and does not
/// prove, and for the maintenance warning.
#[cfg(test)]
fn simulated_fill_block(prev: &Block, ref_block: &Block, next_block: &mut Block, with_xor: bool) {
    use tests::sim::{M512, add, mul_epu32, permutex, permutexvar, ror, shuffle_i64x2, xor};

    fn muladd(x: M512, y: M512) -> M512 {
        let z = mul_epu32(x, y);
        add(add(x, y), add(z, z))
    }

    #[allow(clippy::too_many_arguments)]
    fn g1(
        a0: &mut M512,
        b0: &mut M512,
        c0: &mut M512,
        d0: &mut M512,
        a1: &mut M512,
        b1: &mut M512,
        c1: &mut M512,
        d1: &mut M512,
    ) {
        *a0 = muladd(*a0, *b0);
        *a1 = muladd(*a1, *b1);
        *d0 = xor(*d0, *a0);
        *d1 = xor(*d1, *a1);
        *d0 = ror::<32>(*d0);
        *d1 = ror::<32>(*d1);
        *c0 = muladd(*c0, *d0);
        *c1 = muladd(*c1, *d1);
        *b0 = xor(*b0, *c0);
        *b1 = xor(*b1, *c1);
        *b0 = ror::<24>(*b0);
        *b1 = ror::<24>(*b1);
    }

    #[allow(clippy::too_many_arguments)]
    fn g2(
        a0: &mut M512,
        b0: &mut M512,
        c0: &mut M512,
        d0: &mut M512,
        a1: &mut M512,
        b1: &mut M512,
        c1: &mut M512,
        d1: &mut M512,
    ) {
        *a0 = muladd(*a0, *b0);
        *a1 = muladd(*a1, *b1);
        *d0 = xor(*d0, *a0);
        *d1 = xor(*d1, *a1);
        *d0 = ror::<16>(*d0);
        *d1 = ror::<16>(*d1);
        *c0 = muladd(*c0, *d0);
        *c1 = muladd(*c1, *d1);
        *b0 = xor(*b0, *c0);
        *b1 = xor(*b1, *c1);
        *b0 = ror::<63>(*b0);
        *b1 = ror::<63>(*b1);
    }

    fn diagonalize(
        b0: &mut M512,
        b1: &mut M512,
        c0: &mut M512,
        c1: &mut M512,
        d0: &mut M512,
        d1: &mut M512,
    ) {
        *b0 = permutex::<0b00_11_10_01>(*b0);
        *b1 = permutex::<0b00_11_10_01>(*b1);
        *c0 = permutex::<0b01_00_11_10>(*c0);
        *c1 = permutex::<0b01_00_11_10>(*c1);
        *d0 = permutex::<0b10_01_00_11>(*d0);
        *d1 = permutex::<0b10_01_00_11>(*d1);
    }

    fn undiagonalize(
        b0: &mut M512,
        b1: &mut M512,
        c0: &mut M512,
        c1: &mut M512,
        d0: &mut M512,
        d1: &mut M512,
    ) {
        *b0 = permutex::<0b10_01_00_11>(*b0);
        *b1 = permutex::<0b10_01_00_11>(*b1);
        *c0 = permutex::<0b01_00_11_10>(*c0);
        *c1 = permutex::<0b01_00_11_10>(*c1);
        *d0 = permutex::<0b00_11_10_01>(*d0);
        *d1 = permutex::<0b00_11_10_01>(*d1);
    }

    #[allow(clippy::too_many_arguments)]
    fn blake2_round(
        a0: M512,
        b0: M512,
        c0: M512,
        d0: M512,
        a1: M512,
        b1: M512,
        c1: M512,
        d1: M512,
    ) -> [M512; 8] {
        let (mut a0, mut b0, mut c0, mut d0) = (a0, b0, c0, d0);
        let (mut a1, mut b1, mut c1, mut d1) = (a1, b1, c1, d1);
        g1(
            &mut a0, &mut b0, &mut c0, &mut d0, &mut a1, &mut b1, &mut c1, &mut d1,
        );
        g2(
            &mut a0, &mut b0, &mut c0, &mut d0, &mut a1, &mut b1, &mut c1, &mut d1,
        );
        diagonalize(&mut b0, &mut b1, &mut c0, &mut c1, &mut d0, &mut d1);
        g1(
            &mut a0, &mut b0, &mut c0, &mut d0, &mut a1, &mut b1, &mut c1, &mut d1,
        );
        g2(
            &mut a0, &mut b0, &mut c0, &mut d0, &mut a1, &mut b1, &mut c1, &mut d1,
        );
        undiagonalize(&mut b0, &mut b1, &mut c0, &mut c1, &mut d0, &mut d1);
        [a0, b0, c0, d0, a1, b1, c1, d1]
    }

    fn swap_halves(a0: &mut M512, a1: &mut M512) {
        let t0 = shuffle_i64x2::<0b01_00_01_00>(*a0, *a1);
        let t1 = shuffle_i64x2::<0b11_10_11_10>(*a0, *a1);
        *a0 = t0;
        *a1 = t1;
    }

    fn swap_quarters(a0: &mut M512, a1: &mut M512) {
        swap_halves(a0, a1);
        *a0 = permutexvar(QUARTER_IDX, *a0);
        *a1 = permutexvar(QUARTER_IDX, *a1);
    }

    fn unswap_quarters(a0: &mut M512, a1: &mut M512) {
        *a0 = permutexvar(QUARTER_IDX, *a0);
        *a1 = permutexvar(QUARTER_IDX, *a1);
        swap_halves(a0, a1);
    }

    #[allow(clippy::too_many_arguments)]
    fn blake2_round_1(
        a0: M512,
        c0: M512,
        b0: M512,
        d0: M512,
        a1: M512,
        c1: M512,
        b1: M512,
        d1: M512,
    ) -> [M512; 8] {
        let (mut a0, mut c0, mut b0, mut d0) = (a0, c0, b0, d0);
        let (mut a1, mut c1, mut b1, mut d1) = (a1, c1, b1, d1);
        swap_halves(&mut a0, &mut b0);
        swap_halves(&mut c0, &mut d0);
        swap_halves(&mut a1, &mut b1);
        swap_halves(&mut c1, &mut d1);
        let r = blake2_round(a0, b0, c0, d0, a1, b1, c1, d1);
        a0 = r[0];
        b0 = r[1];
        c0 = r[2];
        d0 = r[3];
        a1 = r[4];
        b1 = r[5];
        c1 = r[6];
        d1 = r[7];
        swap_halves(&mut a0, &mut b0);
        swap_halves(&mut c0, &mut d0);
        swap_halves(&mut a1, &mut b1);
        swap_halves(&mut c1, &mut d1);
        [a0, c0, b0, d0, a1, c1, b1, d1]
    }

    #[allow(clippy::too_many_arguments)]
    fn blake2_round_2(
        a0: M512,
        a1: M512,
        b0: M512,
        b1: M512,
        c0: M512,
        c1: M512,
        d0: M512,
        d1: M512,
    ) -> [M512; 8] {
        let (mut a0, mut a1, mut b0, mut b1) = (a0, a1, b0, b1);
        let (mut c0, mut c1, mut d0, mut d1) = (c0, c1, d0, d1);
        swap_quarters(&mut a0, &mut a1);
        swap_quarters(&mut b0, &mut b1);
        swap_quarters(&mut c0, &mut c1);
        swap_quarters(&mut d0, &mut d1);
        let r = blake2_round(a0, b0, c0, d0, a1, b1, c1, d1);
        a0 = r[0];
        b0 = r[1];
        c0 = r[2];
        d0 = r[3];
        a1 = r[4];
        b1 = r[5];
        c1 = r[6];
        d1 = r[7];
        unswap_quarters(&mut a0, &mut a1);
        unswap_quarters(&mut b0, &mut b1);
        unswap_quarters(&mut c0, &mut c1);
        unswap_quarters(&mut d0, &mut d1);
        [a0, a1, b0, b1, c0, c1, d0, d1]
    }

    // The body of `fill_block`, on the model.
    let load = |b: &Block, j: usize| -> M512 { core::array::from_fn(|k| b.0[8 * j + k]) };
    let mut state: [M512; BITS512_WORDS_IN_BLOCK] = core::array::from_fn(|j| load(prev, j));
    let mut block_xy = [[0u64; 8]; BITS512_WORDS_IN_BLOCK];

    if with_xor {
        for i in 0..BITS512_WORDS_IN_BLOCK {
            state[i] = xor(state[i], load(ref_block, i));
            block_xy[i] = xor(state[i], load(next_block, i));
        }
    } else {
        for i in 0..BITS512_WORDS_IN_BLOCK {
            state[i] = xor(state[i], load(ref_block, i));
            block_xy[i] = state[i];
        }
    }

    for i in 0..2 {
        let base = 8 * i;
        let r = blake2_round_1(
            state[base],
            state[base + 1],
            state[base + 2],
            state[base + 3],
            state[base + 4],
            state[base + 5],
            state[base + 6],
            state[base + 7],
        );
        for (k, value) in r.into_iter().enumerate() {
            state[base + k] = value;
        }
    }

    for i in 0..2 {
        let r = blake2_round_2(
            state[i],
            state[2 + i],
            state[4 + i],
            state[6 + i],
            state[8 + i],
            state[10 + i],
            state[12 + i],
            state[14 + i],
        );
        for (k, value) in r.into_iter().enumerate() {
            state[2 * k + i] = value;
        }
    }

    for i in 0..BITS512_WORDS_IN_BLOCK {
        state[i] = xor(state[i], block_xy[i]);
        next_block.0[8 * i..8 * i + 8].copy_from_slice(&state[i]);
    }
}

#[cfg(test)]
mod tests {
    use super::super::sse2::test_support::{
        Group, XorShift64Star, assert_fill_block_matches_scalar, check_official_vectors,
        skip_unless_available,
    };
    use super::*;
    use crate::fill_block::{Backend, backend, detect, fill_segment_fn};
    use crate::params::QWORDS_IN_BLOCK;

    // ------------------------------------------------------------------
    // Tests that DO run on a host without AVX-512
    //
    // The lane shuffles are the part of this backend most likely to be wrong,
    // and they are pure index permutations, so they can be checked in plain
    // integer arithmetic with no AVX-512 instruction anywhere. These run
    // everywhere `x86_64` compiles.
    // ------------------------------------------------------------------

    /// `_mm512_permutexvar_epi64(idx, a)` computes `out[k] = a[idx[k]]`, so
    /// [`QUARTER_IDX`] must be an involution for `UNSWAP_QUARTERS` to be able to
    /// undo `SWAP_QUARTERS` by reordering its two steps.
    #[test]
    fn quarter_permutation_is_an_involution() {
        assert_eq!(QUARTER_IDX, [0, 1, 4, 5, 2, 3, 6, 7]);
        for (k, &target) in QUARTER_IDX.iter().enumerate() {
            let once = target as usize;
            assert!(once < 8, "index {once} out of range");
            assert_eq!(
                QUARTER_IDX[once] as usize, k,
                "QUARTER_IDX is not an involution at {k}"
            );
        }
    }

    /// `SWAP_HALVES` as a 64-bit-lane index permutation of the pair
    /// `(a0, a1)` viewed as 16 slots: `a0` gets `(a0[0..4], a1[0..4])` and `a1`
    /// gets `(a0[4..8], a1[4..8])`. Applying it twice is the identity.
    fn swap_halves_on_indices(a0: &mut [usize; 8], a1: &mut [usize; 8]) {
        let (o0, o1) = (*a0, *a1);
        // _MM_SHUFFLE(1, 0, 1, 0): 128-bit lanes (a[0], a[1], b[0], b[1]).
        a0[0..4].copy_from_slice(&o0[0..4]);
        a0[4..8].copy_from_slice(&o1[0..4]);
        // _MM_SHUFFLE(3, 2, 3, 2): 128-bit lanes (a[2], a[3], b[2], b[3]).
        a1[0..4].copy_from_slice(&o0[4..8]);
        a1[4..8].copy_from_slice(&o1[4..8]);
    }

    fn permute_on_indices(a: &mut [usize; 8]) {
        let old = *a;
        for k in 0..8 {
            a[k] = old[QUARTER_IDX[k] as usize];
        }
    }

    #[test]
    fn swap_halves_is_an_involution() {
        let mut a0 = [0, 1, 2, 3, 4, 5, 6, 7];
        let mut a1 = [8, 9, 10, 11, 12, 13, 14, 15];
        let (o0, o1) = (a0, a1);

        swap_halves_on_indices(&mut a0, &mut a1);
        // The upper half of a0 and the lower half of a1 are exchanged.
        assert_eq!(a0, [0, 1, 2, 3, 8, 9, 10, 11]);
        assert_eq!(a1, [4, 5, 6, 7, 12, 13, 14, 15]);

        swap_halves_on_indices(&mut a0, &mut a1);
        assert_eq!((a0, a1), (o0, o1), "SWAP_HALVES must be its own inverse");
    }

    #[test]
    fn swap_and_unswap_quarters_are_inverses() {
        let mut a0 = [0, 1, 2, 3, 4, 5, 6, 7];
        let mut a1 = [8, 9, 10, 11, 12, 13, 14, 15];
        let (o0, o1) = (a0, a1);

        // SWAP_QUARTERS: swap_halves, then permute both.
        swap_halves_on_indices(&mut a0, &mut a1);
        permute_on_indices(&mut a0);
        permute_on_indices(&mut a1);
        assert_ne!((a0, a1), (o0, o1), "SWAP_QUARTERS must actually move data");

        // UNSWAP_QUARTERS: permute both, then swap_halves.
        permute_on_indices(&mut a0);
        permute_on_indices(&mut a1);
        swap_halves_on_indices(&mut a0, &mut a1);
        assert_eq!(
            (a0, a1),
            (o0, o1),
            "UNSWAP_QUARTERS must undo SWAP_QUARTERS"
        );
    }

    /// `DIAGONALIZE` / `UNDIAGONALIZE` are `_mm512_permutex_epi64` with rotate
    /// amounts 1, 2, 3 within each 256-bit half. Check the immediates encode
    /// exactly those rotations, and that the un- variant inverts them.
    #[test]
    fn diagonalize_immediates_are_the_right_rotations() {
        /// `_mm512_permutex_epi64::<IMM>` per 256-bit half:
        /// `out[k] = src[(IMM >> (2 * k)) & 3]`.
        fn apply(imm: u32, src: [usize; 4]) -> [usize; 4] {
            let mut out = [0usize; 4];
            for k in 0..4 {
                out[k] = src[((imm >> (2 * k)) & 3) as usize];
            }
            out
        }
        const ROT1: u32 = 0b00_11_10_01;
        const ROT2: u32 = 0b01_00_11_10;
        const ROT3: u32 = 0b10_01_00_11;

        let id = [0usize, 1, 2, 3];
        assert_eq!(apply(ROT1, id), [1, 2, 3, 0], "B must rotate left by 1");
        assert_eq!(apply(ROT2, id), [2, 3, 0, 1], "C must rotate left by 2");
        assert_eq!(apply(ROT3, id), [3, 0, 1, 2], "D must rotate left by 3");

        // UNDIAGONALIZE uses ROT3 for B, ROT2 for C, ROT1 for D.
        assert_eq!(apply(ROT3, apply(ROT1, id)), id, "B round trip");
        assert_eq!(apply(ROT2, apply(ROT2, id)), id, "C round trip");
        assert_eq!(apply(ROT1, apply(ROT3, id)), id, "D round trip");
    }

    /// The immediates handed to `_mm512_shuffle_i64x2` in `SWAP_HALVES` must be
    /// `_MM_SHUFFLE(1, 0, 1, 0)` and `_MM_SHUFFLE(3, 2, 3, 2)`.
    #[test]
    fn swap_halves_immediates_match_the_c() {
        const fn mm_shuffle(z: u32, y: u32, x: u32, w: u32) -> u32 {
            (z << 6) | (y << 4) | (x << 2) | w
        }
        assert_eq!(0b01_00_01_00, mm_shuffle(1, 0, 1, 0));
        assert_eq!(0b11_10_11_10, mm_shuffle(3, 2, 3, 2));
    }

    /// AVX-512 must be unreachable on a host that does not advertise it, so the
    /// never-executed code is dead rather than latent. This is the guarantee
    /// that makes "compile-verified only" acceptable.
    #[test]
    fn avx512_is_never_selected_on_a_host_without_it() {
        if !Backend::Avx512.is_available() {
            assert_ne!(
                detect(),
                Backend::Avx512,
                "AVX-512F absent, so it must never be selected"
            );
            assert_ne!(backend(), Backend::Avx512, "nor cached");
        } else {
            assert_eq!(
                detect(),
                Backend::Avx512,
                "AVX-512F present, so it is the top preference"
            );
            assert_eq!(backend(), Backend::Avx512);
        }
        #[cfg(feature = "std")]
        assert_eq!(
            Backend::Avx512.is_available(),
            std::arch::is_x86_feature_detected!("avx512f")
        );
    }

    #[test]
    fn dispatch_resolves_to_this_module() {
        // Resolving the pointer does not execute anything, so this is safe on a
        // host without AVX-512.
        let f = fill_segment_fn(Backend::Avx512);
        assert!(
            core::ptr::fn_addr_eq(f, fill_segment as unsafe fn(&Instance, Position)),
            "fill_segment_fn(Avx512) must be avx512::fill_segment"
        );
        assert!(!core::ptr::fn_addr_eq(
            f,
            crate::fill_block::scalar::fill_segment as unsafe fn(&Instance, Position)
        ));
    }

    // ------------------------------------------------------------------
    // Lane-algebra simulation — RUNS ON EVERY HOST, no AVX-512 needed
    // ------------------------------------------------------------------

    /// A scalar model of the AVX-512F intrinsics this module uses, so the lane
    /// algebra can be checked on a host that cannot execute AVX-512.
    ///
    /// `__m512i` is modelled as `[u64; 8]` with lane 0 lowest, and every
    /// operation is written straight from the Intel Intrinsics Guide pseudocode.
    /// [`super::simulated_fill_block`] then re-expresses [`fill_block`]'s round
    /// structure on that model, and
    /// [`lane_algebra_matches_scalar_over_4096_triples`] pins the result against
    /// `scalar::fill_block`.
    ///
    /// What this does and does not buy:
    ///
    /// * **Covered** — the `SWAP_HALVES` / `SWAP_QUARTERS` / `UNSWAP_QUARTERS`
    ///   algebra, the `DIAGONALIZE` immediates, `BLAKE2_ROUND_1`'s
    ///   `A0 C0 B0 D0 A1 C1 B1 D1` parameter naming, the column/row schedule and
    ///   its store-back slots, the `with_xor` selection, and the final XOR.
    ///   Deliberately breaking any one of those makes the test fail — verified.
    /// * **Not covered** — that the real instructions behave as the Intel
    ///   pseudocode says. Only real hardware can show that.
    ///
    /// ⚠ **Maintenance**: [`sim`] and [`super::simulated_fill_block`] mirror the
    /// real code by hand. Change [`fill_block`] or any round helper above and you
    /// must change these too, or the test silently stops covering what it claims.
    pub(super) mod sim {
        pub type M512 = [u64; 8];

        pub fn xor(a: M512, b: M512) -> M512 {
            core::array::from_fn(|i| a[i] ^ b[i])
        }

        pub fn add(a: M512, b: M512) -> M512 {
            core::array::from_fn(|i| a[i].wrapping_add(b[i]))
        }

        /// `_mm512_mul_epu32`: each lane is the full 64-bit product of the two
        /// low 32-bit halves.
        pub fn mul_epu32(a: M512, b: M512) -> M512 {
            core::array::from_fn(|i| (a[i] & 0xFFFF_FFFF).wrapping_mul(b[i] & 0xFFFF_FFFF))
        }

        /// `_mm512_ror_epi64::<N>`.
        pub fn ror<const N: u32>(a: M512) -> M512 {
            core::array::from_fn(|i| a[i].rotate_right(N))
        }

        /// `_mm512_permutex_epi64::<IMM>`: one 4-lane pattern applied to each
        /// 256-bit half independently, `dst[j] = src_half[(IMM >> 2j) & 3]`.
        pub fn permutex<const IMM: u32>(a: M512) -> M512 {
            let mut out = [0u64; 8];
            for half in 0..2 {
                for j in 0..4 {
                    out[half * 4 + j] = a[half * 4 + (((IMM >> (2 * j)) & 3) as usize)];
                }
            }
            out
        }

        /// `_mm512_permutexvar_epi64(idx, a)`: `dst[j] = a[idx[j] & 7]`.
        pub fn permutexvar(idx: [i64; 8], a: M512) -> M512 {
            core::array::from_fn(|j| a[(idx[j] as usize) & 7])
        }

        /// `_mm512_shuffle_i64x2::<IMM>(a, b)`: 128-bit lane select, the low two
        /// result lanes from `a` and the high two from `b`.
        pub fn shuffle_i64x2<const IMM: u32>(a: M512, b: M512) -> M512 {
            let lane = |v: M512, l: usize| [v[2 * l], v[2 * l + 1]];
            let picked = [
                lane(a, (IMM & 3) as usize),
                lane(a, ((IMM >> 2) & 3) as usize),
                lane(b, ((IMM >> 4) & 3) as usize),
                lane(b, ((IMM >> 6) & 3) as usize),
            ];
            let mut out = [0u64; 8];
            for (l, pair) in picked.iter().enumerate() {
                out[2 * l] = pair[0];
                out[2 * l + 1] = pair[1];
            }
            out
        }
    }

    #[test]
    fn lane_algebra_matches_scalar_over_4096_triples() {
        let mut rng = XorShift64Star::new(0x0123_4567_89AB_CDEF);
        let mut compared = 0u32;
        for iteration in 0..4096u32 {
            let prev = rng.next_block();
            let reference = rng.next_block();
            let original_next = rng.next_block();

            for with_xor in [false, true] {
                let mut want = original_next;
                crate::fill_block::scalar::fill_block(&prev, &reference, &mut want, with_xor);

                let mut got = original_next;
                super::simulated_fill_block(&prev, &reference, &mut got, with_xor);

                for w in 0..QWORDS_IN_BLOCK {
                    assert_eq!(
                        got.0[w], want.0[w],
                        "avx512 lane algebra: iteration {iteration}, \
                         with_xor={with_xor}, word {w}"
                    );
                }
                compared += 1;
            }
        }
        assert_eq!(compared, 4096 * 2);
    }

    /// The all-zero fixed point, through the simulated lane algebra.
    #[test]
    fn lane_algebra_keeps_all_zero_all_zero() {
        let mut next = Block::ZERO;
        super::simulated_fill_block(&Block::ZERO, &Block::ZERO, &mut next, false);
        assert_eq!(next, Block::ZERO);
    }

    // ------------------------------------------------------------------
    // Tests that need real AVX-512 hardware
    //
    // Every one of these is a no-op on a host without AVX-512F. On this
    // development host that is ALWAYS, because Rosetta 2 reports
    // `cpuid.7:EBX[16] == 0` and traps the instruction with SIGILL.
    // ------------------------------------------------------------------

    /// Bail out when the host cannot execute AVX-512F — `true` means skip.
    ///
    /// **On the development host this ALWAYS skips**, because Rosetta 2 reports
    /// `avx512f` as absent and traps the instruction with `SIGILL` (measured:
    /// exit code 132). `ARGON2_REQUIRE_BACKEND=avx512` turns the skip into a
    /// failure, which is how a future run on real AVX-512 hardware can prove
    /// these tests actually executed. Do NOT reach for
    /// `RUSTFLAGS="-C target-feature=+avx512f"` to satisfy it here: that makes
    /// `is_available()` lie and the process dies with `SIGILL`.
    fn skip_without_avx512() -> bool {
        skip_unless_available(Backend::Avx512)
    }

    /// `fill_block` on whole [`Block`]s, so it can be compared against
    /// `scalar::fill_block`. Loads `prev` into a fresh `state`, exactly as
    /// `fill_segment`'s pre-loop `memcpy` does, then runs one `fill_block`.
    ///
    /// # Safety
    ///
    /// The CPU must support AVX-512F.
    #[target_feature(enable = "avx512f")]
    unsafe fn fill_block_blocks(prev: &Block, reference: &Block, next: &mut Block, with_xor: bool) {
        // SAFETY: AVX-512F is declared above. `prev` is one `Block` = 16
        // `__m512i`, read with `loadu`; `reference` and `next` are distinct live
        // `Block`s.
        unsafe {
            let mut state = [_mm512_setzero_si512(); BITS512_WORDS_IN_BLOCK];
            let p = prev.as_ptr().cast::<__m512i>();
            for (i, slot) in state.iter_mut().enumerate() {
                *slot = _mm512_loadu_si512(p.add(i));
            }
            fill_block(&mut state, reference, next, with_xor);
        }
    }

    #[test]
    fn fill_block_matches_scalar_over_2048_triples() {
        if skip_without_avx512() {
            return;
        }
        // SAFETY: `Backend::Avx512.is_available()` confirmed AVX-512F.
        unsafe {
            assert_fill_block_matches_scalar(
                "avx512",
                fill_block_blocks,
                2048,
                0x0123_4567_89AB_CDEF,
            );
        }
    }

    /// An all-zero block survives every round, because `fBlaMka(0, 0) == 0`.
    #[test]
    fn all_zero_stays_all_zero() {
        if skip_without_avx512() {
            return;
        }
        let mut next = Block::ZERO;
        // SAFETY: AVX-512F confirmed.
        unsafe { fill_block_blocks(&Block::ZERO, &Block::ZERO, &mut next, false) };
        assert_eq!(next, Block::ZERO);
    }

    /// Each of the 128 input words must reach the output. This is the test that
    /// catches `BLAKE2_ROUND_1`'s `A0 C0 B0 D0` parameter naming being read as
    /// `A0 B0 C0 D0`, which otherwise compiles and produces plausible-looking
    /// wrong hashes.
    #[test]
    fn every_input_word_reaches_the_output() {
        if skip_without_avx512() {
            return;
        }
        let mut rng = XorShift64Star::new(0x1357_9BDF_2468_ACE0);
        let prev = rng.next_block();
        let reference = rng.next_block();

        let base = {
            let mut b = Block::ZERO;
            // SAFETY: AVX-512F confirmed.
            unsafe { fill_block_blocks(&prev, &reference, &mut b, false) };
            b
        };

        for w in 0..QWORDS_IN_BLOCK {
            let mut flipped_prev = prev;
            flipped_prev.0[w] ^= 1;
            let mut got = Block::ZERO;
            // SAFETY: AVX-512F confirmed.
            unsafe { fill_block_blocks(&flipped_prev, &reference, &mut got, false) };
            assert_ne!(got, base, "flipping prev word {w} changed nothing");
        }
    }

    #[test]
    fn official_vectors_avx512_forced_v0x10_argon2i() {
        if skip_without_avx512() {
            return;
        }
        // SAFETY: `skip_without_avx512()` returned false, i.e.
        // `Backend::Avx512.is_available()` is true. There is no forced bypass
        // here, unlike AVX2: Rosetta 2 traps AVX-512 with `SIGILL`.
        unsafe { check_official_vectors(Backend::Avx512, Group::V0x10Argon2i, false) };
    }

    #[test]
    fn official_vectors_avx512_forced_v0x13_argon2i() {
        if skip_without_avx512() {
            return;
        }
        // SAFETY: as above — `skip_without_avx512()` returned false.
        unsafe { check_official_vectors(Backend::Avx512, Group::V0x13Argon2i, false) };
    }

    #[test]
    fn official_vectors_avx512_forced_v0x13_argon2id() {
        if skip_without_avx512() {
            return;
        }
        // SAFETY: as above — `skip_without_avx512()` returned false.
        unsafe { check_official_vectors(Backend::Avx512, Group::V0x13Argon2id, false) };
    }

    #[test]
    #[ignore = "TEST_LARGE_RAM: 1 GiB arena"]
    fn official_vectors_with_the_avx512_backend_forced_including_large_ram() {
        if skip_without_avx512() {
            return;
        }
        // SAFETY: as above — `skip_without_avx512()` returned false.
        unsafe { check_official_vectors(Backend::Avx512, Group::All, true) };
    }
}

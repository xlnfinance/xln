//! BLAKE2b and Argon2's `blake2b_long` variable-length extension.
//!
//! A line-by-line port of `phc-winner-argon2/src/blake2/blake2b.c`: the
//! standard 12-round BLAKE2b with the standard IV and sigma table, with the
//! parameter block XORed into the IV as eight little-endian `u64` words. Argon2
//! uses it **unkeyed**, with `digest_length = outlen` and `fanout = depth = 1`.
//!
//! # Differences forced by Rust
//!
//! * The C guards every entry point against a *reused* state (`S->f[0] != 0`,
//!   which `blake2b_final` leaves set). Here [`Blake2b::finalize`] takes `self`
//!   by value, so reuse is a compile error and the guards are unreachable. They
//!   are kept anyway, so the port matches the C statement for statement, and
//!   `tests::reused_state_is_rejected` drives them directly.
//! * `blake2b_final(S, out, outlen)` accepts any `outlen >= S->outlen` and
//!   writes `S->outlen` bytes. [`Blake2b::finalize`] does the same with
//!   `out.len()` in place of `outlen`.

use crate::error::Error;
use crate::memory::{clear_internal_memory, clear_internal_memory_u64};
#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
use core::sync::atomic::{AtomicU8, Ordering};

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
mod avx2;
#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
mod avx512;
#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
mod sse41;

/// `BLAKE2B_BLOCKBYTES`.
pub const BLOCKBYTES: usize = 128;
/// `BLAKE2B_OUTBYTES`.
pub const OUTBYTES: usize = 64;
/// `BLAKE2B_KEYBYTES`.
pub const KEYBYTES: usize = 64;
/// `BLAKE2B_SALTBYTES`.
pub const SALTBYTES: usize = 16;
/// `BLAKE2B_PERSONALBYTES`.
pub const PERSONALBYTES: usize = 16;

/// Half a digest: how many bytes `blake2b_long` emits per extension step.
const HALFBYTES: usize = OUTBYTES / 2;

/// Size of `blake2b_param`, which is `#pragma pack`ed to exactly 64 bytes.
const PARAMBYTES: usize = 64;

/// The BLAKE2b IV (`blake2b_IV` in `blake2b.c`).
pub const IV: [u64; 8] = [
    0x6a09e667f3bcc908,
    0xbb67ae8584caa73b,
    0x3c6ef372fe94f82b,
    0xa54ff53a5f1d36f1,
    0x510e527fade682d1,
    0x9b05688c2b3e6c1f,
    0x1f83d9abfb41bd6b,
    0x5be0cd19137e2179,
];

/// The message schedule (`blake2b_sigma`). `usize` so it indexes `m` directly.
const SIGMA: [[usize; 16]; 12] = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];

/// `load64()` from `blake2-impl.h`, total: a short slice reads as if
/// zero-padded, so it can never panic. Callers always pass exactly 8 bytes.
#[inline]
fn load64(src: &[u8]) -> u64 {
    let mut bytes = [0u8; 8];
    let n = if src.len() < 8 { src.len() } else { 8 };
    bytes[..n].copy_from_slice(&src[..n]);
    u64::from_le_bytes(bytes)
}

/// The `G` macro from `blake2b_compress`.
///
/// `s` is one row of [`SIGMA`], `i` the column index within the round. Every
/// index is `< 16`, so no access here can be out of bounds.
#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn g(
    v: &mut [u64; 16],
    m: &[u64; 16],
    s: &[usize; 16],
    i: usize,
    a: usize,
    b: usize,
    c: usize,
    d: usize,
) {
    // Every `+` in the C is modular `uint64_t` arithmetic: `wrapping_add`, or
    // this would panic in a debug build.
    v[a] = v[a].wrapping_add(v[b]).wrapping_add(m[s[2 * i]]);
    v[d] = (v[d] ^ v[a]).rotate_right(32);
    v[c] = v[c].wrapping_add(v[d]);
    v[b] = (v[b] ^ v[c]).rotate_right(24);
    v[a] = v[a].wrapping_add(v[b]).wrapping_add(m[s[2 * i + 1]]);
    v[d] = (v[d] ^ v[a]).rotate_right(16);
    v[c] = v[c].wrapping_add(v[d]);
    v[b] = (v[b] ^ v[c]).rotate_right(63);
}

/// Portable `blake2b_compress()`: absorb one parsed 128-byte block into `h`.
fn compress_scalar(h: &mut [u64; 8], t: &[u64; 2], f: &[u64; 2], m: &[u64; 16]) {
    let mut v = [0u64; 16];
    v[..8].copy_from_slice(h);
    v[8] = IV[0];
    v[9] = IV[1];
    v[10] = IV[2];
    v[11] = IV[3];
    v[12] = IV[4] ^ t[0];
    v[13] = IV[5] ^ t[1];
    v[14] = IV[6] ^ f[0];
    v[15] = IV[7] ^ f[1];

    for s in &SIGMA {
        g(&mut v, m, s, 0, 0, 4, 8, 12);
        g(&mut v, m, s, 1, 1, 5, 9, 13);
        g(&mut v, m, s, 2, 2, 6, 10, 14);
        g(&mut v, m, s, 3, 3, 7, 11, 15);
        g(&mut v, m, s, 4, 0, 5, 10, 15);
        g(&mut v, m, s, 5, 1, 6, 11, 12);
        g(&mut v, m, s, 6, 2, 7, 8, 13);
        g(&mut v, m, s, 7, 3, 4, 9, 14);
    }

    for (i, word) in h.iter_mut().enumerate() {
        *word ^= v[i] ^ v[i + 8];
    }
}

/// The compression implementations available to BLAKE2b on this target.
///
/// This is deliberately separate from [`crate::fill_block::Backend`]. One
/// BLAKE2b compression has four naturally parallel `G` functions. SSE4.1
/// handles them as two pairs; AVX2 handles all four in one register. The
/// AVX-512 backend requires AVX2, AVX-512F and AVX-512VL, and uses a native
/// 256-bit rotate instead of widening into half-empty ZMM registers.
///
/// A two-register NEON version was also measured on Apple ARM64 and rejected:
/// it made the 72-byte digest 16% slower and the 1 KiB expansion 26% slower
/// than scalar. On x86, upstream's SSE4.1 schedule was retained because it
/// made Argon2's 72-to-1024-byte expansion 15-16% faster on AMD EPYC. SSE2 and
/// SSSE3 were rejected because they regressed longer inputs substantially.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Blake2bBackend {
    /// Portable scalar code. Always available.
    Scalar = 0,
    /// x86/x86-64 SSE4.1, two 64-bit lanes per register.
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    Sse41 = 1,
    /// x86/x86-64 AVX2, four 64-bit lanes.
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    Avx2 = 2,
    /// x86/x86-64 AVX2 + AVX-512F + AVX-512VL, with native rotates.
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    Avx512 = 3,
}

impl Blake2bBackend {
    /// Every BLAKE2b backend compiled for this target.
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    pub const ALL: &'static [Blake2bBackend] = &[
        Blake2bBackend::Scalar,
        Blake2bBackend::Sse41,
        Blake2bBackend::Avx2,
        Blake2bBackend::Avx512,
    ];
    /// Every BLAKE2b backend compiled for this target.
    #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
    pub const ALL: &'static [Blake2bBackend] = &[Blake2bBackend::Scalar];

    /// A short diagnostic/benchmark name.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Blake2bBackend::Scalar => "scalar",
            #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
            Blake2bBackend::Sse41 => "sse4.1",
            #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
            Blake2bBackend::Avx2 => "avx2",
            #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
            Blake2bBackend::Avx512 => "avx512",
        }
    }

    /// Whether this CPU can execute the backend right now.
    #[must_use]
    pub fn is_available(self) -> bool {
        match self {
            Blake2bBackend::Scalar => true,
            #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
            Blake2bBackend::Sse41 => have_sse41(),
            #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
            Blake2bBackend::Avx2 => have_avx2(),
            #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
            Blake2bBackend::Avx512 => have_avx512vl(),
        }
    }

    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    const fn from_u8(value: u8) -> Blake2bBackend {
        match value {
            1 => Blake2bBackend::Sse41,
            2 => Blake2bBackend::Avx2,
            3 => Blake2bBackend::Avx512,
            _ => Blake2bBackend::Scalar,
        }
    }
}

impl core::fmt::Display for Blake2bBackend {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.name())
    }
}

#[cfg(all(feature = "std", any(target_arch = "x86", target_arch = "x86_64")))]
fn have_sse41() -> bool {
    std::arch::is_x86_feature_detected!("sse4.1")
}

#[cfg(all(
    not(feature = "std"),
    any(target_arch = "x86", target_arch = "x86_64")
))]
fn have_sse41() -> bool {
    cfg!(target_feature = "sse4.1")
}

/// Rosetta implements SSE4.1 correctly but made this exact compression path
/// about twice as slow as scalar in matched-process measurements. Keep the
/// backend executable for explicit differential tests, but do not select it
/// automatically for translated x86-64 processes.
///
/// Gated `not(miri)` together with the only call site in
/// [`detect_blake2b_backend`]: under Miri detection short-circuits to
/// Scalar (no SIMD intrinsics), so compiling this helper would be dead
/// code on `cargo miri test --test allocation_audit` (lib built without
/// `cfg(test)`).
#[cfg(all(
    not(miri),
    feature = "std",
    target_arch = "x86_64",
    target_os = "macos"
))]
fn prefer_sse41() -> bool {
    use core::ffi::{c_char, c_int, c_void};

    unsafe extern "C" {
        fn sysctlbyname(
            name: *const c_char,
            oldp: *mut c_void,
            oldlenp: *mut usize,
            newp: *mut c_void,
            newlen: usize,
        ) -> c_int;
    }

    let mut translated: c_int = 0;
    let mut translated_len = core::mem::size_of::<c_int>();
    // SAFETY: the NUL-terminated key is static; both output pointers name a
    // live integer and its size. An Intel Mac reports an unknown key, which is
    // deliberately treated as "not translated".
    let result = unsafe {
        sysctlbyname(
            c"sysctl.proc_translated".as_ptr(),
            (&raw mut translated).cast(),
            &raw mut translated_len,
            core::ptr::null_mut(),
            0,
        )
    };
    have_sse41()
        && !(result == 0
            && translated_len == core::mem::size_of::<c_int>()
            && translated == 1)
}

#[cfg(all(
    not(miri),
    any(target_arch = "x86", target_arch = "x86_64"),
    not(all(feature = "std", target_arch = "x86_64", target_os = "macos"))
))]
fn prefer_sse41() -> bool {
    have_sse41()
}

#[cfg(all(feature = "std", any(target_arch = "x86", target_arch = "x86_64")))]
fn have_avx2() -> bool {
    std::arch::is_x86_feature_detected!("avx2")
}

#[cfg(all(
    not(feature = "std"),
    any(target_arch = "x86", target_arch = "x86_64")
))]
fn have_avx2() -> bool {
    cfg!(target_feature = "avx2")
}

#[cfg(all(feature = "std", any(target_arch = "x86", target_arch = "x86_64")))]
fn have_avx512vl() -> bool {
    std::arch::is_x86_feature_detected!("avx2")
        && std::arch::is_x86_feature_detected!("avx512f")
        && std::arch::is_x86_feature_detected!("avx512vl")
}

#[cfg(all(
    not(feature = "std"),
    any(target_arch = "x86", target_arch = "x86_64")
))]
fn have_avx512vl() -> bool {
    cfg!(all(
        target_feature = "avx2",
        target_feature = "avx512f",
        target_feature = "avx512vl"
    ))
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
const BACKEND_UNINIT: u8 = u8::MAX;
#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
static DETECTED_BACKEND: AtomicU8 = AtomicU8::new(BACKEND_UNINIT);

/// Detect the fastest supported BLAKE2b compression backend without touching
/// the process-wide cache.
#[must_use]
pub fn detect_blake2b_backend() -> Blake2bBackend {
    // Miri does not implement architecture intrinsics. Its job here is to
    // exercise the portable state machine and wiping paths.
    #[cfg(miri)]
    return Blake2bBackend::Scalar;

    #[cfg(not(miri))]
    {
        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        if have_avx512vl() {
            return Blake2bBackend::Avx512;
        }

        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        if have_avx2() {
            return Blake2bBackend::Avx2;
        }

        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        if prefer_sse41() {
            return Blake2bBackend::Sse41;
        }

        Blake2bBackend::Scalar
    }
}

/// Detect and populate the process-wide cache. Kept off the hot path.
#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[cold]
#[inline(never)]
fn detect_and_cache_blake2b_backend() -> Blake2bBackend {
    let detected = detect_blake2b_backend();
    // Relaxed is sufficient: this publishes one plain value with no associated
    // data, and concurrent detection always computes the same result.
    DETECTED_BACKEND.store(detected as u8, Ordering::Relaxed);
    detected
}

/// The cached BLAKE2b backend used by newly-created states.
#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[inline]
#[must_use]
pub fn blake2b_backend() -> Blake2bBackend {
    let cached = DETECTED_BACKEND.load(Ordering::Relaxed);
    if cached == BACKEND_UNINIT {
        detect_and_cache_blake2b_backend()
    } else {
        Blake2bBackend::from_u8(cached)
    }
}

/// The portable backend used on targets with no accelerated implementation.
#[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
#[inline]
#[must_use]
pub const fn blake2b_backend() -> Blake2bBackend {
    Blake2bBackend::Scalar
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
type CompressFn = unsafe fn(&mut [u64; 8], &[u64; 2], &[u64; 2], &[u64; 16]);

// A zero-sized choice preserves the old direct scalar call on targets where
// this module has no accelerated backend. In particular, ARM must not pay an
// indirect call for an x86-only optimization.
#[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
#[derive(Copy, Clone)]
struct ScalarCompress;
#[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
type CompressFn = ScalarCompress;

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
unsafe fn compress_scalar_backend(
    h: &mut [u64; 8],
    t: &[u64; 2],
    f: &[u64; 2],
    m: &[u64; 16],
) {
    compress_scalar(h, t, f, m);
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
fn compress_fn(backend: Blake2bBackend) -> CompressFn {
    match backend {
        Blake2bBackend::Scalar => compress_scalar_backend,
        Blake2bBackend::Sse41 => sse41::compress,
        Blake2bBackend::Avx2 => avx2::compress,
        Blake2bBackend::Avx512 => avx512::compress,
    }
}

#[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
fn compress_fn(_backend: Blake2bBackend) -> CompressFn {
    ScalarCompress
}

/// Compress one parsed block using a backend already proved available.
unsafe fn compress_parsed_with(
    compress: CompressFn,
    h: &mut [u64; 8],
    t: &[u64; 2],
    f: &[u64; 2],
    m: &[u64; 16],
) {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    {
        // SAFETY: transferred from this function's caller.
        unsafe { compress(h, t, f, m) };
    }

    #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
    {
        let ScalarCompress = compress;
        compress_scalar(h, t, f, m);
    }
}

/// Parse and compress one block using a backend already proved available.
///
/// Free-standing so the caller can pass `&mut self.h` alongside `&self.buf` as
/// disjoint fields, without copying the block.
fn compress_with(
    compress: CompressFn,
    h: &mut [u64; 8],
    t: &[u64; 2],
    f: &[u64; 2],
    block: &[u8],
) {
    let mut m = [0u64; 16];
    for (word, chunk) in m.iter_mut().zip(block.chunks_exact(8)) {
        *word = load64(chunk);
    }

    // SAFETY: the function pointer enters a state only through `init_param`,
    // whose automatic path calls `detect_blake2b_backend`. The explicit
    // internal test/benchmark path is unsafe and transfers that proof to its
    // caller. `m` has exactly sixteen words.
    unsafe { compress_parsed_with(compress, h, t, f, &m) };
}

/// A streaming BLAKE2b state (`blake2b_state`).
///
/// `initial_hash` needs the streaming form: it feeds eleven separate pieces
/// (the six `u32` parameters, then each length-prefixed buffer) into one digest.
///
/// Dropping the state wipes it, the way the C calls `clear_internal_memory` on
/// every exit path.
pub struct Blake2b {
    h: [u64; 8],
    t: [u64; 2],
    f: [u64; 2],
    buf: [u8; BLOCKBYTES],
    /// Always `<= BLOCKBYTES`, which is what keeps the slicing below panic-free.
    buflen: usize,
    outlen: usize,
    /// Tree-hashing flag. Argon2 never sets it — `blake2b_init0` memsets the
    /// state to zero and nothing in this crate turns it on — but it is kept so
    /// `set_lastblock` mirrors the C.
    last_node: bool,
    /// Resolved once when the state is created, not once per compressed block.
    compress: CompressFn,
}

impl Blake2b {
    /// `blake2b_init(S, outlen)`: unkeyed, `digest_length = outlen`,
    /// `fanout = depth = 1`.
    ///
    /// # Errors
    ///
    /// [`Error::IncorrectParameter`] if `outlen` is 0 or greater than
    /// [`OUTBYTES`] (the C returns -1 for both).
    pub fn new(outlen: usize) -> Result<Blake2b, Error> {
        Blake2b::init_param(outlen, 0, blake2b_backend())
    }

    /// Construct a state with an explicitly selected compression backend.
    ///
    /// This is an unstable test/benchmark hook. Normal callers must use
    /// [`Blake2b::new`], which performs safe runtime detection.
    ///
    /// # Safety
    ///
    /// `backend` must be executable on the current CPU, as reported by
    /// [`Blake2bBackend::is_available`].
    pub unsafe fn new_with_backend(
        outlen: usize,
        backend: Blake2bBackend,
    ) -> Result<Blake2b, Error> {
        Blake2b::init_param(outlen, 0, backend)
    }

    /// `blake2b_init_key(S, outlen, key, keylen)`.
    ///
    /// Argon2 itself never keys BLAKE2b; provided for completeness and for the
    /// official BLAKE2b test vectors.
    ///
    /// # Errors
    ///
    /// [`Error::IncorrectParameter`] for an invalid `outlen`, an empty key, or
    /// a key longer than [`KEYBYTES`].
    pub fn with_key(outlen: usize, key: &[u8]) -> Result<Blake2b, Error> {
        // The C checks `outlen` first, then the key; both return -1.
        if outlen == 0 || outlen > OUTBYTES {
            return Err(Error::IncorrectParameter);
        }
        if key.is_empty() || key.len() > KEYBYTES {
            return Err(Error::IncorrectParameter);
        }

        let mut state = Blake2b::init_param(outlen, key.len(), blake2b_backend())?;

        // The key is absorbed as one zero-padded 128-byte block.
        let mut block = [0u8; BLOCKBYTES];
        block[..key.len()].copy_from_slice(key);
        state.update(&block);
        clear_internal_memory(&mut block);

        Ok(state)
    }

    /// `blake2b_init_param()` for the two parameter blocks this port can build.
    ///
    /// `blake2b_param` is `#pragma pack`ed to 64 bytes and read back as eight
    /// little-endian `u64`s, so the byte image is the specification:
    ///
    /// ```text
    ///  0        digest_length      4..8    leaf_length  (0)
    ///  1        key_length         8..16   node_offset  (0)
    ///  2        fanout      (1)    16      node_depth   (0)
    ///  3        depth       (1)    17      inner_length (0)
    ///                              18..32  reserved     (0)
    ///                              32..48  salt         (0)
    ///                              48..64  personal     (0)
    /// ```
    fn init_param(
        outlen: usize,
        keylen: usize,
        backend: Blake2bBackend,
    ) -> Result<Blake2b, Error> {
        if outlen == 0 || outlen > OUTBYTES {
            return Err(Error::IncorrectParameter);
        }
        if keylen > KEYBYTES {
            return Err(Error::IncorrectParameter);
        }

        let mut param = [0u8; PARAMBYTES];
        // Both fit in a `u8`: bounded by OUTBYTES/KEYBYTES == 64 just above.
        param[0] = outlen as u8;
        param[1] = keylen as u8;
        param[2] = 1; // fanout
        param[3] = 1; // depth

        // blake2b_init0 + "IV XOR Parameter Block".
        let mut h = IV;
        for (word, chunk) in h.iter_mut().zip(param.chunks_exact(8)) {
            *word ^= load64(chunk);
        }

        Ok(Blake2b {
            h,
            t: [0; 2],
            f: [0; 2],
            buf: [0; BLOCKBYTES],
            buflen: 0,
            outlen,
            last_node: false,
            compress: compress_fn(backend),
        })
    }

    /// `blake2b_increment_counter()`. The carry compares the *new* `t[0]`
    /// against the increment, exactly as the C does.
    #[inline]
    fn increment_counter(&mut self, inc: u64) {
        self.t[0] = self.t[0].wrapping_add(inc);
        self.t[1] = self.t[1].wrapping_add(u64::from(self.t[0] < inc));
    }

    /// `blake2b_set_lastblock()`.
    #[inline]
    fn set_lastblock(&mut self) {
        if self.last_node {
            self.f[1] = !0;
        }
        self.f[0] = !0;
    }

    /// `blake2b_update(S, in, inlen)`.
    ///
    /// Note the buffering rule: a block is only compressed once
    /// `buflen + inlen` is **strictly** greater than [`BLOCKBYTES`], so a full
    /// 128-byte buffer is held back for [`Blake2b::finalize`] to compress with
    /// the last-block flag set.
    pub fn update(&mut self, input: &[u8]) {
        if input.is_empty() {
            return;
        }
        // `S->f[0] != 0` — a reused state. Unreachable: `finalize` consumes
        // `self`. The C returns -1 without touching the state; do the same.
        if self.f[0] != 0 {
            return;
        }

        let mut pin = input;

        if self.buflen + pin.len() > BLOCKBYTES {
            // Complete the current block.
            let left = self.buflen;
            let fill = BLOCKBYTES - left;
            self.buf[left..].copy_from_slice(&pin[..fill]);
            self.increment_counter(BLOCKBYTES as u64);
            compress_with(self.compress, &mut self.h, &self.t, &self.f, &self.buf);
            self.buflen = 0;
            pin = &pin[fill..];

            // Avoid buffer copies when possible.
            while pin.len() > BLOCKBYTES {
                // In range: the loop guard just proved `pin.len() > BLOCKBYTES`.
                let (block, rest) = pin.split_at(BLOCKBYTES);
                self.increment_counter(BLOCKBYTES as u64);
                compress_with(self.compress, &mut self.h, &self.t, &self.f, block);
                pin = rest;
            }
        }

        // `pin.len() <= BLOCKBYTES - buflen` here, either because the branch
        // above ran (buflen == 0, pin.len() <= 128) or because it did not.
        self.buf[self.buflen..self.buflen + pin.len()].copy_from_slice(pin);
        self.buflen += pin.len();
    }

    /// `blake2b_final(S, out, outlen)`.
    ///
    /// Consumes the state — reuse is what the C's `f[0]` guard exists to
    /// prevent, and here the type system does it. Writes the `outlen` bytes
    /// given to [`Blake2b::new`] and leaves any excess capacity in `out`
    /// untouched, matching `outlen >= S->outlen` in the C.
    ///
    /// # Errors
    ///
    /// [`Error::IncorrectParameter`] if `out` is shorter than the configured
    /// `outlen`.
    pub fn finalize(mut self, out: &mut [u8]) -> Result<(), Error> {
        if out.len() < self.outlen {
            return Err(Error::IncorrectParameter);
        }
        // A reused state. Unreachable here (see `update`), kept for fidelity.
        if self.f[0] != 0 {
            return Err(Error::IncorrectParameter);
        }

        self.increment_counter(self.buflen as u64);
        self.set_lastblock();
        // Padding. `buflen <= BLOCKBYTES`, so this range is always valid.
        for byte in &mut self.buf[self.buflen..] {
            *byte = 0;
        }
        compress_with(self.compress, &mut self.h, &self.t, &self.f, &self.buf);

        let mut buffer = [0u8; OUTBYTES];
        for (chunk, word) in buffer.chunks_exact_mut(8).zip(self.h.iter()) {
            chunk.copy_from_slice(&word.to_le_bytes());
        }
        out[..self.outlen].copy_from_slice(&buffer[..self.outlen]);

        clear_internal_memory(&mut buffer);
        // `self` is dropped here, which wipes `buf` and `h` as the C does.
        Ok(())
    }
}

impl Drop for Blake2b {
    fn drop(&mut self) {
        // `blake2b_final` clears `buf` and `h`; `blake2b()` clears the whole
        // state on every exit path, including the error ones. Doing it in
        // `Drop` covers both, and covers a state abandoned mid-stream.
        clear_internal_memory(&mut self.buf);
        clear_internal_memory_u64(&mut self.h);
        clear_internal_memory_u64(&mut self.t);
        clear_internal_memory_u64(&mut self.f);
    }
}

/// `blake2b(out, outlen, in, inlen, NULL, 0)`: the one-shot unkeyed digest.
///
/// The digest length is `out.len()`.
///
/// # Errors
///
/// [`Error::IncorrectParameter`] if `out.len()` is 0 or greater than 64
/// (BLAKE2b's digest size).
pub fn blake2b(out: &mut [u8], input: &[u8]) -> Result<(), Error> {
    let backend = blake2b_backend();
    // SAFETY: `blake2b_backend` only returns a backend available on this CPU.
    unsafe { blake2b_with_backend(out, input, backend) }
}

/// One-shot BLAKE2b with an explicitly selected compression backend.
///
/// This is an unstable test/benchmark hook.
///
/// # Safety
///
/// `backend` must be executable on the current CPU, as reported by
/// [`Blake2bBackend::is_available`].
pub unsafe fn blake2b_with_backend(
    out: &mut [u8],
    input: &[u8],
    backend: Blake2bBackend,
) -> Result<(), Error> {
    // SAFETY: transferred from this function's caller.
    let mut state = unsafe { Blake2b::new_with_backend(out.len(), backend)? };
    state.update(input);
    state.finalize(out)
}

/// `blake2b_long(out, outlen, in, inlen)`: Argon2's variable-length extension.
///
/// The output length is `out.len()`.
///
/// For `outlen <= 64` it is `init(outlen)`, `update(LE32(outlen))`,
/// `update(in)`, `final`.
///
/// For `outlen > 64` it produces a 64-byte `out_buffer`, emits the first 32
/// bytes, then **while `toproduce > 64`** (strictly greater) rehashes 64 -> 64
/// and emits 32 each time, and finally emits a `toproduce`-byte digest of the
/// last 64-byte buffer. For `outlen = 1024` that is `32 + 29*32 + 64 = 1024`.
/// Here `toproduce` is just the length of the not-yet-written tail of `out`.
///
/// # Errors
///
/// [`Error::IncorrectParameter`] if `out` is empty (the C's `blake2b_init`
/// rejects a zero digest length) or longer than
/// [`crate::params::MAX_OUTLEN`] (the C's `outlen > UINT32_MAX`).
pub fn blake2b_long(out: &mut [u8], input: &[u8]) -> Result<(), Error> {
    let backend = blake2b_backend();
    // SAFETY: `blake2b_backend` only returns a backend available on this CPU.
    unsafe { blake2b_long_with_backend(out, input, backend) }
}

/// Argon2's variable-length BLAKE2b extension with an explicitly selected
/// compression backend.
///
/// This is an unstable test/benchmark hook.
///
/// # Safety
///
/// `backend` must be executable on the current CPU, as reported by
/// [`Blake2bBackend::is_available`].
pub unsafe fn blake2b_long_with_backend(
    out: &mut [u8],
    input: &[u8],
    backend: Blake2bBackend,
) -> Result<(), Error> {
    // `if (outlen > UINT32_MAX) goto fail;`
    let Ok(outlen) = u32::try_from(out.len()) else {
        return Err(Error::IncorrectParameter);
    };
    let outlen_bytes = outlen.to_le_bytes();

    if out.len() <= OUTBYTES {
        // Rejects `out.len() == 0`, as `blake2b_init(&S, 0)` does in the C.
        // SAFETY: transferred from this function's caller.
        let mut state = unsafe { Blake2b::new_with_backend(out.len(), backend)? };
        state.update(&outlen_bytes);
        state.update(input);
        return state.finalize(out);
    }

    let mut out_buffer = [0u8; OUTBYTES];
    let mut in_buffer;

    // SAFETY: transferred from this function's caller.
    let mut state = unsafe { Blake2b::new_with_backend(OUTBYTES, backend)? };
    state.update(&outlen_bytes);
    state.update(input);
    state.finalize(&mut out_buffer)?;

    // `tail` is the part of `out` still to be written; `tail.len()` is the C's
    // `toproduce`. Every split below is guarded by `tail.len() > 64 > 32`.
    let (head, mut tail) = out.split_at_mut(HALFBYTES);
    head.copy_from_slice(&out_buffer[..HALFBYTES]);

    while tail.len() > OUTBYTES {
        in_buffer = out_buffer;
        // SAFETY: transferred from this function's caller.
        unsafe { blake2b_with_backend(&mut out_buffer, &in_buffer, backend)? };
        let (head, rest) = tail.split_at_mut(HALFBYTES);
        head.copy_from_slice(&out_buffer[..HALFBYTES]);
        tail = rest;
    }

    // 33 <= tail.len() <= 64: the loop only ever subtracts 32 from a length
    // that was greater than 64, and the first split left at least 33.
    let toproduce = tail.len();
    in_buffer = out_buffer;
    // SAFETY: transferred from this function's caller.
    unsafe { blake2b_with_backend(&mut out_buffer[..toproduce], &in_buffer, backend)? };
    tail.copy_from_slice(&out_buffer[..toproduce]);

    clear_internal_memory(&mut out_buffer);
    clear_internal_memory(&mut in_buffer);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::String;
    use alloc::vec;
    use alloc::vec::Vec;

    #[test]
    fn detection_selects_the_preferred_executable_backend() {
        let expected = {
            // Mirror `detect_blake2b_backend`: Miri has no SIMD path.
            #[cfg(miri)]
            {
                Blake2bBackend::Scalar
            }
            #[cfg(all(not(miri), any(target_arch = "x86", target_arch = "x86_64")))]
            {
                if have_avx512vl() {
                    Blake2bBackend::Avx512
                } else if have_avx2() {
                    Blake2bBackend::Avx2
                } else if prefer_sse41() {
                    Blake2bBackend::Sse41
                } else {
                    Blake2bBackend::Scalar
                }
            }
            #[cfg(all(
                not(miri),
                not(any(target_arch = "x86", target_arch = "x86_64"))
            ))]
            {
                Blake2bBackend::Scalar
            }
        };

        assert_eq!(detect_blake2b_backend(), expected);
        assert_eq!(blake2b_backend(), expected);
        assert!(expected.is_available());
    }

    /// Every compiled SIMD compression backend must agree with the portable
    /// function for arbitrary chaining values, counters, flags and blocks —
    /// not only for the states that happen to occur in published vectors.
    #[test]
    fn compression_backends_match_scalar() {
        fn next(x: &mut u64) -> u64 {
            *x ^= *x << 13;
            *x ^= *x >> 7;
            *x ^= *x << 17;
            *x
        }

        for &backend in Blake2bBackend::ALL {
            if !backend.is_available() {
                continue;
            }

            let implementation = compress_fn(backend);
            let mut seed = 0x243f_6a88_85a3_08d3;
            for case in 0..128 {
                let mut expected = [0u64; 8];
                for word in &mut expected {
                    *word = next(&mut seed);
                }
                let mut actual = expected;
                let t = [next(&mut seed), next(&mut seed)];
                let f = [
                    if case & 1 == 0 { 0 } else { u64::MAX },
                    if case & 2 == 0 { 0 } else { u64::MAX },
                ];
                let mut m = [0u64; 16];
                for word in &mut m {
                    *word = next(&mut seed);
                }

                compress_scalar(&mut expected, &t, &f, &m);
                // SAFETY: unavailable backends were skipped above.
                unsafe { compress_parsed_with(implementation, &mut actual, &t, &f, &m) };
                assert_eq!(expected, actual, "backend={}", backend.name());
            }
        }
    }

    /// Exercise the complete streaming and `blake2b_long` state machines with
    /// every backend. This catches mistakes outside the raw compression state,
    /// such as selecting a fresh backend for the extension chain.
    #[test]
    fn full_backends_match_scalar() {
        let input: Vec<u8> = (0..=255).chain(0..=31).collect();
        let input_lengths = [0, 1, 63, 64, 65, 127, 128, 129, 255, 256, 288];
        let output_lengths = [1, 16, 32, 63, 64, 65, 96, 127, 128, 1024];

        for &backend in Blake2bBackend::ALL {
            if !backend.is_available() {
                continue;
            }
            for &input_len in &input_lengths {
                for &output_len in &output_lengths {
                    let mut expected = vec![0u8; output_len];
                    let mut actual = vec![0u8; output_len];
                    // SAFETY: scalar is always executable; every other backend
                    // passed the availability guard above.
                    unsafe {
                        blake2b_long_with_backend(
                            &mut expected,
                            &input[..input_len],
                            Blake2bBackend::Scalar,
                        )
                        .expect("valid lengths");
                        blake2b_long_with_backend(
                            &mut actual,
                            &input[..input_len],
                            backend,
                        )
                        .expect("valid lengths");
                    }
                    assert_eq!(expected, actual, "backend={} input={input_len} out={output_len}", backend.name());
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Ground truth.
    //
    // Every hex string below was produced by compiling
    // `phc-winner-argon2/src/blake2/blake2b.c` unmodified against a small C
    // harness and printing the bytes; the tables were then generated
    // mechanically, not transcribed. EMPTY_512 and ABC_512 additionally match
    // the published BLAKE2b-512 test vectors, and KEYED64_512[0] matches the
    // first entry of the official `blake2b-kat.h`.
    // ------------------------------------------------------------------

    const EMPTY_512: &str = "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce";
    const ABC_512: &str = "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923";

    #[rustfmt::skip]
    const SEQ_INPUT_512: &[(usize, &str)] = &[
        (0, "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce"),
        (1, "2fa3f686df876995167e7c2e5d74c4c7b6e48f8068fe0e44208344d480f7904c36963e44115fe3eb2a3ac8694c28bcb4f5a0f3276f2e79487d8219057a506e4b"),
        (63, "d10bf9a15b1c9fc8d41f89bb140bf0be08d2f3666176d13baac4d381358ad074c9d4748c300520eb026daeaea7c5b158892fde4e8ec17dc998dcd507df26eb63"),
        (64, "2fc6e69fa26a89a5ed269092cb9b2a449a4409a7a44011eecad13d7c4b0456602d402fa5844f1a7a758136ce3d5d8d0e8b86921ffff4f692dd95bdc8e5ff0052"),
        (127, "b6292669ccd38d5f01caae96ba272c76a879a45743afa0725d83b9ebb26665b731f1848c52f11972b6644f554c064fa90780dbbbf3a89d4fc31f67df3e5857ef"),
        (128, "2319e3789c47e2daa5fe807f61bec2a1a6537fa03f19ff32e87eecbfd64b7e0e8ccff439ac333b040f19b0c4ddd11a61e24ac1fe0f10a039806c5dcc0da3d115"),
        (129, "f59711d44a031d5f97a9413c065d1e614c417ede998590325f49bad2fd444d3e4418be19aec4e11449ac1a57207898bc57d76a1bcf3566292c20c683a5c4648f"),
        (255, "5b21c5fd8868367612474fa2e70e9cfa2201ffeee8fafab5797ad58fefa17c9b5b107da4a3db6320baaf2c8617d5a51df914ae88da3867c2d41f0cc14fa67928"),
        (256, "1ecc896f34d3f9cac484c73f75f6a5fb58ee6784be41b35f46067b9c65c63a6794d3d744112c653f73dd7deb6666204c5a9bfa5b46081fc10fdbe7884fa5cbf8"),
        (257, "d8bfe068de0b4f9fa876a3f8024eb9f7b0029fd5dcf251199e065cee89e1a282c8dbf0442f2ade7294ac1c6be19b388dc990c34d8cb79f5f10c54fa813834fda"),
        (383, "6af23f91ca3ca49b5c8267ea6e6e6597d34b0ae22d17634d2f48e6877f92809cc0a4f3fd9344ce154814493bd35c776923f9492e3733ac8cbc600e963dc78257"),
        (384, "49b3d01a1f21431d4a9b65e0450bb0444b7d1deb81131d650d9cbefcad7436a0e51050445af39f3f1312dbe3e2d03601ba309d3bc3c46bc5bdc768feebe176fb"),
    ];

    #[rustfmt::skip]
    const ABC_SHORT_DIGESTS: &[(usize, &str)] = &[
        (1, "6b"),
        (20, "384264f676f39536840523f284921cdc68b6846b"),
        (32, "bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319"),
        (63, "eb5324bb0b0f9ca27381f22f5e49604d7c341b77371fe5bf61fb643c8ab481c7555ef17c9b9e7c92f0daafff6c0d748cab97d2b267bf53f8225c173ea26f3e"),
        (64, "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923"),
    ];

    #[rustfmt::skip]
    const KEYED64_512: &[(usize, &str)] = &[
        (0, "10ebb67700b1868efb4417987acf4690ae9d972fb7a590c2f02871799aaa4786b5e996e8f0f4eb981fc214b005f42d2ff4233499391653df7aefcbc13fc51568"),
        (1, "961f6dd1e4dd30f63901690c512e78e4b45e4742ed197c3c5e45c549fd25f2e4187b0bc9fe30492b16b0d0bc4ef9b0f34c7003fac09a5ef1532e69430234cebd"),
        (2, "da2cfbe2d8409a0f38026113884f84b50156371ae304c4430173d08a99d9fb1b983164a3770706d537f49e0c916d9f32b95cc37a95b99d857436f0232c88a965"),
        (3, "33d0825dddf7ada99b0e7e307104ad07ca9cfd9692214f1561356315e784f3e5a17e364ae9dbb14cb2036df932b77f4b292761365fb328de7afdc6d8998f5fc1"),
        (64, "65676d800617972fbd87e4b9514e1c67402b7a331096d3bfac22f1abb95374abc942f16e9ab0ead33b87c91968a6e509e119ff07787b3ef483e1dcdccf6e3022"),
        (127, "76d2d819c92bce55fa8e092ab1bf9b9eab237a25267986cacf2b8ee14d214d730dc9a5aa2d7b596e86a1fd8fa0804c77402d2fcd45083688b218b1cdfa0dcbcb"),
        (128, "72065ee4dd91c2d8509fa1fc28a37c7fc9fa7d5b3f8ad3d0d7a25626b57b1b44788d4caf806290425f9890a3a2a35a905ab4b37acfd0da6e4517b2525c9651e4"),
        (129, "64475dfe7600d7171bea0b394e27c9b00d8e74dd1e416a79473682ad3dfdbb706631558055cfc8a40e07bd015a4540dcdea15883cbbf31412df1de1cd4152b91"),
        (255, "142709d62e28fcccd0af97fad0f8465b971e82201dc51070faa0372aa43e92484be1c1e73ba10906d5d1853db6a4106e0a7bf9800d373d6dee2d46d62ef2a461"),
    ];

    const KEY16_ABC_512: &str = "4c76bc7ad0fc52e4bde231b38727c331172cfe3eeaf10cd2fa5c65abbdb8faeaad2da338531b382ac103f10ccaf41f74d8870d016c48b269c0d9a5cf5752c8c3";

    #[rustfmt::skip]
    const LONG_EMPTY: &[(usize, &str)] = &[
        (1, "88"),
        (4, "431894c5"),
        (32, "547578a45cc5d4a6e6ad0b59905a85e08527c2b1420604e157772e7bf02c2672"),
        (63, "dc0d3ff9a4218744635fbae40331d1e69bf28200e2a268c722b8e10256ce8f75956f8f0481f99dae0ca012527475952d63614424d71e7848129d9947140c39"),
        (64, "7fedd5af05184f3700cb1986bf39663bc06501e6455da2b643d47bc1c01302bea32e4e9ec6b29f4d151c6348788b59d4e02e69e4199a886d5b36fc3e5200ab04"),
        (65, "8e8b922d272035d878f074418dd8fadac41f5865ae0dc5066383237e85104c776bcad5ae3396429e5048b46920bc0d7ad39ccbf77d99aeca1fe4702407b8603cb0"),
        (72, "e6e2acf2db332da1bea83127d5fb3f8aefbd9d1307efe4f09a813450828b782a157773321d11891262adfb5d1143bcf1ce3c50f7e453b0fcf2c36e08bb0480a8ec5fe940f653191d"),
        (96, "2933619da44b6063c6ad2f7e7caf776e62c3d5cc563e7c441cb33ec3274ef6c8b2755787b8ae7343ed71089edac2f1f07af6e830fe875a3ee6977bf71c8f8e45b0cb0ca86f192a71bf186ef9044c8022f828e1de4a1883282ea4617ffb950090"),
        (97, "bbc187c6e4d8525655d0ada62d16eed59f3db3ab07e04fb0483fd4ae21d88b980947a1cf35bf02acf14d5cd7587598b710c421f79f6538692f3cb9d8e8a3532b0a40bc2db816471ac4d29bb3908b4d76ffb2b6cc465720242985ac7fba5634873a"),
        (127, "e547a0bef8c8fa5f56835b345361b67798b31bdea276c15ce8e85b28cf4f3c9f9dc6bf1a5e8bd98aeb7357c08b4676c5470dbfeffc1f02aa59a75c2635e60e8584b718a3062fbe95c7389e1f2a039b410ae89d0d98b532e1b1e8d55a15bfde6e2e7c0a736e510a121c9583e6fe88b7fd53fb5702bb111eca534963b98eb11e"),
        (128, "b29368bb02ce0ae43090fe9aae30fb003364b966dce7007296855bbe48c4bacfdb0b66313b1b6d1445ec8f738605f82d14d1bdac5c08a3e82e5af784071c6390b8c1bcecf371bbb2b5518bbc3819b0bde7b4d1584fdf3a0160fcd94c4cb321ef8596457211899cbb5d60dafb837177151fe257d44642c8b6b28909c3a8272ec7"),
        (129, "dfb78002c8bf1fa06b57e467781f9ba22d9905fd141102c7fc20b4d2dbd39a594e25803dbbba9059c9dbce98c146902f92e8b416c6339d4e6f12d94659a545fe5cb5bde3e818926cd127e8a716ed36f845af0512a80c683193d85762e2c6b3328cc57a75b56be044869047d45184857df32585645bd643bb2b37a75d4352602c14"),
        (1024, "845b3c40f4155e5f90e2b72ed952c88d976b45ccdd74d419cea79a6ae874a0170481acf57ad997333f407aa75655962ef2041f129406aca1b0e03ada5e43a21e83a3c04f04af6603100772c73497d884d01ef8ad0bc756973ac54fb564516844f7dc5eb12af3240c937af768018fed5ef81da41a1ede4e2f22b82c635979a6f619d66b96d82a4b2ff6917b0c889e7c2f87dbdb98ad5d5c33f7def3962f280ea3f12f2856b0bcf3c755f761c5c076af39f73a1bc0d7c333b21655af1917dc8fb32294168224fd49712606dc5aa95dcd92d59109d02f9aeb7c3ab01017aadd0116f4fbd0ca6b8a451b66c42229cc0ceaefb29de10b8c1f26d4a87d2bc6848c859857d34920dda2140822055a7decdf1cbb9aead07cec689d891972aa463bc3677f3885dc78d91b3ccfd2137ae02a16716c454c8a59fc287afe65f95d3e238925e50191a49d329bb601b3d746ac1fd8d5f4c5983015b7760b7bd863d4d7c92152fdffb60df7c7194d7f39326cc67bd1d83204d4999f4a9e5cde6f7c8fd5bd343d0490bcb917c011ccd6f1c167b22bb3a3488083965677ee135945815f467d0bb7201a35392154e57c52750b98a7a9fca0d0789f4863c494ca1b5474f48cbda149d6a62e5c1bc087f6ac831bb32df43b5e66188dff97bb7f89f5e92c219c830450935c60a250e3ba1cc5e14f24003694cefb30219c241097f61a2110f1848e7f194ef6bb27a110c2db9b54d75909a77fb857ef2bb1a6b36a5e2a20bca79549fdfa9e668cadd0cc82d23cdc6d75cf65932a6a34a6bdb07a5ca54e16410ac0414ae9115ca776667add778094f313a3ebed2707043cbe4994846eb9c725df1cb84a42fe1311cb781408b4bb8e5645348f1fd0565005f8e17a36dcc4f12d473f600521c9dc8eb3aa495c80e9ad2b1d80e328116f13c3d0fd4cb5ec4e508fbb802368febdea52abf93dfd8aebe937b8435c01a5c701ff5348f0290b89ea2fde8f7b16c9713e8c6bdcae3bc69f73de3e3a16b4ff3d17c4b2d922d37036b5703ed3031bae4ec1abfc8bc94facb4202474acc3c659754beab08bbc5281e9b467f75c7cc5db648d7c2a566b6e95567d2a7acd70646859e243278238bdb279f1c0c16d943c230a0f56d0b74c05266a6996ac791f3e2a8e1e90b31330599cc9fc8d2973fb93535b560cca2f15208f9259c08982a81b9f0612cf42ea8c9ef613d2a7a44c4bf5debfa0d8b6ef7d0b6a858892e1be00a794540f6c227573c20b2bd7cef2a8a71c16a3592b6f7ab381b7b2545388f3879a1c81c05383242b8776fe4db9d8cc064702111796828c400609b6a7d247198c1867a9937ff9a2913f16a58b5f9c4451d853ce9b602763319df8b4911c8cf62901232768b3a5fe6323d85deac32ea6bc96022cd65eac1c760427c23c4da56812651b7e123a8a4a16ec794db78a0f5f8f107851"),
    ];

    #[rustfmt::skip]
    const LONG_ABC: &[(usize, &str)] = &[
        (1, "79"),
        (4, "3e6c02ac"),
        (32, "6cfcbf5d43e547674bfbc009070570bcb84e272d359c1e9277e416d74cbbe1c6"),
        (63, "dcb6b07bc6dc2bc0095962ee05ccce1905972d78956e7118b050166e21d7262eea5924bcef9b3efc50ec39e6cae5edf759e9979d7bffb9898356e3a76b83ab"),
        (64, "f32577a3172f56657d531faaa43077bb8c9726ada7bb04dd337ec5a65454abff241ad6b87a72440e5127c6f9caa70327f2a699096e52d163eb52d9cd99620593"),
        (65, "77baa447fe6f777c9bcb519545ce80badaf08ecb973fbb4ff45af7d8b569ec7caad65f72669d05153cdeaa563a162bb5ae4c42214551593816008dc560c5a65391"),
        (72, "13ac1def3e362ae0a78cdcb810a81885c95926cabee9dee40b46f9fc31cfa58a3e4e098a7beea541ca0b9002f89434898fc85990e937d91ddd70754b10d5316ad4fd8cd64564db92"),
        (96, "41b5590d909a09f99c2c5475f782ba721397c7dc626736a3b5b0b369bab78af24a800ffd07bd9b94e073fe5451b20caf770b68afe0839842b4723550bdf083cf9e205e5304aaec1584f10008285f563252fcfcf207ca8c755d1652168b9024af"),
        (97, "c82ccb541fdbecd1ce8090f61f39905cbf4bc03cebd133a002c7babe4ea204fba111552004c5a5338c62d4c7561af5de2665d24d30de9407b9ba1a6ab372054d3e6fdd0c7aa46b48980189af43f3502d68d007a02b1c4efe04c13b9f39d932f335"),
        (127, "29519d9954a0791d76c47164bbedf2f4fb71a7742dc15073cbb6b5daf34adb2f8d5ddd992dda0f1abbb46838676e2e7340bc82510f3f71e97982400b085024553fcaa92f91f31442c5084d3ecd03728597818c3b6fcb1ec9dd660aa5773ebc21626d5467972bc349a08c866f4f6eb3a5f944a76ca22d39bbabcebe565cb98a"),
        (128, "e03f682135fde8cb7caea3c8ad7c0a7e78efb026e119732d27b1eea7ba92335a7eb8825c755809add7833e7f75e7a5915bb1b3e70eca7b61bec34cd8c486f8005b05f94166103045f120f568fa1952f24e2a032a35d96e5a61fe520090178a4b60490d839f773b71f88589442d94bf5614c401e1a49b7d4d6e34782c0130e1c2"),
        (129, "81795998330577749c80da69a830b48e222555c721afd94d76dd0f9f2f6c6d18a441f42634e58d17da51d9979ae5638530dbe5db52b33bf8b3f4c3bfdd00287d055c3c4ac752f4996544c83253ee7a663a3c42b8e547d1f0a83bb34eb93aa12215687105cf925cd8d26b794b9ba4eefb3a1eea534a48be42894ddd5de35f354e4c"),
        (1024, "4038a0ea5c85fa5a0ea62fd668347bd44afd8da63438fd92fb08bee04dbe89ace70e7b8f4e9379b208c138b444e4434164437f03da914150722aaa902eb35fa0e710cfd7239e719b99c987f6b3d6f068d76e949c68084e608d280634fae1ea8423d431b6fa6c8b9b73f5343ea98aa27b95dc901e6e237a10251620aee94ee5b1d29651f228c8ba90ca3600c8e9f5b273f1a3dd9c011222db6085a566acf250cb07268dd47a4dfdc171b99f571dc84a38dd7ae4cf6b7b3c6581c9625b27bb4a0bcca537a34cd7a8f78e0c050f0089a25c5d2cd72de4f96ee451796df7d0f116591a8b33b0ee5105df5b4ff5c372cac6a1a24fb3ede74fef08f9b9f75d5ece43f4904461a3605cba1841daadeb1bf81e94807d99d4892c8b8a3b088584695d7bc39b29d467db4fbf09971598fdf02e23bb42c2aebb5d70ce213b12e4d330b2121dde4a548c0d62bfde70ad51cd06a51181d6df33fe65aaa55fd0a4f9c25e3f8f094848c05158bf47d8f05b204527a3064d190ef4813a97c404935ecf04244075c5c8370cfb0a6ec66479a10534abe3195a95b0875e813674e6f0bd6b11ad3890cafe09740b3aad45e7629de7324fc94e76023fca6dda84a1f1eefd751234e6d6d7de72666ddb84cf0d5e2a42505f3125439926c8449da9b67ccfc16892509901c19dc32595db48866951281e91c3973295a6ab375b54233c9d0441c081b0ba8074b816b59742042198a38a519ff06a2430edd4a9ba9b8fb874f9a895973877e5a2207c86a0f78cf952188337c2bc608974040c149e355e23315a338dd64f27bee9faff79fec5e5234ec52ffeddcfbd81d2c3db2888f36ec4199a730db5befbc30e75833240999ad8f9008eeab8ac6989a5ede8f46e3190ca9aff38717aa52dbc73b609b89a6b340355e6f5f81b95bf8e54f8a69f4e2bf95bd4c2e438589e4ffe2e91f286e40f78fb5972405ad546178ca1b91908a03ebf04228665d2313ceeff42a14cb8c1105731142398cb39aac140f5bbcf64514c5b33f31f27142ac08ea189dda4124f05221fa80fae12ee8fcc476e16af15b83274fcf98ffb29291ba1adb22ec944a0e8aef1dcca32545fd8751a07ed61d071ac735e782909e3a210d9b4262f0b6e5923a034985bf81aa837d76820f9e6cbb3e17eca941c0512ddca18c4b173e89390fee8407c903a6f8ef19460d0f800155cbb95899b828f21a09cba10a6464790ee766bfbd3a43be7594678a994d950a82aac89e24c1ab0fad8c364de19d2ba1a92663f4930d13b9b8a7fbbdac83bb74c4f9ba25a0c53aee93ebaab93e677c67f963eeefc06666dbe499222c1eccb16ab17de6533ce3336aa329bd4af8a09b19078a98dd48ef08da6762f125e673682d8822123b6d0fe99c97fda5e58406c64c157c76bb0a4bd1fc3f8fe819e96fbfdc50ba0194abc940ec7cdc9fff8a0"),
    ];

    #[rustfmt::skip]
    const LONG_SEQ72: &[(usize, &str)] = &[
        (1, "fa"),
        (4, "ca513e0a"),
        (32, "36592a3c3e0dfcff6e0efcf362b2a8e68eb0a1563c041ba4272309536ae39b47"),
        (63, "5352b4a8ebcc8d25cfbfcca3226d9ed9567deae28f887ebcb9707534f83dbbad521370e0665dd1aa052b9f2086c72c1196fe325082d221edee0b3668ebac82"),
        (64, "2c6f5fa62d9b0549bfaae2b39e99afca0e624754e43f71bf8b2df8ead7151e3694fb51c7b4ec6de9b4f66426863ce4a520d7f84db5051250f5b4181f04aa4949"),
        (65, "9321f69a406e6ab17f116b5bdc619b9e794806601069888795e1e36eb382839f6189ffa17b35028daabbc9bf1db409643b9981fb4bb1764fb33325cdb6deafbad6"),
        (72, "906f3255cf91dc0af4da3697e8d7f1e5e1898157e63cd3e5c5de65a52130e486134b8c5598b255b83a48ac1826fc4107f60bd5adaee8660aa92df8612817463d0f15a00ba0e5fde5"),
        (96, "fb57485ec7a6d6c983353a051998d1ab68014821cca42c53e4c99ebe828f880f155105341c88adc44ff28118362581b73c5d4a65cee3a2d7dfb0f74623a0451220f27107948a281513191a0aa327bfd816d6b46be21d3237b7377cfe7174b11b"),
        (97, "e712e0864d944a484faef1107faa299d64a416d4b0348c560fb0e358488910571c63f872540695b85212a4b39f438b3c1ad21ed4148db9232c0bfa1231e04519a81c3ac662ffae2219b320d4a29c15760633ec7a3b04d69c96542016ce5e7aea80"),
        (127, "bda04620f38590a5a2a218564c97544a6572828775ea75d961b5c3ddfaeb769d38631639eceadb0aeb0def8ba5617a26a9aa88682cdd323428def92841d7edf2eb3375c29f24014e9c75a07c176528d102c8fa9ae28d7d6ce190cde38b943b12a4a8c1337fef010f815ab2cf25222cef2a9b9a451f1163288bf5add7a18495"),
        (128, "28739f1ddc548d8fa52f866c2eceaea11c2ea05d8e17f184df19bd2dc8210fde317df70bdaf91a1482ecca54d5b9ef0557bf817c41cc528257f25ed633ac6938e5b3f417606fe55559f57ed67d6accf9e32131348cdbb073896a6452405c9b83302800ddce561f96f4bb56f489338f0958e142aee3d326caee27fbaacd33fc27"),
        (129, "cae345ac89bc5a3cc819e2b9aae53f06a49c606b1de4376e30b23929d239ff046d92e34a1a6eeb3e1f474ed212b545d76aa1e4d88af7f17326a8ae255bdf9582a5692934d3016ab0f7fe78f95a8bd3db1da1678b0a78a636ef91914b53765313095247aa29a410522e3a060254c7b285243e34e049864bbdf4f3518aeb676cf5b7"),
        (1024, "d5f4c304b4be42af53855c080628693f4c741bfe3378766e5dd6b78097ba90b7140c2f3dc0960ae214ae1820dd8b008839ba2ebce72d123662eef7bd75204b3f4a9eea9a2e4a33637bbe28d1bb8d3b201cd85b324ccb5da17e2dccf1efd6d28be4159259adfce532dd62a973cc3c98c60547aabcf6abcb9283e30e581ba7e19f4c702faf54759a6aad67e950659ab8c9a5041a9c76e58fcb3a28ca9f43a280bee1d7cc86e0af6f890285e24e989d4771fdd8177cfba4db926f5938b8da89a85dc7fc312fda86a60938b6691da0ce86a7a6f8445bf0fd0cf49aefe39d476d7c91ab92e93339e887180d4e081cda235fcb39be7369a2fd73f21481ca305d2ba0e32caa2c464a109dc3e14062ea2d7a700b4752c31a8cc504d91289e46776f8fdeb4042e6de3f90361b5de27dacd4b6404154350e83570d06d0092de308069c1d58cb9a9dd2fce2f98cf73b1eabdb207b47136c6215e3a51b56d3a9078c0b92e2ba6848e4596636e45f0f074941adfcf5a7868ccdf97b62aa3a74b0d4ecc4ca4a25aaa086ec2b741ddf38637d0b88db86348917480c74871588cfe8a73d8911068b070081d8b88201791019b45da05f082cf21019963ff08104d73876c8b654451e4ad62b9accb64d6c8f5a8c7bb32ac1aac968ac48b95fc116b563244d7c64afd05a64acab82b9affb43357cfd430404113717baff8fc1cfb258315d9764f911c88914d976475f0e97d4d01d553c2394b00576326f1268e1e84b14750349b07e260177e3e84b779e201a50668d1957b608dad8422477d1785c71cd3ae7ca97957fdb2777c15328d4097c3108cd697f8933854c9e6a16f8c49ab0323bf24284ad57b0ee3852ffdbd7b7f05836c5910aec4c2cc7ec71b613b0fed9a816ad079b37de526cd0eba925f86932d59f84535e7f5d12fc14b2776cf09d34d1e73e5762255fdfca677e4bca438b6527e3bbfde8ba590e64373d46cb26c7e6cf8636925ddd8b5e509a69640d03e1fdb4e95321f7a195487544906f39e00fcbded63a9c3a88f1acb72f44b9a804c80338c777292b040ad175581a8e76d58cbae7240754d0d8aef79321447da39f556edf32003d160faadc579692c982d0e85146e5ca1909ca42de9d2bc11538f81c525866cd6c5019319cb3f44e5d97f915ca3a8ae53337d7d90c03cf00ea2986aebc3b141e1e9f78e9f1f58e29e5a5b1c2622c0ee2e8d12a9945d8b58ac43d8d9aababa1f93d1bcb640eb5e51aafae9873f3ccd25d784ccc8aec4f7a864295b50fff28b2c4f994f8f92d7c14475e284b2fbe6cd2e04a2f9ff5f0cd002a64ec3c66e8565dd74fa8d16a54e35d393c7d50a05f0f36ed0dc7b70f8907c99865757af2055714c4c695cd3c8bbe1cb4028d0bcb444f3561445356ebd40c3ba6acc9446c5942112fd8911f41fbd98ce10f4a9415476b9336122c9127"),
    ];

    #[rustfmt::skip]
    const LONG_SEQ1024_IN: &[(usize, &str)] = &[
        (4, "b9c129b4"),
        (32, "6d65b7906fb326296197c405be7dee4c4ab2b6e40d4a959b99ceca5dd907275d"),
        (64, "7cd0c105b0a21a9f0f03ff8b3a94d72c58898ab95d904d685b02314aeb94ec4a587caa362abf5c4ec14732f590b304153bb2b0198200b7b334398be40fac7fb8"),
        (65, "adad4ba5075f72879db895fd08670fb41fce21d2e45e502f16b16d293d802d39ec97836223e8137674097b08ebff26b52456e84d461f1b68009d59ff0bd8c5806b"),
        (1024, "53acc9238374ecbd78f622b71ced7e0d62c200a0581d1be678330f3b924ae12ec932bc461d07e53072da275b4826828588c077e0dbdb8814d151a1abcbe8ffaf8f3444a17f9ca7c783867763942c931a715b2e9d91af4ebaa3b27ef3142f2c373eb38e1638efc3580ab6acd7b4f95ab05370916142fab304238408ae13049818d9ed5486c4e6ef801e7e210c39815a3daf4d07a02f7183a92a3380fc329ed4e5fb4f0f398bf8b53571accadd084458d6b681c5d34b0749aed210c85f0f96df6b250d470a46f99a57ebff9fe6037c1d3012f4f9dcfd0bf541f3aafb22a466237f62978526e5ff94a21daa12c662c4f468167e942ab3a1a257c3e5e61f7df0951867f4d73e1728c4fbb3e7e22569e1f41511e530652fc5b369c6a6154ecbf4bf0133c27fa18820cae10681748548fd0b24c7718834c273efcf8ee2dc430029a5af9e71d83f0e5dd97db328c6606c947c50435b091ca956e2017d0bb8dc95c59d787fbbf62796447fae7cedc2d7adc7e26212954a527991c36726f0c0b389e9389bfb065cd5ebb8ffbac8e7dcd44d0c6a18bc25c0bb7705253ef6c130dd19be2c7ffeec1f83edab0f94a132bed6debdf6186f025b7d209f8e5391a707870d6fa87790ba3b29f8f9b2b0d4606dbe709b4a544c4fb685351e170870336308d601900c346fa0488b2f0c48dee77ee9e1a4e5805004870b7719df90840994a7793a20187cc6aa8f5e0927e43102c6d260bbbd8750a5c4873e595a738f47a18f68cea2e92ff6b62301d25d5b57cbb484c1ea5ec44f3c1bddf8bda3b1de0f62cfa5543a69c086cfd4b9cbccf0c14040973f2c8fc90e09d2f0a089463101c1b49c2a179d72ef0d2910e158d4caa706c7de2aaf23115ea7c0ba51de990eba8f80c849834d9640a0fdd8975b6ee50c0774cd4fa8a84b35d6159acd325fba6540ff6e5387b7dfeb499d3cee87e4650823457e59fc51eafdd888d8413f833abc28af35713c355381799d58b46d9caeb8235b466827fc952acd70926677f73a65239a9a4b9f42ba48250996c08080629ed749df15ac2e4334107e7ffd6916ec301717c0e47a3fd060f12f2fd8b863a720316b1ec65282d0a57c908eb0095a09f99c0c69acd66772c346d3ce325222b24cef45ca80302263e7f3e5f5bbddf194d81e542fc51540f7eaa7e4d9eca93b57c238b1f283b4203025d55cde0330a14ef84dc8bf656095045cae80fcbb25b8f05a7bc099d5d379ce5bad52429613c6ff193b01b620df850b82bec94f84a0d5a7c1523207bff87f979d71f50842f498742af12e73374d8bdf0981b2dc4ebb6530d39a05c0aa692f254e870736e3f45eed6f4131f90a372e4fd1b5a2c0d5d37470f44787a281a8526a67801ce2838b53eaa3c7665539790750cdfa15c620e5df0503c7577854bb6304f5ce270f9170584224aa992b83b35173"),
    ];

    const STREAM_SEQ300: &str = "d9cf5983dc6b34c0fa1f0226926855ad3eccd2bcdcd8f8053b9a80664d33b5afcc32fd21c70ea14f4ef50ca97c3203c4d1803159f0e01bb6cb1d1c83db52b63c";

    /// The accumulator over the 926-digest sweep in
    /// [`sweep_matches_c_reference`], computed independently by the same C
    /// harness driving `blake2b.c`.
    const SWEEP: &str = "88cd3776d2b82923db5e42a2050d4490522ea9b7c10ef5b83d28a2dd59df25c48ff553afac387458ce7e3d2082d976667ea0142b9a5c2c973cc501f9999ec33a";

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    fn hex(bytes: &[u8]) -> String {
        const DIGITS: [u8; 16] = *b"0123456789abcdef";
        let mut s = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            s.push(char::from(DIGITS[usize::from(*byte >> 4)]));
            s.push(char::from(DIGITS[usize::from(*byte & 0x0f)]));
        }
        s
    }

    /// `0, 1, 2, ... (mod 256)`, the filler the C harness used.
    fn seq(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i & 0xff) as u8).collect()
    }

    fn one_shot(outlen: usize, input: &[u8]) -> Vec<u8> {
        let mut out = vec![0u8; outlen];
        blake2b(&mut out, input).expect("outlen in 1..=64");
        out
    }

    // ------------------------------------------------------------------
    // Tests
    // ------------------------------------------------------------------

    /// The two published BLAKE2b-512 vectors, one-shot and streamed.
    #[test]
    fn published_512_vectors() {
        assert_eq!(hex(&one_shot(64, b"")), EMPTY_512);
        assert_eq!(hex(&one_shot(64, b"abc")), ABC_512);

        // Same, through the streaming API.
        let mut out = [0u8; 64];
        let state = Blake2b::new(64).expect("outlen 64");
        state.finalize(&mut out).expect("64-byte buffer");
        assert_eq!(hex(&out), EMPTY_512);

        let mut state = Blake2b::new(64).expect("outlen 64");
        state.update(b"a");
        state.update(b"b");
        state.update(b"c");
        state.finalize(&mut out).expect("64-byte buffer");
        assert_eq!(hex(&out), ABC_512);
    }

    /// Input lengths around the 128-byte block boundary. `update` must hold a
    /// full block back, so 128 and 256 compress *only* in `finalize`.
    #[test]
    fn block_boundary_input_lengths() {
        for &(len, expected) in SEQ_INPUT_512 {
            let input = seq(len);
            assert_eq!(hex(&one_shot(64, &input)), expected, "inlen {len}");
        }
    }

    /// The parameter block changes with `digest_length`, so short digests are
    /// not truncations of the 64-byte one.
    #[test]
    fn short_digest_lengths() {
        for &(outlen, expected) in ABC_SHORT_DIGESTS {
            assert_eq!(hex(&one_shot(outlen, b"abc")), expected, "outlen {outlen}");
        }
        // Not a prefix of the full digest.
        assert_ne!(ABC_SHORT_DIGESTS[2].1, &ABC_512[..64]);
    }

    /// `blake2b_init_key`: key length lands in parameter byte 1 and the key is
    /// absorbed as one zero-padded 128-byte block.
    #[test]
    fn keyed_vectors() {
        let key = seq(64);
        for &(len, expected) in KEYED64_512 {
            let input = seq(len);
            let mut out = [0u8; 64];
            let mut state = Blake2b::with_key(64, &key).expect("64-byte key");
            state.update(&input);
            state.finalize(&mut out).expect("64-byte buffer");
            assert_eq!(hex(&out), expected, "keyed inlen {len}");
        }

        let mut out = [0u8; 64];
        let mut state = Blake2b::with_key(64, &key[..16]).expect("16-byte key");
        state.update(b"abc");
        state.finalize(&mut out).expect("64-byte buffer");
        assert_eq!(hex(&out), KEY16_ABC_512);
    }

    /// Chunked updates that straddle the block boundary, including a chunk that
    /// fills the buffer to exactly 128 and an empty chunk.
    #[test]
    fn streaming_chunks_match_one_shot() {
        let input = seq(300);
        let mut out = [0u8; 64];
        let mut state = Blake2b::new(64).expect("outlen 64");
        state.update(&input[..1]);
        state.update(&input[1..127]); // buflen 127
        state.update(&input[127..128]); // buflen 128 — must NOT compress
        state.update(&input[128..128]); // empty — no-op
        state.update(&input[128..]);
        state.finalize(&mut out).expect("64-byte buffer");

        assert_eq!(hex(&out), STREAM_SEQ300);
        assert_eq!(hex(&out), hex(&one_shot(64, &input)));
    }

    /// `blake2b_long` across the `outlen <= 64` branch, the extension loop, and
    /// the 96/97 boundary that the strictly-greater loop guard decides.
    #[test]
    fn blake2b_long_vectors() {
        for &(outlen, expected) in LONG_EMPTY {
            let mut out = vec![0u8; outlen];
            blake2b_long(&mut out, b"").expect("valid outlen");
            assert_eq!(hex(&out), expected, "long empty outlen {outlen}");
        }
        for &(outlen, expected) in LONG_ABC {
            let mut out = vec![0u8; outlen];
            blake2b_long(&mut out, b"abc").expect("valid outlen");
            assert_eq!(hex(&out), expected, "long abc outlen {outlen}");
        }
        let seq72 = seq(72);
        for &(outlen, expected) in LONG_SEQ72 {
            let mut out = vec![0u8; outlen];
            blake2b_long(&mut out, &seq72).expect("valid outlen");
            assert_eq!(hex(&out), expected, "long seq72 outlen {outlen}");
        }
        let seq1024 = seq(1024);
        for &(outlen, expected) in LONG_SEQ1024_IN {
            let mut out = vec![0u8; outlen];
            blake2b_long(&mut out, &seq1024).expect("valid outlen");
            assert_eq!(hex(&out), expected, "long seq1024-in outlen {outlen}");
        }
    }

    /// The `outlen <= 64` branch is *not* a prefix of the `> 64` branch: the
    /// two feed different `digest_length`s into the parameter block.
    #[test]
    fn blake2b_long_branches_differ() {
        let mut short = [0u8; 64];
        blake2b_long(&mut short, b"abc").expect("outlen 64");
        let mut long = [0u8; 65];
        blake2b_long(&mut long, b"abc").expect("outlen 65");
        assert_ne!(short[..], long[..64]);
    }

    #[test]
    fn blake2b_long_rejects_zero_outlen() {
        // The C's `blake2b_init(&S, 0)` fails, so `blake2b_long` returns -1.
        assert_eq!(
            blake2b_long(&mut [], b"abc"),
            Err(Error::IncorrectParameter)
        );
    }

    #[test]
    fn init_rejects_bad_outlen_and_key() {
        assert_eq!(Blake2b::new(0).err(), Some(Error::IncorrectParameter));
        assert_eq!(Blake2b::new(65).err(), Some(Error::IncorrectParameter));
        assert!(Blake2b::new(1).is_ok());
        assert!(Blake2b::new(64).is_ok());

        let key = seq(65);
        assert_eq!(
            Blake2b::with_key(64, &key).err(),
            Some(Error::IncorrectParameter)
        );
        assert_eq!(
            Blake2b::with_key(64, &[]).err(),
            Some(Error::IncorrectParameter)
        );
        assert_eq!(
            Blake2b::with_key(0, &key[..1]).err(),
            Some(Error::IncorrectParameter)
        );

        // One-shot bounds come from `Blake2b::new`.
        assert_eq!(
            blake2b(&mut [], b"abc").err(),
            Some(Error::IncorrectParameter)
        );
        assert_eq!(
            blake2b(&mut [0u8; 65], b"abc").err(),
            Some(Error::IncorrectParameter)
        );
    }

    /// `blake2b_final` accepts `outlen >= S->outlen` and writes only `S->outlen`
    /// bytes; a shorter buffer is an error.
    #[test]
    fn finalize_writes_exactly_outlen_bytes() {
        let mut out = [0xAAu8; 128];
        let mut state = Blake2b::new(32).expect("outlen 32");
        state.update(b"abc");
        state.finalize(&mut out).expect("128 >= 32");
        assert_eq!(hex(&out[..32]), ABC_SHORT_DIGESTS[2].1);
        assert!(out[32..].iter().all(|b| *b == 0xAA));

        let mut short = [0u8; 31];
        let state = Blake2b::new(32).expect("outlen 32");
        assert_eq!(state.finalize(&mut short), Err(Error::IncorrectParameter));
    }

    /// The C's reuse guard (`S->f[0] != 0`, set by `blake2b_final`). Rust's
    /// `finalize(self)` makes this unreachable, so drive it by hand: the C
    /// returns -1 from both `blake2b_update` and `blake2b_final`.
    #[test]
    fn reused_state_is_rejected() {
        let mut state = Blake2b::new(64).expect("outlen 64");
        state.update(b"abc");
        state.f[0] = !0; // what `finalize` leaves behind

        state.update(b"more"); // C: returns -1, state untouched
        assert_eq!(state.buflen, 3);

        let mut out = [0u8; 64];
        assert_eq!(state.finalize(&mut out), Err(Error::IncorrectParameter));
    }

    /// A folded sweep over 926 digests, checked against one 64-byte
    /// accumulator that the C harness produced from `blake2b.c`:
    ///
    /// * **A** — every input length 0..=300 at `outlen` 64.
    /// * **B** — every digest length 1..=64 over a fixed 200-byte input.
    /// * **C** — every `blake2b_long` output length 1..=300, which walks the
    ///   extension loop from zero iterations up to eight.
    /// * **D** — every two-chunk split of a 260-byte stream. This is what pins
    ///   the buffering rule down: a compression may happen only once
    ///   `buflen + inlen` exceeds 128, so a split landing exactly on 128 or 256
    ///   must still hold its block back.
    ///
    /// The fixed tables above cover hand-picked boundaries; this covers every
    /// length in between, at the cost of one constant.
    #[test]
    fn sweep_matches_c_reference() {
        let mut acc = Blake2b::new(64).expect("outlen 64");

        // A
        for inlen in 0..=300 {
            acc.update(&one_shot(64, &seq(inlen)));
        }

        // B
        let in200 = seq(200);
        for outlen in 1..=64 {
            acc.update(&one_shot(outlen, &in200));
        }

        // C
        for outlen in 1..=300usize {
            let mut out = vec![0u8; outlen];
            blake2b_long(&mut out, &seq(outlen % 137)).expect("valid outlen");
            acc.update(&out);
        }

        // D
        let in260 = seq(260);
        for split in 0..=260 {
            let mut state = Blake2b::new(64).expect("outlen 64");
            state.update(&in260[..split]);
            state.update(&in260[split..]);
            let mut digest = [0u8; 64];
            state.finalize(&mut digest).expect("64-byte buffer");
            acc.update(&digest);
        }

        let mut out = [0u8; 64];
        acc.finalize(&mut out).expect("64-byte buffer");
        assert_eq!(hex(&out), SWEEP);
    }

    /// The parameter block is XORed into the IV as eight LE `u64`s, so for an
    /// unkeyed digest only word 0 changes: `outlen | keylen<<8 | 1<<16 | 1<<24`.
    #[test]
    fn parameter_block_layout() {
        let state = Blake2b::new(32).expect("outlen 32");
        assert_eq!(state.h[0], IV[0] ^ 0x0101_0020);
        assert_eq!(state.h[1..], IV[1..]);
        assert_eq!(state.outlen, 32);

        // 0x0101_1040 = depth 1, fanout 1, key_length 16, digest_length 64.
        let key = seq(16);
        let keyed = Blake2b::with_key(64, &key).expect("16-byte key");
        assert_eq!(keyed.h[0], IV[0] ^ 0x0101_1040);
        assert_eq!(keyed.h[1..], IV[1..]);

        // The key block is *buffered*, not compressed: `update` only compresses
        // once `buflen + inlen` exceeds 128, so a 128-byte key block leaves `h`
        // and the counter untouched. Byte 0 of the buffer is the key.
        assert_eq!(keyed.buflen, BLOCKBYTES);
        assert_eq!(keyed.t, [0, 0]);
        assert_eq!(keyed.buf[..16], key[..]);
        assert!(keyed.buf[16..].iter().all(|b| *b == 0));
    }

    /// The counter is bumped by 128 per compressed block and by `buflen` at
    /// finalisation, and it carries into `t[1]`.
    #[test]
    fn counter_increments_and_carries() {
        let mut state = Blake2b::new(64).expect("outlen 64");
        state.update(&seq(300));
        // 300 bytes: two full blocks compressed, 44 held back.
        assert_eq!(state.t, [256, 0]);
        assert_eq!(state.buflen, 44);

        let mut state = Blake2b::new(64).expect("outlen 64");
        state.t[0] = u64::MAX - 1;
        state.increment_counter(2);
        assert_eq!(state.t, [0, 1]);
    }
}

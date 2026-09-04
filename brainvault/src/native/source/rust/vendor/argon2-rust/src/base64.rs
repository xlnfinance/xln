//! Runtime-dispatched SIMD prefixes for the PHC Base64 codec.
//!
//! The public contract remains in [`crate::encoding`]. Backends here consume
//! only complete 3-byte/4-character groups and stop before any invalid SIMD
//! block; the scalar reference loop then handles the tail, locates the exact
//! first invalid byte, and enforces the reference C's leftover-bit rules.
//!
//! # Algorithm
//!
//! This follows the structure used by `base64-simd` and `aklomp/base64`:
//!
//! * encoding reshuffles 12 or 24 input bytes into independent six-bit lanes,
//!   then translates all lanes through the standard Base64 alphabet;
//! * decoding classifies and translates a whole ASCII vector, rejects the
//!   vector as a unit if any lane is invalid, then merges each four six-bit
//!   lanes into three output bytes;
//! * AVX2 handles 24/32 bytes per iteration, SSSE3 12/16, and AArch64 NEON
//!   uses interleaved 8-lane loads for 24/32 bytes.
//!
//! The backend is detected once and cached with a relaxed atomic. Without
//! `std`, selection uses compile-time target features, matching the crate's
//! other runtime-dispatched kernels.

use core::sync::atomic::{AtomicU8, Ordering};

#[cfg(target_arch = "aarch64")]
mod neon;
#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
mod x86;
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod wasm128;

/// A Base64 SIMD implementation compiled into this crate.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Base64Backend {
    /// Portable scalar code.
    Scalar = 0,
    /// AArch64 NEON, processing 24 input or 32 encoded bytes at a time.
    Neon = 1,
    /// x86/x86-64 SSSE3, processing 12 input or 16 encoded bytes at a time.
    Ssse3 = 2,
    /// x86/x86-64 AVX2 plus SSSE3, processing 24 input or 32 encoded bytes at
    /// a time and using SSSE3 for the remaining vector-sized prefix.
    Avx2 = 3,
    /// WebAssembly SIMD128, processing 12 input or 16 encoded bytes at a time.
    Wasm128 = 4,
}

impl Base64Backend {
    /// Every backend compiled for the current architecture.
    #[cfg(target_arch = "aarch64")]
    pub const ALL: &'static [Base64Backend] =
        &[Base64Backend::Scalar, Base64Backend::Neon];
    /// Every backend compiled for the current architecture.
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    pub const ALL: &'static [Base64Backend] = &[
        Base64Backend::Scalar,
        Base64Backend::Ssse3,
        Base64Backend::Avx2,
    ];
    /// Scalar and SIMD128 backends in a SIMD-enabled WebAssembly build.
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    pub const ALL: &'static [Base64Backend] =
        &[Base64Backend::Scalar, Base64Backend::Wasm128];
    /// The scalar backend on architectures without an implementation above.
    #[cfg(not(any(
        target_arch = "aarch64",
        target_arch = "x86",
        target_arch = "x86_64",
        all(target_arch = "wasm32", target_feature = "simd128")
    )))]
    pub const ALL: &'static [Base64Backend] = &[Base64Backend::Scalar];

    /// Short lowercase diagnostic and benchmark name.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Base64Backend::Scalar => "scalar",
            Base64Backend::Neon => "neon",
            Base64Backend::Ssse3 => "ssse3",
            Base64Backend::Avx2 => "avx2",
            Base64Backend::Wasm128 => "wasm128",
        }
    }

    /// Whether this CPU can execute the backend now.
    #[must_use]
    pub fn is_available(self) -> bool {
        match self {
            Base64Backend::Scalar => true,
            Base64Backend::Neon => have_neon(),
            Base64Backend::Ssse3 => have_ssse3(),
            // The AVX2 entry point deliberately finishes with the SSSE3
            // kernel, so its full feature contract includes both.
            Base64Backend::Avx2 => have_avx2() && have_ssse3(),
            Base64Backend::Wasm128 => have_wasm_simd128(),
        }
    }

    #[inline]
    const fn from_u8(value: u8) -> Base64Backend {
        match value {
            1 => Base64Backend::Neon,
            2 => Base64Backend::Ssse3,
            3 => Base64Backend::Avx2,
            4 => Base64Backend::Wasm128,
            _ => Base64Backend::Scalar,
        }
    }
}

impl core::fmt::Display for Base64Backend {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.name())
    }
}

#[cfg(all(feature = "std", any(target_arch = "x86", target_arch = "x86_64")))]
#[inline]
fn have_ssse3() -> bool {
    std::arch::is_x86_feature_detected!("ssse3")
}
#[cfg(not(all(feature = "std", any(target_arch = "x86", target_arch = "x86_64"))))]
#[inline]
fn have_ssse3() -> bool {
    cfg!(all(
        any(target_arch = "x86", target_arch = "x86_64"),
        target_feature = "ssse3"
    ))
}

#[cfg(all(feature = "std", any(target_arch = "x86", target_arch = "x86_64")))]
#[inline]
fn have_avx2() -> bool {
    std::arch::is_x86_feature_detected!("avx2")
}
#[cfg(not(all(feature = "std", any(target_arch = "x86", target_arch = "x86_64"))))]
#[inline]
fn have_avx2() -> bool {
    cfg!(all(
        any(target_arch = "x86", target_arch = "x86_64"),
        target_feature = "avx2"
    ))
}

#[cfg(all(feature = "std", target_arch = "aarch64"))]
#[inline]
fn have_neon() -> bool {
    #[cfg(any(target_vendor = "apple", target_os = "windows"))]
    {
        true
    }
    #[cfg(not(any(target_vendor = "apple", target_os = "windows")))]
    {
        std::arch::is_aarch64_feature_detected!("neon")
    }
}

#[inline]
fn have_wasm_simd128() -> bool {
    cfg!(all(target_arch = "wasm32", target_feature = "simd128"))
}
#[cfg(not(all(feature = "std", target_arch = "aarch64")))]
#[inline]
fn have_neon() -> bool {
    cfg!(all(target_arch = "aarch64", target_feature = "neon"))
}

const UNINIT: u8 = u8::MAX;
static CACHED_BACKEND: AtomicU8 = AtomicU8::new(UNINIT);

/// Detect the fastest executable Base64 backend without reading the cache.
#[must_use]
pub fn detect_base64_backend() -> Base64Backend {
    if cfg!(miri) {
        Base64Backend::Scalar
    } else if have_avx2() && have_ssse3() {
        Base64Backend::Avx2
    } else if have_ssse3() {
        Base64Backend::Ssse3
    } else if have_neon() {
        Base64Backend::Neon
    } else if have_wasm_simd128() {
        Base64Backend::Wasm128
    } else {
        Base64Backend::Scalar
    }
}

#[cold]
#[inline(never)]
fn detect_and_cache() -> Base64Backend {
    let detected = detect_base64_backend();
    CACHED_BACKEND.store(detected as u8, Ordering::Relaxed);
    detected
}

/// Return the process-wide cached Base64 backend.
#[inline]
#[must_use]
pub fn base64_backend() -> Base64Backend {
    let cached = CACHED_BACKEND.load(Ordering::Relaxed);
    if cached == UNINIT {
        detect_and_cache()
    } else {
        Base64Backend::from_u8(cached)
    }
}

/// The shortest input on which any backend for this architecture can encode
/// a vector. Used to keep the dispatch cost completely off shorter inputs.
#[cfg(target_arch = "aarch64")]
pub const MIN_ENCODE_LEN: usize = 24;
/// See the AArch64 definition.
#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
pub const MIN_ENCODE_LEN: usize = 16;
/// WebAssembly SIMD128 consumes 12 bytes from each 16-byte vector load, as
/// SSSE3 does, so the shortest safely readable input is 16 bytes.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
pub const MIN_ENCODE_LEN: usize = 16;
/// No SIMD encoder is compiled on this target.
#[cfg(not(any(
    target_arch = "aarch64",
    target_arch = "x86",
    target_arch = "x86_64",
    all(target_arch = "wasm32", target_feature = "simd128")
)))]
pub const MIN_ENCODE_LEN: usize = usize::MAX;

/// The shortest encoded input on which a backend can decode a vector.
#[cfg(target_arch = "aarch64")]
pub const MIN_DECODE_LEN: usize = 32;
/// See the AArch64 definition.
#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
pub const MIN_DECODE_LEN: usize = 16;
/// WebAssembly SIMD128 decodes one 16-character vector.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
pub const MIN_DECODE_LEN: usize = 16;
/// No SIMD decoder is compiled on this target.
#[cfg(not(any(
    target_arch = "aarch64",
    target_arch = "x86",
    target_arch = "x86_64",
    all(target_arch = "wasm32", target_feature = "simd128")
)))]
pub const MIN_DECODE_LEN: usize = usize::MAX;

/// Encode as many complete SIMD blocks as possible.
///
/// Returns `(input_consumed, output_written)`.
///
/// # Safety
///
/// `backend` must be executable on the current CPU. `dst` has already been
/// sized for the complete encoding by the caller.
#[inline]
pub unsafe fn encode_prefix(
    backend: Base64Backend,
    dst: *mut u8,
    src: &[u8],
) -> (usize, usize) {
    #[cfg(not(any(
        target_arch = "aarch64",
        target_arch = "x86",
        target_arch = "x86_64",
        all(target_arch = "wasm32", target_feature = "simd128")
    )))]
    let _ = (dst, src);

    match backend {
        Base64Backend::Scalar => (0, 0),

        #[cfg(target_arch = "aarch64")]
        // SAFETY: transferred from this function's caller; the slice pointers
        // and lengths are passed together without alteration.
        Base64Backend::Neon => unsafe { neon::encode(dst, src.as_ptr(), src.len()) },
        #[cfg(not(target_arch = "aarch64"))]
        Base64Backend::Neon => (0, 0),

        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        // SAFETY: transferred from this function's caller; the slices supply
        // the pointer/length pairs unchanged.
        Base64Backend::Ssse3 => unsafe { x86::encode_ssse3(dst, src.as_ptr(), src.len()) },
        #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
        Base64Backend::Ssse3 => (0, 0),

        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        // SAFETY: as above; the backend contract includes AVX2 and SSSE3.
        Base64Backend::Avx2 => unsafe { x86::encode_avx2(dst, src.as_ptr(), src.len()) },
        #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
        Base64Backend::Avx2 => (0, 0),

        #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
        // SAFETY: the module only exists under the compile-time SIMD128
        // contract, and the slices supply both pointer bounds.
        Base64Backend::Wasm128 => unsafe { wasm128::encode(dst, src.as_ptr(), src.len()) },
        #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
        Base64Backend::Wasm128 => (0, 0),
    }
}

/// Decode as many complete, valid SIMD blocks as possible.
///
/// Returns `(input_consumed, output_written)`. An invalid vector is left
/// entirely unconsumed so the scalar loop can find its first invalid byte.
///
/// # Safety
///
/// `backend` must be executable on the current CPU.
#[inline]
pub unsafe fn decode_prefix(
    backend: Base64Backend,
    dst: *mut u8,
    dst_len: usize,
    src: &[u8],
) -> (usize, usize) {
    #[cfg(not(any(
        target_arch = "aarch64",
        target_arch = "x86",
        target_arch = "x86_64",
        all(target_arch = "wasm32", target_feature = "simd128")
    )))]
    let _ = (dst, dst_len, src);

    match backend {
        Base64Backend::Scalar => (0, 0),

        #[cfg(target_arch = "aarch64")]
        // SAFETY: transferred from this function's caller; both pointer/length
        // pairs come directly from live slices.
        Base64Backend::Neon => unsafe { neon::decode(dst, dst_len, src.as_ptr(), src.len()) },
        #[cfg(not(target_arch = "aarch64"))]
        Base64Backend::Neon => (0, 0),

        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        // SAFETY: transferred from this function's caller; both pointer/length
        // pairs come directly from live slices.
        Base64Backend::Ssse3 => unsafe { x86::decode_ssse3(dst, dst_len, src.as_ptr(), src.len()) },
        #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
        Base64Backend::Ssse3 => (0, 0),

        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        // SAFETY: as above; the backend contract includes AVX2 and SSSE3.
        Base64Backend::Avx2 => unsafe { x86::decode_avx2(dst, dst_len, src.as_ptr(), src.len()) },
        #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
        Base64Backend::Avx2 => (0, 0),

        #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
        // SAFETY: the module only exists under the compile-time SIMD128
        // contract, and both pointer/length pairs come from live slices.
        Base64Backend::Wasm128 => unsafe {
            wasm128::decode(dst, dst_len, src.as_ptr(), src.len())
        },
        #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
        Base64Backend::Wasm128 => (0, 0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection_is_cached_and_executable() {
        let detected = detect_base64_backend();
        assert!(detected.is_available());
        assert_eq!(base64_backend(), detected);
        assert_eq!(base64_backend(), detected);
    }

    #[test]
    fn backend_discriminants_round_trip() {
        for &backend in Base64Backend::ALL {
            assert_eq!(Base64Backend::from_u8(backend as u8), backend);
        }
        assert_eq!(Base64Backend::from_u8(UNINIT), Base64Backend::Scalar);
        assert_eq!(Base64Backend::from_u8(200), Base64Backend::Scalar);
    }
}

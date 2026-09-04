//! A pure-Rust port of the reference Argon2 implementation
//! ([phc-winner-argon2](https://github.com/P-H-C/phc-winner-argon2)), with
//! runtime-dispatched SIMD backends.
//!
//! Argon2 is the winner of the 2015 Password Hashing Competition and is
//! specified in [RFC 9106](https://www.rfc-editor.org/rfc/rfc9106). Three
//! variants exist, see [`Algorithm`]:
//!
//! * `Argon2d` — data-dependent addressing: fastest, but leaks a memory access
//!   pattern that depends on the password.
//! * `Argon2i` — data-independent addressing: side-channel resistant.
//! * `Argon2id` — independent for the first half-pass, dependent afterwards.
//!   The default, and what RFC 9106 recommends.
//!
//! # Example
//!
//! ```
//! use argon2_rust::{Algorithm, Argon2, Error, Params, Version};
//!
//! // Default: 19 MiB, t=2, 1 lane, 32-byte tag (raw hash output). ~8 ms per
//! // hash in release on M-series — cheap enough for a real doctest. Raise
//! // `m_cost` until it fits your budget.
//! let params = Params::default();
//! let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
//!
//! let mut tag = [0u8; 32];
//! argon2.hash_into(b"password", b"somesalt", &mut tag)?;
//! assert_eq!(argon2.verify(b"password", b"somesalt", &tag), Ok(()));
//! assert_eq!(
//!     argon2.verify(b"wrong", b"somesalt", &tag),
//!     Err(Error::VerifyMismatch),
//! );
//! # Ok::<(), argon2_rust::Error>(())
//! ```
//!
//! # SIMD backends
//!
//! The compression function is selected by **runtime** CPU feature detection,
//! never by `cfg(target_feature)` alone, so one binary runs at full speed on
//! every machine. Detection happens at most once per process and the result is
//! cached; a hash call resolves one function pointer before entering its loops.
//! Ask [`detected_backend`] what this CPU picked. The cost model is documented
//! on the private `fill_block` module.
//!
//! | [`Backend`] | Requires | Source it was ported from |
//! |---|---|---|
//! | `Scalar` | — | `src/ref.c` |
//! | `Neon` | `aarch64` | `src/opt.c` (128-bit path) |
//! | `Sse2` | `x86`/`x86_64` + SSE2 | `src/opt.c` (128-bit path) |
//! | `Avx2` | `x86_64` + AVX2 | `src/opt.c` (`__AVX2__`) |
//! | `Avx512` | `x86_64` + AVX-512F | `src/opt.c` (`__AVX512F__`) |
//!
//! The unpadded standard-Base64 codec used by PHC strings has a separate,
//! cached dispatch: AVX2, SSSE3, AArch64 NEON, wasm SIMD128, then scalar. Its
//! vector kernels follow `base64-simd`/`aklomp/base64`, while inputs shorter
//! than one vector stay on the original scalar loop. As in `base64-simd`,
//! AVX-512-capable CPUs use this codec's AVX2 path; the wider backend remains
//! specific to the Argon2 compression function above. Call [`encode_base64`]
//! and [`decode_base64`] for that codec on its own; [`detected_base64_backend`]
//! reports which implementation this CPU picked. The PHC string itself is
//! [`encode_string`] / [`decode_string`] (C `encode_string` / `decode_string`)
//! or [`decode_phc`] when the input may be a `@phc/format` / node-argon2
//! string (`m,p,t` any order, optional `data=`).
//!
//! BLAKE2b (H0, the long expansion, and finalize) has its own cascade, x86
//! only: AVX-512 → AVX2 → SSE4.1 → scalar. AArch64 stays on scalar; a NEON
//! compress was measured slower. [`blake2b`] / [`blake2b_long`] are the
//! one-shot entry points; [`detected_blake2b_backend`] reports the choice.
//!
//! # Features
//!
//! * `std` *(default)* — runtime CPU feature detection, including
//!   `memchr`'s SIMD cascade for PHC field scans.
//! * `parallel` *(default, implies `std`)* — multi-threaded fill. One
//!   [`std::thread::scope`] for the **whole** fill, whose workers meet at a
//!   barrier at each of the `4 * t_cost` algorithmic sync points, rather than a
//!   fresh scope per sync point. Note that the thread count does **not** change
//!   the tag; only [`Params::lanes`] does.
//! * `zeroize-memory` *(default)* — securely wipe internal buffers, the
//!   equivalent of `FLAG_clear_internal_memory` in the C.
//! * `bump-alloc` — internal test/bench control. Together with `internal-api`,
//!   gives `memory::Workspace` a reusable bump allocator for measuring small
//!   scratch buffers. It does **not** change the stable hash/encode/verify paths,
//!   which deliberately keep their `Vec`s. Measured upper bound: 17 ns per hash,
//!   or 0.00013% of an RFC 9106 hash.
//! * `internal-api` — exposes `__internal` for tests and benches. Not stable.
//!
//! The crate is `#![no_std]` and needs `alloc` plus [`memchr`]. That stays
//! true with every feature turned on. Without `std`, backend selection (and
//! `memchr`) fall back to compile-time `target_feature` cfgs.
//!
//! # Not a `password-hash` provider
//!
//! This is a port of the C reference, not an implementation of the RustCrypto
//! `password-hash` traits: there is no `PasswordHasher` or `PasswordVerifier`
//! here, and no dependency that would supply one. [`Params`] carries no `serde`
//! impls either, though its full state round-trips through the accessors and
//! [`Params::to_builder`]. Interoperation is at the string level — the PHC
//! strings this crate reads and writes are the ones the `argon2` crate reads and
//! writes. A future optional feature for those traits would be additive and
//! would not change this default surface.
//!
//! # SemVer
//!
//! From `1.0.0`, the default-feature public API is covered by Semantic
//! Versioning. The `internal-api` feature and its `__internal` module are not.
//! MSRV may rise on a minor release. See the README "SemVer policy" section for
//! the full list.
//!
//! # Reusing memory across hashes
//!
//! Each [`Argon2`] hash acquires its block arena once and releases it on the
//! way out. A process that hashes repeatedly can instead keep a [`Hasher`],
//! from [`Argon2::hasher`], which parks the arena between calls and wipes it on
//! release, so the next call gets a zeroed arena that is **already mapped and
//! already resident**.
//!
//! Skipping the `mmap`, the first-touch faults and the `munmap` is worth around
//! -25% at `m_cost = 64 MiB`, and next to nothing below 1 MiB, where a hash is
//! mostly BLAKE2b; [`Hasher`](Hasher#what-it-is-worth-measured) has the
//! per-cost measurements.
//!
//! ```
//! use argon2_rust::{Algorithm, Argon2, Hasher, Params, Version, params::Memory};
//!
//! // Nameable, so it can be a field, a `thread_local!` or a worker slot —
//! // which is the only shape in which reuse is worth anything.
//! struct Worker {
//!     hasher: Hasher,
//! }
//!
//! let params = Params::builder().memory(Memory::kib(1 << 8)).passes(1).build()?;
//! let mut worker = Worker {
//!     hasher: Argon2::new(Algorithm::Argon2id, Version::V0x13, params).hasher(),
//! };
//! let mut tag = [0u8; 32];
//! worker.hasher.hash_into(b"password", b"somesalt", &mut tag)?;
//! # Ok::<(), argon2_rust::Error>(())
//! ```
//!
//! # Salts
//!
//! [`Argon2::hash_password_with_random_salt`] (and the pooled
//! [`Hasher::hash_password_with_random_salt`]) draw a [`RANDOM_SALT_LEN`]-byte
//! salt from the OS and put it in the returned PHC string, so nothing has to be
//! stored alongside. The entropy comes from whichever entry point is correct
//! for the target — `getrandom(2)`, `getentropy`, `CCRandomGenerateBytes`,
//! `ProcessPrng`, WASI `random_get`, or `/dev/urandom` — each declared by hand,
//! so this costs no dependency. Callers who already run a CSPRNG should keep
//! passing their own salt.
//!
//! # Verifying strings you did not write
//!
//! `m_cost` in a PHC string is up to ten digits of decimal, and
//! [`Argon2::verify_encoded`] will honour all of them — up to
//! [`params::MAX_MEMORY`] KiB, which is 4 TiB — because `argon2_verify` does
//! too. That is fine for a config file and a denial of service for a login
//! endpoint. [`Argon2::verify_encoded_bounded`] takes a ceiling and rejects an
//! over-large cost while it is still a number, before anything is allocated:
//!
//! ```
//! use argon2_rust::{Algorithm, Argon2, Error, Params, params::Memory};
//!
//! let hostile = "$argon2id$v=19$m=4294967295,t=1,p=1$c29tZXNhbHQ$\
//!                CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc";
//! let ceiling = Params::builder().memory(Memory::mib(64)).passes(8).lanes(4).build()?;
//! assert_eq!(
//!     Argon2::verify_encoded_bounded(hostile, b"pw", Algorithm::Argon2id, &ceiling),
//!     Err(Error::MemoryTooMuch),
//! );
//! # Ok::<(), argon2_rust::Error>(())
//! ```
//!
//! Memory is not the only resource the string spends. Decoding sets
//! `threads = lanes` (C parity), so `p` also picks how many OS threads the
//! verify spawns; the ceiling's own `threads` bounds that, and a ceiling that
//! leaves [`ParamsBuilder::threads`](params::ParamsBuilder::threads) unset bounds
//! it together with `lanes`. Set that one setter to accept wide strings without
//! spawning wide. The clamp cannot change a verdict — only `lanes` feeds the tag.
//!
//! # Panics
//!
//! No fallible path in this crate panics: hashing, verifying, encoding,
//! decoding and parameter validation all report failure as an [`Error`], whose
//! numeric [`Error::as_c_code`] matches the C reference — except for the
//! crate-specific codes below [`Error::MIN_C_CODE`], which the C has no
//! equivalent for.
//!
//! There is exactly one intentional exception, and it is not on a fallible
//! path: [`ParamsBuilder::build_or_panic`](params::ParamsBuilder::build_or_panic)
//! panics on invalid parameters. It exists so a `const` item can turn bad
//! parameters into a *compile* error, which is what a panic in a `const`
//! evaluation is. Anywhere a runtime error is the right answer, use
//! [`ParamsBuilder::build`](params::ParamsBuilder::build) — it is the normal way
//! in.

#![no_std]
#![warn(missing_docs)]
// A `pub` item that a downstream crate cannot *name* is only half-public: it
// works in `let` bindings and nowhere else — not in a struct field, a function
// signature, a `Vec`, or a `thread_local!`. `Hasher` shipped that way once
// (`Argon2::hasher()` returned it, `lib.rs` never re-exported it), which broke
// the one shape the reuse layer exists to serve: one hasher per worker, owned
// by that worker's struct. This lint is the regression guard.
#![warn(unnameable_types)]
#![warn(clippy::undocumented_unsafe_blocks)]

// NOTE FOR EVERY CONTRIBUTOR: this crate has a module named `core`, which
// shadows the `core` crate *in this root module only*. Inside `src/lib.rs`
// always write `::core::...`. Submodules are unaffected — bare `core::` there
// still means the `core` crate.

extern crate alloc;

#[cfg(feature = "std")]
extern crate std;

pub mod error;
pub mod params;

// These modules are private, and a good deal of what they expose escapes the
// crate only through `__internal` (below), which tests and benches enable. In a
// plain build those items are legitimately unreachable, so `dead_code` would
// fire on all of them.
//
// Rather than blanket-allowing `dead_code` — which would also hide code that is
// dead by mistake — the allow is tied to `internal-api` being OFF. With the
// feature ON, `__internal` re-exports the intended surface, so anything the
// compiler still calls dead really is dead and gets reported.
macro_rules! private_modules {
    ($($name:ident),* $(,)?) => {
        $(
            #[cfg_attr(not(feature = "internal-api"), allow(dead_code))]
            mod $name;
        )*
    };
}

private_modules!(base64, blake2b, block, core, encoding, fill_block, memory);

// OS entropy for the convenience salt API; needs std for the syscall and the
// /dev/urandom fallback. Declared per-platform inside the module.
//
// Deliberately not in `private_modules!`: everything here is reachable from
// `Argon2::hash_password_with_random_salt` on every `std` build, so it needs no
// `dead_code` allow, and should not have one hiding a future mistake.
#[cfg(feature = "std")]
mod random;

pub use crate::core::{Argon2, BOUNDED_MAX_SALT_LEN, Hasher, constant_time_eq};
// `RANDOM_SALT_LEN` is std-only because the API it describes is;
// `BOUNDED_MAX_SALT_LEN` is not, because `verify_encoded_bounded` works without
// `std` and a caller has to be able to name the bound it is being held to.
pub use crate::base64::Base64Backend;
pub use crate::blake2b::{Blake2bBackend, blake2b, blake2b_long};
#[cfg(feature = "std")]
pub use crate::core::RANDOM_SALT_LEN;
pub use crate::encoding::{
    Decoded, decode_base64, decode_phc, decode_string, encode_base64, encode_string,
    encode_string_alloc, encoded_len, from_base64, to_base64,
};
pub use crate::error::Error;
pub use crate::fill_block::Backend;
pub use crate::params::{Algorithm, Params, Version};

/// The [`Backend`] this CPU resolved to, cached after the first call.
///
/// Diagnostic only — the hashing entry points call this for you.
///
/// ```
/// println!("argon2 backend: {}", argon2_rust::detected_backend());
/// ```
#[inline]
#[must_use]
pub fn detected_backend() -> Backend {
    crate::fill_block::backend()
}

/// The Base64 [`Base64Backend`] this CPU resolved to, cached after the first call.
///
/// Diagnostic only — [`encode_base64`] and [`decode_base64`] call this for you.
///
/// ```
/// println!("argon2 base64 backend: {}", argon2_rust::detected_base64_backend());
/// ```
#[inline]
#[must_use]
pub fn detected_base64_backend() -> Base64Backend {
    crate::base64::base64_backend()
}

/// The BLAKE2b [`Blake2bBackend`] this CPU resolved to, cached after the first
/// call.
///
/// Diagnostic only — [`blake2b`], [`blake2b_long`], and every Argon2 hash call
/// this for you. On aarch64 this is always [`Blake2bBackend::Scalar`]: a NEON
/// compress was measured slower than the portable path, so there is no ARM
/// SIMD backend to pick.
///
/// ```
/// println!("argon2 blake2b backend: {}", argon2_rust::detected_blake2b_backend());
/// ```
#[inline]
#[must_use]
pub fn detected_blake2b_backend() -> Blake2bBackend {
    crate::blake2b::blake2b_backend()
}

/// Unstable internals, exposed for this crate's own tests and benches.
///
/// Gated behind the non-default `internal-api` feature. **No stability
/// guarantees**: anything here can change in a patch release.
///
/// # Soundness
///
/// Unstable is not the same as unsound. Every entry point here that takes an
/// explicit [`Backend`] or `Blake2bBackend` — including
/// `fill_memory_blocks_traced`, `hash_traced`, `hash_with_backend`,
/// `blake2b_with_backend`, and `blake2b_long_with_backend` — is an `unsafe fn`,
/// and so is each backend's low-level entry point. They dispatch to a
/// `#[target_feature(enable = ...)]` function, so running one whose feature
/// this CPU lacks is undefined behaviour (`SIGILL` in practice), and only the
/// caller can rule that out. Each backend type's `is_available` method is the
/// portable way.
///
/// The safe entry points — [`Argon2`], [`detected_backend`], `blake2b`,
/// `blake2b_long`, and `fill_memory_blocks` — never let a caller name the
/// backend. They take it from the corresponding cached runtime cascade, which
/// by construction only ever names a backend this CPU advertises. That is the
/// whole reason they can be safe, and it is why turning on `internal-api`
/// cannot make a `#![forbid(unsafe_code)]` program reachable by UB.
#[cfg(feature = "internal-api")]
#[doc(hidden)]
pub mod __internal {
    pub use crate::base64::{Base64Backend, base64_backend, detect_base64_backend};
    pub use crate::blake2b::{
        BLOCKBYTES, Blake2b, Blake2bBackend, IV, KEYBYTES, OUTBYTES, PERSONALBYTES, SALTBYTES,
        blake2b, blake2b_backend, blake2b_long, blake2b_long_with_backend, blake2b_with_backend,
        detect_blake2b_backend,
    };
    pub use crate::block::{Block, Instance, Position};
    pub use crate::core::{
        PassTrace, constant_time_eq, fill_first_blocks, fill_memory_blocks,
        fill_memory_blocks_traced, finalize, hash_traced, hash_with_backend, index_alpha,
        initial_hash,
    };
    pub use crate::encoding::{
        Decoded, b64_len, decode_phc, decode_string, encode_string, encode_string_alloc,
        encoded_len, from_base64, from_base64_with_backend, num_len, to_base64,
        to_base64_with_backend,
    };
    pub use crate::fill_block::{Backend, FillSegmentFn, backend, detect, fill_segment_fn};
    /// The arena release-path observation point, for
    /// `tests/allocation_audit.rs`. See [`crate::memory::audit`].
    #[cfg(feature = "std")]
    pub use crate::memory::audit;
    pub use crate::memory::{
        ARENA_ALIGN, Arena, ArenaGuard, Workspace, clear_internal_memory,
        clear_internal_memory_blocks, clear_internal_memory_u64, secure_wipe, secure_wipe_blocks,
        secure_wipe_raw, secure_wipe_u64,
    };
    pub use crate::params::validate_inputs;

    /// `bumpalo`, re-exported so callers can name the types
    /// [`Workspace::bump`](crate::memory::Workspace::bump) hands back without
    /// having to match this crate's exact dependency version.
    ///
    /// Only the `try_alloc_*` family is admissible: the infallible `alloc_*`
    /// methods abort on allocation failure, and nothing reachable from this
    /// crate's safe API is allowed to do that.
    #[cfg(feature = "bump-alloc")]
    pub use ::bumpalo;

    /// Each backend's `fill_segment`, reachable directly so a differential test
    /// can pit two backends against each other on the same arena.
    pub mod backends {
        pub use crate::fill_block::scalar;

        #[cfg(target_arch = "aarch64")]
        pub use crate::fill_block::neon;

        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        pub use crate::fill_block::sse2;

        #[cfg(target_arch = "x86_64")]
        pub use crate::fill_block::avx2;

        #[cfg(target_arch = "x86_64")]
        pub use crate::fill_block::avx512;
    }
}

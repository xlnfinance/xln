//! Limits, [`Algorithm`], [`Version`] and [`Params`].
//!
//! Every constant here is transcribed from `phc-winner-argon2/include/argon2.h`
//! and `phc-winner-argon2/src/core.h`. [`validate_inputs`] reproduces
//! `validate_inputs()` from `src/core.c` **in the same order**, because the
//! order decides which error code surfaces first.

use crate::error::Error;

// ---------------------------------------------------------------------------
// Limits from include/argon2.h
// ---------------------------------------------------------------------------

/// `ARGON2_MIN_LANES`.
pub const MIN_LANES: u32 = 1;
/// `ARGON2_MAX_LANES`.
pub const MAX_LANES: u32 = 0x00FF_FFFF;

/// `ARGON2_MIN_THREADS`.
pub const MIN_THREADS: u32 = 1;
/// `ARGON2_MAX_THREADS`.
pub const MAX_THREADS: u32 = 0x00FF_FFFF;

/// `ARGON2_SYNC_POINTS`: synchronisation points between lanes per pass.
pub const SYNC_POINTS: u32 = 4;

/// `ARGON2_MIN_OUTLEN`.
pub const MIN_OUTLEN: u32 = 4;
/// `ARGON2_MAX_OUTLEN`.
pub const MAX_OUTLEN: u32 = 0xFFFF_FFFF;

/// `ARGON2_MIN_MEMORY` = `2 * ARGON2_SYNC_POINTS` (two blocks per slice).
pub const MIN_MEMORY: u32 = 2 * SYNC_POINTS;

/// `ARGON2_MAX_MEMORY_BITS` = `min(32, sizeof(void*) * CHAR_BIT - 10 - 1)`.
///
/// 32 on a 64-bit target, 21 on a 32-bit target.
pub const MAX_MEMORY_BITS: u32 = {
    let ptr_bits = (size_of::<*const u8>() * 8) as u32;
    let bits = ptr_bits - 10 - 1;
    if bits < 32 { bits } else { 32 }
};

/// `ARGON2_MAX_MEMORY` = `min(0xFFFFFFFF, 1 << ARGON2_MAX_MEMORY_BITS)`.
///
/// `0xFFFF_FFFF` on a 64-bit target, `0x0020_0000` on a 32-bit target.
/// Verified against the C preprocessor on `aarch64-apple-darwin`.
pub const MAX_MEMORY: u32 = {
    let candidate: u64 = 1u64 << MAX_MEMORY_BITS;
    if candidate < 0xFFFF_FFFF {
        candidate as u32
    } else {
        0xFFFF_FFFF
    }
};

/// `ARGON2_MIN_TIME`.
pub const MIN_TIME: u32 = 1;
/// `ARGON2_MAX_TIME`.
pub const MAX_TIME: u32 = 0xFFFF_FFFF;

/// `ARGON2_MIN_PWD_LENGTH`.
pub const MIN_PWD_LENGTH: u32 = 0;
/// `ARGON2_MAX_PWD_LENGTH`.
pub const MAX_PWD_LENGTH: u32 = 0xFFFF_FFFF;

/// `ARGON2_MIN_AD_LENGTH`.
pub const MIN_AD_LENGTH: u32 = 0;
/// `ARGON2_MAX_AD_LENGTH`.
pub const MAX_AD_LENGTH: u32 = 0xFFFF_FFFF;

/// `ARGON2_MIN_SALT_LENGTH`.
pub const MIN_SALT_LENGTH: u32 = 8;
/// `ARGON2_MAX_SALT_LENGTH`.
pub const MAX_SALT_LENGTH: u32 = 0xFFFF_FFFF;

/// `ARGON2_MIN_SECRET`.
pub const MIN_SECRET: u32 = 0;
/// `ARGON2_MAX_SECRET`.
pub const MAX_SECRET: u32 = 0xFFFF_FFFF;

// ---------------------------------------------------------------------------
// Typed units
// ---------------------------------------------------------------------------

/// A memory cost, carried in kibibytes.
///
/// The unit is the point of this type. Argon2's `m_cost` is a count of 1 KiB
/// blocks, so a bare `65536` at a call site could be read as bytes, KiB, MiB or
/// blocks; `Memory::mib(64)` cannot.
///
/// No constructor validates or panics. The value is held as a `u64` and checked
/// once, by [`ParamsBuilder::build`], which is the only place that knows the
/// target's `MAX_MEMORY`.
///
/// ```
/// use argon2_rust::params::Memory;
///
/// assert_eq!(Memory::mib(64), Memory::kib(65536));
/// assert_eq!(Memory::gib(1), Memory::mib(1024));
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Memory(u64);

impl Memory {
    /// A cost in kibibytes, the unit Argon2's `m_cost` uses.
    #[inline]
    #[must_use]
    pub const fn kib(kib: u64) -> Memory {
        Memory(kib)
    }

    /// A cost in mebibytes.
    ///
    /// Saturating, not wrapping: `mib(u64::MAX)` yields `u64::MAX` KiB rather
    /// than panicking in a debug build. Any saturated value is far above
    /// [`MAX_MEMORY`] and becomes [`Error::MemoryTooMuch`] at `build()`.
    #[inline]
    #[must_use]
    pub const fn mib(mib: u64) -> Memory {
        Memory(mib.saturating_mul(1024))
    }

    /// A cost in gibibytes. Saturating, for the reason given on [`Memory::mib`].
    #[inline]
    #[must_use]
    pub const fn gib(gib: u64) -> Memory {
        Memory(gib.saturating_mul(1024 * 1024))
    }

    /// The cost in kibibytes.
    #[inline]
    #[must_use]
    pub const fn as_kib(self) -> u64 {
        self.0
    }
}

/// Length of an Argon2 **tag** (raw hash output), in bytes.
///
/// RFC 9106's name for the digest. No `bits()` constructor — only whole bytes.
/// Like [`Memory`], this validates nothing; [`ParamsBuilder::build`] does.
///
/// ```
/// use argon2_rust::params::TagLen;
///
/// // RFC 9106's "256-bit tag"
/// assert_eq!(TagLen::bytes(32).as_bytes(), 32);
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TagLen(u64);

impl TagLen {
    /// A tag length in bytes.
    #[inline]
    #[must_use]
    pub const fn bytes(bytes: u64) -> TagLen {
        TagLen(bytes)
    }

    /// The length in bytes.
    #[inline]
    #[must_use]
    pub const fn as_bytes(self) -> u64 {
        self.0
    }
}

// ---------------------------------------------------------------------------
// Internal constants from src/core.h
// ---------------------------------------------------------------------------

/// `ARGON2_BLOCK_SIZE`: memory block size in bytes.
pub const BLOCK_SIZE: usize = 1024;
/// `ARGON2_QWORDS_IN_BLOCK`: 64-bit words per block.
pub const QWORDS_IN_BLOCK: usize = BLOCK_SIZE / 8;
/// `ARGON2_OWORDS_IN_BLOCK`: 128-bit lanes per block (SSE2).
pub const OWORDS_IN_BLOCK: usize = BLOCK_SIZE / 16;
/// `ARGON2_HWORDS_IN_BLOCK`: 256-bit lanes per block (AVX2).
pub const HWORDS_IN_BLOCK: usize = BLOCK_SIZE / 32;
/// `ARGON2_512BIT_WORDS_IN_BLOCK`: 512-bit lanes per block (AVX-512).
pub const BITS512_WORDS_IN_BLOCK: usize = BLOCK_SIZE / 64;

/// `ARGON2_ADDRESSES_IN_BLOCK`: pseudo-random values one address block holds.
pub const ADDRESSES_IN_BLOCK: usize = 128;

/// `ARGON2_PREHASH_DIGEST_LENGTH`: length of `H0`.
pub const PREHASH_DIGEST_LENGTH: usize = 64;
/// `ARGON2_PREHASH_SEED_LENGTH`: `H0` plus the 4-byte block index and 4-byte lane index.
pub const PREHASH_SEED_LENGTH: usize = 72;

// ---------------------------------------------------------------------------
// Limits from src/encoding.h
// ---------------------------------------------------------------------------
//
// Mirrored for completeness, and unused — the C defines all three in
// `encoding.h:22-24` and then never reads them, so `decode_string` here does
// not either. Keeping them (rather than dropping them) is what makes the
// header-for-header correspondence with the C checkable; do not add a use for
// them without checking the C grew one first.
//
// `#[cfg(test)]`, and deliberately NOT public. Each one's own documentation
// says not to bounds-check against it, which is disqualifying for a stable
// export: the names read like enforced limits, they sit next to the `MIN_`/
// `MAX_` constants that really are enforced, and `MIN_DECODED_SALT_LEN` even
// holds the same value as the real bound today. A caller who reaches for one
// gets a limit the decoder does not apply. They stay here so
// `decoded_mirrors_are_not_decoder_bounds` can keep pinning the gap.

/// `ARGON2_MAX_DECODED_LANES`.
///
/// Mirrored from `encoding.h:22`, and **not a bound this crate enforces**. The
/// C defines the macro there and then never reads it, in `encoding.c` or
/// anywhere else in the tree, so `decode_string` here does not read it either.
/// What actually bounds the `p=` field of a decoded PHC string is
/// [`MAX_LANES`] (`0x00FF_FFFF`), applied by [`validate_inputs`] inside
/// `decode_string`.
///
/// Do not use this constant to bounds-check decoded input: a well-formed
/// string can carry a `p` far above 255 and will decode and verify. Measured
/// against this crate, `p=300` round-trips through `hash_encoded` and
/// `verify_encoded`:
///
/// ```text
/// $argon2id$v=19$m=2400,t=1,p=300$c29tZXNhbHQ$tPLI8hre65Crk/uP5eIGCZzn3TQ7RzRoXIkGzt5jQoI
/// ```
///
/// (`m=2400` because [`validate_inputs`] requires `m_cost >= 8 * lanes`, not
/// because 255 played any part.) The `decoded_mirrors_are_not_decoder_bounds`
/// test pins the gap between this value and the bound that is real.
#[cfg(test)]
const MAX_DECODED_LANES: u32 = 255;
/// `ARGON2_MIN_DECODED_SALT_LEN`.
///
/// Mirrored from `encoding.h:23`, and unread for the same reason: the C
/// defines it and never consults it, so `decode_string` here does not either.
/// The salt of a decoded string is bounded by [`MIN_SALT_LENGTH`], applied by
/// [`validate_inputs`].
///
/// The two happen to hold the same value (8) today, which is exactly what
/// makes this constant easy to mistake for the enforced minimum. It is not the
/// enforced minimum, and nothing ties the two together: they come from
/// different headers (`encoding.h` and `argon2.h`), and if [`MIN_SALT_LENGTH`]
/// ever moves the decoder moves with it while this value stays at 8. Check
/// decoded salts against [`MIN_SALT_LENGTH`].
#[cfg(test)]
const MIN_DECODED_SALT_LEN: u32 = 8;
/// `ARGON2_MIN_DECODED_OUT_LEN`.
///
/// Mirrored from `encoding.h:24`, and likewise never read by the C, so
/// `decode_string` here does not read it either. The tag length of a decoded
/// string is bounded by [`MIN_OUTLEN`], applied by [`validate_inputs`].
///
/// Do not use this constant to bounds-check decoded input: [`MIN_OUTLEN`] is
/// 4, so a decoded tag can legitimately undershoot 12. Measured against this
/// crate, an 8-byte tag round-trips through `hash_encoded` and
/// `verify_encoded`:
///
/// ```text
/// $argon2id$v=19$m=2400,t=1,p=1$c29tZXNhbHQ$kQGQLZpZJIk
/// ```
#[cfg(test)]
const MIN_DECODED_OUT_LEN: u32 = 12;

// ---------------------------------------------------------------------------
// Algorithm
// ---------------------------------------------------------------------------

/// The Argon2 primitive type (`argon2_type`).
///
/// The numeric values matter: `initial_hash` hashes them, and `fill_segment`
/// puts `instance->type` into `input_block.v[5]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
#[repr(u32)]
pub enum Algorithm {
    /// `Argon2_d` (0): data-dependent addressing.
    Argon2d = 0,
    /// `Argon2_i` (1): data-independent addressing.
    Argon2i = 1,
    /// `Argon2_id` (2): first half-pass independent, rest dependent. The default.
    #[default]
    Argon2id = 2,
}

impl Algorithm {
    /// The `argon2_type` numeric value.
    #[inline]
    #[must_use]
    pub const fn as_u32(self) -> u32 {
        self as u32
    }

    /// Parse an `argon2_type` numeric value.
    #[inline]
    #[must_use]
    pub const fn from_u32(value: u32) -> Option<Algorithm> {
        match value {
            0 => Some(Algorithm::Argon2d),
            1 => Some(Algorithm::Argon2i),
            2 => Some(Algorithm::Argon2id),
            _ => None,
        }
    }

    /// `argon2_type2string(type, 0)`: the lowercase name used in PHC strings.
    ///
    /// Note `"argon2i"` is a prefix of `"argon2id"`; the C decoder relies on
    /// the *next* character failing to parse, and the Rust decoder must too.
    #[inline]
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Algorithm::Argon2d => "argon2d",
            Algorithm::Argon2i => "argon2i",
            Algorithm::Argon2id => "argon2id",
        }
    }

    /// `argon2_type2string(type, 1)`: the capitalised name (used by genkat).
    #[inline]
    #[must_use]
    pub const fn as_str_uppercase(self) -> &'static str {
        match self {
            Algorithm::Argon2d => "Argon2d",
            Algorithm::Argon2i => "Argon2i",
            Algorithm::Argon2id => "Argon2id",
        }
    }

    /// All three variants, in `argon2_type` order.
    pub const ALL: [Algorithm; 3] = [Algorithm::Argon2d, Algorithm::Argon2i, Algorithm::Argon2id];
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/// The Argon2 version (`argon2_version`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
#[repr(u32)]
pub enum Version {
    /// `ARGON2_VERSION_10` (0x10). Blocks are always overwritten, never XORed.
    V0x10 = 0x10,
    /// `ARGON2_VERSION_13` (0x13) — `ARGON2_VERSION_NUMBER`, the default.
    #[default]
    V0x13 = 0x13,
}

impl Version {
    /// `ARGON2_VERSION_NUMBER`.
    pub const DEFAULT: Version = Version::V0x13;

    /// Both variants, ascending.
    pub const ALL: [Version; 2] = [Version::V0x10, Version::V0x13];

    /// The `argon2_version` numeric value.
    #[inline]
    #[must_use]
    pub const fn as_u32(self) -> u32 {
        self as u32
    }

    /// Parse an `argon2_version` numeric value.
    #[inline]
    #[must_use]
    pub const fn from_u32(value: u32) -> Option<Version> {
        match value {
            0x10 => Some(Version::V0x10),
            0x13 => Some(Version::V0x13),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// validate_inputs
// ---------------------------------------------------------------------------

/// `validate_inputs()` from `src/core.c`, in the exact same order.
///
/// The order is load-bearing: when several inputs are invalid, the C reference
/// returns the error for whichever check runs first, and the differential tests
/// compare error codes.
///
/// Checks the C performs that are omitted here, with the reason:
///
/// * `context == NULL` → `ARGON2_INCORRECT_PARAMETER`: no null contexts in Rust.
/// * `out == NULL` → `ARGON2_OUTPUT_PTR_NULL`: no null slices in Rust.
/// * the four `*_PTR_MISMATCH` checks: a Rust slice always has a valid pointer.
/// * `ARGON2_MIN_PWD_LENGTH > pwdlen`, `ARGON2_MIN_AD_LENGTH > adlen`,
///   `ARGON2_MIN_SECRET > secretlen`: those minima are all 0, so the checks can
///   never fire (and would be tautological comparisons in Rust).
/// * the two allocator-callback checks: this crate has no allocator callbacks.
///
/// Note the C computes `8 * context->lanes` in `uint32_t`, *before* `lanes` has
/// been range-checked, so it can wrap. [`u32::wrapping_mul`] reproduces that:
/// `lanes = 0xFFFF_FFFF` yields `MemoryTooLittle`, not `LanesTooMany`.
///
/// # Prefer [`Params::validate_for`]
///
/// This free function is the escape hatch, not the main path.
/// [`Params::validate_for`] calls it with five of the nine arguments filled in
/// from the receiver: the tag length (`out_len`, from [`Params::tag_len_bytes`])
/// and the four cost values (`m_cost`, `t_cost`, `lanes`, `threads`). It leaves
/// the caller exactly the four buffer lengths, `pwd_len`, `salt_len`,
/// `secret_len` and `ad_len`. Those five values come from a [`Params`] that
/// [`ParamsBuilder::build`] already ran through this function, so they cannot
/// drift from the costs the hash will actually run with, and `core` takes that
/// route on every hash.
///
/// Reach for this function directly only when the C's exact check ordering is
/// what is wanted, which is the one thing the `Params` route cannot give you:
/// [`ParamsBuilder::build`] validates the cost parameters at construction time,
/// so a caller who supplies both a bad `m_cost` and a short salt sees the
/// `m_cost` error where the C reports `ARGON2_SALT_TOO_SHORT` (the divergence
/// note on [`Params`] spells this out).
/// `decode_string` is the in-crate example: it calls this function directly on
/// the decoded fields and only builds its `Params` afterwards, so that a
/// malformed PHC string yields the same error code `validate_inputs()`
/// (`core.c:388-513`) yields in the C.
///
/// ```
/// use argon2_rust::Error;
/// use argon2_rust::params::{Memory, Params, validate_inputs};
///
/// let params = Params::builder().memory(Memory::kib(19_456)).passes(2).build()?;
///
/// // Four arguments. The tag length and the four costs come from `params`.
/// assert_eq!(params.validate_for(8, 16, 0, 0), Ok(()));
///
/// // The same check spelled out. The five values `params` would have supplied
/// // have to be repeated by hand and kept in step with it.
/// assert_eq!(validate_inputs(32, 8, 16, 0, 0, 19_456, 2, 1, 1), Ok(()));
///
/// // `out_len` and `pwd_len` transposed, which is the pair `validate_for`
/// // takes off the call site entirely. Both are `usize` and adjacent, so this
/// // compiles, and there is no error to notice: the password length 8 is now
/// // the tag length, 8 clears `MIN_OUTLEN` (4), and the call says `Ok(())`
/// // while agreeing to a 64-bit tag.
/// assert_eq!(validate_inputs(8, 32, 16, 0, 0, 19_456, 2, 1, 1), Ok(()));
///
/// // The method form cannot be told that. `out_len` is not one of its four
/// // arguments; it comes from the `Params`, which holds it at 32.
/// assert_eq!(params.tag_len_bytes(), 32);
/// assert_eq!(params.validate_for(32, 16, 0, 0), Ok(()));
/// # Ok::<(), Error>(())
/// ```
// `MAX_TIME` is `u32::MAX`, and so is `MAX_MEMORY` on a 64-bit target, which
// makes those two upper-bound checks tautologically false there. They are kept
// verbatim so the check order matches the C exactly, and because `MAX_MEMORY` is
// `0x20_0000` on a 32-bit target, where the check is real.
#[allow(clippy::absurd_extreme_comparisons)]
// Nine parameters, one per `argon2_context` field the C checks. Grouping them
// would obscure the 1:1 correspondence with `validate_inputs()`.
#[allow(clippy::too_many_arguments)]
pub const fn validate_inputs(
    out_len: usize,
    pwd_len: usize,
    salt_len: usize,
    secret_len: usize,
    ad_len: usize,
    m_cost: u32,
    t_cost: u32,
    lanes: u32,
    threads: u32,
) -> Result<(), Error> {
    // Validate output length.
    if out_len < MIN_OUTLEN as usize {
        return Err(Error::OutputTooShort);
    }
    if out_len > MAX_OUTLEN as usize {
        return Err(Error::OutputTooLong);
    }

    // Validate password (required param).
    if pwd_len > MAX_PWD_LENGTH as usize {
        return Err(Error::PwdTooLong);
    }

    // Validate salt (required param). Note the C checks the length even when
    // `salt == NULL`, so an empty salt is `SaltTooShort`, not a ptr mismatch.
    if salt_len < MIN_SALT_LENGTH as usize {
        return Err(Error::SaltTooShort);
    }
    if salt_len > MAX_SALT_LENGTH as usize {
        return Err(Error::SaltTooLong);
    }

    // Validate secret (optional param).
    if secret_len > MAX_SECRET as usize {
        return Err(Error::SecretTooLong);
    }

    // Validate associated data (optional param).
    if ad_len > MAX_AD_LENGTH as usize {
        return Err(Error::AdTooLong);
    }

    // Validate memory cost. Three checks, in this order.
    if m_cost < MIN_MEMORY {
        return Err(Error::MemoryTooLittle);
    }
    if m_cost > MAX_MEMORY {
        return Err(Error::MemoryTooMuch);
    }
    if m_cost < 8u32.wrapping_mul(lanes) {
        return Err(Error::MemoryTooLittle);
    }

    // Validate time cost.
    if t_cost < MIN_TIME {
        return Err(Error::TimeTooSmall);
    }
    if t_cost > MAX_TIME {
        return Err(Error::TimeTooLarge);
    }

    // Validate lanes.
    if lanes < MIN_LANES {
        return Err(Error::LanesTooFew);
    }
    if lanes > MAX_LANES {
        return Err(Error::LanesTooMany);
    }

    // Validate threads.
    if threads < MIN_THREADS {
        return Err(Error::ThreadsTooFew);
    }
    if threads > MAX_THREADS {
        return Err(Error::ThreadsTooMany);
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/// Validated Argon2 cost parameters.
///
/// Holds exactly the fields of `argon2_context` that are *not* byte buffers:
/// `m_cost`, `t_cost`, `lanes`, `threads` and `outlen`. Password, salt, secret
/// and associated data are passed per call.
///
/// There is no public field and no public constructor: every `Params` comes out
/// of [`ParamsBuilder::build`], which runs [`validate_inputs`], or out of a
/// preset ([`Params::DEFAULT`], [`Params::OWASP`],
/// [`Params::RFC9106_HIGH_MEMORY`], [`Params::RFC9106_LOW_MEMORY`]) that
/// `build`'s `const` twin already ran. So `lanes >= 1` always holds and the
/// derived values below never divide by zero.
///
/// Start from [`Params::builder`], or from [`Params::to_builder`] to adjust an
/// existing value.
///
/// # Known divergence from the C reference
///
/// [`ParamsBuilder::build`] validates the cost parameters immediately, whereas
/// the C checks salt length *before* `m_cost`. If a caller supplies both a bad
/// `m_cost` and a short salt, this crate reports the `m_cost` error at
/// `Params` construction time while the C reports `ARGON2_SALT_TOO_SHORT`.
/// Call [`validate_inputs`] directly to reproduce the C ordering exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Params {
    m_cost: u32,
    t_cost: u32,
    lanes: u32,
    threads: u32,
    output_len: u32,
}

/// Builder for [`Params`].
///
/// Every setter is a `const fn` taking `self` by value, so a `Params` can be
/// built in a `const` item — see [`ParamsBuilder::build_or_panic`]. The builder
/// starts from [`ParamsBuilder::DEFAULT`], so each setter is optional.
///
/// ```
/// use argon2_rust::{Params, params::{Memory, TagLen}};
///
/// let params = Params::builder()
///     .memory(Memory::mib(64))
///     .passes(3)
///     .lanes(4)
///     .tag_len(TagLen::bytes(32))
///     .build()?;
/// assert_eq!(params.memory(), Memory::mib(64));
/// # Ok::<(), argon2_rust::Error>(())
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ParamsBuilder {
    memory: Memory,
    passes: u32,
    lanes: u32,
    /// `None` means "track `lanes`", which is what `argon2_hash()` does: it
    /// sets both `context.lanes` and `context.threads` from one argument.
    /// Storing the choice rather than eagerly copying `lanes` is what makes
    /// `.threads(2).lanes(4)` and `.lanes(4).threads(2)` agree.
    threads: Option<u32>,
    tag_len: TagLen,
}

impl ParamsBuilder {
    /// The starting point: OWASP's Argon2id profile, 19 MiB, two passes, one
    /// lane, a 32-byte tag.
    ///
    /// These are literals rather than a copy of [`Params::DEFAULT`]'s fields
    /// on purpose. `Params::DEFAULT` is built *by* this builder, so reading it
    /// here would be a cyclic `const`.
    pub const DEFAULT: ParamsBuilder = ParamsBuilder {
        memory: Memory::kib(19456),
        passes: 2,
        lanes: 1,
        threads: None,
        tag_len: TagLen::bytes(32),
    };

    /// Set the memory cost.
    #[inline]
    #[must_use]
    pub const fn memory(mut self, memory: Memory) -> ParamsBuilder {
        self.memory = memory;
        self
    }

    /// Set the number of passes (`t_cost` in the C, `t=` in a PHC string).
    #[inline]
    #[must_use]
    pub const fn passes(mut self, passes: u32) -> ParamsBuilder {
        self.passes = passes;
        self
    }

    /// Set the degree of parallelism (`p=` in a PHC string).
    ///
    /// This one feeds the tag. Changing it changes the hash.
    #[inline]
    #[must_use]
    pub const fn lanes(mut self, lanes: u32) -> ParamsBuilder {
        self.lanes = lanes;
        self
    }

    /// Set the worker-thread budget.
    ///
    /// A pure performance knob: it does **not** affect the tag. Only `lanes`
    /// does. Left unset it tracks [`ParamsBuilder::lanes`], which is what
    /// `argon2_hash()` does — it sets both `context.lanes` and
    /// `context.threads` from its single `parallelism` argument. The effective
    /// count is `min(threads, lanes)`, see [`Params::effective_threads`].
    ///
    /// ```
    /// use argon2_rust::{Algorithm, Argon2, Params, Version, params::Memory};
    ///
    /// // Four lanes of work, but never more than two OS threads to run them.
    /// let budgeted = Params::builder()
    ///     .memory(Memory::kib(64))
    ///     .passes(1)
    ///     .lanes(4)
    ///     .threads(2)
    ///     .build()?;
    /// assert_eq!((budgeted.lanes(), budgeted.threads()), (4, 2));
    /// assert_eq!(budgeted.effective_threads(), 2);
    ///
    /// // Asking for more threads than lanes is legal, and the extra workers
    /// // simply have no lane to claim.
    /// let oversubscribed = Params::builder()
    ///     .memory(Memory::kib(64))
    ///     .passes(1)
    ///     .lanes(2)
    ///     .threads(8)
    ///     .build()?;
    /// assert_eq!(oversubscribed.effective_threads(), 2);
    ///
    /// // Leaving it unset is exactly `threads == lanes`.
    /// let full = Params::builder()
    ///     .memory(Memory::kib(64))
    ///     .passes(1)
    ///     .lanes(4)
    ///     .build()?;
    /// assert_eq!(full, budgeted.to_builder().threads(4).build()?);
    /// assert_eq!(full.threads(), 4);
    ///
    /// // And the knob really is free of the tag: same `lanes`, same bytes,
    /// // whichever thread budget produced them.
    /// let two_workers = Argon2::new(Algorithm::Argon2id, Version::V0x13, budgeted);
    /// let four_workers = Argon2::new(Algorithm::Argon2id, Version::V0x13, full);
    /// assert_eq!(
    ///     two_workers.hash(b"password", b"somesalt")?,
    ///     four_workers.hash(b"password", b"somesalt")?,
    /// );
    /// # Ok::<(), argon2_rust::Error>(())
    /// ```
    #[inline]
    #[must_use]
    pub const fn threads(mut self, threads: u32) -> ParamsBuilder {
        self.threads = Some(threads);
        self
    }

    /// Set the tag length.
    #[inline]
    #[must_use]
    pub const fn tag_len(mut self, tag_len: TagLen) -> ParamsBuilder {
        self.tag_len = tag_len;
        self
    }

    /// Validate and produce [`Params`].
    ///
    /// # Errors
    ///
    /// Any of the cost-parameter errors from [`validate_inputs`], plus
    /// [`Error::OutputTooLong`] and [`Error::MemoryTooMuch`] for values too
    /// large for this target at all.
    pub const fn build(self) -> Result<Params, Error> {
        // `Memory` and `TagLen` hold `u64`; `validate_inputs` takes a `u32`
        // memory cost and a `usize` output length. Range-check BEFORE
        // narrowing: on a 32-bit target `(1u64 << 40) as usize` is 0, which
        // would turn OutputTooLong into OutputTooShort.
        //
        // The order here is the C's. `validate_inputs` checks BOTH `out_len`
        // bounds before it looks at `m_cost`, so both are checked here too —
        // pre-checking only the upper bound would report MemoryTooMuch for a
        // 3-byte tag combined with an over-large memory cost, where the C
        // reports OutputTooShort. That combination is reachable from a crafted
        // PHC string, whose tag length and `m=` are both attacker-chosen.
        let bytes = self.tag_len.as_bytes();
        if bytes > MAX_OUTLEN as u64 {
            return Err(Error::OutputTooLong);
        }
        if bytes < MIN_OUTLEN as u64 {
            return Err(Error::OutputTooShort);
        }
        let kib = self.memory.as_kib();
        if kib > MAX_MEMORY as u64 {
            return Err(Error::MemoryTooMuch);
        }

        let threads = match self.threads {
            Some(threads) => threads,
            None => self.lanes,
        };

        // Placeholder lengths that always pass their own checks, so the
        // *relative* order of the checks that do apply is exactly the C's.
        match validate_inputs(
            bytes as usize,
            0,
            MIN_SALT_LENGTH as usize,
            0,
            0,
            kib as u32,
            self.passes,
            self.lanes,
            threads,
        ) {
            Ok(()) => {}
            Err(e) => return Err(e),
        }

        Ok(Params {
            m_cost: kib as u32,
            t_cost: self.passes,
            lanes: self.lanes,
            threads,
            output_len: bytes as u32,
        })
    }

    /// Validate and produce [`Params`], panicking on invalid parameters.
    ///
    /// This exists for `const` items, where a panic is a compile error:
    ///
    /// ```
    /// use argon2_rust::{Params, params::Memory};
    ///
    /// const LOGIN: Params = Params::builder()
    ///     .memory(Memory::mib(64))
    ///     .passes(3)
    ///     .build_or_panic();
    /// assert_eq!(LOGIN.passes(), 3);
    /// ```
    ///
    /// # Panics
    ///
    /// If the parameters are invalid. Use [`ParamsBuilder::build`] anywhere a
    /// runtime error is the right answer — it is the normal way in, and it is
    /// why no fallible path in this crate panics.
    #[must_use]
    pub const fn build_or_panic(self) -> Params {
        match self.build() {
            Ok(params) => params,
            Err(_) => panic!("invalid Argon2 parameters"),
        }
    }
}

impl Default for ParamsBuilder {
    fn default() -> ParamsBuilder {
        ParamsBuilder::DEFAULT
    }
}

impl Params {
    /// The recommended default: OWASP's Argon2id profile.
    ///
    /// 19 MiB, two passes, one lane, a 32-byte tag. Equal to [`Params::OWASP`]
    /// and to `Params::default()`.
    pub const DEFAULT: Params = ParamsBuilder::DEFAULT.build_or_panic();

    /// OWASP's Argon2id profile: 19 MiB, `t=2`, `p=1`, 32-byte tag.
    ///
    /// The same value as [`Params::DEFAULT`], under the name that says where
    /// the numbers come from.
    pub const OWASP: Params = Params::DEFAULT;

    /// RFC 9106 §4's first recommendation: 2 GiB, `t=1`, `p=4`, 32-byte tag.
    ///
    /// On a 32-bit target 2 GiB is exactly [`MAX_MEMORY`], so this constant
    /// still compiles there — but the arena will fail to allocate inside a
    /// 4 GiB address space. Prefer [`Params::RFC9106_LOW_MEMORY`] there.
    pub const RFC9106_HIGH_MEMORY: Params = ParamsBuilder::DEFAULT
        .memory(Memory::gib(2))
        .passes(1)
        .lanes(4)
        .build_or_panic();

    /// RFC 9106 §4's second recommendation, for memory-constrained systems:
    /// 64 MiB, `t=3`, `p=4`, 32-byte tag.
    pub const RFC9106_LOW_MEMORY: Params = ParamsBuilder::DEFAULT
        .memory(Memory::mib(64))
        .passes(3)
        .lanes(4)
        .build_or_panic();

    /// Start building, from [`ParamsBuilder::DEFAULT`].
    #[inline]
    #[must_use]
    pub const fn builder() -> ParamsBuilder {
        ParamsBuilder::DEFAULT
    }

    /// Reopen these parameters for adjustment.
    ///
    /// ```
    /// use argon2_rust::Params;
    ///
    /// let narrow = Params::RFC9106_LOW_MEMORY.to_builder().lanes(1).build()?;
    /// assert_eq!(narrow.lanes(), 1);
    /// # Ok::<(), argon2_rust::Error>(())
    /// ```
    #[inline]
    #[must_use]
    pub const fn to_builder(self) -> ParamsBuilder {
        ParamsBuilder {
            memory: Memory::kib(self.m_cost as u64),
            passes: self.t_cost,
            lanes: self.lanes,
            // `Some`, not `None`: a round trip must preserve an explicit
            // thread budget that differs from `lanes`.
            threads: Some(self.threads),
            tag_len: TagLen::bytes(self.output_len as u64),
        }
    }

    /// The memory cost.
    #[inline]
    #[must_use]
    pub const fn memory(&self) -> Memory {
        Memory::kib(self.m_cost as u64)
    }

    /// The memory cost in kibibytes (`context.m_cost`, `m=` in a PHC string).
    ///
    /// A `u32`, losslessly: `build()` rejected anything wider.
    #[inline]
    #[must_use]
    pub const fn memory_kib(&self) -> u32 {
        self.m_cost
    }

    /// Number of passes (`context.t_cost`, `instance.passes`, `t=`).
    #[inline]
    #[must_use]
    pub const fn passes(&self) -> u32 {
        self.t_cost
    }

    /// The tag length.
    #[inline]
    #[must_use]
    pub const fn tag_len(&self) -> TagLen {
        TagLen::bytes(self.output_len as u64)
    }

    /// The tag length in bytes (`context.outlen`).
    ///
    /// A `usize`, losslessly: `build()` rejected anything wider.
    #[inline]
    #[must_use]
    pub const fn tag_len_bytes(&self) -> usize {
        self.output_len as usize
    }

    /// Run the full `validate_inputs()` sequence for a concrete call.
    ///
    /// `core` calls this on every hash so the salt/password/secret/ad checks
    /// fire in the C's order.
    ///
    /// # Errors
    ///
    /// Any error from [`validate_inputs`].
    pub const fn validate_for(
        &self,
        pwd_len: usize,
        salt_len: usize,
        secret_len: usize,
        ad_len: usize,
    ) -> Result<(), Error> {
        validate_inputs(
            self.output_len as usize,
            pwd_len,
            salt_len,
            secret_len,
            ad_len,
            self.m_cost,
            self.t_cost,
            self.lanes,
            self.threads,
        )
    }

    /// Degree of parallelism (`context.lanes`). Affects the tag.
    #[inline]
    #[must_use]
    pub const fn lanes(&self) -> u32 {
        self.lanes
    }

    /// Requested worker threads (`context.threads`). Does not affect the tag.
    #[inline]
    #[must_use]
    pub const fn threads(&self) -> u32 {
        self.threads
    }

    /// `min(threads, lanes)`, as `argon2_ctx` computes it.
    #[inline]
    #[must_use]
    pub const fn effective_threads(&self) -> u32 {
        if self.threads > self.lanes {
            self.lanes
        } else {
            self.threads
        }
    }

    /// Step 2 of `argon2_ctx()`: align the memory size.
    ///
    /// ```text
    /// memory_blocks = m_cost;
    /// if (memory_blocks < 2 * SYNC_POINTS * lanes)
    ///     memory_blocks = 2 * SYNC_POINTS * lanes;
    /// segment_length = memory_blocks / (lanes * SYNC_POINTS);
    /// memory_blocks  = segment_length * (lanes * SYNC_POINTS);
    /// lane_length    = segment_length * SYNC_POINTS;
    /// ```
    ///
    /// Returns `(memory_blocks, segment_length, lane_length)`. No overflow is
    /// possible: `lanes <= MAX_LANES` (`0xFF_FFFF`), so `lanes * SYNC_POINTS`
    /// fits comfortably in `u32`, and `segment_length * lanes * SYNC_POINTS`
    /// is bounded by the original `memory_blocks <= MAX_MEMORY`.
    #[inline]
    #[must_use]
    pub const fn memory_layout(&self) -> (u32, u32, u32) {
        let lanes_x_sync = self.lanes * SYNC_POINTS;
        let min_blocks = 2 * SYNC_POINTS * self.lanes;

        let mut memory_blocks = self.m_cost;
        if memory_blocks < min_blocks {
            memory_blocks = min_blocks;
        }

        let segment_length = memory_blocks / lanes_x_sync;
        memory_blocks = segment_length * lanes_x_sync;
        let lane_length = segment_length * SYNC_POINTS;

        (memory_blocks, segment_length, lane_length)
    }

    /// Number of 1 KiB blocks the arena needs (`instance.memory_blocks`).
    #[inline]
    #[must_use]
    pub const fn memory_blocks(&self) -> u32 {
        self.memory_layout().0
    }

    /// Blocks per segment (`instance.segment_length`).
    #[inline]
    #[must_use]
    pub const fn segment_length(&self) -> u32 {
        self.memory_layout().1
    }

    /// Blocks per lane (`instance.lane_length` = `segment_length * SYNC_POINTS`).
    #[inline]
    #[must_use]
    pub const fn lane_length(&self) -> u32 {
        self.memory_layout().2
    }
}

impl Default for Params {
    /// [`Params::DEFAULT`]: OWASP's profile, 19 MiB, `t=2`, `p=1`, 32-byte tag.
    fn default() -> Params {
        Params::DEFAULT
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_match_the_c_preprocessor() {
        // Printed by compiling include/argon2.h on aarch64-apple-darwin:
        //   MAX_MEMORY_BITS = 32, MAX_MEMORY = 4294967295, MIN_MEMORY = 8,
        //   MAX_OUTLEN = 4294967295, MAX_LANES = 16777215
        assert_eq!(MIN_MEMORY, 8);
        assert_eq!(MAX_LANES, 16_777_215);
        assert_eq!(MAX_OUTLEN, 4_294_967_295);
        if size_of::<*const u8>() == 8 {
            assert_eq!(MAX_MEMORY_BITS, 32);
            assert_eq!(MAX_MEMORY, 4_294_967_295);
        }
        assert_eq!(BLOCK_SIZE, 1024);
        assert_eq!(QWORDS_IN_BLOCK, 128);
        assert_eq!(OWORDS_IN_BLOCK, 64);
        assert_eq!(HWORDS_IN_BLOCK, 32);
        assert_eq!(BITS512_WORDS_IN_BLOCK, 16);
        assert_eq!(PREHASH_SEED_LENGTH - PREHASH_DIGEST_LENGTH, 8);
    }

    #[test]
    fn decoded_mirrors_are_not_decoder_bounds() {
        // The three `encoding.h` mirrors are read by nobody: not by the C, and
        // so not by `decode_string` here either. Each one's doc tells a caller
        // not to bounds-check against it. This pins the gap that makes that
        // advice true, so the prose cannot go stale.
        //
        // In `const` blocks so the checks run at compile time: every operand is
        // a constant, so a violation is a build error rather than a red test,
        // and clippy::assertions_on_constants stays quiet.

        // `lanes` is bounded by `MAX_LANES` (16_777_215), roughly 65_000x this
        // value. Measured: `$argon2id$v=19$m=2400,t=1,p=300$...` encodes and
        // verifies, with `p` well past 255. A strict `<` is the point — if the
        // two ever met, "this is not the bound" would be false.
        const { assert!(MAX_DECODED_LANES < MAX_LANES) }

        // The mirror sits ABOVE the enforced minimum (12 against 4), which is
        // what lets a decoded tag legitimately undershoot it. Measured: an
        // 8-byte tag round-trips.
        const { assert!(MIN_DECODED_OUT_LEN > MIN_OUTLEN) }

        // The salt mirror is the nastiest of the three because it agrees with
        // the enforced bound today, which is exactly why it reads like the
        // enforced bound. Pinned as equal on purpose: the day `MIN_SALT_LENGTH`
        // moves, this fails and sends the next reader to the doc above that
        // says "they happen to hold the same value (8) today" — prose that
        // would otherwise quietly become wrong.
        const { assert!(MIN_DECODED_SALT_LEN == MIN_SALT_LENGTH) }
    }

    /// Pins the two PHC strings the docs on `MAX_DECODED_LANES` and
    /// `MIN_DECODED_OUT_LEN` quote as evidence.
    ///
    /// Each of those docs tells a caller not to bounds-check decoded input
    /// against the constant, and each backs the advice with a measured string
    /// that breaks the constant and round-trips anyway: `p=300` against a
    /// documented 255, and an 8-byte tag against a documented 12. The strings
    /// were pasted in from a run of this crate and nothing recomputed them, so
    /// a change to `encode_string`, to the tag derivation, or to what
    /// `ParamsBuilder::build` does with `m_cost` would leave the docs quoting
    /// output the crate no longer produces, with no test failing. Reproduced
    /// here from the parameters those docs state, byte for byte, and verified
    /// back through `verify_encoded` so the word "round-trips" is pinned too.
    #[test]
    fn decoded_bound_docs_quote_strings_this_crate_still_produces() {
        use crate::Argon2;

        // `MAX_DECODED_LANES` is 255 and this is `p=300`. `m=2400` is forced by
        // `validate_inputs`' `m_cost >= 8 * lanes` rule, not by 255.
        let params = Params::builder()
            .memory(Memory::kib(2400))
            .passes(1)
            .lanes(300)
            .tag_len(TagLen::bytes(32))
            .build()
            .unwrap();
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let encoded = argon2.hash_encoded(b"password", b"somesalt").unwrap();
        assert_eq!(
            encoded,
            "$argon2id$v=19$m=2400,t=1,p=300$c29tZXNhbHQ$tPLI8hre65Crk/uP5eIGCZzn3TQ7RzRoXIkGzt5jQoI"
        );
        assert_eq!(
            Argon2::verify_encoded(&encoded, b"password", Algorithm::Argon2id),
            Ok(())
        );

        // `MIN_DECODED_OUT_LEN` is 12 and this tag is 8 bytes, which `MIN_OUTLEN`
        // (4) allows. Same `m` and salt as above so the two strings differ only
        // where the docs say they do.
        let params = Params::builder()
            .memory(Memory::kib(2400))
            .passes(1)
            .lanes(1)
            .tag_len(TagLen::bytes(8))
            .build()
            .unwrap();
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let encoded = argon2.hash_encoded(b"password", b"somesalt").unwrap();
        assert_eq!(
            encoded,
            "$argon2id$v=19$m=2400,t=1,p=1$c29tZXNhbHQ$kQGQLZpZJIk"
        );
        assert_eq!(
            Argon2::verify_encoded(&encoded, b"password", Algorithm::Argon2id),
            Ok(())
        );
    }

    #[test]
    fn default_params_are_valid() {
        let d = Params::default();
        assert!(d.validate_for(0, 8, 0, 0).is_ok());
    }

    #[test]
    fn validate_order_salt_before_m_cost() {
        // Both are bad; the C checks salt first.
        assert_eq!(
            validate_inputs(32, 0, 0, 0, 0, 0, 1, 1, 1),
            Err(Error::SaltTooShort)
        );
    }

    #[test]
    fn validate_order_out_len_first() {
        assert_eq!(
            validate_inputs(0, 0, 0, 0, 0, 0, 0, 0, 0),
            Err(Error::OutputTooShort)
        );
    }

    #[test]
    fn m_cost_lanes_product_wraps_like_c() {
        // 8 * 0xFFFF_FFFF wraps to 0xFFFF_FFF8, so any sane m_cost is "too
        // little" and LanesTooMany never gets a chance to fire.
        assert_eq!(
            validate_inputs(32, 0, 8, 0, 0, 1 << 16, 1, 0xFFFF_FFFF, 1),
            Err(Error::MemoryTooLittle)
        );
        // With lanes in range, the 8*lanes rule is the third memory check.
        assert_eq!(
            validate_inputs(32, 0, 8, 0, 0, 16, 1, 4, 4),
            Err(Error::MemoryTooLittle)
        );
        assert_eq!(validate_inputs(32, 0, 8, 0, 0, 32, 1, 4, 4), Ok(()));
    }

    #[test]
    fn lanes_zero_is_lanes_too_few() {
        // 8 * 0 == 0, so the memory checks pass and LanesTooFew surfaces.
        assert_eq!(
            validate_inputs(32, 0, 8, 0, 0, 8, 1, 0, 1),
            Err(Error::LanesTooFew)
        );
    }

    #[test]
    fn memory_layout_matches_argon2_ctx() {
        // m_cost below the floor gets bumped to 2 * SYNC_POINTS * lanes.
        let p = Params::builder()
            .memory(Memory::kib(8))
            .passes(1)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .unwrap();
        assert_eq!(p.memory_layout(), (8, 2, 8));

        // 1 << 16 KiB, one lane: 65536 blocks, 16384 per segment.
        let p = Params::builder()
            .memory(Memory::kib(1 << 16))
            .passes(2)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .unwrap();
        assert_eq!(p.memory_layout(), (65536, 16384, 65536));

        // Four lanes: segment_length = 65536 / 16 = 4096, lane_length = 16384.
        let p = Params::builder()
            .memory(Memory::kib(1 << 16))
            .passes(2)
            .lanes(4)
            .tag_len(TagLen::bytes(32))
            .build()
            .unwrap();
        assert_eq!(p.memory_layout(), (65536, 4096, 16384));

        // Not a multiple of lanes * SYNC_POINTS: truncated down.
        let p = Params::builder()
            .memory(Memory::kib(100))
            .passes(1)
            .lanes(3)
            .tag_len(TagLen::bytes(32))
            .build()
            .unwrap();
        let (blocks, seg, lane) = p.memory_layout();
        assert_eq!(seg, 100 / 12);
        assert_eq!(blocks, seg * 12);
        assert_eq!(lane, seg * 4);
    }

    #[test]
    fn effective_threads_is_min() {
        let p = Params::builder()
            .memory(Memory::kib(1 << 16))
            .passes(1)
            .lanes(2)
            .threads(8)
            .tag_len(TagLen::bytes(32))
            .build()
            .unwrap();
        assert_eq!(p.threads(), 8);
        assert_eq!(p.effective_threads(), 2);
    }

    #[test]
    fn memory_units_convert() {
        assert_eq!(Memory::kib(65536), Memory::mib(64));
        assert_eq!(Memory::mib(1024), Memory::gib(1));
        assert_eq!(Memory::gib(2).as_kib(), 2 * 1024 * 1024);
        assert_eq!(Memory::kib(19456).as_kib(), 19456);
    }

    /// A plain `*` would panic here in a debug build. These constructors promise
    /// not to, so an absurd request saturates and is rejected later, by `build()`.
    #[test]
    fn memory_saturates_instead_of_overflowing() {
        assert_eq!(Memory::mib(u64::MAX).as_kib(), u64::MAX);
        assert_eq!(Memory::gib(u64::MAX).as_kib(), u64::MAX);
        assert_eq!(Memory::gib(u64::MAX / 1024).as_kib(), u64::MAX);
    }

    #[test]
    fn memory_orders_by_size() {
        assert!(Memory::mib(64) > Memory::kib(19456));
        assert!(Memory::gib(1) > Memory::mib(64));
    }

    #[test]
    fn tag_len_carries_bytes() {
        assert_eq!(TagLen::bytes(32).as_bytes(), 32);
        assert!(TagLen::bytes(64) > TagLen::bytes(32));
    }

    /// Both types must be usable in a `const` item, or the builder cannot be.
    #[test]
    fn units_are_const() {
        const M: Memory = Memory::mib(64);
        const T: TagLen = TagLen::bytes(32);
        assert_eq!(M.as_kib(), 65536);
        assert_eq!(T.as_bytes(), 32);
    }

    /// A `const` item, not a `let`. This is the whole reason the setters take
    /// `self` by value; if constness regresses, this stops compiling.
    const CONST_BUILT: Params = Params::builder()
        .memory(Memory::mib(64))
        .passes(3)
        .lanes(4)
        .build_or_panic();

    #[test]
    fn builder_builds_in_a_const_item() {
        assert_eq!(CONST_BUILT.memory_kib(), 65536);
        assert_eq!(CONST_BUILT.passes(), 3);
        assert_eq!(CONST_BUILT.lanes(), 4);
        assert_eq!(CONST_BUILT.threads(), 4);
        assert_eq!(CONST_BUILT.tag_len_bytes(), 32);
    }

    #[test]
    fn threads_defaults_to_lanes_but_an_explicit_value_survives() {
        let implicit = Params::builder().lanes(4).build().unwrap();
        assert_eq!((implicit.lanes(), implicit.threads()), (4, 4));

        // Order must not matter: setting lanes after threads may not clobber it.
        let explicit = Params::builder().threads(2).lanes(4).build().unwrap();
        assert_eq!((explicit.lanes(), explicit.threads()), (4, 2));
        assert_eq!(explicit.effective_threads(), 2);
    }

    #[test]
    fn typed_and_raw_accessors_agree() {
        let p = Params::builder()
            .memory(Memory::mib(64))
            .tag_len(TagLen::bytes(64))
            .build()
            .unwrap();
        assert_eq!(p.memory(), Memory::mib(64));
        assert_eq!(p.memory().as_kib(), u64::from(p.memory_kib()));
        assert_eq!(p.tag_len(), TagLen::bytes(64));
        assert_eq!(p.tag_len().as_bytes() as usize, p.tag_len_bytes());
    }

    #[test]
    fn presets_hold_their_documented_numbers() {
        assert_eq!(Params::OWASP, Params::DEFAULT);
        assert_eq!(Params::DEFAULT, Params::default());

        assert_eq!(Params::OWASP.memory_kib(), 19456);
        assert_eq!((Params::OWASP.passes(), Params::OWASP.lanes()), (2, 1));
        assert_eq!(Params::OWASP.tag_len_bytes(), 32);

        assert_eq!(Params::RFC9106_HIGH_MEMORY.memory(), Memory::gib(2));
        assert_eq!(
            (
                Params::RFC9106_HIGH_MEMORY.passes(),
                Params::RFC9106_HIGH_MEMORY.lanes()
            ),
            (1, 4)
        );

        assert_eq!(Params::RFC9106_LOW_MEMORY.memory(), Memory::mib(64));
        assert_eq!(
            (
                Params::RFC9106_LOW_MEMORY.passes(),
                Params::RFC9106_LOW_MEMORY.lanes()
            ),
            (3, 4)
        );
    }

    #[test]
    fn to_builder_round_trips_every_preset() {
        for preset in [
            Params::OWASP,
            Params::RFC9106_HIGH_MEMORY,
            Params::RFC9106_LOW_MEMORY,
        ] {
            assert_eq!(preset.to_builder().build(), Ok(preset));
        }
    }

    #[test]
    fn a_preset_can_be_adjusted() {
        let narrow = Params::RFC9106_LOW_MEMORY
            .to_builder()
            .lanes(1)
            .build()
            .unwrap();
        assert_eq!(narrow.memory(), Memory::mib(64));
        assert_eq!(narrow.passes(), 3);
        assert_eq!(narrow.lanes(), 1);
    }

    #[test]
    fn build_rejects_every_out_of_range_value() {
        let b = Params::builder();
        assert_eq!(
            b.memory(Memory::gib(9999)).build(),
            Err(Error::MemoryTooMuch)
        );
        assert_eq!(
            b.memory(Memory::kib(4)).build(),
            Err(Error::MemoryTooLittle)
        );
        assert_eq!(
            b.tag_len(TagLen::bytes(3)).build(),
            Err(Error::OutputTooShort)
        );
        assert_eq!(
            b.tag_len(TagLen::bytes(1 << 40)).build(),
            Err(Error::OutputTooLong)
        );
        assert_eq!(b.passes(0).build(), Err(Error::TimeTooSmall));
        assert_eq!(b.lanes(0).build(), Err(Error::LanesTooFew));
        assert_eq!(b.threads(0).build(), Err(Error::ThreadsTooFew));
    }

    /// `validate_inputs` checks BOTH `out_len` bounds before `m_cost`: its
    /// "Validate output length" block runs before its "Validate memory cost"
    /// block. `build()`'s own pre-narrowing checks must keep that order, so a
    /// caller who gets both wrong sees the error the C would have reported.
    /// Both directions are pinned: checking only the upper bound first is the
    /// bug this test exists to catch.
    #[test]
    fn tag_len_is_checked_before_memory_like_the_c() {
        let too_long = Params::builder()
            .memory(Memory::gib(9999))
            .tag_len(TagLen::bytes(1 << 40))
            .build();
        assert_eq!(too_long, Err(Error::OutputTooLong));

        // The case that a two-check implementation gets wrong: the tag is too
        // SHORT, so only `validate_inputs` would catch it — but the memory
        // pre-check would already have returned MemoryTooMuch. Reachable from a
        // crafted PHC string with a 3-byte tag and a large `m=`.
        let too_short = Params::builder()
            .memory(Memory::kib(MAX_MEMORY as u64 + 1))
            .tag_len(TagLen::bytes(3))
            .build();
        assert_eq!(too_short, Err(Error::OutputTooShort));
    }

    /// A saturated `Memory` must be rejected, not truncated into a legal `u32`.
    #[test]
    fn a_saturated_memory_is_rejected() {
        assert_eq!(
            Params::builder().memory(Memory::gib(u64::MAX)).build(),
            Err(Error::MemoryTooMuch)
        );
    }

    /// The narrowing guard in `build()`, pinned with the one value that makes a
    /// missing guard report the *wrong error* instead of no error.
    ///
    /// `Memory` holds a `u64` and `validate_inputs` takes a `u32`, so `build()`
    /// must range-check before it narrows. 8 TiB is chosen for exactly one
    /// reason: `(1u64 << 33) as u32` is **0**, and 0 is below `MIN_MEMORY`, so a
    /// guard that ran after the narrowing would answer `MemoryTooLittle` for an
    /// over-large request.
    ///
    /// What this protects is a direct builder input, not the PHC decoder:
    /// `decode_string` parses `m=` with `decimal_u32`, so no string can hand
    /// `build()` a memory value wider than `u32::MAX` KiB. A caller can, because
    /// `Memory::kib` takes a `u64` and `Memory::mib`/`Memory::gib` saturate into
    /// one — and answering `MemoryTooLittle` to a request for 8 TiB would be
    /// actively misleading.
    ///
    /// This is a different failure mode from the neighbours above, which is why
    /// it earns its own case rather than folding into them: `gib(9999)` and
    /// `gib(u64::MAX)` narrow to values *inside* the legal range on a 64-bit
    /// target, so a missing guard makes those two return `Ok`. `Memory::gib(8192)`
    /// is the same number if you prefer that spelling, but `kib(1u64 << 33)` is
    /// the one that shows the low 32 bits are zero, which is the whole point.
    #[test]
    fn memory_is_range_checked_before_it_is_narrowed() {
        assert_eq!(
            Params::builder().memory(Memory::kib(1u64 << 33)).build(),
            Err(Error::MemoryTooMuch)
        );
        // The claim about the low 32 bits, asserted rather than trusted.
        assert_eq!((1u64 << 33) as u32, 0);
        assert!(0 < MIN_MEMORY);
    }

    #[test]
    fn algorithm_and_version_round_trip() {
        for a in Algorithm::ALL {
            assert_eq!(Algorithm::from_u32(a.as_u32()), Some(a));
        }
        assert_eq!(Algorithm::from_u32(3), None);
        assert_eq!(Algorithm::Argon2id.as_str(), "argon2id");
        assert_eq!(Algorithm::Argon2i.as_str_uppercase(), "Argon2i");
        for v in Version::ALL {
            assert_eq!(Version::from_u32(v.as_u32()), Some(v));
        }
        assert_eq!(Version::from_u32(0x11), None);
        assert_eq!(Version::default(), Version::V0x13);
        assert_eq!(Algorithm::default(), Algorithm::Argon2id);
    }
}

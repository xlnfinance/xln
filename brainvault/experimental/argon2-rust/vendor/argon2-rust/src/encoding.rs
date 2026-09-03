//! Base64 (standard alphabet, **no** `=` padding) and the PHC hash string.
//!
//! Format: `$argon2<T>[$v=<num>]$m=<num>,t=<num>,p=<num>$<b64 salt>$<b64 hash>`.
//!
//! Ported line by line from `phc-winner-argon2/src/encoding.c`
//! (`b64_byte_to_char`, `b64_char_to_byte`, `to_base64`, `from_base64`,
//! `decode_decimal`, `encode_string`, `decode_string`, `b64len`, `numlen`) plus
//! `argon2_encodedlen` from `src/argon2.c`.
//!
//! Details the C reference gets subtly right, and this port does too:
//!
//! * The `$v=` field is **optional**. When absent the version defaults to
//!   `0x10`, not `0x13`.
//! * After decoding, `threads = lanes`.
//! * `"argon2i"` is a prefix of `"argon2id"`. The C matches the type string and
//!   then relies on the *next* character failing to parse (`$` is expected), so
//!   `"$argon2id$..."` is rejected when the caller asked for `Argon2i`.
//!   Reproduced here rather than special-cased.
//! * Decoding stops at the first non-base64 character, and then **rejects** if
//!   `acc_len > 4` or any buffered low bits are non-zero.
//! * `b64_char_to_byte` returns `0xFF` for an invalid character; a computed
//!   value of 0 is only valid for `'A'`.
//! * `decode_decimal` rejects an empty run of digits and rejects non-minimal
//!   encodings (a leading `'0'` followed by more digits).
//! * [`decode_string`] finishes by running the full `validate_inputs()`, and
//!   only then requires the string to be fully consumed. The order matters: a
//!   string with both a zero-length salt *and* trailing junk reports
//!   [`Error::SaltTooShort`], exactly like the C.
//!
//! The character classification is branch-free, as in the C: the `EQ`/`GT`/
//! `GE`/`LT`/`LE` macros become the [`eq`]/[`gt`]/[`ge`]/[`lt`]/[`le`] helpers
//! below, which return `0x00` for false and `0xFF` for true without branching.
//! It matters because these run over salt and tag material.
//!
//! # Known divergences from the C reference
//!
//! * **Unrepresentable versions.** `validate_inputs()` never looks at
//!   `ctx->version` (`core.c:388`), so the C accepts `$v=99`. It then applies
//!   the `0x13` *fill rule* to anything that is not `0x10` (`ref.c:181`) — but
//!   the raw value is also hashed into H0 (`core.c:561`
//!   `store32(&value, context->version)`), so the tag is version-specific and
//!   `$v=99` is a self-consistent, verifiable C record rather than an alias for
//!   `$v=19`. Measured against `libargon2.a`: `version=99` yields tag
//!   `2d4d864d…` where `version=19` yields `c1628832…`. [`Version`] is a closed
//!   enum, so [`decode_string`] reports [`Error::DecodingFail`] instead. This
//!   is the one divergence reachable from a conforming ASCII PHC string, and
//!   only from a producer emitting a version other than 16 or 19. The check is
//!   deliberately the *last* thing it does, so every other error code still
//!   matches the C.
//! * **Embedded NULs.** The C stops at the first `'\0'`; a Rust `&str` has no
//!   terminator, so the whole slice must be consumed. This is strictly
//!   stricter: it only rejects strings the C would have accepted by truncating.
//! * **Raw and non-ASCII bytes.** The C decoder takes an arbitrary `char *`
//!   byte string, while [`decode_string`] takes `&str`, so malformed UTF-8
//!   cannot reach this API. The C also has a signed-`char` bug in
//!   `b64_char_to_byte(*src)`: on Apple, x86 Linux and MSVC every byte
//!   `>= 0x80` sign-extends to a negative `int`, and `EQ`, which its own
//!   comment says is only valid "over values in the 0..255 range", then reports
//!   a spurious match against both `'+'` and `'/'`. Every such byte therefore
//!   decodes as 63 instead of being rejected. Measured on
//!   `aarch64-apple-darwin` against
//!   `libargon2.a`: `"$argon2i$v=19$m=65536,t=2,p=1$é9tZXNhbHQ$<tag>"` and
//!   `"…$//9tZXNhbHQ$<tag>"` both decode, to the same salt `ff ff 6d 65 …`.
//!   Replacing the first `/` with any single byte `0x80..=0xff`, including
//!   malformed UTF-8, also verifies the same record on that target.
//!   Where `char` is unsigned (aarch64 Linux) the same byte is rejected. This
//!   port always rejects, which matches the unsigned-`char` platforms and the
//!   evident intent, and is unreachable for any string the encoder produced.
//!   See `b64_char_to_byte_rejects_everything_else` below.

use alloc::string::String;
use alloc::vec::Vec;

use crate::base64::Base64Backend;
use crate::error::Error;
use crate::params::{Algorithm, Memory, Params, TagLen, Version, validate_inputs};

// ---------------------------------------------------------------------------
// Constant-time classification (encoding.c lines 74-78)
// ---------------------------------------------------------------------------
//
//   #define EQ(x, y) ((((0U - ((unsigned)(x) ^ (unsigned)(y))) >> 8) & 0xFF) ^ 0xFF)
//   #define GT(x, y) ((((unsigned)(y) - (unsigned)(x)) >> 8) & 0xFF)
//   #define GE(x, y) (GT(y, x) ^ 0xFF)
//   #define LT(x, y) GT(y, x)
//   #define LE(x, y) GE(y, x)
//
// Defined over 0..=255, returning 0x00 for false and 0xFF for true. The C
// evaluates them in `unsigned` with wrapping arithmetic, hence `wrapping_sub`.

/// `EQ(x, y)`: `0xFF` when `x == y`, else `0x00`.
#[inline]
const fn eq(x: u32, y: u32) -> u32 {
    ((0u32.wrapping_sub(x ^ y) >> 8) & 0xFF) ^ 0xFF
}

/// `GT(x, y)`: `0xFF` when `x > y`, else `0x00`.
#[inline]
const fn gt(x: u32, y: u32) -> u32 {
    (y.wrapping_sub(x) >> 8) & 0xFF
}

/// `GE(x, y)`: `0xFF` when `x >= y`, else `0x00`.
#[inline]
const fn ge(x: u32, y: u32) -> u32 {
    gt(y, x) ^ 0xFF
}

/// `LT(x, y)`: `0xFF` when `x < y`, else `0x00`.
#[inline]
const fn lt(x: u32, y: u32) -> u32 {
    gt(y, x)
}

/// `LE(x, y)`: `0xFF` when `x <= y`, else `0x00`.
#[inline]
const fn le(x: u32, y: u32) -> u32 {
    ge(y, x)
}

/// `b64_byte_to_char(x)`: map `0..64` to the standard base64 alphabet.
///
/// Branch-free, like the C. `x` is always masked to 6 bits by the caller.
#[inline]
const fn b64_byte_to_char(x: u32) -> u8 {
    // `'a' - 26` and `'0' - 52` are evaluated in the C as `int`; the second one
    // is negative (-4), which `wrapping_add` reproduces.
    let a_off = b'A' as u32;
    let lower_off = (b'a' as u32).wrapping_sub(26);
    let digit_off = (b'0' as u32).wrapping_sub(52);

    let c = (lt(x, 26) & x.wrapping_add(a_off))
        | (ge(x, 26) & lt(x, 52) & x.wrapping_add(lower_off))
        | (ge(x, 52) & lt(x, 62) & x.wrapping_add(digit_off))
        | (eq(x, 62) & b'+' as u32)
        | (eq(x, 63) & b'/' as u32);
    c as u8
}

/// `b64_char_to_byte(c)`: map a base64 character to its 6-bit value.
///
/// Returns `0xFF` for anything that is not a base64 character. Note the final
/// fixup: a computed value of 0 is only accepted for `'A'`, so every invalid
/// character (which also computes 0) is turned into `0xFF`.
///
/// `c` is always a `u8` widened to `u32`, i.e. `0..=255`, which is the range
/// the `EQ`/`GE`/`LE` macros are defined over. The C instead passes a `char`,
/// which sign-extends on most targets and makes bytes `>= 0x80` decode as 63
/// rather than being rejected — see the module docs.
#[inline]
const fn b64_char_to_byte(c: u32) -> u32 {
    let a_off = b'A' as u32;
    let lower_off = (b'a' as u32).wrapping_sub(26);
    let digit_off = (b'0' as u32).wrapping_sub(52);

    let x = (ge(c, b'A' as u32) & le(c, b'Z' as u32) & c.wrapping_sub(a_off))
        | (ge(c, b'a' as u32) & le(c, b'z' as u32) & c.wrapping_sub(lower_off))
        | (ge(c, b'0' as u32) & le(c, b'9' as u32) & c.wrapping_sub(digit_off))
        | (eq(c, b'+' as u32) & 62)
        | (eq(c, b'/' as u32) & 63);

    x | (eq(x, 0) & (eq(c, b'A' as u32) ^ 0xFF))
}

// ---------------------------------------------------------------------------
// Lengths
// ---------------------------------------------------------------------------

/// `b64len(len)`: length of the unpadded base64 encoding of `len` bytes.
///
/// ```text
/// olen = (len / 3) << 2;
/// switch (len % 3) { case 2: olen++; /* fall through */ case 1: olen += 2; }
/// ```
///
/// # 32-bit targets
///
/// On a target where `usize` is 32 bits, a `len` near `u32::MAX` makes
/// `(len / 3) << 2` discard its top bits, so the answer wraps. That is not a
/// defect to fix: `encoding.c:441` computes `((size_t)len / 3) << 2` and wraps
/// identically where `size_t` is 32 bits, and this function exists to match the
/// C. It cannot panic (`<<` discards bits rather than trapping, and the sums in
/// [`encoded_len`] stay inside `usize` even after a wrap), and it is not on the
/// allocation path — [`encode_string_alloc`] sizes its buffer with
/// `encoded_len_usize`, which takes real slice lengths and cannot wrap.
#[must_use]
pub const fn b64_len(len: u32) -> usize {
    b64_len_usize(len as usize)
}

/// [`b64_len`] over a `usize`, for slices.
///
/// Cannot overflow **when fed a slice length**, which is every caller: a slice
/// is at most `isize::MAX` bytes, and `(isize::MAX / 3) * 4 < usize::MAX` on
/// both 32- and 64-bit targets. The `u32` entry point above has no such bound —
/// see its note.
#[inline]
const fn b64_len_usize(len: usize) -> usize {
    let mut olen = (len / 3) << 2;
    // The C's `case 2` falls through into `case 1`, so it adds 1 + 2.
    match len % 3 {
        2 => olen += 3,
        1 => olen += 2,
        _ => {}
    }
    olen
}

/// `numlen(num)`: number of decimal digits in `num` (1 for 0).
#[must_use]
pub const fn num_len(num: u32) -> usize {
    let mut len = 1usize;
    let mut n = num;
    while n >= 10 {
        len += 1;
        n /= 10;
    }
    len
}

/// `argon2_encodedlen(...)` from `src/argon2.c`.
///
/// ```text
/// strlen("$$v=$m=,t=,p=$$") + strlen(type) + numlen(t_cost) + numlen(m_cost)
///   + numlen(parallelism) + b64len(saltlen) + b64len(hashlen)
///   + numlen(ARGON2_VERSION_NUMBER) + 1
/// ```
///
/// The trailing `+ 1` is the C string's NUL terminator. It is kept so the value
/// matches the C byte for byte; a Rust [`String`] is one byte shorter. It is
/// also exactly the buffer size `encode_string` wants, which reserves the
/// same byte (see there).
///
/// Note the C uses `numlen(ARGON2_VERSION_NUMBER)` and not the version actually
/// being encoded. Both `0x10` (16) and `0x13` (19) are two digits, so it makes
/// no difference; it is kept verbatim. (In the C it *can* differ, because
/// `ctx->version` is a raw `uint32_t`: with `version = 0` the string is one
/// byte shorter than advertised, and a buffer of `argon2_encodedlen() - 1`
/// suffices. Measured on 1051 of 30000 fuzzed cases, all of them `version = 0`.
/// [`Version`] is a closed enum of two two-digit values, so the size is always
/// exact here — see `encode_needs_encoded_len_bytes_exactly`.)
///
/// # Argument order
///
/// `t_cost` comes before `m_cost` here, which is the opposite of the order a
/// PHC string carries them in:
///
/// ```text
/// $argon2id$v=19$m=65536,t=3,p=1$<salt>$<tag>
///                ^^^^^^^^^^^^^^^ the string reads m, then t, then p
/// encoded_len(algorithm, t_cost, m_cost, lanes, salt_len, hash_len)
///                        ^^^^^^^^^^^^^^ this call reads t, then m
/// ```
///
/// So a call transcribed field by field off a string is a call with the two
/// costs swapped. Here that is harmless, and provably so rather than by luck:
/// the result is a plain sum of `num_len(t_cost)` and `num_len(m_cost)`, so it
/// does not depend on which digit count came from which cost — pinned at every
/// digit-count boundary by `encoded_len_is_symmetric_in_m_and_t`.
///
/// The transposition is not harmless anywhere that hashes, and the decoder
/// behind [`Argon2::verify_encoded`](crate::Argon2::verify_encoded) is where it
/// would bite: `m=` must become the memory cost and `t=` the pass count, never
/// the other way round, or a string verifies against a tag its writer never
/// produced. [`Params`] itself is built through named setters —
/// [`ParamsBuilder::memory`](crate::params::ParamsBuilder::memory) and
/// [`ParamsBuilder::passes`](crate::params::ParamsBuilder::passes) — so there is
/// no order to get wrong on that side. This function is the positional one.
///
/// The order is the C's, kept so a call can be transcribed position for
/// position: `argon2_encodedlen(t_cost, m_cost, parallelism, saltlen, hashlen,
/// type)`, declared at `argon2.h:429` and defined at `argon2.c:447`. One
/// argument did move. `type` went from last to first and became `algorithm`.
/// The other five kept their order among themselves; `parallelism` is spelled
/// `lanes` here, the name [`Params`] uses for it.
///
/// `algorithm` comes first here and on the rest of the encode-and-construct
/// side; the verify family keeps the C's trailing `type` and takes it last.
///
/// ```
/// use argon2_rust::{Algorithm, Params, encoded_len, params::{Memory, TagLen}};
///
/// // The builder names each cost, so nothing here has an order to reverse.
/// let params = Params::builder()
///     .memory(Memory::kib(65536))
///     .passes(3)
///     .lanes(1)
///     .tag_len(TagLen::bytes(32))
///     .build()?;
/// assert_eq!((params.memory_kib(), params.passes()), (65536, 3));
///
/// // `encoded_len` is positional, and it takes t_cost first: the same two
/// // costs, the other way round from the `m=65536,t=3` the string will show.
/// let n = encoded_len(
///     Algorithm::Argon2id,
///     params.passes(),
///     params.memory_kib(),
///     params.lanes(),
///     16, // salt_len
///     32, // hash_len
/// );
/// assert_eq!(n, 98);
/// # Ok::<(), argon2_rust::Error>(())
/// ```
///
/// # Against a string the crate really produced
///
/// The value is a C buffer size, so it counts the NUL terminator described
/// above and a Rust [`String`] is one byte shorter. That is the whole of the
/// relationship, and it is exact rather than an upper bound - see
/// `encode_needs_encoded_len_bytes_exactly`:
///
/// ```
/// use argon2_rust::{
///     Algorithm, Argon2, Params, Version, encoded_len,
///     params::{Memory, TagLen},
/// };
///
/// let params = Params::builder()
///     .memory(Memory::kib(64))
///     .passes(1)
///     .lanes(1)
///     .tag_len(TagLen::bytes(32))
///     .build()?;
/// let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
/// let encoded = argon2.hash_encoded(b"password", b"somesalt")?;
///
/// // `salt_len` is the salt's own 8 bytes, not the 11 its base64 occupies.
/// // Note the `1, 64` against the string's `m=64,t=1`: t_cost comes first.
/// let n = encoded_len(Algorithm::Argon2id, 1, 64, 1, 8, 32);
/// assert_eq!(n, 84);
/// assert_eq!(encoded.len(), n - 1);
/// assert_eq!(
///     encoded,
///     "$argon2id$v=19$m=64,t=1,p=1$c29tZXNhbHQ$cpx6VEQbwTVZvcpxNIxOVUWZ5xnAipUmAe1cg2GMG70",
/// );
/// # Ok::<(), argon2_rust::Error>(())
/// ```
#[must_use]
pub fn encoded_len(
    algorithm: Algorithm,
    t_cost: u32,
    m_cost: u32,
    lanes: u32,
    salt_len: u32,
    hash_len: u32,
) -> usize {
    "$$v=$m=,t=,p=$$".len()
        + algorithm.as_str().len()
        + num_len(t_cost)
        + num_len(m_cost)
        + num_len(lanes)
        + b64_len(salt_len)
        + b64_len(hash_len)
        + num_len(Version::DEFAULT.as_u32())
        + 1
}

/// [`encoded_len`] computed from slice lengths, without the `u32` casts.
///
/// [`encode_string_alloc`] sizes its buffer with this so a salt longer than
/// `u32::MAX` cannot silently wrap into a too-small allocation.
fn encoded_len_usize(
    algorithm: Algorithm,
    t_cost: u32,
    m_cost: u32,
    lanes: u32,
    salt_len: usize,
    hash_len: usize,
) -> usize {
    "$$v=$m=,t=,p=$$".len()
        + algorithm.as_str().len()
        + num_len(t_cost)
        + num_len(m_cost)
        + num_len(lanes)
        + b64_len_usize(salt_len)
        + b64_len_usize(hash_len)
        + num_len(Version::DEFAULT.as_u32())
        + 1
}

// ---------------------------------------------------------------------------
// Base64
// ---------------------------------------------------------------------------

/// `to_base64(dst, dst_len, src, src_len)`.
///
/// Writes the unpadded base64 of `src` into `dst` and returns how many bytes
/// were written. No NUL terminator is written (the C writes one; Rust does not
/// need it), but the capacity check is kept identical: the C requires
/// `dst_len > olen`, so this requires `dst.len() > b64_len(src.len())`.
///
/// # Errors
///
/// [`Error::EncodingFail`] if `dst` is too small.
pub fn to_base64(dst: &mut [u8], src: &[u8]) -> Result<usize, Error> {
    to_base64_raw(dst.as_mut_ptr(), dst.len(), src)
}

fn to_base64_raw(dst: *mut u8, dst_len: usize, src: &[u8]) -> Result<usize, Error> {
    if src.len() < crate::base64::MIN_ENCODE_LEN {
        // Keep backend lookup and the generalized prefix state completely out
        // of tiny salts. This is the original scalar function's exact shape.
        return to_base64_scalar(dst, dst_len, src);
    }
    let backend = crate::base64::base64_backend();
    // SAFETY: runtime detection returns only an executable backend.
    unsafe { to_base64_with_backend_raw(dst, dst_len, src, backend) }
}

/// The original reference-C loop, kept whole so short inputs do not pay for or
/// inhibit optimization around a SIMD prefix they cannot use.
///
/// Writes only; `dst` may be uninitialized spare capacity.
#[inline(always)]
fn to_base64_scalar(dst: *mut u8, dst_len: usize, src: &[u8]) -> Result<usize, Error> {
    let olen = b64_len_usize(src.len());
    if dst_len <= olen {
        return Err(Error::EncodingFail);
    }

    let mut acc: u32 = 0;
    let mut acc_len: u32 = 0;
    let mut written = 0usize;
    for &byte in src {
        acc = (acc << 8) | byte as u32;
        acc_len += 8;
        while acc_len >= 6 {
            acc_len -= 6;
            // SAFETY: `written < olen < dst_len`.
            unsafe {
                dst.add(written)
                    .write(b64_byte_to_char((acc >> acc_len) & 0x3f));
            }
            written += 1;
        }
    }
    if acc_len > 0 {
        // SAFETY: the last leftover character is still inside `olen`.
        unsafe {
            dst.add(written)
                .write(b64_byte_to_char((acc << (6 - acc_len)) & 0x3f));
        }
        written += 1;
    }

    debug_assert_eq!(written, olen);
    Ok(written)
}

/// Encode with an explicitly selected Base64 backend.
///
/// This is an unstable test/benchmark hook. Normal callers use [`to_base64`],
/// which performs safe runtime detection.
///
/// # Safety
///
/// `backend` must be executable on the current CPU, as reported by
/// [`Base64Backend::is_available`].
#[inline]
pub unsafe fn to_base64_with_backend(
    dst: &mut [u8],
    src: &[u8],
    backend: Base64Backend,
) -> Result<usize, Error> {
    // SAFETY: `dst` is a live initialized slice; the backend contract is the
    // caller's, same as before this raw-pointer split.
    unsafe { to_base64_with_backend_raw(dst.as_mut_ptr(), dst.len(), src, backend) }
}

unsafe fn to_base64_with_backend_raw(
    dst: *mut u8,
    dst_len: usize,
    src: &[u8],
    backend: Base64Backend,
) -> Result<usize, Error> {
    if backend == Base64Backend::Scalar {
        return to_base64_scalar(dst, dst_len, src);
    }

    let olen = b64_len_usize(src.len());
    if dst_len <= olen {
        return Err(Error::EncodingFail);
    }

    // SAFETY: transferred from this function's caller. The capacity check
    // above proves every complete vector store is within `dst_len`.
    let (consumed, mut written) = unsafe { crate::base64::encode_prefix(backend, dst, src) };
    let mut acc: u32 = 0;
    let mut acc_len: u32 = 0;

    for &byte in &src[consumed..] {
        // The C writes `(acc << 8) + *buf++`; the low 8 bits of `acc << 8` are
        // zero, so `|` is the same value and cannot overflow in debug builds.
        acc = (acc << 8) | byte as u32;
        acc_len += 8;
        while acc_len >= 6 {
            acc_len -= 6;
            // SAFETY: `written` stays inside `olen < dst_len`.
            unsafe {
                dst.add(written)
                    .write(b64_byte_to_char((acc >> acc_len) & 0x3F));
            }
            written += 1;
        }
    }
    if acc_len > 0 {
        // SAFETY: leftover character is the last of `olen`.
        unsafe {
            dst.add(written)
                .write(b64_byte_to_char((acc << (6 - acc_len)) & 0x3F));
        }
        written += 1;
    }

    debug_assert!(written == olen);
    Ok(written)
}

/// `from_base64(dst, dst_len, src)`.
///
/// Decodes until the first non-base64 byte. Returns
/// `(bytes_written, bytes_consumed)`, where `bytes_consumed` indexes the first
/// non-base64 byte in `src` — the equivalent of the pointer the C returns. The
/// end of the slice acts as the C's terminating NUL, which is itself not a
/// base64 character.
///
/// # Errors
///
/// [`Error::DecodingFail`] if `dst` is too small, if `acc_len > 4` at the end,
/// or if any buffered low bits are non-zero.
pub fn from_base64(dst: &mut [u8], src: &[u8]) -> Result<(usize, usize), Error> {
    from_base64_raw(dst.as_mut_ptr(), dst.len(), src)
}

fn from_base64_raw(dst: *mut u8, dst_len: usize, src: &[u8]) -> Result<(usize, usize), Error> {
    if src.len() < crate::base64::MIN_DECODE_LEN {
        // As in the encoder, keep both lookup and generalized prefix state out
        // of inputs too short for this architecture's smallest vector.
        return from_base64_scalar(dst, dst_len, src);
    }
    let backend = crate::base64::base64_backend();
    // SAFETY: as in `to_base64`, detection proves the feature contract.
    unsafe { from_base64_with_backend_raw(dst, dst_len, src, backend) }
}

/// The original reference-C loop, kept whole for the scalar and short-input
/// paths just like [`to_base64_scalar`].
///
/// Writes only; `dst` may be uninitialized spare capacity.
#[inline(always)]
fn from_base64_scalar(dst: *mut u8, dst_len: usize, src: &[u8]) -> Result<(usize, usize), Error> {
    let mut consumed = 0usize;
    let mut len = 0usize;
    let mut acc: u32 = 0;
    let mut acc_len: u32 = 0;

    loop {
        // Past the end of the slice, feed the NUL the C would have read.
        let c = match src.get(consumed) {
            Some(&byte) => byte as u32,
            None => 0,
        };
        let d = b64_char_to_byte(c);
        if d == 0xFF {
            break;
        }
        consumed += 1;
        acc = (acc << 6) | d;
        acc_len += 6;
        if acc_len >= 8 {
            acc_len -= 8;
            if len >= dst_len {
                return Err(Error::DecodingFail);
            }
            // SAFETY: `len < dst_len`.
            unsafe {
                dst.add(len).write(((acc >> acc_len) & 0xFF) as u8);
            }
            len += 1;
        }
    }

    if acc_len > 4 || (acc & ((1u32 << acc_len) - 1)) != 0 {
        return Err(Error::DecodingFail);
    }

    Ok((len, consumed))
}

/// Decode with an explicitly selected Base64 backend.
///
/// This preserves [`from_base64`]'s exact stopping and error behavior and is
/// exposed only as an unstable differential-test/benchmark hook.
///
/// # Safety
///
/// `backend` must be executable on the current CPU, as reported by
/// [`Base64Backend::is_available`].
#[inline]
pub unsafe fn from_base64_with_backend(
    dst: &mut [u8],
    src: &[u8],
    backend: Base64Backend,
) -> Result<(usize, usize), Error> {
    // SAFETY: `dst` is a live slice; the backend contract is the caller's.
    unsafe { from_base64_with_backend_raw(dst.as_mut_ptr(), dst.len(), src, backend) }
}

unsafe fn from_base64_with_backend_raw(
    dst: *mut u8,
    dst_len: usize,
    src: &[u8],
    backend: Base64Backend,
) -> Result<(usize, usize), Error> {
    if backend == Base64Backend::Scalar {
        return from_base64_scalar(dst, dst_len, src);
    }

    // SAFETY: transferred from this function's caller. Each backend checks the
    // supplied slice lengths before loading or storing a complete block.
    let (mut consumed, mut len) =
        unsafe { crate::base64::decode_prefix(backend, dst, dst_len, src) };
    let mut acc: u32 = 0;
    let mut acc_len: u32 = 0;

    loop {
        // Past the end of the slice, feed the NUL the C would have read.
        let c = match src.get(consumed) {
            Some(&byte) => byte as u32,
            None => 0,
        };
        let d = b64_char_to_byte(c);
        if d == 0xFF {
            break;
        }
        consumed += 1;
        // As in `to_base64`, `|` matches the C's `+` bit for bit.
        acc = (acc << 6) | d;
        acc_len += 6;
        if acc_len >= 8 {
            acc_len -= 8;
            // The C is `if ((len++) >= *dst_len) return NULL;`, i.e. the test
            // uses the pre-increment value.
            if len >= dst_len {
                return Err(Error::DecodingFail);
            }
            // SAFETY: `len < dst_len`.
            unsafe {
                dst.add(len).write(((acc >> acc_len) & 0xFF) as u8);
            }
            len += 1;
        }
    }

    // An input length of 1 modulo 4 leaves 6 unprocessed bits, which is
    // invalid; otherwise 0, 2 or 4 bits are buffered and they must be zero.
    if acc_len > 4 || (acc & ((1u32 << acc_len) - 1)) != 0 {
        return Err(Error::DecodingFail);
    }

    Ok((len, consumed))
}

/// Encode `src` as unpadded standard Base64, the alphabet PHC strings use.
///
/// Same dispatch as [`to_base64`]: SIMD when `src` is at least one vector
/// long (16 bytes on x86, 24 on aarch64), scalar below that.
///
/// ```
/// use argon2_rust::encode_base64;
///
/// assert_eq!(encode_base64(b"somesalt")?, "c29tZXNhbHQ");
/// # Ok::<(), argon2_rust::Error>(())
/// ```
///
/// # Errors
///
/// [`Error::MemoryAllocationError`] if the output buffer cannot be allocated.
pub fn encode_base64(src: &[u8]) -> Result<String, Error> {
    // `to_base64` requires `dst_len > olen` (the C writes a NUL).
    let cap = b64_len_usize(src.len()) + 1;
    let mut buf = reserve_vec(cap)?;
    let written = to_base64_raw(buf.as_mut_ptr(), cap, src)?;
    // SAFETY: `to_base64_raw` wrote `written` bytes of the Base64 alphabet.
    unsafe {
        buf.set_len(written);
    }
    Ok(ascii_to_string(buf))
}

/// Decode unpadded standard Base64, the alphabet PHC strings use.
///
/// Same dispatch as [`from_base64`]. The whole of `src` must be alphabet
/// characters; leftover junk is [`Error::DecodingFail`], unlike the C's
/// `from_base64`, which stops at the first non-alphabet byte and leaves the
/// tail for the caller. PHC fields have no tail.
///
/// ```
/// use argon2_rust::decode_base64;
///
/// assert_eq!(decode_base64(b"c29tZXNhbHQ")?, b"somesalt");
/// # Ok::<(), argon2_rust::Error>(())
/// ```
///
/// # Errors
///
/// [`Error::DecodingFail`] if `src` is not entirely valid unpadded Base64, or
/// [`Error::MemoryAllocationError`] if the output buffer cannot be allocated.
pub fn decode_base64(src: &[u8]) -> Result<Vec<u8>, Error> {
    // Isolated PHC fields are all alphabet; `n * 3 / 4` is exact for every
    // valid unpadded length and is the most a valid decode can write.
    let cap = src.len() * 3 / 4;
    let mut buf = reserve_vec(cap)?;
    let (written, consumed) = from_base64_raw(buf.as_mut_ptr(), cap, src)?;
    if consumed != src.len() {
        return Err(Error::DecodingFail);
    }
    // SAFETY: `from_base64_raw` wrote `written` bytes and `written <= cap`.
    unsafe {
        buf.set_len(written);
    }
    Ok(buf)
}

// ---------------------------------------------------------------------------
// decode_decimal
// ---------------------------------------------------------------------------

/// `decode_decimal(str, v)`.
///
/// Returns `(value, digits_consumed)`, or `None` when there is no digit at all,
/// when the encoding is not minimal (a leading `'0'` with more digits after
/// it), or when the value overflows.
///
/// The C accumulates in `unsigned long`, which is 64-bit on every target this
/// crate supports, so `u64` matches it. On a hypothetical 32-bit `unsigned
/// long` the outcome would still be the same, because every caller is
/// `DECIMAL_U32`, which rejects anything above `u32::MAX` anyway.
fn decode_decimal(src: &[u8]) -> Option<(u64, usize)> {
    let mut acc: u64 = 0;
    let mut i = 0usize;

    while let Some(&c) = src.get(i) {
        if !c.is_ascii_digit() {
            break;
        }
        let digit = (c - b'0') as u64;
        if acc > u64::MAX / 10 {
            return None;
        }
        acc *= 10;
        if digit > u64::MAX - acc {
            return None;
        }
        acc += digit;
        i += 1;
    }

    // `if (str == orig || (*orig == '0' && str != (orig + 1))) return NULL;`
    if i == 0 {
        return None;
    }
    if src[0] == b'0' && i != 1 {
        return None;
    }

    Some((acc, i))
}

// ---------------------------------------------------------------------------
// encode_string
// ---------------------------------------------------------------------------

/// The C's `SS`/`SX`/`SB` macros: a cursor that always keeps one byte spare for
/// the NUL terminator the C writes, so the capacity requirement is identical.
struct Writer {
    dst: *mut u8,
    dst_len: usize,
    pos: usize,
}

impl Writer {
    /// `SS(str)`: `if (pp_len >= dst_len) return ARGON2_ENCODING_FAIL;`.
    fn put(&mut self, bytes: &[u8]) -> Result<(), Error> {
        let remaining = self.dst_len - self.pos;
        if bytes.len() >= remaining {
            return Err(Error::EncodingFail);
        }
        // SAFETY: the capacity check leaves room for `bytes`, and this write
        // does not read the destination.
        unsafe {
            self.dst
                .add(self.pos)
                .copy_from_nonoverlapping(bytes.as_ptr(), bytes.len());
        }
        self.pos += bytes.len();
        Ok(())
    }

    /// `SX(x)`: the decimal form of `x`, no allocation.
    fn put_u32(&mut self, value: u32) -> Result<(), Error> {
        // `u32::MAX` is 4294967295: ten digits.
        let mut buf = [0u8; 10];
        let mut i = buf.len();
        let mut n = value;
        loop {
            i -= 1;
            buf[i] = b'0' + (n % 10) as u8;
            n /= 10;
            if n == 0 {
                break;
            }
        }
        self.put(&buf[i..])
    }

    /// `SB(buf, len)`: base64, which does its own capacity check.
    fn put_base64(&mut self, src: &[u8]) -> Result<(), Error> {
        // SAFETY: `self.pos <= self.dst_len`; `to_base64_raw` only writes.
        let written = to_base64_raw(
            unsafe { self.dst.add(self.pos) },
            self.dst_len - self.pos,
            src,
        )?;
        self.pos += written;
        Ok(())
    }
}

/// `validate_inputs(ctx)` as `encode_string` and `decode_string` run it.
///
/// `out_len` is the *tag* length, which is what `ctx->outlen` holds in both
/// call sites, and `pwd_len` is 0 (see the module-level divergence note).
fn validate_for_string(params: &Params, salt_len: usize, hash_len: usize) -> Result<(), Error> {
    validate_inputs(
        hash_len,
        0,
        salt_len,
        0,
        0,
        params.memory_kib(),
        params.passes(),
        params.lanes(),
        params.threads(),
    )
}

/// `encode_string(dst, dst_len, ctx, type)`.
///
/// Writes the PHC string into `dst` (no NUL terminator) and returns its length.
/// Always emits `$v=`, as the C does.
///
/// `dst` must hold the string **plus one byte**, because the C reserves room
/// for its NUL terminator and this port keeps the capacity rule identical:
/// a buffer of exactly [`encoded_len`] bytes is what succeeds, in Rust and in
/// C alike.
///
/// `hash.len()` plays the role of `ctx->outlen` — it is the length that gets
/// encoded, so it, and not [`Params::tag_len_bytes`], is what the leading
/// `validate_inputs()` checks. For a tag produced from these `params` the two
/// are the same value.
///
/// # Errors
///
/// [`Error::EncodingFail`] if `dst` is too small, or whatever
/// [`crate::params::validate_inputs`] returns — `encode_string` runs it first,
/// exactly like the C.
pub fn encode_string(
    dst: &mut [u8],
    algorithm: Algorithm,
    version: Version,
    params: &Params,
    salt: &[u8],
    hash: &[u8],
) -> Result<usize, Error> {
    encode_string_raw(dst.as_mut_ptr(), dst.len(), algorithm, version, params, salt, hash)
}

fn encode_string_raw(
    dst: *mut u8,
    dst_len: usize,
    algorithm: Algorithm,
    version: Version,
    params: &Params,
    salt: &[u8],
    hash: &[u8],
) -> Result<usize, Error> {
    validate_for_string(params, salt.len(), hash.len())?;

    let mut w = Writer {
        dst,
        dst_len,
        pos: 0,
    };

    w.put(b"$")?;
    w.put(algorithm.as_str().as_bytes())?;

    w.put(b"$v=")?;
    w.put_u32(version.as_u32())?;

    w.put(b"$m=")?;
    w.put_u32(params.memory_kib())?;
    w.put(b",t=")?;
    w.put_u32(params.passes())?;
    w.put(b",p=")?;
    w.put_u32(params.lanes())?;

    w.put(b"$")?;
    w.put_base64(salt)?;

    w.put(b"$")?;
    w.put_base64(hash)?;

    Ok(w.pos)
}

/// [`encode_string`] into a freshly allocated [`String`].
///
/// # Errors
///
/// As [`encode_string`], plus [`Error::MemoryAllocationError`] if the buffer
/// cannot be allocated (the C returns the same code when its `malloc` fails).
pub fn encode_string_alloc(
    algorithm: Algorithm,
    version: Version,
    params: &Params,
    salt: &[u8],
    hash: &[u8],
) -> Result<String, Error> {
    // Validate before allocating, so an over-long salt reports SaltTooLong
    // rather than failing to allocate a buffer sized from it.
    validate_for_string(params, salt.len(), hash.len())?;

    let capacity = encoded_len_usize(
        algorithm,
        params.passes(),
        params.memory_kib(),
        params.lanes(),
        salt.len(),
        hash.len(),
    );

    let mut buf = reserve_vec(capacity)?;
    let written = encode_string_raw(
        buf.as_mut_ptr(),
        capacity,
        algorithm,
        version,
        params,
        salt,
        hash,
    )?;
    // SAFETY: `encode_string` wrote `written` ASCII bytes.
    unsafe {
        buf.set_len(written);
    }
    Ok(ascii_to_string(buf))
}

/// Spare capacity only — len stays 0 until the caller writes and `set_len`s.
fn reserve_vec(cap: usize) -> Result<Vec<u8>, Error> {
    let mut v = Vec::new();
    if cap != 0 {
        v.try_reserve_exact(cap)
            .map_err(|_| Error::MemoryAllocationError)?;
    }
    Ok(v)
}

/// The PHC alphabet and punctuation are ASCII.
fn ascii_to_string(buf: Vec<u8>) -> String {
    // SAFETY: every byte came from `b64_byte_to_char`, a decimal digit, or a
    // `$` / `v` / `m` / `t` / `p` / `=` / `,` literal.
    unsafe { String::from_utf8_unchecked(buf) }
}

// ---------------------------------------------------------------------------
// decode_string
// ---------------------------------------------------------------------------

/// The fields a PHC string yields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decoded {
    /// The algorithm named by the string.
    ///
    /// [`decode_string`] requires the caller to pass this type and fails on a
    /// mismatch. [`decode_phc`] reads it from the `$argon2*` prefix.
    pub algorithm: Algorithm,
    /// The version. `0x10` when the `$v=` field is absent.
    pub version: Version,
    /// `m_cost`, `t_cost`, `lanes`, `threads == lanes`, and
    /// `output_len == hash.len()`.
    pub params: Params,
    /// The decoded salt.
    pub salt: Vec<u8>,
    /// The decoded tag.
    pub hash: Vec<u8>,
    /// Associated data from a `data=` parameter, if the string had one.
    ///
    /// The C `decode_string` has no such field; [`decode_string`] always
    /// leaves this empty. [`decode_phc`] fills it for `@phc/format` /
    /// node-argon2 strings.
    pub ad: Vec<u8>,
}

/// The remainder of `src` from `pos`, never panicking.
#[inline]
fn rest(src: &[u8], pos: usize) -> &[u8] {
    src.get(pos..).unwrap_or(&[])
}

/// The `CC(prefix)` macro: consume `prefix` or fail.
fn expect(src: &[u8], pos: &mut usize, prefix: &[u8]) -> Result<(), Error> {
    if rest(src, *pos).starts_with(prefix) {
        *pos += prefix.len();
        Ok(())
    } else {
        Err(Error::DecodingFail)
    }
}

/// The `CC_opt(prefix, code)` macro: consume `prefix` if it is there.
fn expect_opt(src: &[u8], pos: &mut usize, prefix: &[u8]) -> bool {
    if rest(src, *pos).starts_with(prefix) {
        *pos += prefix.len();
        true
    } else {
        false
    }
}

/// The `DECIMAL_U32(x)` macro.
fn decimal_u32(src: &[u8], pos: &mut usize) -> Result<u32, Error> {
    let (value, consumed) = decode_decimal(rest(src, *pos)).ok_or(Error::DecodingFail)?;
    if value > u32::MAX as u64 {
        return Err(Error::DecodingFail);
    }
    *pos += consumed;
    Ok(value as u32)
}

/// The `BIN(buf, max_len, len)` macro.
///
/// The C sizes the destination at `strlen(encoded)` (see `argon2_verify`), so
/// the "output buffer too small" branch of `from_base64` is unreachable there.
/// The bound used here — three bytes out per four characters in — is likewise
/// never exceeded, so the two agree.
fn decode_bin(src: &[u8], pos: &mut usize) -> Result<Vec<u8>, Error> {
    let tail = rest(src, *pos);
    // `n` base64 characters decode to `floor(3n / 4)` bytes; `n/4*3 + 3` is an
    // upper bound for every `n`, and cannot overflow for any real slice.
    let max_len = tail.len() / 4 * 3 + 3;

    let mut buf = reserve_vec(max_len)?;
    let (written, consumed) = from_base64_raw(buf.as_mut_ptr(), max_len, tail)?;
    // `bin_len > UINT32_MAX` is a decoding failure in the C.
    if written > u32::MAX as usize {
        return Err(Error::DecodingFail);
    }
    // SAFETY: `from_base64_raw` wrote `written` bytes and `written <= max_len`.
    unsafe {
        buf.set_len(written);
    }
    *pos += consumed;
    Ok(buf)
}

/// `decode_string(ctx, str, type)`.
///
/// # Errors
///
/// [`Error::DecodingFail`] for a malformed string, or whatever
/// [`crate::params::validate_inputs`] returns — the C runs the full validation
/// before accepting the string, so a well-formed string with a zero-length salt
/// yields [`Error::SaltTooShort`] and not [`Error::DecodingFail`].
///
/// See the module documentation for the known divergences from the C
/// (unrepresentable versions, embedded NULs, and raw/non-ASCII input).
pub fn decode_string(encoded: &str, algorithm: Algorithm) -> Result<Decoded, Error> {
    let src = encoded.as_bytes();
    let mut pos = 0usize;

    // argon2.c:268-271
    //   encoded_len = strlen(encoded);
    //   if (encoded_len > UINT32_MAX) return ARGON2_DECODING_FAIL;
    //
    // The C puts this in `argon2_verify`, one level up, and computes
    // `max_field_len` from it. Here it lives in the decoder because all four
    // verify entry points funnel through this function, so one check covers
    // them and cannot drift; through the public API the behaviour is identical.
    // Reachable only where `usize` is wider than `u32`, from a `&str` at least
    // 4 GiB long.
    if src.len() > u32::MAX as usize {
        return Err(Error::DecodingFail);
    }

    // CC("$"); CC(type_string);
    //
    // No `ARGON2_INCORRECT_TYPE` branch: `argon2_type2string` only returns NULL
    // for a type outside the enum, which `Algorithm` cannot represent.
    expect(src, &mut pos, b"$")?;
    expect(src, &mut pos, algorithm.as_str().as_bytes())?;

    // ctx->version = ARGON2_VERSION_10; CC_opt("$v=", DECIMAL_U32(version));
    let mut version_value = Version::V0x10.as_u32();
    if expect_opt(src, &mut pos, b"$v=") {
        version_value = decimal_u32(src, &mut pos)?;
    }

    expect(src, &mut pos, b"$m=")?;
    let m_cost = decimal_u32(src, &mut pos)?;
    expect(src, &mut pos, b",t=")?;
    let t_cost = decimal_u32(src, &mut pos)?;
    expect(src, &mut pos, b",p=")?;
    let lanes = decimal_u32(src, &mut pos)?;
    // `ctx->threads = ctx->lanes;`
    let threads = lanes;

    expect(src, &mut pos, b"$")?;
    let salt = decode_bin(src, &mut pos)?;
    expect(src, &mut pos, b"$")?;
    let hash = decode_bin(src, &mut pos)?;

    // "On return, must have valid context": the full validate_inputs(), in the
    // C's order, before the trailing-character check.
    validate_inputs(
        hash.len(),
        0,
        salt.len(),
        0,
        0,
        m_cost,
        t_cost,
        lanes,
        threads,
    )?;

    // "Can't have any additional characters".
    if pos != src.len() {
        return Err(Error::DecodingFail);
    }

    // Last, so that every error code above still matches the C exactly.
    let version = Version::from_u32(version_value).ok_or(Error::DecodingFail)?;

    // Attacker-chosen values from the string, through the same validation any
    // caller's parameters get. Both conversions into the typed units widen —
    // `m_cost` is a `u32`, and `hash.len()` is a `usize` — so neither can lose a
    // bit before `build()` range-checks it.
    //
    // `build()` cannot actually reject anything here: `validate_inputs` above
    // already accepted this `m_cost`, `t_cost`, `lanes`, `threads` and
    // `hash.len()`, and `build()` re-runs exactly that check with a salt length
    // that is valid by construction. Propagating rather than unwrapping keeps
    // that a fact about today's checks instead of an assumption baked into a
    // panic. Named setters also mean `m=` cannot land in the pass count: `m=`
    // was parsed into `m_cost` above and only `.memory()` receives it.
    let params = Params::builder()
        .memory(Memory::kib(u64::from(m_cost)))
        .passes(t_cost)
        .lanes(lanes)
        .threads(threads)
        .tag_len(TagLen::bytes(hash.len() as u64))
        .build()?;

    Ok(Decoded {
        algorithm,
        version,
        params,
        salt,
        hash,
        ad: Vec::new(),
    })
}

/// Decode a PHC string, detecting the algorithm from the `$argon2*` prefix.
///
/// Unlike [`decode_string`] (C `decode_string`, fixed `$m=,t=,p=`), this
/// accepts:
///
/// * any order of `m`, `t`, `p`
/// * an optional `data=` associated-data field (node-argon2 / `@phc/format`)
/// * unknown keys such as `keyid` (ignored)
///
/// `$v=` is still optional and still defaults to version 16.
///
/// The C-style encoder ([`encode_string`], [`crate::Argon2::hash_encoded`]) never
/// writes `data=`. This decoder exists so a verifier can still honour strings
/// other producers emit.
///
/// ```
/// use argon2_rust::{Algorithm, decode_phc};
///
/// // node-argon2 / `@phc/format` write `m,p,t`.
/// let d = decode_phc(
///     "$argon2id$v=19$m=64,p=1,t=1$c29tZXNhbHQ$cpx6VEQbwTVZvcpxNIxOVUWZ5xnAipUmAe1cg2GMG70",
/// )?;
/// assert_eq!(d.algorithm, Algorithm::Argon2id);
/// assert_eq!(d.params.memory_kib(), 64);
/// assert_eq!(d.params.passes(), 1);
/// assert_eq!(d.salt, b"somesalt");
/// assert!(d.ad.is_empty());
/// # Ok::<(), argon2_rust::Error>(())
/// ```
///
/// # Errors
///
/// [`Error::DecodingFail`] for a malformed string, or whatever
/// [`crate::params::validate_inputs`] returns.
pub fn decode_phc(encoded: &str) -> Result<Decoded, Error> {
    let src = encoded.as_bytes();
    if src.len() > u32::MAX as usize {
        return Err(Error::DecodingFail);
    }
    let mut pos = 0usize;

    expect(src, &mut pos, b"$")?;
    let algorithm = if expect_opt(src, &mut pos, b"argon2id") {
        Algorithm::Argon2id
    } else if expect_opt(src, &mut pos, b"argon2i") {
        Algorithm::Argon2i
    } else if expect_opt(src, &mut pos, b"argon2d") {
        Algorithm::Argon2d
    } else {
        return Err(Error::DecodingFail);
    };

    let mut version_value = Version::V0x10.as_u32();
    if expect_opt(src, &mut pos, b"$v=") {
        version_value = decimal_u32(src, &mut pos)?;
    }

    expect(src, &mut pos, b"$")?;
    let param_end = find_byte(rest(src, pos), b'$').ok_or(Error::DecodingFail)?;
    let param_bytes = rest(src, pos).get(..param_end).unwrap_or(&[]);
    let (m_cost, t_cost, lanes, ad) = parse_phc_params(param_bytes)?;
    pos += param_end;

    // Isolate each Base64 field so the SIMD decoder sees a clean alphabet
    // run. Feeding it `salt$hash` puts `$` in the first vector and the
    // prefix falls back to scalar.
    expect(src, &mut pos, b"$")?;
    let salt_end = find_byte(rest(src, pos), b'$').ok_or(Error::DecodingFail)?;
    let salt = decode_base64(&rest(src, pos)[..salt_end])?;
    pos += salt_end;

    expect(src, &mut pos, b"$")?;
    // `decode_base64` requires the tail to be entirely alphabet, which is
    // the trailing-junk check `decode_string` does with `pos != src.len()`.
    let hash = decode_base64(rest(src, pos))?;

    validate_inputs(
        hash.len(),
        0,
        salt.len(),
        0,
        ad.len(),
        m_cost,
        t_cost,
        lanes,
        lanes,
    )?;

    let version = Version::from_u32(version_value).ok_or(Error::DecodingFail)?;
    let params = Params::builder()
        .memory(Memory::kib(u64::from(m_cost)))
        .passes(t_cost)
        .lanes(lanes)
        .threads(lanes)
        .tag_len(TagLen::bytes(hash.len() as u64))
        .build()?;

    Ok(Decoded {
        algorithm,
        version,
        params,
        salt,
        hash,
        ad,
    })
}

fn parse_phc_params(src: &[u8]) -> Result<(u32, u32, u32, Vec<u8>), Error> {
    let mut memory = None;
    let mut passes = None;
    let mut lanes = None;
    let mut ad = Vec::new();
    let mut rest = src;
    if rest.is_empty() {
        return Err(Error::DecodingFail);
    }
    loop {
        let (field, next) = match find_byte(rest, b',') {
            Some(i) => (&rest[..i], &rest[i + 1..]),
            None => (rest, [].as_slice()),
        };
        let eq = find_byte(field, b'=').ok_or(Error::DecodingFail)?;
        let key = &field[..eq];
        let value = &field[eq + 1..];
        match key {
            b"m" => memory = Some(parse_param_u32(value)?),
            b"t" => passes = Some(parse_param_u32(value)?),
            b"p" => lanes = Some(parse_param_u32(value)?),
            b"data" => ad = decode_base64(value)?,
            _ => {}
        }
        if next.is_empty() {
            break;
        }
        rest = next;
    }
    match (memory, passes, lanes) {
        (Some(m), Some(t), Some(p)) => Ok((m, t, p, ad)),
        _ => Err(Error::DecodingFail),
    }
}

fn parse_param_u32(src: &[u8]) -> Result<u32, Error> {
    let (value, consumed) = decode_decimal(src).ok_or(Error::DecodingFail)?;
    if consumed != src.len() || value > u64::from(u32::MAX) {
        return Err(Error::DecodingFail);
    }
    Ok(value as u32)
}

/// First index of `needle`. Delegates to [`memchr`], which has its own
/// runtime SIMD cascade when this crate's `std` feature is on.
#[inline]
fn find_byte(haystack: &[u8], needle: u8) -> Option<usize> {
    memchr::memchr(needle, haystack)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    // From `phc-winner-argon2/src/test.c`.
    const V13_ARGON2I: &str = "$argon2i$v=19$m=65536,t=2,p=1$c29tZXNhbHQ\
                               $wWKIMhR9lyDFvRz9YTZweHKfbftvj+qf+YFY4NeBbtA";
    const V10_ARGON2I: &str = "$argon2i$m=65536,t=2,p=1$c29tZXNhbHQ\
                               $9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ";
    const V13_ARGON2ID: &str = "$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ\
                                $CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc";

    /// `f6c4db4a...`, the raw tag of the v=0x10 Argon2i vector in test.c.
    const V10_TAG: [u8; 32] = [
        0xf6, 0xc4, 0xdb, 0x4a, 0x54, 0xe2, 0xa3, 0x70, 0x62, 0x7a, 0xff, 0x3d, 0xb6, 0x17, 0x6b,
        0x94, 0xa2, 0xa2, 0x09, 0xa6, 0x2c, 0x8e, 0x36, 0x15, 0x27, 0x11, 0x80, 0x2f, 0x7b, 0x30,
        0xc6, 0x94,
    ];

    fn b64(src: &[u8]) -> Vec<u8> {
        let mut out = vec![0u8; b64_len_usize(src.len()) + 1];
        let n = to_base64(&mut out, src).expect("buffer sized by b64_len");
        out.truncate(n);
        out
    }

    fn unb64(src: &[u8]) -> Result<Vec<u8>, Error> {
        let mut out = vec![0u8; src.len()];
        let (n, consumed) = from_base64(&mut out, src)?;
        assert_eq!(consumed, src.len(), "test inputs are pure base64");
        out.truncate(n);
        Ok(out)
    }

    fn b64_with_backend(
        dst: &mut [u8],
        src: &[u8],
        backend: Base64Backend,
    ) -> Result<usize, Error> {
        assert!(backend.is_available());
        // SAFETY: the assertion establishes this test process can execute the
        // requested backend; slice bounds remain checked by the implementation.
        unsafe { to_base64_with_backend(dst, src, backend) }
    }

    fn unb64_with_backend(
        dst: &mut [u8],
        src: &[u8],
        backend: Base64Backend,
    ) -> Result<(usize, usize), Error> {
        assert!(backend.is_available());
        // SAFETY: as in `b64_with_backend`, availability is proved immediately
        // above and both pointer/length pairs come from live slices.
        unsafe { from_base64_with_backend(dst, src, backend) }
    }

    // -- lengths ------------------------------------------------------------

    #[test]
    fn encode_base64_matches_known_and_round_trips() {
        assert_eq!(encode_base64(b"somesalt").unwrap(), "c29tZXNhbHQ");
        assert_eq!(decode_base64(b"c29tZXNhbHQ").unwrap(), b"somesalt");
        for n in [0usize, 1, 2, 8, 16, 24, 32, 48] {
            let src: Vec<u8> = (0..n).map(|i| i as u8).collect();
            let encoded = encode_base64(&src).unwrap();
            assert_eq!(decode_base64(encoded.as_bytes()).unwrap(), src, "n={n}");
        }
    }

    #[test]
    fn decode_base64_rejects_junk_and_bad_length() {
        assert_eq!(decode_base64(b"A"), Err(Error::DecodingFail));
        assert_eq!(decode_base64(b"????"), Err(Error::DecodingFail));
        assert_eq!(decode_base64(b"c29tZXNhbHQ!"), Err(Error::DecodingFail));
    }

    #[test]
    fn find_byte_matches_iterator_position() {
        for n in [0usize, 1, 15, 16, 17, 31, 32, 64, 80] {
            let mut src = vec![b'A'; n];
            assert_eq!(find_byte(&src, b'$'), None, "n={n} miss");
            if n == 0 {
                continue;
            }
            src[n / 2] = b'$';
            assert_eq!(find_byte(&src, b'$'), Some(n / 2), "n={n} mid");
            src[n / 2] = b'A';
            src[n - 1] = b'$';
            assert_eq!(find_byte(&src, b'$'), Some(n - 1), "n={n} last");
            src[0] = b'$';
            assert_eq!(find_byte(&src, b'$'), Some(0), "n={n} first");
        }
    }

    #[test]
    fn b64_len_matches_c() {
        assert_eq!(b64_len(0), 0);
        assert_eq!(b64_len(1), 2);
        assert_eq!(b64_len(2), 3);
        assert_eq!(b64_len(3), 4);
        assert_eq!(b64_len(4), 6);
        // "somesalt" -> "c29tZXNhbHQ", "…" -> the 43-char tag.
        assert_eq!(b64_len(8), 11);
        assert_eq!(b64_len(32), 43);
        // Cross-check against the encoder for every small length.
        for len in 0u32..64 {
            let src = vec![0xABu8; len as usize];
            assert_eq!(b64(&src).len(), b64_len(len), "len {len}");
        }
    }

    #[test]
    fn num_len_matches_c() {
        assert_eq!(num_len(0), 1);
        assert_eq!(num_len(9), 1);
        assert_eq!(num_len(10), 2);
        assert_eq!(num_len(19), 2);
        assert_eq!(num_len(65536), 5);
        assert_eq!(num_len(u32::MAX), 10);
    }

    #[test]
    fn encoded_len_matches_the_c_vector() {
        // $argon2id$v=19$m=65536,t=2,p=1$<11>$<43> is 86 chars + NUL.
        let n = encoded_len(Algorithm::Argon2id, 2, 65536, 1, 8, 32);
        assert_eq!(n, V13_ARGON2ID.len() + 1);
        assert_eq!(n, 87);
        assert_eq!(
            encoded_len(Algorithm::Argon2i, 2, 65536, 1, 8, 32),
            V13_ARGON2I.len() + 1
        );
    }

    // Pins the claim in `encoded_len`'s `# Argument order` section: the C's
    // `argon2_encodedlen` (`argon2.c:447`) takes `t_cost` before `m_cost`, and
    // this port keeps that order. `ParamsBuilder` has no argument order to
    // reverse — `.memory()` and `.passes()` are named — so this positional
    // signature is now the only place in the crate where the two costs can be
    // transposed at all.
    //
    // A caller who supplies the two costs the other way round gets no error
    // back, and the reason is arithmetic rather than luck. `t_cost` and `m_cost`
    // each reach the result through exactly one term, `num_len(t_cost)` and
    // `num_len(m_cost)`, and the two terms are added, so the sum does not depend
    // on which digit count came from which cost. Nothing else in the body reads
    // either value. The swap is therefore *always* harmless, not usually
    // harmless: the swapped call returns the same number, and that number is
    // also the correct one. Nothing passed to `encoded_len` reaches the emitted
    // string either -- `encode_string` writes the `m=` and `t=` fields out of
    // the `&Params` it is handed. A swapped call site is a cosmetic
    // inconsistency, not a latent bug.
    //
    // That makes the equality a property of this one formula and not a rule
    // about the crate. This test pins it at every digit-count boundary and will
    // fail here first if the length ever stops being a plain sum of the two
    // terms, at which point the doc gets fixed with it.
    #[test]
    fn encoded_len_is_symmetric_in_m_and_t() {
        // The pair the doc example uses, the C's own test vector, and the
        // extreme: `u32::MAX` is ten digits against one, the widest the two
        // terms can differ.
        assert_eq!(encoded_len(Algorithm::Argon2id, 3, 65536, 1, 16, 32), 98);
        assert_eq!(encoded_len(Algorithm::Argon2id, 65536, 3, 1, 16, 32), 98);
        assert_eq!(encoded_len(Algorithm::Argon2id, 2, 65536, 1, 8, 32), 87);
        assert_eq!(encoded_len(Algorithm::Argon2id, 65536, 2, 1, 8, 32), 87);
        assert_eq!(encoded_len(Algorithm::Argon2id, 1, u32::MAX, 1, 16, 32), 103);
        assert_eq!(encoded_len(Algorithm::Argon2id, u32::MAX, 1, 1, 16, 32), 103);

        // Every place `num_len` changes answer, both sides of each step, over
        // all three algorithm strings, so the property is pinned rather than
        // sampled at a few lucky points.
        const BOUNDARIES: [u32; 22] = [
            0,
            1,
            9,
            10,
            99,
            100,
            999,
            1_000,
            9_999,
            10_000,
            99_999,
            100_000,
            999_999,
            1_000_000,
            9_999_999,
            10_000_000,
            99_999_999,
            100_000_000,
            999_999_999,
            1_000_000_000,
            65536,
            u32::MAX,
        ];
        for algorithm in [Algorithm::Argon2d, Algorithm::Argon2i, Algorithm::Argon2id] {
            for t_cost in BOUNDARIES {
                for m_cost in BOUNDARIES {
                    assert_eq!(
                        encoded_len(algorithm, t_cost, m_cost, 1, 16, 32),
                        encoded_len(algorithm, m_cost, t_cost, 1, 16, 32),
                        "{algorithm:?} t_cost={t_cost} m_cost={m_cost}"
                    );
                }
            }
        }
    }

    // -- base64 -------------------------------------------------------------

    #[test]
    fn b64_tables_are_the_standard_alphabet() {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        for (value, &ch) in ALPHABET.iter().enumerate() {
            assert_eq!(b64_byte_to_char(value as u32), ch, "value {value}");
            assert_eq!(b64_char_to_byte(ch as u32), value as u32, "char {ch}");
        }
    }

    #[test]
    fn b64_char_to_byte_rejects_everything_else() {
        // The 'A' quirk: a computed 0 is only valid for 'A'.
        assert_eq!(b64_char_to_byte(b'A' as u32), 0);
        for c in 0u32..256 {
            let is_b64 = (c as u8).is_ascii_alphanumeric() || c == b'+' as u32 || c == b'/' as u32;
            if !is_b64 {
                assert_eq!(b64_char_to_byte(c), 0xFF, "char {c} must be invalid");
            }
        }
        assert_eq!(b64_char_to_byte(b'=' as u32), 0xFF); // no padding
        assert_eq!(b64_char_to_byte(0), 0xFF); // NUL terminator
        assert_eq!(b64_char_to_byte(b'$' as u32), 0xFF); // field separator

        // Bytes >= 0x80 are rejected here. The C's are not, wherever `char` is
        // signed — it returns 63 for all 128 of them. See the module docs; this
        // loop is the pin for the port's (stricter, portable) choice.
        for c in 0x80u32..256 {
            assert_eq!(b64_char_to_byte(c), 0xFF, "byte {c:#04x} must be invalid");
        }
    }

    /// `b64_char_to_byte` over `0..=127`, dumped from the C reference.
    ///
    /// Produced by a harness that `#include`s `encoding.c` (the function is
    /// `static`) and prints `b64_char_to_byte(i)` for every `i`, linked against
    /// `phc-winner-argon2/libargon2.a`. Only the ASCII half is transcribed: the
    /// upper half is the signed-`char` bug documented at the top of this file,
    /// where the C returns 63 for all 128 values.
    #[rustfmt::skip]
    const C_CHAR_TO_BYTE_ASCII: [u32; 128] = [
        255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
        255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
        255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,  62, 255, 255, 255,  63,
         52,  53,  54,  55,  56,  57,  58,  59,  60,  61, 255, 255, 255, 255, 255, 255,
        255,   0,   1,   2,   3,   4,   5,   6,   7,   8,   9,  10,  11,  12,  13,  14,
         15,  16,  17,  18,  19,  20,  21,  22,  23,  24,  25, 255, 255, 255, 255, 255,
        255,  26,  27,  28,  29,  30,  31,  32,  33,  34,  35,  36,  37,  38,  39,  40,
         41,  42,  43,  44,  45,  46,  47,  48,  49,  50,  51, 255, 255, 255, 255, 255,
    ];

    #[test]
    fn b64_char_to_byte_matches_the_c_dump() {
        for (c, &want) in C_CHAR_TO_BYTE_ASCII.iter().enumerate() {
            assert_eq!(b64_char_to_byte(c as u32), want, "char {c}");
        }
    }

    /// `b64_byte_to_char` over `0..64`, dumped from the same C harness.
    #[rustfmt::skip]
    const C_BYTE_TO_CHAR: [u8; 64] = [
        65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80,
        81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 97, 98, 99, 100, 101, 102,
        103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118,
        119, 120, 121, 122, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 43, 47,
    ];

    #[test]
    fn b64_byte_to_char_matches_the_c_dump() {
        for (x, &want) in C_BYTE_TO_CHAR.iter().enumerate() {
            assert_eq!(b64_byte_to_char(x as u32), want, "value {x}");
        }
    }

    #[test]
    fn non_ascii_bytes_are_rejected_in_a_field() {
        // Measured: the C decodes both of these, identically, to the salt
        // ff ff 6d 65 73 61 6c 74, because 0xC3 and 0xA9 each read as '/'.
        // This port rejects the first and accepts the second.
        let utf8 = "$argon2i$v=19$m=65536,t=2,p=1$é9tZXNhbHQ\
                    $9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ";
        assert_eq!(
            decode_string(utf8, Algorithm::Argon2i),
            Err(Error::DecodingFail)
        );
        let slashes = "$argon2i$v=19$m=65536,t=2,p=1$//9tZXNhbHQ\
                       $9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ";
        let d = decode_string(slashes, Algorithm::Argon2i).unwrap();
        assert_eq!(d.salt, [0xff, 0xff, 0x6d, 0x65, 0x73, 0x61, 0x6c, 0x74]);
    }

    #[test]
    fn base64_known_vectors() {
        assert_eq!(b64(b"somesalt"), b"c29tZXNhbHQ");
        assert_eq!(b64(b"diffsalt"), b"ZGlmZnNhbHQ");
        assert_eq!(
            b64(&V10_TAG),
            b"9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ"
        );
        assert_eq!(unb64(b"c29tZXNhbHQ").unwrap(), b"somesalt");
        assert_eq!(
            unb64(b"9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ").unwrap(),
            &V10_TAG
        );
    }

    #[test]
    fn base64_round_trips_every_short_length() {
        for len in 0usize..96 {
            let src: Vec<u8> = (0..len)
                .map(|i| (i as u8).wrapping_mul(37) ^ 0x5A)
                .collect();
            let encoded = b64(&src);
            assert_eq!(unb64(&encoded).unwrap(), src, "len {len}");
        }
    }

    /// Every executable SIMD backend against the scalar oracle, across the
    /// block boundaries and tails each implementation can take. This checks
    /// the primitive directly rather than relying on PHC vectors whose usual
    /// 16/32-byte fields exercise only two shapes.
    #[test]
    fn every_base64_backend_matches_scalar_across_lengths() {
        for len in 0usize..=512 {
            let src: Vec<u8> = (0..len)
                .map(|i| (i as u8).wrapping_mul(197) ^ (len as u8).wrapping_mul(11))
                .collect();
            let capacity = b64_len_usize(len) + 1;
            let mut expected = vec![0xa5; capacity];
            let expected_len =
                b64_with_backend(&mut expected, &src, Base64Backend::Scalar).unwrap();

            for &backend in Base64Backend::ALL {
                if !backend.is_available()
                    || (cfg!(miri) && backend != Base64Backend::Scalar)
                {
                    continue;
                }
                let mut actual = vec![0xa5; capacity];
                let actual_len = b64_with_backend(&mut actual, &src, backend).unwrap();
                assert_eq!(actual_len, expected_len, "{backend} length {len}");
                assert_eq!(actual, expected, "{backend} bytes at length {len}");

                let mut scalar_decoded = vec![0x5a; len];
                let scalar_result = unb64_with_backend(
                    &mut scalar_decoded,
                    &expected[..expected_len],
                    Base64Backend::Scalar,
                );
                let mut simd_decoded = vec![0x5a; len];
                let simd_result = unb64_with_backend(
                    &mut simd_decoded,
                    &expected[..expected_len],
                    backend,
                );
                assert_eq!(simd_result, scalar_result, "{backend} decode length {len}");
                assert_eq!(simd_decoded, scalar_decoded, "{backend} decode bytes {len}");
                assert_eq!(simd_decoded, src, "{backend} round trip {len}");
            }
        }
    }

    /// An invalid byte in a vector must not make the SIMD prefix lose the C
    /// decoder's exact stopping position. The vector is retried by scalar, so
    /// both the return value and all bytes written before an error match.
    #[test]
    fn every_base64_backend_matches_scalar_on_invalid_bytes_and_short_outputs() {
        let raw: Vec<u8> = (0..96)
            .map(|i| (i as u8).wrapping_mul(37) ^ 0x5a)
            .collect();
        let encoded = b64(&raw);

        for &backend in Base64Backend::ALL {
            if !backend.is_available() || (cfg!(miri) && backend != Base64Backend::Scalar) {
                continue;
            }

            for pos in 0..encoded.len() {
                for invalid in [0, b'$', b'=', 0x80, 0xff] {
                    let mut input = encoded.clone();
                    input[pos] = invalid;
                    let mut expected = vec![0xa5; raw.len()];
                    let expected_result = unb64_with_backend(
                        &mut expected,
                        &input,
                        Base64Backend::Scalar,
                    );
                    let mut actual = vec![0xa5; raw.len()];
                    let actual_result = unb64_with_backend(&mut actual, &input, backend);
                    assert_eq!(actual_result, expected_result, "{backend} pos {pos} byte {invalid:#x}");
                    assert_eq!(actual, expected, "{backend} output at pos {pos} byte {invalid:#x}");
                }
            }

            for dst_len in 0..raw.len() {
                let mut expected = vec![0xa5; dst_len];
                let expected_result = unb64_with_backend(
                    &mut expected,
                    &encoded,
                    Base64Backend::Scalar,
                );
                let mut actual = vec![0xa5; dst_len];
                let actual_result = unb64_with_backend(&mut actual, &encoded, backend);
                assert_eq!(actual_result, expected_result, "{backend} dst length {dst_len}");
                assert_eq!(actual, expected, "{backend} dst bytes at length {dst_len}");
            }
        }
    }

    #[test]
    fn to_base64_rejects_a_tight_buffer() {
        // The C requires dst_len > olen, i.e. room for the NUL as well.
        let mut exact = [0u8; 11];
        assert_eq!(to_base64(&mut exact, b"somesalt"), Err(Error::EncodingFail));
        let mut roomy = [0u8; 12];
        assert_eq!(to_base64(&mut roomy, b"somesalt"), Ok(11));
        // Even an empty input needs one byte for the terminator.
        assert_eq!(to_base64(&mut [], b""), Err(Error::EncodingFail));
        assert_eq!(to_base64(&mut [0u8; 1], b""), Ok(0));
    }

    #[test]
    fn from_base64_stops_at_the_first_non_b64_char() {
        let mut out = [0u8; 16];
        let (written, consumed) = from_base64(&mut out, b"c29tZXNhbHQ$rest").unwrap();
        assert_eq!(written, 8);
        assert_eq!(consumed, 11);
        assert_eq!(&out[..8], b"somesalt");

        // An empty run is fine and consumes nothing (this is how the C accepts
        // "$argon2i$m=…,p=1$$<tag>" and only later reports SaltTooShort).
        let (written, consumed) = from_base64(&mut out, b"$tag").unwrap();
        assert_eq!((written, consumed), (0, 0));
    }

    #[test]
    fn from_base64_rejects_leftover_bits() {
        let mut out = [0u8; 16];
        // 5 chars -> 30 bits -> acc_len == 6 > 4.
        assert_eq!(
            from_base64(&mut out, b"AAAAA"),
            Err(Error::DecodingFail),
            "acc_len > 4"
        );
        // 1 char -> 6 bits -> acc_len == 6 > 4.
        assert_eq!(from_base64(&mut out, b"A"), Err(Error::DecodingFail));
        // 2 chars, 4 buffered bits, non-zero: 'B' == 1.
        assert_eq!(from_base64(&mut out, b"AB"), Err(Error::DecodingFail));
        // Same shape but the buffered bits are zero.
        assert_eq!(from_base64(&mut out, b"AA"), Ok((1, 2)));
        // 3 chars, 2 buffered bits, non-zero: 'B' == 000001.
        assert_eq!(from_base64(&mut out, b"AAB"), Err(Error::DecodingFail));
        assert_eq!(from_base64(&mut out, b"AAA"), Ok((2, 3)));
    }

    #[test]
    fn from_base64_rejects_a_short_buffer() {
        let mut out = [0u8; 4];
        assert_eq!(
            from_base64(&mut out, b"c29tZXNhbHQ"),
            Err(Error::DecodingFail)
        );
        // The C's `if ((len++) >= *dst_len)` tests the pre-increment value, so
        // an exactly-sized buffer is fine and one byte less is not.
        let mut exact = [0u8; 8];
        assert_eq!(from_base64(&mut exact, b"c29tZXNhbHQ"), Ok((8, 11)));
        assert_eq!(&exact, b"somesalt");
        let mut tight = [0u8; 7];
        assert_eq!(
            from_base64(&mut tight, b"c29tZXNhbHQ"),
            Err(Error::DecodingFail)
        );
    }

    // -- decode_decimal -----------------------------------------------------

    #[test]
    fn decode_decimal_matches_c() {
        assert_eq!(decode_decimal(b"0"), Some((0, 1)));
        assert_eq!(decode_decimal(b"19"), Some((19, 2)));
        assert_eq!(decode_decimal(b"65536,t=2"), Some((65536, 5)));
        assert_eq!(decode_decimal(b"4294967295"), Some((4294967295, 10)));
        // No digits at all.
        assert_eq!(decode_decimal(b""), None);
        assert_eq!(decode_decimal(b"$"), None);
        assert_eq!(decode_decimal(b"x1"), None);
        // Non-minimal.
        assert_eq!(decode_decimal(b"01"), None);
        assert_eq!(decode_decimal(b"00"), None);
        assert_eq!(decode_decimal(b"0019"), None);
        // Overflow of `unsigned long`.
        assert_eq!(
            decode_decimal(b"18446744073709551615"),
            Some((u64::MAX, 20))
        );
        assert_eq!(decode_decimal(b"18446744073709551616"), None);
        assert_eq!(decode_decimal(b"99999999999999999999999"), None);
    }

    #[test]
    fn decode_decimal_matches_the_c_dump() {
        // Every pair below was produced by running the C's `decode_decimal`
        // (it is `static`, so via a harness that #includes encoding.c) linked
        // against phc-winner-argon2/libargon2.a. `None` is the C's NULL.
        /// `(input, decode_decimal(input))`, the C's NULL being `None`.
        type Case = (&'static [u8], Option<(u64, usize)>);

        let cases: &[Case] = &[
            (b"", None),
            (b"0", Some((0, 1))),
            (b"00", None),
            (b"000", None),
            (b"01", None),
            (b"0019", None),
            (b"1", Some((1, 1))),
            (b"9", Some((9, 1))),
            (b"19", Some((19, 2))),
            (b"10", Some((10, 2))),
            (b"007", None),
            (b"4294967295", Some((4294967295, 10))),
            (b"4294967296", Some((4294967296, 10))),
            (b"9223372036854775807", Some((9223372036854775807, 19))),
            (b"18446744073709551615", Some((18446744073709551615, 20))),
            (b"18446744073709551616", None),
            (b"18446744073709551620", None),
            (b"19999999999999999999", None),
            (b"20000000000000000000", None),
            (b"99999999999999999999", None),
            (b"1000000000000000000000000", None),
            (b"65536,t=2", Some((65536, 5))),
            (b"1,t=2", Some((1, 1))),
            (b"x", None),
            (b"1x", Some((1, 1))),
            (b" 1", None),
            (b"+1", None),
            (b"-1", None),
            (b"1 ", Some((1, 1))),
            // "0" is minimal on its own, so the 'x' just ends the run.
            (b"0x10", Some((0, 1))),
            (b"12$", Some((12, 2))),
            (b"0,", Some((0, 1))),
            (b"10$", Some((10, 2))),
            (b"$", None),
            (b"1234567890", Some((1234567890, 10))),
        ];
        for (input, want) in cases {
            assert_eq!(
                decode_decimal(input),
                *want,
                "input {:?}",
                core::str::from_utf8(input).unwrap_or("<non-utf8>")
            );
        }
    }

    #[test]
    fn decimal_fields_are_u32_bounded() {
        // DECIMAL_U32 rejects anything above UINT32_MAX.
        let too_big = "$argon2i$v=19$m=4294967296,t=2,p=1$c29tZXNhbHQ\
                       $9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ";
        assert_eq!(
            decode_string(too_big, Algorithm::Argon2i),
            Err(Error::DecodingFail)
        );
        let leading_zero = "$argon2i$v=19$m=065536,t=2,p=1$c29tZXNhbHQ\
                            $9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ";
        assert_eq!(
            decode_string(leading_zero, Algorithm::Argon2i),
            Err(Error::DecodingFail)
        );
    }

    // -- encode -------------------------------------------------------------

    #[test]
    fn encode_matches_the_official_vectors() {
        let params = Params::builder()
            .memory(Memory::kib(65536))
            .passes(2)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .unwrap();
        let tag = unb64(b"wWKIMhR9lyDFvRz9YTZweHKfbftvj+qf+YFY4NeBbtA").unwrap();
        let encoded = encode_string_alloc(
            Algorithm::Argon2i,
            Version::V0x13,
            &params,
            b"somesalt",
            &tag,
        )
        .unwrap();
        assert_eq!(encoded, V13_ARGON2I);

        let tag = unb64(b"CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc").unwrap();
        let encoded = encode_string_alloc(
            Algorithm::Argon2id,
            Version::V0x13,
            &params,
            b"somesalt",
            &tag,
        )
        .unwrap();
        assert_eq!(encoded, V13_ARGON2ID);

        // The C always emits "$v=", even for 0x10.
        let encoded = encode_string_alloc(
            Algorithm::Argon2i,
            Version::V0x10,
            &params,
            b"somesalt",
            &V10_TAG,
        )
        .unwrap();
        assert_eq!(
            encoded,
            "$argon2i$v=16$m=65536,t=2,p=1$c29tZXNhbHQ\
             $9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ"
        );
    }

    #[test]
    fn encode_needs_encoded_len_bytes_exactly() {
        let params = Params::builder()
            .memory(Memory::kib(65536))
            .passes(2)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .unwrap();
        let want = encoded_len(Algorithm::Argon2i, 2, 65536, 1, 8, 32);
        assert_eq!(want, V13_ARGON2I.len() + 1);

        let mut buf = vec![0u8; want];
        let n = encode_string(
            &mut buf,
            Algorithm::Argon2i,
            Version::V0x13,
            &params,
            b"somesalt",
            &V10_TAG,
        )
        .unwrap();
        assert_eq!(n, want - 1);

        // One byte less is a failure, exactly as in the C.
        let mut buf = vec![0u8; want - 1];
        assert_eq!(
            encode_string(
                &mut buf,
                Algorithm::Argon2i,
                Version::V0x13,
                &params,
                b"somesalt",
                &V10_TAG,
            ),
            Err(Error::EncodingFail)
        );
    }

    #[test]
    fn encode_validates_first() {
        let params = Params::builder()
            .memory(Memory::kib(65536))
            .passes(2)
            .lanes(1)
            .tag_len(TagLen::bytes(32))
            .build()
            .unwrap();
        // Short salt: validate_inputs runs before anything is written.
        assert_eq!(
            encode_string_alloc(
                Algorithm::Argon2i,
                Version::V0x13,
                &params,
                b"short",
                &V10_TAG
            ),
            Err(Error::SaltTooShort)
        );
        // Short tag.
        assert_eq!(
            encode_string_alloc(
                Algorithm::Argon2i,
                Version::V0x13,
                &params,
                b"somesalt",
                &[0u8; 3]
            ),
            Err(Error::OutputTooShort)
        );
    }

    // -- decode -------------------------------------------------------------

    #[test]
    fn decode_the_v13_vector() {
        let d = decode_string(V13_ARGON2I, Algorithm::Argon2i).unwrap();
        assert_eq!(d.algorithm, Algorithm::Argon2i);
        assert_eq!(d.version, Version::V0x13);
        assert_eq!(d.params.memory_kib(), 65536);
        assert_eq!(d.params.passes(), 2);
        assert_eq!(d.params.lanes(), 1);
        assert_eq!(d.params.tag_len_bytes(), 32);
        assert_eq!(d.salt, b"somesalt");
        assert!(d.ad.is_empty());
        assert_eq!(
            d.hash,
            unb64(b"wWKIMhR9lyDFvRz9YTZweHKfbftvj+qf+YFY4NeBbtA").unwrap()
        );
    }

    #[test]
    fn decode_defaults_the_version_to_0x10() {
        let d = decode_string(V10_ARGON2I, Algorithm::Argon2i).unwrap();
        assert_eq!(d.version, Version::V0x10);
        assert_eq!(d.salt, b"somesalt");
        assert_eq!(d.hash, &V10_TAG);
    }

    #[test]
    fn decode_sets_threads_to_lanes() {
        let s = "$argon2id$v=19$m=65536,t=2,p=4$c29tZXNhbHQ\
                 $CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc";
        let d = decode_string(s, Algorithm::Argon2id).unwrap();
        assert_eq!(d.params.lanes(), 4);
        assert_eq!(d.params.threads(), 4);
        assert!(d.ad.is_empty());
    }

    #[test]
    fn decode_phc_accepts_c_strings_and_detects_the_algorithm() {
        let d = decode_phc(V13_ARGON2ID).unwrap();
        let c = decode_string(V13_ARGON2ID, Algorithm::Argon2id).unwrap();
        assert_eq!(d, c);
        assert!(d.ad.is_empty());
        assert_eq!(decode_phc(V13_ARGON2I).unwrap().algorithm, Algorithm::Argon2i);
        assert_eq!(decode_phc(V10_ARGON2I).unwrap().version, Version::V0x10);
    }

    #[test]
    fn decode_phc_accepts_m_p_t_order_and_unknown_keys() {
        let reordered = "$argon2id$v=19$m=65536,p=1,t=2$c29tZXNhbHQ\
                         $CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc";
        let d = decode_phc(reordered).unwrap();
        assert_eq!(d.params.memory_kib(), 65536);
        assert_eq!(d.params.passes(), 2);
        assert_eq!(d.params.lanes(), 1);
        assert_eq!(d.salt, b"somesalt");
        assert!(d.ad.is_empty());

        let with_keyid = "$argon2id$v=19$m=65536,t=2,p=1,keyid=abc$c29tZXNhbHQ\
                          $CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc";
        let k = decode_phc(with_keyid).unwrap();
        assert_eq!(k.hash, d.hash);
        assert!(k.ad.is_empty());

        // C-strict decoder still requires `$m=,t=,p=`.
        assert_eq!(
            decode_string(reordered, Algorithm::Argon2id),
            Err(Error::DecodingFail)
        );
    }

    #[test]
    fn decode_phc_reads_data_associated_data() {
        let encoded = "$argon2id$v=19$m=65536,t=2,p=1,data=c29tZXNhbHQ$c29tZXNhbHQ\
                       $CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc";
        let d = decode_phc(encoded).unwrap();
        assert_eq!(d.ad, b"somesalt");
        assert_eq!(d.salt, b"somesalt");
        assert_eq!(decode_string(encoded, Algorithm::Argon2id), Err(Error::DecodingFail));
    }

    #[test]
    fn decode_phc_rejects_missing_required_params() {
        assert_eq!(
            decode_phc("$argon2id$v=19$m=65536,t=2$c29tZXNhbHQ$AAAA"),
            Err(Error::DecodingFail)
        );
        assert_eq!(decode_phc("$argon2x$v=19$m=8,t=1,p=1$c29tZXNhbHQ$AAAA"), Err(Error::DecodingFail));
        assert_eq!(decode_phc("argon2id$v=19$m=8,t=1,p=1$c29tZXNhbHQ$AAAA"), Err(Error::DecodingFail));
    }

    #[test]
    fn encode_decode_round_trip() {
        let salt = b"0123456789abcdef";
        let tag: Vec<u8> = (0u8..48).collect();
        for algorithm in Algorithm::ALL {
            for version in Version::ALL {
                for lanes in [1u32, 2, 255] {
                    let params = Params::builder()
                        .memory(Memory::kib(1 << 16))
                        .passes(3)
                        .lanes(lanes)
                        .tag_len(TagLen::bytes(tag.len() as u64))
                        .build()
                        .unwrap();
                    let encoded =
                        encode_string_alloc(algorithm, version, &params, salt, &tag).unwrap();
                    let d = decode_string(&encoded, algorithm).unwrap();
                    assert_eq!(d.algorithm, algorithm);
                    assert_eq!(d.version, version);
                    assert!(d.ad.is_empty());
                    assert_eq!(d.params, params);
                    assert_eq!(d.salt, salt);
                    assert_eq!(d.hash, tag);
                    // And re-encoding is byte-identical.
                    assert_eq!(
                        encode_string_alloc(d.algorithm, d.version, &d.params, &d.salt, &d.hash)
                            .unwrap(),
                        encoded
                    );
                }
            }
        }
    }

    // The four malformed strings from `src/test.c`, both version flavours.

    #[test]
    fn decode_rejects_a_missing_dollar_before_the_salt() {
        // "…,p=1c29tZXNhbHQ$…": the '$' after p=1 is gone.
        let v10 = "$argon2i$m=65536,t=2,p=1c29tZXNhbHQ\
                   $9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ";
        assert_eq!(
            decode_string(v10, Algorithm::Argon2i),
            Err(Error::DecodingFail)
        );
        let v13 = "$argon2i$v=19$m=65536,t=2,p=1c29tZXNhbHQ\
                   $wWKIMhR9lyDFvRz9YTZweHKfbftvj+qf+YFY4NeBbtA";
        assert_eq!(
            decode_string(v13, Algorithm::Argon2i),
            Err(Error::DecodingFail)
        );
    }

    #[test]
    fn decode_rejects_a_missing_dollar_before_the_tag() {
        // The salt and tag run together into one 54-character base64 field,
        // which decodes cleanly (54 chars leave 4 zero bits); the failure comes
        // from the CC("$") that follows.
        let v10 = "$argon2i$m=65536,t=2,p=1$c29tZXNhbHQ\
                   9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ";
        assert_eq!(
            decode_string(v10, Algorithm::Argon2i),
            Err(Error::DecodingFail)
        );
        let v13 = "$argon2i$v=19$m=65536,t=2,p=1$c29tZXNhbHQ\
                   wWKIMhR9lyDFvRz9YTZweHKfbftvj+qf+YFY4NeBbtA";
        assert_eq!(
            decode_string(v13, Algorithm::Argon2i),
            Err(Error::DecodingFail)
        );
    }

    #[test]
    fn decode_reports_salt_too_short_not_decoding_fail() {
        // This is the distinction tests/vectors.rs relies on: the string parses,
        // and it is validate_inputs() that rejects it.
        let v10 = "$argon2i$m=65536,t=2,p=1$\
                   $9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ";
        assert_eq!(
            decode_string(v10, Algorithm::Argon2i),
            Err(Error::SaltTooShort)
        );
        let v13 = "$argon2i$v=19$m=65536,t=2,p=1$\
                   $9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ";
        assert_eq!(
            decode_string(v13, Algorithm::Argon2i),
            Err(Error::SaltTooShort)
        );
        // A 7-byte salt is also too short, and still not a DecodingFail.
        let short = "$argon2i$v=19$m=65536,t=2,p=1$c2hvcnRz\
                     $9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ";
        assert_eq!(
            decode_string(short, Algorithm::Argon2i),
            Err(Error::SaltTooShort)
        );
    }

    #[test]
    fn decode_argon2i_is_a_prefix_of_argon2id() {
        // CC("argon2i") matches the first seven characters of "argon2id"; the
        // leftover 'd' then fails the CC("$m=") (or the CC_opt("$v=")).
        assert_eq!(
            decode_string(V13_ARGON2ID, Algorithm::Argon2i),
            Err(Error::DecodingFail)
        );
        let v10_id = "$argon2id$m=65536,t=2,p=1$c29tZXNhbHQ\
                      $9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ";
        assert_eq!(
            decode_string(v10_id, Algorithm::Argon2i),
            Err(Error::DecodingFail)
        );
        // And the other way round: "argon2i" is not "argon2id".
        assert_eq!(
            decode_string(V13_ARGON2I, Algorithm::Argon2id),
            Err(Error::DecodingFail)
        );
        assert_eq!(
            decode_string(V13_ARGON2I, Algorithm::Argon2d),
            Err(Error::DecodingFail)
        );
        // The correct type still works, of course.
        assert!(decode_string(V13_ARGON2ID, Algorithm::Argon2id).is_ok());
    }

    #[test]
    fn decode_rejects_structural_damage() {
        let cases: &[&str] = &[
            "",
            "$",
            "argon2i$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ",
            "$argon2i",
            "$argon2i$v=19",
            "$argon2i$v=19$m=65536,t=2,p=1",
            "$argon2i$v=19$m=65536,t=2,p=1$c29tZXNhbHQ",
            // 'x' is not a decimal digit.
            "$argon2i$v=19$m=x,t=2,p=1$c29tZXNhbHQ$9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ",
            // Fields out of order.
            "$argon2i$v=19$t=2,m=65536,p=1$c29tZXNhbHQ$9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ",
            // Trailing junk after the tag.
            "$argon2i$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ$",
            "$argon2i$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ ",
            // '=' padding is not part of the alphabet, so it ends the field.
            "$argon2i$v=19$m=65536,t=2,p=1$c29tZXNhbHQ=$9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ",
        ];
        for case in cases {
            assert_eq!(
                decode_string(case, Algorithm::Argon2i),
                Err(Error::DecodingFail),
                "expected DecodingFail for {case:?}"
            );
        }
    }

    #[test]
    fn decode_surfaces_the_c_validation_codes() {
        // A 3-byte tag: outlen is checked first.
        assert_eq!(
            decode_string(
                "$argon2i$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$AAAA",
                Algorithm::Argon2i
            ),
            Err(Error::OutputTooShort)
        );
        // m_cost < ARGON2_MIN_MEMORY.
        assert_eq!(
            decode_string(
                "$argon2i$v=19$m=1,t=2,p=1$c29tZXNhbHQ$9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ",
                Algorithm::Argon2i
            ),
            Err(Error::MemoryTooLittle)
        );
        // m_cost < 8 * lanes.
        assert_eq!(
            decode_string(
                "$argon2i$v=19$m=16,t=2,p=4$c29tZXNhbHQ$9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ",
                Algorithm::Argon2i
            ),
            Err(Error::MemoryTooLittle)
        );
        // t_cost < ARGON2_MIN_TIME.
        assert_eq!(
            decode_string(
                "$argon2i$v=19$m=65536,t=0,p=1$c29tZXNhbHQ$9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ",
                Algorithm::Argon2i
            ),
            Err(Error::TimeTooSmall)
        );
        // lanes < ARGON2_MIN_LANES.
        assert_eq!(
            decode_string(
                "$argon2i$v=19$m=65536,t=2,p=0$c29tZXNhbHQ$9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ",
                Algorithm::Argon2i
            ),
            Err(Error::LanesTooFew)
        );
        // lanes > ARGON2_MAX_LANES (16777215).
        #[cfg(target_pointer_width = "64")]
        assert_eq!(
            decode_string(
                "$argon2i$v=19$m=4294967295,t=2,p=16777216$c29tZXNhbHQ$9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ",
                Algorithm::Argon2i
            ),
            Err(Error::LanesTooMany)
        );
        // On a 32-bit target ARGON2_MAX_MEMORY is 2 MiB (the C's own
        // pointer-width rule), so — exactly as the C on 32-bit — the memory
        // check fires before the lanes check gets a chance to.
        #[cfg(target_pointer_width = "32")]
        assert_eq!(
            decode_string(
                "$argon2i$v=19$m=4294967295,t=2,p=16777216$c29tZXNhbHQ$9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ",
                Algorithm::Argon2i
            ),
            Err(Error::MemoryTooMuch)
        );
    }

    #[test]
    fn validation_runs_before_the_trailing_character_check() {
        // Both wrong: the C returns SALT_TOO_SHORT because validate_inputs()
        // comes first.
        let s = "$argon2i$v=19$m=65536,t=2,p=1$\
                 $9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ!!!";
        assert_eq!(
            decode_string(s, Algorithm::Argon2i),
            Err(Error::SaltTooShort)
        );
    }

    #[test]
    fn decode_rejects_an_unrepresentable_version() {
        // Documented divergence: the C accepts this (validate_inputs never
        // looks at the version) and treats it as 0x13.
        let s = "$argon2i$v=99$m=65536,t=2,p=1$c29tZXNhbHQ\
                 $9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ";
        assert_eq!(
            decode_string(s, Algorithm::Argon2i),
            Err(Error::DecodingFail)
        );
        // …but an earlier error still wins, so the codes stay C-compatible.
        let s = "$argon2i$v=99$m=65536,t=2,p=1$$9sTbSlTio3Biev89thdrlKKiCaYsjjYVJxGAL3swxpQ";
        assert_eq!(
            decode_string(s, Algorithm::Argon2i),
            Err(Error::SaltTooShort)
        );
    }

    #[test]
    fn decode_accepts_a_long_salt_and_tag() {
        let salt: Vec<u8> = (0u8..=255).collect();
        let tag: Vec<u8> = (0u8..=200).rev().collect();
        let params = Params::builder()
            .memory(Memory::kib(1 << 16))
            .passes(1)
            .lanes(1)
            .tag_len(TagLen::bytes(tag.len() as u64))
            .build()
            .unwrap();
        let encoded =
            encode_string_alloc(Algorithm::Argon2d, Version::V0x13, &params, &salt, &tag).unwrap();
        let d = decode_string(&encoded, Algorithm::Argon2d).unwrap();
        assert_eq!(d.salt, salt);
        assert_eq!(d.hash, tag);
        assert_eq!(d.params.tag_len_bytes(), tag.len());
    }
}

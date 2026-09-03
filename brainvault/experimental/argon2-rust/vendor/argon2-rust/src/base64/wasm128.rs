//! WebAssembly SIMD128 Base64 blocks.
//!
//! This is the `base64-simd` 128-bit schedule expressed directly with
//! `core::arch::wasm32`: byte swizzles place each triple/quad into independent
//! lanes, fixed-width shifts split or merge the six-bit values, and one small
//! lookup maps those values onto the standard alphabet.

use core::arch::wasm32::*;

const SPLIT_SHUFFLE: [u8; 16] = [1, 0, 2, 1, 4, 3, 5, 4, 7, 6, 8, 7, 10, 9, 11, 10];
const ENCODE_SHIFT: [u8; 16] = [
    b'a' - 26,
    b'0'.wrapping_sub(52),
    b'0'.wrapping_sub(52),
    b'0'.wrapping_sub(52),
    b'0'.wrapping_sub(52),
    b'0'.wrapping_sub(52),
    b'0'.wrapping_sub(52),
    b'0'.wrapping_sub(52),
    b'0'.wrapping_sub(52),
    b'0'.wrapping_sub(52),
    b'0'.wrapping_sub(52),
    b'+'.wrapping_sub(62),
    b'/'.wrapping_sub(63),
    b'A',
    0x80,
    0x80,
];

#[inline(always)]
unsafe fn load_const(bytes: &[u8; 16]) -> v128 {
    // SAFETY: the fixed-size reference proves a complete 16-byte load.
    unsafe { v128_load(bytes.as_ptr().cast()) }
}

#[inline(always)]
unsafe fn split_bits(input: v128) -> v128 {
    // SAFETY: this module only exists with SIMD128 enabled; the only memory
    // access loads a fixed-size static table.
    unsafe {
        let input = u8x16_swizzle(input, load_const(&SPLIT_SHUFFLE));
        let a = u16x8_shr(
            v128_and(input, i32x4_splat(i32::from_le_bytes([0x00, 0xfc, 0x00, 0x00]))),
            10,
        );
        let b = u16x8_shl(
            v128_and(input, i32x4_splat(i32::from_le_bytes([0xf0, 0x03, 0x00, 0x00]))),
            4,
        );
        let c = u16x8_shr(
            v128_and(input, i32x4_splat(i32::from_le_bytes([0x00, 0x00, 0xc0, 0x0f]))),
            6,
        );
        let d = u16x8_shl(
            v128_and(input, i32x4_splat(i32::from_le_bytes([0x00, 0x00, 0x3f, 0x00]))),
            8,
        );
        v128_or(v128_or(a, b), v128_or(c, d))
    }
}

#[inline(always)]
unsafe fn encode_values(input: v128) -> v128 {
    // SAFETY: SIMD128 is a module-level compile-time contract; the only memory
    // access loads a fixed-size static table.
    unsafe {
        let ranges = u8x16_sub_sat(input, u8x16_splat(51));
        let upper = v128_and(i8x16_lt(input, i8x16_splat(26)), u8x16_splat(13));
        let indices = v128_or(ranges, upper);
        let shift = u8x16_swizzle(load_const(&ENCODE_SHIFT), indices);
        i8x16_add(input, shift)
    }
}

/// Encode complete 12-byte blocks into 16-byte blocks.
///
/// # Safety
///
/// This module exists only in a `+simd128` build. `src` names `len` readable
/// bytes and the caller sized `dst` for the complete encoding.
pub unsafe fn encode(dst: *mut u8, src: *const u8, len: usize) -> (usize, usize) {
    let mut consumed = 0usize;
    let mut written = 0usize;
    while len - consumed >= 16 {
        // SAFETY: the loop proves the 16-byte load and full-output sizing proves
        // the store; this module's cfg establishes SIMD128 support.
        unsafe {
            let input = v128_load(src.add(consumed).cast());
            let output = encode_values(split_bits(input));
            v128_store(dst.add(written).cast(), output);
        }
        consumed += 12;
        written += 16;
    }
    (consumed, written)
}

#[inline(always)]
fn decode_values(input: v128) -> Option<v128> {
    let upper = v128_and(
        u8x16_ge(input, u8x16_splat(b'A')),
        u8x16_le(input, u8x16_splat(b'Z')),
    );
    let lower = v128_and(
        u8x16_ge(input, u8x16_splat(b'a')),
        u8x16_le(input, u8x16_splat(b'z')),
    );
    let digit = v128_and(
        u8x16_ge(input, u8x16_splat(b'0')),
        u8x16_le(input, u8x16_splat(b'9')),
    );
    let plus = u8x16_eq(input, u8x16_splat(b'+'));
    let slash = u8x16_eq(input, u8x16_splat(b'/'));
    let valid = v128_or(
        v128_or(upper, lower),
        v128_or(v128_or(digit, plus), slash),
    );
    if i8x16_bitmask(valid) != 0xffff {
        return None;
    }

    let zero = u8x16_splat(0);
    let mut value = v128_bitselect(u8x16_sub(input, u8x16_splat(b'A')), zero, upper);
    value = v128_bitselect(
        u8x16_add(u8x16_sub(input, u8x16_splat(b'a')), u8x16_splat(26)),
        value,
        lower,
    );
    value = v128_bitselect(
        u8x16_add(u8x16_sub(input, u8x16_splat(b'0')), u8x16_splat(52)),
        value,
        digit,
    );
    value = v128_bitselect(u8x16_splat(62), value, plus);
    value = v128_bitselect(u8x16_splat(63), value, slash);
    Some(value)
}

const MERGE_SHUFFLE: [u8; 16] = [
    2, 1, 0, 6, 5, 4, 10, 9, 8, 14, 13, 12, 0x80, 0x80, 0x80, 0x80,
];

#[inline(always)]
unsafe fn merge_bits(input: v128) -> v128 {
    // SAFETY: SIMD128 is a module-level compile-time contract; the only memory
    // access loads a fixed-size static table.
    unsafe {
        let odd = v128_and(input, i32x4_splat(i32::from_le_bytes([0x3f, 0, 0x3f, 0])));
        let even = v128_and(input, i32x4_splat(i32::from_le_bytes([0, 0x3f, 0, 0x3f])));
        let odd = v128_or(u32x4_shl(odd, 18), u32x4_shr(odd, 10));
        let even = v128_or(u32x4_shl(even, 4), u32x4_shr(even, 24));
        let merged = v128_and(
            v128_or(odd, even),
            i32x4_splat(i32::from_le_bytes([0xff, 0xff, 0xff, 0])),
        );
        u8x16_swizzle(merged, load_const(&MERGE_SHUFFLE))
    }
}

/// Decode complete, valid 16-character blocks into 12-byte blocks.
///
/// # Safety
///
/// This module exists only in a `+simd128` build. Both pointer/length pairs
/// must name readable and writable regions respectively.
pub unsafe fn decode(
    dst: *mut u8,
    dst_len: usize,
    src: *const u8,
    src_len: usize,
) -> (usize, usize) {
    let mut consumed = 0usize;
    let mut written = 0usize;
    while src_len - consumed >= 16 && dst_len - written >= 12 {
        // SAFETY: the loop proves the input and output ranges; the temporary is
        // exactly one vector wide and this module's cfg establishes SIMD128.
        unsafe {
            let input = v128_load(src.add(consumed).cast());
            let Some(values) = decode_values(input) else {
                break;
            };
            let output = merge_bits(values);
            let mut bytes = [0u8; 16];
            v128_store(bytes.as_mut_ptr().cast(), output);
            core::ptr::copy_nonoverlapping(bytes.as_ptr(), dst.add(written), 12);
        }
        consumed += 16;
        written += 12;
    }
    (consumed, written)
}

//! AArch64 NEON Base64 blocks.
//!
//! Interleaved loads make Base64's 3-to-4 and 4-to-3 layouts explicit: one
//! `vld3` separates eight binary triples, while `vld4` separates eight encoded
//! quads. This is the small-input version of `aklomp/base64`'s AArch64 kernel;
//! eight lanes are intentional because a normal 32-byte Argon2 tag then takes
//! the vector path instead of falling below a bulk-only 48/64-byte threshold.

use core::arch::aarch64::*;

#[inline(always)]
unsafe fn encode_values(x: uint8x8_t) -> uint8x8_t {
    // Five alphabet ranges. The select chain is branch-free and has no memory
    // lookup indexed by salt/tag material.
    // SAFETY: the caller established NEON support; every operation is entirely
    // register-local.
    unsafe {
        let mut out = vadd_u8(x, vdup_n_u8(b'A'));
        out = vbsl_u8(
            vcge_u8(x, vdup_n_u8(26)),
            vadd_u8(x, vdup_n_u8(b'a' - 26)),
            out,
        );
        out = vbsl_u8(
            vcge_u8(x, vdup_n_u8(52)),
            vsub_u8(x, vdup_n_u8(52 - b'0')),
            out,
        );
        out = vbsl_u8(vceq_u8(x, vdup_n_u8(62)), vdup_n_u8(b'+'), out);
        vbsl_u8(vceq_u8(x, vdup_n_u8(63)), vdup_n_u8(b'/'), out)
    }
}

/// Encode complete 24-byte blocks into 32-byte blocks.
///
/// # Safety
///
/// The current CPU must support NEON. `src` names `len` readable bytes and the
/// caller sized `dst` for their complete Base64 encoding.
#[target_feature(enable = "neon")]
pub unsafe fn encode(dst: *mut u8, src: *const u8, len: usize) -> (usize, usize) {
    let mut consumed = 0usize;
    let mut written = 0usize;

    while len - consumed >= 24 {
        // SAFETY: the loop proves 24 input bytes. The complete output has room
        // for 32 bytes because the caller validated its full encoded length.
        unsafe {
            let input = vld3_u8(src.add(consumed));
            let mask = vdup_n_u8(0x3f);
            let a = input.0;
            let b = input.1;
            let c = input.2;

            let x0 = vshr_n_u8::<2>(a);
            let x1 = vand_u8(vorr_u8(vshl_n_u8::<4>(a), vshr_n_u8::<4>(b)), mask);
            let x2 = vand_u8(vorr_u8(vshl_n_u8::<2>(b), vshr_n_u8::<6>(c)), mask);
            let x3 = vand_u8(c, mask);

            let output = uint8x8x4_t(
                encode_values(x0),
                encode_values(x1),
                encode_values(x2),
                encode_values(x3),
            );
            vst4_u8(dst.add(written), output);
        }
        consumed += 24;
        written += 32;
    }

    (consumed, written)
}

#[inline(always)]
unsafe fn decode_values(x: uint8x8_t) -> (uint8x8_t, uint8x8_t) {
    // SAFETY: the caller established NEON support; every operation is entirely
    // register-local.
    unsafe {
        let upper = vand_u8(
            vcge_u8(x, vdup_n_u8(b'A')),
            vcle_u8(x, vdup_n_u8(b'Z')),
        );
        let lower = vand_u8(
            vcge_u8(x, vdup_n_u8(b'a')),
            vcle_u8(x, vdup_n_u8(b'z')),
        );
        let digit = vand_u8(
            vcge_u8(x, vdup_n_u8(b'0')),
            vcle_u8(x, vdup_n_u8(b'9')),
        );
        let plus = vceq_u8(x, vdup_n_u8(b'+'));
        let slash = vceq_u8(x, vdup_n_u8(b'/'));
        let valid = vorr_u8(
            vorr_u8(upper, lower),
            vorr_u8(vorr_u8(digit, plus), slash),
        );

        let mut value = vand_u8(upper, vsub_u8(x, vdup_n_u8(b'A')));
        value = vbsl_u8(lower, vadd_u8(vsub_u8(x, vdup_n_u8(b'a')), vdup_n_u8(26)), value);
        value = vbsl_u8(digit, vadd_u8(vsub_u8(x, vdup_n_u8(b'0')), vdup_n_u8(52)), value);
        value = vbsl_u8(plus, vdup_n_u8(62), value);
        value = vbsl_u8(slash, vdup_n_u8(63), value);
        (value, valid)
    }
}

/// Decode complete, valid 32-character blocks into 24-byte blocks.
///
/// Stops before a block containing any invalid byte so the scalar caller can
/// identify the precise stopping position.
///
/// # Safety
///
/// The current CPU must support NEON. The two pointer/length pairs must name
/// readable and writable regions respectively.
#[target_feature(enable = "neon")]
pub unsafe fn decode(
    dst: *mut u8,
    dst_len: usize,
    src: *const u8,
    src_len: usize,
) -> (usize, usize) {
    let mut consumed = 0usize;
    let mut written = 0usize;

    while src_len - consumed >= 32 && dst_len - written >= 24 {
        // SAFETY: the loop proves the 32-byte load and 24-byte store in range.
        unsafe {
            let input = vld4_u8(src.add(consumed));
            let (a, va) = decode_values(input.0);
            let (b, vb) = decode_values(input.1);
            let (c, vc) = decode_values(input.2);
            let (d, vd) = decode_values(input.3);
            let valid = vand_u8(vand_u8(va, vb), vand_u8(vc, vd));
            if vminv_u8(valid) != u8::MAX {
                break;
            }

            let output = uint8x8x3_t(
                vorr_u8(vshl_n_u8::<2>(a), vshr_n_u8::<4>(b)),
                vorr_u8(vshl_n_u8::<4>(b), vshr_n_u8::<2>(c)),
                vorr_u8(vshl_n_u8::<6>(c), d),
            );
            vst3_u8(dst.add(written), output);
        }
        consumed += 32;
        written += 24;
    }

    (consumed, written)
}

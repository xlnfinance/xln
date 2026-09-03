//! x86 SSSE3 and AVX2 Base64 blocks.
//!
//! This is the `base64-simd` split/translate/merge schedule expressed directly
//! with `core::arch` intrinsics. AVX2 performs two lanes together and then
//! hands its short remainder to SSSE3. Decoding uses vector range masks for the
//! standard alphabet before the same multiply-and-shuffle merge.

#[cfg(target_arch = "x86")]
use core::arch::x86::*;
#[cfg(target_arch = "x86_64")]
use core::arch::x86_64::*;

#[inline(always)]
unsafe fn encode_reshuffle_128(input: __m128i) -> __m128i {
    // SAFETY: the caller established SSSE3 support; operations are register-only.
    unsafe {
        let input = _mm_shuffle_epi8(
            input,
            _mm_setr_epi8(1, 0, 2, 1, 4, 3, 5, 4, 7, 6, 8, 7, 10, 9, 11, 10),
        );
        let a = _mm_and_si128(input, _mm_set1_epi32(0x0fc0_fc00));
        let a = _mm_mulhi_epu16(a, _mm_set1_epi32(0x0400_0040));
        let b = _mm_and_si128(input, _mm_set1_epi32(0x003f_03f0));
        let b = _mm_mullo_epi16(b, _mm_set1_epi32(0x0100_0010));
        _mm_or_si128(a, b)
    }
}

#[inline(always)]
unsafe fn encode_translate_128(input: __m128i) -> __m128i {
    // SAFETY: the caller established SSSE3 support; operations are register-only.
    unsafe {
        let lut = _mm_setr_epi8(
            65, 71, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -19, -16, 0, 0,
        );
        let indices = _mm_subs_epu8(input, _mm_set1_epi8(51));
        let mask = _mm_cmpgt_epi8(input, _mm_set1_epi8(25));
        let indices = _mm_sub_epi8(indices, mask);
        _mm_add_epi8(input, _mm_shuffle_epi8(lut, indices))
    }
}

#[inline(always)]
unsafe fn encode_block_12(dst: *mut u8, src: *const u8) {
    // SAFETY: the caller established SSSE3 and provides 16 readable/writable bytes.
    unsafe {
        let input = _mm_loadu_si128(src.cast());
        let output = encode_translate_128(encode_reshuffle_128(input));
        _mm_storeu_si128(dst.cast(), output);
    }
}

/// Encode complete 12-byte blocks with SSSE3.
///
/// # Safety
///
/// The CPU must support SSSE3. `src` names `len` bytes and `dst` is large
/// enough for the complete Base64 encoding.
#[target_feature(enable = "ssse3")]
pub unsafe fn encode_ssse3(dst: *mut u8, src: *const u8, len: usize) -> (usize, usize) {
    let mut consumed = 0usize;
    let mut written = 0usize;
    // The kernel consumes 12 bytes but loads 16.
    while len - consumed >= 16 {
        // SAFETY: the loop proves the load; full-output sizing proves the store.
        unsafe { encode_block_12(dst.add(written), src.add(consumed)) };
        consumed += 12;
        written += 16;
    }
    (consumed, written)
}

#[inline(always)]
unsafe fn encode_reshuffle_256(input: __m256i) -> __m256i {
    // SAFETY: the caller established AVX2 support; operations are register-only.
    unsafe {
        let input = _mm256_shuffle_epi8(
            input,
            _mm256_setr_epi8(
                5, 4, 6, 5, 8, 7, 9, 8, 11, 10, 12, 11, 14, 13, 15, 14, //
                1, 0, 2, 1, 4, 3, 5, 4, 7, 6, 8, 7, 10, 9, 11, 10,
            ),
        );
        let a = _mm256_and_si256(input, _mm256_set1_epi32(0x0fc0_fc00));
        let a = _mm256_mulhi_epu16(a, _mm256_set1_epi32(0x0400_0040));
        let b = _mm256_and_si256(input, _mm256_set1_epi32(0x003f_03f0));
        let b = _mm256_mullo_epi16(b, _mm256_set1_epi32(0x0100_0010));
        _mm256_or_si256(a, b)
    }
}

#[inline(always)]
unsafe fn encode_translate_256(input: __m256i) -> __m256i {
    // SAFETY: the caller established AVX2 support; operations are register-only.
    unsafe {
        let lut = _mm256_setr_epi8(
            65, 71, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -19, -16, 0, 0, //
            65, 71, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -19, -16, 0, 0,
        );
        let indices = _mm256_subs_epu8(input, _mm256_set1_epi8(51));
        let mask = _mm256_cmpgt_epi8(input, _mm256_set1_epi8(25));
        let indices = _mm256_sub_epi8(indices, mask);
        _mm256_add_epi8(input, _mm256_shuffle_epi8(lut, indices))
    }
}

#[inline(always)]
unsafe fn encode_block_24(dst: *mut u8, src: *const u8) {
    // SAFETY: the caller established AVX2 and provides 32 readable/writable bytes.
    unsafe {
        let input = _mm256_loadu_si256(src.cast());
        // Arrange bytes 0..11 and 12..23 into the two lane-local shuffle
        // layouts, without reading before `src` on the first iteration.
        let input = _mm256_permutevar8x32_epi32(
            input,
            _mm256_setr_epi32(0, 0, 1, 2, 3, 4, 5, 6),
        );
        let output = encode_translate_256(encode_reshuffle_256(input));
        _mm256_storeu_si256(dst.cast(), output);
    }
}

/// Encode 24-byte AVX2 blocks, then a 12-byte SSSE3 remainder.
///
/// # Safety
///
/// The CPU must support AVX2 and SSSE3. Pointer bounds are as for
/// [`encode_ssse3`].
#[target_feature(enable = "avx2,ssse3")]
pub unsafe fn encode_avx2(dst: *mut u8, src: *const u8, len: usize) -> (usize, usize) {
    let mut consumed = 0usize;
    let mut written = 0usize;
    // The kernel consumes 24 bytes but loads 32.
    while len - consumed >= 32 {
        // SAFETY: the loop proves the load; full-output sizing proves the store.
        unsafe { encode_block_24(dst.add(written), src.add(consumed)) };
        consumed += 24;
        written += 32;
    }
    while len - consumed >= 16 {
        // SAFETY: the loop proves the load; full-output sizing proves the store.
        unsafe { encode_block_12(dst.add(written), src.add(consumed)) };
        consumed += 12;
        written += 16;
    }
    (consumed, written)
}

#[inline(always)]
unsafe fn decode_translate_128(input: __m128i) -> Option<__m128i> {
    // SAFETY: the caller established SSSE3 support; operations are register-only.
    unsafe {
        let upper = _mm_and_si128(
            _mm_cmpgt_epi8(input, _mm_set1_epi8((b'A' - 1) as i8)),
            _mm_cmpgt_epi8(_mm_set1_epi8((b'Z' + 1) as i8), input),
        );
        let lower = _mm_and_si128(
            _mm_cmpgt_epi8(input, _mm_set1_epi8((b'a' - 1) as i8)),
            _mm_cmpgt_epi8(_mm_set1_epi8((b'z' + 1) as i8), input),
        );
        let digit = _mm_and_si128(
            _mm_cmpgt_epi8(input, _mm_set1_epi8((b'0' - 1) as i8)),
            _mm_cmpgt_epi8(_mm_set1_epi8((b'9' + 1) as i8), input),
        );
        let plus = _mm_cmpeq_epi8(input, _mm_set1_epi8(b'+' as i8));
        let slash = _mm_cmpeq_epi8(input, _mm_set1_epi8(b'/' as i8));
        let valid = _mm_or_si128(
            _mm_or_si128(upper, lower),
            _mm_or_si128(_mm_or_si128(digit, plus), slash),
        );
        if _mm_movemask_epi8(valid) != 0xffff {
            return None;
        }

        let upper_value = _mm_and_si128(upper, _mm_sub_epi8(input, _mm_set1_epi8(b'A' as i8)));
        let lower_value = _mm_and_si128(
            lower,
            _mm_add_epi8(
                _mm_sub_epi8(input, _mm_set1_epi8(b'a' as i8)),
                _mm_set1_epi8(26),
            ),
        );
        let digit_value = _mm_and_si128(
            digit,
            _mm_add_epi8(
                _mm_sub_epi8(input, _mm_set1_epi8(b'0' as i8)),
                _mm_set1_epi8(52),
            ),
        );
        Some(_mm_or_si128(
            _mm_or_si128(upper_value, lower_value),
            _mm_or_si128(
                digit_value,
                _mm_or_si128(
                    _mm_and_si128(plus, _mm_set1_epi8(62)),
                    _mm_and_si128(slash, _mm_set1_epi8(63)),
                ),
            ),
        ))
    }
}

#[inline(always)]
unsafe fn decode_reshuffle_128(input: __m128i) -> __m128i {
    // SAFETY: the caller established SSSE3 support; operations are register-only.
    unsafe {
        let merged = _mm_maddubs_epi16(input, _mm_set1_epi32(0x0140_0140));
        let merged = _mm_madd_epi16(merged, _mm_set1_epi32(0x0001_1000));
        _mm_shuffle_epi8(
            merged,
            _mm_setr_epi8(2, 1, 0, 6, 5, 4, 10, 9, 8, 14, 13, 12, -1, -1, -1, -1),
        )
    }
}

#[inline(always)]
unsafe fn store_12(dst: *mut u8, value: __m128i) {
    // SAFETY: the caller provides exactly twelve writable bytes.
    unsafe {
        _mm_storel_epi64(dst.cast(), value);
        let high = _mm_srli_si128::<8>(value);
        dst.add(8).cast::<i32>().write_unaligned(_mm_cvtsi128_si32(high));
    }
}

#[inline(always)]
unsafe fn decode_block_16(dst: *mut u8, src: *const u8) -> bool {
    // SAFETY: the caller established SSSE3 and provides 16 readable and twelve
    // writable bytes.
    unsafe {
        let input = _mm_loadu_si128(src.cast());
        let Some(values) = decode_translate_128(input) else {
            return false;
        };
        store_12(dst, decode_reshuffle_128(values));
        true
    }
}

/// Decode valid 16-character blocks with SSSE3.
///
/// # Safety
///
/// The CPU must support SSSE3 and both pointer/length pairs must be valid.
#[target_feature(enable = "ssse3")]
pub unsafe fn decode_ssse3(
    dst: *mut u8,
    dst_len: usize,
    src: *const u8,
    src_len: usize,
) -> (usize, usize) {
    let mut consumed = 0usize;
    let mut written = 0usize;
    while src_len - consumed >= 16 && dst_len - written >= 12 {
        // SAFETY: the loop proves both pointer ranges; the attribute proves SSSE3.
        if !unsafe { decode_block_16(dst.add(written), src.add(consumed)) } {
            break;
        }
        consumed += 16;
        written += 12;
    }
    (consumed, written)
}

#[inline(always)]
unsafe fn decode_translate_256(input: __m256i) -> Option<__m256i> {
    // SAFETY: the caller established AVX2 support; operations are register-only.
    unsafe {
        let upper = _mm256_and_si256(
            _mm256_cmpgt_epi8(input, _mm256_set1_epi8((b'A' - 1) as i8)),
            _mm256_cmpgt_epi8(_mm256_set1_epi8((b'Z' + 1) as i8), input),
        );
        let lower = _mm256_and_si256(
            _mm256_cmpgt_epi8(input, _mm256_set1_epi8((b'a' - 1) as i8)),
            _mm256_cmpgt_epi8(_mm256_set1_epi8((b'z' + 1) as i8), input),
        );
        let digit = _mm256_and_si256(
            _mm256_cmpgt_epi8(input, _mm256_set1_epi8((b'0' - 1) as i8)),
            _mm256_cmpgt_epi8(_mm256_set1_epi8((b'9' + 1) as i8), input),
        );
        let plus = _mm256_cmpeq_epi8(input, _mm256_set1_epi8(b'+' as i8));
        let slash = _mm256_cmpeq_epi8(input, _mm256_set1_epi8(b'/' as i8));
        let valid = _mm256_or_si256(
            _mm256_or_si256(upper, lower),
            _mm256_or_si256(_mm256_or_si256(digit, plus), slash),
        );
        if _mm256_movemask_epi8(valid) != -1 {
            return None;
        }

        let upper_value =
            _mm256_and_si256(upper, _mm256_sub_epi8(input, _mm256_set1_epi8(b'A' as i8)));
        let lower_value = _mm256_and_si256(
            lower,
            _mm256_add_epi8(
                _mm256_sub_epi8(input, _mm256_set1_epi8(b'a' as i8)),
                _mm256_set1_epi8(26),
            ),
        );
        let digit_value = _mm256_and_si256(
            digit,
            _mm256_add_epi8(
                _mm256_sub_epi8(input, _mm256_set1_epi8(b'0' as i8)),
                _mm256_set1_epi8(52),
            ),
        );
        Some(_mm256_or_si256(
            _mm256_or_si256(upper_value, lower_value),
            _mm256_or_si256(
                digit_value,
                _mm256_or_si256(
                    _mm256_and_si256(plus, _mm256_set1_epi8(62)),
                    _mm256_and_si256(slash, _mm256_set1_epi8(63)),
                ),
            ),
        ))
    }
}

#[inline(always)]
unsafe fn decode_reshuffle_256(input: __m256i) -> __m256i {
    // SAFETY: the caller established AVX2 support; operations are register-only.
    unsafe {
        let merged = _mm256_maddubs_epi16(input, _mm256_set1_epi32(0x0140_0140));
        let merged = _mm256_madd_epi16(merged, _mm256_set1_epi32(0x0001_1000));
        let packed = _mm256_shuffle_epi8(
            merged,
            _mm256_setr_epi8(
                2, 1, 0, 6, 5, 4, 10, 9, 8, 14, 13, 12, -1, -1, -1, -1, //
                2, 1, 0, 6, 5, 4, 10, 9, 8, 14, 13, 12, -1, -1, -1, -1,
            ),
        );
        _mm256_permutevar8x32_epi32(packed, _mm256_setr_epi32(0, 1, 2, 4, 5, 6, 7, 7))
    }
}

#[inline(always)]
unsafe fn store_24(dst: *mut u8, value: __m256i) {
    // SAFETY: the caller provides exactly twenty-four writable bytes.
    unsafe {
        _mm_storeu_si128(dst.cast(), _mm256_castsi256_si128(value));
        _mm_storel_epi64(dst.add(16).cast(), _mm256_extracti128_si256::<1>(value));
    }
}

#[inline(always)]
unsafe fn decode_block_32(dst: *mut u8, src: *const u8) -> bool {
    // SAFETY: the caller established AVX2 and provides 32 readable and 24
    // writable bytes.
    unsafe {
        let input = _mm256_loadu_si256(src.cast());
        let Some(values) = decode_translate_256(input) else {
            return false;
        };
        store_24(dst, decode_reshuffle_256(values));
        true
    }
}

/// Decode 32-character AVX2 blocks, then a 16-character SSSE3 remainder.
///
/// # Safety
///
/// The CPU must support AVX2 and SSSE3 and both pointer/length pairs must be
/// valid.
#[target_feature(enable = "avx2,ssse3")]
pub unsafe fn decode_avx2(
    dst: *mut u8,
    dst_len: usize,
    src: *const u8,
    src_len: usize,
) -> (usize, usize) {
    let mut consumed = 0usize;
    let mut written = 0usize;
    while src_len - consumed >= 32 && dst_len - written >= 24 {
        // SAFETY: the loop proves both pointer ranges; the attribute proves AVX2.
        if !unsafe { decode_block_32(dst.add(written), src.add(consumed)) } {
            // Leave the whole rejected vector for the scalar tail. Retrying its
            // first half with SSSE3 would only optimize malformed input.
            return (consumed, written);
        }
        consumed += 32;
        written += 24;
    }
    while src_len - consumed >= 16 && dst_len - written >= 12 {
        // SAFETY: the loop proves both pointer ranges; the attribute includes SSSE3.
        if !unsafe { decode_block_16(dst.add(written), src.add(consumed)) } {
            break;
        }
        consumed += 16;
        written += 12;
    }
    (consumed, written)
}

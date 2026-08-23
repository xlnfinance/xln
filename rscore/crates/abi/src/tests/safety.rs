use std::panic::{AssertUnwindSafe, catch_unwind};

use super::*;

#[test]
fn rejects_maps_extensions_floats_and_invalid_utf8() {
    let encoded = encode_envelope(&sample_envelope()).expect("encode");
    let (_, body_start, _) = body_metadata(&encoded);
    for marker in [0x80, 0xc7, 0xca] {
        let mut changed = encoded.clone();
        changed[body_start + 1] = marker;
        assert_eq!(
            decode_envelope(&changed, BODY_ARITY),
            Err(AbiError::UnsupportedMarker(marker))
        );
    }
    let mut invalid_domain = encoded.clone();
    let domain_last = 1 + 1 + 1 + ABI_DOMAIN.len() - 1;
    invalid_domain[domain_last] = 0xff;
    assert_eq!(
        decode_envelope(&invalid_domain, BODY_ARITY),
        Err(AbiError::InvalidUtf8)
    );
}

#[test]
fn enforces_envelope_text_blob_nesting_and_limit_bounds() {
    let envelope = sample_envelope();
    let encoded = encode_envelope(&envelope).expect("encode");
    let limits = AbiLimits {
        max_envelope_bytes: encoded.len() - 1,
        ..AbiLimits::default()
    };
    assert_eq!(
        decode_envelope_with_limits(&encoded, BODY_ARITY, &limits),
        Err(AbiError::EnvelopeTooLarge {
            actual: encoded.len(),
            max: encoded.len() - 1,
        })
    );
    let limits = AbiLimits {
        max_text_bytes: ABI_DOMAIN.len() - 1,
        ..AbiLimits::default()
    };
    assert_eq!(
        decode_envelope_with_limits(&encoded, BODY_ARITY, &limits),
        Err(AbiError::TextTooLarge {
            actual: ABI_DOMAIN.len(),
            max: ABI_DOMAIN.len() - 1,
        })
    );
    let limits = AbiLimits {
        max_nesting_depth: 1,
        ..AbiLimits::default()
    };
    assert_eq!(
        decode_envelope_with_limits(&encoded, BODY_ARITY, &limits),
        Err(AbiError::NestingTooDeep { actual: 2, max: 1 })
    );
    let limits = AbiLimits {
        max_blob_bytes: 2,
        ..AbiLimits::default()
    };
    assert_eq!(
        decode_envelope_with_limits(&encoded, BODY_ARITY, &limits),
        Err(AbiError::BlobTooLarge { actual: 3, max: 2 })
    );
    let limits = AbiLimits {
        max_nesting_depth: 65,
        ..AbiLimits::default()
    };
    assert_eq!(
        decode_envelope_with_limits(&encoded, BODY_ARITY, &limits),
        Err(AbiError::InvalidLimits("maxNestingDepth"))
    );
}

#[test]
fn body_integer_boundaries_round_trip_canonically() {
    let values = [
        i128::from(i64::MIN),
        -2_147_483_649,
        -2_147_483_648,
        -32_769,
        -32_768,
        -129,
        -128,
        -33,
        -32,
        -1,
        0,
        127,
        128,
        255,
        256,
        65_535,
        65_536,
        4_294_967_295,
        4_294_967_296,
        i128::from(u64::MAX),
    ];
    for value in values {
        let mut envelope = sample_envelope();
        envelope.body = BodyTuple::from_array([AbiValue::Integer(value)]);
        let encoded = encode_envelope(&envelope).expect("encode integer boundary");
        assert_eq!(decode_envelope(&encoded, 1), Ok(envelope));
    }
}

#[test]
fn malformed_bytes_never_panic() {
    let encoded = encode_envelope(&sample_envelope()).expect("encode");
    for end in 0..=encoded.len() {
        let result = catch_unwind(AssertUnwindSafe(|| {
            decode_envelope(&encoded[..end], BODY_ARITY)
        }));
        assert!(result.is_ok(), "decoder panicked at truncation {end}");
    }
    for marker in 0_u8..=u8::MAX {
        let input = [ABI_MAGIC, marker];
        let result = catch_unwind(AssertUnwindSafe(|| decode_envelope(&input, BODY_ARITY)));
        assert!(result.is_ok(), "decoder panicked for marker {marker:#04x}");
    }
    let mut state = 0x9e37_79b9_u32;
    for length in 0..512_usize {
        let mut bytes = vec![0_u8; length];
        for byte in &mut bytes {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            *byte = state as u8;
        }
        let result = catch_unwind(AssertUnwindSafe(|| decode_envelope(&bytes, BODY_ARITY)));
        assert!(
            result.is_ok(),
            "decoder panicked for corpus length {length}"
        );
    }
}

use sha2::{Digest, Sha256};

use super::*;
use crate::msgpack_parser::Parser;

const BODY_ARITY: usize = 6;

mod safety;

fn sequence<const N: usize>(start: u8) -> [u8; N] {
    std::array::from_fn(|index| start.wrapping_add(index as u8))
}

fn sample_body() -> BodyTuple {
    BodyTuple::from_array([
        AbiValue::Nil,
        AbiValue::Bool(true),
        AbiValue::Integer(-33),
        AbiValue::Text("phase".into()),
        AbiValue::Bytes(vec![ABI_MAGIC, 0x91, 0xc0]),
        AbiValue::Tuple(BodyTuple::from_array([AbiValue::Integer(7), AbiValue::Nil])),
    ])
}

fn sample_envelope() -> Envelope {
    Envelope {
        binding: ProtocolBinding {
            protocol_version: 4,
            storage_schema_version: 9,
            protocol_fingerprint: sequence(0x00),
        },
        identity: EngineIdentity {
            engine_generation: sequence(0xa0),
            runtime_id: sequence(0x10),
            session_id: sequence(0x20),
            request_id: sequence(0x30),
        },
        op_tag: OpTag::ExecuteWave,
        message_kind: MessageKind::Request,
        body: sample_body(),
    }
}

fn parser_after_prefix<'a>(bytes: &'a [u8], limits: &'a AbiLimits) -> Parser<'a> {
    let mut parser = Parser::new(&bytes[1..], limits);
    assert_eq!(parser.read_tuple_len(), Ok(14));
    assert_eq!(parser.read_text().as_deref(), Ok(ABI_DOMAIN));
    parser
}

fn skip_binding_and_identity(parser: &mut Parser<'_>) {
    assert_eq!(parser.read_unsigned(), Ok(1));
    assert_eq!(parser.read_unsigned(), Ok(4));
    assert_eq!(parser.read_unsigned(), Ok(9));
    assert!(parser.read_fixed_bytes::<32>("fingerprint").is_ok());
    assert!(parser.read_fixed_bytes::<8>("generation").is_ok());
    assert!(parser.read_fixed_bytes::<20>("runtime").is_ok());
    assert!(parser.read_fixed_bytes::<16>("session").is_ok());
    assert!(parser.read_fixed_bytes::<8>("request").is_ok());
}

fn body_metadata(bytes: &[u8]) -> (usize, usize, usize) {
    let limits = AbiLimits::default();
    let mut parser = parser_after_prefix(bytes, &limits);
    skip_binding_and_identity(&mut parser);
    assert_eq!(parser.read_unsigned(), Ok(5));
    assert_eq!(parser.read_unsigned(), Ok(0));
    assert_eq!(parser.read_unsigned(), Ok(19));
    let digest_marker = parser.position() + 1;
    assert_eq!(bytes.get(digest_marker), Some(&0xc4));
    assert_eq!(bytes.get(digest_marker + 1), Some(&32));
    assert!(parser.read_fixed_bytes::<32>("digest").is_ok());
    let body_start = parser.position() + 1;
    assert!(parser.read_body_tuple(BODY_ARITY).is_ok());
    let body_end = parser.position() + 1;
    (digest_marker + 2, body_start, body_end)
}

#[test]
fn exact_golden_matches_canonical_msgpack_and_sha256() {
    let encoded = encode_envelope(&sample_envelope()).expect("encode fixture");
    assert_eq!(
        hex::encode(encoded),
        "039eb2786c6e2e7273636f72652e6163636f756e74010409c420000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1fc408a0a1a2a3a4a5a6a7c414101112131415161718191a1b1c1d1e1f20212223c410202122232425262728292a2b2c2d2e2fc4083031323334353637050013c42057aad4903ecf2846e04772129fadac7ae08c4e93a0fe07431c506f95a9ca9fc696c0c3d0dfa57068617365c4030391c09207c0"
    );
    let body = hex::decode("96c0c3d0dfa57068617365c4030391c09207c0").expect("body hex");
    assert_eq!(
        hex::encode(
            compute_body_digest(
                &sequence(0x00),
                &sequence(0x10),
                OpTag::ExecuteWave,
                MessageKind::Request,
                &body,
            )
            .expect("body digest")
        ),
        "57aad4903ecf2846e04772129fadac7ae08c4e93a0fe07431c506f95a9ca9fc6"
    );
}

#[test]
fn round_trips_nil_nested_tuple_and_independent_payload_bytes() {
    let envelope = sample_envelope();
    let encoded = encode_envelope(&envelope).expect("encode");
    let decoded = decode_envelope(&encoded, BODY_ARITY).expect("decode");
    assert_eq!(decoded, envelope);
}

#[test]
fn every_closed_operation_and_message_kind_round_trips() {
    let operations = [
        OpTag::Hello,
        OpTag::RestoreCheckpoint,
        OpTag::BeginRuntime,
        OpTag::BeginEntity,
        OpTag::ReadCapacityBatch,
        OpTag::ExecuteWave,
        OpTag::PrepareEntity,
        OpTag::FinalizeEntity,
        OpTag::DiscardEntity,
        OpTag::PrepareRuntime,
        OpTag::CommitRuntime,
        OpTag::AbortRuntime,
        OpTag::ReadAccountSummaryPage,
        OpTag::Shutdown,
    ];
    let kinds = [MessageKind::Request, MessageKind::Ok, MessageKind::Error];
    for op_tag in operations {
        for message_kind in kinds {
            let mut envelope = sample_envelope();
            envelope.op_tag = op_tag;
            envelope.message_kind = message_kind;
            let encoded = encode_envelope(&envelope).expect("encode closed tag");
            assert_eq!(decode_envelope(&encoded, BODY_ARITY), Ok(envelope));
        }
    }
}

#[test]
fn rejects_wrong_magic_trailing_bytes_and_wrong_arities() {
    let encoded = encode_envelope(&sample_envelope()).expect("encode");
    for magic in [0x01, 0x02] {
        let mut changed = encoded.clone();
        changed[0] = magic;
        assert_eq!(
            decode_envelope(&changed, BODY_ARITY),
            Err(AbiError::InvalidMagic(magic))
        );
    }
    let mut trailing = encoded.clone();
    trailing.push(0xc0);
    assert_eq!(
        decode_envelope(&trailing, BODY_ARITY),
        Err(AbiError::TrailingBytes(1))
    );
    let mut outer = encoded.clone();
    outer[1] = 0x9d;
    assert_eq!(
        decode_envelope(&outer, BODY_ARITY),
        Err(AbiError::OuterArity { actual: 13 })
    );
    assert_eq!(
        decode_envelope(&encoded, BODY_ARITY - 1),
        Err(AbiError::BodyArity {
            actual: BODY_ARITY,
            expected: BODY_ARITY - 1,
        })
    );
}

#[test]
fn rejects_unknown_tags_and_wrong_fixed_width_identifiers() {
    let encoded = encode_envelope(&sample_envelope()).expect("encode");
    let limits = AbiLimits::default();
    let mut parser = parser_after_prefix(&encoded, &limits);
    skip_binding_and_identity(&mut parser);
    let op_position = parser.position() + 1;
    let mut unknown_op = encoded.clone();
    // One past the last operation, so this stays a real unknown tag as the op
    // set grows.
    unknown_op[op_position] = OpTag::ReadAccountEnvelope as u8 + 1;
    assert_eq!(
        decode_envelope(&unknown_op, BODY_ARITY),
        Err(AbiError::UnknownOpTag(u64::from(
            OpTag::ReadAccountEnvelope as u8 + 1
        )))
    );
    assert_eq!(parser.read_unsigned(), Ok(5));
    let kind_position = parser.position() + 1;
    let mut unknown_kind = encoded.clone();
    unknown_kind[kind_position] = 3;
    assert_eq!(
        decode_envelope(&unknown_kind, BODY_ARITY),
        Err(AbiError::UnknownMessageKind(3))
    );

    let mut parser = parser_after_prefix(&encoded, &limits);
    assert_eq!(parser.read_unsigned(), Ok(1));
    assert_eq!(parser.read_unsigned(), Ok(4));
    assert_eq!(parser.read_unsigned(), Ok(9));
    assert!(parser.read_fixed_bytes::<32>("fingerprint").is_ok());
    assert!(parser.read_fixed_bytes::<8>("generation").is_ok());
    let runtime_marker = parser.position() + 1;
    let mut wrong_runtime = encoded.clone();
    wrong_runtime[runtime_marker + 1] = 19;
    assert_eq!(
        decode_envelope(&wrong_runtime, BODY_ARITY),
        Err(AbiError::FixedBytes {
            field: "runtimeId",
            actual: 19,
            expected: 20,
        })
    );
}

#[test]
fn rejects_wrong_body_length_digest_and_virtual_nested_magic_digest() {
    let encoded = encode_envelope(&sample_envelope()).expect("encode");
    let limits = AbiLimits::default();
    let mut parser = parser_after_prefix(&encoded, &limits);
    skip_binding_and_identity(&mut parser);
    assert_eq!(parser.read_unsigned(), Ok(5));
    assert_eq!(parser.read_unsigned(), Ok(0));
    let length_position = parser.position() + 1;
    let mut wrong_length = encoded.clone();
    wrong_length[length_position] = 20;
    assert_eq!(
        decode_envelope(&wrong_length, BODY_ARITY),
        Err(AbiError::BodyLength {
            actual: 19,
            declared: 20
        })
    );

    let (digest_start, body_start, body_end) = body_metadata(&encoded);
    let mut wrong_digest = encoded.clone();
    wrong_digest[digest_start] ^= 0x80;
    assert_eq!(
        decode_envelope(&wrong_digest, BODY_ARITY),
        Err(AbiError::BodyDigest)
    );

    let body = &encoded[body_start..body_end];
    let mut virtual_inner_frame = Vec::with_capacity(body.len() + 1);
    virtual_inner_frame.push(ABI_MAGIC);
    virtual_inner_frame.extend_from_slice(body);
    let mut hasher = Sha256::new();
    hasher.update(ABI_DOMAIN.as_bytes());
    hasher.update(sequence::<32>(0x00));
    hasher.update(sequence::<20>(0x10));
    hasher.update([OpTag::ExecuteWave as u8]);
    hasher.update([MessageKind::Request as u8]);
    hasher.update((virtual_inner_frame.len() as u32).to_be_bytes());
    hasher.update(&virtual_inner_frame);
    let nested_digest: [u8; 32] = hasher.finalize().into();
    let mut nested_magic_digest = encoded.clone();
    nested_magic_digest[digest_start..digest_start + 32].copy_from_slice(&nested_digest);
    assert_eq!(
        decode_envelope(&nested_magic_digest, BODY_ARITY),
        Err(AbiError::BodyDigest)
    );
}

#[test]
fn canonical_reencode_rejects_wider_array_and_integer_markers() {
    let encoded = encode_envelope(&sample_envelope()).expect("encode");
    let mut wide_array = Vec::with_capacity(encoded.len() + 2);
    wide_array.push(ABI_MAGIC);
    wide_array.extend_from_slice(&[0xdc, 0x00, 0x0e]);
    wide_array.extend_from_slice(&encoded[2..]);
    assert_eq!(
        decode_envelope(&wide_array, BODY_ARITY),
        Err(AbiError::NonCanonical)
    );

    let limits = AbiLimits::default();
    let parser = Parser::new(&encoded[1..], &limits);
    let abi_position = parser.position() + 2 + ABI_DOMAIN.len() + 1;
    assert_eq!(encoded[abi_position], 1);
    let mut wide_integer = Vec::with_capacity(encoded.len() + 1);
    wide_integer.extend_from_slice(&encoded[..abi_position]);
    wide_integer.extend_from_slice(&[0xcc, 0x01]);
    wide_integer.extend_from_slice(&encoded[abi_position + 1..]);
    assert_eq!(
        decode_envelope(&wide_integer, BODY_ARITY),
        Err(AbiError::NonCanonical)
    );
}

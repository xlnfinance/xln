use crate::msgpack_encode::{
    encode_body_tuple, write_array_header, write_binary, write_integer, write_text, write_tuple,
};
use crate::msgpack_parser::Parser;
use crate::{
    ABI_DOMAIN, ABI_MAGIC, ABI_VERSION, AbiError, AbiLimits, EngineIdentity, Envelope, MessageKind,
    OpTag, ProtocolBinding, compute_body_digest,
};

const OUTER_ARITY: usize = 14;

pub fn encode_envelope(envelope: &Envelope) -> Result<Vec<u8>, AbiError> {
    encode_envelope_with_limits(envelope, &AbiLimits::default())
}

pub fn decode_envelope(input: &[u8], expected_body_arity: usize) -> Result<Envelope, AbiError> {
    decode_envelope_with_limits(input, expected_body_arity, &AbiLimits::default())
}

pub fn decode_envelope_with_limits(
    input: &[u8],
    expected_body_arity: usize,
    limits: &AbiLimits,
) -> Result<Envelope, AbiError> {
    limits.validate()?;
    check_envelope_size(input.len(), limits)?;
    let magic = input.first().copied().ok_or(AbiError::UnexpectedEof)?;
    if magic != ABI_MAGIC {
        return Err(AbiError::InvalidMagic(magic));
    }
    let mut parser = Parser::new(&input[1..], limits);
    check_outer_arity(parser.read_tuple_len()?)?;
    let domain = parser.read_text()?;
    if domain != ABI_DOMAIN {
        return Err(AbiError::Domain);
    }
    let abi_version = parser.read_unsigned()?;
    if abi_version != u64::from(ABI_VERSION) {
        return Err(AbiError::AbiVersion(abi_version));
    }
    let binding = read_protocol_binding(&mut parser)?;
    let identity = read_engine_identity(&mut parser)?;
    let op_tag = OpTag::try_from(parser.read_unsigned()?)?;
    let message_kind = MessageKind::try_from(parser.read_unsigned()?)?;
    let declared_body_length = parser.read_unsigned()?;
    let declared_body_digest = parser.read_fixed_bytes::<32>("bodyDigest")?;
    let body_start = parser.position();
    let body = parser.read_body_tuple(expected_body_arity)?;
    let body_end = parser.position();
    let body_bytes = body_slice(input, body_start, body_end)?;
    check_body_length(body_bytes.len(), declared_body_length, limits)?;
    check_body_digest(
        &binding,
        &identity,
        op_tag,
        message_kind,
        body_bytes,
        &declared_body_digest,
    )?;
    if parser.remaining() != 0 {
        return Err(AbiError::TrailingBytes(parser.remaining()));
    }
    let envelope = Envelope {
        binding,
        identity,
        op_tag,
        message_kind,
        body,
    };
    let canonical = encode_envelope_with_limits(&envelope, limits)?;
    if canonical != input {
        return Err(AbiError::NonCanonical);
    }
    Ok(envelope)
}

fn encode_envelope_with_limits(
    envelope: &Envelope,
    limits: &AbiLimits,
) -> Result<Vec<u8>, AbiError> {
    limits.validate()?;
    let body_bytes = encode_body_tuple(&envelope.body, limits)?;
    let body_digest = compute_body_digest(
        &envelope.binding.protocol_fingerprint,
        &envelope.identity.runtime_id,
        envelope.op_tag,
        envelope.message_kind,
        &body_bytes,
    )?;
    let mut output = Vec::with_capacity(body_bytes.len().saturating_add(160));
    output.push(ABI_MAGIC);
    write_array_header(&mut output, OUTER_ARITY)?;
    write_text(&mut output, ABI_DOMAIN)?;
    write_integer(&mut output, i128::from(ABI_VERSION))?;
    write_integer(&mut output, i128::from(envelope.binding.protocol_version))?;
    write_integer(
        &mut output,
        i128::from(envelope.binding.storage_schema_version),
    )?;
    write_binary(&mut output, &envelope.binding.protocol_fingerprint)?;
    write_identity(&mut output, &envelope.identity)?;
    write_integer(&mut output, i128::from(envelope.op_tag as u8))?;
    write_integer(&mut output, i128::from(envelope.message_kind as u8))?;
    write_integer(&mut output, body_bytes.len() as i128)?;
    write_binary(&mut output, &body_digest)?;
    write_tuple(&mut output, &envelope.body)?;
    check_envelope_size(output.len(), limits)?;
    Ok(output)
}

fn read_protocol_binding(parser: &mut Parser<'_>) -> Result<ProtocolBinding, AbiError> {
    let protocol_version = bounded_u32(parser.read_unsigned()?, "protocolVersion")?;
    let storage_schema_version = bounded_u32(parser.read_unsigned()?, "storageSchemaVersion")?;
    let protocol_fingerprint = parser.read_fixed_bytes::<32>("protocolFingerprint")?;
    Ok(ProtocolBinding {
        protocol_version,
        storage_schema_version,
        protocol_fingerprint,
    })
}

fn read_engine_identity(parser: &mut Parser<'_>) -> Result<EngineIdentity, AbiError> {
    Ok(EngineIdentity {
        engine_generation: parser.read_fixed_bytes::<8>("engineGeneration")?,
        runtime_id: parser.read_fixed_bytes::<20>("runtimeId")?,
        session_id: parser.read_fixed_bytes::<16>("sessionId")?,
        request_id: parser.read_fixed_bytes::<8>("requestId")?,
    })
}

fn write_identity(output: &mut Vec<u8>, identity: &EngineIdentity) -> Result<(), AbiError> {
    write_binary(output, &identity.engine_generation)?;
    write_binary(output, &identity.runtime_id)?;
    write_binary(output, &identity.session_id)?;
    write_binary(output, &identity.request_id)?;
    Ok(())
}

fn check_body_digest(
    binding: &ProtocolBinding,
    identity: &EngineIdentity,
    op_tag: OpTag,
    message_kind: MessageKind,
    body_bytes: &[u8],
    declared: &[u8; 32],
) -> Result<(), AbiError> {
    let actual = compute_body_digest(
        &binding.protocol_fingerprint,
        &identity.runtime_id,
        op_tag,
        message_kind,
        body_bytes,
    )?;
    if actual != *declared {
        return Err(AbiError::BodyDigest);
    }
    Ok(())
}

fn body_slice(input: &[u8], start: usize, end: usize) -> Result<&[u8], AbiError> {
    let absolute_start = start.checked_add(1).ok_or(AbiError::LengthOverflow)?;
    let absolute_end = end.checked_add(1).ok_or(AbiError::LengthOverflow)?;
    input
        .get(absolute_start..absolute_end)
        .ok_or(AbiError::UnexpectedEof)
}

fn check_outer_arity(actual: usize) -> Result<(), AbiError> {
    if actual != OUTER_ARITY {
        return Err(AbiError::OuterArity { actual });
    }
    Ok(())
}

fn check_body_length(actual: usize, declared: u64, limits: &AbiLimits) -> Result<(), AbiError> {
    if actual > limits.max_body_bytes {
        return Err(AbiError::BlobTooLarge {
            actual,
            max: limits.max_body_bytes,
        });
    }
    if u64::try_from(actual).map_err(|_| AbiError::LengthOverflow)? != declared {
        return Err(AbiError::BodyLength { actual, declared });
    }
    Ok(())
}

fn check_envelope_size(actual: usize, limits: &AbiLimits) -> Result<(), AbiError> {
    if actual > limits.max_envelope_bytes {
        return Err(AbiError::EnvelopeTooLarge {
            actual,
            max: limits.max_envelope_bytes,
        });
    }
    Ok(())
}

fn bounded_u32(value: u64, field: &'static str) -> Result<u32, AbiError> {
    u32::try_from(value).map_err(|_| AbiError::IntegerRange { field, value })
}

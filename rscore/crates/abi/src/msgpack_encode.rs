use crate::{AbiError, AbiLimits, AbiValue, BodyTuple};

pub(crate) fn encode_body_tuple(
    tuple: &BodyTuple,
    limits: &AbiLimits,
) -> Result<Vec<u8>, AbiError> {
    let mut budget = ValueBudget::new(limits);
    let encoded_len = encoded_tuple_len(tuple, 0, &mut budget)?;
    if encoded_len > limits.max_body_bytes {
        return Err(AbiError::BlobTooLarge {
            actual: encoded_len,
            max: limits.max_body_bytes,
        });
    }
    let mut output = Vec::with_capacity(encoded_len);
    write_tuple(&mut output, tuple)?;
    Ok(output)
}

struct ValueBudget<'a> {
    limits: &'a AbiLimits,
    total_values: usize,
}

impl<'a> ValueBudget<'a> {
    fn new(limits: &'a AbiLimits) -> Self {
        Self {
            limits,
            total_values: 0,
        }
    }

    fn record(&mut self) -> Result<(), AbiError> {
        self.total_values = self
            .total_values
            .checked_add(1)
            .ok_or(AbiError::LengthOverflow)?;
        if self.total_values > self.limits.max_total_values {
            return Err(AbiError::ValueLimit {
                actual: self.total_values,
                max: self.limits.max_total_values,
            });
        }
        Ok(())
    }
}

fn encoded_tuple_len(
    tuple: &BodyTuple,
    depth: usize,
    budget: &mut ValueBudget<'_>,
) -> Result<usize, AbiError> {
    check_tuple(tuple.len(), depth, budget)?;
    let mut length = array_header_len(tuple.len())?;
    for value in tuple.fields() {
        length = length
            .checked_add(encoded_value_len(value, depth + 1, budget)?)
            .ok_or(AbiError::LengthOverflow)?;
    }
    Ok(length)
}

fn encoded_value_len(
    value: &AbiValue,
    depth: usize,
    budget: &mut ValueBudget<'_>,
) -> Result<usize, AbiError> {
    if depth > budget.limits.max_nesting_depth {
        return Err(AbiError::NestingTooDeep {
            actual: depth,
            max: budget.limits.max_nesting_depth,
        });
    }
    if let AbiValue::Tuple(value) = value {
        return encoded_tuple_len(value, depth, budget);
    }
    budget.record()?;
    match value {
        AbiValue::Nil | AbiValue::Bool(_) => Ok(1),
        AbiValue::Integer(value) => integer_len(*value),
        AbiValue::Bytes(value) => prefixed_len(value.len(), budget.limits.max_blob_bytes, true),
        AbiValue::Text(value) => prefixed_len(value.len(), budget.limits.max_text_bytes, false),
        AbiValue::Tuple(_) => Err(AbiError::LengthOverflow),
    }
}

fn check_tuple(length: usize, depth: usize, budget: &mut ValueBudget<'_>) -> Result<(), AbiError> {
    budget.record()?;
    if length > budget.limits.max_tuple_fields {
        return Err(AbiError::TupleTooLarge {
            actual: length,
            max: budget.limits.max_tuple_fields,
        });
    }
    if depth > budget.limits.max_nesting_depth {
        return Err(AbiError::NestingTooDeep {
            actual: depth,
            max: budget.limits.max_nesting_depth,
        });
    }
    Ok(())
}

fn prefixed_len(length: usize, max: usize, binary: bool) -> Result<usize, AbiError> {
    if length > max {
        return Err(if binary {
            AbiError::BlobTooLarge {
                actual: length,
                max,
            }
        } else {
            AbiError::TextTooLarge {
                actual: length,
                max,
            }
        });
    }
    let prefix = if binary || length > 31 {
        length_prefix_len(length)?
    } else {
        1
    };
    prefix.checked_add(length).ok_or(AbiError::LengthOverflow)
}

fn integer_len(value: i128) -> Result<usize, AbiError> {
    match value {
        -32..=127 => Ok(1),
        128..=255 | -128..=-33 => Ok(2),
        256..=65_535 | -32_768..=-129 => Ok(3),
        65_536..=4_294_967_295 | -2_147_483_648..=-32_769 => Ok(5),
        value if value >= 0 && value <= i128::from(u64::MAX) => Ok(9),
        value if value >= i128::from(i64::MIN) && value < 0 => Ok(9),
        _ => Err(AbiError::BodyIntegerRange(value)),
    }
}

fn array_header_len(length: usize) -> Result<usize, AbiError> {
    match length {
        0..=15 => Ok(1),
        16..=65_535 => Ok(3),
        _ if u32::try_from(length).is_ok() => Ok(5),
        _ => Err(AbiError::LengthOverflow),
    }
}

fn length_prefix_len(length: usize) -> Result<usize, AbiError> {
    match length {
        0..=255 => Ok(2),
        256..=65_535 => Ok(3),
        _ if u32::try_from(length).is_ok() => Ok(5),
        _ => Err(AbiError::LengthOverflow),
    }
}

pub(crate) fn write_tuple(output: &mut Vec<u8>, tuple: &BodyTuple) -> Result<(), AbiError> {
    write_array_header(output, tuple.len())?;
    for value in tuple.fields() {
        write_value(output, value)?;
    }
    Ok(())
}

fn write_value(output: &mut Vec<u8>, value: &AbiValue) -> Result<(), AbiError> {
    match value {
        AbiValue::Nil => output.push(0xc0),
        AbiValue::Bool(false) => output.push(0xc2),
        AbiValue::Bool(true) => output.push(0xc3),
        AbiValue::Integer(value) => write_integer(output, *value)?,
        AbiValue::Bytes(value) => write_binary(output, value)?,
        AbiValue::Text(value) => write_text(output, value)?,
        AbiValue::Tuple(value) => write_tuple(output, value)?,
    }
    Ok(())
}

pub(crate) fn write_integer(output: &mut Vec<u8>, value: i128) -> Result<(), AbiError> {
    match value {
        0..=127 => output.push(value as u8),
        128..=255 => output.extend_from_slice(&[0xcc, value as u8]),
        256..=65_535 => write_tagged(output, 0xcd, &(value as u16).to_be_bytes()),
        65_536..=4_294_967_295 => write_tagged(output, 0xce, &(value as u32).to_be_bytes()),
        value if value >= 0 && value <= i128::from(u64::MAX) => {
            write_tagged(output, 0xcf, &(value as u64).to_be_bytes());
        }
        -32..=-1 => output.push(value as i8 as u8),
        -128..=-33 => write_tagged(output, 0xd0, &(value as i8).to_be_bytes()),
        -32_768..=-129 => write_tagged(output, 0xd1, &(value as i16).to_be_bytes()),
        -2_147_483_648..=-32_769 => write_tagged(output, 0xd2, &(value as i32).to_be_bytes()),
        value if value >= i128::from(i64::MIN) && value < 0 => {
            write_tagged(output, 0xd3, &(value as i64).to_be_bytes());
        }
        _ => return Err(AbiError::BodyIntegerRange(value)),
    }
    Ok(())
}

pub(crate) fn write_binary(output: &mut Vec<u8>, value: &[u8]) -> Result<(), AbiError> {
    write_length_header(output, value.len(), [0xc4, 0xc5, 0xc6])?;
    output.extend_from_slice(value);
    Ok(())
}

pub(crate) fn write_text(output: &mut Vec<u8>, value: &str) -> Result<(), AbiError> {
    if value.len() <= 31 {
        output.push(0xa0 | value.len() as u8);
    } else {
        write_length_header(output, value.len(), [0xd9, 0xda, 0xdb])?;
    }
    output.extend_from_slice(value.as_bytes());
    Ok(())
}

pub(crate) fn write_array_header(output: &mut Vec<u8>, length: usize) -> Result<(), AbiError> {
    match length {
        0..=15 => output.push(0x90 | length as u8),
        16..=65_535 => write_tagged(output, 0xdc, &(length as u16).to_be_bytes()),
        _ => {
            let length = u32::try_from(length).map_err(|_| AbiError::LengthOverflow)?;
            write_tagged(output, 0xdd, &length.to_be_bytes());
        }
    }
    Ok(())
}

fn write_length_header(output: &mut Vec<u8>, length: usize, tags: [u8; 3]) -> Result<(), AbiError> {
    match length {
        0..=255 => write_tagged(output, tags[0], &[length as u8]),
        256..=65_535 => write_tagged(output, tags[1], &(length as u16).to_be_bytes()),
        _ => {
            let length = u32::try_from(length).map_err(|_| AbiError::LengthOverflow)?;
            write_tagged(output, tags[2], &length.to_be_bytes());
        }
    }
    Ok(())
}

fn write_tagged(output: &mut Vec<u8>, tag: u8, bytes: &[u8]) {
    output.push(tag);
    output.extend_from_slice(bytes);
}

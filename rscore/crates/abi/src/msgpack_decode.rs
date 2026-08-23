use crate::msgpack_parser::Parser;
use crate::{AbiError, AbiValue, BodyTuple};

impl Parser<'_> {
    pub(crate) fn read_tuple_len(&mut self) -> Result<usize, AbiError> {
        let marker = self.read_byte()?;
        let length = self.array_length(marker)?;
        self.check_tuple_length(length)?;
        Ok(length)
    }

    pub(crate) fn read_text(&mut self) -> Result<String, AbiError> {
        let marker = self.read_byte()?;
        let length = self.string_length(marker)?;
        if length > self.limits.max_text_bytes {
            return Err(AbiError::TextTooLarge {
                actual: length,
                max: self.limits.max_text_bytes,
            });
        }
        let bytes = self.read_exact(length)?;
        String::from_utf8(bytes.to_vec()).map_err(|_| AbiError::InvalidUtf8)
    }

    pub(crate) fn read_fixed_bytes<const N: usize>(
        &mut self,
        field: &'static str,
    ) -> Result<[u8; N], AbiError> {
        let marker = self.read_byte()?;
        let length = self.binary_length(marker)?;
        if length != N {
            return Err(AbiError::FixedBytes {
                field,
                actual: length,
                expected: N,
            });
        }
        let mut value = [0_u8; N];
        value.copy_from_slice(self.read_exact(N)?);
        Ok(value)
    }

    pub(crate) fn read_unsigned(&mut self) -> Result<u64, AbiError> {
        let marker = self.read_byte()?;
        match marker {
            0x00..=0x7f => Ok(u64::from(marker)),
            0xcc => Ok(u64::from(self.read_byte()?)),
            0xcd => Ok(u64::from(self.read_u16()?)),
            0xce => Ok(u64::from(self.read_u32()?)),
            0xcf => self.read_u64(),
            0xd0 => non_negative_i64(i64::from(self.read_i8()?), marker),
            0xd1 => non_negative_i64(i64::from(self.read_i16()?), marker),
            0xd2 => non_negative_i64(i64::from(self.read_i32()?), marker),
            0xd3 => non_negative_i64(self.read_i64()?, marker),
            _ => Err(AbiError::UnexpectedMarker {
                expected: "UNSIGNED_INTEGER",
                actual: marker,
            }),
        }
    }

    pub(crate) fn read_body_tuple(&mut self, expected_arity: usize) -> Result<BodyTuple, AbiError> {
        let actual = self.read_tuple_len()?;
        if actual != expected_arity {
            return Err(AbiError::BodyArity {
                actual,
                expected: expected_arity,
            });
        }
        self.record_value()?;
        let mut values = Vec::with_capacity(actual);
        for _ in 0..actual {
            values.push(self.read_value(1)?);
        }
        Ok(BodyTuple::decoded(values))
    }

    fn read_value(&mut self, depth: usize) -> Result<AbiValue, AbiError> {
        self.check_depth(depth)?;
        self.record_value()?;
        let marker = self.read_byte()?;
        match marker {
            0xc0 => Ok(AbiValue::Nil),
            0xc2 => Ok(AbiValue::Bool(false)),
            0xc3 => Ok(AbiValue::Bool(true)),
            0x00..=0x7f => Ok(AbiValue::Integer(i128::from(marker))),
            0xe0..=0xff => Ok(AbiValue::Integer(i128::from(marker as i8))),
            0xcc..=0xd3 => self.read_integer_value(marker),
            0xa0..=0xbf | 0xd9..=0xdb => self.read_text_value(marker),
            0xc4..=0xc6 => self.read_bytes_value(marker),
            0x90..=0x9f | 0xdc..=0xdd => self.read_nested_tuple(marker, depth),
            _ => Err(AbiError::UnsupportedMarker(marker)),
        }
    }

    fn read_integer_value(&mut self, marker: u8) -> Result<AbiValue, AbiError> {
        let value = match marker {
            0xcc => i128::from(self.read_byte()?),
            0xcd => i128::from(self.read_u16()?),
            0xce => i128::from(self.read_u32()?),
            0xcf => i128::from(self.read_u64()?),
            0xd0 => i128::from(self.read_i8()?),
            0xd1 => i128::from(self.read_i16()?),
            0xd2 => i128::from(self.read_i32()?),
            0xd3 => i128::from(self.read_i64()?),
            _ => return Err(AbiError::UnsupportedMarker(marker)),
        };
        Ok(AbiValue::Integer(value))
    }

    fn read_text_value(&mut self, marker: u8) -> Result<AbiValue, AbiError> {
        let length = self.string_length(marker)?;
        if length > self.limits.max_text_bytes {
            return Err(AbiError::TextTooLarge {
                actual: length,
                max: self.limits.max_text_bytes,
            });
        }
        let bytes = self.read_exact(length)?;
        let value = String::from_utf8(bytes.to_vec()).map_err(|_| AbiError::InvalidUtf8)?;
        Ok(AbiValue::Text(value))
    }

    fn read_bytes_value(&mut self, marker: u8) -> Result<AbiValue, AbiError> {
        let length = self.binary_length(marker)?;
        self.check_blob_length(length)?;
        Ok(AbiValue::Bytes(self.read_exact(length)?.to_vec()))
    }

    fn read_nested_tuple(&mut self, marker: u8, depth: usize) -> Result<AbiValue, AbiError> {
        let length = self.array_length(marker)?;
        self.check_tuple_length(length)?;
        let mut values = Vec::with_capacity(length);
        for _ in 0..length {
            values.push(self.read_value(depth + 1)?);
        }
        Ok(AbiValue::Tuple(BodyTuple::decoded(values)))
    }

    fn record_value(&mut self) -> Result<(), AbiError> {
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

    fn check_tuple_length(&self, actual: usize) -> Result<(), AbiError> {
        if actual > self.limits.max_tuple_fields {
            return Err(AbiError::TupleTooLarge {
                actual,
                max: self.limits.max_tuple_fields,
            });
        }
        Ok(())
    }

    fn check_blob_length(&self, actual: usize) -> Result<(), AbiError> {
        if actual > self.limits.max_blob_bytes {
            return Err(AbiError::BlobTooLarge {
                actual,
                max: self.limits.max_blob_bytes,
            });
        }
        Ok(())
    }

    fn check_depth(&self, actual: usize) -> Result<(), AbiError> {
        if actual > self.limits.max_nesting_depth {
            return Err(AbiError::NestingTooDeep {
                actual,
                max: self.limits.max_nesting_depth,
            });
        }
        Ok(())
    }
}

fn non_negative_i64(value: i64, marker: u8) -> Result<u64, AbiError> {
    u64::try_from(value).map_err(|_| AbiError::UnexpectedMarker {
        expected: "UNSIGNED_INTEGER",
        actual: marker,
    })
}

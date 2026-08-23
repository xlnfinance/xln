use crate::{AbiError, AbiLimits};

pub(crate) struct Parser<'a> {
    pub(super) bytes: &'a [u8],
    pub(super) position: usize,
    pub(super) limits: &'a AbiLimits,
    pub(super) total_values: usize,
}

impl<'a> Parser<'a> {
    pub(crate) fn new(bytes: &'a [u8], limits: &'a AbiLimits) -> Self {
        Self {
            bytes,
            position: 0,
            limits,
            total_values: 0,
        }
    }

    pub(crate) fn position(&self) -> usize {
        self.position
    }

    pub(crate) fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.position)
    }

    pub(super) fn string_length(&mut self, marker: u8) -> Result<usize, AbiError> {
        match marker {
            0xa0..=0xbf => Ok(usize::from(marker & 0x1f)),
            0xd9 => Ok(usize::from(self.read_byte()?)),
            0xda => Ok(usize::from(self.read_u16()?)),
            0xdb => usize::try_from(self.read_u32()?).map_err(|_| AbiError::LengthOverflow),
            _ => Err(AbiError::UnexpectedMarker {
                expected: "TEXT",
                actual: marker,
            }),
        }
    }

    pub(super) fn binary_length(&mut self, marker: u8) -> Result<usize, AbiError> {
        match marker {
            0xc4 => Ok(usize::from(self.read_byte()?)),
            0xc5 => Ok(usize::from(self.read_u16()?)),
            0xc6 => usize::try_from(self.read_u32()?).map_err(|_| AbiError::LengthOverflow),
            _ => Err(AbiError::UnexpectedMarker {
                expected: "BINARY",
                actual: marker,
            }),
        }
    }

    pub(super) fn array_length(&mut self, marker: u8) -> Result<usize, AbiError> {
        match marker {
            0x90..=0x9f => Ok(usize::from(marker & 0x0f)),
            0xdc => Ok(usize::from(self.read_u16()?)),
            0xdd => usize::try_from(self.read_u32()?).map_err(|_| AbiError::LengthOverflow),
            _ => Err(AbiError::UnexpectedMarker {
                expected: "TUPLE",
                actual: marker,
            }),
        }
    }

    pub(super) fn read_exact(&mut self, length: usize) -> Result<&'a [u8], AbiError> {
        let end = self
            .position
            .checked_add(length)
            .ok_or(AbiError::LengthOverflow)?;
        let bytes = self
            .bytes
            .get(self.position..end)
            .ok_or(AbiError::UnexpectedEof)?;
        self.position = end;
        Ok(bytes)
    }

    pub(super) fn read_byte(&mut self) -> Result<u8, AbiError> {
        let byte = self
            .bytes
            .get(self.position)
            .copied()
            .ok_or(AbiError::UnexpectedEof)?;
        self.position += 1;
        Ok(byte)
    }

    pub(super) fn read_u16(&mut self) -> Result<u16, AbiError> {
        let bytes = self.read_exact(2)?;
        Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
    }

    pub(super) fn read_u32(&mut self) -> Result<u32, AbiError> {
        let bytes = self.read_exact(4)?;
        Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    pub(super) fn read_u64(&mut self) -> Result<u64, AbiError> {
        let bytes = self.read_exact(8)?;
        Ok(u64::from_be_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        ]))
    }

    pub(super) fn read_i8(&mut self) -> Result<i8, AbiError> {
        Ok(i8::from_be_bytes([self.read_byte()?]))
    }

    pub(super) fn read_i16(&mut self) -> Result<i16, AbiError> {
        let bytes = self.read_exact(2)?;
        Ok(i16::from_be_bytes([bytes[0], bytes[1]]))
    }

    pub(super) fn read_i32(&mut self) -> Result<i32, AbiError> {
        let bytes = self.read_exact(4)?;
        Ok(i32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    pub(super) fn read_i64(&mut self) -> Result<i64, AbiError> {
        let bytes = self.read_exact(8)?;
        Ok(i64::from_be_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        ]))
    }
}

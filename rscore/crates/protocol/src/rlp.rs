use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RlpError {
    #[error("RLP payload is too large")]
    PayloadTooLarge,
}

fn length_bytes(mut length: usize) -> Result<Vec<u8>, RlpError> {
    if length == 0 {
        return Ok(vec![0]);
    }
    let mut reversed = Vec::with_capacity(std::mem::size_of::<usize>());
    while length > 0 {
        reversed.push((length & 0xff) as u8);
        length >>= 8;
    }
    reversed.reverse();
    Ok(reversed)
}

pub fn encode_payload(payload: &[u8]) -> Result<Vec<u8>, RlpError> {
    if payload.len() == 1 && payload[0] < 0x80 {
        return Ok(payload.to_vec());
    }
    encode_container(payload, 0x80, 0xb7)
}

pub fn encode_list(children: &[Vec<u8>]) -> Result<Vec<u8>, RlpError> {
    let payload_length = children
        .iter()
        .try_fold(0usize, |total, child| total.checked_add(child.len()))
        .ok_or(RlpError::PayloadTooLarge)?;
    let mut payload = Vec::with_capacity(payload_length);
    for child in children {
        payload.extend_from_slice(child);
    }
    encode_container(&payload, 0xc0, 0xf7)
}

fn encode_container(payload: &[u8], short_base: u8, long_base: u8) -> Result<Vec<u8>, RlpError> {
    if payload.len() <= 55 {
        let mut encoded = Vec::with_capacity(payload.len() + 1);
        encoded.push(short_base + payload.len() as u8);
        encoded.extend_from_slice(payload);
        return Ok(encoded);
    }
    let encoded_length = length_bytes(payload.len())?;
    let length_of_length =
        u8::try_from(encoded_length.len()).map_err(|_| RlpError::PayloadTooLarge)?;
    let mut encoded = Vec::with_capacity(payload.len() + encoded_length.len() + 1);
    encoded.push(long_base + length_of_length);
    encoded.extend_from_slice(&encoded_length);
    encoded.extend_from_slice(payload);
    Ok(encoded)
}

/// Single-buffer RLP writer.
///
/// The allocating encoders above build a `Vec` per node and copy every payload
/// into its parent, which makes a nested value quadratic in depth and costs one
/// malloc per scalar. This writer appends children straight into one buffer and
/// splices the list header in afterwards — byte-identical output, one growing
/// allocation for a whole value.
#[derive(Debug, Default)]
pub struct RlpWriter {
    bytes: Vec<u8>,
}

impl RlpWriter {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(capacity),
        }
    }

    pub fn clear(&mut self) {
        self.bytes.clear();
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.bytes
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }

    /// Start a list; pass the returned mark to `close_list` once its children
    /// have been written.
    pub fn open_list(&self) -> usize {
        self.bytes.len()
    }

    pub fn close_list(&mut self, mark: usize) -> Result<(), RlpError> {
        let payload_length = self.bytes.len() - mark;
        self.splice_header(mark, payload_length, 0xc0, 0xf7)
    }

    pub fn push_payload(&mut self, payload: &[u8]) -> Result<(), RlpError> {
        if payload.len() == 1 && payload[0] < 0x80 {
            self.bytes.push(payload[0]);
            return Ok(());
        }
        let mark = self.bytes.len();
        self.bytes.extend_from_slice(payload);
        self.splice_header(mark, payload.len(), 0x80, 0xb7)
    }

    /// Append an already-encoded node verbatim (a cached entry, for instance).
    pub fn push_encoded(&mut self, encoded: &[u8]) {
        self.bytes.extend_from_slice(encoded);
    }

    fn splice_header(
        &mut self,
        mark: usize,
        payload_length: usize,
        short_base: u8,
        long_base: u8,
    ) -> Result<(), RlpError> {
        if payload_length <= 55 {
            self.bytes.insert(mark, short_base + payload_length as u8);
            return Ok(());
        }
        let length = length_bytes(payload_length)?;
        let length_of_length = u8::try_from(length.len()).map_err(|_| RlpError::PayloadTooLarge)?;
        let header_length = 1 + length.len();
        self.bytes
            .resize(self.bytes.len() + header_length, 0);
        self.bytes
            .copy_within(mark..mark + payload_length, mark + header_length);
        self.bytes[mark] = long_base + length_of_length;
        self.bytes[mark + 1..mark + header_length].copy_from_slice(&length);
        Ok(())
    }
}

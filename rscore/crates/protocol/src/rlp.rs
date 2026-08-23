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

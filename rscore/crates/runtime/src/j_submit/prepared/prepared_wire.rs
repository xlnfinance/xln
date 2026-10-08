//! Decode and authenticate exact durable wire before comparing its sealed intent.
//! Native TAPOS is signed, but has no embedded EVM chain id: the caller must
//! select native mode from the committed, chain-attested Jurisdiction policy.
use super::{Address, Eip1559Transaction, JSubmitError, Word};
use ethabi::ethereum_types::U256;
use rlp::Rlp;
use sha2::{Digest, Sha256};
use sha3::Keccak256;
use xln_rscore_crypto::recover_signer_address;
use xln_rscore_protocol::RlpWriter;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct PreparedTransaction {
    pub hash: Word,
    pub nonce: u64,
    pub signer: Address,
    pub to: Address,
    pub value: U256,
    pub data: Vec<u8>,
    pub chain_id: Option<u64>,
    pub expires_at: Option<u64>,
}
fn bad() -> JSubmitError {
    JSubmitError::Transaction("prepared-wire")
}
fn recover(hash: &Word, signature: &[u8; 65]) -> Result<Address, JSubmitError> {
    // Match ethers' low-s policy; accepting the alternate signature would make
    // durable acceptance differ between engines even though recovery succeeds.
    const HALF_ORDER: [u8; 32] = [
        0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4, 0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b,
        0x20, 0xa0,
    ];
    if signature[32..64] > HALF_ORDER[..] {
        return Err(bad());
    }
    recover_signer_address(hash, signature).ok_or_else(bad)
}

pub(crate) fn decode_prepared_transaction(
    raw: &str,
    native_tron: bool,
) -> Result<PreparedTransaction, JSubmitError> {
    let hex = raw.strip_prefix("0x").ok_or_else(bad)?;
    if hex.is_empty() || hex.len() > 524_288 {
        return Err(bad());
    }
    let bytes = hex::decode(hex).map_err(|_| bad())?;
    if native_tron {
        decode_tron(&bytes)
    } else {
        decode_evm(&bytes)
    }
}
fn integer(bytes: &[u8]) -> Result<U256, JSubmitError> {
    if bytes.len() > 32 || bytes.first() == Some(&0) {
        return Err(bad());
    }
    Ok(U256::from_big_endian(bytes))
}
fn u64_integer(bytes: &[u8]) -> Result<u64, JSubmitError> {
    let value = integer(bytes)?;
    if value > U256::from(u64::MAX) {
        return Err(bad());
    }
    Ok(value.low_u64())
}
fn decode_evm(raw: &[u8]) -> Result<PreparedTransaction, JSubmitError> {
    if raw.first() != Some(&2) {
        return Err(bad());
    }
    let rlp = Rlp::new(&raw[1..]);
    if rlp.payload_info().map_err(|_| bad())?.total() != raw.len() - 1
        || rlp.item_count().map_err(|_| bad())? != 12
    {
        return Err(bad());
    }
    let mut fields = Vec::new();
    let mut canonical = RlpWriter::with_capacity(raw.len());
    let list = canonical.open_list();
    for index in 0..12 {
        let field = rlp.at(index).map_err(|_| bad())?;
        if index == 8 {
            // The one canonical submitter emits an empty access list.
            if !field.is_list() || field.item_count().map_err(|_| bad())? != 0 {
                return Err(bad());
            }
            let empty = canonical.open_list();
            canonical.close_list(empty).map_err(|_| bad())?;
            fields.push(Vec::new());
        } else {
            if !field.is_data() {
                return Err(bad());
            }
            let data = field.data().map_err(|_| bad())?;
            canonical.push_payload(data).map_err(|_| bad())?;
            fields.push(data.to_vec());
        }
    }
    canonical.close_list(list).map_err(|_| bad())?;
    if canonical.as_slice() != &raw[1..] {
        return Err(bad());
    }
    let tx = Eip1559Transaction {
        chain_id: u64_integer(&fields[0])?,
        nonce: u64_integer(&fields[1])?,
        max_priority_fee_per_gas: integer(&fields[2])?,
        max_fee_per_gas: integer(&fields[3])?,
        gas_limit: integer(&fields[4])?,
        to: fields[5].as_slice().try_into().map_err(|_| bad())?,
        value: integer(&fields[6])?,
        data: fields[7].clone(),
    };
    let parity = u64_integer(&fields[9])?;
    if parity > 1 {
        return Err(bad());
    }
    let mut signature = [0; 65];
    integer(&fields[10])?.to_big_endian(&mut signature[..32]);
    integer(&fields[11])?.to_big_endian(&mut signature[32..64]);
    signature[64] = parity as u8;
    let signer = recover(&super::transaction::signing_hash(&tx)?, &signature)?;
    Ok(PreparedTransaction {
        hash: Keccak256::digest(raw).into(),
        nonce: tx.nonce,
        signer,
        to: tx.to,
        value: tx.value,
        data: tx.data,
        chain_id: Some(tx.chain_id),
        expires_at: None,
    })
}

#[derive(Clone, Copy)]
enum ProtoField<'a> {
    Number(u64),
    Bytes(&'a [u8]),
}
fn varint(input: &mut &[u8]) -> Result<u64, JSubmitError> {
    let mut value = 0u64;
    for shift in 0..10 {
        let (&byte, rest) = input.split_first().ok_or_else(bad)?;
        *input = rest;
        if shift == 9 && byte > 1 {
            return Err(bad());
        }
        value |= u64::from(byte & 127) << (shift * 7);
        if byte < 128 {
            if shift > 0 && byte == 0 {
                return Err(bad());
            }
            return Ok(value);
        }
    }
    Err(bad())
}
fn proto<'a>(
    mut input: &'a [u8],
    allowed: &[u64],
) -> Result<Vec<(u64, ProtoField<'a>)>, JSubmitError> {
    let mut fields = Vec::new();
    let mut previous = 0;
    while !input.is_empty() {
        let key = varint(&mut input)?;
        let field = key >> 3;
        if field <= previous || !allowed.contains(&field) {
            return Err(bad());
        }
        previous = field;
        let value = match key & 7 {
            0 => ProtoField::Number(varint(&mut input)?),
            2 => {
                let length = usize::try_from(varint(&mut input)?).map_err(|_| bad())?;
                if length > input.len() {
                    return Err(bad());
                }
                let (bytes, rest) = input.split_at(length);
                input = rest;
                ProtoField::Bytes(bytes)
            }
            _ => return Err(bad()),
        };
        fields.push((field, value));
    }
    Ok(fields)
}
fn bytes<'a>(fields: &[(u64, ProtoField<'a>)], key: u64) -> Result<&'a [u8], JSubmitError> {
    match fields
        .iter()
        .find(|(field, _)| *field == key)
        .map(|(_, value)| value)
    {
        Some(ProtoField::Bytes(value)) => Ok(value),
        _ => Err(bad()),
    }
}
fn number(fields: &[(u64, ProtoField<'_>)], key: u64) -> Result<u64, JSubmitError> {
    match fields
        .iter()
        .find(|(field, _)| *field == key)
        .map(|(_, value)| value)
    {
        Some(ProtoField::Number(value)) if *value <= 9_007_199_254_740_991 => Ok(*value),
        _ => Err(bad()),
    }
}
fn tron_address(bytes: &[u8]) -> Result<Address, JSubmitError> {
    if bytes.len() != 21 || bytes[0] != 0x41 {
        return Err(bad());
    }
    bytes[1..].try_into().map_err(|_| bad())
}
fn decode_tron(wire: &[u8]) -> Result<PreparedTransaction, JSubmitError> {
    let tx = proto(wire, &[1, 2])?;
    let raw = bytes(&tx, 1)?;
    let signature: [u8; 65] = bytes(&tx, 2)?.try_into().map_err(|_| bad())?;
    if !matches!(signature[64], 27 | 28) {
        return Err(bad());
    }
    let fields = proto(raw, &[1, 4, 8, 11, 14, 18])?;
    if bytes(&fields, 1)?.len() != 2 || bytes(&fields, 4)?.len() != 8 {
        return Err(bad());
    }
    let expiration = number(&fields, 8)?;
    let timestamp = number(&fields, 14)?;
    let fee = number(&fields, 18)?;
    if timestamp == 0 || expiration != timestamp + 60_000 || fee == 0 || fee > 15_000_000_000 {
        return Err(bad());
    }
    let contract = proto(bytes(&fields, 11)?, &[1, 2])?;
    if number(&contract, 1)? != 31 {
        return Err(bad());
    }
    let parameter = proto(bytes(&contract, 2)?, &[1, 2])?;
    if bytes(&parameter, 1)? != b"type.googleapis.com/protocol.TriggerSmartContract" {
        return Err(bad());
    }
    let call = proto(bytes(&parameter, 2)?, &[1, 2, 3, 4])?;
    let signer = tron_address(bytes(&call, 1)?)?;
    let hash = Sha256::digest(raw).into();
    if recover(&hash, &signature)? != signer {
        return Err(bad());
    }
    let value = if call.iter().any(|(key, _)| *key == 3) {
        number(&call, 3)?
    } else {
        0
    };
    Ok(PreparedTransaction {
        hash,
        nonce: 0,
        signer,
        to: tron_address(bytes(&call, 2)?)?,
        value: value.into(),
        data: bytes(&call, 4)?.to_vec(),
        chain_id: None,
        expires_at: Some(expiration),
    })
}

#[cfg(test)]
#[path = "prepared_wire_tests.rs"]
mod tests;

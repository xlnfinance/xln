use ethabi::ethereum_types::U256;
use sha3::{Digest, Keccak256};
use xln_rscore_crypto::sign_digest;
use xln_rscore_protocol::RlpWriter;

use super::{Address, JSubmitError, Word};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Eip1559Transaction {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: U256,
    pub max_fee_per_gas: U256,
    pub gas_limit: U256,
    pub to: Address,
    pub value: U256,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedEip1559Transaction {
    pub raw: Vec<u8>,
    pub hash: Word,
    pub nonce: u64,
}

fn u256_bytes(value: U256) -> Vec<u8> {
    if value.is_zero() {
        return Vec::new();
    }
    let mut full = [0_u8; 32];
    value.to_big_endian(&mut full);
    full[full.iter().position(|byte| *byte != 0).unwrap_or(32)..].to_vec()
}

fn push_uint(writer: &mut RlpWriter, value: U256) -> Result<(), JSubmitError> {
    writer
        .push_payload(&u256_bytes(value))
        .map_err(|_| JSubmitError::Transaction("rlp"))
}

fn unsigned_payload(tx: &Eip1559Transaction) -> Result<Vec<u8>, JSubmitError> {
    if tx.chain_id == 0 {
        return Err(JSubmitError::Transaction("chain-id"));
    }
    let mut writer = RlpWriter::with_capacity(tx.data.len() + 256);
    let list = writer.open_list();
    push_uint(&mut writer, U256::from(tx.chain_id))?;
    push_uint(&mut writer, U256::from(tx.nonce))?;
    push_uint(&mut writer, tx.max_priority_fee_per_gas)?;
    push_uint(&mut writer, tx.max_fee_per_gas)?;
    push_uint(&mut writer, tx.gas_limit)?;
    writer
        .push_payload(&tx.to)
        .map_err(|_| JSubmitError::Transaction("rlp"))?;
    push_uint(&mut writer, tx.value)?;
    writer
        .push_payload(&tx.data)
        .map_err(|_| JSubmitError::Transaction("rlp"))?;
    let access_list = writer.open_list();
    writer
        .close_list(access_list)
        .map_err(|_| JSubmitError::Transaction("rlp"))?;
    writer
        .close_list(list)
        .map_err(|_| JSubmitError::Transaction("rlp"))?;
    Ok(writer.into_bytes())
}

pub(crate) fn signing_hash(tx: &Eip1559Transaction) -> Result<Word, JSubmitError> {
    let payload = unsigned_payload(tx)?;
    let mut hash = Keccak256::new();
    hash.update([2]);
    hash.update(payload);
    Ok(hash.finalize().into())
}

impl Eip1559Transaction {
    pub fn sign(&self, private_key: &Word) -> Result<SignedEip1559Transaction, JSubmitError> {
        let digest = signing_hash(self)?;
        let signature =
            sign_digest(private_key, &digest).ok_or(JSubmitError::Transaction("sign"))?;
        let mut writer = RlpWriter::with_capacity(self.data.len() + 384);
        let list = writer.open_list();
        push_uint(&mut writer, U256::from(self.chain_id))?;
        push_uint(&mut writer, U256::from(self.nonce))?;
        push_uint(&mut writer, self.max_priority_fee_per_gas)?;
        push_uint(&mut writer, self.max_fee_per_gas)?;
        push_uint(&mut writer, self.gas_limit)?;
        writer
            .push_payload(&self.to)
            .map_err(|_| JSubmitError::Transaction("rlp"))?;
        push_uint(&mut writer, self.value)?;
        writer
            .push_payload(&self.data)
            .map_err(|_| JSubmitError::Transaction("rlp"))?;
        let access_list = writer.open_list();
        writer
            .close_list(access_list)
            .map_err(|_| JSubmitError::Transaction("rlp"))?;
        push_uint(&mut writer, U256::from(signature[64]))?;
        push_uint(&mut writer, U256::from_big_endian(&signature[..32]))?;
        push_uint(&mut writer, U256::from_big_endian(&signature[32..64]))?;
        writer
            .close_list(list)
            .map_err(|_| JSubmitError::Transaction("rlp"))?;
        let mut raw = Vec::with_capacity(writer.as_slice().len() + 1);
        raw.push(2);
        raw.extend_from_slice(writer.as_slice());
        let hash = Keccak256::digest(&raw).into();
        Ok(SignedEip1559Transaction {
            raw,
            hash,
            nonce: self.nonce,
        })
    }
}

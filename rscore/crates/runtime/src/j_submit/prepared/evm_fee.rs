//! Same signer and nonce permits at most one financial execution; only fee caps change.
use super::{JSubmitError, prepared_wire::decode_prepared_transaction};
use ethabi::ethereum_types::U256;

pub(crate) fn bump(value: U256, bps: u64) -> Result<U256, JSubmitError> {
    if !(1000..=100000).contains(&bps) {
        return Err(JSubmitError::Transaction("replacement-bump"));
    }
    let rounded = value
        .checked_mul((10000 + bps).into())
        .and_then(|v| v.checked_add(9999.into()))
        .ok_or(JSubmitError::Transaction("replacement-fee-overflow"))?
        / U256::from(10000);
    Ok(rounded.max(
        value
            .checked_add(U256::one())
            .ok_or(JSubmitError::Transaction("replacement-fee-overflow"))?,
    ))
}
pub(crate) fn validate(old_raw: &str, raw: &str, hash: &str, bps: u64) -> Result<(), JSubmitError> {
    let old = decode_prepared_transaction(old_raw, false)?;
    let next = decode_prepared_transaction(raw, false)?;
    if format!("0x{}", hex::encode(old.hash)) != hash
        || old.hash == next.hash
        || old.signer != next.signer
        || old.nonce != next.nonce
        || old.chain_id != next.chain_id
        || old.to != next.to
        || old.value != next.value
        || old.data != next.data
        || old.gas_limit != next.gas_limit
    {
        return Err(JSubmitError::Transaction("replacement-intent"));
    }
    if next.max_fee < bump(old.max_fee, bps)?
        || next.priority_fee < bump(old.priority_fee, bps)?
        || next.max_fee < next.priority_fee
    {
        return Err(JSubmitError::Transaction("replacement-underpriced"));
    }
    Ok(())
}
#[cfg(test)]
use super::Eip1559Transaction;
#[cfg(test)]
#[path = "evm_fee_tests.rs"]
mod tests;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvmFeeLimits {
    pub max_fee_per_gas: U256,
    pub max_priority_fee_per_gas: U256,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvmFeeAuthorization {
    pub limits: EvmFeeLimits,
    pub signature: String,
}
impl EvmFeeLimits {
    pub(crate) fn decode(value: &serde_json::Value) -> Result<Self, JSubmitError> {
        let fail = || JSubmitError::Transaction("evm-fee-limits");
        let object = value
            .as_object()
            .filter(|o| o.len() == 2)
            .ok_or_else(fail)?;
        let read = |key| {
            let text = object
                .get(key)
                .and_then(serde_json::Value::as_str)
                .ok_or_else(fail)?;
            let parsed = U256::from_dec_str(text).map_err(|_| fail())?;
            if text != parsed.to_string() {
                return Err(fail());
            }
            Ok(parsed)
        };
        let limits = Self {
            max_fee_per_gas: read("maxFeePerGasWei")?,
            max_priority_fee_per_gas: read("maxPriorityFeePerGasWei")?,
        };
        if limits.max_priority_fee_per_gas > limits.max_fee_per_gas {
            return Err(fail());
        }
        Ok(limits)
    }
    pub(crate) fn encode(&self) -> serde_json::Value {
        serde_json::json!({"maxFeePerGasWei":self.max_fee_per_gas.to_string(), "maxPriorityFeePerGasWei":self.max_priority_fee_per_gas.to_string()})
    }
    pub(crate) fn from_wire(raw: &str) -> Result<Self, JSubmitError> {
        let wire = decode_prepared_transaction(raw, false)?;
        Ok(Self {
            max_fee_per_gas: wire.max_fee,
            max_priority_fee_per_gas: wire.priority_fee,
        })
    }
    pub(crate) fn allows(&self, max: U256, priority: U256) -> bool {
        max <= self.max_fee_per_gas && priority <= self.max_priority_fee_per_gas
    }
}
impl EvmFeeAuthorization {
    pub(crate) fn sign(
        jurisdiction: &str,
        id: &str,
        raw: &str,
        ceiling: U256,
        key: &[u8; 32],
    ) -> Result<Self, JSubmitError> {
        let mut auth = Self {
            limits: EvmFeeLimits {
                max_fee_per_gas: ceiling,
                max_priority_fee_per_gas: ceiling,
            },
            signature: String::new(),
        };
        let signature = xln_rscore_crypto::sign_digest(key, &auth.digest(jurisdiction, id, raw)?)
            .ok_or(JSubmitError::Transaction("evm-fee-signature"))?;
        auth.signature = format!("0x{}", hex::encode(signature));
        auth.validate(jurisdiction, id, raw)?;
        Ok(auth)
    }

    pub(crate) fn decode(value: &serde_json::Value) -> Result<Self, JSubmitError> {
        let fail = || JSubmitError::Transaction("evm-fee-authorization");
        let mut fields = value
            .as_object()
            .filter(|o| o.len() == 3)
            .cloned()
            .ok_or_else(fail)?;
        let signature = fields
            .remove("signature")
            .and_then(|v| v.as_str().map(str::to_owned))
            .ok_or_else(fail)?;
        if signature.len() != 132
            || !signature.starts_with("0x")
            || !signature[2..]
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err(fail());
        }
        Ok(Self {
            limits: EvmFeeLimits::decode(&serde_json::Value::Object(fields))?,
            signature,
        })
    }
    pub(crate) fn encode(&self) -> serde_json::Value {
        let mut value = self.limits.encode();
        value["signature"] = self.signature.clone().into();
        value
    }
    pub(crate) fn digest(
        &self,
        jurisdiction: &str,
        id: &str,
        raw: &str,
    ) -> Result<[u8; 32], JSubmitError> {
        use sha3::{Digest, Keccak256};
        let wire = decode_prepared_transaction(raw, false)?;
        let encoded = ethabi::encode(&[
            ethabi::Token::String("xln:evm-fee-authorization".into()),
            ethabi::Token::String(jurisdiction.into()),
            ethabi::Token::String(id.into()),
            ethabi::Token::FixedBytes(wire.hash.to_vec()),
            ethabi::Token::Uint(self.limits.max_fee_per_gas),
            ethabi::Token::Uint(self.limits.max_priority_fee_per_gas),
        ]);
        let message = Keccak256::digest(encoded);
        let mut hash = Keccak256::new();
        hash.update(b"\x19Ethereum Signed Message:\n32");
        hash.update(message);
        Ok(hash.finalize().into())
    }
    pub(crate) fn validate(
        &self,
        jurisdiction: &str,
        id: &str,
        raw: &str,
    ) -> Result<EvmFeeLimits, JSubmitError> {
        let wire = decode_prepared_transaction(raw, false)?;
        let signature: [u8; 65] = hex::decode(
            self.signature
                .strip_prefix("0x")
                .ok_or(JSubmitError::Transaction("evm-fee-signature"))?,
        )
        .map_err(|_| JSubmitError::Transaction("evm-fee-signature"))?
        .try_into()
        .map_err(|_| JSubmitError::Transaction("evm-fee-signature"))?;
        // Match ethers.Signature.s: high-bit S is rejected, never normalized.
        if signature[32] & 0x80 != 0 {
            return Err(JSubmitError::Transaction("evm-fee-signature"));
        }
        // Payer signature binds this exact attempt, chain, nonce and financial call.
        // Entity bumps and underpriced feedback cannot authorize another ceiling.
        if xln_rscore_crypto::recover_signer_address(
            &self.digest(jurisdiction, id, raw)?,
            &signature,
        ) != Some(wire.signer)
            || !self.limits.allows(wire.max_fee, wire.priority_fee)
        {
            return Err(JSubmitError::Transaction("evm-fee-authorization-payer"));
        }
        Ok(self.limits.clone())
    }
}

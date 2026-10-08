//! Native numbered-registration replacement after RPC-attested finalized absence.
//! The attestation is local WAL input, not a cryptographic proof of non-inclusion.
use crate::j_submit::native_replacement::{exact, raw_hex, text};
use crate::j_submit::prepared_wire::decode_prepared_transaction;
use crate::processor::RuntimeDurableEnvelope;
use ethabi::Token;
use serde_json::{Value, json};
use sha3::{Digest, Keccak256};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NumberedRegistrationReplacement(Value);
impl NumberedRegistrationReplacement {
    pub(crate) fn encode(&self) -> Value {
        self.0.clone()
    }
}
fn fail(name: &str) -> String {
    format!("NUMBERED_REGISTRATION_REPLACEMENT_{name}")
}
pub(crate) fn decode(value: &Value) -> Result<NumberedRegistrationReplacement, String> {
    exact(
        value,
        &[
            "intentId",
            "requestHash",
            "previousTransactionHash",
            "rawTransaction",
            "evidence",
        ],
    )?;
    for key in ["intentId", "requestHash", "previousTransactionHash"] {
        raw_hex(text(value, key)?, Some(32))?;
    }
    raw_hex(text(value, "rawTransaction")?, None)?;
    crate::j_submit::native_replacement::validate_evidence(&value["evidence"])?;
    Ok(NumberedRegistrationReplacement(value.clone()))
}
fn expected_calldata(request: &Value) -> Result<Vec<u8>, String> {
    let entities = request["entities"]
        .as_array()
        .ok_or_else(|| fail("ENTITIES"))?;
    if entities.is_empty() {
        return Err(fail("ENTITIES"));
    }
    let boards = entities
        .iter()
        .map(|entity| raw_hex(text(entity, "encodedBoard")?, None).map(Token::Bytes))
        .collect::<Result<Vec<_>, _>>()?;
    let mut data = Keccak256::digest(b"registerNumberedEntitiesBatch(bytes[])")[..4].to_vec();
    data.extend(ethabi::encode(&[Token::Array(boards)]));
    Ok(data)
}
fn validate(
    envelope: &RuntimeDurableEnvelope,
    pending: &Value,
    input: &Value,
) -> Result<Value, String> {
    if pending["status"] != "pending" || pending["requestHash"] != input["requestHash"] {
        return Err(fail("INTENT_MISMATCH"));
    }
    let request = &pending["request"];
    let replicas = envelope
        .j_replicas()
        .as_array()
        .ok_or_else(|| fail("NATIVE_REQUIRED"))?;
    let mut bound = None;
    for pair in replicas {
        let replica = &pair[1];
        if replica.get("chainId").is_some()
            && replica["contracts"].get("depository").is_some()
            && replica["contracts"].get("entityProvider").is_some()
            && request["stackKey"] == crate::j_authority::stack_key(replica)?
        {
            bound = Some(replica);
            break;
        }
    }
    if bound.is_none_or(|replica| replica["watcherReceiptCommitment"] != "tron-rpc-attested") {
        return Err(fail("NATIVE_REQUIRED"));
    }
    let raw = text(input, "rawTransaction")?;
    let next = decode_prepared_transaction(raw, true).map_err(|e| e.to_string())?;
    if next.signer.as_slice() != raw_hex(text(request, "payerSignerId")?, Some(20))?
        || next.to.as_slice() != raw_hex(text(request, "entityProviderAddress")?, Some(20))?
        || !next.value.is_zero()
        || next.data != expected_calldata(request)?
    {
        return Err(fail("CALL_MISMATCH"));
    }
    let hash = format!("0x{}", hex::encode(next.hash));
    if crate::j_submit::native_replacement::validate_native_replacement(
        text(pending, "rawTransaction")?,
        raw,
        text(input, "previousTransactionHash")?,
        &input["evidence"],
    )? {
        return Ok(pending.clone());
    }
    let mut changed = pending.clone();
    changed["rawTransaction"] = json!(raw);
    changed["transactionHash"] = json!(hash);
    changed["transactionNonce"] = json!(0);
    Ok(changed)
}
pub(crate) fn apply(
    envelope: &mut RuntimeDurableEnvelope,
    replacement: &NumberedRegistrationReplacement,
) -> Result<(), String> {
    let value = &replacement.0;
    let store = &envelope.infrastructure()["numberedRegistrationIntents"];
    if store["__xlnType"] != "Map" {
        return Err(fail("INTENT_MISMATCH"));
    }
    let rows = store["value"]
        .as_array()
        .ok_or_else(|| fail("INTENT_MISMATCH"))?;
    let index = rows
        .iter()
        .position(|row| row[0] == value["intentId"])
        .ok_or_else(|| fail("INTENT_MISMATCH"))?;
    let pending = &rows[index][1];
    let changed = validate(envelope, pending, value)?;
    if changed == *pending {
        return Ok(());
    }
    envelope.infrastructure_mut()["numberedRegistrationIntents"]["value"][index][1] = changed;
    envelope.invalidate_infrastructure_digest();
    Ok(())
}

#[cfg(test)]
#[path = "registration_replacement_tests.rs"]
mod tests;

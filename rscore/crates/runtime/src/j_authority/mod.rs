//! Locally witnessed EntityProvider authority, bound to the committed J policy.
mod receipt;
mod validation;
pub(crate) use validation::decode;
#[cfg(test)]
mod tests;

use crate::processor::RuntimeDurableEnvelope;
use serde_json::{Value, json};
use sha3::{Digest, Keccak256};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthenticatedJAuthority(Value);

impl AuthenticatedJAuthority {
    pub(crate) fn encode(&self) -> Value {
        self.0.clone()
    }
}

fn bytes(value: &Value, key: &str, min: usize, max: usize) -> Result<Vec<u8>, String> {
    let text = value[key]
        .as_str()
        .ok_or_else(|| format!("J_AUTHORITY_HEX:{key}"))?;
    let raw = text
        .strip_prefix("0x")
        .ok_or_else(|| format!("J_AUTHORITY_HEX:{key}"))?;
    if raw.len() % 2 != 0
        || raw.len() / 2 < min
        || raw.len() / 2 > max
        || !raw
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!("J_AUTHORITY_HEX:{key}"));
    }
    hex::decode(raw).map_err(|_| format!("J_AUTHORITY_HEX:{key}"))
}
fn number(value: &Value, key: &str) -> Result<u64, String> {
    value[key]
        .as_u64()
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or_else(|| format!("J_AUTHORITY_NUMBER:{key}"))
}
fn hash(value: &Value) -> Result<String, String> {
    let canonical = crate::canonical_value_from_tagged_json(value).map_err(|e| e.to_string())?;
    let encoded = xln_rscore_protocol::encode_canonical_consensus_bytes(&canonical)
        .map_err(|e| e.to_string())?;
    Ok(format!("0x{}", hex::encode(Keccak256::digest(encoded))))
}
fn raw_digest(value: &Value) -> Result<String, String> {
    let mut raw = json!({"domain":"xln.j-authority.raw-log.v1"});
    for key in [
        "emitter",
        "topics",
        "data",
        "activationHeight",
        "blockHash",
        "transactionHash",
        "transactionIndex",
        "logIndex",
    ] {
        raw[key] = value[key].clone();
    }
    hash(&raw)
}
fn claim_hash(value: &Value) -> Result<String, String> {
    let mut claim = json!({"domain":"xln.j-authority.receipt-claim.v1"});
    for key in [
        "version",
        "source",
        "stackKey",
        "entityId",
        "boardHash",
        "activationHeight",
        "blockHash",
        "transactionHash",
        "transactionIndex",
        "logIndex",
        "emitter",
        "topics",
        "data",
        "rawLogDigest",
        "receiptLogIndex",
    ] {
        claim[key] = value[key].clone();
    }
    let fields: &[&str] = if value["receiptKind"] == "tron-rpc-attested" {
        &["receiptKind", "chainId", "finality"]
    } else {
        &["receiptsRoot", "encodedReceipt", "receiptProofNodes"]
    };
    for key in fields {
        claim[*key] = value[*key].clone();
    }
    hash(&claim)
}
pub(crate) fn stack_key(replica: &Value) -> Result<String, String> {
    let domain = Keccak256::digest(b"xln.certified-board.stack.v1");
    let chain = number(replica, "chainId")?;
    let contracts = &replica["contracts"];
    let mut encoded = domain.to_vec();
    encoded.extend([0; 24]);
    encoded.extend(chain.to_be_bytes());
    for key in ["depository", "entityProvider"] {
        encoded.extend([0; 12]);
        encoded.extend(bytes(contracts, key, 20, 20)?);
    }
    Ok(format!("0x{}", hex::encode(Keccak256::digest(encoded))))
}

pub(crate) fn apply(
    envelope: &mut RuntimeDurableEnvelope,
    evidence: &AuthenticatedJAuthority,
) -> Result<(), String> {
    let value = &evidence.0;
    if value["witnessRuntimeId"] != envelope.runtime_id() {
        return Err("J_AUTHORITY_WITNESS_RUNTIME_MISMATCH".into());
    }
    let rows = envelope
        .j_replicas()
        .as_array()
        .ok_or("J_AUTHORITY_J_REPLICAS")?;
    let mut matches = Vec::new();
    for pair in rows {
        let replica = &pair[1];
        if replica.get("chainId").is_some()
            && replica["contracts"].get("depository").is_some()
            && replica["contracts"].get("entityProvider").is_some()
            && value["stackKey"] == stack_key(replica)?
        {
            matches.push(replica);
        }
    }
    if matches.len() != 1 {
        return Err("J_AUTHORITY_STACK_LOCAL_MATCH".into());
    }
    let replica = matches[0];
    if replica["contracts"]["entityProvider"] != value["emitter"] {
        return Err("J_AUTHORITY_EMITTER_STACK_MISMATCH".into());
    }
    let native = value["receiptKind"] == "tron-rpc-attested";
    if (replica["watcherReceiptCommitment"] == "tron-rpc-attested") != native {
        return Err("J_AUTHORITY_RECEIPT_COMMITMENT_MISMATCH".into());
    }
    if replica["watcherConfirmationDepth"] != value["confirmationDepth"] {
        return Err("J_AUTHORITY_FINALITY_POLICY_MISMATCH".into());
    }
    if native {
        if replica["chainId"] != value["chainId"] || value["confirmationDepth"] != 0 {
            return Err("J_AUTHORITY_NATIVE_CHAIN_OR_DEPTH".into());
        }
        let rpcs = replica["rpcs"]
            .as_array()
            .ok_or("J_AUTHORITY_NATIVE_RPCS")?;
        let mut configured = false;
        for rpc in rpcs {
            let url = url::Url::parse(rpc.as_str().ok_or("J_AUTHORITY_RPC")?)
                .map_err(|_| "J_AUTHORITY_RPC")?;
            configured |= value["rpcEndpointHash"]
                == format!(
                    "0x{}",
                    hex::encode(Keccak256::digest(url.as_str().as_bytes()))
                );
        }
        if !configured {
            return Err("J_AUTHORITY_NATIVE_RPC_NOT_CONFIGURED".into());
        }
    }
    let key = format!(
        "{}:{}",
        value["stackKey"].as_str().expect("validated"),
        value["entityId"].as_str().expect("validated")
    );
    let infrastructure = envelope
        .infrastructure_mut()
        .as_object_mut()
        .ok_or("J_AUTHORITY_INFRASTRUCTURE")?;
    let store = infrastructure
        .entry("certifiedRegistrationEvidence")
        .or_insert_with(|| json!({"__xlnType":"Map","value":[]}));
    let entries = store["value"].as_array_mut().ok_or("J_AUTHORITY_STORE")?;
    for entry in entries.iter() {
        if entry[0] == key {
            if claim_hash(&entry[1])? != claim_hash(value)? {
                return Err("J_AUTHORITY_EVIDENCE_CONFLICT".into());
            }
            return Ok(());
        }
    }
    entries.push(json!([key, value]));
    envelope.invalidate_infrastructure_digest();
    Ok(())
}

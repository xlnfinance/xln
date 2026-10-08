use super::*;

fn event(value: &Value) -> Result<(), String> {
    let topics = value["topics"].as_array().ok_or("J_AUTHORITY_TOPICS")?;
    let native_foundation = value["source"] == "FoundationBootstrapped";
    let signature = if native_foundation {
        "FoundationBootstrapped(address,bytes32,uint256,uint256)"
    } else {
        "EntityRegistered(bytes32,uint256,bytes32)"
    };
    let topic0 = format!("0x{}", hex::encode(Keccak256::digest(signature.as_bytes())));
    let data = bytes(value, "data", 0, 65_536)?;
    if topics.len() != 3
        || topics[0] != topic0
        || data.len() != if native_foundation { 64 } else { 32 }
    {
        return Err("J_AUTHORITY_EVENT_TYPE".into());
    }
    let foundation_id = format!("0x{:064x}", 1);
    if native_foundation {
        if value["entityId"] != foundation_id || value["boardHash"] != topics[2] {
            return Err("J_AUTHORITY_EVENT_BODY".into());
        }
        let recipient = bytes(&json!({"topic":topics[1]}), "topic", 32, 32)?;
        if recipient[..12].iter().any(|byte| *byte != 0) {
            return Err("J_AUTHORITY_EVENT_ADDRESS".into());
        }
    } else if value["entityId"] != topics[1]
        || topics[1] != topics[2]
        || topics[1] == format!("0x{}", "00".repeat(32))
        || value["boardHash"] != format!("0x{}", hex::encode(data))
    {
        return Err("J_AUTHORITY_EVENT_BODY".into());
    }
    Ok(())
}

pub(crate) fn decode(value: &Value) -> Result<AuthenticatedJAuthority, String> {
    let object = value.as_object().ok_or("J_AUTHORITY_OBJECT")?;
    let native = value["receiptKind"] == "tron-rpc-attested";
    let mut fields = vec![
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
        "observedThroughHeight",
        "observedTipBlockHash",
        "observedHeadHeight",
        "confirmationDepth",
        "witnessRuntimeId",
        "witnessSignature",
    ];
    fields.extend(if native {
        vec!["receiptKind", "chainId", "rpcEndpointHash", "finality"]
    } else {
        vec!["receiptsRoot", "encodedReceipt", "receiptProofNodes"]
    });
    if object.len() != fields.len() || fields.iter().any(|key| !object.contains_key(*key)) {
        return Err("J_AUTHORITY_FIELDS".into());
    }
    if value["version"] != 1
        || !matches!(
            value["source"].as_str(),
            Some("FoundationBootstrapped" | "EntityRegistered")
        )
    {
        return Err("J_AUTHORITY_VERSION_SOURCE".into());
    }
    for key in [
        "stackKey",
        "entityId",
        "boardHash",
        "blockHash",
        "transactionHash",
        "rawLogDigest",
        "observedTipBlockHash",
    ] {
        bytes(value, key, 32, 32)?;
    }
    for key in ["emitter", "witnessRuntimeId"] {
        bytes(value, key, 20, 20)?;
    }
    let signature: [u8; 65] = bytes(value, "witnessSignature", 65, 65)?
        .try_into()
        .map_err(|_| "J_AUTHORITY_SIGNATURE")?;
    for key in [
        "activationHeight",
        "transactionIndex",
        "logIndex",
        "receiptLogIndex",
        "observedThroughHeight",
        "observedHeadHeight",
        "confirmationDepth",
    ] {
        number(value, key)?;
    }
    let activation = number(value, "activationHeight")?;
    let through = number(value, "observedThroughHeight")?;
    let finalized = number(value, "observedHeadHeight")?
        .checked_sub(number(value, "confirmationDepth")?)
        .ok_or("J_AUTHORITY_FINALITY")?;
    if activation == 0 || through < activation || through > finalized {
        return Err("J_AUTHORITY_FINALITY".into());
    }
    let topics = value["topics"]
        .as_array()
        .filter(|topics| !topics.is_empty() && topics.len() <= 4)
        .ok_or("J_AUTHORITY_TOPICS")?;
    for topic in topics {
        bytes(&json!({"topic":topic}), "topic", 32, 32)?;
    }
    bytes(value, "data", 0, 65_536)?;
    if native {
        if value["finality"] != "tron-solidified" || number(value, "chainId")? == 0 {
            return Err("J_AUTHORITY_NATIVE_FINALITY".into());
        }
        bytes(value, "rpcEndpointHash", 32, 32)?;
    } else {
        receipt::verify(value)?;
    }
    if value["rawLogDigest"] != raw_digest(value)? {
        return Err("J_AUTHORITY_RAW_LOG_DIGEST".into());
    }
    event(value)?;
    let mut body = value.clone();
    body.as_object_mut()
        .expect("validated object")
        .remove("witnessSignature");
    let digest = hash(&json!({"domain":"xln.j-authority.witness.v1","evidence":body}))?;
    let digest: [u8; 32] = hex::decode(&digest[2..])
        .map_err(|_| "J_AUTHORITY_DIGEST")?
        .try_into()
        .map_err(|_| "J_AUTHORITY_DIGEST")?;
    let recovered = xln_rscore_crypto::recover_signer_address(&digest, &signature)
        .ok_or("J_AUTHORITY_WITNESS_SIGNATURE")?;
    if recovered.as_slice() != bytes(value, "witnessRuntimeId", 20, 20)? {
        return Err("J_AUTHORITY_WITNESS_SIGNATURE".into());
    }
    Ok(AuthenticatedJAuthority(value.clone()))
}

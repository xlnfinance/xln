//! Custody adoption runs only on the existing Runtime writer, after authenticated IPC.
use crate::runtime_adapter::custody::custody_worker::CustodyOwner;
use serde_json::{Value, json};
use xln_rscore_runtime::{
    ResidentRuntimeService, RuntimeEntityKey, RuntimeReplica,
    restore::ConcreteCheckpointConfiguration,
};
pub fn owner_key(owner: &CustodyOwner) -> Result<RuntimeEntityKey, String> {
    let identity = xln_rscore_engine::SigningIdentity::lazy_from_key(
        owner.private_key,
        &owner.signer_id,
        1,
        1,
        xln_rscore_engine::BoardDelays::default(),
    )
    .map_err(|_| "BRAINVAULT_OWNER_IDENTITY_INVALID")?;
    RuntimeEntityKey::new(*identity.entity_id(), &owner.signer_id).map_err(|e| e.to_string())
}
fn jurisdiction(replica: &RuntimeReplica) -> Result<Value, String> {
    let name = replica
        .durable
        .active_jurisdiction()
        .ok_or("BRAINVAULT_OWNER_JURISDICTION_MISSING")?;
    let j = replica
        .durable
        .j_replicas()
        .as_array()
        .ok_or("BRAINVAULT_OWNER_JURISDICTION_MISSING")?
        .iter()
        .find(|row| row[0] == name)
        .ok_or("BRAINVAULT_OWNER_JURISDICTION_MISSING")?;
    let j = &j[1];
    let address = j["rpcs"]
        .as_array()
        .and_then(|r| r.first())
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| format!("jreplica://{name}"));
    let mut value = json!({"address":address,"name":name,"chainId":j["chainId"],
        "blockTimeMs":j.get("blockTimeMs").or_else(||j.get("blockDelayMs")).ok_or("BRAINVAULT_OWNER_BLOCK_TIME_MISSING")?,
        "depositoryAddress":j["contracts"]["depository"],"entityProviderAddress":j["contracts"]["entityProvider"]});
    if let Some(block) = j.get("entityProviderDeploymentBlock") {
        value["entityProviderDeploymentBlock"] = block.clone();
    }
    Ok(value)
}
pub fn adopt(
    service: &mut ResidentRuntimeService,
    config: &mut ConcreteCheckpointConfiguration,
    owner: CustodyOwner,
) -> Result<Value, String> {
    if !service.delivery_ready() {
        return Err("E_COMMAND_PENDING:runtime restoring".into());
    }
    let j = jurisdiction(service.processor().replica().map_err(|e| e.to_string())?)?;
    let profile = std::env::var("XLN_LOCAL_OWNER_PROFILE_NAME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "xln finance".into());
    let receipt = service
        .adopt_custody_owner(
            &owner.signer_id,
            owner.private_key,
            &owner.entity_seed,
            j,
            profile.trim(),
        )
        .map_err(|e| e.to_string())?;
    xln_rscore_runtime::install_custody_key(
        &mut config.custody_import_keys,
        &owner.signer_id,
        owner.private_key,
    )?;
    let mut public = owner
        .public_derivation
        .as_object()
        .ok_or("BRAINVAULT_PUBLIC_RECEIPT_INVALID")?
        .clone();
    public.extend(
        receipt
            .as_object()
            .ok_or("BRAINVAULT_COMMIT_RECEIPT_INVALID")?
            .clone(),
    );
    Ok(Value::Object(public))
}

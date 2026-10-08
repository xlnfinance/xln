use num_bigint::BigInt;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use xln_rscore_batch::AccountId;
use xln_rscore_engine::{Side, TokenId};
use xln_rscore_runtime::{ResidentRuntimeService, tagged_json_from_canonical_value};
fn error(e: impl std::fmt::Display) -> String {
    format!("E_INTERNAL:PAYMENT_ROUTES:{e}")
}
fn tagged(value: &BigInt) -> Value {
    json!({"__xlnType":"BigInt","value":value.to_string()})
}
pub(super) fn profiles(
    service: &mut ResidentRuntimeService,
    token: u16,
    routing_fees: &std::collections::BTreeMap<xln_rscore_runtime::RuntimeEntityKey, (u32, BigInt)>,
) -> Result<Vec<Value>, String> {
    let mut profiles = service.processor().authenticated_profiles();
    let owners = {
        let replica = service.processor().replica().map_err(error)?;
        let mut seen = BTreeSet::new();
        replica
            .state
            .e_replicas
            .iter()
            .map(|(key, state)| {
                if !seen.insert(key.entity_id) {
                    return Err(error("ENTITY_OWNER_AMBIGUOUS"));
                }
                let metadata = match &state.entity.hub_rebalance_config {
                    Some(config) => tagged_json_from_canonical_value(config).map_err(error)?,
                    None => {
                        let (ppm, base) = match routing_fees.get(key) {
                            Some(fee) => fee.clone(),
                            None if !state.entity.profile.is_hub => (1, BigInt::from(0)),
                            None => return Err(error("HUB_ROUTING_POLICY_MISSING")),
                        };
                        json!({"routingFeePPM":ppm,"baseFee":tagged(&base)})
                    }
                };
                Ok((
                    key.clone(),
                    state.entity.profile.name.clone(),
                    state.entity.profile.is_hub,
                    metadata,
                    state
                        .entity
                        .known_accounts
                        .iter()
                        .cloned()
                        .collect::<Vec<_>>(),
                ))
            })
            .collect::<Result<Vec<_>, String>>()?
    };
    let token_id = TokenId::new(u32::from(token)).map_err(error)?;
    for (key, name, is_hub, mut metadata, peers) in owners {
        let owner = format!("0x{}", hex::encode(key.entity_id));
        metadata["isHub"] = json!(is_hub);
        let mut rows = Vec::new();
        for peer in peers {
            let bytes: [u8; 32] =
                hex::decode(peer.strip_prefix("0x").ok_or_else(|| error("PEER_ID"))?)
                    .map_err(error)?
                    .try_into()
                    .map_err(|_| error("PEER_WIDTH"))?;
            let Some(status) = service
                .account_status(&key, AccountId::from_bytes(bytes), vec![token_id])
                .map_err(error)?
            else {
                return Err(error("KNOWN_ACCOUNT_MISSING"));
            };
            let Some(Some(delta)) = status.tokens.get(&token_id) else {
                continue;
            };
            let perspective = delta.perspective(if owner < peer {
                Side::Left
            } else {
                Side::Right
            });
            let capacity = json!({"outCapacity":tagged(&perspective.out_capacity),"inCapacity":tagged(&perspective.in_capacity)});
            rows.push(
                json!({"counterpartyId":peer,"tokenCapacities":{token.to_string():capacity}}),
            );
            // A remote advertisement cannot override a locally committed bilateral Account.
            for profile in &mut profiles {
                if profile["entityId"].as_str() == Some(&peer)
                    && let Some(accounts) = profile["accounts"].as_array_mut()
                {
                    for row in accounts
                        .iter_mut()
                        .filter(|r| r["counterpartyId"].as_str() == Some(&owner))
                    {
                        row["tokenCapacities"][token.to_string()] = json!({"outCapacity":tagged(&perspective.in_capacity),"inCapacity":tagged(&perspective.out_capacity)});
                    }
                }
            }
        }
        let profile = json!({"entityId":owner,"name":name,"metadata":metadata,"accounts":rows});
        if let Some(existing) = profiles.iter_mut().find(|p| p["entityId"] == owner) {
            *existing = profile;
        } else {
            profiles.push(profile);
        }
    }
    Ok(profiles)
}

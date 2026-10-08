//! Read-only native equivalent of calculateSolvency. No chain totals are inferred.
use num_bigint::BigInt;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use xln_rscore_engine::{AccountConsensus, StateError};
use xln_rscore_protocol::CanonicalValue as V;
use xln_rscore_runtime::{
    ResidentRuntimeService, RuntimeEntityKey, tagged_json_from_canonical_value,
};

fn error(value: impl std::fmt::Display) -> String {
    format!("E_INTERNAL:SOLVENCY:{value}")
}
fn amount(value: &BigInt) -> Value {
    json!({"__xlnType":"BigInt","value":value.to_string()})
}

#[derive(Default)]
struct Totals {
    reserves: BigInt,
    collateral: BigInt,
}

fn selected_owners(service: &ResidentRuntimeService) -> Result<Vec<RuntimeEntityKey>, String> {
    let replica = service.processor().replica().map_err(error)?;
    let mut selected: BTreeMap<[u8; 32], (RuntimeEntityKey, u64, String)> = BTreeMap::new();
    for (key, state) in &replica.state.e_replicas {
        let live = replica
            .e_replicas
            .get(key)
            .ok_or("E_INTERNAL:SOLVENCY_OWNER_MISSING")?;
        let (root, _) = live
            .entity_consensus
            .validate_restored(
                &format!("0x{}", hex::encode(key.entity_id)),
                state.entity.height,
            )
            .map_err(error)?;
        if let Some((current, height, current_root)) = selected.get(&key.entity_id) {
            if *height > state.entity.height {
                continue;
            }
            if *height == state.entity.height {
                if *current_root != root {
                    return Err(format!(
                        "E_INTERNAL:SOLVENCY_ENTITY_REPLICA_DIVERGENCE:{}",
                        hex::encode(key.entity_id)
                    ));
                }
                if current.signer_id <= key.signer_id {
                    continue;
                }
            }
        }
        selected.insert(key.entity_id, (key.clone(), state.entity.height, root));
    }
    Ok(selected.into_values().map(|(key, _, _)| key).collect())
}
fn stack(config: &Value) -> Result<(u64, String), String> {
    let j = &config["jurisdiction"];
    let chain = j["chainId"]
        .as_u64()
        .or_else(|| j["chainId"].as_str().and_then(|s| s.parse().ok()))
        .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
        .ok_or("E_INTERNAL:SOLVENCY_STACK_CHAIN")?;
    let address = j["depositoryAddress"]
        .as_str()
        .ok_or("E_INTERNAL:SOLVENCY_STACK_ADDRESS")?
        .trim()
        .to_ascii_lowercase();
    if address.len() != 42
        || !address.starts_with("0x")
        || !address[2..].bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("E_INTERNAL:SOLVENCY_STACK_ADDRESS".into());
    }
    Ok((chain, address))
}
fn collateral(account: &AccountConsensus) -> Result<V, StateError> {
    Ok(V::Map(
        account
            .replica()
            .state()
            .deltas()
            .map(|delta| {
                (
                    crate::runtime_adapter::views::account_projection::token(
                        delta.token_id().get(),
                    ),
                    V::BigInt(delta.collateral().clone()),
                )
            })
            .collect(),
    ))
}
fn account_id(id: &str) -> Result<xln_rscore_batch::AccountId, String> {
    let bytes = hex::decode(
        id.strip_prefix("0x")
            .ok_or("E_INTERNAL:SOLVENCY_ACCOUNT_ID")?,
    )
    .map_err(error)?;
    Ok(xln_rscore_batch::AccountId::from_bytes(
        bytes
            .try_into()
            .map_err(|_| "E_INTERNAL:SOLVENCY_ACCOUNT_ID_WIDTH")?,
    ))
}

pub fn read(service: &mut ResidentRuntimeService, query: &Value) -> Result<Value, String> {
    let height = service.processor().replica().map_err(error)?.state.height;
    if let Some(requested) = query.get("atHeight").filter(|v| !v.is_null()) {
        let requested = requested
            .as_u64()
            .or_else(|| requested.as_str().and_then(|s| s.parse().ok()))
            .ok_or("E_BAD_QUERY:atHeight")?;
        if requested != height {
            return Err("E_BAD_QUERY:historical solvency-summary reads unavailable".into());
        }
    }
    let owners = selected_owners(service)?;
    let mut totals: BTreeMap<(String, u64, String, u16), Totals> = BTreeMap::new();
    let mut account_views = 0;
    for key in &owners {
        let (reserves, accounts, config) = {
            let replica = service.processor().replica().map_err(error)?;
            let state = &replica.state.e_replicas[key];
            let live = &replica.e_replicas[key];
            let projection = xln_rscore_entity_kernel::project_entity_storage(
                &state.entity,
                &live.entity_consensus,
            )
            .map_err(error)?;
            (
                state.entity.reserves.clone(),
                state
                    .entity
                    .known_accounts
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>(),
                tagged_json_from_canonical_value(&projection.config).map_err(error)?,
            )
        };
        account_views += accounts.len();
        let entity_id = format!("0x{}", hex::encode(key.entity_id));
        let left_accounts = accounts
            .iter()
            .filter(|peer| entity_id.as_str() < peer.as_str())
            .map(|id| account_id(id))
            .collect::<Result<Vec<_>, _>>()?;
        // Only left-owned views contribute collateral, identical to TS isLeftEntity.
        let rows = service
            .read_account_views(key, left_accounts, collateral)
            .map_err(error)?;
        let mut collateral_by_token: BTreeMap<u16, BigInt> = BTreeMap::new();
        for (_, row) in rows {
            let V::Map(values) = row else {
                return Err("E_INTERNAL:SOLVENCY_COLLATERAL_SHAPE".into());
            };
            for (token, value) in values {
                let wire = tagged_json_from_canonical_value(&token).map_err(error)?;
                let token = wire
                    .as_u64()
                    .and_then(|n| u16::try_from(n).ok())
                    .filter(|n| *n > 0)
                    .ok_or("E_INTERNAL:SOLVENCY_TOKEN_ID")?;
                let V::BigInt(value) = value else {
                    return Err("E_INTERNAL:SOLVENCY_COLLATERAL_AMOUNT".into());
                };
                *collateral_by_token.entry(token).or_default() += value;
            }
        }
        if reserves.is_empty() && collateral_by_token.is_empty() {
            continue;
        }
        let (chain, address) = stack(&config)?;
        let stack_id = format!("{chain}:{address}");
        for (token, value) in reserves {
            if token == 0 {
                return Err("E_INTERNAL:SOLVENCY_TOKEN_ID".into());
            }
            totals
                .entry((stack_id.clone(), chain, address.clone(), token))
                .or_default()
                .reserves += value;
        }
        for (token, value) in collateral_by_token {
            totals
                .entry((stack_id.clone(), chain, address.clone(), token))
                .or_default()
                .collateral += value;
        }
    }
    let assets=totals.into_iter().map(|((stack_id,chain,address,token),value)|json!({
        "stackId":stack_id,"chainId":chain,"depositoryAddress":address,"tokenId":token,
        "reserves":amount(&value.reserves),"confirmedCollateral":amount(&value.collateral),
        "internalValue":amount(&(value.reserves+value.collateral)),"expectedInternalValue":null,"delta":null,"isValid":null
    })).collect::<Vec<_>>();
    Ok(
        json!({"ok":true,"height":height,"entityCount":owners.len(),"accountViews":account_views,"assets":assets,"isValid":null}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use xln_rscore_engine::{
        AccountDisputeConfig, AccountDomain, AccountIdentity, AccountReplica, AccountState, Delta,
        DepositoryAddress, EntityId, TokenId, WatchSeed,
    };

    #[test]
    fn native_collateral_projection_reads_committed_collateral_without_credit_or_offdelta() {
        let left = EntityId::parse(&format!("0x{}", "11".repeat(32))).unwrap();
        let right = EntityId::parse(&format!("0x{}", "22".repeat(32))).unwrap();
        let identity = AccountIdentity::new(
            AccountDomain::new(
                31337,
                DepositoryAddress::parse("0x8888888888888888888888888888888888888888").unwrap(),
            )
            .unwrap(),
            left.clone(),
            right,
            WatchSeed::parse(&format!("0x{}", "99".repeat(32))).unwrap(),
        )
        .unwrap();
        let deltas = [(1, 500), (101, 700)]
            .into_iter()
            .map(|(token, value)| {
                Delta::new(
                    TokenId::new(token).unwrap(),
                    value.into(),
                    0.into(),
                    17.into(),
                    1000.into(),
                    2000.into(),
                    0.into(),
                    0.into(),
                    0.into(),
                    0.into(),
                )
                .unwrap()
            })
            .collect();
        let state = AccountState::new(identity, AccountDisputeConfig::new(10, 10).unwrap(), deltas)
            .unwrap();
        let consensus = AccountConsensus::new(AccountReplica::new(left, state).unwrap());
        assert_eq!(
            collateral(&consensus).unwrap(),
            V::Map(vec![
                (
                    crate::runtime_adapter::views::account_projection::token(1),
                    V::BigInt(500.into())
                ),
                (
                    crate::runtime_adapter::views::account_projection::token(101),
                    V::BigInt(700.into())
                )
            ])
        );
        assert_eq!(
            amount(&BigInt::from(1200)),
            json!({"__xlnType":"BigInt","value":"1200"})
        );
    }
    #[test]
    fn jurisdiction_identity_keeps_equal_token_numbers_on_different_stacks_separate() {
        let a=stack(&json!({"jurisdiction":{"chainId":31337,"depositoryAddress":"0x8888888888888888888888888888888888888888"}})).unwrap();
        let b=stack(&json!({"jurisdiction":{"chainId":31338,"depositoryAddress":"0x8888888888888888888888888888888888888888"}})).unwrap();
        assert_ne!(a, b);
        assert!(stack(&json!({"jurisdiction":{"chainId":0,"depositoryAddress":"0x8888888888888888888888888888888888888888"}})).is_err());
        assert!(stack(&json!({"jurisdiction":{"chainId":31337,"depositoryAddress":""}})).is_err());
    }
}

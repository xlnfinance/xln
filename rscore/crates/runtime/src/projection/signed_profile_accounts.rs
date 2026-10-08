//! Canonical pinned Account advertisement, matching profile-descriptor.ts.
use crate::{
    RuntimeEntityState, canonical_value_from_tagged_json, tagged_json_from_canonical_value,
};
use num_bigint::BigInt;
use serde_json::{Value, json};
use xln_rscore_batch::AccountId;
use xln_rscore_engine::{AccountConsensus, StateError};
use xln_rscore_protocol::{CanonicalValue, encode_canonical_consensus_bytes};

const DESCRIPTOR_LIMIT: usize = 960_602; // MAX_PROFILE_BYTES minus canonical route/Hanko overhead.
fn tagged(value: &BigInt) -> Value {
    json!({"__xlnType":"BigInt","value":value.to_string()})
}
fn floor(value: &BigInt) -> BigInt {
    if value <= &BigInt::from(0) {
        BigInt::from(0)
    } else {
        value - value % 1000
    }
}
pub fn account_ids(state: &RuntimeEntityState) -> Result<Vec<AccountId>, String> {
    state
        .entity
        .known_accounts
        .iter()
        .map(|peer| {
            let bytes = hex::decode(peer.strip_prefix("0x").ok_or("PROFILE_ACCOUNT_ID")?)
                .map_err(|e| e.to_string())?;
            Ok(AccountId::from_bytes(
                bytes.try_into().map_err(|_| "PROFILE_ACCOUNT_ID_WIDTH")?,
            ))
        })
        .collect()
}
/// Only the committed owner-side pin grants permission to advertise this Account.
pub fn project_account(account: &AccountConsensus) -> Result<CanonicalValue, StateError> {
    let replica = account.replica();
    let envelope = account.checkpoint_envelope()?;
    if !envelope
        .fields()
        .iter()
        .any(|(key, value)| key == "publicPinned" && value == &CanonicalValue::Bool(true))
    {
        return Ok(CanonicalValue::Null);
    }
    let state = replica.state();
    let identity = state.identity();
    let side = identity
        .side_of(replica.owner())
        .ok_or_else(|| StateError::Envelope("PROFILE_ACCOUNT_OWNER".into()))?;
    let peer = if replica.owner() == identity.left() {
        identity.right()
    } else {
        identity.left()
    };
    let mut tokens = state.deltas().map(|delta| {
        let view = delta.perspective(side);
        (delta.token_id().get(), &view.in_capacity + &view.out_capacity,
            json!({"inCapacity":tagged(&floor(&view.in_capacity)),"outCapacity":tagged(&floor(&view.out_capacity))}))
    }).filter(|(_,liquidity,_)| liquidity > &BigInt::from(0)).collect::<Vec<_>>();
    tokens.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    tokens.truncate(16);
    let value = json!({
        "counterpartyId":peer.to_string(),
        "domain":{"chainId":identity.domain().chain_id(),"depositoryAddress":format!("0x{}",hex::encode(identity.domain().depository_address().bytes()))},
        "ranked":tokens.into_iter().map(|(token,liquidity,capacity)| json!({"token":token,"liquidity":tagged(&liquidity),"capacity":capacity})).collect::<Vec<_>>()
    });
    canonical_value_from_tagged_json(&value).map_err(|e| StateError::Envelope(e.to_string()))
}
fn amount(value: &Value) -> Result<BigInt, String> {
    value["value"]
        .as_str()
        .ok_or("PROFILE_CAPACITY_TYPE")?
        .parse()
        .map_err(|_| "PROFILE_CAPACITY_VALUE".into())
}
#[derive(Clone)]
struct Extra {
    peer: String,
    token: String,
    liquidity: BigInt,
    capacity: Value,
}
fn set_accounts(
    descriptor: &mut CanonicalValue,
    accounts: &Value,
    public: &Value,
) -> Result<(), String> {
    let CanonicalValue::Object(fields) = descriptor else {
        return Err("PROFILE_DESCRIPTOR_TYPE".into());
    };
    for (key, value) in fields {
        match key.as_str() {
            "accounts" => {
                *value = canonical_value_from_tagged_json(accounts).map_err(|e| e.to_string())?
            }
            "publicAccounts" => {
                *value = canonical_value_from_tagged_json(public).map_err(|e| e.to_string())?
            }
            _ => {}
        }
    }
    Ok(())
}
pub fn apply_accounts(
    descriptor: &mut CanonicalValue,
    rows: Vec<(AccountId, CanonicalValue)>,
) -> Result<(Value, Value), String> {
    let mut accounts = Vec::new();
    let mut public = Vec::new();
    let mut extras = Vec::new();
    for (id, row) in rows {
        if row == CanonicalValue::Null {
            continue;
        }
        let row = tagged_json_from_canonical_value(&row).map_err(|e| e.to_string())?;
        let peer = row["counterpartyId"]
            .as_str()
            .ok_or("PROFILE_PEER_TYPE")?
            .to_owned();
        if peer != format!("0x{}", hex::encode(id.as_bytes())) {
            return Err("PROFILE_PEER_BINDING".into());
        }
        let ranked = row["ranked"].as_array().ok_or("PROFILE_RANKED_TYPE")?;
        let Some(first) = ranked.first() else {
            continue;
        };
        let token = first["token"].as_u64().ok_or("PROFILE_TOKEN")?.to_string();
        let capacity = first["capacity"].clone();
        if amount(&capacity["inCapacity"])? > BigInt::from(0) {
            public.push(peer.clone());
        }
        accounts.push(json!({"counterpartyId":peer,"domain":row["domain"],"tokenCapacities":{token:capacity}}));
        for item in ranked.iter().skip(1) {
            extras.push(Extra {
                peer: peer.clone(),
                token: item["token"].as_u64().ok_or("PROFILE_TOKEN")?.to_string(),
                liquidity: amount(&item["liquidity"])?,
                capacity: item["capacity"].clone(),
            });
        }
    }
    let liquidity = |row: &Value| -> Result<BigInt, String> {
        let caps = row["tokenCapacities"]
            .as_object()
            .ok_or("PROFILE_CAPACITIES")?;
        caps.values().try_fold(BigInt::from(0), |total, cap| {
            Ok(total + amount(&cap["inCapacity"])? + amount(&cap["outCapacity"])?)
        })
    };
    if accounts.len() > 100 {
        let mut ranked = accounts
            .into_iter()
            .map(|row| Ok((liquidity(&row)?, row)))
            .collect::<Result<Vec<_>, String>>()?;
        ranked.sort_by(|a, b| {
            b.0.cmp(&a.0).then(
                a.1["counterpartyId"]
                    .as_str()
                    .cmp(&b.1["counterpartyId"].as_str()),
            )
        });
        accounts = ranked.into_iter().take(100).map(|(_, row)| row).collect();
        public.retain(|peer| accounts.iter().any(|row| row["counterpartyId"] == *peer));
        extras.retain(|extra| {
            accounts
                .iter()
                .any(|row| row["counterpartyId"] == extra.peer)
        });
    }
    accounts.sort_by(|a, b| {
        a["counterpartyId"]
            .as_str()
            .cmp(&b["counterpartyId"].as_str())
    });
    public.sort();
    extras.sort_by(|a, b| {
        b.liquidity
            .cmp(&a.liquidity)
            .then(a.peer.cmp(&b.peer))
            .then_with(|| {
                a.token
                    .parse::<u16>()
                    .unwrap()
                    .cmp(&b.token.parse::<u16>().unwrap())
            })
    });
    let public = json!(public);
    let prefix = |count: usize| {
        let mut result = accounts.clone();
        for extra in extras.iter().take(count) {
            let row = result
                .iter_mut()
                .find(|row| row["counterpartyId"] == extra.peer)
                .expect("selected peer");
            row["tokenCapacities"][&extra.token] = extra.capacity.clone();
        }
        json!(result)
    };
    let mut candidate = prefix(extras.len());
    set_accounts(descriptor, &candidate, &public)?;
    if encode_canonical_consensus_bytes(descriptor)
        .map_err(|e| e.to_string())?
        .len()
        > DESCRIPTOR_LIMIT
    {
        candidate = prefix(0);
        set_accounts(descriptor, &candidate, &public)?;
        let size = encode_canonical_consensus_bytes(descriptor)
            .map_err(|e| e.to_string())?
            .len();
        if size > DESCRIPTOR_LIMIT {
            return Err(format!(
                "ENTITY_PROFILE_REQUIRED_CAPACITY_BUDGET_EXCEEDED:{size}:{DESCRIPTOR_LIMIT}"
            ));
        }
        let (mut low, mut high) = (0, extras.len());
        while low < high {
            let mid = (low + high).div_ceil(2);
            candidate = prefix(mid);
            set_accounts(descriptor, &candidate, &public)?;
            if encode_canonical_consensus_bytes(descriptor)
                .map_err(|e| e.to_string())?
                .len()
                <= DESCRIPTOR_LIMIT
            {
                low = mid
            } else {
                high = mid - 1
            }
        }
        candidate = prefix(low);
        set_accounts(descriptor, &candidate, &public)?;
    }
    Ok((candidate, public))
}

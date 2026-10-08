//! Read-only route discovery; balances remain owned by committed native Accounts.
use num_bigint::BigInt;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use xln_rscore_runtime::{
    ResidentRuntimeService,
    payment_routes::{edge, edges, search},
};
mod source;
fn id(query: &Value, key: &str) -> Result<String, String> {
    let text = query
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if text.len() != 66
        || !text.starts_with("0x")
        || !text[2..].bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(format!("E_BAD_QUERY:{key} must be a bytes32 entity id"));
    }
    Ok(text)
}
pub fn read(
    service: &mut ResidentRuntimeService,
    query: &Value,
    routing_fees: &std::collections::BTreeMap<xln_rscore_runtime::RuntimeEntityKey, (u32, BigInt)>,
) -> Result<Value, String> {
    let source = id(query, "sourceEntityId")?;
    let target = id(query, "targetEntityId")?;
    let funding = query
        .get("fundingAccountId")
        .filter(|v| **v != Value::Null && **v != Value::String(String::new()))
        .map(|_| id(query, "fundingAccountId"))
        .transpose()?;
    let token = query
        .get("tokenId")
        .and_then(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()))
        .and_then(|v| u16::try_from(v).ok())
        .filter(|v| *v > 0)
        .ok_or("E_BAD_QUERY:tokenId must be positive")?;
    let amount = query
        .get("amount")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<BigInt>().ok())
        .filter(|v| *v > BigInt::from(0))
        .ok_or("E_BAD_QUERY:amount must be positive bigint string")?;
    let profiles = source::profiles(service, token, routing_fees)?;
    let nodes = profiles
        .iter()
        .filter_map(|p| p["entityId"].as_str())
        .collect::<BTreeSet<_>>();
    if !nodes.contains(source.as_str()) || !nodes.contains(target.as_str()) {
        return Err("E_INTERNAL:payment route profiles are unavailable".into());
    }
    let edges = edges(&profiles, token, &source, funding.as_deref())?;
    let routes = search(&edges, &source, &target, &amount, funding.as_deref())?;
    if routes.is_empty() {
        return Err(format!(
            "E_NOT_FOUND:no payment route from {source} to {target}"
        ));
    }
    Ok(json!({"routes":routes.iter().map(|r| json!({"path":r.path,
        "hops":r.path.windows(2).enumerate().map(|(i,p)|json!({"from":p[0],"to":p[1],"fee":r.fees[i].to_string(),"feePPM":edge(&edges,&p[0],&p[1]).expect("built route").ppm})).collect::<Vec<_>>(),
        "totalFee":(&r.total-&amount).to_string(),"senderAmount":r.total.to_string(),"recipientAmount":amount.to_string(),"probability":r.probability})).collect::<Vec<_>>()}))
}

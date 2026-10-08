use super::Edge;
use num_bigint::BigInt;
use serde_json::Value;
use std::collections::BTreeSet;
use xln_rscore_entity_kernel::{PreparedAccountView, directional_fee_ppm};
fn error(e: impl std::fmt::Display) -> String {
    format!("E_INTERNAL:PAYMENT_ROUTES:{e}")
}
fn integer(value: &Value) -> Result<BigInt, String> {
    value
        .as_str()
        .or_else(|| value.get("value").and_then(Value::as_str))
        .ok_or_else(|| error("BIGINT_MISSING"))?
        .parse()
        .map_err(error)
}
fn fee(profile: &Value, out: &BigInt, inbound: &BigInt) -> Result<(u32, BigInt), String> {
    let metadata = &profile["metadata"];
    let ppm = metadata["routingFeePPM"]
        .as_u64()
        .filter(|v| *v < 1_000_000)
        .ok_or_else(|| error("PROFILE_FEE_INVALID"))? as u32;
    let base = integer(&metadata["baseFee"])?;
    if base < BigInt::from(0) {
        return Err(error("PROFILE_BASE_FEE_NEGATIVE"));
    }
    Ok((
        directional_fee_ppm(
            ppm,
            &PreparedAccountView {
                online: true,
                out_capacity: out.clone(),
                in_capacity: inbound.clone(),
            },
        ),
        base,
    ))
}
fn capacity(row: &Value, token: u16) -> Option<&Value> {
    let values = &row["tokenCapacities"];
    if values["__xlnType"] == "Map" {
        values["entries"]
            .as_array()?
            .iter()
            .find(|pair| {
                pair[0].as_u64() == Some(u64::from(token))
                    || pair[0].as_str() == Some(&token.to_string())
            })
            .map(|pair| &pair[1])
    } else {
        values.get(token.to_string())
    }
}
pub fn edges(
    profiles: &[Value],
    token: u16,
    source: &str,
    funding: Option<&str>,
) -> Result<Vec<Edge>, String> {
    let mut edges = Vec::new();
    let mut recorded = BTreeSet::new();
    for profile in profiles {
        let from = profile["entityId"]
            .as_str()
            .ok_or_else(|| error("PROFILE_ID"))?;
        let mut forward = Vec::new();
        for row in profile["accounts"]
            .as_array()
            .ok_or_else(|| error("PROFILE_ACCOUNTS"))?
        {
            let to = row["counterpartyId"]
                .as_str()
                .ok_or_else(|| error("PEER_ID"))?;
            let Some(other) = profiles.iter().find(|p| p["entityId"] == to) else {
                continue;
            };
            let Some(cap) = capacity(row, token) else {
                continue;
            };
            let out = integer(&cap["outCapacity"])?;
            let inbound = integer(&cap["inCapacity"])?;
            let (ppm, base) = fee(profile, &out, &inbound)?;
            if out > BigInt::from(0) || (source == from && funding == Some(to)) {
                forward.push(Edge {
                    from: from.into(),
                    to: to.into(),
                    capacity: out.clone(),
                    base,
                    ppm,
                });
            }
            recorded.insert((from.to_owned(), to.to_owned()));
            if recorded.insert((to.to_owned(), from.to_owned()))
                && (inbound > BigInt::from(0) || (source == to && funding == Some(from)))
            {
                let (ppm, base) = fee(other, &inbound, &out)?;
                edges.push(Edge {
                    from: to.into(),
                    to: from.into(),
                    capacity: inbound,
                    base,
                    ppm,
                });
            }
        }
        edges.extend(forward);
    }
    Ok(edges)
}

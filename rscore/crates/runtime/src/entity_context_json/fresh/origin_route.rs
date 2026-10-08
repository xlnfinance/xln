use super::FreshEntityContextError;
use num_bigint::BigInt;
use serde_json::Value;
use std::collections::BTreeSet;
use xln_rscore_engine::{AccountDomain, DepositoryAddress};
use xln_rscore_entity_kernel::{PreparedAccountView, directional_fee_ppm, required_htlc_inbound};

pub(super) fn invalid(reason: impl ToString) -> FreshEntityContextError {
    FreshEntityContextError::HtlcInfrastructureInvalid(format!("ORIGIN:{}", reason.to_string()))
}
pub(super) fn bytes<const N: usize>(value: &str) -> Result<[u8; N], FreshEntityContextError> {
    hex::decode(value.strip_prefix("0x").ok_or_else(|| invalid("HEX"))?)
        .map_err(invalid)?
        .try_into()
        .map_err(|_| invalid("HEX_WIDTH"))
}
pub(super) fn integer(value: &Value) -> Result<BigInt, FreshEntityContextError> {
    value
        .as_str()
        .or_else(|| value.get("value").and_then(Value::as_str))
        .ok_or_else(|| invalid("BIGINT"))?
        .parse()
        .map_err(invalid)
}
pub(super) fn profile<'a>(
    profiles: &'a [Value],
    id: &str,
) -> Result<&'a Value, FreshEntityContextError> {
    let mut matching = profiles
        .iter()
        .filter(|profile| profile["entityId"].as_str() == Some(id));
    let profile = matching
        .next()
        .ok_or_else(|| invalid(format!("PROFILE_MISSING:{id}")))?;
    if matching.next().is_some() {
        return Err(invalid("PROFILE_DUPLICATE"));
    }
    Ok(profile)
}
fn account<'a>(profile: &'a Value, peer: &str) -> Option<&'a Value> {
    profile["accounts"]
        .as_array()?
        .iter()
        .find(|row| row["counterpartyId"].as_str() == Some(peer))
}
pub(super) fn domain(value: &Value) -> Result<AccountDomain, FreshEntityContextError> {
    AccountDomain::new(
        value["chainId"]
            .as_u64()
            .ok_or_else(|| invalid("CHAIN_ID"))?,
        DepositoryAddress::parse(
            value["depositoryAddress"]
                .as_str()
                .ok_or_else(|| invalid("DEPOSITORY"))?,
        )
        .map_err(invalid)?,
    )
    .map_err(invalid)
}
pub(super) fn hop_domain(
    profiles: &[Value],
    from: &str,
    to: &str,
) -> Result<AccountDomain, FreshEntityContextError> {
    let own = account(profile(profiles, from)?, to)
        .map(|row| domain(&row["domain"]))
        .transpose()?;
    let mirror = account(profile(profiles, to)?, from)
        .map(|row| domain(&row["domain"]))
        .transpose()?;
    if let (Some(left), Some(right)) = (&own, &mirror)
        && left != right
    {
        return Err(invalid("ACCOUNT_DOMAIN_CONFLICT"));
    }
    own.or(mirror)
        .ok_or_else(|| invalid(format!("ACCOUNT_MISSING:{from}:{to}")))
}
fn capacity(row: &Value, token: u16) -> Result<(BigInt, BigInt), FreshEntityContextError> {
    let capacities = &row["tokenCapacities"];
    let value = if capacities["__xlnType"] == "Map" {
        capacities["entries"]
            .as_array()
            .and_then(|rows| {
                rows.iter().find(|pair| {
                    pair[0].as_u64() == Some(u64::from(token))
                        || pair[0].as_str() == Some(&token.to_string())
                })
            })
            .map(|row| &row[1])
    } else {
        capacities.get(token.to_string())
    }
    .ok_or_else(|| invalid("TOKEN_CAPACITY"))?;
    Ok((
        integer(&value["outCapacity"])?,
        integer(&value["inCapacity"])?,
    ))
}
pub(super) fn required_inbound(
    profiles: &[Value],
    from: &str,
    to: &str,
    token: u16,
    amount: &BigInt,
) -> Result<BigInt, FreshEntityContextError> {
    let owner = profile(profiles, from)?;
    let (out_capacity, in_capacity) = if let Some(row) = account(owner, to) {
        capacity(row, token)?
    } else {
        let (out, inbound) = capacity(
            account(profile(profiles, to)?, from).ok_or_else(|| invalid("ACCOUNT_MISSING"))?,
            token,
        )?;
        (inbound, out)
    };
    let metadata = &owner["metadata"];
    let fee = metadata["routingFeePPM"].as_u64().unwrap_or(1);
    if fee >= 1_000_000 {
        return Err(invalid("FEE_PPM"));
    }
    let base = if metadata["baseFee"].is_null() {
        BigInt::from(0)
    } else {
        integer(&metadata["baseFee"])?
    };
    if base < BigInt::from(0) {
        return Err(invalid("BASE_FEE"));
    }
    let ppm = directional_fee_ppm(
        fee as u32,
        &PreparedAccountView {
            online: true,
            out_capacity,
            in_capacity,
        },
    );
    required_htlc_inbound(amount, ppm, &base).map_err(invalid)
}

pub(super) fn validate(
    tx: &xln_rscore_entity_kernel::HtlcPaymentEntityTx,
    source: &str,
    timestamp: u64,
) -> Result<(), FreshEntityContextError> {
    if tx.amount <= BigInt::from(0) || tx.max_sender_debit < tx.amount {
        return Err(FreshEntityContextError::OriginRejected(
            "AMOUNT_OR_MAX_DEBIT",
        ));
    }
    if tx.route.len() < 2
        || tx.route.len() > 101
        || tx.route.first().map(String::as_str) != Some(source)
        || tx.route.last() != Some(&tx.target_entity_id)
    {
        return Err(FreshEntityContextError::OriginRejected("ROUTE"));
    }
    let unique = tx.route.iter().collect::<BTreeSet<_>>();
    let self_route = source == tx.target_entity_id;
    if (!self_route && unique.len() != tx.route.len())
        || (self_route
            && (tx.route.len() < 4
                || unique.len() + 1 != tx.route.len()
                || tx.route[1..tx.route.len() - 1]
                    .iter()
                    .any(|id| id == source)))
    {
        return Err(FreshEntityContextError::OriginRejected("ROUTE_LOOP"));
    }
    for id in &tx.route {
        bytes::<32>(id)?;
    }
    if tx.started_at_ms.is_some_and(|time| time != timestamp) {
        return Err(FreshEntityContextError::OriginRejected("STARTED_AT"));
    }
    if tx
        .description
        .as_ref()
        .is_some_and(|text| text.trim() != text || text.len() > 256)
    {
        return Err(FreshEntityContextError::OriginRejected("DESCRIPTION"));
    }
    Ok(())
}
pub(super) fn resolve_empty_route(
    tx: &mut xln_rscore_entity_kernel::HtlcPaymentEntityTx,
    source: &str,
    profiles: &[Value],
) -> Result<(), FreshEntityContextError> {
    if tx.route.is_empty() {
        let edges = crate::payment_routes::edges(profiles, tx.token_id.get(), source, None)
            .map_err(invalid)?;
        tx.route =
            crate::payment_routes::search(&edges, source, &tx.target_entity_id, &tx.amount, None)
                .map_err(invalid)?
                .into_iter()
                .next()
                .ok_or(FreshEntityContextError::OriginRejected("ROUTE_NOT_FOUND"))?
                .path;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn captured_live_route_origin_uses_exact_backwards_fees() {
        let profiles: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../../../core/__tests__/fixtures/pathfinding/three-hub-live-profiles.json"
        ))
        .unwrap();
        let ids = profiles
            .iter()
            .map(|p| p["entityId"].as_str().unwrap())
            .collect::<Vec<_>>();
        let route = [ids[0], ids[2], ids[3], ids[4], ids[1]];
        let mut tx = xln_rscore_entity_kernel::HtlcPaymentEntityTx {
            target_entity_id: ids[1].into(),
            token_id: xln_rscore_engine::TokenId::new(1).unwrap(),
            amount: 25_000_000.into(),
            max_sender_debit: 25_000_075.into(),
            route: vec![],
            description: None,
            delivery_mode: xln_rscore_entity_kernel::OriginatedHtlcDeliveryMode::Instant,
            started_at_ms: None,
            hashlock: None,
            tx_hash: "captured-route".into(),
        };
        resolve_empty_route(&mut tx, ids[0], &profiles).unwrap();
        assert_eq!(
            tx.route,
            vec![ids[0], ids[2], ids[4], ids[1]],
            "auto-route selects the lower-fee captured path"
        );
        let original = tx.clone();
        resolve_empty_route(&mut tx, ids[0], &[]).unwrap();
        assert_eq!(tx, original, "explicit routes are never replaced");
        tx.route.clear();
        tx.amount += 1;
        assert!(resolve_empty_route(&mut tx, ids[0], &profiles).is_err());
        let mut amount = BigInt::from(25_000_000);
        for pair in route[1..].windows(2).rev() {
            amount = required_inbound(&profiles, pair[0], pair[1], 1, &amount).unwrap();
        }
        assert_eq!(amount, BigInt::from(25_000_075));
        // The exact authenticated row must exist; unknown recipients cannot
        // borrow another Account's capacity or fee policy.
        assert!(required_inbound(&profiles, route[1], "0xunknown", 1, &amount).is_err());
    }
}

//! Canonical cross-j Account transitions.
//!
//! The nested route/proof objects remain `CanonicalValue` so the Rust engine
//! commits exactly the TS bytes. This module validates and mutates only the
//! Account-owned fields; no parallel Rust route codec exists.

use num_bigint::BigInt;
use sha3::{Digest as _, Keccak256};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue, encode_account_state_value};

use crate::swap::{MAX_ACCOUNT_CROSS_J_SWAP_OFFERS, MAX_ACCOUNT_SWAP_OFFERS};
use crate::tx::apply_types::MutationDecision;
use crate::tx::offdelta::validate_transfer;
use crate::{
    AccountRejection, AccountReplica, Side, StateError, TokenId, TransitionError,
    ValidationRejection,
};

const MAX_FILL_RATIO: u64 = 65_535;

type Fields = Vec<(String, CanonicalValue)>;

fn reject(message: impl Into<String>) -> MutationDecision {
    MutationDecision::rejected(AccountRejection::Validation(
        ValidationRejection::AccountTx {
            message: message.into(),
        },
    ))
}

fn fields(value: &CanonicalValue) -> Result<&Fields, String> {
    match value {
        CanonicalValue::Object(fields) => Ok(fields),
        _ => Err("Cross-j transaction data must be an object".into()),
    }
}

fn get<'a>(fields: &'a Fields, key: &str) -> Option<&'a CanonicalValue> {
    fields
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value)
}

fn required<'a>(fields: &'a Fields, key: &str) -> Result<&'a CanonicalValue, String> {
    get(fields, key).ok_or_else(|| format!("Cross-j field missing: {key}"))
}

fn object<'a>(fields: &'a Fields, key: &str) -> Result<&'a Fields, String> {
    self::fields(required(fields, key)?)
}

fn string(fields: &Fields, key: &str) -> Result<String, String> {
    match required(fields, key)? {
        CanonicalValue::String(value) => Ok(value.clone()),
        _ => Err(format!("Cross-j field must be string: {key}")),
    }
}

fn optional_string(fields: &Fields, key: &str) -> Result<Option<String>, String> {
    match get(fields, key) {
        None => Ok(None),
        Some(CanonicalValue::String(value)) => Ok(Some(value.clone())),
        _ => Err(format!("Cross-j field must be string: {key}")),
    }
}

fn bigint(fields: &Fields, key: &str) -> Result<BigInt, String> {
    match required(fields, key)? {
        CanonicalValue::BigInt(value) => Ok(value.clone()),
        _ => Err(format!("Cross-j field must be bigint: {key}")),
    }
}

fn number_u64(value: &CanonicalNumber, key: &str) -> Result<u64, String> {
    let text = value.as_str();
    if text.contains(['.', 'e', 'E']) {
        return Err(format!("Cross-j field must be integer: {key}"));
    }
    text.parse()
        .map_err(|_| format!("Cross-j field out of range: {key}"))
}

fn uint(fields: &Fields, key: &str) -> Result<u64, String> {
    match required(fields, key)? {
        CanonicalValue::Number(value) => number_u64(value, key),
        _ => Err(format!("Cross-j field must be number: {key}")),
    }
}

fn number(value: u64) -> Result<CanonicalValue, String> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|error| error.to_string())
}

fn hex_bytes(value: &str, expected: usize, field: &str) -> Result<Vec<u8>, String> {
    let payload = value
        .strip_prefix("0x")
        .filter(|payload| payload.len() == expected * 2)
        .ok_or_else(|| format!("Invalid {field}"))?;
    hex::decode(payload).map_err(|_| format!("Invalid {field}"))
}

fn variable_hex_bytes(value: &str, field: &str) -> Result<Vec<u8>, String> {
    let payload = value
        .strip_prefix("0x")
        .filter(|payload| payload.len() % 2 == 0)
        .ok_or_else(|| format!("Invalid {field}"))?;
    hex::decode(payload).map_err(|_| format!("Invalid {field}"))
}

fn normalized_hex(value: &str, expected: usize, field: &str) -> Result<String, String> {
    hex_bytes(value, expected, field)?;
    Ok(value.to_ascii_lowercase())
}

fn abs(value: &BigInt) -> BigInt {
    if value < &BigInt::from(0) {
        -value
    } else {
        value.clone()
    }
}

fn map_state(error: StateError) -> TransitionError {
    TransitionError::InvalidState(error)
}

fn binding_from_route(route: &Fields, leg: &str) -> Result<CanonicalValue, String> {
    let mut binding = vec![
        (
            "orderId".into(),
            CanonicalValue::String(string(route, "orderId")?),
        ),
        (
            "routeHash".into(),
            CanonicalValue::String(string(route, "routeHash")?),
        ),
        ("leg".into(), CanonicalValue::String(leg.into())),
    ];
    if let Some(value) = get(route, "status") {
        binding.push(("status".into(), value.clone()));
    }
    Ok(CanonicalValue::Object(binding))
}

fn same_canonical_object(left: &CanonicalValue, right: &CanonicalValue) -> Result<bool, String> {
    // Object insertion order is not protocol state: the canonical Account
    // encoder sorts keys in the same UTF-16 order as TypeScript. Comparing
    // `CanonicalValue::Object` directly would reject an exact wire value just
    // because its decoder emitted `[leg, orderId, ...]` while this module built
    // `[orderId, routeHash, leg, ...]`.
    let encode = |value: &CanonicalValue| {
        encode_account_state_value(value)
            .map_err(|error| format!("Cross-j canonical binding encode failed: {error}"))
    };
    Ok(encode(left)? == encode(right)?)
}

pub(crate) fn cross_market_source_is_base(
    policy: &crate::SwapMarketPolicy,
    route: &CanonicalValue,
) -> Result<bool, String> {
    let route = fields(route)?;
    let source = object(route, "source")?;
    let target = object(route, "target")?;
    let source_token =
        u32::try_from(uint(source, "tokenId")?).map_err(|_| "Cross-j source token invalid")?;
    let target_token =
        u32::try_from(uint(target, "tokenId")?).map_err(|_| "Cross-j target token invalid")?;
    let source_liquid = policy.liquid(source_token);
    let target_liquid = policy.liquid(target_token);
    if source_liquid != target_liquid {
        return Ok(!source_liquid);
    }
    let source_key = format!(
        "{}:{}",
        string(source, "jurisdiction")?.trim().to_ascii_lowercase(),
        source_token,
    );
    let target_key = format!(
        "{}:{}",
        string(target, "jurisdiction")?.trim().to_ascii_lowercase(),
        target_token,
    );
    Ok(source_key <= target_key)
}

pub(crate) fn validate_swap_offer_route(
    account: &AccountReplica,
    route: &CanonicalValue,
    give_token_id: u32,
    want_token_id: u32,
    proposer: Side,
) -> Result<Side, String> {
    let route = fields(route)?;
    if string(route, "status")? != "resting"
        || get(route, "sourcePull").is_none()
        || get(route, "targetPull").is_none()
    {
        return Err("Cross-j swap must be prepared before entering the book".into());
    }
    normalized_hex(&string(route, "routeHash")?, 32, "cross-j routeHash")?;
    let identity = account.state().identity();
    let left = identity.left().as_hex().to_ascii_lowercase();
    let right = identity.right().as_hex().to_ascii_lowercase();
    let maker = string(route, "makerEntityId")?.to_ascii_lowercase();
    let maker_side = if maker == left {
        Side::Left
    } else if maker == right {
        Side::Right
    } else {
        return Err("Cross-j swap maker is not an Account endpoint".into());
    };
    let proposer_id = identity.entity(proposer).as_hex().to_ascii_lowercase();
    let source = object(route, "source")?;
    if proposer_id != maker
        && proposer_id != string(source, "counterpartyEntityId")?.to_ascii_lowercase()
    {
        return Err("Cross-j swap proposer must be the maker or source hub".into());
    }
    if uint(source, "tokenId")? != u64::from(give_token_id)
        || uint(object(route, "target")?, "tokenId")? != u64::from(want_token_id)
    {
        return Err("Cross-j offer token route mismatch".into());
    }
    let source_pull = object(route, "sourcePull")?;
    let pull_id = string(source_pull, "pullId")?;
    let paired = account
        .state()
        .pull(&pull_id)
        .ok_or("Cross-j swap offer requires paired source pull lock")?;
    let paired = fields(paired)?;
    if uint(paired, "tokenId")? != uint(source_pull, "tokenId")?
        || uint(paired, "tokenId")? != u64::from(give_token_id)
        || bigint(paired, "amount")? != bigint(source_pull, "signedAmount")?
        || !string(paired, "fullHash")?.eq_ignore_ascii_case(&string(source_pull, "fullHash")?)
        || !string(paired, "partialRoot")?
            .eq_ignore_ascii_case(&string(source_pull, "partialRoot")?)
    {
        return Err("Cross-j swap offer source pull mismatch".into());
    }
    let binding = object(paired, "crossJurisdiction")?;
    if string(binding, "leg")? != "source"
        || string(binding, "orderId")? != string(route, "orderId")?
        || !string(binding, "routeHash")?.eq_ignore_ascii_case(&string(route, "routeHash")?)
    {
        return Err("Cross-j source pull binding mismatch".into());
    }
    Ok(maker_side)
}

fn route_leg<'a>(route: &'a Fields, leg: &str) -> Result<&'a Fields, String> {
    object(route, leg)
}

fn pull_leg<'a>(route: &'a Fields, leg: &str) -> Result<&'a Fields, String> {
    object(
        route,
        if leg == "source" {
            "sourcePull"
        } else {
            "targetPull"
        },
    )
}

fn live_cross_pull_count(account: &AccountReplica) -> usize {
    account
        .state()
        .pulls()
        .filter(|(_, pull)| {
            fields(pull)
                .ok()
                .is_some_and(|value| get(value, "crossJurisdiction").is_some())
        })
        .count()
}

pub(crate) fn apply_pull_lock(
    account: &mut AccountReplica,
    data: &CanonicalValue,
    _proposer: Side,
    current_height: u64,
    current_timestamp: u64,
) -> Result<MutationDecision, TransitionError> {
    let data = match fields(data) {
        Ok(value) => value,
        Err(error) => return Ok(reject(error)),
    };
    let admitted = (|| -> Result<_, String> {
        let pull_id = string(data, "pullId")?;
        if pull_id.is_empty() || pull_id.contains(':') {
            return Err("Invalid pullId".into());
        }
        if account.state().pull(&pull_id).is_some() {
            return Err(format!("Pull {pull_id} already exists"));
        }
        if account.state().pull_count() >= MAX_ACCOUNT_SWAP_OFFERS {
            return Err("Too many open pulls".into());
        }
        if live_cross_pull_count(account) >= MAX_ACCOUNT_CROSS_J_SWAP_OFFERS {
            return Err(format!(
                "Too many open cross-j pulls: max {MAX_ACCOUNT_CROSS_J_SWAP_OFFERS}"
            ));
        }
        let token_raw = uint(data, "tokenId")?;
        let token_id = TokenId::new(u32::try_from(token_raw).map_err(|_| "Invalid pull tokenId")?)
            .map_err(|_| "Invalid pull tokenId")?;
        let amount = bigint(data, "amount")?;
        if amount == BigInt::from(0) {
            return Err("Pull amount must be non-zero".into());
        }
        let absolute = abs(&amount);
        let maximum = (BigInt::from(1) << 256_usize) - 1_u8;
        if absolute > maximum {
            return Err(format!("Pull amount out of bounds: {absolute}"));
        }
        let full_hash =
            normalized_hex(&string(data, "fullHash")?, 32, "pull hashladder commitment")?;
        let partial_root = normalized_hex(
            &string(data, "partialRoot")?,
            32,
            "pull hashladder commitment",
        )?;
        let binding = object(data, "crossJurisdiction")?;
        let route = object(data, "crossJurisdictionRoute")?;
        // TS `validateCrossJurisdictionPullRoute`: the supplied route must be
        // its own canonical form (defaults filled, routeHash recomputed).
        let supplied = CanonicalValue::Object(route.to_vec());
        let canonical = crate::cross_j_route::canonical_route(&supplied)
            .map_err(|detail| format!("Cross-j pull route invalid: {detail}"))?;
        if !same_canonical_object(&canonical, &supplied)? {
            return Err("Cross-j pull route is not canonical".into());
        }
        if string(route, "status")? != "resting" || string(binding, "status")? != "resting" {
            return Err("Cross-j pull opening must be a zero-progress resting route".into());
        }
        for key in [
            "sourceCloseProof",
            "targetCloseProof",
            "fillSeq",
            "cumulativeFillRatio",
            "fillNumerator",
            "fillDenominator",
            "filledSourceAmount",
            "filledTargetAmount",
            "executionSourceAmount",
            "executionTargetAmount",
            "pendingClearRequestedAt",
            "claimedRatio",
            "sourceClaimed",
            "targetClaimed",
            "settledAt",
        ] {
            if get(route, key).is_some() {
                return Err("Cross-j pull opening must be a zero-progress resting route".into());
            }
        }
        let leg = string(binding, "leg")?;
        if leg != "source" && leg != "target" {
            return Err("Cross-j pull binding leg invalid".into());
        }
        if !same_canonical_object(
            &CanonicalValue::Object(binding.clone()),
            &binding_from_route(route, &leg)?,
        )? {
            return Err("Cross-j pull binding does not match route".into());
        }
        let route_pull = pull_leg(route, &leg)?;
        if string(route_pull, "pullId")? != pull_id
            || uint(route_pull, "tokenId")? != token_raw
            || bigint(route_pull, "signedAmount")? != amount
            || normalized_hex(&string(route_pull, "fullHash")?, 32, "route fullHash")? != full_hash
            || normalized_hex(&string(route_pull, "partialRoot")?, 32, "route partialRoot")?
                != partial_root
        {
            return Err("Cross-j pull terms do not match route".into());
        }
        let route_leg = route_leg(route, &leg)?;
        let left = account
            .state()
            .identity()
            .left()
            .as_hex()
            .to_ascii_lowercase();
        let right = account
            .state()
            .identity()
            .right()
            .as_hex()
            .to_ascii_lowercase();
        let entity = string(route_leg, "entityId")?.to_ascii_lowercase();
        let counterparty = string(route_leg, "counterpartyEntityId")?.to_ascii_lowercase();
        if !matches!(entity.as_str(), value if value == left || value == right)
            || !matches!(counterparty.as_str(), value if value == left || value == right)
        {
            return Err("Cross-j pull Account endpoints do not match route leg".into());
        }
        let domain = account.state().identity().domain();
        let expected_stack = format!(
            "stack:{}:{}",
            domain.chain_id(),
            domain.depository_address().as_hex().to_ascii_lowercase(),
        );
        if string(route_leg, "jurisdiction")?.to_ascii_lowercase() != expected_stack {
            return Err("Cross-j pull jurisdiction does not match Account domain".into());
        }
        let order_id = string(binding, "orderId")?;
        for (_, existing) in account.state().pulls() {
            let existing = fields(existing)?;
            let existing_binding =
                get(existing, "crossJurisdiction").and_then(|value| fields(value).ok());
            if existing_binding
                .is_some_and(|value| string(value, "orderId").ok().as_deref() == Some(&order_id))
            {
                continue;
            }
            if optional_string(existing, "fullHash")?
                .is_some_and(|value| value.eq_ignore_ascii_case(&full_hash))
                || optional_string(existing, "partialRoot")?
                    .is_some_and(|value| value.eq_ignore_ascii_case(&partial_root))
            {
                return Err(format!(
                    "Pull hash material collides with live pull {}",
                    string(existing, "pullId")?
                ));
            }
        }
        let loser = if amount < BigInt::from(0) {
            Side::Left
        } else {
            Side::Right
        };
        let mut delta = account
            .state()
            .delta_or_zero(token_id)
            .map_err(|error| error.to_string())?;
        let available = delta.perspective(loser).out_capacity;
        if absolute > available {
            return Err(format!(
                "Insufficient pull capacity: need {absolute}, available {available}"
            ));
        }
        let projected = crate::tx::dispute_gas_budget::projected_charge(
            account,
            usize::from(account.state().delta(token_id).is_none()),
            1,
        )
        .map_err(|error| error.to_string())?;
        if let Some(error) = crate::tx::dispute_gas_budget::budget_error(projected) {
            return Err(error);
        }
        delta
            .add_hold(loser, &absolute)
            .map_err(|error| error.message())?;
        let event_amount = amount.clone();
        let pull = CanonicalValue::Object(vec![
            ("pullId".into(), CanonicalValue::String(pull_id.clone())),
            ("tokenId".into(), number(token_raw)?),
            ("amount".into(), CanonicalValue::BigInt(amount)),
            ("claimedRatio".into(), number(0)?),
            (
                "claimedAmount".into(),
                CanonicalValue::BigInt(BigInt::from(0)),
            ),
            ("fullHash".into(), CanonicalValue::String(full_hash)),
            ("partialRoot".into(), CanonicalValue::String(partial_root)),
            (
                "crossJurisdiction".into(),
                CanonicalValue::Object(binding.clone()),
            ),
            ("createdHeight".into(), number(current_height)?),
            ("createdTimestamp".into(), number(current_timestamp)?),
        ]);
        Ok((pull_id, token_raw, event_amount, delta, pull))
    })();
    let (pull_id, token_id, amount, delta, pull) = match admitted {
        Ok(value) => value,
        Err(error) => return Ok(reject(error)),
    };
    account.state_mut().put_delta(delta).map_err(map_state)?;
    account
        .state_mut()
        .put_pull(&pull_id, pull)
        .map_err(map_state)?;
    Ok(MutationDecision::applied(vec![format!(
        "🪝 Pull locked: {}... amount {amount} token{token_id}",
        crate::state::identity::js_prefix(&pull_id, 8),
    )]))
}

pub(crate) fn decode_ladder_ratio(binary: &str) -> Result<u64, String> {
    let bytes = variable_hex_bytes(binary, "cross-j close binary")?;
    match bytes.len() {
        0 => Ok(0),
        32 => Ok(MAX_FILL_RATIO),
        130 => {
            let ratio = u64::from(u16::from_be_bytes([bytes[0], bytes[1]]));
            if ratio == 0 || ratio == MAX_FILL_RATIO {
                return Err("HASHLADDER_PARTIAL_BINARY_RATIO_INVALID".into());
            }
            Ok(ratio)
        }
        length => Err(format!("HASHLADDER_BINARY_INVALID_LENGTH:{length}")),
    }
}

pub(crate) fn verify_ladder(
    full_hash: &str,
    partial_root: &str,
    binary: &str,
) -> Result<u64, String> {
    let bytes = variable_hex_bytes(binary, "cross-j close binary")?;
    if bytes.is_empty() {
        return Ok(0);
    }
    if bytes.len() == 32 {
        let actual: [u8; 32] = Keccak256::digest(&bytes).into();
        if format!("0x{}", hex::encode(actual)) != normalized_hex(full_hash, 32, "fullHash")? {
            return Err("HASHLADDER_BINARY_VERIFY_FAILED".into());
        }
        return Ok(MAX_FILL_RATIO);
    }
    if bytes.len() != 130 {
        return Err(format!("HASHLADDER_BINARY_INVALID_LENGTH:{}", bytes.len()));
    }
    let ratio = u64::from(u16::from_be_bytes([bytes[0], bytes[1]]));
    if ratio == 0 || ratio == MAX_FILL_RATIO {
        return Err("HASHLADDER_PARTIAL_BINARY_RATIO_INVALID".into());
    }
    let nibbles = [
        (ratio >> 12) & 15,
        (ratio >> 8) & 15,
        (ratio >> 4) & 15,
        ratio & 15,
    ];
    let mut roots = Vec::with_capacity(128);
    for (index, steps) in nibbles.into_iter().enumerate() {
        let mut node = bytes[2 + index * 32..2 + (index + 1) * 32].to_vec();
        for _ in 0..steps {
            node = Keccak256::digest(&node).to_vec();
        }
        roots.extend_from_slice(&node);
    }
    let actual: [u8; 32] = Keccak256::digest(&roots).into();
    if format!("0x{}", hex::encode(actual)) != normalized_hex(partial_root, 32, "partialRoot")? {
        return Err("HASHLADDER_BINARY_VERIFY_FAILED".into());
    }
    Ok(ratio)
}

pub(crate) fn apply_pull_close(
    account: &mut AccountReplica,
    data: &CanonicalValue,
    proposer: Side,
) -> Result<MutationDecision, TransitionError> {
    let data = match fields(data) {
        Ok(value) => value,
        Err(error) => return Ok(reject(error)),
    };
    let pull_id = match string(data, "pullId") {
        Ok(value) => value,
        Err(error) => return Ok(reject(error)),
    };
    let Some(pull_value) = account.state().pull(&pull_id).cloned() else {
        return Ok(reject(format!(
            "Cross-j close pull missing: {}...",
            crate::state::identity::js_prefix(&pull_id, 8),
        )));
    };
    let outcome = (|| -> Result<_, String> {
        let pull = fields(&pull_value)?;
        let binding = object(pull, "crossJurisdiction")?;
        let proof = object(data, "proof")?;
        let leg = string(binding, "leg")?;
        let order_id = string(binding, "orderId")?;
        let ratio = uint(proof, "fillRatio")?;
        if ratio > MAX_FILL_RATIO {
            return Err(format!(
                "Cross-j close proof ratio out of uint16 range: {ratio}"
            ));
        }
        let close_mode = string(proof, "closeMode")?;
        if !matches!(
            close_mode.as_str(),
            "full" | "partial_cancel_remainder" | "pure_cancel"
        ) {
            return Err(format!("Cross-j close mode invalid: {close_mode}"));
        }
        let proof_order_id = string(proof, "orderId")?;
        if proof_order_id != order_id {
            return Err(format!(
                "Cross-j close proof mismatch: order {proof_order_id} != {order_id}"
            ));
        }
        let proof_route_hash = string(proof, "routeHash")?;
        let binding_route_hash = string(binding, "routeHash")?;
        if !proof_route_hash.eq_ignore_ascii_case(&binding_route_hash) {
            return Err(format!(
                "Cross-j close proof mismatch: routeHash {proof_route_hash} != {binding_route_hash}"
            ));
        }
        let expected_pull = string(
            proof,
            if leg == "source" {
                "sourcePullId"
            } else {
                "targetPullId"
            },
        )?;
        if expected_pull != pull_id {
            return Err(format!(
                "Cross-j close proof mismatch: {leg} pull {expected_pull} != {pull_id}"
            ));
        }
        // Fill progress is Hub-internal and never reaches this binding, so the
        // close amounts are validated exactly as the chain settles a dispute at
        // this ratio: proportional amount*ratio/65535 on this leg. Mirrors
        // `crossProofMatchesBinding` in core/account/tx/handlers/settlement/pull.ts.
        let amount = bigint(pull, "amount")?;
        let absolute = abs(&amount);
        let expected_leg_amount = if ratio >= MAX_FILL_RATIO {
            absolute.clone()
        } else {
            &absolute * BigInt::from(ratio) / BigInt::from(MAX_FILL_RATIO)
        };
        let cumulative = bigint(
            proof,
            if leg == "source" {
                "cumulativeSourceAmount"
            } else {
                "cumulativeTargetAmount"
            },
        )?;
        if cumulative != expected_leg_amount {
            return Err(format!(
                "Cross-j close proof mismatch: {leg} amount {cumulative} != chain-proportional {expected_leg_amount}"
            ));
        }
        let binary = string(data, "binary")?;
        let actual_binary_hash: [u8; 32] =
            Keccak256::digest(variable_hex_bytes(&binary, "cross-j close binary")?).into();
        if format!("0x{}", hex::encode(actual_binary_hash))
            != normalized_hex(&string(proof, "binaryHash")?, 32, "binaryHash")?
        {
            return Err("Cross-j close binary hash mismatch".into());
        }
        if verify_ladder(
            &string(pull, "fullHash")?,
            &string(pull, "partialRoot")?,
            &binary,
        )? != ratio
        {
            return Err("Cross-j close ratio mismatch".into());
        }
        let beneficiary = if amount > BigInt::from(0) {
            Side::Left
        } else {
            Side::Right
        };
        let hub = if leg == "source" {
            beneficiary
        } else {
            beneficiary.opposite()
        };
        if proposer != hub {
            return Err(format!("Only the {leg} Hub can close cross-j pull"));
        }
        // The ratio remains the dispute ceiling. A cooperative buyer close may
        // spend less at the book execution price, like same-J swap_resolve.
        let execution = get(data, "executionAmount")
            .map(|_| bigint(data, "executionAmount"))
            .transpose()?;
        if let Some(executed) = &execution {
            let offer = account
                .state()
                .swap_offer(&order_id)
                .and_then(|offer| offer.cross_jurisdiction())
                .ok_or("Cross-j cooperative execution offer missing")?;
            if leg != "source"
                || crate::cross_j_route::canonical_source_is_base(offer)?
                || executed <= &BigInt::from(0)
                || executed > &cumulative
            {
                return Err("Cross-j cooperative execution amount invalid".into());
            }
        }
        let applied = execution.unwrap_or_else(|| cumulative.clone());
        let remaining = &absolute - &applied;
        let payer = beneficiary.opposite();
        let token_id = TokenId::new(
            u32::try_from(uint(pull, "tokenId")?).map_err(|_| "Invalid pull tokenId")?,
        )
        .map_err(|error| error.to_string())?;
        let mut delta = account
            .state()
            .delta_or_zero(token_id)
            .map_err(|error| error.to_string())?;
        let release = absolute.clone();
        if delta.hold(payer) < &release {
            return Err(format!(
                "Pull {} hold underflow",
                if payer == Side::Left { "left" } else { "right" }
            ));
        }
        delta
            .release_hold(payer, &release)
            .map_err(|error| error.to_string())?;
        Ok((delta, ratio, applied, remaining, leg, order_id, payer))
    })();
    let (mut delta, ratio, applied, remaining, leg, order_id, payer) = match outcome {
        Ok(value) => value,
        Err(error) => return Ok(reject(error)),
    };
    if let Err(rejection) = validate_transfer(account, &delta, payer, &applied, None) {
        return Ok(MutationDecision::rejected(AccountRejection::Validation(
            rejection,
        )));
    }
    if applied > BigInt::from(0) {
        delta.apply_transfer(payer, &applied)?;
    }
    account.state_mut().put_delta(delta).map_err(map_state)?;
    account
        .state_mut()
        .remove_pull(&pull_id)
        .map_err(map_state)?;
    let mut events = vec![format!(
        "🪝 Cross-j pull closed: {}... ratio {ratio}/{MAX_FILL_RATIO} claimed {applied} released {remaining}",
        crate::state::identity::js_prefix(&pull_id, 8),
    )];
    // The source offer is bound to this pull; the close is the only Account tx
    // that retires it (fill progress never touches the Account offer).
    let bound_offer = (leg == "source")
        .then(|| account.state().swap_offer(&order_id))
        .flatten()
        .is_some_and(|offer| offer.cross_jurisdiction().is_some());
    if bound_offer {
        account
            .state_mut()
            .remove_swap_offer(&order_id)
            .map_err(map_state)?;
        events.push(format!(
            "🌉 Cross-j offer {} closed with pull",
            crate::state::identity::js_prefix(&order_id, 8),
        ));
    }
    Ok(MutationDecision::applied(events))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        AccountDisputeConfig, AccountDomain, AccountExecutionContext, AccountIdentity,
        AccountState, AccountTx, AccountVerdict, Delta, DepositoryAddress, EntityId,
        SequentialAccountEngine, SwapOffer, WatchSeed,
    };

    fn entity(byte: u8) -> EntityId {
        EntityId::parse(&format!("0x{}", format!("{byte:02x}").repeat(32))).expect("entity")
    }

    fn text(value: impl Into<String>) -> CanonicalValue {
        CanonicalValue::String(value.into())
    }

    fn object(entries: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
        CanonicalValue::Object(
            entries
                .into_iter()
                .map(|(key, value)| (key.to_owned(), value))
                .collect(),
        )
    }

    fn replica() -> AccountReplica {
        let identity = AccountIdentity::new(
            AccountDomain::new(
                31_337,
                DepositoryAddress::parse(&format!("0x{}", "88".repeat(20))).expect("address"),
            )
            .expect("domain"),
            entity(0x11),
            entity(0x22),
            WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("seed"),
        )
        .expect("identity");
        let delta = Delta::new(
            TokenId::new(1).expect("token"),
            100.into(),
            0.into(),
            0.into(),
            0.into(),
            0.into(),
            0.into(),
            0.into(),
            0.into(),
            0.into(),
        )
        .expect("delta");
        AccountReplica::new(
            entity(0x11),
            AccountState::new(
                identity,
                AccountDisputeConfig::new(10, 10).expect("config"),
                vec![delta],
            )
            .expect("state"),
        )
        .expect("replica")
    }

    fn lock_route() -> CanonicalValue {
        lock_route_with_amount(10.into())
    }

    fn lock_route_with_amount(amount: BigInt) -> CanonicalValue {
        let full_hash = format!("0x{}", "bb".repeat(32));
        let partial_root = format!("0x{}", "cc".repeat(32));
        let source = object(vec![
            (
                "jurisdiction",
                text(format!("stack:31337:0x{}", "88".repeat(20))),
            ),
            ("entityId", text(entity(0x11).as_hex())),
            ("counterpartyEntityId", text(entity(0x22).as_hex())),
            ("tokenId", number(1).expect("number")),
            ("amount", CanonicalValue::BigInt(abs(&amount))),
        ]);
        let target = object(vec![
            (
                "jurisdiction",
                text(format!("stack:31338:0x{}", "77".repeat(20))),
            ),
            ("entityId", text(entity(0x33).as_hex())),
            ("counterpartyEntityId", text(entity(0x44).as_hex())),
            ("tokenId", number(2).expect("number")),
            ("amount", CanonicalValue::BigInt(20.into())),
        ]);
        let source_pull = object(vec![
            ("pullId", text("pull-1")),
            ("tokenId", number(1).expect("number")),
            ("amount", CanonicalValue::BigInt(abs(&amount))),
            ("signedAmount", CanonicalValue::BigInt(amount)),
            ("fullHash", text(full_hash.clone())),
            ("partialRoot", text(partial_root.clone())),
        ]);
        let target_pull = object(vec![
            ("pullId", text("pull-2")),
            ("tokenId", number(2).expect("number")),
            ("amount", CanonicalValue::BigInt(20.into())),
            ("signedAmount", CanonicalValue::BigInt(20.into())),
            ("fullHash", text(full_hash.clone())),
            ("partialRoot", text(partial_root.clone())),
        ]);
        let dispute = || {
            object(vec![
                ("leftResponseSeconds", number(10).expect("number")),
                ("rightResponseSeconds", number(10).expect("number")),
            ])
        };
        // The Account layer admits only the canonical route (TS parity).
        crate::cross_j_route::canonical_route(&object(vec![
            ("orderId", text("order-1")),
            ("source", source),
            ("target", target),
            ("sourcePull", source_pull),
            ("targetPull", target_pull),
            ("sourceDisputeConfig", dispute()),
            ("targetDisputeConfig", dispute()),
            ("status", text("resting")),
        ]))
        .expect("canonical route")
    }

    fn lock_route_hash() -> String {
        string(fields(&lock_route()).expect("route"), "routeHash").expect("route hash")
    }

    fn lock_tx() -> AccountTx {
        lock_tx_with_amount(10.into())
    }

    fn lock_tx_with_amount(amount: BigInt) -> AccountTx {
        let full_hash = format!("0x{}", "bb".repeat(32));
        let partial_root = format!("0x{}", "cc".repeat(32));
        let route = lock_route_with_amount(amount.clone());
        let route_hash = string(fields(&route).expect("route"), "routeHash").expect("route hash");
        let binding = object(vec![
            ("orderId", text("order-1")),
            ("routeHash", text(route_hash)),
            ("leg", text("source")),
            ("status", text("resting")),
        ]);
        AccountTx::CrossPullLock {
            data: object(vec![
                ("pullId", text("pull-1")),
                ("tokenId", number(1).expect("number")),
                ("amount", CanonicalValue::BigInt(amount)),
                ("fullHash", text(full_hash)),
                ("partialRoot", text(partial_root)),
                ("crossJurisdiction", binding),
                ("crossJurisdictionRoute", route),
            ]),
        }
    }

    /// One source-leg pull bound to its resting cross-J offer, with the
    /// payer (right) hold the lock would have placed.
    fn bound_offer_replica() -> AccountReplica {
        let base = replica();
        let identity = base.state().identity().clone();
        let route_hash =
            string(fields(&lock_route()).expect("route"), "routeHash").expect("route hash");
        let source_pull = object(vec![
            ("pullId", text("pull-1")),
            ("tokenId", number(1).expect("number")),
            ("amount", CanonicalValue::BigInt(100.into())),
            ("signedAmount", CanonicalValue::BigInt(100.into())),
            ("fullHash", text(format!("0x{}", "bb".repeat(32)))),
            ("partialRoot", text(format!("0x{}", "cc".repeat(32)))),
        ]);
        let route = object(vec![
            ("orderId", text("order-1")),
            ("routeHash", text(route_hash.clone())),
            ("makerEntityId", text(entity(0x11).as_hex())),
            (
                "source",
                object(vec![
                    (
                        "jurisdiction",
                        text(format!("stack:31337:0x{}", "88".repeat(20))),
                    ),
                    ("entityId", text(entity(0x11).as_hex())),
                    ("counterpartyEntityId", text(entity(0x22).as_hex())),
                    ("tokenId", number(1).expect("number")),
                    ("amount", CanonicalValue::BigInt(100.into())),
                ]),
            ),
            (
                "target",
                object(vec![
                    (
                        "jurisdiction",
                        text(format!("stack:31338:0x{}", "77".repeat(20))),
                    ),
                    ("entityId", text(entity(0x33).as_hex())),
                    ("counterpartyEntityId", text(entity(0x44).as_hex())),
                    ("tokenId", number(2).expect("number")),
                    ("amount", CanonicalValue::BigInt(200.into())),
                ]),
            ),
            ("sourcePull", source_pull.clone()),
            ("status", text("resting")),
        ]);
        let binding = object(vec![
            ("orderId", text("order-1")),
            ("routeHash", text(route_hash)),
            ("leg", text("source")),
            ("status", text("resting")),
        ]);
        let pull = object(vec![
            ("pullId", text("pull-1")),
            ("tokenId", number(1).expect("number")),
            ("amount", CanonicalValue::BigInt(100.into())),
            ("claimedRatio", number(0).expect("number")),
            ("claimedAmount", CanonicalValue::BigInt(0.into())),
            ("fullHash", text(format!("0x{}", "bb".repeat(32)))),
            ("partialRoot", text(format!("0x{}", "cc".repeat(32)))),
            ("crossJurisdiction", binding),
            ("createdHeight", number(1).expect("number")),
            ("createdTimestamp", number(1).expect("number")),
        ]);
        let mut offer = SwapOffer::new(
            "order-1".into(),
            1,
            6,
            100.into(),
            2,
            6,
            200.into(),
            0.into(),
            200.into(),
            20_000.into(),
            None,
            true,
            1,
        );
        offer.set_cross_jurisdiction(Some(route));
        let state = AccountState::restore_full(crate::AccountStateSeed {
            identity,
            dispute_config: AccountDisputeConfig::new(10, 10).expect("config"),
            deltas: vec![
                Delta::new(
                    TokenId::new(1).expect("token"),
                    100.into(),
                    0.into(),
                    0.into(),
                    0.into(),
                    0.into(),
                    0.into(),
                    0.into(),
                    0.into(),
                    100.into(),
                )
                .expect("delta"),
            ],
            locks: Vec::new(),
            j_nonce: 0,
            last_finalized_j_height: 0,
            carried: Default::default(),
            rebalance_fee_policies: Vec::new(),
            swap_offers: vec![offer],
            lending_intents: Vec::new(),
            pulls: vec![("pull-1".into(), pull)],
            settlement_workspace: None,
        })
        .expect("bound offer state");
        AccountReplica::new(entity(0x11), state).expect("bound offer replica")
    }

    #[test]
    fn cross_pull_lock_gas_budget_rejects_without_hold_and_defers_the_paired_opening() {
        let mut account = replica();
        for id in 2..=10 {
            account = SequentialAccountEngine::apply(
                &account,
                Side::Left,
                &AccountTx::AddDelta {
                    token_id: TokenId::new(id).expect("token"),
                },
            )
            .expect("transition")
            .committed()
            .expect("admitted row");
        }
        let root = account.state().deltas_root();
        let tx = lock_tx_with_amount(10.into());
        let result = SequentialAccountEngine::apply_with_context(
            &account,
            Side::Left,
            &tx,
            &AccountExecutionContext::new(1_000, 1_000, 10, 7, 10),
        )
        .expect("transition");
        let crate::AccountVerdict::Rejected(reason) = result.verdict() else {
            panic!("over-budget pull admitted")
        };
        assert_eq!(
            reason.message(),
            "ACCOUNT_DISPUTE_GAS_BUDGET_EXCEEDED:5100000/5000000"
        );
        assert!(crate::tx::dispute_gas_budget::opening_deferred(
            &tx,
            &reason.message()
        ));
        assert!(result.candidate().is_none());
        assert!(result.outputs().is_empty());
        assert_eq!(account.state().deltas_root(), root);
        assert_eq!(account.state().pull_count(), 0);
    }

    #[test]
    fn cross_pull_lock_full_uint256_for_both_payers_builds_dispute_proof() {
        let maximum = (BigInt::from(1) << 256_usize) - 1_u8;
        let context = AccountExecutionContext::new(1_000, 1_000, 10, 7, 10);
        for amount in [-&maximum, maximum.clone()] {
            let original = replica();
            let delta = Delta::new(
                TokenId::new(1).expect("token"),
                0.into(),
                0.into(),
                0.into(),
                maximum.clone(),
                maximum.clone(),
                0.into(),
                0.into(),
                0.into(),
                0.into(),
            )
            .expect("full asset credit");
            let state = AccountState::new(
                original.state().identity().clone(),
                AccountDisputeConfig::new(10, 10).expect("config"),
                vec![delta],
            )
            .expect("state");
            let base = AccountReplica::new(entity(0x11), state).expect("replica");
            let locked = SequentialAccountEngine::apply_with_context(
                &base,
                Side::Left,
                &lock_tx_with_amount(amount.clone()),
                &context,
            )
            .expect("transition")
            .committed()
            .expect("full magnitude pull");
            let payer = if amount < BigInt::from(0) {
                Side::Left
            } else {
                Side::Right
            };
            assert_eq!(
                locked
                    .state()
                    .delta(TokenId::new(1).expect("token"))
                    .expect("delta")
                    .hold(payer),
                &maximum
            );
            assert_eq!(locked.state().pull_count(), 1);
            crate::build_dispute_proof(&locked, &[0x77; 20], 1)
                .expect("full magnitude recovery proof");
        }
    }

    #[test]
    fn cross_pull_lock_zero_and_unrepresentable_magnitude_reject_atomically() {
        let boundary = BigInt::from(1) << 256_usize;
        for amount in [BigInt::from(0), -&boundary, boundary] {
            let base = replica();
            let before = base.state().deltas_root();
            let mut transaction = lock_tx();
            let AccountTx::CrossPullLock {
                data: CanonicalValue::Object(data),
            } = &mut transaction
            else {
                panic!("pull fixture")
            };
            *data
                .iter_mut()
                .find_map(|(name, value)| (name == "amount").then_some(value))
                .expect("amount") = CanonicalValue::BigInt(amount.clone());
            let result = SequentialAccountEngine::apply_with_context(
                &base,
                Side::Left,
                &transaction,
                &AccountExecutionContext::new(1_000, 1_000, 10, 7, 10),
            )
            .expect("typed rejection");
            let AccountVerdict::Rejected(reason) = result.verdict() else {
                panic!("invalid amount accepted")
            };
            assert_eq!(
                reason.message(),
                if amount == BigInt::from(0) {
                    "Pull amount must be non-zero".to_string()
                } else {
                    format!("Pull amount out of bounds: {}", abs(&amount))
                }
            );
            assert!(result.candidate().is_none());
            assert!(result.outputs().is_empty());
            assert!(result.events().is_empty());
            assert_eq!(base.state().deltas_root(), before);
        }
    }

    #[test]
    fn cross_j_r6_h43_pull_created_height_uses_jurisdiction_height() {
        for frame_j_height in [24, 34] {
            // The signed frame owns the pull's clock. Account height and the
            // receiver's enforcement clock must not change its committed leaf.
            let context = AccountExecutionContext::new(1_000, 2_000, 99, 4, frame_j_height);
            let locked = SequentialAccountEngine::apply_with_context(
                &replica(),
                Side::Left,
                &lock_tx(),
                &context,
            )
            .expect("lock")
            .committed()
            .expect("lock candidate");
            let pull =
                fields(locked.state().pull("pull-1").expect("stored pull")).expect("pull fields");
            assert_eq!(uint(pull, "createdHeight").expect("height"), frame_j_height);
            assert_eq!(uint(pull, "createdTimestamp").expect("timestamp"), 1_000);
        }
    }

    #[test]
    fn pull_lock_and_zero_close_move_one_hold_and_persist_no_duplicate_body() {
        let context = AccountExecutionContext::new(1_000, 1_000, 10, 7, 10);
        let locked = SequentialAccountEngine::apply_with_context(
            &replica(),
            Side::Left,
            &lock_tx(),
            &context,
        )
        .expect("lock")
        .committed()
        .expect("lock candidate");
        assert_eq!(locked.state().pull_count(), 1);
        assert_eq!(
            locked
                .state()
                .delta(TokenId::new(1).expect("token"))
                .expect("delta")
                .hold(Side::Right),
            &BigInt::from(10),
        );

        let close = AccountTx::CrossPullClose {
            data: object(vec![
                ("pullId", text("pull-1")),
                ("binary", text("0x")),
                (
                    "proof",
                    object(vec![
                        ("orderId", text("order-1")),
                        ("routeHash", text(lock_route_hash())),
                        ("sourcePullId", text("pull-1")),
                        ("targetPullId", text("target-pull")),
                        ("fillRatio", number(0).expect("number")),
                        ("cumulativeSourceAmount", CanonicalValue::BigInt(0.into())),
                        ("cumulativeTargetAmount", CanonicalValue::BigInt(0.into())),
                        (
                            "binaryHash",
                            text(
                                "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
                            ),
                        ),
                        ("closeMode", text("pure_cancel")),
                    ]),
                ),
            ]),
        };
        let closed = SequentialAccountEngine::apply(&locked, Side::Left, &close).expect("close");
        assert_eq!(closed.verdict(), &AccountVerdict::Applied);
        let closed = closed.committed().expect("close candidate");
        assert_eq!(closed.state().pull_count(), 0);
        assert_eq!(
            closed
                .state()
                .delta(TokenId::new(1).expect("token"))
                .expect("delta")
                .hold(Side::Right),
            &BigInt::from(0),
        );
    }

    #[test]
    fn pull_lock_accepts_canonically_equal_reordered_binding_fields() {
        let mut transaction = lock_tx();
        let AccountTx::CrossPullLock {
            data: CanonicalValue::Object(data),
        } = &mut transaction
        else {
            panic!("cross-J lock fixture")
        };
        let binding = data
            .iter_mut()
            .find_map(|(key, value)| (key == "crossJurisdiction").then_some(value))
            .expect("cross-J binding");
        let CanonicalValue::Object(fields) = binding else {
            panic!("cross-J binding object")
        };
        fields.reverse();

        let context = AccountExecutionContext::new(1_000, 1_000, 10, 7, 10);
        let applied = SequentialAccountEngine::apply_with_context(
            &replica(),
            Side::Left,
            &transaction,
            &context,
        )
        .expect("reordered canonical binding");
        assert_eq!(applied.verdict(), &AccountVerdict::Applied);
        assert_eq!(
            applied.candidate().expect("candidate").state().pull_count(),
            1
        );
    }

    #[test]
    fn source_close_retires_bound_offer_as_swap_cancelled() {
        let close = AccountTx::CrossPullClose {
            data: object(vec![
                ("pullId", text("pull-1")),
                ("binary", text("0x")),
                (
                    "proof",
                    object(vec![
                        ("orderId", text("order-1")),
                        ("routeHash", text(lock_route_hash())),
                        ("sourcePullId", text("pull-1")),
                        ("targetPullId", text("target-pull")),
                        ("fillRatio", number(0).expect("number")),
                        ("cumulativeSourceAmount", CanonicalValue::BigInt(0.into())),
                        ("cumulativeTargetAmount", CanonicalValue::BigInt(0.into())),
                        (
                            "binaryHash",
                            text(
                                "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
                            ),
                        ),
                        ("closeMode", text("pure_cancel")),
                    ]),
                ),
            ]),
        };
        let applied = SequentialAccountEngine::apply(&bound_offer_replica(), Side::Left, &close)
            .expect("source close");
        assert_eq!(applied.verdict(), &AccountVerdict::Applied);
        assert!(applied.outputs().is_empty());
        let closed = applied.committed().expect("close candidate");
        assert_eq!(closed.state().pull_count(), 0);
        assert_eq!(closed.state().swap_offer_count(), 0);
        assert_eq!(
            closed
                .state()
                .delta(TokenId::new(1).expect("token"))
                .expect("delta")
                .hold(Side::Right),
            &BigInt::from(0),
        );
    }

    #[test]
    fn source_close_rejects_amount_that_is_not_chain_proportional() {
        let close = AccountTx::CrossPullClose {
            data: object(vec![
                ("pullId", text("pull-1")),
                ("binary", text("0x")),
                (
                    "proof",
                    object(vec![
                        ("orderId", text("order-1")),
                        ("routeHash", text(lock_route_hash())),
                        ("sourcePullId", text("pull-1")),
                        ("targetPullId", text("target-pull")),
                        ("fillRatio", number(0).expect("number")),
                        ("cumulativeSourceAmount", CanonicalValue::BigInt(1.into())),
                        ("cumulativeTargetAmount", CanonicalValue::BigInt(0.into())),
                        (
                            "binaryHash",
                            text(
                                "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
                            ),
                        ),
                        ("closeMode", text("pure_cancel")),
                    ]),
                ),
            ]),
        };
        let applied = SequentialAccountEngine::apply(&bound_offer_replica(), Side::Left, &close)
            .expect("source close");
        assert!(matches!(
            applied.verdict(),
            AccountVerdict::Rejected(AccountRejection::Validation(
                ValidationRejection::AccountTx { message }
            )) if message == "Cross-j close proof mismatch: source amount 1 != chain-proportional 0"
        ));
    }
}

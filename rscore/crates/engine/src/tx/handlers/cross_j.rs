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
use crate::{
    AccountOutput, AccountRejection, AccountReplica, Side, StateError, TokenId, TransitionError,
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

fn optional_bigint(fields: &Fields, key: &str) -> Result<Option<BigInt>, String> {
    match get(fields, key) {
        None => Ok(None),
        Some(CanonicalValue::BigInt(value)) => Ok(Some(value.clone())),
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

fn optional_uint(fields: &Fields, key: &str) -> Result<Option<u64>, String> {
    match get(fields, key) {
        None => Ok(None),
        Some(CanonicalValue::Number(value)) => number_u64(value, key).map(Some),
        _ => Err(format!("Cross-j field must be number: {key}")),
    }
}

fn optional_bool(fields: &Fields, key: &str) -> Result<Option<bool>, String> {
    match get(fields, key) {
        None => Ok(None),
        Some(CanonicalValue::Bool(value)) => Ok(Some(*value)),
        _ => Err(format!("Cross-j field must be boolean: {key}")),
    }
}

fn set(fields: &mut Fields, key: &str, value: CanonicalValue) {
    if let Some((_, current)) = fields.iter_mut().find(|(name, _)| name == key) {
        *current = value;
    } else {
        fields.push((key.to_owned(), value));
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
    for key in [
        "sourceCloseProof",
        "status",
        "fillSeq",
        "cumulativeFillRatio",
        "fillNumerator",
        "fillDenominator",
        "claimedRatio",
        "filledSourceAmount",
        "filledTargetAmount",
        "sourceClaimed",
        "targetClaimed",
        "clearingPolicy",
    ] {
        if let Some(value) = get(route, key) {
            binding.push((key.into(), value.clone()));
        }
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
        if absolute < BigInt::from(1) || absolute > ((BigInt::from(1) << 128) - 1) {
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
            "priceImprovementSourceAmount",
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
        delta
            .add_hold(loser, &absolute)
            .map_err(|error| error.to_string())?;
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

fn committed_ratio(fields: &Fields) -> Result<u64, String> {
    let numerator = optional_bigint(fields, "fillNumerator")?;
    let denominator = optional_bigint(fields, "fillDenominator")?;
    if numerator.is_none() && denominator.is_none() {
        let coarse = optional_uint(fields, "cumulativeFillRatio")?
            .unwrap_or(0)
            .max(optional_uint(fields, "claimedRatio")?.unwrap_or(0));
        return if coarse == 0 {
            Ok(0)
        } else {
            Err("CROSS_J_EXACT_FILL_RATIO_REQUIRED".into())
        };
    }
    let numerator = numerator.ok_or("CROSS_J_EXACT_FILL_RATIO_INCOMPLETE")?;
    let denominator = denominator.ok_or("CROSS_J_EXACT_FILL_RATIO_INCOMPLETE")?;
    if denominator <= BigInt::from(0) || numerator < BigInt::from(0) || numerator > denominator {
        return Err("CROSS_J_EXACT_FILL_RATIO_INVALID".into());
    }
    let derived = if numerator <= BigInt::from(0) {
        0
    } else if numerator >= denominator {
        MAX_FILL_RATIO
    } else {
        let max = BigInt::from(MAX_FILL_RATIO);
        u64::try_from((&numerator * &max + &denominator - 1) / &denominator)
            .map_err(|_| "CROSS_J_EXACT_FILL_RATIO_INVALID")?
    };
    for key in ["cumulativeFillRatio", "claimedRatio"] {
        if let Some(value) = optional_uint(fields, key)?
            && value.min(MAX_FILL_RATIO) != derived
        {
            return Err("CROSS_J_COARSE_EXACT_RATIO_MISMATCH".into());
        }
    }
    Ok(derived)
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
        return Ok(MutationDecision::applied(vec![format!(
            "🪝 Cross-j pull close ignored: {}... already closed",
            crate::state::identity::js_prefix(&pull_id, 8),
        )]));
    };
    let outcome = (|| -> Result<_, String> {
        let pull = fields(&pull_value)?;
        let binding = object(pull, "crossJurisdiction")?;
        let proof = object(data, "proof")?;
        let leg = string(binding, "leg")?;
        if string(proof, "orderId")? != string(binding, "orderId")?
            || !string(proof, "routeHash")?.eq_ignore_ascii_case(&string(binding, "routeHash")?)
        {
            return Err("Cross-j close proof mismatch: route".into());
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
            return Err("Cross-j close proof mismatch: pull".into());
        }
        let ratio = uint(proof, "fillRatio")?;
        if ratio > MAX_FILL_RATIO {
            return Err("Cross-j close proof ratio out of uint16 range".into());
        }
        let binding_ratio = committed_ratio(binding)?;
        if ratio < binding_ratio {
            return Err("Cross-j close proof rolls back informed ratio".into());
        }
        if ratio == binding_ratio {
            for (proof_key, binding_keys) in [
                (
                    "cumulativeSourceAmount",
                    ["filledSourceAmount", "sourceClaimed"],
                ),
                (
                    "cumulativeTargetAmount",
                    ["filledTargetAmount", "targetClaimed"],
                ),
            ] {
                let actual = bigint(proof, proof_key)?;
                for key in binding_keys {
                    if let Some(expected) = optional_bigint(binding, key)?
                        && actual != expected
                    {
                        return Err(format!("Cross-j close {proof_key} does not match {key}"));
                    }
                }
            }
        }
        if let Some(source_proof) = get(binding, "sourceCloseProof")
            && source_proof != required(data, "proof")?
        {
            return Err("Cross-j close proof mismatch: source close proof mismatch".into());
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
        let amount = bigint(pull, "amount")?;
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
        let absolute = abs(&amount);
        let previous_ratio = optional_uint(pull, "claimedRatio")?
            .unwrap_or(0)
            .min(MAX_FILL_RATIO);
        if ratio < previous_ratio {
            return Err("Cross-j close ratio regression".into());
        }
        let previous_claimed = optional_bigint(pull, "claimedAmount")?.unwrap_or_else(|| {
            &absolute * BigInt::from(previous_ratio) / BigInt::from(MAX_FILL_RATIO)
        });
        let cumulative = bigint(
            proof,
            if leg == "source" {
                "cumulativeSourceAmount"
            } else {
                "cumulativeTargetAmount"
            },
        )?;
        if cumulative < previous_claimed || cumulative > absolute {
            return Err("Cross-j close amount invalid".into());
        }
        if ratio > binding_ratio {
            let expected = if ratio == MAX_FILL_RATIO {
                absolute.clone()
            } else {
                &absolute * BigInt::from(ratio) / BigInt::from(MAX_FILL_RATIO)
            };
            if cumulative != expected {
                return Err("Cross-j close amount is not chain-proportional".into());
            }
        }
        let applied = &cumulative - &previous_claimed;
        let remaining = &absolute - &cumulative;
        let payer = beneficiary.opposite();
        let token_id = TokenId::new(
            u32::try_from(uint(pull, "tokenId")?).map_err(|_| "Invalid pull tokenId")?,
        )
        .map_err(|error| error.to_string())?;
        let mut delta = account
            .state()
            .delta_or_zero(token_id)
            .map_err(|error| error.to_string())?;
        let release = &applied + &remaining;
        if delta.hold(payer) < &release {
            return Err("Pull hold underflow".into());
        }
        delta
            .release_hold(payer, &release)
            .map_err(|error| error.to_string())?;
        if applied > BigInt::from(0) {
            delta
                .apply_transfer(payer, &applied)
                .map_err(|error| error.to_string())?;
        }
        Ok((delta, ratio, applied, remaining))
    })();
    let (delta, ratio, applied, remaining) = match outcome {
        Ok(value) => value,
        Err(error) => return Ok(reject(error)),
    };
    account.state_mut().put_delta(delta).map_err(map_state)?;
    account
        .state_mut()
        .remove_pull(&pull_id)
        .map_err(map_state)?;
    Ok(MutationDecision::applied(vec![format!(
        "🪝 Cross-j pull closed: {}... ratio {ratio}/{MAX_FILL_RATIO} claimed {applied} released {remaining}",
        crate::state::identity::js_prefix(&pull_id, 8),
    )]))
}

pub(crate) fn apply_pull_progress(
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
    let Some(mut pull_value) = account.state().pull(&pull_id).cloned() else {
        return Ok(reject(format!("Cross-j target pull {pull_id} not found")));
    };
    let result = (|| -> Result<(String, u64), String> {
        let fill = object(data, "fill")?;
        let pull = fields(&pull_value)?;
        let mut binding_value = required(pull, "crossJurisdiction")?.clone();
        let binding = fields(&binding_value)?;
        if string(binding, "leg")? != "target" {
            return Err("Cross-j progress requires target pull".into());
        }
        let offer_id = string(fill, "offerId")?;
        if offer_id != string(binding, "orderId")?
            || !string(fill, "routeHash")?.eq_ignore_ascii_case(&string(binding, "routeHash")?)
        {
            return Err("Cross-j progress route mismatch".into());
        }
        let amount = bigint(pull, "amount")?;
        let beneficiary = if amount > BigInt::from(0) {
            Side::Left
        } else {
            Side::Right
        };
        if proposer == beneficiary {
            return Err("Only the target Hub can advance cross-j pull".into());
        }
        let current_seq = optional_uint(binding, "fillSeq")?.unwrap_or(0);
        let next_seq = uint(fill, "fillSeq")?;
        let previous_seq = uint(fill, "previousFillSeq")?;
        let kind = string(fill, "ackKind")?;
        let cancelling = kind == "cancel";
        if kind != "fill" && !cancelling {
            return Err("Cross-j progress kind invalid".into());
        }
        if cancelling && optional_bool(fill, "cancelRemainder")? != Some(true) {
            return Err("Cross-j cancel progress must clear remainder".into());
        }
        if previous_seq != current_seq
            || (!cancelling && next_seq != current_seq + 1)
            || (cancelling && next_seq != current_seq)
        {
            return Err("Cross-j progress sequence mismatch".into());
        }
        let next_ratio = committed_ratio(fill)?;
        let current_ratio = committed_ratio(binding)?;
        let prior_source = optional_bigint(binding, "filledSourceAmount")?.unwrap_or_default();
        let prior_target = optional_bigint(binding, "filledTargetAmount")?.unwrap_or_default();
        let next_source = bigint(fill, "cumulativeSourceAmount")?;
        let next_target = bigint(fill, "cumulativeTargetAmount")?;
        let source_increment = bigint(fill, "incrementalSourceAmount")?;
        let target_increment = bigint(fill, "incrementalTargetAmount")?;
        if next_source < prior_source
            || next_target < prior_target
            || source_increment != &next_source - &prior_source
            || target_increment != &next_target - &prior_target
            || next_target > abs(&amount)
            || (!cancelling
                && (next_ratio <= current_ratio
                    || source_increment <= BigInt::from(0)
                    || target_increment <= BigInt::from(0)))
            || (cancelling
                && (next_ratio != current_ratio
                    || source_increment != BigInt::from(0)
                    || target_increment != BigInt::from(0)))
        {
            return Err("Cross-j progress amounts mismatch".into());
        }
        let binding = match &mut binding_value {
            CanonicalValue::Object(value) => value,
            _ => unreachable!(),
        };
        set(binding, "fillSeq", number(next_seq)?);
        set(binding, "cumulativeFillRatio", number(next_ratio)?);
        for key in ["fillNumerator", "fillDenominator"] {
            if let Some(value) = get(fill, key) {
                set(binding, key, value.clone());
            }
        }
        set(
            binding,
            "filledSourceAmount",
            CanonicalValue::BigInt(next_source),
        );
        set(
            binding,
            "filledTargetAmount",
            CanonicalValue::BigInt(next_target),
        );
        set(
            binding,
            "status",
            CanonicalValue::String(
                if cancelling || next_ratio == MAX_FILL_RATIO {
                    "clear_requested"
                } else {
                    "partially_filled"
                }
                .into(),
            ),
        );
        if cancelling {
            set(
                binding,
                "clearingPolicy",
                CanonicalValue::String("cancel_and_clear".into()),
            );
        }
        let pull = match &mut pull_value {
            CanonicalValue::Object(value) => value,
            _ => unreachable!(),
        };
        set(pull, "crossJurisdiction", binding_value);
        Ok((offer_id, next_ratio))
    })();
    let (offer_id, next_ratio) = match result {
        Ok(value) => value,
        Err(error) => return Ok(reject(error)),
    };
    account
        .state_mut()
        .put_pull(&pull_id, pull_value)
        .map_err(map_state)?;
    Ok(MutationDecision::applied(vec![format!(
        "🌉 Cross-j target progress {} {next_ratio}/{MAX_FILL_RATIO}",
        crate::state::identity::js_prefix(&offer_id, 8),
    )]))
}

fn route_fill_amounts(route: &Fields) -> Result<(BigInt, BigInt, BigInt, BigInt, u64), String> {
    let source_total = bigint(object(route, "source")?, "amount")?;
    let target_total = bigint(object(route, "target")?, "amount")?;
    let ratio = committed_ratio(route)?;
    let numerator = optional_bigint(route, "fillNumerator")?.unwrap_or_default();
    let denominator = optional_bigint(route, "fillDenominator")?.unwrap_or_else(|| BigInt::from(1));
    let source = if numerator >= denominator {
        source_total.clone()
    } else {
        &source_total * &numerator / &denominator
    };
    let target = if numerator >= denominator {
        target_total.clone()
    } else {
        &target_total * &numerator / &denominator
    };
    for (key, expected) in [
        ("filledSourceAmount", &source),
        ("sourceClaimed", &source),
        ("filledTargetAmount", &target),
        ("targetClaimed", &target),
    ] {
        if let Some(value) = optional_bigint(route, key)?
            && &value != expected
        {
            return Err("CROSS_J_COMMITTED_AMOUNT_MISMATCH".into());
        }
    }
    Ok((source_total, target_total, source, target, ratio))
}

fn sync_source_pull(account: &mut AccountReplica, route: &Fields) -> Result<(), TransitionError> {
    let Ok(source_pull) = object(route, "sourcePull") else {
        return Ok(());
    };
    let pull_id = string(source_pull, "pullId")
        .map_err(|message| map_state(StateError::AccountStateRoot(message)))?;
    let Some(mut pull) = account.state().pull(&pull_id).cloned() else {
        return Ok(());
    };
    let binding = binding_from_route(route, "source")
        .map_err(|message| map_state(StateError::AccountStateRoot(message)))?;
    let pull_fields = match &mut pull {
        CanonicalValue::Object(value) => value,
        _ => {
            return Err(map_state(StateError::AccountStateRoot(
                "CROSS_J_PULL_OBJECT".into(),
            )));
        }
    };
    set(pull_fields, "crossJurisdiction", binding);
    account
        .state_mut()
        .put_pull(&pull_id, pull)
        .map_err(map_state)
}

pub(crate) fn apply_swap_fill_ack(
    account: &mut AccountReplica,
    data: &CanonicalValue,
    proposer: Side,
    timestamp: u64,
) -> Result<MutationDecision, TransitionError> {
    let data = match fields(data) {
        Ok(value) => value,
        Err(error) => return Ok(reject(error)),
    };
    let offer_id = match string(data, "offerId") {
        Ok(value) => value,
        Err(error) => return Ok(reject(error)),
    };
    let Some(mut offer) = account.state().swap_offer(&offer_id).cloned() else {
        return Ok(reject(format!("Offer {offer_id} not found")));
    };
    let result = (|| -> Result<_, String> {
        if optional_string(data, "priceImprovementMode")?
            .as_deref()
            .is_some_and(|value| value != "source_savings")
        {
            return Err("CROSS_J_PRICE_IMPROVEMENT_MODE_UNSUPPORTED".into());
        }
        let mut route_value = offer
            .cross_jurisdiction()
            .cloned()
            .ok_or_else(|| format!("Offer {offer_id} is not cross-jurisdictional"))?;
        let route = fields(&route_value)?;
        if proposer
            == if offer.maker_is_left() {
                Side::Left
            } else {
                Side::Right
            }
        {
            return Err("Only counterparty can ack cross-j fill".into());
        }
        if let Some(route_hash) = optional_string(data, "routeHash")?
            && !route_hash.eq_ignore_ascii_case(&string(route, "routeHash")?)
        {
            return Err("Cross-j route hash mismatch".into());
        }
        let (source_total, target_total, current_source, current_target, current_ratio) =
            route_fill_amounts(route)?;
        let proof_ratio = committed_ratio(data)?;
        let current_seq = optional_uint(route, "fillSeq")?.unwrap_or(0);
        if let Some(previous) = optional_uint(data, "previousFillSeq")?
            && previous != current_seq
            && !(optional_bool(data, "cancelRemainder")? == Some(true)
                && proof_ratio == current_ratio)
        {
            return Err("Cross-j previous fill seq mismatch".into());
        }
        if optional_bool(data, "cancelRemainder")? == Some(true) && proof_ratio == current_ratio {
            if bigint(data, "cumulativeSourceAmount")? != current_source
                || bigint(data, "cumulativeTargetAmount")? != current_target
            {
                return Err("Cross-j cancel amount mismatch".into());
            }
            let route = match &mut route_value {
                CanonicalValue::Object(value) => value,
                _ => unreachable!(),
            };
            set(
                route,
                "status",
                CanonicalValue::String("clear_requested".into()),
            );
            set(route, "pendingClearRequestedAt", number(timestamp)?);
            set(route, "updatedAt", number(timestamp)?);
            set(
                route,
                "clearingPolicy",
                CanonicalValue::String("cancel_and_clear".into()),
            );
            let event = format!(
                "🌉 Cross-j offer {} cancel requested at {current_ratio}/{MAX_FILL_RATIO}",
                crate::state::identity::js_prefix(&offer_id, 8),
            );
            return Ok((route_value, None, event));
        }
        let next_seq = optional_uint(data, "fillSeq")?.unwrap_or(current_seq + 1);
        if next_seq != current_seq + 1 || proof_ratio <= current_ratio {
            return Err("Cross-j fill progress invalid".into());
        }
        let numerator = bigint(data, "fillNumerator")?;
        let denominator = bigint(data, "fillDenominator")?;
        let next_source = if numerator >= denominator {
            source_total.clone()
        } else {
            &source_total * &numerator / &denominator
        };
        let next_target = if numerator >= denominator {
            target_total.clone()
        } else {
            &target_total * &numerator / &denominator
        };
        let source_increment = &next_source - &current_source;
        let target_increment = &next_target - &current_target;
        if source_increment <= BigInt::from(0) || target_increment <= BigInt::from(0) {
            return Err("Cross-j no incremental amount".into());
        }
        for (key, expected) in [
            ("cumulativeSourceAmount", &next_source),
            ("cumulativeTargetAmount", &next_target),
            ("incrementalSourceAmount", &source_increment),
            ("incrementalTargetAmount", &target_increment),
        ] {
            if let Some(value) = optional_bigint(data, key)?
                && &value != expected
            {
                return Err(format!("Cross-j {key} mismatch"));
            }
        }
        let improvement = optional_bigint(data, "priceImprovementAmount")?.unwrap_or_default();
        if improvement < BigInt::from(0) {
            return Err("Cross-j price improvement must be non-negative".into());
        }
        if improvement > BigInt::from(0) {
            let source_token = uint(object(route, "source")?, "tokenId")?;
            if optional_uint(data, "priceImprovementTokenId")? != Some(source_token) {
                return Err("Cross-j source savings token mismatch".into());
            }
        }
        let execution_source = &source_increment - &improvement;
        if execution_source <= BigInt::from(0) || target_increment <= BigInt::from(0) {
            return Err("Cross-j execution amount after improvement must be positive".into());
        }
        if optional_bigint(data, "executionSourceAmount")?
            .is_some_and(|value| value != execution_source)
            || optional_bigint(data, "executionTargetAmount")?
                .is_some_and(|value| value != target_increment)
        {
            return Err("Cross-j execution amount mismatch".into());
        }
        let route = match &mut route_value {
            CanonicalValue::Object(value) => value,
            _ => unreachable!(),
        };
        set(route, "fillSeq", number(next_seq)?);
        set(route, "cumulativeFillRatio", number(proof_ratio)?);
        set(route, "claimedRatio", number(proof_ratio)?);
        set(route, "fillNumerator", CanonicalValue::BigInt(numerator));
        set(
            route,
            "fillDenominator",
            CanonicalValue::BigInt(denominator),
        );
        set(
            route,
            "filledSourceAmount",
            CanonicalValue::BigInt(next_source.clone()),
        );
        set(
            route,
            "filledTargetAmount",
            CanonicalValue::BigInt(next_target.clone()),
        );
        set(
            route,
            "sourceClaimed",
            CanonicalValue::BigInt(next_source.clone()),
        );
        set(
            route,
            "targetClaimed",
            CanonicalValue::BigInt(next_target.clone()),
        );
        set(route, "updatedAt", number(timestamp)?);
        if improvement > BigInt::from(0) {
            let accumulated = optional_bigint(route, "priceImprovementSourceAmount")?
                .unwrap_or_default()
                + improvement;
            set(
                route,
                "priceImprovementSourceAmount",
                CanonicalValue::BigInt(accumulated),
            );
        }
        if let Some(value) = get(data, "priceTicks") {
            set(route, "priceTicks", value.clone());
        }
        if get(route, "venueId").is_none()
            && let Some(CanonicalValue::String(value)) = get(data, "pairId")
        {
            set(route, "venueId", CanonicalValue::String(value.clone()));
        }
        let source_lot = BigInt::from(10).pow(offer.give_token_decimals().saturating_sub(6));
        let target_lot = BigInt::from(10).pow(offer.want_token_decimals().saturating_sub(6));
        let remaining_source = &source_total - &next_source;
        let remaining_target = &target_total - &next_target;
        let requested_close = proof_ratio == MAX_FILL_RATIO
            || next_source >= source_total
            || next_target >= target_total
            || optional_bool(data, "cancelRemainder")? == Some(true);
        let dust_close = !requested_close
            && source_total >= source_lot
            && target_total >= target_lot
            && (remaining_source < source_lot || remaining_target < target_lot);
        let terminal = requested_close || dust_close;
        if terminal {
            set(
                route,
                "status",
                CanonicalValue::String("clear_requested".into()),
            );
            set(route, "pendingClearRequestedAt", number(timestamp)?);
            set(
                route,
                "clearingPolicy",
                CanonicalValue::String(
                    if optional_bool(data, "cancelRemainder")? == Some(true)
                        || dust_close
                        || proof_ratio < MAX_FILL_RATIO
                    {
                        "cancel_and_clear"
                    } else {
                        "full_fill"
                    }
                    .into(),
                ),
            );
            let event = if dust_close {
                format!(
                    "🌉 Cross-j offer {} closed after dust remainder",
                    crate::state::identity::js_prefix(&offer_id, 8),
                )
            } else {
                format!(
                    "🌉 Cross-j offer {} closed at {proof_ratio}/{MAX_FILL_RATIO}",
                    crate::state::identity::js_prefix(&offer_id, 8),
                )
            };
            Ok((route_value, None, event))
        } else {
            set(
                route,
                "status",
                CanonicalValue::String("partially_filled".into()),
            );
            let price = optional_bigint(route, "priceTicks")?;
            let event = format!(
                "🌉 Cross-j offer {} filled to {proof_ratio}/{MAX_FILL_RATIO}, {remaining_source} source remaining",
                crate::state::identity::js_prefix(&offer_id, 8),
            );
            Ok((
                route_value,
                Some((remaining_source, remaining_target, price)),
                event,
            ))
        }
    })();
    let (route, remainder, event) = match result {
        Ok(value) => value,
        Err(error) => return Ok(reject(error)),
    };
    let route_fields = fields(&route)
        .map_err(|message| map_state(StateError::AccountStateRoot(message)))?
        .clone();
    sync_source_pull(account, &route_fields)?;
    if let Some((give, want, price)) = remainder {
        offer.set_cross_jurisdiction(Some(route));
        offer
            .apply_cross_j_remainder(give, want, price)
            .map_err(map_state)?;
        let identity = account.state().identity().clone();
        let output = AccountOutput::SwapOfferUpsert {
            offer: Box::new(offer.snapshot(identity.left().as_hex(), identity.right().as_hex())),
        };
        account
            .state_mut()
            .put_swap_offer(offer)
            .map_err(map_state)?;
        Ok(MutationDecision::with_outputs(vec![event], vec![output]))
    } else {
        offer.set_cross_jurisdiction(Some(route));
        let maker_is_left = offer.maker_is_left();
        account
            .state_mut()
            .remove_swap_offer(&offer_id)
            .map_err(map_state)?;
        Ok(MutationDecision::with_outputs(
            vec![event],
            vec![AccountOutput::SwapOfferRemove {
                offer_id,
                maker_is_left,
            }],
        ))
    }
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

    fn lock_tx() -> AccountTx {
        let route_hash = format!("0x{}", "aa".repeat(32));
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
            ("amount", CanonicalValue::BigInt(10.into())),
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
            ("amount", CanonicalValue::BigInt(10.into())),
            ("signedAmount", CanonicalValue::BigInt(10.into())),
            ("fullHash", text(full_hash.clone())),
            ("partialRoot", text(partial_root.clone())),
        ]);
        let route = object(vec![
            ("orderId", text("order-1")),
            ("routeHash", text(route_hash.clone())),
            ("source", source),
            ("target", target),
            ("sourcePull", source_pull),
            ("status", text("resting")),
        ]);
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
                ("amount", CanonicalValue::BigInt(10.into())),
                ("fullHash", text(full_hash)),
                ("partialRoot", text(partial_root)),
                ("crossJurisdiction", binding),
                ("crossJurisdictionRoute", route),
            ]),
        }
    }

    fn fill_replica() -> AccountReplica {
        let base = replica();
        let identity = base.state().identity().clone();
        let route_hash = format!("0x{}", "aa".repeat(32));
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
            deltas: base.state().deltas().cloned().collect(),
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
        .expect("fill state");
        AccountReplica::new(entity(0x11), state).expect("fill replica")
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
                        ("routeHash", text(format!("0x{}", "aa".repeat(32)))),
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
    fn fill_ack_updates_offer_and_source_pull_from_one_exact_ratio() {
        let tx = AccountTx::CrossSwapFillAck {
            data: object(vec![
                ("offerId", text("order-1")),
                ("routeHash", text(format!("0x{}", "aa".repeat(32)))),
                ("previousFillSeq", number(0).expect("number")),
                ("fillSeq", number(1).expect("number")),
                ("incrementalSourceAmount", CanonicalValue::BigInt(50.into())),
                (
                    "incrementalTargetAmount",
                    CanonicalValue::BigInt(100.into()),
                ),
                ("cumulativeSourceAmount", CanonicalValue::BigInt(50.into())),
                ("cumulativeTargetAmount", CanonicalValue::BigInt(100.into())),
                ("cumulativeFillRatio", number(32_768).expect("number")),
                ("fillNumerator", CanonicalValue::BigInt(1.into())),
                ("fillDenominator", CanonicalValue::BigInt(2.into())),
                ("ackKind", text("fill")),
                ("executionSourceAmount", CanonicalValue::BigInt(50.into())),
                ("executionTargetAmount", CanonicalValue::BigInt(100.into())),
            ]),
        };
        let context = AccountExecutionContext::new(2_000, 2_000, 10, 2, 10);
        let applied = SequentialAccountEngine::apply_with_context(
            &fill_replica(),
            Side::Right,
            &tx,
            &context,
        )
        .expect("fill ack");
        assert_eq!(applied.verdict(), &AccountVerdict::Applied);
        assert!(matches!(
            applied.outputs(),
            [AccountOutput::SwapOfferUpsert { .. }]
        ));
        let state = applied.committed().expect("candidate");
        let offer = state.state().swap_offer("order-1").expect("remainder");
        assert_eq!(offer.give_amount(), &BigInt::from(50));
        assert_eq!(offer.want_amount(), &BigInt::from(100));
        let route = fields(offer.cross_jurisdiction().expect("route")).expect("route object");
        assert_eq!(uint(route, "fillSeq"), Ok(1));
        assert_eq!(uint(route, "cumulativeFillRatio"), Ok(32_768));
        let pull = fields(state.state().pull("pull-1").expect("pull")).expect("pull object");
        let binding = super::object(pull, "crossJurisdiction").expect("binding");
        assert_eq!(
            optional_bigint(binding, "filledSourceAmount"),
            Ok(Some(50.into()))
        );
    }

    #[test]
    fn fill_ack_applies_canonical_source_savings_price_improvement() {
        let tx = AccountTx::CrossSwapFillAck {
            data: object(vec![
                ("offerId", text("order-1")),
                ("previousFillSeq", number(0).expect("number")),
                ("fillSeq", number(1).expect("number")),
                ("incrementalSourceAmount", CanonicalValue::BigInt(50.into())),
                (
                    "incrementalTargetAmount",
                    CanonicalValue::BigInt(100.into()),
                ),
                ("cumulativeSourceAmount", CanonicalValue::BigInt(50.into())),
                ("cumulativeTargetAmount", CanonicalValue::BigInt(100.into())),
                ("cumulativeFillRatio", number(32_768).expect("number")),
                ("fillNumerator", CanonicalValue::BigInt(1.into())),
                ("fillDenominator", CanonicalValue::BigInt(2.into())),
                ("ackKind", text("fill")),
                ("priceImprovementMode", text("source_savings")),
                ("priceImprovementAmount", CanonicalValue::BigInt(5.into())),
                ("priceImprovementTokenId", number(1).expect("number")),
                ("executionSourceAmount", CanonicalValue::BigInt(45.into())),
                ("executionTargetAmount", CanonicalValue::BigInt(100.into())),
            ]),
        };
        let context = AccountExecutionContext::new(2_000, 2_000, 10, 2, 10);
        let applied = SequentialAccountEngine::apply_with_context(
            &fill_replica(),
            Side::Right,
            &tx,
            &context,
        )
        .expect("fill ack");
        assert_eq!(applied.verdict(), &AccountVerdict::Applied);
        let state = applied.committed().expect("candidate");
        let offer = state.state().swap_offer("order-1").expect("remainder");
        let route = fields(offer.cross_jurisdiction().expect("route")).expect("route object");
        assert_eq!(
            optional_bigint(route, "priceImprovementSourceAmount"),
            Ok(Some(5.into()))
        );
    }
}

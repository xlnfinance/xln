use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;
use serde_json::{Map, Value};
use thiserror::Error;
use xln_rscore_engine::{AccountDomain, DepositoryAddress, OpaqueHtlcCiphertext};
use xln_rscore_entity_kernel::{
    DeterministicContext, HtlcPreparedBinding, HtlcPreparedOutcome, OriginatedHtlcDeliveryMode,
    PairPolicy, PreparedHtlcEntry, PreparedOriginatedHtlcPayment,
};

#[path = "entity_context_json/fresh.rs"]
mod fresh;
mod policy;

pub use fresh::{
    CanonicalEntityInfraMaterializer, EntityInfraMaterializeRequest, EntityInfraMaterializer,
    FreshEntityContextError, InboundHtlcInfrastructure, MaterializedEntityInfraContext,
};
pub(crate) use policy::apply_entity_state_policy;
pub use policy::canonical_swap_market_policy;

const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EntityContextJsonError {
    #[error("RSCORE_RUNTIME_ENTITY_CONTEXT_TYPE:{0}")]
    InvalidType(String),
    #[error("RSCORE_RUNTIME_ENTITY_CONTEXT_FIELD_MISSING:{0}")]
    MissingField(String),
    #[error("RSCORE_RUNTIME_ENTITY_CONTEXT_FIELD_UNEXPECTED:{0}")]
    UnexpectedField(String),
    #[error("RSCORE_RUNTIME_ENTITY_CONTEXT_VALUE_INVALID:{0}")]
    InvalidValue(String),
    #[error("RSCORE_RUNTIME_ENTITY_CONTEXT_PAIR_DUPLICATE:{0}")]
    DuplicatePair(String),
    #[error("RSCORE_RUNTIME_ENTITY_CONTEXT_PREPARED_DUPLICATE:{0}:{1}")]
    DuplicatePrepared(String, String),
    #[error("RSCORE_RUNTIME_ENTITY_CONTEXT_ORIGINATED_DUPLICATE:{0}")]
    DuplicateOriginated(String),
}

/// Decode the exact deterministic Entity-kernel context from persisted Runtime
/// JSON. `policy` is an explicit projection, not a market lookup table:
/// `{minimumTradeSize, swapTakerFeeBps, jurisdictionId, pairPolicies}`, where
/// each policy row is `[pairId, priceStepTicks, bucketWidthTicks, midPriceTicks]`.
/// Decimal BigInts may be canonical strings or canonical `__xlnType=BigInt`
/// objects. This keeps the signed snapshot authoritative over Rust constants.
pub fn decode_entity_deterministic_context(
    policy: &Value,
    context: &Value,
) -> Result<DeterministicContext, EntityContextJsonError> {
    let mut decoded = decode_entity_deterministic_policy(policy)?;
    let (prepared_htlcs, originated_htlcs) = prepared_context(context)?;
    decoded.prepared_htlcs = prepared_htlcs;
    decoded.originated_htlcs = originated_htlcs;
    Ok(decoded)
}

/// Decode only per-frame prepared context from WAL. Financial policy is not
/// stored beside the frame: `apply_entity_group` derives it from the current
/// committed Entity state immediately before execution.
pub(crate) fn decode_entity_frame_context(
    context: &Value,
) -> Result<DeterministicContext, EntityContextJsonError> {
    let (prepared_htlcs, originated_htlcs) = prepared_context(context)?;
    Ok(DeterministicContext {
        minimum_trade_size: BigInt::from(0),
        swap_taker_fee_bps: 0,
        jurisdiction_id: None,
        pair_policies: BTreeMap::new(),
        prepared_htlcs,
        originated_htlcs,
    })
}

/// Decode the immutable policy once when the live materializer is created.
/// Per-frame HTLC preparation fills only the two context maps below; parsing
/// the same policy JSON for every Runtime frame is duplicate boundary work.
pub fn decode_entity_deterministic_policy(
    policy: &Value,
) -> Result<DeterministicContext, EntityContextJsonError> {
    let policy = object(policy, "policy")?;
    exact_keys(
        policy,
        &[
            "minimumTradeSize",
            "swapTakerFeeBps",
            "jurisdictionId",
            "pairPolicies",
        ],
        &[],
        "policy",
    )?;
    let minimum_trade_size = nonnegative_bigint(
        required(policy, "minimumTradeSize", "policy")?,
        "policy.minimumTradeSize",
    )?;
    let swap_taker_fee_bps = bounded_u16(
        required(policy, "swapTakerFeeBps", "policy")?,
        10_000,
        "policy.swapTakerFeeBps",
    )?;
    let jurisdiction_id = optional_nonempty_text(
        required(policy, "jurisdictionId", "policy")?,
        "policy.jurisdictionId",
    )?;
    let pair_policies = pair_policies(required(policy, "pairPolicies", "policy")?)?;
    Ok(DeterministicContext {
        minimum_trade_size,
        swap_taker_fee_bps,
        jurisdiction_id,
        pair_policies,
        prepared_htlcs: BTreeMap::new(),
        originated_htlcs: BTreeMap::new(),
    })
}

fn pair_policies(value: &Value) -> Result<BTreeMap<String, PairPolicy>, EntityContextJsonError> {
    let rows = array(value, "policy.pairPolicies")?;
    let mut policies = BTreeMap::new();
    for (index, value) in rows.iter().enumerate() {
        let path = format!("policy.pairPolicies[{index}]");
        let row = fixed_array(value, 4, &path)?;
        let pair_id = pair_id(&row[0], &format!("{path}.pairId"))?;
        let policy = PairPolicy {
            price_step_ticks: positive_u32(&row[1], &format!("{path}.priceStepTicks"))?,
            book_bucket_width_ticks: positive_u32(
                &row[2],
                &format!("{path}.bookBucketWidthTicks"),
            )?,
            mid_price_ticks: positive_bigint(&row[3], &format!("{path}.midPriceTicks"))?,
        };
        if policies.insert(pair_id.clone(), policy).is_some() {
            return Err(EntityContextJsonError::DuplicatePair(pair_id));
        }
    }
    Ok(policies)
}

type PreparedContextRows = (
    BTreeMap<(String, String), PreparedHtlcEntry>,
    BTreeMap<String, PreparedOriginatedHtlcPayment>,
);

fn prepared_context(value: &Value) -> Result<PreparedContextRows, EntityContextJsonError> {
    let context = object(value, "context")?;
    exact_keys(
        context,
        &[
            "version",
            "proposerReplicaId",
            "entityId",
            "proposerSignerId",
            "parentFrameHash",
            "height",
            "gossipProfiles",
            "peerAssertions",
            "htlc",
        ],
        &[],
        "context",
    )?;
    exact_version(context, "context")?;
    validate_context_identity(context)?;
    array(
        required(context, "gossipProfiles", "context")?,
        "context.gossipProfiles",
    )?;
    validate_peer_assertions(required(context, "peerAssertions", "context")?)?;
    let htlc = object(required(context, "htlc", "context")?, "context.htlc")?;
    exact_keys(
        htlc,
        &["version", "entries", "originated"],
        &[],
        "context.htlc",
    )?;
    exact_version(htlc, "context.htlc")?;
    Ok((
        prepared_entries(required(htlc, "entries", "context.htlc")?)?,
        prepared_originated(required(htlc, "originated", "context.htlc")?)?,
    ))
}

fn validate_context_identity(context: &Map<String, Value>) -> Result<(), EntityContextJsonError> {
    let entity = fixed_hex(
        required(context, "entityId", "context")?,
        32,
        "context.entityId",
    )?;
    let signer = nonempty_text(
        required(context, "proposerSignerId", "context")?,
        "context.proposerSignerId",
    )?;
    if signer != signer.trim().to_lowercase() {
        return Err(EntityContextJsonError::InvalidValue(
            "context.proposerSignerId".into(),
        ));
    }
    let replica = nonempty_text(
        required(context, "proposerReplicaId", "context")?,
        "context.proposerReplicaId",
    )?;
    if replica != format!("{entity}:{signer}") {
        return Err(EntityContextJsonError::InvalidValue(
            "context.proposerReplicaId".into(),
        ));
    }
    let parent = required(context, "parentFrameHash", "context")?;
    if parent.as_str() != Some("genesis") {
        fixed_hex(parent, 32, "context.parentFrameHash")?;
    }
    safe_u64(required(context, "height", "context")?, "context.height")?;
    Ok(())
}

fn validate_peer_assertions(value: &Value) -> Result<(), EntityContextJsonError> {
    let rows = array(value, "context.peerAssertions")?;
    let mut entities = BTreeSet::new();
    for (index, value) in rows.iter().enumerate() {
        let path = format!("context.peerAssertions[{index}]");
        let row = object(value, &path)?;
        exact_keys(row, &["entityId", "online"], &[], &path)?;
        let entity = fixed_hex(
            required(row, "entityId", &path)?,
            32,
            &format!("{path}.entityId"),
        )?;
        boolean(required(row, "online", &path)?, &format!("{path}.online"))?;
        if !entities.insert(entity) {
            return Err(EntityContextJsonError::InvalidValue(format!(
                "{path}.entityId.duplicate"
            )));
        }
    }
    Ok(())
}

fn prepared_entries(
    value: &Value,
) -> Result<BTreeMap<(String, String), PreparedHtlcEntry>, EntityContextJsonError> {
    let rows = array(value, "context.htlc.entries")?;
    let mut entries = BTreeMap::new();
    for (index, value) in rows.iter().enumerate() {
        let path = format!("context.htlc.entries[{index}]");
        let row = object(value, &path)?;
        exact_keys(row, &["binding", "outcome"], &[], &path)?;
        let binding =
            prepared_binding(required(row, "binding", &path)?, &format!("{path}.binding"))?;
        let outcome =
            prepared_outcome(required(row, "outcome", &path)?, &format!("{path}.outcome"))?;
        let key = (binding.account_frame_hash.clone(), binding.hashlock.clone());
        if entries
            .insert(key.clone(), PreparedHtlcEntry { binding, outcome })
            .is_some()
        {
            return Err(EntityContextJsonError::DuplicatePrepared(key.0, key.1));
        }
    }
    Ok(entries)
}

fn prepared_originated(
    value: &Value,
) -> Result<BTreeMap<String, PreparedOriginatedHtlcPayment>, EntityContextJsonError> {
    let rows = array(value, "context.htlc.originated")?;
    let mut payments = BTreeMap::new();
    let mut previous_hash: Option<String> = None;
    for (index, value) in rows.iter().enumerate() {
        let path = format!("context.htlc.originated[{index}]");
        let payment = prepared_originated_payment(value, &path)?;
        if previous_hash
            .as_ref()
            .is_some_and(|previous| payment.tx_hash <= *previous)
        {
            if previous_hash.as_deref() == Some(payment.tx_hash.as_str()) {
                return Err(EntityContextJsonError::DuplicateOriginated(payment.tx_hash));
            }
            return Err(EntityContextJsonError::InvalidValue(format!(
                "{path}.txHash.notSorted"
            )));
        }
        previous_hash = Some(payment.tx_hash.clone());
        if payments.insert(payment.tx_hash.clone(), payment).is_some() {
            return Err(EntityContextJsonError::InvalidValue(format!(
                "{path}.txHash.duplicate"
            )));
        }
    }
    Ok(payments)
}

fn prepared_originated_payment(
    value: &Value,
    path: &str,
) -> Result<PreparedOriginatedHtlcPayment, EntityContextJsonError> {
    let row = object(value, path)?;
    exact_keys(
        row,
        &[
            "txHash",
            "targetEntityId",
            "tokenId",
            "recipientAmount",
            "route",
            "description",
            "deliveryMode",
            "startedAtMs",
            "hashlock",
            "senderLockAmount",
            "maxSenderDebit",
            "totalFee",
            "timelock",
            "revealBeforeHeight",
            "nextHopEntityId",
            "envelope",
        ],
        &[],
        path,
    )?;
    let tx_hash = fixed_hex(
        required(row, "txHash", path)?,
        32,
        &format!("{path}.txHash"),
    )?;
    let target_entity_id = fixed_hex(
        required(row, "targetEntityId", path)?,
        32,
        &format!("{path}.targetEntityId"),
    )?;
    let next_hop_entity_id = fixed_hex(
        required(row, "nextHopEntityId", path)?,
        32,
        &format!("{path}.nextHopEntityId"),
    )?;
    let route = originated_route(required(row, "route", path)?, path)?;
    if route.last() != Some(&target_entity_id) || route.get(1) != Some(&next_hop_entity_id) {
        return Err(EntityContextJsonError::InvalidValue(format!(
            "{path}.route.binding"
        )));
    }
    let recipient_amount = positive_bigint(
        required(row, "recipientAmount", path)?,
        &format!("{path}.recipientAmount"),
    )?;
    let sender_lock_amount = positive_bigint(
        required(row, "senderLockAmount", path)?,
        &format!("{path}.senderLockAmount"),
    )?;
    let max_sender_debit = positive_bigint(
        required(row, "maxSenderDebit", path)?,
        &format!("{path}.maxSenderDebit"),
    )?;
    let total_fee = nonnegative_bigint(
        required(row, "totalFee", path)?,
        &format!("{path}.totalFee"),
    )?;
    if sender_lock_amount < recipient_amount
        || max_sender_debit < sender_lock_amount
        || total_fee != &sender_lock_amount - &recipient_amount
    {
        return Err(EntityContextJsonError::InvalidValue(format!(
            "{path}.economics"
        )));
    }
    let delivery_mode = match text(
        required(row, "deliveryMode", path)?,
        &format!("{path}.deliveryMode"),
    )? {
        "instant" => OriginatedHtlcDeliveryMode::Instant,
        "async" => OriginatedHtlcDeliveryMode::Async,
        _ => {
            return Err(EntityContextJsonError::InvalidValue(format!(
                "{path}.deliveryMode"
            )));
        }
    };
    let started_at_ms = positive_safe_u64(
        required(row, "startedAtMs", path)?,
        &format!("{path}.startedAtMs"),
    )?;
    let reveal_before_height = positive_safe_u64(
        required(row, "revealBeforeHeight", path)?,
        &format!("{path}.revealBeforeHeight"),
    )?;
    let description = text(
        required(row, "description", path)?,
        &format!("{path}.description"),
    )?;
    if description.len() > 256 {
        return Err(EntityContextJsonError::InvalidValue(format!(
            "{path}.description"
        )));
    }
    let envelope_path = format!("{path}.envelope");
    let envelope = object(required(row, "envelope", path)?, &envelope_path)?;
    exact_keys(envelope, &["version", "ciphertext"], &[], &envelope_path)?;
    let envelope = OpaqueHtlcCiphertext::parse(
        text(
            required(envelope, "version", &envelope_path)?,
            &format!("{envelope_path}.version"),
        )?,
        text(
            required(envelope, "ciphertext", &envelope_path)?,
            &format!("{envelope_path}.ciphertext"),
        )?,
    )
    .map_err(|_| EntityContextJsonError::InvalidValue(envelope_path))?;
    Ok(PreparedOriginatedHtlcPayment {
        tx_hash,
        target_entity_id,
        token_id: bounded_u16(
            required(row, "tokenId", path)?,
            u16::MAX,
            &format!("{path}.tokenId"),
        )?,
        recipient_amount,
        route,
        description: description.to_string(),
        delivery_mode,
        started_at_ms,
        hashlock: fixed_hex(
            required(row, "hashlock", path)?,
            32,
            &format!("{path}.hashlock"),
        )?,
        sender_lock_amount,
        max_sender_debit,
        total_fee,
        timelock: positive_bigint(
            required(row, "timelock", path)?,
            &format!("{path}.timelock"),
        )?,
        reveal_before_height,
        next_hop_entity_id,
        envelope,
    })
}

fn originated_route(value: &Value, path: &str) -> Result<Vec<String>, EntityContextJsonError> {
    let values = array(value, &format!("{path}.route"))?;
    if !(2..=101).contains(&values.len()) {
        return Err(EntityContextJsonError::InvalidValue(format!(
            "{path}.route"
        )));
    }
    let route = values
        .iter()
        .enumerate()
        .map(|(index, value)| fixed_hex(value, 32, &format!("{path}.route[{index}]")))
        .collect::<Result<Vec<_>, _>>()?;
    let source = &route[0];
    let target = &route[route.len() - 1];
    if source == target {
        let intermediates = &route[1..route.len() - 1];
        let unique = intermediates.iter().collect::<BTreeSet<_>>();
        if intermediates.len() < 2
            || unique.len() != intermediates.len()
            || intermediates.iter().any(|entity| entity == source)
        {
            return Err(EntityContextJsonError::InvalidValue(format!(
                "{path}.route.loop"
            )));
        }
    } else if route.iter().collect::<BTreeSet<_>>().len() != route.len() {
        return Err(EntityContextJsonError::InvalidValue(format!(
            "{path}.route.loop"
        )));
    }
    Ok(route)
}

fn prepared_binding(
    value: &Value,
    path: &str,
) -> Result<HtlcPreparedBinding, EntityContextJsonError> {
    let row = object(value, path)?;
    exact_keys(
        row,
        &[
            "fromEntityId",
            "toEntityId",
            "domain",
            "accountFrameHash",
            "accountHeight",
            "envelopeHash",
            "hashlock",
            "tokenId",
            "amount",
            "timelock",
            "revealBeforeHeight",
        ],
        &[],
        path,
    )?;
    Ok(HtlcPreparedBinding {
        from_entity_id: fixed_hex(
            required(row, "fromEntityId", path)?,
            32,
            &format!("{path}.fromEntityId"),
        )?,
        to_entity_id: fixed_hex(
            required(row, "toEntityId", path)?,
            32,
            &format!("{path}.toEntityId"),
        )?,
        domain: account_domain(required(row, "domain", path)?, &format!("{path}.domain"))?,
        account_frame_hash: fixed_hex(
            required(row, "accountFrameHash", path)?,
            32,
            &format!("{path}.accountFrameHash"),
        )?,
        account_height: safe_u64(
            required(row, "accountHeight", path)?,
            &format!("{path}.accountHeight"),
        )?,
        envelope_hash: fixed_hex(
            required(row, "envelopeHash", path)?,
            32,
            &format!("{path}.envelopeHash"),
        )?,
        hashlock: fixed_hex(
            required(row, "hashlock", path)?,
            32,
            &format!("{path}.hashlock"),
        )?,
        token_id: bounded_u16(
            required(row, "tokenId", path)?,
            u16::MAX,
            &format!("{path}.tokenId"),
        )?,
        amount: nonnegative_bigint(required(row, "amount", path)?, &format!("{path}.amount"))?,
        timelock: nonnegative_bigint(
            required(row, "timelock", path)?,
            &format!("{path}.timelock"),
        )?,
        reveal_before_height: safe_u64(
            required(row, "revealBeforeHeight", path)?,
            &format!("{path}.revealBeforeHeight"),
        )?,
    })
}

fn prepared_outcome(
    value: &Value,
    path: &str,
) -> Result<HtlcPreparedOutcome, EntityContextJsonError> {
    let row = object(value, path)?;
    let kind = nonempty_text(required(row, "kind", path)?, &format!("{path}.kind"))?;
    match kind {
        "reject" => reject_outcome(row, path),
        "final" => final_outcome(row, path),
        "forward" => forward_outcome(row, path),
        _ => Err(EntityContextJsonError::InvalidValue(format!("{path}.kind"))),
    }
}

fn reject_outcome(
    row: &Map<String, Value>,
    path: &str,
) -> Result<HtlcPreparedOutcome, EntityContextJsonError> {
    exact_keys(row, &["kind", "reason"], &[], path)?;
    let reason = nonempty_text(required(row, "reason", path)?, &format!("{path}.reason"))?;
    const REASONS: &[&str] = &[
        "ciphertext_invalid",
        "decrypt_failed",
        "next_hop_account_missing",
        "next_hop_offline",
        "insufficient_capacity",
        "fee_below_policy",
        "deadline_unsafe",
    ];
    if !REASONS.contains(&reason) {
        return Err(EntityContextJsonError::InvalidValue(format!(
            "{path}.reason"
        )));
    }
    Ok(HtlcPreparedOutcome::Reject {
        reason: reason.into(),
    })
}

fn final_outcome(
    row: &Map<String, Value>,
    path: &str,
) -> Result<HtlcPreparedOutcome, EntityContextJsonError> {
    exact_keys(
        row,
        &["kind", "secret"],
        &["description", "startedAtMs"],
        path,
    )?;
    let description = row
        .get("description")
        .map(|value| text(value, &format!("{path}.description")).map(str::to_string))
        .transpose()?;
    if description.as_ref().is_some_and(|value| value.len() > 256) {
        return Err(EntityContextJsonError::InvalidValue(format!(
            "{path}.description"
        )));
    }
    Ok(HtlcPreparedOutcome::Final {
        secret: fixed_hex(
            required(row, "secret", path)?,
            32,
            &format!("{path}.secret"),
        )?,
        description,
        started_at_ms: optional_safe_u64(row.get("startedAtMs"), &format!("{path}.startedAtMs"))?,
    })
}

fn forward_outcome(
    row: &Map<String, Value>,
    path: &str,
) -> Result<HtlcPreparedOutcome, EntityContextJsonError> {
    exact_keys(
        row,
        &["kind", "nextHopEntityId", "forwardAmount", "innerEnvelope"],
        &[],
        path,
    )?;
    let envelope_path = format!("{path}.innerEnvelope");
    let envelope = object(required(row, "innerEnvelope", path)?, &envelope_path)?;
    exact_keys(envelope, &["version", "ciphertext"], &[], &envelope_path)?;
    let version = text(
        required(envelope, "version", &envelope_path)?,
        &format!("{envelope_path}.version"),
    )?;
    let ciphertext = text(
        required(envelope, "ciphertext", &envelope_path)?,
        &format!("{envelope_path}.ciphertext"),
    )?;
    let inner_envelope = OpaqueHtlcCiphertext::parse(version, ciphertext)
        .map_err(|_| EntityContextJsonError::InvalidValue(envelope_path))?;
    Ok(HtlcPreparedOutcome::Forward {
        next_hop_entity_id: fixed_hex(
            required(row, "nextHopEntityId", path)?,
            32,
            &format!("{path}.nextHopEntityId"),
        )?,
        forward_amount: nonnegative_bigint(
            required(row, "forwardAmount", path)?,
            &format!("{path}.forwardAmount"),
        )?,
        inner_envelope,
    })
}

fn account_domain(value: &Value, path: &str) -> Result<AccountDomain, EntityContextJsonError> {
    let row = object(value, path)?;
    exact_keys(row, &["chainId", "depositoryAddress"], &[], path)?;
    let chain_id = safe_u64(required(row, "chainId", path)?, &format!("{path}.chainId"))?;
    let address = text(
        required(row, "depositoryAddress", path)?,
        &format!("{path}.depositoryAddress"),
    )?;
    let address = DepositoryAddress::parse(address)
        .map_err(|_| EntityContextJsonError::InvalidValue(format!("{path}.depositoryAddress")))?;
    AccountDomain::new(chain_id, address)
        .map_err(|_| EntityContextJsonError::InvalidValue(path.into()))
}

fn object<'a>(
    value: &'a Value,
    path: &str,
) -> Result<&'a Map<String, Value>, EntityContextJsonError> {
    value
        .as_object()
        .ok_or_else(|| EntityContextJsonError::InvalidType(path.into()))
}

fn array<'a>(value: &'a Value, path: &str) -> Result<&'a [Value], EntityContextJsonError> {
    value
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| EntityContextJsonError::InvalidType(path.into()))
}

fn fixed_array<'a>(
    value: &'a Value,
    length: usize,
    path: &str,
) -> Result<&'a [Value], EntityContextJsonError> {
    let values = array(value, path)?;
    if values.len() != length {
        return Err(EntityContextJsonError::InvalidValue(format!(
            "{path}.arity"
        )));
    }
    Ok(values)
}

fn required<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    path: &str,
) -> Result<&'a Value, EntityContextJsonError> {
    object
        .get(field)
        .ok_or_else(|| EntityContextJsonError::MissingField(format!("{path}.{field}")))
}

fn exact_keys(
    object: &Map<String, Value>,
    required: &[&str],
    optional: &[&str],
    path: &str,
) -> Result<(), EntityContextJsonError> {
    for field in required {
        required_field(object, field, path)?;
    }
    for field in object.keys() {
        if !required.contains(&field.as_str()) && !optional.contains(&field.as_str()) {
            return Err(EntityContextJsonError::UnexpectedField(format!(
                "{path}.{field}"
            )));
        }
    }
    Ok(())
}

fn required_field(
    object: &Map<String, Value>,
    field: &str,
    path: &str,
) -> Result<(), EntityContextJsonError> {
    if object.contains_key(field) {
        Ok(())
    } else {
        Err(EntityContextJsonError::MissingField(format!(
            "{path}.{field}"
        )))
    }
}

fn exact_version(object: &Map<String, Value>, path: &str) -> Result<(), EntityContextJsonError> {
    if safe_u64(
        required(object, "version", path)?,
        &format!("{path}.version"),
    )? == 1
    {
        Ok(())
    } else {
        Err(EntityContextJsonError::InvalidValue(format!(
            "{path}.version"
        )))
    }
}

fn text<'a>(value: &'a Value, path: &str) -> Result<&'a str, EntityContextJsonError> {
    value
        .as_str()
        .ok_or_else(|| EntityContextJsonError::InvalidType(path.into()))
}

fn nonempty_text<'a>(value: &'a Value, path: &str) -> Result<&'a str, EntityContextJsonError> {
    let value = text(value, path)?;
    if value.is_empty() {
        Err(EntityContextJsonError::InvalidValue(path.into()))
    } else {
        Ok(value)
    }
}

fn optional_nonempty_text(
    value: &Value,
    path: &str,
) -> Result<Option<String>, EntityContextJsonError> {
    if value.is_null() {
        Ok(None)
    } else {
        Ok(Some(nonempty_text(value, path)?.into()))
    }
}

fn boolean(value: &Value, path: &str) -> Result<bool, EntityContextJsonError> {
    value
        .as_bool()
        .ok_or_else(|| EntityContextJsonError::InvalidType(path.into()))
}

fn safe_u64(value: &Value, path: &str) -> Result<u64, EntityContextJsonError> {
    let value = value
        .as_u64()
        .ok_or_else(|| EntityContextJsonError::InvalidType(path.into()))?;
    if value > JS_MAX_SAFE_INTEGER {
        Err(EntityContextJsonError::InvalidValue(path.into()))
    } else {
        Ok(value)
    }
}

fn positive_safe_u64(value: &Value, path: &str) -> Result<u64, EntityContextJsonError> {
    let value = safe_u64(value, path)?;
    if value == 0 {
        Err(EntityContextJsonError::InvalidValue(path.into()))
    } else {
        Ok(value)
    }
}

fn bounded_u16(value: &Value, max: u16, path: &str) -> Result<u16, EntityContextJsonError> {
    let value = safe_u64(value, path)?;
    let value =
        u16::try_from(value).map_err(|_| EntityContextJsonError::InvalidValue(path.into()))?;
    if value > max {
        Err(EntityContextJsonError::InvalidValue(path.into()))
    } else {
        Ok(value)
    }
}

fn positive_u32(value: &Value, path: &str) -> Result<u32, EntityContextJsonError> {
    let value = safe_u64(value, path)?;
    let value =
        u32::try_from(value).map_err(|_| EntityContextJsonError::InvalidValue(path.into()))?;
    if value == 0 {
        Err(EntityContextJsonError::InvalidValue(path.into()))
    } else {
        Ok(value)
    }
}

fn bigint(value: &Value, path: &str) -> Result<BigInt, EntityContextJsonError> {
    let decimal = if let Some(value) = value.as_str() {
        value
    } else {
        let object = object(value, path)?;
        exact_keys(object, &["__xlnType", "value"], &[], path)?;
        if text(
            required(object, "__xlnType", path)?,
            &format!("{path}.__xlnType"),
        )? != "BigInt"
        {
            return Err(EntityContextJsonError::InvalidValue(format!(
                "{path}.__xlnType"
            )));
        }
        text(required(object, "value", path)?, &format!("{path}.value"))?
    };
    if !canonical_decimal(decimal) {
        return Err(EntityContextJsonError::InvalidValue(path.into()));
    }
    decimal
        .parse::<BigInt>()
        .map_err(|_| EntityContextJsonError::InvalidValue(path.into()))
}

fn nonnegative_bigint(value: &Value, path: &str) -> Result<BigInt, EntityContextJsonError> {
    let value = bigint(value, path)?;
    if value < BigInt::from(0) {
        Err(EntityContextJsonError::InvalidValue(path.into()))
    } else {
        Ok(value)
    }
}

fn positive_bigint(value: &Value, path: &str) -> Result<BigInt, EntityContextJsonError> {
    let value = bigint(value, path)?;
    if value <= BigInt::from(0) {
        Err(EntityContextJsonError::InvalidValue(path.into()))
    } else {
        Ok(value)
    }
}

fn canonical_decimal(value: &str) -> bool {
    value == "0"
        || value
            .strip_prefix('-')
            .unwrap_or(value)
            .as_bytes()
            .first()
            .is_some_and(|first| *first >= b'1' && *first <= b'9')
            && value
                .strip_prefix('-')
                .unwrap_or(value)
                .bytes()
                .all(|byte| byte.is_ascii_digit())
}

fn fixed_hex(value: &Value, bytes: usize, path: &str) -> Result<String, EntityContextJsonError> {
    let value = text(value, path)?;
    let payload = value
        .strip_prefix("0x")
        .ok_or_else(|| EntityContextJsonError::InvalidValue(path.into()))?;
    if value != value.to_ascii_lowercase()
        || payload.len() != bytes * 2
        || !payload.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(EntityContextJsonError::InvalidValue(path.into()));
    }
    Ok(value.into())
}

fn optional_safe_u64(
    value: Option<&Value>,
    path: &str,
) -> Result<Option<u64>, EntityContextJsonError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => safe_u64(value, path).map(Some),
    }
}

fn pair_id(value: &Value, path: &str) -> Result<String, EntityContextJsonError> {
    let value = nonempty_text(value, path)?;
    let (left, right) = value
        .split_once('/')
        .ok_or_else(|| EntityContextJsonError::InvalidValue(path.into()))?;
    if left == right || !canonical_positive_u32(left) || !canonical_positive_u32(right) {
        return Err(EntityContextJsonError::InvalidValue(path.into()));
    }
    Ok(value.into())
}

fn canonical_positive_u32(value: &str) -> bool {
    !value.starts_with('0') && value.parse::<u32>().is_ok_and(|value| value > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::{Digest as _, Sha256};
    use xln_rscore_engine::HTLC_OPAQUE_CIPHERTEXT_VERSION;

    const ENTITY: &str = "0xe439def09623839817f6b74bdd4c54c0d5078635b5435cac2b2ab2809153a51c";
    const PEER: &str = "0x5d364af08764f6cfc396de3370245fd2c9e127a340fef4af39feba27e114a957";
    const SIGNER: &str = "0x4ebbed8e45556b03d25a8bf0242be9f6d1e70092";
    const HASH: &str = "0x540b75f0beeeb2f9ee37fe1ea52c61259294f9d997cd7e3884f311d6a0ec012e";
    const CIPHERTEXT: &str = "suvroyPQHQTEmrN0ZCHdlqXMuBdJ/UnT1ko77xe8IwYNt4NrMNXLZlrx1eKYDGyXCF+LMkacuaIuJhqqzy9POeWNnVaWdkU2JvbW4o4AoUt7Lr6oJlTxrOKMXj3qgi86X3Do1kmgCJ9HNqGdTRwP2SNb0fQ=";

    fn policy() -> Value {
        json!({
            "minimumTradeSize": {"__xlnType":"BigInt", "value":"10000000"},
            "swapTakerFeeBps": 1,
            "jurisdictionId": "Testnet",
            "pairPolicies": [["2/1", 1, 10000, "25000000"]]
        })
    }

    fn entry() -> Value {
        json!({
            "binding": {
                "fromEntityId": PEER, "toEntityId": ENTITY,
                "domain": {"chainId":31337, "depositoryAddress":"0xa513e6e4b8f2a923d98304ec87f64353c4d5c853"},
                "accountFrameHash": HASH, "accountHeight":4,
                "envelopeHash":HASH, "hashlock":HASH, "tokenId":1,
                "amount":{"__xlnType":"BigInt", "value":"1000"},
                "timelock":{"__xlnType":"BigInt", "value":"1787666194697"},
                "revealBeforeHeight":17288
            },
            "outcome": {
                "kind":"forward", "nextHopEntityId":PEER,
                "forwardAmount":{"__xlnType":"BigInt", "value":"1000"},
                "innerEnvelope":{"version":HTLC_OPAQUE_CIPHERTEXT_VERSION, "ciphertext":CIPHERTEXT}
            }
        })
    }

    fn final_entry() -> Value {
        let mut value = entry();
        value["outcome"] = json!({
            "kind":"final",
            "secret":HASH,
            "description":"canonical payment note",
            "startedAtMs":1500
        });
        value
    }

    fn originated(tx_hash: &str) -> Value {
        json!({
            "txHash":tx_hash,
            "targetEntityId":PEER,
            "tokenId":1,
            "recipientAmount":{"__xlnType":"BigInt", "value":"1000"},
            "route":[ENTITY,PEER],
            "description":"canonical payment note",
            "deliveryMode":"instant",
            "startedAtMs":1_700_000_000_000_u64,
            "hashlock":HASH,
            "senderLockAmount":{"__xlnType":"BigInt", "value":"1010"},
            "maxSenderDebit":{"__xlnType":"BigInt", "value":"1100"},
            "totalFee":{"__xlnType":"BigInt", "value":"10"},
            "timelock":{"__xlnType":"BigInt", "value":"1700000100000"},
            "revealBeforeHeight":123,
            "nextHopEntityId":PEER,
            "envelope":{
                "version":HTLC_OPAQUE_CIPHERTEXT_VERSION,
                "ciphertext":CIPHERTEXT
            }
        })
    }

    fn context(entries: Vec<Value>) -> Value {
        json!({
            "version":1, "proposerReplicaId":format!("{ENTITY}:{SIGNER}"),
            "entityId":ENTITY, "proposerSignerId":SIGNER, "parentFrameHash":HASH,
            "height":27, "gossipProfiles":[],
            "peerAssertions":[{"entityId":PEER,"online":true}],
            "htlc":{"version":1,"entries":entries,"originated":[]}
        })
    }

    #[test]
    fn accepts_genesis_parent_and_canonical_named_signer() {
        let mut value = context(vec![]);
        value["proposerSignerId"] = json!("h1-hub");
        value["proposerReplicaId"] = json!(format!("{ENTITY}:h1-hub"));
        value["parentFrameHash"] = json!("genesis");
        decode_entity_deterministic_context(&policy(), &value)
            .expect("TS permits canonical named signer ids at genesis");
    }

    #[test]
    fn rejects_noncanonical_named_signer() {
        for signer in ["H1-HUB", " h1-hub", "h1-hub "] {
            let mut value = context(vec![]);
            value["proposerSignerId"] = json!(signer);
            value["proposerReplicaId"] = json!(format!("{ENTITY}:{signer}"));
            assert_eq!(
                decode_entity_deterministic_context(&policy(), &value),
                Err(EntityContextJsonError::InvalidValue(
                    "context.proposerSignerId".into()
                ))
            );
        }
    }

    #[test]
    fn decodes_snapshot_policy_and_current_prepared_forward_exactly() {
        let decoded = decode_entity_deterministic_context(&policy(), &context(vec![entry()]))
            .expect("valid deterministic context");
        assert_eq!(decoded.minimum_trade_size, BigInt::from(10_000_000));
        assert_eq!(decoded.swap_taker_fee_bps, 1);
        assert_eq!(decoded.jurisdiction_id.as_deref(), Some("Testnet"));
        assert_eq!(
            decoded.pair_policies["2/1"].mid_price_ticks,
            BigInt::from(25_000_000)
        );
        assert!(
            decoded
                .prepared_htlcs
                .contains_key(&(HASH.into(), HASH.into()))
        );
    }

    #[test]
    fn preserves_prepared_final_description() {
        let decoded = decode_entity_deterministic_context(&policy(), &context(vec![final_entry()]))
            .expect("valid final context");
        let outcome = &decoded
            .prepared_htlcs
            .get(&(HASH.into(), HASH.into()))
            .expect("prepared row")
            .outcome;
        assert!(matches!(
            outcome,
            HtlcPreparedOutcome::Final {
                description: Some(value),
                started_at_ms: Some(1_500),
                ..
            } if value == "canonical payment note"
        ));
    }

    #[test]
    fn rejects_duplicate_pair_and_prepared_keys() {
        let mut duplicate_policy = policy();
        duplicate_policy["pairPolicies"] =
            json!([["2/1", 1, 10000, "25000000"], ["2/1", 1, 10000, "25000000"]]);
        assert_eq!(
            decode_entity_deterministic_context(&duplicate_policy, &context(vec![])),
            Err(EntityContextJsonError::DuplicatePair("2/1".into()))
        );
        assert!(matches!(
            decode_entity_deterministic_context(&policy(), &context(vec![entry(), entry()])),
            Err(EntityContextJsonError::DuplicatePrepared(_, _))
        ));
    }

    #[test]
    fn decodes_originated_payment_and_opaque_envelope_exactly() {
        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/entity-kernel/originated-htlc-context-v1.json"
        ))
        .trim_end();
        assert_eq!(
            hex::encode(Sha256::digest(raw.as_bytes())),
            "f5ccf77b1d0ec7c312dfe49f38cb4c5aea65ae5eb0f7801f9abea13b052e34a7"
        );
        let mut value = context(vec![]);
        value["htlc"] = serde_json::from_str(raw).expect("TS golden JSON");
        let decoded = decode_entity_deterministic_context(&policy(), &value)
            .expect("valid originated payment");
        let payment = decoded
            .originated_htlcs
            .get(HASH)
            .expect("payment by tx hash");
        assert_eq!(payment.target_entity_id, PEER);
        assert_eq!(payment.route, vec![ENTITY.to_string(), PEER.to_string()]);
        assert_eq!(payment.recipient_amount, BigInt::from(1_000));
        assert_eq!(payment.sender_lock_amount, BigInt::from(1_010));
        assert_eq!(payment.total_fee, BigInt::from(10));
        assert_eq!(payment.delivery_mode, OriginatedHtlcDeliveryMode::Instant);
        assert_eq!(
            hex::encode(payment.envelope.integrity_hash()),
            "79f9bf7ce38da88ba654913a2321f43a70d5f6dd7bb44ae7e2fd9a3fac72c7ec"
        );
    }

    #[test]
    fn rejects_unsorted_duplicate_and_invalid_originated_economics() {
        let earlier = "0x1111111111111111111111111111111111111111111111111111111111111111";
        let later = "0x9999999999999999999999999999999999999999999999999999999999999999";
        let mut unsorted = context(vec![]);
        unsorted["htlc"]["originated"] = json!([originated(later), originated(earlier)]);
        assert!(matches!(
            decode_entity_deterministic_context(&policy(), &unsorted),
            Err(EntityContextJsonError::InvalidValue(path)) if path.ends_with("txHash.notSorted")
        ));
        let mut duplicate = context(vec![]);
        duplicate["htlc"]["originated"] = json!([originated(earlier), originated(earlier)]);
        assert_eq!(
            decode_entity_deterministic_context(&policy(), &duplicate),
            Err(EntityContextJsonError::DuplicateOriginated(earlier.into()))
        );
        let mut economics = context(vec![]);
        let mut invalid = originated(HASH);
        invalid["totalFee"] = json!({"__xlnType":"BigInt", "value":"11"});
        economics["htlc"]["originated"] = json!([invalid]);
        assert!(matches!(
            decode_entity_deterministic_context(&policy(), &economics),
            Err(EntityContextJsonError::InvalidValue(path)) if path.ends_with("economics")
        ));
    }

    #[test]
    fn rejects_noncanonical_bigints() {
        let mut invalid_policy = policy();
        invalid_policy["minimumTradeSize"] = json!("01");
        assert!(matches!(
            decode_entity_deterministic_context(&invalid_policy, &context(vec![])),
            Err(EntityContextJsonError::InvalidValue(_))
        ));
    }
}

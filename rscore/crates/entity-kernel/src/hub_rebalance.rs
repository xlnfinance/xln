use std::collections::BTreeMap;

use ethabi::ethereum_types::U256;
use num_bigint::{BigInt, Sign};
use xln_rscore_engine::{Delta, Side, TokenId};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use crate::{
    AccountEnvelopeMutation, CanonicalEntityTx, EntityKernelError, EntityKernelOutput,
    EntityStateSlice, EntityTxKind, LocalEntityOutput, LocalEntityOutputTx,
};

pub(crate) const HUB_PENDING_BROADCAST_STALE_MS: u64 = 120_000;
const HUB_MAX_R2C_PER_TICK: usize = 10;
const HUB_MAX_C2R_PER_TICK: usize = 10;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HubRebalanceFeeState {
    pub(crate) request_id: String,
    pub(crate) fee_paid_upfront: BigInt,
    pub(crate) policy_version: u64,
    pub(crate) requested_at: u64,
    pub(crate) refund: bool,
    pub(crate) refunded_amount: Option<BigInt>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HubRebalanceAccountView {
    pub(crate) account_id: String,
    pub(crate) owner_side: Side,
    pub(crate) pending_frame: bool,
    pub(crate) settlement_transition_pending: bool,
    pub(crate) settlement_workspace: Option<CanonicalValue>,
    pub(crate) requested_rebalance: BTreeMap<TokenId, BigInt>,
    pub(crate) fee_state: BTreeMap<TokenId, HubRebalanceFeeState>,
    pub(crate) submitted_at_by_token: BTreeMap<TokenId, u64>,
    pub(crate) deltas: BTreeMap<TokenId, Delta>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct HubRebalanceResult {
    pub(crate) outputs: Vec<LocalEntityOutput>,
    pub(crate) envelope_mutations: Vec<(String, AccountEnvelopeMutation)>,
    pub(crate) effects: Vec<EntityKernelOutput>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MatchingStrategy {
    Amount,
    Time,
    Fee,
}

#[derive(Clone, Debug)]
struct R2cTarget {
    account_id: String,
    token_id: TokenId,
    amount: BigInt,
    requested_at: u64,
    fee_paid_upfront: BigInt,
}

#[derive(Clone, Debug)]
struct C2rPlan {
    account_id: String,
    ops: Vec<CanonicalValue>,
    total_amount: BigInt,
}

fn projected(
    kind: EntityTxKind,
    data: CanonicalValue,
) -> Result<LocalEntityOutputTx, EntityKernelError> {
    CanonicalEntityTx::from_frame_projection(kind, data)
        .map(LocalEntityOutputTx::Projected)
        .map_err(|error| EntityKernelError::local("hubRebalance", error.to_string()))
}

fn diagnostic(
    state: &EntityStateSlice,
    step: u32,
    status: &'static str,
    event: &'static str,
    mut detail: Vec<(String, CanonicalValue)>,
) -> EntityKernelOutput {
    let mut payload = vec![
        ("level".into(), CanonicalValue::String("info".into())),
        ("code".into(), CanonicalValue::String("REB_STEP".into())),
        (
            "hubId".into(),
            CanonicalValue::String(state.entity_id.clone()),
        ),
        (
            "step".into(),
            CanonicalValue::Number(CanonicalNumber::from_u32(step)),
        ),
        ("status".into(), CanonicalValue::String(status.into())),
        ("event".into(), CanonicalValue::String(event.into())),
    ];
    payload.append(&mut detail);
    EntityKernelOutput::Debug {
        payload: CanonicalValue::Object(payload),
    }
}

fn number_u64(value: u64) -> Result<CanonicalValue, EntityKernelError> {
    Ok(CanonicalValue::Number(
        CanonicalNumber::try_from_u64(value)
            .map_err(|_| EntityKernelError::local("hubRebalance", "NUMBER_UNSAFE"))?,
    ))
}

/// Resolve the sent-batch latch before inspecting Account work.
///
/// This is the exact TS `resolveBatchAvailability` ordering: a fresh batch
/// blocks JBatch mutation but still permits C2R proposal discovery, while a
/// stale batch queues one self-addressed abort and terminates the tick.
pub(crate) fn resolve_sent_batch(
    state: &EntityStateSlice,
) -> Result<(bool, Option<Vec<LocalEntityOutput>>), EntityKernelError> {
    let Some(batch_state) = state.j_batch_state.as_ref() else {
        return Ok((true, None));
    };
    let Some(sent) = batch_state.sent_batch.as_ref() else {
        return Ok((true, None));
    };
    let submitted_at = if sent.last_submitted_at != 0 {
        sent.last_submitted_at
    } else {
        batch_state.last_broadcast
    };
    if state.timestamp.saturating_sub(submitted_at) <= HUB_PENDING_BROADCAST_STALE_MS {
        return Ok((false, None));
    }
    let abort = projected(
        EntityTxKind::JAbortSentBatch,
        CanonicalValue::Object(vec![
            (
                "reason".into(),
                CanonicalValue::String("stale-hub-rebalance-latch".into()),
            ),
            ("requeueToCurrent".into(), CanonicalValue::Bool(true)),
        ]),
    )?;
    Ok((
        false,
        Some(vec![LocalEntityOutput {
            entity_id: state.entity_id.clone(),
            target_signer_id: None,
            entity_txs: vec![abort],
        }]),
    ))
}

fn object<'a>(
    value: &'a CanonicalValue,
    detail: &'static str,
) -> Result<&'a [(String, CanonicalValue)], EntityKernelError> {
    match value {
        CanonicalValue::Object(fields) => Ok(fields),
        _ => Err(EntityKernelError::HubRebalanceConfigInvalid {
            detail: detail.into(),
        }),
    }
}

fn field<'a>(fields: &'a [(String, CanonicalValue)], name: &str) -> Option<&'a CanonicalValue> {
    fields
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
}

fn number(value: &CanonicalValue, name: &'static str) -> Result<u64, EntityKernelError> {
    let CanonicalValue::Number(value) = value else {
        return Err(EntityKernelError::HubRebalanceConfigInvalid {
            detail: name.into(),
        });
    };
    value
        .as_str()
        .parse()
        .map_err(|_| EntityKernelError::HubRebalanceConfigInvalid {
            detail: name.into(),
        })
}

fn config(state: &EntityStateSlice) -> Result<(MatchingStrategy, u64, BigInt), EntityKernelError> {
    let fields = object(
        state.hub_rebalance_config.as_ref().ok_or_else(|| {
            EntityKernelError::HubRebalanceConfigInvalid {
                detail: "MISSING".into(),
            }
        })?,
        "OBJECT",
    )?;
    for forbidden in [
        "rebalanceBaseFee",
        "c2rWithdrawSoftLimit",
        "rebalanceGasFee",
    ] {
        if field(fields, forbidden).is_some() {
            return Err(EntityKernelError::HubRebalanceConfigInvalid {
                detail: format!("TOKENLESS_RAW_OVERRIDE_FORBIDDEN:{forbidden}"),
            });
        }
    }
    let strategy = match field(fields, "matchingStrategy") {
        Some(CanonicalValue::String(value)) if value == "time" => MatchingStrategy::Time,
        Some(CanonicalValue::String(value)) if value == "fee" => MatchingStrategy::Fee,
        _ => MatchingStrategy::Amount,
    };
    let policy_version = field(fields, "policyVersion")
        .map(|value| number(value, "policyVersion"))
        .transpose()?
        .filter(|value| *value > 0)
        .unwrap_or(1);
    let liquidity_fee_bps = match field(fields, "rebalanceLiquidityFeeBps") {
        Some(CanonicalValue::BigInt(value)) if value.sign() != Sign::Minus => value.clone(),
        _ => {
            return Err(EntityKernelError::HubRebalanceConfigInvalid {
                detail: "rebalanceLiquidityFeeBps".into(),
            });
        }
    };
    Ok((strategy, policy_version, liquidity_fee_bps))
}

fn token_decimals(token: TokenId) -> Result<u32, EntityKernelError> {
    crate::canonical_token_decimals(u32::from(token.get())).ok_or_else(|| {
        EntityKernelError::HubRebalanceConfigInvalid {
            detail: format!("TOKEN_METADATA_UNAVAILABLE:{}", token.get()),
        }
    })
}

fn default_base_fee(token: TokenId) -> Result<BigInt, EntityKernelError> {
    let decimals = token_decimals(token)?;
    if decimals == 0 {
        return Err(EntityKernelError::HubRebalanceConfigInvalid {
            detail: "TOKEN_AMOUNT_PRECISION_UNREPRESENTABLE:0.1:0".into(),
        });
    }
    Ok(BigInt::from(10_u8).pow(decimals - 1))
}

fn default_soft_limit(token: TokenId) -> Result<BigInt, EntityKernelError> {
    Ok(BigInt::from(500_u16) * BigInt::from(10_u8).pow(token_decimals(token)?))
}

fn positive_u256(value: &BigInt) -> Result<U256, EntityKernelError> {
    let (sign, bytes) = value.to_bytes_be();
    if sign != Sign::Plus || bytes.len() > 32 {
        return Err(EntityKernelError::local("hubRebalance", "AMOUNT_UINT256"));
    }
    Ok(U256::from_big_endian(&bytes))
}

fn delta_parts(delta: &Delta, side: Side) -> (BigInt, BigInt, BigInt) {
    let total = delta.ondelta() + delta.offdelta();
    let zero = BigInt::from(0_u8);
    let collateral = delta.collateral().max(&zero).clone();
    let left_in_collateral = if total > zero {
        (&collateral - &total).max(zero.clone())
    } else {
        collateral.clone()
    };
    let left_out_collateral = if total > zero {
        total.clone().min(collateral.clone())
    } else {
        zero.clone()
    };
    let left_in_own_credit = (-&total).max(zero.clone());
    let left_out_peer_credit = (&total - &collateral).max(zero);
    match side {
        Side::Left => (
            left_out_peer_credit,
            left_out_collateral,
            delta.hold(Side::Left).clone(),
        ),
        Side::Right => (
            left_in_own_credit,
            left_in_collateral,
            delta.hold(Side::Right).clone(),
        ),
    }
}

fn collect_r2c_targets(
    state: &EntityStateSlice,
    views: &[HubRebalanceAccountView],
    strategy: MatchingStrategy,
    policy_version: u64,
    liquidity_fee_bps: &BigInt,
    effects: &mut Vec<EntityKernelOutput>,
) -> Result<Vec<R2cTarget>, EntityKernelError> {
    let mut targets = Vec::new();
    for view in views {
        for (token_id, requested_raw) in &view.requested_rebalance {
            if requested_raw <= &BigInt::from(0_u8) {
                continue;
            }
            let fee = view.fee_state.get(token_id).ok_or_else(|| {
                EntityKernelError::local(
                    "hubRebalance",
                    format!(
                        "REBALANCE_REQUEST_FEE_STATE_MISSING:{}:{}",
                        view.account_id,
                        token_id.get()
                    ),
                )
            })?;
            if fee.refund {
                effects.push(diagnostic(
                    state,
                    2,
                    "blocked",
                    "request_refund_in_progress",
                    vec![
                        (
                            "counterpartyId".into(),
                            CanonicalValue::String(view.account_id.clone()),
                        ),
                        (
                            "tokenId".into(),
                            CanonicalValue::Number(CanonicalNumber::from_u32(u32::from(
                                token_id.get(),
                            ))),
                        ),
                        (
                            "requestId".into(),
                            CanonicalValue::String(fee.request_id.clone()),
                        ),
                        (
                            "refundedAmount".into(),
                            CanonicalValue::String(
                                fee.refunded_amount
                                    .as_ref()
                                    .cloned()
                                    .unwrap_or_default()
                                    .to_string(),
                            ),
                        ),
                    ],
                ));
                continue;
            }
            let submitted_at = view
                .submitted_at_by_token
                .get(token_id)
                .copied()
                .unwrap_or(0);
            // Exact-once latch, not a lease. Redrafting on elapsed time can
            // execute the same request twice when J succeeded but the peer's
            // bilateral AccountSettled claim is delayed. Sent-batch recovery
            // retries the sealed batch; finality or explicit drop clears this.
            if submitted_at > 0 {
                continue;
            }
            if fee.policy_version != policy_version {
                effects.push(diagnostic(
                    state,
                    2,
                    "blocked",
                    "policy_mismatch_manual",
                    vec![
                        (
                            "counterpartyId".into(),
                            CanonicalValue::String(view.account_id.clone()),
                        ),
                        (
                            "tokenId".into(),
                            CanonicalValue::Number(CanonicalNumber::from_u32(u32::from(
                                token_id.get(),
                            ))),
                        ),
                        (
                            "requestPolicyVersion".into(),
                            number_u64(fee.policy_version)?,
                        ),
                        ("hubPolicyVersion".into(), number_u64(policy_version)?),
                    ],
                ));
                continue;
            }
            let minimum_fee = default_base_fee(*token_id)?
                + requested_raw * liquidity_fee_bps / BigInt::from(10_000_u32);
            if fee.fee_paid_upfront < minimum_fee {
                effects.push(diagnostic(
                    state,
                    2,
                    "blocked",
                    "prepaid_fee_too_low_manual",
                    vec![
                        (
                            "counterpartyId".into(),
                            CanonicalValue::String(view.account_id.clone()),
                        ),
                        (
                            "tokenId".into(),
                            CanonicalValue::Number(CanonicalNumber::from_u32(u32::from(
                                token_id.get(),
                            ))),
                        ),
                        (
                            "prepaidFee".into(),
                            CanonicalValue::String(fee.fee_paid_upfront.to_string()),
                        ),
                        (
                            "requiredFee".into(),
                            CanonicalValue::String(minimum_fee.to_string()),
                        ),
                    ],
                ));
                continue;
            }
            let Some(delta) = view.deltas.get(token_id) else {
                effects.push(diagnostic(
                    state,
                    2,
                    "error",
                    "request_missing_delta",
                    vec![
                        (
                            "counterpartyId".into(),
                            CanonicalValue::String(view.account_id.clone()),
                        ),
                        (
                            "tokenId".into(),
                            CanonicalValue::Number(CanonicalNumber::from_u32(u32::from(
                                token_id.get(),
                            ))),
                        ),
                    ],
                ));
                continue;
            };
            let (uncollateralized, _, _) = delta_parts(
                delta,
                match view.owner_side {
                    Side::Left => Side::Right,
                    Side::Right => Side::Left,
                },
            );
            if uncollateralized <= BigInt::from(0_u8) {
                effects.push(diagnostic(
                    state,
                    2,
                    "blocked",
                    "request_waiting_bilateral_resolution",
                    vec![
                        (
                            "counterpartyId".into(),
                            CanonicalValue::String(view.account_id.clone()),
                        ),
                        (
                            "tokenId".into(),
                            CanonicalValue::Number(CanonicalNumber::from_u32(u32::from(
                                token_id.get(),
                            ))),
                        ),
                    ],
                ));
                continue;
            }
            let requested = requested_raw.min(&uncollateralized).clone();
            targets.push(R2cTarget {
                account_id: view.account_id.clone(),
                token_id: *token_id,
                amount: requested,
                requested_at: fee.requested_at,
                fee_paid_upfront: fee.fee_paid_upfront.clone(),
            });
        }
    }
    targets.sort_by(|left, right| match strategy {
        MatchingStrategy::Amount => right
            .amount
            .cmp(&left.amount)
            .then(left.requested_at.cmp(&right.requested_at)),
        MatchingStrategy::Fee => right
            .fee_paid_upfront
            .cmp(&left.fee_paid_upfront)
            .then(right.amount.cmp(&left.amount)),
        MatchingStrategy::Time => left
            .requested_at
            .cmp(&right.requested_at)
            .then(right.amount.cmp(&left.amount)),
    });
    let mut reserves = state.reserves.clone();
    let mut funded = Vec::new();
    for mut target in targets {
        if funded.len() == HUB_MAX_R2C_PER_TICK {
            break;
        }
        let reserve = reserves
            .get(&target.token_id.get())
            .cloned()
            .unwrap_or_default();
        let amount = target.amount.clone().min(reserve.clone());
        if amount <= BigInt::from(0_u8) {
            effects.push(diagnostic(
                state,
                2,
                "blocked",
                "hub_reserve_zero",
                vec![
                    (
                        "counterpartyId".into(),
                        CanonicalValue::String(target.account_id),
                    ),
                    (
                        "tokenId".into(),
                        CanonicalValue::Number(CanonicalNumber::from_u32(u32::from(
                            target.token_id.get(),
                        ))),
                    ),
                    (
                        "requestedAmount".into(),
                        CanonicalValue::String(target.amount.to_string()),
                    ),
                ],
            ));
            continue;
        }
        reserves.insert(target.token_id.get(), reserve - &amount);
        target.amount = amount;
        funded.push(target);
    }
    Ok(funded)
}

fn workspace_fields(value: &CanonicalValue) -> Option<&[(String, CanonicalValue)]> {
    match value {
        CanonicalValue::Object(fields) => Some(fields),
        _ => None,
    }
}

fn bool_field(fields: &[(String, CanonicalValue)], name: &str) -> Option<bool> {
    match field(fields, name) {
        Some(CanonicalValue::Bool(value)) => Some(*value),
        _ => None,
    }
}

fn truthy(value: Option<&CanonicalValue>) -> bool {
    match value {
        None | Some(CanonicalValue::Null) => false,
        Some(CanonicalValue::Bool(value)) => *value,
        Some(CanonicalValue::String(value)) => !value.is_empty(),
        Some(CanonicalValue::Number(value)) => value.as_str() != "0",
        Some(CanonicalValue::BigInt(value)) => value != &BigInt::from(0_u8),
        Some(
            CanonicalValue::Array(_)
            | CanonicalValue::Map(_)
            | CanonicalValue::Set(_)
            | CanonicalValue::Object(_),
        ) => true,
    }
}

fn c2r_workspace_executable(view: &HubRebalanceAccountView, can_touch_batch: bool) -> bool {
    let Some(fields) = view
        .settlement_workspace
        .as_ref()
        .and_then(workspace_fields)
    else {
        return false;
    };
    let owner_is_left = view.owner_side == Side::Left;
    let Some(CanonicalValue::Array(ops)) = field(fields, "ops") else {
        return false;
    };
    can_touch_batch
        && bool_field(fields, "lastModifiedByLeft") == Some(owner_is_left)
        && bool_field(fields, "executorIsLeft") == Some(owner_is_left)
        && matches!(field(fields, "status"), Some(CanonicalValue::String(status)) if status == "ready_to_submit")
        && !ops.is_empty()
        && ops.iter().all(|op| matches!(op, CanonicalValue::Object(fields) if matches!(field(fields, "type"), Some(CanonicalValue::String(kind)) if kind == "c2r")))
        && truthy(field(
            fields,
            if owner_is_left {
                "rightHanko"
            } else {
                "leftHanko"
            },
        ))
}

fn c2r_op(token_id: TokenId, amount: BigInt) -> CanonicalValue {
    CanonicalValue::Object(vec![
        ("type".into(), CanonicalValue::String("c2r".into())),
        (
            "tokenId".into(),
            CanonicalValue::Number(CanonicalNumber::from_u32(u32::from(token_id.get()))),
        ),
        ("amount".into(), CanonicalValue::BigInt(amount)),
    ])
}

fn collect_c2r(
    state: &EntityStateSlice,
    views: &[HubRebalanceAccountView],
    can_touch_batch: bool,
    effects: &mut Vec<EntityKernelOutput>,
) -> Result<(Vec<C2rPlan>, Vec<String>), EntityKernelError> {
    let mut plans = Vec::new();
    let mut executable = Vec::new();
    for view in views {
        if view.pending_frame || view.settlement_transition_pending {
            continue;
        }
        if view.settlement_workspace.is_some() {
            if c2r_workspace_executable(view, can_touch_batch) {
                executable.push(view.account_id.clone());
            }
            continue;
        }
        let mut ops = Vec::new();
        let mut total_amount = BigInt::from(0_u8);
        for (token_id, delta) in &view.deltas {
            if view
                .requested_rebalance
                .get(token_id)
                .is_some_and(|amount| amount > &BigInt::from(0_u8))
            {
                continue;
            }
            let (_, out_collateral, out_hold) = delta_parts(delta, view.owner_side);
            let free = (&out_collateral - &out_hold).max(BigInt::from(0_u8));
            let soft_limit = default_soft_limit(*token_id)?;
            if free <= soft_limit {
                continue;
            }
            effects.push(diagnostic(
                state,
                2,
                "ok",
                "c2r_withdraw_overcollateralized",
                vec![
                    (
                        "counterpartyId".into(),
                        CanonicalValue::String(view.account_id.clone()),
                    ),
                    (
                        "tokenId".into(),
                        CanonicalValue::Number(CanonicalNumber::from_u32(u32::from(
                            token_id.get(),
                        ))),
                    ),
                    (
                        "outCollateral".into(),
                        CanonicalValue::String(out_collateral.to_string()),
                    ),
                    (
                        "outHold".into(),
                        CanonicalValue::String(out_hold.to_string()),
                    ),
                    (
                        "freeOutCollateral".into(),
                        CanonicalValue::String(free.to_string()),
                    ),
                    (
                        "c2rWithdrawSoftLimit".into(),
                        CanonicalValue::String(soft_limit.to_string()),
                    ),
                    (
                        "withdrawAmount".into(),
                        CanonicalValue::String(free.to_string()),
                    ),
                ],
            ));
            total_amount += &free;
            ops.push(c2r_op(*token_id, free));
        }
        if !ops.is_empty() && total_amount > BigInt::from(0_u8) {
            plans.push(C2rPlan {
                account_id: view.account_id.clone(),
                ops,
                total_amount,
            });
        }
    }
    plans.sort_by(|left, right| right.total_amount.cmp(&left.total_amount));
    plans.truncate(HUB_MAX_C2R_PER_TICK);
    executable.truncate(HUB_MAX_C2R_PER_TICK);
    Ok((plans, executable))
}

fn self_output(state: &EntityStateSlice, txs: Vec<LocalEntityOutputTx>) -> Vec<LocalEntityOutput> {
    if txs.is_empty() {
        Vec::new()
    } else {
        vec![LocalEntityOutput {
            entity_id: state.entity_id.clone(),
            target_signer_id: None,
            entity_txs: txs,
        }]
    }
}

pub(crate) fn apply_hub_rebalance(
    state: &mut EntityStateSlice,
    views: &[HubRebalanceAccountView],
    manual_broadcast_in_input: bool,
) -> Result<HubRebalanceResult, EntityKernelError> {
    if state.hub_rebalance_config.is_none() {
        return Ok(HubRebalanceResult::default());
    }
    let (strategy, policy_version, liquidity_fee_bps) = config(state)?;
    state.j_batch_state.get_or_insert_with(Default::default);
    let (can_touch_batch, terminal) = resolve_sent_batch(state)?;
    if let Some(outputs) = terminal {
        return Ok(HubRebalanceResult {
            outputs,
            envelope_mutations: Vec::new(),
            effects: Vec::new(),
        });
    }
    let mut envelope_mutations = Vec::new();
    let mut effects = Vec::new();
    let targets = collect_r2c_targets(
        state,
        views,
        strategy,
        policy_version,
        &liquidity_fee_bps,
        &mut effects,
    )?;
    let mut queued_r2c = 0_usize;
    if can_touch_batch {
        let receiving = fixed_entity_id(&state.entity_id)?;
        for target in targets {
            let account_id = target.account_id.clone();
            crate::local_control::queue_reserve_to_collateral(
                state,
                receiving,
                fixed_entity_id(&target.account_id)?,
                u64::from(target.token_id.get()),
                positive_u256(&target.amount)?,
            )?;
            envelope_mutations.push((
                target.account_id,
                AccountEnvelopeMutation::SetRebalanceSubmittedAt {
                    token_id: u32::from(target.token_id.get()),
                    submitted_at: Some(state.timestamp),
                },
            ));
            effects.push(diagnostic(
                state,
                2,
                "ok",
                "batch_add",
                vec![
                    ("counterpartyId".into(), CanonicalValue::String(account_id)),
                    (
                        "tokenId".into(),
                        CanonicalValue::Number(CanonicalNumber::from_u32(u32::from(
                            target.token_id.get(),
                        ))),
                    ),
                    (
                        "amount".into(),
                        CanonicalValue::String(target.amount.to_string()),
                    ),
                    ("requestedAt".into(), number_u64(target.requested_at)?),
                ],
            ));
            queued_r2c += 1;
        }
    }
    let (plans, executable) = collect_c2r(state, views, can_touch_batch, &mut effects)?;
    let mut txs = Vec::new();
    for plan in plans {
        let account_id = plan.account_id.clone();
        let op_count = plan.ops.len();
        let total_amount = plan.total_amount.clone();
        let executor_is_left = views
            .iter()
            .find(|view| view.account_id == plan.account_id)
            .is_some_and(|view| view.owner_side == Side::Left);
        txs.push(projected(
            EntityTxKind::SettlePropose,
            CanonicalValue::Object(vec![
                (
                    "counterpartyEntityId".into(),
                    CanonicalValue::String(plan.account_id),
                ),
                ("ops".into(), CanonicalValue::Array(plan.ops)),
                (
                    "executorIsLeft".into(),
                    CanonicalValue::Bool(executor_is_left),
                ),
                (
                    "memo".into(),
                    CanonicalValue::String("auto-c2r-rebalance".into()),
                ),
            ]),
        )?);
        effects.push(diagnostic(
            state,
            2,
            "ok",
            "c2r_settle_propose_queued",
            vec![
                ("counterpartyId".into(), CanonicalValue::String(account_id)),
                (
                    "ops".into(),
                    number_u64(
                        u64::try_from(op_count).map_err(|_| {
                            EntityKernelError::local("hubRebalance", "OPS_OVERFLOW")
                        })?,
                    )?,
                ),
                (
                    "amount".into(),
                    CanonicalValue::String(total_amount.to_string()),
                ),
            ],
        ));
    }
    for account_id in &executable {
        txs.push(projected(
            EntityTxKind::SettleExecute,
            CanonicalValue::Object(vec![(
                "counterpartyEntityId".into(),
                CanonicalValue::String(account_id.clone()),
            )]),
        )?);
        effects.push(diagnostic(
            state,
            2,
            "ok",
            "c2r_settle_execute_queued",
            vec![(
                "counterpartyId".into(),
                CanonicalValue::String(account_id.clone()),
            )],
        ));
    }
    let has_batch_work = queued_r2c > 0 || !executable.is_empty();
    let sent_batch_pending = state
        .j_batch_state
        .as_ref()
        .is_some_and(|batch| batch.sent_batch.is_some());
    if has_batch_work && can_touch_batch && !manual_broadcast_in_input && !sent_batch_pending {
        txs.push(projected(
            EntityTxKind::JBroadcast,
            CanonicalValue::Object(Vec::new()),
        )?);
        effects.push(diagnostic(
            state,
            3,
            "ok",
            "j_broadcast_queued",
            vec![
                (
                    "queuedCount".into(),
                    number_u64(u64::try_from(queued_r2c + executable.len()).map_err(|_| {
                        EntityKernelError::local("hubRebalance", "COUNT_OVERFLOW")
                    })?)?,
                ),
                ("sentBatchPending".into(), CanonicalValue::Bool(false)),
            ],
        ));
    } else if has_batch_work {
        effects.push(diagnostic(
            state,
            3,
            "blocked",
            "j_broadcast_skipped",
            vec![
                (
                    "queuedCount".into(),
                    number_u64(u64::try_from(queued_r2c + executable.len()).map_err(|_| {
                        EntityKernelError::local("hubRebalance", "COUNT_OVERFLOW")
                    })?)?,
                ),
                (
                    "sentBatchPending".into(),
                    CanonicalValue::Bool(sent_batch_pending),
                ),
            ],
        ));
    }
    Ok(HubRebalanceResult {
        outputs: self_output(state, txs),
        envelope_mutations,
        effects,
    })
}

fn fixed_entity_id(value: &str) -> Result<[u8; 32], EntityKernelError> {
    let raw = value
        .strip_prefix("0x")
        .ok_or_else(|| EntityKernelError::local("hubRebalance", "ENTITY_ID_HEX"))?;
    if raw.len() != 64 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(EntityKernelError::local("hubRebalance", "ENTITY_ID_HEX"));
    }
    let bytes = (0..64)
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&raw[index..index + 2], 16)
                .map_err(|_| EntityKernelError::local("hubRebalance", "ENTITY_ID_HEX"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    bytes
        .try_into()
        .map_err(|_| EntityKernelError::local("hubRebalance", "ENTITY_ID_HEX"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{JBatchState, SentJBatch};

    fn hub_state(now: u64) -> EntityStateSlice {
        let mut state = EntityStateSlice::empty(format!("0x{}", "11".repeat(32)), now);
        state.hub_rebalance_config = Some(CanonicalValue::Object(vec![
            (
                "matchingStrategy".into(),
                CanonicalValue::String("amount".into()),
            ),
            (
                "policyVersion".into(),
                CanonicalValue::Number(CanonicalNumber::from_u32(1)),
            ),
            (
                "rebalanceLiquidityFeeBps".into(),
                CanonicalValue::BigInt(BigInt::from(0_u8)),
            ),
        ]));
        state
    }

    fn state_with_sent(now: u64, submitted_at: u64) -> EntityStateSlice {
        let mut state = EntityStateSlice::empty(format!("0x{}", "11".repeat(32)), now);
        let mut batch = JBatchState::default();
        batch.sent_batch = Some(SentJBatch {
            batch: Default::default(),
            batch_hash: [0; 32],
            encoded_batch: Vec::new(),
            entity_nonce: 1,
            first_submitted_at: submitted_at,
            last_submitted_at: submitted_at,
            submit_attempts: 1,
            fee_overrides: None,
            transaction_hash: None,
            last_failure: None,
            terminal_failure: None,
        });
        state.j_batch_state = Some(batch);
        state
    }

    fn diagnostic_event(output: &EntityKernelOutput) -> &str {
        let EntityKernelOutput::Debug {
            payload: CanonicalValue::Object(fields),
        } = output
        else {
            panic!("debug output")
        };
        match field(fields, "event") {
            Some(CanonicalValue::String(value)) => value,
            _ => panic!("debug event"),
        }
    }

    fn r2c_view(account_byte: u8, requested: u64, requested_at: u64) -> HubRebalanceAccountView {
        let token = TokenId::new(1).expect("token");
        let amount = BigInt::from(requested);
        let delta = Delta::new(
            token,
            BigInt::from(0_u8),
            -amount.clone(),
            BigInt::from(0_u8),
            BigInt::from(0_u8),
            BigInt::from(0_u8),
            BigInt::from(0_u8),
            BigInt::from(0_u8),
            BigInt::from(0_u8),
            BigInt::from(0_u8),
        )
        .expect("delta");
        HubRebalanceAccountView {
            account_id: format!("0x{}", format!("{account_byte:02x}").repeat(32)),
            owner_side: Side::Left,
            pending_frame: false,
            settlement_transition_pending: false,
            settlement_workspace: None,
            requested_rebalance: [(token, amount)].into_iter().collect(),
            fee_state: [(
                token,
                HubRebalanceFeeState {
                    request_id: format!("request-{account_byte:02x}"),
                    fee_paid_upfront: BigInt::from(1_000_000_u64),
                    policy_version: 1,
                    requested_at,
                    refund: false,
                    refunded_amount: None,
                },
            )]
            .into_iter()
            .collect(),
            submitted_at_by_token: BTreeMap::new(),
            deltas: [(token, delta)].into_iter().collect(),
        }
    }

    #[test]
    fn amount_priority_funds_later_larger_request_first_when_reserve_is_scarce() {
        let mut state = hub_state(100);
        state.reserves.insert(1, BigInt::from(600_u64));
        let views = [r2c_view(0x22, 400, 1), r2c_view(0x33, 900, 2)];
        let mut effects = Vec::new();

        let targets = collect_r2c_targets(
            &state,
            &views,
            MatchingStrategy::Amount,
            1,
            &BigInt::from(0_u8),
            &mut effects,
        )
        .expect("targets");

        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].account_id, format!("0x{}", "33".repeat(32)));
        assert_eq!(targets[0].amount, BigInt::from(600_u64));
        assert_eq!(
            effects.iter().map(diagnostic_event).collect::<Vec<_>>(),
            ["hub_reserve_zero"]
        );
    }

    #[test]
    fn fresh_sent_batch_is_a_noop_but_stale_batch_queues_one_abort() {
        let fresh = resolve_sent_batch(&state_with_sent(120_000, 1)).expect("fresh");
        assert!(!fresh.0);
        assert!(fresh.1.is_none());

        let stale = resolve_sent_batch(&state_with_sent(120_002, 1))
            .expect("stale")
            .1
            .expect("handled");
        assert_eq!(stale.len(), 1);
        assert!(matches!(
            stale[0].entity_txs.as_slice(),
            [LocalEntityOutputTx::Projected(tx)] if tx.kind == EntityTxKind::JAbortSentBatch
        ));
    }

    #[test]
    fn fresh_sent_batch_still_queues_c2r_proposal_from_account_work() {
        let mut state = hub_state(100);
        state.j_batch_state = state_with_sent(100, 50).j_batch_state;
        let token = TokenId::new(1).expect("token");
        let delta = Delta::new(
            token,
            BigInt::from(1_000_000_000_u64),
            BigInt::from(600_000_000_u64),
            BigInt::from(0_u8),
            BigInt::from(0_u8),
            BigInt::from(0_u8),
            BigInt::from(0_u8),
            BigInt::from(0_u8),
            BigInt::from(0_u8),
            BigInt::from(0_u8),
        )
        .expect("delta");
        let account_id = format!("0x{}", "22".repeat(32));
        let view = HubRebalanceAccountView {
            account_id,
            owner_side: Side::Left,
            pending_frame: false,
            settlement_transition_pending: false,
            settlement_workspace: None,
            requested_rebalance: BTreeMap::new(),
            fee_state: BTreeMap::new(),
            submitted_at_by_token: BTreeMap::new(),
            deltas: [(token, delta)].into_iter().collect(),
        };
        let result = apply_hub_rebalance(&mut state, &[view], false).expect("rebalance");
        assert!(result.envelope_mutations.is_empty());
        assert!(matches!(
            result.outputs[0].entity_txs.as_slice(),
            [LocalEntityOutputTx::Projected(tx)] if tx.kind == EntityTxKind::SettlePropose
        ));
        assert_eq!(
            result
                .effects
                .iter()
                .map(diagnostic_event)
                .collect::<Vec<_>>(),
            [
                "c2r_withdraw_overcollateralized",
                "c2r_settle_propose_queued"
            ]
        );
    }

    #[test]
    fn r2c_request_queues_batch_marker_and_broadcast_atomically() {
        let mut state = hub_state(100);
        let token = TokenId::new(1).expect("token");
        state
            .reserves
            .insert(token.get(), BigInt::from(1_000_000_u64));
        let delta = Delta::new(
            token,
            BigInt::from(0_u8),
            BigInt::from(-1_000_000_i64),
            BigInt::from(0_u8),
            BigInt::from(0_u8),
            BigInt::from(0_u8),
            BigInt::from(0_u8),
            BigInt::from(0_u8),
            BigInt::from(0_u8),
            BigInt::from(0_u8),
        )
        .expect("delta");
        let account_id = format!("0x{}", "22".repeat(32));
        let view = HubRebalanceAccountView {
            account_id: account_id.clone(),
            owner_side: Side::Left,
            pending_frame: false,
            settlement_transition_pending: false,
            settlement_workspace: None,
            requested_rebalance: [(token, BigInt::from(500_000_u64))].into_iter().collect(),
            fee_state: [(
                token,
                HubRebalanceFeeState {
                    request_id: "request-1".into(),
                    fee_paid_upfront: BigInt::from(100_000_u64),
                    policy_version: 1,
                    requested_at: 1,
                    refund: false,
                    refunded_amount: None,
                },
            )]
            .into_iter()
            .collect(),
            submitted_at_by_token: BTreeMap::new(),
            deltas: [(token, delta)].into_iter().collect(),
        };
        let result = apply_hub_rebalance(&mut state, &[view], false).expect("rebalance");
        assert!(matches!(
            result.envelope_mutations.as_slice(),
            [(target, AccountEnvelopeMutation::SetRebalanceSubmittedAt { token_id: 1, submitted_at: Some(100) })]
                if target == &account_id
        ));
        assert!(matches!(
            result.outputs[0].entity_txs.as_slice(),
            [LocalEntityOutputTx::Projected(tx)] if tx.kind == EntityTxKind::JBroadcast
        ));
        assert_eq!(
            state
                .j_batch_state
                .as_ref()
                .expect("batch")
                .batch
                .reserve_to_collateral
                .len(),
            1
        );
        assert_eq!(
            result
                .effects
                .iter()
                .map(diagnostic_event)
                .collect::<Vec<_>>(),
            ["batch_add", "j_broadcast_queued"]
        );
    }

    #[test]
    fn old_submitted_request_remains_exact_once_latched() {
        let mut state = hub_state(1_000_000);
        let token = TokenId::new(1).expect("token");
        state
            .reserves
            .insert(token.get(), BigInt::from(1_000_000_u64));
        let delta = Delta::new(
            token,
            BigInt::from(0_u8),
            BigInt::from(-500_000_i64),
            BigInt::from(0_u8),
            BigInt::from(0_u8),
            BigInt::from(0_u8),
            BigInt::from(0_u8),
            BigInt::from(0_u8),
            BigInt::from(0_u8),
            BigInt::from(0_u8),
        )
        .expect("delta");
        let account_id = format!("0x{}", "22".repeat(32));
        let view = HubRebalanceAccountView {
            account_id,
            owner_side: Side::Left,
            pending_frame: false,
            settlement_transition_pending: false,
            settlement_workspace: None,
            requested_rebalance: [(token, BigInt::from(500_000_u64))].into_iter().collect(),
            fee_state: [(
                token,
                HubRebalanceFeeState {
                    request_id: "already-submitted-request".into(),
                    fee_paid_upfront: BigInt::from(100_000_u64),
                    policy_version: 1,
                    requested_at: 1,
                    refund: false,
                    refunded_amount: None,
                },
            )]
            .into_iter()
            .collect(),
            submitted_at_by_token: [(token, 1)].into_iter().collect(),
            deltas: [(token, delta)].into_iter().collect(),
        };

        let result = apply_hub_rebalance(&mut state, &[view], false).expect("rebalance");

        assert!(result.envelope_mutations.is_empty());
        assert!(result.outputs.is_empty());
        assert!(
            state
                .j_batch_state
                .as_ref()
                .expect("batch")
                .batch
                .reserve_to_collateral
                .is_empty()
        );
    }
}

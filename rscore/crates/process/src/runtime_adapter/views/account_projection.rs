//! Network-only financial Account projection. Amounts come from committed getters;
//! perspective/capacity stays in the canonical engine and no signing seed is exposed.
use xln_rscore_engine::{AccountState, Delta, HtlcLock, Side, StateError};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue as V};

pub(in crate::runtime_adapter) fn number(value: u64) -> Result<V, StateError> {
    CanonicalNumber::try_from_u64(value)
        .map(V::Number)
        .map_err(|error| StateError::Envelope(error.to_string()))
}
pub(in crate::runtime_adapter) fn text(value: impl Into<String>) -> V {
    V::String(value.into())
}
pub(in crate::runtime_adapter) fn object<const N: usize>(fields: [(&str, V); N]) -> V {
    V::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}
pub(in crate::runtime_adapter) fn token(value: u16) -> V {
    V::Number(CanonicalNumber::from_u16(value))
}
pub(in crate::runtime_adapter) fn root(value: &[u8; 32]) -> V {
    text(format!("0x{}", hex::encode(value)))
}

pub(in crate::runtime_adapter) fn delta(value: &Delta) -> V {
    object([
        ("tokenId", token(value.token_id().get())),
        ("collateral", V::BigInt(value.collateral().clone())),
        ("ondelta", V::BigInt(value.ondelta().clone())),
        ("offdelta", V::BigInt(value.offdelta().clone())),
        (
            "leftCreditLimit",
            V::BigInt(value.left_credit_limit().clone()),
        ),
        (
            "rightCreditLimit",
            V::BigInt(value.right_credit_limit().clone()),
        ),
        (
            "leftAllowance",
            V::BigInt(value.allowance(Side::Left).clone()),
        ),
        (
            "rightAllowance",
            V::BigInt(value.allowance(Side::Right).clone()),
        ),
        ("leftHold", V::BigInt(value.hold(Side::Left).clone())),
        ("rightHold", V::BigInt(value.hold(Side::Right).clone())),
    ])
}
fn lock(value: &HtlcLock) -> Result<V, StateError> {
    let mut fields = vec![
        ("lockId".into(), text(value.lock_id())),
        ("hashlock".into(), text(value.hashlock().as_str())),
        ("timelock".into(), V::BigInt(value.timelock().clone())),
        (
            "revealBeforeHeight".into(),
            number(value.reveal_before_height())?,
        ),
        ("amount".into(), V::BigInt(value.amount().clone())),
        ("tokenId".into(), token(value.token_id().get())),
        ("senderIsLeft".into(), V::Bool(value.sender() == Side::Left)),
        ("createdHeight".into(), number(value.created_height())?),
        (
            "createdTimestamp".into(),
            number(value.created_timestamp())?,
        ),
    ];
    if let Some(hash) = value.envelope_hash() {
        fields.push(("envelopeHash".into(), root(hash)));
    }
    Ok(V::Object(fields))
}

pub fn account_state(state: &AccountState) -> Result<V, StateError> {
    let identity = state.identity();
    let dispute = state.dispute_config();
    let mut fields = vec![
        ("leftEntity".into(), text(identity.left().to_string())),
        ("rightEntity".into(), text(identity.right().to_string())),
        (
            "domain".into(),
            object([
                ("chainId", number(identity.domain().chain_id())?),
                (
                    "depositoryAddress",
                    text(format!(
                        "0x{}",
                        hex::encode(identity.domain().depository_address().bytes())
                    )),
                ),
            ]),
        ),
        ("watchSeed".into(), text("")),
        (
            "disputeConfig".into(),
            object([
                (
                    "leftResponseSeconds",
                    number(u64::from(dispute.left_response_seconds()))?,
                ),
                (
                    "rightResponseSeconds",
                    number(u64::from(dispute.right_response_seconds()))?,
                ),
            ]),
        ),
        ("jNonce".into(), number(state.j_nonce())?),
        (
            "lastFinalizedJHeight".into(),
            number(state.last_finalized_j_height())?,
        ),
        (
            "deltas".into(),
            V::Map(
                state
                    .deltas()
                    .take(100)
                    .map(|value| (token(value.token_id().get()), delta(value)))
                    .collect(),
            ),
        ),
        (
            "swapOffers".into(),
            V::Map(
                state
                    .swap_offers()
                    .map(|value| Ok((text(value.offer_id()), value.canonical()?)))
                    .collect::<Result<Vec<_>, StateError>>()?,
            ),
        ),
    ];
    let locks = state.htlc_locks().collect::<Vec<_>>();
    fields.push((
        "locks".into(),
        V::Map(
            locks
                .iter()
                .skip(locks.len().saturating_sub(20))
                .map(|value| Ok((text(value.lock_id()), lock(value)?)))
                .collect::<Result<Vec<_>, StateError>>()?,
        ),
    ));
    let requests = state.requested_rebalance_entries()?;
    fields.push((
        "requestedRebalance".into(),
        V::Map(
            requests
                .into_iter()
                .take(100)
                .map(|(id, amount)| (token(id.get()), V::BigInt(amount)))
                .collect(),
        ),
    ));
    let fees = state.requested_rebalance_fee_entries()?;
    fields.push((
        "requestedRebalanceFeeState".into(),
        V::Map(
            fees.iter()
                .take(100)
                .map(|(id, fee)| Ok((token(id.get()), request_fee(fee)?)))
                .collect::<Result<Vec<_>, StateError>>()?,
        ),
    ));
    let policies = state.rebalance_fee_policy_entries()?;
    fields.push((
        "rebalanceFeePolicies".into(),
        V::Map(
            policies
                .into_iter()
                .take(100)
                .map(|(id, policy)| Ok((token(id.get()), policy_value(&policy)?)))
                .collect::<Result<Vec<_>, StateError>>()?,
        ),
    ));
    for (name, claim) in [
        ("leftPendingJClaims", &state.carried().left_pending_j_claims),
        (
            "rightPendingJClaims",
            &state.carried().right_pending_j_claims,
        ),
    ] {
        fields.push((
            name.into(),
            object([("root", root(&claim.root)), ("count", number(claim.count)?)]),
        ));
    }
    let pull_ids = state.pull_ids()?;
    fields.push((
        "pulls".into(),
        V::Map(
            pull_ids
                .iter()
                .skip(pull_ids.len().saturating_sub(20))
                .map(|id| {
                    let value = state
                        .pull(id)
                        .ok_or_else(|| StateError::Envelope("ACCOUNT_PULL_BODY_MISSING".into()))?;
                    Ok((text(id.clone()), value.clone()))
                })
                .collect::<Result<Vec<_>, StateError>>()?,
        ),
    ));
    // This compact DTO intentionally excludes the settlement workspace and witnesses,
    // matching compactAccountDocForView; financial state remains native-owned.
    Ok(V::Object(fields))
}

fn policy_value(policy: &xln_rscore_engine::BilateralRebalanceFeePolicy) -> Result<V, StateError> {
    let mut fields = vec![];
    for (name, side) in [("left", Side::Left), ("right", Side::Right)] {
        if let Some(p) = policy.side(side) {
            fields.push((
                name.into(),
                object([
                    ("policyVersion", number(p.policy_version())?),
                    ("baseFee", V::BigInt(p.base_fee().clone())),
                    ("liquidityFeeBps", V::BigInt(p.liquidity_fee_bps().clone())),
                    ("gasFee", V::BigInt(p.gas_fee().clone())),
                    ("updatedAt", number(p.updated_at())?),
                ]),
            ));
        }
    }
    Ok(V::Object(fields))
}
fn request_fee(fee: &xln_rscore_engine::RebalanceRequestFeeState) -> Result<V, StateError> {
    let mut fields = vec![
        ("requestId".into(), text(fee.request_id.clone())),
        ("feeTokenId".into(), token(fee.fee_token_id.get())),
        (
            "feePaidUpfront".into(),
            V::BigInt(fee.fee_paid_upfront.clone()),
        ),
        (
            "requestedAmount".into(),
            V::BigInt(fee.requested_amount.clone()),
        ),
        ("policyVersion".into(), number(fee.policy_version)?),
        ("requestedAt".into(), number(fee.requested_at)?),
        ("requestedByLeft".into(), V::Bool(fee.requested_by_left)),
    ];
    if let Some(refund) = &fee.refund {
        fields.push((
            "refund".into(),
            object([
                ("reason", text(refund.reason.wire_name())),
                ("refundedAmount", V::BigInt(refund.refunded_amount.clone())),
            ]),
        ));
    }
    Ok(V::Object(fields))
}

use xln_rscore_engine::{AccountConsensus, AccountFrame, canonical_tx_value};

fn frame(frame: &AccountFrame, state_hash: &[u8; 32]) -> Result<V, StateError> {
    let txs = frame
        .txs
        .iter()
        .skip(frame.txs.len().saturating_sub(20))
        .map(canonical_tx_value)
        .collect::<Result<Vec<_>, StateError>>()?;
    Ok(object([
        ("height", number(frame.height)?),
        ("timestamp", number(frame.timestamp)?),
        ("jHeight", number(frame.j_height)?),
        ("accountTxs", V::Array(txs)),
        ("prevFrameHash", text(frame.prev_frame_hash.clone())),
        ("accountStateRoot", root(&frame.account_state_root)),
        ("stateHash", root(state_hash)),
    ]))
}
fn select_fields(value: &V, names: &[&str]) -> Result<V, StateError> {
    let V::Object(fields) = value else {
        return Err(StateError::Envelope("ACCOUNT_VIEW_OBJECT_INVALID".into()));
    };
    Ok(V::Object(
        fields
            .iter()
            .filter(|(name, _)| names.contains(&name.as_str()))
            .cloned()
            .collect(),
    ))
}

pub fn account_view(account: &AccountConsensus) -> Result<V, StateError> {
    let envelope = account.checkpoint_envelope()?;
    let mut out = vec![
        ("state".into(), account_state(account.replica().state())?),
        ("mempool".into(), V::Array(vec![])),
        (
            "mempoolCount".into(),
            number(account.mempool().len() as u64)?,
        ),
        ("currentHeight".into(), number(account.current_height())?),
        ("rollbackCount".into(), number(account.rollback_count())?),
    ];
    for (name, value) in envelope.fields() {
        // Whitelist DTO fields. Never publish arbitrary recovery envelopes or watch secrets.
        if [
            "status",
            "proofHeader",
            "pendingWithdrawals",
            "lastRollbackFrameHash",
            "counterpartyDisputeProofNonce",
            "counterpartyDisputeProofBodyHash",
            "counterpartyDisputeHash",
            "counterpartySettlementHanko",
        ]
        .contains(&name.as_str())
        {
            out.push((name.clone(), value.clone()));
        } else if name == "activeDispute" {
            out.push((
                name.clone(),
                select_fields(
                    value,
                    &[
                        "startedByLeft",
                        "initialProofbodyHash",
                        "initialNonce",
                        "initialProposerIsLeft",
                        "disputeTimeout",
                        "jNonce",
                        "starterCounterProofCommitment",
                        "disputeStartTimestamp",
                        "observedOnChain",
                        "observedBlockNumber",
                        "batchNonce",
                        "selectedCounterNonce",
                        "selectedCounterProofbodyHash",
                        "selectedCounterProposerIsLeft",
                        "finalizeQueued",
                    ],
                )?,
            ));
        } else if name == "disputePrepare" {
            out.push((
                name.clone(),
                select_fields(value, &["startedAt", "readyAfter", "reason"])?,
            ));
        }
    }
    let current = match account.current() {
        Some(current) => frame(&current.frame, &current.state_hash)?,
        // The canonical TS/native Account genesis frame is H0/T0 with no signed hash.
        None => object([
            ("height", number(0)?),
            ("timestamp", number(0)?),
            ("jHeight", number(0)?),
            ("accountTxs", V::Array(vec![])),
            ("prevFrameHash", text("")),
            ("accountStateRoot", root(&[0; 32])),
            ("stateHash", text("")),
        ]),
    };
    out.push(("currentFrame".into(), current));
    if let Some(pending) = account.pending() {
        out.push((
            "pendingFrame".into(),
            frame(&pending.frame, &pending.state_hash)?,
        ));
    }
    let snapshot = account.consensus_snapshot();
    if let Some(hanko) = snapshot.counterparty_frame_hanko {
        out.push((
            "counterpartyFrameHanko".into(),
            text(format!("0x{}", hex::encode(hanko))),
        ));
    }
    let local_hanko = account
        .pending()
        .map(|pending| pending.hanko.clone())
        .or(snapshot.local_committed_frame_hanko);
    if let Some(hanko) = local_hanko {
        out.push((
            "currentFrameHanko".into(),
            text(format!("0x{}", hex::encode(hanko))),
        ));
    }
    let policies = envelope
        .rebalance_shadow_policy_rows()
        .into_iter()
        .take(100)
        .map(|(id, value)| Ok((number(u64::from(id))?, value)))
        .collect::<Result<Vec<_>, StateError>>()?;
    let submitted = envelope
        .rebalance_shadow_submitted_rows()
        .into_iter()
        .take(100)
        .map(|(id, timestamp)| Ok((number(u64::from(id))?, number(timestamp)?)))
        .collect::<Result<Vec<_>, StateError>>()?;
    let mut rebalance = vec![
        ("policy".into(), V::Map(policies)),
        ("submittedAtByToken".into(), V::Map(submitted)),
    ];
    if let Some((_, V::Object(shadow))) =
        envelope.fields().iter().find(|(name, _)| name == "shadow")
        && let Some((_, V::Object(fields))) = shadow.iter().find(|(name, _)| name == "rebalance")
    {
        rebalance.extend(
            fields
                .iter()
                .filter(|(name, _)| ["activeQuote", "pendingRequest"].contains(&name.as_str()))
                .cloned(),
        );
    }
    out.push((
        "shadow".into(),
        object([("rebalance", V::Object(rebalance))]),
    ));
    Ok(V::Object(out))
}

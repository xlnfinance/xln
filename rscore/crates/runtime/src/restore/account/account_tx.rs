//! Account transaction and Patricia-leaf wire decoders for exact restore.

use num_bigint::BigInt;
use xln_rscore_abi::AbiValue;
use xln_rscore_engine::{
    AccountTx, BilateralRebalanceFeePolicy, DeliveryMode, Delta, HtlcDeliveryMode, HtlcHashlock,
    HtlcLock, HtlcLockTx, HtlcResolveOutcome, HtlcResolveTx, JClaimAccumulator, JClaimNode,
    JClaimProof, JClaimRecord, JClaimSide, JEventClaimTx, JurisdictionEvent, LendingAction,
    LendingTermId, OpaqueHtlcCiphertext, RebalanceFeePolicySnapshot, RebalanceRefundReason, Side,
    SwapOffer, TokenId,
};

use super::account_canonical;

use super::account_value::{
    AccountWireRestoreError, bigint, bounded_u32, exact, fixed_bytes, hex_fixed, integer, invalid,
    js_number, optional_fixed_bytes, optional_text, text, text_list, token, tuple, unsigned,
};

fn optional_bigint(
    value: &AbiValue,
    field: &'static str,
) -> Result<Option<BigInt>, AccountWireRestoreError> {
    match value {
        AbiValue::Nil => Ok(None),
        value => bigint(value, field).map(Some),
    }
}

fn optional_u32(
    value: &AbiValue,
    field: &'static str,
) -> Result<Option<u32>, AccountWireRestoreError> {
    match value {
        AbiValue::Nil => Ok(None),
        value => bounded_u32(value, field).map(Some),
    }
}

fn lending_term(value: &AbiValue) -> Result<LendingTermId, AccountWireRestoreError> {
    match integer(value)? {
        0 => Ok(LendingTermId::OneHour),
        1 => Ok(LendingTermId::OneDay),
        2 => Ok(LendingTermId::OneMonth),
        value => Err(invalid(format!("LENDING_TERM:{value}"))),
    }
}

fn side(value: &AbiValue, field: &'static str) -> Result<Side, AccountWireRestoreError> {
    match integer(value)? {
        0 => Ok(Side::Left),
        1 => Ok(Side::Right),
        value => Err(invalid(format!("SIDE:{field}:{value}"))),
    }
}

fn delivery(value: &AbiValue) -> Result<DeliveryMode, AccountWireRestoreError> {
    match integer(value)? {
        0 => Ok(DeliveryMode::Direct),
        1 => Ok(DeliveryMode::Trusted),
        value => Err(invalid(format!("DELIVERY_MODE:{value}"))),
    }
}

fn optional_delivery(
    value: &AbiValue,
) -> Result<Option<HtlcDeliveryMode>, AccountWireRestoreError> {
    match value {
        AbiValue::Nil => Ok(None),
        value => match integer(value)? {
            0 => Ok(Some(HtlcDeliveryMode::Instant)),
            1 => Ok(Some(HtlcDeliveryMode::Async)),
            value => Err(invalid(format!("HTLC_DELIVERY_MODE:{value}"))),
        },
    }
}

fn optional_envelope(
    value: &AbiValue,
) -> Result<Option<OpaqueHtlcCiphertext>, AccountWireRestoreError> {
    match value {
        AbiValue::Nil => Ok(None),
        AbiValue::Bytes(bytes) => OpaqueHtlcCiphertext::from_packed(bytes.clone())
            .map(Some)
            .map_err(|error| invalid(format!("HTLC_ENVELOPE:{error}"))),
        _ => Err(invalid("HTLC_ENVELOPE")),
    }
}

fn direct(fields: &[AbiValue]) -> Result<AccountTx, AccountWireRestoreError> {
    let fields = exact(fields, 9, "directPayment")?;
    Ok(AccountTx::DirectPayment {
        token_id: token(&fields[1])?,
        amount: bigint(&fields[2], "amount")?,
        route: text_list(&fields[3])?,
        description: optional_text(&fields[4])?,
        from_entity_id: text(&fields[5])?.to_owned(),
        to_entity_id: text(&fields[6])?.to_owned(),
        delivery_mode: delivery(&fields[7])?,
        trusted_gateway_entity_id: optional_text(&fields[8])?,
    })
}

fn htlc_lock(fields: &[AbiValue]) -> Result<AccountTx, AccountWireRestoreError> {
    let fields = exact(fields, 9, "htlcLock")?;
    let hashlock = HtlcHashlock::parse(&hex_fixed(&fields[2], "hashlock", 32)?)
        .map_err(|error| invalid(format!("HASHLOCK:{error}")))?;
    Ok(AccountTx::HtlcLock(HtlcLockTx {
        lock_id: text(&fields[1])?.to_owned(),
        hashlock,
        timelock: bigint(&fields[3], "timelock")?,
        reveal_before_height: js_number(&fields[4], "revealBeforeHeight")?,
        amount: bigint(&fields[5], "amount")?,
        token_id: token(&fields[6])?,
        delivery_mode: optional_delivery(&fields[7])?,
        envelope: optional_envelope(&fields[8])?,
    }))
}

fn htlc_resolve(fields: &[AbiValue]) -> Result<AccountTx, AccountWireRestoreError> {
    let fields = exact(fields, 4, "htlcResolve")?;
    let outcome = match integer(&fields[2])? {
        0 => HtlcResolveOutcome::Secret {
            secret: hex_fixed(&fields[3], "secret", 32)?,
        },
        1 => HtlcResolveOutcome::Error {
            reason: optional_text(&fields[3])?,
        },
        value => return Err(invalid(format!("HTLC_OUTCOME:{value}"))),
    };
    Ok(AccountTx::HtlcResolve(HtlcResolveTx {
        lock_id: text(&fields[1])?.to_owned(),
        outcome,
    }))
}

fn add_delta(fields: &[AbiValue]) -> Result<AccountTx, AccountWireRestoreError> {
    let fields = exact(fields, 2, "addDelta")?;
    Ok(AccountTx::AddDelta {
        token_id: token(&fields[1])?,
    })
}

fn set_credit_limit(fields: &[AbiValue]) -> Result<AccountTx, AccountWireRestoreError> {
    let fields = exact(fields, 3, "setCreditLimit")?;
    Ok(AccountTx::SetCreditLimit {
        token_id: token(&fields[1])?,
        amount: bigint(&fields[2], "amount")?,
    })
}

fn rebalance_policy(fields: &[AbiValue]) -> Result<AccountTx, AccountWireRestoreError> {
    let fields = exact(fields, 6, "rebalancePolicy")?;
    Ok(AccountTx::RebalancePolicy {
        token_id: bounded_u32(&fields[1], "tokenId")?,
        policy_version: js_number(&fields[2], "policyVersion")?,
        base_fee: bigint(&fields[3], "baseFee")?,
        liquidity_fee_bps: bigint(&fields[4], "liquidityFeeBps")?,
        gas_fee: bigint(&fields[5], "gasFee")?,
    })
}

fn swap_offer(fields: &[AbiValue]) -> Result<AccountTx, AccountWireRestoreError> {
    let fields = exact(fields, 13, "swapOffer")?;
    let time_in_force = match &fields[10] {
        AbiValue::Nil => None,
        value => Some(
            u8::try_from(bounded_u32(value, "timeInForce")?)
                .map_err(|_| invalid("TIME_IN_FORCE"))?,
        ),
    };
    Ok(AccountTx::SwapOffer {
        offer_id: text(&fields[1])?.to_owned(),
        give_token_id: bounded_u32(&fields[2], "giveTokenId")?,
        give_token_decimals: bounded_u32(&fields[3], "giveTokenDecimals")?,
        give_amount: bigint(&fields[4], "giveAmount")?,
        want_token_id: bounded_u32(&fields[5], "wantTokenId")?,
        want_token_decimals: bounded_u32(&fields[6], "wantTokenDecimals")?,
        want_amount: bigint(&fields[7], "wantAmount")?,
        max_fee: bigint(&fields[8], "maxFee")?,
        min_net_receive: bigint(&fields[9], "minNetReceive")?,
        time_in_force,
        price_ticks: optional_bigint(&fields[11], "priceTicks")?,
        cross_jurisdiction: match &fields[12] {
            AbiValue::Nil => None,
            value => Some(canonical_object(value, "swapOfferCrossJurisdiction")?),
        },
    })
}

fn swap_cancel_request(fields: &[AbiValue]) -> Result<AccountTx, AccountWireRestoreError> {
    let fields = exact(fields, 2, "swapCancelRequest")?;
    Ok(AccountTx::SwapCancelRequest {
        offer_id: text(&fields[1])?.to_owned(),
    })
}

fn swap_resolve(fields: &[AbiValue]) -> Result<AccountTx, AccountWireRestoreError> {
    let fields = exact(fields, 18, "swapResolve")?;
    let cancel_remainder = match integer(&fields[5])? {
        0 => false,
        1 => true,
        value => return Err(invalid(format!("CANCEL_REMAINDER:{value}"))),
    };
    Ok(AccountTx::SwapResolve {
        offer_id: text(&fields[1])?.to_owned(),
        fill_ratio: bounded_u32(&fields[2], "fillRatio")?,
        fill_numerator: optional_bigint(&fields[3], "fillNumerator")?,
        fill_denominator: optional_bigint(&fields[4], "fillDenominator")?,
        cancel_remainder,
        comment: optional_text(&fields[6])?,
        resting_give_token_id: optional_u32(&fields[7], "restingGiveTokenId")?,
        resting_want_token_id: optional_u32(&fields[8], "restingWantTokenId")?,
        fee_token_id: optional_u32(&fields[9], "feeTokenId")?,
        fee_amount: optional_bigint(&fields[10], "feeAmount")?,
        execution_give_amount: optional_bigint(&fields[11], "executionGiveAmount")?,
        execution_want_amount: optional_bigint(&fields[12], "executionWantAmount")?,
        resting_price_ticks: optional_bigint(&fields[13], "restingPriceTicks")?,
        resting_give_amount: optional_bigint(&fields[14], "restingGiveAmount")?,
        resting_want_amount: optional_bigint(&fields[15], "restingWantAmount")?,
        resting_quantized_give: optional_bigint(&fields[16], "restingQuantizedGive")?,
        resting_quantized_want: optional_bigint(&fields[17], "restingQuantizedWant")?,
    })
}

fn canonical_object(
    value: &AbiValue,
    field: &'static str,
) -> Result<xln_rscore_engine::CanonicalValue, AccountWireRestoreError> {
    let value = account_canonical::value(value)?;
    if !matches!(value, xln_rscore_engine::CanonicalValue::Object(_)) {
        return Err(invalid(format!("CANONICAL_OBJECT:{field}")));
    }
    Ok(value)
}

fn lending_fund(fields: &[AbiValue]) -> Result<AccountTx, AccountWireRestoreError> {
    let fields = exact(fields, 8, "lendingFund")?;
    Ok(AccountTx::LendingFund {
        position_id: text(&fields[1])?.to_owned(),
        hub_entity_id: text(&fields[2])?.to_owned(),
        lender_entity_id: text(&fields[3])?.to_owned(),
        token_id: token(&fields[4])?,
        amount: bigint(&fields[5], "amount")?,
        term_id: lending_term(&fields[6])?,
        interest_bps: i64::try_from(integer(&fields[7])?)
            .map_err(|_| invalid("LENDING_INTEREST_BPS"))?,
    })
}

fn lending_borrow_request(fields: &[AbiValue]) -> Result<AccountTx, AccountWireRestoreError> {
    let fields = exact(fields, 8, "lendingBorrowRequest")?;
    Ok(AccountTx::LendingBorrowRequest {
        request_id: text(&fields[1])?.to_owned(),
        hub_entity_id: text(&fields[2])?.to_owned(),
        borrower_entity_id: text(&fields[3])?.to_owned(),
        token_id: unsigned(&fields[4], "tokenId")?,
        amount: bigint(&fields[5], "amount")?,
        term_id: lending_term(&fields[6])?,
        max_interest_bps: i64::try_from(integer(&fields[7])?)
            .map_err(|_| invalid("LENDING_MAX_INTEREST_BPS"))?,
    })
}

fn lending_repay(fields: &[AbiValue]) -> Result<AccountTx, AccountWireRestoreError> {
    let fields = exact(fields, 6, "lendingRepay")?;
    Ok(AccountTx::LendingRepay {
        loan_id: text(&fields[1])?.to_owned(),
        hub_entity_id: text(&fields[2])?.to_owned(),
        borrower_entity_id: text(&fields[3])?.to_owned(),
        token_id: token(&fields[4])?,
        amount: bigint(&fields[5], "amount")?,
    })
}

fn lending_credit(fields: &[AbiValue]) -> Result<AccountTx, AccountWireRestoreError> {
    let fields = exact(fields, 7, "lendingCredit")?;
    let action = match integer(&fields[1])? {
        0 => LendingAction::Grant,
        1 => LendingAction::Revoke,
        value => return Err(invalid(format!("LENDING_ACTION:{value}"))),
    };
    Ok(AccountTx::LendingCredit {
        action,
        loan_id: text(&fields[2])?.to_owned(),
        hub_entity_id: text(&fields[3])?.to_owned(),
        borrower_entity_id: text(&fields[4])?.to_owned(),
        token_id: token(&fields[5])?,
        credit_limit: bigint(&fields[6], "creditLimit")?,
    })
}

fn lending_close_request(fields: &[AbiValue]) -> Result<AccountTx, AccountWireRestoreError> {
    let fields = exact(fields, 4, "lendingCloseRequest")?;
    Ok(AccountTx::LendingCloseRequest {
        position_id: text(&fields[1])?.to_owned(),
        hub_entity_id: text(&fields[2])?.to_owned(),
        lender_entity_id: text(&fields[3])?.to_owned(),
    })
}

fn lending_close_payout(fields: &[AbiValue]) -> Result<AccountTx, AccountWireRestoreError> {
    let fields = exact(fields, 6, "lendingClosePayout")?;
    Ok(AccountTx::LendingClosePayout {
        position_id: text(&fields[1])?.to_owned(),
        hub_entity_id: text(&fields[2])?.to_owned(),
        lender_entity_id: text(&fields[3])?.to_owned(),
        token_id: token(&fields[4])?,
        amount: bigint(&fields[5], "amount")?,
    })
}

fn request_collateral(fields: &[AbiValue]) -> Result<AccountTx, AccountWireRestoreError> {
    let fields = exact(fields, 6, "requestCollateral")?;
    Ok(AccountTx::RequestCollateral {
        token_id: token(&fields[1])?,
        amount: bigint(&fields[2], "amount")?,
        fee_token_id: match &fields[3] {
            AbiValue::Nil => None,
            value => Some(token(value)?),
        },
        fee_amount: bigint(&fields[4], "feeAmount")?,
        policy_version: js_number(&fields[5], "policyVersion")?,
    })
}

fn rebalance_refund(fields: &[AbiValue]) -> Result<AccountTx, AccountWireRestoreError> {
    let fields = exact(fields, 5, "rebalanceRefund")?;
    let reason = match text(&fields[4])? {
        "policy_mismatch" => RebalanceRefundReason::PolicyMismatch,
        "timeout" => RebalanceRefundReason::Timeout,
        "fee_too_low" => RebalanceRefundReason::FeeTooLow,
        "manual" => RebalanceRefundReason::Manual,
        value => return Err(invalid(format!("REBALANCE_REFUND_REASON:{value}"))),
    };
    Ok(AccountTx::RebalanceRefund {
        request_id: text(&fields[1])?.to_owned(),
        request_token_id: token(&fields[2])?,
        amount: bigint(&fields[3], "amount")?,
        reason,
    })
}

fn canonical_tx(
    fields: &[AbiValue],
    field: &'static str,
    build: impl FnOnce(xln_rscore_engine::CanonicalValue) -> AccountTx,
) -> Result<AccountTx, AccountWireRestoreError> {
    let fields = exact(fields, 2, field)?;
    Ok(build(canonical_object(&fields[1], field)?))
}

fn jurisdiction_event(value: &AbiValue) -> Result<JurisdictionEvent, AccountWireRestoreError> {
    xln_rscore_batch::decode_jurisdiction_event(value).map_err(|error| invalid(error.to_string()))
}

fn claim_record(value: &AbiValue) -> Result<JClaimRecord, AccountWireRestoreError> {
    let fields = exact(tuple(value)?, 5, "jClaimRecord")?;
    let side = match integer(&fields[1])? {
        0 => JClaimSide::Left,
        1 => JClaimSide::Right,
        value => return Err(invalid(format!("J_CLAIM_SIDE:{value}"))),
    };
    Ok(JClaimRecord {
        account_key: fixed_bytes(&fields[0], "jClaimAccountKey")?,
        side,
        j_height: js_number(&fields[2], "jClaimRecordHeight")?,
        j_block_hash: fixed_bytes(&fields[3], "jClaimRecordBlockHash")?,
        events_hash: fixed_bytes(&fields[4], "jClaimRecordEventsHash")?,
    })
}

pub fn j_claim_node(value: &AbiValue) -> Result<JClaimNode, AccountWireRestoreError> {
    let fields = tuple(value)?;
    let tag = fields
        .first()
        .ok_or_else(|| invalid("J_CLAIM_NODE_TAG"))
        .and_then(integer)?;
    match tag {
        0 => {
            let fields = exact(fields, 3, "jClaimLeaf")?;
            Ok(JClaimNode::Leaf {
                key: fixed_bytes(&fields[1], "jClaimLeafKey")?,
                record: claim_record(&fields[2])?,
            })
        }
        1 => {
            let fields = exact(fields, 4, "jClaimBranch")?;
            Ok(JClaimNode::Branch {
                bit: u16::try_from(bounded_u32(&fields[1], "jClaimBranchBit")?)
                    .map_err(|_| invalid("J_CLAIM_BRANCH_BIT"))?,
                left: fixed_bytes(&fields[2], "jClaimBranchLeft")?,
                right: fixed_bytes(&fields[3], "jClaimBranchRight")?,
            })
        }
        value => Err(invalid(format!("J_CLAIM_NODE:{value}"))),
    }
}

fn claim_proof(
    value: &AbiValue,
    field: &'static str,
) -> Result<Option<JClaimProof>, AccountWireRestoreError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let fields = exact(tuple(value)?, 2, field)?;
    if integer(&fields[0])? != 1 {
        return Err(invalid("J_CLAIM_PROOF_VERSION"));
    }
    Ok(Some(JClaimProof {
        nodes: tuple(&fields[1])?
            .iter()
            .map(j_claim_node)
            .collect::<Result<_, _>>()?,
    }))
}

fn j_event_claim(fields: &[AbiValue]) -> Result<AccountTx, AccountWireRestoreError> {
    let fields = exact(fields, 7, "jEventClaim")?;
    let events = tuple(&fields[4])?
        .iter()
        .map(jurisdiction_event)
        .collect::<Result<Vec<_>, _>>()?;
    let supplied_events_hash = fixed_bytes(&fields[3], "jClaimEventsHash")?;
    let actual_events_hash = xln_rscore_engine::canonical_events_hash(&events)
        .map_err(|error| invalid(format!("J_CLAIM_EVENTS_HASH:{error}")))?;
    if supplied_events_hash != actual_events_hash {
        return Err(invalid("J_CLAIM_EVENTS_HASH_MISMATCH"));
    }
    Ok(AccountTx::JEventClaim(JEventClaimTx {
        j_height: js_number(&fields[1], "jClaimHeight")?,
        j_block_hash: fixed_bytes(&fields[2], "jClaimBlockHash")?,
        events,
        left_proof: claim_proof(&fields[5], "leftJClaimProof")?,
        right_proof: claim_proof(&fields[6], "rightJClaimProof")?,
    }))
}

pub fn transaction(value: &AbiValue) -> Result<AccountTx, AccountWireRestoreError> {
    let fields = tuple(value)?;
    let tag = fields
        .first()
        .ok_or_else(|| invalid("TX_TAG"))
        .and_then(integer)?;
    match tag {
        0 => direct(fields),
        1 => htlc_lock(fields),
        2 => htlc_resolve(fields),
        3 => add_delta(fields),
        4 => set_credit_limit(fields),
        5 => rebalance_policy(fields),
        6 => swap_offer(fields),
        7 => swap_cancel_request(fields),
        8 => swap_resolve(fields),
        9 => j_event_claim(fields),
        10 => lending_fund(fields),
        11 => lending_borrow_request(fields),
        12 => lending_repay(fields),
        13 => lending_credit(fields),
        14 => lending_close_request(fields),
        15 => lending_close_payout(fields),
        17 => request_collateral(fields),
        18 => rebalance_refund(fields),
        19 => canonical_tx(fields, "crossPullLock", |data| AccountTx::CrossPullLock {
            data,
        }),
        20 => canonical_tx(fields, "crossPullClose", |data| AccountTx::CrossPullClose {
            data,
        }),
        21 => canonical_tx(fields, "crossPullProgress", |data| {
            AccountTx::CrossPullProgress { data }
        }),
        22 => canonical_tx(fields, "crossSwapFillAck", |data| {
            AccountTx::CrossSwapFillAck { data }
        }),
        23 => canonical_tx(fields, "settleTransition", |data| {
            AccountTx::SettleTransition { data }
        }),
        value => Err(invalid(format!("TX_TAG:{value}"))),
    }
}

pub fn delta(value: &AbiValue) -> Result<Delta, AccountWireRestoreError> {
    let fields = exact(tuple(value)?, 10, "delta")?;
    Delta::new(
        token(&fields[0])?,
        bigint(&fields[1], "collateral")?,
        bigint(&fields[2], "ondelta")?,
        bigint(&fields[3], "offdelta")?,
        bigint(&fields[4], "leftCreditLimit")?,
        bigint(&fields[5], "rightCreditLimit")?,
        bigint(&fields[6], "leftAllowance")?,
        bigint(&fields[7], "rightAllowance")?,
        bigint(&fields[8], "leftHold")?,
        bigint(&fields[9], "rightHold")?,
    )
    .map_err(|error| invalid(format!("DELTA:{error}")))
}

pub fn lock(value: &AbiValue) -> Result<HtlcLock, AccountWireRestoreError> {
    let fields = exact(tuple(value)?, 10, "htlcState")?;
    HtlcLock::restore(
        text(&fields[0])?.to_owned(),
        HtlcHashlock::parse(&hex_fixed(&fields[1], "hashlock", 32)?)
            .map_err(|error| invalid(format!("HASHLOCK:{error}")))?,
        bigint(&fields[2], "timelock")?,
        js_number(&fields[3], "revealBeforeHeight")?,
        bigint(&fields[4], "amount")?,
        token(&fields[5])?,
        side(&fields[6], "sender")?,
        js_number(&fields[7], "createdHeight")?,
        js_number(&fields[8], "createdTimestamp")?,
        optional_fixed_bytes(&fields[9], "envelopeHash")?,
    )
    .map_err(|error| invalid(format!("HTLC_LOCK:{error}")))
}

fn offer_fields(
    row: &[AbiValue],
    give_amount: BigInt,
    want_amount: BigInt,
) -> Result<SwapOffer, AccountWireRestoreError> {
    let time_in_force = match &row[10] {
        AbiValue::Nil => None,
        value => Some(
            u8::try_from(bounded_u32(value, "timeInForce")?)
                .map_err(|_| invalid("TIME_IN_FORCE"))?,
        ),
    };
    Ok(SwapOffer::new(
        text(&row[0])?.to_owned(),
        bounded_u32(&row[1], "giveTokenId")?,
        bounded_u32(&row[2], "giveTokenDecimals")?,
        give_amount,
        bounded_u32(&row[4], "wantTokenId")?,
        bounded_u32(&row[5], "wantTokenDecimals")?,
        want_amount,
        bigint(&row[7], "maxFee")?,
        bigint(&row[8], "minNetReceive")?,
        bigint(&row[9], "priceTicks")?,
        time_in_force,
        match integer(&row[11])? {
            0 => true,
            1 => false,
            value => return Err(invalid(format!("MAKER_IS_LEFT:{value}"))),
        },
        js_number(&row[12], "createdHeight")?,
    ))
}

pub fn swap_offer_state(value: &AbiValue) -> Result<SwapOffer, AccountWireRestoreError> {
    let row = exact(tuple(value)?, 16, "swapOffer")?;
    let mut offer = offer_fields(
        row,
        bigint(&row[3], "giveAmount")?,
        bigint(&row[6], "wantAmount")?,
    )?;
    offer
        .restore_quantized(
            bigint(&row[13], "quantizedGive")?,
            bigint(&row[14], "quantizedWant")?,
        )
        .map_err(|error| invalid(format!("SWAP_OFFER_QUANTIZED:{error}")))?;
    offer.set_cross_jurisdiction(match &row[15] {
        AbiValue::Nil => None,
        value => Some(canonical_object(value, "swapOfferCrossJurisdiction")?),
    });
    Ok(offer)
}

pub fn policy_snapshot(
    value: &AbiValue,
) -> Result<Option<RebalanceFeePolicySnapshot>, AccountWireRestoreError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let fields = exact(tuple(value)?, 5, "rebalancePolicySnapshot")?;
    Ok(Some(RebalanceFeePolicySnapshot::new(
        js_number(&fields[0], "policyVersion")?,
        bigint(&fields[1], "baseFee")?,
        bigint(&fields[2], "liquidityFeeBps")?,
        bigint(&fields[3], "gasFee")?,
        js_number(&fields[4], "updatedAt")?,
    )))
}

pub fn policy_entry(
    value: &AbiValue,
) -> Result<(TokenId, BilateralRebalanceFeePolicy), AccountWireRestoreError> {
    let fields = exact(tuple(value)?, 2, "policyEntry")?;
    let policy = exact(tuple(&fields[1])?, 2, "rebalancePolicy")?;
    Ok((
        token(&fields[0])?,
        BilateralRebalanceFeePolicy::new(
            policy_snapshot(&policy[0])?,
            policy_snapshot(&policy[1])?,
        ),
    ))
}

pub fn claim_accumulator(value: &AbiValue) -> Result<JClaimAccumulator, AccountWireRestoreError> {
    let fields = exact(tuple(value)?, 2, "claimAccumulator")?;
    Ok(JClaimAccumulator {
        root: fixed_bytes(&fields[0], "claimRoot")?,
        count: unsigned(&fields[1], "claimCount")?,
    })
}

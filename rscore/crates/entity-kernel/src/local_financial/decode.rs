use num_bigint::BigInt;
use sha3::{Digest as _, Keccak256};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, CanonicalValue, DeliveryMode, DepositoryAddress,
    LendingTermId, TokenId, WatchSeed,
};

use crate::{CanonicalEntityTx, EntityKernelError, EntityTxKind, OriginatedHtlcDeliveryMode};

use super::types::{
    CanonicalRebalancePolicy, DirectPaymentEntityTx, DisputeFinalizeEntityTx, DisputeStartEntityTx,
    ExtendCreditEntityTx, ForceSiblingDisputeEntityTx, HtlcPaymentEntityTx, LendingBorrowEntityTx,
    LendingClosePositionEntityTx, LendingOfferEntityTx, LendingRepayEntityTx,
    LocalEntityFinancialTx, OpenAccountEntityTx, PlaceSwapOfferEntityTx, PrepareDisputeEntityTx,
    ProcessHtlcTimeoutsEntityTx, ProposeCancelSwapEntityTx, QuoteBackedR2cEntityTx,
    RequestCollateralEntityTx, ResolveHtlcLockEntityTx, SetRebalancePolicyEntityTx,
    SettleApproveEntityTx, SettleExecuteEntityTx, SettleProposeEntityTx, SettleRejectEntityTx,
    SettleUpdateEntityTx,
};

fn force_sibling_dispute(
    tx: &CanonicalEntityTx,
) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "crossJurisdictionForceSiblingDispute";
    let data = object(frame_data(tx, KIND)?, KIND)?;
    exact_fields(
        data,
        &["routeId", "observedCounterpartyEntityId"],
        &["observedAt"],
        KIND,
    )?;
    Ok(
        LocalEntityFinancialTx::CrossJurisdictionForceSiblingDispute(ForceSiblingDisputeEntityTx {
            route_id: string(field(data, "routeId", KIND)?, KIND, "ROUTE_ID")?,
            observed_counterparty_entity_id: entity_id(
                field(data, "observedCounterpartyEntityId", KIND)?,
                KIND,
                "OBSERVED_COUNTERPARTY_ENTITY_ID",
            )?,
            observed_at: optional_field(data, "observedAt")
                .map(|value| u64_number(value, KIND, "OBSERVED_AT"))
                .transpose()?,
        }),
    )
}

const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn invalid(kind: &'static str, detail: &'static str) -> EntityKernelError {
    EntityKernelError::local(kind, detail)
}

fn object<'a>(
    value: &'a CanonicalValue,
    kind: &'static str,
) -> Result<&'a [(String, CanonicalValue)], EntityKernelError> {
    match value {
        CanonicalValue::Object(entries) => Ok(entries),
        _ => Err(invalid(kind, "DATA_OBJECT")),
    }
}

fn exact_fields(
    entries: &[(String, CanonicalValue)],
    required: &[&str],
    optional: &[&str],
    kind: &'static str,
) -> Result<(), EntityKernelError> {
    if required
        .iter()
        .any(|field| !entries.iter().any(|(key, _)| key == field))
        || entries
            .iter()
            .any(|(key, _)| !required.iter().chain(optional).any(|field| key == field))
    {
        return Err(invalid(kind, "DATA_FIELDS"));
    }
    Ok(())
}

fn field<'a>(
    entries: &'a [(String, CanonicalValue)],
    name: &str,
    kind: &'static str,
) -> Result<&'a CanonicalValue, EntityKernelError> {
    entries
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
        .ok_or_else(|| invalid(kind, "DATA_FIELDS"))
}

fn optional_field<'a>(
    entries: &'a [(String, CanonicalValue)],
    name: &str,
) -> Option<&'a CanonicalValue> {
    entries
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
}

fn string(
    value: &CanonicalValue,
    kind: &'static str,
    detail: &'static str,
) -> Result<String, EntityKernelError> {
    match value {
        CanonicalValue::String(value) => Ok(value.clone()),
        _ => Err(invalid(kind, detail)),
    }
}

fn entity_id(
    value: &CanonicalValue,
    kind: &'static str,
    detail: &'static str,
) -> Result<String, EntityKernelError> {
    let value = string(value, kind, detail)?;
    let valid = value.strip_prefix("0x").is_some_and(|payload| {
        payload.len() == 64
            && payload.bytes().all(|byte| byte.is_ascii_hexdigit())
            && value == value.to_lowercase()
    });
    valid.then_some(value).ok_or_else(|| invalid(kind, detail))
}

fn bigint(
    value: &CanonicalValue,
    kind: &'static str,
    detail: &'static str,
) -> Result<BigInt, EntityKernelError> {
    match value {
        CanonicalValue::BigInt(value) => Ok(value.clone()),
        _ => Err(invalid(kind, detail)),
    }
}

fn boolean(
    value: &CanonicalValue,
    kind: &'static str,
    detail: &'static str,
) -> Result<bool, EntityKernelError> {
    match value {
        CanonicalValue::Bool(value) => Ok(*value),
        _ => Err(invalid(kind, detail)),
    }
}

fn canonical_hash(
    value: &CanonicalValue,
    kind: &'static str,
    detail: &'static str,
) -> Result<String, EntityKernelError> {
    let value = string(value, kind, detail)?;
    let valid = value.strip_prefix("0x").is_some_and(|payload| {
        payload.len() == 64
            && payload.bytes().all(|byte| byte.is_ascii_hexdigit())
            && value == value.to_lowercase()
    });
    valid.then_some(value).ok_or_else(|| invalid(kind, detail))
}

fn u64_number(
    value: &CanonicalValue,
    kind: &'static str,
    detail: &'static str,
) -> Result<u64, EntityKernelError> {
    let CanonicalValue::Number(value) = value else {
        return Err(invalid(kind, detail));
    };
    value
        .as_str()
        .parse::<u64>()
        .ok()
        .filter(|value| *value <= JS_MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid(kind, detail))
}

fn u32_number(
    value: &CanonicalValue,
    kind: &'static str,
    detail: &'static str,
) -> Result<u32, EntityKernelError> {
    u32::try_from(u64_number(value, kind, detail)?).map_err(|_| invalid(kind, detail))
}

fn token(value: &CanonicalValue, kind: &'static str) -> Result<TokenId, EntityKernelError> {
    TokenId::new(u32_number(value, kind, "TOKEN_ID")?).map_err(|_| invalid(kind, "TOKEN_ID"))
}

fn lending_term(
    value: &CanonicalValue,
    kind: &'static str,
) -> Result<LendingTermId, EntityKernelError> {
    match string(value, kind, "TERM_ID")?.as_str() {
        "1h" => Ok(LendingTermId::OneHour),
        "1d" => Ok(LendingTermId::OneDay),
        "1m" => Ok(LendingTermId::OneMonth),
        _ => Err(invalid(kind, "TERM_ID")),
    }
}

fn interest_bps(value: &CanonicalValue, kind: &'static str) -> Result<u16, EntityKernelError> {
    u16::try_from(u64_number(value, kind, "INTEREST_BPS")?)
        .ok()
        .filter(|value| *value <= 10_000)
        .ok_or_else(|| invalid(kind, "INTEREST_BPS"))
}

fn string_array(
    value: &CanonicalValue,
    kind: &'static str,
    detail: &'static str,
) -> Result<Vec<String>, EntityKernelError> {
    let CanonicalValue::Array(values) = value else {
        return Err(invalid(kind, detail));
    };
    values
        .iter()
        .map(|value| entity_id(value, kind, detail))
        .collect()
}

fn optional_string(
    entries: &[(String, CanonicalValue)],
    name: &str,
    kind: &'static str,
    detail: &'static str,
) -> Result<Option<String>, EntityKernelError> {
    optional_field(entries, name)
        .map(|value| string(value, kind, detail))
        .transpose()
}

fn optional_bigint(
    entries: &[(String, CanonicalValue)],
    name: &str,
    kind: &'static str,
    detail: &'static str,
) -> Result<Option<BigInt>, EntityKernelError> {
    optional_field(entries, name)
        .map(|value| bigint(value, kind, detail))
        .transpose()
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut value = String::with_capacity(bytes.len() * 2 + 2);
    value.push_str("0x");
    for byte in bytes {
        value.push(char::from(DIGITS[usize::from(byte >> 4)]));
        value.push(char::from(DIGITS[usize::from(byte & 15)]));
    }
    value
}

fn raw_tx_hash(tx: &CanonicalEntityTx) -> Result<String, EntityKernelError> {
    Ok(hex(&Keccak256::digest(tx.frame_payload())))
}

fn frame_data<'a>(
    tx: &'a CanonicalEntityTx,
    kind: &'static str,
) -> Result<&'a CanonicalValue, EntityKernelError> {
    tx.frame_data()
        .ok_or_else(|| invalid(kind, "FRAME_DATA_MISSING"))
}

fn open_account(tx: &CanonicalEntityTx) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "openAccount";
    let data = object(frame_data(tx, KIND)?, KIND)?;
    exact_fields(
        data,
        &[
            "targetEntityId",
            "disputeConfig",
            "accountDomain",
            "watchSeed",
        ],
        &["creditAmount", "tokenId", "pinPublic", "rebalancePolicy"],
        KIND,
    )?;
    let dispute = object(field(data, "disputeConfig", KIND)?, KIND)?;
    exact_fields(
        dispute,
        &["leftResponseSeconds", "rightResponseSeconds"],
        &[],
        KIND,
    )?;
    let domain = object(field(data, "accountDomain", KIND)?, KIND)?;
    exact_fields(domain, &["chainId", "depositoryAddress"], &[], KIND)?;
    let token_id = optional_field(data, "tokenId")
        .map(|value| token(value, KIND))
        .transpose()?
        .unwrap_or(TokenId::new(1).map_err(|_| invalid(KIND, "TOKEN_ID"))?);
    let rebalance_policy = optional_field(data, "rebalancePolicy")
        .map(|value| {
            let policy = object(value, KIND)?;
            exact_fields(
                policy,
                &["r2cRequestSoftLimit", "hardLimit", "maxAcceptableFee"],
                &[],
                KIND,
            )?;
            let result = CanonicalRebalancePolicy {
                r2c_request_soft_limit: bigint(
                    field(policy, "r2cRequestSoftLimit", KIND)?,
                    KIND,
                    "REBALANCE_SOFT_LIMIT",
                )?,
                hard_limit: bigint(
                    field(policy, "hardLimit", KIND)?,
                    KIND,
                    "REBALANCE_HARD_LIMIT",
                )?,
                max_acceptable_fee: bigint(
                    field(policy, "maxAcceptableFee", KIND)?,
                    KIND,
                    "REBALANCE_MAX_FEE",
                )?,
            };
            if result.r2c_request_soft_limit <= BigInt::from(0)
                || result.hard_limit < result.r2c_request_soft_limit
                || result.max_acceptable_fee < BigInt::from(0)
            {
                return Err(invalid(KIND, "REBALANCE_POLICY_INVALID"));
            }
            Ok(result)
        })
        .transpose()?;
    Ok(LocalEntityFinancialTx::OpenAccount(OpenAccountEntityTx {
        target_entity_id: entity_id(field(data, "targetEntityId", KIND)?, KIND, "TARGET")?,
        dispute_config: AccountDisputeConfig::new(
            u64_number(
                field(dispute, "leftResponseSeconds", KIND)?,
                KIND,
                "LEFT_RESPONSE",
            )?,
            u64_number(
                field(dispute, "rightResponseSeconds", KIND)?,
                KIND,
                "RIGHT_RESPONSE",
            )?,
        )
        .map_err(|_| invalid(KIND, "DISPUTE_CONFIG"))?,
        account_domain: AccountDomain::new(
            u64_number(field(domain, "chainId", KIND)?, KIND, "CHAIN_ID")?,
            DepositoryAddress::parse(&string(
                field(domain, "depositoryAddress", KIND)?,
                KIND,
                "DEPOSITORY_ADDRESS",
            )?)
            .map_err(|_| invalid(KIND, "DEPOSITORY_ADDRESS"))?,
        )
        .map_err(|_| invalid(KIND, "ACCOUNT_DOMAIN"))?,
        watch_seed: WatchSeed::parse(&string(
            field(data, "watchSeed", KIND)?,
            KIND,
            "WATCH_SEED",
        )?)
        .map_err(|_| invalid(KIND, "WATCH_SEED"))?,
        credit_amount: optional_bigint(data, "creditAmount", KIND, "CREDIT_AMOUNT")?,
        token_id,
        pin_public: optional_field(data, "pinPublic")
            .map(|value| boolean(value, KIND, "PIN_PUBLIC"))
            .transpose()?
            .unwrap_or(true),
        rebalance_policy,
    }))
}

fn direct_payment(tx: &CanonicalEntityTx) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "directPayment";
    let data = object(frame_data(tx, KIND)?, KIND)?;
    exact_fields(
        data,
        &[
            "targetEntityId",
            "tokenId",
            "amount",
            "route",
            "deliveryMode",
        ],
        &["description", "trustedGatewayEntityId"],
        KIND,
    )?;
    let mode = match string(field(data, "deliveryMode", KIND)?, KIND, "DELIVERY_MODE")?.as_str() {
        "direct" => DeliveryMode::Direct,
        "trusted" => DeliveryMode::Trusted,
        _ => return Err(invalid(KIND, "DELIVERY_MODE")),
    };
    let trusted_gateway_entity_id = optional_field(data, "trustedGatewayEntityId")
        .map(|value| entity_id(value, KIND, "TRUSTED_GATEWAY"))
        .transpose()?;
    if (mode == DeliveryMode::Trusted) != trusted_gateway_entity_id.is_some() {
        return Err(invalid(KIND, "TRUSTED_GATEWAY"));
    }
    Ok(LocalEntityFinancialTx::DirectPayment(
        DirectPaymentEntityTx {
            target_entity_id: entity_id(field(data, "targetEntityId", KIND)?, KIND, "TARGET")?,
            token_id: token(field(data, "tokenId", KIND)?, KIND)?,
            amount: bigint(field(data, "amount", KIND)?, KIND, "AMOUNT")?,
            route: string_array(field(data, "route", KIND)?, KIND, "ROUTE")?,
            description: optional_string(data, "description", KIND, "DESCRIPTION")?,
            delivery_mode: mode,
            trusted_gateway_entity_id,
        },
    ))
}

fn prepare_dispute(tx: &CanonicalEntityTx) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "prepareDispute";
    let data = object(frame_data(tx, KIND)?, KIND)?;
    exact_fields(
        data,
        &["counterpartyEntityId"],
        &[
            "description",
            "minCooldownMs",
            "crossJurisdictionRouteId",
            "starterInitialArguments",
        ],
        KIND,
    )?;
    Ok(LocalEntityFinancialTx::PrepareDispute(
        PrepareDisputeEntityTx {
            counterparty_entity_id: entity_id(
                field(data, "counterpartyEntityId", KIND)?,
                KIND,
                "COUNTERPARTY_ENTITY_ID",
            )?,
            description: optional_string(data, "description", KIND, "DESCRIPTION")?,
            min_cooldown_ms: optional_field(data, "minCooldownMs")
                .map(|value| u64_number(value, KIND, "MIN_COOLDOWN_MS"))
                .transpose()?
                .unwrap_or(0),
            cross_jurisdiction_route_id: optional_string(
                data,
                "crossJurisdictionRouteId",
                KIND,
                "CROSS_JURISDICTION_ROUTE_ID",
            )?,
            starter_initial_arguments: optional_string(
                data,
                "starterInitialArguments",
                KIND,
                "STARTER_INITIAL_ARGUMENTS",
            )?,
        },
    ))
}

fn dispute_start(tx: &CanonicalEntityTx) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "disputeStart";
    let data = object(frame_data(tx, KIND)?, KIND)?;
    exact_fields(
        data,
        &["counterpartyEntityId"],
        &[
            "crossJurisdictionRouteId",
            "starterInitialArguments",
            "starterCounterArguments",
            "starterCounterProofCommitment",
            "description",
        ],
        KIND,
    )?;
    Ok(LocalEntityFinancialTx::DisputeStart(DisputeStartEntityTx {
        counterparty_entity_id: entity_id(
            field(data, "counterpartyEntityId", KIND)?,
            KIND,
            "COUNTERPARTY_ENTITY_ID",
        )?,
        description: optional_string(data, "description", KIND, "DESCRIPTION")?,
        cross_jurisdiction_route_id: optional_string(
            data,
            "crossJurisdictionRouteId",
            KIND,
            "CROSS_JURISDICTION_ROUTE_ID",
        )?,
        starter_initial_arguments: optional_string(
            data,
            "starterInitialArguments",
            KIND,
            "STARTER_INITIAL_ARGUMENTS",
        )?,
        starter_counter_arguments: optional_string(
            data,
            "starterCounterArguments",
            KIND,
            "STARTER_COUNTER_ARGUMENTS",
        )?,
        starter_counter_proof_commitment: optional_string(
            data,
            "starterCounterProofCommitment",
            KIND,
            "STARTER_COUNTER_PROOF_COMMITMENT",
        )?,
    }))
}

fn resolve_htlc_lock(tx: &CanonicalEntityTx) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "resolveHtlcLock";
    let data = object(frame_data(tx, KIND)?, KIND)?;
    exact_fields(
        data,
        &["counterpartyEntityId", "lockId", "secret"],
        &["crossJurisdictionRouteId", "description"],
        KIND,
    )?;
    Ok(LocalEntityFinancialTx::ResolveHtlcLock(
        ResolveHtlcLockEntityTx {
            counterparty_entity_id: entity_id(
                field(data, "counterpartyEntityId", KIND)?,
                KIND,
                "COUNTERPARTY_ENTITY_ID",
            )?,
            lock_id: string(field(data, "lockId", KIND)?, KIND, "LOCK_ID")?.to_ascii_lowercase(),
            secret: string(field(data, "secret", KIND)?, KIND, "SECRET")?.to_ascii_lowercase(),
            cross_jurisdiction_route_id: optional_string(
                data,
                "crossJurisdictionRouteId",
                KIND,
                "CROSS_JURISDICTION_ROUTE_ID",
            )?,
            description: optional_string(data, "description", KIND, "DESCRIPTION")?,
        },
    ))
}

fn dispute_finalize(tx: &CanonicalEntityTx) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "disputeFinalize";
    let data = object(frame_data(tx, KIND)?, KIND)?;
    exact_fields(
        data,
        &["counterpartyEntityId"],
        &["useOnchainRegistry", "description"],
        KIND,
    )?;
    Ok(LocalEntityFinancialTx::DisputeFinalize(
        DisputeFinalizeEntityTx {
            counterparty_entity_id: entity_id(
                field(data, "counterpartyEntityId", KIND)?,
                KIND,
                "COUNTERPARTY_ENTITY_ID",
            )?,
            use_onchain_registry: optional_field(data, "useOnchainRegistry")
                .map(|value| boolean(value, KIND, "USE_ONCHAIN_REGISTRY"))
                .transpose()?
                .unwrap_or(false),
            description: optional_string(data, "description", KIND, "DESCRIPTION")?,
        },
    ))
}

fn htlc_payment(tx: &CanonicalEntityTx) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "htlcPayment";
    let data = object(frame_data(tx, KIND)?, KIND)?;
    exact_fields(
        data,
        &[
            "targetEntityId",
            "tokenId",
            "amount",
            "maxSenderDebit",
            "route",
            "deliveryMode",
        ],
        &["description", "startedAtMs", "hashlock"],
        KIND,
    )?;
    let mode = match string(field(data, "deliveryMode", KIND)?, KIND, "DELIVERY_MODE")?.as_str() {
        "instant" => OriginatedHtlcDeliveryMode::Instant,
        "async" => OriginatedHtlcDeliveryMode::Async,
        _ => return Err(invalid(KIND, "DELIVERY_MODE")),
    };
    Ok(LocalEntityFinancialTx::HtlcPayment(HtlcPaymentEntityTx {
        target_entity_id: entity_id(field(data, "targetEntityId", KIND)?, KIND, "TARGET")?,
        token_id: token(field(data, "tokenId", KIND)?, KIND)?,
        amount: bigint(field(data, "amount", KIND)?, KIND, "AMOUNT")?,
        max_sender_debit: bigint(
            field(data, "maxSenderDebit", KIND)?,
            KIND,
            "MAX_SENDER_DEBIT",
        )?,
        route: string_array(field(data, "route", KIND)?, KIND, "ROUTE")?,
        description: optional_string(data, "description", KIND, "DESCRIPTION")?,
        delivery_mode: mode,
        started_at_ms: optional_field(data, "startedAtMs")
            .map(|value| u64_number(value, KIND, "STARTED_AT"))
            .transpose()?,
        hashlock: optional_string(data, "hashlock", KIND, "HASHLOCK")?,
        tx_hash: raw_tx_hash(tx)?,
    }))
}

fn extend_credit(tx: &CanonicalEntityTx) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "extendCredit";
    let data = object(frame_data(tx, KIND)?, KIND)?;
    exact_fields(
        data,
        &["counterpartyEntityId", "tokenId", "amount"],
        &[],
        KIND,
    )?;
    Ok(LocalEntityFinancialTx::ExtendCredit(ExtendCreditEntityTx {
        counterparty_entity_id: entity_id(
            field(data, "counterpartyEntityId", KIND)?,
            KIND,
            "COUNTERPARTY",
        )?,
        token_id: token(field(data, "tokenId", KIND)?, KIND)?,
        amount: bigint(field(data, "amount", KIND)?, KIND, "AMOUNT")?,
    }))
}

fn request_collateral(tx: &CanonicalEntityTx) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "requestCollateral";
    let data = object(frame_data(tx, KIND)?, KIND)?;
    exact_fields(
        data,
        &[
            "counterpartyEntityId",
            "tokenId",
            "amount",
            "feeAmount",
            "policyVersion",
        ],
        &["feeTokenId"],
        KIND,
    )?;
    Ok(LocalEntityFinancialTx::RequestCollateral(
        RequestCollateralEntityTx {
            counterparty_entity_id: entity_id(
                field(data, "counterpartyEntityId", KIND)?,
                KIND,
                "COUNTERPARTY",
            )?,
            token_id: token(field(data, "tokenId", KIND)?, KIND)?,
            amount: bigint(field(data, "amount", KIND)?, KIND, "AMOUNT")?,
            fee_token_id: optional_field(data, "feeTokenId")
                .map(|value| token(value, KIND))
                .transpose()?,
            fee_amount: bigint(field(data, "feeAmount", KIND)?, KIND, "FEE_AMOUNT")?,
            policy_version: u64_number(
                field(data, "policyVersion", KIND)?,
                KIND,
                "POLICY_VERSION",
            )?,
        },
    ))
}

fn place_swap_offer(tx: &CanonicalEntityTx) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "placeSwapOffer";
    let data = object(frame_data(tx, KIND)?, KIND)?;
    exact_fields(
        data,
        &[
            "counterpartyEntityId",
            "offerId",
            "giveTokenId",
            "giveTokenDecimals",
            "giveAmount",
            "wantTokenId",
            "wantTokenDecimals",
            "wantAmount",
            "maxFee",
            "minNetReceive",
        ],
        &["priceTicks", "timeInForce"],
        KIND,
    )?;
    let time_in_force = optional_field(data, "timeInForce")
        .map(|value| u64_number(value, KIND, "TIME_IN_FORCE"))
        .transpose()?
        .map(|value| u8::try_from(value).map_err(|_| invalid(KIND, "TIME_IN_FORCE")))
        .transpose()?;
    if time_in_force.is_some_and(|value| value > 2) {
        return Err(invalid(KIND, "TIME_IN_FORCE"));
    }
    Ok(LocalEntityFinancialTx::PlaceSwapOffer(
        PlaceSwapOfferEntityTx {
            counterparty_entity_id: entity_id(
                field(data, "counterpartyEntityId", KIND)?,
                KIND,
                "COUNTERPARTY",
            )?,
            offer_id: string(field(data, "offerId", KIND)?, KIND, "OFFER_ID")?,
            give_token_id: u32_number(field(data, "giveTokenId", KIND)?, KIND, "GIVE_TOKEN")?,
            give_token_decimals: u32_number(
                field(data, "giveTokenDecimals", KIND)?,
                KIND,
                "GIVE_DECIMALS",
            )?,
            give_amount: bigint(field(data, "giveAmount", KIND)?, KIND, "GIVE_AMOUNT")?,
            want_token_id: u32_number(field(data, "wantTokenId", KIND)?, KIND, "WANT_TOKEN")?,
            want_token_decimals: u32_number(
                field(data, "wantTokenDecimals", KIND)?,
                KIND,
                "WANT_DECIMALS",
            )?,
            want_amount: bigint(field(data, "wantAmount", KIND)?, KIND, "WANT_AMOUNT")?,
            max_fee: bigint(field(data, "maxFee", KIND)?, KIND, "MAX_FEE")?,
            min_net_receive: bigint(field(data, "minNetReceive", KIND)?, KIND, "MIN_NET_RECEIVE")?,
            price_ticks: optional_bigint(data, "priceTicks", KIND, "PRICE_TICKS")?,
            time_in_force,
        },
    ))
}

fn cancel_swap(tx: &CanonicalEntityTx) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "proposeCancelSwap";
    let data = object(frame_data(tx, KIND)?, KIND)?;
    exact_fields(data, &["counterpartyEntityId", "offerId"], &[], KIND)?;
    Ok(LocalEntityFinancialTx::ProposeCancelSwap(
        ProposeCancelSwapEntityTx {
            counterparty_entity_id: entity_id(
                field(data, "counterpartyEntityId", KIND)?,
                KIND,
                "COUNTERPARTY",
            )?,
            offer_id: string(field(data, "offerId", KIND)?, KIND, "OFFER_ID")?,
        },
    ))
}

fn lending_offer(tx: &CanonicalEntityTx) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "lendingOffer";
    let data = object(frame_data(tx, KIND)?, KIND)?;
    exact_fields(
        data,
        &[
            "positionId",
            "hubEntityId",
            "tokenId",
            "amount",
            "termId",
            "interestBps",
        ],
        &[],
        KIND,
    )?;
    Ok(LocalEntityFinancialTx::LendingOffer(LendingOfferEntityTx {
        position_id: string(field(data, "positionId", KIND)?, KIND, "POSITION_ID")?
            .trim()
            .to_ascii_lowercase(),
        hub_entity_id: entity_id(field(data, "hubEntityId", KIND)?, KIND, "HUB_ENTITY_ID")?,
        token_id: token(field(data, "tokenId", KIND)?, KIND)?,
        amount: bigint(field(data, "amount", KIND)?, KIND, "AMOUNT")?,
        term_id: lending_term(field(data, "termId", KIND)?, KIND)?,
        interest_bps: interest_bps(field(data, "interestBps", KIND)?, KIND)?,
    }))
}

fn lending_borrow(tx: &CanonicalEntityTx) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "lendingBorrow";
    let data = object(frame_data(tx, KIND)?, KIND)?;
    exact_fields(
        data,
        &["requestId", "hubEntityId", "tokenId", "amount", "termId"],
        &["maxInterestBps"],
        KIND,
    )?;
    let max_interest_bps = optional_field(data, "maxInterestBps")
        .map(|value| interest_bps(value, KIND))
        .transpose()?
        .unwrap_or(10_000);
    Ok(LocalEntityFinancialTx::LendingBorrow(
        LendingBorrowEntityTx {
            request_id: string(field(data, "requestId", KIND)?, KIND, "REQUEST_ID")?
                .trim()
                .to_ascii_lowercase(),
            hub_entity_id: entity_id(field(data, "hubEntityId", KIND)?, KIND, "HUB_ENTITY_ID")?,
            token_id: u64_number(field(data, "tokenId", KIND)?, KIND, "TOKEN_ID")?,
            amount: bigint(field(data, "amount", KIND)?, KIND, "AMOUNT")?,
            term_id: lending_term(field(data, "termId", KIND)?, KIND)?,
            max_interest_bps,
        },
    ))
}

fn lending_repay(tx: &CanonicalEntityTx) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "lendingRepay";
    let data = object(frame_data(tx, KIND)?, KIND)?;
    exact_fields(
        data,
        &["hubEntityId", "loanId", "tokenId", "amount"],
        &[],
        KIND,
    )?;
    Ok(LocalEntityFinancialTx::LendingRepay(LendingRepayEntityTx {
        hub_entity_id: entity_id(field(data, "hubEntityId", KIND)?, KIND, "HUB_ENTITY_ID")?,
        loan_id: string(field(data, "loanId", KIND)?, KIND, "LOAN_ID")?
            .trim()
            .to_ascii_lowercase(),
        token_id: token(field(data, "tokenId", KIND)?, KIND)?,
        amount: bigint(field(data, "amount", KIND)?, KIND, "AMOUNT")?,
    }))
}

fn lending_close(tx: &CanonicalEntityTx) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "lendingClosePosition";
    let data = object(frame_data(tx, KIND)?, KIND)?;
    exact_fields(data, &["hubEntityId", "positionId"], &[], KIND)?;
    Ok(LocalEntityFinancialTx::LendingClosePosition(
        LendingClosePositionEntityTx {
            hub_entity_id: entity_id(field(data, "hubEntityId", KIND)?, KIND, "HUB_ENTITY_ID")?,
            position_id: string(field(data, "positionId", KIND)?, KIND, "POSITION_ID")?
                .trim()
                .to_ascii_lowercase(),
        },
    ))
}

fn process_htlc_timeouts(
    tx: &CanonicalEntityTx,
) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "processHtlcTimeouts";
    let data = object(frame_data(tx, KIND)?, KIND)?;
    exact_fields(data, &[], &["expiredLocks"], KIND)?;
    let expired_locks = match optional_field(data, "expiredLocks") {
        None => Vec::new(),
        Some(CanonicalValue::Array(rows)) => rows
            .iter()
            .map(|row| {
                let row = object(row, KIND)?;
                exact_fields(row, &["accountId", "lockId"], &[], KIND)?;
                Ok((
                    entity_id(field(row, "accountId", KIND)?, KIND, "ACCOUNT_ID")?,
                    string(field(row, "lockId", KIND)?, KIND, "LOCK_ID")?,
                ))
            })
            .collect::<Result<Vec<_>, EntityKernelError>>()?,
        Some(_) => return Err(invalid(KIND, "EXPIRED_LOCKS")),
    };
    Ok(LocalEntityFinancialTx::ProcessHtlcTimeouts(
        ProcessHtlcTimeoutsEntityTx { expired_locks },
    ))
}

fn set_rebalance_policy(
    tx: &CanonicalEntityTx,
) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "setRebalancePolicy";
    let data = object(frame_data(tx, KIND)?, KIND)?;
    exact_fields(
        data,
        &[
            "counterpartyEntityId",
            "tokenId",
            "r2cRequestSoftLimit",
            "hardLimit",
            "maxAcceptableFee",
        ],
        &[],
        KIND,
    )?;
    let soft = bigint(
        field(data, "r2cRequestSoftLimit", KIND)?,
        KIND,
        "SOFT_LIMIT",
    )?;
    let hard = bigint(field(data, "hardLimit", KIND)?, KIND, "HARD_LIMIT")?;
    let max_fee = bigint(
        field(data, "maxAcceptableFee", KIND)?,
        KIND,
        "MAX_ACCEPTABLE_FEE",
    )?;
    if soft < BigInt::from(0_u8) || hard < soft || max_fee < BigInt::from(0_u8) {
        return Err(invalid(KIND, "REBALANCE_POLICY_INVALID"));
    }
    Ok(LocalEntityFinancialTx::SetRebalancePolicy(
        SetRebalancePolicyEntityTx {
            counterparty_entity_id: entity_id(
                field(data, "counterpartyEntityId", KIND)?,
                KIND,
                "COUNTERPARTY_ENTITY_ID",
            )?,
            token_id: token(field(data, "tokenId", KIND)?, KIND)?,
            r2c_request_soft_limit: soft,
            hard_limit: hard,
            max_acceptable_fee: max_fee,
        },
    ))
}

fn settle_propose(tx: &CanonicalEntityTx) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "settle_propose";
    let data = object(frame_data(tx, KIND)?, KIND)?;
    exact_fields(
        data,
        &["counterpartyEntityId", "ops"],
        &["executorIsLeft", "memo", "continuation"],
        KIND,
    )?;
    let CanonicalValue::Array(ops) = field(data, "ops", KIND)? else {
        return Err(invalid(KIND, "OPS"));
    };
    if ops.is_empty() {
        return Err(invalid(KIND, "OPS_EMPTY"));
    }
    Ok(LocalEntityFinancialTx::SettlePropose(
        SettleProposeEntityTx {
            counterparty_entity_id: entity_id(
                field(data, "counterpartyEntityId", KIND)?,
                KIND,
                "COUNTERPARTY_ENTITY_ID",
            )?,
            ops: ops.clone(),
            executor_is_left: optional_field(data, "executorIsLeft")
                .map(|value| boolean(value, KIND, "EXECUTOR_IS_LEFT"))
                .transpose()?,
            memo: optional_string(data, "memo", KIND, "MEMO")?,
            continuation: optional_field(data, "continuation").cloned(),
        },
    ))
}

fn settle_update(tx: &CanonicalEntityTx) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "settle_update";
    let data = object(frame_data(tx, KIND)?, KIND)?;
    exact_fields(
        data,
        &["counterpartyEntityId", "ops"],
        &["executorIsLeft", "memo"],
        KIND,
    )?;
    let CanonicalValue::Array(ops) = field(data, "ops", KIND)? else {
        return Err(invalid(KIND, "OPS"));
    };
    if ops.is_empty() {
        return Err(invalid(KIND, "OPS_EMPTY"));
    }
    Ok(LocalEntityFinancialTx::SettleUpdate(SettleUpdateEntityTx {
        counterparty_entity_id: entity_id(
            field(data, "counterpartyEntityId", KIND)?,
            KIND,
            "COUNTERPARTY_ENTITY_ID",
        )?,
        ops: ops.clone(),
        executor_is_left: optional_field(data, "executorIsLeft")
            .map(|value| boolean(value, KIND, "EXECUTOR_IS_LEFT"))
            .transpose()?,
        memo: optional_string(data, "memo", KIND, "MEMO")?,
    }))
}

fn settle_approve(tx: &CanonicalEntityTx) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "settle_approve";
    let data = object(frame_data(tx, KIND)?, KIND)?;
    exact_fields(data, &["counterpartyEntityId", "workspaceHash"], &[], KIND)?;
    Ok(LocalEntityFinancialTx::SettleApprove(
        SettleApproveEntityTx {
            counterparty_entity_id: entity_id(
                field(data, "counterpartyEntityId", KIND)?,
                KIND,
                "COUNTERPARTY_ENTITY_ID",
            )?,
            workspace_hash: canonical_hash(
                field(data, "workspaceHash", KIND)?,
                KIND,
                "WORKSPACE_HASH",
            )?,
        },
    ))
}

fn settle_execute(tx: &CanonicalEntityTx) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "settle_execute";
    let data = object(frame_data(tx, KIND)?, KIND)?;
    exact_fields(
        data,
        &["counterpartyEntityId"],
        &["disableC2RShortcut"],
        KIND,
    )?;
    Ok(LocalEntityFinancialTx::SettleExecute(
        SettleExecuteEntityTx {
            counterparty_entity_id: entity_id(
                field(data, "counterpartyEntityId", KIND)?,
                KIND,
                "COUNTERPARTY_ENTITY_ID",
            )?,
            disable_c2r_shortcut: optional_field(data, "disableC2RShortcut")
                .map(|value| boolean(value, KIND, "DISABLE_C2R_SHORTCUT"))
                .transpose()?
                .unwrap_or(false),
        },
    ))
}

fn settle_reject(tx: &CanonicalEntityTx) -> Result<LocalEntityFinancialTx, EntityKernelError> {
    const KIND: &str = "settle_reject";
    let data = object(frame_data(tx, KIND)?, KIND)?;
    exact_fields(data, &["counterpartyEntityId"], &["reason"], KIND)?;
    Ok(LocalEntityFinancialTx::SettleReject(SettleRejectEntityTx {
        counterparty_entity_id: entity_id(
            field(data, "counterpartyEntityId", KIND)?,
            KIND,
            "COUNTERPARTY_ENTITY_ID",
        )?,
        reason: optional_string(data, "reason", KIND, "REASON")?,
    }))
}

fn quote_backed_r2c(
    tx: &CanonicalEntityTx,
) -> Result<Option<LocalEntityFinancialTx>, EntityKernelError> {
    const KIND: &str = "r2c";
    let data = object(frame_data(tx, KIND)?, KIND)?;
    if optional_field(data, "rebalanceQuoteId").is_none() {
        return Ok(None);
    }
    exact_fields(
        data,
        &["counterpartyId", "tokenId", "amount", "rebalanceQuoteId"],
        &[
            "receivingEntityId",
            "rebalanceFeeTokenId",
            "rebalanceFeeAmount",
        ],
        KIND,
    )?;
    let token_id = token(field(data, "tokenId", KIND)?, KIND)?;
    let amount = bigint(field(data, "amount", KIND)?, KIND, "AMOUNT")?;
    if amount <= BigInt::from(0) {
        return Err(invalid(KIND, "AMOUNT"));
    }
    Ok(Some(LocalEntityFinancialTx::QuoteBackedR2c(
        QuoteBackedR2cEntityTx {
            counterparty_entity_id: entity_id(
                field(data, "counterpartyId", KIND)?,
                KIND,
                "COUNTERPARTY_ENTITY_ID",
            )?,
            receiving_entity_id: optional_field(data, "receivingEntityId")
                .map(|value| entity_id(value, KIND, "RECEIVING_ENTITY_ID"))
                .transpose()?,
            token_id,
            amount,
            rebalance_quote_id: u64_number(
                field(data, "rebalanceQuoteId", KIND)?,
                KIND,
                "REBALANCE_QUOTE_ID",
            )?,
            rebalance_fee_token_id: optional_field(data, "rebalanceFeeTokenId")
                .map(|value| token(value, KIND))
                .transpose()?,
            rebalance_fee_amount: optional_bigint(
                data,
                "rebalanceFeeAmount",
                KIND,
                "REBALANCE_FEE_AMOUNT",
            )?,
        },
    )))
}

pub fn decode_local_entity_financial_tx(
    tx: &CanonicalEntityTx,
) -> Result<Option<LocalEntityFinancialTx>, EntityKernelError> {
    match tx.kind {
        EntityTxKind::CrossJurisdictionForceSiblingDispute => force_sibling_dispute(tx).map(Some),
        EntityTxKind::DirectPayment => direct_payment(tx).map(Some),
        EntityTxKind::DisputeFinalize => dispute_finalize(tx).map(Some),
        EntityTxKind::DisputeStart => dispute_start(tx).map(Some),
        EntityTxKind::ExtendCredit => extend_credit(tx).map(Some),
        EntityTxKind::HtlcPayment => htlc_payment(tx).map(Some),
        EntityTxKind::LendingBorrow => lending_borrow(tx).map(Some),
        EntityTxKind::LendingClosePosition => lending_close(tx).map(Some),
        EntityTxKind::LendingOffer => lending_offer(tx).map(Some),
        EntityTxKind::LendingRepay => lending_repay(tx).map(Some),
        EntityTxKind::OpenAccount => open_account(tx).map(Some),
        EntityTxKind::PlaceSwapOffer => place_swap_offer(tx).map(Some),
        EntityTxKind::PrepareDispute => prepare_dispute(tx).map(Some),
        EntityTxKind::ProcessHtlcTimeouts => process_htlc_timeouts(tx).map(Some),
        EntityTxKind::ProposeCancelSwap => cancel_swap(tx).map(Some),
        EntityTxKind::RequestCollateral => request_collateral(tx).map(Some),
        EntityTxKind::ResolveHtlcLock => resolve_htlc_lock(tx).map(Some),
        EntityTxKind::R2c => quote_backed_r2c(tx),
        EntityTxKind::SetRebalancePolicy => set_rebalance_policy(tx).map(Some),
        EntityTxKind::SettleApprove => settle_approve(tx).map(Some),
        EntityTxKind::SettleExecute => settle_execute(tx).map(Some),
        EntityTxKind::SettlePropose => settle_propose(tx).map(Some),
        EntityTxKind::SettleReject => settle_reject(tx).map(Some),
        EntityTxKind::SettleUpdate => settle_update(tx).map(Some),
        _ => Ok(None),
    }
}

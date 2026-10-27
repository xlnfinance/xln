//! Exact peer-route boundary, mirroring core/extensions/cross-j/route-shape.ts.
//! Validate before canonicalization: unhashed metadata is still protocol input.

use xln_rscore_protocol::CanonicalValue;

mod objects;
mod primitives;

use objects::{close_proof, dispute, domain, leg, pending_reveal, pull, registry, time_policy};
use primitives::{bigint, get, integer, literal, shape, string};
const REQUIRED: &[&str] = &[
    "orderId",
    "makerEntityId",
    "hubEntityId",
    "source",
    "target",
    "sourceDisputeConfig",
    "targetDisputeConfig",
    "status",
    "createdAt",
    "updatedAt",
];
const OPTIONAL: &[&str] = &[
    "routeHash",
    "bookOwnerEntityId",
    "venueId",
    "sourceSignerId",
    "sourceHubSignerId",
    "targetHubSignerId",
    "targetSignerId",
    "bookHubSignerId",
    "sourcePull",
    "targetPull",
    "sourceCloseProof",
    "targetCloseProof",
    "priceTicks",
    "fillSeq",
    "cumulativeFillRatio",
    "fillNumerator",
    "fillDenominator",
    "filledSourceAmount",
    "filledTargetAmount",
    "executionSourceAmount",
    "executionTargetAmount",
    "pendingClearRequestedAt",
    "domain",
    "timePolicy",
    "clearingPolicy",
    "riskMode",
    "claimedRatio",
    "sourceRegistryFillRatio",
    "targetRegistryFillRatio",
    "sourceRegistryRecord",
    "targetRegistryRecord",
    "pendingSourceRegistryReveal",
    "pendingTargetRegistryReveal",
    "sourceClaimed",
    "targetClaimed",
    "expiresAt",
    "settledAt",
    "error",
    "memo",
];
const STRINGS: &[&str] = &[
    "orderId",
    "makerEntityId",
    "hubEntityId",
    "routeHash",
    "bookOwnerEntityId",
    "venueId",
    "sourceSignerId",
    "sourceHubSignerId",
    "targetHubSignerId",
    "targetSignerId",
    "bookHubSignerId",
    "error",
    "memo",
];
const INTEGERS: &[&str] = &[
    "createdAt",
    "updatedAt",
    "fillSeq",
    "cumulativeFillRatio",
    "pendingClearRequestedAt",
    "claimedRatio",
    "sourceRegistryFillRatio",
    "targetRegistryFillRatio",
    "expiresAt",
    "settledAt",
];
const BIGINTS: &[&str] = &[
    "priceTicks",
    "fillNumerator",
    "fillDenominator",
    "filledSourceAmount",
    "filledTargetAmount",
    "sourceClaimed",
    "targetClaimed",
    "executionSourceAmount",
    "executionTargetAmount",
];

/// Returns only the TS rejection text; the caller wraps ACCOUNT_TX_VALIDATION.
/// Sender-owned route metadata must never survive admission just because its
/// canonical hash and paired pull were valid (e.g. a missing updatedAt).
pub(super) fn validate(value: &CanonicalValue) -> Result<(), String> {
    let code = "CROSS_J_SWAP_OFFER_ROUTE";
    let fields = shape(Some(value), REQUIRED, OPTIONAL, code)?;
    for key in STRINGS {
        if let Some(value) = get(fields, key) {
            string(Some(value), &format!("{code}_{key}"))?;
        }
    }
    for key in INTEGERS {
        if let Some(value) = get(fields, key) {
            integer(Some(value), &format!("{code}_{key}"), 0)?;
        }
    }
    for key in BIGINTS {
        if let Some(value) = get(fields, key) {
            bigint(Some(value), &format!("{code}_{key}"), None)?;
        }
    }
    leg(get(fields, "source"), &format!("{code}_SOURCE"))?;
    leg(get(fields, "target"), &format!("{code}_TARGET"))?;
    dispute(
        get(fields, "sourceDisputeConfig"),
        &format!("{code}_SOURCE_DISPUTE"),
    )?;
    dispute(
        get(fields, "targetDisputeConfig"),
        &format!("{code}_TARGET_DISPUTE"),
    )?;
    type Validator = fn(Option<&CanonicalValue>, &str) -> Result<(), String>;
    let nested: &[(&str, &str, Validator)] = &[
        ("sourcePull", "SOURCE_PULL", pull),
        ("targetPull", "TARGET_PULL", pull),
        ("sourceCloseProof", "SOURCE_CLOSE", close_proof),
        ("targetCloseProof", "TARGET_CLOSE", close_proof),
        ("domain", "DOMAIN", domain),
        ("timePolicy", "TIME", time_policy),
        ("sourceRegistryRecord", "SOURCE_REGISTRY", registry),
        ("targetRegistryRecord", "TARGET_REGISTRY", registry),
        (
            "pendingSourceRegistryReveal",
            "PENDING_SOURCE",
            pending_reveal,
        ),
        (
            "pendingTargetRegistryReveal",
            "PENDING_TARGET",
            pending_reveal,
        ),
    ];
    for (key, suffix, validate) in nested {
        if let Some(value) = get(fields, key) {
            validate(Some(value), &format!("{code}_{suffix}"))?;
        }
    }
    literal(
        get(fields, "status"),
        &[
            "intent",
            "target_prepared",
            "resting",
            "partially_filled",
            "clear_requested",
            "clearing",
            "settled",
            "cancelled",
            "expired",
        ],
        &format!("{code}_STATUS"),
    )?;
    if let Some(value) = get(fields, "clearingPolicy") {
        literal(
            Some(value),
            &["manual", "full_fill", "cancel_and_clear"],
            &format!("{code}_CLEARING"),
        )?;
    }
    if let Some(value) = get(fields, "riskMode") {
        literal(
            Some(value),
            &[
                "fully_collateralized",
                "partially_collateralized",
                "credit_line",
                "unsecured_internalized",
            ],
            &format!("{code}_RISK"),
        )?;
    }
    Ok(())
}

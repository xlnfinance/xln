use xln_rscore_protocol::CanonicalValue;

use super::primitives::{bigint, get, integer, literal, shape, string};

pub(super) fn leg(value: Option<&CanonicalValue>, code: &str) -> Result<(), String> {
    let fields = shape(
        value,
        &[
            "jurisdiction",
            "entityId",
            "counterpartyEntityId",
            "tokenId",
            "amount",
        ],
        &[],
        code,
    )?;
    for (key, suffix) in [
        ("jurisdiction", "JURISDICTION"),
        ("entityId", "ENTITY"),
        ("counterpartyEntityId", "COUNTERPARTY"),
    ] {
        string(get(fields, key), &format!("{code}_{suffix}"))?;
    }
    integer(get(fields, "tokenId"), &format!("{code}_TOKEN"), 1)?;
    bigint(get(fields, "amount"), &format!("{code}_AMOUNT"), Some(1))
}

pub(super) fn dispute(value: Option<&CanonicalValue>, code: &str) -> Result<(), String> {
    let fields = shape(
        value,
        &["leftResponseSeconds", "rightResponseSeconds"],
        &[],
        code,
    )?;
    integer(
        get(fields, "leftResponseSeconds"),
        &format!("{code}_LEFT"),
        0,
    )?;
    integer(
        get(fields, "rightResponseSeconds"),
        &format!("{code}_RIGHT"),
        0,
    )
}

pub(super) fn pull(value: Option<&CanonicalValue>, code: &str) -> Result<(), String> {
    let fields = shape(
        value,
        &[
            "pullId",
            "tokenId",
            "amount",
            "signedAmount",
            "deadline",
            "fullHash",
            "partialRoot",
        ],
        &[],
        code,
    )?;
    for key in ["pullId", "fullHash", "partialRoot"] {
        string(get(fields, key), &format!("{code}_{key}"))?;
    }
    integer(get(fields, "tokenId"), &format!("{code}_TOKEN"), 1)?;
    integer(get(fields, "deadline"), &format!("{code}_DEADLINE"), 1)?;
    bigint(get(fields, "amount"), &format!("{code}_AMOUNT"), Some(0))?;
    bigint(
        get(fields, "signedAmount"),
        &format!("{code}_SIGNED_AMOUNT"),
        None,
    )
}

pub(super) fn close_proof(value: Option<&CanonicalValue>, code: &str) -> Result<(), String> {
    let fields = shape(
        value,
        &[
            "orderId",
            "routeHash",
            "sourcePullId",
            "targetPullId",
            "fillRatio",
            "cumulativeSourceAmount",
            "cumulativeTargetAmount",
            "binaryHash",
            "closeMode",
        ],
        &[],
        code,
    )?;
    for key in [
        "orderId",
        "routeHash",
        "sourcePullId",
        "targetPullId",
        "binaryHash",
    ] {
        string(get(fields, key), &format!("{code}_{key}"))?;
    }
    integer(get(fields, "fillRatio"), &format!("{code}_RATIO"), 0)?;
    bigint(
        get(fields, "cumulativeSourceAmount"),
        &format!("{code}_SOURCE"),
        Some(0),
    )?;
    bigint(
        get(fields, "cumulativeTargetAmount"),
        &format!("{code}_TARGET"),
        Some(0),
    )?;
    literal(
        get(fields, "closeMode"),
        &["full", "partial_cancel_remainder", "pure_cancel"],
        &format!("{code}_MODE"),
    )
}

pub(super) fn domain(value: Option<&CanonicalValue>, code: &str) -> Result<(), String> {
    let fields = shape(
        value,
        &[
            "protocol",
            "hashSchema",
            "sourceStackId",
            "targetStackId",
            "sourceAssetRef",
            "targetAssetRef",
        ],
        &[
            "sourceEntityProviderAddress",
            "targetEntityProviderAddress",
            "sourceDeltaTransformerAddress",
            "targetDeltaTransformerAddress",
        ],
        code,
    )?;
    literal(
        get(fields, "protocol"),
        &["xln-cross-j"],
        &format!("{code}_PROTOCOL"),
    )?;
    literal(
        get(fields, "hashSchema"),
        &["route-domain"],
        &format!("{code}_SCHEMA"),
    )?;
    for (key, value) in fields {
        if key != "protocol" && key != "hashSchema" {
            string(Some(value), &format!("{code}_{key}"))?;
        }
    }
    Ok(())
}

pub(super) fn time_policy(value: Option<&CanonicalValue>, code: &str) -> Result<(), String> {
    let fields = shape(
        value,
        &[
            "runtimeClock",
            "settlementClock",
            "deadlineConversion",
            "runtimeExpiresAtMs",
            "finalityPolicy",
        ],
        &[],
        code,
    )?;
    for (key, allowed, suffix) in [
        ("runtimeClock", "unix_ms", "RUNTIME_CLOCK"),
        ("settlementClock", "unix_seconds", "SETTLEMENT_CLOCK"),
        (
            "deadlineConversion",
            "floor_ms_to_unix_seconds",
            "CONVERSION",
        ),
        (
            "finalityPolicy",
            "absolute_pull_deadlines",
            "FINALITY",
        ),
    ] {
        literal(get(fields, key), &[allowed], &format!("{code}_{suffix}"))?;
    }
    integer(
        get(fields, "runtimeExpiresAtMs"),
        &format!("{code}_EXPIRES"),
        0,
    )
}

pub(super) fn registry(value: Option<&CanonicalValue>, code: &str) -> Result<(), String> {
    let fields = shape(value, &["fillRatio", "revealedAt"], &[], code)?;
    integer(get(fields, "fillRatio"), &format!("{code}_RATIO"), 0)?;
    integer(get(fields, "revealedAt"), &format!("{code}_REVEALED_AT"), 0)
}

pub(super) fn pending_reveal(value: Option<&CanonicalValue>, code: &str) -> Result<(), String> {
    let fields = shape(value, &["fillRatio", "fullSecret", "reveals"], &[], code)?;
    integer(get(fields, "fillRatio"), &format!("{code}_RATIO"), 0)?;
    string(get(fields, "fullSecret"), &format!("{code}_SECRET"))?;
    let Some(CanonicalValue::Array(reveals)) = get(fields, "reveals") else {
        return Err(format!("{code}_REVEALS"));
    };
    if reveals.len() != 4 {
        return Err(format!("{code}_REVEALS_LENGTH"));
    }
    for (index, value) in reveals.iter().enumerate() {
        string(Some(value), &format!("{code}_REVEAL_{index}"))?;
    }
    Ok(())
}

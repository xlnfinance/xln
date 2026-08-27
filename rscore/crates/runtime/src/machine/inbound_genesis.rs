use std::collections::BTreeSet;

use num_bigint::BigInt;
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use sha3::Keccak256;
use xln_rscore_batch::{AccountInputRow, EntityAccountGenesisPolicy};
use xln_rscore_engine::{AccountDomain, DepositoryAddress};
use xln_rscore_protocol::{CanonicalValue, PersistentRadixMap, encode_account_state_value};

use super::RuntimeMachineError;

const DEFAULT_POLICY_TOKENS: [(u16, u32); 3] = [(1, 6), (3, 6), (2, 18)];
const DEFAULT_SOFT_LIMIT: u64 = 500;
const DEFAULT_HARD_LIMIT: u64 = 10_000;
const DEFAULT_MAX_FEE: u64 = 15;

/// Attach owner-derived H=0 policy only to the first row for each Account that
/// is absent from the committed Entity state. Peer bytes never choose any of
/// these fields; this is the Rust twin of `resolveInboundAccount` in TS.
pub(super) fn attach_inbound_genesis_policies(
    rows: &mut [AccountInputRow],
    known_accounts: &BTreeSet<String>,
    jurisdiction: Option<&CanonicalValue>,
    j_replicas: &Value,
) -> Result<(), RuntimeMachineError> {
    if rows.iter().any(|row| row.genesis_policy.is_some()) {
        return Err(policy_error("CALLER_POLICY_FORBIDDEN"));
    }
    let mut first_unknown = BTreeSet::new();
    let needs_policy = rows.iter().any(|row| {
        let account = render_account_id(row);
        !known_accounts.contains(&account) && first_unknown.insert(account)
    });
    if !needs_policy {
        return Ok(());
    }
    let policy = derive_policy(
        jurisdiction.ok_or_else(|| policy_error("JURISDICTION_REQUIRED"))?,
        j_replicas,
    )?;
    first_unknown.clear();
    for row in rows {
        let account = render_account_id(row);
        if !known_accounts.contains(&account) && first_unknown.insert(account) {
            row.genesis_policy = Some(policy.clone());
        }
    }
    Ok(())
}

fn derive_policy(
    jurisdiction: &CanonicalValue,
    j_replicas: &Value,
) -> Result<EntityAccountGenesisPolicy, RuntimeMachineError> {
    let fields = canonical_object(jurisdiction, "JURISDICTION_OBJECT")?;
    let chain_id = canonical_u64(required_canonical(fields, "chainId")?, "CHAIN_ID")?;
    let depository_text = canonical_string(
        required_canonical(fields, "depositoryAddress")?,
        "DEPOSITORY_ADDRESS",
    )?;
    let depository = DepositoryAddress::parse(depository_text)
        .map_err(|_| policy_error("DEPOSITORY_ADDRESS_INVALID"))?;
    let expected_domain =
        AccountDomain::new(chain_id, depository).map_err(|_| policy_error("DOMAIN_INVALID"))?;
    let overrides = fields
        .iter()
        .find_map(|(name, value)| (name == "rebalancePolicyUsd").then_some(value));
    Ok(EntityAccountGenesisPolicy {
        shadow_policy_root: shadow_policy_root(overrides)?,
        delta_transformer: resolve_delta_transformer(j_replicas, chain_id, depository_text)?,
        expected_domain,
        public_pinned: false,
    })
}

fn shadow_policy_root(overrides: Option<&CanonicalValue>) -> Result<[u8; 32], RuntimeMachineError> {
    let override_fields = overrides
        .map(|value| canonical_object(value, "REBALANCE_POLICY_OBJECT"))
        .transpose()?;
    let mut map = PersistentRadixMap::empty();
    for (token_id, decimals) in DEFAULT_POLICY_TOKENS {
        let scale = BigInt::from(10_u8).pow(decimals);
        let amount = |name: &str, default: u64| -> Result<BigInt, RuntimeMachineError> {
            let whole = match override_fields {
                Some(fields) => {
                    canonical_floor_nonnegative(required_canonical(fields, name)?, name)?
                }
                None => BigInt::from(default),
            };
            Ok(whole * &scale)
        };
        let soft = amount("r2cRequestSoftLimit", DEFAULT_SOFT_LIMIT)?;
        let hard = amount("hardLimit", DEFAULT_HARD_LIMIT)?;
        let max_fee = amount("maxFee", DEFAULT_MAX_FEE)?;
        if soft <= BigInt::from(0_u8) || hard < soft {
            return Err(policy_error("REBALANCE_POLICY_INVALID"));
        }
        let value = CanonicalValue::Object(vec![
            ("r2cRequestSoftLimit".into(), CanonicalValue::BigInt(soft)),
            ("hardLimit".into(), CanonicalValue::BigInt(hard)),
            ("maxAcceptableFee".into(), CanonicalValue::BigInt(max_fee)),
        ]);
        let encoded = encode_account_state_value(&value)
            .map_err(|error| policy_error(&format!("POLICY_ENCODING:{error}")))?;
        let digest: [u8; 32] = Sha256::digest(encoded).into();
        map = map
            .updated(token_key(token_id), (), digest)
            .map_err(|error| policy_error(&format!("POLICY_TREE:{error}")))?;
    }
    Ok(map.root_hash())
}

fn resolve_delta_transformer(
    j_replicas: &Value,
    chain_id: u64,
    depository: &str,
) -> Result<[u8; 20], RuntimeMachineError> {
    let rows = j_replicas
        .as_array()
        .ok_or_else(|| policy_error("J_REPLICAS_ARRAY_REQUIRED"))?;
    let expected_depository = parse_address(depository, "DEPOSITORY_ADDRESS")?;
    let mut matches = Vec::new();
    for row in rows {
        // Row/replica shape is parsed optimistically: an irrelevant row for a
        // different jurisdiction may be malformed on the wire without ever
        // becoming proof authority, so any shape failure here just means
        // "not our jurisdiction" rather than a fatal error. Strictness only
        // starts once chainId+depository single out this row below.
        let Some(pair) = row.as_array().filter(|pair| pair.len() == 2) else {
            continue;
        };
        let Some(replica) = pair[1].as_object() else {
            continue;
        };
        if replica.get("chainId").and_then(Value::as_u64) != Some(chain_id) {
            continue;
        }
        let Some(contracts) = replica.get("contracts").and_then(Value::as_object) else {
            continue;
        };
        let Some(candidate) = contracts.get("depository").and_then(Value::as_str) else {
            continue;
        };
        let Ok(candidate) = parse_address(candidate, "J_DEPOSITORY") else {
            // TS `firstUsableContractAddress` skips an unusable candidate;
            // only a matching persisted stack becomes proof authority.
            continue;
        };
        if candidate != expected_depository {
            continue;
        }
        // TS requires the complete persisted jurisdiction stack before using
        // its DeltaTransformer; accepting a partial row would create another
        // proof-authority rule in Rust.
        for field in ["entityProvider", "account"] {
            parse_address(
                contracts
                    .get(field)
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        policy_error(&format!("J_STACK_{}_REQUIRED", field.to_uppercase()))
                    })?,
                field,
            )?;
        }
        matches.push(parse_address(
            contracts
                .get("deltaTransformer")
                .and_then(Value::as_str)
                .ok_or_else(|| policy_error("J_STACK_DELTA_TRANSFORMER_REQUIRED"))?,
            "deltaTransformer",
        )?);
    }
    match matches.as_slice() {
        [address] => Ok(*address),
        [] => Err(policy_error("PROOF_JURISDICTION_NOT_FOUND")),
        _ => Err(policy_error("PROOF_JURISDICTION_AMBIGUOUS")),
    }
}

fn canonical_object<'a>(
    value: &'a CanonicalValue,
    code: &str,
) -> Result<&'a [(String, CanonicalValue)], RuntimeMachineError> {
    match value {
        CanonicalValue::Object(fields) => Ok(fields),
        _ => Err(policy_error(code)),
    }
}

fn required_canonical<'a>(
    fields: &'a [(String, CanonicalValue)],
    name: &str,
) -> Result<&'a CanonicalValue, RuntimeMachineError> {
    fields
        .iter()
        .find_map(|(field, value)| (field == name).then_some(value))
        .ok_or_else(|| policy_error(&format!("FIELD_REQUIRED:{name}")))
}

fn canonical_string<'a>(
    value: &'a CanonicalValue,
    code: &str,
) -> Result<&'a str, RuntimeMachineError> {
    match value {
        CanonicalValue::String(value) => Ok(value),
        _ => Err(policy_error(code)),
    }
}

fn canonical_u64(value: &CanonicalValue, code: &str) -> Result<u64, RuntimeMachineError> {
    let CanonicalValue::Number(value) = value else {
        return Err(policy_error(code));
    };
    value.as_str().parse().map_err(|_| policy_error(code))
}

fn canonical_floor_nonnegative(
    value: &CanonicalValue,
    code: &str,
) -> Result<BigInt, RuntimeMachineError> {
    let CanonicalValue::Number(value) = value else {
        return Err(policy_error(&format!("{code}_NUMBER_REQUIRED")));
    };
    floor_canonical_decimal_text(value.as_str(), code)
}

/// Decimal digit-shift ceiling for [`floor_canonical_decimal_text`]. A finite
/// f64's magnitude never needs more than ~309 digits of shift, so this stays
/// a generous, allocation-safe bound rather than a tight one.
const MAX_CANONICAL_DIGIT_SHIFT: i64 = 1024;

struct CanonicalNumberParts<'a> {
    negative: bool,
    integer: &'a str,
    fraction: &'a str,
    exponent: i64,
}

/// Splits `text` into sign/integer/fraction/exponent parts if it matches the
/// JSON-number grammar `-?digits(\.digits)?([eE][+-]?digits)?` with no
/// leading zeros — the only shape a canonical JS `Number` rendering (and
/// therefore a wire-received [`crate::CanonicalNumber`]) can ever take.
fn parse_canonical_number_parts(text: &str) -> Option<CanonicalNumberParts<'_>> {
    let bytes = text.as_bytes();
    let mut index = 0_usize;
    let negative = bytes.first() == Some(&b'-');
    if negative {
        index += 1;
    }
    let integer_start = index;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
    }
    let integer = &text[integer_start..index];
    if integer.is_empty() || (integer.len() > 1 && integer.as_bytes()[0] == b'0') {
        return None;
    }
    let fraction = if bytes.get(index) == Some(&b'.') {
        index += 1;
        let fraction_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        let fraction = &text[fraction_start..index];
        if fraction.is_empty() {
            return None;
        }
        fraction
    } else {
        ""
    };
    let exponent = if matches!(bytes.get(index), Some(b'e') | Some(b'E')) {
        index += 1;
        let exponent_negative = match bytes.get(index) {
            Some(b'+') => {
                index += 1;
                false
            }
            Some(b'-') => {
                index += 1;
                true
            }
            _ => false,
        };
        let exponent_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == exponent_start {
            return None;
        }
        let magnitude: i64 = text[exponent_start..index].parse().ok()?;
        if exponent_negative {
            -magnitude
        } else {
            magnitude
        }
    } else {
        0
    };
    (index == bytes.len()).then_some(CanonicalNumberParts {
        negative,
        integer,
        fraction,
        exponent,
    })
}

/// Deterministic `floor()` over a canonical JSON-number's exact text —
/// integer/string arithmetic only, no f64 in the path. Matches TypeScript's
/// `Math.floor(value)` on the same double for every representable input,
/// without ever reconstructing that double.
fn floor_canonical_decimal_text(text: &str, code: &str) -> Result<BigInt, RuntimeMachineError> {
    let invalid = || policy_error(&format!("{code}_INVALID"));
    let parts = parse_canonical_number_parts(text).ok_or_else(invalid)?;
    if parts.negative {
        return Err(invalid());
    }
    let point = parts.integer.len() as i64 + parts.exponent;
    if point <= 0 {
        return Ok(BigInt::from(0_u8));
    }
    if point > MAX_CANONICAL_DIGIT_SHIFT {
        return Err(policy_error(&format!("{code}_OVERFLOW")));
    }
    let digits_len = parts.integer.len() + parts.fraction.len();
    let point = point as usize;
    let mut integer_digits = String::with_capacity(point);
    if point <= digits_len {
        integer_digits.push_str(parts.integer);
        integer_digits.push_str(parts.fraction);
        integer_digits.truncate(point);
    } else {
        integer_digits.push_str(parts.integer);
        integer_digits.push_str(parts.fraction);
        integer_digits.extend(std::iter::repeat_n('0', point - digits_len));
    }
    BigInt::parse_bytes(integer_digits.as_bytes(), 10).ok_or_else(invalid)
}

fn token_key(token_id: u16) -> Vec<u8> {
    let mut key = vec![0_u8; 32];
    key[30..].copy_from_slice(&token_id.to_be_bytes());
    key
}

/// Same acceptance rule as `ethers.getAddress`: all-lowercase or all-uppercase
/// hex needs no checksum, mixed case must match EIP-55 exactly. Invalid mixed
/// case is rejected outright, never silently lowercased.
fn parse_address(value: &str, code: &str) -> Result<[u8; 20], RuntimeMachineError> {
    let body = value
        .strip_prefix("0x")
        .filter(|body| body.len() == 40 && body.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| policy_error(&format!("{code}_INVALID")))?;
    if !is_eip55_acceptable(body) {
        return Err(policy_error(&format!("{code}_INVALID")));
    }
    let mut output = [0_u8; 20];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&body[index * 2..index * 2 + 2], 16)
            .map_err(|_| policy_error(&format!("{code}_INVALID")))?;
    }
    if output == [0; 20] {
        return Err(policy_error(&format!("{code}_ZERO")));
    }
    Ok(output)
}

fn is_eip55_acceptable(body: &str) -> bool {
    let has_lower = body.bytes().any(|byte| byte.is_ascii_lowercase());
    let has_upper = body.bytes().any(|byte| byte.is_ascii_uppercase());
    if !has_lower || !has_upper {
        return true;
    }
    let digest = Keccak256::digest(body.to_ascii_lowercase().as_bytes());
    body.bytes().enumerate().all(|(index, byte)| {
        if !byte.is_ascii_alphabetic() {
            return true;
        }
        let nibble = if index % 2 == 0 {
            digest[index / 2] >> 4
        } else {
            digest[index / 2] & 0x0f
        };
        (nibble >= 8) == byte.is_ascii_uppercase()
    })
}

fn render_account_id(row: &AccountInputRow) -> String {
    let mut output = String::from("0x");
    for byte in row.account_id.as_bytes() {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn policy_error(detail: &str) -> RuntimeMachineError {
    RuntimeMachineError::InboundGenesisPolicy(detail.to_string())
}

#[cfg(test)]
mod tests {
    use num_bigint::BigInt;
    use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

    use super::{derive_policy, floor_canonical_decimal_text, parse_address, shadow_policy_root};

    fn number(value: u64) -> CanonicalValue {
        CanonicalValue::Number(CanonicalNumber::try_from_u64(value).expect("safe fixture"))
    }

    #[test]
    fn default_shadow_policy_root_matches_typescript() {
        let root = shadow_policy_root(None).expect("default policy");
        assert_eq!(
            hex::encode(root),
            "b6f09b549aac6b836985696c609df76b43c4563570749bcd1c967d261a485e09"
        );
    }

    #[test]
    fn policy_is_derived_from_committed_jurisdiction_and_j_replica() {
        let jurisdiction = CanonicalValue::Object(vec![
            ("chainId".into(), number(31_337)),
            (
                "depositoryAddress".into(),
                CanonicalValue::String(format!("0x{}", "a5".repeat(20))),
            ),
        ]);
        let j_replicas = serde_json::json!([["Testnet", {
            "name":"Testnet",
            "chainId":31337,
            "contracts":{
                "depository":format!("0x{}", "a5".repeat(20)),
                "entityProvider":format!("0x{}", "b6".repeat(20)),
                "account":format!("0x{}", "c7".repeat(20)),
                "deltaTransformer":format!("0x{}", "d8".repeat(20))
            }
        }]]);
        let policy = derive_policy(&jurisdiction, &j_replicas).expect("trusted policy");
        assert_eq!(policy.expected_domain.chain_id(), 31_337);
        assert_eq!(policy.delta_transformer, [0xd8; 20]);
        assert_eq!(
            hex::encode(policy.shadow_policy_root),
            "b6f09b549aac6b836985696c609df76b43c4563570749bcd1c967d261a485e09"
        );
        assert!(!policy.public_pinned);
    }

    #[test]
    fn parse_address_accepts_valid_lowercase() {
        assert!(parse_address(&format!("0x{}", "a5".repeat(20)), "ADDR").is_ok());
    }

    #[test]
    fn parse_address_accepts_valid_eip55_checksum() {
        // Canonical EIP-55 test vector (https://eips.ethereum.org/EIPS/eip-55).
        assert!(parse_address("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "ADDR").is_ok());
    }

    #[test]
    fn parse_address_rejects_invalid_mixed_case_checksum() {
        // Same vector with one letter's case flipped: valid hex, broken checksum.
        // ethers.getAddress throws here; it must never be silently lowercased.
        assert!(parse_address("0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "ADDR").is_err());
    }

    #[test]
    fn irrelevant_malformed_j_replica_row_is_skipped() {
        let jurisdiction = CanonicalValue::Object(vec![
            ("chainId".into(), number(31_337)),
            (
                "depositoryAddress".into(),
                CanonicalValue::String(format!("0x{}", "a5".repeat(20))),
            ),
        ]);
        let j_replicas = serde_json::json!([
            "not-a-pair",
            [123, "not-an-object"],
            ["OtherChain", { "chainId": 1, "contracts": { "depository": "not-an-address" } }],
            ["Testnet", {
                "name":"Testnet",
                "chainId":31337,
                "contracts":{
                    "depository":format!("0x{}", "a5".repeat(20)),
                    "entityProvider":format!("0x{}", "b6".repeat(20)),
                    "account":format!("0x{}", "c7".repeat(20)),
                    "deltaTransformer":format!("0x{}", "d8".repeat(20))
                }
            }]
        ]);
        let policy = derive_policy(&jurisdiction, &j_replicas).expect("skips malformed rows");
        assert_eq!(policy.delta_transformer, [0xd8; 20]);
    }

    #[test]
    fn relevant_malformed_j_replica_stack_is_rejected() {
        let jurisdiction = CanonicalValue::Object(vec![
            ("chainId".into(), number(31_337)),
            (
                "depositoryAddress".into(),
                CanonicalValue::String(format!("0x{}", "a5".repeat(20))),
            ),
        ]);
        let j_replicas = serde_json::json!([["Testnet", {
            "name":"Testnet",
            "chainId":31337,
            "contracts":{
                "depository":format!("0x{}", "a5".repeat(20))
            }
        }]]);
        let error = derive_policy(&jurisdiction, &j_replicas).expect_err("missing full stack");
        assert!(format!("{error:?}").contains("J_STACK_ENTITYPROVIDER_REQUIRED"));
    }

    fn floor(text: &str) -> Result<BigInt, super::RuntimeMachineError> {
        floor_canonical_decimal_text(text, "TEST")
    }

    #[test]
    fn floor_canonical_accepts_plain_integer() {
        assert_eq!(floor("15").unwrap(), BigInt::from(15));
    }

    #[test]
    fn floor_canonical_truncates_fraction_towards_zero() {
        assert_eq!(floor("15.9").unwrap(), BigInt::from(15));
    }

    #[test]
    fn floor_canonical_applies_positive_exponent() {
        assert_eq!(floor("1e3").unwrap(), BigInt::from(1000));
    }

    #[test]
    fn floor_canonical_applies_exponent_over_a_fraction() {
        assert_eq!(floor("1.5e3").unwrap(), BigInt::from(1500));
    }

    #[test]
    fn floor_canonical_applies_negative_exponent_below_zero() {
        assert_eq!(floor("1.5e-3").unwrap(), BigInt::from(0));
        assert_eq!(floor("0").unwrap(), BigInt::from(0));
    }

    #[test]
    fn floor_canonical_rejects_negative_values() {
        assert!(floor("-1").is_err());
        assert!(floor("-0.5").is_err());
    }

    #[test]
    fn floor_canonical_rejects_non_finite_and_garbage_text() {
        assert!(floor("NaN").is_err());
        assert!(floor("Infinity").is_err());
        assert!(floor("1.2.3").is_err());
        assert!(floor("").is_err());
        assert!(floor("015").is_err());
    }

    #[test]
    fn floor_canonical_rejects_overflowing_exponent() {
        assert!(floor("1e5000").is_err());
    }
}

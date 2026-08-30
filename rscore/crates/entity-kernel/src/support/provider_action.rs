use ethabi::ethereum_types::U256;
use sha3::{Digest, Keccak256};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use crate::EntityKernelError;

const MAX_PURPOSE_BYTES: usize = 1_024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EntityProviderActionPayload {
    Transfer {
        to: [u8; 20],
        token_id: U256,
        amount: U256,
    },
    ReleaseControlShares {
        recipient: [u8; 20],
        control_amount: U256,
        dividend_amount: U256,
        purpose: String,
    },
    Cancel {
        cancelled_action_hash: [u8; 32],
        cancelled_action_kind: u8,
    },
}

impl EntityProviderActionPayload {
    pub const fn kind(&self) -> &'static str {
        match self {
            Self::Transfer { .. } => "entityTransferTokens",
            Self::ReleaseControlShares { .. } => "releaseControlShares",
            Self::Cancel { .. } => "cancelPendingAction",
        }
    }

    pub const fn executable_kind_code(&self) -> Option<u8> {
        match self {
            Self::Transfer { .. } => Some(0),
            Self::ReleaseControlShares { .. } => Some(1),
            Self::Cancel { .. } => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityProviderActionIntent {
    pub entity_id: String,
    pub entity_number: U256,
    pub chain_id: U256,
    pub entity_provider_address: [u8; 20],
    pub board_epoch: U256,
    pub action_nonce: U256,
    pub action_hash: [u8; 32],
    pub generation: u64,
    pub created_at: u64,
    pub payload: EntityProviderActionPayload,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityProviderActionState {
    pub confirmed_nonce: U256,
    pub generation: u64,
    pub pending: Option<EntityProviderActionIntent>,
}

impl Default for EntityProviderActionState {
    fn default() -> Self {
        Self {
            confirmed_nonce: U256::zero(),
            generation: 0,
            pending: None,
        }
    }
}

fn invalid(detail: impl Into<String>) -> EntityKernelError {
    EntityKernelError::local("entityProviderAction", detail)
}

fn object(entries: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
    CanonicalValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

fn number(value: u64) -> Result<CanonicalValue, EntityKernelError> {
    Ok(CanonicalValue::Number(
        CanonicalNumber::try_from_u64(value).map_err(|error| invalid(error.to_string()))?,
    ))
}

fn bigint(value: U256) -> CanonicalValue {
    let mut bytes = [0_u8; 32];
    value.to_big_endian(&mut bytes);
    CanonicalValue::BigInt(num_bigint::BigInt::from_bytes_be(
        num_bigint::Sign::Plus,
        &bytes,
    ))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(2 + bytes.len() * 2);
    output.push_str("0x");
    for byte in bytes {
        output.push(DIGITS[usize::from(byte >> 4)] as char);
        output.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    output
}

fn u256_word(value: U256) -> [u8; 32] {
    let mut output = [0_u8; 32];
    value.to_big_endian(&mut output);
    output
}

pub fn hash_entity_provider_action(intent: &EntityProviderActionIntent) -> [u8; 32] {
    let mut encoded = Vec::with_capacity(300);
    match &intent.payload {
        EntityProviderActionPayload::Transfer {
            to,
            token_id,
            amount,
        } => {
            encoded.extend_from_slice(b"ENTITY_TRANSFER");
            encoded.extend_from_slice(&u256_word(intent.chain_id));
            encoded.extend_from_slice(&intent.entity_provider_address);
            encoded.extend_from_slice(&u256_word(intent.entity_number));
            encoded.extend_from_slice(&u256_word(intent.board_epoch));
            encoded.extend_from_slice(to);
            encoded.extend_from_slice(&u256_word(*token_id));
            encoded.extend_from_slice(&u256_word(*amount));
            encoded.extend_from_slice(&u256_word(intent.action_nonce));
        }
        EntityProviderActionPayload::ReleaseControlShares {
            recipient,
            control_amount,
            dividend_amount,
            purpose,
        } => {
            encoded.extend_from_slice(b"RELEASE_CONTROL_SHARES");
            encoded.extend_from_slice(&u256_word(intent.chain_id));
            encoded.extend_from_slice(&intent.entity_provider_address);
            encoded.extend_from_slice(&u256_word(intent.entity_number));
            encoded.extend_from_slice(&u256_word(intent.board_epoch));
            encoded.extend_from_slice(recipient);
            encoded.extend_from_slice(&u256_word(*control_amount));
            encoded.extend_from_slice(&u256_word(*dividend_amount));
            encoded.extend_from_slice(&Keccak256::digest(purpose.as_bytes()));
            encoded.extend_from_slice(&u256_word(intent.action_nonce));
        }
        EntityProviderActionPayload::Cancel {
            cancelled_action_hash,
            cancelled_action_kind,
        } => {
            encoded.extend_from_slice(b"CANCEL_ENTITY_PROVIDER_ACTION");
            encoded.extend_from_slice(&u256_word(intent.chain_id));
            encoded.extend_from_slice(&intent.entity_provider_address);
            encoded.extend_from_slice(&u256_word(intent.entity_number));
            encoded.extend_from_slice(&u256_word(intent.board_epoch));
            encoded.extend_from_slice(&u256_word(intent.action_nonce));
            encoded.extend_from_slice(cancelled_action_hash);
            encoded.push(*cancelled_action_kind);
        }
    }
    Keccak256::digest(encoded).into()
}

fn canonical_payload(payload: &EntityProviderActionPayload) -> CanonicalValue {
    match payload {
        EntityProviderActionPayload::Transfer {
            to,
            token_id,
            amount,
        } => object(vec![
            ("kind", CanonicalValue::String(payload.kind().into())),
            (
                "transfer",
                object(vec![
                    ("to", CanonicalValue::String(hex(to))),
                    ("tokenId", bigint(*token_id)),
                    ("amount", bigint(*amount)),
                ]),
            ),
        ]),
        EntityProviderActionPayload::ReleaseControlShares {
            recipient,
            control_amount,
            dividend_amount,
            purpose,
        } => object(vec![
            ("kind", CanonicalValue::String(payload.kind().into())),
            (
                "release",
                object(vec![
                    ("recipientAddress", CanonicalValue::String(hex(recipient))),
                    ("controlAmount", bigint(*control_amount)),
                    ("dividendAmount", bigint(*dividend_amount)),
                    ("purpose", CanonicalValue::String(purpose.clone())),
                ]),
            ),
        ]),
        EntityProviderActionPayload::Cancel {
            cancelled_action_hash,
            cancelled_action_kind,
        } => object(vec![
            ("kind", CanonicalValue::String(payload.kind().into())),
            (
                "cancel",
                object(vec![
                    (
                        "cancelledActionHash",
                        CanonicalValue::String(hex(cancelled_action_hash)),
                    ),
                    (
                        "cancelledActionKind",
                        CanonicalValue::Number(
                            CanonicalNumber::try_from_u64(u64::from(*cancelled_action_kind))
                                .expect("provider action kind is safe"),
                        ),
                    ),
                ]),
            ),
        ]),
    }
}

pub fn canonical_entity_provider_action_intent(
    intent: &EntityProviderActionIntent,
) -> Result<CanonicalValue, EntityKernelError> {
    if intent.action_hash != hash_entity_provider_action(intent) {
        return Err(invalid("ENTITY_PROVIDER_ACTION_HASH_MISMATCH"));
    }
    Ok(object(vec![
        ("version", number(1)?),
        ("entityId", CanonicalValue::String(intent.entity_id.clone())),
        ("entityNumber", bigint(intent.entity_number)),
        ("chainId", bigint(intent.chain_id)),
        (
            "entityProviderAddress",
            CanonicalValue::String(hex(&intent.entity_provider_address)),
        ),
        ("boardEpoch", bigint(intent.board_epoch)),
        ("actionNonce", bigint(intent.action_nonce)),
        (
            "actionHash",
            CanonicalValue::String(hex(&intent.action_hash)),
        ),
        ("generation", number(intent.generation)?),
        ("createdAt", number(intent.created_at)?),
        ("payload", canonical_payload(&intent.payload)),
    ]))
}

pub fn canonical_entity_provider_action_state(
    state: &EntityProviderActionState,
) -> Result<CanonicalValue, EntityKernelError> {
    let mut fields = vec![
        ("version", number(1)?),
        ("confirmedNonce", bigint(state.confirmed_nonce)),
        ("generation", number(state.generation)?),
    ];
    if let Some(pending) = &state.pending {
        fields.push(("pending", canonical_entity_provider_action_intent(pending)?));
    }
    Ok(object(fields))
}

fn fields<'a>(
    value: &'a CanonicalValue,
    code: &str,
) -> Result<&'a [(String, CanonicalValue)], EntityKernelError> {
    match value {
        CanonicalValue::Object(fields) => Ok(fields),
        _ => Err(invalid(code)),
    }
}

fn get<'a>(
    fields: &'a [(String, CanonicalValue)],
    name: &str,
) -> Result<&'a CanonicalValue, EntityKernelError> {
    fields
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
        .ok_or_else(|| invalid(format!("ENTITY_PROVIDER_ACTION_FIELD_MISSING:{name}")))
}

fn exact(fields: &[(String, CanonicalValue)], names: &[&str]) -> Result<(), EntityKernelError> {
    if fields.len() != names.len() || fields.iter().any(|(key, _)| !names.contains(&key.as_str())) {
        return Err(invalid("ENTITY_PROVIDER_ACTION_FIELDS_INVALID"));
    }
    Ok(())
}

fn safe_number(value: &CanonicalValue, code: &str) -> Result<u64, EntityKernelError> {
    match value {
        CanonicalValue::Number(value) => value.as_str().parse().map_err(|_| invalid(code)),
        _ => Err(invalid(code)),
    }
}

fn uint(value: &CanonicalValue, code: &str) -> Result<U256, EntityKernelError> {
    let CanonicalValue::BigInt(value) = value else {
        return Err(invalid(code));
    };
    if value.sign() == num_bigint::Sign::Minus {
        return Err(invalid(code));
    }
    let (_, bytes) = value.to_bytes_be();
    if bytes.len() > 32 {
        return Err(invalid(code));
    }
    Ok(U256::from_big_endian(&bytes))
}

fn text<'a>(value: &'a CanonicalValue, code: &str) -> Result<&'a str, EntityKernelError> {
    match value {
        CanonicalValue::String(value) => Ok(value),
        _ => Err(invalid(code)),
    }
}

fn fixed_hex<const N: usize>(
    value: &CanonicalValue,
    code: &str,
) -> Result<[u8; N], EntityKernelError> {
    let value = text(value, code)?;
    let raw = value.strip_prefix("0x").ok_or_else(|| invalid(code))?;
    if raw.len() != N * 2 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid(code));
    }
    let bytes = (0..raw.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&raw[index..index + 2], 16).map_err(|_| invalid(code)))
        .collect::<Result<Vec<_>, _>>()?;
    bytes.try_into().map_err(|_| invalid(code))
}

fn decode_payload(
    value: &CanonicalValue,
) -> Result<EntityProviderActionPayload, EntityKernelError> {
    let payload = fields(value, "ENTITY_PROVIDER_ACTION_PAYLOAD_OBJECT")?;
    let kind = text(get(payload, "kind")?, "ENTITY_PROVIDER_ACTION_KIND_INVALID")?;
    let decoded = match kind {
        "entityTransferTokens" => {
            exact(payload, &["kind", "transfer"])?;
            let transfer = fields(
                get(payload, "transfer")?,
                "ENTITY_PROVIDER_ACTION_TRANSFER_OBJECT",
            )?;
            exact(transfer, &["to", "tokenId", "amount"])?;
            EntityProviderActionPayload::Transfer {
                to: fixed_hex(
                    get(transfer, "to")?,
                    "ENTITY_PROVIDER_ACTION_RECIPIENT_INVALID",
                )?,
                token_id: uint(
                    get(transfer, "tokenId")?,
                    "ENTITY_PROVIDER_ACTION_TOKEN_ID_INVALID",
                )?,
                amount: uint(
                    get(transfer, "amount")?,
                    "ENTITY_PROVIDER_ACTION_AMOUNT_INVALID",
                )?,
            }
        }
        "releaseControlShares" => {
            exact(payload, &["kind", "release"])?;
            let release = fields(
                get(payload, "release")?,
                "ENTITY_PROVIDER_ACTION_RELEASE_OBJECT",
            )?;
            exact(
                release,
                &[
                    "recipientAddress",
                    "controlAmount",
                    "dividendAmount",
                    "purpose",
                ],
            )?;
            EntityProviderActionPayload::ReleaseControlShares {
                recipient: fixed_hex(
                    get(release, "recipientAddress")?,
                    "ENTITY_PROVIDER_ACTION_RECIPIENT_INVALID",
                )?,
                control_amount: uint(
                    get(release, "controlAmount")?,
                    "ENTITY_PROVIDER_ACTION_CONTROL_AMOUNT_INVALID",
                )?,
                dividend_amount: uint(
                    get(release, "dividendAmount")?,
                    "ENTITY_PROVIDER_ACTION_DIVIDEND_AMOUNT_INVALID",
                )?,
                purpose: text(
                    get(release, "purpose")?,
                    "ENTITY_PROVIDER_ACTION_PURPOSE_INVALID",
                )?
                .to_string(),
            }
        }
        "cancelPendingAction" => {
            exact(payload, &["kind", "cancel"])?;
            let cancel = fields(
                get(payload, "cancel")?,
                "ENTITY_PROVIDER_ACTION_CANCEL_OBJECT",
            )?;
            exact(cancel, &["cancelledActionHash", "cancelledActionKind"])?;
            EntityProviderActionPayload::Cancel {
                cancelled_action_hash: fixed_hex(
                    get(cancel, "cancelledActionHash")?,
                    "ENTITY_PROVIDER_ACTION_CANCELLED_HASH_INVALID",
                )?,
                cancelled_action_kind: u8::try_from(safe_number(
                    get(cancel, "cancelledActionKind")?,
                    "ENTITY_PROVIDER_ACTION_CANCELLED_KIND_INVALID",
                )?)
                .map_err(|_| invalid("ENTITY_PROVIDER_ACTION_CANCELLED_KIND_INVALID"))?,
            }
        }
        _ => {
            return Err(invalid(format!(
                "ENTITY_PROVIDER_ACTION_KIND_INVALID:{kind}"
            )));
        }
    };
    validate_provider_payload(&decoded)?;
    Ok(decoded)
}

pub fn decode_canonical_entity_provider_action_intent(
    value: &CanonicalValue,
) -> Result<EntityProviderActionIntent, EntityKernelError> {
    let intent = fields(value, "ENTITY_PROVIDER_ACTION_INTENT_OBJECT")?;
    exact(
        intent,
        &[
            "version",
            "entityId",
            "entityNumber",
            "chainId",
            "entityProviderAddress",
            "boardEpoch",
            "actionNonce",
            "actionHash",
            "generation",
            "createdAt",
            "payload",
        ],
    )?;
    if safe_number(
        get(intent, "version")?,
        "ENTITY_PROVIDER_ACTION_VERSION_INVALID",
    )? != 1
    {
        return Err(invalid("ENTITY_PROVIDER_ACTION_VERSION_INVALID"));
    }
    let decoded = EntityProviderActionIntent {
        entity_id: text(
            get(intent, "entityId")?,
            "ENTITY_PROVIDER_ACTION_ENTITY_ID_INVALID",
        )?
        .to_string(),
        entity_number: uint(
            get(intent, "entityNumber")?,
            "ENTITY_PROVIDER_ACTION_ENTITY_NUMBER_INVALID",
        )?,
        chain_id: uint(
            get(intent, "chainId")?,
            "ENTITY_PROVIDER_ACTION_CHAIN_ID_INVALID",
        )?,
        entity_provider_address: fixed_hex(
            get(intent, "entityProviderAddress")?,
            "ENTITY_PROVIDER_ACTION_PROVIDER_INVALID",
        )?,
        board_epoch: uint(
            get(intent, "boardEpoch")?,
            "ENTITY_PROVIDER_ACTION_BOARD_EPOCH_INVALID",
        )?,
        action_nonce: uint(
            get(intent, "actionNonce")?,
            "ENTITY_PROVIDER_ACTION_NONCE_INVALID",
        )?,
        action_hash: fixed_hex(
            get(intent, "actionHash")?,
            "ENTITY_PROVIDER_ACTION_HASH_INVALID",
        )?,
        generation: safe_number(
            get(intent, "generation")?,
            "ENTITY_PROVIDER_ACTION_GENERATION_INVALID",
        )?,
        created_at: safe_number(
            get(intent, "createdAt")?,
            "ENTITY_PROVIDER_ACTION_CREATED_AT_INVALID",
        )?,
        payload: decode_payload(get(intent, "payload")?)?,
    };
    if decoded.entity_number.is_zero()
        || decoded.chain_id.is_zero()
        || decoded.action_nonce.is_zero()
        || decoded.generation == 0
        || decoded
            .entity_provider_address
            .iter()
            .all(|byte| *byte == 0)
        || decoded.action_hash != hash_entity_provider_action(&decoded)
    {
        return Err(invalid("ENTITY_PROVIDER_ACTION_INTENT_INVALID"));
    }
    let expected_id = hex(&u256_word(decoded.entity_number));
    if decoded.entity_id != expected_id {
        return Err(invalid("ENTITY_PROVIDER_ACTION_ENTITY_ID_INVALID"));
    }
    Ok(decoded)
}

pub fn decode_canonical_entity_provider_action_state(
    value: &CanonicalValue,
) -> Result<EntityProviderActionState, EntityKernelError> {
    let state = fields(value, "ENTITY_PROVIDER_ACTION_STATE_OBJECT")?;
    if state.len() == 3 {
        exact(state, &["version", "confirmedNonce", "generation"])?;
    } else if state.len() == 4 {
        exact(
            state,
            &["version", "confirmedNonce", "generation", "pending"],
        )?;
    } else {
        return Err(invalid("ENTITY_PROVIDER_ACTION_STATE_FIELDS_INVALID"));
    }
    for name in ["version", "confirmedNonce", "generation"] {
        let _ = get(state, name)?;
    }
    if safe_number(
        get(state, "version")?,
        "ENTITY_PROVIDER_ACTION_STATE_VERSION_INVALID",
    )? != 1
    {
        return Err(invalid("ENTITY_PROVIDER_ACTION_STATE_VERSION_INVALID"));
    }
    let decoded = EntityProviderActionState {
        confirmed_nonce: uint(
            get(state, "confirmedNonce")?,
            "ENTITY_PROVIDER_ACTION_CONFIRMED_NONCE_INVALID",
        )?,
        generation: safe_number(
            get(state, "generation")?,
            "ENTITY_PROVIDER_ACTION_GENERATION_INVALID",
        )?,
        pending: state
            .iter()
            .find_map(|(key, value)| (key == "pending").then_some(value))
            .map(decode_canonical_entity_provider_action_intent)
            .transpose()?,
    };
    if decoded.pending.as_ref().is_some_and(|pending| {
        pending.generation != decoded.generation
            || pending.action_nonce != decoded.confirmed_nonce.saturating_add(U256::one())
    }) {
        return Err(invalid("ENTITY_PROVIDER_ACTION_PENDING_STATE_INVALID"));
    }
    Ok(decoded)
}

pub fn validate_provider_payload(
    payload: &EntityProviderActionPayload,
) -> Result<(), EntityKernelError> {
    match payload {
        EntityProviderActionPayload::Transfer { to, amount, .. } => {
            if to.iter().all(|byte| *byte == 0) || amount.is_zero() {
                return Err(invalid("ENTITY_PROVIDER_ACTION_TRANSFER_INVALID"));
            }
        }
        EntityProviderActionPayload::ReleaseControlShares {
            recipient,
            control_amount,
            dividend_amount,
            purpose,
        } => {
            if recipient.iter().all(|byte| *byte == 0)
                || (control_amount.is_zero() && dividend_amount.is_zero())
                || purpose.len() > MAX_PURPOSE_BYTES
            {
                return Err(invalid("ENTITY_PROVIDER_ACTION_RELEASE_INVALID"));
            }
        }
        EntityProviderActionPayload::Cancel {
            cancelled_action_hash,
            cancelled_action_kind,
        } => {
            if cancelled_action_hash.iter().all(|byte| *byte == 0) || *cancelled_action_kind > 1 {
                return Err(invalid("ENTITY_PROVIDER_ACTION_CANCEL_INVALID"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn intent(payload: EntityProviderActionPayload) -> EntityProviderActionIntent {
        let mut intent = EntityProviderActionIntent {
            entity_id: format!("0x{}", "11".repeat(32)),
            entity_number: U256::from_big_endian(&[0x11; 32]),
            chain_id: U256::from(31_337_u64),
            entity_provider_address: [0x22; 20],
            board_epoch: U256::from(7_u8),
            action_nonce: U256::from(3_u8),
            action_hash: [0_u8; 32],
            generation: 4,
            created_at: 99,
            payload,
        };
        intent.action_hash = hash_entity_provider_action(&intent);
        intent
    }

    #[test]
    fn action_hashes_match_typescript_golden() {
        let rows = [
            (
                EntityProviderActionPayload::Transfer {
                    to: [0x33; 20],
                    token_id: U256::from(5_u8),
                    amount: U256::from(9_u8),
                },
                "0xa386281bbd4f8c695aec5de205612c2ba0031449e654ba1f8db898cbcf67643c",
            ),
            (
                EntityProviderActionPayload::ReleaseControlShares {
                    recipient: [0x44; 20],
                    control_amount: U256::from(8_u8),
                    dividend_amount: U256::from(2_u8),
                    purpose: "ship".into(),
                },
                "0xc0904dac9aeb973fa1357cc9e83786896e211bfe2c6ca361d511b761a7b94781",
            ),
            (
                EntityProviderActionPayload::Cancel {
                    cancelled_action_hash: [0x55; 32],
                    cancelled_action_kind: 1,
                },
                "0xd97ee106f62433b39efab3571f08f43cd74866d9e5eb39765d55b9ebf20fd2a0",
            ),
        ];
        for (payload, expected) in rows {
            assert_eq!(
                hex(&hash_entity_provider_action(&intent(payload))),
                expected
            );
        }
    }

    #[test]
    fn action_state_round_trips_canonical_value() {
        let pending = intent(EntityProviderActionPayload::Transfer {
            to: [0x33; 20],
            token_id: U256::from(5_u8),
            amount: U256::from(9_u8),
        });
        let state = EntityProviderActionState {
            confirmed_nonce: U256::from(2_u8),
            generation: 4,
            pending: Some(pending),
        };
        let canonical = canonical_entity_provider_action_state(&state).expect("encode");
        assert_eq!(
            decode_canonical_entity_provider_action_state(&canonical).expect("decode"),
            state
        );
    }
}

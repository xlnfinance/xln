use ethabi::{Token, ethereum_types::U256};
use num_bigint::{BigInt, Sign};
use sha3::{Digest, Keccak256};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use crate::j_batch::{
    EntityAmount, ExternalTokenToReserve, JBatch, JBatchFeeOverrides, ReserveToCollateral,
    ReserveToExternalToken, ReserveToReserve, SentJBatch,
};
use crate::{
    CanonicalEntityTx, EntityFrameAuthority, EntityFrameEvent, EntityJOutput, EntityKernelError,
    EntityProfile, EntityProposal, EntityProposalVote, EntityStateSlice, EntityTxKind, HashToSign,
    HashType, HubProfile, JBatchState, JBatchStatus, LocalEntityTx, OrderbookConsensusMetadata,
    OrderbookState, SpreadDistribution,
};

const PROFILE_ENTITY_KINDS: &[&str] = &[
    "company",
    "foundation",
    "government",
    "nonprofit",
    "person",
    "protocol",
];
const PROFILE_ENTITY_SECTORS: &[&str] = &[
    "commerce",
    "education",
    "energy",
    "finance",
    "healthcare",
    "infrastructure",
    "media",
    "professional-services",
    "public-sector",
    "real-estate",
    "technology",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LocalEntityControlTx {
    Chat {
        from: String,
        message: String,
    },
    ChatMessage {
        message: String,
    },
    ProfileUpdate(ProfileUpdate),
    E2r(E2r),
    Propose(EntityPropose),
    Vote(EntityVote),
    R2r {
        receiving_entity: [u8; 32],
        token_id: u64,
        amount: U256,
    },
    R2e {
        receiving_entity: [u8; 32],
        token_id: u64,
        amount: U256,
    },
    R2c {
        receiving_entity: Option<[u8; 32]>,
        counterparty: [u8; 32],
        token_id: u64,
        amount: U256,
    },
    JBroadcast {
        fee_overrides: Option<JBatchFeeOverrides>,
    },
    JRebroadcast {
        gas_bump_bps: Option<u32>,
    },
    JAbortSentBatch {
        reason: Option<String>,
        requeue_to_current: bool,
    },
    JClearBatch {
        reason: Option<String>,
    },
    MintReserves {
        token_id: u64,
        amount: BigInt,
    },
    EntityProviderTransfer {
        to: [u8; 20],
        token_id: U256,
        amount: U256,
    },
    EntityProviderReleaseControlShares {
        recipient: [u8; 20],
        control_amount: U256,
        dividend_amount: U256,
        purpose: String,
    },
    EntityProviderCancelAction {
        action_hash: [u8; 32],
    },
    EntityProviderProposeControlBoard(ControlBoardProposal),
    EntityProviderActivateBoard {
        target_entity_id: [u8; 32],
    },
    InitOrderbookExt(HubProfile),
    SetHubConfig(CanonicalValue),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LocalEntityControlResult {
    pub j_outputs: Vec<EntityJOutput>,
    pub hashes_to_sign: Vec<HashToSign>,
    pub approved_entity_txs: Vec<LocalEntityTx>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityPropose {
    pub proposer: String,
    pub action: CanonicalValue,
    pub board_hash: String,
    pub board_epoch: u64,
    pub command_nonce: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityVote {
    pub proposal_id: String,
    pub voter: String,
    pub choice: crate::EntityVoteChoice,
    pub comment: Option<String>,
    pub board_hash: String,
    pub board_epoch: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlBoardSupporterInput {
    pub entity_id: [u8; 32],
    pub hanko_signature: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlBoardProposal {
    pub target_entity_id: [u8; 32],
    pub new_board_hash: [u8; 32],
    pub action_nonce: U256,
    pub supporter_votes: Vec<ControlBoardSupporterInput>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct E2r {
    pub contract_text: String,
    pub contract_address: [u8; 20],
    pub token_type: u8,
    pub external_token_id: U256,
    pub internal_token_id: U256,
    pub amount: U256,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProfileUpdate {
    pub entity_id: String,
    pub name: Option<String>,
    pub entity_kind: Option<Option<String>>,
    pub sectors: Option<Vec<String>>,
    pub avatar: Option<String>,
    pub bio: Option<String>,
    pub website: Option<String>,
}

fn invalid(kind: &'static str, detail: impl Into<String>) -> EntityKernelError {
    EntityKernelError::local(kind, detail)
}

fn number(value: u64) -> Result<CanonicalValue, EntityKernelError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|error| invalid("canonicalNumber", error.to_string()))
}

fn object<'a>(
    value: &'a CanonicalValue,
    kind: &'static str,
    field: &'static str,
) -> Result<&'a [(String, CanonicalValue)], EntityKernelError> {
    match value {
        CanonicalValue::Object(entries) => Ok(entries),
        _ => Err(invalid(kind, format!("{field}:OBJECT"))),
    }
}

fn field<'a>(entries: &'a [(String, CanonicalValue)], name: &str) -> Option<&'a CanonicalValue> {
    entries
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
}

fn string(
    entries: &[(String, CanonicalValue)],
    name: &'static str,
    kind: &'static str,
) -> Result<String, EntityKernelError> {
    match field(entries, name) {
        Some(CanonicalValue::String(value)) => Ok(value.clone()),
        _ => Err(invalid(kind, format!("{name}:STRING"))),
    }
}

fn optional_string(
    entries: &[(String, CanonicalValue)],
    name: &'static str,
    kind: &'static str,
) -> Result<Option<String>, EntityKernelError> {
    match field(entries, name) {
        None => Ok(None),
        Some(CanonicalValue::String(value)) => Ok(Some(value.clone())),
        _ => Err(invalid(kind, format!("{name}:STRING"))),
    }
}

fn safe_u64(
    entries: &[(String, CanonicalValue)],
    name: &'static str,
    kind: &'static str,
    default: u64,
) -> Result<u64, EntityKernelError> {
    match field(entries, name) {
        None => Ok(default),
        Some(CanonicalValue::Number(value)) => value
            .as_str()
            .parse()
            .map_err(|_| invalid(kind, format!("{name}:SAFE_UINT"))),
        _ => Err(invalid(kind, format!("{name}:SAFE_UINT"))),
    }
}

fn positive_u256(
    entries: &[(String, CanonicalValue)],
    name: &'static str,
    kind: &'static str,
    optional: bool,
) -> Result<U256, EntityKernelError> {
    let Some(value) = field(entries, name) else {
        return optional
            .then_some(U256::zero())
            .ok_or_else(|| invalid(kind, format!("{name}:MISSING")));
    };
    let CanonicalValue::BigInt(value) = value else {
        return Err(invalid(kind, format!("{name}:BIGINT")));
    };
    if value.sign() == Sign::Minus {
        return Err(invalid(kind, format!("{name}:UINT256")));
    }
    let (_, bytes) = value.to_bytes_be();
    if bytes.len() > 32 {
        return Err(invalid(kind, format!("{name}:UINT256")));
    }
    Ok(U256::from_big_endian(&bytes))
}

fn fixed_hex<const N: usize>(
    value: &str,
    kind: &'static str,
    name: &str,
) -> Result<[u8; N], EntityKernelError> {
    let raw = value
        .strip_prefix("0x")
        .ok_or_else(|| invalid(kind, format!("{name}:HEX")))?;
    if raw.len() != N * 2 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid(kind, format!("{name}:HEX")));
    }
    let bytes = (0..raw.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&raw[index..index + 2], 16)
                .map_err(|_| invalid(kind, format!("{name}:HEX")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    bytes
        .try_into()
        .map_err(|_| invalid(kind, format!("{name}:HEX")))
}

fn hex_bytes(value: &str, kind: &'static str, name: &str) -> Result<Vec<u8>, EntityKernelError> {
    let raw = value
        .strip_prefix("0x")
        .ok_or_else(|| invalid(kind, format!("{name}:HEX")))?;
    if raw.is_empty()
        || raw.len() % 2 != 0
        || !raw.bytes().all(|byte| byte.is_ascii_hexdigit())
        || value.to_ascii_lowercase() != value
    {
        return Err(invalid(kind, format!("{name}:HEX")));
    }
    (0..raw.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&raw[index..index + 2], 16)
                .map_err(|_| invalid(kind, format!("{name}:HEX")))
        })
        .collect()
}

fn render_hex(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(2 + bytes.len() * 2);
    output.push_str("0x");
    for byte in bytes {
        output.push(ALPHABET[usize::from(byte >> 4)] as char);
        output.push(ALPHABET[usize::from(byte & 0x0f)] as char);
    }
    output
}

fn decode_e2r(
    entries: &[(String, CanonicalValue)],
) -> Result<LocalEntityControlTx, EntityKernelError> {
    let contract = string(entries, "contractAddress", "e2r")?;
    let contract_address = fixed_hex::<20>(&contract, "e2r", "contractAddress")?;
    if contract_address.iter().all(|byte| *byte == 0) {
        return Err(invalid("e2r", format!("INVALID_CONTRACT:{contract}")));
    }
    let amount = positive_u256(entries, "amount", "e2r", false)?;
    if amount.is_zero() {
        return Err(invalid("e2r", "AMOUNT_NOT_POSITIVE"));
    }
    let token_type = u8::try_from(safe_u64(entries, "tokenType", "e2r", 0)?)
        .map_err(|_| invalid("e2r", "tokenType:UINT8"))?;
    let internal_token_id = U256::from(safe_u64(entries, "internalTokenId", "e2r", 0)?);
    Ok(LocalEntityControlTx::E2r(E2r {
        contract_text: contract,
        contract_address,
        token_type,
        external_token_id: positive_u256(entries, "externalTokenId", "e2r", true)?,
        internal_token_id,
        amount,
    }))
}

fn decode_reserve_tx(
    entries: &[(String, CanonicalValue)],
    kind: EntityTxKind,
) -> Result<LocalEntityControlTx, EntityKernelError> {
    let label = kind.as_str();
    let token_id = safe_u64(entries, "tokenId", label, 0)?;
    let amount = positive_u256(entries, "amount", label, false)?;
    if token_id == 0 || amount.is_zero() {
        return Err(invalid(label, "TOKEN_OR_AMOUNT_INVALID"));
    }
    match kind {
        EntityTxKind::R2r => Ok(LocalEntityControlTx::R2r {
            receiving_entity: fixed_hex(
                &string(entries, "toEntityId", label)?,
                label,
                "toEntityId",
            )?,
            token_id,
            amount,
        }),
        EntityTxKind::R2e => Ok(LocalEntityControlTx::R2e {
            receiving_entity: fixed_hex(
                &string(entries, "receivingEntity", label)?,
                label,
                "receivingEntity",
            )?,
            token_id,
            amount,
        }),
        EntityTxKind::R2c => {
            let receiving_entity = optional_string(entries, "receivingEntityId", label)?
                .map(|value| fixed_hex(&value, label, "receivingEntityId"))
                .transpose()?;
            let counterparty = fixed_hex(
                &string(entries, "counterpartyId", label)?,
                label,
                "counterpartyId",
            )?;
            if receiving_entity == Some(counterparty) {
                return Err(invalid(label, "ACCOUNT_PARTIES_INVALID"));
            }
            // Quote-backed fees require the exact live Account shadow, which
            // is handled by the Account-owning financial path. Silently
            // ignoring it would undercharge, so reject this control decoder.
            if field(entries, "rebalanceQuoteId").is_some() {
                return Err(invalid(label, "REBALANCE_QUOTE_REQUIRES_ACCOUNT_PATH"));
            }
            Ok(LocalEntityControlTx::R2c {
                receiving_entity,
                counterparty,
                token_id,
                amount,
            })
        }
        _ => unreachable!(),
    }
}

fn optional_bool(
    entries: &[(String, CanonicalValue)],
    name: &str,
    default: bool,
    kind: &'static str,
) -> Result<bool, EntityKernelError> {
    match field(entries, name) {
        None => Ok(default),
        Some(CanonicalValue::Bool(value)) => Ok(*value),
        _ => Err(invalid(kind, format!("{name}:BOOL"))),
    }
}

fn fee_overrides(
    entries: &[(String, CanonicalValue)],
    kind: &'static str,
) -> Result<Option<JBatchFeeOverrides>, EntityKernelError> {
    let Some(value) = field(entries, "feeOverrides") else {
        return Ok(None);
    };
    let fees = object(value, kind, "feeOverrides")?;
    let gas_bump_bps = field(fees, "gasBumpBps")
        .map(|_| safe_u64(fees, "gasBumpBps", kind, 0))
        .transpose()?
        .map(|value| u32::try_from(value.min(20_000)).expect("bounded"));
    Ok(Some(JBatchFeeOverrides {
        gas_bump_bps,
        max_fee_per_gas_wei: optional_string(fees, "maxFeePerGasWei", kind)?,
        max_priority_fee_per_gas_wei: optional_string(fees, "maxPriorityFeePerGasWei", kind)?,
    }))
}

fn decode_profile(tx: &CanonicalEntityTx) -> Result<LocalEntityControlTx, EntityKernelError> {
    let data = object(
        tx.frame_data()
            .ok_or_else(|| invalid("profile-update", "DATA_MISSING"))?,
        "profile-update",
        "data",
    )?;
    let profile = object(
        field(data, "profile").ok_or_else(|| invalid("profile-update", "profile:MISSING"))?,
        "profile-update",
        "profile",
    )?;
    let entity_kind = match field(profile, "entityKind") {
        None => None,
        Some(CanonicalValue::Null) => Some(None),
        Some(CanonicalValue::String(value)) => Some(Some(value.clone())),
        _ => return Err(invalid("profile-update", "entityKind:STRING_OR_NULL")),
    };
    let sectors = match field(profile, "sectors") {
        None => None,
        Some(CanonicalValue::Array(values)) => Some(
            values
                .iter()
                .map(|value| match value {
                    CanonicalValue::String(value) => Ok(value.clone()),
                    _ => Err(invalid("profile-update", "sectors:STRING_ARRAY")),
                })
                .collect::<Result<Vec<_>, _>>()?,
        ),
        _ => return Err(invalid("profile-update", "sectors:ARRAY")),
    };
    Ok(LocalEntityControlTx::ProfileUpdate(ProfileUpdate {
        entity_id: string(profile, "entityId", "profile-update")?,
        name: optional_string(profile, "name", "profile-update")?,
        entity_kind,
        sectors,
        avatar: optional_string(profile, "avatar", "profile-update")?,
        bio: optional_string(profile, "bio", "profile-update")?,
        website: optional_string(profile, "website", "profile-update")?,
    }))
}

pub fn decode_local_entity_control_tx(
    tx: &CanonicalEntityTx,
) -> Result<Option<LocalEntityControlTx>, EntityKernelError> {
    let kind = tx.kind.as_str();
    let Some(data) = tx.frame_data() else {
        return Err(invalid(kind, "DATA_MISSING"));
    };
    let entries = object(data, kind, "data")?;
    match tx.kind {
        EntityTxKind::Chat => Ok(Some(LocalEntityControlTx::Chat {
            from: string(entries, "from", "chat")?,
            message: string(entries, "message", "chat")?,
        })),
        EntityTxKind::ChatMessage => Ok(Some(LocalEntityControlTx::ChatMessage {
            message: string(entries, "message", "chatMessage")?,
        })),
        EntityTxKind::ProfileUpdate => decode_profile(tx).map(Some),
        EntityTxKind::E2r => decode_e2r(entries).map(Some),
        EntityTxKind::R2r | EntityTxKind::R2e | EntityTxKind::R2c => {
            decode_reserve_tx(entries, tx.kind).map(Some)
        }
        EntityTxKind::JBroadcast => Ok(Some(LocalEntityControlTx::JBroadcast {
            fee_overrides: fee_overrides(entries, "j_broadcast")?,
        })),
        EntityTxKind::JRebroadcast => Ok(Some(LocalEntityControlTx::JRebroadcast {
            gas_bump_bps: field(entries, "gasBumpBps")
                .map(|_| safe_u64(entries, "gasBumpBps", "j_rebroadcast", 0))
                .transpose()?
                .map(|value| u32::try_from(value.min(20_000)).expect("bounded")),
        })),
        EntityTxKind::JAbortSentBatch => Ok(Some(LocalEntityControlTx::JAbortSentBatch {
            reason: optional_string(entries, "reason", "j_abort_sent_batch")?,
            requeue_to_current: optional_bool(
                entries,
                "requeueToCurrent",
                true,
                "j_abort_sent_batch",
            )?,
        })),
        EntityTxKind::JClearBatch => Ok(Some(LocalEntityControlTx::JClearBatch {
            reason: optional_string(entries, "reason", "j_clear_batch")?,
        })),
        EntityTxKind::MintReserves => {
            let amount = positive_u256(entries, "amount", "mintReserves", false)?;
            let mut bytes = [0_u8; 32];
            amount.to_big_endian(&mut bytes);
            Ok(Some(LocalEntityControlTx::MintReserves {
                token_id: safe_u64(entries, "tokenId", "mintReserves", 0)?,
                amount: BigInt::from_bytes_be(Sign::Plus, &bytes),
            }))
        }
        EntityTxKind::EntityProviderTransfer => {
            let amount = positive_u256(entries, "amount", kind, false)?;
            if amount.is_zero() {
                return Err(invalid(kind, "ENTITY_PROVIDER_ACTION_AMOUNT_INVALID"));
            }
            Ok(Some(LocalEntityControlTx::EntityProviderTransfer {
                to: fixed_hex(&string(entries, "to", kind)?, kind, "to")?,
                token_id: positive_u256(entries, "tokenId", kind, false)?,
                amount,
            }))
        }
        EntityTxKind::EntityProviderReleaseControlShares => {
            let control_amount = positive_u256(entries, "controlAmount", kind, false)?;
            let dividend_amount = positive_u256(entries, "dividendAmount", kind, false)?;
            if control_amount.is_zero() && dividend_amount.is_zero() {
                return Err(invalid(kind, "ENTITY_PROVIDER_ACTION_RELEASE_AMOUNT_EMPTY"));
            }
            let purpose = string(entries, "purpose", kind)?;
            if purpose.len() > 1_024 {
                return Err(invalid(
                    kind,
                    format!(
                        "ENTITY_PROVIDER_ACTION_PURPOSE_OVERSIZED:{}:1024",
                        purpose.len()
                    ),
                ));
            }
            Ok(Some(
                LocalEntityControlTx::EntityProviderReleaseControlShares {
                    recipient: fixed_hex(
                        &string(entries, "recipientAddress", kind)?,
                        kind,
                        "recipientAddress",
                    )?,
                    control_amount,
                    dividend_amount,
                    purpose,
                },
            ))
        }
        EntityTxKind::EntityProviderCancelAction => {
            Ok(Some(LocalEntityControlTx::EntityProviderCancelAction {
                action_hash: fixed_hex(&string(entries, "actionHash", kind)?, kind, "actionHash")?,
            }))
        }
        EntityTxKind::EntityProviderProposeControlBoard => {
            let action_nonce = positive_u256(entries, "actionNonce", kind, false)?;
            if action_nonce.is_zero() {
                return Err(invalid(kind, "CONTROL_BOARD_PROPOSAL_NONCE_INVALID"));
            }
            let supporter_votes = match field(entries, "supporterVotes") {
                None => Vec::new(),
                Some(CanonicalValue::Array(values)) if values.len() < 256 => values
                    .iter()
                    .map(|value| {
                        let fields = object(value, kind, "supporterVote")?;
                        if fields.len() != 2 {
                            return Err(invalid(kind, "SUPPORTER_VOTE_FIELDS"));
                        }
                        Ok(ControlBoardSupporterInput {
                            entity_id: fixed_hex(
                                &string(fields, "entityId", kind)?,
                                kind,
                                "supporterVote.entityId",
                            )?,
                            hanko_signature: hex_bytes(
                                &string(fields, "hankoSignature", kind)?,
                                kind,
                                "supporterVote.hankoSignature",
                            )?,
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                Some(CanonicalValue::Array(values)) => {
                    return Err(invalid(
                        kind,
                        format!(
                            "CONTROL_BOARD_PROPOSAL_SUPPORTERS_OVERSIZED:{}",
                            values.len()
                        ),
                    ));
                }
                Some(_) => return Err(invalid(kind, "supporterVotes:ARRAY")),
            };
            Ok(Some(
                LocalEntityControlTx::EntityProviderProposeControlBoard(ControlBoardProposal {
                    target_entity_id: fixed_hex(
                        &string(entries, "targetEntityId", kind)?,
                        kind,
                        "targetEntityId",
                    )?,
                    new_board_hash: fixed_hex(
                        &string(entries, "newBoardHash", kind)?,
                        kind,
                        "newBoardHash",
                    )?,
                    action_nonce,
                    supporter_votes,
                }),
            ))
        }
        EntityTxKind::EntityProviderActivateBoard => {
            Ok(Some(LocalEntityControlTx::EntityProviderActivateBoard {
                target_entity_id: fixed_hex(
                    &string(entries, "targetEntityId", kind)?,
                    kind,
                    "targetEntityId",
                )?,
            }))
        }
        EntityTxKind::InitOrderbookExt => {
            const FIELDS: &[&str] = &[
                "name",
                "spreadDistribution",
                "referenceTokenId",
                "usdQuoteAuthorityEntityId",
                "minTradeSize",
                "supportedPairs",
            ];
            if entries.len() != FIELDS.len()
                || entries
                    .iter()
                    .any(|(name, _)| !FIELDS.contains(&name.as_str()))
            {
                return Err(invalid(kind, "FIELDS"));
            }
            let spread_entries = field(entries, "spreadDistribution")
                .ok_or_else(|| invalid(kind, "spreadDistribution:MISSING"))
                .and_then(|value| object(value, kind, "spreadDistribution"))?;
            const SPREAD_FIELDS: &[&str] = &[
                "makerBps",
                "takerBps",
                "hubBps",
                "makerReferrerBps",
                "takerReferrerBps",
            ];
            if spread_entries.len() != SPREAD_FIELDS.len()
                || spread_entries
                    .iter()
                    .any(|(name, _)| !SPREAD_FIELDS.contains(&name.as_str()))
            {
                return Err(invalid(kind, "spreadDistribution:FIELDS"));
            }
            let bps = |name| {
                u32::try_from(safe_u64(spread_entries, name, kind, 0)?)
                    .map_err(|_| invalid(kind, format!("{name}:UINT32")))
            };
            let quote_authority = string(entries, "usdQuoteAuthorityEntityId", kind)?
                .trim()
                .to_ascii_lowercase();
            fixed_hex::<32>(&quote_authority, kind, "usdQuoteAuthorityEntityId")?;
            let min_trade_size = match field(entries, "minTradeSize") {
                Some(CanonicalValue::BigInt(value)) => value.clone(),
                _ => return Err(invalid(kind, "minTradeSize:BIGINT")),
            };
            let supported_pairs = match field(entries, "supportedPairs") {
                Some(CanonicalValue::Array(values)) => values
                    .iter()
                    .map(|value| match value {
                        CanonicalValue::String(value) if !value.is_empty() => Ok(value.clone()),
                        _ => Err(invalid(kind, "supportedPairs:STRING_ARRAY")),
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                _ => return Err(invalid(kind, "supportedPairs:ARRAY")),
            };
            Ok(Some(LocalEntityControlTx::InitOrderbookExt(HubProfile {
                entity_id: String::new(),
                name: string(entries, "name", kind)?,
                spread_distribution: SpreadDistribution {
                    maker_bps: bps("makerBps")?,
                    taker_bps: bps("takerBps")?,
                    hub_bps: bps("hubBps")?,
                    maker_referrer_bps: bps("makerReferrerBps")?,
                    taker_referrer_bps: bps("takerReferrerBps")?,
                },
                reference_token_id: u32::try_from(safe_u64(entries, "referenceTokenId", kind, 0)?)
                    .map_err(|_| invalid(kind, "referenceTokenId:UINT32"))?,
                usd_quote_authority_entity_id: quote_authority,
                min_trade_size,
                supported_pairs,
            })))
        }
        EntityTxKind::SetHubConfig => {
            const FIELDS: &[&str] = &[
                "hubName",
                "matchingStrategy",
                "policyVersion",
                "routingFeePPM",
                "baseFee",
                "swapTakerFeeBps",
                "disputeAutoFinalizeMode",
                "minCollateralThreshold",
                "c2rWithdrawSoftLimit",
                "rebalanceBaseFee",
                "rebalanceLiquidityFeeBps",
                "rebalanceGasFee",
                "rebalanceTimeoutMs",
            ];
            if entries
                .iter()
                .any(|(name, _)| !FIELDS.contains(&name.as_str()))
            {
                return Err(invalid(kind, "HUB_CONFIG_FIELD_UNSUPPORTED"));
            }
            if [
                "c2rWithdrawSoftLimit",
                "rebalanceBaseFee",
                "rebalanceGasFee",
            ]
            .iter()
            .any(|name| field(entries, name).is_some())
            {
                return Err(invalid(
                    kind,
                    "HUB_REBALANCE_TOKENLESS_RAW_OVERRIDE_FORBIDDEN",
                ));
            }
            Ok(Some(LocalEntityControlTx::SetHubConfig(data.clone())))
        }
        _ => Ok(None),
    }
}

fn normalized_name(raw: Option<&str>, entity_id: &str) -> String {
    if let Some(name) = raw.map(str::trim).filter(|name| !name.is_empty()) {
        return name.to_string();
    }
    let suffix = entity_id
        .get(entity_id.len().saturating_sub(4)..)
        .unwrap_or(entity_id);
    format!("Entity {suffix}")
}

fn apply_profile(
    state: &mut EntityStateSlice,
    update: ProfileUpdate,
) -> Result<(), EntityKernelError> {
    if update.entity_id != state.entity_id {
        return Err(invalid(
            "profile-update",
            format!("INVALID_ENTITY:{}:{}", state.entity_id, update.entity_id),
        ));
    }
    let entity_kind = update
        .entity_kind
        .unwrap_or_else(|| state.profile.entity_kind.clone());
    if let Some(kind) = entity_kind.as_deref()
        && !PROFILE_ENTITY_KINDS.contains(&kind)
    {
        return Err(invalid(
            "profile-update",
            format!("ENTITY_KIND_INVALID:{kind}"),
        ));
    }
    let sectors = update
        .sectors
        .unwrap_or_else(|| state.profile.sectors.clone());
    if sectors.len() > 4
        || sectors
            .iter()
            .any(|sector| !PROFILE_ENTITY_SECTORS.contains(&sector.as_str()))
        || sectors.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return Err(invalid("profile-update", "ENTITY_SECTORS_NONCANONICAL"));
    }
    state.profile = EntityProfile {
        name: normalized_name(
            update.name.as_deref().or(Some(&state.profile.name)),
            &state.entity_id,
        ),
        is_hub: state.profile.is_hub,
        entity_kind,
        sectors,
        avatar: update
            .avatar
            .unwrap_or_else(|| state.profile.avatar.clone()),
        bio: update.bio.unwrap_or_else(|| state.profile.bio.clone()),
        website: update
            .website
            .unwrap_or_else(|| state.profile.website.clone()),
    };
    Ok(())
}

fn optional_bigint_field(
    entries: &[(String, CanonicalValue)],
    name: &'static str,
    default: BigInt,
) -> Result<BigInt, EntityKernelError> {
    match field(entries, name) {
        None => Ok(default),
        Some(CanonicalValue::BigInt(value)) => Ok(value.clone()),
        _ => Err(invalid("setHubConfig", format!("{name}:BIGINT"))),
    }
}

fn previous_hub_field<'a>(
    previous: Option<&'a CanonicalValue>,
    name: &str,
) -> Option<&'a CanonicalValue> {
    let CanonicalValue::Object(fields) = previous? else {
        return None;
    };
    field(fields, name)
}

fn apply_set_hub_config(
    state: &mut EntityStateSlice,
    data: CanonicalValue,
    events: &mut Vec<EntityFrameEvent>,
) -> Result<(), EntityKernelError> {
    let entries = object(&data, "setHubConfig", "data")?;
    let previous = state.hub_rebalance_config.as_ref();
    let liquidity_fee =
        optional_bigint_field(entries, "rebalanceLiquidityFeeBps", BigInt::from(1_u8))?;
    if liquidity_fee < BigInt::from(0_u8) || liquidity_fee > BigInt::from(10_000_u32) {
        return Err(invalid(
            "setHubConfig",
            format!("HUB_REBALANCE_LIQUIDITY_FEE_BPS_INVALID:{liquidity_fee}"),
        ));
    }
    let previous_liquidity = previous_hub_field(previous, "rebalanceLiquidityFeeBps");
    let fee_policy_changed = previous.is_none()
        || previous_liquidity != Some(&CanonicalValue::BigInt(liquidity_fee.clone()));
    let previous_version = match previous_hub_field(previous, "policyVersion") {
        Some(CanonicalValue::Number(value)) => value
            .as_str()
            .parse::<u64>()
            .map_err(|_| invalid("setHubConfig", "HUB_REBALANCE_POLICY_VERSION_CORRUPT"))?,
        None => 0,
        _ => {
            return Err(invalid(
                "setHubConfig",
                "HUB_REBALANCE_POLICY_VERSION_CORRUPT",
            ));
        }
    };
    let requested_version = field(entries, "policyVersion")
        .map(|_| safe_u64(entries, "policyVersion", "setHubConfig", 0))
        .transpose()?;
    if requested_version == Some(0) {
        return Err(invalid(
            "setHubConfig",
            "HUB_REBALANCE_POLICY_VERSION_INVALID",
        ));
    }
    let policy_version = match requested_version {
        Some(requested) if requested < previous_version => {
            return Err(invalid(
                "setHubConfig",
                format!("HUB_REBALANCE_POLICY_VERSION_STALE:{requested}<{previous_version}"),
            ));
        }
        Some(requested) if requested == previous_version && fee_policy_changed => {
            return Err(invalid(
                "setHubConfig",
                format!("HUB_REBALANCE_POLICY_EQUIVOCATION:version={requested}"),
            ));
        }
        Some(requested) => requested,
        None if previous_version == 0 => 1,
        None if fee_policy_changed => previous_version
            .checked_add(1)
            .ok_or_else(|| invalid("setHubConfig", "POLICY_VERSION_OVERFLOW"))?,
        None => previous_version,
    };
    let hub_name = optional_string(entries, "hubName", "setHubConfig")?
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .or_else(|| match previous_hub_field(previous, "hubName") {
            Some(CanonicalValue::String(name)) => Some(name.clone()),
            _ => None,
        });
    let matching_strategy = optional_string(entries, "matchingStrategy", "setHubConfig")?
        .filter(|value| value == "time" || value == "fee")
        .unwrap_or_else(|| "amount".into());
    let dispute_mode = optional_string(entries, "disputeAutoFinalizeMode", "setHubConfig")?
        .unwrap_or_else(|| "auto".into());
    if dispute_mode != "auto" && dispute_mode != "ignore" {
        return Err(invalid("setHubConfig", "disputeAutoFinalizeMode:LITERAL"));
    }
    let routing_fee = safe_u64(entries, "routingFeePPM", "setHubConfig", 1)?;
    let swap_fee = safe_u64(entries, "swapTakerFeeBps", "setHubConfig", 0)?.min(10_000);
    let timeout = safe_u64(
        entries,
        "rebalanceTimeoutMs",
        "setHubConfig",
        10 * 60 * 1_000,
    )?;
    let mut config = Vec::new();
    if let Some(name) = hub_name {
        config.push(("hubName".into(), CanonicalValue::String(name)));
    }
    config.extend([
        (
            "matchingStrategy".into(),
            CanonicalValue::String(matching_strategy.clone()),
        ),
        ("policyVersion".into(), number(policy_version)?),
        ("routingFeePPM".into(), number(routing_fee)?),
        (
            "baseFee".into(),
            CanonicalValue::BigInt(optional_bigint_field(entries, "baseFee", BigInt::from(0))?),
        ),
        ("swapTakerFeeBps".into(), number(swap_fee)?),
        (
            "disputeAutoFinalizeMode".into(),
            CanonicalValue::String(dispute_mode),
        ),
        (
            "minCollateralThreshold".into(),
            CanonicalValue::BigInt(optional_bigint_field(
                entries,
                "minCollateralThreshold",
                BigInt::from(0),
            )?),
        ),
        (
            "rebalanceLiquidityFeeBps".into(),
            CanonicalValue::BigInt(liquidity_fee.clone()),
        ),
        ("rebalanceTimeoutMs".into(), number(timeout)?),
    ]);
    state.hub_rebalance_config = Some(CanonicalValue::Object(config));
    state.profile.is_hub = true;
    events.push(EntityFrameEvent::Status {
        message: format!(
            "🏦 Hub config activated: {matching_strategy} strategy v{policy_version}, {routing_fee}ppm routing fee, swapTakerFee={swap_fee}bps, rebalance(base=token-default, liqBps={liquidity_fee}, gas=token-default, c2rWithdrawSoftLimit=token-default)"
        ),
    });
    Ok(())
}

fn control_board_proposal_hash(
    chain_id: U256,
    provider: [u8; 20],
    target_entity_id: [u8; 32],
    board_epoch: u64,
    new_board_hash: [u8; 32],
    action_nonce: U256,
) -> [u8; 32] {
    let domain: [u8; 32] = Keccak256::digest(b"XLN_ENTITY_PROVIDER_BOARD_PROPOSAL_V1").into();
    Keccak256::digest(ethabi::encode(&[
        Token::FixedBytes(domain.to_vec()),
        Token::Uint(chain_id),
        Token::Address(provider.into()),
        Token::FixedBytes(target_entity_id.to_vec()),
        Token::Uint(U256::from(board_epoch)),
        Token::FixedBytes(new_board_hash.to_vec()),
        Token::Uint(U256::from(1_u8)),
        Token::Uint(action_nonce),
    ]))
    .into()
}

fn apply_control_board_proposal(
    state: &EntityStateSlice,
    authority: &EntityFrameAuthority,
    tx: ControlBoardProposal,
    events: &mut Vec<EntityFrameEvent>,
) -> Result<LocalEntityControlResult, EntityKernelError> {
    let registry = state.certified_board_state.as_ref().ok_or_else(|| {
        invalid(
            "entityProviderProposeControlBoard",
            "CONTROL_BOARD_REGISTRY_MISSING",
        )
    })?;
    let shareholder = fixed_hex::<32>(
        &state.entity_id,
        "entityProviderProposeControlBoard",
        "entityId",
    )?;
    let target = registry.resolve(&tx.target_entity_id).ok_or_else(|| {
        invalid(
            "entityProviderProposeControlBoard",
            "CONTROL_BOARD_PROPOSAL_TARGET_AUTHORITY_MISSING",
        )
    })?;
    if registry.resolve(&shareholder).is_none() {
        return Err(invalid(
            "entityProviderProposeControlBoard",
            "CONTROL_BOARD_PROPOSAL_SHAREHOLDER_AUTHORITY_MISSING",
        ));
    }
    let chain_id = jurisdiction_chain_id(authority)?;
    let provider = fixed_hex::<20>(
        &jurisdiction_text(authority, "entityProviderAddress")?,
        "entityProviderProposeControlBoard",
        "entityProviderAddress",
    )?;
    let proposal_hash = control_board_proposal_hash(
        chain_id,
        provider,
        tx.target_entity_id,
        target.board_epoch,
        tx.new_board_hash,
        tx.action_nonce,
    );
    let mut seen = std::collections::BTreeSet::new();
    let mut votes = Vec::with_capacity(tx.supporter_votes.len() + 1);
    for supporter in tx.supporter_votes {
        if supporter.entity_id == shareholder || !seen.insert(supporter.entity_id) {
            return Err(invalid(
                "entityProviderProposeControlBoard",
                "CONTROL_BOARD_PROPOSAL_SUPPORTER_DUPLICATE",
            ));
        }
        let record = registry.resolve(&supporter.entity_id).ok_or_else(|| {
            invalid(
                "entityProviderProposeControlBoard",
                "CONTROL_BOARD_PROPOSAL_SUPPORTER_AUTHORITY_MISSING",
            )
        })?;
        let validates_board = |entity_id: &[u8; 32], board_hash: &[u8; 32], _: usize| {
            entity_id == &supporter.entity_id && board_hash == &record.board_hash
        };
        xln_rscore_hanko::verify_canonical_hanko(
            &supporter.hanko_signature,
            &proposal_hash,
            Some(&supporter.entity_id),
            Some(&validates_board),
        )
        .map_err(|error| {
            invalid(
                "entityProviderProposeControlBoard",
                format!("CONTROL_BOARD_PROPOSAL_SUPPORTER_HANKO_INVALID:{error}"),
            )
        })?;
        votes.push(crate::ControlBoardSupporterVote {
            entity_id: supporter.entity_id,
            hanko_signature: Some(supporter.hanko_signature),
        });
    }
    votes.push(crate::ControlBoardSupporterVote {
        entity_id: shareholder,
        hanko_signature: None,
    });
    votes.sort_unstable_by_key(|vote| vote.entity_id);
    let signer_id = authority.leader_state.active_validator_id.clone();
    if signer_id.is_empty() {
        return Err(invalid(
            "entityProviderProposeControlBoard",
            "CONTROL_BOARD_PROPOSAL_SUBMITTER_MISSING",
        ));
    }
    events.push(EntityFrameEvent::Status {
        message: format!(
            "🗳️ CONTROL vote {} → {}",
            &state.entity_id[state.entity_id.len().saturating_sub(4)..],
            &render_hex(&tx.target_entity_id)[62..]
        ),
    });
    let jurisdiction_name = jurisdiction_text(authority, "name")?;
    Ok(LocalEntityControlResult {
        j_outputs: vec![EntityJOutput::GovernanceIntent {
            jurisdiction_name,
            intent: crate::EntityProviderGovernanceIntent::ProposeControlBoard {
                shareholder_entity_id: shareholder,
                target_entity_id: tx.target_entity_id,
                new_board_hash: tx.new_board_hash,
                target_board_epoch: target.board_epoch,
                action_nonce: tx.action_nonce,
                proposal_hash,
                supporter_votes: votes,
                signer_id,
                timestamp: state.timestamp,
            },
        }],
        hashes_to_sign: vec![HashToSign {
            hash: render_hex(&proposal_hash),
            kind: HashType::EntityProviderAction,
            context: format!(
                "controlBoard:{}:nonce:{}",
                &render_hex(&tx.target_entity_id)[62..],
                tx.action_nonce
            ),
        }],
        approved_entity_txs: Vec::new(),
    })
}

fn apply_activate_board(
    state: &EntityStateSlice,
    authority: &EntityFrameAuthority,
    target_entity_id: [u8; 32],
    events: &mut Vec<EntityFrameEvent>,
) -> Result<LocalEntityControlResult, EntityKernelError> {
    let registry = state.certified_board_state.as_ref().ok_or_else(|| {
        invalid(
            "entityProviderActivateBoard",
            "CONTROL_BOARD_REGISTRY_MISSING",
        )
    })?;
    if registry.resolve(&target_entity_id).is_none() {
        return Err(invalid(
            "entityProviderActivateBoard",
            "CONTROL_BOARD_ACTIVATION_TARGET_MISSING",
        ));
    }
    let signer_id = authority.leader_state.active_validator_id.clone();
    if signer_id.is_empty() {
        return Err(invalid(
            "entityProviderActivateBoard",
            "CONTROL_BOARD_ACTIVATION_SUBMITTER_MISSING",
        ));
    }
    events.push(EntityFrameEvent::Status {
        message: format!("🔐 Activate board {}", &render_hex(&target_entity_id)[62..]),
    });
    Ok(LocalEntityControlResult {
        j_outputs: vec![EntityJOutput::GovernanceIntent {
            jurisdiction_name: jurisdiction_text(authority, "name")?,
            intent: crate::EntityProviderGovernanceIntent::ActivateBoard {
                entity_id: fixed_hex(&state.entity_id, "entityProviderActivateBoard", "entityId")?,
                target_entity_id,
                signer_id,
                timestamp: state.timestamp,
            },
        }],
        ..LocalEntityControlResult::default()
    })
}

fn j_batch_op_count(state: &JBatchState) -> usize {
    let batch = &state.batch;
    batch.flashloans.len()
        + batch.reserve_to_reserve.len()
        + batch.reserve_to_collateral.len()
        + batch.collateral_to_reserve.len()
        + batch.settlements.len()
        + batch.dispute_starts.len()
        + batch.counter_disputes.len()
        + batch.dispute_finalizations.len()
        + batch.external_token_to_reserve.len()
        + batch.reserve_to_external_token.len()
        + batch.reveal_secrets.len()
        + batch.hash_ladder_registrations.len()
}

pub(crate) fn queue_reserve_to_collateral(
    state: &mut EntityStateSlice,
    receiving_entity: [u8; 32],
    counterparty: [u8; 32],
    token_id: u64,
    amount: U256,
) -> Result<(), EntityKernelError> {
    let mut candidate = draft_batch_with_candidate(state, token_id, amount, "r2c")?;
    if receiving_entity == counterparty {
        return Err(invalid("r2c", "ACCOUNT_PARTIES_INVALID"));
    }
    if let Some(operation) = candidate
        .reserve_to_collateral
        .iter_mut()
        .find(|op| op.receiving_entity == receiving_entity && op.token_id == U256::from(token_id))
    {
        if let Some(pair) = operation
            .pairs
            .iter_mut()
            .find(|pair| pair.entity == counterparty)
        {
            pair.amount = pair
                .amount
                .checked_add(amount)
                .ok_or_else(|| invalid("r2c", "AMOUNT_OVERFLOW"))?;
        } else {
            operation.pairs.push(EntityAmount {
                entity: counterparty,
                amount,
            });
        }
    } else {
        candidate.reserve_to_collateral.push(ReserveToCollateral {
            token_id: U256::from(token_id),
            receiving_entity,
            pairs: vec![EntityAmount {
                entity: counterparty,
                amount,
            }],
        });
    }
    require_draft_reserves(state, &candidate, "r2c")?;
    let batch = state.j_batch_state.get_or_insert_with(JBatchState::default);
    batch.batch = candidate;
    batch.status = JBatchStatus::Accumulating;
    Ok(())
}

fn apply_e2r(
    state: &mut EntityStateSlice,
    tx: E2r,
    events: &mut Vec<EntityFrameEvent>,
) -> Result<(), EntityKernelError> {
    let entity = fixed_hex::<32>(&state.entity_id, "e2r", "entityId")?;
    let batch = state.j_batch_state.get_or_insert_with(JBatchState::default);
    if j_batch_op_count(batch) >= 50 {
        return Err(invalid(
            "e2r",
            "J_BATCH_LIMIT_EXCEEDED:externalTokenToReserve:51/50",
        ));
    }
    batch
        .batch
        .external_token_to_reserve
        .push(ExternalTokenToReserve {
            entity,
            contract_address: tx.contract_address,
            external_token_id: tx.external_token_id,
            token_type: tx.token_type,
            internal_token_id: tx.internal_token_id,
            amount: tx.amount,
        });
    if batch.status == JBatchStatus::Empty {
        batch.status = JBatchStatus::Accumulating;
    }
    let amount = batch
        .batch
        .external_token_to_reserve
        .last()
        .expect("just appended")
        .amount;
    events.push(EntityFrameEvent::Status {
        message: format!(
            "📦 Queued E→R: {amount} via {}... (use j_broadcast to commit)",
            &tx.contract_text[..10]
        ),
    });
    Ok(())
}

pub(crate) fn batch_empty(batch: &JBatch) -> bool {
    crate::j_batch::batch_is_empty(batch)
}

/// Exact TS `takeBroadcastBatch`: public hash-ladder evidence must land before
/// a finalization that reads it, and adversarial finalizers are sent FIFO one
/// at a time so one processBatch stays below the L1 block gas limit.
fn take_broadcast_batch(source: &JBatch) -> (JBatch, JBatch) {
    let dispute_priority = has_dispute_priority(source);
    if !dispute_priority {
        return (source.clone(), JBatch::default());
    }
    let mut selected = JBatch::default();
    let mut remainder = source.clone();
    selected.dispute_starts = std::mem::take(&mut remainder.dispute_starts);
    selected.counter_disputes = std::mem::take(&mut remainder.counter_disputes);
    selected.reveal_secrets = std::mem::take(&mut remainder.reveal_secrets);
    if !source.hash_ladder_registrations.is_empty() {
        selected.hash_ladder_registrations =
            std::mem::take(&mut remainder.hash_ladder_registrations);
    } else if !remainder.dispute_finalizations.is_empty() {
        selected
            .dispute_finalizations
            .push(remainder.dispute_finalizations.remove(0));
    }
    (selected, remainder)
}

fn has_dispute_priority(source: &JBatch) -> bool {
    !source.dispute_starts.is_empty()
        || !source.counter_disputes.is_empty()
        || !source.dispute_finalizations.is_empty()
}

pub(crate) fn has_queued_batch_work(state: &JBatchState) -> bool {
    !batch_empty(&state.batch)
        || state
            .recovery_batches
            .iter()
            .any(|batch| !batch_empty(batch))
}

fn draft_batch_with_candidate(
    state: &EntityStateSlice,
    token_id: u64,
    amount: U256,
    kind: &'static str,
) -> Result<JBatch, EntityKernelError> {
    if token_id == 0 || token_id > u64::from(u16::MAX) || amount.is_zero() {
        return Err(invalid(kind, "TOKEN_OR_AMOUNT_INVALID"));
    }
    Ok(state
        .j_batch_state
        .as_ref()
        .map(|state| state.batch.clone())
        .unwrap_or_default())
}

fn require_draft_reserves(
    state: &EntityStateSlice,
    batch: &JBatch,
    kind: &'static str,
) -> Result<(), EntityKernelError> {
    let entity_id = fixed_hex(&state.entity_id, kind, "entityId")?;
    let simulation = crate::j_batch::simulate_draft_batch_reserve_availability(
        entity_id,
        &state.reserves,
        batch,
        state.out_debts_by_token.as_ref(),
    )?;
    if simulation.issues.is_empty() {
        Ok(())
    } else {
        Err(invalid(kind, "INSUFFICIENT_RESERVE"))
    }
}

fn depository_hash(chain_id: u64, address: [u8; 20], encoded: &[u8], nonce: u64) -> [u8; 32] {
    let domain: [u8; 32] = Keccak256::digest(b"XLN_DEPOSITORY_HANKO_V1").into();
    let mut chain = [0_u8; 32];
    U256::from(chain_id).to_big_endian(&mut chain);
    let mut nonce_word = [0_u8; 32];
    U256::from(nonce).to_big_endian(&mut nonce_word);
    let mut digest = Keccak256::new();
    digest.update(domain);
    digest.update(chain);
    digest.update(address);
    digest.update(encoded);
    digest.update(nonce_word);
    digest.finalize().into()
}

fn broadcast(
    state: &mut EntityStateSlice,
    fees: Option<JBatchFeeOverrides>,
    rebroadcast: bool,
    authority: &EntityFrameAuthority,
    events: &mut Vec<EntityFrameEvent>,
) -> Result<LocalEntityControlResult, EntityKernelError> {
    let owner = state.entity_id.clone();
    let timestamp = state.timestamp;
    let jurisdiction_name = authority_jurisdiction_text(authority, "j_broadcast", "name")?;
    let chain_id = authority_jurisdiction_chain_id(authority, "j_broadcast")?;
    if chain_id > U256::from(u64::MAX) {
        return Err(invalid("j_broadcast", "CHAIN_ID_INVALID"));
    }
    let chain_id = chain_id.low_u64();
    let depository = fixed_hex::<20>(
        &authority_jurisdiction_text(authority, "j_broadcast", "depositoryAddress")?,
        "j_broadcast",
        "depositoryAddress",
    )?;
    let batch_state = state
        .j_batch_state
        .as_mut()
        .ok_or_else(|| invalid("j_broadcast", "J_BATCH_MISSING"))?;
    let (batch, remainder, from_recovery, nonce, dispute_priority) = if rebroadcast {
        let sent = batch_state
            .sent_batch
            .as_ref()
            .ok_or_else(|| invalid("j_rebroadcast", "SENT_BATCH_MISSING"))?;
        if sent.terminal_failure.is_some() {
            return Err(invalid("j_rebroadcast", "TERMINAL_FAILURE"));
        }
        (
            sent.batch.clone(),
            JBatch::default(),
            false,
            sent.entity_nonce,
            false,
        )
    } else {
        if batch_state.sent_batch.is_some() {
            return Err(invalid("j_broadcast", "SENT_BATCH_PENDING"));
        }
        let from_recovery = batch_state
            .recovery_batches
            .first()
            .is_some_and(|batch| !batch_empty(batch));
        let source = if from_recovery {
            batch_state.recovery_batches[0].clone()
        } else {
            batch_state.batch.clone()
        };
        if batch_empty(&source) {
            return Ok(LocalEntityControlResult::default());
        }
        let dispute_priority = has_dispute_priority(&source);
        let (selected, remainder) = take_broadcast_batch(&source);
        (
            selected,
            remainder,
            from_recovery,
            batch_state
                .entity_nonce
                .unwrap_or(0)
                .checked_add(1)
                .ok_or_else(|| invalid("j_broadcast", "NONCE_OVERFLOW"))?,
            dispute_priority,
        )
    };
    if batch_empty(&batch) {
        return Ok(LocalEntityControlResult::default());
    }
    let encoded =
        crate::encode_j_batch(&batch).map_err(|error| invalid("j_broadcast", error.to_string()))?;
    let hash = depository_hash(chain_id, depository, &encoded, nonce);
    let generation = batch_state
        .broadcast_count
        .checked_add(1)
        .ok_or_else(|| invalid("j_broadcast", "GENERATION_OVERFLOW"))?;
    let op_count = crate::j_batch::batch_op_count(&batch);
    let override_present = fees.is_some();
    let applied_fees = fees.or_else(|| {
        batch_state
            .sent_batch
            .as_ref()
            .and_then(|sent| sent.fee_overrides.clone())
    });
    if rebroadcast {
        let sent = batch_state
            .sent_batch
            .as_mut()
            .expect("validated sent batch");
        sent.batch = batch;
        sent.batch_hash = hash;
        sent.encoded_batch = encoded;
        if override_present {
            sent.fee_overrides = applied_fees.clone();
        }
    } else {
        batch_state.sent_batch = Some(SentJBatch {
            batch,
            batch_hash: hash,
            encoded_batch: encoded,
            entity_nonce: nonce,
            first_submitted_at: timestamp,
            last_submitted_at: 0,
            submit_attempts: 0,
            fee_overrides: applied_fees.clone(),
            transaction_hash: None,
            last_failure: None,
            terminal_failure: None,
        });
        if from_recovery {
            if batch_empty(&remainder) {
                batch_state.recovery_batches.remove(0);
            } else {
                batch_state.recovery_batches[0] = remainder;
            }
        } else {
            batch_state.batch = remainder;
        }
        batch_state.auto_broadcast_draft = has_queued_batch_work(batch_state);
    }
    batch_state.last_broadcast = timestamp;
    batch_state.broadcast_count = generation;
    batch_state.status = JBatchStatus::Sent;
    if !rebroadcast {
        events.push(EntityFrameEvent::Status {
            message: format!("📤 Batch ({op_count} ops) → hashesToSign [nonce={nonce}]"),
        });
        if dispute_priority {
            events.push(EntityFrameEvent::Status {
                message: "⚖️ Dispute operations broadcast before ordinary queued operations".into(),
            });
        }
    }
    Ok(LocalEntityControlResult {
        j_outputs: vec![EntityJOutput::BatchIntent {
            jurisdiction_name,
            batch_hash: hash,
            entity_nonce: nonce,
            batch_generation: generation,
            fee_overrides: applied_fees,
        }],
        hashes_to_sign: vec![HashToSign {
            hash: render_hex(&hash),
            kind: HashType::JBatch,
            context: format!(
                "jBatch:{}:nonce:{nonce}{}",
                &owner[owner.len().saturating_sub(4)..],
                if rebroadcast { ":rebroadcast" } else { "" }
            ),
        }],
        approved_entity_txs: Vec::new(),
    })
}

fn governance_authority(
    authority: &EntityFrameAuthority,
) -> Result<EntityFrameAuthority, EntityKernelError> {
    authority
        .validate_and_normalize()
        .map_err(|error| invalid("proposal", error.to_string()))
}

fn execute_proposal(
    proposal: &EntityProposal,
    events: &mut Vec<EntityFrameEvent>,
) -> Result<Vec<LocalEntityTx>, EntityKernelError> {
    if let Some(message) = crate::proposal::collective_message(&proposal.action)? {
        events.push(EntityFrameEvent::Status {
            message: format!("[COLLECTIVE] {message}"),
        });
        return Ok(Vec::new());
    }
    crate::proposal::decode_approved_entity_txs(&proposal.action)
}

fn apply_propose(
    state: &mut EntityStateSlice,
    tx: EntityPropose,
    authority: &EntityFrameAuthority,
    events: &mut Vec<EntityFrameEvent>,
) -> Result<Vec<LocalEntityTx>, EntityKernelError> {
    let authority = governance_authority(authority)?;
    let proposer = tx.proposer.trim().to_ascii_lowercase();
    let proposer_power = authority
        .config
        .shares
        .get(&proposer)
        .copied()
        .ok_or_else(|| {
            invalid(
                "proposal",
                format!("ENTITY_PROPOSAL_PROPOSER_UNKNOWN:{proposer}"),
            )
        })?;
    if state.proposals.len() >= 100 {
        return Err(invalid(
            "proposal",
            format!(
                "ENTITY_PROPOSAL_PENDING_LIMIT_EXCEEDED:{}:100",
                state.proposals.len()
            ),
        ));
    }
    if let Some(existing) = state
        .proposals
        .values()
        .find(|proposal| proposal.proposer == proposer)
    {
        return Err(invalid(
            "proposal",
            format!(
                "ENTITY_PROPOSAL_PROPOSER_PENDING_LIMIT:{proposer}:{}",
                existing.id
            ),
        ));
    }
    let action_hash = crate::hash_entity_proposal_action(&tx.action)?;
    let id = crate::generate_entity_proposal_id(
        &action_hash,
        &proposer,
        &tx.board_hash,
        tx.board_epoch,
        &tx.command_nonce,
    )?;
    if state.proposals.contains_key(&id) {
        return Err(invalid(
            "proposal",
            format!("ENTITY_PROPOSAL_DUPLICATE:{id}"),
        ));
    }
    let proposal = EntityProposal {
        id: id.clone(),
        proposer: proposer.clone(),
        board_hash: tx.board_hash,
        board_epoch: tx.board_epoch,
        action: tx.action,
        action_hash,
        votes: std::collections::BTreeMap::from([(
            proposer,
            EntityProposalVote {
                choice: crate::EntityVoteChoice::Yes,
                comment: None,
            },
        )]),
        created: state.timestamp,
    };
    if proposer_power >= authority.config.threshold {
        execute_proposal(&proposal, events)
    } else {
        state.proposals.insert(id, proposal);
        Ok(Vec::new())
    }
}

fn apply_vote(
    state: &mut EntityStateSlice,
    tx: EntityVote,
    authority: &EntityFrameAuthority,
    events: &mut Vec<EntityFrameEvent>,
) -> Result<Vec<LocalEntityTx>, EntityKernelError> {
    let authority = governance_authority(authority)?;
    let voter = tx.voter.trim().to_ascii_lowercase();
    if !authority.config.shares.contains_key(&voter) {
        return Err(invalid(
            "vote",
            format!("ENTITY_PROPOSAL_VOTER_UNKNOWN:{voter}"),
        ));
    }
    let proposal = state
        .proposals
        .get(&tx.proposal_id)
        .cloned()
        .ok_or_else(|| {
            invalid(
                "vote",
                format!("ENTITY_PROPOSAL_VOTE_TARGET_MISSING:{}", tx.proposal_id),
            )
        })?;
    if proposal.board_hash != tx.board_hash {
        return Err(invalid(
            "vote",
            format!(
                "ENTITY_PROPOSAL_BOARD_MISMATCH:{}:{}:{}",
                tx.proposal_id, proposal.board_hash, tx.board_hash
            ),
        ));
    }
    if proposal.board_epoch != tx.board_epoch {
        return Err(invalid(
            "vote",
            format!(
                "ENTITY_PROPOSAL_EPOCH_MISMATCH:{}:{}:{}",
                tx.proposal_id, proposal.board_epoch, tx.board_epoch
            ),
        ));
    }
    if proposal.votes.contains_key(&voter) {
        return Err(invalid(
            "vote",
            format!("ENTITY_PROPOSAL_DUPLICATE_VOTE:{}:{voter}", tx.proposal_id),
        ));
    }
    let mut updated = proposal;
    updated.votes.insert(
        voter,
        EntityProposalVote {
            choice: tx.choice,
            comment: tx.comment,
        },
    );
    let vote_power = |choice| {
        updated
            .votes
            .iter()
            .filter(|(_, vote)| vote.choice == choice)
            .map(|(signer, _)| {
                u64::from(
                    *authority
                        .config
                        .shares
                        .get(signer)
                        .expect("validated voter"),
                )
            })
            .sum::<u64>()
    };
    let yes = vote_power(crate::EntityVoteChoice::Yes);
    let no = vote_power(crate::EntityVoteChoice::No);
    let total = authority
        .config
        .shares
        .values()
        .map(|value| u64::from(*value))
        .sum::<u64>();
    let threshold = u64::from(authority.config.threshold);
    if yes >= threshold {
        state.proposals.remove(&tx.proposal_id);
        return execute_proposal(&updated, events);
    }
    if no > total - threshold {
        state.proposals.remove(&tx.proposal_id);
        return Ok(Vec::new());
    }
    state.proposals.insert(tx.proposal_id, updated);
    Ok(Vec::new())
}

fn authority_jurisdiction_value<'a>(
    authority: &'a EntityFrameAuthority,
    operation: &'static str,
    name: &'static str,
) -> Result<&'a CanonicalValue, EntityKernelError> {
    let value = authority
        .config
        .jurisdiction
        .as_ref()
        .ok_or_else(|| invalid(operation, "JURISDICTION_MISSING"))?;
    let fields = object(value, operation, "jurisdiction")?;
    field(fields, name)
        .ok_or_else(|| invalid(operation, format!("JURISDICTION_FIELD_MISSING:{name}")))
}

fn authority_jurisdiction_text(
    authority: &EntityFrameAuthority,
    operation: &'static str,
    name: &'static str,
) -> Result<String, EntityKernelError> {
    match authority_jurisdiction_value(authority, operation, name)? {
        CanonicalValue::String(value) if !value.trim().is_empty() => Ok(value.clone()),
        _ => Err(invalid(
            operation,
            format!("JURISDICTION_FIELD_INVALID:{name}"),
        )),
    }
}

fn authority_jurisdiction_chain_id(
    authority: &EntityFrameAuthority,
    operation: &'static str,
) -> Result<U256, EntityKernelError> {
    let value = authority_jurisdiction_value(authority, operation, "chainId")?;
    let parsed = match value {
        CanonicalValue::Number(value) => U256::from_dec_str(value.as_str())
            .map_err(|_| invalid(operation, "CHAIN_ID_INVALID"))?,
        CanonicalValue::BigInt(value) if value.sign() != Sign::Minus => {
            let (_, bytes) = value.to_bytes_be();
            if bytes.len() > 32 {
                return Err(invalid(operation, "CHAIN_ID_INVALID"));
            }
            U256::from_big_endian(&bytes)
        }
        _ => {
            return Err(invalid(operation, "CHAIN_ID_INVALID"));
        }
    };
    if parsed.is_zero() {
        return Err(invalid(operation, "CHAIN_ID_INVALID"));
    }
    Ok(parsed)
}

fn jurisdiction_text(
    authority: &EntityFrameAuthority,
    name: &'static str,
) -> Result<String, EntityKernelError> {
    authority_jurisdiction_text(authority, "entityProviderAction", name)
}

fn jurisdiction_chain_id(authority: &EntityFrameAuthority) -> Result<U256, EntityKernelError> {
    authority_jurisdiction_chain_id(authority, "entityProviderAction")
}

fn entity_number(entity_id: &str) -> Result<U256, EntityKernelError> {
    let bytes = fixed_hex::<32>(entity_id, "entityProviderAction", "entityId")?;
    let value = U256::from_big_endian(&bytes);
    if value.is_zero() {
        return Err(invalid(
            "entityProviderAction",
            "ENTITY_PROVIDER_ACTION_ENTITY_NUMBER_INVALID",
        ));
    }
    Ok(value)
}

fn next_provider_intent(
    state: &EntityStateSlice,
    authority: &EntityFrameAuthority,
    board_epoch: u64,
    payload: crate::EntityProviderActionPayload,
) -> Result<(crate::EntityProviderActionState, String), EntityKernelError> {
    crate::provider_action::validate_provider_payload(&payload)?;
    let current = state
        .entity_provider_action_state
        .clone()
        .unwrap_or_default();
    if current.pending.is_some() {
        return Err(invalid(
            "entityProviderAction",
            "ENTITY_PROVIDER_ACTION_PENDING",
        ));
    }
    let action_nonce = current
        .confirmed_nonce
        .checked_add(U256::one())
        .ok_or_else(|| {
            invalid(
                "entityProviderAction",
                "ENTITY_PROVIDER_ACTION_NONCE_EXHAUSTED",
            )
        })?;
    let generation = current
        .generation
        .checked_add(1)
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or_else(|| {
            invalid(
                "entityProviderAction",
                "ENTITY_PROVIDER_ACTION_GENERATION_EXHAUSTED",
            )
        })?;
    let provider_text = jurisdiction_text(authority, "entityProviderAddress")?;
    let provider = fixed_hex(
        &provider_text,
        "entityProviderAction",
        "entityProviderAddress",
    )?;
    let _depository = fixed_hex::<20>(
        &jurisdiction_text(authority, "depositoryAddress")?,
        "entityProviderAction",
        "depositoryAddress",
    )?;
    let mut intent = crate::EntityProviderActionIntent {
        entity_id: state.entity_id.clone(),
        entity_number: entity_number(&state.entity_id)?,
        chain_id: jurisdiction_chain_id(authority)?,
        entity_provider_address: provider,
        board_epoch: U256::from(board_epoch),
        action_nonce,
        action_hash: [0_u8; 32],
        generation,
        created_at: state.timestamp,
        payload,
    };
    intent.action_hash = crate::hash_entity_provider_action(&intent);
    Ok((
        crate::EntityProviderActionState {
            confirmed_nonce: current.confirmed_nonce,
            generation,
            pending: Some(intent),
        },
        jurisdiction_text(authority, "name")?,
    ))
}

fn apply_provider_action(
    state: &mut EntityStateSlice,
    authority: &EntityFrameAuthority,
    board_epoch: u64,
    payload: crate::EntityProviderActionPayload,
    events: &mut Vec<EntityFrameEvent>,
) -> Result<LocalEntityControlResult, EntityKernelError> {
    let (next, jurisdiction_name) = next_provider_intent(state, authority, board_epoch, payload)?;
    let intent = next
        .pending
        .clone()
        .expect("new provider action is pending");
    let signer_id = authority.leader_state.active_validator_id.clone();
    if signer_id.is_empty() {
        return Err(invalid(
            "entityProviderAction",
            "ENTITY_PROVIDER_ACTION_SUBMITTER_MISSING",
        ));
    }
    let cancel = matches!(
        &intent.payload,
        crate::EntityProviderActionPayload::Cancel { .. }
    );
    events.push(EntityFrameEvent::Status {
        message: if cancel {
            format!(
                "🛑 EntityProvider cancel → hashesToSign [nonce={}]",
                intent.action_nonce
            )
        } else {
            format!(
                "📤 EntityProvider {} → hashesToSign [nonce={}]",
                intent.payload.kind(),
                intent.action_nonce
            )
        },
    });
    let action_hash = render_hex(&intent.action_hash);
    let context = format!(
        "entityProviderAction:{}:{}:nonce:{}",
        &state.entity_id[state.entity_id.len().saturating_sub(4)..],
        if cancel {
            "cancel"
        } else {
            intent.payload.kind()
        },
        intent.action_nonce
    );
    state.entity_provider_action_state = Some(next);
    Ok(LocalEntityControlResult {
        j_outputs: vec![EntityJOutput::EntityProviderActionIntent {
            jurisdiction_name,
            intent,
            signer_id,
        }],
        hashes_to_sign: vec![HashToSign {
            hash: action_hash,
            kind: HashType::EntityProviderAction,
            context,
        }],
        approved_entity_txs: Vec::new(),
    })
}

fn apply_provider_cancel(
    state: &mut EntityStateSlice,
    authority: &EntityFrameAuthority,
    board_epoch: u64,
    requested_hash: [u8; 32],
    events: &mut Vec<EntityFrameEvent>,
) -> Result<LocalEntityControlResult, EntityKernelError> {
    let current = state.entity_provider_action_state.clone().ok_or_else(|| {
        invalid(
            "entityProviderAction",
            "ENTITY_PROVIDER_ACTION_CANCEL_PENDING_MISSING",
        )
    })?;
    let pending = current.pending.as_ref().ok_or_else(|| {
        invalid(
            "entityProviderAction",
            "ENTITY_PROVIDER_ACTION_CANCEL_PENDING_MISSING",
        )
    })?;
    if pending.action_hash != requested_hash {
        return Err(invalid(
            "entityProviderAction",
            format!(
                "ENTITY_PROVIDER_ACTION_CANCEL_TARGET_MISMATCH:{}:{}",
                render_hex(&requested_hash),
                render_hex(&pending.action_hash)
            ),
        ));
    }
    let cancelled_kind = pending.payload.executable_kind_code().ok_or_else(|| {
        invalid(
            "entityProviderAction",
            "ENTITY_PROVIDER_ACTION_CANCEL_ALREADY_PENDING",
        )
    })?;
    let mut base = current;
    base.pending = None;
    state.entity_provider_action_state = Some(base);
    apply_provider_action(
        state,
        authority,
        board_epoch,
        crate::EntityProviderActionPayload::Cancel {
            cancelled_action_hash: requested_hash,
            cancelled_action_kind: cancelled_kind,
        },
        events,
    )
}

pub fn apply_local_entity_control_tx(
    state: &mut EntityStateSlice,
    tx: LocalEntityControlTx,
    events: &mut Vec<EntityFrameEvent>,
    authority: &EntityFrameAuthority,
    board_epoch: u64,
) -> Result<LocalEntityControlResult, EntityKernelError> {
    let mut result = LocalEntityControlResult::default();
    match tx {
        LocalEntityControlTx::Chat { from, message } => {
            if message.is_empty() || message.encode_utf16().count() > 1_000 {
                // Canonical TS treats an invalid user chat as an applied tx
                // with no event. Admission still commits the tx itself.
                return Ok(result);
            }
            events.push(EntityFrameEvent::Text {
                validator_id: from.trim().to_lowercase(),
                message,
            });
        }
        LocalEntityControlTx::ChatMessage { message } => {
            events.push(EntityFrameEvent::Status { message });
        }
        LocalEntityControlTx::ProfileUpdate(update) => apply_profile(state, update)?,
        LocalEntityControlTx::E2r(tx) => apply_e2r(state, tx, events)?,
        LocalEntityControlTx::Propose(tx) => {
            result.approved_entity_txs = apply_propose(state, tx, authority, events)?;
        }
        LocalEntityControlTx::Vote(tx) => {
            result.approved_entity_txs = apply_vote(state, tx, authority, events)?;
        }
        LocalEntityControlTx::R2r {
            receiving_entity,
            token_id,
            amount,
        } => {
            let mut candidate = draft_batch_with_candidate(state, token_id, amount, "r2r")?;
            candidate.reserve_to_reserve.push(ReserveToReserve {
                receiving_entity,
                token_id: U256::from(token_id),
                amount,
            });
            require_draft_reserves(state, &candidate, "r2r")?;
            let batch = state.j_batch_state.get_or_insert_with(JBatchState::default);
            batch.batch = candidate;
            batch.status = JBatchStatus::Accumulating;
            events.push(EntityFrameEvent::Status {
                message: format!(
                    "📦 Queued R→R: {amount} token {token_id} to {} (use jBroadcast to commit)",
                    &render_hex(&receiving_entity)[62..]
                ),
            });
        }
        LocalEntityControlTx::R2e {
            receiving_entity,
            token_id,
            amount,
        } => {
            let mut candidate = draft_batch_with_candidate(state, token_id, amount, "r2e")?;
            candidate
                .reserve_to_external_token
                .push(ReserveToExternalToken {
                    receiving_entity,
                    token_id: U256::from(token_id),
                    amount,
                });
            require_draft_reserves(state, &candidate, "r2e")?;
            let batch = state.j_batch_state.get_or_insert_with(JBatchState::default);
            batch.batch = candidate;
            batch.status = JBatchStatus::Accumulating;
            events.push(EntityFrameEvent::Status {
                message: format!(
                    "📦 Queued R→E: {amount} token {token_id} to {} (use jBroadcast to commit)",
                    &render_hex(&receiving_entity)[58..]
                ),
            });
        }
        LocalEntityControlTx::R2c {
            receiving_entity,
            counterparty,
            token_id,
            amount,
        } => {
            let receiving_entity =
                receiving_entity.unwrap_or(fixed_hex(&state.entity_id, "r2c", "entityId")?);
            queue_reserve_to_collateral(state, receiving_entity, counterparty, token_id, amount)?;
            events.push(EntityFrameEvent::Status {
                message: format!(
                    "📦 Queued R→C: {amount} token {token_id} to {}↔{} (use j_broadcast to commit)",
                    &render_hex(&receiving_entity)[62..],
                    &render_hex(&counterparty)[62..]
                ),
            });
        }
        LocalEntityControlTx::JBroadcast { fee_overrides } => {
            result = broadcast(state, fee_overrides, false, authority, events)?
        }
        LocalEntityControlTx::JRebroadcast { gas_bump_bps } => {
            if state
                .j_batch_state
                .as_ref()
                .and_then(|batch| batch.sent_batch.as_ref())
                .is_none()
            {
                events.push(EntityFrameEvent::Status {
                    message: "⚠️ j_rebroadcast skipped: no sentBatch".into(),
                });
                return Ok(result);
            }
            result = broadcast(
                state,
                Some(JBatchFeeOverrides {
                    gas_bump_bps,
                    ..JBatchFeeOverrides::default()
                }),
                true,
                authority,
                events,
            )?
        }
        LocalEntityControlTx::JAbortSentBatch {
            reason: _,
            requeue_to_current,
        } => {
            let batch = state.j_batch_state.as_mut().or_else(|| {
                events.push(EntityFrameEvent::Status {
                    message: "⚠️ No sentBatch to abort".into(),
                });
                None
            });
            let Some(batch) = batch else {
                return Ok(result);
            };
            let Some(sent) = batch.sent_batch.take() else {
                events.push(EntityFrameEvent::Status {
                    message: "⚠️ No sentBatch to abort".into(),
                });
                return Ok(result);
            };
            if requeue_to_current {
                let mut recovered = sent.batch;
                recovered.dispute_finalizations.clear();
                if !batch_empty(&recovered) {
                    batch.recovery_batches.insert(0, recovered);
                }
            }
            batch.status =
                if batch_empty(&batch.batch) && batch.recovery_batches.iter().all(batch_empty) {
                    JBatchStatus::Empty
                } else {
                    JBatchStatus::Accumulating
                };
        }
        LocalEntityControlTx::JClearBatch { reason: _ } => {
            let batch = state.j_batch_state.as_mut().or_else(|| {
                events.push(EntityFrameEvent::Status {
                    message: "⚠️ No jBatchState to clear".into(),
                });
                None
            });
            let Some(batch) = batch else {
                return Ok(result);
            };
            batch.batch = JBatch::default();
            batch.sent_batch = None;
            batch.recovery_batches.clear();
            batch.status = JBatchStatus::Empty;
        }
        LocalEntityControlTx::MintReserves { token_id, amount } => {
            events.push(EntityFrameEvent::Status {
                message: format!("💰 Minting {amount} of token {token_id}"),
            });
            result.j_outputs.push(EntityJOutput::MintReserves {
                jurisdiction_name: authority_jurisdiction_text(authority, "mintReserves", "name")?,
                entity_id: fixed_hex(&state.entity_id, "mintReserves", "entityId")?,
                token_id,
                amount,
                timestamp: state.timestamp,
            });
        }
        LocalEntityControlTx::EntityProviderTransfer {
            to,
            token_id,
            amount,
        } => {
            result = apply_provider_action(
                state,
                authority,
                board_epoch,
                crate::EntityProviderActionPayload::Transfer {
                    to,
                    token_id,
                    amount,
                },
                events,
            )?;
        }
        LocalEntityControlTx::EntityProviderReleaseControlShares {
            recipient,
            control_amount,
            dividend_amount,
            purpose,
        } => {
            result = apply_provider_action(
                state,
                authority,
                board_epoch,
                crate::EntityProviderActionPayload::ReleaseControlShares {
                    recipient,
                    control_amount,
                    dividend_amount,
                    purpose,
                },
                events,
            )?;
        }
        LocalEntityControlTx::EntityProviderCancelAction { action_hash } => {
            result = apply_provider_cancel(state, authority, board_epoch, action_hash, events)?;
        }
        LocalEntityControlTx::EntityProviderProposeControlBoard(tx) => {
            result = apply_control_board_proposal(state, authority, tx, events)?;
        }
        LocalEntityControlTx::EntityProviderActivateBoard { target_entity_id } => {
            result = apply_activate_board(state, authority, target_entity_id, events)?;
        }
        LocalEntityControlTx::InitOrderbookExt(mut profile) => {
            if state.orderbook.is_none() {
                let spread = &profile.spread_distribution;
                let total = u64::from(spread.maker_bps)
                    + u64::from(spread.taker_bps)
                    + u64::from(spread.hub_bps)
                    + u64::from(spread.maker_referrer_bps)
                    + u64::from(spread.taker_referrer_bps);
                if total == 10_000 {
                    profile.entity_id = state.entity_id.clone();
                    state.orderbook = Some(OrderbookState::empty(10_000));
                    state.orderbook_metadata = Some(OrderbookConsensusMetadata {
                        hub_profile: profile,
                        referrals: Default::default(),
                    });
                }
            }
        }
        LocalEntityControlTx::SetHubConfig(data) => {
            apply_set_hub_config(state, data, events)?;
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn final_dispute(counterentity: u8, nonce: u64) -> crate::j_batch::FinalDisputeProof {
        crate::j_batch::FinalDisputeProof {
            counterentity: [counterentity; 32],
            initial_nonce: U256::from(nonce),
            final_nonce: U256::from(nonce + 1),
            proposer_is_left: true,
            initial_proofbody_hash: [0x44; 32],
            final_proofbody: crate::j_batch::ProofBody {
                watch_seed: [0x55; 32],
                left_response_seconds: 1,
                right_response_seconds: 1,
                offdeltas: Vec::new(),
                token_ids: Vec::new(),
                transformers: Vec::new(),
            },
            starter_arguments: Vec::new(),
            other_arguments: Vec::new(),
            sig: vec![0x66; 65],
            started_by_left: true,
            cooperative: false,
            submit_not_before_timestamp: None,
        }
    }

    fn authority() -> EntityFrameAuthority {
        EntityFrameAuthority {
            config: crate::EntityConsensusConfig {
                mode: crate::ConsensusMode::ProposerBased,
                threshold: 1,
                validators: vec!["validator".into()],
                shares: std::collections::BTreeMap::from([("validator".into(), 1)]),
                jurisdiction: None,
            },
            leader_state: crate::EntityLeaderState {
                active_validator_id: "validator".into(),
                view: 0,
                changed_at_height: 0,
            },
        }
    }

    fn provider_authority() -> EntityFrameAuthority {
        let mut authority = authority();
        authority.config.jurisdiction = Some(object(vec![
            ("name", CanonicalValue::String("test".into())),
            (
                "chainId",
                CanonicalValue::Number(
                    xln_rscore_protocol::CanonicalNumber::try_from_u64(31_337).expect("safe chain"),
                ),
            ),
            (
                "entityProviderAddress",
                CanonicalValue::String(format!("0x{}", "22".repeat(20))),
            ),
            (
                "depositoryAddress",
                CanonicalValue::String(format!("0x{}", "44".repeat(20))),
            ),
        ]));
        authority
    }

    fn quorum_authority() -> EntityFrameAuthority {
        EntityFrameAuthority {
            config: crate::EntityConsensusConfig {
                mode: crate::ConsensusMode::ProposerBased,
                threshold: 2,
                validators: vec!["alice".into(), "bob".into()],
                shares: std::collections::BTreeMap::from([("alice".into(), 1), ("bob".into(), 1)]),
                jurisdiction: None,
            },
            leader_state: crate::EntityLeaderState {
                active_validator_id: "alice".into(),
                view: 0,
                changed_at_height: 0,
            },
        }
    }

    fn object(entries: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
        CanonicalValue::Object(
            entries
                .into_iter()
                .map(|(key, value)| (key.to_string(), value))
                .collect(),
        )
    }

    #[test]
    fn profile_update_matches_canonical_presence_rules() {
        let entity = format!("0x{}", "11".repeat(32));
        let tx = CanonicalEntityTx::from_frame_projection(
            EntityTxKind::ProfileUpdate,
            object(vec![(
                "profile",
                object(vec![
                    ("entityId", CanonicalValue::String(entity.clone())),
                    ("name", CanonicalValue::String("  Example  ".into())),
                    (
                        "sectors",
                        CanonicalValue::Array(vec![CanonicalValue::String("finance".into())]),
                    ),
                ]),
            )]),
        )
        .expect("tx");
        let native = decode_local_entity_control_tx(&tx)
            .expect("decode")
            .expect("control");
        let mut state = EntityStateSlice::empty(entity, 1);
        apply_local_entity_control_tx(&mut state, native, &mut Vec::new(), &authority(), 0)
            .expect("apply");
        assert_eq!(state.profile.name, "Example");
        assert_eq!(state.profile.sectors, ["finance"]);
    }

    #[test]
    fn init_orderbook_ext_installs_the_canonical_empty_book_once() {
        let entity = format!("0x{}", "11".repeat(32));
        let quote_authority = format!("0x{}", "22".repeat(32));
        let number =
            |value| CanonicalValue::Number(xln_rscore_protocol::CanonicalNumber::from_u32(value));
        let tx = CanonicalEntityTx::from_frame_projection(
            EntityTxKind::InitOrderbookExt,
            object(vec![
                ("name", CanonicalValue::String("H1".into())),
                (
                    "spreadDistribution",
                    object(vec![
                        ("makerBps", number(0)),
                        ("takerBps", number(10_000)),
                        ("hubBps", number(0)),
                        ("makerReferrerBps", number(0)),
                        ("takerReferrerBps", number(0)),
                    ]),
                ),
                ("referenceTokenId", number(1)),
                (
                    "usdQuoteAuthorityEntityId",
                    CanonicalValue::String(quote_authority.clone()),
                ),
                ("minTradeSize", CanonicalValue::BigInt(BigInt::from(10))),
                (
                    "supportedPairs",
                    CanonicalValue::Array(vec![CanonicalValue::String("1/2".into())]),
                ),
            ]),
        )
        .expect("tx");
        let native = decode_local_entity_control_tx(&tx)
            .expect("decode")
            .expect("control");
        let mut state = EntityStateSlice::empty(entity.clone(), 1);
        apply_local_entity_control_tx(&mut state, native, &mut Vec::new(), &authority(), 0)
            .expect("apply");
        assert_eq!(
            state
                .orderbook
                .as_ref()
                .expect("orderbook")
                .max_orders_per_pair,
            10_000
        );
        let profile = &state
            .orderbook_metadata
            .as_ref()
            .expect("metadata")
            .hub_profile;
        assert_eq!(profile.entity_id, entity);
        assert_eq!(profile.usd_quote_authority_entity_id, quote_authority);
        assert_eq!(profile.supported_pairs, ["1/2"]);
    }

    #[test]
    fn e2r_appends_one_typed_batch_operation_and_exact_event() {
        let entity = format!("0x{}", "11".repeat(32));
        let tx = CanonicalEntityTx::from_frame_projection(
            EntityTxKind::E2r,
            object(vec![
                (
                    "contractAddress",
                    CanonicalValue::String(format!("0x{}", "22".repeat(20))),
                ),
                ("amount", CanonicalValue::BigInt(7.into())),
            ]),
        )
        .expect("tx");
        let native = decode_local_entity_control_tx(&tx)
            .expect("decode")
            .expect("control");
        let mut state = EntityStateSlice::empty(entity, 1);
        let mut events = Vec::new();
        apply_local_entity_control_tx(&mut state, native, &mut events, &authority(), 0)
            .expect("apply");
        let batch = state.j_batch_state.expect("batch");
        assert_eq!(batch.status, JBatchStatus::Accumulating);
        assert_eq!(batch.batch.external_token_to_reserve.len(), 1);
        assert_eq!(
            batch.batch.external_token_to_reserve[0].amount,
            U256::from(7)
        );
        assert_eq!(
            events,
            [EntityFrameEvent::Status {
                message: "📦 Queued E→R: 7 via 0x22222222... (use j_broadcast to commit)".into(),
            }]
        );
    }

    #[test]
    fn reserve_admission_simulates_entire_draft_and_preserves_prior_on_reject() {
        let entity = format!("0x{}", "11".repeat(32));
        let mut state = EntityStateSlice::empty(entity, 1);
        state.reserves.insert(1, BigInt::from(10));
        let first = LocalEntityControlTx::R2r {
            receiving_entity: [0x22; 32],
            token_id: 1,
            amount: U256::from(7),
        };
        apply_local_entity_control_tx(&mut state, first, &mut Vec::new(), &authority(), 0)
            .expect("first fits");
        let second = LocalEntityControlTx::R2r {
            receiving_entity: [0x33; 32],
            token_id: 1,
            amount: U256::from(4),
        };
        let error =
            apply_local_entity_control_tx(&mut state, second, &mut Vec::new(), &authority(), 0)
                .expect_err("whole draft exceeds reserve");
        assert!(error.to_string().contains("INSUFFICIENT_RESERVE"));
        assert_eq!(
            state
                .j_batch_state
                .as_ref()
                .unwrap()
                .batch
                .reserve_to_reserve
                .len(),
            1
        );
    }

    #[test]
    fn open_outgoing_debt_reduces_draft_reserve_without_full_ledger_scan() {
        let entity = format!("0x{}", "11".repeat(32));
        let mut state = EntityStateSlice::empty(entity.clone(), 1);
        state.reserves.insert(1, BigInt::from(10));
        state.out_debts_by_token = Some(
            crate::DebtLedger::from_entries([crate::DebtEntry {
                debt_id: "debt-1".into(),
                token_id: 1,
                debtor: entity,
                creditor: format!("0x{}", "22".repeat(32)),
                counterparty: format!("0x{}", "22".repeat(32)),
                direction: crate::DebtDirection::Out,
                created_amount: BigInt::from(4),
                paid_amount: BigInt::from(0),
                remaining_amount: BigInt::from(4),
                created_debt_index: 1,
                current_debt_index: 1,
                created_at_block: 1,
                created_tx_hash: format!("0x{}", "aa".repeat(32)),
                last_updated_block: 1,
                last_updated_tx_hash: format!("0x{}", "aa".repeat(32)),
                last_event_type: crate::DebtEventType::Created,
            }])
            .expect("ledger"),
        );
        let tx = LocalEntityControlTx::R2r {
            receiving_entity: [0x33; 32],
            token_id: 1,
            amount: U256::from(7),
        };
        let error = apply_local_entity_control_tx(&mut state, tx, &mut Vec::new(), &authority(), 0)
            .expect_err("debt is paid before reserve transfer");
        assert!(error.to_string().contains("INSUFFICIENT_RESERVE"));
        assert!(state.j_batch_state.is_none());
    }

    #[test]
    fn sent_batch_does_not_block_a_new_independent_draft() {
        let entity = format!("0x{}", "11".repeat(32));
        let mut state = EntityStateSlice::empty(entity, 1);
        state.reserves.insert(1, BigInt::from(10));
        state.j_batch_state = Some(JBatchState {
            sent_batch: Some(SentJBatch {
                batch: JBatch::default(),
                batch_hash: [0x44; 32],
                encoded_batch: vec![0x55],
                entity_nonce: 1,
                first_submitted_at: 1,
                last_submitted_at: 1,
                submit_attempts: 1,
                fee_overrides: None,
                transaction_hash: None,
                last_failure: None,
                terminal_failure: None,
            }),
            status: JBatchStatus::Sent,
            ..JBatchState::default()
        });
        apply_local_entity_control_tx(
            &mut state,
            LocalEntityControlTx::R2r {
                receiving_entity: [0x22; 32],
                token_id: 1,
                amount: U256::from(6),
            },
            &mut Vec::new(),
            &authority(),
            0,
        )
        .expect("TS permits draft accumulation while a prior batch is sent");
        let batch = state.j_batch_state.unwrap();
        assert!(batch.sent_batch.is_some());
        assert_eq!(batch.batch.reserve_to_reserve.len(), 1);
    }

    #[test]
    fn broadcast_selects_one_finalizer_and_preserves_unrelated_remainder() {
        let source = JBatch {
            reserve_to_reserve: vec![ReserveToReserve {
                receiving_entity: [0x22; 32],
                token_id: U256::one(),
                amount: U256::from(7),
            }],
            dispute_finalizations: vec![final_dispute(0x33, 1), final_dispute(0x44, 3)],
            ..JBatch::default()
        };
        let (selected, remainder) = take_broadcast_batch(&source);
        assert_eq!(
            selected.dispute_finalizations,
            source.dispute_finalizations[..1]
        );
        assert!(selected.reserve_to_reserve.is_empty());
        assert_eq!(
            remainder.dispute_finalizations,
            source.dispute_finalizations[1..]
        );
        assert_eq!(remainder.reserve_to_reserve, source.reserve_to_reserve);
    }

    #[test]
    fn broadcast_emits_typescript_status_events_in_canonical_order() {
        let entity = format!("0x{}", "11".repeat(32));
        let mut state = EntityStateSlice::empty(entity, 99);
        state.j_batch_state = Some(JBatchState {
            batch: JBatch {
                dispute_finalizations: vec![final_dispute(0x33, 1)],
                ..JBatch::default()
            },
            ..JBatchState::default()
        });
        let mut events = Vec::new();
        let result = apply_local_entity_control_tx(
            &mut state,
            LocalEntityControlTx::JBroadcast {
                fee_overrides: None,
            },
            &mut events,
            &provider_authority(),
            0,
        )
        .expect("broadcast");
        assert_eq!(result.hashes_to_sign.len(), 1);
        assert_eq!(
            events,
            [
                EntityFrameEvent::Status {
                    message: "📤 Batch (1 ops) → hashesToSign [nonce=1]".into(),
                },
                EntityFrameEvent::Status {
                    message: "⚖️ Dispute operations broadcast before ordinary queued operations"
                        .into(),
                },
            ]
        );
    }

    #[test]
    fn proposal_waits_for_weighted_quorum_then_executes_once() {
        let mut state = EntityStateSlice::empty(format!("0x{}", "11".repeat(32)), 99);
        let board_hash = format!("0x{}", "22".repeat(32));
        let action = object(vec![
            ("type", CanonicalValue::String("collective_message".into())),
            (
                "data",
                object(vec![("message", CanonicalValue::String("ship".into()))]),
            ),
        ]);
        let mut events = Vec::new();
        let proposed = apply_local_entity_control_tx(
            &mut state,
            LocalEntityControlTx::Propose(EntityPropose {
                proposer: "alice".into(),
                action,
                board_hash: board_hash.clone(),
                board_epoch: 7,
                command_nonce: BigInt::from(1_u8),
            }),
            &mut events,
            &quorum_authority(),
            7,
        )
        .expect("propose");
        assert!(proposed.approved_entity_txs.is_empty());
        let proposal_id = state.proposals.keys().next().expect("pending").clone();
        assert!(events.is_empty());

        let voted = apply_local_entity_control_tx(
            &mut state,
            LocalEntityControlTx::Vote(EntityVote {
                proposal_id,
                voter: "bob".into(),
                choice: crate::EntityVoteChoice::Yes,
                comment: Some("ok".into()),
                board_hash,
                board_epoch: 7,
            }),
            &mut events,
            &quorum_authority(),
            7,
        )
        .expect("vote");
        assert!(voted.approved_entity_txs.is_empty());
        assert!(state.proposals.is_empty());
        assert_eq!(
            events,
            [EntityFrameEvent::Status {
                message: "[COLLECTIVE] ship".into(),
            }]
        );
    }

    #[test]
    fn provider_transfer_commits_one_intent_and_exact_typescript_hash() {
        let entity = format!("0x{}", "11".repeat(32));
        let tx = CanonicalEntityTx::from_frame_projection(
            EntityTxKind::EntityProviderTransfer,
            object(vec![
                (
                    "to",
                    CanonicalValue::String(format!("0x{}", "33".repeat(20))),
                ),
                ("tokenId", CanonicalValue::BigInt(5.into())),
                ("amount", CanonicalValue::BigInt(9.into())),
            ]),
        )
        .expect("tx");
        let native = decode_local_entity_control_tx(&tx)
            .expect("decode")
            .expect("control");
        let mut state = EntityStateSlice::empty(entity, 99);
        let result = apply_local_entity_control_tx(
            &mut state,
            native,
            &mut Vec::new(),
            &provider_authority(),
            7,
        )
        .expect("apply");
        let pending = state
            .entity_provider_action_state
            .as_ref()
            .and_then(|state| state.pending.as_ref())
            .expect("pending intent");
        assert_eq!(
            render_hex(&pending.action_hash),
            "0x7b47e48377e20de225763b037cee9fedadb386ee355ca6e554478e7518eaee97"
        );
        assert_eq!(result.j_outputs.len(), 1);
        assert_eq!(result.hashes_to_sign.len(), 1);
    }
}

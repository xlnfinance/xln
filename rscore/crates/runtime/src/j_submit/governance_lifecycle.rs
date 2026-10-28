use ethabi::ethereum_types::U256;
use serde_json::{Map, Number, Value, json};
use sha3::{Digest, Keccak256};
use xln_rscore_entity_kernel::{ControlBoardSupporterVote, EntityProviderGovernanceIntent};

use crate::RuntimeReplica;

use super::lifecycle::{
    JAdapterFailure, JSubmitLifecycleError, error, infrastructure_pending_mut, normalize,
    pending_tx_type, stable_json,
};

const RETRY_MS: u64 = 60_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernanceSupporterVote {
    pub entity_id: [u8; 32],
    pub hanko: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PublicationPayload {
    ControlBoard {
        target_entity_id: [u8; 32],
        new_board_hash: [u8; 32],
        target_board_epoch: u64,
        action_nonce: U256,
        supporter_votes: Vec<GovernanceSupporterVote>,
    },
    TargetReveal {
        registration: xln_rscore_entity_kernel::j_batch::HashLadderRegistration,
        hanko: Vec<u8>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DurableGovernanceAttempt {
    pub jurisdiction_name: String,
    pub shareholder_entity_id: [u8; 32],
    pub payload: PublicationPayload,
    pub proposal_hash: [u8; 32],
    pub signer_id: [u8; 20],
    pub timestamp: u64,
    pub payload_hash: [u8; 32],
    pub attempt_id: String,
    pub attempt_number: u64,
    pub attempted_at: u64,
    pub eligible_at: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GovernanceResultOutcome {
    Submitted,
    TransientFailure,
    TerminalFailure,
    Reconciled,
}

impl GovernanceResultOutcome {
    fn text(self) -> &'static str {
        match self {
            Self::Submitted => "submitted",
            Self::TransientFailure => "transientFailure",
            Self::TerminalFailure => "terminalFailure",
            Self::Reconciled => "reconciled",
        }
    }

    fn parse(value: &str) -> Result<Self, JSubmitLifecycleError> {
        match value {
            "submitted" => Ok(Self::Submitted),
            "transientFailure" => Ok(Self::TransientFailure),
            "terminalFailure" => Ok(Self::TerminalFailure),
            "reconciled" => Ok(Self::Reconciled),
            _ => Err(error("GOVERNANCE_RESULT_OUTCOME")),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernanceResultData {
    pub jurisdiction_name: String,
    pub entity_id: String,
    pub signer_id: String,
    pub proposal_hash: String,
    pub payload_hash: String,
    pub attempt_id: String,
    pub attempt_number: u64,
    pub attempted_at: u64,
    pub outcome: GovernanceResultOutcome,
    pub message: Option<String>,
    pub adapter_failure: Option<JAdapterFailure>,
    pub transaction_hash: Option<String>,
}

fn hex(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn fixed_hex<const N: usize>(value: &str, field: &str) -> Result<[u8; N], JSubmitLifecycleError> {
    let normalized = normalize(value);
    hex::decode(normalized.strip_prefix("0x").ok_or_else(|| error(field))?)
        .map_err(|_| error(field))?
        .try_into()
        .map_err(|_| error(field))
}

fn safe_number(value: u64, field: &str) -> Result<Value, JSubmitLifecycleError> {
    if value > MAX_SAFE_INTEGER {
        return Err(error(format!("{field}_UNSAFE")));
    }
    Ok(Value::Number(Number::from(value)))
}

fn bigint(value: U256) -> Value {
    json!({"__xlnType":"BigInt", "value":value.to_string()})
}

fn decode_bigint(value: &Value, field: &str) -> Result<U256, JSubmitLifecycleError> {
    let tagged = value.as_object().ok_or_else(|| error(field))?;
    if tagged.len() != 2 || tagged.get("__xlnType").and_then(Value::as_str) != Some("BigInt") {
        return Err(error(field));
    }
    U256::from_dec_str(
        tagged
            .get("value")
            .and_then(Value::as_str)
            .ok_or_else(|| error(field))?,
    )
    .map_err(|_| error(field))
}

fn supporter_values(votes: &[GovernanceSupporterVote]) -> Value {
    Value::Array(
        votes
            .iter()
            .map(|vote| json!({"entityId":hex(&vote.entity_id), "hankoSignature":hex(&vote.hanko)}))
            .collect(),
    )
}

fn unsigned_payload(attempt: &DurableGovernanceAttempt) -> Value {
    let (kind, data) = match &attempt.payload {
        PublicationPayload::ControlBoard {
            target_entity_id,
            new_board_hash,
            target_board_epoch,
            action_nonce,
            supporter_votes,
        } => (
            "entityProviderProposeControlBoard",
            json!({
                "targetEntityId":hex(target_entity_id), "newBoardHash":hex(new_board_hash),
                "boardEpoch":bigint(U256::from(*target_board_epoch)), "actionNonce":bigint(*action_nonce),
                "proposalHash":hex(&attempt.proposal_hash), "supporterVotes":supporter_values(supporter_votes),
                "signerId":hex(&attempt.signer_id),
            }),
        ),
        PublicationPayload::TargetReveal {
            registration,
            hanko,
        } => (
            "hashLadderReveal",
            json!({
                "registration":super::target_reveal::registration_value(registration),
                "revealHash":hex(&attempt.proposal_hash), "hankoSignature":hex(hanko), "signerId":hex(&attempt.signer_id),
            }),
        ),
    };
    json!({"type":kind, "entityId":hex(&attempt.shareholder_entity_id), "data":data, "timestamp":attempt.timestamp})
}

pub(super) fn payload_hash(
    attempt: &DurableGovernanceAttempt,
) -> Result<[u8; 32], JSubmitLifecycleError> {
    Ok(Keccak256::digest(stable_json(&unsigned_payload(attempt))?.as_bytes()).into())
}

pub(super) fn attempt_id(
    attempt: &DurableGovernanceAttempt,
    attempt_number: u64,
) -> Result<String, JSubmitLifecycleError> {
    if attempt_number == 0 || attempt_number > MAX_SAFE_INTEGER {
        return Err(error("GOVERNANCE_SUBMIT_ATTEMPT_NUMBER_INVALID"));
    }
    let identity = json!({
        "domain":"xln/governance-j-submit-attempt/v1",
        "jurisdictionName":normalize(&attempt.jurisdiction_name),
        "entityId":hex(&attempt.shareholder_entity_id),
        "signerId":hex(&attempt.signer_id),
        "proposalHash":hex(&attempt.proposal_hash),
        "payloadHash":hex(&attempt.payload_hash),
        "attemptNumber":attempt_number,
    });
    Ok(hex(&Keccak256::digest(stable_json(&identity)?.as_bytes())))
}

pub fn prepare_governance_attempt(
    jurisdiction_name: String,
    intent: EntityProviderGovernanceIntent,
    own_hanko: Vec<u8>,
) -> Result<DurableGovernanceAttempt, JSubmitLifecycleError> {
    let EntityProviderGovernanceIntent::ProposeControlBoard {
        shareholder_entity_id,
        target_entity_id,
        new_board_hash,
        target_board_epoch,
        action_nonce,
        proposal_hash,
        supporter_votes,
        signer_id,
        timestamp,
    } = intent
    else {
        return Err(error("GOVERNANCE_INTENT_NOT_PROPOSAL"));
    };
    if jurisdiction_name.trim().is_empty()
        || action_nonce.is_zero()
        || target_board_epoch > MAX_SAFE_INTEGER
        || timestamp > MAX_SAFE_INTEGER
    {
        return Err(error("GOVERNANCE_INTENT_INVALID"));
    }
    let signer_id = fixed_hex(&signer_id, "GOVERNANCE_SIGNER")?;
    let own_count = supporter_votes
        .iter()
        .filter(|vote| vote.entity_id == shareholder_entity_id)
        .count();
    if own_count != 1 || supporter_votes.len() > 256 {
        return Err(error("GOVERNANCE_OWN_VOTE_INVALID"));
    }
    let supporter_votes = supporter_votes
        .into_iter()
        .map(
            |ControlBoardSupporterVote {
                 entity_id,
                 hanko_signature,
             }| {
                let hanko = if entity_id == shareholder_entity_id {
                    if hanko_signature.is_some() {
                        return Err(error("GOVERNANCE_OWN_VOTE_PREATTACHED"));
                    }
                    own_hanko.clone()
                } else {
                    hanko_signature.ok_or_else(|| error("GOVERNANCE_SUPPORTER_HANKO_MISSING"))?
                };
                Ok(GovernanceSupporterVote { entity_id, hanko })
            },
        )
        .collect::<Result<Vec<_>, _>>()?;
    let mut attempt = DurableGovernanceAttempt {
        jurisdiction_name,
        shareholder_entity_id,
        payload: PublicationPayload::ControlBoard {
            target_entity_id,
            new_board_hash,
            target_board_epoch,
            action_nonce,
            supporter_votes,
        },
        proposal_hash,
        signer_id,
        timestamp,
        payload_hash: [0; 32],
        attempt_id: String::new(),
        attempt_number: 1,
        attempted_at: timestamp,
        eligible_at: timestamp,
    };
    attempt.payload_hash = payload_hash(&attempt)?;
    attempt.attempt_id = attempt_id(&attempt, 1)?;
    Ok(attempt)
}

fn pending_value(attempt: &DurableGovernanceAttempt) -> Result<Value, JSubmitLifecycleError> {
    let mut tx = unsigned_payload(attempt);
    tx.get_mut("data")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| error("GOVERNANCE_PENDING_DATA"))?
        .insert(
            "runtimeSubmitAttempt".into(),
            json!({
                "attemptId":attempt.attempt_id,
                "attemptNumber":attempt.attempt_number,
                "attemptedAt":attempt.attempted_at,
                "eligibleAt":attempt.eligible_at,
            }),
        );
    Ok(json!({"jurisdictionName":attempt.jurisdiction_name, "jTxs":[tx]}))
}

pub fn register_governance_attempt(
    replica: &mut RuntimeReplica,
    attempt: &DurableGovernanceAttempt,
) -> Result<(), JSubmitLifecycleError> {
    if decode_pending_governance_attempts(replica.durable.infrastructure())?
        .iter()
        .any(|pending| pending.attempt_id == attempt.attempt_id)
    {
        return Err(error("GOVERNANCE_SUBMIT_ATTEMPT_DUPLICATED"));
    }
    infrastructure_pending_mut(&mut replica.durable)?.push(pending_value(attempt)?);
    replica.durable.invalidate_infrastructure_digest();
    Ok(())
}

fn parse_pending(value: &Value) -> Result<DurableGovernanceAttempt, JSubmitLifecycleError> {
    let input = value
        .as_object()
        .ok_or_else(|| error("GOVERNANCE_PENDING_INPUT"))?;
    let jurisdiction_name = input
        .get("jurisdictionName")
        .and_then(Value::as_str)
        .ok_or_else(|| error("GOVERNANCE_PENDING_JURISDICTION"))?
        .to_string();
    let tx = input
        .get("jTxs")
        .and_then(Value::as_array)
        .filter(|rows| rows.len() == 1)
        .and_then(|rows| rows.first())
        .and_then(Value::as_object)
        .ok_or_else(|| error("GOVERNANCE_PENDING_TX"))?;
    let entity_id = fixed_hex(
        tx.get("entityId")
            .and_then(Value::as_str)
            .ok_or_else(|| error("GOVERNANCE_ENTITY"))?,
        "GOVERNANCE_ENTITY",
    )?;
    let timestamp = tx
        .get("timestamp")
        .and_then(Value::as_u64)
        .ok_or_else(|| error("GOVERNANCE_TIMESTAMP"))?;
    let data = tx
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| error("GOVERNANCE_DATA"))?;
    let payload = if tx.get("type").and_then(Value::as_str) == Some("hashLadderReveal") {
        PublicationPayload::TargetReveal {
            registration: super::target_reveal::parse_registration(
                data.get("registration")
                    .ok_or_else(|| error("REVEAL_REGISTRATION"))?,
            )?,
            hanko: hex::decode(
                data.get("hankoSignature")
                    .and_then(Value::as_str)
                    .and_then(|v| v.strip_prefix("0x"))
                    .ok_or_else(|| error("REVEAL_HANKO"))?,
            )
            .map_err(|_| error("REVEAL_HANKO"))?,
        }
    } else {
        let votes = data
            .get("supporterVotes")
            .and_then(Value::as_array)
            .ok_or_else(|| error("GOVERNANCE_VOTES"))?
            .iter()
            .map(|row| {
                let row = row.as_object().ok_or_else(|| error("GOVERNANCE_VOTE"))?;
                Ok(GovernanceSupporterVote {
                    entity_id: fixed_hex(
                        row.get("entityId")
                            .and_then(Value::as_str)
                            .ok_or_else(|| error("GOVERNANCE_VOTE_ENTITY"))?,
                        "GOVERNANCE_VOTE_ENTITY",
                    )?,
                    hanko: hex::decode(
                        normalize(
                            row.get("hankoSignature")
                                .and_then(Value::as_str)
                                .ok_or_else(|| error("GOVERNANCE_VOTE_HANKO"))?,
                        )
                        .strip_prefix("0x")
                        .ok_or_else(|| error("GOVERNANCE_VOTE_HANKO"))?,
                    )
                    .map_err(|_| error("GOVERNANCE_VOTE_HANKO"))?,
                })
            })
            .collect::<Result<Vec<_>, JSubmitLifecycleError>>()?;
        PublicationPayload::ControlBoard {
            target_entity_id: fixed_hex(
                data.get("targetEntityId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| error("GOVERNANCE_TARGET"))?,
                "GOVERNANCE_TARGET",
            )?,
            new_board_hash: fixed_hex(
                data.get("newBoardHash")
                    .and_then(Value::as_str)
                    .ok_or_else(|| error("GOVERNANCE_BOARD"))?,
                "GOVERNANCE_BOARD",
            )?,
            target_board_epoch: decode_bigint(
                data.get("boardEpoch")
                    .ok_or_else(|| error("GOVERNANCE_EPOCH"))?,
                "GOVERNANCE_EPOCH",
            )?
            .low_u64(),
            action_nonce: decode_bigint(
                data.get("actionNonce")
                    .ok_or_else(|| error("GOVERNANCE_NONCE"))?,
                "GOVERNANCE_NONCE",
            )?,
            supporter_votes: votes,
        }
    };
    let metadata = data
        .get("runtimeSubmitAttempt")
        .and_then(Value::as_object)
        .ok_or_else(|| error("GOVERNANCE_ATTEMPT"))?;
    let mut attempt = DurableGovernanceAttempt {
        jurisdiction_name,
        shareholder_entity_id: entity_id,
        proposal_hash: fixed_hex(
            data.get(
                if matches!(&payload, PublicationPayload::TargetReveal { .. }) {
                    "revealHash"
                } else {
                    "proposalHash"
                },
            )
            .and_then(Value::as_str)
            .ok_or_else(|| error("PUBLICATION_HASH"))?,
            "PUBLICATION_HASH",
        )?,
        payload,
        signer_id: fixed_hex(
            data.get("signerId")
                .and_then(Value::as_str)
                .ok_or_else(|| error("GOVERNANCE_SIGNER"))?,
            "GOVERNANCE_SIGNER",
        )?,
        timestamp,
        payload_hash: [0; 32],
        attempt_id: metadata
            .get("attemptId")
            .and_then(Value::as_str)
            .ok_or_else(|| error("GOVERNANCE_ATTEMPT_ID"))?
            .to_string(),
        attempt_number: metadata
            .get("attemptNumber")
            .and_then(Value::as_u64)
            .ok_or_else(|| error("GOVERNANCE_ATTEMPT_NUMBER"))?,
        attempted_at: metadata
            .get("attemptedAt")
            .and_then(Value::as_u64)
            .ok_or_else(|| error("GOVERNANCE_ATTEMPT_TIME"))?,
        eligible_at: metadata
            .get("eligibleAt")
            .and_then(Value::as_u64)
            .ok_or_else(|| error("GOVERNANCE_ELIGIBLE_TIME"))?,
    };
    attempt.payload_hash = payload_hash(&attempt)?;
    if attempt.attempt_id != attempt_id(&attempt, attempt.attempt_number)?
        || attempt.eligible_at < attempt.attempted_at
    {
        return Err(error("GOVERNANCE_ATTEMPT_ID_MISMATCH"));
    }
    Ok(attempt)
}

pub fn decode_pending_governance_attempts(
    infrastructure: &Value,
) -> Result<Vec<DurableGovernanceAttempt>, JSubmitLifecycleError> {
    let Some(rows) = infrastructure
        .as_object()
        .and_then(|value| value.get("pendingCommittedJOutbox"))
    else {
        return Ok(Vec::new());
    };
    rows.as_array()
        .ok_or_else(|| error("PENDING_ARRAY"))?
        .iter()
        .filter_map(|value| match pending_tx_type(value) {
            Ok("entityProviderProposeControlBoard" | "hashLadderReveal") => {
                Some(parse_pending(value))
            }
            Ok(_) => None,
            Err(reason) => Some(Err(reason)),
        })
        .collect()
}

fn result_value(result: &GovernanceResultData) -> Result<Value, JSubmitLifecycleError> {
    let mut data = Map::from_iter([
        (
            "jurisdictionName".into(),
            Value::String(result.jurisdiction_name.clone()),
        ),
        (
            "entityId".into(),
            Value::String(normalize(&result.entity_id)),
        ),
        (
            "signerId".into(),
            Value::String(normalize(&result.signer_id)),
        ),
        (
            "proposalHash".into(),
            Value::String(normalize(&result.proposal_hash)),
        ),
        (
            "payloadHash".into(),
            Value::String(normalize(&result.payload_hash)),
        ),
        (
            "attemptId".into(),
            Value::String(normalize(&result.attempt_id)),
        ),
        (
            "attemptNumber".into(),
            safe_number(result.attempt_number, "GOVERNANCE_RESULT_ATTEMPT")?,
        ),
        (
            "attemptedAt".into(),
            safe_number(result.attempted_at, "GOVERNANCE_RESULT_TIME")?,
        ),
        (
            "outcome".into(),
            Value::String(result.outcome.text().into()),
        ),
    ]);
    if let Some(value) = &result.message {
        data.insert("message".into(), Value::String(value.clone()));
    }
    if let Some(value) = &result.adapter_failure {
        data.insert(
            "adapterFailure".into(),
            json!({"category":value.category,"code":value.code,"message":value.message}),
        );
    }
    if let Some(value) = &result.transaction_hash {
        data.insert("txHash".into(), Value::String(normalize(value)));
    }
    Ok(json!({"type":"recordGovernanceJSubmitResult", "data":data}))
}

pub fn encode_governance_result(
    result: &GovernanceResultData,
) -> Result<Value, JSubmitLifecycleError> {
    result_value(result)
}

pub(crate) fn decode_governance_result(
    value: &Value,
) -> Result<GovernanceResultData, JSubmitLifecycleError> {
    let data = value
        .as_object()
        .ok_or_else(|| error("GOVERNANCE_RESULT_DATA"))?;
    let string = |field: &str| {
        data.get(field)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| error(format!("GOVERNANCE_RESULT_{field}")))
    };
    let adapter_failure = data
        .get("adapterFailure")
        .map(|value| {
            let row = value
                .as_object()
                .ok_or_else(|| error("GOVERNANCE_RESULT_ADAPTER"))?;
            Ok(JAdapterFailure {
                category: row
                    .get("category")
                    .and_then(Value::as_str)
                    .ok_or_else(|| error("GOVERNANCE_RESULT_ADAPTER_CATEGORY"))?
                    .into(),
                code: row
                    .get("code")
                    .and_then(Value::as_str)
                    .ok_or_else(|| error("GOVERNANCE_RESULT_ADAPTER_CODE"))?
                    .into(),
                message: row
                    .get("message")
                    .and_then(Value::as_str)
                    .ok_or_else(|| error("GOVERNANCE_RESULT_ADAPTER_MESSAGE"))?
                    .into(),
            })
        })
        .transpose()?;
    Ok(GovernanceResultData {
        jurisdiction_name: string("jurisdictionName")?,
        entity_id: string("entityId")?,
        signer_id: string("signerId")?,
        proposal_hash: string("proposalHash")?,
        payload_hash: string("payloadHash")?,
        attempt_id: string("attemptId")?,
        attempt_number: data
            .get("attemptNumber")
            .and_then(Value::as_u64)
            .ok_or_else(|| error("GOVERNANCE_RESULT_ATTEMPT"))?,
        attempted_at: data
            .get("attemptedAt")
            .and_then(Value::as_u64)
            .ok_or_else(|| error("GOVERNANCE_RESULT_TIME"))?,
        outcome: GovernanceResultOutcome::parse(
            data.get("outcome")
                .and_then(Value::as_str)
                .ok_or_else(|| error("GOVERNANCE_RESULT_OUTCOME"))?,
        )?,
        message: data
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string),
        adapter_failure,
        transaction_hash: data
            .get("txHash")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

pub fn apply_governance_result(
    replica: &mut RuntimeReplica,
    result: &GovernanceResultData,
    timestamp: u64,
) -> Result<(), JSubmitLifecycleError> {
    let mut matches = decode_pending_governance_attempts(replica.durable.infrastructure())?
        .into_iter()
        .filter(|attempt| attempt.attempt_id == result.attempt_id)
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(error("GOVERNANCE_SUBMIT_RESULT_ATTEMPT_MISSING"));
    }
    let current = matches.pop().expect("exactly one");
    if normalize(&result.jurisdiction_name) != normalize(&current.jurisdiction_name)
        || normalize(&result.entity_id) != hex(&current.shareholder_entity_id)
        || normalize(&result.signer_id) != hex(&current.signer_id)
        || normalize(&result.proposal_hash) != hex(&current.proposal_hash)
        || normalize(&result.payload_hash) != hex(&current.payload_hash)
        || result.attempt_number != current.attempt_number
        || result.attempted_at != current.attempted_at
    {
        return Err(error("GOVERNANCE_SUBMIT_RESULT_IDENTITY_MISMATCH"));
    }
    let pending = infrastructure_pending_mut(&mut replica.durable)?;
    let index = pending
        .iter()
        .position(|row| {
            parse_pending(row).is_ok_and(|attempt| attempt.attempt_id == result.attempt_id)
        })
        .ok_or_else(|| error("GOVERNANCE_SUBMIT_RESULT_ATTEMPT_MISSING"))?;
    if result.outcome == GovernanceResultOutcome::TransientFailure {
        let mut next = current;
        next.attempt_number = next
            .attempt_number
            .checked_add(1)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| error("GOVERNANCE_SUBMIT_ATTEMPT_EXHAUSTED"))?;
        next.attempted_at = timestamp;
        next.eligible_at = timestamp
            .checked_add(RETRY_MS)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| error("GOVERNANCE_SUBMIT_RETRY_TIME"))?;
        next.attempt_id = attempt_id(&next, next.attempt_number)?;
        pending[index] = pending_value(&next)?;
    } else {
        pending.remove(index);
    }
    replica.durable.invalidate_infrastructure_digest();
    Ok(())
}

#[cfg(test)]
mod target_publication_tests {
    use super::*;
    use xln_rscore_entity_kernel::j_batch::{
        HashLadderRegistration, HashLadderWitness, hash_target_reveal,
    };

    #[test]
    fn target_publication_matches_ts_hash_and_recovers_exact_immutable_outbox() {
        let registration = HashLadderRegistration {
            counterparty_entity: [0x33; 32],
            target_role: true,
            full_hash: Keccak256::digest([0x22; 32]).into(),
            partial_root: [0; 32],
            witness: HashLadderWitness {
                fill_ratio: 65535,
                full_secret: [0x22; 32],
                reveals: [[0; 32]; 4],
            },
        };
        let digest = hash_target_reveal(2, [0x11; 20], [0x44; 32], &registration);
        assert_eq!(
            hex(&digest),
            "0x308ddc17f20601e25e786d51461ac3531fc61ffd018470aba1e8a0dcf892aa29"
        );
        // Signature bytes are opaque in this serialization vector; chain verification owns authentication.
        let attempt = super::super::target_reveal::prepare_target_reveal(
            "Target".into(),
            [0x44; 32],
            registration,
            digest,
            hex(&[0x55; 20]),
            1_149_000,
            vec![0x12, 0x34],
        )
        .unwrap();
        assert_eq!(
            hex(&attempt.payload_hash),
            "0xe8ce4fea7bde518087cd57e2b8255ccc3e884943156681c50923502a40f4199f"
        );
        assert_eq!(
            attempt.attempt_id,
            "0x46c16654ebcee7b78393eb90d4ca1d6ee6a6dcf7353dace6805f293c40282e3e"
        );
        let saved = pending_value(&attempt).unwrap();
        let restored: Value = serde_json::from_slice(&serde_json::to_vec(&saved).unwrap()).unwrap();
        assert_eq!(parse_pending(&restored).unwrap(), attempt);
        let mut tampered = restored;
        tampered["jTxs"][0]["data"]["registration"]["counterpartyEntity"] =
            Value::String(hex(&[0x66; 32]));
        assert!(parse_pending(&tampered).is_err());
    }
}

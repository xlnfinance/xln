use super::governance_lifecycle::{
    DurableGovernanceAttempt, PublicationPayload, attempt_id, payload_hash,
};
use super::lifecycle::{JSubmitLifecycleError, error};
use serde_json::{Value, json};
use xln_rscore_entity_kernel::j_batch::{HashLadderRegistration, HashLadderWitness};

fn hex(value: &[u8]) -> String {
    format!("0x{}", hex::encode(value))
}

pub(super) fn registration_value(value: &HashLadderRegistration) -> Value {
    json!({"counterpartyEntity":hex(&value.counterparty_entity), "targetRole":value.target_role,
        "fullHash":hex(&value.full_hash), "partialRoot":hex(&value.partial_root), "witness":{
            "fillRatio":value.witness.fill_ratio, "fullSecret":hex(&value.witness.full_secret),
            "reveals":value.witness.reveals.iter().map(|v| hex(v)).collect::<Vec<_>>()}})
}

pub(super) fn parse_registration(
    value: &Value,
) -> Result<HashLadderRegistration, JSubmitLifecycleError> {
    fn word(value: Option<&Value>) -> Result<[u8; 32], JSubmitLifecycleError> {
        hex::decode(
            value
                .and_then(Value::as_str)
                .and_then(|v| v.strip_prefix("0x"))
                .ok_or_else(|| error("REVEAL_WORD"))?,
        )
        .map_err(|_| error("REVEAL_WORD"))?
        .try_into()
        .map_err(|_| error("REVEAL_WORD"))
    }
    let witness = value
        .get("witness")
        .ok_or_else(|| error("REVEAL_WITNESS"))?;
    let reveals = witness
        .get("reveals")
        .and_then(Value::as_array)
        .filter(|v| v.len() == 4)
        .ok_or_else(|| error("REVEAL_NODES"))?;
    if value.get("targetRole") != Some(&Value::Bool(true)) {
        return Err(error("REVEAL_ROLE"));
    }
    let registration = HashLadderRegistration {
        counterparty_entity: word(value.get("counterpartyEntity"))?,
        target_role: true,
        full_hash: word(value.get("fullHash"))?,
        partial_root: word(value.get("partialRoot"))?,
        witness: HashLadderWitness {
            fill_ratio: witness
                .get("fillRatio")
                .and_then(Value::as_u64)
                .filter(|v| *v > 0 && *v <= 65535)
                .ok_or_else(|| error("REVEAL_RATIO"))? as u16,
            full_secret: word(witness.get("fullSecret"))?,
            reveals: [
                word(reveals.first())?,
                word(reveals.get(1))?,
                word(reveals.get(2))?,
                word(reveals.get(3))?,
            ],
        },
    };
    if registration_value(&registration) != *value {
        return Err(error("REVEAL_NONCANONICAL"));
    }
    Ok(registration)
}

pub(super) fn prepare_target_reveal(
    jurisdiction_name: String,
    entity_id: [u8; 32],
    registration: HashLadderRegistration,
    reveal_hash: [u8; 32],
    signer_id: String,
    timestamp: u64,
    hanko: Vec<u8>,
) -> Result<DurableGovernanceAttempt, JSubmitLifecycleError> {
    let signer_id = hex::decode(
        signer_id
            .strip_prefix("0x")
            .ok_or_else(|| error("REVEAL_SIGNER"))?,
    )
    .map_err(|_| error("REVEAL_SIGNER"))?
    .try_into()
    .map_err(|_| error("REVEAL_SIGNER"))?;
    let mut value = DurableGovernanceAttempt {
        jurisdiction_name,
        shareholder_entity_id: entity_id,
        proposal_hash: reveal_hash,
        payload: PublicationPayload::TargetReveal {
            registration,
            hanko,
        },
        signer_id,
        timestamp,
        payload_hash: [0; 32],
        attempt_id: String::new(),
        attempt_number: 1,
        attempted_at: timestamp,
        eligible_at: timestamp,
    };
    value.payload_hash = payload_hash(&value)?;
    value.attempt_id = attempt_id(&value, 1)?;
    Ok(value)
}

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

/// Match only the owning Entity's authenticated finalized registry projection.
/// RPC receipts, pending witnesses and foreign chain/pair/role slots cannot retire it.
pub(crate) fn finalized_target_reveal(
    replica: &crate::RuntimeReplica,
    attempt: &DurableGovernanceAttempt,
) -> Result<bool, JSubmitLifecycleError> {
    let PublicationPayload::TargetReveal { registration, .. } = &attempt.payload else {
        return Ok(false);
    };
    let Some((state, live)) =
        replica.entity_slot(&attempt.shareholder_entity_id, &hex(&attempt.signer_id))
    else {
        return Ok(false);
    };
    let Some(config) = &live.entity_consensus.state.authority.config.jurisdiction else {
        return Ok(false);
    };
    let config =
        crate::tagged_json_from_canonical_value(config).map_err(|e| error(e.to_string()))?;
    if config.get("name").and_then(Value::as_str) != Some(&attempt.jurisdiction_name) {
        return Ok(false);
    }
    let chain = config
        .get("chainId")
        .and_then(Value::as_u64)
        .ok_or_else(|| error("REVEAL_CHAIN_ID"))?;
    let depository = config
        .get("depositoryAddress")
        .and_then(Value::as_str)
        .ok_or_else(|| error("REVEAL_DEPOSITORY"))?;
    let address: [u8; 20] = hex::decode(
        depository
            .strip_prefix("0x")
            .ok_or_else(|| error("REVEAL_DEPOSITORY"))?,
    )
    .map_err(|_| error("REVEAL_DEPOSITORY"))?
    .try_into()
    .map_err(|_| error("REVEAL_DEPOSITORY"))?;
    if xln_rscore_entity_kernel::j_batch::hash_target_reveal(
        chain,
        address,
        attempt.shareholder_entity_id,
        registration,
    ) != attempt.proposal_hash
    {
        return Ok(false);
    }
    let Some(routes) = &state.entity.cross_jurisdiction_swaps else {
        return Ok(false);
    };
    let stack = format!("stack:{chain}:{}", depository.to_ascii_lowercase());
    for (_, route) in routes.keyed_values() {
        let route =
            crate::tagged_json_from_canonical_value(route).map_err(|e| error(e.to_string()))?;
        if finalized_route_matches(&route, &stack, attempt, registration) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn finalized_route_matches(
    route: &Value,
    stack: &str,
    attempt: &DurableGovernanceAttempt,
    registration: &HashLadderRegistration,
) -> bool {
    route
        .pointer("/target/jurisdiction")
        .and_then(Value::as_str)
        == Some(stack)
        && route
            .pointer("/target/counterpartyEntityId")
            .and_then(Value::as_str)
            .is_some_and(|v| v.eq_ignore_ascii_case(&hex(&attempt.shareholder_entity_id)))
        && route
            .pointer("/target/entityId")
            .and_then(Value::as_str)
            .is_some_and(|v| v.eq_ignore_ascii_case(&hex(&registration.counterparty_entity)))
        && route
            .pointer("/targetPull/fullHash")
            .and_then(Value::as_str)
            == Some(hex(&registration.full_hash).as_str())
        && route
            .pointer("/targetPull/partialRoot")
            .and_then(Value::as_str)
            == Some(hex(&registration.partial_root).as_str())
        && route.get("targetRegistryFillRatio").and_then(Value::as_u64)
            == Some(u64::from(registration.witness.fill_ratio))
        && route
            .pointer("/targetRegistryRecord/fillRatio")
            .and_then(Value::as_u64)
            == Some(u64::from(registration.witness.fill_ratio))
}

/// Native poll and startup share this eligibility rule; no new salvage input is needed.
pub(crate) fn target_reveal_is_due(
    attempt: &DurableGovernanceAttempt,
    now: u64,
    queued: &std::collections::VecDeque<crate::RuntimeTx>,
) -> bool {
    attempt.eligible_at <= now && !queued.iter().any(|tx| matches!(tx,
        crate::RuntimeTx::RecordGovernanceJSubmitResult(result) if result.attempt_id == attempt.attempt_id))
}

pub(crate) fn due_target_reveals(
    replica: &crate::RuntimeReplica,
    now: u64,
    queued: &std::collections::VecDeque<crate::RuntimeTx>,
) -> Result<Vec<DurableGovernanceAttempt>, JSubmitLifecycleError> {
    Ok(
        super::decode_pending_governance_attempts(replica.durable.infrastructure())?
            .into_iter()
            .filter(|attempt| {
                matches!(attempt.payload, PublicationPayload::TargetReveal { .. })
                    && target_reveal_is_due(attempt, now, queued)
            })
            .collect(),
    )
}

#[cfg(test)]
#[path = "target_reveal_tests.rs"]
mod finality_tests;

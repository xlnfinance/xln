use super::LocalAccountFinancialView;
use super::dispute::{argument_tuple, known_secrets_for_hashlocks};
use crate::j_batch::ProofBody;
use crate::paybook::PaybookChanges;
use crate::{EntityKernelError, EntityStateSlice};
use ethabi::{ParamType, Token};
use std::collections::BTreeMap;

fn invalid(detail: impl Into<String>) -> EntityKernelError {
    EntityKernelError::local("dispute", detail.into())
}

fn decode_list(encoded: &[u8], param: ParamType) -> Result<Vec<Token>, EntityKernelError> {
    if encoded.is_empty() {
        return Ok(Vec::new());
    }
    let decoded = ethabi::decode(&[param], encoded).map_err(|error| invalid(error.to_string()))?;
    match decoded.into_iter().next() {
        Some(Token::Array(items) | Token::Tuple(items)) => Ok(items),
        _ => Err(invalid("DISPUTE_ARGUMENT_TUPLE")),
    }
}

// N8's authenticated clauses own positions. Never borrow N7 swap ratios when
// Alice supplies an unpublished preimage omitted from Bob's committed start.
pub(crate) fn refresh_dispute_secret_arguments(
    body: &ProofBody,
    existing: &[u8],
    state: &EntityStateSlice,
    paybook: &PaybookChanges,
    counterparty: &str,
    delta_transformer: [u8; 20],
) -> Result<Vec<u8>, EntityKernelError> {
    let previous = decode_list(existing, ParamType::Array(Box::new(ParamType::Bytes)))?;
    let mut changed = false;
    let mut clauses = Vec::new();
    for (index, clause) in body.transformers.iter().enumerate() {
        let original = match previous.get(index) {
            Some(Token::Bytes(bytes)) => bytes.clone(),
            None => Vec::new(),
            _ => return Err(invalid("DISPUTE_ARGUMENT_BYTES")),
        };
        if clause.transformer_address != delta_transformer {
            clauses.push(Token::Bytes(original));
            continue;
        }
        let batch = decode_list(&clause.encoded_batch, crate::cross_j::delta_batch_param())?;
        let Some(Token::Array(payments)) = batch.first() else {
            return Err(invalid("DISPUTE_ARGUMENT_PAYMENTS"));
        };
        let hashlocks = payments
            .iter()
            .map(|payment| {
                let Token::Tuple(fields) = payment else {
                    return Err(invalid("DISPUTE_ARGUMENT_PAYMENT"));
                };
                let Some(Token::FixedBytes(hash)) = fields.get(3) else {
                    return Err(invalid("DISPUTE_ARGUMENT_HASHLOCK"));
                };
                Ok(format!(
                    "0x{}",
                    hash.iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>()
                ))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let known = known_secrets_for_hashlocks(state, paybook, &hashlocks, counterparty)?;
        if known.is_empty() {
            clauses.push(Token::Bytes(original));
            continue;
        }
        let (ratios, previous_secrets) = decode_arguments(&original)?;
        let mut secrets = Vec::new();
        for secret in previous_secrets {
            if !secrets.contains(&secret) {
                secrets.push(secret);
            }
        }
        for secret in known {
            if !secrets.contains(&secret) {
                secrets.push(secret);
            }
        }
        clauses.push(Token::Bytes(argument_tuple(ratios, secrets)));
        changed = true;
    }
    Ok(if changed {
        ethabi::encode(&[Token::Array(clauses)])
    } else {
        existing.to_vec()
    })
}

fn decode_arguments(encoded: &[u8]) -> Result<(Vec<u32>, Vec<[u8; 32]>), EntityKernelError> {
    if encoded.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let fields = decode_list(
        encoded,
        ParamType::Tuple(vec![
            ParamType::Array(Box::new(ParamType::Uint(16))),
            ParamType::Array(Box::new(ParamType::FixedBytes(32))),
        ]),
    )?;
    let [Token::Array(ratios), Token::Array(secrets)] = fields.as_slice() else {
        return Err(invalid("DISPUTE_ARGUMENT_FIELDS"));
    };
    let ratios = ratios
        .iter()
        .map(|value| match value {
            Token::Uint(value) => Ok(value.low_u32()),
            _ => Err(invalid("DISPUTE_ARGUMENT_RATIO")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let secrets = secrets
        .iter()
        .map(|value| match value {
            Token::FixedBytes(value) => value
                .as_slice()
                .try_into()
                .map_err(|_| invalid("DISPUTE_ARGUMENT_SECRET")),
            _ => Err(invalid("DISPUTE_ARGUMENT_SECRET")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((ratios, secrets))
}

pub(crate) fn refresh_broadcast_dispute_arguments(
    state: &mut EntityStateSlice,
    paybook: &PaybookChanges,
    views: &BTreeMap<String, LocalAccountFinancialView>,
) -> Result<(), EntityKernelError> {
    let Some(j_state) = state.j_batch_state.as_ref() else {
        return Ok(());
    };
    if j_state.sent_batch.is_some() {
        return Ok(());
    }
    let recovery = j_state
        .recovery_batches
        .first()
        .is_some_and(|batch| crate::j_batch::batch_op_count(batch) > 0);
    let source = if recovery {
        &j_state.recovery_batches[0]
    } else {
        &j_state.batch
    };
    let (selected, _) = crate::local_control::take_broadcast_batch(source, state.timestamp / 1000);
    let Some(proof) = selected.dispute_finalizations.first() else {
        return Ok(());
    };
    let counterparty = format!(
        "0x{}",
        proof
            .counterentity
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    if proof.cooperative
        || proof.final_proofbody.transformers.is_empty()
        || (state.entity_id < counterparty) == proof.started_by_left
    {
        return Ok(());
    }
    let transformer = views
        .get(&counterparty)
        .and_then(|view| view.dispute.as_ref())
        .and_then(|view| view.delta_transformer)
        .ok_or_else(|| invalid("DISPUTE_ARGUMENT_ACCOUNT_MISSING"))?;
    let arguments = refresh_dispute_secret_arguments(
        &proof.final_proofbody,
        &proof.other_arguments,
        state,
        paybook,
        &counterparty,
        transformer,
    )?;
    let index = source
        .dispute_finalizations
        .iter()
        .position(|row| row == proof)
        .expect("selected draft");
    let j_state = state.j_batch_state.as_mut().expect("selected batch");
    let source = if recovery {
        &mut j_state.recovery_batches[0]
    } else {
        &mut j_state.batch
    };
    source.dispute_finalizations[index].other_arguments = arguments;
    Ok(())
}

#[cfg(test)]
#[path = "dispute_arguments_tests.rs"]
mod tests;

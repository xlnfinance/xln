use xln_rscore_abi::{AbiValue, BodyTuple};
use xln_rscore_batch::{BatchResponse, BatchVerdict, IndexedOutput, IndexedResult, PreparedBatch};
use xln_rscore_engine::{AccountOutput, DeliveryMode};

pub fn hello(worker_count: usize) -> BodyTuple {
    body(vec![
        integer(crate::PROCESS_ABI_VERSION),
        AbiValue::Text(crate::PROCESS_PROFILE.into()),
        integer(worker_count),
    ])
}

pub fn loaded(revision: u64) -> BodyTuple {
    body(vec![integer(revision)])
}

pub fn prepared(candidate: &PreparedBatch) -> Result<BodyTuple, crate::ProcessError> {
    let roots = candidate.payment_profile_roots()?;
    Ok(body(vec![
        integer(candidate.base_revision()),
        integer(candidate.next_revision()),
        tuple(candidate.results().iter().map(result).collect()),
        tuple(candidate.outputs().iter().map(output).collect()),
        tuple(
            roots
                .into_iter()
                .map(|root| {
                    tuple(vec![
                        AbiValue::Bytes(root.account_id.as_bytes().to_vec()),
                        AbiValue::Bytes(root.payment_profile_root.to_vec()),
                    ])
                })
                .collect(),
        ),
    ]))
}

pub fn committed(response: &BatchResponse) -> BodyTuple {
    body(vec![integer(response.committed_revision)])
}

pub fn aborted(revision: u64) -> BodyTuple {
    body(vec![integer(revision)])
}

pub fn shutdown() -> BodyTuple {
    body(Vec::new())
}

pub fn error(error: &crate::ProcessError) -> BodyTuple {
    body(vec![
        AbiValue::Text(error.code().into()),
        AbiValue::Text(error.to_string()),
    ])
}

fn result(value: &IndexedResult) -> AbiValue {
    let verdict = match &value.verdict {
        BatchVerdict::Applied => tuple(vec![AbiValue::Integer(0)]),
        BatchVerdict::Rejected(rejection) => tuple(vec![
            AbiValue::Integer(1),
            AbiValue::Text(rejection.code().into()),
            AbiValue::Text(rejection.message()),
        ]),
    };
    tuple(vec![
        AbiValue::Integer(i128::from(value.input_index)),
        AbiValue::Bytes(value.account_id.as_bytes().to_vec()),
        verdict,
        tuple(value.events.iter().cloned().map(AbiValue::Text).collect()),
    ])
}

fn output(value: &IndexedOutput) -> AbiValue {
    tuple(vec![
        AbiValue::Integer(i128::from(value.input_index)),
        AbiValue::Integer(i128::from(value.output_index)),
        AbiValue::Bytes(value.account_id.as_bytes().to_vec()),
        account_output(&value.output),
    ])
}

fn account_output(value: &AccountOutput) -> AbiValue {
    match value {
        AccountOutput::DirectPaymentForward {
            token_id,
            amount,
            route,
            description,
            delivery_mode,
            trusted_gateway_entity_id,
        } => tuple(vec![
            AbiValue::Integer(0),
            AbiValue::Integer(i128::from(token_id.get())),
            AbiValue::Text(amount.to_string()),
            tuple(route.iter().cloned().map(AbiValue::Text).collect()),
            optional_text(description),
            AbiValue::Integer(match delivery_mode {
                DeliveryMode::Direct => 0,
                DeliveryMode::Trusted => 1,
            }),
            AbiValue::Text(trusted_gateway_entity_id.clone()),
        ]),
        AccountOutput::HtlcSecret {
            lock_id,
            hashlock,
            secret,
            token_id,
            amount,
        } => tuple(vec![
            AbiValue::Integer(1),
            AbiValue::Text(lock_id.clone()),
            AbiValue::Text(hashlock.clone()),
            AbiValue::Text(secret.clone()),
            AbiValue::Integer(i128::from(token_id.get())),
            AbiValue::Text(amount.to_string()),
        ]),
        AccountOutput::HtlcError {
            lock_id,
            hashlock,
            token_id,
            amount,
            reason,
        } => tuple(vec![
            AbiValue::Integer(2),
            AbiValue::Text(lock_id.clone()),
            AbiValue::Text(hashlock.clone()),
            AbiValue::Integer(i128::from(token_id.get())),
            AbiValue::Text(amount.to_string()),
            optional_text(reason),
        ]),
    }
}

fn body(fields: Vec<AbiValue>) -> BodyTuple {
    BodyTuple::from_array([tuple(fields)])
}

fn tuple(fields: Vec<AbiValue>) -> AbiValue {
    AbiValue::Tuple(BodyTuple::from_vec(fields))
}

fn optional_text(value: &Option<String>) -> AbiValue {
    value.clone().map_or(AbiValue::Nil, AbiValue::Text)
}

fn integer(value: impl TryInto<i128>) -> AbiValue {
    AbiValue::Integer(value.try_into().ok().expect("wire integer fits i128"))
}

use xln_rscore_abi::{AbiValue, BodyTuple};
use xln_rscore_batch::{BatchResponse, BatchVerdict, IndexedOutput, IndexedResult, PreparedBatch};
use xln_rscore_engine::{AccountOutput, DeliveryMode};

pub fn hello(worker_count: usize, swap_market_digest: [u8; 32]) -> BodyTuple {
    body(vec![
        integer(crate::PROCESS_ABI_VERSION),
        AbiValue::Text(crate::PROCESS_PROFILE.into()),
        integer(worker_count),
        // The caller compares this against the digest of the tables it sent,
        // so a registry that moved under the engine is loud, not silent.
        AbiValue::Bytes(swap_market_digest.to_vec()),
    ])
}

pub fn loaded(revision: u64, accounts_root: [u8; 32]) -> BodyTuple {
    body(vec![
        integer(revision),
        AbiValue::Bytes(accounts_root.to_vec()),
    ])
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
    body(vec![
        integer(response.committed_revision),
        AbiValue::Bytes(response.accounts_root.to_vec()),
    ])
}

pub fn upserted(revision: u64, accounts_root: [u8; 32]) -> BodyTuple {
    body(vec![
        integer(revision),
        AbiValue::Bytes(accounts_root.to_vec()),
    ])
}

pub fn aborted(revision: u64) -> BodyTuple {
    body(vec![integer(revision)])
}

pub fn shutdown() -> BodyTuple {
    body(Vec::new())
}

pub fn capacity_rows(
    revision: u64,
    rows: &[Option<xln_rscore_engine::DeltaPerspective>],
) -> BodyTuple {
    body(vec![
        integer(revision),
        tuple(
            rows.iter()
                .map(|row| match row {
                    None => AbiValue::Nil,
                    Some(view) => tuple(vec![
                        AbiValue::Text(view.in_capacity.to_string()),
                        AbiValue::Text(view.out_capacity.to_string()),
                        AbiValue::Text(view.own_credit_limit.to_string()),
                        AbiValue::Text(view.peer_credit_limit.to_string()),
                    ]),
                })
                .collect(),
        ),
    ])
}

pub fn summary_page(
    revision: u64,
    rows: &[xln_rscore_batch::AccountSummaryRow],
    next_cursor: Option<xln_rscore_batch::AccountId>,
    totals: &xln_rscore_batch::EngineTotals,
) -> BodyTuple {
    body(vec![
        integer(revision),
        tuple(
            rows.iter()
                .map(|row| {
                    tuple(vec![
                        AbiValue::Bytes(row.account_id.as_bytes().to_vec()),
                        AbiValue::Integer(match row.owner_side {
                            xln_rscore_engine::Side::Left => 0,
                            xln_rscore_engine::Side::Right => 1,
                        }),
                        integer(row.delta_rows),
                        integer(row.htlc_locks),
                        AbiValue::Bytes(row.deltas_root.to_vec()),
                        AbiValue::Bytes(row.htlc_locks_root.to_vec()),
                        AbiValue::Bytes(row.account_state_root.to_vec()),
                    ])
                })
                .collect(),
        ),
        match next_cursor {
            None => AbiValue::Nil,
            Some(cursor) => AbiValue::Bytes(cursor.as_bytes().to_vec()),
        },
        tuple(vec![
            integer(totals.accounts),
            integer(totals.htlc_locks),
            tuple(
                totals
                    .tokens
                    .iter()
                    .map(|token| {
                        tuple(vec![
                            AbiValue::Integer(i128::from(token.token_id.get())),
                            integer(token.rows),
                            AbiValue::Text(token.collateral.to_string()),
                            AbiValue::Text(token.owner_in_capacity.to_string()),
                            AbiValue::Text(token.owner_out_capacity.to_string()),
                        ])
                    })
                    .collect(),
            ),
        ]),
    ])
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
        AccountOutput::SwapOfferCreated {
            offer_id,
            maker_is_left,
            from_entity,
            to_entity,
            created_height,
            give_token_id,
            give_token_decimals,
            give_amount,
            want_token_id,
            want_token_decimals,
            want_amount,
            max_fee,
            min_net_receive,
            price_ticks,
            time_in_force,
        } => tuple(vec![
            AbiValue::Integer(3),
            AbiValue::Text(offer_id.clone()),
            AbiValue::Integer(i128::from(!*maker_is_left)),
            AbiValue::Text(from_entity.clone()),
            AbiValue::Text(to_entity.clone()),
            integer(*created_height),
            integer(*give_token_id),
            integer(*give_token_decimals),
            AbiValue::Text(give_amount.to_string()),
            integer(*want_token_id),
            integer(*want_token_decimals),
            AbiValue::Text(want_amount.to_string()),
            AbiValue::Text(max_fee.to_string()),
            AbiValue::Text(min_net_receive.to_string()),
            AbiValue::Text(price_ticks.to_string()),
            time_in_force.map_or(AbiValue::Nil, integer),
        ]),
        AccountOutput::SwapCancelRequested { offer_id } => {
            tuple(vec![AbiValue::Integer(4), AbiValue::Text(offer_id.clone())])
        }
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

use std::collections::BTreeSet;
use std::error::Error;
use std::io::{self, Read, Write};

use num_bigint::BigInt;
use sha2::{Digest, Sha256};
use xln_rscore_abi::{
    AbiValue, BodyTuple, Envelope, MessageKind, OpTag, decode_envelope, encode_envelope,
};
use xln_rscore_engine::{
    AccountDomain, AccountIdentity, AccountOutput, AccountRejection, AccountReplica, AccountState,
    AccountTx, AccountVerdict, DeliveryMode, Delta, DepositoryAddress, EntityId,
    SequentialAccountEngine, Side, TokenId, WatchSeed,
};
use xln_rscore_protocol::{CanonicalValue, encode_account_state_value};

const REQUEST_ARITY: usize = 3;
const RESPONSE_SCHEMA: &str = "balance-direct-v1";

fn invalid(detail: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, detail.into())
}

fn tuple(value: &AbiValue) -> Result<&[AbiValue], io::Error> {
    match value {
        AbiValue::Tuple(value) => Ok(value.fields()),
        _ => Err(invalid("DIFFERENTIAL_EXPECTED_TUPLE")),
    }
}

fn text(value: &AbiValue) -> Result<&str, io::Error> {
    match value {
        AbiValue::Text(value) => Ok(value),
        _ => Err(invalid("DIFFERENTIAL_EXPECTED_TEXT")),
    }
}

fn integer(value: &AbiValue) -> Result<i128, io::Error> {
    match value {
        AbiValue::Integer(value) => Ok(*value),
        _ => Err(invalid("DIFFERENTIAL_EXPECTED_INTEGER")),
    }
}

fn optional_text(value: &AbiValue) -> Result<Option<String>, io::Error> {
    match value {
        AbiValue::Nil => Ok(None),
        AbiValue::Text(value) => Ok(Some(value.clone())),
        _ => Err(invalid("DIFFERENTIAL_EXPECTED_OPTIONAL_TEXT")),
    }
}

fn token(value: &AbiValue) -> Result<TokenId, Box<dyn Error>> {
    let raw = u32::try_from(integer(value)?)?;
    Ok(TokenId::new(raw)?)
}

fn bigint(value: &AbiValue) -> Result<BigInt, Box<dyn Error>> {
    Ok(text(value)?.parse()?)
}

fn side(value: &AbiValue) -> Result<Side, io::Error> {
    match integer(value)? {
        0 => Ok(Side::Left),
        1 => Ok(Side::Right),
        tag => Err(invalid(format!("DIFFERENTIAL_SIDE_TAG:{tag}"))),
    }
}

fn parse_delta(value: &AbiValue) -> Result<Delta, Box<dyn Error>> {
    let fields = tuple(value)?;
    if fields.len() != 10 {
        return Err(invalid("DIFFERENTIAL_DELTA_ARITY").into());
    }
    Ok(Delta::new(
        token(&fields[0])?,
        bigint(&fields[1])?,
        bigint(&fields[2])?,
        bigint(&fields[3])?,
        bigint(&fields[4])?,
        bigint(&fields[5])?,
        bigint(&fields[6])?,
        bigint(&fields[7])?,
        bigint(&fields[8])?,
        bigint(&fields[9])?,
    )?)
}

fn parse_initial(value: &AbiValue) -> Result<(AccountReplica, BTreeSet<TokenId>), Box<dyn Error>> {
    let fields = tuple(value)?;
    if fields.len() != 7 {
        return Err(invalid("DIFFERENTIAL_INITIAL_ARITY").into());
    }
    let owner = EntityId::parse(text(&fields[0])?)?;
    let left = EntityId::parse(text(&fields[1])?)?;
    let right = EntityId::parse(text(&fields[2])?)?;
    let domain = AccountDomain::new(
        u64::try_from(integer(&fields[3])?)?,
        DepositoryAddress::parse(text(&fields[4])?)?,
    )?;
    let identity = AccountIdentity::new(domain, left, right, WatchSeed::parse(text(&fields[5])?)?)?;
    let deltas = tuple(&fields[6])?
        .iter()
        .map(parse_delta)
        .collect::<Result<Vec<_>, _>>()?;
    let tokens = deltas.iter().map(Delta::token_id).collect();
    Ok((
        AccountReplica::new(owner, AccountState::new(identity, deltas)?)?,
        tokens,
    ))
}

fn parse_route(value: &AbiValue) -> Result<Vec<String>, Box<dyn Error>> {
    tuple(value)?
        .iter()
        .map(|entry| Ok(text(entry)?.to_owned()))
        .collect()
}

fn parse_tx(value: &AbiValue) -> Result<AccountTx, Box<dyn Error>> {
    let fields = tuple(value)?;
    let tag = fields
        .first()
        .ok_or_else(|| invalid("DIFFERENTIAL_TX_EMPTY"))?;
    match integer(tag)? {
        0 if fields.len() == 2 => Ok(AccountTx::AddDelta {
            token_id: token(&fields[1])?,
        }),
        1 if fields.len() == 3 => Ok(AccountTx::SetCreditLimit {
            token_id: token(&fields[1])?,
            amount: bigint(&fields[2])?,
        }),
        2 if fields.len() == 9 => Ok(AccountTx::DirectPayment {
            token_id: token(&fields[1])?,
            amount: bigint(&fields[2])?,
            route: parse_route(&fields[3])?,
            description: optional_text(&fields[4])?,
            from_entity_id: text(&fields[5])?.to_owned(),
            to_entity_id: text(&fields[6])?.to_owned(),
            delivery_mode: match integer(&fields[7])? {
                0 => DeliveryMode::Direct,
                1 => DeliveryMode::Trusted,
                tag => return Err(invalid(format!("DIFFERENTIAL_DELIVERY_TAG:{tag}")).into()),
            },
            trusted_gateway_entity_id: optional_text(&fields[8])?,
        }),
        tag => Err(invalid(format!(
            "DIFFERENTIAL_TX_TAG_OR_ARITY:{tag}:{}",
            fields.len()
        ))
        .into()),
    }
}

fn values_tuple(values: Vec<AbiValue>) -> AbiValue {
    AbiValue::Tuple(BodyTuple::from_vec(values))
}

fn delta_value(delta: &Delta) -> AbiValue {
    values_tuple(vec![
        AbiValue::Integer(i128::from(delta.token_id().get())),
        AbiValue::Text(delta.collateral().to_string()),
        AbiValue::Text(delta.ondelta().to_string()),
        AbiValue::Text(delta.offdelta().to_string()),
        AbiValue::Text(delta.left_credit_limit().to_string()),
        AbiValue::Text(delta.right_credit_limit().to_string()),
        AbiValue::Text(delta.allowance(Side::Left).to_string()),
        AbiValue::Text(delta.allowance(Side::Right).to_string()),
        AbiValue::Text(delta.hold(Side::Left).to_string()),
        AbiValue::Text(delta.hold(Side::Right).to_string()),
    ])
}

fn observable_rows<'a>(replica: &'a AccountReplica, tokens: &BTreeSet<TokenId>) -> Vec<&'a Delta> {
    tokens
        .iter()
        .filter_map(|token| replica.state().delta(*token))
        .collect()
}

fn modeled_delta_state_root(rows: &[&Delta]) -> Result<[u8; 32], Box<dyn Error>> {
    let values = rows
        .iter()
        .map(|delta| {
            CanonicalValue::Object(vec![
                (
                    "tokenId".into(),
                    CanonicalValue::Number(f64::from(delta.token_id().get())),
                ),
                (
                    "collateral".into(),
                    CanonicalValue::BigInt(delta.collateral().clone()),
                ),
                (
                    "ondelta".into(),
                    CanonicalValue::BigInt(delta.ondelta().clone()),
                ),
                (
                    "offdelta".into(),
                    CanonicalValue::BigInt(delta.offdelta().clone()),
                ),
                (
                    "leftCreditLimit".into(),
                    CanonicalValue::BigInt(delta.left_credit_limit().clone()),
                ),
                (
                    "rightCreditLimit".into(),
                    CanonicalValue::BigInt(delta.right_credit_limit().clone()),
                ),
                (
                    "leftAllowance".into(),
                    CanonicalValue::BigInt(delta.allowance(Side::Left).clone()),
                ),
                (
                    "rightAllowance".into(),
                    CanonicalValue::BigInt(delta.allowance(Side::Right).clone()),
                ),
                (
                    "leftHold".into(),
                    CanonicalValue::BigInt(delta.hold(Side::Left).clone()),
                ),
                (
                    "rightHold".into(),
                    CanonicalValue::BigInt(delta.hold(Side::Right).clone()),
                ),
            ])
        })
        .collect();
    Ok(Sha256::digest(encode_account_state_value(&CanonicalValue::Array(values))?).into())
}

fn output_value(output: &AccountOutput) -> Result<AbiValue, io::Error> {
    match output {
        AccountOutput::DirectPaymentForward {
            token_id,
            amount,
            route,
            description,
            delivery_mode,
            trusted_gateway_entity_id,
        } => Ok(values_tuple(vec![
            AbiValue::Text("directPaymentForward".into()),
            AbiValue::Integer(i128::from(token_id.get())),
            AbiValue::Text(amount.to_string()),
            values_tuple(route.iter().cloned().map(AbiValue::Text).collect()),
            description.clone().map_or(AbiValue::Nil, AbiValue::Text),
            AbiValue::Text(
                match delivery_mode {
                    DeliveryMode::Direct => "direct",
                    DeliveryMode::Trusted => "trusted",
                }
                .into(),
            ),
            AbiValue::Text(trusted_gateway_entity_id.clone()),
        ])),
        unsupported => Err(invalid(format!(
            "DIFFERENTIAL_OUTPUT_UNSUPPORTED:{unsupported:?}"
        ))),
    }
}

fn verdict_value(verdict: &AccountVerdict) -> AbiValue {
    match verdict {
        AccountVerdict::Applied => values_tuple(vec![AbiValue::Text("applied".into())]),
        AccountVerdict::Rejected(rejection) => {
            let kind = match rejection {
                AccountRejection::Validation(_) => "validation",
                AccountRejection::DeltaRowLimitExceeded { .. } => "delta_row_limit_exceeded",
            };
            values_tuple(vec![
                AbiValue::Text("rejected".into()),
                AbiValue::Text(kind.into()),
                AbiValue::Text(rejection.code().into()),
                AbiValue::Text(rejection.message()),
            ])
        }
    }
}

fn step_value(
    id: String,
    transition: &xln_rscore_engine::AccountTransition,
    replica: &AccountReplica,
    tokens: &BTreeSet<TokenId>,
) -> Result<AbiValue, Box<dyn Error>> {
    let rows = observable_rows(replica, tokens);
    Ok(values_tuple(vec![
        AbiValue::Text(id),
        verdict_value(transition.verdict()),
        values_tuple(
            transition
                .events()
                .iter()
                .cloned()
                .map(AbiValue::Text)
                .collect(),
        ),
        values_tuple(
            transition
                .outputs()
                .iter()
                .map(output_value)
                .collect::<Result<Vec<_>, _>>()?,
        ),
        values_tuple(rows.iter().map(|delta| delta_value(delta)).collect()),
        values_tuple(vec![
            AbiValue::Bytes(modeled_delta_state_root(&rows)?.to_vec()),
            AbiValue::Bytes(replica.state().deltas_root().to_vec()),
        ]),
    ]))
}

fn execute(envelope: Envelope) -> Result<Envelope, Box<dyn Error>> {
    if envelope.op_tag != OpTag::ExecuteWave || envelope.message_kind != MessageKind::Request {
        return Err(invalid("DIFFERENTIAL_ENVELOPE_KIND").into());
    }
    let body = envelope.body.fields();
    if text(&body[0])? != RESPONSE_SCHEMA {
        return Err(invalid("DIFFERENTIAL_SCHEMA").into());
    }
    let (mut replica, mut tokens) = parse_initial(&body[1])?;
    let mut steps = Vec::new();
    for case in tuple(&body[2])? {
        let fields = tuple(case)?;
        if fields.len() != 3 {
            return Err(invalid("DIFFERENTIAL_CASE_ARITY").into());
        }
        let id = text(&fields[0])?.to_owned();
        let tx = parse_tx(&fields[2])?;
        if let AccountTx::AddDelta { token_id }
        | AccountTx::SetCreditLimit { token_id, .. }
        | AccountTx::DirectPayment { token_id, .. } = &tx
        {
            tokens.insert(*token_id);
        }
        let transition = SequentialAccountEngine::apply(&replica, side(&fields[1])?, &tx)?;
        let next = transition.candidate().unwrap_or(&replica);
        steps.push(step_value(id, &transition, next, &tokens)?);
        if let Some(candidate) = transition.committed() {
            replica = candidate;
        }
    }
    Ok(Envelope {
        binding: envelope.binding,
        identity: envelope.identity,
        op_tag: envelope.op_tag,
        message_kind: MessageKind::Ok,
        body: BodyTuple::from_array([AbiValue::Text(RESPONSE_SCHEMA.into()), values_tuple(steps)]),
    })
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut input = Vec::new();
    io::stdin().read_to_end(&mut input)?;
    let response = execute(decode_envelope(&input, REQUEST_ARITY)?)?;
    io::stdout().write_all(&encode_envelope(&response)?)?;
    Ok(())
}

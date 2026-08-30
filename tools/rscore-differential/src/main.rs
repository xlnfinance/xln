use std::collections::BTreeSet;
use std::error::Error;
use std::io::{self, Read, Write};

use num_bigint::BigInt;
use xln_rscore_abi::{
    AbiValue, BodyTuple, Envelope, MessageKind, OpTag, decode_envelope, encode_envelope,
};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountExecutionContext, AccountIdentity, AccountOutput,
    AccountRejection, AccountReplica, AccountState, AccountTx, AccountVerdict, DeliveryMode, Delta,
    DepositoryAddress, EntityId, HtlcHashlock, HtlcLock, HtlcLockTx, HtlcResolveOutcome,
    HtlcResolveTx, SequentialAccountEngine, Side, TokenId, WatchSeed,
};

const REQUEST_ARITY: usize = 3;
const RESPONSE_SCHEMA: &str = "payment-v1";

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

fn unsigned(value: &AbiValue) -> Result<u64, Box<dyn Error>> {
    Ok(u64::try_from(integer(value)?)?)
}

fn context(value: &AbiValue) -> Result<Option<AccountExecutionContext>, Box<dyn Error>> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let fields = tuple(value)?;
    if fields.len() != 5 {
        return Err(invalid("DIFFERENTIAL_CONTEXT_ARITY").into());
    }
    Ok(Some(AccountExecutionContext::new(
        unsigned(&fields[0])?,
        unsigned(&fields[1])?,
        unsigned(&fields[2])?,
        unsigned(&fields[3])?,
        unsigned(&fields[4])?,
    )))
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
    if fields.len() != 8 {
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
    let dispute_fields = tuple(&fields[6])?;
    if dispute_fields.len() != 2 {
        return Err(invalid("DIFFERENTIAL_DISPUTE_CONFIG_ARITY").into());
    }
    let dispute_config =
        AccountDisputeConfig::new(unsigned(&dispute_fields[0])?, unsigned(&dispute_fields[1])?)?;
    let deltas = tuple(&fields[7])?
        .iter()
        .map(parse_delta)
        .collect::<Result<Vec<_>, _>>()?;
    let tokens = deltas.iter().map(Delta::token_id).collect();
    Ok((
        AccountReplica::new(owner, AccountState::new(identity, dispute_config, deltas)?)?,
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
        3 if fields.len() == 7 => Ok(AccountTx::HtlcLock(HtlcLockTx {
            lock_id: text(&fields[1])?.to_owned(),
            hashlock: HtlcHashlock::parse(text(&fields[2])?)?,
            timelock: bigint(&fields[3])?,
            reveal_before_height: unsigned(&fields[4])?,
            amount: bigint(&fields[5])?,
            token_id: token(&fields[6])?,
            delivery_mode: None,
            envelope: None,
        })),
        4 if fields.len() == 4 => {
            let outcome = match integer(&fields[2])? {
                0 => HtlcResolveOutcome::Secret {
                    secret: text(&fields[3])?.to_owned(),
                },
                1 => HtlcResolveOutcome::Error {
                    reason: optional_text(&fields[3])?,
                },
                tag => return Err(invalid(format!("DIFFERENTIAL_HTLC_OUTCOME_TAG:{tag}")).into()),
            };
            Ok(AccountTx::HtlcResolve(HtlcResolveTx {
                lock_id: text(&fields[1])?.to_owned(),
                outcome,
            }))
        }
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

fn lock_value(lock: &HtlcLock) -> AbiValue {
    values_tuple(vec![
        AbiValue::Text(lock.lock_id().into()),
        AbiValue::Text(lock.hashlock().as_str().into()),
        AbiValue::Text(lock.timelock().to_string()),
        AbiValue::Integer(i128::from(lock.reveal_before_height())),
        AbiValue::Text(lock.amount().to_string()),
        AbiValue::Integer(i128::from(lock.token_id().get())),
        AbiValue::Bool(lock.sender() == Side::Left),
        AbiValue::Integer(i128::from(lock.created_height())),
        AbiValue::Integer(i128::from(lock.created_timestamp())),
        lock.envelope_hash_hex()
            .map_or(AbiValue::Nil, AbiValue::Text),
    ])
}

fn observable_locks<'a>(
    replica: &'a AccountReplica,
    lock_ids: &BTreeSet<String>,
) -> Vec<&'a HtlcLock> {
    lock_ids
        .iter()
        .filter_map(|lock_id| replica.state().htlc_lock(lock_id))
        .collect()
}

fn output_value(output: &AccountOutput) -> AbiValue {
    match output {
        AccountOutput::DirectPaymentForward {
            token_id,
            amount,
            route,
            description,
            delivery_mode,
            trusted_gateway_entity_id,
        } => values_tuple(vec![
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
        ]),
        AccountOutput::HtlcSecret {
            lock_id,
            hashlock,
            secret,
            token_id,
            amount,
        } => values_tuple(vec![
            AbiValue::Text("htlcSecret".into()),
            AbiValue::Text(lock_id.clone()),
            AbiValue::Text(hashlock.clone()),
            AbiValue::Text(secret.clone()),
            AbiValue::Integer(i128::from(token_id.get())),
            AbiValue::Text(amount.to_string()),
        ]),
        AccountOutput::SwapOfferUpsert { offer } => values_tuple(vec![
            AbiValue::Text("swapOfferUpsert".into()),
            AbiValue::Text(offer.offer_id.clone()),
            AbiValue::Text(offer.left_entity.clone()),
            AbiValue::Text(offer.right_entity.clone()),
            AbiValue::Integer(i128::from(offer.give_token_id)),
            AbiValue::Integer(i128::from(offer.give_token_decimals)),
            AbiValue::Text(offer.give_amount.to_string()),
            AbiValue::Integer(i128::from(offer.want_token_id)),
            AbiValue::Integer(i128::from(offer.want_token_decimals)),
            AbiValue::Text(offer.want_amount.to_string()),
            AbiValue::Text(offer.max_fee.to_string()),
            AbiValue::Text(offer.min_net_receive.to_string()),
            AbiValue::Text(offer.price_ticks.to_string()),
            offer
                .time_in_force
                .map_or(AbiValue::Nil, |value| AbiValue::Integer(i128::from(value))),
            AbiValue::Integer(i128::from(offer.maker_is_left)),
            AbiValue::Integer(i128::from(offer.created_height)),
            AbiValue::Text(offer.quantized_give.to_string()),
            AbiValue::Text(offer.quantized_want.to_string()),
        ]),
        AccountOutput::SwapCancelRequest { offer_id } => values_tuple(vec![
            AbiValue::Text("swapCancelRequest".into()),
            AbiValue::Text(offer_id.clone()),
        ]),
        AccountOutput::SwapOfferRemove {
            offer_id,
            maker_is_left,
        } => values_tuple(vec![
            AbiValue::Text("swapOfferRemove".into()),
            AbiValue::Text(offer_id.clone()),
            AbiValue::Integer(i128::from(!maker_is_left)),
        ]),
        AccountOutput::HtlcError {
            lock_id,
            hashlock,
            token_id,
            amount,
            reason,
        } => values_tuple(vec![
            AbiValue::Text("htlcError".into()),
            AbiValue::Text(lock_id.clone()),
            AbiValue::Text(hashlock.clone()),
            AbiValue::Integer(i128::from(token_id.get())),
            AbiValue::Text(amount.to_string()),
            reason.clone().map_or(AbiValue::Nil, AbiValue::Text),
        ]),
        AccountOutput::AccountSettledFinalized {
            token_id,
            j_height,
            collateral,
            ondelta,
        } => values_tuple(vec![
            AbiValue::Text("accountSettledFinalized".into()),
            AbiValue::Integer(i128::from(token_id.get())),
            AbiValue::Integer(i128::from(*j_height)),
            AbiValue::Text(collateral.to_string()),
            AbiValue::Text(ondelta.to_string()),
        ]),
    }
}

fn verdict_value(verdict: &AccountVerdict) -> AbiValue {
    match verdict {
        AccountVerdict::Applied => values_tuple(vec![AbiValue::Text("applied".into())]),
        AccountVerdict::Rejected(rejection) => {
            let kind = match rejection {
                AccountRejection::Validation(_) => "validation",
                AccountRejection::DeltaRowLimitExceeded { .. } => "delta_row_limit_exceeded",
                AccountRejection::HtlcLockCapacity { .. } => "htlc_lock_capacity",
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
    lock_ids: &BTreeSet<String>,
) -> Result<AbiValue, Box<dyn Error>> {
    let rows = observable_rows(replica, tokens);
    let locks = observable_locks(replica, lock_ids);
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
        values_tuple(transition.outputs().iter().map(output_value).collect()),
        values_tuple(rows.iter().map(|delta| delta_value(delta)).collect()),
        values_tuple(locks.iter().map(|lock| lock_value(lock)).collect()),
        values_tuple(vec![
            AbiValue::Bytes(replica.state().deltas_root().to_vec()),
            AbiValue::Bytes(replica.state().htlc_locks_root().to_vec()),
            AbiValue::Bytes(
                replica
                    .state()
                    .payment_profile_account_state_root()?
                    .to_vec(),
            ),
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
    let mut lock_ids = BTreeSet::new();
    let mut steps = Vec::new();
    for case in tuple(&body[2])? {
        let fields = tuple(case)?;
        if fields.len() != 4 {
            return Err(invalid("DIFFERENTIAL_CASE_ARITY").into());
        }
        let id = text(&fields[0])?.to_owned();
        let tx = parse_tx(&fields[3])?;
        if let AccountTx::AddDelta { token_id }
        | AccountTx::SetCreditLimit { token_id, .. }
        | AccountTx::DirectPayment { token_id, .. } = &tx
        {
            tokens.insert(*token_id);
        }
        if let AccountTx::HtlcLock(lock) = &tx {
            tokens.insert(lock.token_id);
            lock_ids.insert(lock.lock_id.clone());
        } else if let AccountTx::HtlcResolve(resolve) = &tx {
            lock_ids.insert(resolve.lock_id.clone());
        }
        let proposer = side(&fields[1])?;
        let transition = match context(&fields[2])? {
            Some(context) => {
                SequentialAccountEngine::apply_with_context(&replica, proposer, &tx, &context)?
            }
            None => SequentialAccountEngine::apply(&replica, proposer, &tx)?,
        };
        let next = transition.candidate().unwrap_or(&replica);
        steps.push(step_value(id, &transition, next, &tokens, &lock_ids)?);
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

fn run() -> Result<(), Box<dyn Error>> {
    let mut input = Vec::new();
    io::stdin().read_to_end(&mut input)?;
    let response = execute(decode_envelope(&input, REQUEST_ARITY)?)?;
    io::stdout().write_all(&encode_envelope(&response)?)?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("DIFFERENTIAL_ERROR:{error:#}");
        std::process::exit(1);
    }
}

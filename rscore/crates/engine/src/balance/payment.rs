use num_bigint::BigInt;

use crate::delta::max_payment_amount;
use crate::mutation::MutationDecision;
use crate::{
    AccountOutput, AccountRejection, AccountReplica, DeliveryMode, Side, TokenId, TransitionError,
    ValidationRejection,
};

const MAX_ROUTE_HOPS: usize = 100;

#[derive(Clone, Copy)]
pub(crate) struct DirectPayment<'a> {
    pub token_id: TokenId,
    pub amount: &'a BigInt,
    pub route: &'a [String],
    pub description: Option<&'a String>,
    pub from_entity_id: &'a str,
    pub to_entity_id: &'a str,
    pub delivery_mode: DeliveryMode,
    pub trusted_gateway_entity_id: Option<&'a String>,
}

pub(crate) fn direct_payment(
    replica: &mut AccountReplica,
    payment: DirectPayment<'_>,
    proposer: Side,
) -> Result<MutationDecision, TransitionError> {
    if let Some(reason) = validate_envelope(payment) {
        return Ok(rejected(reason));
    }
    let parties = payment_parties(replica, proposer);
    if !direction_matches(payment, &parties) {
        return Ok(rejected(ValidationRejection::PaymentDirection));
    }
    if let Some(reason) = validate_route(payment, &parties) {
        return Ok(rejected(reason));
    }
    let forward = build_forward(replica, payment, &parties)?;
    let mut delta = replica.state().delta_or_zero(payment.token_id)?;
    let available = delta.perspective(proposer).out_capacity;
    if payment.amount > &available {
        return Ok(rejected(ValidationRejection::InsufficientCapacity {
            payer_suffix: last_four(&parties.payer),
            required: payment.amount.clone(),
            available,
        }));
    }
    delta.apply_transfer(proposer, payment.amount)?;
    replica.state_mut().put_delta(delta)?;
    let events = payment_events(replica, payment, &parties, proposer, forward.as_ref());
    Ok(MutationDecision::with_outputs(
        events,
        forward.into_iter().collect(),
    ))
}

struct PaymentParties {
    payer: String,
    recipient: String,
}

fn payment_parties(replica: &AccountReplica, proposer: Side) -> PaymentParties {
    let identity = replica.state().identity();
    PaymentParties {
        payer: identity.entity(proposer).to_string(),
        recipient: identity.entity(proposer.opposite()).to_string(),
    }
}

fn validate_envelope(payment: DirectPayment<'_>) -> Option<ValidationRejection> {
    let minimum = BigInt::from(1);
    let maximum = max_payment_amount();
    if payment.amount < &minimum || payment.amount > &maximum {
        return Some(ValidationRejection::PaymentAmount {
            amount: payment.amount.clone(),
            minimum,
            maximum,
        });
    }
    if payment.route.is_empty() || payment.route.len() > MAX_ROUTE_HOPS {
        return Some(ValidationRejection::RouteLength {
            length: payment.route.len(),
            maximum: MAX_ROUTE_HOPS,
        });
    }
    match (payment.delivery_mode, payment.trusted_gateway_entity_id) {
        (DeliveryMode::Direct, Some(_)) => Some(ValidationRejection::DirectGatewayForbidden),
        (DeliveryMode::Trusted, None) => Some(ValidationRejection::TrustedGatewayRequired),
        (DeliveryMode::Trusted, Some(gateway)) if gateway.is_empty() => {
            Some(ValidationRejection::TrustedGatewayRequired)
        }
        _ => None,
    }
}

fn direction_matches(payment: DirectPayment<'_>, parties: &PaymentParties) -> bool {
    (payment.from_entity_id.is_empty() || same_entity(payment.from_entity_id, &parties.payer))
        && (payment.to_entity_id.is_empty()
            || same_entity(payment.to_entity_id, &parties.recipient))
}

fn validate_route(
    payment: DirectPayment<'_>,
    parties: &PaymentParties,
) -> Option<ValidationRejection> {
    if payment.delivery_mode == DeliveryMode::Direct {
        let valid = payment.route.len() == 1 && same_entity(&payment.route[0], &parties.recipient);
        return (!valid).then_some(ValidationRejection::DirectRoute);
    }
    trusted_route_error(payment, parties)
}

fn trusted_route_error(
    payment: DirectPayment<'_>,
    parties: &PaymentParties,
) -> Option<ValidationRejection> {
    let gateway = payment.trusted_gateway_entity_id?;
    if same_entity(&parties.payer, gateway) {
        let valid = payment.route.len() == 1 && same_entity(&payment.route[0], &parties.recipient);
        return (!valid).then_some(ValidationRejection::TrustedRoute);
    }
    let valid = payment.route.len() == 2
        && same_entity(&parties.recipient, gateway)
        && same_entity(&payment.route[0], &parties.recipient)
        && !payment.route[1].is_empty()
        && !same_entity(&payment.route[1], gateway)
        && !same_entity(&payment.route[1], &parties.payer);
    (!valid).then_some(ValidationRejection::TrustedRoute)
}

fn build_forward(
    replica: &AccountReplica,
    payment: DirectPayment<'_>,
    parties: &PaymentParties,
) -> Result<Option<AccountOutput>, TransitionError> {
    if same_entity(&parties.payer, &replica.owner().to_string()) || payment.route.len() == 1 {
        return Ok(None);
    }
    let current = payment
        .route
        .first()
        .ok_or(TransitionError::TrustedPaymentForwardContextMissing)?;
    let next = payment
        .route
        .get(1)
        .ok_or(TransitionError::TrustedPaymentForwardContextMissing)?;
    let final_target = payment
        .route
        .last()
        .ok_or(TransitionError::TrustedPaymentForwardContextMissing)?;
    let gateway = payment
        .trusted_gateway_entity_id
        .ok_or(TransitionError::TrustedPaymentForwardContextMissing)?;
    if !same_entity(current, &replica.owner().to_string()) || same_entity(current, final_target) {
        return Err(TransitionError::TrustedPaymentForwardGatewayMismatch);
    }
    if same_entity(&replica.counterparty().to_string(), next) {
        return Err(TransitionError::TrustedPaymentForwardLoop);
    }
    Ok(Some(AccountOutput::DirectPaymentForward {
        token_id: payment.token_id,
        amount: payment.amount.clone(),
        route: payment.route.to_vec(),
        description: payment
            .description
            .filter(|value| !value.is_empty())
            .cloned(),
        delivery_mode: DeliveryMode::Trusted,
        trusted_gateway_entity_id: gateway.clone(),
    }))
}

fn payment_events(
    replica: &AccountReplica,
    payment: DirectPayment<'_>,
    parties: &PaymentParties,
    proposer: Side,
    forward: Option<&AccountOutput>,
) -> Vec<String> {
    let note = payment
        .description
        .filter(|value| !value.is_empty())
        .map_or(String::new(), |value| format!("({value})"));
    let main = if proposer == replica.owner_side() {
        format!(
            "💸 Sent {} token {} to Entity {} {note}",
            payment.amount,
            payment.token_id,
            last_four(&replica.counterparty().to_string())
        )
    } else {
        format!(
            "💰 Received {} token {} from Entity {} {note}",
            payment.amount,
            payment.token_id,
            last_four(&parties.payer)
        )
    };
    let mut events = vec![main];
    if let Some(AccountOutput::DirectPaymentForward { route, .. }) = forward
        && let Some(target) = route.last()
    {
        events.push(format!(
            "↪️ Forwarding payment to {} via {} more hops",
            last_four(target),
            route.len() - 1
        ));
    }
    events
}

fn rejected(reason: ValidationRejection) -> MutationDecision {
    MutationDecision::rejected(AccountRejection::Validation(reason))
}

fn same_entity(left: &str, right: &str) -> bool {
    left.eq_ignore_ascii_case(right)
}

fn last_four(value: &str) -> String {
    let reversed = value.chars().rev().take(4).collect::<Vec<_>>();
    reversed.into_iter().rev().collect()
}

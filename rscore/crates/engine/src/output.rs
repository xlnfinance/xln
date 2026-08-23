use num_bigint::BigInt;

use crate::{DeliveryMode, TokenId};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccountOutput {
    DirectPaymentForward {
        token_id: TokenId,
        amount: BigInt,
        route: Vec<String>,
        description: Option<String>,
        delivery_mode: DeliveryMode,
        trusted_gateway_entity_id: String,
    },
}

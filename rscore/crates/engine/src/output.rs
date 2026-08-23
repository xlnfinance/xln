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
    HtlcSecret {
        lock_id: String,
        hashlock: String,
        secret: String,
        token_id: TokenId,
        amount: BigInt,
    },
    HtlcError {
        lock_id: String,
        hashlock: String,
        token_id: TokenId,
        amount: BigInt,
        reason: Option<String>,
    },
}

use num_bigint::BigInt;

use crate::swap::SwapOfferSnapshot;
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
    /// Full same-j resting row after creation or partial resolution.
    /// Parity target: `core/account/tx/same-j-swap-output.ts`.
    SwapOfferUpsert { offer: Box<SwapOfferSnapshot> },
    /// Same-j resting row removed by a committed full/cancel resolution.
    SwapOfferRemove { offer_id: String },
    /// Maker's committed request for the orderbook owner to resolve.
    SwapCancelRequest { offer_id: String },
    HtlcError {
        lock_id: String,
        hashlock: String,
        token_id: TokenId,
        amount: BigInt,
        reason: Option<String>,
    },
}

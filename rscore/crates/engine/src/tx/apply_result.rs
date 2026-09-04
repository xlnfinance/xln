use num_bigint::BigInt;

use crate::swap::SwapOfferSnapshot;
use crate::{DeliveryMode, TokenId};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccountOutput {
    /// A fresh collateral request became committed Account state. The local
    /// owner/counterparty pair is carried explicitly because both bilateral
    /// replicas publish their own receipt after their respective commit.
    RequestCollateralCommitted {
        entity_id: String,
        account_id: String,
        token_id: TokenId,
        requested_amount: BigInt,
        prepaid_fee: BigInt,
        requested_at: u64,
    },
    AccountSettledFinalized {
        token_id: TokenId,
        j_height: u64,
        collateral: BigInt,
        ondelta: BigInt,
    },
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
    ///
    /// The removed row is no longer resident after the transition, so the
    /// parent cannot recover its owner from the post-state. Carry the exact
    /// side observed by the Account transition instead of asking a stale
    /// parent read model to infer it.
    SwapOfferRemove {
        offer_id: String,
        maker_is_left: bool,
    },
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

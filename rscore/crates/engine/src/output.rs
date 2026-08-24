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
    /// Entity-level view of a created same-j offer: the maker side, the two
    /// account entities and the effective (quantized) terms.
    SwapOfferCreated {
        offer_id: String,
        maker_is_left: bool,
        from_entity: String,
        to_entity: String,
        created_height: u64,
        give_token_id: u32,
        give_token_decimals: u32,
        give_amount: BigInt,
        want_token_id: u32,
        want_token_decimals: u32,
        want_amount: BigInt,
        max_fee: BigInt,
        min_net_receive: BigInt,
        price_ticks: BigInt,
        time_in_force: Option<u8>,
    },
    /// The maker asked to cancel; the resting row is untouched until the
    /// counterparty resolves.
    SwapCancelRequested { offer_id: String },
    /// The resting row was closed by a resolve: filled, cancelled, or dusted.
    SwapOfferCancelled {
        offer_id: String,
        account_id: String,
    },
    HtlcError {
        lock_id: String,
        hashlock: String,
        token_id: TokenId,
        amount: BigInt,
        reason: Option<String>,
    },
}

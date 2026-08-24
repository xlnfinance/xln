//! Resting same-jurisdiction swap offers.
//!
//! Parity target: `core/account/tx/handlers/swap/offer/*.ts`. A cross-j offer
//! is not represented here — its route, pulls and settlement live outside the
//! payment profile — and the wire refuses to encode one rather than pretending
//! to execute it.

use num_bigint::BigInt;
use xln_rscore_protocol::CanonicalValue;

/// Total, same-j and per-side-per-market ceilings (core/config/constants.ts).
pub const MAX_ACCOUNT_SWAP_OFFERS: usize = 38;
pub const MAX_ACCOUNT_SAME_J_SWAP_OFFERS: usize = 20;
pub const MAX_ACCOUNT_SWAP_OFFERS_PER_SIDE_PER_MARKET: usize = 20;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapOffer {
    offer_id: String,
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
    maker_is_left: bool,
    created_height: u64,
    quantized_give: BigInt,
    quantized_want: BigInt,
}

#[allow(clippy::too_many_arguments)]
impl SwapOffer {
    pub fn new(
        offer_id: String,
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
        maker_is_left: bool,
        created_height: u64,
    ) -> Self {
        Self {
            offer_id,
            give_token_id,
            give_token_decimals,
            quantized_give: give_amount.clone(),
            give_amount,
            want_token_id,
            want_token_decimals,
            quantized_want: want_amount.clone(),
            want_amount,
            max_fee,
            min_net_receive,
            price_ticks,
            time_in_force,
            maker_is_left,
            created_height,
        }
    }

    pub fn offer_id(&self) -> &str {
        &self.offer_id
    }

    pub const fn maker_is_left(&self) -> bool {
        self.maker_is_left
    }

    pub const fn give_token_id(&self) -> u32 {
        self.give_token_id
    }

    pub const fn want_token_id(&self) -> u32 {
        self.want_token_id
    }

    pub const fn give_amount(&self) -> &BigInt {
        &self.give_amount
    }

    /// The market this offer rests in, for the per-side ceiling. Same-j only,
    /// so the key is the directed token pair.
    pub fn market_key(&self) -> String {
        format!("same:{}>{}", self.give_token_id, self.want_token_id)
    }

    /// Field-for-field the TypeScript SwapOffer object; absent optional keys
    /// are omitted exactly as TypeScript drops undefined before encoding.
    pub fn canonical(&self) -> CanonicalValue {
        let mut fields = vec![
            (
                "offerId".into(),
                CanonicalValue::String(self.offer_id.clone()),
            ),
            (
                "giveTokenId".into(),
                CanonicalValue::Number(f64::from(self.give_token_id)),
            ),
            (
                "giveTokenDecimals".into(),
                CanonicalValue::Number(f64::from(self.give_token_decimals)),
            ),
            (
                "giveAmount".into(),
                CanonicalValue::BigInt(self.give_amount.clone()),
            ),
            (
                "wantTokenId".into(),
                CanonicalValue::Number(f64::from(self.want_token_id)),
            ),
            (
                "wantTokenDecimals".into(),
                CanonicalValue::Number(f64::from(self.want_token_decimals)),
            ),
            (
                "wantAmount".into(),
                CanonicalValue::BigInt(self.want_amount.clone()),
            ),
            (
                "maxFee".into(),
                CanonicalValue::BigInt(self.max_fee.clone()),
            ),
            (
                "minNetReceive".into(),
                CanonicalValue::BigInt(self.min_net_receive.clone()),
            ),
            (
                "priceTicks".into(),
                CanonicalValue::BigInt(self.price_ticks.clone()),
            ),
            (
                "makerIsLeft".into(),
                CanonicalValue::Bool(self.maker_is_left),
            ),
            (
                "createdHeight".into(),
                CanonicalValue::Number(self.created_height as f64),
            ),
            (
                "quantizedGive".into(),
                CanonicalValue::BigInt(self.quantized_give.clone()),
            ),
            (
                "quantizedWant".into(),
                CanonicalValue::BigInt(self.quantized_want.clone()),
            ),
        ];
        if let Some(time_in_force) = self.time_in_force {
            fields.push((
                "timeInForce".into(),
                CanonicalValue::Number(f64::from(time_in_force)),
            ));
        }
        CanonicalValue::Object(fields)
    }
}

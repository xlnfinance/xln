//! Resting swap offers.
//!
//! Parity target: `core/account/tx/handlers/swap/offer/*.ts`. A cross-j offer
//! is not represented here — its route, pulls and settlement live outside the
//! payment profile — and the wire refuses to encode one rather than pretending
//! to execute it.

use num_bigint::BigInt;
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use crate::StateError;

/// The Entity-visible view of one resting row.
/// Parity target: `AccountSwapOfferSnapshot` (core/types/account.ts).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapOfferSnapshot {
    pub offer_id: String,
    pub left_entity: String,
    pub right_entity: String,
    pub give_token_id: u32,
    pub give_token_decimals: u32,
    pub give_amount: BigInt,
    pub want_token_id: u32,
    pub want_token_decimals: u32,
    pub want_amount: BigInt,
    pub max_fee: BigInt,
    pub min_net_receive: BigInt,
    pub price_ticks: BigInt,
    pub time_in_force: Option<u8>,
    pub maker_is_left: bool,
    pub created_height: u64,
    pub quantized_give: BigInt,
    pub quantized_want: BigInt,
    pub cross_jurisdiction: Option<CanonicalValue>,
}

/// Total, same-j and per-side-per-market ceilings (core/config/constants.ts).
pub const MAX_ACCOUNT_SWAP_OFFERS: usize = 50;
pub const MAX_ACCOUNT_SAME_J_SWAP_OFFERS: usize = 32;
pub const MAX_ACCOUNT_CROSS_J_SWAP_OFFERS: usize = 18;
pub const MAX_ACCOUNT_SWAP_OFFERS_PER_SIDE_PER_MARKET: usize = 32;

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
    cross_jurisdiction: Option<CanonicalValue>,
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
            cross_jurisdiction: None,
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

    pub const fn want_amount(&self) -> &BigInt {
        &self.want_amount
    }

    pub const fn quantized_give(&self) -> &BigInt {
        &self.quantized_give
    }

    pub const fn quantized_want(&self) -> &BigInt {
        &self.quantized_want
    }

    pub const fn price_ticks(&self) -> &BigInt {
        &self.price_ticks
    }

    pub const fn max_fee(&self) -> &BigInt {
        &self.max_fee
    }

    pub const fn min_net_receive(&self) -> &BigInt {
        &self.min_net_receive
    }

    pub const fn give_token_decimals(&self) -> u32 {
        self.give_token_decimals
    }

    pub const fn want_token_decimals(&self) -> u32 {
        self.want_token_decimals
    }

    pub const fn time_in_force(&self) -> Option<u8> {
        self.time_in_force
    }

    pub const fn created_height(&self) -> u64 {
        self.created_height
    }

    pub const fn cross_jurisdiction(&self) -> Option<&CanonicalValue> {
        self.cross_jurisdiction.as_ref()
    }

    pub fn set_cross_jurisdiction(&mut self, route: Option<CanonicalValue>) {
        self.cross_jurisdiction = route;
    }

    /// Restore the exact committed quantized lots. They normally equal the
    /// effective resting amounts, but are committed fields in their own right
    /// and a checkpoint must not infer them.
    pub fn restore_quantized(
        &mut self,
        quantized_give: BigInt,
        quantized_want: BigInt,
    ) -> Result<(), crate::StateError> {
        let zero = BigInt::from(0);
        if quantized_give <= zero
            || quantized_want <= zero
            || quantized_give > self.give_amount
            || quantized_want > self.want_amount
        {
            return Err(crate::StateError::CheckpointRestore(
                "SWAP_OFFER_QUANTIZED_BOUNDS".to_string(),
            ));
        }
        self.quantized_give = quantized_give;
        self.quantized_want = quantized_want;
        Ok(())
    }

    /// The market this offer rests in, for the per-side ceiling. Same-j only,
    /// so the key is the directed token pair.
    /// The snapshot the Entity layer consumes, read from the committed row.
    pub fn snapshot(&self, left_entity: String, right_entity: String) -> SwapOfferSnapshot {
        SwapOfferSnapshot {
            offer_id: self.offer_id.clone(),
            left_entity,
            right_entity,
            give_token_id: self.give_token_id,
            give_token_decimals: self.give_token_decimals,
            give_amount: self.give_amount.clone(),
            want_token_id: self.want_token_id,
            want_token_decimals: self.want_token_decimals,
            want_amount: self.want_amount.clone(),
            max_fee: self.max_fee.clone(),
            min_net_receive: self.min_net_receive.clone(),
            price_ticks: self.price_ticks.clone(),
            time_in_force: self.time_in_force,
            maker_is_left: self.maker_is_left,
            created_height: self.created_height,
            quantized_give: self.quantized_give.clone(),
            quantized_want: self.quantized_want.clone(),
            cross_jurisdiction: self.cross_jurisdiction.clone(),
        }
    }

    pub fn market_key(&self) -> String {
        format!("same:{}>{}", self.give_token_id, self.want_token_id)
    }

    /// Field-for-field the TypeScript SwapOffer object; absent optional keys
    /// are omitted exactly as TypeScript drops undefined before encoding.
    pub fn canonical(&self) -> Result<CanonicalValue, StateError> {
        let created_height = CanonicalNumber::try_from_u64(self.created_height)
            .map(CanonicalValue::Number)
            .map_err(|error| StateError::AccountStateRoot(error.to_string()))?;
        let mut fields = vec![
            (
                "offerId".into(),
                CanonicalValue::String(self.offer_id.clone()),
            ),
            (
                "giveTokenId".into(),
                CanonicalValue::Number(CanonicalNumber::from_u32(self.give_token_id)),
            ),
            (
                "giveTokenDecimals".into(),
                CanonicalValue::Number(CanonicalNumber::from_u32(self.give_token_decimals)),
            ),
            (
                "giveAmount".into(),
                CanonicalValue::BigInt(self.give_amount.clone()),
            ),
            (
                "wantTokenId".into(),
                CanonicalValue::Number(CanonicalNumber::from_u32(self.want_token_id)),
            ),
            (
                "wantTokenDecimals".into(),
                CanonicalValue::Number(CanonicalNumber::from_u32(self.want_token_decimals)),
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
            ("createdHeight".into(), created_height),
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
                CanonicalValue::Number(CanonicalNumber::from_u32(u32::from(time_in_force))),
            ));
        }
        if let Some(route) = &self.cross_jurisdiction {
            fields.push(("crossJurisdiction".into(), route.clone()));
        }
        Ok(CanonicalValue::Object(fields))
    }
}

#[cfg(test)]
mod tests {
    use num_bigint::BigInt;
    use sha2::{Digest as _, Sha256};

    use super::SwapOffer;

    fn bigint(value: &str) -> BigInt {
        BigInt::parse_bytes(value.as_bytes(), 10).expect("decimal bigint")
    }

    #[test]
    fn committed_offer_digest_matches_typescript() {
        let offer = SwapOffer::new(
            "mm-4f043e-2-1-ask-1".into(),
            2,
            18,
            bigint("10179996000000000000"),
            1,
            6,
            bigint("25455079998"),
            bigint("2545508"),
            bigint("25452534490"),
            bigint("25005000"),
            None,
            true,
            21,
        );
        let encoded = xln_rscore_protocol::encode_account_state_value(
            &offer.canonical().expect("canonical value"),
        )
        .expect("canonical offer");
        assert_eq!(
            hex::encode(Sha256::digest(encoded)),
            "2bcadbbf04f98b128428cb9e48e45e156ff000977c4f306c211a0386ec05c534",
        );
    }
}

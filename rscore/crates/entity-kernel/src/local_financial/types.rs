use num_bigint::BigInt;
use std::collections::BTreeMap;

use xln_rscore_engine::{DeliveryMode, TokenId};

use crate::types::OriginatedHtlcDeliveryMode;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirectPaymentEntityTx {
    pub target_entity_id: String,
    pub token_id: TokenId,
    pub amount: BigInt,
    pub route: Vec<String>,
    pub description: Option<String>,
    pub delivery_mode: DeliveryMode,
    pub trusted_gateway_entity_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HtlcPaymentEntityTx {
    pub target_entity_id: String,
    pub token_id: TokenId,
    pub amount: BigInt,
    pub max_sender_debit: BigInt,
    pub route: Vec<String>,
    pub description: Option<String>,
    pub delivery_mode: OriginatedHtlcDeliveryMode,
    pub started_at_ms: Option<u64>,
    pub hashlock: Option<String>,
    pub tx_hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlaceSwapOfferEntityTx {
    pub counterparty_entity_id: String,
    pub offer_id: String,
    pub give_token_id: u32,
    pub give_token_decimals: u32,
    pub give_amount: BigInt,
    pub want_token_id: u32,
    pub want_token_decimals: u32,
    pub want_amount: BigInt,
    pub max_fee: BigInt,
    pub min_net_receive: BigInt,
    pub price_ticks: Option<BigInt>,
    pub time_in_force: Option<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProposeCancelSwapEntityTx {
    pub counterparty_entity_id: String,
    pub offer_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtendCreditEntityTx {
    pub counterparty_entity_id: String,
    pub token_id: TokenId,
    pub amount: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LocalEntityFinancialTx {
    DirectPayment(DirectPaymentEntityTx),
    ExtendCredit(ExtendCreditEntityTx),
    HtlcPayment(HtlcPaymentEntityTx),
    PlaceSwapOffer(PlaceSwapOfferEntityTx),
    ProposeCancelSwap(ProposeCancelSwapEntityTx),
}

/// Compact post-inbound Account projection used by Entity-local financial
/// admission. No replica, radix node, mempool or consensus envelope crosses
/// the permanent Account-worker boundary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LocalAccountFinancialView {
    pub active: bool,
    pub owner_out_capacity: BTreeMap<TokenId, BigInt>,
}

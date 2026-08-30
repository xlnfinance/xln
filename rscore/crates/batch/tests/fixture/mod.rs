//! Shared identities, funded account state and canonical transactions for the
//! resident consensus-engine tests, driven the way the runtime drives them.

// Each test binary uses a different part of the fixture.
#![allow(dead_code)]

use num_bigint::BigInt;
use xln_rscore_batch::{AccountId, ReceiverClock};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountIdentity, AccountState, AccountTx, BoardDelays,
    DeliveryMode, Delta, DepositoryAddress, EntityId, SigningIdentity, TokenId, WatchSeed,
};

/// The key the runtime would derive for a signer label, which is what the
/// engine is handed now — it never sees the seed.
pub fn signer_key(signer_id: &str) -> [u8; 32] {
    xln_rscore_engine::derive_signer_key(SEED, signer_id).expect("signer key")
}

pub fn signing_identity(signer_id: &str) -> SigningIdentity {
    SigningIdentity::lazy_from_seed(SEED, signer_id, 1, 1, BoardDelays::default())
        .expect("signing identity")
}

pub const SEED: &str = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";

// ------------------------------------------------------------- the fixture

pub fn hex_of(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

pub fn entity_of(signer_id: &str) -> ([u8; 32], EntityId) {
    let identity = signing_identity(signer_id);
    let bytes = *identity.entity_id();
    let parsed = EntityId::parse(&format!("0x{}", hex_of(&bytes))).expect("entity");
    (bytes, parsed)
}

pub fn account_state(left: &EntityId, right: &EntityId) -> AccountState {
    let domain = AccountDomain::new(
        31_337,
        DepositoryAddress::parse(&format!("0x{}", "88".repeat(20))).expect("depository"),
    )
    .expect("domain");
    let identity = AccountIdentity::new(
        domain,
        left.clone(),
        right.clone(),
        WatchSeed::parse(&format!("0x{}", "99".repeat(32))).expect("watch seed"),
    )
    .expect("identity");
    let delta = Delta::new(
        TokenId::new(1).expect("token"),
        BigInt::from(1_000_000_000),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(500_000_000),
        BigInt::from(500_000_000),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(0),
        BigInt::from(0),
    )
    .expect("delta");
    AccountState::new(
        identity,
        AccountDisputeConfig::new(10, 10).expect("dispute config"),
        vec![delta],
    )
    .expect("state")
}

pub struct Pair {
    pub payer_account: AccountId,
    pub payee_account: AccountId,
    pub payer: EntityId,
    pub payee: EntityId,
    pub payer_entity: [u8; 32],
    pub payee_entity: [u8; 32],
}

/// The `payer-0`/`payee-0` account pair every single-account test runs on,
/// seen from the payer's side.
pub fn pair() -> Pair {
    let (payer_bytes, payer) = entity_of("payer-0");
    let (payee_bytes, payee) = entity_of("payee-0");
    Pair {
        payer_account: AccountId::from_bytes(payee_bytes),
        payee_account: AccountId::from_bytes(payer_bytes),
        payer,
        payee,
        payer_entity: payer_bytes,
        payee_entity: payee_bytes,
    }
}

/// The registry tables the runtime installs with Hello. They are not account
/// state, so an engine that never received them prices swaps differently from
/// TypeScript — which is why the market is a constructor argument and not a
/// default.
pub fn market() -> std::sync::Arc<xln_rscore_engine::SwapMarketPolicy> {
    std::sync::Arc::new(xln_rscore_engine::SwapMarketPolicy::new(
        vec![
            xln_rscore_engine::SwapToken {
                token_id: 1,
                decimals: 6,
                liquid: false,
            },
            xln_rscore_engine::SwapToken {
                token_id: 2,
                decimals: 6,
                liquid: true,
            },
        ],
        Vec::new(),
    ))
}

/// The receiver's clock, level with the frame being applied.
pub fn clock(timestamp: u64) -> ReceiverClock {
    ReceiverClock {
        entity_timestamp: timestamp,
        finalized_j_height: 100,
    }
}

pub fn payment(pair: &Pair, amount: i64) -> (AccountId, Vec<AccountTx>) {
    (
        pair.payer_account,
        vec![AccountTx::DirectPayment {
            token_id: TokenId::new(1).expect("token"),
            amount: BigInt::from(amount),
            route: vec![pair.payee.to_string()],
            description: None,
            from_entity_id: pair.payer.to_string(),
            to_entity_id: pair.payee.to_string(),
            delivery_mode: DeliveryMode::Direct,
            trusted_gateway_entity_id: None,
        }],
    )
}

/// A maker offer on the funded token. Six decimals so one lot is one unit:
/// the point of the transaction is which market priced it, not its size.
pub fn swap_offer(pair: &Pair) -> (AccountId, Vec<AccountTx>) {
    (
        pair.payer_account,
        vec![AccountTx::SwapOffer {
            offer_id: "offer-1".to_string(),
            give_token_id: 1,
            give_token_decimals: 6,
            give_amount: BigInt::from(1_000_000),
            want_token_id: 2,
            want_token_decimals: 6,
            want_amount: BigInt::from(2_000_000),
            max_fee: BigInt::from(0),
            min_net_receive: BigInt::from(1_900_000),
            time_in_force: None,
            price_ticks: None,
            cross_jurisdiction: None,
        }],
    )
}

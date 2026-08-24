//! Market policy: the registry-derived inputs swap quantization needs.
//!
//! Pair orientation and the price step live in the TypeScript token registry
//! (`core/account/utils.ts`), not in the account state, so the engine cannot
//! derive them. Copying the tables here would create a second source of truth
//! that drifts silently; instead the runtime installs them once, and the digest
//! of the installed policy is compared against the one TypeScript computes.

use std::collections::BTreeMap;

use num_bigint::BigInt;
use sha2::{Digest, Sha256};

/// Book quantities keep six decimal places of base precision.
const LOT_DECIMALS: u32 = 6;
pub const ORDERBOOK_PRICE_SCALE: i64 = 10_000;
const DEFAULT_PRICE_STEP_TICKS: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SwapToken {
    pub token_id: u32,
    pub decimals: u32,
    /// Reference stable assets quote the pair instead of basing it.
    pub liquid: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SwapMarketPolicy {
    tokens: BTreeMap<u32, SwapToken>,
    /// Static price step by (base, quote); absent pairs use the default.
    steps: BTreeMap<(u32, u32), u32>,
}

impl SwapMarketPolicy {
    pub fn new(tokens: Vec<SwapToken>, steps: Vec<((u32, u32), u32)>) -> Self {
        Self {
            tokens: tokens
                .into_iter()
                .map(|token| (token.token_id, token))
                .collect(),
            steps: steps.into_iter().collect(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty()
    }

    fn liquid(&self, token_id: u32) -> bool {
        self.tokens.get(&token_id).is_some_and(|token| token.liquid)
    }

    fn registry_decimals(&self, token_id: u32) -> Option<u32> {
        self.tokens.get(&token_id).map(|token| token.decimals)
    }

    /// The liquid asset quotes the pair; otherwise the lower id is the base.
    pub fn canonical_pair(&self, token_a: u32, token_b: u32) -> (u32, u32) {
        let low = token_a.min(token_b);
        let high = token_a.max(token_b);
        match (self.liquid(token_a), self.liquid(token_b)) {
            (true, false) => (token_b, token_a),
            (false, true) => (token_a, token_b),
            _ => (low, high),
        }
    }

    /// 1 = sell base, 0 = buy base.
    pub fn derive_side(&self, give_token_id: u32, want_token_id: u32) -> u8 {
        let (base, quote) = self.canonical_pair(give_token_id, want_token_id);
        if give_token_id == base && want_token_id == quote {
            return 1;
        }
        if give_token_id == quote && want_token_id == base {
            return 0;
        }
        u8::from(give_token_id < want_token_id)
    }

    /// Static policy is authority only when the signed dimensions also match
    /// the registry: a jurisdiction-local id may reuse a built-in token number.
    pub fn price_step_ticks(
        &self,
        base_token_id: u32,
        quote_token_id: u32,
        base_decimals: u32,
        quote_decimals: u32,
    ) -> u32 {
        let matches_registry = self.registry_decimals(base_token_id) == Some(base_decimals)
            && self.registry_decimals(quote_token_id) == Some(quote_decimals);
        if !matches_registry {
            return DEFAULT_PRICE_STEP_TICKS;
        }
        self.steps
            .get(&(base_token_id, quote_token_id))
            .copied()
            .unwrap_or(DEFAULT_PRICE_STEP_TICKS)
            .max(1)
    }

    /// Digest of the installed policy, so a runtime whose registry moved is
    /// rejected instead of quietly pricing on stale tables.
    pub fn digest(&self) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(b"xln.rscore.swap-market-policy.v1");
        for token in self.tokens.values() {
            hasher.update(token.token_id.to_be_bytes());
            hasher.update(token.decimals.to_be_bytes());
            hasher.update([u8::from(token.liquid)]);
        }
        hasher.update(b"steps");
        for ((base, quote), step) in &self.steps {
            hasher.update(base.to_be_bytes());
            hasher.update(quote.to_be_bytes());
            hasher.update(step.to_be_bytes());
        }
        hasher.finalize().into()
    }
}

pub fn token_scale(decimals: u32) -> BigInt {
    BigInt::from(10).pow(decimals)
}

pub fn lot_scale(decimals: u32) -> BigInt {
    BigInt::from(10).pow(decimals.saturating_sub(LOT_DECIMALS))
}

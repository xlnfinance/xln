use std::sync::Arc;

use crate::swap::SwapMarketPolicy;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountExecutionContext {
    pub committed_timestamp: u64,
    pub enforcement_timestamp: u64,
    pub enforcement_j_height: u64,
    pub current_account_height: u64,
    /// The signed frame's own J height (`frameJHeight` in
    /// core/account/consensus): swap and pull transitions are clocked with it,
    /// not with the Entity enforcement clock.
    pub frame_j_height: u64,
    /// Registry-derived market tables. They are not account state and cannot
    /// be derived from it, so the runtime installs them with the frame.
    pub swap_market: Arc<SwapMarketPolicy>,
}

impl AccountExecutionContext {
    pub fn new(
        committed_timestamp: u64,
        enforcement_timestamp: u64,
        enforcement_j_height: u64,
        current_account_height: u64,
        frame_j_height: u64,
    ) -> Self {
        Self::with_market(
            committed_timestamp,
            enforcement_timestamp,
            enforcement_j_height,
            current_account_height,
            frame_j_height,
            Arc::new(SwapMarketPolicy::default()),
        )
    }

    pub const fn with_market(
        committed_timestamp: u64,
        enforcement_timestamp: u64,
        enforcement_j_height: u64,
        current_account_height: u64,
        frame_j_height: u64,
        swap_market: Arc<SwapMarketPolicy>,
    ) -> Self {
        Self {
            committed_timestamp,
            enforcement_timestamp,
            enforcement_j_height,
            current_account_height,
            frame_j_height,
            swap_market,
        }
    }
}

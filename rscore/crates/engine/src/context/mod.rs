#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AccountExecutionContext {
    pub committed_timestamp: u64,
    pub enforcement_timestamp: u64,
    pub enforcement_j_height: u64,
    pub current_account_height: u64,
}

impl AccountExecutionContext {
    pub const fn new(
        committed_timestamp: u64,
        enforcement_timestamp: u64,
        enforcement_j_height: u64,
        current_account_height: u64,
    ) -> Self {
        Self {
            committed_timestamp,
            enforcement_timestamp,
            enforcement_j_height,
            current_account_height,
        }
    }
}

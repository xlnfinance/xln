use num_bigint::BigInt;
use xln_rscore_engine::LendingTermId;
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue, PersistentRadixMap};

use crate::EntityKernelError;
use crate::commitment::{consensus_digest_bytes, raw_text_key};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LendingPoolStatus {
    Open,
    Closing,
    Closed,
}

impl LendingPoolStatus {
    const fn wire_name(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closing => "closing",
            Self::Closed => "closed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LendingLoanStatus {
    Opening,
    Active,
    Closing,
    Repaid,
}

impl LendingLoanStatus {
    const fn wire_name(self) -> &'static str {
        match self {
            Self::Opening => "opening",
            Self::Active => "active",
            Self::Closing => "closing",
            Self::Repaid => "repaid",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LendingPoolPosition {
    pub position_id: String,
    pub hub_entity_id: String,
    pub lender_entity_id: String,
    pub token_id: u16,
    pub principal_amount: BigInt,
    pub available_amount: BigInt,
    pub borrowed_amount: BigInt,
    pub interest_bps: u16,
    pub term_id: LendingTermId,
    pub term_ms: u64,
    pub created_at: u64,
    pub updated_at: u64,
    pub status: LendingPoolStatus,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LendingLoan {
    pub request_id: String,
    pub loan_id: String,
    pub hub_entity_id: String,
    pub borrower_entity_id: String,
    pub lender_entity_id: String,
    pub position_id: String,
    pub token_id: u16,
    pub principal_amount: BigInt,
    pub interest_amount: BigInt,
    pub repayment_amount: BigInt,
    pub repaid_amount: BigInt,
    pub interest_bps: u16,
    pub term_id: LendingTermId,
    pub term_ms: u64,
    pub opened_at: u64,
    pub due_at: u64,
    pub updated_at: u64,
    pub status: LendingLoanStatus,
}

#[derive(Clone)]
pub struct LendingState {
    pools: PersistentRadixMap<LendingPoolPosition>,
    loans: PersistentRadixMap<LendingLoan>,
}

impl std::fmt::Debug for LendingState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LendingState")
            .field("pools", &self.pools.iter().collect::<Vec<_>>())
            .field("loans", &self.loans.iter().collect::<Vec<_>>())
            .finish()
    }
}

impl PartialEq for LendingState {
    fn eq(&self, other: &Self) -> bool {
        self.pools.len() == other.pools.len()
            && self.loans.len() == other.loans.len()
            && self.pools.iter().eq(other.pools.iter())
            && self.loans.iter().eq(other.loans.iter())
    }
}

impl Eq for LendingState {}

impl LendingState {
    pub fn empty() -> Self {
        Self {
            pools: PersistentRadixMap::empty(),
            loans: PersistentRadixMap::empty(),
        }
    }

    pub fn from_entries(
        pools: impl IntoIterator<Item = LendingPoolPosition>,
        loans: impl IntoIterator<Item = LendingLoan>,
    ) -> Result<Self, EntityKernelError> {
        let mut state = Self::empty();
        for pool in pools {
            if state.pool(&pool.position_id).is_some() {
                return Err(EntityKernelError::lending("POSITION_DUPLICATE"));
            }
            state.put_pool(pool)?;
        }
        for loan in loans {
            if state.loan(&loan.loan_id).is_some() {
                return Err(EntityKernelError::lending("LOAN_DUPLICATE"));
            }
            state.put_loan(loan)?;
        }
        Ok(state)
    }

    pub fn pool(&self, position_id: &str) -> Option<&LendingPoolPosition> {
        raw_text_key(position_id)
            .ok()
            .and_then(|key| self.pools.get(&key))
    }

    pub fn loan(&self, loan_id: &str) -> Option<&LendingLoan> {
        raw_text_key(loan_id)
            .ok()
            .and_then(|key| self.loans.get(&key))
    }

    pub fn pools(&self) -> impl Iterator<Item = &LendingPoolPosition> {
        self.pools.iter().map(|(_, value)| value)
    }

    pub fn loans(&self) -> impl Iterator<Item = &LendingLoan> {
        self.loans.iter().map(|(_, value)| value)
    }

    pub(crate) fn put_pool(&mut self, pool: LendingPoolPosition) -> Result<(), EntityKernelError> {
        let key = raw_text_key(&pool.position_id)?;
        let digest = consensus_digest_bytes(&canonical_lending_pool(&pool)?)?;
        self.pools = self.pools.updated(key, pool, digest).map_err(radix_error)?;
        Ok(())
    }

    pub(crate) fn put_loan(&mut self, loan: LendingLoan) -> Result<(), EntityKernelError> {
        let key = raw_text_key(&loan.loan_id)?;
        let digest = consensus_digest_bytes(&canonical_lending_loan(&loan)?)?;
        self.loans = self.loans.updated(key, loan, digest).map_err(radix_error)?;
        Ok(())
    }
}

impl Default for LendingState {
    fn default() -> Self {
        Self::empty()
    }
}

fn radix_error(error: impl std::fmt::Display) -> EntityKernelError {
    EntityKernelError::CommitmentEncoding {
        detail: format!("LENDING_RADIX:{error}"),
    }
}

fn text(value: impl Into<String>) -> CanonicalValue {
    CanonicalValue::String(value.into())
}

fn number(field: &'static str, value: u64) -> Result<CanonicalValue, EntityKernelError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|_| EntityKernelError::CommitmentUnsafeNumber { field, value })
}

fn object(entries: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
    CanonicalValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

pub(crate) fn canonical_lending_pool(
    pool: &LendingPoolPosition,
) -> Result<CanonicalValue, EntityKernelError> {
    Ok(object(vec![
        ("positionId", text(&pool.position_id)),
        ("hubEntityId", text(&pool.hub_entity_id)),
        ("lenderEntityId", text(&pool.lender_entity_id)),
        (
            "tokenId",
            number("lending.pool.tokenId", u64::from(pool.token_id))?,
        ),
        (
            "principalAmount",
            CanonicalValue::BigInt(pool.principal_amount.clone()),
        ),
        (
            "availableAmount",
            CanonicalValue::BigInt(pool.available_amount.clone()),
        ),
        (
            "borrowedAmount",
            CanonicalValue::BigInt(pool.borrowed_amount.clone()),
        ),
        (
            "interestBps",
            number("lending.pool.interestBps", u64::from(pool.interest_bps))?,
        ),
        ("termId", text(pool.term_id.wire_name())),
        ("termMs", number("lending.pool.termMs", pool.term_ms)?),
        (
            "createdAt",
            number("lending.pool.createdAt", pool.created_at)?,
        ),
        (
            "updatedAt",
            number("lending.pool.updatedAt", pool.updated_at)?,
        ),
        ("status", text(pool.status.wire_name())),
    ]))
}

pub(crate) fn canonical_lending_loan(
    loan: &LendingLoan,
) -> Result<CanonicalValue, EntityKernelError> {
    Ok(object(vec![
        ("requestId", text(&loan.request_id)),
        ("loanId", text(&loan.loan_id)),
        ("hubEntityId", text(&loan.hub_entity_id)),
        ("borrowerEntityId", text(&loan.borrower_entity_id)),
        ("lenderEntityId", text(&loan.lender_entity_id)),
        ("positionId", text(&loan.position_id)),
        (
            "tokenId",
            number("lending.loan.tokenId", u64::from(loan.token_id))?,
        ),
        (
            "principalAmount",
            CanonicalValue::BigInt(loan.principal_amount.clone()),
        ),
        (
            "interestAmount",
            CanonicalValue::BigInt(loan.interest_amount.clone()),
        ),
        (
            "repaymentAmount",
            CanonicalValue::BigInt(loan.repayment_amount.clone()),
        ),
        (
            "repaidAmount",
            CanonicalValue::BigInt(loan.repaid_amount.clone()),
        ),
        (
            "interestBps",
            number("lending.loan.interestBps", u64::from(loan.interest_bps))?,
        ),
        ("termId", text(loan.term_id.wire_name())),
        ("termMs", number("lending.loan.termMs", loan.term_ms)?),
        ("openedAt", number("lending.loan.openedAt", loan.opened_at)?),
        ("dueAt", number("lending.loan.dueAt", loan.due_at)?),
        (
            "updatedAt",
            number("lending.loan.updatedAt", loan.updated_at)?,
        ),
        ("status", text(loan.status.wire_name())),
    ]))
}

pub fn canonical_lending_state(state: &LendingState) -> Result<CanonicalValue, EntityKernelError> {
    let pools = state
        .pools()
        .map(|pool| Ok((text(&pool.position_id), canonical_lending_pool(pool)?)))
        .collect::<Result<Vec<_>, EntityKernelError>>()?;
    let loans = state
        .loans()
        .map(|loan| Ok((text(&loan.loan_id), canonical_lending_loan(loan)?)))
        .collect::<Result<Vec<_>, EntityKernelError>>()?;
    Ok(object(vec![
        ("pools", CanonicalValue::Map(pools)),
        ("loans", CanonicalValue::Map(loans)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute_entity_section_digest;

    fn entity(byte: &str) -> String {
        format!("0x{}", byte.repeat(32))
    }

    #[test]
    fn exact_typescript_lending_section_digest() {
        let hub = entity("10");
        let lender = entity("20");
        let borrower = entity("30");
        let position_id = "lend-1111111111111111".to_string();
        let loan_id = "loan-0327fd9035d42518".to_string();
        let state = LendingState::from_entries(
            [LendingPoolPosition {
                position_id: position_id.clone(),
                hub_entity_id: hub.clone(),
                lender_entity_id: lender.clone(),
                token_id: 1,
                principal_amount: BigInt::from(10_000),
                available_amount: BigInt::from(7_500),
                borrowed_amount: BigInt::from(2_500),
                interest_bps: 100,
                term_id: LendingTermId::OneDay,
                term_ms: 86_400_000,
                created_at: 1_000,
                updated_at: 2_000,
                status: LendingPoolStatus::Open,
            }],
            [LendingLoan {
                request_id: "borrow-2222222222222222".into(),
                loan_id,
                hub_entity_id: hub,
                borrower_entity_id: borrower,
                lender_entity_id: lender,
                position_id,
                token_id: 1,
                principal_amount: BigInt::from(2_500),
                interest_amount: BigInt::from(25),
                repayment_amount: BigInt::from(2_525),
                repaid_amount: BigInt::from(0),
                interest_bps: 100,
                term_id: LendingTermId::OneDay,
                term_ms: 86_400_000,
                opened_at: 2_000,
                due_at: 86_402_000,
                updated_at: 2_001,
                status: LendingLoanStatus::Active,
            }],
        )
        .expect("lending state");
        let actual = compute_entity_section_digest(&canonical_lending_state(&state).unwrap())
            .expect("section digest");
        // Generated by the canonical TypeScript binary consensus encoder.
        assert_eq!(
            actual,
            "0x0a20cbc2e149ffc4d81d1985e8cb1a574fcffed808de000f3ab7a5eedd25a861"
        );
        assert_eq!(
            super::super::decode_canonical_lending_state(
                &canonical_lending_state(&state).expect("canonical lending")
            )
            .expect("decode canonical lending"),
            state
        );
    }
}

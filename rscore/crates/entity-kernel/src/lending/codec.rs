use num_bigint::BigInt;
use xln_rscore_engine::LendingTermId;
use xln_rscore_protocol::CanonicalValue;

use crate::EntityKernelError;

use super::{LendingLoan, LendingLoanStatus, LendingPoolPosition, LendingPoolStatus, LendingState};

fn invalid(detail: impl Into<String>) -> EntityKernelError {
    EntityKernelError::lending(format!("SNAPSHOT_{}", detail.into()))
}

fn object<'a>(
    value: &'a CanonicalValue,
    expected: &[&str],
    path: &str,
) -> Result<&'a [(String, CanonicalValue)], EntityKernelError> {
    let CanonicalValue::Object(entries) = value else {
        return Err(invalid(format!("OBJECT:{path}")));
    };
    if entries.len() != expected.len()
        || expected
            .iter()
            .any(|name| entries.iter().filter(|(key, _)| key == name).count() != 1)
    {
        return Err(invalid(format!("FIELDS:{path}")));
    }
    Ok(entries)
}

fn field<'a>(
    entries: &'a [(String, CanonicalValue)],
    name: &str,
    path: &str,
) -> Result<&'a CanonicalValue, EntityKernelError> {
    entries
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
        .ok_or_else(|| invalid(format!("FIELD:{path}.{name}")))
}

fn text(value: &CanonicalValue, path: &str) -> Result<String, EntityKernelError> {
    match value {
        CanonicalValue::String(value) => Ok(value.clone()),
        _ => Err(invalid(format!("TEXT:{path}"))),
    }
}

fn bigint(value: &CanonicalValue, path: &str) -> Result<BigInt, EntityKernelError> {
    match value {
        CanonicalValue::BigInt(value) => Ok(value.clone()),
        _ => Err(invalid(format!("BIGINT:{path}"))),
    }
}

fn number(value: &CanonicalValue, path: &str) -> Result<u64, EntityKernelError> {
    match value {
        CanonicalValue::Number(value) => value
            .as_str()
            .parse::<u64>()
            .map_err(|_| invalid(format!("NUMBER:{path}"))),
        _ => Err(invalid(format!("NUMBER:{path}"))),
    }
}

fn u16_number(value: &CanonicalValue, path: &str) -> Result<u16, EntityKernelError> {
    u16::try_from(number(value, path)?).map_err(|_| invalid(format!("U16:{path}")))
}

fn term(value: &CanonicalValue, path: &str) -> Result<LendingTermId, EntityKernelError> {
    match text(value, path)?.as_str() {
        "1h" => Ok(LendingTermId::OneHour),
        "1d" => Ok(LendingTermId::OneDay),
        "1m" => Ok(LendingTermId::OneMonth),
        _ => Err(invalid(format!("TERM:{path}"))),
    }
}

fn pool_status(value: &CanonicalValue) -> Result<LendingPoolStatus, EntityKernelError> {
    match text(value, "pool.status")?.as_str() {
        "open" => Ok(LendingPoolStatus::Open),
        "closing" => Ok(LendingPoolStatus::Closing),
        "closed" => Ok(LendingPoolStatus::Closed),
        _ => Err(invalid("POOL_STATUS")),
    }
}

fn loan_status(value: &CanonicalValue) -> Result<LendingLoanStatus, EntityKernelError> {
    match text(value, "loan.status")?.as_str() {
        "opening" => Ok(LendingLoanStatus::Opening),
        "active" => Ok(LendingLoanStatus::Active),
        "closing" => Ok(LendingLoanStatus::Closing),
        "repaid" => Ok(LendingLoanStatus::Repaid),
        _ => Err(invalid("LOAN_STATUS")),
    }
}

fn pool(value: &CanonicalValue) -> Result<LendingPoolPosition, EntityKernelError> {
    const FIELDS: &[&str] = &[
        "positionId",
        "hubEntityId",
        "lenderEntityId",
        "tokenId",
        "principalAmount",
        "availableAmount",
        "borrowedAmount",
        "interestBps",
        "termId",
        "termMs",
        "createdAt",
        "updatedAt",
        "status",
    ];
    let value = object(value, FIELDS, "pool")?;
    Ok(LendingPoolPosition {
        position_id: text(field(value, "positionId", "pool")?, "pool.positionId")?,
        hub_entity_id: text(field(value, "hubEntityId", "pool")?, "pool.hubEntityId")?,
        lender_entity_id: text(
            field(value, "lenderEntityId", "pool")?,
            "pool.lenderEntityId",
        )?,
        token_id: u16_number(field(value, "tokenId", "pool")?, "pool.tokenId")?,
        principal_amount: bigint(
            field(value, "principalAmount", "pool")?,
            "pool.principalAmount",
        )?,
        available_amount: bigint(
            field(value, "availableAmount", "pool")?,
            "pool.availableAmount",
        )?,
        borrowed_amount: bigint(
            field(value, "borrowedAmount", "pool")?,
            "pool.borrowedAmount",
        )?,
        interest_bps: u16_number(field(value, "interestBps", "pool")?, "pool.interestBps")?,
        term_id: term(field(value, "termId", "pool")?, "pool.termId")?,
        term_ms: number(field(value, "termMs", "pool")?, "pool.termMs")?,
        created_at: number(field(value, "createdAt", "pool")?, "pool.createdAt")?,
        updated_at: number(field(value, "updatedAt", "pool")?, "pool.updatedAt")?,
        status: pool_status(field(value, "status", "pool")?)?,
    })
}

fn loan(value: &CanonicalValue) -> Result<LendingLoan, EntityKernelError> {
    const FIELDS: &[&str] = &[
        "requestId",
        "loanId",
        "hubEntityId",
        "borrowerEntityId",
        "lenderEntityId",
        "positionId",
        "tokenId",
        "principalAmount",
        "interestAmount",
        "repaymentAmount",
        "repaidAmount",
        "interestBps",
        "termId",
        "termMs",
        "openedAt",
        "dueAt",
        "updatedAt",
        "status",
    ];
    let value = object(value, FIELDS, "loan")?;
    Ok(LendingLoan {
        request_id: text(field(value, "requestId", "loan")?, "loan.requestId")?,
        loan_id: text(field(value, "loanId", "loan")?, "loan.loanId")?,
        hub_entity_id: text(field(value, "hubEntityId", "loan")?, "loan.hubEntityId")?,
        borrower_entity_id: text(
            field(value, "borrowerEntityId", "loan")?,
            "loan.borrowerEntityId",
        )?,
        lender_entity_id: text(
            field(value, "lenderEntityId", "loan")?,
            "loan.lenderEntityId",
        )?,
        position_id: text(field(value, "positionId", "loan")?, "loan.positionId")?,
        token_id: u16_number(field(value, "tokenId", "loan")?, "loan.tokenId")?,
        principal_amount: bigint(
            field(value, "principalAmount", "loan")?,
            "loan.principalAmount",
        )?,
        interest_amount: bigint(
            field(value, "interestAmount", "loan")?,
            "loan.interestAmount",
        )?,
        repayment_amount: bigint(
            field(value, "repaymentAmount", "loan")?,
            "loan.repaymentAmount",
        )?,
        repaid_amount: bigint(field(value, "repaidAmount", "loan")?, "loan.repaidAmount")?,
        interest_bps: u16_number(field(value, "interestBps", "loan")?, "loan.interestBps")?,
        term_id: term(field(value, "termId", "loan")?, "loan.termId")?,
        term_ms: number(field(value, "termMs", "loan")?, "loan.termMs")?,
        opened_at: number(field(value, "openedAt", "loan")?, "loan.openedAt")?,
        due_at: number(field(value, "dueAt", "loan")?, "loan.dueAt")?,
        updated_at: number(field(value, "updatedAt", "loan")?, "loan.updatedAt")?,
        status: loan_status(field(value, "status", "loan")?)?,
    })
}

fn map<'a>(
    value: &'a CanonicalValue,
    path: &str,
) -> Result<&'a [(CanonicalValue, CanonicalValue)], EntityKernelError> {
    match value {
        CanonicalValue::Map(entries) => Ok(entries),
        _ => Err(invalid(format!("MAP:{path}"))),
    }
}

pub fn decode_canonical_lending_state(
    value: &CanonicalValue,
) -> Result<LendingState, EntityKernelError> {
    let value = object(value, &["pools", "loans"], "lending")?;
    let pools = map(field(value, "pools", "lending")?, "pools")?
        .iter()
        .map(|(key, value)| {
            let key = text(key, "pool.key")?;
            let value = pool(value)?;
            (key == value.position_id)
                .then_some(value)
                .ok_or_else(|| invalid("POOL_KEY_MISMATCH"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let loans = map(field(value, "loans", "lending")?, "loans")?
        .iter()
        .map(|(key, value)| {
            let key = text(key, "loan.key")?;
            let value = loan(value)?;
            (key == value.loan_id)
                .then_some(value)
                .ok_or_else(|| invalid("LOAN_KEY_MISMATCH"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    LendingState::from_entries(pools, loans)
}

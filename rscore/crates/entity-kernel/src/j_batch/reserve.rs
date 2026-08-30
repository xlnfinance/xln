use std::collections::{BTreeMap, BTreeSet};

use ethabi::ethereum_types::U256;
use num_bigint::{BigInt, Sign};

use crate::{DebtLedger, EntityKernelError};

use super::{JBatch, Settlement};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DraftBatchReserveOpType {
    ReserveToReserve,
    Settlement,
    ReserveToCollateral,
    ReserveToExternalToken,
    Flashloan,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DraftBatchReserveIssue {
    pub token_id: u16,
    pub op_type: DraftBatchReserveOpType,
    pub op_index: usize,
    pub required_amount: BigInt,
    pub available_after_debt: BigInt,
    pub debt_claim_paid: BigInt,
    pub remaining_debt_after_sweep: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DraftBatchReserveSimulation {
    pub issues: Vec<DraftBatchReserveIssue>,
    pub reserves_by_token: BTreeMap<u16, BigInt>,
    pub outgoing_debt_by_token: BTreeMap<u16, BigInt>,
}

#[derive(Clone, Debug)]
struct DebtSweep {
    available_after_debt: BigInt,
    debt_claim_paid: BigInt,
    remaining_debt_after_sweep: BigInt,
}

fn invalid(detail: impl Into<String>) -> EntityKernelError {
    EntityKernelError::CommitmentEncoding {
        detail: format!("J_BATCH_RESERVE:{}", detail.into()),
    }
}

fn token(value: U256) -> Result<u16, EntityKernelError> {
    if value > U256::from(u16::MAX) {
        return Err(invalid(format!("TOKEN_ID_UNSUPPORTED:{value}")));
    }
    Ok(value.as_u32() as u16)
}

fn amount(value: U256) -> BigInt {
    let mut bytes = [0_u8; 32];
    value.to_big_endian(&mut bytes);
    BigInt::from_bytes_be(Sign::Plus, &bytes)
}

fn read(source: &BTreeMap<u16, BigInt>, token_id: u16) -> BigInt {
    source.get(&token_id).cloned().unwrap_or_default()
}

fn write(target: &mut BTreeMap<u16, BigInt>, token_id: u16, value: BigInt) {
    if value == BigInt::from(0) {
        target.remove(&token_id);
    } else {
        target.insert(token_id, value);
    }
}

fn add(target: &mut BTreeMap<u16, BigInt>, token_id: u16, value: BigInt) {
    write(target, token_id, read(target, token_id) + value);
}

fn spendable(state: &DraftBatchReserveSimulation, token_id: u16) -> BigInt {
    let reserve = read(&state.reserves_by_token, token_id);
    let debt = read(&state.outgoing_debt_by_token, token_id);
    if reserve > debt {
        reserve - debt
    } else {
        BigInt::from(0)
    }
}

fn sweep(state: &mut DraftBatchReserveSimulation, token_id: u16) -> DebtSweep {
    let reserve = read(&state.reserves_by_token, token_id);
    let debt = read(&state.outgoing_debt_by_token, token_id);
    let paid = reserve.clone().min(debt.clone());
    let available = reserve - &paid;
    let remaining = debt - &paid;
    write(&mut state.reserves_by_token, token_id, available.clone());
    write(
        &mut state.outgoing_debt_by_token,
        token_id,
        remaining.clone(),
    );
    DebtSweep {
        available_after_debt: available,
        debt_claim_paid: paid,
        remaining_debt_after_sweep: remaining,
    }
}

fn issue(
    state: &mut DraftBatchReserveSimulation,
    sweep: DebtSweep,
    token_id: u16,
    op_type: DraftBatchReserveOpType,
    op_index: usize,
    required_amount: BigInt,
) {
    state.issues.push(DraftBatchReserveIssue {
        token_id,
        op_type,
        op_index,
        required_amount,
        available_after_debt: sweep.available_after_debt,
        debt_claim_paid: sweep.debt_claim_paid,
        remaining_debt_after_sweep: sweep.remaining_debt_after_sweep,
    });
}

fn spend_or_issue(
    state: &mut DraftBatchReserveSimulation,
    token_id: u16,
    value: BigInt,
    op_type: DraftBatchReserveOpType,
    op_index: usize,
) -> bool {
    let swept = sweep(state, token_id);
    if swept.available_after_debt < value {
        issue(state, swept, token_id, op_type, op_index, value);
        return false;
    }
    write(
        &mut state.reserves_by_token,
        token_id,
        swept.available_after_debt - value,
    );
    true
}

fn settlement_side(entity_id: &[u8; 32], settlement: &Settlement) -> Option<bool> {
    if &settlement.left_entity == entity_id {
        Some(true)
    } else if &settlement.right_entity == entity_id {
        Some(false)
    } else {
        None
    }
}

fn touched_tokens(batch: &JBatch) -> Result<BTreeSet<u16>, EntityKernelError> {
    let mut tokens = BTreeSet::new();
    for value in &batch.flashloans {
        tokens.insert(token(value.token_id)?);
    }
    for value in &batch.reserve_to_reserve {
        tokens.insert(token(value.token_id)?);
    }
    for value in &batch.reserve_to_collateral {
        tokens.insert(token(value.token_id)?);
    }
    for value in &batch.collateral_to_reserve {
        tokens.insert(token(value.token_id)?);
    }
    for value in &batch.external_token_to_reserve {
        tokens.insert(token(value.internal_token_id)?);
    }
    for value in &batch.reserve_to_external_token {
        tokens.insert(token(value.token_id)?);
    }
    for settlement in &batch.settlements {
        for value in &settlement.diffs {
            tokens.insert(token(value.token_id)?);
        }
    }
    Ok(tokens)
}

pub fn simulate_draft_batch_reserve_availability(
    entity_id: [u8; 32],
    current_reserves: &BTreeMap<u16, BigInt>,
    batch: &JBatch,
    outgoing_debts: Option<&DebtLedger>,
) -> Result<DraftBatchReserveSimulation, EntityKernelError> {
    let starting_reserves = current_reserves.clone();
    let mut starting_debts = BTreeMap::new();
    if let Some(ledger) = outgoing_debts {
        for token_id in touched_tokens(batch)? {
            let total = ledger.open_total(u64::from(token_id));
            if total > BigInt::from(0) {
                starting_debts.insert(token_id, total);
            }
        }
    }
    let mut state = DraftBatchReserveSimulation {
        issues: Vec::new(),
        reserves_by_token: starting_reserves.clone(),
        outgoing_debt_by_token: starting_debts.clone(),
    };
    let mut flashloans = BTreeMap::<u16, BigInt>::new();
    let mut settlement_sweeps = BTreeMap::<u16, DebtSweep>::new();

    for op in &batch.flashloans {
        add(&mut flashloans, token(op.token_id)?, amount(op.amount));
    }
    for (&token_id, value) in &flashloans {
        add(&mut state.reserves_by_token, token_id, value.clone());
    }
    for op in &batch.external_token_to_reserve {
        if op.entity == entity_id {
            add(
                &mut state.reserves_by_token,
                token(op.internal_token_id)?,
                amount(op.amount),
            );
        }
    }
    for (index, op) in batch.reserve_to_reserve.iter().enumerate() {
        let token_id = token(op.token_id)?;
        let value = amount(op.amount);
        if spend_or_issue(
            &mut state,
            token_id,
            value.clone(),
            DraftBatchReserveOpType::ReserveToReserve,
            index,
        ) && op.receiving_entity == entity_id
        {
            add(&mut state.reserves_by_token, token_id, value);
        }
    }
    for op in &batch.collateral_to_reserve {
        add(
            &mut state.reserves_by_token,
            token(op.token_id)?,
            amount(op.amount),
        );
    }

    for settlement in &batch.settlements {
        let Some(is_left) = settlement_side(&entity_id, settlement) else {
            continue;
        };
        for diff in &settlement.diffs {
            let own = if is_left {
                &diff.left_diff
            } else {
                &diff.right_diff
            };
            if own.sign() != Sign::Minus {
                continue;
            }
            let token_id = token(diff.token_id)?;
            let swept = sweep(&mut state, token_id);
            settlement_sweeps
                .entry(token_id)
                .and_modify(|prior| {
                    prior.available_after_debt = swept.available_after_debt.clone();
                    prior.debt_claim_paid += &swept.debt_claim_paid;
                    prior.remaining_debt_after_sweep = swept.remaining_debt_after_sweep.clone();
                })
                .or_insert(swept);
        }
    }
    for (index, settlement) in batch.settlements.iter().enumerate() {
        let Some(is_left) = settlement_side(&entity_id, settlement) else {
            continue;
        };
        let mut failed = false;
        for diff in &settlement.diffs {
            let own = if is_left {
                &diff.left_diff
            } else {
                &diff.right_diff
            };
            if own.sign() != Sign::Minus {
                continue;
            }
            let token_id = token(diff.token_id)?;
            let required = -own.clone();
            let available = spendable(&state, token_id);
            if available < required {
                let swept = settlement_sweeps
                    .get(&token_id)
                    .cloned()
                    .unwrap_or(DebtSweep {
                        available_after_debt: available,
                        debt_claim_paid: BigInt::from(0),
                        remaining_debt_after_sweep: read(&state.outgoing_debt_by_token, token_id),
                    });
                issue(
                    &mut state,
                    swept,
                    token_id,
                    DraftBatchReserveOpType::Settlement,
                    index,
                    required,
                );
                failed = true;
                break;
            }
        }
        if failed {
            continue;
        }
        for diff in &settlement.diffs {
            let own = if is_left {
                diff.left_diff.clone()
            } else {
                diff.right_diff.clone()
            };
            add(&mut state.reserves_by_token, token(diff.token_id)?, own);
        }
    }
    for (index, op) in batch.reserve_to_collateral.iter().enumerate() {
        let total = op
            .pairs
            .iter()
            .fold(BigInt::from(0), |sum, pair| sum + amount(pair.amount));
        spend_or_issue(
            &mut state,
            token(op.token_id)?,
            total,
            DraftBatchReserveOpType::ReserveToCollateral,
            index,
        );
    }
    for (index, op) in batch.reserve_to_external_token.iter().enumerate() {
        spend_or_issue(
            &mut state,
            token(op.token_id)?,
            amount(op.amount),
            DraftBatchReserveOpType::ReserveToExternalToken,
            index,
        );
    }
    for (&token_id, loan) in &flashloans {
        let required = read(&starting_reserves, token_id) + loan;
        let available = read(&state.reserves_by_token, token_id);
        if available < required {
            let remaining_debt_after_sweep = read(&state.outgoing_debt_by_token, token_id);
            issue(
                &mut state,
                DebtSweep {
                    available_after_debt: available,
                    debt_claim_paid: BigInt::from(0),
                    remaining_debt_after_sweep,
                },
                token_id,
                DraftBatchReserveOpType::Flashloan,
                0,
                required,
            );
            break;
        }
    }
    if state
        .issues
        .iter()
        .all(|issue| issue.op_type != DraftBatchReserveOpType::Flashloan)
    {
        for (token_id, loan) in flashloans {
            add(&mut state.reserves_by_token, token_id, -loan);
        }
    }
    if !state.issues.is_empty() {
        state.reserves_by_token = starting_reserves;
        state.outgoing_debt_by_token = starting_debts;
    }
    Ok(state)
}

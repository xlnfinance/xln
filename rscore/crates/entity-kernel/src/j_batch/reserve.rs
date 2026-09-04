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
    /// Implicit flash credit this op opened that the batch never repaid
    /// (Depository reverts unless every deficit is zero at the end). Zero when
    /// the op itself is rejected on the spot.
    pub unrepaid_deficit: BigInt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DraftBatchReserveSimulation {
    pub issues: Vec<DraftBatchReserveIssue>,
    pub reserves_by_token: BTreeMap<u16, BigInt>,
    pub outgoing_debt_by_token: BTreeMap<u16, BigInt>,
    /// Depository `BatchScratch.deficit` for the initiator: reserve spent ahead
    /// of holding (only while the token has no outstanding debt). Inflows repay
    /// it first; every entry must be zero when the batch ends.
    pub flash_deficit_by_token: BTreeMap<u16, BigInt>,
}

#[derive(Clone, Debug)]
struct DebtSweep {
    available_after_debt: BigInt,
    debt_claim_paid: BigInt,
    remaining_debt_after_sweep: BigInt,
}

/// The op that first overdrew a token; reported if its deficit is never repaid.
#[derive(Clone, Debug)]
struct DeficitOrigin {
    sweep: DebtSweep,
    op_type: DraftBatchReserveOpType,
    op_index: usize,
    required_amount: BigInt,
}

type DeficitOrigins = BTreeMap<u16, DeficitOrigin>;

fn record_deficit_origin(
    origins: &mut DeficitOrigins,
    token_id: u16,
    sweep: DebtSweep,
    op_type: DraftBatchReserveOpType,
    op_index: usize,
    required_amount: BigInt,
) {
    origins.entry(token_id).or_insert(DeficitOrigin {
        sweep,
        op_type,
        op_index,
        required_amount,
    });
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
    unrepaid_deficit: BigInt,
) {
    state.issues.push(DraftBatchReserveIssue {
        token_id,
        op_type,
        op_index,
        required_amount,
        available_after_debt: sweep.available_after_debt,
        debt_claim_paid: sweep.debt_claim_paid,
        remaining_debt_after_sweep: sweep.remaining_debt_after_sweep,
        unrepaid_deficit,
    });
}

/// `Account._increaseReserve` for the initiator: repay the open flash deficit
/// first, credit the remainder to the reserve.
fn inflow(state: &mut DraftBatchReserveSimulation, token_id: u16, value: BigInt) {
    let owed = read(&state.flash_deficit_by_token, token_id);
    let repaid = value.clone().min(owed.clone());
    write(&mut state.flash_deficit_by_token, token_id, owed - &repaid);
    add(&mut state.reserves_by_token, token_id, value - repaid);
}

/// `Account._canSpend`: the plain reserve net of outstanding debt, or unlimited
/// for a debt-free batch initiator (implicit flash, repaid before the end).
fn can_spend(state: &DraftBatchReserveSimulation, token_id: u16, value: &BigInt) -> bool {
    spendable(state, token_id) >= *value
        || read(&state.outgoing_debt_by_token, token_id) == BigInt::from(0)
}

/// `Account._decreaseReserve` after `_canSpend` passed: a shortfall becomes
/// initiator flash deficit and the reserve drops to zero. Returns whether a
/// deficit was opened.
fn decrease(state: &mut DraftBatchReserveSimulation, token_id: u16, value: BigInt) -> bool {
    let current = read(&state.reserves_by_token, token_id);
    if current >= value {
        write(&mut state.reserves_by_token, token_id, current - value);
        return false;
    }
    add(&mut state.flash_deficit_by_token, token_id, value - current);
    write(&mut state.reserves_by_token, token_id, BigInt::from(0));
    true
}

fn spend_or_issue(
    state: &mut DraftBatchReserveSimulation,
    origins: &mut DeficitOrigins,
    token_id: u16,
    value: BigInt,
    op_type: DraftBatchReserveOpType,
    op_index: usize,
) -> bool {
    let swept = sweep(state, token_id);
    if !can_spend(state, token_id, &value) {
        issue(
            state,
            swept,
            token_id,
            op_type,
            op_index,
            value,
            BigInt::from(0),
        );
        return false;
    }
    if decrease(state, token_id, value.clone()) {
        record_deficit_origin(origins, token_id, swept, op_type, op_index, value);
    }
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
        flash_deficit_by_token: BTreeMap::new(),
    };
    let mut settlement_sweeps = BTreeMap::<u16, DebtSweep>::new();
    let mut deficit_origins = DeficitOrigins::new();

    // Same order as Depository._processBatch: inflows first, then outflows,
    // then the initiator's implicit flash deficit must be back to zero.
    for op in &batch.external_token_to_reserve {
        if op.entity == entity_id || op.entity == [0_u8; 32] {
            inflow(&mut state, token(op.internal_token_id)?, amount(op.amount));
        }
    }
    for (index, op) in batch.reserve_to_reserve.iter().enumerate() {
        let token_id = token(op.token_id)?;
        let value = amount(op.amount);
        if spend_or_issue(
            &mut state,
            &mut deficit_origins,
            token_id,
            value.clone(),
            DraftBatchReserveOpType::ReserveToReserve,
            index,
        ) && op.receiving_entity == entity_id
        {
            inflow(&mut state, token_id, value);
        }
    }
    for op in &batch.collateral_to_reserve {
        inflow(&mut state, token(op.token_id)?, amount(op.amount));
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
            if !can_spend(&state, token_id, &required) {
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
                    BigInt::from(0),
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
            let token_id = token(diff.token_id)?;
            if own.sign() == Sign::Minus {
                let required = -own;
                let swept = DebtSweep {
                    available_after_debt: read(&state.reserves_by_token, token_id),
                    debt_claim_paid: settlement_sweeps
                        .get(&token_id)
                        .map(|prior| prior.debt_claim_paid.clone())
                        .unwrap_or_default(),
                    remaining_debt_after_sweep: read(&state.outgoing_debt_by_token, token_id),
                };
                if decrease(&mut state, token_id, required.clone()) {
                    record_deficit_origin(
                        &mut deficit_origins,
                        token_id,
                        swept,
                        DraftBatchReserveOpType::Settlement,
                        index,
                        required,
                    );
                }
            } else {
                inflow(&mut state, token_id, own);
            }
        }
    }
    for (index, op) in batch.reserve_to_collateral.iter().enumerate() {
        let total = op
            .pairs
            .iter()
            .fold(BigInt::from(0), |sum, pair| sum + amount(pair.amount));
        spend_or_issue(
            &mut state,
            &mut deficit_origins,
            token(op.token_id)?,
            total,
            DraftBatchReserveOpType::ReserveToCollateral,
            index,
        );
    }
    for (index, op) in batch.reserve_to_external_token.iter().enumerate() {
        spend_or_issue(
            &mut state,
            &mut deficit_origins,
            token(op.token_id)?,
            amount(op.amount),
            DraftBatchReserveOpType::ReserveToExternalToken,
            index,
        );
    }
    let deficits: Vec<(u16, BigInt)> = state
        .flash_deficit_by_token
        .iter()
        .filter(|(_, owed)| **owed != BigInt::from(0))
        .map(|(token_id, owed)| (*token_id, owed.clone()))
        .collect();
    // Depository._processBatch tail: an unrepaid deficit reverts the batch and
    // is reported against the op that opened it (same shape as TS).
    if let Some((token_id, owed)) = deficits.into_iter().next() {
        let origin = deficit_origins
            .get(&token_id)
            .cloned()
            .ok_or_else(|| invalid(format!("DEFICIT_WITHOUT_ORIGIN:{token_id}")))?;
        issue(
            &mut state,
            origin.sweep,
            token_id,
            origin.op_type,
            origin.op_index,
            origin.required_amount,
            owed,
        );
    }
    if !state.issues.is_empty() {
        state.reserves_by_token = starting_reserves;
        state.outgoing_debt_by_token = starting_debts;
        state.flash_deficit_by_token = BTreeMap::new();
    }
    Ok(state)
}

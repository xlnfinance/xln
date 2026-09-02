use std::collections::{BTreeSet, VecDeque};

use xln_rscore_entity_kernel::{
    CanonicalEntityTx, EntityTxKind, LocalEntityTx, decode_local_entity_tx,
    proposer_materialization_key,
};

use super::{EntityPendingWork, RuntimeMachineError};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct CrossJWorkFlags {
    account_transition: bool,
    setup: bool,
}

#[derive(Debug, Default)]
pub(super) struct MaterializationAdmission {
    pub(super) pending_keys: BTreeSet<String>,
    pub(super) commit_phase: bool,
    account_transition: bool,
    setup: bool,
}

impl MaterializationAdmission {
    pub(super) fn requires_commit_phase_selection(&self) -> bool {
        self.account_transition && self.setup
    }
}

fn inspect_entity_tx(
    tx: &CanonicalEntityTx,
    admission: &mut MaterializationAdmission,
) -> Result<CrossJWorkFlags, RuntimeMachineError> {
    if let Some(key) = proposer_materialization_key(tx) {
        admission.pending_keys.insert(key);
    }
    let mut flags = CrossJWorkFlags {
        account_transition: matches!(
            tx.kind,
            EntityTxKind::AccountInput | EntityTxKind::CrossJurisdictionFillNotice
        ),
        setup: matches!(
            tx.kind,
            EntityTxKind::MaterializeCrossJurisdictionSwap
                | EntityTxKind::MaterializeCrossJurisdictionClear
                | EntityTxKind::RegisterCrossJurisdictionSwap
        ),
    };
    admission.commit_phase |=
        flags.account_transition || tx.kind == EntityTxKind::RegisterCrossJurisdictionSwap;
    if tx.kind == EntityTxKind::RuntimeOutput {
        let Some(LocalEntityTx::RuntimeOutput(output)) =
            decode_local_entity_tx(tx).map_err(RuntimeMachineError::EntityFinancial)?
        else {
            return Err(RuntimeMachineError::EntityTxExecutionUnsupported(
                tx.kind.as_str(),
            ));
        };
        for nested in &output.entity_txs {
            let nested_flags = inspect_entity_tx(nested, admission)?;
            flags.account_transition |= nested_flags.account_transition;
            flags.setup |= nested_flags.setup;
        }
    }
    admission.account_transition |= flags.account_transition;
    admission.setup |= flags.setup;
    Ok(flags)
}

fn inspect_local_tx(
    tx: &LocalEntityTx,
    admission: &mut MaterializationAdmission,
) -> Result<CrossJWorkFlags, RuntimeMachineError> {
    match tx {
        LocalEntityTx::CrossJurisdiction(tx) => inspect_entity_tx(tx, admission),
        LocalEntityTx::RuntimeOutput(output) => {
            let mut flags = CrossJWorkFlags::default();
            for nested in &output.entity_txs {
                let nested_flags = inspect_entity_tx(nested, admission)?;
                flags.account_transition |= nested_flags.account_transition;
                flags.setup |= nested_flags.setup;
            }
            Ok(flags)
        }
        LocalEntityTx::Financial(_) | LocalEntityTx::Control(_) => Ok(CrossJWorkFlags::default()),
    }
}

fn inspect_work(
    work: &EntityPendingWork,
    admission: &mut MaterializationAdmission,
) -> Result<CrossJWorkFlags, RuntimeMachineError> {
    match work {
        EntityPendingWork::Account { .. } => {
            admission.commit_phase = true;
            admission.account_transition = true;
            Ok(CrossJWorkFlags {
                account_transition: true,
                setup: false,
            })
        }
        EntityPendingWork::LocalBatch { native, .. } => {
            let mut flags = CrossJWorkFlags::default();
            for tx in native {
                let nested_flags = inspect_local_tx(tx, admission)?;
                flags.account_transition |= nested_flags.account_transition;
                flags.setup |= nested_flags.setup;
            }
            Ok(flags)
        }
        EntityPendingWork::Command { command, .. } => {
            let mut flags = CrossJWorkFlags::default();
            for tx in &command.native_txs {
                let nested_flags = inspect_local_tx(tx, admission)?;
                flags.account_transition |= nested_flags.account_transition;
                flags.setup |= nested_flags.setup;
            }
            Ok(flags)
        }
        EntityPendingWork::ProposerMaterialized { native, .. } => {
            inspect_local_tx(native, admission)
        }
        EntityPendingWork::Projected(projected) => inspect_entity_tx(projected, admission),
    }
}

pub(super) fn materialization_admission(
    work: &VecDeque<EntityPendingWork>,
) -> Result<MaterializationAdmission, RuntimeMachineError> {
    let mut admission = MaterializationAdmission::default();
    for work in work {
        inspect_work(work, &mut admission)?;
    }
    Ok(admission)
}

fn command_author(command: &xln_rscore_entity_kernel::SignedEntityCommandV1) -> String {
    format!(
        "{}:{}:{}",
        command.board_hash, command.board_epoch, command.author_signer_id
    )
    .to_lowercase()
}

fn work_author(
    work: &EntityPendingWork,
    local_author: Option<&str>,
) -> Result<Option<String>, RuntimeMachineError> {
    match work {
        EntityPendingWork::Command { command, .. } => Ok(Some(command_author(command))),
        // LocalBatch is wrapped into one collective EntityCommand by
        // take_entity_prefix. ProposerMaterialized remains a bare protocol tx,
        // so it must not create an author deferral boundary.
        EntityPendingWork::LocalBatch { .. } => {
            local_author.map(str::to_owned).map(Some).ok_or_else(|| {
                RuntimeMachineError::EntityCommandContext(
                    "CROSS_J_COMMIT_PHASE_LOCAL_AUTHOR_REQUIRED".into(),
                )
            })
        }
        EntityPendingWork::Account { .. }
        | EntityPendingWork::ProposerMaterialized { .. }
        | EntityPendingWork::Projected(_) => Ok(None),
    }
}

pub(super) struct CommitPhaseWorkSelection {
    pub(super) selected: VecDeque<EntityPendingWork>,
    selected_positions: VecDeque<usize>,
    deferred: VecDeque<(usize, EntityPendingWork)>,
}

impl CommitPhaseWorkSelection {
    pub(super) fn consume_selected_prefix(
        &mut self,
        count: usize,
    ) -> Result<(), RuntimeMachineError> {
        if count > self.selected_positions.len() {
            return Err(RuntimeMachineError::InputCountOverflow);
        }
        self.selected_positions.drain(..count);
        Ok(())
    }

    pub(super) fn into_remaining(self) -> Result<VecDeque<EntityPendingWork>, RuntimeMachineError> {
        if self.selected.len() != self.selected_positions.len() {
            return Err(RuntimeMachineError::InputCountOverflow);
        }
        let mut selected = self
            .selected_positions
            .into_iter()
            .zip(self.selected)
            .collect::<VecDeque<_>>();
        let mut deferred = self.deferred;
        let mut remaining = VecDeque::new();
        while let (Some((selected_position, _)), Some((deferred_position, _))) =
            (selected.front(), deferred.front())
        {
            if selected_position == deferred_position {
                return Err(RuntimeMachineError::EntityCommandContext(
                    "CROSS_J_COMMIT_PHASE_POSITION_COLLISION".into(),
                ));
            }
            let source = if selected_position < deferred_position {
                &mut selected
            } else {
                &mut deferred
            };
            remaining.push_back(pop_positioned_work(source)?);
        }
        remaining.extend(selected.into_iter().map(|(_, work)| work));
        remaining.extend(deferred.into_iter().map(|(_, work)| work));
        Ok(remaining)
    }
}

fn pop_positioned_work(
    work: &mut VecDeque<(usize, EntityPendingWork)>,
) -> Result<EntityPendingWork, RuntimeMachineError> {
    work.pop_front().map(|(_, work)| work).ok_or_else(|| {
        RuntimeMachineError::EntityCommandContext(
            "CROSS_J_COMMIT_PHASE_POSITIONED_WORK_MISSING".into(),
        )
    })
}

pub(super) fn select_commit_phase_work(
    work: VecDeque<EntityPendingWork>,
    admission: &MaterializationAdmission,
    local_author: Option<&str>,
) -> Result<CommitPhaseWorkSelection, RuntimeMachineError> {
    if !admission.requires_commit_phase_selection() {
        return Ok(CommitPhaseWorkSelection {
            selected_positions: (0..work.len()).collect(),
            selected: work,
            deferred: VecDeque::new(),
        });
    }
    let mut selected = VecDeque::new();
    let mut selected_positions = VecDeque::new();
    let mut deferred = VecDeque::new();
    let mut deferred_authors = BTreeSet::new();
    for (position, work) in work.into_iter().enumerate() {
        let mut work_admission = MaterializationAdmission::default();
        let flags = inspect_work(&work, &mut work_admission)?;
        let author = work_author(&work, local_author)?;
        let should_defer = match author {
            Some(author) if deferred_authors.contains(&author) || flags.setup => {
                deferred_authors.insert(author);
                true
            }
            Some(_) => false,
            None => flags.setup,
        };
        if should_defer {
            deferred.push_back((position, work));
        } else {
            selected_positions.push_back(position);
            selected.push_back(work);
        }
    }
    Ok(CommitPhaseWorkSelection {
        selected,
        selected_positions,
        deferred,
    })
}

#[cfg(test)]
mod tests;

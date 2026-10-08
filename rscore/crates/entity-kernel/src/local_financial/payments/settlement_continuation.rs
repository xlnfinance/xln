use super::*;
use crate::{AdmittedLocalEntityTx, CanonicalEntityTx, EntityTxKind};

pub(crate) enum ContinuationDisposition {
    Wait,
    Discard(&'static str),
    Execute(Vec<AdmittedLocalEntityTx>),
}

pub(crate) fn continuation_probe(
    counterparty: &str,
    signer: &str,
) -> Result<AdmittedLocalEntityTx, EntityKernelError> {
    admitted(
        EntityTxKind::SettleExecute,
        vec![(
            "counterpartyEntityId".into(),
            CanonicalValue::String(counterparty.into()),
        )],
        signer,
    )
}

fn admitted(
    kind: EntityTxKind,
    data: Vec<(String, CanonicalValue)>,
    signer: &str,
) -> Result<AdmittedLocalEntityTx, EntityKernelError> {
    let tx = CanonicalEntityTx::from_frame_projection(kind, CanonicalValue::Object(data))
        .map_err(|error| invalid("settlementContinuation", error.to_string()))?;
    Ok(AdmittedLocalEntityTx {
        signer_id: signer.into(),
        // These derived financial operations cannot create governance proposals;
        // their reducers do not read the command board epoch.
        board_epoch: 0,
        tx: crate::decode_local_entity_tx(&tx)?
            .ok_or_else(|| invalid("settlementContinuation", "DERIVED_TX_UNSUPPORTED"))?,
    })
}

pub(crate) fn select_continuation(
    state: &EntityStateSlice,
    counterparty: &str,
    continuation: &CanonicalValue,
    views: &std::collections::BTreeMap<String, LocalAccountFinancialView>,
    queued_transition: bool,
    signer: &str,
) -> Result<ContinuationDisposition, EntityKernelError> {
    const KIND: &str = "settlementContinuation";
    let account = view(views, counterparty, KIND)?;
    if queued_transition || account.settlement_transition_pending {
        return Ok(ContinuationDisposition::Wait);
    }
    let Some(workspace) = workspace_fields(account, KIND)? else {
        return Ok(ContinuationDisposition::Discard("workspace missing"));
    };
    let fields = object(continuation, KIND, "CONTINUATION_OBJECT")?;
    if required(workspace, "workspaceHash", KIND)? != required(fields, "workspaceHash", KIND)? {
        return Ok(ContinuationDisposition::Discard("workspace changed"));
    }
    let status = string(required(workspace, "status", KIND)?, KIND, "STATUS")?;
    if status == "submitted" {
        return Ok(ContinuationDisposition::Discard("already submitted"));
    }
    if status != "ready_to_submit" {
        return Ok(ContinuationDisposition::Wait);
    }
    if boolean(
        required(workspace, "executorIsLeft", KIND)?,
        KIND,
        "EXECUTOR",
    )? != local_is_left(state, counterparty)
    {
        return Err(invalid(KIND, "SETTLEMENT_CONTINUATION_EXECUTOR_MISMATCH"));
    }
    if state.j_batch_state.as_ref().is_some_and(|batch| {
        batch.sent_batch.is_some() || !crate::j_batch::batch_is_empty(&batch.batch)
    }) {
        return Ok(ContinuationDisposition::Wait);
    }
    let CanonicalValue::Array(actions) = required(fields, "actions", KIND)? else {
        return Err(invalid(KIND, "ACTIONS_ARRAY"));
    };
    let mut execute = vec![(
        "counterpartyEntityId".into(),
        CanonicalValue::String(counterparty.into()),
    )];
    if !actions.is_empty() {
        execute.push(("disableC2RShortcut".into(), CanonicalValue::Bool(true)));
    }
    let mut txs = vec![admitted(EntityTxKind::SettleExecute, execute, signer)?];
    for action in actions {
        let action = object(action, KIND, "ACTION_OBJECT")?;
        let action_type = string(required(action, "type", KIND)?, KIND, "ACTION_TYPE")?;
        let (kind, target) = match action_type {
            "r2r" => (EntityTxKind::R2r, "toEntityId"),
            "r2e" => (EntityTxKind::R2e, "receivingEntity"),
            "r2c" => (EntityTxKind::R2c, "counterpartyId"),
            _ => return Err(invalid(KIND, "ACTION_TYPE")),
        };
        let mut data = vec![
            (target.into(), required(action, target, KIND)?.clone()),
            ("tokenId".into(), required(action, "tokenId", KIND)?.clone()),
            ("amount".into(), required(action, "amount", KIND)?.clone()),
        ];
        if kind == EntityTxKind::R2c
            && let Some(value) = field(action, "receivingEntityId")
        {
            data.push(("receivingEntityId".into(), value.clone()));
        }
        txs.push(admitted(kind, data, signer)?);
    }
    if boolean(required(fields, "broadcast", KIND)?, KIND, "BROADCAST")? {
        txs.push(admitted(EntityTxKind::JBroadcast, vec![], signer)?);
    }
    Ok(ContinuationDisposition::Execute(txs))
}

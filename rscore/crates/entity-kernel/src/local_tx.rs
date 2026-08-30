use crate::{
    CanonicalEntityTx, EntityKernelError, EntityTxKind, LocalEntityControlTx,
    LocalEntityFinancialTx, decode_local_entity_control_tx, decode_local_entity_financial_tx,
};
use xln_rscore_protocol::CanonicalValue;

/// One authenticated, committed cross-J Runtime output. The outer Runtime
/// route proves transport provenance; these fields bind that provenance to
/// the exact economic roles committed by every nested route.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrossJurisdictionRuntimeOutput {
    pub source_entity_id: String,
    pub source_signer_id: String,
    pub target_entity_id: String,
    pub entity_txs: Vec<CanonicalEntityTx>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LocalEntityTx {
    Financial(LocalEntityFinancialTx),
    Control(LocalEntityControlTx),
    CrossJurisdiction(CanonicalEntityTx),
    RuntimeOutput(CrossJurisdictionRuntimeOutput),
}

/// One local Entity transaction after command signature/nonce admission. The
/// signer is frame-local authority provenance; it is never persisted as a
/// second transaction field and approved nested work inherits its proposal's
/// signer deterministically.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdmittedLocalEntityTx {
    pub signer_id: String,
    /// Certified board epoch under which the outer EntityCommand was
    /// admitted. Collective on-chain intents bind this exact epoch; deriving
    /// it later from mutable registry state would let a rotation change an
    /// already-approved proposal's signing domain.
    pub board_epoch: u64,
    pub tx: LocalEntityTx,
}

fn object<'a>(
    value: &'a CanonicalValue,
    context: &'static str,
) -> Result<&'a [(String, CanonicalValue)], EntityKernelError> {
    match value {
        CanonicalValue::Object(fields) => Ok(fields),
        _ => Err(EntityKernelError::local(
            "runtimeOutput",
            format!("{context}:OBJECT"),
        )),
    }
}

fn field<'a>(
    fields: &'a [(String, CanonicalValue)],
    name: &'static str,
) -> Result<&'a CanonicalValue, EntityKernelError> {
    fields
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
        .ok_or_else(|| EntityKernelError::local("runtimeOutput", format!("{name}:MISSING")))
}

fn text(
    fields: &[(String, CanonicalValue)],
    name: &'static str,
) -> Result<String, EntityKernelError> {
    let CanonicalValue::String(value) = field(fields, name)? else {
        return Err(EntityKernelError::local(
            "runtimeOutput",
            format!("{name}:STRING"),
        ));
    };
    let canonical = value.trim().to_ascii_lowercase();
    if canonical.is_empty() || canonical != *value {
        return Err(EntityKernelError::local(
            "runtimeOutput",
            format!("{name}:CANONICAL"),
        ));
    }
    Ok(canonical)
}

pub fn is_cross_jurisdiction_entity_tx_kind(kind: EntityTxKind) -> bool {
    matches!(
        kind,
        EntityTxKind::AdmitCrossJurisdictionBookOrder
            | EntityTxKind::ApplyCrossJurisdictionBookProgress
            | EntityTxKind::CrossJurisdictionBookOrderRemoved
            | EntityTxKind::CrossJurisdictionFillNotice
            | EntityTxKind::CrossJurisdictionForceSiblingDispute
            | EntityTxKind::CrossJurisdictionSalvage
            | EntityTxKind::CrossPullClose
            | EntityTxKind::DisputeStart
            | EntityTxKind::MaterializeCrossJurisdictionClear
            | EntityTxKind::MaterializeCrossJurisdictionSwap
            | EntityTxKind::OrderbookSweepCrossJurisdiction
            | EntityTxKind::PrepareCrossJurisdictionSwap
            | EntityTxKind::RegisterCrossJurisdictionSwap
            | EntityTxKind::RemoveCrossJurisdictionBookOrder
            | EntityTxKind::RequestCrossJurisdictionClear
            | EntityTxKind::ResolveHtlcLock
    )
}

/// Validator-authenticated work emitted by an Entity frame back to the same
/// Entity. Runtime carries these committed bytes across its WAL boundary; the
/// canonical financial/control dispatcher still validates every transition.
pub(crate) fn is_self_runtime_continuation_kind(kind: EntityTxKind) -> bool {
    matches!(
        kind,
        EntityTxKind::DisputeFinalize
            | EntityTxKind::JAbortSentBatch
            | EntityTxKind::JBroadcast
            | EntityTxKind::OrderbookSweepCrossJurisdiction
            | EntityTxKind::PrepareDispute
            | EntityTxKind::ProcessHtlcTimeouts
            | EntityTxKind::RequestCrossJurisdictionClear
            | EntityTxKind::SettleExecute
            | EntityTxKind::SettlePropose
    )
}

fn decode_runtime_output(
    tx: &CanonicalEntityTx,
) -> Result<CrossJurisdictionRuntimeOutput, EntityKernelError> {
    let fields = object(
        tx.frame_data()
            .ok_or_else(|| EntityKernelError::local("runtimeOutput", "DATA_MISSING"))?,
        "data",
    )?;
    if fields.len() != 5 {
        return Err(EntityKernelError::local(
            "runtimeOutput",
            "FIELDS:protocol,sourceEntityId,sourceSignerId,targetEntityId,entityTxs",
        ));
    }
    let CanonicalValue::String(protocol) = field(fields, "protocol")? else {
        return Err(EntityKernelError::local("runtimeOutput", "protocol:STRING"));
    };
    if protocol != "cross-j" {
        return Err(EntityKernelError::local(
            "runtimeOutput",
            format!("RUNTIME_OUTPUT_PROTOCOL_INVALID:{protocol}"),
        ));
    }
    let source_entity_id = text(fields, "sourceEntityId")?;
    let source_signer_id = text(fields, "sourceSignerId")?;
    let target_entity_id = text(fields, "targetEntityId")?;
    let CanonicalValue::Array(nested) = field(fields, "entityTxs")? else {
        return Err(EntityKernelError::local("runtimeOutput", "entityTxs:ARRAY"));
    };
    if nested.is_empty() {
        return Err(EntityKernelError::local(
            "runtimeOutput",
            "RUNTIME_OUTPUT_TXS_MISSING",
        ));
    }
    let mut entity_txs = Vec::with_capacity(nested.len());
    for value in nested {
        let nested_fields = object(value, "entityTx")?;
        if nested_fields.len() != 2 {
            return Err(EntityKernelError::local(
                "runtimeOutput",
                "ENTITY_TX_FIELDS:type,data",
            ));
        }
        let CanonicalValue::String(kind_text) = field(nested_fields, "type")? else {
            return Err(EntityKernelError::local("runtimeOutput", "ENTITY_TX_TYPE"));
        };
        let kind = EntityTxKind::parse(kind_text)
            .map_err(|error| EntityKernelError::local("runtimeOutput", error.to_string()))?;
        if matches!(
            kind,
            EntityTxKind::AccountInput
                | EntityTxKind::BoardHandover
                | EntityTxKind::EntityCommand
                | EntityTxKind::JEvent
                | EntityTxKind::RuntimeOutput
                | EntityTxKind::ScheduledWake
        ) {
            return Err(EntityKernelError::local(
                "runtimeOutput",
                format!("RUNTIME_OUTPUT_NESTED_PROTOCOL_TX_FORBIDDEN:{kind_text}"),
            ));
        }
        if !is_cross_jurisdiction_entity_tx_kind(kind) && !is_self_runtime_continuation_kind(kind) {
            return Err(EntityKernelError::local(
                "runtimeOutput",
                format!("RUNTIME_OUTPUT_SEMANTIC_VARIANT_FORBIDDEN:{kind_text}"),
            ));
        }
        entity_txs.push(
            CanonicalEntityTx::from_frame_projection(kind, field(nested_fields, "data")?.clone())
                .map_err(|error| EntityKernelError::local("runtimeOutput", error.to_string()))?,
        );
    }
    Ok(CrossJurisdictionRuntimeOutput {
        source_entity_id,
        source_signer_id,
        target_entity_id,
        entity_txs,
    })
}

pub fn decode_local_entity_tx(
    tx: &CanonicalEntityTx,
) -> Result<Option<LocalEntityTx>, EntityKernelError> {
    if let Some(financial) = decode_local_entity_financial_tx(tx)? {
        return Ok(Some(LocalEntityTx::Financial(financial)));
    }
    if let Some(control) = decode_local_entity_control_tx(tx)? {
        return Ok(Some(LocalEntityTx::Control(control)));
    }
    if tx.kind == EntityTxKind::RuntimeOutput {
        return decode_runtime_output(tx)
            .map(LocalEntityTx::RuntimeOutput)
            .map(Some);
    }
    if is_cross_jurisdiction_entity_tx_kind(tx.kind) {
        return Ok(Some(LocalEntityTx::CrossJurisdiction(tx.clone())));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(entries: impl IntoIterator<Item = (&'static str, CanonicalValue)>) -> CanonicalValue {
        CanonicalValue::Object(
            entries
                .into_iter()
                .map(|(key, value)| (key.to_string(), value))
                .collect(),
        )
    }

    fn text(value: &str) -> CanonicalValue {
        CanonicalValue::String(value.into())
    }

    fn runtime_output(nested_kind: &str) -> CanonicalEntityTx {
        CanonicalEntityTx::from_frame_projection(
            EntityTxKind::RuntimeOutput,
            object([
                ("protocol", text("cross-j")),
                ("sourceEntityId", text("source-hub")),
                ("sourceSignerId", text("source-hub-signer")),
                ("targetEntityId", text("source-hub")),
                (
                    "entityTxs",
                    CanonicalValue::Array(vec![object([
                        ("type", text(nested_kind)),
                        ("data", object([])),
                    ])]),
                ),
            ]),
        )
        .expect("runtime output")
    }

    #[test]
    fn runtime_output_decoder_admits_self_continuation_but_not_arbitrary_command() {
        let decoded = decode_local_entity_tx(&runtime_output("j_broadcast"))
            .expect("decode")
            .expect("supported");
        assert!(matches!(
            decoded,
            LocalEntityTx::RuntimeOutput(CrossJurisdictionRuntimeOutput { entity_txs, .. })
                if matches!(entity_txs.as_slice(), [tx] if tx.kind == EntityTxKind::JBroadcast)
        ));

        let error = decode_local_entity_tx(&runtime_output("setHubConfig"))
            .expect_err("ordinary self command is not a Runtime-output variant");
        assert!(
            error
                .to_string()
                .contains("RUNTIME_OUTPUT_SEMANTIC_VARIANT_FORBIDDEN:setHubConfig")
        );
    }
}

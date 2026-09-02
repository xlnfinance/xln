use num_bigint::BigInt;
use xln_rscore_entity_kernel::{
    CrossJurisdictionRuntimeOutput, SignedEntityCommandV1, UNREGISTERED_ENTITY_COMMAND_STACK_KEY,
};
use xln_rscore_protocol::CanonicalValue;

use super::*;

fn projected(kind: EntityTxKind) -> CanonicalEntityTx {
    CanonicalEntityTx::from_frame_projection(kind, CanonicalValue::Object(Vec::new()))
        .expect("canonical fixture")
}

fn command(author: &str, nonce: u64, kind: EntityTxKind) -> EntityPendingWork {
    EntityPendingWork::Command {
        projected: projected(EntityTxKind::EntityCommand),
        command: Box::new(SignedEntityCommandV1 {
            version: 1,
            entity_id: format!("0x{}", "11".repeat(32)),
            stack_key: UNREGISTERED_ENTITY_COMMAND_STACK_KEY.into(),
            board_hash: format!("0x{}", "22".repeat(32)),
            board_epoch: 7,
            author_signer_id: author.into(),
            author_signer: format!("0x{}", "33".repeat(20)),
            nonce: BigInt::from(nonce),
            txs_hash: format!("0x{}", "44".repeat(32)),
            txs: Vec::new(),
            signature: [0; 65],
            command_hash: format!("0x{}", "55".repeat(32)),
            native_txs: vec![LocalEntityTx::CrossJurisdiction(projected(kind))],
        }),
    }
}

fn local_batch(kind: EntityTxKind) -> EntityPendingWork {
    EntityPendingWork::LocalBatch {
        projected: vec![projected(kind)],
        native: vec![LocalEntityTx::CrossJurisdiction(projected(kind))],
    }
}

fn proposer_materialized(kind: EntityTxKind) -> EntityPendingWork {
    EntityPendingWork::ProposerMaterialized {
        projected: projected(kind),
        native: Box::new(LocalEntityTx::CrossJurisdiction(projected(kind))),
    }
}

fn label(work: &EntityPendingWork) -> String {
    match work {
        EntityPendingWork::Command { command, .. } => {
            format!("{}:{}", command.author_signer_id, command.nonce)
        }
        EntityPendingWork::Projected(tx) => tx.kind.as_str().into(),
        EntityPendingWork::LocalBatch { projected, .. } => projected.first().map_or_else(
            || "localBatch".into(),
            |tx| format!("local:{}", tx.kind.as_str()),
        ),
        EntityPendingWork::ProposerMaterialized { projected, .. } => {
            format!("proposer:{}", projected.kind.as_str())
        }
        _ => "other".into(),
    }
}

fn mixed_commit_phase_work() -> VecDeque<EntityPendingWork> {
    VecDeque::from([
        command("author-a", 0, EntityTxKind::CrossJurisdictionSalvage),
        EntityPendingWork::Projected(projected(EntityTxKind::CrossJurisdictionFillNotice)),
        command(
            "author-a",
            1,
            EntityTxKind::MaterializeCrossJurisdictionSwap,
        ),
        command("author-b", 0, EntityTxKind::CrossJurisdictionSalvage),
        command("author-a", 2, EntityTxKind::CrossJurisdictionSalvage),
        EntityPendingWork::Projected(projected(EntityTxKind::ScheduledWake)),
    ])
}

#[test]
fn account_commit_defers_setup_and_later_same_author_without_blocking_others() {
    let work = mixed_commit_phase_work();
    let admission = materialization_admission(&work).expect("admission");
    let selection = select_commit_phase_work(work, &admission, None).expect("selection");
    assert_eq!(
        selection.selected.iter().map(label).collect::<Vec<_>>(),
        [
            "author-a:0",
            "crossJurisdictionFillNotice",
            "author-b:0",
            "scheduledWake",
        ]
    );
}

#[test]
fn wire_limited_selection_restores_unconsumed_work_in_original_fifo_order() {
    let work = mixed_commit_phase_work();
    let admission = materialization_admission(&work).expect("admission");
    let mut selection = select_commit_phase_work(work, &admission, None).expect("selection");
    selection.selected.pop_front();
    selection.selected.pop_front();
    selection
        .consume_selected_prefix(2)
        .expect("consume prefix");
    assert_eq!(
        selection
            .into_remaining()
            .expect("remaining FIFO")
            .iter()
            .map(label)
            .collect::<Vec<_>>(),
        ["author-a:1", "author-b:0", "author-a:2", "scheduledWake"]
    );
}

#[test]
fn registration_without_account_transition_does_not_trigger_deferral() {
    let work = VecDeque::from([
        command("author-a", 0, EntityTxKind::RegisterCrossJurisdictionSwap),
        command("author-a", 1, EntityTxKind::CrossJurisdictionSalvage),
    ]);
    let admission = materialization_admission(&work).expect("admission");
    assert!(admission.commit_phase);
    assert!(!admission.requires_commit_phase_selection());
    let selection = select_commit_phase_work(work, &admission, None).expect("selection");
    assert_eq!(
        selection.selected.iter().map(label).collect::<Vec<_>>(),
        ["author-a:0", "author-a:1"]
    );
}

#[test]
fn bare_setup_defers_only_itself_and_nested_account_input_triggers_selection() {
    let nested_account = EntityPendingWork::ProposerMaterialized {
        projected: projected(EntityTxKind::RuntimeOutput),
        native: Box::new(LocalEntityTx::RuntimeOutput(
            CrossJurisdictionRuntimeOutput {
                source_entity_id: format!("0x{}", "11".repeat(32)),
                source_signer_id: "source".into(),
                target_entity_id: format!("0x{}", "22".repeat(32)),
                entity_txs: vec![projected(EntityTxKind::AccountInput)],
            },
        )),
    };
    let work = VecDeque::from([
        nested_account,
        proposer_materialized(EntityTxKind::MaterializeCrossJurisdictionClear),
        EntityPendingWork::Projected(projected(EntityTxKind::ScheduledWake)),
        local_batch(EntityTxKind::CrossJurisdictionSalvage),
    ]);
    let admission = materialization_admission(&work).expect("admission");
    assert!(admission.requires_commit_phase_selection());
    let local_author = format!("0x{}:7:local", "22".repeat(32));
    let selection =
        select_commit_phase_work(work, &admission, Some(&local_author)).expect("selection");
    assert_eq!(
        selection.selected.iter().map(label).collect::<Vec<_>>(),
        [
            "proposer:runtimeOutput",
            "scheduledWake",
            "local:crossJurisdictionSalvage",
        ]
    );
}

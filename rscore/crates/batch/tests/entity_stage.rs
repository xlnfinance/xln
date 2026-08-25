//! A parent Entity input is a savepoint inside the one Runtime candidate.
//! These tests pin exact retry, accept and rollback behaviour before the
//! process wire is allowed to depend on it.

mod fixture;

use xln_rscore_batch::{
    BatchError, EntityProposalSelection, EntityStageContext, EntityStageStatus, EntityWaveOps,
    StageKey, WaveOp, WaveOpsRequest, WaveProposalRequest, WaveRequest,
};

fn context(owner_entity_id: [u8; 32], timestamp: u64, propose: bool) -> EntityStageContext {
    EntityStageContext {
        owner_entity_id,
        timestamp,
        j_height: 100,
        clock: fixture::clock(timestamp),
        propose,
    }
}

fn key(byte: u8) -> StageKey {
    StageKey::from_bytes([byte; 32])
}

#[test]
fn rollback_restores_the_index_and_transcript_for_the_next_parent_input() {
    let mut stand = fixture::stand(1);
    let pair = &stand.pairs[0];
    let owner = pair.payer_entity;
    let account_id = pair.payer_account;
    let first_txs = fixture::payment(pair, 10).1;
    let second_txs = fixture::payment(pair, 11).1;
    let base = stand
        .payer
        .prepare_wave(WaveRequest {
            entities: vec![],
            post_accounts: true,
        })
        .expect("empty Runtime candidate");

    let rolled_back_key = key(1);
    let stage_context = context(owner, 1_700_000_000_000, false);
    let opened = stand
        .payer
        .begin_entity_stage(rolled_back_key, 0, stage_context)
        .expect("begin first Entity input");
    assert_eq!(opened.status, EntityStageStatus::Open);
    stand
        .payer
        .apply_wave_ops(WaveOpsRequest {
            entities: vec![EntityWaveOps {
                owner_entity_id: owner,
                ops: vec![WaveOp::Admit {
                    operation_index: 0,
                    account_id,
                    txs: first_txs,
                }],
            }],
        })
        .expect("mutate rejected parent input");
    let rolled_back = stand
        .payer
        .rollback_entity_stage(rolled_back_key, 0)
        .expect("reject parent input");
    assert_eq!(rolled_back.status, EntityStageStatus::RolledBack);
    assert_eq!(rolled_back.accepted_stage_ordinal, 0);
    assert_eq!(stand.payer.accounts_root(), base.accounts_root);
    assert_eq!(stand.payer.revision(), base.revision);
    assert_eq!(
        stand
            .payer
            .rollback_entity_stage(rolled_back_key, 0)
            .expect("idempotent rollback"),
        rolled_back,
    );
    assert_eq!(
        stand
            .payer
            .begin_entity_stage(rolled_back_key, 0, stage_context)
            .expect("idempotent terminal begin"),
        rolled_back,
    );
    assert!(matches!(
        stand.payer.accept_entity_stage(rolled_back_key, 0),
        Err(BatchError::EntityStageDecisionConflict { .. })
    ));

    let accepted_key = key(2);
    stand
        .payer
        .begin_entity_stage(accepted_key, 0, stage_context)
        .expect("begin next Entity input at the same ordinal");
    stand
        .payer
        .apply_wave_ops(WaveOpsRequest {
            entities: vec![EntityWaveOps {
                owner_entity_id: owner,
                ops: vec![WaveOp::Admit {
                    operation_index: 0,
                    account_id,
                    txs: second_txs,
                }],
            }],
        })
        .expect("rollback released operation index zero");
    let accepted = stand
        .payer
        .accept_entity_stage(accepted_key, 0)
        .expect("accept next parent input");
    assert_eq!(accepted.accepted_stage_ordinal, 1);
    let sealed = stand.payer.seal_wave().expect("seal accepted candidate");
    assert_eq!(
        sealed.admissions.len(),
        1,
        "rolled-back receipt was truncated"
    );
    assert_eq!(sealed.admissions[0].operation_index, 0);
}

#[test]
fn multiple_apply_and_propose_rounds_roll_back_exactly() {
    let mut stand = fixture::stand(1);
    let pair = &stand.pairs[0];
    let owner = pair.payer_entity;
    let account_id = pair.payer_account;
    let first_txs = fixture::payment(pair, 20).1;
    let second_txs = fixture::payment(pair, 21).1;
    let base = stand
        .payer
        .prepare_wave(WaveRequest {
            entities: vec![],
            post_accounts: true,
        })
        .expect("candidate");
    let stage_key = key(3);
    stand
        .payer
        .begin_entity_stage(stage_key, 0, context(owner, 1_700_000_001_000, true))
        .expect("stage");

    for (operation_index, txs) in [(0, first_txs), (1, second_txs)] {
        stand
            .payer
            .apply_wave_ops(WaveOpsRequest {
                entities: vec![EntityWaveOps {
                    owner_entity_id: owner,
                    ops: vec![WaveOp::Admit {
                        operation_index,
                        account_id,
                        txs,
                    }],
                }],
            })
            .expect("apply round");
        stand
            .payer
            .propose_wave(WaveProposalRequest {
                entities: vec![EntityProposalSelection {
                    owner_entity_id: owner,
                    account_ids: vec![account_id],
                }],
            })
            .expect("proposal round");
    }
    assert_ne!(stand.payer.accounts_root(), base.accounts_root);
    stand
        .payer
        .rollback_entity_stage(stage_key, 0)
        .expect("rollback all rounds");
    assert_eq!(stand.payer.accounts_root(), base.accounts_root);
    assert_eq!(stand.payer.revision(), base.revision);
    let account = stand.payer.account(&account_id).expect("account restored");
    assert!(account.mempool().is_empty());
    assert!(account.pending().is_none());
    let sealed = stand.payer.seal_wave().expect("empty candidate seals");
    assert!(sealed.applied.is_empty());
    assert!(sealed.admissions.is_empty());
    assert!(sealed.proposals.is_empty());
}

#[test]
fn accept_keeps_mutations_but_removes_the_stage_context() {
    let mut stand = fixture::stand(1);
    let pair = &stand.pairs[0];
    let owner = pair.payer_entity;
    let account_id = pair.payer_account;
    let txs = fixture::payment(pair, 30).1;
    let timestamp = 1_700_000_002_000;
    stand
        .payer
        .prepare_wave(WaveRequest {
            entities: vec![],
            post_accounts: true,
        })
        .expect("candidate");
    let stage_key = key(4);
    let stage_context = context(owner, timestamp, true);
    stand
        .payer
        .begin_entity_stage(stage_key, 0, stage_context)
        .expect("stage");
    stand
        .payer
        .apply_wave_ops(WaveOpsRequest {
            entities: vec![EntityWaveOps {
                owner_entity_id: owner,
                ops: vec![WaveOp::Admit {
                    operation_index: 0,
                    account_id,
                    txs,
                }],
            }],
        })
        .expect("apply");
    let proposal = stand
        .payer
        .propose_wave(WaveProposalRequest {
            entities: vec![EntityProposalSelection {
                owner_entity_id: owner,
                account_ids: vec![account_id],
            }],
        })
        .expect("propose");
    assert_eq!(
        proposal.proposals[0]
            .proposed
            .as_ref()
            .expect("frame")
            .frame
            .timestamp,
        timestamp,
    );
    let receipt = stand
        .payer
        .accept_entity_stage(stage_key, 0)
        .expect("accept");
    assert_eq!(receipt.status, EntityStageStatus::Accepted);
    assert_eq!(receipt.accepted_stage_ordinal, 1);
    assert_eq!(
        stand
            .payer
            .accept_entity_stage(stage_key, 0)
            .expect("idempotent accept"),
        receipt,
    );
    assert!(
        stand
            .payer
            .account(&account_id)
            .expect("account")
            .pending()
            .is_some()
    );
    let sealed = stand.payer.seal_wave().expect("seal retained mutation");
    assert_eq!(sealed.admissions.len(), 1);
    assert_eq!(sealed.proposals.len(), 1);
}

#[test]
fn an_open_stage_blocks_seal_commit_and_checkpoint() {
    let mut stand = fixture::stand(1);
    let owner = stand.pairs[0].payer_entity;
    let prepared = stand
        .payer
        .prepare_wave(WaveRequest {
            entities: vec![],
            post_accounts: true,
        })
        .expect("candidate");
    let stage_key = key(5);
    stand
        .payer
        .begin_entity_stage(stage_key, 0, context(owner, 1_700_000_003_000, false))
        .expect("stage");
    assert!(matches!(
        stand.payer.seal_wave(),
        Err(BatchError::EntityStageOpen(key)) if key == stage_key
    ));
    assert!(matches!(
        stand.payer.commit_wave(prepared.candidate_id),
        Err(BatchError::EntityStageOpen(key)) if key == stage_key
    ));
    assert!(matches!(
        stand.payer.checkpoint_token(),
        Err(BatchError::EntityStageOpen(key)) if key == stage_key
    ));
    assert!(matches!(
        stand.payer.checkpoint_changes_for_wave(prepared.candidate_id),
        Err(BatchError::EntityStageOpen(key)) if key == stage_key
    ));
}

#[test]
fn whole_wave_abort_discards_an_open_stage_and_its_mutations() {
    let mut stand = fixture::stand(1);
    let pair = &stand.pairs[0];
    let owner = pair.payer_entity;
    let account_id = pair.payer_account;
    let txs = fixture::payment(pair, 40).1;
    let base_root = stand.payer.accounts_root();
    let base_revision = stand.payer.revision();
    let prepared = stand
        .payer
        .prepare_wave(WaveRequest {
            entities: vec![],
            post_accounts: true,
        })
        .expect("candidate");
    let stage_key = key(6);
    stand
        .payer
        .begin_entity_stage(stage_key, 0, context(owner, 1_700_000_004_000, false))
        .expect("stage");
    stand
        .payer
        .apply_wave_ops(WaveOpsRequest {
            entities: vec![EntityWaveOps {
                owner_entity_id: owner,
                ops: vec![WaveOp::Admit {
                    operation_index: 0,
                    account_id,
                    txs,
                }],
            }],
        })
        .expect("mutate");
    stand
        .payer
        .abort_wave(prepared.candidate_id)
        .expect("whole Runtime candidate abort remains legal");
    assert_eq!(stand.payer.accounts_root(), base_root);
    assert_eq!(stand.payer.revision(), base_revision);
    assert!(!stand.payer.wave_pending());
    assert!(matches!(
        stand.payer.require_entity_stage(stage_key),
        Err(BatchError::WaveMissing)
    ));
}

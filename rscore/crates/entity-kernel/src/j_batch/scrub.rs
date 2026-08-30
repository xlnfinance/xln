use super::{HashLadderRegistration, JBatch, JBatchState, batch_is_empty, proof_body_hash};

fn remove_matching<T>(rows: &mut Vec<T>, mut remove: impl FnMut(&T) -> bool) -> usize {
    let before = rows.len();
    rows.retain(|row| !remove(row));
    before - rows.len()
}

pub(crate) fn scrub_dispute_finalizations_for_counterparty(
    batch: &mut JBatch,
    counterparty: &[u8; 32],
) -> usize {
    remove_matching(&mut batch.dispute_finalizations, |row| {
        &row.counterentity == counterparty
    })
}

pub(crate) fn scrub_dispute_starts_for_counterparty(
    batch: &mut JBatch,
    counterparty: &[u8; 32],
) -> usize {
    remove_matching(&mut batch.dispute_starts, |row| {
        &row.counterentity == counterparty
    })
}

pub(crate) fn scrub_counter_disputes_for_active_start(
    batch: &mut JBatch,
    counterparty: &[u8; 32],
    initial_proof_body_hash: &[u8; 32],
) -> usize {
    remove_matching(&mut batch.counter_disputes, |row| {
        &row.counterentity == counterparty && &row.initial_proofbody_hash != initial_proof_body_hash
    })
}

pub(crate) fn scrub_counter_disputes_for_counterparty(
    batch: &mut JBatch,
    counterparty: &[u8; 32],
) -> usize {
    remove_matching(&mut batch.counter_disputes, |row| {
        &row.counterentity == counterparty
    })
}

/// Keep only branches that still outrank an authenticated on-chain selection.
/// Depository ordering is nonce first, then LEFT at equal nonce. Exact rows are
/// retained only for an immutable sent batch that still owns its chain ACK.
pub(crate) fn scrub_counter_disputes_superseded_by_observed(
    batch: &mut JBatch,
    counterparty: &[u8; 32],
    observed_nonce: u64,
    observed_proposer_is_left: bool,
    observed_proof_body_hash: &[u8; 32],
    preserve_exact: bool,
) -> Result<usize, super::JBatchError> {
    let mut error = None;
    let removed = remove_matching(&mut batch.counter_disputes, |row| {
        if &row.counterentity != counterparty {
            return false;
        }
        let nonce = if row.counter_nonce > ethabi::ethereum_types::U256::from(u64::MAX) {
            error = Some(super::JBatchError::Abi("counterNonce:width".into()));
            return false;
        } else {
            row.counter_nonce.low_u64()
        };
        if nonce != observed_nonce {
            return nonce < observed_nonce;
        }
        if row.proposer_is_left != observed_proposer_is_left {
            return !row.proposer_is_left && observed_proposer_is_left;
        }
        match proof_body_hash(&row.counter_proofbody) {
            Ok(hash) => !(preserve_exact && &hash == observed_proof_body_hash),
            Err(found) => {
                error = Some(found);
                false
            }
        }
    });
    error.map_or(Ok(removed), Err)
}

pub(crate) fn scrub_source_registrations_for_counterparty(
    batch: &mut JBatch,
    counterparty: &[u8; 32],
) -> usize {
    remove_matching(
        &mut batch.hash_ladder_registrations,
        |row: &HashLadderRegistration| !row.target_role && &row.counterparty_entity == counterparty,
    )
}

pub(crate) fn prune_empty_recovery_batches(state: &mut JBatchState) {
    state
        .recovery_batches
        .retain(|batch| !batch_is_empty(batch));
}

pub(crate) fn prepend_recovery_batch(state: &mut JBatchState, batch: JBatch) {
    if !batch_is_empty(&batch) {
        state.recovery_batches.insert(0, batch);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::j_batch::{FinalDisputeProof, InitialDisputeProof, ProofBody};
    use ethabi::ethereum_types::U256;

    fn body() -> ProofBody {
        ProofBody {
            watch_seed: [0; 32],
            left_response_seconds: 1,
            right_response_seconds: 1,
            offdeltas: Vec::new(),
            token_ids: Vec::new(),
            transformers: Vec::new(),
        }
    }

    #[test]
    fn scrubs_only_named_account_and_preserves_public_target_registration() {
        let target = [0x11; 32];
        let other = [0x22; 32];
        let mut batch = JBatch {
            dispute_starts: [target, other]
                .into_iter()
                .map(|counterentity| InitialDisputeProof {
                    counterentity,
                    nonce: U256::one(),
                    proposer_is_left: true,
                    proofbody_hash: [1; 32],
                    initial_proofbody: body(),
                    watch_seed: [0; 32],
                    sig: Vec::new(),
                    starter_initial_arguments: Vec::new(),
                    starter_counter_arguments: Vec::new(),
                    starter_counter_proof_commitment: [0; 32],
                })
                .collect(),
            ..JBatch::default()
        };
        batch.dispute_finalizations.push(FinalDisputeProof {
            counterentity: target,
            initial_nonce: U256::one(),
            final_nonce: U256::one(),
            proposer_is_left: true,
            initial_proofbody_hash: [1; 32],
            final_proofbody: body(),
            starter_arguments: Vec::new(),
            other_arguments: Vec::new(),
            sig: Vec::new(),
            started_by_left: true,
            cooperative: false,
            submit_not_before_timestamp: None,
        });
        batch.hash_ladder_registrations.extend([
            HashLadderRegistration {
                counterparty_entity: target,
                target_role: false,
                full_hash: [0; 32],
                partial_root: [0; 32],
                witness: crate::j_batch::HashLadderWitness {
                    fill_ratio: 1,
                    full_secret: [0; 32],
                    reveals: [[0; 32]; 4],
                },
            },
            HashLadderRegistration {
                counterparty_entity: target,
                target_role: true,
                full_hash: [0; 32],
                partial_root: [0; 32],
                witness: crate::j_batch::HashLadderWitness {
                    fill_ratio: 1,
                    full_secret: [0; 32],
                    reveals: [[0; 32]; 4],
                },
            },
        ]);
        assert_eq!(
            scrub_dispute_starts_for_counterparty(&mut batch, &target),
            1
        );
        assert_eq!(
            scrub_dispute_finalizations_for_counterparty(&mut batch, &target),
            1
        );
        assert_eq!(
            scrub_source_registrations_for_counterparty(&mut batch, &target),
            1
        );
        assert_eq!(batch.dispute_starts[0].counterentity, other);
        assert!(batch.hash_ladder_registrations[0].target_role);
    }
}

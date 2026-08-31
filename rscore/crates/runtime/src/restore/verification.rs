use super::{
    ExactRestoreError, ExactRestoreTarget, RestoreBoundary, RestoreCommitments, RestoreDigest,
    RestoreHead, RestoreStage,
};

pub(super) fn backend(stage: RestoreStage, error: impl std::fmt::Display) -> ExactRestoreError {
    ExactRestoreError::Backend {
        stage,
        detail: error.to_string(),
    }
}

fn digest_hex(value: &RestoreDigest) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(66);
    output.push_str("0x");
    for byte in value {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}

pub(super) fn compare_digest(
    boundary: RestoreBoundary,
    expected: Option<RestoreDigest>,
    actual: Option<RestoreDigest>,
) -> Result<(), ExactRestoreError> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let actual = actual.ok_or(ExactRestoreError::CommitmentMissing { boundary })?;
    if expected == actual {
        Ok(())
    } else {
        Err(ExactRestoreError::CommitmentMismatch {
            boundary,
            expected: digest_hex(&expected),
            actual: digest_hex(&actual),
        })
    }
}

fn compare_count(
    boundary: RestoreBoundary,
    expected: Option<u64>,
    actual: Option<u64>,
) -> Result<(), ExactRestoreError> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let actual = actual.ok_or(ExactRestoreError::CommitmentMissing { boundary })?;
    if expected == actual {
        Ok(())
    } else {
        Err(ExactRestoreError::CommitmentMismatch {
            boundary,
            expected: expected.to_string(),
            actual: actual.to_string(),
        })
    }
}

fn verify_commitments(
    expected: &RestoreCommitments,
    actual: &RestoreCommitments,
) -> Result<(), ExactRestoreError> {
    for (boundary, expected, actual) in [
        (
            RestoreBoundary::RuntimeMachineRoot,
            expected.runtime_machine_root,
            actual.runtime_machine_root,
        ),
        (
            RestoreBoundary::CanonicalStateHash,
            expected.canonical_state_hash,
            actual.canonical_state_hash,
        ),
        (
            RestoreBoundary::PostStateHash,
            expected.post_state_hash,
            actual.post_state_hash,
        ),
        (
            RestoreBoundary::EntityStateRoot,
            expected.entity_state_root,
            actual.entity_state_root,
        ),
        (
            RestoreBoundary::AccountsRoot,
            expected.accounts_root,
            actual.accounts_root,
        ),
        (
            RestoreBoundary::PaybookRoot,
            expected.paybook_root,
            actual.paybook_root,
        ),
        (
            RestoreBoundary::OrderbookRoot,
            expected.orderbook_root,
            actual.orderbook_root,
        ),
        (
            RestoreBoundary::OutputsDigest,
            expected.outputs_digest,
            actual.outputs_digest,
        ),
        (
            RestoreBoundary::EventsDigest,
            expected.events_digest,
            actual.events_digest,
        ),
    ] {
        compare_digest(boundary, expected, actual)?;
    }
    compare_count(
        RestoreBoundary::OutputCount,
        expected.output_count,
        actual.output_count,
    )?;
    compare_count(
        RestoreBoundary::EventCount,
        expected.event_count,
        actual.event_count,
    )
}

pub(super) fn verify_head(
    expected_height: u64,
    expected_timestamp: u64,
    expected: &RestoreCommitments,
    actual: &RestoreHead,
) -> Result<(), ExactRestoreError> {
    if actual.height != expected_height {
        return Err(ExactRestoreError::HeadMismatch {
            field: "height",
            expected: expected_height,
            actual: actual.height,
        });
    }
    if actual.timestamp != expected_timestamp {
        return Err(ExactRestoreError::HeadMismatch {
            field: "timestamp",
            expected: expected_timestamp,
            actual: actual.timestamp,
        });
    }
    verify_commitments(expected, &actual.commitments)
}

pub(super) fn inspect<T: ExactRestoreTarget>(target: &T) -> Result<RestoreHead, ExactRestoreError> {
    target
        .head()
        .map_err(|error| backend(RestoreStage::Inspect, error))
}

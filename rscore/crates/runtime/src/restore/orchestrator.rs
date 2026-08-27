//! Atomic checkpoint + WAL restoration for the single-Entity Rust Runtime.

use thiserror::Error;

use super::verification::{backend, compare_digest, inspect, verify_head};
use super::{
    DurableRuntimeIdentity, ExactRuntimeCheckpoint, ExactRuntimeWalFrame, RestoreBoundary,
    RestoreHead,
};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestoreStage {
    Fork,
    Accounts,
    Entity,
    Runtime,
    Wal,
    Inspect,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ExactRestoreError {
    #[error("RRS_RESTORE_IDENTITY_REQUIRED:height={height}:accountCount=0")]
    IdentityRequired { height: u64 },
    #[error("RRS_RESTORE_IDENTITY_INVALID:{field}")]
    IdentityInvalid { field: &'static str },
    #[error("RRS_RESTORE_NUMBER_UNSAFE:field={field}:value={value}")]
    UnsafeNumber { field: &'static str, value: u64 },
    #[error("RRS_RESTORE_WAL_GAP:expected={expected}:actual={actual}")]
    WalGap { expected: u64, actual: u64 },
    #[error("RRS_RESTORE_TIMESTAMP_REGRESSION:previous={previous}:actual={actual}:height={height}")]
    TimestampRegression {
        previous: u64,
        actual: u64,
        height: u64,
    },
    #[error("RRS_RESTORE_HEAD_MISMATCH:field={field}:expected={expected}:actual={actual}")]
    HeadMismatch {
        field: &'static str,
        expected: u64,
        actual: u64,
    },
    #[error("RRS_RESTORE_COMMITMENT_MISSING:boundary={boundary:?}")]
    CommitmentMissing { boundary: RestoreBoundary },
    #[error(
        "RRS_RESTORE_COMMITMENT_MISMATCH:boundary={boundary:?}:expected={expected}:actual={actual}"
    )]
    CommitmentMismatch {
        boundary: RestoreBoundary,
        expected: String,
        actual: String,
    },
    #[error("RRS_RESTORE_BACKEND:stage={stage:?}:detail={detail}")]
    Backend { stage: RestoreStage, detail: String },
}

/// A candidate must own detached Account shards, Entity state and Runtime
/// envelope. Implementations must not share interior mutable state with `self`:
/// the orchestrator publishes the candidate only after the full WAL tail has
/// passed every commitment check.
pub trait ExactRestoreTarget: Sized {
    type CheckpointPayload;
    type RuntimeInput;
    type Error: std::fmt::Display;

    fn fork_restore_candidate(&self) -> Result<Self, Self::Error>;

    fn restore_account_shards(
        &mut self,
        checkpoint: &ExactRuntimeCheckpoint<Self::CheckpointPayload>,
    ) -> Result<(), Self::Error>;

    fn restore_entity(
        &mut self,
        checkpoint: &ExactRuntimeCheckpoint<Self::CheckpointPayload>,
    ) -> Result<(), Self::Error>;

    fn restore_runtime(
        &mut self,
        checkpoint: &ExactRuntimeCheckpoint<Self::CheckpointPayload>,
    ) -> Result<(), Self::Error>;

    fn apply_runtime_wal_frame(
        &mut self,
        frame: &ExactRuntimeWalFrame<Self::RuntimeInput>,
    ) -> Result<(), Self::Error>;

    fn head(&self) -> Result<RestoreHead, Self::Error>;
}

fn validate_identity(identity: &DurableRuntimeIdentity) -> Result<(), ExactRestoreError> {
    if identity.runtime_id.trim().is_empty() {
        return Err(ExactRestoreError::IdentityInvalid { field: "runtimeId" });
    }
    if identity.signer_id.trim().is_empty() {
        return Err(ExactRestoreError::IdentityInvalid { field: "signerId" });
    }
    Ok(())
}

/// Restore into a detached candidate, replay the exact ordered WAL tail, and
/// return the candidate only after all available roots, outbox and event
/// commitments match. `live` is never mutated, including on a backend error.
pub fn restore_exact_runtime<T: ExactRestoreTarget>(
    live: &T,
    checkpoint: &ExactRuntimeCheckpoint<T::CheckpointPayload>,
    frames: &[ExactRuntimeWalFrame<T::RuntimeInput>],
) -> Result<T, ExactRestoreError> {
    if checkpoint.height > MAX_SAFE_INTEGER {
        return Err(ExactRestoreError::UnsafeNumber {
            field: "checkpoint.height",
            value: checkpoint.height,
        });
    }
    if checkpoint.timestamp > MAX_SAFE_INTEGER {
        return Err(ExactRestoreError::UnsafeNumber {
            field: "checkpoint.timestamp",
            value: checkpoint.timestamp,
        });
    }
    if checkpoint.account_count == 0 && checkpoint.identity.is_none() {
        return Err(ExactRestoreError::IdentityRequired {
            height: checkpoint.height,
        });
    }
    if let Some(identity) = checkpoint.identity.as_ref() {
        validate_identity(identity)?;
    }

    let mut candidate = live
        .fork_restore_candidate()
        .map_err(|error| backend(RestoreStage::Fork, error))?;
    candidate
        .restore_account_shards(checkpoint)
        .map_err(|error| backend(RestoreStage::Accounts, error))?;
    let account_head = inspect(&candidate)?;
    compare_digest(
        RestoreBoundary::AccountsRoot,
        checkpoint.expected.accounts_root,
        account_head.commitments.accounts_root,
    )?;
    candidate
        .restore_entity(checkpoint)
        .map_err(|error| backend(RestoreStage::Entity, error))?;
    let entity_head = inspect(&candidate)?;
    for (boundary, expected, actual) in [
        (
            RestoreBoundary::EntityStateRoot,
            checkpoint.expected.entity_state_root,
            entity_head.commitments.entity_state_root,
        ),
        (
            RestoreBoundary::AccountsRoot,
            checkpoint.expected.accounts_root,
            entity_head.commitments.accounts_root,
        ),
        (
            RestoreBoundary::PaybookRoot,
            checkpoint.expected.paybook_root,
            entity_head.commitments.paybook_root,
        ),
        (
            RestoreBoundary::OrderbookRoot,
            checkpoint.expected.orderbook_root,
            entity_head.commitments.orderbook_root,
        ),
    ] {
        compare_digest(boundary, expected, actual)?;
    }
    candidate
        .restore_runtime(checkpoint)
        .map_err(|error| backend(RestoreStage::Runtime, error))?;
    verify_head(
        checkpoint.height,
        checkpoint.timestamp,
        &checkpoint.expected,
        &inspect(&candidate)?,
    )?;

    let mut expected_height =
        checkpoint
            .height
            .checked_add(1)
            .ok_or(ExactRestoreError::UnsafeNumber {
                field: "wal.height",
                value: checkpoint.height,
            })?;
    let mut previous_timestamp = checkpoint.timestamp;
    for frame in frames {
        if frame.height != expected_height {
            return Err(ExactRestoreError::WalGap {
                expected: expected_height,
                actual: frame.height,
            });
        }
        if frame.height > MAX_SAFE_INTEGER || frame.timestamp > MAX_SAFE_INTEGER {
            return Err(ExactRestoreError::UnsafeNumber {
                field: if frame.height > MAX_SAFE_INTEGER {
                    "wal.height"
                } else {
                    "wal.timestamp"
                },
                value: if frame.height > MAX_SAFE_INTEGER {
                    frame.height
                } else {
                    frame.timestamp
                },
            });
        }
        if frame.timestamp < previous_timestamp {
            return Err(ExactRestoreError::TimestampRegression {
                previous: previous_timestamp,
                actual: frame.timestamp,
                height: frame.height,
            });
        }
        candidate
            .apply_runtime_wal_frame(frame)
            .map_err(|error| backend(RestoreStage::Wal, error))?;
        verify_head(
            frame.height,
            frame.timestamp,
            &frame.expected,
            &inspect(&candidate)?,
        )?;
        previous_timestamp = frame.timestamp;
        expected_height = frame
            .height
            .checked_add(1)
            .ok_or(ExactRestoreError::UnsafeNumber {
                field: "wal.height",
                value: frame.height,
            })?;
    }
    Ok(candidate)
}

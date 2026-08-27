//! Concrete single-Entity Runtime checkpoint and decoded-WAL restoration.

use std::sync::Arc;

use serde_json::Value;
use sha2::{Digest as _, Sha256};
use thiserror::Error;
use xln_rscore_batch::{BatchError, CheckpointToken, EngineGeneration, ResidentConsensusEngine};
use xln_rscore_crypto::KeyDerivationError;
use xln_rscore_engine::SwapMarketPolicy;
use xln_rscore_entity_kernel::{
    EntityKernelError, EntitySingleSigner, EntityStateSnapshot, ResidentEntityConsensusReplica,
    compute_entity_consensus_root, compute_entity_owned_sections,
    project_entity_consensus_sections, restore_entity_state,
};

use crate::{
    CertifiedBoardRegistry, RuntimeDurableEnvelope, RuntimeInput, RuntimeLimits,
    RuntimeMachineError, RuntimeReplica, RuntimeState, StoredRscoreCheckpoint, apply_runtime,
};

use super::{AccountWireRestoreError, decode_account_rows};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub struct DecodedRuntimeCheckpoint {
    pub runtime_height: u64,
    pub runtime_timestamp: u64,
    pub durable_envelope: RuntimeDurableEnvelope,
    pub expected_protocol_fingerprint: [u8; 32],
    pub stored_accounts: StoredRscoreCheckpoint,
    pub entity_snapshot: EntityStateSnapshot,
    /// Complete live Entity consensus envelope restored from the canonical
    /// 0x21/0x26/0x36-0x38 graph. It is installed inside RuntimeReplica; there
    /// is no second carried-section sidecar that can drift from the machine.
    pub entity_consensus: ResidentEntityConsensusReplica,
    /// Entity signer derived from the same operator seed and durable signer
    /// identity as the Account engine, then bound to the restored authority.
    pub entity_signer: EntitySingleSigner,
    /// Exact Entity-certified peer board registry restored from path-keyed
    /// 0x2a rows and bound to `entity_snapshot.certifiedBoardState`.
    pub certified_board_registry: CertifiedBoardRegistry,
    /// Exact static Entity execution policy projected once from the
    /// authenticated checkpoint graph. WAL replay combines it only with each
    /// frame's independently authenticated prepared-context rows.
    pub entity_context_policy: Value,
    /// Exact canonical 0x26 live EntityReplica envelope.
    pub replica_metadata: Value,
    pub expected_entity_root: [u8; 32],
    /// Derived exactly once from the operator keyring label and already bound
    /// to the canonical 0x26 signer address by checkpoint decoding.
    pub signer_private_key: [u8; 32],
    pub signer_id: String,
    pub worker_count: usize,
    pub limits: RuntimeLimits,
    pub swap_market: Arc<SwapMarketPolicy>,
}

pub struct DecodedRuntimeWalFrame {
    pub height: u64,
    pub timestamp: u64,
    pub input: RuntimeInput,
    /// The global Account forest root is explicit only on Runtime checkpoint
    /// cadence. Non-checkpoint WAL frames are still independently bound by
    /// their certified Entity root, whose owned Account section commits this
    /// same root; callers must never feed the just-computed Rust value back as
    /// fake expected evidence.
    pub expected_accounts_root: Option<[u8; 32]>,
    pub expected_entity_root: [u8; 32],
}

pub struct RestoredRuntime {
    pub replica: RuntimeReplica,
}

#[derive(Debug, Error)]
pub enum ConcreteRestoreError {
    #[error("RRS_RESTORE_CHECKPOINT_NUMBER_UNSAFE:field={field}:value={value}")]
    UnsafeNumber { field: &'static str, value: u64 },
    #[error("RRS_RESTORE_CHECKPOINT_FINGERPRINT")]
    ProtocolFingerprint,
    #[error("RRS_RESTORE_CHECKPOINT_SIGNER_REQUIRED")]
    SignerRequired,
    #[error("RRS_RESTORE_CHECKPOINT_OWNER_MISMATCH")]
    OwnerMismatch,
    #[error("RRS_RESTORE_CHECKPOINT_ENTITY_ROOT:expected={expected}:actual={actual}")]
    EntityRoot { expected: String, actual: String },
    #[error("RRS_RESTORE_WAL_HEIGHT:expected={expected}:actual={actual}")]
    WalHeight { expected: u64, actual: u64 },
    #[error("RRS_RESTORE_WAL_TIMESTAMP:frame={frame}:input={input}")]
    WalTimestamp { frame: u64, input: u64 },
    #[error("RRS_RESTORE_WAL_ACCOUNTS_ROOT:height={height}:expected={expected}:actual={actual}")]
    AccountsRoot {
        height: u64,
        expected: String,
        actual: String,
    },
    #[error(transparent)]
    Key(#[from] KeyDerivationError),
    #[error(transparent)]
    Batch(#[from] BatchError),
    #[error(transparent)]
    Entity(#[from] EntityKernelError),
    #[error(transparent)]
    Machine(#[from] RuntimeMachineError),
    #[error(transparent)]
    AccountWire(#[from] AccountWireRestoreError),
    #[error("RRS_RESTORE_ENTITY_MANIFEST:{0}")]
    EntityManifest(String),
}

fn hex(value: &[u8; 32]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(66);
    output.push_str("0x");
    for byte in value {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

fn parse_hex(value: &str) -> Result<[u8; 32], ConcreteRestoreError> {
    let payload = value
        .strip_prefix("0x")
        .filter(|payload| payload.len() == 64)
        .ok_or_else(|| ConcreteRestoreError::EntityManifest(value.to_string()))?;
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&payload[index * 2..index * 2 + 2], 16)
            .map_err(|_| ConcreteRestoreError::EntityManifest(value.to_string()))?;
    }
    Ok(output)
}

fn generation(checkpoint: &DecodedRuntimeCheckpoint) -> EngineGeneration {
    let mut digest = Sha256::new();
    digest.update(b"xln.rscore.runtime.restore.generation.v1");
    digest.update(checkpoint.stored_accounts.owner_entity_id);
    digest.update(checkpoint.runtime_height.to_be_bytes());
    digest.update(checkpoint.stored_accounts.revision.to_be_bytes());
    let digest: [u8; 32] = digest.finalize().into();
    let mut generation = [0_u8; 8];
    generation.copy_from_slice(&digest[..8]);
    EngineGeneration::from_bytes(generation)
}

fn assert_entity_root(
    sections: &[xln_rscore_entity_kernel::EntityConsensusSection],
    expected: [u8; 32],
) -> Result<(), ConcreteRestoreError> {
    let actual = compute_entity_consensus_root(sections)
        .map_err(|error| ConcreteRestoreError::EntityManifest(error.to_string()))?;
    let actual_bytes = parse_hex(&actual)?;
    if actual_bytes == expected {
        Ok(())
    } else {
        Err(ConcreteRestoreError::EntityRoot {
            expected: hex(&expected),
            actual,
        })
    }
}

fn assert_accounts_root(
    height: u64,
    actual: [u8; 32],
    expected: Option<[u8; 32]>,
) -> Result<(), ConcreteRestoreError> {
    let Some(expected) = expected else {
        return Ok(());
    };
    if actual == expected {
        Ok(())
    } else {
        Err(ConcreteRestoreError::AccountsRoot {
            height,
            expected: hex(&expected),
            actual: hex(&actual),
        })
    }
}

/// Build a new live Runtime value beside any existing process state. Failure
/// drops the candidate; no live Runtime, Account shard or output publisher is
/// reachable from this function until every checkpoint commitment passes.
pub fn restore_decoded_runtime_checkpoint(
    checkpoint: DecodedRuntimeCheckpoint,
) -> Result<RestoredRuntime, ConcreteRestoreError> {
    for (field, value) in [
        ("runtimeHeight", checkpoint.runtime_height),
        ("runtimeTimestamp", checkpoint.runtime_timestamp),
    ] {
        if value > MAX_SAFE_INTEGER {
            return Err(ConcreteRestoreError::UnsafeNumber { field, value });
        }
    }
    if checkpoint.signer_id.is_empty() {
        return Err(ConcreteRestoreError::SignerRequired);
    }
    let stored = &checkpoint.stored_accounts;
    if stored.protocol_fingerprint != checkpoint.expected_protocol_fingerprint {
        return Err(ConcreteRestoreError::ProtocolFingerprint);
    }
    if checkpoint.entity_snapshot.entity_id != hex(&stored.owner_entity_id) {
        return Err(ConcreteRestoreError::OwnerMismatch);
    }
    let private_key = checkpoint.signer_private_key;
    let account_rows = decode_account_rows(&stored.accounts)?;
    let token = CheckpointToken {
        base_revision: stored.base_revision,
        revision: stored.revision,
        accounts_root: stored.accounts_root,
        signer_digest: stored.signer_digest,
        account_count: stored.account_count,
    };
    let accounts = ResidentConsensusEngine::restore_exact(
        generation(&checkpoint),
        checkpoint.worker_count,
        private_key,
        checkpoint.signer_id.clone(),
        checkpoint.swap_market,
        token,
        account_rows,
    )?;
    let entity = restore_entity_state(
        checkpoint.entity_snapshot,
        stored.accounts_root,
        stored.account_count,
    )?;
    let owned = compute_entity_owned_sections(&entity, stored.accounts_root, stored.account_count)?;
    let mut entity_consensus = checkpoint.entity_consensus;
    entity_consensus.state.sections = project_entity_consensus_sections(
        &entity_consensus.state.sections,
        owned,
        &entity_consensus.state.authority,
    )
    .map_err(|error| ConcreteRestoreError::EntityManifest(error.to_string()))?;
    assert_entity_root(
        &entity_consensus.state.sections,
        checkpoint.expected_entity_root,
    )?;
    let finalized_j_height = entity.last_finalized_j_height;
    let mut replica = RuntimeReplica::new(
        RuntimeState {
            height: checkpoint.runtime_height,
            timestamp: checkpoint.runtime_timestamp,
            finalized_j_height,
            accounts_root: stored.accounts_root,
            entity,
        },
        checkpoint.durable_envelope,
        stored.owner_entity_id,
        checkpoint.signer_id,
        accounts,
        entity_consensus,
        checkpoint.entity_signer,
        stored.protocol_fingerprint,
        checkpoint.limits,
    )?;
    replica.install_certified_board_registry(checkpoint.certified_board_registry);
    replica.install_replica_metadata(checkpoint.replica_metadata)?;
    Ok(RestoredRuntime { replica })
}

/// Apply already-decoded canonical Runtime inputs in strict WAL order. Each
/// step checks the existing Account root and Entity frame root or drops the
/// whole candidate; output publication remains disabled during restore.
pub fn replay_decoded_runtime_wal(
    mut restored: RestoredRuntime,
    frames: Vec<DecodedRuntimeWalFrame>,
) -> Result<RestoredRuntime, ConcreteRestoreError> {
    for frame in frames {
        let expected_height = restored.replica.state.height.checked_add(1).ok_or(
            ConcreteRestoreError::UnsafeNumber {
                field: "wal.height",
                value: restored.replica.state.height,
            },
        )?;
        if frame.height != expected_height {
            return Err(ConcreteRestoreError::WalHeight {
                expected: expected_height,
                actual: frame.height,
            });
        }
        if frame.timestamp != frame.input.frame.timestamp {
            return Err(ConcreteRestoreError::WalTimestamp {
                frame: frame.timestamp,
                input: frame.input.frame.timestamp,
            });
        }
        let applied = apply_runtime(restored.replica, frame.input)?;
        if applied.replica.state.height != frame.height {
            return Err(ConcreteRestoreError::WalHeight {
                expected: frame.height,
                actual: applied.replica.state.height,
            });
        }
        assert_accounts_root(
            frame.height,
            applied.replica.state.accounts_root,
            frame.expected_accounts_root,
        )?;
        assert_entity_root(
            &applied.replica.entity_consensus.state.sections,
            frame.expected_entity_root,
        )?;
        restored.replica = applied.replica;
    }
    Ok(restored)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noncheckpoint_wal_frame_does_not_invent_an_expected_accounts_root() {
        assert_accounts_root(7, [0xaa; 32], None).expect("non-checkpoint root is nested evidence");
        assert!(matches!(
            assert_accounts_root(100, [0xaa; 32], Some([0xbb; 32])),
            Err(ConcreteRestoreError::AccountsRoot { height: 100, .. })
        ));
    }
}

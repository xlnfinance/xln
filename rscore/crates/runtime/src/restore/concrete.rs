//! Concrete owner-scoped Runtime checkpoint and decoded-WAL restoration.

use std::collections::BTreeMap;
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
    RuntimeDurableEnvelope, RuntimeEntityKey, RuntimeInput, RuntimeLimits, RuntimeMachineError,
    RuntimeReplica, RuntimeState, StoredRscoreCheckpoint, apply_runtime,
};

use super::{AccountWireRestoreError, decode_account_rows};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub struct DecodedRuntimeCheckpoint {
    pub runtime_seed: String,
    pub entity_import_keys: BTreeMap<String, [u8; 32]>,
    pub runtime_height: u64,
    pub runtime_timestamp: u64,
    pub durable_envelope: RuntimeDurableEnvelope,
    pub expected_protocol_fingerprint: [u8; 32],
    pub entities: Vec<DecodedRuntimeEntityCheckpoint>,
    pub worker_count: usize,
    pub limits: RuntimeLimits,
    pub swap_market: Arc<SwapMarketPolicy>,
}

/// One inert owner slot decoded from the existing authenticated checkpoint.
/// This grouping is never persisted and cannot replace a committed graph.
pub struct DecodedRuntimeEntityCheckpoint {
    pub stored_accounts: StoredRscoreCheckpoint,
    pub entity_snapshot: EntityStateSnapshot,
    /// Complete live Entity consensus envelope restored from the canonical
    /// 0x21/0x26/0x36-0x38 graph. It is installed inside RuntimeReplica; there
    /// is no second carried-section sidecar that can drift from the machine.
    pub entity_consensus: ResidentEntityConsensusReplica,
    /// Entity signer derived from the same operator seed and durable signer
    /// identity as the Account engine, then bound to the restored authority.
    pub entity_signer: EntitySingleSigner,
    /// Exact public HTLC fee policy projected from authenticated Entity state.
    /// The Entity encryption public key stays in `entity_snapshot`; the
    /// private key and liveness remain operator/network infrastructure.
    pub htlc_routing_fee_ppm: u32,
    pub htlc_routing_base_fee: num_bigint::BigInt,
    /// Exact canonical 0x26 live EntityReplica envelope.
    pub replica_metadata: Value,
    pub expected_entity_root: [u8; 32],
    /// Derived exactly once from the operator keyring label and already bound
    /// to the canonical 0x26 signer address by checkpoint decoding.
    pub signer_private_key: [u8; 32],
    pub signer_id: String,
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
    /// Canonical Runtime hashes may re-commit an unchanged Entity on a
    /// Runtime-only frame. Retain the Entity id with the root instead of
    /// inferring its owner from a newly emitted Entity output.
    pub expected_entity_roots: Option<Vec<ExpectedEntityRoot>>,
    pub expected_previous_frame_hash: [u8; 32],
    pub expected_frame_hash: [u8; 32],
    /// The frame's committed canonical Runtime state hash, when the frame
    /// carries one. Exposed from the one validation pass the decode already
    /// runs so callers never re-parse the frame to read it.
    pub canonical_state_hash: Option<[u8; 32]>,
}

#[derive(Debug)]
pub struct ExpectedEntityRoot {
    pub entity_id: [u8; 32],
    pub root: [u8; 32],
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
    #[error("RRS_RESTORE_WAL_ENTITY_REPLICA_MISSING:height={height}")]
    WalEntityReplicaMissing { height: u64 },
    #[error("RRS_RESTORE_WAL_ENTITY_REPLICA_AMBIGUOUS:height={height}:count={count}")]
    WalEntityReplicaAmbiguous { height: u64, count: usize },
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
    #[error(transparent)]
    Envelope(#[from] crate::RuntimeDurableEnvelopeError),
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

fn generation(stored: &StoredRscoreCheckpoint, height: u64) -> EngineGeneration {
    let mut digest = Sha256::new();
    digest.update(b"xln.rscore.runtime.restore.generation.v1");
    digest.update(stored.owner_entity_id);
    digest.update(height.to_be_bytes());
    digest.update(stored.revision.to_be_bytes());
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
    if checkpoint.runtime_seed.trim().is_empty() {
        return Err(RuntimeMachineError::RuntimeSeedEmpty.into());
    }
    let mut states = std::collections::BTreeMap::new();
    let mut replicas = std::collections::BTreeMap::new();
    let mut owners = std::collections::BTreeSet::new();
    let mut finalized_j_height = 0;
    for entity in checkpoint.entities {
        let (key, state, live) = restore_entity_checkpoint(
            entity,
            checkpoint.runtime_height,
            checkpoint.expected_protocol_fingerprint,
            checkpoint.worker_count,
            Arc::clone(&checkpoint.swap_market),
        )?;
        if !owners.insert(key.entity_id) {
            return Err(ConcreteRestoreError::OwnerMismatch);
        }
        // Same cumulative frontier as the Runtime's selected-J-input fold;
        // each Entity retains its own authenticated jurisdiction clock.
        finalized_j_height = finalized_j_height.max(state.entity.last_finalized_j_height);
        states.insert(key.clone(), state);
        replicas.insert(key, live);
    }
    Ok(RestoredRuntime {
        replica: RuntimeReplica {
            state: RuntimeState {
                height: checkpoint.runtime_height,
                timestamp: checkpoint.runtime_timestamp,
                finalized_j_height,
                e_replicas: states,
            },
            durable: checkpoint.durable_envelope,
            e_replicas: replicas,
            mempool: crate::RuntimeMempool::empty(),
            limits: checkpoint.limits,
            proposer_runtime_seed: checkpoint.runtime_seed,
            entity_import_keys: checkpoint.entity_import_keys,
            entity_import_workers: checkpoint.worker_count,
            entity_import_protocol: checkpoint.expected_protocol_fingerprint,
        },
    })
}

fn restore_entity_checkpoint(
    checkpoint: DecodedRuntimeEntityCheckpoint,
    runtime_height: u64,
    expected_protocol_fingerprint: [u8; 32],
    worker_count: usize,
    swap_market: Arc<SwapMarketPolicy>,
) -> Result<
    (
        RuntimeEntityKey,
        crate::RuntimeEntityState,
        crate::RuntimeEntityReplica,
    ),
    ConcreteRestoreError,
> {
    if checkpoint.signer_id.is_empty() {
        return Err(ConcreteRestoreError::SignerRequired);
    }
    let stored = &checkpoint.stored_accounts;
    if stored.protocol_fingerprint != expected_protocol_fingerprint {
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
        generation(stored, runtime_height),
        worker_count,
        private_key,
        checkpoint.signer_id.clone(),
        swap_market,
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
        entity.height,
    )
    .map_err(|error| ConcreteRestoreError::EntityManifest(error.to_string()))?;
    assert_entity_root(
        &entity_consensus.state.sections,
        checkpoint.expected_entity_root,
    )?;
    let owner = stored.owner_entity_id;
    let key = RuntimeEntityKey::new(owner, &checkpoint.signer_id)?;
    let state = crate::RuntimeEntityState {
        accounts_root: stored.accounts_root,
        entity,
    };
    let mut live = crate::RuntimeEntityReplica::new(
        &state,
        owner,
        checkpoint.signer_id,
        accounts,
        entity_consensus,
        checkpoint.entity_signer,
        stored.protocol_fingerprint,
        runtime_height,
    )?;
    live.install_replica_metadata(checkpoint.replica_metadata)?;
    Ok((key, state, live))
}

/// Apply already-decoded canonical Runtime inputs in strict WAL order. Each
/// step checks the existing Account root and Entity frame root or drops the
/// whole candidate; output publication remains disabled during restore.
pub fn replay_decoded_runtime_wal(
    restored: RestoredRuntime,
    frames: Vec<DecodedRuntimeWalFrame>,
) -> Result<RestoredRuntime, ConcreteRestoreError> {
    replay_decoded_runtime_wal_observed(restored, frames, |_, _, _| {})
}

/// Read-only observers see actual outputs only after the same canonical restore checks.
/// No event cache, publication or additional durable receipt representation is introduced.
pub fn replay_decoded_runtime_wal_observed(
    mut restored: RestoredRuntime,
    frames: Vec<DecodedRuntimeWalFrame>,
    mut observe: impl FnMut(u64, u64, &crate::RuntimeOutputs),
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
        let entity_output = applied.outputs.entities.first();
        let entity_key = entity_output.map(|output| RuntimeEntityKey {
            entity_id: output.entity_id,
            signer_id: output.signer_id.clone(),
        });
        let accounts_root = entity_output
            .and(entity_key.as_ref())
            .and_then(|key| applied.replica.state.e_replicas.get(key))
            .map(|state| state.accounts_root)
            .unwrap_or([0; 32]);
        assert_accounts_root(frame.height, accounts_root, frame.expected_accounts_root)?;
        for expected in frame.expected_entity_roots.into_iter().flatten() {
            let matching = applied
                .replica
                .e_replicas
                .iter()
                .filter(|(key, _)| key.entity_id == expected.entity_id)
                .collect::<Vec<_>>();
            let [(_, live)] = matching.as_slice() else {
                return Err(if matching.is_empty() {
                    ConcreteRestoreError::WalEntityReplicaMissing {
                        height: frame.height,
                    }
                } else {
                    ConcreteRestoreError::WalEntityReplicaAmbiguous {
                        height: frame.height,
                        count: matching.len(),
                    }
                });
            };
            assert_entity_root(&live.entity_consensus.state.sections, expected.root)?;
        }
        let mut replica = applied.replica;
        replica.durable.advance_frame_hash(
            frame.expected_previous_frame_hash,
            frame.expected_frame_hash,
        )?;
        observe(frame.height, frame.timestamp, &applied.outputs);
        restored.replica = replica;
    }
    Ok(restored)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_jurisdiction_only_runtime_keeps_empty_entity_set() {
        let restored = restore_decoded_runtime_checkpoint(DecodedRuntimeCheckpoint {
            entity_import_keys: BTreeMap::new(),
            runtime_seed: "public-jurisdiction-only-fixture".into(),
            runtime_height: 1,
            runtime_timestamp: 1,
            durable_envelope: RuntimeDurableEnvelope::fixture(),
            expected_protocol_fingerprint: [0; 32],
            entities: vec![],
            worker_count: 1,
            limits: RuntimeLimits::hlt(),
            swap_market: Arc::new(SwapMarketPolicy::default()),
        })
        .unwrap();
        assert!(restored.replica.state.e_replicas.is_empty());
        assert!(restored.replica.e_replicas.is_empty());
        assert_eq!(restored.replica.state.height, 1);
        assert_eq!(restored.replica.state.finalized_j_height, 0);
    }

    #[test]
    fn noncheckpoint_wal_frame_does_not_invent_an_expected_accounts_root() {
        assert_accounts_root(7, [0xaa; 32], None).expect("non-checkpoint root is nested evidence");
        assert!(matches!(
            assert_accounts_root(100, [0xaa; 32], Some([0xbb; 32])),
            Err(ConcreteRestoreError::AccountsRoot { height: 100, .. })
        ));
    }
}

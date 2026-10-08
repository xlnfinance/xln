//! Shared Entity genesis construction for operator bootstrap and Runtime import.
use crate::{RuntimeEntityKey, RuntimeEntityReplica, RuntimeEntityState};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use xln_rscore_batch::{EngineGeneration, ResidentConsensusEngine};
use xln_rscore_engine::BoardDelays;
use xln_rscore_entity_kernel::{
    EntityConsensusState, EntityFrameAuthority, EntitySingleSigner, EntityStateSlice,
    ResidentEntityConsensusReplica,
};

#[allow(clippy::too_many_arguments)]
pub fn create_entity_genesis_slot(
    entity: EntityStateSlice,
    authority: EntityFrameAuthority,
    private_key: [u8; 32],
    signer_id: String,
    workers: usize,
    protocol_fingerprint: [u8; 32],
    runtime_height: u64,
) -> Result<(RuntimeEntityKey, RuntimeEntityState, RuntimeEntityReplica), String> {
    let entity_id: [u8; 32] = hex::decode(
        entity
            .entity_id
            .strip_prefix("0x")
            .ok_or("ENTITY_GENESIS_ID")?,
    )
    .map_err(|_| "ENTITY_GENESIS_ID")?
    .try_into()
    .map_err(|_| "ENTITY_GENESIS_ID")?;
    let mut digest = Sha256::new();
    digest.update(b"xln.rscore.runtime.restore.generation.v1");
    digest.update(entity_id);
    digest.update(0_u64.to_be_bytes());
    digest.update(0_u64.to_be_bytes());
    let digest = digest.finalize();
    let mut generation = [0_u8; 8];
    generation.copy_from_slice(&digest[..8]);
    let accounts = ResidentConsensusEngine::restore(
        EngineGeneration::from_bytes(generation),
        workers,
        0,
        private_key,
        signer_id.clone(),
        Arc::new(crate::canonical_swap_market_policy()),
        Vec::new(),
    )
    .map_err(|error| format!("ENTITY_GENESIS_ACCOUNTS:{error}"))?;
    let weight = *authority
        .config
        .shares
        .get(&signer_id)
        .ok_or("ENTITY_GENESIS_SIGNER_OUTSIDE_BOARD")?;
    let entity_signer = EntitySingleSigner::from_key(
        private_key,
        &signer_id,
        &entity.entity_id,
        u128::from(weight),
        u128::from(authority.config.threshold),
        BoardDelays::default(),
    )
    .map_err(|error| format!("ENTITY_GENESIS_SIGNER:{error}"))?;
    let mut consensus = ResidentEntityConsensusReplica {
        state: EntityConsensusState {
            sections: vec![xln_rscore_entity_kernel::EntityConsensusSection {
                field: "nonces".into(),
                digest: xln_rscore_entity_kernel::compute_entity_section_digest(
                    &xln_rscore_protocol::CanonicalValue::Map(Vec::new()),
                )
                .map_err(|error| error.to_string())?,
            }],
            authority,
        },
        certified_frame_head: None,
    };
    // A genesis owner has no certificate, but its live sections must already
    // describe the complete committed state. WAL restart verifies this same
    // root before the first Entity frame is ever proposed.
    let owned = xln_rscore_entity_kernel::compute_entity_owned_sections(
        &entity,
        accounts.accounts_root(),
        accounts.account_count(),
    )
    .map_err(|error| error.to_string())?;
    consensus.state.sections = xln_rscore_entity_kernel::project_entity_consensus_sections(
        &consensus.state.sections,
        owned,
        &consensus.state.authority,
        entity.height,
    )
    .map_err(|error| error.to_string())?;
    let key = RuntimeEntityKey::new(entity_id, &signer_id).map_err(|error| error.to_string())?;
    let state = RuntimeEntityState {
        accounts_root: accounts.accounts_root(),
        entity,
    };
    let live = RuntimeEntityReplica::new(
        &state,
        entity_id,
        signer_id,
        accounts,
        consensus,
        entity_signer,
        protocol_fingerprint,
        runtime_height,
    )
    .map_err(|error| error.to_string())?;
    Ok((key, state, live))
}

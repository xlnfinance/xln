//! Certified Entity-frame lineage checks.

use thiserror::Error;

use super::authority::{EntityAuthorityError, EntityFrameAuthority};
use super::frame::{EntityFrame, EntityFrameBody, EntityFrameError, compute_entity_frame_hash};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CertifiedEntityFrameLink {
    pub frame: EntityFrame,
    pub post_authority: EntityFrameAuthority,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EntityLineageError {
    #[error(transparent)]
    Authority(#[from] EntityAuthorityError),
    #[error(transparent)]
    Frame(#[from] EntityFrameError),
    #[error("ENTITY_CERTIFIED_LINK_HEIGHT_MISMATCH:state={state}:frame={frame}")]
    HeightMismatch { state: u64, frame: u64 },
    #[error("ENTITY_CERTIFIED_LINK_HEAD_MISMATCH:state={state}:frame={frame}")]
    HeadMismatch { state: String, frame: String },
    #[error("ENTITY_CERTIFIED_LINK_STATE_ROOT_MISMATCH:expected={expected}:received={received}")]
    StateRootMismatch { expected: String, received: String },
    #[error(
        "ENTITY_CERTIFIED_LINK_AUTHORITY_ROOT_MISMATCH:expected={expected}:received={received}"
    )]
    AuthorityRootMismatch { expected: String, received: String },
    #[error("ENTITY_CERTIFIED_LINK_HASH_MISMATCH:expected={expected}:received={received}")]
    HashMismatch { expected: String, received: String },
}

/// Bind a certified frame to the exact post-state commitments. The caller
/// supplies `post_state_root` from the Entity reducer and `post_head` from the
/// resulting replica; no frame field is trusted as its own verification.
pub fn build_certified_entity_frame_link(
    entity_id: &str,
    post_height: u64,
    post_head: &str,
    post_state_root: &str,
    frame: EntityFrame,
    post_authority: EntityFrameAuthority,
) -> Result<CertifiedEntityFrameLink, EntityLineageError> {
    if frame.height != post_height {
        return Err(EntityLineageError::HeightMismatch {
            state: post_height,
            frame: frame.height,
        });
    }
    if post_head != frame.hash {
        return Err(EntityLineageError::HeadMismatch {
            state: post_head.to_string(),
            frame: frame.hash.clone(),
        });
    }
    if post_state_root != frame.state_root {
        return Err(EntityLineageError::StateRootMismatch {
            expected: post_state_root.to_string(),
            received: frame.state_root.clone(),
        });
    }
    let authority_root = post_authority.root()?;
    if authority_root != frame.authority_root {
        return Err(EntityLineageError::AuthorityRootMismatch {
            expected: authority_root,
            received: frame.authority_root.clone(),
        });
    }
    let recomputed = compute_entity_frame_hash(&EntityFrameBody {
        parent_frame_hash: &frame.parent_frame_hash,
        height: frame.height,
        timestamp: frame.timestamp,
        txs: &frame.txs,
        events: &frame.events,
        entity_id,
        state_root: &frame.state_root,
        authority_root: &frame.authority_root,
        entity_context: &frame.entity_context,
        entity_context_bytes: None,
        j_prefix_certificate: frame.j_prefix_certificate.as_ref(),
    })?;
    if recomputed != frame.hash {
        return Err(EntityLineageError::HashMismatch {
            expected: recomputed,
            received: frame.hash.clone(),
        });
    }
    frame.require_certified_proof_shape()?;
    Ok(CertifiedEntityFrameLink {
        frame,
        post_authority,
    })
}

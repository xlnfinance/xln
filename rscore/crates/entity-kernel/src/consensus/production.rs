//! Native Entity consensus subset used by RRS.

#[path = "authority.rs"]
mod authority;
#[path = "catalog.rs"]
mod catalog;
#[path = "encoding.rs"]
mod encoding;
#[path = "frame.rs"]
mod frame;
#[path = "lineage.rs"]
mod lineage;
#[path = "output.rs"]
mod output;
#[path = "single_signer.rs"]
mod single_signer;
#[path = "transition.rs"]
mod transition;

pub use authority::{
    ConsensusMode, EntityAuthorityError, EntityConsensusConfig, EntityFrameAuthority,
    EntityLeaderState,
};
pub use catalog::{EntityTxCatalogError, EntityTxKind, EntityTxSupport};
pub use encoding::EntityEncodingError;
pub use frame::{
    CanonicalEntityTx, EntityFrame, EntityFrameBody, EntityFrameError, EntityFrameEvent,
    EntityFrameLeader, HashToSign, HashType, compute_entity_events_parity_digest,
    compute_entity_frame_hash,
};
pub use lineage::{
    CertifiedEntityFrameLink, EntityLineageError, build_certified_entity_frame_link,
};
pub use output::{
    EntityHankoWitness, EntityHankoWitnessMap, EntityOutputError, LocalEntityOutput,
    LocalEntityOutputTx,
};
pub use single_signer::{
    CertifiedEntityProposal, EntityCertificationError, EntitySingleSigner, PresignedManifest,
    PresignedManifestEntry, build_entity_hash_manifest, certify_single_signer_entity_frame,
};
pub use transition::{
    CertifiedEntityTransition, ENTITY_OWNED_CONSENSUS_FIELDS, EntityConsensusState,
    EntityHtlcNoteIndex, EntityTransitionCertificationRequest, EntityTransitionError,
    PendingNonMutatingWake, ResidentEntityConsensusReplica, certify_entity_transition,
    is_entity_owned_consensus_field, project_entity_consensus_sections,
};

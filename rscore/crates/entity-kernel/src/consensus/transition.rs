//! The single production Entity certification seam used by Runtime.
//!
//! The resident reducer owns financial mutation. This module alone replaces
//! the exact Entity commitment sections, derives state/authority roots, builds
//! and certifies the frame, materializes generic outputs, and advances the
//! current head. Runtime still owns route resolution, one-time outbox encoding,
//! WAL fsync and publication.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;
use std::time::Instant;

use thiserror::Error;
use xln_rscore_protocol::CanonicalValue;

use crate::{
    EntityConsensusError, EntityConsensusSection, EntityKernelError, EntityStateSlice,
    compute_entity_consensus_root, compute_entity_owned_sections, compute_entity_section_digest,
};

use super::authority::{EntityAuthorityError, EntityFrameAuthority};
use super::frame::{
    CanonicalEntityTx, EntityFrameDraft, EntityFrameError, EntityFrameEvent, HashToSign,
};
use super::j_prefix::JPrefixError;
use super::lineage::{
    CertifiedEntityFrameLink, EntityLineageError, build_certified_entity_frame_link,
};
use super::output::{
    EntityHankoWitness, EntityHankoWitnessMap, EntityOutputError, LocalEntityOutput,
};
use super::single_signer::{
    EntityCertificationError, EntitySingleSigner, PresignedManifest,
    certify_single_signer_entity_frame,
};

fn profile_entity_certification() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("XLN_RSCORE_PROFILE_ENTITY").as_deref() == Ok("1"))
}

/// Entity consensus fields whose values are derived by the native Entity and
/// Account machines. Import, live execution and checkpoint projection must
/// use this one classifier; carrying any of these fields from storage would
/// create a second authority and make the first post-restore root diverge.
pub const ENTITY_OWNED_CONSENSUS_FIELDS: &[&str] = &[
    "accounts",
    "entityId",
    "height",
    "timestamp",
    "entityCommandNonces",
    "reserves",
    "externalWallet",
    "outDebtsByToken",
    "inDebtsByToken",
    "entityEncryptionPublicKey",
    "profile",
    "jBatchState",
    "entityProviderActionState",
    "certifiedBoardState",
    "lastFinalizedJHeight",
    "jHistoryFinality",
    "paybook",
    "crontabState",
    "hubRebalanceConfig",
    "deferredAccountProposals",
    "settlementContinuations",
    "crossJurisdictionSwaps",
    "crossJurisdictionAuthorizations",
    "pendingCrossJurisdictionFillAcks",
    "crossJurisdictionBookAdmissions",
    "orderbookExt",
    "swapTradingPairs",
    "lending",
    "config",
    "proposals",
    "leaderState",
];
const RETIRED_ENTITY_CONSENSUS_FIELDS: &[&str] =
    &["certifiedOutputSequences", "consumptionAccumulator"];
/// Consensus data surrounding the resident financial slice.
///
/// `sections` is the complete current manifest, including carried fields.
#[derive(Debug, PartialEq, Eq)]
pub struct EntityConsensusState {
    pub sections: Vec<EntityConsensusSection>,
    pub authority: EntityFrameAuthority,
}

/// Live Entity replica metadata owned by the parent Runtime replica.
#[derive(Debug, PartialEq, Eq)]
pub struct ResidentEntityConsensusReplica {
    pub state: EntityConsensusState,
    pub certified_frame_head: Option<CertifiedEntityFrameLink>,
}

impl ResidentEntityConsensusReplica {
    /// Validate a restored live envelope before Runtime can accept input.
    /// The complete section manifest is independently folded; a stored frame
    /// is then rebound to that root and authority instead of trusting either
    /// commitment from its own fields.
    pub fn validate_restored(
        &self,
        entity_id: &str,
        state_height: u64,
    ) -> Result<(String, String), EntityTransitionError> {
        let state_root = compute_entity_consensus_root(&self.state.sections)?;
        let authority_root = self.state.authority.root()?;
        match &self.certified_frame_head {
            Some(head) => {
                if head.post_authority != self.state.authority {
                    return Err(EntityTransitionError::RestoredAuthorityMismatch {
                        state: authority_root,
                        head: head.post_authority.root()?,
                        detail: authority_difference(&self.state.authority, &head.post_authority),
                    });
                }
                build_certified_entity_frame_link(
                    entity_id,
                    state_height,
                    &head.frame.hash,
                    &state_root,
                    head.frame.clone(),
                    self.state.authority.clone(),
                )?;
            }
            None if state_height == 0 => {}
            None => return Err(EntityTransitionError::RestoredHeadMissing(state_height)),
        }
        Ok((state_root, authority_root))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingNonMutatingWake {
    /// Position in the exact Entity output list. Wakes occupy a real outbox
    /// slot but intentionally receive neither an output identity nor Hanko.
    pub output_index: u64,
    pub target_entity_id: String,
}

pub struct EntityTransitionCertificationRequest<'a> {
    pub post_state: &'a EntityStateSlice,
    pub accounts_root: [u8; 32],
    pub account_count: usize,
    pub txs: Vec<CanonicalEntityTx>,
    pub events: Vec<EntityFrameEvent>,
    pub entity_context: &'a CanonicalValue,
    /// Exact certificate selected and signed against the pre-transition J
    /// anchor. Runtime also derived the frame's `j_event` transaction from the
    /// same range value. Certification commits these bytes verbatim instead of
    /// rebuilding a second J-history oracle from post-state.
    pub j_prefix_certificate: Option<CanonicalValue>,
    pub post_authority: EntityFrameAuthority,
    pub secondary_hashes: Vec<HashToSign>,
    pub presigned_manifest: PresignedManifest,
    /// Raw Account outputs in their exact relative Entity-output order.
    pub account_outputs: Vec<xln_rscore_batch::AccountInput>,
    /// Already-authorized non-Account Entity outputs in exact transition
    /// order. They occupy the leading output slots; Account Hankos are
    /// attached only to the later Account outputs.
    pub routed_entity_outputs: Vec<LocalEntityOutput>,
    pub non_mutating_wakes: Vec<PendingNonMutatingWake>,
}

pub struct CertifiedEntityTransition {
    pub consensus: ResidentEntityConsensusReplica,
    pub state_root: String,
    pub authority_root: String,
    pub local_outputs: Vec<LocalEntityOutput>,
    /// Exact manifest witnesses, returned so Runtime can persist local
    /// Account resend evidence only after Entity certification succeeds.
    pub manifest_hankos: EntityHankoWitnessMap,
}

#[derive(Debug, Error)]
pub enum EntityTransitionError {
    #[error(transparent)]
    Kernel(#[from] EntityKernelError),
    #[error(transparent)]
    Consensus(#[from] EntityConsensusError),
    #[error(transparent)]
    Authority(#[from] EntityAuthorityError),
    #[error(transparent)]
    Frame(#[from] EntityFrameError),
    #[error(transparent)]
    Certification(#[from] EntityCertificationError),
    #[error(transparent)]
    JPrefix(#[from] JPrefixError),
    #[error(transparent)]
    Output(#[from] EntityOutputError),
    #[error(transparent)]
    Lineage(#[from] EntityLineageError),
    #[error("ENTITY_TRANSITION_HEIGHT_INVALID:expected={expected}:actual={actual}")]
    Height { expected: u64, actual: u64 },
    #[error("ENTITY_TRANSITION_ENTITY_MISMATCH:state={state}:signer={signer}")]
    EntityMismatch { state: String, signer: String },
    #[error("ENTITY_RESTORED_HEAD_MISSING:height={0}")]
    RestoredHeadMissing(u64),
    #[error("ENTITY_RESTORED_AUTHORITY_MISMATCH:state={state}:head={head}:detail={detail}")]
    RestoredAuthorityMismatch {
        state: String,
        head: String,
        detail: String,
    },
    #[error("ENTITY_TRANSITION_SECTION_DUPLICATE:{0}")]
    DuplicateSection(String),
    #[error("ENTITY_TRANSITION_OWNED_SECTION_UNEXPECTED:{0}")]
    UnexpectedOwnedSection(String),
    #[error("ENTITY_TRANSITION_RETIRED_SECTION:{0}")]
    RetiredSection(String),
    #[error("ENTITY_TRANSITION_OUTPUT_INDEX_DUPLICATE:{0}")]
    DuplicateOutputIndex(u64),
    #[error("ENTITY_TRANSITION_OUTPUT_COUNT_OVERFLOW")]
    OutputCountOverflow,
    #[error("ENTITY_TRANSITION_OUTPUT_INDEX_OUT_OF_RANGE:index={index}:count={count}")]
    OutputIndexOutOfRange { index: u64, count: usize },
    #[error("ENTITY_TRANSITION_OUTPUT_LAYOUT_INVALID")]
    OutputLayout,
}

fn authority_difference(left: &EntityFrameAuthority, right: &EntityFrameAuthority) -> String {
    if left.config.mode != right.config.mode {
        "mode".into()
    } else if left.config.threshold != right.config.threshold {
        "threshold".into()
    } else if left.config.validators != right.config.validators {
        "validators".into()
    } else if left.config.shares != right.config.shares {
        "shares".into()
    } else if left.config.jurisdiction != right.config.jurisdiction {
        format!(
            "jurisdiction:state={:?}:head={:?}",
            left.config.jurisdiction, right.config.jurisdiction
        )
    } else if left.leader_state != right.leader_state {
        format!(
            "leader:state={:?}:head={:?}",
            left.leader_state, right.leader_state
        )
    } else {
        "unknown".into()
    }
}

fn insert_section(
    sections: &mut BTreeMap<String, EntityConsensusSection>,
    section: EntityConsensusSection,
) -> Result<(), EntityTransitionError> {
    let field = section.field.clone();
    if sections.insert(field.clone(), section).is_some() {
        return Err(EntityTransitionError::DuplicateSection(field));
    }
    Ok(())
}

pub fn is_entity_owned_consensus_field(field: &str) -> bool {
    ENTITY_OWNED_CONSENSUS_FIELDS.contains(&field)
}

/// Rebuild the complete Entity section manifest from carried commitments and
/// the one typed native projection. This is intentionally shared by restore
/// and live certification so neither path can invent a different config,
/// leader or certified-output frontier serializer.
pub fn project_entity_consensus_sections(
    current: &[EntityConsensusSection],
    owned: Vec<EntityConsensusSection>,
    authority: &EntityFrameAuthority,
) -> Result<Vec<EntityConsensusSection>, EntityTransitionError> {
    let mut sections = BTreeMap::new();
    for section in current {
        if RETIRED_ENTITY_CONSENSUS_FIELDS.contains(&section.field.as_str()) {
            return Err(EntityTransitionError::RetiredSection(section.field.clone()));
        }
        if !is_entity_owned_consensus_field(&section.field) {
            insert_section(&mut sections, section.clone())?;
        }
    }
    for section in owned {
        if !is_entity_owned_consensus_field(&section.field) {
            return Err(EntityTransitionError::UnexpectedOwnedSection(section.field));
        }
        insert_section(&mut sections, section)?;
    }
    let (config, leader) = authority.commitment_values()?;
    for (field, value) in [("config", config), ("leaderState", leader)] {
        insert_section(
            &mut sections,
            EntityConsensusSection {
                field: field.to_string(),
                digest: compute_entity_section_digest(&value)?,
            },
        )?;
    }
    Ok(sections.into_values().collect())
}

fn expected_height(
    consensus: &ResidentEntityConsensusReplica,
) -> Result<u64, EntityTransitionError> {
    match consensus.certified_frame_head.as_ref() {
        Some(head) => head.frame.height.checked_add(1),
        None => return Ok(1),
    }
    .ok_or(EntityTransitionError::Height {
        expected: u64::MAX,
        actual: u64::MAX,
    })
}

fn lineage_parent_hash(consensus: &ResidentEntityConsensusReplica) -> &str {
    consensus
        .certified_frame_head
        .as_ref()
        .map_or("genesis", |head| head.frame.hash.as_str())
}

/// Certify the exact post-resident Entity transition.
///
/// This consumes the consensus replica. An error therefore returns no partial
/// frame, frontier, note, signature or output; the parent Runtime must reload
/// the last durable checkpoint+WAL before it can continue.
pub fn certify_entity_transition(
    signer: &EntitySingleSigner,
    mut consensus: ResidentEntityConsensusReplica,
    request: EntityTransitionCertificationRequest<'_>,
) -> Result<CertifiedEntityTransition, EntityTransitionError> {
    let total_started = Instant::now();
    let expected = expected_height(&consensus)?;
    if request.post_state.height != expected {
        return Err(EntityTransitionError::Height {
            expected,
            actual: request.post_state.height,
        });
    }
    let signer_entity = signer.entity_id_text();
    if request.post_state.entity_id != signer_entity {
        return Err(EntityTransitionError::EntityMismatch {
            state: request.post_state.entity_id.clone(),
            signer: signer_entity,
        });
    }

    let output_count = request
        .account_outputs
        .len()
        .checked_add(request.routed_entity_outputs.len())
        .ok_or(EntityTransitionError::OutputCountOverflow)?
        .checked_add(request.non_mutating_wakes.len())
        .ok_or(EntityTransitionError::OutputCountOverflow)?;
    let mut pending_wakes = request.non_mutating_wakes;
    let account_outputs = request.account_outputs;
    pending_wakes.sort_by_key(|output| output.output_index);
    let mut indexes = BTreeSet::new();
    for wake in &pending_wakes {
        let output_index = usize::try_from(wake.output_index).map_err(|_| {
            EntityTransitionError::OutputIndexOutOfRange {
                index: wake.output_index,
                count: output_count,
            }
        })?;
        if output_index >= output_count {
            return Err(EntityTransitionError::OutputIndexOutOfRange {
                index: wake.output_index,
                count: output_count,
            });
        }
        if !indexes.insert(wake.output_index) {
            return Err(EntityTransitionError::DuplicateOutputIndex(
                wake.output_index,
            ));
        }
    }
    let owned = compute_entity_owned_sections(
        request.post_state,
        request.accounts_root,
        request.account_count,
    )?;
    let owned_done = total_started.elapsed();
    let sections = project_entity_consensus_sections(
        &consensus.state.sections,
        owned,
        &request.post_authority,
    )?;
    let state_root = compute_entity_consensus_root(&sections)?;
    let authority_root = request.post_authority.root()?;
    let roots_done = total_started.elapsed();
    let parent_hash = lineage_parent_hash(&consensus);
    let j_prefix_certificate = request.j_prefix_certificate;
    let j_prefix_done = total_started.elapsed();
    let draft = EntityFrameDraft {
        parent_frame_hash: parent_hash.to_string(),
        height: request.post_state.height,
        timestamp: request.post_state.timestamp,
        txs: request.txs,
        events: request.events,
        entity_id: request.post_state.entity_id.clone(),
        state_root: state_root.clone(),
        authority_root: authority_root.clone(),
        entity_context: request.entity_context.clone(),
        j_prefix_certificate,
    };
    let mut certified = certify_single_signer_entity_frame(
        signer,
        &request.post_authority,
        draft,
        request.secondary_hashes,
        request.presigned_manifest,
    )?;
    let frame_done = total_started.elapsed();
    if certified.frame.hashes_to_sign.len() != certified.manifest_hankos.len() {
        return Err(EntityTransitionError::OutputLayout);
    }
    let manifest_hankos = certified
        .frame
        .hashes_to_sign
        .iter()
        .cloned()
        // The signer result is owned by this transition. Move every Hanko
        // into its exact output witness instead of cloning the full manifest
        // immediately before the transient proof is compacted.
        .zip(certified.manifest_hankos)
        .map(|(entry, hanko)| {
            (
                entry.hash,
                EntityHankoWitness {
                    kind: entry.kind,
                    hanko,
                },
            )
        })
        .collect::<EntityHankoWitnessMap>();
    let mut local_outputs = std::iter::repeat_with(|| None)
        .take(output_count)
        .collect::<Vec<Option<LocalEntityOutput>>>();
    for (index, output) in request.routed_entity_outputs.into_iter().enumerate() {
        local_outputs[index] = Some(output);
    }
    for wake in pending_wakes {
        let output_index = usize::try_from(wake.output_index)
            .map_err(|_| EntityTransitionError::OutputCountOverflow)?;
        local_outputs[output_index] =
            Some(LocalEntityOutput::non_mutating_wake(wake.target_entity_id));
    }
    let mut account_outputs = account_outputs.into_iter();
    for slot in local_outputs.iter_mut().filter(|slot| slot.is_none()) {
        let input = account_outputs
            .next()
            .ok_or(EntityTransitionError::OutputLayout)?;
        *slot = Some(LocalEntityOutput::account_input(input, &manifest_hankos)?);
    }
    if account_outputs.next().is_some() {
        return Err(EntityTransitionError::OutputLayout);
    }
    let local_outputs = local_outputs
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or(EntityTransitionError::OutputLayout)?;
    let outputs_done = total_started.elapsed();
    // Every secondary Hanko is now attached to its exact Account/output.
    // Keep only the Entity-frame proof in durable lineage; replica-meta must
    // never serialize the transient commit manifest again on the next frame.
    certified.frame.compact_lineage_proof()?;
    // `certify_single_signer_entity_frame` just built and proof-checked this
    // frame from the exact post-state roots above. Recomputing its full hash
    // here encoded every Entity tx and the HTLC context a second time. Keep
    // `build_certified_entity_frame_link` for untrusted/restored frames; this
    // internal path already owns the validated constructor output.
    let link = CertifiedEntityFrameLink {
        frame: certified.frame,
        post_authority: request.post_authority.clone(),
    };
    consensus.state.sections = sections;
    consensus.state.authority = request.post_authority;
    consensus.certified_frame_head = Some(link);
    if profile_entity_certification() {
        let total = total_started.elapsed();
        eprintln!(
            "RSCORE_ENTITY_CERT_PHASE owned={} roots={} jPrefix={} frame={} outputs={} lineage={} total={}",
            owned_done.as_micros(),
            roots_done.saturating_sub(owned_done).as_micros(),
            j_prefix_done.saturating_sub(roots_done).as_micros(),
            frame_done.saturating_sub(j_prefix_done).as_micros(),
            outputs_done.saturating_sub(frame_done).as_micros(),
            total.saturating_sub(outputs_done).as_micros(),
            total.as_micros(),
        );
    }
    Ok(CertifiedEntityTransition {
        consensus,
        state_root,
        authority_root,
        local_outputs,
        manifest_hankos,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use xln_rscore_engine::BoardDelays;

    use super::super::authority::{ConsensusMode, EntityConsensusConfig, EntityLeaderState};
    use super::super::catalog::EntityTxKind;
    use super::super::encoding::{number, object, text};
    use super::*;

    fn authority() -> EntityFrameAuthority {
        EntityFrameAuthority {
            config: EntityConsensusConfig {
                mode: ConsensusMode::ProposerBased,
                threshold: 1,
                validators: vec!["h1-hub".into()],
                shares: BTreeMap::from([("h1-hub".into(), 1)]),
                jurisdiction: None,
            },
            leader_state: EntityLeaderState {
                active_validator_id: "h1-hub".into(),
                view: 0,
                changed_at_height: 0,
            },
        }
    }

    fn signer(entity: &str) -> EntitySingleSigner {
        let key: [u8; 32] =
            hex::decode("309b1f6e8dd69428a1954d7ab5ef05460264d9885d1cee151ccb277b9f27d01e")
                .expect("key")
                .try_into()
                .expect("key bytes");
        EntitySingleSigner::from_key(key, "h1-hub", entity, 1, 1, BoardDelays::default())
            .expect("signer")
    }

    fn section(field: &str, byte: &str) -> EntityConsensusSection {
        EntityConsensusSection {
            field: field.into(),
            digest: format!("0x{}", byte.repeat(32)),
        }
    }

    #[test]
    fn restore_and_live_share_authority_projection() {
        let authority = authority();
        let sections = project_entity_consensus_sections(
            &[
                section("config", "10"),
                section("leaderState", "20"),
                section("nonces", "40"),
            ],
            vec![section("accounts", "50")],
            &authority,
        )
        .expect("one canonical projection");
        assert_eq!(
            sections
                .iter()
                .map(|section| section.field.as_str())
                .collect::<Vec<_>>(),
            vec!["accounts", "config", "leaderState", "nonces",]
        );
        let (config, leader) = authority.commitment_values().expect("authority values");
        for (field, expected) in [
            (
                "config",
                compute_entity_section_digest(&config).expect("config"),
            ),
            (
                "leaderState",
                compute_entity_section_digest(&leader).expect("leader"),
            ),
        ] {
            assert_eq!(
                sections
                    .iter()
                    .find(|section| section.field == field)
                    .map(|section| section.digest.as_str()),
                Some(expected.as_str()),
            );
        }
        assert!(matches!(
            project_entity_consensus_sections(
                &[section("certifiedOutputSequences", "30")],
                vec![section("accounts", "50")],
                &authority,
            ),
            Err(EntityTransitionError::RetiredSection(field))
                if field == "certifiedOutputSequences"
        ));
    }

    #[test]
    fn one_transition_advances_one_certified_head() {
        let entity = "0x1b7a1f31158ced332b779dd6b985ff695b22358470d1cbf6fac0c6db84478d08";
        let mut state = EntityStateSlice::empty(entity, 1_000);
        state.height = 1;
        let tx = CanonicalEntityTx::from_frame_projection(
            EntityTxKind::HtlcPayment,
            object(vec![
                ("hashlock", text("0xfeed")),
                ("description", text("coffee")),
            ]),
        )
        .expect("tx");
        let context = object(vec![
            ("version", number("version", 1).expect("version")),
            (
                "htlc",
                object(vec![("entries", CanonicalValue::Array(Vec::new()))]),
            ),
        ]);
        let authority = authority();
        let result = certify_entity_transition(
            &signer(entity),
            ResidentEntityConsensusReplica {
                state: EntityConsensusState {
                    sections: Vec::new(),
                    authority: authority.clone(),
                },
                certified_frame_head: None,
            },
            EntityTransitionCertificationRequest {
                post_state: &state,
                accounts_root: [0_u8; 32],
                account_count: 0,
                txs: vec![tx],
                events: vec![],
                entity_context: &context,
                j_prefix_certificate: None,
                post_authority: authority,
                secondary_hashes: Vec::new(),
                presigned_manifest: PresignedManifest::new(),
                account_outputs: Vec::new(),
                routed_entity_outputs: Vec::new(),
                non_mutating_wakes: Vec::new(),
            },
        )
        .expect("transition");
        let head = result
            .consensus
            .certified_frame_head
            .as_ref()
            .expect("head");
        assert_eq!(head.frame.height, 1);
        assert_eq!(head.frame.state_root, result.state_root);
    }

    #[test]
    fn non_mutating_wake_occupies_its_slot_without_a_secondary_hanko() {
        let entity = "0x1b7a1f31158ced332b779dd6b985ff695b22358470d1cbf6fac0c6db84478d08";
        let mut state = EntityStateSlice::empty(entity, 1_000);
        state.height = 1;
        let context = object(vec![("version", number("version", 1).expect("version"))]);
        let authority = authority();
        let result = certify_entity_transition(
            &signer(entity),
            ResidentEntityConsensusReplica {
                state: EntityConsensusState {
                    sections: Vec::new(),
                    authority: authority.clone(),
                },
                certified_frame_head: None,
            },
            EntityTransitionCertificationRequest {
                post_state: &state,
                accounts_root: [0_u8; 32],
                account_count: 0,
                txs: vec![],
                events: vec![],
                entity_context: &context,
                j_prefix_certificate: None,
                post_authority: authority,
                secondary_hashes: Vec::new(),
                presigned_manifest: PresignedManifest::new(),
                account_outputs: Vec::new(),
                routed_entity_outputs: Vec::new(),
                non_mutating_wakes: vec![PendingNonMutatingWake {
                    output_index: 0,
                    target_entity_id: entity.into(),
                }],
            },
        )
        .expect("transition");
        assert_eq!(result.local_outputs.len(), 1);
        assert_eq!(result.local_outputs[0].entity_id, entity);
        assert!(result.local_outputs[0].entity_txs.is_empty());
    }
}

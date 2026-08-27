//! Compact post-state authority commitment for Entity frame lineage.
//!
//! Mirrors `buildEntityFrameAuthority` and
//! `computeEntityFrameAuthorityRoot` in
//! `core/entity/consensus/state-root.ts`.

use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;
use thiserror::Error;
use xln_rscore_protocol::{CanonicalValue, encode_canonical_consensus_bytes};

use super::encoding::{EntityEncodingError, keccak_bytes, number, object, text};

const AUTHORITY_DOMAIN: &str = "xln.entity.frame-authority:binary";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsensusMode {
    ProposerBased,
    GossipBased,
}

impl ConsensusMode {
    const fn as_str(self) -> &'static str {
        match self {
            Self::ProposerBased => "proposer-based",
            Self::GossipBased => "gossip-based",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityConsensusConfig {
    pub mode: ConsensusMode,
    pub threshold: u16,
    pub validators: Vec<String>,
    pub shares: BTreeMap<String, u16>,
    /// Exact durable TS `ConsensusConfig.jurisdiction`. The authority-root
    /// projection removes display/routing fields on demand; `postAuthority`
    /// retains the full canonical state, so there is only one source of truth.
    pub jurisdiction: Option<CanonicalValue>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityLeaderState {
    pub active_validator_id: String,
    pub view: u64,
    pub changed_at_height: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityFrameAuthority {
    pub config: EntityConsensusConfig,
    pub leader_state: EntityLeaderState,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EntityAuthorityError {
    #[error(transparent)]
    Encoding(#[from] EntityEncodingError),
    #[error("ENTITY_FRAME_AUTHORITY_VALIDATORS_EMPTY")]
    ValidatorsEmpty,
    #[error("ENTITY_FRAME_AUTHORITY_SIGNER_EMPTY")]
    SignerEmpty,
    #[error("ENTITY_FRAME_AUTHORITY_DUPLICATE_SIGNER:{0}")]
    DuplicateSigner(String),
    #[error("ENTITY_FRAME_AUTHORITY_SHARE_MISSING:{0}")]
    ShareMissing(String),
    #[error("ENTITY_FRAME_AUTHORITY_SHARE_OUTSIDE_VALIDATORS:{0}")]
    ShareOutsideValidators(String),
    #[error("ENTITY_FRAME_AUTHORITY_THRESHOLD_UNREACHABLE:threshold={threshold}:total={total}")]
    ThresholdUnreachable { threshold: u16, total: u64 },
    #[error("ENTITY_FRAME_AUTHORITY_LEADER_OUTSIDE_VALIDATORS:{0}")]
    LeaderOutsideValidators(String),
    #[error("ENTITY_FRAME_AUTHORITY_JURISDICTION:{0}")]
    Jurisdiction(String),
}

fn normalized_signer(value: &str) -> Result<String, EntityAuthorityError> {
    let signer = value.trim().to_lowercase();
    if signer.is_empty() {
        return Err(EntityAuthorityError::SignerEmpty);
    }
    Ok(signer)
}

fn project_jurisdiction(value: CanonicalValue) -> Result<CanonicalValue, EntityAuthorityError> {
    let CanonicalValue::Object(entries) = value else {
        return Err(EntityAuthorityError::Jurisdiction("OBJECT_REQUIRED".into()));
    };
    let allowed = BTreeSet::from([
        "address",
        "name",
        "chainId",
        "depositoryAddress",
        "entityProviderAddress",
        "registrationBlock",
        "entityProviderDeploymentBlock",
        "blockTimeMs",
        "rebalancePolicyUsd",
    ]);
    let committed = BTreeSet::from([
        "chainId",
        "depositoryAddress",
        "entityProviderAddress",
        "registrationBlock",
        "entityProviderDeploymentBlock",
        "blockTimeMs",
        "rebalancePolicyUsd",
    ]);
    let mut projected = Vec::new();
    for (key, mut value) in entries {
        if !allowed.contains(key.as_str()) {
            return Err(EntityAuthorityError::Jurisdiction(format!(
                "EXTRA_PROPERTY:{key}"
            )));
        }
        if !committed.contains(key.as_str()) {
            continue;
        }
        if matches!(key.as_str(), "depositoryAddress" | "entityProviderAddress") {
            let CanonicalValue::String(address) = value else {
                return Err(EntityAuthorityError::Jurisdiction(format!(
                    "ADDRESS_REQUIRED:{key}"
                )));
            };
            let address = address.trim().to_ascii_lowercase();
            if address.is_empty() {
                return Err(EntityAuthorityError::Jurisdiction(format!(
                    "ADDRESS_REQUIRED:{key}"
                )));
            }
            value = CanonicalValue::String(address);
        }
        if key == "rebalancePolicyUsd" {
            let CanonicalValue::Object(policy) = &value else {
                return Err(EntityAuthorityError::Jurisdiction(
                    "REBALANCE_POLICY_OBJECT_REQUIRED".into(),
                ));
            };
            if policy.iter().any(|(field, _)| {
                !matches!(
                    field.as_str(),
                    "r2cRequestSoftLimit" | "hardLimit" | "maxFee"
                )
            }) {
                return Err(EntityAuthorityError::Jurisdiction(
                    "REBALANCE_POLICY_EXTRA_PROPERTY".into(),
                ));
            }
        }
        projected.push((key, value));
    }
    for required in ["depositoryAddress", "entityProviderAddress"] {
        if !projected.iter().any(|(key, _)| key == required) {
            return Err(EntityAuthorityError::Jurisdiction(format!(
                "ADDRESS_REQUIRED:{required}"
            )));
        }
    }
    Ok(CanonicalValue::Object(projected))
}

impl EntityFrameAuthority {
    pub fn validate_and_normalize(&self) -> Result<Self, EntityAuthorityError> {
        if self.config.validators.is_empty() {
            return Err(EntityAuthorityError::ValidatorsEmpty);
        }
        let mut seen = BTreeSet::new();
        let mut validators = Vec::with_capacity(self.config.validators.len());
        for validator in &self.config.validators {
            let signer = normalized_signer(validator)?;
            if !seen.insert(signer.clone()) {
                return Err(EntityAuthorityError::DuplicateSigner(signer));
            }
            validators.push(signer);
        }

        let mut shares = BTreeMap::new();
        for (raw_signer, power) in &self.config.shares {
            let signer = normalized_signer(raw_signer)?;
            if shares.insert(signer.clone(), *power).is_some() {
                return Err(EntityAuthorityError::DuplicateSigner(signer));
            }
        }
        let mut total = 0_u64;
        for validator in &validators {
            let power = shares
                .get(validator)
                .copied()
                .filter(|power| *power > 0)
                .ok_or_else(|| EntityAuthorityError::ShareMissing(validator.clone()))?;
            total = total.checked_add(u64::from(power)).ok_or(
                EntityAuthorityError::ThresholdUnreachable {
                    threshold: self.config.threshold,
                    total: u64::MAX,
                },
            )?;
        }
        for signer in shares.keys() {
            if !seen.contains(signer) {
                return Err(EntityAuthorityError::ShareOutsideValidators(signer.clone()));
            }
        }
        if self.config.threshold == 0 || total < u64::from(self.config.threshold) {
            return Err(EntityAuthorityError::ThresholdUnreachable {
                threshold: self.config.threshold,
                total,
            });
        }
        let leader = normalized_signer(&self.leader_state.active_validator_id)?;
        if !seen.contains(&leader) {
            return Err(EntityAuthorityError::LeaderOutsideValidators(leader));
        }
        Ok(Self {
            config: EntityConsensusConfig {
                mode: self.config.mode,
                threshold: self.config.threshold,
                validators,
                shares,
                jurisdiction: self.config.jurisdiction.clone(),
            },
            leader_state: EntityLeaderState {
                active_validator_id: leader,
                view: self.leader_state.view,
                changed_at_height: self.leader_state.changed_at_height,
            },
        })
    }

    pub(crate) fn state_values(
        &self,
    ) -> Result<(CanonicalValue, CanonicalValue), EntityAuthorityError> {
        self.values(true)
    }

    fn values(
        &self,
        commitment: bool,
    ) -> Result<(CanonicalValue, CanonicalValue), EntityAuthorityError> {
        let authority = self.validate_and_normalize()?;
        let shares = CanonicalValue::Object(
            authority
                .config
                .shares
                .iter()
                .map(|(signer, power)| {
                    (signer.clone(), CanonicalValue::BigInt(BigInt::from(*power)))
                })
                .collect(),
        );
        let mut config = vec![
            ("mode", text(authority.config.mode.as_str())),
            (
                "threshold",
                CanonicalValue::BigInt(BigInt::from(authority.config.threshold)),
            ),
            (
                "validators",
                CanonicalValue::Array(authority.config.validators.into_iter().map(text).collect()),
            ),
            ("shares", shares),
        ];
        if let Some(jurisdiction) = authority.config.jurisdiction {
            let jurisdiction = if commitment {
                project_jurisdiction(jurisdiction)?
            } else {
                jurisdiction
            };
            config.push(("jurisdiction", jurisdiction));
        }
        let config = object(config);
        let leader_state = object(vec![
            (
                "activeValidatorId",
                text(authority.leader_state.active_validator_id),
            ),
            ("view", number("leader.view", authority.leader_state.view)?),
            (
                "changedAtHeight",
                number(
                    "leader.changedAtHeight",
                    authority.leader_state.changed_at_height,
                )?,
            ),
        ]);
        Ok((config, leader_state))
    }

    fn canonical_value(&self) -> Result<CanonicalValue, EntityAuthorityError> {
        let (config, leader_state) = self.values(true)?;
        Ok(object(vec![
            ("domain", text(AUTHORITY_DOMAIN)),
            (
                "authority",
                object(vec![("config", config), ("leaderState", leader_state)]),
            ),
        ]))
    }

    /// Exact durable `postAuthority` projection. Storage reuses the same
    /// normalized values as the authority-root builder; reconstructing this
    /// object in a parent crate would create a second consensus serializer.
    pub fn state_value(&self) -> Result<CanonicalValue, EntityAuthorityError> {
        let (config, leader_state) = self.values(false)?;
        Ok(object(vec![
            ("config", config),
            ("leaderState", leader_state),
        ]))
    }

    pub fn root(&self) -> Result<String, EntityAuthorityError> {
        // Authority uses raw canonical MessagePack, unlike the separately
        // framed binary payload used by Entity-frame headers.
        let encoded = encode_canonical_consensus_bytes(&self.canonical_value()?)
            .map_err(EntityEncodingError::from)?;
        Ok(keccak_bytes(&encoded))
    }

    pub fn is_single_signer(&self) -> Result<bool, EntityAuthorityError> {
        let normalized = self.validate_and_normalize()?;
        let signer = normalized
            .config
            .validators
            .first()
            .ok_or(EntityAuthorityError::ValidatorsEmpty)?;
        let share = normalized
            .config
            .shares
            .get(signer)
            .copied()
            .ok_or_else(|| EntityAuthorityError::ShareMissing(signer.clone()))?;
        Ok(normalized.config.validators.len() == 1 && normalized.config.threshold == share)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn authority() -> EntityFrameAuthority {
        EntityFrameAuthority {
            config: EntityConsensusConfig {
                mode: ConsensusMode::ProposerBased,
                threshold: 1,
                validators: vec!["H1-Hub".into()],
                shares: BTreeMap::from([("H1-Hub".into(), 1)]),
                jurisdiction: None,
            },
            leader_state: EntityLeaderState {
                active_validator_id: "H1-Hub".into(),
                view: 0,
                changed_at_height: 0,
            },
        }
    }

    #[test]
    fn matches_typescript_authority_root_golden() {
        assert_eq!(
            authority().root().expect("authority root"),
            "0xedc4ddb8ec2d8f0a4e4c83dc91d1c51c16e828fa4bea0a914b64fd57a4bbc704",
        );
        assert!(authority().is_single_signer().expect("single signer"));
    }

    #[test]
    fn rejects_duplicate_or_unreachable_authority() {
        let mut duplicate = authority();
        duplicate.config.validators.push("h1-hub".into());
        assert!(matches!(
            duplicate.root(),
            Err(EntityAuthorityError::DuplicateSigner(signer)) if signer == "h1-hub"
        ));
        let mut unreachable = authority();
        unreachable.config.threshold = 2;
        assert!(matches!(
            unreachable.root(),
            Err(EntityAuthorityError::ThresholdUnreachable {
                threshold: 2,
                total: 1
            })
        ));
    }
}

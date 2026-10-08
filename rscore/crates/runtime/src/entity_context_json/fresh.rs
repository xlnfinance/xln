//! Canonical proposer context for live resident Runtime frames.

#[path = "fresh/htlc.rs"]
mod htlc;
#[path = "fresh/origin.rs"]
mod origin;
#[path = "fresh/origin_route.rs"]
mod origin_route;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;
use std::time::Instant;

use num_bigint::BigInt;
use thiserror::Error;
use x25519_dalek::{PublicKey, StaticSecret};
use xln_rscore_batch::AccountInputRow;
use xln_rscore_entity_kernel::{
    DeterministicContext, LocalEntityFinancialTx, PreparedContextError,
};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use self::htlc::{canonical_entry, collect_inputs, materialize_inbound_htlc_context};

use crate::processor::EntityRouteTable;
use crate::transport::InboundSessionTable;
use crate::{EntityContextJsonError, RuntimeEntityReplica, RuntimeEntityState};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn profile_entity_context() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("XLN_RSCORE_PROFILE_ENTITY").as_deref() == Ok("1"))
}

#[derive(Debug, Error)]
pub enum FreshEntityContextError {
    #[error("RRS_FRESH_CONTEXT_HEIGHT_OVERFLOW")]
    HeightOverflow,
    #[error("RRS_FRESH_CONTEXT_HEIGHT_UNSAFE:{0}")]
    HeightUnsafe(u64),
    #[error("RRS_FRESH_CONTEXT_LINEAGE:state={state}:head={head}")]
    Lineage { state: u64, head: String },
    #[error("RRS_FRESH_CONTEXT_HTLC_INFRA_REQUIRED")]
    HtlcInfrastructureRequired,
    #[error("RRS_FRESH_CONTEXT_HTLC_ORIGIN_REQUIRED")]
    HtlcOriginRequired,
    #[error("RRS_FRESH_CONTEXT_ORIGIN_REJECTED:{0}")]
    OriginRejected(&'static str),
    #[error("RRS_FRESH_CONTEXT_HTLC_INFRA_INVALID:{0}")]
    HtlcInfrastructureInvalid(String),
    #[error("RRS_FRESH_CONTEXT_HTLC_ACCOUNT_READ:{0}")]
    HtlcAccountRead(String),
    #[error(transparent)]
    Htlc(#[from] PreparedContextError),
    #[error(transparent)]
    Decode(#[from] EntityContextJsonError),
}

pub struct EntityInfraMaterializeRequest<'a> {
    /// Existing committed owner seed; used only to prepare live observations.
    pub entity_encryption_seed: Option<&'a str>,
    pub state: &'a RuntimeEntityState,
    pub replica: &'a mut RuntimeEntityReplica,
    /// Exact Account rows remaining after Runtime FIFO and Entity wire fitting.
    pub account_inputs: &'a [&'a AccountInputRow],
    /// Exact effective local operations after Entity-command expansion.
    pub local_financial_txs: &'a [&'a LocalEntityFinancialTx],
    pub originated_j_heights: &'a BTreeMap<String, u64>,
    pub timestamp: u64,
    pub finalized_j_height: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MaterializedEntityInfraContext {
    pub execution: DeterministicContext,
    pub canonical: CanonicalValue,
    /// Exact preprocessing observation per prepared inbound binding. This is
    /// used only to trim an oversized live candidate; canonical assertions
    /// remain committed in `canonical` for deterministic replay.
    observed_peer_by_prepared: BTreeMap<(String, String), String>,
}

impl MaterializedEntityInfraContext {
    /// Shrink one fully materialized live candidate to a smaller FIFO prefix.
    /// Decryption and Account-view reads are prefix-monotonic, so throwing
    /// away tail entries is byte-identical to materializing that smaller
    /// prefix from scratch. This is deliberately one-way: growing a context
    /// would require infrastructure work that is no longer represented here.
    pub(crate) fn retain_inbound_htlc_keys(
        &mut self,
        retained: &BTreeSet<(String, String)>,
        originated: &BTreeSet<String>,
    ) -> Result<(), FreshEntityContextError> {
        self.execution
            .prepared_htlcs
            .retain(|key, _| retained.contains(key));
        self.observed_peer_by_prepared
            .retain(|key, _| retained.contains(key));
        self.execution
            .originated_htlcs
            .retain(|hash, _| originated.contains(hash));
        let mut retained_peers = self
            .observed_peer_by_prepared
            .values()
            .cloned()
            .collect::<BTreeSet<_>>();

        retained_peers.extend(
            self.execution
                .originated_htlcs
                .values()
                .map(|payment| payment.next_hop_entity_id.clone()),
        );
        let retained_profile_ids = self
            .execution
            .originated_htlcs
            .values()
            .flat_map(|payment| payment.route.iter().cloned())
            .collect::<BTreeSet<_>>();
        let context = canonical_object_mut(&mut self.canonical, "CONTEXT")?;
        let CanonicalValue::Array(profiles) = canonical_field_mut(context, "gossipProfiles")?
        else {
            return Err(filter_error("PROFILES"));
        };
        let mut filtered_profiles = Vec::new();
        for profile in std::mem::take(profiles) {
            let row = canonical_object(&profile, "PROFILE")?;
            let id = canonical_text(canonical_field(row, "entityId")?, "PROFILE_ID")?;
            if retained_profile_ids.contains(id) {
                filtered_profiles.push(profile);
            }
        }
        *profiles = filtered_profiles;

        let htlc = canonical_field_mut(context, "htlc")?;
        let htlc = canonical_object_mut(htlc, "HTLC")?;
        let CanonicalValue::Array(origins) = canonical_field_mut(htlc, "originated")? else {
            return Err(filter_error("ORIGINATED"));
        };
        let mut filtered_origins = Vec::new();
        for payment in std::mem::take(origins) {
            let row = canonical_object(&payment, "ORIGIN")?;
            let hash = canonical_text(canonical_field(row, "txHash")?, "ORIGIN_HASH")?;
            if originated.contains(hash) {
                filtered_origins.push(payment);
            }
        }
        *origins = filtered_origins;
        let entries = canonical_field_mut(htlc, "entries")?;
        let CanonicalValue::Array(entries) = entries else {
            return Err(filter_error("HTLC_ENTRIES"));
        };
        let mut filtered = Vec::with_capacity(entries.len());
        for entry in std::mem::take(entries) {
            if retained.contains(&canonical_prepared_key(&entry)?) {
                filtered.push(entry);
            }
        }
        *entries = filtered;
        let entry_count = entries.len();

        let assertions = canonical_field_mut(context, "peerAssertions")?;
        let CanonicalValue::Array(assertions) = assertions else {
            return Err(filter_error("PEER_ASSERTIONS"));
        };
        let mut filtered = Vec::with_capacity(assertions.len());
        for assertion in std::mem::take(assertions) {
            let row = canonical_object(&assertion, "PEER_ASSERTION")?;
            let entity_id = canonical_text(canonical_field(row, "entityId")?, "PEER_ENTITY")?;
            if retained_peers.contains(entity_id) {
                filtered.push(assertion);
            }
        }
        *assertions = filtered;

        if self.execution.prepared_htlcs.len() != entry_count {
            return Err(filter_error("ENTRY_COUNT"));
        }
        Ok(())
    }
}

fn filter_error(detail: &str) -> FreshEntityContextError {
    FreshEntityContextError::HtlcInfrastructureInvalid(format!("CONTEXT_FILTER_{detail}"))
}

fn canonical_object<'a>(
    value: &'a CanonicalValue,
    detail: &str,
) -> Result<&'a Vec<(String, CanonicalValue)>, FreshEntityContextError> {
    let CanonicalValue::Object(fields) = value else {
        return Err(filter_error(detail));
    };
    Ok(fields)
}

fn canonical_object_mut<'a>(
    value: &'a mut CanonicalValue,
    detail: &str,
) -> Result<&'a mut Vec<(String, CanonicalValue)>, FreshEntityContextError> {
    let CanonicalValue::Object(fields) = value else {
        return Err(filter_error(detail));
    };
    Ok(fields)
}

fn canonical_field<'a>(
    fields: &'a [(String, CanonicalValue)],
    field: &str,
) -> Result<&'a CanonicalValue, FreshEntityContextError> {
    fields
        .iter()
        .find_map(|(key, value)| (key == field).then_some(value))
        .ok_or_else(|| filter_error(field))
}

fn canonical_field_mut<'a>(
    fields: &'a mut [(String, CanonicalValue)],
    field: &str,
) -> Result<&'a mut CanonicalValue, FreshEntityContextError> {
    fields
        .iter_mut()
        .find_map(|(key, value)| (key == field).then_some(value))
        .ok_or_else(|| filter_error(field))
}

fn canonical_text<'a>(
    value: &'a CanonicalValue,
    detail: &str,
) -> Result<&'a str, FreshEntityContextError> {
    let CanonicalValue::String(value) = value else {
        return Err(filter_error(detail));
    };
    Ok(value)
}

fn canonical_number(value: u64) -> Result<CanonicalValue, FreshEntityContextError> {
    CanonicalNumber::try_from_u64(value)
        .map(CanonicalValue::Number)
        .map_err(|_| FreshEntityContextError::HeightUnsafe(value))
}

fn canonical_object_value(entries: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
    let mut entries = entries
        .into_iter()
        .map(|(key, value)| (key.to_string(), value))
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.0.encode_utf16().cmp(right.0.encode_utf16()));
    CanonicalValue::Object(entries)
}

fn canonical_prepared_key(
    entry: &CanonicalValue,
) -> Result<(String, String), FreshEntityContextError> {
    let entry = canonical_object(entry, "HTLC_ENTRY")?;
    let binding = canonical_object(canonical_field(entry, "binding")?, "HTLC_BINDING")?;
    Ok((
        canonical_text(canonical_field(binding, "accountFrameHash")?, "HTLC_FRAME")?.to_string(),
        canonical_text(canonical_field(binding, "hashlock")?, "HTLC_HASHLOCK")?.to_string(),
    ))
}

/// Live infrastructure is invoked once, after the exact Runtime/Entity prefix
/// is fixed and before any Account or Entity mutation. Replay bypasses this
/// trait and consumes the context already committed in its Runtime frame.
pub trait EntityInfraMaterializer {
    /// Install the current transient route/session view before preprocessing a
    /// live Entity frame. The resulting booleans enter `peerAssertions`; the
    /// route/session objects themselves never enter consensus or replay.
    fn set_paybook_reachability(
        &mut self,
        routes: EntityRouteTable,
        sessions: InboundSessionTable,
        identity: crate::signed_profile::ProfileTransportIdentity,
    );

    fn materialize(
        &mut self,
        request: EntityInfraMaterializeRequest<'_>,
    ) -> Result<MaterializedEntityInfraContext, FreshEntityContextError>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InboundHtlcInfrastructure {
    pub entity_encryption_public_key: [u8; 32],
    pub entity_encryption_private_key: [u8; 32],
    pub routing_fee_ppm: u32,
    pub routing_base_fee: BigInt,
}

impl InboundHtlcInfrastructure {
    fn owner_private_key(
        &self,
        entity_id: &str,
        public_key: [u8; 32],
        seed: Option<&str>,
    ) -> Result<[u8; 32], FreshEntityContextError> {
        let private_key = match seed {
            Some(seed) => crate::entity_encryption::derive_entity_encryption_key(seed, entity_id)
                .map_err(FreshEntityContextError::HtlcInfrastructureInvalid)?,
            None if public_key == self.entity_encryption_public_key => {
                self.entity_encryption_private_key
            }
            None => {
                return Err(FreshEntityContextError::HtlcInfrastructureInvalid(
                    "OWNER_ENCRYPTION_KEY_MISSING".into(),
                ));
            }
        };
        if *PublicKey::from(&StaticSecret::from(private_key)).as_bytes() != public_key {
            return Err(FreshEntityContextError::HtlcInfrastructureInvalid(
                "OWNER_ENCRYPTION_KEY_MISMATCH".into(),
            ));
        }
        Ok(private_key)
    }

    pub fn validate(self) -> Result<Self, FreshEntityContextError> {
        let derived_public =
            *PublicKey::from(&StaticSecret::from(self.entity_encryption_private_key)).as_bytes();
        if derived_public != self.entity_encryption_public_key
            || self.routing_fee_ppm > 999_999
            || self.routing_base_fee < BigInt::from(0)
        {
            return Err(FreshEntityContextError::HtlcInfrastructureInvalid(
                "KEYPAIR_OR_FIELDS".into(),
            ));
        }
        Ok(self)
    }
}

/// Canonical direct-payment/same-J/J-event materializer. HTLC work is rejected
/// until profile, liveness, encryption and onion inputs are installed here;
/// it must never silently execute with an empty context.
#[derive(Default)]
pub struct CanonicalEntityInfraMaterializer {
    inbound_htlc: Option<InboundHtlcInfrastructure>,
    paybook_reachability: Option<(EntityRouteTable, InboundSessionTable)>,
    profile_identity: Option<crate::signed_profile::ProfileTransportIdentity>,
}

impl CanonicalEntityInfraMaterializer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_inbound_htlc(
        infrastructure: InboundHtlcInfrastructure,
    ) -> Result<Self, FreshEntityContextError> {
        Ok(Self {
            inbound_htlc: Some(infrastructure.validate()?),
            paybook_reachability: None,
            profile_identity: None,
        })
    }
}

impl EntityInfraMaterializer for CanonicalEntityInfraMaterializer {
    fn set_paybook_reachability(
        &mut self,
        routes: EntityRouteTable,
        sessions: InboundSessionTable,
        identity: crate::signed_profile::ProfileTransportIdentity,
    ) {
        self.paybook_reachability = Some((routes, sessions));
        self.profile_identity = Some(identity);
    }

    fn materialize(
        &mut self,
        request: EntityInfraMaterializeRequest<'_>,
    ) -> Result<MaterializedEntityInfraContext, FreshEntityContextError> {
        materialize_fresh_entity_context(
            self.inbound_htlc.as_ref(),
            self.paybook_reachability.as_ref(),
            self.profile_identity.as_ref(),
            request,
        )
    }
}

fn needs_originated_htlc(request: &EntityInfraMaterializeRequest<'_>) -> bool {
    request
        .local_financial_txs
        .iter()
        .any(|tx| matches!(tx, LocalEntityFinancialTx::HtlcPayment(_)))
}

/// Build the exact empty-infrastructure Entity context used by TypeScript for
/// direct payments, same-J swaps, J-events and ordinary Account ACK traffic.
fn materialize_fresh_entity_context(
    inbound_htlc: Option<&InboundHtlcInfrastructure>,
    paybook_reachability: Option<&(EntityRouteTable, InboundSessionTable)>,
    profile_identity: Option<&crate::signed_profile::ProfileTransportIdentity>,
    request: EntityInfraMaterializeRequest<'_>,
) -> Result<MaterializedEntityInfraContext, FreshEntityContextError> {
    let mut request = request;
    let total_started = Instant::now();
    let account_rows = request.account_inputs.len();
    let local_txs = request.local_financial_txs.len();
    let origins = if needs_originated_htlc(&request) {
        let (routes, sessions) =
            paybook_reachability.ok_or(FreshEntityContextError::HtlcOriginRequired)?;
        let identity = profile_identity.ok_or(FreshEntityContextError::HtlcOriginRequired)?;
        Some(origin::materialize(
            &mut request,
            inbound_htlc,
            routes,
            sessions,
            identity,
        )?)
    } else {
        None
    };
    // Collect once. The former path first scanned every Account frame merely
    // to answer `needs_htlc_context`, then scanned them all again inside the
    // HTLC materializer. Ordinary payment/swap frames also entered that
    // materializer whenever infrastructure happened to be configured.
    let inbound_htlc_inputs = collect_inputs(&request);
    if !inbound_htlc_inputs.is_empty() && inbound_htlc.is_none() {
        return Err(FreshEntityContextError::HtlcInfrastructureRequired);
    }
    let classify_done = total_started.elapsed();
    let (prepared_entries, mut peer_assertions, observed_peer_by_prepared) =
        match (inbound_htlc, inbound_htlc_inputs.is_empty()) {
            (Some(infrastructure), false) => {
                let reachability = paybook_reachability.ok_or_else(|| {
                    FreshEntityContextError::HtlcInfrastructureInvalid(
                        "PAYBOOK_REACHABILITY_REQUIRED".into(),
                    )
                })?;
                materialize_inbound_htlc_context(
                    infrastructure,
                    reachability,
                    &mut request,
                    inbound_htlc_inputs,
                )?
            }
            _ => (Vec::new(), Vec::new(), BTreeMap::new()),
        };
    if let Some(origins) = &origins {
        let mut online = origins.assertions.clone();
        for assertion in peer_assertions {
            let row = canonical_object(&assertion, "PEER_ASSERTION")?;
            let entity = canonical_text(canonical_field(row, "entityId")?, "PEER_ENTITY")?;
            let CanonicalValue::Bool(ready) = canonical_field(row, "online")? else {
                return Err(filter_error("PEER_ONLINE"));
            };
            if online
                .insert(entity.to_string(), *ready)
                .is_some_and(|previous| previous != *ready)
            {
                return Err(filter_error("PEER_ONLINE_CONFLICT"));
            }
        }
        peer_assertions = online
            .into_iter()
            .map(|(entity, ready)| {
                canonical_object_value(vec![
                    ("entityId", CanonicalValue::String(entity)),
                    ("online", CanonicalValue::Bool(ready)),
                ])
            })
            .collect();
    }
    let inbound_done = total_started.elapsed();
    let entries = prepared_entries
        .iter()
        .map(canonical_entry)
        .collect::<Result<Vec<_>, _>>()?;
    let prepared_entry_count = prepared_entries.len();
    let mut prepared_htlcs = std::collections::BTreeMap::new();
    for entry in prepared_entries {
        let key = (
            entry.binding.account_frame_hash.clone(),
            entry.binding.hashlock.clone(),
        );
        if prepared_htlcs.insert(key.clone(), entry).is_some() {
            return Err(FreshEntityContextError::Htlc(
                PreparedContextError::BindingConflict {
                    key: format!("{}:{}", key.0, key.1),
                },
            ));
        }
    }
    let typed_done = total_started.elapsed();
    let replica = &request.replica;
    let height = request
        .state
        .entity
        .height
        .checked_add(1)
        .ok_or(FreshEntityContextError::HeightOverflow)?;
    if height > MAX_SAFE_INTEGER {
        return Err(FreshEntityContextError::HeightUnsafe(height));
    }
    let parent_frame_hash = match replica.entity_consensus.certified_frame_head.as_ref() {
        Some(head) if head.frame.height == request.state.entity.height => head.frame.hash.clone(),
        Some(head) => {
            return Err(FreshEntityContextError::Lineage {
                state: request.state.entity.height,
                head: head.frame.height.to_string(),
            });
        }
        None if request.state.entity.height == 0 => "genesis".to_string(),
        None => {
            return Err(FreshEntityContextError::Lineage {
                state: request.state.entity.height,
                head: "missing".into(),
            });
        }
    };
    let entity_id = request.state.entity.entity_id.clone();
    let signer_id = replica.signer_id.clone();
    let canonical = canonical_object_value(vec![
        ("version", canonical_number(1)?),
        (
            "proposerReplicaId",
            CanonicalValue::String(format!("{entity_id}:{signer_id}")),
        ),
        ("entityId", CanonicalValue::String(entity_id)),
        ("proposerSignerId", CanonicalValue::String(signer_id)),
        ("parentFrameHash", CanonicalValue::String(parent_frame_hash)),
        ("height", canonical_number(height)?),
        (
            "gossipProfiles",
            CanonicalValue::Array(
                origins
                    .as_ref()
                    .map(|value| value.profiles.clone())
                    .unwrap_or_default(),
            ),
        ),
        ("peerAssertions", CanonicalValue::Array(peer_assertions)),
        (
            "htlc",
            canonical_object_value(vec![
                ("version", canonical_number(1)?),
                ("entries", CanonicalValue::Array(entries)),
                (
                    "originated",
                    CanonicalValue::Array(
                        origins
                            .as_ref()
                            .map(|value| {
                                value
                                    .payments
                                    .values()
                                    .map(origin::canonical)
                                    .collect::<Result<Vec<_>, _>>()
                            })
                            .transpose()?
                            .unwrap_or_default(),
                    ),
                ),
            ]),
        ),
    ]);
    let canonical_done = total_started.elapsed();
    let execution = DeterministicContext {
        minimum_trade_size: BigInt::from(0),
        swap_taker_fee_bps: 0,
        jurisdiction_id: None,
        pair_policies: std::collections::BTreeMap::new(),
        prepared_htlcs,
        originated_htlcs: origins.map(|value| value.payments).unwrap_or_default(),
    };
    let total = total_started.elapsed();
    if profile_entity_context() {
        eprintln!(
            "RSCORE_ENTITY_CONTEXT_PHASE classify={} inbound={} typed={} canonical={} execution={} total={} accountRows={} localTxs={} preparedHtlcs={}",
            classify_done.as_micros(),
            inbound_done.saturating_sub(classify_done).as_micros(),
            typed_done.saturating_sub(inbound_done).as_micros(),
            canonical_done.saturating_sub(typed_done).as_micros(),
            total.saturating_sub(canonical_done).as_micros(),
            total.as_micros(),
            account_rows,
            local_txs,
            prepared_entry_count,
        );
    }
    Ok(MaterializedEntityInfraContext {
        execution,
        canonical,
        observed_peer_by_prepared,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canonical_value_from_tagged_json;
    use serde_json::json;
    use xln_rscore_engine::{AccountDomain, DepositoryAddress};
    use xln_rscore_entity_kernel::{HtlcPreparedBinding, HtlcPreparedOutcome, PreparedHtlcEntry};

    #[test]
    fn owned_entity_keys_decrypt_independently_and_rederive_after_restore() {
        use xln_rscore_entity_kernel::{decrypt_opaque_htlc_layer, encrypt_opaque_htlc_layer};
        let hub_private = [7; 32];
        let infrastructure = InboundHtlcInfrastructure {
            entity_encryption_public_key: *PublicKey::from(&StaticSecret::from(hub_private))
                .as_bytes(),
            entity_encryption_private_key: hub_private,
            routing_fee_ppm: 0,
            routing_base_fee: BigInt::from(0),
        };
        let seed = format!("0x{}", "55".repeat(64));
        let owners = [
            format!("0x{}", "11".repeat(32)),
            format!("0x{}", "22".repeat(32)),
        ];
        let keys = owners.each_ref().map(|owner| {
            crate::entity_encryption::derive_entity_encryption_key(&seed, owner).unwrap()
        });
        assert_ne!(keys[0], keys[1]);
        for index in 0..2 {
            let public = *PublicKey::from(&StaticSecret::from(keys[index])).as_bytes();
            let selected = infrastructure
                .owner_private_key(&owners[index], public, Some(&seed))
                .unwrap();
            let envelope =
                encrypt_opaque_htlc_layer(b"owner-bound payload", &public, &[9; 32], &[8; 32])
                    .unwrap();
            assert_eq!(
                decrypt_opaque_htlc_layer(&envelope, &public, &selected, &[9; 32]).unwrap(),
                b"owner-bound payload"
            );
            let restored = infrastructure.clone().validate().unwrap();
            assert_eq!(
                restored
                    .owner_private_key(&owners[index], public, Some(&seed))
                    .unwrap(),
                selected
            );
            assert!(
                restored
                    .owner_private_key(&owners[1 - index], public, Some(&seed))
                    .is_err()
            );
            assert!(
                restored
                    .owner_private_key(&owners[index], public, None)
                    .is_err()
            );
            assert!(
                decrypt_opaque_htlc_layer(
                    &envelope,
                    &infrastructure.entity_encryption_public_key,
                    &hub_private,
                    &[9; 32]
                )
                .is_err()
            );
        }
    }

    #[test]
    fn inbound_htlc_infrastructure_requires_the_checkpoint_keypair() {
        let private_key = [7_u8; 32];
        let public_key = *PublicKey::from(&StaticSecret::from(private_key)).as_bytes();
        let valid = InboundHtlcInfrastructure {
            entity_encryption_public_key: public_key,
            entity_encryption_private_key: private_key,
            routing_fee_ppm: 1,
            routing_base_fee: BigInt::from(0),
        };
        valid.clone().validate().expect("matching keypair");
        assert!(matches!(
            InboundHtlcInfrastructure {
                entity_encryption_public_key: [8; 32],
                ..valid
            }
            .validate(),
            Err(FreshEntityContextError::HtlcInfrastructureInvalid(_))
        ));
    }

    #[test]
    fn materialized_context_trims_tail_without_rematerializing() {
        let frame = format!("0x{}", "11".repeat(32));
        let hashlock = format!("0x{}", "22".repeat(32));
        let peer = format!("0x{}", "33".repeat(32));
        let key = (frame.clone(), hashlock.clone());
        let entry = PreparedHtlcEntry {
            binding: HtlcPreparedBinding {
                from_entity_id: format!("0x{}", "44".repeat(32)),
                to_entity_id: format!("0x{}", "55".repeat(32)),
                domain: AccountDomain::new(
                    1,
                    DepositoryAddress::parse(&format!("0x{}", "66".repeat(20)))
                        .expect("depository"),
                )
                .expect("domain"),
                account_frame_hash: frame.clone(),
                account_height: 1,
                envelope_hash: format!("0x{}", "77".repeat(32)),
                hashlock: hashlock.clone(),
                token_id: 1,
                amount: BigInt::from(1),
                timelock: BigInt::from(2),
                reveal_before_height: 3,
            },
            outcome: HtlcPreparedOutcome::Reject {
                reason: "insufficient_capacity".into(),
            },
        };
        let mut execution = DeterministicContext::hlt_default();
        execution.prepared_htlcs.insert(key.clone(), entry);
        let canonical = canonical_value_from_tagged_json(&json!({
            "gossipProfiles": [],
            "peerAssertions": [],
            "htlc": {
                "originated": [],
                "entries": [{
                    "binding": { "accountFrameHash": frame, "hashlock": hashlock },
                    "outcome": { "kind": "reject", "reason": "insufficient_capacity" }
                }]
            }
        }))
        .expect("canonical context");
        let mut materialized = MaterializedEntityInfraContext {
            execution,
            canonical,
            observed_peer_by_prepared: BTreeMap::from([(key, peer)]),
        };

        materialized
            .retain_inbound_htlc_keys(&BTreeSet::new(), &BTreeSet::new())
            .expect("trim tail");
        assert!(materialized.execution.prepared_htlcs.is_empty());
        let context = canonical_object(&materialized.canonical, "context").expect("context");
        let CanonicalValue::Array(assertions) =
            canonical_field(context, "peerAssertions").expect("assertions")
        else {
            panic!("assertion rows")
        };
        assert!(assertions.is_empty());
        let htlc = canonical_object(canonical_field(context, "htlc").expect("htlc"), "htlc")
            .expect("htlc object");
        let CanonicalValue::Array(entries) = canonical_field(htlc, "entries").expect("entries")
        else {
            panic!("entry rows")
        };
        assert!(entries.is_empty());
    }
}

//! Canonical proposer context for live resident Runtime frames.

#[path = "fresh/htlc.rs"]
mod htlc;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;
use std::time::Instant;

use num_bigint::BigInt;
use serde_json::Value;
use thiserror::Error;
use x25519_dalek::{PublicKey, StaticSecret};
use xln_rscore_batch::AccountInputRow;
use xln_rscore_entity_kernel::{
    DeterministicContext, LocalEntityFinancialTx, PreparedContextError,
};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

use self::htlc::{canonical_entry, collect_inputs, materialize_inbound_htlc_context};
use super::decode_entity_deterministic_policy;

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
    #[error("RRS_FRESH_CONTEXT_ENTITY_POLICY_MISSING:{0}")]
    EntityPolicyMissing(String),
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
    pub state: &'a RuntimeEntityState,
    pub replica: &'a mut RuntimeEntityReplica,
    /// Exact Account rows remaining after Runtime FIFO and Entity wire fitting.
    pub account_inputs: &'a [&'a AccountInputRow],
    /// Exact effective local operations after Entity-command expansion.
    pub local_financial_txs: &'a [&'a LocalEntityFinancialTx],
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
    ) -> Result<(), FreshEntityContextError> {
        self.execution
            .prepared_htlcs
            .retain(|key, _| retained.contains(key));
        self.observed_peer_by_prepared
            .retain(|key, _| retained.contains(key));
        let retained_peers = self
            .observed_peer_by_prepared
            .values()
            .cloned()
            .collect::<BTreeSet<_>>();

        let context = canonical_object_mut(&mut self.canonical, "CONTEXT")?;
        let htlc = canonical_field_mut(context, "htlc")?;
        let htlc = canonical_object_mut(htlc, "HTLC")?;
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
    fn set_paybook_reachability(&mut self, routes: EntityRouteTable, sessions: InboundSessionTable);

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
pub struct CanonicalEntityInfraMaterializer {
    policy: DeterministicContext,
    inbound_htlc: Option<InboundHtlcInfrastructure>,
    paybook_reachability: Option<(EntityRouteTable, InboundSessionTable)>,
}

/// One canonical live context materializer per local Entity, selected by the
/// committed Entity id already present in the Runtime apply request.  This is
/// process configuration only: no policy or key is copied into Runtime state,
/// and replay still consumes the exact context committed in each frame.
pub struct CanonicalMultiEntityInfraMaterializer {
    by_entity: BTreeMap<String, CanonicalEntityInfraMaterializer>,
}

impl CanonicalMultiEntityInfraMaterializer {
    pub fn new(
        entries: impl IntoIterator<Item = (String, Value, InboundHtlcInfrastructure)>,
    ) -> Result<Self, FreshEntityContextError> {
        let mut by_entity = BTreeMap::new();
        for (entity_id, policy, infrastructure) in entries {
            let entity_id = entity_id.trim().to_ascii_lowercase();
            if entity_id.is_empty()
                || by_entity
                    .insert(
                        entity_id.clone(),
                        CanonicalEntityInfraMaterializer::with_inbound_htlc(
                            policy,
                            infrastructure,
                        )?,
                    )
                    .is_some()
            {
                return Err(FreshEntityContextError::EntityPolicyMissing(entity_id));
            }
        }
        if by_entity.is_empty() {
            return Err(FreshEntityContextError::EntityPolicyMissing(String::new()));
        }
        Ok(Self { by_entity })
    }
}

impl EntityInfraMaterializer for CanonicalMultiEntityInfraMaterializer {
    fn set_paybook_reachability(
        &mut self,
        routes: EntityRouteTable,
        sessions: InboundSessionTable,
    ) {
        for materializer in self.by_entity.values_mut() {
            materializer.set_paybook_reachability(routes.clone(), sessions.clone());
        }
    }

    fn materialize(
        &mut self,
        request: EntityInfraMaterializeRequest<'_>,
    ) -> Result<MaterializedEntityInfraContext, FreshEntityContextError> {
        let entity_id = request.state.entity.entity_id.trim().to_ascii_lowercase();
        self.by_entity
            .get_mut(&entity_id)
            .ok_or(FreshEntityContextError::EntityPolicyMissing(entity_id))?
            .materialize(request)
    }
}

impl CanonicalEntityInfraMaterializer {
    pub fn new(policy: Value) -> Result<Self, FreshEntityContextError> {
        Ok(Self {
            policy: decode_entity_deterministic_policy(&policy)?,
            inbound_htlc: None,
            paybook_reachability: None,
        })
    }

    pub fn with_inbound_htlc(
        policy: Value,
        infrastructure: InboundHtlcInfrastructure,
    ) -> Result<Self, FreshEntityContextError> {
        Ok(Self {
            policy: decode_entity_deterministic_policy(&policy)?,
            inbound_htlc: Some(infrastructure.validate()?),
            paybook_reachability: None,
        })
    }
}

impl EntityInfraMaterializer for CanonicalEntityInfraMaterializer {
    fn set_paybook_reachability(
        &mut self,
        routes: EntityRouteTable,
        sessions: InboundSessionTable,
    ) {
        self.paybook_reachability = Some((routes, sessions));
    }

    fn materialize(
        &mut self,
        request: EntityInfraMaterializeRequest<'_>,
    ) -> Result<MaterializedEntityInfraContext, FreshEntityContextError> {
        materialize_fresh_entity_context_from_policy(
            &self.policy,
            self.inbound_htlc.as_ref(),
            self.paybook_reachability.as_ref(),
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
pub fn materialize_fresh_entity_context(
    policy: &Value,
    inbound_htlc: Option<&InboundHtlcInfrastructure>,
    request: EntityInfraMaterializeRequest<'_>,
) -> Result<MaterializedEntityInfraContext, FreshEntityContextError> {
    let policy = decode_entity_deterministic_policy(policy)?;
    materialize_fresh_entity_context_from_policy(&policy, inbound_htlc, None, request)
}

fn materialize_fresh_entity_context_from_policy(
    policy: &DeterministicContext,
    inbound_htlc: Option<&InboundHtlcInfrastructure>,
    paybook_reachability: Option<&(EntityRouteTable, InboundSessionTable)>,
    mut request: EntityInfraMaterializeRequest<'_>,
) -> Result<MaterializedEntityInfraContext, FreshEntityContextError> {
    let total_started = Instant::now();
    let account_rows = request.account_inputs.len();
    let local_txs = request.local_financial_txs.len();
    if needs_originated_htlc(&request) {
        return Err(FreshEntityContextError::HtlcOriginRequired);
    }
    // Collect once. The former path first scanned every Account frame merely
    // to answer `needs_htlc_context`, then scanned them all again inside the
    // HTLC materializer. Ordinary payment/swap frames also entered that
    // materializer whenever infrastructure happened to be configured.
    let inbound_htlc_inputs = collect_inputs(&request);
    if !inbound_htlc_inputs.is_empty() && inbound_htlc.is_none() {
        return Err(FreshEntityContextError::HtlcInfrastructureRequired);
    }
    let classify_done = total_started.elapsed();
    let (prepared_entries, peer_assertions, observed_peer_by_prepared) =
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
        ("gossipProfiles", CanonicalValue::Array(Vec::new())),
        ("peerAssertions", CanonicalValue::Array(peer_assertions)),
        (
            "htlc",
            canonical_object_value(vec![
                ("version", canonical_number(1)?),
                ("entries", CanonicalValue::Array(entries)),
                ("originated", CanonicalValue::Array(Vec::new())),
            ]),
        ),
    ]);
    let canonical_done = total_started.elapsed();
    let execution = DeterministicContext {
        minimum_trade_size: policy.minimum_trade_size.clone(),
        swap_taker_fee_bps: policy.swap_taker_fee_bps,
        jurisdiction_id: policy.jurisdiction_id.clone(),
        pair_policies: policy.pair_policies.clone(),
        prepared_htlcs,
        originated_htlcs: std::collections::BTreeMap::new(),
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
    fn multi_entity_materializer_requires_unique_complete_entity_keys() {
        let infrastructure = |byte: u8| {
            let private_key = [byte; 32];
            InboundHtlcInfrastructure {
                entity_encryption_public_key: *PublicKey::from(&StaticSecret::from(private_key))
                    .as_bytes(),
                entity_encryption_private_key: private_key,
                routing_fee_ppm: 1,
                routing_base_fee: BigInt::from(0),
            }
        };
        let policy = || {
            json!({
                "minimumTradeSize": {"__xlnType":"BigInt","value":"1"},
                "swapTakerFeeBps": 1,
                "jurisdictionId": "test",
                "pairPolicies": [],
            })
        };
        let materializer = CanonicalMultiEntityInfraMaterializer::new([
            (
                format!("0x{}", "11".repeat(32)),
                policy(),
                infrastructure(1),
            ),
            (
                format!("0x{}", "22".repeat(32)),
                policy(),
                infrastructure(2),
            ),
        ])
        .expect("two Entity policies");
        assert_eq!(materializer.by_entity.len(), 2);

        let duplicate = CanonicalMultiEntityInfraMaterializer::new([
            (
                format!("0x{}", "11".repeat(32)),
                policy(),
                infrastructure(1),
            ),
            (
                format!("0x{}", "11".repeat(32)),
                policy(),
                infrastructure(2),
            ),
        ]);
        assert!(matches!(
            duplicate,
            Err(FreshEntityContextError::EntityPolicyMissing(_))
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
            "peerAssertions": [],
            "htlc": {
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
            .retain_inbound_htlc_keys(&BTreeSet::new())
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

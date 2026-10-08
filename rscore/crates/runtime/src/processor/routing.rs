use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use serde_json::{Map, Number, Value};
use thiserror::Error;

use crate::transport::InboundSessionTable;
use crate::transport::{DirectRoute, DirectRouteTable, RuntimeTransportError};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const ENTITY_ID_BYTES: usize = 32;
const RUNTIME_ID_BYTES: usize = 20;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityRoute {
    pub target_entity_id: String,
    pub target_runtime_id: String,
    pub target_signer_id: String,
    pub websocket_url: Option<String>,
}

#[derive(Clone, Debug)]
struct BoundEntityRoute {
    runtime_id: String,
    signer_id: String,
    /// `None` is an operator-installed route and cannot be displaced by
    /// gossip. Dynamic routes use the signed Profile clock.
    last_updated: Option<u64>,
    /// Original signed Gossip row, retained only after full profile and route verification.
    authenticated_profile: Option<Value>,
}

pub(crate) struct BoundEntityOutputs {
    pub rows: Vec<Vec<u8>>,
    /// Exact in-memory values used to build `rows`, retained only until the
    /// synced WAL token is published. Recovery deliberately has no copy.
    pub resident_rows: Vec<Value>,
    pub local_continuations: Vec<crate::RuntimeEntityInput>,
}

pub(crate) enum BoundEntityOutput {
    Remote { row: Vec<u8>, value: Value },
    Local(Box<crate::RuntimeEntityInput>),
}

/// Deterministic Entity-to-Runtime routing installed outside consensus.
///
/// Entity certification names only the destination Entity. Runtime binds that
/// immutable output to one explicit validator/runtime route before the output
/// enters the same fsynced batch as its Runtime frame. Missing routes are a
/// hard error; guessing from local replicas or gossip would make replay depend
/// on whichever process happened to answer first. The only non-operator,
/// non-Profile source is this Runtime's own fsynced outbox: a destination it
/// already bound is the same fact native replay derives its table from.
#[derive(Clone, Debug)]
pub struct EntityRouteTable {
    by_entity: Arc<BTreeMap<String, BoundEntityRoute>>,
    direct_routes: DirectRouteTable,
}

/// Signed Profile clocks are validated `>= 1`. A destination recovered from
/// the durable outbox sits below every Profile so the peer's next
/// transport-authenticated announcement supersedes it.
const RECOVERED_OUTBOX_ROUTE_CLOCK: u64 = 0;

#[derive(Debug, Error)]
pub enum EntityRouteError {
    #[error("RRS_ENTITY_ROUTE_ENTITY_ID:{0}")]
    EntityId(String),
    #[error("RRS_ENTITY_ROUTE_SIGNER_ID_EMPTY:{0}")]
    SignerId(String),
    #[error("RRS_ENTITY_ROUTE_DUPLICATE:{0}")]
    Duplicate(String),
    #[error("RRS_ENTITY_ROUTE_MISSING:{0}")]
    Missing(String),
    #[error("RRS_ENTITY_ROUTE_RUNTIME_CONFLICT:{0}")]
    RuntimeConflict(String),
    #[error("RRS_ENTITY_OUTPUT_NOT_OBJECT:{0}")]
    OutputObject(usize),
    #[error("RRS_ENTITY_OUTPUT_FIELD:{index}:{field}")]
    OutputField { index: usize, field: &'static str },
    #[error("RRS_ENTITY_OUTPUT_ALREADY_ROUTED:{index}:{field}")]
    AlreadyRouted { index: usize, field: &'static str },
    #[error("RRS_ENTITY_OUTPUT_TARGET_SIGNER_MISMATCH:{index}:{expected}:{actual}")]
    TargetSignerMismatch {
        index: usize,
        expected: String,
        actual: String,
    },
    #[error("RRS_ENTITY_OUTPUT_EMPTY:{0}")]
    Empty(usize),
    #[error("RRS_ENTITY_OUTPUT_SAFE_INTEGER:{field}:{value}")]
    SafeInteger { field: &'static str, value: u64 },
    #[error("RRS_ENTITY_OUTPUT_LOCAL_PAYLOAD:{0}")]
    LocalPayload(usize),
    #[error("RRS_ENTITY_OUTPUT_LOCAL_CROSS_J_ESCAPED_MACHINE:{0}")]
    LocalCrossJEscapedMachine(usize),
    #[error("RRS_ENTITY_OUTPUT_LOCAL_INPUT:{0}")]
    LocalInput(String),
    #[error("INBOUND_ENTITY_OWNER_UNKNOWN:{entity_id}:{signer_id}")]
    InboundEntityOwner {
        entity_id: String,
        signer_id: String,
    },
    #[error("INBOUND_RUNTIME_OUTPUT_ENVELOPE_INVALID:index={0}")]
    InboundRuntimeOutputEnvelope(usize),
    #[error("INBOUND_RUNTIME_OUTPUT_SOURCE_UNVERIFIED:{entity_id}:{signer_id}:{peer_runtime_id}")]
    InboundRuntimeOutputSource {
        entity_id: String,
        signer_id: String,
        peer_runtime_id: String,
    },
    #[error(transparent)]
    Transport(#[from] RuntimeTransportError),
}

impl EntityRouteTable {
    pub fn new(routes: impl IntoIterator<Item = EntityRoute>) -> Result<Self, EntityRouteError> {
        let mut by_entity = BTreeMap::new();
        let mut direct = BTreeMap::<String, String>::new();
        for route in routes {
            let entity_id = normalized_entity_id(&route.target_entity_id)?;
            let runtime_id = normalized_runtime_id(&route.target_runtime_id)?;
            if route.target_signer_id.trim().is_empty() {
                return Err(EntityRouteError::SignerId(entity_id));
            }
            if by_entity
                .insert(
                    entity_id.clone(),
                    BoundEntityRoute {
                        runtime_id: runtime_id.clone(),
                        signer_id: route.target_signer_id,
                        last_updated: None,
                        authenticated_profile: None,
                    },
                )
                .is_some()
            {
                return Err(EntityRouteError::Duplicate(entity_id));
            }
            if let Some(url) = route.websocket_url {
                if let Some(existing) = direct.get(&runtime_id) {
                    if existing != &url {
                        return Err(EntityRouteError::RuntimeConflict(runtime_id));
                    }
                } else {
                    direct.insert(runtime_id, url);
                }
            }
        }
        let direct = direct
            .into_iter()
            .map(|(target_runtime_id, url)| DirectRoute {
                target_runtime_id,
                url,
            });
        Ok(Self {
            by_entity: Arc::new(by_entity),
            direct_routes: DirectRouteTable::new(direct)?,
        })
    }

    pub fn direct_routes(&self) -> DirectRouteTable {
        self.direct_routes.clone()
    }

    /// Entity profiles explicitly installed by the operator. The resident
    /// Runtime uses this same deterministic set both for output routing and
    /// for HTLC liveness assertions; no gossip lookup occurs mid-frame.
    pub fn entity_ids(&self) -> impl Iterator<Item = &str> {
        self.by_entity.keys().map(String::as_str)
    }

    /// Authenticate the complete batch before any input enters the live writer.
    /// A valid peer session cannot claim another Entity's public signer. The
    /// existing operator-pinned or signed-profile route must bind all three
    /// source coordinates; nested semantic authority is checked later by Entity.
    pub(crate) fn validate_inbound_runtime_outputs(
        &self,
        peer_runtime_id: &str,
        inputs: &[crate::RuntimeEntityInput],
    ) -> Result<(), EntityRouteError> {
        for (index, input) in inputs.iter().enumerate() {
            let Some(output) = input.runtime_output() else {
                continue;
            };
            let peer = normalized_runtime_id(peer_runtime_id)?;
            let canonical = input.canonical();
            if canonical.get("from").and_then(Value::as_str) != Some(peer.as_str())
                || canonical.get("entityId").and_then(Value::as_str)
                    != Some(output.target_entity_id.as_str())
                || canonical
                    .get("entityTxs")
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    != Some(1)
                || !canonical
                    .get("sourceRuntimeFrame")
                    .is_some_and(Value::is_object)
            {
                return Err(EntityRouteError::InboundRuntimeOutputEnvelope(index));
            }
            let entity_id = normalized_entity_id(&output.source_entity_id)?;
            let signer_id = output.source_signer_id.trim().to_ascii_lowercase();
            let verified = self.by_entity.get(&entity_id).is_some_and(|route| {
                route.runtime_id == peer && route.signer_id.trim().to_ascii_lowercase() == signer_id
            });
            if !verified {
                return Err(EntityRouteError::InboundRuntimeOutputSource {
                    entity_id,
                    signer_id,
                    peer_runtime_id: peer,
                });
            }
        }
        Ok(())
    }

    /// Paybook liveness is a transient Entity-preprocessing fact. Operator
    /// routes are explicit live routes; authenticated Profile routes are live
    /// only while their exact Runtime socket remains open.
    pub(crate) fn is_paybook_peer_online(
        &self,
        entity_id: &str,
        sessions: &InboundSessionTable,
    ) -> Result<bool, RuntimeTransportError> {
        let Ok(entity_id) = normalized_entity_id(entity_id) else {
            return Ok(false);
        };
        let Some(route) = self.by_entity.get(&entity_id) else {
            return Ok(false);
        };
        if route.last_updated.is_none() {
            return Ok(true);
        }
        sessions.has_open(&route.runtime_id)
    }

    pub fn authenticated_profiles(&self) -> Vec<Value> {
        self.by_entity
            .values()
            .filter_map(|route| route.authenticated_profile.clone())
            .collect()
    }

    pub(super) fn with_verified_profile(
        &self,
        profile: super::profile_route::VerifiedProfileRoute,
    ) -> Result<Self, EntityRouteError> {
        let mut updated = self.clone();
        let routes = Arc::make_mut(&mut updated.by_entity);
        if let Some(existing) = routes.get_mut(&profile.entity_id) {
            if existing.runtime_id == profile.runtime_id && existing.signer_id == profile.signer_id
            {
                // An operator-pinned route remains pinned, but its verified peer profile
                // supplies display metadata. An older signed row never overwrites newer metadata.
                let metadata_clock = existing
                    .authenticated_profile
                    .as_ref()
                    .and_then(|value| value.get("lastUpdated"))
                    .and_then(Value::as_u64);
                if metadata_clock.is_none_or(|clock| clock < profile.last_updated) {
                    existing.authenticated_profile = Some(profile.profile);
                }
                if existing
                    .last_updated
                    .is_some_and(|clock| clock < profile.last_updated)
                {
                    existing.last_updated = Some(profile.last_updated);
                }
                return Ok(updated);
            }
            match existing.last_updated {
                None => return Err(EntityRouteError::RuntimeConflict(profile.entity_id)),
                Some(clock) if clock > profile.last_updated => return Ok(updated),
                Some(clock) if clock == profile.last_updated => {
                    return Err(EntityRouteError::RuntimeConflict(profile.entity_id));
                }
                _ => {}
            }
        }
        routes.insert(
            profile.entity_id,
            BoundEntityRoute {
                runtime_id: profile.runtime_id,
                signer_id: profile.signer_id,
                last_updated: Some(profile.last_updated),
                authenticated_profile: Some(profile.profile),
            },
        );
        Ok(updated)
    }

    /// Install a destination this Runtime already bound and fsynced in its own
    /// flat outbox. Profile routes are RAM transport state, so after a restart
    /// the first frame addressing a peer that has not re-announced would
    /// otherwise fail-stop on `RRS_ENTITY_ROUTE_MISSING` even though the
    /// destination is committed in the WAL and native replay derives its route
    /// table from these same rows. A later row for the same Entity replaces an
    /// earlier recovered one; operator routes and signed Profile routes are
    /// never displaced. Nothing new becomes durable.
    pub(crate) fn with_recovered_output_route(
        &mut self,
        entity_id: &str,
        runtime_id: &str,
        signer_id: &str,
    ) -> Result<(), EntityRouteError> {
        let entity_id = normalized_entity_id(entity_id)?;
        let runtime_id = normalized_runtime_id(runtime_id)?;
        let signer_id = signer_id.trim().to_ascii_lowercase();
        if signer_id.is_empty() {
            return Err(EntityRouteError::SignerId(entity_id));
        }
        let routes = Arc::make_mut(&mut self.by_entity);
        if routes
            .get(&entity_id)
            .is_some_and(|existing| existing.last_updated != Some(RECOVERED_OUTBOX_ROUTE_CLOCK))
        {
            return Ok(());
        }
        routes.insert(
            entity_id,
            BoundEntityRoute {
                runtime_id,
                signer_id,
                last_updated: Some(RECOVERED_OUTBOX_ROUTE_CLOCK),
                authenticated_profile: None,
            },
        );
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn bind_and_encode(
        &self,
        outputs: Vec<Value>,
        source_height: u64,
        source_timestamp: u64,
        local_entity_id: &str,
        local_signer_id: &str,
    ) -> Result<BoundEntityOutputs, EntityRouteError> {
        let local_entity_id = normalized_entity_id(local_entity_id)?;
        if local_signer_id.trim().is_empty() {
            return Err(EntityRouteError::SignerId(local_entity_id));
        }
        let bound = outputs
            .into_iter()
            .enumerate()
            .map(|(index, output)| {
                self.bind_and_encode_one(
                    output,
                    index,
                    source_height,
                    source_timestamp,
                    &local_entity_id,
                    local_signer_id,
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self::collect_bound(bound))
    }

    pub(crate) fn bind_and_encode_one(
        &self,
        output: Value,
        index: usize,
        source_height: u64,
        source_timestamp: u64,
        local_entity_id: &str,
        local_signer_id: &str,
    ) -> Result<BoundEntityOutput, EntityRouteError> {
        let Value::Object(mut object) = output else {
            return Err(EntityRouteError::OutputObject(index));
        };
        validate_local_output(&object, index)?;
        let raw_entity = object.get("entityId").and_then(Value::as_str).ok_or(
            EntityRouteError::OutputField {
                index,
                field: "entityId",
            },
        )?;
        let entity_id = normalized_entity_id(raw_entity)?;
        object.insert("entityId".into(), Value::String(entity_id.clone()));
        let supplied_signer = object
            .get("signerId")
            .and_then(Value::as_str)
            .map(|value| value.trim().to_ascii_lowercase());
        if object.contains_key("signerId") && supplied_signer.is_none() {
            return Err(EntityRouteError::OutputField {
                index,
                field: "signerId",
            });
        }
        if supplied_signer.as_deref() == Some("") {
            return Err(EntityRouteError::SignerId(entity_id));
        }
        if entity_id == local_entity_id {
            if is_local_runtime_output(&object, &entity_id, local_entity_id, local_signer_id) {
                return Err(EntityRouteError::LocalCrossJEscapedMachine(index));
            }
            if !is_trigger_only(&object) {
                return Err(EntityRouteError::LocalPayload(index));
            }
            let local_signer_id = local_signer_id.trim().to_ascii_lowercase();
            if let Some(actual) = supplied_signer.as_ref()
                && actual != &local_signer_id
            {
                return Err(EntityRouteError::TargetSignerMismatch {
                    index,
                    expected: local_signer_id,
                    actual: actual.clone(),
                });
            }
            object.insert("signerId".into(), Value::String(local_signer_id));
            return crate::RuntimeEntityInput::decode(Value::Object(object))
                .map(Box::new)
                .map(BoundEntityOutput::Local)
                .map_err(|error| EntityRouteError::LocalInput(error.to_string()));
        }
        let route = self
            .by_entity
            .get(&entity_id)
            .ok_or_else(|| EntityRouteError::Missing(entity_id.clone()))?;
        let expected_signer = route.signer_id.trim().to_ascii_lowercase();
        if let Some(actual) = supplied_signer
            && actual != expected_signer
        {
            return Err(EntityRouteError::TargetSignerMismatch {
                index,
                expected: expected_signer,
                actual,
            });
        }
        object.insert("signerId".into(), Value::String(expected_signer));
        object.insert("runtimeId".into(), Value::String(route.runtime_id.clone()));
        object.insert(
            "sourceRuntimeFrame".into(),
            Value::Object(Map::from_iter([
                ("height".into(), safe_number("height", source_height)?),
                (
                    "timestamp".into(),
                    safe_number("timestamp", source_timestamp)?,
                ),
            ])),
        );
        let value = Value::Object(object);
        let row = crate::transport::msgpack::encode_framed(&value)?;
        Ok(BoundEntityOutput::Remote { row, value })
    }

    /// Prior native output keeps its financial bytes and original frame, but
    /// its recorded transport destination must still be the current bound route.
    pub(crate) fn validate_retained_output(
        &self,
        output: &Value,
        index: usize,
    ) -> Result<(), EntityRouteError> {
        let entity_id = output.get("entityId").and_then(Value::as_str).ok_or(
            EntityRouteError::OutputField {
                index,
                field: "entityId",
            },
        )?;
        let entity_id = normalized_entity_id(entity_id)?;
        let route = self
            .by_entity
            .get(&entity_id)
            .ok_or_else(|| EntityRouteError::Missing(entity_id.clone()))?;
        if output.get("runtimeId").and_then(Value::as_str) != Some(route.runtime_id.as_str()) {
            return Err(EntityRouteError::RuntimeConflict(entity_id));
        }
        let signer = output.get("signerId").and_then(Value::as_str).ok_or(
            EntityRouteError::OutputField {
                index,
                field: "signerId",
            },
        )?;
        let expected_signer = route.signer_id.trim().to_ascii_lowercase();
        if signer != expected_signer {
            return Err(EntityRouteError::TargetSignerMismatch {
                index,
                expected: expected_signer,
                actual: signer.into(),
            });
        }
        Ok(())
    }

    pub(crate) fn collect_bound(outputs: Vec<BoundEntityOutput>) -> BoundEntityOutputs {
        let mut rows = Vec::with_capacity(outputs.len());
        let mut resident_rows = Vec::with_capacity(outputs.len());
        let mut local_continuations = Vec::new();
        let mut local_owners = BTreeSet::new();
        for output in outputs {
            match output {
                BoundEntityOutput::Remote { row, value } => {
                    rows.push(row);
                    resident_rows.push(value);
                }
                // TS merges current-frame self-wakes by Entity and signer.
                // Preserve each owner's first output position: a wake for one
                // owner must not suppress another owner's pending work (R4 h30).
                BoundEntityOutput::Local(input) => {
                    if local_owners.insert((*input.entity_id(), input.signer_id().to_owned())) {
                        local_continuations.push(*input);
                    }
                }
            }
        }
        BoundEntityOutputs {
            rows,
            resident_rows,
            local_continuations,
        }
    }
}

fn is_trigger_only(object: &Map<String, Value>) -> bool {
    object
        .get("entityTxs")
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty)
        && [
            "proposedFrame",
            "hashPrecommits",
            "jPrefixAttestations",
            "leaderTimeoutVote",
        ]
        .iter()
        .all(|field| !object.contains_key(*field))
}

fn is_local_runtime_output(
    object: &Map<String, Value>,
    target_entity_id: &str,
    source_entity_id: &str,
    source_signer_id: &str,
) -> bool {
    let Some([tx]) = object
        .get("entityTxs")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
    else {
        return false;
    };
    let Some(tx) = tx.as_object() else {
        return false;
    };
    if tx.get("type").and_then(Value::as_str) != Some("runtimeOutput") {
        return false;
    }
    let Some(data) = tx.get("data").and_then(Value::as_object) else {
        return false;
    };
    data.get("protocol").and_then(Value::as_str) == Some("cross-j")
        && data.get("targetEntityId").and_then(Value::as_str) == Some(target_entity_id)
        && data.get("sourceEntityId").and_then(Value::as_str) == Some(source_entity_id)
        && data.get("sourceSignerId").and_then(Value::as_str)
            == Some(source_signer_id.trim().to_ascii_lowercase().as_str())
        && data
            .get("entityTxs")
            .and_then(Value::as_array)
            .is_some_and(|txs| !txs.is_empty())
}

fn validate_local_output(
    object: &Map<String, Value>,
    index: usize,
) -> Result<(), EntityRouteError> {
    for field in [
        "runtimeId",
        "sourceRuntimeFrame",
        "atomicCrossJurisdictionPair",
    ] {
        if object.contains_key(field) {
            return Err(EntityRouteError::AlreadyRouted { index, field });
        }
    }
    let has_payload = [
        "entityTxs",
        "proposedFrame",
        "hashPrecommits",
        "jPrefixAttestations",
        "leaderTimeoutVote",
    ]
    .iter()
    .any(|field| object.contains_key(*field));
    if !has_payload {
        return Err(EntityRouteError::Empty(index));
    }
    Ok(())
}

fn safe_number(field: &'static str, value: u64) -> Result<Value, EntityRouteError> {
    if value > MAX_SAFE_INTEGER {
        return Err(EntityRouteError::SafeInteger { field, value });
    }
    Ok(Value::Number(Number::from(value)))
}

fn normalized_entity_id(value: &str) -> Result<String, EntityRouteError> {
    normalized_hex_id(value, ENTITY_ID_BYTES)
        .ok_or_else(|| EntityRouteError::EntityId(value.into()))
}

fn normalized_runtime_id(value: &str) -> Result<String, EntityRouteError> {
    normalized_hex_id(value, RUNTIME_ID_BYTES).ok_or_else(|| {
        EntityRouteError::Transport(RuntimeTransportError::Route(format!("runtime-id:{value}")))
    })
}

fn normalized_hex_id(value: &str, width: usize) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    let body = normalized.strip_prefix("0x")?;
    if body.len() != width * 2 || !body.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(normalized)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn entity(byte: &str) -> String {
        format!("0x{}", byte.repeat(32))
    }

    fn runtime(byte: &str) -> String {
        format!("0x{}", byte.repeat(20))
    }

    fn routes() -> EntityRouteTable {
        EntityRouteTable::new([EntityRoute {
            target_entity_id: entity("11"),
            target_runtime_id: runtime("22"),
            target_signer_id: "peer".into(),
            websocket_url: Some("ws://127.0.0.1:9000/ws".into()),
        }])
        .expect("routes")
    }

    #[test]
    fn cross_j_r6_h72_retention_requires_the_current_route_and_signer() {
        let routes = routes();
        let output = json!({
            "entityId": entity("11"), "runtimeId": runtime("22"), "signerId": "peer",
            "sourceRuntimeFrame": {"height": 71, "timestamp": 100},
            "entityTxs": []
        });
        routes
            .validate_retained_output(&output, 0)
            .expect("bound route");
        let mut redirected = output.clone();
        redirected["runtimeId"] = json!(runtime("33"));
        assert!(matches!(
            routes.validate_retained_output(&redirected, 0),
            Err(EntityRouteError::RuntimeConflict(_))
        ));
        let mut wrong_signer = output.clone();
        wrong_signer["signerId"] = json!("other");
        assert!(matches!(
            routes.validate_retained_output(&wrong_signer, 0),
            Err(EntityRouteError::TargetSignerMismatch { .. })
        ));
        let mut unknown = output;
        unknown["entityId"] = json!(entity("44"));
        assert!(matches!(
            routes.validate_retained_output(&unknown, 0),
            Err(EntityRouteError::Missing(_))
        ));
    }

    #[test]
    fn inbound_runtime_output_requires_exact_operator_pinned_source() {
        let source = entity("11");
        let peer = runtime("22");
        let signer = runtime("33");
        let routes = EntityRouteTable::new([EntityRoute {
            target_entity_id: source.clone(),
            target_runtime_id: peer.clone(),
            target_signer_id: signer.clone(),
            websocket_url: None,
        }])
        .expect("operator-pinned route");
        let wire = json!({
            "entityId": entity("ab"), "signerId": runtime("55"),
            "from": peer, "runtimeId": runtime("66"),
            "sourceRuntimeFrame": {"height": 1, "timestamp": 100},
            "entityTxs": [{"type": "runtimeOutput", "data": {
                "protocol": "cross-j", "sourceEntityId": source,
                "sourceSignerId": signer, "targetEntityId": entity("ab"),
                "entityTxs": [{"type": "crossJurisdictionFillNotice", "data": {
                    "orderId": "pinned-source", "fillSeq": 1, "cumulativeFillRatio": 100
                }}]
            }}]
        });
        let valid = crate::RuntimeEntityInput::decode(wire.clone()).expect("Runtime output");
        routes
            .validate_inbound_runtime_outputs(&peer, std::slice::from_ref(&valid))
            .expect("pinned source authority");

        let mut uppercase_target = wire.clone();
        uppercase_target["entityTxs"][0]["data"]["targetEntityId"] =
            Value::String(format!("0x{}", "AB".repeat(32)));
        let error = crate::RuntimeEntityInput::decode(uppercase_target)
            .expect_err("noncanonical target is rejected at decode");
        assert!(error.to_string().contains("targetEntityId:CANONICAL"));
        let mut wrong_target = wire.clone();
        wrong_target["entityTxs"][0]["data"]["targetEntityId"] = Value::String(entity("cd"));
        let wrong_target =
            crate::RuntimeEntityInput::decode(wrong_target).expect("well-formed wrong target");
        assert!(matches!(
            routes.validate_inbound_runtime_outputs(&peer, &[wrong_target]),
            Err(EntityRouteError::InboundRuntimeOutputEnvelope(0)),
        ));

        for (field, value) in [
            ("sourceEntityId", entity("77")),
            ("sourceSignerId", runtime("88")),
        ] {
            let mut changed = wire.clone();
            changed["entityTxs"][0]["data"][field] = Value::String(value);
            let forged = crate::RuntimeEntityInput::decode(changed).expect("well-formed forgery");
            assert!(matches!(
                routes.validate_inbound_runtime_outputs(&peer, &[valid.clone(), forged]),
                Err(EntityRouteError::InboundRuntimeOutputSource { .. }),
            ));
        }
        let wrong_peer = runtime("99");
        let mut wrong_origin = wire;
        wrong_origin["from"] = Value::String(wrong_peer.clone());
        let forged =
            crate::RuntimeEntityInput::decode(wrong_origin).expect("authenticated other peer");
        assert!(matches!(
            routes.validate_inbound_runtime_outputs(&wrong_peer, &[forged]),
            Err(EntityRouteError::InboundRuntimeOutputSource { .. }),
        ));
        assert!(matches!(
            routes.validate_inbound_runtime_outputs(&wrong_peer, &[valid]),
            Err(EntityRouteError::InboundRuntimeOutputEnvelope(0)),
        ));
    }

    #[test]
    fn recovered_outbox_route_binds_until_operator_or_signed_profile_supersedes_it() {
        let peer = entity("33");
        let bound_runtime = |routes: &EntityRouteTable, target: &str| {
            let encoded = routes
                .bind_and_encode(
                    vec![json!({
                        "entityId": target,
                        "entityTxs": [{"type":"accountInput","data":{"kind":"ack"}}],
                    })],
                    7,
                    99,
                    &entity("44"),
                    "local",
                )
                .expect("bind");
            let decoded = crate::decode_storage_payload(&encoded.rows[0]).expect("decode");
            (
                decoded["runtimeId"].as_str().expect("runtime").to_owned(),
                decoded["signerId"].as_str().expect("signer").to_owned(),
            )
        };
        let mut routes = routes();
        assert!(matches!(
            routes.bind_and_encode(
                vec![json!({"entityId": peer, "entityTxs": []})],
                7,
                99,
                &entity("44"),
                "local",
            ),
            Err(EntityRouteError::Missing(_)),
        ));
        routes
            .with_recovered_output_route(&peer, &runtime("44"), "0xAA")
            .expect("recovered row");
        assert_eq!(
            bound_runtime(&routes, &peer),
            (runtime("44"), "0xaa".into())
        );
        // A later durable row for the same peer is the newer destination.
        routes
            .with_recovered_output_route(&peer, &runtime("55"), "0xbb")
            .expect("later recovered row");
        assert_eq!(
            bound_runtime(&routes, &peer),
            (runtime("55"), "0xbb".into())
        );
        // Recovered routes are dynamic: the peer is offline without a session.
        assert!(
            !routes
                .is_paybook_peer_online(&peer, &InboundSessionTable::default())
                .expect("recovered route liveness")
        );
        // An operator route is never displaced by an older durable row.
        routes
            .with_recovered_output_route(&entity("11"), &runtime("66"), "other")
            .expect("row for an operator-pinned peer");
        assert_eq!(
            bound_runtime(&routes, &entity("11")),
            (runtime("22"), "peer".into())
        );
        // The peer's next signed Profile supersedes and is never downgraded.
        let mut routes = routes
            .with_verified_profile(super::super::profile_route::VerifiedProfileRoute {
                entity_id: peer.clone(),
                runtime_id: runtime("77"),
                signer_id: "0xcc".into(),
                last_updated: 1,
                profile: serde_json::json!({"lastUpdated":1}),
            })
            .expect("signed profile");
        assert_eq!(
            bound_runtime(&routes, &peer),
            (runtime("77"), "0xcc".into())
        );
        routes
            .with_recovered_output_route(&peer, &runtime("55"), "0xbb")
            .expect("stale recovered row after a profile");
        assert_eq!(
            bound_runtime(&routes, &peer),
            (runtime("77"), "0xcc".into())
        );
        assert!(matches!(
            routes.with_recovered_output_route(&peer, &runtime("55"), " "),
            Err(EntityRouteError::SignerId(_)),
        ));
    }

    #[test]
    fn paybook_liveness_uses_current_authenticated_route_kind() {
        let operator_entity = entity("11");
        let dynamic_entity = entity("33");
        let routes = routes()
            .with_verified_profile(super::super::profile_route::VerifiedProfileRoute {
                entity_id: dynamic_entity.clone(),
                runtime_id: runtime("44"),
                signer_id: "dynamic-peer".into(),
                last_updated: 1,
                profile: serde_json::json!({"lastUpdated":1}),
            })
            .expect("dynamic route");
        let sessions = InboundSessionTable::default();
        assert!(
            routes
                .is_paybook_peer_online(&operator_entity, &sessions)
                .expect("operator route")
        );
        assert!(
            !routes
                .is_paybook_peer_online(&dynamic_entity, &sessions)
                .expect("closed dynamic route")
        );
        assert!(
            !routes
                .is_paybook_peer_online(&entity("55"), &sessions)
                .expect("missing route")
        );
    }

    #[test]
    fn output_is_bound_once_without_reordering_payload() {
        let encoded = routes()
            .bind_and_encode(
                vec![json!({
                    "entityId": entity("11"),
                    "entityTxs": [{"type":"accountInput","data":{"kind":"ack"}}],
                })],
                7,
                99,
                &entity("44"),
                "local",
            )
            .expect("bind");
        let decoded = crate::decode_storage_payload(&encoded.rows[0]).expect("decode");
        assert_eq!(decoded["entityId"], entity("11"));
        assert_eq!(decoded["runtimeId"], runtime("22"));
        assert_eq!(decoded["signerId"], "peer");
        assert_eq!(decoded["sourceRuntimeFrame"]["height"], 7);
        assert_eq!(decoded["sourceRuntimeFrame"]["timestamp"], 99);
        assert_eq!(decoded["entityTxs"][0]["type"], "accountInput");
    }

    #[test]
    fn canonical_target_signer_is_preserved_in_existing_wire_field() {
        let encoded = routes()
            .bind_and_encode(
                vec![json!({
                    "entityId": entity("11"),
                    "signerId": "peer",
                    "entityTxs": [{"type":"accountInput","data":{"kind":"ack"}}],
                })],
                7,
                99,
                &entity("44"),
                "local",
            )
            .expect("bind exact signer");
        let decoded = crate::decode_storage_payload(&encoded.rows[0]).expect("decode");
        assert_eq!(decoded["signerId"], "peer");
    }

    #[test]
    fn missing_route_and_wrong_target_signer_fail_loud() {
        assert!(matches!(
            routes().bind_and_encode(
                vec![json!({"entityId":entity("33"),"entityTxs":[]})],
                1,
                1,
                &entity("44"),
                "local",
            ),
            Err(EntityRouteError::Missing(_)),
        ));
        assert!(matches!(
            routes().bind_and_encode(
                vec![json!({
                    "entityId":entity("11"),
                    "entityTxs":[],
                    "signerId":"already-bound",
                })],
                1,
                1,
                &entity("44"),
                "local",
            ),
            Err(EntityRouteError::TargetSignerMismatch { .. }),
        ));
    }

    #[test]
    fn local_trigger_is_requeued_but_never_enters_the_durable_outbox() {
        let local_entity = entity("44");
        let encoded = EntityRouteTable::new([])
            .expect("routes")
            .bind_and_encode(
                vec![json!({"entityId":local_entity,"entityTxs":[]})],
                3,
                77,
                &entity("44"),
                "local-signer",
            )
            .expect("local trigger");
        assert_eq!(encoded.local_continuations.len(), 1);
        assert!(encoded.rows.is_empty());
        assert_eq!(
            encoded.local_continuations[0].canonical()["signerId"],
            "local-signer",
        );
    }

    #[test]
    fn duplicate_local_triggers_coalesce_into_one_runtime_continuation() {
        let local_entity = entity("44");
        let trigger = json!({"entityId":local_entity,"entityTxs":[]});
        let encoded = EntityRouteTable::new([])
            .expect("routes")
            .bind_and_encode(
                vec![trigger.clone(), trigger],
                3,
                77,
                &entity("44"),
                "local-signer",
            )
            .expect("local triggers");
        assert_eq!(encoded.local_continuations.len(), 1);
        assert!(encoded.rows.is_empty());
    }

    #[test]
    fn cross_j_r4_h30_local_continuations_keep_each_owner_in_first_output_order() {
        let trigger = |entity_id: String, signer_id: &str| {
            BoundEntityOutput::Local(Box::new(
                crate::RuntimeEntityInput::decode(json!({
                    "entityId": entity_id, "signerId": signer_id, "entityTxs": [],
                }))
                .expect("local wake"),
            ))
        };
        let first = entity("f9");
        let second = entity("ea");
        let encoded = EntityRouteTable::collect_bound(vec![
            trigger(first.clone(), "first-signer"),
            trigger(second.clone(), "second-signer"),
            trigger(first.clone(), "first-signer"),
            trigger(first.clone(), "another-signer"),
            trigger(second.clone(), "second-signer"),
        ]);
        let owners = encoded
            .local_continuations
            .iter()
            .map(|input| (input.canonical()["entityId"].clone(), input.signer_id()))
            .collect::<Vec<_>>();
        assert_eq!(
            owners,
            vec![
                (json!(first), "first-signer"),
                (json!(second), "second-signer"),
                (json!(first), "another-signer"),
            ],
        );
        assert!(encoded.rows.is_empty());
        assert!(encoded.resident_rows.is_empty());
    }

    #[test]
    fn authenticated_local_runtime_output_must_be_consumed_by_runtime_machine() {
        let local = entity("44");
        let input = json!({
            "entityId": local,
            "entityTxs": [{
                "type": "runtimeOutput",
                "data": {
                    "protocol": "cross-j",
                    "sourceEntityId": local,
                    "sourceSignerId": "local-signer",
                    "targetEntityId": local,
                    "entityTxs": [{
                        "type": "registerCrossJurisdictionSwap",
                        "data": {"route": {"orderId": "order-1"}}
                    }]
                }
            }]
        });
        let error = match EntityRouteTable::new([]).expect("routes").bind_and_encode(
            vec![input],
            3,
            77,
            &local,
            "local-signer",
        ) {
            Ok(_) => panic!("machine must consume local cross-J before projection"),
            Err(error) => error,
        };
        assert!(matches!(
            error,
            EntityRouteError::LocalCrossJEscapedMachine(0)
        ));
    }

    #[test]
    fn many_entities_may_share_one_runtime_but_not_conflicting_urls() {
        let shared_runtime = runtime("22");
        let shared = EntityRouteTable::new([
            EntityRoute {
                target_entity_id: entity("11"),
                target_runtime_id: shared_runtime.clone(),
                target_signer_id: "one".into(),
                websocket_url: Some("ws://127.0.0.1:9000/ws".into()),
            },
            EntityRoute {
                target_entity_id: entity("33"),
                target_runtime_id: shared_runtime.clone(),
                target_signer_id: "two".into(),
                websocket_url: Some("ws://127.0.0.1:9000/ws".into()),
            },
        ]);
        assert!(shared.is_ok());

        let conflict = EntityRouteTable::new([
            EntityRoute {
                target_entity_id: entity("11"),
                target_runtime_id: shared_runtime.clone(),
                target_signer_id: "one".into(),
                websocket_url: Some("ws://127.0.0.1:9000/ws".into()),
            },
            EntityRoute {
                target_entity_id: entity("33"),
                target_runtime_id: shared_runtime,
                target_signer_id: "two".into(),
                websocket_url: Some("ws://127.0.0.1:9001/ws".into()),
            },
        ]);
        assert!(matches!(
            conflict,
            Err(EntityRouteError::RuntimeConflict(_))
        ));
    }

    #[test]
    fn inbound_only_route_binds_entity_without_a_direct_url() {
        let table = EntityRouteTable::new([EntityRoute {
            target_entity_id: entity("11"),
            target_runtime_id: runtime("22"),
            target_signer_id: "peer".into(),
            websocket_url: None,
        }])
        .expect("inbound-only");
        let encoded = table
            .bind_and_encode(
                vec![json!({
                    "entityId": entity("11"),
                    "entityTxs": [{"type":"accountInput","data":{"kind":"ack"}}],
                })],
                7,
                99,
                &entity("44"),
                "local",
            )
            .expect("bind");
        let decoded = crate::decode_storage_payload(&encoded.rows[0]).expect("decode");
        assert_eq!(decoded["runtimeId"], runtime("22"));
        assert!(!table.direct_routes().contains(&runtime("22")));
    }
}

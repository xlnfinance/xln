use std::collections::BTreeMap;

use serde_json::{Map, Number, Value};
use thiserror::Error;

use crate::transport::{DirectRoute, DirectRouteTable, RuntimeTransportError};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const ENTITY_ID_BYTES: usize = 32;
const RUNTIME_ID_BYTES: usize = 20;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityRoute {
    pub target_entity_id: String,
    pub target_runtime_id: String,
    pub target_signer_id: String,
    pub websocket_url: String,
}

#[derive(Clone, Debug)]
struct BoundEntityRoute {
    runtime_id: String,
    signer_id: String,
}

pub(crate) struct BoundEntityOutputs {
    pub rows: Vec<Vec<u8>>,
    pub local_continuations: Vec<crate::RuntimeEntityInput>,
}

/// Deterministic Entity-to-Runtime routing installed outside consensus.
///
/// Entity certification names only the destination Entity. Runtime binds that
/// immutable output to one explicit validator/runtime route before the output
/// enters the same fsynced batch as its Runtime frame. Missing routes are a
/// hard error; guessing from local replicas or gossip would make replay depend
/// on whichever process happened to answer first.
#[derive(Clone, Debug)]
pub struct EntityRouteTable {
    by_entity: BTreeMap<String, BoundEntityRoute>,
    direct_routes: DirectRouteTable,
}

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
    #[error("RRS_ENTITY_OUTPUT_EMPTY:{0}")]
    Empty(usize),
    #[error("RRS_ENTITY_OUTPUT_SAFE_INTEGER:{field}:{value}")]
    SafeInteger { field: &'static str, value: u64 },
    #[error("RRS_ENTITY_OUTPUT_LOCAL_PAYLOAD:{0}")]
    LocalPayload(usize),
    #[error("RRS_ENTITY_OUTPUT_LOCAL_INPUT:{0}")]
    LocalInput(String),
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
                    },
                )
                .is_some()
            {
                return Err(EntityRouteError::Duplicate(entity_id));
            }
            if let Some(existing) = direct.get(&runtime_id) {
                if existing != &route.websocket_url {
                    return Err(EntityRouteError::RuntimeConflict(runtime_id));
                }
            } else {
                direct.insert(runtime_id, route.websocket_url);
            }
        }
        let direct = direct
            .into_iter()
            .map(|(target_runtime_id, url)| DirectRoute {
                target_runtime_id,
                url,
            });
        Ok(Self {
            by_entity,
            direct_routes: DirectRouteTable::new(direct)?,
        })
    }

    pub fn direct_routes(&self) -> DirectRouteTable {
        self.direct_routes.clone()
    }

    pub(crate) fn bind_and_encode(
        &self,
        outputs: Vec<Value>,
        source_height: u64,
        source_timestamp: u64,
        local_entity_id: &str,
        local_signer_id: &str,
    ) -> Result<BoundEntityOutputs, EntityRouteError> {
        let height = safe_number("height", source_height)?;
        let timestamp = safe_number("timestamp", source_timestamp)?;
        let local_entity_id = normalized_entity_id(local_entity_id)?;
        if local_signer_id.trim().is_empty() {
            return Err(EntityRouteError::SignerId(local_entity_id));
        }
        let mut rows = Vec::with_capacity(outputs.len());
        let mut local_continuations = Vec::new();
        for (index, output) in outputs.into_iter().enumerate() {
            let mut object = output
                .as_object()
                .cloned()
                .ok_or(EntityRouteError::OutputObject(index))?;
            validate_local_output(&object, index)?;
            let raw_entity = object.get("entityId").and_then(Value::as_str).ok_or(
                EntityRouteError::OutputField {
                    index,
                    field: "entityId",
                },
            )?;
            let entity_id = normalized_entity_id(raw_entity)?;
            object.insert("entityId".into(), Value::String(entity_id.clone()));
            if entity_id == local_entity_id {
                if !is_trigger_only(&object) {
                    return Err(EntityRouteError::LocalPayload(index));
                }
                // TypeScript output routing merges identical trigger-only
                // self-wakes by Entity+signer before they enter the Runtime
                // FIFO. Ten local financial txs therefore schedule one next
                // Entity visit, not ten empty Runtime inputs.
                if !local_continuations.is_empty() {
                    continue;
                }
                object.insert(
                    "signerId".into(),
                    Value::String(local_signer_id.to_ascii_lowercase()),
                );
                local_continuations.push(
                    crate::RuntimeEntityInput::decode(Value::Object(object))
                        .map_err(|error| EntityRouteError::LocalInput(error.to_string()))?,
                );
                continue;
            } else {
                let route = self
                    .by_entity
                    .get(&entity_id)
                    .ok_or_else(|| EntityRouteError::Missing(entity_id.clone()))?;
                object.insert("signerId".into(), Value::String(route.signer_id.clone()));
                object.insert("runtimeId".into(), Value::String(route.runtime_id.clone()));
            }
            object.insert(
                "sourceRuntimeFrame".into(),
                Value::Object(Map::from_iter([
                    ("height".into(), height.clone()),
                    ("timestamp".into(), timestamp.clone()),
                ])),
            );
            rows.push(
                crate::transport::msgpack::encode_framed(&Value::Object(object))
                    .map_err(EntityRouteError::from)?,
            );
        }
        Ok(BoundEntityOutputs {
            rows,
            local_continuations,
        })
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

fn validate_local_output(
    object: &Map<String, Value>,
    index: usize,
) -> Result<(), EntityRouteError> {
    for field in [
        "signerId",
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
            websocket_url: "ws://127.0.0.1:9000/ws".into(),
        }])
        .expect("routes")
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
    fn missing_route_and_prebound_output_fail_loud() {
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
            Err(EntityRouteError::AlreadyRouted {
                field: "signerId",
                ..
            }),
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
    fn many_entities_may_share_one_runtime_but_not_conflicting_urls() {
        let shared_runtime = runtime("22");
        let shared = EntityRouteTable::new([
            EntityRoute {
                target_entity_id: entity("11"),
                target_runtime_id: shared_runtime.clone(),
                target_signer_id: "one".into(),
                websocket_url: "ws://127.0.0.1:9000/ws".into(),
            },
            EntityRoute {
                target_entity_id: entity("33"),
                target_runtime_id: shared_runtime.clone(),
                target_signer_id: "two".into(),
                websocket_url: "ws://127.0.0.1:9000/ws".into(),
            },
        ]);
        assert!(shared.is_ok());

        let conflict = EntityRouteTable::new([
            EntityRoute {
                target_entity_id: entity("11"),
                target_runtime_id: shared_runtime.clone(),
                target_signer_id: "one".into(),
                websocket_url: "ws://127.0.0.1:9000/ws".into(),
            },
            EntityRoute {
                target_entity_id: entity("33"),
                target_runtime_id: shared_runtime,
                target_signer_id: "two".into(),
                websocket_url: "ws://127.0.0.1:9001/ws".into(),
            },
        ]);
        assert!(matches!(
            conflict,
            Err(EntityRouteError::RuntimeConflict(_))
        ));
    }
}

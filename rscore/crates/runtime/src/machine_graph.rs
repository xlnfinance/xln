//! Rebuild and verify the canonical Runtime-machine Patricia graph.

use serde_json::{Map, Value};
use sha2::{Digest as _, Sha256};
use thiserror::Error;
use xln_rscore_protocol::PersistentRadixMap;

use crate::decode_storage_payload;

#[derive(Debug, Error)]
pub enum RuntimeMachineGraphError {
    #[error("RUNTIME_MACHINE_GRAPH_PATH:{0}")]
    Path(String),
    #[error("RUNTIME_MACHINE_GRAPH_VALUE:{0}")]
    Value(String),
    #[error("RUNTIME_MACHINE_GRAPH_DUPLICATE_PATH")]
    DuplicatePath,
    #[error("RUNTIME_MACHINE_GRAPH_ROOT_ENTRY")]
    RootEntry,
    #[error("RUNTIME_MACHINE_GRAPH_CHILD:{0}")]
    Child(String),
    #[error("RUNTIME_MACHINE_GRAPH_LEAF_COUNT:expected={expected}:actual={actual}")]
    LeafCount { expected: usize, actual: usize },
    #[error("RUNTIME_MACHINE_GRAPH_ROOT:expected={expected}:actual={actual}")]
    Root { expected: String, actual: String },
    #[error("RUNTIME_MACHINE_GRAPH_RADIX:{0}")]
    Radix(String),
    #[error(transparent)]
    MessagePack(#[from] crate::StorageMessagePackError),
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Segment {
    Property(String),
    Array(usize),
    Map { index: usize, key: Value },
    Set(usize),
}

#[derive(Clone)]
enum GraphValue {
    Atom(Value),
    Container(String),
}

struct Entry {
    path: Vec<Segment>,
    value: GraphValue,
}

fn object<'a>(
    value: &'a Value,
    path: &str,
) -> Result<&'a Map<String, Value>, RuntimeMachineGraphError> {
    value
        .as_object()
        .ok_or_else(|| RuntimeMachineGraphError::Value(path.into()))
}

fn exact_keys(
    object: &Map<String, Value>,
    expected: &[&str],
    path: &str,
) -> Result<(), RuntimeMachineGraphError> {
    let mut actual = object.keys().map(String::as_str).collect::<Vec<_>>();
    actual.sort_unstable();
    let mut expected = expected.to_vec();
    expected.sort_unstable();
    if actual == expected {
        Ok(())
    } else {
        Err(RuntimeMachineGraphError::Value(format!("{path}:FIELDS")))
    }
}

fn index(value: &Value, path: &str) -> Result<usize, RuntimeMachineGraphError> {
    value
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| RuntimeMachineGraphError::Path(path.into()))
}

fn segment(value: &Value, path: &str) -> Result<Segment, RuntimeMachineGraphError> {
    let source = object(value, path)?;
    match source.get("kind").and_then(Value::as_str) {
        Some("property") => {
            exact_keys(source, &["kind", "name"], path)?;
            let name = source
                .get("name")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| RuntimeMachineGraphError::Path(path.into()))?;
            Ok(Segment::Property(name.into()))
        }
        Some("array") => {
            exact_keys(source, &["kind", "index"], path)?;
            Ok(Segment::Array(index(&source["index"], path)?))
        }
        Some("map") => {
            exact_keys(source, &["kind", "index", "key"], path)?;
            Ok(Segment::Map {
                index: index(&source["index"], path)?,
                key: source["key"].clone(),
            })
        }
        Some("set") => {
            exact_keys(source, &["kind", "index"], path)?;
            Ok(Segment::Set(index(&source["index"], path)?))
        }
        _ => Err(RuntimeMachineGraphError::Path(path.into())),
    }
}

fn graph_path(value: &Value) -> Result<Vec<Segment>, RuntimeMachineGraphError> {
    value
        .as_array()
        .ok_or_else(|| RuntimeMachineGraphError::Path("ARRAY".into()))?
        .iter()
        .enumerate()
        .map(|(index, value)| segment(value, &format!("SEGMENT:{index}")))
        .collect()
}

fn graph_value(value: &Value) -> Result<GraphValue, RuntimeMachineGraphError> {
    let source = object(value, "VALUE")?;
    match source.get("kind").and_then(Value::as_str) {
        Some("atom") => {
            exact_keys(source, &["kind", "value"], "VALUE")?;
            Ok(GraphValue::Atom(source["value"].clone()))
        }
        Some("container") => {
            exact_keys(source, &["kind", "container"], "VALUE")?;
            let container = source
                .get("container")
                .and_then(Value::as_str)
                .filter(|value| matches!(*value, "object" | "array" | "map" | "set"))
                .ok_or_else(|| RuntimeMachineGraphError::Value("CONTAINER".into()))?;
            Ok(GraphValue::Container(container.into()))
        }
        _ => Err(RuntimeMachineGraphError::Value("KIND".into())),
    }
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2 + 2);
    output.push_str("0x");
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

fn children<'a>(entries: &'a [Entry], path: &[Segment]) -> Vec<&'a Entry> {
    entries
        .iter()
        .filter(|entry| entry.path.len() == path.len() + 1 && entry.path.starts_with(path))
        .collect()
}

fn indexed_child<'a>(
    child: &'a Entry,
    expected: usize,
    kind: &str,
) -> Result<&'a Entry, RuntimeMachineGraphError> {
    let actual = match child.path.last() {
        Some(Segment::Array(index)) if kind == "array" => *index,
        Some(Segment::Map { index, .. }) if kind == "map" => *index,
        Some(Segment::Set(index)) if kind == "set" => *index,
        _ => return Err(RuntimeMachineGraphError::Child(kind.into())),
    };
    if actual != expected {
        return Err(RuntimeMachineGraphError::Child(format!(
            "{kind}:expected={expected}:actual={actual}"
        )));
    }
    Ok(child)
}

fn build(entries: &[Entry], path: &[Segment]) -> Result<Value, RuntimeMachineGraphError> {
    let entry = entries
        .iter()
        .find(|entry| entry.path == path)
        .ok_or(RuntimeMachineGraphError::RootEntry)?;
    let mut children = children(entries, path);
    match &entry.value {
        GraphValue::Atom(value) => {
            if children.is_empty() {
                Ok(value.clone())
            } else {
                Err(RuntimeMachineGraphError::Child("ATOM".into()))
            }
        }
        GraphValue::Container(kind) if kind == "object" => {
            children.sort_by(|left, right| match (left.path.last(), right.path.last()) {
                (Some(Segment::Property(left)), Some(Segment::Property(right))) => left.cmp(right),
                _ => std::cmp::Ordering::Equal,
            });
            let mut output = Map::new();
            for child in children {
                let Some(Segment::Property(name)) = child.path.last() else {
                    return Err(RuntimeMachineGraphError::Child("OBJECT".into()));
                };
                if output
                    .insert(name.clone(), build(entries, &child.path)?)
                    .is_some()
                {
                    return Err(RuntimeMachineGraphError::Child("OBJECT_DUPLICATE".into()));
                }
            }
            Ok(Value::Object(output))
        }
        GraphValue::Container(kind) if kind == "array" => {
            children.sort_by_key(|child| match child.path.last() {
                Some(Segment::Array(index)) => *index,
                _ => usize::MAX,
            });
            children
                .iter()
                .enumerate()
                .map(|(index, child)| build(entries, &indexed_child(child, index, "array")?.path))
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array)
        }
        GraphValue::Container(kind) if kind == "map" => {
            children.sort_by_key(|child| match child.path.last() {
                Some(Segment::Map { index, .. }) => *index,
                _ => usize::MAX,
            });
            let rows = children
                .iter()
                .enumerate()
                .map(|(index, child)| {
                    let child = indexed_child(child, index, "map")?;
                    let Some(Segment::Map { key, .. }) = child.path.last() else {
                        return Err(RuntimeMachineGraphError::Child("MAP".into()));
                    };
                    Ok(Value::Array(vec![
                        key.clone(),
                        build(entries, &child.path)?,
                    ]))
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(tagged("Map", rows))
        }
        GraphValue::Container(kind) if kind == "set" => {
            children.sort_by_key(|child| match child.path.last() {
                Some(Segment::Set(index)) => *index,
                _ => usize::MAX,
            });
            let values = children
                .iter()
                .enumerate()
                .map(|(index, child)| build(entries, &indexed_child(child, index, "set")?.path))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(tagged("Set", values))
        }
        GraphValue::Container(kind) => Err(RuntimeMachineGraphError::Value(kind.clone())),
    }
}

fn tagged(kind: &str, values: Vec<Value>) -> Value {
    Value::Object(Map::from_iter([
        ("__xlnType".into(), Value::String(kind.into())),
        ("value".into(), Value::Array(values)),
    ]))
}

pub fn rebuild_runtime_machine_graph(
    rows: Vec<(Vec<u8>, Vec<u8>)>,
    expected_root: &str,
    expected_leaf_count: usize,
) -> Result<Value, RuntimeMachineGraphError> {
    if rows.len() != expected_leaf_count {
        return Err(RuntimeMachineGraphError::LeafCount {
            expected: expected_leaf_count,
            actual: rows.len(),
        });
    }
    let mut radix = PersistentRadixMap::empty();
    let mut entries = Vec::with_capacity(rows.len());
    for (key, encoded_value) in rows {
        let path = graph_path(&decode_storage_payload(&key)?)?;
        let decoded_value = decode_storage_payload(&encoded_value)?;
        let value = graph_value(&decoded_value)?;
        if entries.iter().any(|entry: &Entry| entry.path == path) {
            return Err(RuntimeMachineGraphError::DuplicatePath);
        }
        let digest = Sha256::digest(&encoded_value).into();
        radix = radix
            .updated(key, decoded_value, digest)
            .map_err(|error| RuntimeMachineGraphError::Radix(error.to_string()))?;
        entries.push(Entry { path, value });
    }
    let actual = hex(&radix.root_hash());
    if actual != expected_root {
        return Err(RuntimeMachineGraphError::Root {
            expected: expected_root.into(),
            actual,
        });
    }
    build(&entries, &[])
}

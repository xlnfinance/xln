//! Exact path-keyed Runtime-machine graph projection.

use serde_json::{Map, Value};
use sha2::{Digest as _, Sha256};
use thiserror::Error;
use xln_rscore_protocol::{PersistentNodeRecord, PersistentRadixMap};

const MAX_DEPTH: usize = 64;
const MAX_ROW_BYTES: usize = 10_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RuntimeMachineLeaf {
    /// Exact 0x03/msgpack path payload. Storage prefixes it with 0x16+height.
    pub path_bytes: Vec<u8>,
    /// Exact 0x03/msgpack `{kind, value|container}` payload.
    pub value_bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PreparedRuntimeMachineGraph {
    pub root_hash: [u8; 32],
    pub leaf_count: u64,
    pub leaves: Vec<RuntimeMachineLeaf>,
}

pub(crate) fn prepare_runtime_machine_graph(
    machine: &Value,
) -> Result<PreparedRuntimeMachineGraph, RuntimeMachineProjectionError> {
    let mut entries = Vec::new();
    append_entries(&mut entries, machine, &[])?;
    let mut graph = PersistentRadixMap::empty();
    for (path, value) in &entries {
        let path_bytes = encode(path)?;
        let value_bytes = encode(value)?;
        if path_bytes.len() >= MAX_ROW_BYTES || value_bytes.len() >= MAX_ROW_BYTES {
            return Err(RuntimeMachineProjectionError::RowBytes {
                key: path_bytes.len(),
                value: value_bytes.len(),
            });
        }
        graph = graph.updated(
            path_bytes,
            value.clone(),
            Sha256::digest(value_bytes).into(),
        )?;
    }
    let root_hash = graph.root_hash();
    let leaves = graph
        .node_records()
        .into_iter()
        .filter_map(|record| match record {
            PersistentNodeRecord::Leaf { key, value, .. } => Some((key, value)),
            PersistentNodeRecord::Branch { .. } => None,
        })
        .map(|(path_bytes, value)| {
            Ok(RuntimeMachineLeaf {
                path_bytes,
                value_bytes: encode(&value)?,
            })
        })
        .collect::<Result<Vec<_>, RuntimeMachineProjectionError>>()?;
    let leaf_count = u64::try_from(leaves.len())
        .map_err(|_| RuntimeMachineProjectionError::LeafCount(leaves.len()))?;
    if leaf_count != u64::try_from(entries.len()).unwrap_or(u64::MAX) {
        return Err(RuntimeMachineProjectionError::DuplicatePath);
    }
    Ok(PreparedRuntimeMachineGraph {
        root_hash,
        leaf_count,
        leaves,
    })
}

fn append_entries(
    output: &mut Vec<(Value, Value)>,
    value: &Value,
    path: &[Value],
) -> Result<(), RuntimeMachineProjectionError> {
    if path.len() > MAX_DEPTH {
        return Err(RuntimeMachineProjectionError::Depth(path.len()));
    }
    match value {
        Value::Array(values) => {
            output.push((path_value(path), container("array")));
            for (index, child) in values.iter().enumerate() {
                let index = u64::try_from(index)
                    .map_err(|_| RuntimeMachineProjectionError::Index(index))?;
                append_entries(output, child, &child_path(path, array_segment(index)))?;
            }
        }
        Value::Object(object) => match object.get("__xlnType").and_then(Value::as_str) {
            Some("Map") => append_map(output, object, path)?,
            Some("Set") => append_set(output, object, path)?,
            Some("BigInt" | "TypedArray") => {
                validate_tagged_atom(value)?;
                output.push((path_value(path), atom(value.clone())));
            }
            Some(other) => return Err(RuntimeMachineProjectionError::Tag(other.into())),
            None => {
                output.push((path_value(path), container("object")));
                let mut fields = object.iter().collect::<Vec<_>>();
                fields.sort_by(|left, right| left.0.encode_utf16().cmp(right.0.encode_utf16()));
                for (name, child) in fields {
                    append_entries(output, child, &child_path(path, property_segment(name)))?;
                }
            }
        },
        _ => output.push((path_value(path), atom(value.clone()))),
    }
    Ok(())
}

fn append_map(
    output: &mut Vec<(Value, Value)>,
    object: &Map<String, Value>,
    path: &[Value],
) -> Result<(), RuntimeMachineProjectionError> {
    exact_tag_fields(object, &["__xlnType", "value"])?;
    let rows = object
        .get("value")
        .and_then(Value::as_array)
        .ok_or(RuntimeMachineProjectionError::Map)?;
    output.push((path_value(path), container("map")));
    for (index, row) in rows.iter().enumerate() {
        let pair = row
            .as_array()
            .filter(|pair| pair.len() == 2)
            .ok_or(RuntimeMachineProjectionError::Map)?;
        crate::canonical_value_from_tagged_json(&pair[0])?;
        let index =
            u64::try_from(index).map_err(|_| RuntimeMachineProjectionError::Index(index))?;
        append_entries(
            output,
            &pair[1],
            &child_path(path, map_segment(index, pair[0].clone())),
        )?;
    }
    Ok(())
}

fn append_set(
    output: &mut Vec<(Value, Value)>,
    object: &Map<String, Value>,
    path: &[Value],
) -> Result<(), RuntimeMachineProjectionError> {
    exact_tag_fields(object, &["__xlnType", "value"])?;
    let values = object
        .get("value")
        .and_then(Value::as_array)
        .ok_or(RuntimeMachineProjectionError::Set)?;
    output.push((path_value(path), container("set")));
    for (index, child) in values.iter().enumerate() {
        let index =
            u64::try_from(index).map_err(|_| RuntimeMachineProjectionError::Index(index))?;
        append_entries(output, child, &child_path(path, set_segment(index)))?;
    }
    Ok(())
}

fn validate_tagged_atom(value: &Value) -> Result<(), RuntimeMachineProjectionError> {
    crate::transport::msgpack::encode_framed(value)
        .map(|_| ())
        .map_err(RuntimeMachineProjectionError::Transport)
}

fn exact_tag_fields(
    object: &Map<String, Value>,
    expected: &[&str],
) -> Result<(), RuntimeMachineProjectionError> {
    if object.len() == expected.len()
        && object
            .keys()
            .all(|field| expected.contains(&field.as_str()))
    {
        Ok(())
    } else {
        Err(RuntimeMachineProjectionError::TagFields)
    }
}

fn path_value(path: &[Value]) -> Value {
    Value::Array(path.to_vec())
}

fn child_path(path: &[Value], segment: Value) -> Vec<Value> {
    let mut child = Vec::with_capacity(path.len() + 1);
    child.extend_from_slice(path);
    child.push(segment);
    child
}

fn property_segment(name: &str) -> Value {
    object([
        ("kind", Value::String("property".into())),
        ("name", Value::String(name.into())),
    ])
}

fn array_segment(index: u64) -> Value {
    object([
        ("kind", Value::String("array".into())),
        ("index", Value::from(index)),
    ])
}

fn map_segment(index: u64, key: Value) -> Value {
    object([
        ("kind", Value::String("map".into())),
        ("index", Value::from(index)),
        ("key", key),
    ])
}

fn set_segment(index: u64) -> Value {
    object([
        ("kind", Value::String("set".into())),
        ("index", Value::from(index)),
    ])
}

fn atom(value: Value) -> Value {
    object([("kind", Value::String("atom".into())), ("value", value)])
}

fn container(kind: &str) -> Value {
    object([
        ("kind", Value::String("container".into())),
        ("container", Value::String(kind.into())),
    ])
}

fn object<const N: usize>(entries: [(&str, Value); N]) -> Value {
    Value::Object(Map::from_iter(
        entries
            .into_iter()
            .map(|(field, value)| (field.to_string(), value)),
    ))
}

fn encode(value: &Value) -> Result<Vec<u8>, RuntimeMachineProjectionError> {
    crate::transport::msgpack::encode_framed(value)
        .map_err(RuntimeMachineProjectionError::Transport)
}

#[derive(Debug, Error)]
pub(crate) enum RuntimeMachineProjectionError {
    #[error("RRS_RUNTIME_MACHINE_GRAPH_DEPTH:{0}")]
    Depth(usize),
    #[error("RRS_RUNTIME_MACHINE_GRAPH_INDEX:{0}")]
    Index(usize),
    #[error("RRS_RUNTIME_MACHINE_GRAPH_TAG:{0}")]
    Tag(String),
    #[error("RRS_RUNTIME_MACHINE_GRAPH_TAG_FIELDS")]
    TagFields,
    #[error("RRS_RUNTIME_MACHINE_GRAPH_MAP")]
    Map,
    #[error("RRS_RUNTIME_MACHINE_GRAPH_SET")]
    Set,
    #[error("RRS_RUNTIME_MACHINE_GRAPH_ROW_BYTES:key={key}:value={value}")]
    RowBytes { key: usize, value: usize },
    #[error("RRS_RUNTIME_MACHINE_GRAPH_LEAF_COUNT:{0}")]
    LeafCount(usize),
    #[error("RRS_RUNTIME_MACHINE_GRAPH_DUPLICATE_PATH")]
    DuplicatePath,
    #[error(transparent)]
    Tagged(#[from] crate::TaggedJsonError),
    #[error(transparent)]
    Transport(#[from] crate::transport::RuntimeTransportError),
    #[error(transparent)]
    Radix(#[from] xln_rscore_protocol::PersistentRadixMapError),
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn path_keyed_graph_round_trips_through_the_restore_oracle() {
        let machine = json!({
            "runtimeId":"0x1111111111111111111111111111111111111111",
            "rows":{"__xlnType":"Map","value":[["a",{"__xlnType":"BigInt","value":"1"}]]}
        });
        let graph = prepare_runtime_machine_graph(&machine).expect("graph");
        let restored = crate::rebuild_runtime_machine_graph(
            graph
                .leaves
                .iter()
                .map(|leaf| (leaf.path_bytes.clone(), leaf.value_bytes.clone()))
                .collect(),
            &format!("0x{}", hex(&graph.root_hash)),
            usize::try_from(graph.leaf_count).expect("leaf count"),
        )
        .expect("verified graph");
        assert_eq!(restored, machine);
    }
}

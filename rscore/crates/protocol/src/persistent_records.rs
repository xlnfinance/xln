use std::sync::Arc;

use crate::persistent::{
    PersistentChildRecord, PersistentNodeChanges, PersistentNodeRecord, PersistentNodeRef,
    PersistentRadixMap,
};
use crate::persistent_node::{Node, NodeRef, edge_hash, node_hash, node_kind, node_path};

fn record<V: Clone>(node: &NodeRef<V>) -> PersistentNodeRecord<V> {
    match &**node {
        Node::Leaf {
            key, path, value, ..
        } => PersistentNodeRecord::Leaf {
            path: path.clone(),
            key: key.clone(),
            value: value.clone(),
        },
        Node::Branch { path, children, .. } => PersistentNodeRecord::Branch {
            path: path.clone(),
            children: children
                .iter()
                .enumerate()
                .filter_map(|(slot, child)| {
                    child.as_ref().map(|child| PersistentChildRecord {
                        slot: slot as u8,
                        kind: node_kind(child),
                        path: node_path(child).to_vec(),
                        edge_hash: edge_hash(path, child),
                    })
                })
                .collect(),
        },
    }
}

fn node_at_path<'a, V>(
    root: Option<&'a NodeRef<V>>,
    kind: &str,
    path: &[u8],
) -> Option<&'a NodeRef<V>> {
    let mut node = root;
    while let Some(current) = node {
        if node_kind(current) == kind && node_path(current) == path {
            return Some(current);
        }
        let Node::Branch {
            path: parent,
            children,
            ..
        } = &**current
        else {
            return None;
        };
        if !path.starts_with(parent) {
            return None;
        }
        node = path
            .get(parent.len())
            .and_then(|slot| children[*slot as usize].as_ref());
    }
    None
}

fn collect_records<V: Clone>(node: Option<&NodeRef<V>>, output: &mut Vec<PersistentNodeRecord<V>>) {
    let Some(node) = node else { return };
    output.push(record(node));
    if let Node::Branch { children, .. } = &**node {
        for child in children.iter().flatten() {
            collect_records(Some(child), output);
        }
    }
}

fn collect_puts<V: Clone>(
    node: Option<&NodeRef<V>>,
    previous: Option<&NodeRef<V>>,
    output: &mut Vec<PersistentNodeRecord<V>>,
) {
    let Some(node) = node else { return };
    let prior = node_at_path(previous, node_kind(node), node_path(node));
    if prior.is_some_and(|prior| Arc::ptr_eq(prior, node) || node_hash(prior) == node_hash(node)) {
        return;
    }
    output.push(record(node));
    if let Node::Branch { children, .. } = &**node {
        for child in children.iter().flatten() {
            collect_puts(Some(child), previous, output);
        }
    }
}

fn collect_dels<V>(
    node: Option<&NodeRef<V>>,
    next: Option<&NodeRef<V>>,
    output: &mut Vec<PersistentNodeRef>,
) {
    let Some(node) = node else { return };
    let replacement = node_at_path(next, node_kind(node), node_path(node));
    if replacement.is_some_and(|next| Arc::ptr_eq(next, node) || node_hash(next) == node_hash(node))
    {
        return;
    }
    if replacement.is_none() {
        output.push(match &**node {
            Node::Branch { path, .. } => PersistentNodeRef::Branch { path: path.clone() },
            Node::Leaf { path, key, .. } => PersistentNodeRef::Leaf {
                path: path.clone(),
                key: key.clone(),
            },
        });
    }
    if let Node::Branch { children, .. } = &**node {
        for child in children.iter().flatten() {
            collect_dels(Some(child), next, output);
        }
    }
}

fn record_order<V>(record: &PersistentNodeRecord<V>) -> (&[u8], u8) {
    match record {
        PersistentNodeRecord::Branch { path, .. } => (path, 0),
        PersistentNodeRecord::Leaf { path, .. } => (path, 1),
    }
}

fn ref_order(record: &PersistentNodeRef) -> (&[u8], u8) {
    match record {
        PersistentNodeRef::Branch { path } => (path, 0),
        PersistentNodeRef::Leaf { path, .. } => (path, 1),
    }
}

impl<V: Clone> PersistentRadixMap<V> {
    pub fn node_records(&self) -> Vec<PersistentNodeRecord<V>> {
        self.root_hash();
        let mut records = Vec::new();
        collect_records(self.root.as_ref(), &mut records);
        records
    }

    pub fn node_changes_since(&self, previous: &Self) -> PersistentNodeChanges<V> {
        self.root_hash();
        previous.root_hash();
        let mut puts = Vec::new();
        let mut dels = Vec::new();
        collect_puts(self.root.as_ref(), previous.root.as_ref(), &mut puts);
        collect_dels(previous.root.as_ref(), self.root.as_ref(), &mut dels);
        puts.sort_unstable_by(|left, right| record_order(left).cmp(&record_order(right)));
        dels.sort_unstable_by(|left, right| ref_order(left).cmp(&ref_order(right)));
        PersistentNodeChanges { puts, dels }
    }
}

use xln_rscore_abi::AbiValue;
use xln_rscore_protocol::{PersistentNodeChanges, PersistentNodeRecord, PersistentNodeRef};

use super::state_value::{encode_lending_kind, encode_lock, encode_policy, encode_swap_offer};
use super::{AccountWireEncodeError, encode_delta, encode_j_claim_node, integer, tuple};
use crate::AccountCheckpointRows;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum AccountCheckpointNamespace {
    Deltas = 1,
    Locks = 2,
    LendingIntents = 3,
    SwapOffers = 4,
    RebalanceFeePolicies = 5,
}

impl AccountCheckpointNamespace {
    pub const fn tag(self) -> u8 {
        self as u8
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EncodedAccountCheckpointNodeAddress {
    Branch { path: Vec<u8> },
    Leaf { path: Vec<u8>, key: Vec<u8> },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncodedAccountCheckpointNodeMutation {
    pub address: EncodedAccountCheckpointNodeAddress,
    /// Exact `[kind, path, ...]` ABI row written as the storage value. For a
    /// delete this is the exact two/three-field node reference.
    pub wire_value: AbiValue,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncodedAccountCheckpointTreeChanges {
    pub namespace: AccountCheckpointNamespace,
    pub puts: Vec<EncodedAccountCheckpointNodeMutation>,
    pub dels: Vec<EncodedAccountCheckpointNodeMutation>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncodedAccountJClaimNodePut {
    pub hash: [u8; 32],
    pub wire_value: AbiValue,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncodedAccountJClaimChanges {
    pub puts: Vec<EncodedAccountJClaimNodePut>,
    pub dels: Vec<[u8; 32]>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncodedAccountCheckpointNodes {
    pub trees: [EncodedAccountCheckpointTreeChanges; 5],
    pub j_claims: EncodedAccountJClaimChanges,
}

/// Project every persistent Account namespace without assigning physical
/// keys. Runtime storage owns the `(entity, account, namespace, path)` prefix;
/// this function owns the sole canonical node-value formula.
pub fn encode_account_checkpoint_nodes(
    rows: &AccountCheckpointRows,
) -> Result<EncodedAccountCheckpointNodes, AccountWireEncodeError> {
    Ok(EncodedAccountCheckpointNodes {
        trees: [
            tree_changes(
                AccountCheckpointNamespace::Deltas,
                &rows.deltas,
                encode_delta,
            )?,
            tree_changes(AccountCheckpointNamespace::Locks, &rows.locks, encode_lock)?,
            tree_changes(
                AccountCheckpointNamespace::LendingIntents,
                &rows.lending_intents,
                encode_lending_kind,
            )?,
            tree_changes(
                AccountCheckpointNamespace::SwapOffers,
                &rows.swap_offers,
                encode_swap_offer,
            )?,
            tree_changes(
                AccountCheckpointNamespace::RebalanceFeePolicies,
                &rows.rebalance_fee_policies,
                encode_policy,
            )?,
        ],
        j_claims: EncodedAccountJClaimChanges {
            puts: rows
                .j_claim_nodes
                .new_nodes
                .iter()
                .map(|(hash, node)| {
                    Ok(EncodedAccountJClaimNodePut {
                        hash: *hash,
                        wire_value: encode_j_claim_node(node)?,
                    })
                })
                .collect::<Result<Vec<_>, AccountWireEncodeError>>()?,
            dels: rows.j_claim_nodes.replaced_node_hashes.clone(),
        },
    })
}

fn tree_changes<V>(
    namespace: AccountCheckpointNamespace,
    changes: &PersistentNodeChanges<V>,
    encode: impl Fn(&V) -> AbiValue + Copy,
) -> Result<EncodedAccountCheckpointTreeChanges, AccountWireEncodeError> {
    Ok(EncodedAccountCheckpointTreeChanges {
        namespace,
        puts: changes
            .puts
            .iter()
            .map(|record| encode_node_put(record, encode))
            .collect::<Result<_, _>>()?,
        dels: changes.dels.iter().map(encode_node_del).collect(),
    })
}

pub(super) fn encode_node_put<V>(
    record: &PersistentNodeRecord<V>,
    encode: impl Fn(&V) -> AbiValue,
) -> Result<EncodedAccountCheckpointNodeMutation, AccountWireEncodeError> {
    match record {
        PersistentNodeRecord::Branch { path, children } => {
            let encoded_children = children
                .iter()
                .map(|child| {
                    let kind = match child.kind {
                        "branch" => 0,
                        "leaf" => 1,
                        _ => {
                            return Err(AccountWireEncodeError::Expected("checkpointChildKind"));
                        }
                    };
                    Ok(tuple(vec![
                        integer(child.slot),
                        integer(kind),
                        AbiValue::Bytes(child.path.clone()),
                        AbiValue::Bytes(child.edge_hash.to_vec()),
                    ]))
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(EncodedAccountCheckpointNodeMutation {
                address: EncodedAccountCheckpointNodeAddress::Branch { path: path.clone() },
                wire_value: tuple(vec![
                    integer(0),
                    AbiValue::Bytes(path.clone()),
                    tuple(encoded_children),
                ]),
            })
        }
        PersistentNodeRecord::Leaf { path, key, value } => {
            Ok(EncodedAccountCheckpointNodeMutation {
                address: EncodedAccountCheckpointNodeAddress::Leaf {
                    path: path.clone(),
                    key: key.clone(),
                },
                wire_value: tuple(vec![
                    integer(1),
                    AbiValue::Bytes(path.clone()),
                    AbiValue::Bytes(key.clone()),
                    encode(value),
                ]),
            })
        }
    }
}

pub(super) fn encode_node_del(record: &PersistentNodeRef) -> EncodedAccountCheckpointNodeMutation {
    match record {
        PersistentNodeRef::Branch { path } => EncodedAccountCheckpointNodeMutation {
            address: EncodedAccountCheckpointNodeAddress::Branch { path: path.clone() },
            wire_value: tuple(vec![integer(0), AbiValue::Bytes(path.clone())]),
        },
        PersistentNodeRef::Leaf { path, key } => EncodedAccountCheckpointNodeMutation {
            address: EncodedAccountCheckpointNodeAddress::Leaf {
                path: path.clone(),
                key: key.clone(),
            },
            wire_value: tuple(vec![
                integer(1),
                AbiValue::Bytes(path.clone()),
                AbiValue::Bytes(key.clone()),
            ]),
        },
    }
}

#[cfg(test)]
mod tests {
    use xln_rscore_protocol::{PersistentChildRecord, PersistentNodeRecord, PersistentNodeRef};

    use super::*;

    #[test]
    fn branch_leaf_and_delete_rows_match_checkpoint_abi() {
        let branch = encode_node_put(
            &PersistentNodeRecord::<u8>::Branch {
                path: vec![1],
                children: vec![PersistentChildRecord {
                    slot: 2,
                    kind: "leaf",
                    path: vec![1, 2],
                    edge_hash: [3; 32],
                }],
            },
            |value| integer(*value),
        )
        .expect("branch");
        assert_eq!(
            branch.wire_value,
            tuple(vec![
                integer(0),
                AbiValue::Bytes(vec![1]),
                tuple(vec![tuple(vec![
                    integer(2),
                    integer(1),
                    AbiValue::Bytes(vec![1, 2]),
                    AbiValue::Bytes(vec![3; 32]),
                ])]),
            ]),
        );

        let leaf = encode_node_put(
            &PersistentNodeRecord::Leaf {
                path: vec![1, 2],
                key: vec![0xaa],
                value: 9_u8,
            },
            |value| integer(*value),
        )
        .expect("leaf");
        assert_eq!(
            leaf.wire_value,
            tuple(vec![
                integer(1),
                AbiValue::Bytes(vec![1, 2]),
                AbiValue::Bytes(vec![0xaa]),
                integer(9),
            ]),
        );

        let deletion = encode_node_del(&PersistentNodeRef::Leaf {
            path: vec![1, 2],
            key: vec![0xaa],
        });
        assert_eq!(
            deletion.wire_value,
            tuple(vec![
                integer(1),
                AbiValue::Bytes(vec![1, 2]),
                AbiValue::Bytes(vec![0xaa]),
            ]),
        );
    }
}

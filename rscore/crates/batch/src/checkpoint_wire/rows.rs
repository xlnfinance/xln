use xln_rscore_abi::AbiValue;
use xln_rscore_engine::{
    AccountFrame, ConsensusSnapshot, CounterpartyDispute, DisputeDraft, OutboundAck,
};
use xln_rscore_protocol::PersistentNodeChanges;

use super::nodes::{EncodedAccountCheckpointNodeAddress, encode_node_del, encode_node_put};
use super::state_value::{encode_lending_kind, encode_lock, encode_policy, encode_swap_offer};
use super::{
    AccountWireEncodeError, encode_account_envelope, encode_account_tx, encode_delta,
    encode_j_claim_node, integer, tuple,
};
use crate::{AccountCheckpointHeader, AccountCheckpointRows};

/// Canonical eleven-field incremental checkpoint row used by both the
/// process ABI and path-keyed storage projection.
pub fn encode_account_checkpoint_rows(
    value: &AccountCheckpointRows,
    carry_envelope: bool,
) -> Result<AbiValue, AccountWireEncodeError> {
    Ok(tuple(vec![
        AbiValue::Bytes(value.account_id.as_bytes().to_vec()),
        AbiValue::Bytes(value.account_leaf.to_vec()),
        header(&value.header, carry_envelope),
        sections(&value.sections),
        changes(&value.deltas, encode_delta)?,
        changes(&value.locks, encode_lock)?,
        changes(&value.lending_intents, encode_lending_kind)?,
        changes(&value.swap_offers, encode_swap_offer)?,
        changes(&value.rebalance_fee_policies, encode_policy)?,
        j_claim_changes(&value.j_claim_nodes)?,
        consensus(&value.consensus)?,
    ]))
}

fn j_claim_changes(
    value: &xln_rscore_engine::JClaimNodeChanges,
) -> Result<AbiValue, AccountWireEncodeError> {
    let puts = value
        .new_nodes
        .iter()
        .map(|(hash, node)| {
            Ok(tuple(vec![
                AbiValue::Bytes(hash.to_vec()),
                encode_j_claim_node(node)?,
            ]))
        })
        .collect::<Result<Vec<_>, AccountWireEncodeError>>()?;
    let dels = value
        .replaced_node_hashes
        .iter()
        .map(|hash| AbiValue::Bytes(hash.to_vec()))
        .collect();
    Ok(tuple(vec![tuple(puts), tuple(dels)]))
}

fn sections(value: &crate::AccountCheckpointSections) -> AbiValue {
    tuple(vec![
        descriptor(&value.deltas),
        descriptor(&value.locks),
        descriptor(&value.lending_intents),
        descriptor(&value.swap_offers),
        descriptor(&value.rebalance_fee_policies),
    ])
}

fn descriptor(value: &crate::CheckpointTreeDescriptor) -> AbiValue {
    tuple(vec![
        AbiValue::Bytes(value.root.to_vec()),
        integer(value.leaf_count),
    ])
}

fn changes<V>(
    value: &PersistentNodeChanges<V>,
    encode: impl Fn(&V) -> AbiValue + Copy,
) -> Result<AbiValue, AccountWireEncodeError> {
    let puts = value
        .puts
        .iter()
        .map(|record| encode_node_put(record, encode))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter_map(|mutation| match mutation.address {
            EncodedAccountCheckpointNodeAddress::Branch { .. } => None,
            EncodedAccountCheckpointNodeAddress::Leaf { .. } => Some(mutation.wire_value),
        })
        .collect();
    let dels = value
        .dels
        .iter()
        .map(encode_node_del)
        .filter_map(|mutation| match mutation.address {
            EncodedAccountCheckpointNodeAddress::Branch { .. } => None,
            EncodedAccountCheckpointNodeAddress::Leaf { .. } => Some(mutation.wire_value),
        })
        .collect();
    Ok(tuple(vec![tuple(puts), tuple(dels)]))
}

fn header(value: &AccountCheckpointHeader, carry_envelope: bool) -> AbiValue {
    let identity = &value.identity;
    let domain = identity.domain();
    let carried = &value.carried;
    tuple(vec![
        AbiValue::Bytes(value.owner.as_bytes().to_vec()),
        AbiValue::Text(value.signer_id.clone()),
        tuple(vec![
            integer(domain.chain_id()),
            AbiValue::Bytes(domain.depository_address().as_bytes().to_vec()),
            AbiValue::Bytes(identity.left().as_bytes().to_vec()),
            AbiValue::Bytes(identity.right().as_bytes().to_vec()),
            AbiValue::Bytes(identity.watch_seed().as_bytes().to_vec()),
        ]),
        tuple(vec![
            integer(value.dispute_config.left_response_seconds()),
            integer(value.dispute_config.right_response_seconds()),
        ]),
        integer(value.j_nonce),
        integer(value.last_finalized_j_height),
        tuple(vec![
            AbiValue::Bytes(carried.pulls_root.to_vec()),
            AbiValue::Bytes(carried.subcontracts_root.to_vec()),
            AbiValue::Bytes(carried.requested_rebalance_root.to_vec()),
            AbiValue::Bytes(carried.requested_rebalance_fee_state_root.to_vec()),
            accumulator(&carried.left_pending_j_claims),
            accumulator(&carried.right_pending_j_claims),
        ]),
        if carry_envelope {
            encode_account_envelope(&value.envelope)
        } else {
            AbiValue::Nil
        },
        value
            .delta_transformer
            .map_or(AbiValue::Nil, |address| AbiValue::Bytes(address.to_vec())),
    ])
}

fn accumulator(value: &xln_rscore_engine::JClaimAccumulator) -> AbiValue {
    tuple(vec![
        AbiValue::Bytes(value.root.to_vec()),
        integer(value.count),
    ])
}

fn consensus(value: &ConsensusSnapshot) -> Result<AbiValue, AccountWireEncodeError> {
    let mempool = value
        .mempool
        .iter()
        .map(encode_account_tx)
        .collect::<Result<Vec<_>, _>>()?;
    let pending = match value.pending.as_ref() {
        None => AbiValue::Nil,
        Some(pending) => tuple(vec![
            frame(&pending.frame)?,
            AbiValue::Bytes(pending.state_hash.to_vec()),
            AbiValue::Bytes(pending.hanko.clone()),
            optional_ack(pending.bundled_ack.as_ref()),
            optional_dispute(pending.proposal_dispute.as_ref()),
        ]),
    };
    let current = match value.current.as_ref() {
        None => AbiValue::Nil,
        Some(current) => tuple(vec![
            frame(&current.frame)?,
            AbiValue::Bytes(current.state_hash.to_vec()),
        ]),
    };
    Ok(tuple(vec![
        tuple(mempool),
        current,
        pending,
        integer(value.rollback_count),
        value
            .last_rollback_frame_hash
            .map_or(AbiValue::Nil, |hash| AbiValue::Bytes(hash.to_vec())),
        value
            .counterparty_frame_hanko
            .as_ref()
            .map_or(AbiValue::Nil, |hanko| AbiValue::Bytes(hanko.clone())),
        value
            .local_committed_frame_hanko
            .as_ref()
            .map_or(AbiValue::Nil, |hanko| AbiValue::Bytes(hanko.clone())),
        optional_ack(value.last_outbound_ack.as_ref()),
        optional_dispute(value.dispute.as_ref()),
        integer(value.next_proof_nonce),
        optional_counterparty_dispute(value.counterparty_dispute.as_ref()),
    ]))
}

fn optional_ack(value: Option<&OutboundAck>) -> AbiValue {
    value.map_or(AbiValue::Nil, |ack| {
        tuple(vec![
            integer(ack.height),
            AbiValue::Bytes(ack.frame_hash.to_vec()),
            AbiValue::Bytes(ack.frame_hanko.clone()),
            optional_dispute(ack.dispute.as_ref()),
        ])
    })
}

fn optional_dispute(value: Option<&DisputeDraft>) -> AbiValue {
    value.map_or(AbiValue::Nil, |draft| {
        tuple(vec![
            AbiValue::Bytes(draft.hash.to_vec()),
            AbiValue::Bytes(draft.proof_body_hash.to_vec()),
            integer(draft.nonce),
            AbiValue::Bool(draft.proposer_is_left),
        ])
    })
}

fn optional_counterparty_dispute(value: Option<&CounterpartyDispute>) -> AbiValue {
    value.map_or(AbiValue::Nil, |dispute| {
        tuple(vec![
            dispute
                .hanko
                .as_ref()
                .map_or(AbiValue::Nil, |hanko| AbiValue::Bytes(hanko.clone())),
            AbiValue::Bytes(dispute.hash.to_vec()),
            AbiValue::Bytes(dispute.proof_body_hash.to_vec()),
            integer(dispute.nonce),
            AbiValue::Bool(dispute.proposer_is_left),
        ])
    })
}

fn frame(value: &AccountFrame) -> Result<AbiValue, AccountWireEncodeError> {
    let txs = value
        .txs
        .iter()
        .map(encode_account_tx)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(tuple(vec![
        integer(value.height),
        integer(value.timestamp),
        integer(value.j_height),
        tuple(txs),
        AbiValue::Text(value.prev_frame_hash.clone()),
        AbiValue::Bytes(value.account_state_root.to_vec()),
    ]))
}

use xln_rscore_abi::AbiValue;
use xln_rscore_batch::{AccountCheckpointHeader, AccountCheckpointRows};
use xln_rscore_engine::{
    AccountFrame, BilateralRebalanceFeePolicy, ConsensusSnapshot, CounterpartyDispute,
    DisputeDraft, HtlcLock, LendingIntentKind, OutboundAck, RebalanceFeePolicySnapshot, Side,
    SwapOffer,
};
use xln_rscore_protocol::{PersistentNodeChanges, PersistentNodeRecord, PersistentNodeRef};

use crate::ProcessError;
use crate::canonical::encode_envelope;
use crate::wire_encode::{big, delta, integer, tuple, tx};

/// `carry_envelope` is false on the round wire and true in a checkpoint.
///
/// The envelope is the Account's opaque half: fields the engine stores and
/// hands back untouched, never authors (`execution.rs` installs only what the
/// caller sent). Echoing it to the caller that just sent it was 39% of every
/// reply. A checkpoint is read by a process that holds no prior Account, so
/// that one still carries it.
pub(crate) fn account_rows(
    value: &AccountCheckpointRows,
    carry_envelope: bool,
) -> Result<AbiValue, ProcessError> {
    Ok(tuple(vec![
        AbiValue::Bytes(value.account_id.as_bytes().to_vec()),
        AbiValue::Bytes(value.account_leaf.to_vec()),
        header(&value.header, carry_envelope),
        sections(&value.sections),
        changes(&value.deltas, delta),
        changes(&value.locks, lock),
        changes(&value.lending_intents, |kind| integer(lending_kind(*kind))),
        changes(&value.swap_offers, offer),
        changes(&value.rebalance_fee_policies, policy),
        j_claim_changes(&value.j_claim_nodes)?,
        consensus(&value.consensus)?,
    ]))
}

fn j_claim_changes(value: &xln_rscore_engine::JClaimNodeChanges) -> Result<AbiValue, ProcessError> {
    let puts = value
        .new_nodes
        .iter()
        .map(|(hash, node)| {
            Ok(tuple(vec![
                AbiValue::Bytes(hash.to_vec()),
                crate::wire_encode::j_claim_node(node)?,
            ]))
        })
        .collect::<Result<Vec<_>, ProcessError>>()?;
    let dels = value
        .replaced_node_hashes
        .iter()
        .map(|hash| AbiValue::Bytes(hash.to_vec()))
        .collect();
    Ok(tuple(vec![tuple(puts), tuple(dels)]))
}

fn sections(value: &xln_rscore_batch::AccountCheckpointSections) -> AbiValue {
    tuple(vec![
        descriptor(&value.deltas),
        descriptor(&value.locks),
        descriptor(&value.lending_intents),
        descriptor(&value.swap_offers),
        descriptor(&value.rebalance_fee_policies),
    ])
}

fn descriptor(value: &xln_rscore_batch::CheckpointTreeDescriptor) -> AbiValue {
    tuple(vec![
        AbiValue::Bytes(value.root.to_vec()),
        integer(value.leaf_count),
    ])
}

fn changes<V>(value: &PersistentNodeChanges<V>, encode: impl Fn(&V) -> AbiValue) -> AbiValue {
    tuple(vec![
        tuple(
            value
                .puts
                .iter()
                .filter_map(|record| match record {
                    // Branch records rebuild a tree the reader rebuilds itself
                    // from the leaves. Sending them was the largest single item
                    // on this wire, and nothing on the other side read them.
                    PersistentNodeRecord::Branch { .. } => None,
                    PersistentNodeRecord::Leaf {
                        path, key, value, ..
                    } => Some(tuple(vec![
                        integer(1),
                        AbiValue::Bytes(path.clone()),
                        AbiValue::Bytes(key.clone()),
                        encode(value),
                    ])),
                })
                .collect(),
        ),
        tuple(
            value
                .dels
                .iter()
                .filter_map(|record| match record {
                    PersistentNodeRef::Branch { .. } => None,
                    PersistentNodeRef::Leaf { path, key } => Some(tuple(vec![
                        integer(1),
                        AbiValue::Bytes(path.clone()),
                        AbiValue::Bytes(key.clone()),
                    ])),
                })
                .collect(),
        ),
    ])
}

pub fn header(value: &AccountCheckpointHeader, carry_envelope: bool) -> AbiValue {
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
            encode_envelope(&value.envelope)
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

pub fn consensus(value: &ConsensusSnapshot) -> Result<AbiValue, ProcessError> {
    let mut mempool = Vec::with_capacity(value.mempool.len());
    for value in &value.mempool {
        mempool.push(tx(value)?);
    }
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

fn frame(value: &AccountFrame) -> Result<AbiValue, ProcessError> {
    let mut txs = Vec::with_capacity(value.txs.len());
    for value in &value.txs {
        txs.push(tx(value)?);
    }
    Ok(tuple(vec![
        integer(value.height),
        integer(value.timestamp),
        integer(value.j_height),
        tuple(txs),
        AbiValue::Text(value.prev_frame_hash.clone()),
        AbiValue::Bytes(value.account_state_root.to_vec()),
        AbiValue::Bool(value.by_left),
        tuple(value.deltas.iter().map(delta).collect()),
    ]))
}

fn lock(value: &HtlcLock) -> AbiValue {
    tuple(vec![
        AbiValue::Text(value.lock_id().to_owned()),
        AbiValue::Bytes(value.hashlock().bytes().to_vec()),
        big(value.timelock()),
        integer(value.reveal_before_height()),
        big(value.amount()),
        integer(value.token_id().get()),
        integer(match value.sender() {
            Side::Left => 0,
            Side::Right => 1,
        }),
        integer(value.created_height()),
        integer(value.created_timestamp()),
        value
            .envelope_hash()
            .map_or(AbiValue::Nil, |hash| AbiValue::Bytes(hash.to_vec())),
    ])
}

pub fn offer(value: &SwapOffer) -> AbiValue {
    tuple(vec![
        AbiValue::Text(value.offer_id().to_owned()),
        integer(value.give_token_id()),
        integer(value.give_token_decimals()),
        big(value.give_amount()),
        integer(value.want_token_id()),
        integer(value.want_token_decimals()),
        big(value.want_amount()),
        big(value.max_fee()),
        big(value.min_net_receive()),
        big(value.price_ticks()),
        value.time_in_force().map_or(AbiValue::Nil, integer),
        integer(if value.maker_is_left() { 0 } else { 1 }),
        integer(value.created_height()),
        big(value.quantized_give()),
        big(value.quantized_want()),
    ])
}

pub fn policy(value: &BilateralRebalanceFeePolicy) -> AbiValue {
    tuple(vec![
        value
            .side(Side::Left)
            .map_or(AbiValue::Nil, policy_snapshot),
        value
            .side(Side::Right)
            .map_or(AbiValue::Nil, policy_snapshot),
    ])
}

fn policy_snapshot(value: &RebalanceFeePolicySnapshot) -> AbiValue {
    tuple(vec![
        integer(value.policy_version()),
        big(value.base_fee()),
        big(value.liquidity_fee_bps()),
        big(value.gas_fee()),
        integer(value.updated_at()),
    ])
}

pub const fn lending_kind(value: LendingIntentKind) -> u8 {
    match value {
        LendingIntentKind::Fund => 0,
        LendingIntentKind::Borrow => 1,
        LendingIntentKind::Repay => 2,
        LendingIntentKind::CreditGrant => 3,
        LendingIntentKind::CreditRevoke => 4,
        LendingIntentKind::CloseRequest => 5,
        LendingIntentKind::ClosePayout => 6,
    }
}

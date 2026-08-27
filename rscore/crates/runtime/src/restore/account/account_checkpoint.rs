//! Exact ten-field `RestoreExact` Account-row decoder.

use serde_json::Value;
use xln_rscore_abi::AbiValue;
use xln_rscore_batch::{AccountCheckpointHeader, AccountId, AccountRestore};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountFrame, AccountIdentity, AccountReplica,
    AccountState, AccountStateSeed, CarriedSections, CommittedFrame, ConsensusSnapshot,
    DepositoryAddress, DisputeDraft, LendingIntentKind, OutboundAck, PendingFrameSnapshot,
    WatchSeed,
};

use super::account_canonical::envelope;
use super::account_tx::{
    claim_accumulator, delta, j_claim_node, lock, policy_entry, swap_offer_state, transaction,
};
use super::account_value::{
    AccountWireRestoreError, abi, boolean, bytes, entity, exact, fixed_bytes, hex_fixed, integer,
    invalid, js_number, strict_boolean, text, tuple,
};

const MAX_CHECKPOINT_ACCOUNTS: usize = 65_536;

fn optional_bytes(
    value: &AbiValue,
    field: &'static str,
) -> Result<Option<Vec<u8>>, AccountWireRestoreError> {
    match value {
        AbiValue::Nil => Ok(None),
        AbiValue::Bytes(value) => Ok(Some(value.clone())),
        _ => Err(invalid(format!("OPTIONAL_BYTES:{field}"))),
    }
}

fn dispute(value: &AbiValue) -> Result<Option<DisputeDraft>, AccountWireRestoreError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let row = exact(tuple(value)?, 4, "disputeDraft")?;
    Ok(Some(DisputeDraft {
        hash: fixed_bytes(&row[0], "disputeHash")?,
        proof_body_hash: fixed_bytes(&row[1], "disputeProofBodyHash")?,
        nonce: js_number(&row[2], "disputeProofNonce")?,
        proposer_is_left: boolean(&row[3], "disputeProposerIsLeft")?,
    }))
}

fn outbound_ack(
    value: &AbiValue,
    field: &'static str,
) -> Result<Option<OutboundAck>, AccountWireRestoreError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let row = exact(tuple(value)?, 4, field)?;
    let frame_hanko = bytes(&row[2], "ackFrameHanko")?.to_vec();
    if frame_hanko.is_empty() {
        return Err(invalid("ACK_FRAME_HANKO"));
    }
    Ok(Some(OutboundAck {
        height: js_number(&row[0], "ackHeight")?,
        frame_hash: fixed_bytes(&row[1], "ackFrameHash")?,
        frame_hanko,
        dispute: dispute(&row[3])?,
    }))
}

fn counterparty_dispute(
    value: &AbiValue,
) -> Result<Option<xln_rscore_engine::CounterpartyDispute>, AccountWireRestoreError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let row = exact(tuple(value)?, 5, "counterpartyDispute")?;
    Ok(Some(xln_rscore_engine::CounterpartyDispute {
        hanko: optional_bytes(&row[0], "counterpartyDisputeHanko")?,
        hash: fixed_bytes(&row[1], "counterpartyDisputeHash")?,
        proof_body_hash: fixed_bytes(&row[2], "counterpartyDisputeProofBodyHash")?,
        nonce: js_number(&row[3], "counterpartyDisputeProofNonce")?,
        proposer_is_left: strict_boolean(&row[4], "counterpartyDisputeProposerIsLeft")?,
    }))
}

fn frame(value: &AbiValue) -> Result<AccountFrame, AccountWireRestoreError> {
    let fields = exact(tuple(value)?, 6, "checkpointFrame")?;
    Ok(AccountFrame {
        height: js_number(&fields[0], "height")?,
        timestamp: js_number(&fields[1], "timestamp")?,
        j_height: js_number(&fields[2], "jHeight")?,
        txs: tuple(&fields[3])?
            .iter()
            .map(transaction)
            .collect::<Result<_, _>>()?,
        prev_frame_hash: text(&fields[4])?.to_owned(),
        account_state_root: fixed_bytes(&fields[5], "accountStateRoot")?,
    })
}

fn current(value: &AbiValue) -> Result<Option<CommittedFrame>, AccountWireRestoreError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let fields = exact(tuple(value)?, 2, "committedFrame")?;
    Ok(Some(CommittedFrame {
        frame: frame(&fields[0])?,
        state_hash: fixed_bytes(&fields[1], "stateHash")?,
    }))
}

fn pending(value: &AbiValue) -> Result<Option<PendingFrameSnapshot>, AccountWireRestoreError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let fields = exact(tuple(value)?, 5, "pendingFrame")?;
    Ok(Some(PendingFrameSnapshot {
        frame: frame(&fields[0])?,
        state_hash: fixed_bytes(&fields[1], "pendingStateHash")?,
        hanko: bytes(&fields[2], "pendingHanko")?.to_vec(),
        bundled_ack: outbound_ack(&fields[3], "pendingBundledAck")?,
        proposal_dispute: dispute(&fields[4])?,
    }))
}

fn consensus(value: &AbiValue) -> Result<ConsensusSnapshot, AccountWireRestoreError> {
    let fields = exact(tuple(value)?, 11, "consensusSnapshot")?;
    Ok(ConsensusSnapshot {
        mempool: tuple(&fields[0])?
            .iter()
            .map(transaction)
            .collect::<Result<_, _>>()?,
        current: current(&fields[1])?,
        pending: pending(&fields[2])?,
        rollback_count: js_number(&fields[3], "rollbackCount")?,
        last_rollback_frame_hash: match &fields[4] {
            AbiValue::Nil => None,
            value => Some(fixed_bytes(value, "lastRollbackFrameHash")?),
        },
        counterparty_frame_hanko: optional_bytes(&fields[5], "counterpartyFrameHanko")?,
        local_committed_frame_hanko: optional_bytes(&fields[6], "localCommittedFrameHanko")?,
        last_outbound_ack: outbound_ack(&fields[7], "lastOutboundAck")?,
        dispute: dispute(&fields[8])?,
        next_proof_nonce: js_number(&fields[9], "nextProofNonce")?,
        counterparty_dispute: counterparty_dispute(&fields[10])?,
    })
}

fn lending_entry(value: &AbiValue) -> Result<(String, LendingIntentKind), AccountWireRestoreError> {
    let fields = exact(tuple(value)?, 2, "lendingEntry")?;
    let kind = match integer(&fields[1])? {
        0 => LendingIntentKind::Fund,
        1 => LendingIntentKind::Borrow,
        2 => LendingIntentKind::Repay,
        3 => LendingIntentKind::CreditGrant,
        4 => LendingIntentKind::CreditRevoke,
        5 => LendingIntentKind::CloseRequest,
        6 => LendingIntentKind::ClosePayout,
        value => return Err(invalid(format!("LENDING_KIND:{value}"))),
    };
    Ok((text(&fields[0])?.to_owned(), kind))
}

fn header(value: &AbiValue) -> Result<AccountCheckpointHeader, AccountWireRestoreError> {
    let fields = exact(tuple(value)?, 9, "checkpointHeader")?;
    let identity = exact(tuple(&fields[2])?, 5, "checkpointIdentity")?;
    let dispute = exact(tuple(&fields[3])?, 2, "checkpointDispute")?;
    let carried = exact(tuple(&fields[6])?, 6, "checkpointCarried")?;
    let identity = AccountIdentity::new(
        AccountDomain::new(
            js_number(&identity[0], "chainId")?,
            DepositoryAddress::parse(&hex_fixed(&identity[1], "depository", 20)?)
                .map_err(|error| invalid(format!("DEPOSITORY:{error}")))?,
        )
        .map_err(|error| invalid(format!("ACCOUNT_DOMAIN:{error}")))?,
        entity(&identity[2], "left")?,
        entity(&identity[3], "right")?,
        WatchSeed::parse(&hex_fixed(&identity[4], "watchSeed", 32)?)
            .map_err(|error| invalid(format!("WATCH_SEED:{error}")))?,
    )
    .map_err(|error| invalid(format!("ACCOUNT_IDENTITY:{error}")))?;
    let dispute_config = AccountDisputeConfig::new(
        js_number(&dispute[0], "leftResponseSeconds")?,
        js_number(&dispute[1], "rightResponseSeconds")?,
    )
    .map_err(|error| invalid(format!("DISPUTE_CONFIG:{error}")))?;
    Ok(AccountCheckpointHeader {
        owner: entity(&fields[0], "owner")?,
        signer_id: text(&fields[1])?.to_owned(),
        identity,
        dispute_config,
        j_nonce: js_number(&fields[4], "jNonce")?,
        last_finalized_j_height: js_number(&fields[5], "lastFinalizedJHeight")?,
        carried: CarriedSections {
            pulls_root: fixed_bytes(&carried[0], "pullsRoot")?,
            subcontracts_root: fixed_bytes(&carried[1], "subcontractsRoot")?,
            requested_rebalance_root: fixed_bytes(&carried[2], "requestedRebalanceRoot")?,
            requested_rebalance_fee_state_root: fixed_bytes(
                &carried[3],
                "requestedRebalanceFeeStateRoot",
            )?,
            left_pending_j_claims: claim_accumulator(&carried[4])?,
            right_pending_j_claims: claim_accumulator(&carried[5])?,
        },
        envelope: envelope(&fields[7])?,
        delta_transformer: match &fields[8] {
            AbiValue::Nil => None,
            value => Some(fixed_bytes(value, "deltaTransformer")?),
        },
    })
}

fn account_restore(value: &AbiValue) -> Result<AccountRestore, AccountWireRestoreError> {
    let fields = exact(tuple(value)?, 10, "accountRestore")?;
    let account_id = AccountId::from_bytes(fixed_bytes(&fields[0], "accountId")?);
    let account_leaf = fixed_bytes(&fields[1], "accountLeaf")?;
    let header = header(&fields[2])?;
    let deltas = tuple(&fields[3])?
        .iter()
        .map(delta)
        .collect::<Result<_, _>>()?;
    let locks = tuple(&fields[4])?
        .iter()
        .map(lock)
        .collect::<Result<_, _>>()?;
    let lending_intents = tuple(&fields[5])?
        .iter()
        .map(lending_entry)
        .collect::<Result<_, _>>()?;
    let swap_offers = tuple(&fields[6])?
        .iter()
        .map(swap_offer_state)
        .collect::<Result<_, _>>()?;
    let rebalance_fee_policies = tuple(&fields[7])?
        .iter()
        .map(policy_entry)
        .collect::<Result<_, _>>()?;
    let j_claim_nodes = tuple(&fields[8])?
        .iter()
        .map(|entry| {
            let row = exact(tuple(entry)?, 2, "jClaimNodeEntry")?;
            Ok((
                fixed_bytes(&row[0], "jClaimNodeHash")?,
                j_claim_node(&row[1])?,
            ))
        })
        .collect::<Result<Vec<_>, AccountWireRestoreError>>()?;
    let consensus = consensus(&fields[9])?;
    let counterparty = if &header.owner == header.identity.left() {
        header.identity.right()
    } else if &header.owner == header.identity.right() {
        header.identity.left()
    } else {
        return Err(invalid("CHECKPOINT_OWNER_IN_ACCOUNT"));
    };
    if account_id.as_bytes() != counterparty.as_bytes() {
        return Err(invalid("CHECKPOINT_ACCOUNT_IS_COUNTERPARTY"));
    }
    let mut replica = AccountReplica::new(
        header.owner,
        AccountState::restore_full(AccountStateSeed {
            identity: header.identity,
            dispute_config: header.dispute_config,
            deltas,
            locks,
            j_nonce: header.j_nonce,
            last_finalized_j_height: header.last_finalized_j_height,
            carried: header.carried,
            rebalance_fee_policies,
            swap_offers,
            lending_intents,
        })
        .map_err(|error| invalid(format!("ACCOUNT_STATE:{error}")))?,
    )
    .map_err(|error| invalid(format!("ACCOUNT_REPLICA:{error}")))?;
    replica.set_envelope(header.envelope);
    replica
        .restore_j_claim_nodes(j_claim_nodes)
        .map_err(|error| invalid(format!("J_CLAIM_NODES:{error}")))?;
    if let Some(address) = header.delta_transformer {
        replica.set_delta_transformer(address);
    }
    Ok(AccountRestore {
        account_id,
        replica,
        consensus,
        signer_id: header.signer_id,
        account_leaf,
    })
}

/// Decode exactly the persisted ten-field rows accepted by the process
/// `RestoreExact` operation. This is the same positional ABI, not a second
/// semantic checkpoint shape.
pub fn decode_account_rows(rows: &[Value]) -> Result<Vec<AccountRestore>, AccountWireRestoreError> {
    if rows.len() > MAX_CHECKPOINT_ACCOUNTS {
        return Err(invalid(format!("ACCOUNT_COUNT:{}", rows.len())));
    }
    rows.iter()
        .map(abi)
        .map(|value| value.and_then(|value| account_restore(&value)))
        .collect()
}

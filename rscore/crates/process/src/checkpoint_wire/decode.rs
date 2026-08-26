use xln_rscore_abi::AbiValue;
use xln_rscore_batch::{AccountCheckpointHeader, AccountId, AccountRestore, CheckpointToken};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountFrame, AccountIdentity, AccountReplica,
    AccountState, AccountStateSeed, BilateralRebalanceFeePolicy, CarriedSections, CommittedFrame,
    ConsensusSnapshot, DepositoryAddress, JClaimAccumulator, LendingIntentKind,
    PendingFrameSnapshot, RebalanceFeePolicySnapshot, TokenId, WatchSeed,
};

use crate::ProcessError;
use crate::wire_decode::{
    decode_counterparty_dispute, decode_delta, decode_dispute_draft, decode_lock,
    decode_outbound_ack, decode_swap_offer_state, decode_tx,
};
use crate::wire_value::{
    bigint, boolean, bounded_u32, bytes, entity, exact, fixed_bytes, hex_fixed, integer, js_number,
    text, tuple, unsigned,
};

const MAX_CHECKPOINT_ACCOUNTS: usize = 65_536;

pub fn restore_request(
    fields: &[AbiValue],
) -> Result<(CheckpointToken, Vec<AccountRestore>), ProcessError> {
    let fields = exact(fields, 2, "restoreExact")?;
    let expected = super::decode_token(&fields[0])?;
    let rows = tuple(&fields[1])?;
    if rows.len() > MAX_CHECKPOINT_ACCOUNTS {
        return Err(ProcessError::Expected("checkpointAccountRows"));
    }
    let restored = rows
        .iter()
        .map(account_restore)
        .collect::<Result<Vec<_>, _>>()?;
    Ok((expected, restored))
}

fn account_restore(value: &AbiValue) -> Result<AccountRestore, ProcessError> {
    let fields = exact(tuple(value)?, 10, "accountRestore")?;
    let account_id = AccountId::from_bytes(fixed_bytes(&fields[0], "accountId")?);
    let account_leaf = fixed_bytes(&fields[1], "accountLeaf")?;
    let header = header(&fields[2])?;
    let deltas = tuple(&fields[3])?
        .iter()
        .map(decode_delta)
        .collect::<Result<_, _>>()?;
    let locks = tuple(&fields[4])?
        .iter()
        .map(decode_lock)
        .collect::<Result<_, _>>()?;
    let lending_intents = tuple(&fields[5])?
        .iter()
        .map(lending_entry)
        .collect::<Result<_, _>>()?;
    let swap_offers = tuple(&fields[6])?
        .iter()
        .map(decode_swap_offer_state)
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
                crate::wire_decode::decode_j_claim_node(&row[1])?,
            ))
        })
        .collect::<Result<Vec<_>, ProcessError>>()?;
    let consensus = consensus(&fields[9])?;
    let AccountCheckpointHeader {
        owner,
        signer_id,
        identity,
        dispute_config,
        j_nonce,
        last_finalized_j_height,
        carried,
        envelope,
        delta_transformer,
    } = header;
    let counterparty = if &owner == identity.left() {
        identity.right()
    } else if &owner == identity.right() {
        identity.left()
    } else {
        return Err(ProcessError::Expected("checkpointOwnerInAccount"));
    };
    if account_id.as_bytes() != counterparty.as_bytes() {
        return Err(ProcessError::Expected("checkpointAccountIdIsCounterparty"));
    }
    let mut replica = AccountReplica::new(
        owner,
        AccountState::restore_full(AccountStateSeed {
            identity,
            dispute_config,
            deltas,
            locks,
            j_nonce,
            last_finalized_j_height,
            carried,
            rebalance_fee_policies,
            swap_offers,
            lending_intents,
        })?,
    )?;
    replica.set_envelope(envelope);
    replica.restore_j_claim_nodes(j_claim_nodes)?;
    if let Some(address) = delta_transformer {
        replica.set_delta_transformer(address);
    }
    Ok(AccountRestore {
        account_id,
        replica,
        consensus,
        signer_id,
        account_leaf,
    })
}

pub fn header(value: &AbiValue) -> Result<AccountCheckpointHeader, ProcessError> {
    let fields = exact(tuple(value)?, 9, "checkpointHeader")?;
    let identity = exact(tuple(&fields[2])?, 5, "checkpointIdentity")?;
    let dispute = exact(tuple(&fields[3])?, 2, "checkpointDispute")?;
    let carried = exact(tuple(&fields[6])?, 6, "checkpointCarried")?;
    Ok(AccountCheckpointHeader {
        owner: entity(&fields[0], "owner")?,
        signer_id: text(&fields[1])?.to_owned(),
        identity: AccountIdentity::new(
            AccountDomain::new(
                js_number(&identity[0], "chainId")?,
                DepositoryAddress::parse(&hex_fixed(&identity[1], "depository", 20)?)?,
            )?,
            entity(&identity[2], "left")?,
            entity(&identity[3], "right")?,
            WatchSeed::parse(&hex_fixed(&identity[4], "watchSeed", 32)?)?,
        )?,
        dispute_config: AccountDisputeConfig::new(
            js_number(&dispute[0], "leftResponseSeconds")?,
            js_number(&dispute[1], "rightResponseSeconds")?,
        )?,
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
            left_pending_j_claims: accumulator(&carried[4])?,
            right_pending_j_claims: accumulator(&carried[5])?,
        },
        envelope: crate::canonical::envelope(&fields[7])?
            .ok_or(ProcessError::Expected("checkpointEnvelope"))?,
        delta_transformer: match &fields[8] {
            AbiValue::Nil => None,
            value => Some(fixed_bytes(value, "deltaTransformer")?),
        },
    })
}

fn accumulator(value: &AbiValue) -> Result<JClaimAccumulator, ProcessError> {
    let fields = exact(tuple(value)?, 2, "claimAccumulator")?;
    Ok(JClaimAccumulator {
        root: fixed_bytes(&fields[0], "claimRoot")?,
        count: unsigned(&fields[1], "claimCount")?,
    })
}

pub fn consensus(value: &AbiValue) -> Result<ConsensusSnapshot, ProcessError> {
    let fields = exact(tuple(value)?, 11, "consensusSnapshot")?;
    Ok(ConsensusSnapshot {
        mempool: tuple(&fields[0])?
            .iter()
            .map(decode_tx)
            .collect::<Result<_, _>>()?,
        current: optional_current(&fields[1])?,
        pending: optional_pending(&fields[2])?,
        rollback_count: js_number(&fields[3], "rollbackCount")?,
        last_rollback_frame_hash: match &fields[4] {
            AbiValue::Nil => None,
            value => Some(fixed_bytes(value, "lastRollbackFrameHash")?),
        },
        counterparty_frame_hanko: match &fields[5] {
            AbiValue::Nil => None,
            value => Some(bytes(value, "counterpartyFrameHanko")?.to_vec()),
        },
        local_committed_frame_hanko: match &fields[6] {
            AbiValue::Nil => None,
            value => Some(bytes(value, "localCommittedFrameHanko")?.to_vec()),
        },
        last_outbound_ack: decode_outbound_ack(&fields[7], "lastOutboundAck")?,
        dispute: decode_dispute_draft(&fields[8])?,
        next_proof_nonce: js_number(&fields[9], "nextProofNonce")?,
        counterparty_dispute: decode_counterparty_dispute(&fields[10])?,
    })
}

fn optional_current(value: &AbiValue) -> Result<Option<CommittedFrame>, ProcessError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let fields = exact(tuple(value)?, 2, "committedFrame")?;
    Ok(Some(CommittedFrame {
        frame: frame(&fields[0])?,
        state_hash: fixed_bytes(&fields[1], "stateHash")?,
    }))
}

fn optional_pending(value: &AbiValue) -> Result<Option<PendingFrameSnapshot>, ProcessError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let fields = exact(tuple(value)?, 5, "pendingFrame")?;
    Ok(Some(PendingFrameSnapshot {
        frame: frame(&fields[0])?,
        state_hash: fixed_bytes(&fields[1], "pendingStateHash")?,
        hanko: bytes(&fields[2], "pendingHanko")?.to_vec(),
        bundled_ack: decode_outbound_ack(&fields[3], "pendingBundledAck")?,
        proposal_dispute: decode_dispute_draft(&fields[4])?,
    }))
}

fn frame(value: &AbiValue) -> Result<AccountFrame, ProcessError> {
    let fields = exact(tuple(value)?, 8, "checkpointFrame")?;
    Ok(AccountFrame {
        height: js_number(&fields[0], "height")?,
        timestamp: js_number(&fields[1], "timestamp")?,
        j_height: js_number(&fields[2], "jHeight")?,
        txs: tuple(&fields[3])?
            .iter()
            .map(decode_tx)
            .collect::<Result<_, _>>()?,
        prev_frame_hash: text(&fields[4])?.to_owned(),
        account_state_root: fixed_bytes(&fields[5], "accountStateRoot")?,
        by_left: boolean(&fields[6], "byLeft")?,
        deltas: tuple(&fields[7])?
            .iter()
            .map(decode_delta)
            .collect::<Result<_, _>>()?,
    })
}

fn lending_entry(value: &AbiValue) -> Result<(String, LendingIntentKind), ProcessError> {
    let fields = exact(tuple(value)?, 2, "lendingEntry")?;
    let kind = match integer(&fields[1])? {
        0 => LendingIntentKind::Fund,
        1 => LendingIntentKind::Borrow,
        2 => LendingIntentKind::Repay,
        3 => LendingIntentKind::CreditGrant,
        4 => LendingIntentKind::CreditRevoke,
        5 => LendingIntentKind::CloseRequest,
        6 => LendingIntentKind::ClosePayout,
        value => {
            return Err(ProcessError::Tag {
                field: "lendingKind",
                value,
            });
        }
    };
    Ok((text(&fields[0])?.to_owned(), kind))
}

fn policy_entry(value: &AbiValue) -> Result<(TokenId, BilateralRebalanceFeePolicy), ProcessError> {
    let fields = exact(tuple(value)?, 2, "policyEntry")?;
    Ok((
        TokenId::new(bounded_u32(&fields[0], "tokenId")?)?,
        policy(&fields[1])?,
    ))
}

fn policy(value: &AbiValue) -> Result<BilateralRebalanceFeePolicy, ProcessError> {
    let fields = exact(tuple(value)?, 2, "rebalancePolicy")?;
    Ok(BilateralRebalanceFeePolicy::new(
        policy_snapshot(&fields[0])?,
        policy_snapshot(&fields[1])?,
    ))
}

fn policy_snapshot(value: &AbiValue) -> Result<Option<RebalanceFeePolicySnapshot>, ProcessError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let fields = exact(tuple(value)?, 5, "rebalancePolicySnapshot")?;
    Ok(Some(RebalanceFeePolicySnapshot::new(
        js_number(&fields[0], "policyVersion")?,
        bigint(&fields[1], "baseFee")?,
        bigint(&fields[2], "liquidityFeeBps")?,
        bigint(&fields[3], "gasFee")?,
        js_number(&fields[4], "updatedAt")?,
    )))
}

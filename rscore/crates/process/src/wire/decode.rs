//! Command and Account transition decoder for the process ABI.

use num_bigint::BigInt;
use xln_rscore_abi::{AbiValue, Envelope, OpTag};
use xln_rscore_batch::{AccountId, AccountSeed};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountFrame, AccountIdentity, AccountReplica,
    AccountState, AccountStateSeed, AccountTx, BilateralRebalanceFeePolicy, CarriedSections,
    DeliveryMode, Delta, DepositoryAddress, HtlcDeliveryMode, HtlcHashlock, HtlcLock, HtlcLockTx,
    HtlcResolveOutcome, HtlcResolveTx, JClaimAccumulator, JClaimNode, JClaimProof, JClaimRecord,
    JClaimSide, JEventClaimTx, JurisdictionEvent, LendingAction, LendingTermId,
    OpaqueHtlcCiphertext, RebalanceFeePolicySnapshot, RebalanceRefundReason, ReserveSide, Side,
    SwapMarketPolicy, SwapOffer, SwapToken, TokenId, WatchSeed,
};

use crate::wire_value::{
    bigint, boolean, bounded_u32, bytes, entity, exact, fixed_bytes, hex_fixed, integer, js_number,
    optional_fixed_bytes, optional_text, text, text_list, token, tuple, unsigned,
};
use crate::{PROCESS_ABI_VERSION, PROCESS_PROFILE, ProcessError};

/// The key the authoritative session signs with and the id the runtime knows
/// that key by. The runtime
/// derives its keys from labels of its own choosing, which this process cannot
/// reconstruct from an address, so it is handed one key rather than the seed
/// that makes all of them.
pub struct AuthorityConfig {
    pub private_key: [u8; 32],
    pub signer_id: String,
}

pub enum Command {
    Hello {
        worker_count: usize,
        swap_market: SwapMarketPolicy,
        /// Present when this session owns the accounts rather than mirroring
        /// them.
        authority: Option<AuthorityConfig>,
    },
    BootstrapAccounts {
        revision: u64,
        accounts: Vec<AccountSeed>,
        /// Explicit, caller-declared import of existing TypeScript Account
        /// state. Production never sets it: durable history enters through
        /// RestoreExact, whose token binds every leaf, signer and revision.
        /// A read-only benchmark replay of a recording that predates the
        /// authority has no such checkpoint, and says so here rather than
        /// having the engine guess.
        import_existing: bool,
    },
    RestoreExact {
        expected: xln_rscore_batch::CheckpointToken,
        accounts: Vec<xln_rscore_batch::AccountRestore>,
    },
    Shutdown,
    /// Every retired authority candidate/checkpoint command collapses to one
    /// loud rejection. Keeping decoded payloads here would retain a second,
    /// unused authority protocol beside the resident EntityRound path.
    AuthorityTwoCallOnly,
    BootstrapEntity {
        snapshot: Box<xln_rscore_entity_kernel::EntityStateSnapshot>,
    },
    EntityRound {
        request: Box<xln_rscore_entity_kernel::ResidentEntityRequest>,
        context: Box<xln_rscore_entity_kernel::DeterministicContext>,
    },
}

pub fn decode_command(envelope: &Envelope) -> Result<Command, ProcessError> {
    let body = exact(envelope.body.fields(), 1, "body")?;
    let payload = tuple(&body[0])?;
    match envelope.op_tag {
        OpTag::Hello => decode_hello(payload),
        OpTag::BootstrapAccounts => decode_bootstrap(payload),
        OpTag::Shutdown => decode_shutdown(payload),
        OpTag::ExecuteWave
        | OpTag::CommitRuntime
        | OpTag::AbortRuntime
        | OpTag::UpdateAccountShells
        | OpTag::RemoveAccounts
        | OpTag::ReadCapacityBatch
        | OpTag::ReadAccountSummaryPage
        | OpTag::ReadAccountEnvelope
        | OpTag::UpsertAccounts
        | OpTag::PrepareAccountWave
        | OpTag::BeginEntity
        | OpTag::ApplyAccountWave
        | OpTag::ProposeAccountWave
        | OpTag::Checkpoint
        | OpTag::FinalizeEntity
        | OpTag::DiscardEntity
        | OpTag::SealAccountWave
        | OpTag::GetCheckpointChanges
        | OpTag::CommitCheckpoint => Ok(Command::AuthorityTwoCallOnly),
        OpTag::BootstrapEntity => decode_bootstrap_entity(payload),
        OpTag::EntityRound => decode_entity_round(payload),
        OpTag::RestoreExact => decode_restore_exact(payload),
        other => Err(ProcessError::UnsupportedOp(other as u8)),
    }
}

fn decode_bootstrap_entity(fields: &[AbiValue]) -> Result<Command, ProcessError> {
    let fields = exact(fields, 1, "bootstrapEntity")?;
    Ok(Command::BootstrapEntity {
        snapshot: Box::new(crate::entity_wire::decode_entity_snapshot(&fields[0])?),
    })
}

fn decode_entity_round(fields: &[AbiValue]) -> Result<Command, ProcessError> {
    let fields = exact(fields, 7, "entityRound")?;
    let inbound = decode_account_ingress_request(tuple(&fields[0])?)?;
    let operations = (!inbound.rows.is_empty())
        .then_some(
            xln_rscore_entity_kernel::ResidentEntityOperation::AccountRange {
                start: 0,
                len: inbound.rows.len(),
            },
        )
        .into_iter()
        .collect();
    Ok(Command::EntityRound {
        request: Box::new(xln_rscore_entity_kernel::ResidentEntityRequest {
            inbound,
            local_certified_board_authority: xln_rscore_batch::AccountInputBoardAuthority::Lazy,
            entity_height: js_number(&fields[1], "entityHeight")?,
            outbound_timestamp: js_number(&fields[2], "outboundTimestamp")?,
            outbound_j_height: js_number(&fields[3], "outboundJHeight")?,
            checkpoint_due: strict_boolean(&fields[4], "checkpointDue")?,
            post_accounts: strict_boolean(&fields[5], "postAccounts")?,
            runtime_seed: None,
            scheduled_wake: None,
            expected_proposer_signer_id: String::new(),
            hub_rebalance_has_pending_work: false,
            finalized_j_events: None,
            entity_authority: None,
            local_account_genesis_policy: None,
            operations,
        }),
        context: Box::new(crate::entity_wire::decode_context(&fields[6])?),
    })
}

fn decode_hello(fields: &[AbiValue]) -> Result<Command, ProcessError> {
    let fields = exact(fields, 4, "hello")?;
    let version = unsigned(&fields[0], "processVersion")?;
    if version != PROCESS_ABI_VERSION {
        return Err(ProcessError::Version {
            actual: version,
            expected: PROCESS_ABI_VERSION,
        });
    }
    Ok(Command::Hello {
        worker_count: usize::try_from(unsigned(&fields[1], "workerCount")?)
            .map_err(|_| ProcessError::Expected("workerCount"))?,
        swap_market: decode_swap_market(&fields[2])?,
        authority: decode_authority_config(&fields[3])?,
    })
}

/// `(privateKey, signerId)` for the Account authority. `null` still decodes so
/// Hello can reject the retired non-authority role with one precise error.
fn decode_authority_config(value: &AbiValue) -> Result<Option<AuthorityConfig>, ProcessError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let fields = exact(tuple(value)?, 2, "authorityConfig")?;
    let private_key = fixed_bytes(&fields[0], "authorityPrivateKey")?;
    let signer_id = text(&fields[1])?.to_string();
    if private_key == [0_u8; 32] || signer_id.is_empty() {
        return Err(ProcessError::Expected("authorityConfig"));
    }
    Ok(Some(AuthorityConfig {
        private_key,
        signer_id,
    }))
}

/// Registry-derived market tables, installed once per session. The engine
/// cannot derive pair orientation or the price step from account state, and
/// duplicating the TypeScript registry here would be a second source of truth.
fn decode_swap_market(value: &AbiValue) -> Result<SwapMarketPolicy, ProcessError> {
    let fields = exact(tuple(value)?, 2, "swapMarketPolicy")?;
    let tokens = tuple(&fields[0])?
        .iter()
        .map(|row| {
            let row = exact(tuple(row)?, 3, "swapMarketToken")?;
            Ok(SwapToken {
                token_id: bounded_u32(&row[0], "tokenId")?,
                decimals: bounded_u32(&row[1], "decimals")?,
                liquid: integer(&row[2])? != 0,
            })
        })
        .collect::<Result<Vec<_>, ProcessError>>()?;
    let steps = tuple(&fields[1])?
        .iter()
        .map(|row| {
            let row = exact(tuple(row)?, 3, "swapMarketStep")?;
            Ok((
                (
                    bounded_u32(&row[0], "baseTokenId")?,
                    bounded_u32(&row[1], "quoteTokenId")?,
                ),
                bounded_u32(&row[2], "priceStepTicks")?,
            ))
        })
        .collect::<Result<Vec<_>, ProcessError>>()?;
    Ok(SwapMarketPolicy::new(tokens, steps))
}

fn decode_bootstrap(fields: &[AbiValue]) -> Result<Command, ProcessError> {
    let fields = exact(fields, 4, "bootstrapAccounts")?;
    let profile = text(&fields[0])?;
    if profile != PROCESS_PROFILE {
        return Err(ProcessError::Profile(profile.into()));
    }
    Ok(Command::BootstrapAccounts {
        revision: unsigned(&fields[1], "revision")?,
        accounts: tuple(&fields[2])?
            .iter()
            .map(decode_seed_account)
            .collect::<Result<_, _>>()?,
        import_existing: boolean(&fields[3], "importExisting")?,
    })
}

fn decode_restore_exact(fields: &[AbiValue]) -> Result<Command, ProcessError> {
    let (expected, accounts) = crate::checkpoint_wire::restore_request(fields)?;
    Ok(Command::RestoreExact { expected, accounts })
}

const MAX_WAVE_OP_ROWS: usize = 1_000_000;

pub(crate) fn decode_input_row(
    value: &AbiValue,
) -> Result<xln_rscore_batch::AccountInputRow, ProcessError> {
    let fields = exact(tuple(value)?, 5, "accountInput")?;
    let input = decode_account_input(&fields[2])?;
    let peer_entity_id = input.envelope.from_entity_id;
    let local_entity_id = input.envelope.to_entity_id;
    let authorities = exact(tuple(&fields[4])?, 2, "accountBoardAuthorities")?;
    Ok(xln_rscore_batch::AccountInputRow {
        operation_index: js_number(&fields[0], "operationIndex")?,
        account_id: AccountId::from_bytes(fixed_bytes(&fields[1], "accountId")?),
        genesis_policy: decode_entity_account_genesis_policy(&fields[3])?,
        certified_board_authority: decode_board_authority(
            &authorities[0],
            peer_entity_id,
            "peerBoardAuthority",
        )?,
        local_certified_board_authority: decode_board_authority(
            &authorities[1],
            local_entity_id,
            "localBoardAuthority",
        )?,
        input,
    })
}

fn decode_board_authority(
    value: &AbiValue,
    entity_id: [u8; 32],
    label: &'static str,
) -> Result<xln_rscore_batch::AccountInputBoardAuthority, ProcessError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(xln_rscore_batch::AccountInputBoardAuthority::Lazy);
    }
    let fields = exact(tuple(value)?, 5, label)?;
    Ok(xln_rscore_batch::AccountInputBoardAuthority::Certified(
        xln_rscore_engine::CertifiedBoardAuthority {
            entity_id,
            registered_board_hash: fixed_bytes(&fields[0], "registeredBoardHash")?,
            previous_board_hash: fixed_bytes(&fields[1], "previousBoardHash")?,
            previous_board_valid_until: js_number(&fields[2], "previousBoardValidUntil")?,
            activated_at_j_height: js_number(&fields[3], "activatedAtJHeight")?,
            activation_log_index: js_number(&fields[4], "activationLogIndex")?,
        },
    ))
}

fn decode_entity_account_genesis_policy(
    value: &AbiValue,
) -> Result<Option<xln_rscore_batch::EntityAccountGenesisPolicy>, ProcessError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let fields = exact(tuple(value)?, 5, "accountGenesisPolicy")?;
    let domain = exact(tuple(&fields[0])?, 2, "accountGenesisDomain")?;
    let shadow_policy_rows = tuple(&fields[2])?
        .iter()
        .map(|value| {
            let row = exact(tuple(value)?, 2, "accountGenesisPolicyRow")?;
            Ok((
                u32::try_from(js_number(&row[0], "accountGenesisPolicyToken")?)
                    .map_err(|_| ProcessError::Expected("accountGenesisPolicyToken"))?,
                crate::canonical::canonical_value(&row[1])?,
            ))
        })
        .collect::<Result<Vec<_>, ProcessError>>()?;
    Ok(Some(xln_rscore_batch::EntityAccountGenesisPolicy {
        expected_domain: AccountDomain::new(
            js_number(&domain[0], "accountGenesisChainId")?,
            DepositoryAddress::parse(&hex_fixed(&domain[1], "accountGenesisDepository", 20)?)?,
        )?,
        shadow_policy_root: fixed_bytes(&fields[1], "accountGenesisPolicyRoot")?,
        shadow_policy_rows,
        delta_transformer: fixed_bytes(&fields[3], "accountGenesisDeltaTransformer")?,
        public_pinned: strict_boolean(&fields[4], "accountGenesisPublicPinned")?,
    }))
}

fn decode_account_input(value: &AbiValue) -> Result<xln_rscore_batch::AccountInput, ProcessError> {
    let fields = exact(tuple(value)?, 6, "accountInputEnvelope")?;
    let domain = exact(tuple(&fields[2])?, 2, "accountInputDomain")?;
    let dispute = exact(tuple(&fields[3])?, 2, "accountInputDisputeConfig")?;
    let watch_seed = match &fields[4] {
        AbiValue::Nil => None,
        value => Some(WatchSeed::parse(&hex_fixed(value, "watchSeed", 32)?)?),
    };
    Ok(xln_rscore_batch::AccountInput {
        envelope: xln_rscore_engine::AccountInputEnvelope {
            from_entity_id: fixed_bytes(&fields[0], "fromEntityId")?,
            to_entity_id: fixed_bytes(&fields[1], "toEntityId")?,
            domain: AccountDomain::new(
                js_number(&domain[0], "chainId")?,
                DepositoryAddress::parse(&hex_fixed(&domain[1], "depositoryAddress", 20)?)?,
            )?,
            dispute_config: AccountDisputeConfig::new(
                js_number(&dispute[0], "leftResponseSeconds")?,
                js_number(&dispute[1], "rightResponseSeconds")?,
            )?,
            watch_seed,
        },
        kind: decode_input_kind(&fields[5])?,
    })
}

fn decode_account_ingress_request(
    fields: &[AbiValue],
) -> Result<xln_rscore_batch::EntityInboundRequest, ProcessError> {
    let fields = exact(fields, 5, "accountIngress")?;
    let rows = tuple(&fields[3])?;
    if rows.len() > MAX_WAVE_OP_ROWS {
        return Err(ProcessError::Expected("waveOpRows"));
    }
    let clock = exact(tuple(&fields[2])?, 2, "receiverClock")?;
    Ok(xln_rscore_batch::EntityInboundRequest {
        owner_entity_id: fixed_bytes(&fields[0], "ownerEntityId")?,
        expected_accounts_root: fixed_bytes(&fields[1], "expectedAccountsRoot")?,
        clock: xln_rscore_batch::ReceiverClock {
            entity_timestamp: js_number(&clock[0], "entityTimestamp")?,
            finalized_j_height: js_number(&clock[1], "finalizedJHeight")?,
        },
        rows: rows
            .iter()
            .map(decode_input_row)
            .collect::<Result<_, _>>()?,
        post_accounts: strict_boolean(&fields[4], "postAccounts")?,
    })
}

fn decode_input_kind(value: &AbiValue) -> Result<xln_rscore_batch::AccountInputKind, ProcessError> {
    let fields = tuple(value)?;
    let tag = fields.first().ok_or(ProcessError::Expected("inputTag"))?;
    match integer(tag)? {
        0 => {
            let fields = exact(fields, 3, "accountAckFrameInput")?;
            Ok(xln_rscore_batch::AccountInputKind::AckFrame {
                ack: match &fields[1] {
                    AbiValue::Nil => None,
                    value => Some(decode_incoming_ack(value)?),
                },
                frame: Box::new(decode_incoming_frame(&fields[2])?),
            })
        }
        1 => {
            let fields = exact(fields, 2, "accountAckInput")?;
            Ok(xln_rscore_batch::AccountInputKind::Ack(
                decode_incoming_ack(&fields[1])?,
            ))
        }
        value => Err(ProcessError::Tag {
            field: "accountInput",
            value,
        }),
    }
}

fn decode_incoming_frame(
    value: &AbiValue,
) -> Result<xln_rscore_engine::IncomingFrame, ProcessError> {
    let proposal = exact(tuple(value)?, 3, "incomingProposal")?;
    let frame = exact(tuple(&proposal[0])?, 7, "incomingFrame")?;
    Ok(xln_rscore_engine::IncomingFrame {
        frame: AccountFrame {
            height: js_number(&frame[0], "height")?,
            timestamp: js_number(&frame[1], "timestamp")?,
            j_height: js_number(&frame[2], "jHeight")?,
            txs: tuple(&frame[3])?
                .iter()
                .map(decode_tx)
                .collect::<Result<_, _>>()?,
            prev_frame_hash: text(&frame[4])?.into(),
            account_state_root: fixed_bytes(&frame[5], "accountStateRoot")?,
        },
        state_hash: fixed_bytes(&frame[6], "stateHash")?,
        frame_hanko: optional_bytes(&proposal[1], "frameHanko")?,
        dispute: decode_counterparty_dispute(&proposal[2])?,
    })
}

fn decode_incoming_ack(value: &AbiValue) -> Result<xln_rscore_engine::IncomingAck, ProcessError> {
    let fields = exact(tuple(value)?, 4, "incomingAck")?;
    Ok(xln_rscore_engine::IncomingAck {
        height: js_number(&fields[0], "height")?,
        frame_hash: fixed_bytes(&fields[1], "frameHash")?,
        frame_hanko: optional_bytes(&fields[2], "frameHanko")?,
        dispute: decode_counterparty_dispute(&fields[3])?,
    })
}

fn decode_shutdown(fields: &[AbiValue]) -> Result<Command, ProcessError> {
    exact(fields, 0, "shutdown")?;
    Ok(Command::Shutdown)
}

pub(crate) fn decode_seed_account(value: &AbiValue) -> Result<AccountSeed, ProcessError> {
    let fields = exact(tuple(value)?, 15, "accountSeed")?;
    let account_id = AccountId::from_bytes(fixed_bytes(&fields[0], "accountId")?);
    let owner = entity(&fields[1], "owner")?;
    // The account id IS the counterparty entity id: one engine process serves
    // exactly one owner entity, so its account tree is keyed the same way the
    // TypeScript entity keys its account map (raw 32-byte counterparty id, no
    // hashing). Anything else would produce a different tree shape and a
    // different accounts root than the entity machine computes.
    let left = entity(&fields[2], "left")?;
    let right = entity(&fields[3], "right")?;
    let counterparty = if owner == left { &right } else { &left };
    if account_id.as_bytes() != counterparty.as_bytes() {
        return Err(ProcessError::Expected("accountIdIsCounterparty"));
    }
    let identity = AccountIdentity::new(
        AccountDomain::new(
            js_number(&fields[4], "chainId")?,
            DepositoryAddress::parse(&hex_fixed(&fields[5], "depository", 20)?)?,
        )?,
        left.clone(),
        right.clone(),
        WatchSeed::parse(&hex_fixed(&fields[6], "watchSeed", 32)?)?,
    )?;
    let dispute = exact(tuple(&fields[7])?, 2, "disputeConfig")?;
    let dispute_config = AccountDisputeConfig::new(
        js_number(&dispute[0], "leftResponseSeconds")?,
        js_number(&dispute[1], "rightResponseSeconds")?,
    )?;
    let deltas = tuple(&fields[8])?
        .iter()
        .map(decode_delta)
        .collect::<Result<_, _>>()?;
    let locks = tuple(&fields[9])?
        .iter()
        .map(decode_lock)
        .collect::<Result<_, _>>()?;
    let journal = exact(tuple(&fields[10])?, 2, "journal")?;
    let mut replica = AccountReplica::new(
        owner,
        AccountState::restore_full(AccountStateSeed {
            identity,
            dispute_config,
            deltas,
            locks,
            j_nonce: js_number(&journal[0], "jNonce")?,
            last_finalized_j_height: js_number(&journal[1], "lastFinalizedJHeight")?,
            carried: decode_carried_sections(&fields[11])?,
            rebalance_fee_policies: decode_rebalance_policies(&fields[11])?,
            swap_offers: decode_swap_offers(&fields[11])?,
            pulls: decode_pulls(&fields[11])?,
            // The wire seed carries no lending intents: no supported account
            // transaction opens one, so a seeded account starts without any.
            // A checkpoint restore fills this from what it saved.
            lending_intents: Vec::new(),
            settlement_workspace: decode_settlement_workspace(&fields[11])?,
        })?,
    )?;
    if let Some(envelope) = crate::canonical::envelope(&fields[12])? {
        replica.set_envelope(envelope);
    }
    // Present when this session builds its own recovery proofs; a mirror seed
    // may leave it out only for an Account whose jurisdiction defines no
    // transformer.
    if !matches!(&fields[14], AbiValue::Nil) {
        replica.set_delta_transformer(fixed_bytes(&fields[14], "deltaTransformer")?);
    }
    Ok(AccountSeed {
        account_id,
        replica,
        consensus: decode_consensus_snapshot(&fields[13])?,
    })
}

/// Where the Account stands in its own consensus, or `null` only for genesis.
/// Recovery must carry the snapshot or authority would propose height one
/// against an Account the Entity already holds at a later height.
fn decode_consensus_snapshot(
    value: &AbiValue,
) -> Result<Option<xln_rscore_engine::ConsensusSnapshot>, ProcessError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    Ok(Some(crate::checkpoint_wire::decode_consensus(value)?))
}

/// The proposal this side signed and has not been acked for, whole. The engine
/// replays it against the committed replica and refuses a snapshot whose frame
/// does not reproduce its own hash.
/// The recovery proof this account already stands behind, or `null` for an
/// account that has never proposed. The engine replaces it when a frame moves
/// the state, and spends the next nonce when it does.
/// The counterparty's proof exactly as received. The claimed hash is retained
/// so the engine can rebuild it independently and reject a mismatch before it
/// authenticates or stores the witness.
pub(crate) fn decode_counterparty_dispute(
    value: &AbiValue,
) -> Result<Option<xln_rscore_engine::CounterpartyDispute>, ProcessError> {
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

fn optional_bytes(value: &AbiValue, field: &'static str) -> Result<Option<Vec<u8>>, ProcessError> {
    match value {
        AbiValue::Nil => Ok(None),
        AbiValue::Bytes(value) => Ok(Some(value.clone())),
        _ => Err(ProcessError::Expected(field)),
    }
}

fn strict_boolean(value: &AbiValue, field: &'static str) -> Result<bool, ProcessError> {
    match value {
        AbiValue::Bool(value) => Ok(*value),
        _ => Err(ProcessError::Expected(field)),
    }
}

pub(crate) fn decode_dispute_draft(
    value: &AbiValue,
) -> Result<Option<xln_rscore_engine::DisputeDraft>, ProcessError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let row = exact(tuple(value)?, 5, "disputeDraft")?;
    Ok(Some(xln_rscore_engine::DisputeDraft {
        hanko: optional_bytes(&row[0], "disputeHanko")?,
        hash: fixed_bytes(&row[1], "disputeHash")?,
        proof_body_hash: fixed_bytes(&row[2], "disputeProofBodyHash")?,
        nonce: js_number(&row[3], "disputeProofNonce")?,
        proposer_is_left: boolean(&row[4], "disputeProposerIsLeft")?,
    }))
}

pub(crate) fn decode_outbound_ack(
    value: &AbiValue,
    field: &'static str,
) -> Result<Option<xln_rscore_engine::OutboundAck>, ProcessError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let row = exact(tuple(value)?, 4, field)?;
    let frame_hanko = bytes(&row[2], "ackFrameHanko")?.to_vec();
    if frame_hanko.is_empty() {
        return Err(ProcessError::Expected("ackFrameHanko"));
    }
    Ok(Some(xln_rscore_engine::OutboundAck {
        height: js_number(&row[0], "ackHeight")?,
        frame_hash: fixed_bytes(&row[1], "ackFrameHash")?,
        frame_hanko,
        dispute: decode_dispute_draft(&row[3])?,
    }))
}

/// Sections the engine still carries without interpreting. Pulls are decoded
/// separately from slot zero because native Account handlers own their body.
pub(crate) fn decode_carried_sections(value: &AbiValue) -> Result<CarriedSections, ProcessError> {
    let fields = exact(tuple(value)?, 9, "carriedSections")?;
    Ok(CarriedSections {
        pulls_root: [0; 32],
        subcontracts_root: fixed_bytes(&fields[2], "subcontractsRoot")?,
        requested_rebalance_root: fixed_bytes(&fields[3], "requestedRebalanceRoot")?,
        requested_rebalance_fee_state_root: fixed_bytes(
            &fields[4],
            "requestedRebalanceFeeStateRoot",
        )?,
        left_pending_j_claims: decode_claim_accumulator(&fields[6])?,
        right_pending_j_claims: decode_claim_accumulator(&fields[7])?,
    })
}

fn decode_settlement_workspace(
    value: &AbiValue,
) -> Result<Option<xln_rscore_engine::CanonicalValue>, ProcessError> {
    let fields = exact(tuple(value)?, 9, "carriedSections")?;
    if matches!(&fields[8], AbiValue::Nil) {
        return Ok(None);
    }
    let workspace = crate::canonical::canonical_value(&fields[8])?;
    if !matches!(workspace, xln_rscore_engine::CanonicalValue::Object(_)) {
        return Err(ProcessError::Expected("settlementWorkspace"));
    }
    Ok(Some(workspace))
}

pub(crate) fn decode_pulls(
    value: &AbiValue,
) -> Result<Vec<(String, xln_rscore_engine::CanonicalValue)>, ProcessError> {
    let fields = exact(tuple(value)?, 9, "carriedSections")?;
    tuple(&fields[0])?
        .iter()
        .map(|entry| {
            let row = exact(tuple(entry)?, 2, "seedPull")?;
            let pull_id = text(&row[0])?.to_owned();
            let pull = crate::canonical::canonical_value(&row[1])?;
            let object = match &pull {
                xln_rscore_engine::CanonicalValue::Object(fields) => fields,
                _ => return Err(ProcessError::Expected("seedPullObject")),
            };
            let embedded = object
                .iter()
                .find(|(key, _)| key == "pullId")
                .and_then(|(_, value)| match value {
                    xln_rscore_engine::CanonicalValue::String(value) => Some(value.as_str()),
                    _ => None,
                })
                .ok_or(ProcessError::Expected("seedPullId"))?;
            if embedded != pull_id {
                return Err(ProcessError::Expected("seedPullIdMatchesKey"));
            }
            Ok((pull_id, pull))
        })
        .collect()
}

/// Slot 1 of the carried tuple is no longer a carried root either: the engine
/// owns the resting same-jurisdiction offers and recomputes their root.
pub(crate) fn decode_swap_offers(value: &AbiValue) -> Result<Vec<SwapOffer>, ProcessError> {
    let fields = exact(tuple(value)?, 9, "carriedSections")?;
    tuple(&fields[1])?
        .iter()
        .map(decode_seed_swap_offer)
        .collect()
}

/// Bootstrap receives the complete resting offer. Quantized lots equal the
/// resting amounts only at live cutover; exact recovery preserves them below.
fn decode_seed_swap_offer(value: &AbiValue) -> Result<SwapOffer, ProcessError> {
    let row = exact(tuple(value)?, 14, "seedSwapOffer")?;
    let give_amount = bigint(&row[3], "giveAmount")?;
    let want_amount = bigint(&row[6], "wantAmount")?;
    let mut offer = decode_swap_offer_fields(row, give_amount.clone(), want_amount.clone())?;
    offer.restore_quantized(give_amount, want_amount)?;
    offer.set_cross_jurisdiction(optional_canonical_object(
        &row[13],
        "seedSwapOfferCrossJurisdiction",
    )?);
    Ok(offer)
}

pub(crate) fn decode_swap_offer_state(value: &AbiValue) -> Result<SwapOffer, ProcessError> {
    let row = exact(tuple(value)?, 16, "swapOffer")?;
    let mut offer = decode_swap_offer_fields(
        row,
        bigint(&row[3], "giveAmount")?,
        bigint(&row[6], "wantAmount")?,
    )?;
    offer.restore_quantized(
        bigint(&row[13], "quantizedGive")?,
        bigint(&row[14], "quantizedWant")?,
    )?;
    offer.set_cross_jurisdiction(optional_canonical_object(
        &row[15],
        "swapOfferCrossJurisdiction",
    )?);
    Ok(offer)
}

fn optional_canonical_object(
    value: &AbiValue,
    field: &'static str,
) -> Result<Option<xln_rscore_engine::CanonicalValue>, ProcessError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let value = crate::canonical::canonical_value(value)?;
    if !matches!(value, xln_rscore_engine::CanonicalValue::Object(_)) {
        return Err(ProcessError::Expected(field));
    }
    Ok(Some(value))
}

fn decode_swap_offer_fields(
    row: &[AbiValue],
    give_amount: BigInt,
    want_amount: BigInt,
) -> Result<SwapOffer, ProcessError> {
    Ok(SwapOffer::new(
        text(&row[0])?.into(),
        bounded_u32(&row[1], "giveTokenId")?,
        bounded_u32(&row[2], "giveTokenDecimals")?,
        give_amount,
        bounded_u32(&row[4], "wantTokenId")?,
        bounded_u32(&row[5], "wantTokenDecimals")?,
        want_amount,
        bigint(&row[7], "maxFee")?,
        bigint(&row[8], "minNetReceive")?,
        bigint(&row[9], "priceTicks")?,
        match &row[10] {
            AbiValue::Nil => None,
            value => Some(
                u8::try_from(bounded_u32(value, "timeInForce")?)
                    .map_err(|_| ProcessError::Expected("timeInForce"))?,
            ),
        },
        match integer(&row[11])? {
            0 => true,
            1 => false,
            value => {
                return Err(ProcessError::Tag {
                    field: "makerIsLeft",
                    value,
                });
            }
        },
        js_number(&row[12], "createdHeight")?,
    ))
}

/// Optional bigints stay optional: absent is not zero for the resting-terms
/// and exact-ratio checks.
fn optional_bigint(value: &AbiValue, field: &'static str) -> Result<Option<BigInt>, ProcessError> {
    match value {
        AbiValue::Nil => Ok(None),
        value => Ok(Some(bigint(value, field)?)),
    }
}

fn optional_u32(value: &AbiValue, field: &'static str) -> Result<Option<u32>, ProcessError> {
    match value {
        AbiValue::Nil => Ok(None),
        value => Ok(Some(bounded_u32(value, field)?)),
    }
}

fn decode_swap_resolve(fields: &[AbiValue]) -> Result<AccountTx, ProcessError> {
    let fields = exact(fields, 18, "swapResolve")?;
    Ok(AccountTx::SwapResolve {
        offer_id: text(&fields[1])?.into(),
        fill_ratio: bounded_u32(&fields[2], "fillRatio")?,
        fill_numerator: optional_bigint(&fields[3], "fillNumerator")?,
        fill_denominator: optional_bigint(&fields[4], "fillDenominator")?,
        cancel_remainder: match integer(&fields[5])? {
            0 => false,
            1 => true,
            value => {
                return Err(ProcessError::Tag {
                    field: "cancelRemainder",
                    value,
                });
            }
        },
        comment: optional_text(&fields[6])?,
        resting_give_token_id: optional_u32(&fields[7], "restingGiveTokenId")?,
        resting_want_token_id: optional_u32(&fields[8], "restingWantTokenId")?,
        fee_token_id: optional_u32(&fields[9], "feeTokenId")?,
        fee_amount: optional_bigint(&fields[10], "feeAmount")?,
        execution_give_amount: optional_bigint(&fields[11], "executionGiveAmount")?,
        execution_want_amount: optional_bigint(&fields[12], "executionWantAmount")?,
        resting_price_ticks: optional_bigint(&fields[13], "restingPriceTicks")?,
        resting_give_amount: optional_bigint(&fields[14], "restingGiveAmount")?,
        resting_want_amount: optional_bigint(&fields[15], "restingWantAmount")?,
        resting_quantized_give: optional_bigint(&fields[16], "restingQuantizedGive")?,
        resting_quantized_want: optional_bigint(&fields[17], "restingQuantizedWant")?,
    })
}

fn decode_swap_cancel_request(fields: &[AbiValue]) -> Result<AccountTx, ProcessError> {
    let fields = exact(fields, 2, "swapCancelRequest")?;
    Ok(AccountTx::SwapCancelRequest {
        offer_id: text(&fields[1])?.into(),
    })
}

/// Slot 5 of the carried tuple is no longer a carried root: the engine owns
/// the rebalance fee registers, so the seed ships their full contents and the
/// root is recomputed here.
pub(crate) fn decode_rebalance_policies(
    value: &AbiValue,
) -> Result<Vec<(TokenId, BilateralRebalanceFeePolicy)>, ProcessError> {
    let fields = exact(tuple(value)?, 9, "carriedSections")?;
    tuple(&fields[5])?
        .iter()
        .map(|row| {
            let row = exact(tuple(row)?, 3, "rebalanceFeePolicy")?;
            Ok((
                token(&row[0])?,
                BilateralRebalanceFeePolicy::new(
                    decode_policy_snapshot(&row[1])?,
                    decode_policy_snapshot(&row[2])?,
                ),
            ))
        })
        .collect()
}

fn decode_policy_snapshot(
    value: &AbiValue,
) -> Result<Option<RebalanceFeePolicySnapshot>, ProcessError> {
    let fields = tuple(value)?;
    if fields.is_empty() {
        return Ok(None);
    }
    let fields = exact(fields, 5, "rebalanceFeePolicySnapshot")?;
    Ok(Some(RebalanceFeePolicySnapshot::new(
        js_number(&fields[0], "policyVersion")?,
        bigint(&fields[1], "baseFee")?,
        bigint(&fields[2], "liquidityFeeBps")?,
        bigint(&fields[3], "gasFee")?,
        js_number(&fields[4], "updatedAt")?,
    )))
}

fn decode_claim_accumulator(value: &AbiValue) -> Result<JClaimAccumulator, ProcessError> {
    let fields = exact(tuple(value)?, 2, "jClaimAccumulator")?;
    Ok(JClaimAccumulator {
        root: fixed_bytes(&fields[0], "jClaimRoot")?,
        count: unsigned(&fields[1], "jClaimCount")?,
    })
}

pub(crate) fn decode_lock(value: &AbiValue) -> Result<HtlcLock, ProcessError> {
    let fields = exact(tuple(value)?, 10, "htlcState")?;
    Ok(HtlcLock::restore(
        text(&fields[0])?.into(),
        HtlcHashlock::parse(&hex_fixed(&fields[1], "hashlock", 32)?)?,
        bigint(&fields[2], "timelock")?,
        js_number(&fields[3], "revealBeforeHeight")?,
        bigint(&fields[4], "amount")?,
        token(&fields[5])?,
        side(&fields[6], "sender")?,
        js_number(&fields[7], "createdHeight")?,
        js_number(&fields[8], "createdTimestamp")?,
        optional_fixed_bytes(&fields[9], "envelopeHash")?,
    )?)
}

pub(crate) fn decode_delta(value: &AbiValue) -> Result<Delta, ProcessError> {
    let fields = exact(tuple(value)?, 10, "delta")?;
    Ok(Delta::new(
        token(&fields[0])?,
        bigint(&fields[1], "collateral")?,
        bigint(&fields[2], "ondelta")?,
        bigint(&fields[3], "offdelta")?,
        bigint(&fields[4], "leftCreditLimit")?,
        bigint(&fields[5], "rightCreditLimit")?,
        bigint(&fields[6], "leftAllowance")?,
        bigint(&fields[7], "rightAllowance")?,
        bigint(&fields[8], "leftHold")?,
        bigint(&fields[9], "rightHold")?,
    )?)
}

pub(crate) fn decode_tx(value: &AbiValue) -> Result<AccountTx, ProcessError> {
    let fields = tuple(value)?;
    let tag = fields.first().ok_or(ProcessError::Expected("txTag"))?;
    match integer(tag)? {
        0 => decode_direct(fields),
        1 => decode_htlc_lock(fields),
        2 => decode_htlc_resolve(fields),
        3 => decode_add_delta(fields),
        4 => decode_set_credit_limit(fields),
        5 => decode_rebalance_policy(fields),
        6 => decode_swap_offer(fields),
        7 => decode_swap_cancel_request(fields),
        8 => decode_swap_resolve(fields),
        9 => decode_j_event_claim(fields),
        10 => decode_lending_fund(fields),
        11 => decode_lending_borrow_request(fields),
        12 => decode_lending_repay(fields),
        13 => decode_lending_credit(fields),
        14 => decode_lending_close_request(fields),
        15 => decode_lending_close_payout(fields),
        16 => decode_reserve_to_collateral(fields),
        17 => decode_request_collateral(fields),
        18 => decode_rebalance_refund(fields),
        19 => decode_canonical_tx(fields, "crossPullLock", |data| AccountTx::CrossPullLock {
            data,
        }),
        20 => decode_canonical_tx(fields, "crossPullClose", |data| AccountTx::CrossPullClose {
            data,
        }),
        21 => decode_canonical_tx(fields, "crossPullProgress", |data| {
            AccountTx::CrossPullProgress { data }
        }),
        22 => decode_canonical_tx(fields, "crossSwapFillAck", |data| {
            AccountTx::CrossSwapFillAck { data }
        }),
        23 => decode_canonical_tx(fields, "settleTransition", |data| {
            AccountTx::SettleTransition { data }
        }),
        value => Err(ProcessError::Tag { field: "tx", value }),
    }
}

fn decode_canonical_tx(
    fields: &[AbiValue],
    field: &'static str,
    build: impl FnOnce(xln_rscore_engine::CanonicalValue) -> AccountTx,
) -> Result<AccountTx, ProcessError> {
    let fields = exact(fields, 2, field)?;
    let data = crate::canonical::canonical_value(&fields[1])?;
    if !matches!(data, xln_rscore_engine::CanonicalValue::Object(_)) {
        return Err(ProcessError::Expected(field));
    }
    Ok(build(data))
}

fn decode_lending_term(value: &AbiValue) -> Result<LendingTermId, ProcessError> {
    match integer(value)? {
        0 => Ok(LendingTermId::OneHour),
        1 => Ok(LendingTermId::OneDay),
        2 => Ok(LendingTermId::OneMonth),
        value => Err(ProcessError::Tag {
            field: "lendingTerm",
            value,
        }),
    }
}

fn decode_lending_fund(fields: &[AbiValue]) -> Result<AccountTx, ProcessError> {
    let fields = exact(fields, 8, "lendingFund")?;
    Ok(AccountTx::LendingFund {
        position_id: text(&fields[1])?.into(),
        hub_entity_id: text(&fields[2])?.into(),
        lender_entity_id: text(&fields[3])?.into(),
        token_id: token(&fields[4])?,
        amount: bigint(&fields[5], "amount")?,
        term_id: decode_lending_term(&fields[6])?,
        interest_bps: i64::try_from(integer(&fields[7])?)
            .map_err(|_| ProcessError::Expected("interestBps"))?,
    })
}

fn decode_lending_borrow_request(fields: &[AbiValue]) -> Result<AccountTx, ProcessError> {
    let fields = exact(fields, 8, "lendingBorrowRequest")?;
    Ok(AccountTx::LendingBorrowRequest {
        request_id: text(&fields[1])?.into(),
        hub_entity_id: text(&fields[2])?.into(),
        borrower_entity_id: text(&fields[3])?.into(),
        token_id: unsigned(&fields[4], "tokenId")?,
        amount: bigint(&fields[5], "amount")?,
        term_id: decode_lending_term(&fields[6])?,
        max_interest_bps: i64::try_from(integer(&fields[7])?)
            .map_err(|_| ProcessError::Expected("maxInterestBps"))?,
    })
}

fn decode_lending_repay(fields: &[AbiValue]) -> Result<AccountTx, ProcessError> {
    let fields = exact(fields, 6, "lendingRepay")?;
    Ok(AccountTx::LendingRepay {
        loan_id: text(&fields[1])?.into(),
        hub_entity_id: text(&fields[2])?.into(),
        borrower_entity_id: text(&fields[3])?.into(),
        token_id: token(&fields[4])?,
        amount: bigint(&fields[5], "amount")?,
    })
}

fn decode_lending_credit(fields: &[AbiValue]) -> Result<AccountTx, ProcessError> {
    let fields = exact(fields, 7, "lendingCredit")?;
    Ok(AccountTx::LendingCredit {
        action: match integer(&fields[1])? {
            0 => LendingAction::Grant,
            1 => LendingAction::Revoke,
            value => {
                return Err(ProcessError::Tag {
                    field: "lendingAction",
                    value,
                });
            }
        },
        loan_id: text(&fields[2])?.into(),
        hub_entity_id: text(&fields[3])?.into(),
        borrower_entity_id: text(&fields[4])?.into(),
        token_id: token(&fields[5])?,
        credit_limit: bigint(&fields[6], "creditLimit")?,
    })
}

fn decode_lending_close_request(fields: &[AbiValue]) -> Result<AccountTx, ProcessError> {
    let fields = exact(fields, 4, "lendingCloseRequest")?;
    Ok(AccountTx::LendingCloseRequest {
        position_id: text(&fields[1])?.into(),
        hub_entity_id: text(&fields[2])?.into(),
        lender_entity_id: text(&fields[3])?.into(),
    })
}

fn decode_lending_close_payout(fields: &[AbiValue]) -> Result<AccountTx, ProcessError> {
    let fields = exact(fields, 6, "lendingClosePayout")?;
    Ok(AccountTx::LendingClosePayout {
        position_id: text(&fields[1])?.into(),
        hub_entity_id: text(&fields[2])?.into(),
        lender_entity_id: text(&fields[3])?.into(),
        token_id: token(&fields[4])?,
        amount: bigint(&fields[5], "amount")?,
    })
}

fn decode_reserve_to_collateral(fields: &[AbiValue]) -> Result<AccountTx, ProcessError> {
    let fields = exact(fields, 7, "reserveToCollateral")?;
    Ok(AccountTx::ReserveToCollateral {
        token_id: token(&fields[1])?,
        collateral: text(&fields[2])?.into(),
        ondelta: text(&fields[3])?.into(),
        side: match integer(&fields[4])? {
            0 => ReserveSide::Receiving,
            1 => ReserveSide::Counterparty,
            value => {
                return Err(ProcessError::Tag {
                    field: "reserveSide",
                    value,
                });
            }
        },
        block_number: i64::try_from(integer(&fields[5])?)
            .map_err(|_| ProcessError::Expected("blockNumber"))?,
        transaction_hash: text(&fields[6])?.into(),
    })
}

fn decode_request_collateral(fields: &[AbiValue]) -> Result<AccountTx, ProcessError> {
    let fields = exact(fields, 6, "requestCollateral")?;
    Ok(AccountTx::RequestCollateral {
        token_id: token(&fields[1])?,
        amount: bigint(&fields[2], "amount")?,
        fee_token_id: match &fields[3] {
            AbiValue::Nil => None,
            value => Some(token(value)?),
        },
        fee_amount: bigint(&fields[4], "feeAmount")?,
        policy_version: js_number(&fields[5], "policyVersion")?,
    })
}

fn decode_rebalance_refund(fields: &[AbiValue]) -> Result<AccountTx, ProcessError> {
    let fields = exact(fields, 5, "rebalanceRefund")?;
    let reason = match text(&fields[4])? {
        "policy_mismatch" => RebalanceRefundReason::PolicyMismatch,
        "timeout" => RebalanceRefundReason::Timeout,
        "fee_too_low" => RebalanceRefundReason::FeeTooLow,
        "manual" => RebalanceRefundReason::Manual,
        _ => return Err(ProcessError::Expected("rebalanceRefundReason")),
    };
    Ok(AccountTx::RebalanceRefund {
        request_id: text(&fields[1])?.into(),
        request_token_id: token(&fields[2])?,
        amount: bigint(&fields[3], "amount")?,
        reason,
    })
}

fn decode_j_event_claim(fields: &[AbiValue]) -> Result<AccountTx, ProcessError> {
    let fields = exact(fields, 7, "jEventClaim")?;
    let events = tuple(&fields[4])?
        .iter()
        .map(decode_jurisdiction_event)
        .collect::<Result<Vec<_>, _>>()?;
    let supplied_events_hash = fixed_bytes(&fields[3], "jClaimEventsHash")?;
    let actual_events_hash = xln_rscore_engine::canonical_events_hash(&events)?;
    if supplied_events_hash != actual_events_hash {
        return Err(ProcessError::Expected("jClaimEventsHashMismatch"));
    }
    Ok(AccountTx::JEventClaim(JEventClaimTx {
        j_height: js_number(&fields[1], "jClaimHeight")?,
        j_block_hash: fixed_bytes(&fields[2], "jClaimBlockHash")?,
        events,
        left_proof: decode_j_claim_proof(&fields[5], "leftJClaimProof")?,
        right_proof: decode_j_claim_proof(&fields[6], "rightJClaimProof")?,
    }))
}

fn decode_jurisdiction_event(value: &AbiValue) -> Result<JurisdictionEvent, ProcessError> {
    xln_rscore_batch::decode_jurisdiction_event(value)
        .map_err(|error| ProcessError::Unsupported(error.to_string()))
}

fn decode_j_claim_proof(
    value: &AbiValue,
    field: &'static str,
) -> Result<Option<JClaimProof>, ProcessError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let fields = exact(tuple(value)?, 2, field)?;
    if integer(&fields[0])? != 1 {
        return Err(ProcessError::Expected("jClaimProofVersion"));
    }
    Ok(Some(JClaimProof {
        nodes: tuple(&fields[1])?
            .iter()
            .map(decode_j_claim_node)
            .collect::<Result<_, _>>()?,
    }))
}

pub(crate) fn decode_j_claim_node(value: &AbiValue) -> Result<JClaimNode, ProcessError> {
    let fields = tuple(value)?;
    match fields
        .first()
        .map(integer)
        .transpose()?
        .ok_or(ProcessError::Expected("jClaimNodeTag"))?
    {
        0 => {
            let fields = exact(fields, 3, "jClaimLeaf")?;
            Ok(JClaimNode::Leaf {
                key: fixed_bytes(&fields[1], "jClaimLeafKey")?,
                record: decode_j_claim_record(&fields[2])?,
            })
        }
        1 => {
            let fields = exact(fields, 4, "jClaimBranch")?;
            let bit = bounded_u32(&fields[1], "jClaimBranchBit")?;
            Ok(JClaimNode::Branch {
                bit: u16::try_from(bit).map_err(|_| ProcessError::Expected("jClaimBranchBit"))?,
                left: fixed_bytes(&fields[2], "jClaimBranchLeft")?,
                right: fixed_bytes(&fields[3], "jClaimBranchRight")?,
            })
        }
        value => Err(ProcessError::Tag {
            field: "jClaimNode",
            value,
        }),
    }
}

fn decode_j_claim_record(value: &AbiValue) -> Result<JClaimRecord, ProcessError> {
    let fields = exact(tuple(value)?, 5, "jClaimRecord")?;
    let side = match integer(&fields[1])? {
        0 => JClaimSide::Left,
        1 => JClaimSide::Right,
        value => {
            return Err(ProcessError::Tag {
                field: "jClaimSide",
                value,
            });
        }
    };
    Ok(JClaimRecord {
        account_key: fixed_bytes(&fields[0], "jClaimAccountKey")?,
        side,
        j_height: js_number(&fields[2], "jClaimRecordHeight")?,
        j_block_hash: fixed_bytes(&fields[3], "jClaimRecordBlockHash")?,
        events_hash: fixed_bytes(&fields[4], "jClaimRecordEventsHash")?,
    })
}

fn decode_add_delta(fields: &[AbiValue]) -> Result<AccountTx, ProcessError> {
    let fields = exact(fields, 2, "addDelta")?;
    Ok(AccountTx::AddDelta {
        token_id: token(&fields[1])?,
    })
}

fn decode_set_credit_limit(fields: &[AbiValue]) -> Result<AccountTx, ProcessError> {
    let fields = exact(fields, 3, "setCreditLimit")?;
    Ok(AccountTx::SetCreditLimit {
        token_id: token(&fields[1])?,
        amount: bigint(&fields[2], "amount")?,
    })
}

fn decode_rebalance_policy(fields: &[AbiValue]) -> Result<AccountTx, ProcessError> {
    let fields = exact(fields, 6, "rebalancePolicy")?;
    Ok(AccountTx::RebalancePolicy {
        token_id: bounded_u32(&fields[1], "tokenId")?,
        policy_version: js_number(&fields[2], "policyVersion")?,
        base_fee: bigint(&fields[3], "baseFee")?,
        liquidity_fee_bps: bigint(&fields[4], "liquidityFeeBps")?,
        gas_fee: bigint(&fields[5], "gasFee")?,
    })
}

fn decode_swap_offer(fields: &[AbiValue]) -> Result<AccountTx, ProcessError> {
    let fields = exact(fields, 13, "swapOffer")?;
    Ok(AccountTx::SwapOffer {
        offer_id: text(&fields[1])?.into(),
        give_token_id: bounded_u32(&fields[2], "giveTokenId")?,
        give_token_decimals: bounded_u32(&fields[3], "giveTokenDecimals")?,
        give_amount: bigint(&fields[4], "giveAmount")?,
        want_token_id: bounded_u32(&fields[5], "wantTokenId")?,
        want_token_decimals: bounded_u32(&fields[6], "wantTokenDecimals")?,
        want_amount: bigint(&fields[7], "wantAmount")?,
        max_fee: bigint(&fields[8], "maxFee")?,
        min_net_receive: bigint(&fields[9], "minNetReceive")?,
        time_in_force: match &fields[10] {
            AbiValue::Nil => None,
            value => Some(
                u8::try_from(bounded_u32(value, "timeInForce")?)
                    .map_err(|_| ProcessError::Expected("timeInForce"))?,
            ),
        },
        price_ticks: optional_bigint(&fields[11], "priceTicks")?,
        cross_jurisdiction: match &fields[12] {
            AbiValue::Nil => None,
            value => Some(crate::canonical::canonical_value(value)?),
        },
    })
}

fn decode_direct(fields: &[AbiValue]) -> Result<AccountTx, ProcessError> {
    let fields = exact(fields, 9, "directPayment")?;
    Ok(AccountTx::DirectPayment {
        token_id: token(&fields[1])?,
        amount: bigint(&fields[2], "amount")?,
        route: text_list(&fields[3])?,
        description: optional_text(&fields[4])?,
        from_entity_id: text(&fields[5])?.into(),
        to_entity_id: text(&fields[6])?.into(),
        delivery_mode: delivery(&fields[7])?,
        trusted_gateway_entity_id: optional_text(&fields[8])?,
    })
}

fn decode_htlc_lock(fields: &[AbiValue]) -> Result<AccountTx, ProcessError> {
    let fields = exact(fields, 9, "htlcLock")?;
    let hashlock = hex_fixed(&fields[2], "hashlock", 32)?;
    Ok(AccountTx::HtlcLock(HtlcLockTx {
        lock_id: text(&fields[1])?.into(),
        hashlock: HtlcHashlock::parse(&hashlock)?,
        timelock: bigint(&fields[3], "timelock")?,
        reveal_before_height: js_number(&fields[4], "revealBeforeHeight")?,
        amount: bigint(&fields[5], "amount")?,
        token_id: token(&fields[6])?,
        delivery_mode: optional_delivery(&fields[7])?,
        envelope: optional_envelope(&fields[8])?,
    }))
}

fn decode_htlc_resolve(fields: &[AbiValue]) -> Result<AccountTx, ProcessError> {
    let fields = exact(fields, 4, "htlcResolve")?;
    let outcome = match integer(&fields[2])? {
        0 => HtlcResolveOutcome::Secret {
            secret: hex_fixed(&fields[3], "secret", 32)?,
        },
        1 => HtlcResolveOutcome::Error {
            reason: optional_text(&fields[3])?,
        },
        value => {
            return Err(ProcessError::Tag {
                field: "htlcOutcome",
                value,
            });
        }
    };
    Ok(AccountTx::HtlcResolve(HtlcResolveTx {
        lock_id: text(&fields[1])?.into(),
        outcome,
    }))
}

fn delivery(value: &AbiValue) -> Result<DeliveryMode, ProcessError> {
    match integer(value)? {
        0 => Ok(DeliveryMode::Direct),
        1 => Ok(DeliveryMode::Trusted),
        value => Err(ProcessError::Tag {
            field: "deliveryMode",
            value,
        }),
    }
}

fn optional_delivery(value: &AbiValue) -> Result<Option<HtlcDeliveryMode>, ProcessError> {
    match value {
        AbiValue::Nil => Ok(None),
        _ => match integer(value)? {
            0 => Ok(Some(HtlcDeliveryMode::Instant)),
            1 => Ok(Some(HtlcDeliveryMode::Async)),
            value => Err(ProcessError::Tag {
                field: "htlcDeliveryMode",
                value,
            }),
        },
    }
}

fn optional_envelope(value: &AbiValue) -> Result<Option<OpaqueHtlcCiphertext>, ProcessError> {
    match value {
        AbiValue::Nil => Ok(None),
        AbiValue::Bytes(bytes) => Ok(Some(OpaqueHtlcCiphertext::from_packed(bytes.clone())?)),
        _ => Err(ProcessError::Expected("optionalEnvelope")),
    }
}

fn side(value: &AbiValue, field: &'static str) -> Result<Side, ProcessError> {
    match integer(value)? {
        0 => Ok(Side::Left),
        1 => Ok(Side::Right),
        value => Err(ProcessError::Tag { field, value }),
    }
}

use num_bigint::BigInt;
use xln_rscore_abi::{AbiValue, Envelope, OpTag};
use xln_rscore_batch::{AccountId, AccountInputAuthority, AccountSeed, BatchJob};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountExecutionContext, AccountIdentity, AccountReplica,
    AccountState, AccountStateSeed, AccountTx, BilateralRebalanceFeePolicy, CarriedSections,
    DeliveryMode, Delta, DepositoryAddress, HtlcDeliveryMode, HtlcHashlock, HtlcLock, HtlcLockTx,
    HtlcResolveOutcome, HtlcResolveTx, JClaimAccumulator, OpaqueHtlcCiphertext,
    RebalanceFeePolicySnapshot, Side, SwapMarketPolicy, SwapOffer, SwapToken, TokenId, WatchSeed,
};

use crate::wire_value::{
    bigint, boolean, bounded_u32, bytes, entity, exact, fixed_bytes, hex_fixed, integer, js_number,
    optional_fixed_bytes, optional_text, text, text_list, token, tuple, unsigned,
};
use crate::{PROCESS_ABI_VERSION, PROCESS_PROFILE, ProcessError};

/// What an authoritative session needs that a mirror session does not: the
/// runtime's seed and the signer it signs as. The engine derives its own keys
/// from them, so the runtime never ships a private key.
pub struct AuthorityConfig {
    pub seed: String,
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
    Restore {
        revision: u64,
        accounts: Vec<AccountSeed>,
    },
    Prepare {
        jobs: Vec<BatchJob>,
    },
    Commit {
        prepare_request_id: [u8; 8],
    },
    Abort {
        prepare_request_id: [u8; 8],
    },
    Shutdown,
    ReadCapacityBatch {
        requests: Vec<xln_rscore_batch::CapacityRequest>,
    },
    ReadAccountSummaryPage {
        cursor: Option<AccountId>,
        limit: usize,
        token_ids: Vec<xln_rscore_engine::TokenId>,
    },
    UpsertAccounts {
        accounts: Vec<AccountSeed>,
    },
    UpdateAccountShells {
        shells: Vec<(AccountId, xln_rscore_engine::AccountEnvelope)>,
    },
    RemoveAccounts {
        account_ids: Vec<AccountId>,
    },
    /// One runtime frame for the authoritative engine.
    PrepareAccountWave {
        request: Box<xln_rscore_batch::WaveRequest>,
    },
}

pub fn decode_command(envelope: &Envelope) -> Result<Command, ProcessError> {
    let body = exact(envelope.body.fields(), 1, "body")?;
    let payload = tuple(&body[0])?;
    match envelope.op_tag {
        OpTag::Hello => decode_hello(payload),
        OpTag::RestoreCheckpoint => decode_restore(payload),
        OpTag::ExecuteWave => decode_prepare(payload),
        OpTag::CommitRuntime => decode_commit(payload),
        OpTag::AbortRuntime => decode_abort(payload),
        OpTag::Shutdown => decode_shutdown(payload),
        OpTag::UpdateAccountShells => decode_update_shells(payload),
        OpTag::RemoveAccounts => decode_remove_accounts(payload),
        OpTag::ReadCapacityBatch => decode_capacity_batch(payload),
        OpTag::ReadAccountSummaryPage => decode_summary_page(payload),
        OpTag::UpsertAccounts => decode_upsert_accounts(payload),
        OpTag::PrepareAccountWave => decode_prepare_wave(payload),
        other => Err(ProcessError::UnsupportedOp(other as u8)),
    }
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

/// `null` for a mirror session, or `(seed, signerId)` for one that owns the
/// accounts. The seed never leaves this process again: the engine derives its
/// keys from it and returns signatures, not key material.
fn decode_authority_config(value: &AbiValue) -> Result<Option<AuthorityConfig>, ProcessError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let fields = exact(tuple(value)?, 2, "authorityConfig")?;
    let seed = text(&fields[0])?.to_string();
    let signer_id = text(&fields[1])?.to_string();
    if seed.is_empty() || signer_id.is_empty() {
        return Err(ProcessError::Expected("authorityConfig"));
    }
    Ok(Some(AuthorityConfig { seed, signer_id }))
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

fn decode_restore(fields: &[AbiValue]) -> Result<Command, ProcessError> {
    let fields = exact(fields, 3, "restore")?;
    let profile = text(&fields[0])?;
    if profile != PROCESS_PROFILE {
        return Err(ProcessError::Profile(profile.into()));
    }
    Ok(Command::Restore {
        revision: unsigned(&fields[1], "revision")?,
        accounts: tuple(&fields[2])?
            .iter()
            .map(decode_seed_account)
            .collect::<Result<_, _>>()?,
    })
}

fn decode_upsert_accounts(fields: &[AbiValue]) -> Result<Command, ProcessError> {
    let fields = exact(fields, 1, "upsertAccounts")?;
    Ok(Command::UpsertAccounts {
        accounts: tuple(&fields[0])?
            .iter()
            .map(decode_seed_account)
            .collect::<Result<_, _>>()?,
    })
}

/// `[(accountId, envelope)]`: the authority re-projected these replica shells
/// at a Runtime boundary. Financial state is untouched by this operation.
fn decode_update_shells(fields: &[AbiValue]) -> Result<Command, ProcessError> {
    let fields = exact(fields, 1, "updateAccountShells")?;
    let mut shells = Vec::new();
    for row in tuple(&fields[0])? {
        let row = exact(tuple(row)?, 2, "accountShell")?;
        let account_id = AccountId::from_bytes(fixed_bytes(&row[0], "accountId")?);
        let envelope = crate::canonical::envelope(&row[1])?
            .ok_or(ProcessError::Expected("accountShellEnvelope"))?;
        shells.push((account_id, envelope));
    }
    Ok(Command::UpdateAccountShells { shells })
}

fn decode_remove_accounts(fields: &[AbiValue]) -> Result<Command, ProcessError> {
    let fields = exact(fields, 1, "removeAccounts")?;
    Ok(Command::RemoveAccounts {
        account_ids: tuple(&fields[0])?
            .iter()
            .map(|row| Ok(AccountId::from_bytes(fixed_bytes(row, "accountId")?)))
            .collect::<Result<_, ProcessError>>()?,
    })
}

fn decode_prepare(fields: &[AbiValue]) -> Result<Command, ProcessError> {
    let fields = exact(fields, 1, "prepare")?;
    Ok(Command::Prepare {
        jobs: tuple(&fields[0])?
            .iter()
            .map(decode_job)
            .collect::<Result<_, _>>()?,
    })
}

const MAX_WAVE_ADMISSION_ROWS: usize = 1_000_000;
const MAX_WAVE_INPUT_ROWS: usize = 1_000_000;

/// One runtime frame: what to queue, what arrived, and whether to propose.
fn decode_prepare_wave(fields: &[AbiValue]) -> Result<Command, ProcessError> {
    let fields = exact(fields, 7, "prepareWave")?;
    let admissions = tuple(&fields[5])?;
    if admissions.len() > MAX_WAVE_ADMISSION_ROWS {
        return Err(ProcessError::Expected("waveAdmissionRows"));
    }
    let inputs = tuple(&fields[6])?;
    if inputs.len() > MAX_WAVE_INPUT_ROWS {
        return Err(ProcessError::Expected("waveInputRows"));
    }
    Ok(Command::PrepareAccountWave {
        request: Box::new(xln_rscore_batch::WaveRequest {
            timestamp: js_number(&fields[0], "timestamp")?,
            j_height: js_number(&fields[1], "jHeight")?,
            clock: xln_rscore_batch::ReceiverClock {
                entity_timestamp: js_number(&fields[2], "entityTimestamp")?,
                finalized_j_height: js_number(&fields[3], "finalizedJHeight")?,
            },
            propose: boolean(&fields[4], "propose")?,
            admissions: admissions
                .iter()
                .map(decode_admission)
                .collect::<Result<_, _>>()?,
            inputs: inputs
                .iter()
                .map(decode_input_row)
                .collect::<Result<_, _>>()?,
        }),
    })
}

fn decode_admission(value: &AbiValue) -> Result<(AccountId, Vec<AccountTx>), ProcessError> {
    let fields = exact(tuple(value)?, 2, "admission")?;
    Ok((
        AccountId::from_bytes(fixed_bytes(&fields[0], "accountId")?),
        tuple(&fields[1])?
            .iter()
            .map(decode_tx)
            .collect::<Result<_, _>>()?,
    ))
}

fn decode_input_row(value: &AbiValue) -> Result<xln_rscore_batch::AccountInputRow, ProcessError> {
    let fields = exact(tuple(value)?, 4, "accountInput")?;
    Ok(xln_rscore_batch::AccountInputRow {
        input_index: bounded_u32(&fields[0], "inputIndex")?,
        account_id: AccountId::from_bytes(fixed_bytes(&fields[1], "accountId")?),
        from_entity_id: fixed_bytes(&fields[2], "fromEntityId")?,
        kind: decode_input_kind(&fields[3])?,
    })
}

fn decode_input_kind(value: &AbiValue) -> Result<xln_rscore_batch::AccountInputKind, ProcessError> {
    let fields = tuple(value)?;
    let tag = fields.first().ok_or(ProcessError::Expected("inputTag"))?;
    match integer(tag)? {
        0 => {
            let fields = exact(fields, 10, "incomingFrame")?;
            Ok(xln_rscore_batch::AccountInputKind::Frame(Box::new(
                xln_rscore_engine::IncomingFrame {
                    height: js_number(&fields[1], "height")?,
                    timestamp: js_number(&fields[2], "timestamp")?,
                    j_height: js_number(&fields[3], "jHeight")?,
                    txs: tuple(&fields[4])?
                        .iter()
                        .map(decode_tx)
                        .collect::<Result<_, _>>()?,
                    prev_frame_hash: text(&fields[5])?.into(),
                    account_state_root: fixed_bytes(&fields[6], "accountStateRoot")?,
                    by_left: boolean(&fields[7], "byLeft")?,
                    state_hash: fixed_bytes(&fields[8], "stateHash")?,
                    hanko: bytes(&fields[9], "hanko")?.to_vec(),
                },
            )))
        }
        1 => {
            let fields = exact(fields, 4, "incomingAck")?;
            Ok(xln_rscore_batch::AccountInputKind::Ack {
                height: js_number(&fields[1], "height")?,
                state_hash: fixed_bytes(&fields[2], "stateHash")?,
                hanko: bytes(&fields[3], "hanko")?.to_vec(),
            })
        }
        value => Err(ProcessError::Tag {
            field: "accountInput",
            value,
        }),
    }
}

fn decode_commit(fields: &[AbiValue]) -> Result<Command, ProcessError> {
    let fields = exact(fields, 1, "commit")?;
    Ok(Command::Commit {
        prepare_request_id: fixed_bytes(&fields[0], "prepareRequestId")?,
    })
}

fn decode_abort(fields: &[AbiValue]) -> Result<Command, ProcessError> {
    let fields = exact(fields, 1, "abort")?;
    Ok(Command::Abort {
        prepare_request_id: fixed_bytes(&fields[0], "prepareRequestId")?,
    })
}

fn decode_shutdown(fields: &[AbiValue]) -> Result<Command, ProcessError> {
    exact(fields, 0, "shutdown")?;
    Ok(Command::Shutdown)
}

const MAX_CAPACITY_BATCH_ROWS: usize = 4_096;
const MAX_SUMMARY_PAGE_LIMIT: u32 = 1_024;
const MAX_SUMMARY_TOKEN_IDS: usize = 64;

fn decode_capacity_batch(fields: &[AbiValue]) -> Result<Command, ProcessError> {
    let fields = exact(fields, 1, "capacityBatch")?;
    let rows = tuple(&fields[0])?;
    if rows.len() > MAX_CAPACITY_BATCH_ROWS {
        return Err(ProcessError::Expected("capacityBatchRows"));
    }
    Ok(Command::ReadCapacityBatch {
        requests: rows
            .iter()
            .map(|row| {
                let row = exact(tuple(row)?, 3, "capacityRequest")?;
                Ok(xln_rscore_batch::CapacityRequest {
                    account_id: AccountId::from_bytes(fixed_bytes(&row[0], "accountId")?),
                    token_id: token(&row[1])?,
                    side: side(&row[2], "side")?,
                })
            })
            .collect::<Result<_, ProcessError>>()?,
    })
}

fn decode_summary_page(fields: &[AbiValue]) -> Result<Command, ProcessError> {
    let fields = exact(fields, 3, "summaryPage")?;
    let cursor = optional_fixed_bytes(&fields[0], "cursor")?.map(AccountId::from_bytes);
    let limit = bounded_u32(&fields[1], "limit")?;
    if limit == 0 || limit > MAX_SUMMARY_PAGE_LIMIT {
        return Err(ProcessError::Expected("summaryPageLimit"));
    }
    let token_ids = tuple(&fields[2])?;
    if token_ids.len() > MAX_SUMMARY_TOKEN_IDS {
        return Err(ProcessError::Expected("summaryTokenIds"));
    }
    Ok(Command::ReadAccountSummaryPage {
        cursor,
        limit: limit as usize,
        token_ids: token_ids.iter().map(token).collect::<Result<_, _>>()?,
    })
}

fn decode_seed_account(value: &AbiValue) -> Result<AccountSeed, ProcessError> {
    let fields = exact(tuple(value)?, 13, "accountSeed")?;
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
            // The wire seed carries no lending intents: no supported account
            // transaction opens one, so a seeded account starts without any.
            // A checkpoint restore fills this from what it saved.
            lending_intents: Vec::new(),
        })?,
    )?;
    if let Some(envelope) = crate::canonical::envelope(&fields[12])? {
        replica.set_envelope(envelope);
    }
    Ok(AccountSeed {
        account_id,
        replica,
    })
}

/// Sections the engine carries but never interprets: their roots are committed
/// verbatim so a live account whose swap/pull/rebalance/J-claim state is
/// non-empty still reproduces its exact TypeScript account state root.
fn decode_carried_sections(value: &AbiValue) -> Result<CarriedSections, ProcessError> {
    let fields = exact(tuple(value)?, 8, "carriedSections")?;
    Ok(CarriedSections {
        pulls_root: fixed_bytes(&fields[0], "pullsRoot")?,
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

/// Slot 1 of the carried tuple is no longer a carried root either: the engine
/// owns the resting same-jurisdiction offers and recomputes their root.
fn decode_swap_offers(value: &AbiValue) -> Result<Vec<SwapOffer>, ProcessError> {
    let fields = exact(tuple(value)?, 8, "carriedSections")?;
    tuple(&fields[1])?
        .iter()
        .map(|row| {
            let row = exact(tuple(row)?, 13, "swapOffer")?;
            Ok(SwapOffer::new(
                text(&row[0])?.into(),
                bounded_u32(&row[1], "giveTokenId")?,
                bounded_u32(&row[2], "giveTokenDecimals")?,
                bigint(&row[3], "giveAmount")?,
                bounded_u32(&row[4], "wantTokenId")?,
                bounded_u32(&row[5], "wantTokenDecimals")?,
                bigint(&row[6], "wantAmount")?,
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
        })
        .collect()
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
    let fields = exact(fields, 15, "swapResolve")?;
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
        fee_token_id: optional_u32(&fields[6], "feeTokenId")?,
        fee_amount: optional_bigint(&fields[7], "feeAmount")?,
        execution_give_amount: optional_bigint(&fields[8], "executionGiveAmount")?,
        execution_want_amount: optional_bigint(&fields[9], "executionWantAmount")?,
        resting_price_ticks: optional_bigint(&fields[10], "restingPriceTicks")?,
        resting_give_amount: optional_bigint(&fields[11], "restingGiveAmount")?,
        resting_want_amount: optional_bigint(&fields[12], "restingWantAmount")?,
        resting_quantized_give: optional_bigint(&fields[13], "restingQuantizedGive")?,
        resting_quantized_want: optional_bigint(&fields[14], "restingQuantizedWant")?,
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
fn decode_rebalance_policies(
    value: &AbiValue,
) -> Result<Vec<(TokenId, BilateralRebalanceFeePolicy)>, ProcessError> {
    let fields = exact(tuple(value)?, 8, "carriedSections")?;
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

fn decode_lock(value: &AbiValue) -> Result<HtlcLock, ProcessError> {
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

fn decode_delta(value: &AbiValue) -> Result<Delta, ProcessError> {
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

fn decode_job(value: &AbiValue) -> Result<BatchJob, ProcessError> {
    let fields = exact(tuple(value)?, 7, "job")?;
    Ok(BatchJob {
        input_index: bounded_u32(&fields[0], "inputIndex")?,
        account_id: AccountId::from_bytes(fixed_bytes(&fields[1], "accountId")?),
        proposer: side(&fields[2], "proposer")?,
        context: decode_context(&fields[3])?,
        tx: decode_tx(&fields[4])?,
        envelope: crate::canonical::envelope(&fields[5])?,
        authority: decode_authority(&fields[6])?,
    })
}

/// `null`, or `(digest, signature, expectedSigner)` — the proof that this input
/// came from the counterparty it claims. The engine recovers the signer before
/// the transaction touches the account.
fn decode_authority(value: &AbiValue) -> Result<Option<AccountInputAuthority>, ProcessError> {
    if matches!(value, AbiValue::Nil) {
        return Ok(None);
    }
    let fields = exact(tuple(value)?, 3, "authority")?;
    let mut signature: [u8; 65] = fixed_bytes(&fields[1], "authoritySignature")?;
    signature[64] =
        xln_rscore_engine::normalize_recovery_byte(signature[64]).ok_or(ProcessError::Integer {
            field: "authorityRecovery",
            value: i128::from(signature[64]),
        })?;
    Ok(Some(AccountInputAuthority {
        digest: fixed_bytes(&fields[0], "authorityDigest")?,
        signature,
        expected_signer: fixed_bytes(&fields[2], "authoritySigner")?,
    }))
}

fn decode_context(value: &AbiValue) -> Result<AccountExecutionContext, ProcessError> {
    let fields = exact(tuple(value)?, 5, "context")?;
    Ok(AccountExecutionContext::new(
        js_number(&fields[0], "committedTimestamp")?,
        js_number(&fields[1], "enforcementTimestamp")?,
        js_number(&fields[2], "enforcementJHeight")?,
        js_number(&fields[3], "currentAccountHeight")?,
        js_number(&fields[4], "frameJHeight")?,
    ))
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
        value => Err(ProcessError::Tag { field: "tx", value }),
    }
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
    let fields = exact(fields, 12, "swapOffer")?;
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

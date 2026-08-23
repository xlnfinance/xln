use xln_rscore_abi::{AbiValue, Envelope, OpTag};
use xln_rscore_batch::{AccountId, AccountSeed, BatchJob};
use xln_rscore_engine::{
    AccountDisputeConfig, AccountDomain, AccountExecutionContext, AccountIdentity, AccountReplica,
    AccountState, AccountTx, DeliveryMode, Delta, DepositoryAddress, HtlcDeliveryMode,
    HtlcHashlock, HtlcLock, HtlcLockTx, HtlcResolveOutcome, HtlcResolveTx, OpaqueHtlcCiphertext,
    Side, WatchSeed,
};

use crate::wire_value::{
    bigint, bounded_u32, entity, exact, fixed_bytes, hex_fixed, integer, optional_fixed_bytes,
    optional_text, text, text_list, token, tuple, unsigned,
};
use crate::{PROCESS_ABI_VERSION, PROCESS_PROFILE, ProcessError};

pub enum Command {
    Hello {
        worker_count: usize,
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
        OpTag::ReadCapacityBatch => decode_capacity_batch(payload),
        OpTag::ReadAccountSummaryPage => decode_summary_page(payload),
        other => Err(ProcessError::UnsupportedOp(other as u8)),
    }
}

fn decode_hello(fields: &[AbiValue]) -> Result<Command, ProcessError> {
    let fields = exact(fields, 2, "hello")?;
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
    })
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

fn decode_prepare(fields: &[AbiValue]) -> Result<Command, ProcessError> {
    let fields = exact(fields, 1, "prepare")?;
    Ok(Command::Prepare {
        jobs: tuple(&fields[0])?
            .iter()
            .map(decode_job)
            .collect::<Result<_, _>>()?,
    })
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
    let fields = exact(tuple(value)?, 10, "accountSeed")?;
    let account_id = AccountId::from_bytes(fixed_bytes(&fields[0], "accountId")?);
    let owner = entity(&fields[1], "owner")?;
    let identity = AccountIdentity::new(
        AccountDomain::new(
            unsigned(&fields[4], "chainId")?,
            DepositoryAddress::parse(&hex_fixed(&fields[5], "depository", 20)?)?,
        )?,
        entity(&fields[2], "left")?,
        entity(&fields[3], "right")?,
        WatchSeed::parse(&hex_fixed(&fields[6], "watchSeed", 32)?)?,
    )?;
    let dispute = exact(tuple(&fields[7])?, 2, "disputeConfig")?;
    let dispute_config = AccountDisputeConfig::new(
        unsigned(&dispute[0], "leftResponseSeconds")?,
        unsigned(&dispute[1], "rightResponseSeconds")?,
    )?;
    let deltas = tuple(&fields[8])?
        .iter()
        .map(decode_delta)
        .collect::<Result<_, _>>()?;
    let locks = tuple(&fields[9])?
        .iter()
        .map(decode_lock)
        .collect::<Result<_, _>>()?;
    let replica = AccountReplica::new(
        owner,
        AccountState::restore(identity, dispute_config, deltas, locks)?,
    )?;
    Ok(AccountSeed {
        account_id,
        replica,
    })
}

fn decode_lock(value: &AbiValue) -> Result<HtlcLock, ProcessError> {
    let fields = exact(tuple(value)?, 10, "htlcState")?;
    Ok(HtlcLock::restore(
        text(&fields[0])?.into(),
        HtlcHashlock::parse(&hex_fixed(&fields[1], "hashlock", 32)?)?,
        bigint(&fields[2], "timelock")?,
        unsigned(&fields[3], "revealBeforeHeight")?,
        bigint(&fields[4], "amount")?,
        token(&fields[5])?,
        side(&fields[6], "sender")?,
        unsigned(&fields[7], "createdHeight")?,
        unsigned(&fields[8], "createdTimestamp")?,
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
    let fields = exact(tuple(value)?, 5, "job")?;
    Ok(BatchJob {
        input_index: bounded_u32(&fields[0], "inputIndex")?,
        account_id: AccountId::from_bytes(fixed_bytes(&fields[1], "accountId")?),
        proposer: side(&fields[2], "proposer")?,
        context: decode_context(&fields[3])?,
        tx: decode_tx(&fields[4])?,
    })
}

fn decode_context(value: &AbiValue) -> Result<AccountExecutionContext, ProcessError> {
    let fields = exact(tuple(value)?, 4, "context")?;
    Ok(AccountExecutionContext::new(
        unsigned(&fields[0], "committedTimestamp")?,
        unsigned(&fields[1], "enforcementTimestamp")?,
        unsigned(&fields[2], "enforcementJHeight")?,
        unsigned(&fields[3], "currentAccountHeight")?,
    ))
}

fn decode_tx(value: &AbiValue) -> Result<AccountTx, ProcessError> {
    let fields = tuple(value)?;
    let tag = fields.first().ok_or(ProcessError::Expected("txTag"))?;
    match integer(tag)? {
        0 => decode_direct(fields),
        1 => decode_htlc_lock(fields),
        2 => decode_htlc_resolve(fields),
        value => Err(ProcessError::Tag { field: "tx", value }),
    }
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
        reveal_before_height: unsigned(&fields[4], "revealBeforeHeight")?,
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

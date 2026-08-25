mod decode;
mod encode;

use xln_rscore_abi::{AbiValue, BodyTuple};
use xln_rscore_batch::{AccountRestore, AccountsCheckpoint, CheckpointToken};

use crate::ProcessError;
use crate::wire_encode::{body, integer, tuple};
use crate::wire_value::{exact, fixed_bytes, js_number, tuple as decode_tuple};

pub fn changes(value: &AccountsCheckpoint) -> Result<BodyTuple, ProcessError> {
    Ok(body(vec![encode::checkpoint(value)?]))
}

pub fn checkpoint_committed(value: &CheckpointToken) -> BodyTuple {
    body(vec![token(value)])
}

pub fn exact_restored(value: &CheckpointToken) -> BodyTuple {
    body(vec![token(value)])
}

pub fn restore_request(
    fields: &[AbiValue],
) -> Result<(CheckpointToken, Vec<AccountRestore>), ProcessError> {
    decode::restore_request(fields)
}

pub fn decode_consensus(
    value: &AbiValue,
) -> Result<xln_rscore_engine::ConsensusSnapshot, ProcessError> {
    decode::consensus(value)
}

pub fn token(value: &CheckpointToken) -> AbiValue {
    tuple(vec![
        integer(value.base_revision),
        integer(value.revision),
        AbiValue::Bytes(value.accounts_root.to_vec()),
        AbiValue::Bytes(value.signer_digest.to_vec()),
        integer(value.account_count),
    ])
}

pub fn decode_token(value: &AbiValue) -> Result<CheckpointToken, ProcessError> {
    let fields = exact(decode_tuple(value)?, 5, "checkpointToken")?;
    Ok(CheckpointToken {
        base_revision: js_number(&fields[0], "baseRevision")?,
        revision: js_number(&fields[1], "revision")?,
        accounts_root: fixed_bytes(&fields[2], "accountsRoot")?,
        signer_digest: fixed_bytes(&fields[3], "signerDigest")?,
        account_count: usize::try_from(js_number(&fields[4], "accountCount")?)
            .map_err(|_| ProcessError::Expected("accountCount"))?,
    })
}

use xln_rscore_abi::AbiValue;
use xln_rscore_batch::AccountCheckpointRows;

use crate::ProcessError;

/// Transport delegates to the encoder owned beside `AccountCheckpointRows`.
/// Persistence and the process ABI therefore cannot acquire distinct tuple
/// shapes for the same canonical checkpoint.
pub(crate) fn account_rows(
    value: &AccountCheckpointRows,
    carry_envelope: bool,
) -> Result<AbiValue, ProcessError> {
    xln_rscore_batch::encode_account_checkpoint_rows(value, carry_envelope).map_err(Into::into)
}

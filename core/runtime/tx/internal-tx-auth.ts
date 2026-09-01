import { assertJAuthorityRuntimeTxAuthorized } from '../../jurisdiction/machine/registration-evidence';
import { assertRuntimeAdapterCommandTxAuthorized } from '../command/frontier-auth';
import { assertEntityProviderActionRuntimeTxAuthorized } from '../registration/entity-provider-action-submit-auth';
import { assertJSubmitRuntimeTxAuthorized } from '../j-submit/j-submit-state';
import { assertJImportResultRuntimeTxAuthorized } from '../j-submit/jurisdiction-import';
import { assertNumberedRegistrationTxAuthorized } from '../registration/numbered-registration-auth';
import { assertGovernanceResultRuntimeTxAuthorized } from '../registration/governance-submit-state';
import { assertCheckpointBarrierRuntimeTxAuthorized } from '../checkpoint/barrier';
import type { RuntimeInput, RuntimeTx } from '../types';

/**
 * Internal Runtime transactions carry process-local capabilities at admission.
 * A durable pending input may recover those capabilities only because this
 * boundary proved them before WAL serialization. Trusting a decoded tx.type
 * without this pre-persistence proof would turn hostile public input into a
 * privileged local command after restart.
 */
export const assertRuntimeTxCapabilitiesAuthorized = (
  tx: RuntimeTx,
  replay = false,
): void => {
  assertCheckpointBarrierRuntimeTxAuthorized(tx, replay);
  assertJSubmitRuntimeTxAuthorized(tx, replay);
  assertJAuthorityRuntimeTxAuthorized(tx, replay);
  assertJImportResultRuntimeTxAuthorized(tx, replay);
  assertEntityProviderActionRuntimeTxAuthorized(tx, replay);
  assertRuntimeAdapterCommandTxAuthorized(tx, replay);
  assertNumberedRegistrationTxAuthorized(tx, replay);
  assertGovernanceResultRuntimeTxAuthorized(tx, replay);
};

export const assertRuntimeInputCapabilitiesAuthorized = (
  input: RuntimeInput,
  replay = false,
): void => {
  for (const tx of input.runtimeTxs) assertRuntimeTxCapabilitiesAuthorized(tx, replay);
};

/**
 * Proves that reserve-governance submission results remain process-local.
 * Network/disk bytes cannot forge the capability used by Runtime replay.
 */

import { describe, expect, test } from 'bun:test';

import {
  assertGovernanceResultRuntimeTxAuthorized,
  markLocalGovernanceResultRuntimeTx,
} from '../../../runtime/registration/governance-submit-state';
import type { RuntimeTx } from '../../../runtime/types';

const resultTx = (): Extract<RuntimeTx, { type: 'recordGovernanceJSubmitResult' }> => ({
  type: 'recordGovernanceJSubmitResult',
  data: {
    entityId: `0x${'01'.repeat(32)}`,
    signerId: `0x${'02'.repeat(20)}`,
    jurisdictionName: 'local-anvil',
    proposalHash: `0x${'03'.repeat(32)}`,
    payloadHash: `0x${'04'.repeat(32)}`,
    attemptId: `0x${'05'.repeat(32)}`,
    attemptNumber: 1,
    attemptedAt: 100,
    outcome: 'submitted',
  },
});

describe('governance submit result capability', () => {
  test('rejects external ingress while accepting local and WAL-replay authority', () => {
    expect(() => assertGovernanceResultRuntimeTxAuthorized(resultTx(), false))
      .toThrow('GOVERNANCE_SUBMIT_RESULT_EXTERNAL_INGRESS_REJECTED');
    expect(() => assertGovernanceResultRuntimeTxAuthorized(
      markLocalGovernanceResultRuntimeTx(resultTx()),
      false,
    )).not.toThrow();
    expect(() => assertGovernanceResultRuntimeTxAuthorized(resultTx(), true)).not.toThrow();
  });
});

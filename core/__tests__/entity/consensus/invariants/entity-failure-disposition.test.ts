import { describe, expect, test } from 'bun:test';

import {
  classifyEntityInputApplyFailure,
  entityInputFailureDisposition,
} from '../../../../entity/tx/processing/invariant-errors';
import {
  disputeFailure,
  haltRuntimeFailure,
  rejectFailure,
  retryFailure,
} from '../../../../protocol/errors/failure-taxonomy';

describe('EntityInput typed failure dispositions', () => {
  test('branches on disposition even when every human message is identical', () => {
    const message = 'operator text may change freely';
    const failures = [
      rejectFailure('PEER_MALFORMED', message),
      retryFailure('PEER_HEAD_STALE', message),
      disputeFailure('SIGNED_REPLAY_UNSAFE', message),
      haltRuntimeFailure('STATE_ROOT_DIVERGED', message),
    ] as const;

    expect(failures.map(classifyEntityInputApplyFailure)).toEqual([
      'malformed-ingress',
      'retryable-ingress',
      'signed-dispute',
      'state-machine-invariant',
    ]);
    expect(failures.map(error => entityInputFailureDisposition(classifyEntityInputApplyFailure(error))))
      .toEqual(['reject', 'retry', 'dispute', 'halt_runtime']);
  });
});

import { expect, test } from 'bun:test';

import type { EntityCandidateEffect, EntityFrameEvent } from '../../../entity/types';
import { createEmptyEnv } from '../../../runtime';
import { makeJurisdiction, makeState } from '../../helpers/cross-j';
import {
  beginRuntimeParityEvidence,
  captureCommittedEntityParityEvidence,
  capturePlannedLocalContinuations,
  captureRuntimeParityEffectLogs,
  discardRuntimeParityEvidence,
  finishRuntimeParityEvidence,
} from '../../../runtime/observability/parity-evidence';
import type { FrameLogEntry } from '../../../types/logging';

const ENTITY_ID = `0x${'11'.repeat(32)}`;
const SIGNER_ID = `0x${'22'.repeat(20)}`;

const committedFrameEffect = (
  events: readonly EntityFrameEvent[],
): EntityCandidateEffect => ({
  kind: 'entityFrameCommitted',
  entityId: ENTITY_ID,
  signerId: SIGNER_ID,
  link: { frame: { events } },
} as EntityCandidateEffect);

const runtimeLog = (id: number, message: string): FrameLogEntry => ({
  id,
  timestamp: 100 + id,
  level: 'info',
  category: 'system',
  message,
  data: { ordinal: id },
});

const installCapturedEntity = (env: ReturnType<typeof createEmptyEnv>): void => {
  env.state.eReplicas.set(`${ENTITY_ID}:${SIGNER_ID}`, {
    state: makeState(ENTITY_ID, SIGNER_ID, makeJurisdiction('Parity', 1, '11', '12')),
  } as never);
};

test('parity evidence capture is inert until an explicit replay window begins', () => {
  const env = createEmptyEnv('parity-evidence-inactive');
  captureCommittedEntityParityEvidence(env, [committedFrameEffect([
    { type: 'status', message: 'must-not-leak' },
  ])]);
  captureRuntimeParityEffectLogs(env, [runtimeLog(1, 'must-not-leak')]);
  capturePlannedLocalContinuations(env, [{
    entityId: 'entity-a',
    signerId: 'signer-a',
    entityTxs: [],
  }]);

  beginRuntimeParityEvidence(env);
  expect(finishRuntimeParityEvidence(env)).toEqual({
    entityFrames: [],
    entityFrameEvents: [],
    entityEffectLogs: [],
    localContinuations: [],
  });
});

test('parity evidence preserves positional Entity events and exact Runtime logs', () => {
  const env = createEmptyEnv('parity-evidence-order');
  installCapturedEntity(env);
  const firstEvents: EntityFrameEvent[] = [
    { type: 'status', message: 'first' },
    { type: 'text', validatorId: 'validator-a', message: 'second' },
  ];
  const thirdEvent: EntityFrameEvent = { type: 'status', message: 'third' };
  const logs = [runtimeLog(7, 'HtlcReceived'), runtimeLog(8, 'SwapMatched')];
  const localContinuations = [{
    entityId: 'entity-a',
    signerId: 'signer-a',
    entityTxs: [],
  }];

  beginRuntimeParityEvidence(env);
  captureCommittedEntityParityEvidence(env, [committedFrameEffect(firstEvents)]);
  captureCommittedEntityParityEvidence(env, [committedFrameEffect([thirdEvent])]);
  captureRuntimeParityEffectLogs(env, logs);
  capturePlannedLocalContinuations(env, localContinuations);

  const captured = finishRuntimeParityEvidence(env);
  expect(captured.entityFrames.map(entry => [entry.entityId, entry.link.frame.events]))
    .toEqual([
      [ENTITY_ID, firstEvents],
      [ENTITY_ID, [thirdEvent]],
    ]);
  expect(captured.entityFrameEvents).toEqual([...firstEvents, thirdEvent]);
  expect(captured.entityEffectLogs).toEqual(logs);
  expect(captured.localContinuations).toEqual(localContinuations);
  expect(captured.entityFrameEvents).not.toBe(firstEvents);
  expect(captured.entityEffectLogs).not.toBe(logs);
  expect(captured.localContinuations).not.toBe(localContinuations);
});

test('parity evidence rejects overlapping and already-finished replay windows', () => {
  const env = createEmptyEnv('parity-evidence-lifecycle');
  beginRuntimeParityEvidence(env);
  expect(() => beginRuntimeParityEvidence(env)).toThrow(
    'RUNTIME_PARITY_EVIDENCE_ALREADY_ACTIVE',
  );
  discardRuntimeParityEvidence(env);
  expect(() => finishRuntimeParityEvidence(env)).toThrow(
    'RUNTIME_PARITY_EVIDENCE_NOT_ACTIVE',
  );

  beginRuntimeParityEvidence(env);
  finishRuntimeParityEvidence(env);
  expect(() => finishRuntimeParityEvidence(env)).toThrow(
    'RUNTIME_PARITY_EVIDENCE_NOT_ACTIVE',
  );
});

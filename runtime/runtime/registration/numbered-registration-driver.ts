import { requireRuntimeJurisdictionConfigByName } from '../../jurisdiction/machine/jurisdiction-runtime';
import { registrationEvidenceKey } from '../../jurisdiction/machine/registration-evidence';
import { enqueueRuntimeInput } from '../input-queue';
import { registerEnvChangeCallback, registerRuntimeFrameCommitCallback } from '../loop/loop-environment.ts';
import { ensureRuntimeInfrastructure } from '../runtime-infrastructure';
import type {
  NumberedRegistrationCommand,
  NumberedRegistrationCommandResult,
  NumberedRegistrationRequest,
  RuntimeReplica,
  RuntimeTx,
} from '../types';
import type { JPreparedTransactionAcceptance } from '../../jurisdiction/adapter/types';
import {
  buildNumberedRegistrationRequest,
  getNumberedRegistrationRecord,
  runNumberedRegistrationIntent,
  type RegistrationSubmission,
} from './numbered-registration-intent';
import {
  getTrustedRegistrationAdapter,
} from './numbered-registration';
export type {
  NumberedRegistrationCommand,
  NumberedRegistrationCommandResult,
} from '../types';

const WAIT_TIMEOUT_MS = 15 * 60 * 1_000;
const WAIT_POLL_MS = 250;

export const assertNumberedRegistrationDriverActive = (
  env: RuntimeReplica,
  code: string,
): void => {
  if (env.infrastructure?.halted) throw new Error(`${code}_RUNTIME_HALTED`);
};

const driverFor = (env: RuntimeReplica) => {
  const infrastructure = ensureRuntimeInfrastructure(env);
  infrastructure.numberedRegistrationDriver ??= { inFlight: new Map(), resumeRun: null };
  return infrastructure.numberedRegistrationDriver;
};

const waitForCommitOrPoll = (env: RuntimeReplica, waitMs: number): Promise<void> =>
  new Promise(resolve => {
    let complete = false;
    let unsubscribe = (): void => {};
    const finish = (): void => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(finish, waitMs);
    unsubscribe = registerEnvChangeCallback(env, finish);
  });

const waitFor = async (
  env: RuntimeReplica,
  code: string,
  predicate: () => boolean,
  poll?: () => Promise<void>,
): Promise<void> => {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!predicate()) {
    assertNumberedRegistrationDriverActive(env, code);
    if (Date.now() >= deadline) throw new Error(`${code}_TIMEOUT`);
    if (poll) await poll();
    assertNumberedRegistrationDriverActive(env, code);
    if (!predicate()) await waitForCommitOrPoll(env, WAIT_POLL_MS);
  }
};

const commitRuntimeTxs = async (
  env: RuntimeReplica,
  intentId: string,
  runtimeTxs: RuntimeTx[],
): Promise<JPreparedTransactionAcceptance> => {
  const resolves = runtimeTxs.some(tx => tx.type === 'resolveNumberedRegistrationIntent');
  const expectedType = resolves
    ? 'resolveNumberedRegistrationIntent'
    : 'recordNumberedRegistrationIntent';
  let committed = false;
  const commitCode = resolves
    ? 'NUMBERED_REGISTRATION_RESOLUTION_COMMIT'
    : 'NUMBERED_REGISTRATION_INTENT_COMMIT';
  const unsubscribe = registerRuntimeFrameCommitCallback(env, ({ runtimeInput }) => {
    if (runtimeInput.runtimeTxs.some(tx => tx.type === expectedType &&
      (tx.type === 'recordNumberedRegistrationIntent'
        ? tx.data.request.intentId
        : tx.data.intentId) === intentId)) committed = true;
  });
  try {
    enqueueRuntimeInput(env, { runtimeTxs, entityInputs: [] });
    await waitFor(env, commitCode, () => committed);
  } finally {
    unsubscribe();
  }
  const record = getNumberedRegistrationRecord(env, intentId);
  if (resolves ? !record || record.status === 'pending' : !record) {
    throw new Error('NUMBERED_REGISTRATION_COMMIT_CALLBACK_STATE_MISMATCH');
  }
  return 'accepted';
};

const waitForCertifiedSubmission = async (
  env: RuntimeReplica,
  request: NumberedRegistrationRequest,
  transactionHash: string,
  submission: Extract<RegistrationSubmission, { kind: 'receipt' }>,
): Promise<void> => waitFor(
  env,
  'NUMBERED_REGISTRATION_EVIDENCE',
  () => submission.registrations.every((registration, index) => {
    const evidence = env.infrastructure?.certifiedRegistrationEvidence?.get(
      registrationEvidenceKey(request.stackKey, registration.entityId),
    );
    const planned = request.entities[index];
    return Boolean(
      evidence && planned &&
      evidence.transactionHash === transactionHash &&
      evidence.boardHash === planned.boardHash &&
      evidence.logIndex === registration.logIndex,
    );
  }),
  async () => {
    const adapter = getTrustedRegistrationAdapter(env, request.entities[0]!.config.jurisdiction!);
    await adapter.pollNow?.();
  },
);

const executeRequest = async (
  env: RuntimeReplica,
  request: NumberedRegistrationRequest,
): Promise<NumberedRegistrationCommandResult> => {
  const adapter = getTrustedRegistrationAdapter(env, request.entities[0]!.config.jurisdiction!);
  const results = await runNumberedRegistrationIntent(
    env,
    adapter,
    request,
    runtimeTxs => commitRuntimeTxs(env, request.intentId, runtimeTxs),
    submission => waitForCertifiedSubmission(env, request, submission.receipt.hash.toLowerCase(), submission),
  );
  const completed = getNumberedRegistrationRecord(env, request.intentId);
  if (!completed || completed.status !== 'completed') {
    throw new Error('NUMBERED_REGISTRATION_COMPLETION_NOT_DURABLE');
  }
  return {
    intentId: request.intentId,
    transactionHash: completed.transactionHash,
    committedHeight: env.state.height,
    entities: results.map((result, index) => {
      const planned = request.entities[index]!;
      const localSignerId = planned.localSignerId;
      const boardIndex = localSignerId === null
        ? -1
        : planned.config.validators.findIndex(signer => signer.toLowerCase() === localSignerId);
      return {
        ...result,
        localSignerId,
        isProposer: boardIndex === 0,
        imported: localSignerId !== null,
      };
    }),
  };
};

const enqueueRequest = (
  env: RuntimeReplica,
  request: NumberedRegistrationRequest,
): Promise<NumberedRegistrationCommandResult> => {
  const driver = driverFor(env);
  const existing = driver.inFlight.get(request.intentId);
  if (existing) return existing;
  const task = executeRequest(env, request);
  driver.inFlight.set(request.intentId, task);
  void task.finally(() => {
    if (driver.inFlight.get(request.intentId) === task) driver.inFlight.delete(request.intentId);
  }).catch(() => undefined);
  return task;
};

export const registerNumberedEntities = (
  env: RuntimeReplica,
  command: NumberedRegistrationCommand,
): Promise<NumberedRegistrationCommandResult> => {
  const jurisdiction = requireRuntimeJurisdictionConfigByName(env, command.jurisdictionRef);
  return enqueueRequest(env, buildNumberedRegistrationRequest(env, {
    jurisdiction,
    payerSignerId: command.payerSignerId,
    entities: command.entities,
  }));
};

const resumePendingNumberedRegistrations = async (env: RuntimeReplica): Promise<void> => {
  const pending = [...(env.infrastructure?.numberedRegistrationIntents?.values() ?? [])]
    .filter(record => record.status === 'pending')
    .sort((left, right) => left.transactionNonce - right.transactionNonce);
  for (const record of pending) {
    try {
      await enqueueRequest(env, record.request);
    } catch (error) {
      const resolved = getNumberedRegistrationRecord(env, record.request.intentId);
      if (resolved?.status !== 'quarantined') throw error;
      env.warn('system', 'NUMBERED_REGISTRATION_RESUME_QUARANTINED', {
        intentId: record.request.intentId,
        transactionHash: record.transactionHash,
        reason: resolved.reason,
      });
    }
  }
};

/** Call after signer prewarm, J-adapter attach, watcher start, and Runtime-loop start. */
export const ensurePendingNumberedRegistrationsResumed = (env: RuntimeReplica): Promise<void> => {
  const driver = driverFor(env);
  if (driver.resumeRun) return driver.resumeRun;
  const run = resumePendingNumberedRegistrations(env);
  const tracked = run.finally(() => {
    if (driver.resumeRun === tracked) driver.resumeRun = null;
  });
  driver.resumeRun = tracked;
  return tracked;
};

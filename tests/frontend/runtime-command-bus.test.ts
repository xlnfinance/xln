import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeInput } from '@xln/runtime/api/public/runtime-module';
import {
  clearRuntimeCommandReceipts,
  recordRuntimeIngressReceipt,
  replayRuntimeCommandIntentsInOrder,
  runtimeCommandLatestReceipt,
  runtimeCommandReceipts,
  runtimeCommandRetryOptions,
  submitRuntimeCommand,
  type CommandReceipt,
} from '../../frontend/src/lib/stores/runtimeCommandBus';
import { RuntimeAdapterError } from '../../runtime/api/runtime-adapter/errors';
import { listUnresolvedRemoteRuntimeCommandIntents } from '../../frontend/src/lib/stores/runtimeCommandIntent';
import {
  findCommittedEmbeddedRuntimeInputHeight,
  findPersistedEmbeddedRuntimeInputHeight,
  runtimeFrameContainsSubmittedInput,
} from '../../frontend/src/lib/stores/embeddedRuntimeCommandCompletion';

const SIGNED_SERVER_FINGERPRINT = '0x01fe56d4322ab531393851ee54e1f751c8358fc2fc3730a432963661e33f50d3';

const frontendSourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return frontendSourceFiles(path);
    return /\.(ts|tsx)$/.test(path) ? [path] : [];
  });

const readStore = <T>(store: { subscribe: (run: (value: T) => void) => () => void }): T => {
  let value: T | undefined;
  const unsubscribe = store.subscribe((next) => {
    value = next;
  });
  unsubscribe();
  return value as T;
};

test('runtime command bus records pending accepted observed committed error receipts deterministically', () => {
  const source = readFileSync('frontend/src/lib/stores/runtimeCommandBus.ts', 'utf8');

  expect(source).toContain("export type RuntimeCommandStatus = 'pending' | 'accepted' | 'observed' | 'committed' | 'error'");
  expect(source).toContain('receiptId: `runtime-command-${++receiptSequence}`');
	  expect(source).toContain('acceptedAtHeight');
  expect(source).toContain('committedAtHeight');
	  expect(source).toContain('upstreamReceiptId');
	  expect(source).toContain('statusUrl');
	  expect(source).not.toContain('commitAcceptedRuntimeCommands');
  expect(source).toContain('recordRuntimeIngressReceipt');
  expect(source).toContain('classifyRuntimeFailure');
  expect(source).toContain('failureKind: RuntimeFailureKind | null');
  expect(source).toContain("status: receipt.mode === 'remote' ? 'observed' : 'committed'");
  expect(source).toContain("upstreamStatus === 'observed' ? 'observed'");
  expect(source).toContain("registerDebugSurface('commands'");
  expect(source).not.toContain('__xlnRuntimeCommands');
  expect(source).not.toContain('Date.now');
  expect(source).not.toContain('Math.random');
});

test('browser E2E mutations use the live runtime command bus instead of a detached view RuntimeReplica', () => {
  const storeSource = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  const helperSource = readFileSync('tests/utils/e2e-runtime-input.ts', 'utf8');
  const enqueueStart = helperSource.indexOf('export async function enqueueRuntimeInput');
  const enqueueEnd = helperSource.indexOf('export async function enqueueEntityTxs', enqueueStart);
  const enqueueSource = helperSource.slice(enqueueStart, enqueueEnd);

  expect(storeSource).toContain("registerDebugSurface('runtimeIngress'");
  expect(storeSource).toContain('submit: submitActiveRuntimeInput');
  expect(enqueueSource).toContain('runtimeIngress.submit(input)');
  expect(enqueueSource).not.toContain('isolatedEnv');
  expect(enqueueSource).not.toContain('await import(');
});

test('runtime command bus transitions receipts from pending to accepted committed and error', async () => {
  clearRuntimeCommandReceipts();
  const input: RuntimeInput = {
    runtimeTxs: [],
    entityInputs: [],
    jInputs: [],
  };

  const committed = await submitRuntimeCommand({
    input,
    runtimeId: 'runtime-a',
    mode: 'embedded',
    initialHeight: 4,
  }, async (progress) => {
    expect(readStore(runtimeCommandLatestReceipt)?.status).toBe('pending');
    await progress.accepted(5);
    expect(readStore(runtimeCommandLatestReceipt)?.status).toBe('accepted');
    await progress.committed(6);
    expect(readStore(runtimeCommandLatestReceipt)?.status).toBe('committed');
    return 'ok';
  });

  expect(committed.result).toBe('ok');
  expect(committed.receipt.receiptId).toMatch(/^runtime-command-/);
  expect(committed.receipt.status).toBe('committed');
  expect(committed.receipt.runtimeId).toBe('runtime-a');
  expect(committed.receipt.mode).toBe('embedded');
  expect(committed.receipt.acceptedAtHeight).toBe(5);
  expect(committed.receipt.committedAtHeight).toBe(6);
  expect(committed.receipt.upstreamReceiptId).toBeNull();
  expect(committed.receipt.statusUrl).toBeNull();
  expect(readStore(runtimeCommandReceipts)).toHaveLength(1);

  const remoteAccepted = await submitRuntimeCommand({
    input,
    runtimeId: 'runtime-remote',
    mode: 'remote',
    serverFingerprint: SIGNED_SERVER_FINGERPRINT,
    initialHeight: 20,
  }, async (progress) => {
    await progress.accepted(21, { receiptId: 'upstream-1', statusUrl: '/api/control/runtime-input/upstream-1/status' });
    await progress.committed(22);
    return 'remote-ok';
  });
  expect(remoteAccepted.receipt.status).toBe('accepted');
  expect(remoteAccepted.receipt.committedAtHeight).toBeNull();
  expect(readStore(runtimeCommandLatestReceipt)?.runtimeId).toBe('runtime-remote');
  expect(readStore(runtimeCommandLatestReceipt)?.status).toBe('accepted');

  const remoteObserved = await submitRuntimeCommand({
    input,
    runtimeId: 'runtime-remote-observed',
    mode: 'remote',
    serverFingerprint: SIGNED_SERVER_FINGERPRINT,
    initialHeight: 30,
  }, async (progress) => {
    await progress.accepted(31, { receiptId: 'upstream-observed', statusUrl: '/api/control/runtime-input/upstream-observed/status' });
    await progress.observed(32);
    return 'remote-observed';
  });
  expect(remoteObserved.receipt.status).toBe('observed');
  expect(remoteObserved.receipt.acceptedAtHeight).toBe(31);
  expect(remoteObserved.receipt.committedAtHeight).toBe(32);

  const acceptedOnly = await submitRuntimeCommand({
    input,
    runtimeId: 'runtime-b',
    mode: 'embedded',
    initialHeight: 10,
  }, async (progress) => {
    await progress.accepted(10);
    return 'accepted';
  });
  expect(acceptedOnly.receipt.status).toBe('accepted');
  expect(readStore(runtimeCommandLatestReceipt)?.runtimeId).toBe('runtime-b');
  expect(readStore(runtimeCommandLatestReceipt)?.status).toBe('accepted');
  expect(readStore(runtimeCommandLatestReceipt)?.committedAtHeight).toBeNull();

  await expect(submitRuntimeCommand({
    input,
    runtimeId: 'runtime-c',
    mode: 'remote',
    serverFingerprint: SIGNED_SERVER_FINGERPRINT,
    initialHeight: 1,
  }, async (progress) => {
    await progress.accepted(2);
    throw new Error('boom');
  })).rejects.toThrow('boom');
  const latest = readStore(runtimeCommandLatestReceipt);
  expect(latest?.runtimeId).toBe('runtime-c');
  expect(latest?.status).toBe('error');
  expect(latest?.acceptedAtHeight).toBe(2);
  expect(latest?.error).toBe('boom');
  expect(latest?.failureKind).toBe('fatal');
  expect(latest?.failureRetryable).toBe(false);

  await expect(submitRuntimeCommand({
    input,
    runtimeId: 'runtime-d',
    mode: 'remote',
    serverFingerprint: SIGNED_SERVER_FINGERPRINT,
    initialHeight: 1,
  }, async () => {
    throw new Error('fetch failed: ECONNREFUSED');
  })).rejects.toThrow('fetch failed');
  const retryable = readStore(runtimeCommandLatestReceipt);
  expect(retryable?.failureKind).toBe('defer');
  expect(retryable?.failureRetryable).toBe(true);
});

test('runtime command pre-execution admission cancels before receipt publication or executor mutation', async () => {
  clearRuntimeCommandReceipts();
  let executorCalls = 0;

  await expect(submitRuntimeCommand({
    input: { runtimeTxs: [], entityInputs: [], jInputs: [] },
    runtimeId: 'runtime-quiescing',
    mode: 'embedded',
    beforeExecute: () => {
      throw new Error('EXTERNAL_WALLET_SNAPSHOT_INGRESS_CANCELLED:cancel-runtime-quiescing');
    },
  }, async () => {
    executorCalls += 1;
    return null;
  })).rejects.toThrow('EXTERNAL_WALLET_SNAPSHOT_INGRESS_CANCELLED:cancel-runtime-quiescing');

  expect(executorCalls).toBe(0);
  expect(readStore(runtimeCommandReceipts)).toEqual([]);
  expect(readStore(runtimeCommandLatestReceipt)).toBeNull();
});

test('terminal remote intent does not head-of-line block the next replay', async () => {
  const attempted: string[] = [];
  const completed = await replayRuntimeCommandIntentsInOrder(['terminal', 'next'], async (intent) => {
    attempted.push(intent);
    if (intent === 'terminal') {
      throw new RuntimeAdapterError(
        'E_BAD_QUERY',
        'runtime adapter commandId was reused with a different payload',
      );
    }
  });
  expect(attempted).toEqual(['terminal', 'next']);
  expect(completed).toBe(1);
});

test('remote command IDs identify UI intents, not identical payloads', async () => {
  clearRuntimeCommandReceipts();
  const input: RuntimeInput = {
    runtimeTxs: [],
    entityInputs: [],
    jInputs: [],
  };
  const seenCommandIds: string[] = [];

  await expect(submitRuntimeCommand({
    input,
    runtimeId: 'runtime-idempotency',
    mode: 'remote',
    serverFingerprint: SIGNED_SERVER_FINGERPRINT,
    initialHeight: 1,
  }, async (_progress, receipt) => {
    seenCommandIds.push(receipt.commandId);
    throw new Error('runtime adapter request timed out: send');
  })).rejects.toThrow('timed out');

  const retryableReceipt = readStore(runtimeCommandLatestReceipt);
  expect(retryableReceipt?.failureRetryable).toBe(true);

  const identicalNewIntent = await submitRuntimeCommand({
    input: structuredClone(input),
    runtimeId: 'runtime-idempotency',
    mode: 'remote',
    serverFingerprint: SIGNED_SERVER_FINGERPRINT,
    initialHeight: 1,
  }, async (progress, receipt) => {
    seenCommandIds.push(receipt.commandId);
    await progress.accepted(1, { receiptId: 'upstream-distinct-intent' });
    await progress.observed(2);
    return 'distinct-observed';
  });

  await expect(submitRuntimeCommand({
    input: {
      ...structuredClone(input),
      runtimeTxs: [{ type: 'importReplica', entityId: 'different-payload' } as never],
    },
    runtimeId: 'runtime-idempotency',
    mode: 'remote',
    serverFingerprint: SIGNED_SERVER_FINGERPRINT,
    initialHeight: 1,
    commandId: seenCommandIds[0],
  }, async () => 'must-not-run')).rejects.toThrow('RUNTIME_COMMAND_ID_PAYLOAD_MISMATCH');

  if (!retryableReceipt) throw new Error('TEST_RETRYABLE_RECEIPT_MISSING');
  const retry = await submitRuntimeCommand({
    input: structuredClone(input),
    runtimeId: 'runtime-idempotency',
    mode: 'remote',
    serverFingerprint: SIGNED_SERVER_FINGERPRINT,
    initialHeight: 1,
    ...runtimeCommandRetryOptions(retryableReceipt),
  }, async (progress, receipt) => {
    seenCommandIds.push(receipt.commandId);
    await progress.accepted(1, { receiptId: 'upstream-idempotency' });
    await progress.observed(2);
    return 'observed';
  });

  expect(seenCommandIds[0]).toMatch(/^[A-Za-z0-9._:-]{16,128}$/);
  expect(seenCommandIds[1]).not.toBe(seenCommandIds[0]);
  expect(seenCommandIds[2]).toBe(seenCommandIds[0]);
  expect(identicalNewIntent.receipt.commandId).toBe(seenCommandIds[1]);
  expect(retry.receipt.commandId).toBe(seenCommandIds[0]);
  expect(() => runtimeCommandRetryOptions(retry.receipt)).toThrow('RUNTIME_COMMAND_RECEIPT_NOT_RETRYABLE');
});

test('an explicit stale-tab retry cannot recreate a settled command intent', async () => {
  const input: RuntimeInput = { runtimeTxs: [], entityInputs: [], jInputs: [] };
  const first = await submitRuntimeCommand({
    input,
    runtimeId: 'runtime-stale-tab',
    mode: 'remote',
    serverFingerprint: SIGNED_SERVER_FINGERPRINT,
  }, async (progress) => {
    await progress.accepted(1);
    await progress.observed(2);
    return null;
  });

  await expect(submitRuntimeCommand({
    input: structuredClone(input),
    runtimeId: 'runtime-stale-tab',
    mode: 'remote',
    serverFingerprint: SIGNED_SERVER_FINGERPRINT,
    commandId: first.receipt.commandId,
  }, async () => null)).rejects.toThrow(`RUNTIME_COMMAND_INTENT_NOT_FOUND:${first.receipt.commandId}`);
  expect(await listUnresolvedRemoteRuntimeCommandIntents(
    'runtime-stale-tab',
    SIGNED_SERVER_FINGERPRINT,
  )).toEqual([]);
});

test('capability-lane one-shot Entity commands never create a durable journal intent', async () => {
  const runtimeId = 'runtime-capability-only';
  const input: RuntimeInput = {
    runtimeTxs: [],
    entityInputs: [{
      entityId: 'entity-a',
      signerId: 'signer-a',
      entityTxs: [{
        type: 'extendCredit',
        data: { counterpartyEntityId: 'entity-b', tokenId: 1, amount: 1n },
      }],
    }],
    jInputs: [],
  };
  const submitted = await submitRuntimeCommand({
    input,
    runtimeId,
    mode: 'remote',
    serverFingerprint: SIGNED_SERVER_FINGERPRINT,
    nextCommandSequence: 7,
    remoteJournalMode: 'one-shot',
  }, async (progress, receipt) => {
    expect(receipt.commandSequence).toBe(7);
    await progress.accepted(3);
    await progress.observed(4);
    return null;
  });

  expect(submitted.receipt.status).toBe('observed');
  expect(await listUnresolvedRemoteRuntimeCommandIntents(
    runtimeId,
    SIGNED_SERVER_FINGERPRINT,
  )).toEqual([]);
});

test('capability-only one-shot response loss is not offered as a retryable payment-style intent', async () => {
  await expect(submitRuntimeCommand({
    input: { runtimeTxs: [], entityInputs: [], jInputs: [] },
    runtimeId: 'runtime-capability-loss',
    mode: 'remote',
    serverFingerprint: SIGNED_SERVER_FINGERPRINT,
    nextCommandSequence: 1,
    remoteJournalMode: 'one-shot',
  }, async () => {
    throw new Error('runtime adapter request timed out: response lost');
  })).rejects.toThrow('response lost');

  const receipt = readStore(runtimeCommandLatestReceipt);
  expect(receipt?.failureRetryable).toBe(false);
  expect(() => runtimeCommandRetryOptions(receipt!)).toThrow('RUNTIME_COMMAND_RECEIPT_NOT_RETRYABLE');
});

test('remote command journal persists protected replayable intents outside localStorage', () => {
  const intentSource = readFileSync('frontend/src/lib/stores/runtimeCommandIntent.ts', 'utf8');
  const codecSource = readFileSync('frontend/src/lib/stores/runtimeCommandIntentCodec.ts', 'utf8');
  const indexedDbSource = readFileSync('frontend/src/lib/stores/runtimeCommandJournalIndexedDb.ts', 'utf8');
  const keyringSource = readFileSync('frontend/src/lib/stores/runtimeCommandJournalKeyring.ts', 'utf8');
  const storageSource = readFileSync('frontend/src/lib/stores/runtimeCommandJournalStorage.ts', 'utf8');
  const routeSource = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  const journalSource = `${intentSource}\n${codecSource}\n${indexedDbSource}\n${keyringSource}\n${storageSource}`;

  expect(journalSource).not.toContain('localStorage');
  expect(indexedDbSource).toContain('indexedDB');
  expect(indexedDbSource).toContain('const DB_VERSION = RUNTIME_COMMAND_JOURNAL_DATABASE.version');
  expect(indexedDbSource).toContain('const [LEGACY_META_STORE] = RUNTIME_COMMAND_JOURNAL_DATABASE.retiredStores');
  expect(indexedDbSource).toContain('db.deleteObjectStore(LEGACY_META_STORE)');
  expect(storageSource).toContain('AES-GCM');
  expect(storageSource).toContain('safeParse');
  expect(storageSource).toContain("from './runtimeCommandJournalIndexedDb'");
  expect(routeSource).toContain('resumeRemoteRuntimeCommandIntents');
});

test('remote command journal retains exact payload and status until observed', async () => {
  const runtimeId = 'runtime-journal-roundtrip';
  const input: RuntimeInput = {
    runtimeTxs: [{ type: 'importReplica', entityId: 'journal-payload', amount: 7n } as never],
    entityInputs: [],
    jInputs: [],
  };
  let retryableReceipt: CommandReceipt | null;

  await expect(submitRuntimeCommand({
    input,
    runtimeId,
    mode: 'remote',
    serverFingerprint: SIGNED_SERVER_FINGERPRINT,
  }, async () => {
    throw new Error('runtime adapter request timed out: response lost');
  })).rejects.toThrow('response lost');
  retryableReceipt = readStore(runtimeCommandLatestReceipt);
  if (!retryableReceipt) throw new Error('TEST_RETRYABLE_RECEIPT_MISSING');

  expect(await listUnresolvedRemoteRuntimeCommandIntents(runtimeId, SIGNED_SERVER_FINGERPRINT)).toMatchObject([{
    commandId: retryableReceipt.commandId,
    runtimeId,
    input,
    status: 'pending',
  }]);

  await expect(submitRuntimeCommand({
    input: structuredClone(input),
    runtimeId,
    mode: 'remote',
    serverFingerprint: SIGNED_SERVER_FINGERPRINT,
    ...runtimeCommandRetryOptions(retryableReceipt),
  }, async (progress) => {
    await progress.accepted(9, { receiptId: 'journal-receipt', statusUrl: '/receipt/journal-receipt' });
    throw new Error('runtime projection timed out after acceptance');
  })).rejects.toThrow('timed out');
  retryableReceipt = readStore(runtimeCommandLatestReceipt);
  if (!retryableReceipt) throw new Error('TEST_ACCEPTED_RECEIPT_MISSING');

  expect(await listUnresolvedRemoteRuntimeCommandIntents(runtimeId, SIGNED_SERVER_FINGERPRINT)).toMatchObject([{
    commandId: retryableReceipt.commandId,
    input,
    status: 'accepted',
    upstreamReceiptId: 'journal-receipt',
    statusUrl: '/receipt/journal-receipt',
  }]);

  await submitRuntimeCommand({
    input: structuredClone(input),
    runtimeId,
    mode: 'remote',
    serverFingerprint: SIGNED_SERVER_FINGERPRINT,
    ...runtimeCommandRetryOptions(retryableReceipt),
  }, async (progress) => {
    await progress.accepted(9, { receiptId: 'journal-receipt', statusUrl: '/receipt/journal-receipt' });
    await progress.observed(10);
    return null;
  });
  expect(await listUnresolvedRemoteRuntimeCommandIntents(runtimeId, SIGNED_SERVER_FINGERPRINT)).toEqual([]);
});

test('runtime command bus records server ingress receipts without fake RuntimeInput', () => {
  clearRuntimeCommandReceipts();

  const receipt = recordRuntimeIngressReceipt({
    runtimeId: 'server-runtime',
    mode: 'remote',
    receipt: {
      id: 'credit-1',
      status: 'pending',
      counts: { runtimeTxs: 0, entityInputs: 1, jInputs: 0 },
      enqueuedHeight: 12,
    },
    statusUrl: '/api/control/runtime-input/credit-1/status',
  });

  expect(receipt.status).toBe('accepted');
  expect(receipt.runtimeId).toBe('server-runtime');
  expect(receipt.mode).toBe('remote');
  expect(receipt.upstreamReceiptId).toBe('credit-1');
  expect(receipt.acceptedAtHeight).toBe(12);
  expect(receipt.statusUrl).toBe('/api/control/runtime-input/credit-1/status');
  expect(receipt.inputSummary).toEqual({
    runtimeTxs: 0,
    entityInputs: 1,
    jInputs: 0,
    entityTxs: 0,
  });
  expect(readStore(runtimeCommandLatestReceipt)).toEqual(receipt);
  expect(receipt.failureKind).toBeNull();
  expect(receipt.failureRetryable).toBe(false);

  const observed = recordRuntimeIngressReceipt({
    runtimeId: 'server-runtime',
    mode: 'remote',
    receipt: {
      id: 'credit-1',
      status: 'observed',
      counts: { runtimeTxs: 0, entityInputs: 1, jInputs: 0 },
      enqueuedHeight: 12,
      observedHeight: 13,
    },
    statusUrl: '/api/control/runtime-input/credit-1/status',
  });
  expect(observed.status).toBe('observed');
  expect(observed.acceptedAtHeight).toBe(12);
  expect(observed.committedAtHeight).toBe(13);

  const expired = recordRuntimeIngressReceipt({
    runtimeId: 'server-runtime',
    mode: 'remote',
    receipt: {
      id: 'credit-expired',
      status: 'expired',
      note: 'Runtime ingress receipt expired',
      enqueuedHeight: 14,
    },
    statusUrl: '/api/control/runtime-input/credit-expired/status',
  });
  expect(expired.status).toBe('error');
  expect(expired.error).toBe('Runtime ingress receipt expired');
  expect(expired.failureKind).toBe('defer');
  expect(expired.failureRetryable).toBe(true);
});

test('xlnStore routes RuntimeInput mutations through RuntimeCommandBus', () => {
  const source = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  const routeIndex = source.indexOf('const routeRuntimeInput = async');
  expect(routeIndex).toBeGreaterThan(0);
  const routeSource = source.slice(routeIndex, source.indexOf('// Enqueue entity inputs', routeIndex));

  expect(routeSource).toContain('submitRuntimeCommand');
	  expect(routeSource).toContain('progress.accepted');
	  expect(source).toContain('const observeRemoteRuntimeCommand');
	  expect(routeSource).toContain('commandSequence: receipt.commandSequence');
	  expect(routeSource).toContain('await observeRemoteRuntimeCommand(accepted, progress)');
	  expect(source).toContain('statusUrl: accepted.statusUrl ?? null');
	  expect(source).toContain('waitForRemoteRuntimeReceiptObserved');
	  expect(source).toContain('progress.observed');
	  expect(routeSource).toContain('progress.committed');
	  expect(routeSource).toContain("runtimeAdapterSend(input, { commandId: receipt.commandId })");
	  expect(routeSource).toContain('const usesRemoteAdapter = Boolean');
	  expect(routeSource).toContain('REMOTE_RUNTIME_ENV_MISMATCH');
	  expect(routeSource).toContain('!targetRuntimeId || !handleRuntimeId || targetRuntimeId === handleRuntimeId');
	  expect(routeSource).toContain('mode: usesRemoteAdapter ? \'remote\' : \'embedded\'');
  expect(routeSource).toContain('if (usesRemoteAdapter)');
  expect(routeSource).toContain('embeddedAdapterTargetsRuntimeEnv(runtimeEnv)');
  expect(routeSource).toContain('xln.enqueueRuntimeInput(runtimeEnv, input)');
	  expect(source).not.toContain('commitAcceptedRuntimeCommands');
		  expect(source).not.toContain("registerDebugSurface('submit'");
		  expect(source).not.toContain('__xlnRuntimeSubmit');
	  expect(source).toContain("from './runtimeStore';");
	  expect(source).toContain('activeEnv');
	  expect(source).toContain('activeRuntimeId');
	  expect(source).toContain('runtimes');
	  expect(source).toContain('runtimeOperations');
	  expect(source).toContain('export async function submitActiveRuntimeInput');
	  expect(source).toContain('export async function submitActiveEntityInputs');
	  expect(source).toContain('export async function submitRuntimeInput');
	  expect(source).toContain('export async function submitEntityInputs');
	});

test('embedded command completion follows the submitted input, not unrelated consensus backlog', () => {
  const submitted: RuntimeInput = {
    runtimeTxs: [],
    entityInputs: [{
      entityId: '0xentity-a',
      signerId: '0xsigner-a',
      entityTxs: [{
        type: 'profile-update',
        data: { profile: { entityId: '0xentity-a', name: 'Alice', bio: '', website: '' } },
      } as never],
    }],
  };
  const committedWithBackground: RuntimeInput = {
    runtimeTxs: [],
    entityInputs: [
      structuredClone(submitted.entityInputs[0]!),
      {
        entityId: '0xentity-b',
        signerId: '0xsigner-b',
        entityTxs: [{ type: 'scheduledWake', data: { dueAt: 99n } } as never],
      },
    ],
  };
  const history = [{ height: 12, runtimeInput: committedWithBackground }] as never;

  expect(runtimeFrameContainsSubmittedInput(committedWithBackground, submitted)).toBe(true);
  expect(findCommittedEmbeddedRuntimeInputHeight(history, submitted, 11)).toBe(12);
  expect(findCommittedEmbeddedRuntimeInputHeight(history, submitted, 12)).toBeNull();
});

test('embedded command completion reads an evicted committed frame from durable storage', async () => {
  const submitted: RuntimeInput = {
    runtimeTxs: [],
    entityInputs: [{
      entityId: '0xentity-a',
      signerId: '0xsigner-a',
      entityTxs: [{ type: 'extendCredit', data: { tokenId: 3, amount: 10n } } as never],
    }],
  };
  const unrelated: RuntimeInput = {
    runtimeTxs: [],
    entityInputs: [{
      entityId: '0xentity-b',
      signerId: '0xsigner-b',
      entityTxs: [{ type: 'scheduledWake', data: {} } as never],
    }],
  };
  const frames = new Map([
    [19, { height: 19, runtimeInput: submitted }],
    [20, { height: 20, runtimeInput: unrelated }],
  ]);

  expect(findCommittedEmbeddedRuntimeInputHeight([frames.get(20)!] as never, submitted, 15)).toBeNull();
  expect(await findPersistedEmbeddedRuntimeInputHeight(
    async (height) => frames.get(height) ?? null,
    submitted,
    15,
    20,
  )).toBe(19);
});

test('embedded command completion is multiset-exact and accepts only derived HTLC fields', () => {
  const profileTx = {
    type: 'profile-update',
    data: { profile: { entityId: '0xentity-a', name: 'Alice', bio: '', website: '' } },
  } as never;
  const duplicateSubmission: RuntimeInput = {
    runtimeTxs: [],
    entityInputs: [{ entityId: '0xentity-a', signerId: '0xsigner-a', entityTxs: [profileTx, profileTx] }],
  };
  const oneApplied: RuntimeInput = {
    runtimeTxs: [],
    entityInputs: [{ entityId: '0xentity-a', signerId: '0xsigner-a', entityTxs: [profileTx] }],
  };
  expect(runtimeFrameContainsSubmittedInput(oneApplied, duplicateSubmission)).toBe(false);

  const rawPayment = {
    type: 'htlcPayment',
    data: { targetEntityId: '0xtarget', tokenId: 1, amount: 7n, description: 'rent' },
  } as never;
  const preparedPayment = {
    type: 'htlcPayment',
    data: {
      targetEntityId: '0xtarget', tokenId: 1, amount: 7n, description: 'rent',
      hashlock: '0xhash', route: ['0xhop'], envelope: { version: 1 },
    },
  } as never;
  const input = (tx: typeof rawPayment): RuntimeInput => ({
    runtimeTxs: [],
    entityInputs: [{ entityId: '0xentity-a', signerId: '0xsigner-a', entityTxs: [tx] }],
  });
  expect(runtimeFrameContainsSubmittedInput(input(preparedPayment), input(rawPayment))).toBe(true);
  expect(runtimeFrameContainsSubmittedInput(
    input({ ...preparedPayment, data: { ...preparedPayment.data, amount: 8n } } as never),
    input(rawPayment),
  )).toBe(false);
});

test('runtime controller forwards caller-owned commandId to the remote adapter', () => {
  const source = readFileSync('frontend/src/lib/stores/runtimeControllerStore.ts', 'utf8');
  const sendIndex = source.indexOf('export const runtimeAdapterSend');
  expect(sendIndex).toBeGreaterThan(0);
  const sendSource = source.slice(sendIndex, source.indexOf('\n};', sendIndex) + 3);

  expect(sendSource).toContain('options: RuntimeAdapterSendOptions = {}');
  expect(sendSource).toContain('adapter.send(input, options)');
});

test('public mutation exports no longer accept caller-owned RuntimeReplica', () => {
  const source = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  expect(source).not.toContain('assertSubmittedEnvMatchesActiveRuntime');

  const submitRuntimeIndex = source.indexOf('export async function submitRuntimeInput');
  const submitEntityIndex = source.indexOf('export async function submitEntityInputs');
  const utilityFunctionsIndex = source.indexOf('// === FRONTEND UTILITY FUNCTIONS ===');
  expect(submitRuntimeIndex).toBeGreaterThan(0);
  expect(submitEntityIndex).toBeGreaterThan(submitRuntimeIndex);
  expect(utilityFunctionsIndex).toBeGreaterThan(submitEntityIndex);

  const submitRuntimeSource = source.slice(submitRuntimeIndex, submitEntityIndex);
  expect(submitRuntimeSource).toContain('export async function submitRuntimeInput(');
  expect(submitRuntimeSource).toContain('commandOptions: RuntimeCommandExecutionOptions = {}');
  expect(submitRuntimeSource).toContain('return submitActiveRuntimeInput(input, commandOptions);');
  expect(submitRuntimeSource).not.toContain('env: RuntimeReplica');
  expect(submitRuntimeSource).not.toContain('assertSubmittedEnvMatchesActiveRuntime');
  expect(submitRuntimeSource).not.toContain('routeRuntimeInput(');

  const submitEntitySource = source.slice(submitEntityIndex, utilityFunctionsIndex);
  expect(submitEntitySource).toContain('export async function submitEntityInputs(inputs: RoutedEntityInput[] = [])');
  expect(submitEntitySource).toContain('return submitActiveEntityInputs(inputs);');
  expect(submitEntitySource).not.toContain('env: RuntimeReplica');
  expect(submitEntitySource).not.toContain('submitRuntimeInput(env');
  expect(submitEntitySource).not.toContain('assertSubmittedEnvMatchesActiveRuntime');
  expect(submitEntitySource).not.toContain('routeRuntimeInput(');
});

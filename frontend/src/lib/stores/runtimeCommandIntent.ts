import type { RuntimeInput } from '@xln/runtime/xln-api';
import {
  MAX_RECEIPT_ID_BYTES,
  MAX_STATUS_URL_BYTES,
  MAX_UNRESOLVED_REMOTE_INTENTS,
  canonicalRuntimeInput,
  createRuntimeCommandId,
  normalizeBoundedText,
  normalizeRuntimeCommandId,
  normalizeRuntimeCommandSequence,
  normalizeRuntimeId,
  normalizeRuntimeServerFingerprint,
  type RemoteRuntimeCommandIntent,
  type RemoteRuntimeCommandIntentStatus,
} from './runtimeCommandIntentCodec';
import {
  addProtectedRemoteRuntimeCommandIntent,
  countProtectedRemoteRuntimeCommandIntents,
  deleteProtectedRemoteRuntimeCommandIntent,
  isBrowserCommandJournal,
  readProtectedRemoteRuntimeCommandIntent,
  readProtectedRemoteRuntimeCommandIntents,
  writeProtectedRemoteRuntimeCommandIntent,
} from './runtimeCommandJournalStorage';

export type RuntimeCommandIntentOptions = { commandId?: string; commandSequence?: number };
export type { RemoteRuntimeCommandIntent, RemoteRuntimeCommandIntentStatus } from './runtimeCommandIntentCodec';
export { createRuntimeCommandId, normalizeRuntimeCommandId } from './runtimeCommandIntentCodec';

const JOURNAL_MUTATION_LOCK = 'xln-runtime-command-journal-mutation-v1';
let memoryIntents = new Map<string, RemoteRuntimeCommandIntent>();
let journalMutationTail: Promise<void> = Promise.resolve();

const cloneIntent = (intent: RemoteRuntimeCommandIntent): RemoteRuntimeCommandIntent => structuredClone(intent);

const serializeJournalMutation = <T>(operation: () => Promise<T>): Promise<T> => {
  const lockedOperation = async (): Promise<T> => {
    if (!isBrowserCommandJournal()) return operation();
    if (!navigator.locks) throw new Error('RUNTIME_COMMAND_JOURNAL_LOCKS_UNAVAILABLE');
    return navigator.locks.request(JOURNAL_MUTATION_LOCK, { mode: 'exclusive' }, operation);
  };
  const result = journalMutationTail.then(lockedOperation, lockedOperation);
  journalMutationTail = result.then(() => undefined, () => undefined);
  return result;
};

export const listUnresolvedRemoteRuntimeCommandIntents = async (
  runtimeId?: string,
  serverFingerprint?: string,
): Promise<RemoteRuntimeCommandIntent[]> => {
  const normalizedRuntimeId = runtimeId === undefined ? null : normalizeRuntimeId(runtimeId);
  const normalizedFingerprint = serverFingerprint === undefined
    ? null
    : normalizeRuntimeServerFingerprint(serverFingerprint);
  const intents = isBrowserCommandJournal()
    ? await readProtectedRemoteRuntimeCommandIntents(
        normalizedRuntimeId ?? undefined,
        normalizedFingerprint ?? undefined,
      )
    : [...memoryIntents.values()].map(cloneIntent);
  const runtimeIntents = intents.filter(intent => normalizedRuntimeId === null || intent.runtimeId === normalizedRuntimeId);
  if (normalizedFingerprint && runtimeIntents.some(intent => intent.serverFingerprint !== normalizedFingerprint)) {
    throw new Error(`RUNTIME_COMMAND_SERVER_IDENTITY_MISMATCH:${normalizedRuntimeId}`);
  }
  return runtimeIntents
    .sort((left, right) => left.createdAt - right.createdAt || left.commandId.localeCompare(right.commandId));
};

export const withRemoteRuntimeCommandReplayLease = async <T>(
  runtimeId: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  if (!isBrowserCommandJournal()) return operation();
  if (!navigator.locks) throw new Error('RUNTIME_COMMAND_REPLAY_LOCKS_UNAVAILABLE');
  let acquired = false;
  let result: T | undefined;
  await navigator.locks.request(
    `xln-runtime-command-replay:${normalizedRuntimeId}`,
    { mode: 'exclusive', ifAvailable: true },
    async lock => {
      if (!lock) return;
      acquired = true;
      result = await operation();
    },
  );
  if (!acquired) throw new Error(`RUNTIME_COMMAND_REPLAY_LEASE_BUSY:${normalizedRuntimeId}`);
  return result!;
};

export const resolveRemoteRuntimeCommandIntent = async (options: {
  input: RuntimeInput;
  runtimeId: string;
  serverFingerprint?: string;
  commandId?: string;
  commandSequence?: number;
  nextCommandSequence?: number | null;
}): Promise<RemoteRuntimeCommandIntent> => serializeJournalMutation(async () => {
  const runtimeId = normalizeRuntimeId(options.runtimeId);
  const serverFingerprint = normalizeRuntimeServerFingerprint(options.serverFingerprint);
  const canonical = canonicalRuntimeInput(options.input);
  const requestedCommandId = options.commandId === undefined ? null : normalizeRuntimeCommandId(options.commandId);
  const existing = requestedCommandId
    ? isBrowserCommandJournal()
      ? await readProtectedRemoteRuntimeCommandIntent(requestedCommandId)
      : memoryIntents.get(requestedCommandId)
    : undefined;
  if (existing) {
    if (
      existing.runtimeId !== runtimeId
      || existing.serverFingerprint !== serverFingerprint
      || existing.inputHash !== canonical.hash
    ) {
      throw new Error('RUNTIME_COMMAND_ID_PAYLOAD_MISMATCH');
    }
    if (
      options.commandSequence !== undefined
      && existing.commandSequence !== normalizeRuntimeCommandSequence(options.commandSequence)
    ) throw new Error('RUNTIME_COMMAND_SEQUENCE_MISMATCH');
    return cloneIntent(existing);
  }
  if (requestedCommandId) throw new Error(`RUNTIME_COMMAND_INTENT_NOT_FOUND:${requestedCommandId}`);
  const recordCount = isBrowserCommandJournal()
    ? await countProtectedRemoteRuntimeCommandIntents()
    : memoryIntents.size;
  if (recordCount >= MAX_UNRESOLVED_REMOTE_INTENTS) {
    throw new Error(`RUNTIME_COMMAND_INTENT_LIMIT_EXCEEDED: max=${MAX_UNRESOLVED_REMOTE_INTENTS}`);
  }
  const unresolved = isBrowserCommandJournal()
    ? await readProtectedRemoteRuntimeCommandIntents(runtimeId, serverFingerprint)
    : [...memoryIntents.values()].filter(candidate =>
        candidate.runtimeId === runtimeId && candidate.serverFingerprint === serverFingerprint);
  const serverNext = options.nextCommandSequence == null
    ? 1
    : normalizeRuntimeCommandSequence(options.nextCommandSequence);
  const commandSequence = Math.max(
    serverNext,
    ...unresolved.map(candidate => normalizeRuntimeCommandSequence(candidate.commandSequence) + 1),
  );
  const intent: RemoteRuntimeCommandIntent = {
    commandId: createRuntimeCommandId(), commandSequence, runtimeId, serverFingerprint, inputHash: canonical.hash,
    input: canonical.input, status: 'pending', createdAt: Date.now(), upstreamReceiptId: null, statusUrl: null,
  };
  if (!isBrowserCommandJournal()) memoryIntents.set(intent.commandId, cloneIntent(intent));
  else {
    try {
      await addProtectedRemoteRuntimeCommandIntent(intent, canonical.encoded);
    } catch (error) {
      const concurrent = await readProtectedRemoteRuntimeCommandIntent(intent.commandId);
      if (
        !concurrent
        || concurrent.runtimeId !== runtimeId
        || concurrent.serverFingerprint !== serverFingerprint
        || concurrent.inputHash !== canonical.hash
      ) throw error;
    }
  }
  return cloneIntent(intent);
});

export const resolveRemoteRuntimeCommandId = async (options: Parameters<
  typeof resolveRemoteRuntimeCommandIntent
>[0]): Promise<string> => (await resolveRemoteRuntimeCommandIntent(options)).commandId;

export const markRemoteRuntimeCommandIntentAccepted = async (
  commandId: string,
  upstream: { receiptId?: string | null; statusUrl?: string | null },
): Promise<void> => serializeJournalMutation(async () => {
  const normalizedCommandId = normalizeRuntimeCommandId(commandId);
  const existing = isBrowserCommandJournal()
    ? await readProtectedRemoteRuntimeCommandIntent(normalizedCommandId)
    : memoryIntents.get(normalizedCommandId);
  if (!existing) throw new Error(`RUNTIME_COMMAND_INTENT_NOT_FOUND:${normalizedCommandId}`);
  const updated: RemoteRuntimeCommandIntent = {
    ...existing,
    status: 'accepted',
    upstreamReceiptId: upstream.receiptId === undefined
      ? existing.upstreamReceiptId : normalizeBoundedText(upstream.receiptId, 'RECEIPT_ID', MAX_RECEIPT_ID_BYTES) || null,
    statusUrl: upstream.statusUrl === undefined
      ? existing.statusUrl : normalizeBoundedText(upstream.statusUrl, 'STATUS_URL', MAX_STATUS_URL_BYTES) || null,
  };
  if (!isBrowserCommandJournal()) memoryIntents.set(normalizedCommandId, cloneIntent(updated));
  else await writeProtectedRemoteRuntimeCommandIntent(updated, canonicalRuntimeInput(updated.input).encoded);
});

export const settleRemoteRuntimeCommandIntent = async (commandId: string): Promise<void> =>
  serializeJournalMutation(async () => {
    const normalized = normalizeRuntimeCommandId(commandId);
    if (!isBrowserCommandJournal()) {
      memoryIntents.delete(normalized);
      return;
    }
    await deleteProtectedRemoteRuntimeCommandIntent(normalized);
  });

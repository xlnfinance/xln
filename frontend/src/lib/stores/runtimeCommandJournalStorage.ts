import type { RuntimeInput } from '@xln/runtime/xln-api';
import { safeParse, safeStringify } from '@xln/runtime/protocol/serialization';
import {
  MAX_RECEIPT_ID_BYTES,
  MAX_RUNTIME_INPUT_BYTES,
  MAX_STATUS_URL_BYTES,
  MAX_UNRESOLVED_REMOTE_INTENTS,
  canonicalRuntimeInput,
  normalizeBoundedText,
  normalizeRuntimeCommandId,
  normalizeRuntimeId,
  normalizeRuntimeServerFingerprint,
  type RemoteRuntimeCommandIntent,
  type RemoteRuntimeCommandIntentStatus,
} from './runtimeCommandIntentCodec';
import {
  computeRuntimeCommandInputHmac,
  requireRuntimeCommandJournalKeys,
} from './runtimeCommandJournalKeyring';
import {
  addRuntimeCommandJournalRecord,
  countRuntimeCommandJournalRecords,
  deleteRuntimeCommandJournalRecord,
  readRuntimeCommandJournalRecord,
  readRuntimeCommandJournalRecords,
  writeRuntimeCommandJournalRecord,
} from './runtimeCommandJournalIndexedDb';

export { isBrowserCommandJournal } from './runtimeCommandJournalIndexedDb';

export type PersistedRemoteRuntimeCommandIntent = {
  version: 3;
  commandId: string;
  runtimeId: string;
  serverFingerprint: string;
  inputHmac: string;
  payloadBytes: number;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
};

type EncryptedIntentPayload = Pick<
  RemoteRuntimeCommandIntent,
  'commandSequence' | 'inputHash' | 'input' | 'status' | 'createdAt' | 'upstreamReceiptId' | 'statusUrl'
>;

const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const MAX_ENCRYPTED_INTENT_BYTES = MAX_RUNTIME_INPUT_BYTES + 16 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const asArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const validateStatus = (value: unknown): RemoteRuntimeCommandIntentStatus => {
  if (value === 'pending' || value === 'accepted') return value;
  throw new Error('RUNTIME_COMMAND_INTENT_STORAGE_CORRUPT: status');
};

const validatePersistedRecord = (
  value: unknown,
  index = 0,
): PersistedRemoteRuntimeCommandIntent => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`RUNTIME_COMMAND_INTENT_STORAGE_CORRUPT: record=${index}`);
  }
  const record = value as Record<string, unknown>;
  if (record['version'] !== 3) {
    throw new Error(`RUNTIME_COMMAND_INTENT_STORAGE_VERSION_UNSUPPORTED:${String(record['version'])}`);
  }
  const commandId = normalizeRuntimeCommandId(String(record['commandId'] || ''));
  const runtimeId = normalizeRuntimeId(record['runtimeId']);
  const serverFingerprint = normalizeRuntimeServerFingerprint(record['serverFingerprint']);
  const inputHmac = String(record['inputHmac'] || '').trim().toLowerCase();
  if (!HASH_PATTERN.test(inputHmac)) {
    throw new Error(`RUNTIME_COMMAND_INTENT_STORAGE_CORRUPT: inputHmac=${index}`);
  }
  const payloadBytes = Number(record['payloadBytes']);
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0 || payloadBytes > MAX_ENCRYPTED_INTENT_BYTES) {
    throw new Error(`RUNTIME_COMMAND_INTENT_STORAGE_LIMIT_EXCEEDED: payloadBytes=${payloadBytes}`);
  }
  const iv = record['iv'];
  const ciphertext = record['ciphertext'];
  if (!(iv instanceof ArrayBuffer) || iv.byteLength !== 12) {
    throw new Error(`RUNTIME_COMMAND_INTENT_STORAGE_CORRUPT: iv=${index}`);
  }
  if (!(ciphertext instanceof ArrayBuffer) || ciphertext.byteLength !== payloadBytes + 16) {
    throw new Error(`RUNTIME_COMMAND_INTENT_STORAGE_CORRUPT: ciphertext=${index}`);
  }
  return { version: 3, commandId, runtimeId, serverFingerprint, inputHmac, payloadBytes, iv, ciphertext };
};

const recordAad = (
  record: Omit<PersistedRemoteRuntimeCommandIntent, 'iv' | 'ciphertext'>,
): Uint8Array => encoder.encode(safeStringify([
  record.version,
  record.commandId,
  record.runtimeId,
  record.serverFingerprint,
  record.inputHmac,
  record.payloadBytes,
]));

const validatedPayload = (value: unknown): EncryptedIntentPayload => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('RUNTIME_COMMAND_INTENT_STORAGE_CORRUPT: payload');
  }
  const payload = value as Record<string, unknown>;
  const input = payload['input'] as RuntimeInput;
  const canonical = canonicalRuntimeInput(input);
  const commandSequence = Number(payload['commandSequence']);
  if (!Number.isSafeInteger(commandSequence) || commandSequence <= 0) {
    throw new Error('RUNTIME_COMMAND_INTENT_STORAGE_CORRUPT: commandSequence');
  }
  const inputHash = String(payload['inputHash'] || '').trim().toLowerCase();
  if (!HASH_PATTERN.test(inputHash) || inputHash !== canonical.hash) {
    throw new Error('RUNTIME_COMMAND_INTENT_STORAGE_CORRUPT: payload hash');
  }
  const status = validateStatus(payload['status']);
  const createdAt = Number(payload['createdAt']);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error('RUNTIME_COMMAND_INTENT_STORAGE_CORRUPT: createdAt');
  }
  const upstreamReceiptId = payload['upstreamReceiptId'] === null
    ? null
    : normalizeBoundedText(payload['upstreamReceiptId'], 'RECEIPT_ID', MAX_RECEIPT_ID_BYTES);
  const statusUrl = payload['statusUrl'] === null
    ? null
    : normalizeBoundedText(payload['statusUrl'], 'STATUS_URL', MAX_STATUS_URL_BYTES);
  return { commandSequence, inputHash, input: canonical.input, status, createdAt, upstreamReceiptId, statusUrl };
};

export const encryptProtectedRemoteRuntimeCommandIntentRecord = async (
  intent: RemoteRuntimeCommandIntent,
  encoded: string,
): Promise<PersistedRemoteRuntimeCommandIntent> => {
  const runtimeId = normalizeRuntimeId(intent.runtimeId);
  const commandId = normalizeRuntimeCommandId(intent.commandId);
  const serverFingerprint = normalizeRuntimeServerFingerprint(intent.serverFingerprint);
  const canonical = canonicalRuntimeInput(intent.input);
  if (canonical.encoded !== encoded || canonical.hash !== intent.inputHash) {
    throw new Error('RUNTIME_COMMAND_INTENT_PAYLOAD_MISMATCH');
  }
  const payload = validatedPayload({
    commandSequence: intent.commandSequence,
    inputHash: canonical.hash,
    input: canonical.input,
    status: intent.status,
    createdAt: intent.createdAt,
    upstreamReceiptId: intent.upstreamReceiptId,
    statusUrl: intent.statusUrl,
  });
  const plaintext = encoder.encode(safeStringify(payload));
  if (plaintext.byteLength > MAX_ENCRYPTED_INTENT_BYTES) {
    throw new Error(`RUNTIME_COMMAND_INTENT_STORAGE_LIMIT_EXCEEDED: payloadBytes=${plaintext.byteLength}`);
  }
  const inputHmac = await computeRuntimeCommandInputHmac(runtimeId, commandId, encoded);
  const base = {
    version: 3 as const,
    commandId,
    runtimeId,
    serverFingerprint,
    inputHmac,
    payloadBytes: plaintext.byteLength,
  };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const { encryption } = requireRuntimeCommandJournalKeys(runtimeId);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(iv), additionalData: asArrayBuffer(recordAad(base)) },
    encryption,
    asArrayBuffer(plaintext),
  );
  return { ...base, iv: asArrayBuffer(iv), ciphertext };
};

export const decryptProtectedRemoteRuntimeCommandIntentRecord = async (
  raw: unknown,
): Promise<RemoteRuntimeCommandIntent> => {
  const record = validatePersistedRecord(raw);
  const { iv, ciphertext, ...metadata } = record;
  const { encryption } = requireRuntimeCommandJournalKeys(record.runtimeId);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: asArrayBuffer(recordAad(metadata)) },
      encryption,
      ciphertext,
    );
  } catch (error) {
    throw new Error(`RUNTIME_COMMAND_INTENT_DECRYPT_FAILED:${record.commandId}`, { cause: error });
  }
  if (plaintext.byteLength !== record.payloadBytes) {
    throw new Error('RUNTIME_COMMAND_INTENT_STORAGE_CORRUPT: plaintext size');
  }
  const payload = validatedPayload(safeParse<unknown>(decoder.decode(plaintext)));
  const canonical = canonicalRuntimeInput(payload.input);
  if (await computeRuntimeCommandInputHmac(record.runtimeId, record.commandId, canonical.encoded) !== record.inputHmac) {
    throw new Error('RUNTIME_COMMAND_INTENT_STORAGE_CORRUPT: input HMAC');
  }
  return {
    commandId: record.commandId,
    runtimeId: record.runtimeId,
    serverFingerprint: record.serverFingerprint,
    ...payload,
  };
};

export const readProtectedRemoteRuntimeCommandIntents = async (
  runtimeIdValue?: string,
  serverFingerprintValue?: string,
): Promise<RemoteRuntimeCommandIntent[]> => {
  const raw = await readRuntimeCommandJournalRecords(MAX_UNRESOLVED_REMOTE_INTENTS + 1);
  if (!Array.isArray(raw) || raw.length > MAX_UNRESOLVED_REMOTE_INTENTS) {
    throw new Error(`RUNTIME_COMMAND_INTENT_STORAGE_LIMIT_EXCEEDED: count=${Array.isArray(raw) ? raw.length : -1}`);
  }
  const records = raw.map((record, index) => validatePersistedRecord(record, index));
  if (new Set(records.map(record => record.commandId)).size !== records.length) {
    throw new Error('RUNTIME_COMMAND_INTENT_STORAGE_CORRUPT: duplicate commandId');
  }
  const runtimeId = runtimeIdValue === undefined ? null : normalizeRuntimeId(runtimeIdValue);
  const fingerprint = serverFingerprintValue === undefined
    ? null
    : normalizeRuntimeServerFingerprint(serverFingerprintValue);
  const selected = records.filter(record => runtimeId === null || record.runtimeId === runtimeId);
  if (fingerprint && selected.some(record => record.serverFingerprint !== fingerprint)) {
    throw new Error(`RUNTIME_COMMAND_SERVER_IDENTITY_MISMATCH:${runtimeId}`);
  }
  const intents = await Promise.all(selected.map(decryptProtectedRemoteRuntimeCommandIntentRecord));
  return intents.sort((left, right) => left.createdAt - right.createdAt || left.commandId.localeCompare(right.commandId));
};

export const countProtectedRemoteRuntimeCommandIntents = async (): Promise<number> => {
  const count = await countRuntimeCommandJournalRecords();
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_UNRESOLVED_REMOTE_INTENTS) {
    throw new Error(`RUNTIME_COMMAND_INTENT_STORAGE_LIMIT_EXCEEDED: count=${String(count)}`);
  }
  return count;
};

export const readProtectedRemoteRuntimeCommandIntent = async (
  commandIdValue: string,
): Promise<RemoteRuntimeCommandIntent | undefined> => {
  const commandId = normalizeRuntimeCommandId(commandIdValue);
  const raw = await readRuntimeCommandJournalRecord(commandId);
  return raw === undefined ? undefined : decryptProtectedRemoteRuntimeCommandIntentRecord(raw);
};

export const addProtectedRemoteRuntimeCommandIntent = async (
  intent: RemoteRuntimeCommandIntent,
  encoded: string,
): Promise<void> => {
  const persisted = await encryptProtectedRemoteRuntimeCommandIntentRecord(intent, encoded);
  await addRuntimeCommandJournalRecord(persisted);
};

export const writeProtectedRemoteRuntimeCommandIntent = async (
  intent: RemoteRuntimeCommandIntent,
  encoded: string,
): Promise<void> => {
  const persisted = await encryptProtectedRemoteRuntimeCommandIntentRecord(intent, encoded);
  await writeRuntimeCommandJournalRecord(persisted);
};

export const deleteProtectedRemoteRuntimeCommandIntent = async (commandIdValue: string): Promise<void> => {
  const commandId = normalizeRuntimeCommandId(commandIdValue);
  const existing = await readProtectedRemoteRuntimeCommandIntent(commandId);
  if (!existing) return;
  await deleteRuntimeCommandJournalRecord(commandId);
};

import { createHash } from 'node:crypto';
import type { RuntimeInput } from '../types';
import { serializeTaggedJson } from '../protocol/serialization';
import { requireBoundaryInteger } from '../protocol/boundary-validation';

export type RuntimeIngressReceiptStatus = 'pending' | 'observed' | 'expired';

export type RuntimeIngressCounts = {
  runtimeTxs: number;
  entityInputs: number;
  jInputs: number;
};

export type RuntimeIngressReceipt = {
  id: string;
  kind: string;
  status: RuntimeIngressReceiptStatus;
  counts: RuntimeIngressCounts;
  enqueuedAt: number;
  enqueuedHeight: number;
  inputHash?: string;
  inputFingerprints?: string[];
  observedHeight?: number;
  expiresAt: number;
  note?: string;
};

export type RegisterReceiptOptions = {
  id?: string;
  kind: string;
  counts: RuntimeIngressCounts;
  enqueuedHeight: number;
  runtimeInput?: RuntimeInput;
  inputHash?: string;
  inputFingerprints?: string[];
  note?: string;
};

export const projectRuntimeIngressReceiptForWire = (
  receipt: RuntimeIngressReceipt,
): RuntimeIngressReceipt => {
  if (typeof receipt.id !== 'string' || receipt.id.length === 0) {
    throw new Error('RUNTIME_INGRESS_RECEIPT_ID_INVALID');
  }
  if (typeof receipt.kind !== 'string' || receipt.kind.length === 0) {
    throw new Error('RUNTIME_INGRESS_RECEIPT_KIND_INVALID');
  }
  if (receipt.status !== 'pending' && receipt.status !== 'observed' && receipt.status !== 'expired') {
    throw new Error('RUNTIME_INGRESS_RECEIPT_STATUS_INVALID');
  }
  const counts = {
    runtimeTxs: requireBoundaryInteger(receipt.counts?.runtimeTxs, 'RUNTIME_INGRESS_RECEIPT_RUNTIME_TXS_INVALID'),
    entityInputs: requireBoundaryInteger(receipt.counts?.entityInputs, 'RUNTIME_INGRESS_RECEIPT_ENTITY_INPUTS_INVALID'),
    jInputs: requireBoundaryInteger(receipt.counts?.jInputs, 'RUNTIME_INGRESS_RECEIPT_J_INPUTS_INVALID'),
  };
  if (receipt.inputHash !== undefined && typeof receipt.inputHash !== 'string') {
    throw new Error('RUNTIME_INGRESS_RECEIPT_INPUT_HASH_INVALID');
  }
  if (
    receipt.inputFingerprints !== undefined &&
    (!Array.isArray(receipt.inputFingerprints) || receipt.inputFingerprints.some(value => typeof value !== 'string'))
  ) {
    throw new Error('RUNTIME_INGRESS_RECEIPT_FINGERPRINTS_INVALID');
  }
  if (receipt.note !== undefined && typeof receipt.note !== 'string') {
    throw new Error('RUNTIME_INGRESS_RECEIPT_NOTE_INVALID');
  }
  return {
    id: receipt.id,
    kind: receipt.kind,
    status: receipt.status,
    counts,
    enqueuedAt: requireBoundaryInteger(receipt.enqueuedAt, 'RUNTIME_INGRESS_RECEIPT_ENQUEUED_AT_INVALID'),
    enqueuedHeight: requireBoundaryInteger(receipt.enqueuedHeight, 'RUNTIME_INGRESS_RECEIPT_ENQUEUED_HEIGHT_INVALID'),
    ...(receipt.inputHash !== undefined ? { inputHash: receipt.inputHash } : {}),
    ...(receipt.inputFingerprints !== undefined ? { inputFingerprints: [...receipt.inputFingerprints] } : {}),
    ...(receipt.observedHeight !== undefined
      ? { observedHeight: requireBoundaryInteger(receipt.observedHeight, 'RUNTIME_INGRESS_RECEIPT_OBSERVED_HEIGHT_INVALID') }
      : {}),
    expiresAt: requireBoundaryInteger(receipt.expiresAt, 'RUNTIME_INGRESS_RECEIPT_EXPIRES_AT_INVALID'),
    ...(receipt.note !== undefined ? { note: receipt.note } : {}),
  };
};

type RuntimeIngressReceiptStoreOptions = {
  ttlMs?: number;
  now?: () => number;
};

const DEFAULT_RECEIPT_TTL_MS = 10 * 60_000;

const normalizeHeight = (height: number): number =>
  Number.isFinite(height) && height > 0 ? Math.floor(height) : 0;

const normalizeRuntimeInputForReceipt = (input: RuntimeInput): RuntimeInput => ({
  runtimeTxs: Array.isArray(input.runtimeTxs) ? input.runtimeTxs : [],
  entityInputs: Array.isArray(input.entityInputs) ? input.entityInputs : [],
  ...(Array.isArray(input.jInputs) ? { jInputs: input.jInputs } : { jInputs: [] }),
});

export const hashRuntimeIngressInput = (input: RuntimeInput): string =>
  `sha256:${createHash('sha256').update(serializeTaggedJson(normalizeRuntimeInputForReceipt(input))).digest('hex')}`;

const hashRuntimeIngressPart = (value: unknown): string =>
  `sha256:${createHash('sha256').update(serializeTaggedJson(value)).digest('hex')}`;

export const fingerprintRuntimeIngressInput = (input: RuntimeInput): string[] => {
  const normalized = normalizeRuntimeInputForReceipt(input);
  const fingerprints: string[] = [];
  for (const runtimeTx of normalized.runtimeTxs) {
    fingerprints.push(hashRuntimeIngressPart({ kind: 'runtimeTx', runtimeTx }));
  }
  for (const entityInput of normalized.entityInputs) {
    const entityId = String(entityInput.entityId || '').trim().toLowerCase();
    const signerId = String(entityInput.signerId || '').trim().toLowerCase();
    for (const entityTx of entityInput.entityTxs ?? []) {
      fingerprints.push(hashRuntimeIngressPart({ kind: 'entityTx', entityId, signerId, entityTx }));
    }
    if (entityInput.proposedFrame) {
      fingerprints.push(hashRuntimeIngressPart({ kind: 'proposedFrame', entityId, signerId, proposedFrame: entityInput.proposedFrame }));
    }
    if (entityInput.hashPrecommits && entityInput.hashPrecommits.size > 0) {
      fingerprints.push(hashRuntimeIngressPart({
        kind: 'hashPrecommits',
        entityId,
        signerId,
        hashPrecommitFrame: entityInput.hashPrecommitFrame,
        hashPrecommits: entityInput.hashPrecommits,
      }));
    }
  }
  for (const jInput of normalized.jInputs ?? []) {
    for (const jTx of jInput.jTxs ?? []) {
      fingerprints.push(hashRuntimeIngressPart({ kind: 'jTx', jurisdictionName: jInput.jurisdictionName, jTx }));
    }
  }
  return fingerprints;
};

const containsAllFingerprints = (available: string[], required: string[]): boolean => {
  const counts = new Map<string, number>();
  for (const fingerprint of available) {
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  }
  for (const fingerprint of required) {
    const count = counts.get(fingerprint) ?? 0;
    if (count <= 0) return false;
    counts.set(fingerprint, count - 1);
  }
  return true;
};

const createReceiptId = (): string => {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random;
  return `ingress_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

export const createRuntimeIngressReceiptStore = (options: RuntimeIngressReceiptStoreOptions = {}) => {
  const ttlMs = Math.max(1_000, options.ttlMs ?? DEFAULT_RECEIPT_TTL_MS);
  const now = options.now ?? (() => Date.now());
  const receipts = new Map<string, RuntimeIngressReceipt>();

  const expireOldReceipts = (): void => {
    const timestamp = now();
    for (const [id, receipt] of receipts) {
      if (receipt.status === 'pending' && timestamp >= receipt.expiresAt) {
        receipts.set(id, { ...receipt, status: 'expired' });
      } else if (timestamp >= receipt.expiresAt + ttlMs) {
        receipts.delete(id);
      }
    }
  };

  const observeRuntimeInput = (height: number, runtimeInput: RuntimeInput): void => {
    expireOldReceipts();
    const observedHeight = normalizeHeight(height);
    const observedInputHash = hashRuntimeIngressInput(runtimeInput);
    const observedFingerprints = fingerprintRuntimeIngressInput(runtimeInput);
    for (const [id, receipt] of receipts) {
      if (receipt.status !== 'pending') continue;
      if (observedHeight <= receipt.enqueuedHeight) continue;
      const requiredFingerprints = receipt.inputFingerprints ?? [];
      if (requiredFingerprints.length > 0) {
        if (!containsAllFingerprints(observedFingerprints, requiredFingerprints)) continue;
      } else if (!receipt.inputHash || receipt.inputHash !== observedInputHash) {
        continue;
      }
      receipts.set(id, {
        ...receipt,
        status: 'observed',
        observedHeight,
        note:
          receipt.note ??
          'Runtime frame committed the accepted input; inspect entity/account state for semantic commit details.',
      });
    }
  };

  return {
    register(input: RegisterReceiptOptions): RuntimeIngressReceipt {
      expireOldReceipts();
      const enqueuedAt = now();
      const receipt: RuntimeIngressReceipt = {
        id: input.id || createReceiptId(),
        kind: input.kind,
        status: 'pending',
        counts: input.counts,
        enqueuedAt,
        enqueuedHeight: normalizeHeight(input.enqueuedHeight),
        ...(input.inputHash || input.runtimeInput ? { inputHash: input.inputHash ?? hashRuntimeIngressInput(input.runtimeInput!) } : {}),
        ...(input.inputFingerprints || input.runtimeInput
          ? { inputFingerprints: input.inputFingerprints ?? fingerprintRuntimeIngressInput(input.runtimeInput!) }
          : {}),
        expiresAt: enqueuedAt + ttlMs,
        ...(input.note ? { note: input.note } : {}),
      };
      receipts.set(receipt.id, receipt);
      return receipt;
    },

    observeRuntimeInput,

    observeLatestRuntimeFrame(env: { history?: Array<{ height: number; runtimeInput: RuntimeInput }> }): void {
      const latestFrame = Array.isArray(env.history) ? env.history.at(-1) : undefined;
      if (!latestFrame?.runtimeInput) return;
      observeRuntimeInput(latestFrame.height, latestFrame.runtimeInput);
    },

    get(id: string): RuntimeIngressReceipt | null {
      expireOldReceipts();
      return receipts.get(id) ?? null;
    },

    size(): number {
      expireOldReceipts();
      return receipts.size;
    },
  };
};

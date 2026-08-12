import { createHash } from 'node:crypto';
import type { RuntimeInput } from '../types';
import { serializeTaggedJson } from '../../protocol/serialization';
import { requireBoundaryInteger } from '../../protocol/boundary-validation';

type RuntimeIngressReceiptStatus = 'pending' | 'observed' | 'expired';

type RuntimeIngressCounts = {
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
  observedFingerprintCount?: number;
  requiredFingerprintCount?: number;
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
    ...(receipt.observedFingerprintCount !== undefined
      ? {
          observedFingerprintCount: requireBoundaryInteger(
            receipt.observedFingerprintCount,
            'RUNTIME_INGRESS_RECEIPT_OBSERVED_FINGERPRINT_COUNT_INVALID',
          ),
        }
      : {}),
    ...(receipt.requiredFingerprintCount !== undefined
      ? {
          requiredFingerprintCount: requireBoundaryInteger(
            receipt.requiredFingerprintCount,
            'RUNTIME_INGRESS_RECEIPT_REQUIRED_FINGERPRINT_COUNT_INVALID',
          ),
        }
      : {}),
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

const hashRuntimeIngressInput = (input: RuntimeInput): string =>
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

const consumeObservedFingerprints = (remaining: string[], observed: string[]): string[] => {
  const observedCounts = new Map<string, number>();
  for (const fingerprint of observed) {
    observedCounts.set(fingerprint, (observedCounts.get(fingerprint) ?? 0) + 1);
  }
  return remaining.filter((fingerprint) => {
    const count = observedCounts.get(fingerprint) ?? 0;
    if (count <= 0) return true;
    observedCounts.set(fingerprint, count - 1);
    return false;
  });
};

const createReceiptId = (): string => {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random;
  return `ingress_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

type ReceiptFingerprintProgress = {
  remaining: string[];
  lastObservedFrameKey?: string;
};

type RuntimeIngressReceiptStoreState = {
  ttlMs: number;
  now(): number;
  receipts: Map<string, RuntimeIngressReceipt>;
  fingerprintProgress: Map<string, ReceiptFingerprintProgress>;
};

const expireOldReceipts = (state: RuntimeIngressReceiptStoreState): void => {
  const timestamp = state.now();
  for (const [id, receipt] of state.receipts) {
    if (receipt.status === 'pending' && timestamp >= receipt.expiresAt) {
      state.receipts.set(id, { ...receipt, status: 'expired' });
    } else if (timestamp >= receipt.expiresAt + state.ttlMs) {
      state.receipts.delete(id);
      state.fingerprintProgress.delete(id);
    }
  }
};

const observeRuntimeInput = (
  state: RuntimeIngressReceiptStoreState,
  height: number,
  runtimeInput: RuntimeInput,
): void => {
  expireOldReceipts(state);
  const observedHeight = normalizeHeight(height);
  const observedInputHash = hashRuntimeIngressInput(runtimeInput);
  const observedFingerprints = fingerprintRuntimeIngressInput(runtimeInput);
  for (const [id, receipt] of state.receipts) {
    if (receipt.status !== 'pending' || observedHeight <= receipt.enqueuedHeight) continue;
    const required = receipt.inputFingerprints ?? [];
    if (required.length > 0) {
      const progress = state.fingerprintProgress.get(id) ?? { remaining: [...required] };
      const frameKey = `${observedHeight}:${observedInputHash}`;
      if (progress.lastObservedFrameKey === frameKey) continue;
      const remaining = consumeObservedFingerprints(progress.remaining, observedFingerprints);
      state.fingerprintProgress.set(id, { remaining, lastObservedFrameKey: frameKey });
      if (remaining.length > 0) {
        if (remaining.length !== progress.remaining.length) {
          state.receipts.set(id, {
            ...receipt,
            observedFingerprintCount: required.length - remaining.length,
            requiredFingerprintCount: required.length,
          });
        }
        continue;
      }
    } else if (!receipt.inputHash || receipt.inputHash !== observedInputHash) {
      continue;
    }
    state.receipts.set(id, {
      ...receipt,
      status: 'observed',
      ...(required.length > 0
        ? {
            observedFingerprintCount: required.length,
            requiredFingerprintCount: required.length,
          }
        : {}),
      observedHeight,
      note:
        receipt.note ??
        'Runtime frame committed the accepted input; inspect entity/account state for semantic commit details.',
    });
  }
};

const registerRuntimeIngressReceipt = (
  state: RuntimeIngressReceiptStoreState,
  input: RegisterReceiptOptions,
): RuntimeIngressReceipt => {
  expireOldReceipts(state);
  const enqueuedAt = state.now();
  const inputFingerprints = input.inputFingerprints ?? (
    input.runtimeInput ? fingerprintRuntimeIngressInput(input.runtimeInput) : undefined
  );
  const inputHash = input.inputHash ?? (
    input.runtimeInput ? hashRuntimeIngressInput(input.runtimeInput) : undefined
  );
  const receipt: RuntimeIngressReceipt = {
    id: input.id || createReceiptId(),
    kind: input.kind,
    status: 'pending',
    counts: input.counts,
    enqueuedAt,
    enqueuedHeight: normalizeHeight(input.enqueuedHeight),
    ...(inputHash === undefined ? {} : { inputHash }),
    ...(inputFingerprints === undefined
      ? {}
      : {
          inputFingerprints,
          observedFingerprintCount: 0,
          requiredFingerprintCount: inputFingerprints.length,
        }),
    expiresAt: enqueuedAt + state.ttlMs,
    ...(input.note ? { note: input.note } : {}),
  };
  state.receipts.set(receipt.id, receipt);
  if ((receipt.inputFingerprints?.length ?? 0) > 0) {
    state.fingerprintProgress.set(receipt.id, {
      remaining: [...receipt.inputFingerprints!],
    });
  }
  return receipt;
};

export const createRuntimeIngressReceiptStore = (
  options: RuntimeIngressReceiptStoreOptions = {},
) => {
  const state: RuntimeIngressReceiptStoreState = {
    ttlMs: Math.max(1_000, options.ttlMs ?? DEFAULT_RECEIPT_TTL_MS),
    now: options.now ?? (() => Date.now()),
    receipts: new Map<string, RuntimeIngressReceipt>(),
    fingerprintProgress: new Map<string, ReceiptFingerprintProgress>(),
  };

  return {
    register(input: RegisterReceiptOptions): RuntimeIngressReceipt {
      return registerRuntimeIngressReceipt(state, input);
    },

    observeRuntimeInput(height: number, runtimeInput: RuntimeInput): void {
      observeRuntimeInput(state, height, runtimeInput);
    },

    get(id: string): RuntimeIngressReceipt | null {
      expireOldReceipts(state);
      return state.receipts.get(id) ?? null;
    },

    size(): number {
      expireOldReceipts(state);
      return state.receipts.size;
    },
  };
};

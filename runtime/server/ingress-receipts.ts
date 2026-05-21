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
  observedHeight?: number;
  expiresAt: number;
  note?: string;
};

type RegisterReceiptOptions = {
  id?: string;
  kind: string;
  counts: RuntimeIngressCounts;
  enqueuedHeight: number;
  note?: string;
};

type RuntimeIngressReceiptStoreOptions = {
  ttlMs?: number;
  now?: () => number;
};

const DEFAULT_RECEIPT_TTL_MS = 10 * 60_000;

const normalizeHeight = (height: number): number =>
  Number.isFinite(height) && height > 0 ? Math.floor(height) : 0;

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
        expiresAt: enqueuedAt + ttlMs,
        ...(input.note ? { note: input.note } : {}),
      };
      receipts.set(receipt.id, receipt);
      return receipt;
    },

    observeHeight(height: number): void {
      expireOldReceipts();
      const observedHeight = normalizeHeight(height);
      for (const [id, receipt] of receipts) {
        if (receipt.status !== 'pending') continue;
        if (observedHeight <= receipt.enqueuedHeight) continue;
        receipts.set(id, {
          ...receipt,
          status: 'observed',
          observedHeight,
          note:
            receipt.note ??
            'Runtime frame advanced after enqueue; inspect entity/account state for semantic commit details.',
        });
      }
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

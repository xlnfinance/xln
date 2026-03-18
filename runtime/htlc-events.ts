import type { EntityState } from './types';

const PAYMENT_TS_MARKER_RE = /(?:^|\s)tsms:(\d{10,})(?=$|\s)/i;

export const extractStartedAtMs = (description?: string): number | null => {
  const match = String(description || '').match(PAYMENT_TS_MARKER_RE);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export const buildHtlcReceivedTimingFields = (description: string | undefined, receivedAtMs: number) => {
  const startedAtMs = extractStartedAtMs(description);
  if (!startedAtMs) {
    return { receivedAtMs };
  }
  const elapsedMs = Math.max(1, receivedAtMs - startedAtMs);
  return {
    startedAtMs,
    receivedAtMs,
    elapsedMs,
    finalizedInMs: elapsedMs,
  };
};

export const buildHtlcFinalizedTimingFields = (description: string | undefined, finalizedAtMs: number) => {
  const startedAtMs = extractStartedAtMs(description);
  if (!startedAtMs) {
    return { finalizedAtMs };
  }
  const elapsedMs = Math.max(1, finalizedAtMs - startedAtMs);
  return {
    startedAtMs,
    finalizedAtMs,
    elapsedMs,
    finalizedInMs: elapsedMs,
  };
};

type CommonHtlcEventArgs = {
  entityId: string;
  fromEntity?: string;
  toEntity?: string;
  hashlock: string;
  lockId?: string;
  amount?: bigint;
  tokenId?: number;
  jurisdictionId?: string;
  description?: string;
};

export const buildHtlcReceivedEventPayload = (
  args: CommonHtlcEventArgs & { receivedAtMs: number },
): Record<string, unknown> => ({
  entityId: args.entityId,
  ...(args.fromEntity ? { fromEntity: args.fromEntity } : {}),
  ...(args.toEntity ? { toEntity: args.toEntity } : {}),
  hashlock: args.hashlock,
  ...(args.lockId ? { lockId: args.lockId } : {}),
  ...(args.amount !== undefined ? { amount: args.amount.toString() } : {}),
  ...(args.tokenId !== undefined ? { tokenId: args.tokenId } : {}),
  ...(args.jurisdictionId ? { jurisdictionId: args.jurisdictionId } : {}),
  ...(args.description ? { description: args.description } : {}),
  ...buildHtlcReceivedTimingFields(args.description, args.receivedAtMs),
});

export const buildHtlcFinalizedEventPayload = (
  args: CommonHtlcEventArgs & { finalizedAtMs: number; secret?: string },
): Record<string, unknown> => ({
  entityId: args.entityId,
  ...(args.fromEntity ? { fromEntity: args.fromEntity } : {}),
  ...(args.toEntity ? { toEntity: args.toEntity } : {}),
  hashlock: args.hashlock,
  ...(args.secret ? { secret: args.secret } : {}),
  ...(args.lockId ? { lockId: args.lockId } : {}),
  ...(args.amount !== undefined ? { amount: args.amount.toString() } : {}),
  ...(args.tokenId !== undefined ? { tokenId: args.tokenId } : {}),
  ...(args.jurisdictionId ? { jurisdictionId: args.jurisdictionId } : {}),
  ...(args.description ? { description: args.description } : {}),
  ...buildHtlcFinalizedTimingFields(args.description, args.finalizedAtMs),
});


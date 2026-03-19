export const buildHtlcReceivedTimingFields = (startedAtMs: number | undefined, receivedAtMs: number) => {
  if (!startedAtMs) {
    return { receivedAtMs };
  }
  const elapsedMs = Math.max(1, receivedAtMs - startedAtMs);
  return {
    startedAtMs,
    receivedAtMs,
    elapsedMs,
  };
};

export const buildHtlcFinalizedTimingFields = (startedAtMs: number | undefined, finalizedAtMs: number) => {
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
  startedAtMs?: number;
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
  ...buildHtlcReceivedTimingFields(args.startedAtMs, args.receivedAtMs),
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
  ...buildHtlcFinalizedTimingFields(args.startedAtMs, args.finalizedAtMs),
});

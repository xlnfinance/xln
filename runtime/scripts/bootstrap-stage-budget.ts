type HubMeshBudgetClock = {
  nowMs: number;
  resetStartedAt: number | null | undefined;
  spawnH1StartedAt: number | null | undefined;
  readyAt: number | null | undefined;
};

const requireTimestamp = (value: number, code: string): number => {
  if (!Number.isFinite(value) || value < 0) throw new Error(code);
  return value;
};

export const getHubMeshBudgetElapsedMs = ({
  nowMs,
  resetStartedAt,
  spawnH1StartedAt,
  readyAt,
}: HubMeshBudgetClock): number | null => {
  const now = requireTimestamp(nowMs, 'HUB_MESH_TIMING_NOW_INVALID');
  if (resetStartedAt === null || resetStartedAt === undefined) {
    if (readyAt !== null && readyAt !== undefined) throw new Error('HUB_MESH_TIMING_MISSING');
    return null;
  }
  const resetStart = requireTimestamp(resetStartedAt, 'HUB_MESH_RESET_TIMING_STARTED_AT_INVALID');
  if (spawnH1StartedAt === null || spawnH1StartedAt === undefined) {
    if (readyAt !== null && readyAt !== undefined) throw new Error('HUB_MESH_TIMING_MISSING');
    return null;
  }
  const hubStart = requireTimestamp(spawnH1StartedAt, 'HUB_MESH_TIMING_STARTED_AT_INVALID');
  if (hubStart < resetStart) {
    if (readyAt !== null && readyAt !== undefined) throw new Error('HUB_MESH_TIMING_MISSING');
    return null;
  }
  const end = readyAt === null || readyAt === undefined
    ? now
    : requireTimestamp(readyAt, 'HUB_MESH_TIMING_READY_AT_INVALID');
  if (end < hubStart) throw new Error('HUB_MESH_TIMING_ORDER_INVALID');
  return end - hubStart;
};

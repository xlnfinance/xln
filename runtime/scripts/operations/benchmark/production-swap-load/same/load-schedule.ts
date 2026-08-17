/** A bounded same-j load ladder executed against one already-running stack. */

export type SameLoadStage = Readonly<{
  swaps: number;
  lanes: number;
  laneOffset: number;
}>;

const requirePositiveInteger = (raw: string, code: string): number => {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${code}:${raw}`);
  return value;
};

export const parseSameLoadSchedule = (raw: string): readonly SameLoadStage[] => {
  const entries = raw.split(',').map(entry => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error('PRODUCTION_SWAP_LOAD_SCHEDULE_EMPTY');
  let laneOffset = 0;
  let previousSwaps = 0;
  return entries.map((entry, index) => {
    const parts = entry.split(':');
    if (parts.length !== 2) throw new Error(`PRODUCTION_SWAP_LOAD_SCHEDULE_ENTRY_INVALID:${index}`);
    const swaps = requirePositiveInteger(parts[0]!, 'PRODUCTION_SWAP_LOAD_SCHEDULE_SWAPS_INVALID');
    const lanes = requirePositiveInteger(parts[1]!, 'PRODUCTION_SWAP_LOAD_SCHEDULE_LANES_INVALID');
    if (swaps <= previousSwaps) throw new Error('PRODUCTION_SWAP_LOAD_SCHEDULE_NOT_ASCENDING');
    if (swaps !== lanes) {
      throw new Error(`PRODUCTION_SWAP_LOAD_SCHEDULE_ACCOUNT_FRAME_CAP_INVALID:${index}`);
    }
    const stage = { swaps, lanes, laneOffset };
    laneOffset += lanes;
    previousSwaps = swaps;
    return stage;
  });
};

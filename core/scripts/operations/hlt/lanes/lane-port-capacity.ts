/** Exact private TCP namespace needed by one isolated HLT population. */
export const hltLanePortsPerSlot = (users: number): number => {
  if (!Number.isSafeInteger(users) || users < 1 || users > 32_768) {
    throw new Error(`HLT_USERS_OUTSIDE_LANE_PORT_CAPACITY:${String(users)}`);
  }
  if (users <= 4_096) return 4_096;
  if (users <= 8_192) return 8_192;
  if (users <= 16_384) return 16_384;
  return 32_768;
};

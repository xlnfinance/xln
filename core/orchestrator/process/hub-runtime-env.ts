const RUNTIME_FRAME_DELAY_KEY = 'XLN_RUNTIME_MIN_FRAME_DELAY_MS';

/** Hub batching is owned by the Hub-specific knob, never an inherited wallet/runtime setting. */
export const applyHubRuntimeFrameDelay = (
  env: NodeJS.ProcessEnv,
  hubDelayMs: string | undefined,
): NodeJS.ProcessEnv => {
  const childEnv = { ...env };
  if (hubDelayMs === undefined) delete childEnv[RUNTIME_FRAME_DELAY_KEY];
  else childEnv[RUNTIME_FRAME_DELAY_KEY] = hubDelayMs;
  return childEnv;
};

const RUNTIME_FRAME_DELAY_KEY = 'XLN_RUNTIME_MIN_FRAME_DELAY_MS';
const HUB_STEADY_FRAME_PERIOD_KEY = 'XLN_HUB_STEADY_FRAME_PERIOD_MS';
// Measured steady-load default. A 250ms period reduced frame count 13.5% but
// regressed delivered payments 7.8%, because Account follow-ups were delayed.
export const DEFAULT_HUB_RUNTIME_FRAME_PERIOD_MS = 0;

/**
 * Hub bootstrap must drain immediately. The requested Hub period becomes live
 * only after mesh bootstrap is complete, so account opening and direct-route
 * readiness cannot be slowed or torn down mid-reset.
 */
export const applyHubRuntimeFrameDelay = (
  env: NodeJS.ProcessEnv,
  hubDelayMs: string | undefined,
): NodeJS.ProcessEnv => {
  const childEnv = { ...env };
  childEnv[RUNTIME_FRAME_DELAY_KEY] = '0';
  childEnv[HUB_STEADY_FRAME_PERIOD_KEY] =
    hubDelayMs ?? String(DEFAULT_HUB_RUNTIME_FRAME_PERIOD_MS);
  return childEnv;
};

export const readHubSteadyRuntimeFramePeriodMs = (
  env: NodeJS.ProcessEnv = process.env,
): number => {
  const raw = env[HUB_STEADY_FRAME_PERIOD_KEY];
  const value = raw === undefined ? DEFAULT_HUB_RUNTIME_FRAME_PERIOD_MS : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`HUB_STEADY_FRAME_PERIOD_MS_INVALID:${String(raw)}`);
  }
  return value;
};

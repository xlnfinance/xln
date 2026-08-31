/** Sole default for live production Runtime frame scheduling. */
export const PRODUCTION_RUNTIME_MIN_FRAME_DELAY_MS = 100;

export const resolveRuntimeMinFrameDelayMs = (
  raw: string | undefined,
  production: boolean,
): number => {
  if (raw === undefined) return production ? PRODUCTION_RUNTIME_MIN_FRAME_DELAY_MS : 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`RUNTIME_MIN_FRAME_DELAY_MS_INVALID:${raw}`);
  }
  return value;
};

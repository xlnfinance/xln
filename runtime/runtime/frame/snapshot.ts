import { hasRuntimeHistoryTraceForTesting } from '../../history-retention';
import type { Env, FrameLogEntry, RuntimeInput } from '../../types';
import { buildCanonicalEnvSnapshot } from '../../wal/snapshot';
import type { FrameExecutionState } from './execution-state';
import type { RuntimeProcessProfile } from './process-profile';

export const prepareRuntimeFrameCommit = (
  env: Env,
  liveEnv: Env,
  frameHeightBeforeTick: number,
  appliedInput: RuntimeInput | undefined,
  frame: FrameExecutionState,
  profile: RuntimeProcessProfile,
): boolean => {
  const frameAdvanced = env.height !== frameHeightBeforeTick;
  profile.metrics.frameAdvanced = frameAdvanced;
  if (frameAdvanced && hasRuntimeHistoryTraceForTesting(liveEnv)) {
    const logs = Array.isArray(env.frameLogs)
      ? env.frameLogs.map((entry): FrameLogEntry => ({ ...entry }))
      : [];
    frame.pendingTraceSnapshot = buildCanonicalEnvSnapshot(env, {
      runtimeInput: appliedInput ?? { runtimeTxs: [], entityInputs: [] },
      runtimeOutputs: env.pendingOutputs ?? [],
      description: env.extra?.description ?? `Frame ${env.height}`,
      meta: {
        title: env.extra?.subtitle?.title ?? `Frame ${env.height}`,
        ...(env.extra?.subtitle ? { subtitle: env.extra.subtitle } : {}),
        ...(env.frameDisplayMs !== undefined ? { displayMs: env.frameDisplayMs } : {}),
      },
      logs,
      gossipProfiles: env.gossip?.getProfiles ? env.gossip.getProfiles() : [],
    });
  }
  if (frameAdvanced) {
    env.history = [];
    profile.mark('snapshot');
  }
  env.extra = undefined;
  return frameAdvanced;
};

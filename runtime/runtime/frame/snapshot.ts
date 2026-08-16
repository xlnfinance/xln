import {
  hasRuntimeHistoryTraceForTesting,
} from '../observability/history-retention';
import { readRuntimeFrameEvents } from '../observability/env-events';
import type { RuntimeReplica, RuntimeInput } from '../types';
import { buildCanonicalEnvSnapshot } from '../../storage/wal/snapshot';
import type { FrameExecutionState } from './input/execution-state';
import type { RuntimeProcessProfile } from './process-profile';

export const prepareRuntimeFrameCommit = (
  env: RuntimeReplica,
  liveEnv: RuntimeReplica,
  frameHeightBeforeTick: number,
  appliedInput: RuntimeInput | undefined,
  frame: FrameExecutionState,
  profile: RuntimeProcessProfile,
): boolean => {
  const frameAdvanced = env.state.height !== frameHeightBeforeTick;
  profile.metrics.frameAdvanced = frameAdvanced;
  if (frameAdvanced && hasRuntimeHistoryTraceForTesting(liveEnv)) {
    const logs = readRuntimeFrameEvents(env);
    frame.pendingTraceSnapshot = buildCanonicalEnvSnapshot(env, {
      runtimeInput: appliedInput ?? { runtimeTxs: [], entityInputs: [] },
      runtimeOutputs: env.pendingOutputs ?? [],
      description: env.extra?.description ?? `Frame ${env.state.height}`,
      meta: {
        title: env.extra?.subtitle?.title ?? `Frame ${env.state.height}`,
        ...(env.extra?.subtitle ? { subtitle: env.extra.subtitle } : {}),
      },
      logs,
      gossipProfiles: env.gossip?.getProfiles ? env.gossip.getProfiles() : [],
    });
  }
  if (frameAdvanced) profile.mark('snapshot');
  env.extra = undefined;
  return frameAdvanced;
};

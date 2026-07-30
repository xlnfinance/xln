import type { EntityInput } from '../../entity/types';
import type { RuntimeReplica } from '../types';
import type { RuntimeProcessProfile } from './process-profile';

type RuntimeLifecycleState = NonNullable<RuntimeReplica['infrastructure']>;

export type RuntimeFrameStartDeps = {
  attachEventEmitters(env: RuntimeReplica): void;
  collectIngress(
    env: RuntimeReplica,
    inputs: EntityInput[] | undefined,
    state: RuntimeLifecycleState,
    runtimeDelay: number,
    profile: RuntimeProcessProfile,
  ): Promise<{ ready: true } | { ready: false; outcome: string }>;
};

export type RuntimeFrameStart = {
  ready: boolean;
  frameHeightBeforeTick: number;
  frameTimestampBeforeTick: number;
};

const stopAtDebugFrame = async (env: RuntimeReplica): Promise<void> => {
  if (env.stopAtFrame === undefined || env.state.height < env.stopAtFrame) return;
  console.log(`\n⏸️  FRAME STEPPING: Stopped at frame ${env.state.height}`);
  console.log('═'.repeat(80));
  const { formatRuntime } = await import('../../qa/runtime-ascii');
  console.log(formatRuntime(env, { maxAccounts: 10, maxLocks: 20, maxSwaps: 20 }));
  console.log('═'.repeat(80) + '\n');
  console.log('💾 State captured - use jq on /tmp/{scenario}-runtime.json for deep queries');
  throw new Error(`FRAME_STEP: Stopped at frame ${env.state.height} for debugging`);
};

export const startRuntimeFrame = async (
  env: RuntimeReplica,
  inputs: EntityInput[] | undefined,
  state: RuntimeLifecycleState,
  runtimeDelay: number,
  profile: RuntimeProcessProfile,
  deps: RuntimeFrameStartDeps,
): Promise<RuntimeFrameStart> => {
  // The baseline belongs to the acquired writer. Capturing it before the lock
  // can let a waiter overwrite a frame committed by its predecessor.
  const frameHeightBeforeTick = env.state.height;
  const frameTimestampBeforeTick = env.state.timestamp;
  env.lastProcessEnteredAt = Date.now();
  env.activeProcessProgressAt = env.lastProcessEnteredAt;
  env.activeProcessProgressStep = 'entered';
  if (!env.emit) deps.attachEventEmitters(env);
  await stopAtDebugFrame(env);

  const ingress = await deps.collectIngress(env, inputs, state, runtimeDelay, profile);
  if (!ingress.ready) profile.outcome = ingress.outcome;
  return {
    ready: ingress.ready,
    frameHeightBeforeTick,
    frameTimestampBeforeTick,
  };
};

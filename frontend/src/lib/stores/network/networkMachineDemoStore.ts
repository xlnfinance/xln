import {
  DEMO_PLAYBACK_INTENT_IDLE,
  clampDemoSpeed,
  createDemoPlaybackIntentStore,
  normalizeDemoPlaybackIntent,
  type DemoPlaybackIntent,
} from '../../../../packages/runtime-client/src/demo-playback-intent';

/**
 * Playback intent for an embedded demo.
 *
 * Thin Svelte facade over the framework-neutral boundary in
 * packages/runtime-client so the React workspace consumes the same policy.
 */
export type NetworkMachineDemo = DemoPlaybackIntent;

export const NETWORK_MACHINE_DEMO_IDLE = DEMO_PLAYBACK_INTENT_IDLE;

export { clampDemoSpeed };

export const normalizeDemo = normalizeDemoPlaybackIntent;

const store = createDemoPlaybackIntentStore();

export const networkMachineDemo = {
  subscribe: store.subscribe,
  set: store.set,
  /** Autoplay is a one-shot intent: consuming it prevents a replay on every recompile. */
  consumeAutoplay: store.consumeAutoplay,
  reset: store.reset,
};

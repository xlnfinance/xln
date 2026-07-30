import { writable } from 'svelte/store';

/**
 * Playback intent for an embedded demo.
 *
 * Set by the route from the URL and consumed once by the timeline. Kept apart from
 * NetworkMachine state because it describes how to present a run, not what the run is.
 */
export type NetworkMachineDemo = {
  autoplay: boolean;
  /** Steps per second multiplier; 1 means one step per second. */
  speed: number;
};

export const NETWORK_MACHINE_DEMO_IDLE: NetworkMachineDemo = { autoplay: false, speed: 1 };

/**
 * A demo that plays too slowly reads as broken and too fast reads as noise, so an
 * unusable URL value falls back to 1× rather than being honoured.
 */
export const clampDemoSpeed = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(10, Math.max(0.25, parsed));
};

export const normalizeDemo = (value: Partial<NetworkMachineDemo>): NetworkMachineDemo => ({
  autoplay: value.autoplay === true,
  speed: clampDemoSpeed(value.speed),
});

const demo = writable<NetworkMachineDemo>(NETWORK_MACHINE_DEMO_IDLE);

export const networkMachineDemo = {
  subscribe: demo.subscribe,
  set: (value: Partial<NetworkMachineDemo>): void => {
    demo.set(normalizeDemo(value));
  },
  /** Autoplay is a one-shot intent: consuming it prevents a replay on every recompile. */
  consumeAutoplay: (): boolean => {
    let requested = false;
    demo.update((current) => {
      requested = current.autoplay;
      return requested ? { ...current, autoplay: false } : current;
    });
    return requested;
  },
  reset: (): void => demo.set(NETWORK_MACHINE_DEMO_IDLE),
};

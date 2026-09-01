// Playback intent for an embedded demo. Set by the route from the URL and
// consumed once by the timeline; kept apart from NetworkMachine state because
// it describes how to present a run, not what the run is. Framework-neutral:
// the Svelte store and the React workspace both create their own instance.

export type DemoPlaybackIntent = Readonly<{
  autoplay: boolean;
  /** Steps per second multiplier; 1 means one step per second. */
  speed: number;
}>;

export const DEMO_PLAYBACK_INTENT_IDLE: DemoPlaybackIntent = { autoplay: false, speed: 1 };

/**
 * A demo that plays too slowly reads as broken and too fast reads as noise, so an
 * unusable URL value falls back to 1× rather than being honoured.
 */
export const clampDemoSpeed = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(10, Math.max(0.25, parsed));
};

export const normalizeDemoPlaybackIntent = (value: Partial<DemoPlaybackIntent>): DemoPlaybackIntent => ({
  autoplay: value.autoplay === true,
  speed: clampDemoSpeed(value.speed),
});

export type DemoPlaybackIntentStore = Readonly<{
  getSnapshot: () => DemoPlaybackIntent;
  subscribe: (run: (value: DemoPlaybackIntent) => void) => () => void;
  set: (value: Partial<DemoPlaybackIntent>) => void;
  consumeAutoplay: () => boolean;
  reset: () => void;
}>;

export const createDemoPlaybackIntentStore = (): DemoPlaybackIntentStore => {
  const listeners = new Set<(value: DemoPlaybackIntent) => void>();
  let snapshot: DemoPlaybackIntent = DEMO_PLAYBACK_INTENT_IDLE;

  const publish = (next: DemoPlaybackIntent): void => {
    // Value equality, not identity: a re-set of the same intent must not
    // re-notify subscribers (or re-render useSyncExternalStore consumers).
    if (next.autoplay === snapshot.autoplay && next.speed === snapshot.speed) return;
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
  };

  return {
    getSnapshot: () => snapshot,
    // Store contract: subscribers receive the current value synchronously.
    subscribe: run => {
      listeners.add(run);
      run(snapshot);
      return () => listeners.delete(run);
    },
    set: value => publish(normalizeDemoPlaybackIntent(value)),
    // Autoplay is a one-shot intent: consuming it prevents a replay on every
    // recompile. A consumer that did not request playback gets false.
    consumeAutoplay: () => {
      if (!snapshot.autoplay) return false;
      publish({ ...snapshot, autoplay: false });
      return true;
    },
    reset: () => publish(DEMO_PLAYBACK_INTENT_IDLE),
  };
};

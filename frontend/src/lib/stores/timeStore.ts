import { writable, derived, get } from 'svelte/store';
import type { TimeState } from '$lib/types/ui';
import type { GossipLayer, Profile as GossipProfile } from '@xln/runtime/xln-api';
import type { Env, EnvSnapshot, EntityReplica } from '@xln/runtime';
import { xlnEnvironment, history } from './xlnStore';

const defaultTimeState: TimeState = {
  currentTimeIndex: 0,
  maxTimeIndex: 0,
  isLive: true,
};

// Session-only developer tool state.
// /app must always boot in LIVE mode instead of restoring an old historical cursor.
export const timeState = writable<TimeState>({ ...defaultTimeState });

// Derived stores
export const currentTimeIndex = derived(timeState, $state => $state.currentTimeIndex);
export const isLive = derived(timeState, $state => $state.isLive);
export const maxTimeIndex = derived(timeState, $state => $state.maxTimeIndex);

function cloneReplicaMap(replicas: Map<string, EntityReplica>): Map<string, EntityReplica> {
  return new Map(replicas);
}

function requireHistoricalFrame(
  frames: EnvSnapshot[],
  currentTimeIndex: number,
): EnvSnapshot {
  const clampedIndex = Math.max(0, Math.min(currentTimeIndex, frames.length - 1));
  const frame = frames[clampedIndex];
  if (!frame) {
    throw new Error(`Time machine selected invalid historical frame ${currentTimeIndex}`);
  }
  return frame;
}

// When not live, expose replicas from the selected snapshot; otherwise use live env replicas
export const visibleReplicas = derived(
  [timeState, history, xlnEnvironment],
  ([$timeState, $history, $env]) => {
    if ($timeState.isLive) {
      return $env ? cloneReplicaMap($env.eReplicas) : new Map();
    }
    if ($history.length === 0) {
      throw new Error('Time machine entered historical mode without any history');
    }
    const frame = requireHistoricalFrame($history, $timeState.currentTimeIndex);
    return cloneReplicaMap(frame.eReplicas);
  }
);

// Derived store for getting current visible gossip (based on time index)
type StoredGossip = {
  profiles: GossipProfile[];
};

const isStoredGossip = (value: unknown): value is StoredGossip =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as { profiles?: unknown }).profiles);

function normalizeGossip(gossip: GossipLayer | StoredGossip | null | undefined): GossipLayer | null {
  if (!gossip) return null;
  if (typeof gossip.getProfiles === 'function') {
    return gossip;
  }

  if (isStoredGossip(gossip)) {
    const cachedProfiles = gossip.profiles.map((profile) => ({ ...profile }));
    return {
      getProfiles: () => cachedProfiles
    } as GossipLayer;
  }

  return null;
}

export const visibleGossip = derived(
  [timeState, history, xlnEnvironment],
  ([$timeState, $history, $env]) => {
    if ($timeState.isLive) {
      return normalizeGossip($env?.gossip);
    }
    const idx = $timeState.currentTimeIndex;
    if (idx >= 0 && idx < $history.length) {
      return normalizeGossip($history[idx]?.gossip);
    }
    return null;
  }
);

// Derived store for getting current visible environment (full snapshot)
export const visibleEnvironment = derived(
  [timeState, history, xlnEnvironment],
  ([$timeState, $history, $env]) => {
    if ($timeState.isLive) {
      return $env;
    }
    if ($history.length === 0) {
      throw new Error('Time machine entered historical mode without any history');
    }
    return requireHistoricalFrame($history, $timeState.currentTimeIndex);
  }
);

// Time operations
const timeOperations = {
  // Update max time index based on history length - ROBUST VERSION
  updateMaxTimeIndex() {
    const $history = get(history);
    const currentState = get(timeState);

    // SAFETY: Ensure history is actually populated before proceeding
    if (!$history || !Array.isArray($history)) {
      console.warn('🕰️ TIME-MACHINE-SAFETY: History not ready, skipping update');
      return;
    }

    const maxIndex = Math.max(0, $history.length - 1);

    // TIME-MACHINE-DEBUG removed

    // Update maxTimeIndex, and auto-advance currentTimeIndex if in live mode
    if (maxIndex !== currentState.maxTimeIndex && maxIndex >= 0) {
      timeState.update(current => ({
        ...current,
        maxTimeIndex: maxIndex,
        // LIVE auto-advance: keep timeIndex at latest frame
        currentTimeIndex: current.isLive ? maxIndex : current.currentTimeIndex,
      }));
    }
  },

  // Go to specific time index (exits live mode)
  goToTimeIndex: (index: number) => {
    const $timeState = get(timeState);
    const clampedIndex = Math.max(0, Math.min(index, $timeState.maxTimeIndex));

    const newState = {
      currentTimeIndex: clampedIndex,
      maxTimeIndex: $timeState.maxTimeIndex,
      isLive: false
    };

    timeState.set(newState);
    timeOperations.triggerEntityPanelUpdates();
  },

  // Go to live (auto-advance to latest frame)
  goToLive: () => {
    const $history = get(history);
    const maxIndex = Math.max(0, $history.length - 1);
    const newState = {
      currentTimeIndex: maxIndex,
      maxTimeIndex: maxIndex,
      isLive: true
    };
    timeState.set(newState);
    timeOperations.triggerEntityPanelUpdates();
  },

  resetToLive() {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem('xln-time-state');
      } catch {
        // Ignore storage failures; live state remains in memory.
      }
    }
    timeState.set({ ...defaultTimeState, isLive: true });
  },

  // Go to history start
  goToHistoryStart: () => {
    timeOperations.goToTimeIndex(0);
  },

  // Go to history end (most recent snapshot)
  goToHistoryEnd: () => {
    const $timeState = get(timeState);
    timeOperations.goToTimeIndex($timeState.maxTimeIndex);
  },

  // Step backward in time (exits live mode)
  stepBackward: () => {
    const $timeState = get(timeState);
    const targetIndex = Math.max(0, $timeState.currentTimeIndex - 1);
    timeOperations.goToTimeIndex(targetIndex);
  },

  // Step forward in time
  stepForward: () => {
    const $timeState = get(timeState);
    const $history = get(history);
    const actualMaxIndex = Math.max(0, $history.length - 1);

    if ($timeState.currentTimeIndex < actualMaxIndex) {
      timeOperations.goToTimeIndex($timeState.currentTimeIndex + 1);
    }
    // At latest frame → go live
    if ($timeState.currentTimeIndex + 1 >= actualMaxIndex) {
      timeOperations.goToLive();
    }
  },

  // Get current snapshot or null if live
  getCurrentSnapshot() {
    const $timeState = get(timeState);
    
    if ($timeState.isLive) {
      return null; // Live data
    }
    
    const $history = get(history);
    if ($timeState.currentTimeIndex >= 0 && $timeState.currentTimeIndex < $history.length) {
      return $history[$timeState.currentTimeIndex];
    }
    
    return null;
  },

  // Get time info for display
  getTimeInfo() {
    const $timeState = get(timeState);
    const $history = get(history);
    
    if ($timeState.isLive) {
      return {
        status: 'LIVE',
        description: 'Current time',
        frameNumber: $history.length,
        totalFrames: $history.length
      };
    } else {
      const snapshot = timeOperations.getCurrentSnapshot();
      return {
        status: 'HISTORICAL',
        description: snapshot?.description || 'Historical snapshot',
        frameNumber: $timeState.currentTimeIndex + 1,
        totalFrames: $history.length
      };
    }
  },

  // Trigger entity panel updates (like old index.html renderEntityInTab calls)
  triggerEntityPanelUpdates() {
    // Dispatch custom event that entity panels can listen to
    window.dispatchEvent(new CustomEvent('timeChanged', {
      detail: { timeIndex: get(timeState).currentTimeIndex }
    }));
  },

  // Initialize time machine - SEQUENTIAL LOADING
  initialize() {
    timeOperations.resetToLive();

    // LOAD-ORDER-DEBUG removed

    // Subscribe to history changes for REACTIVE initialization
    // This ensures we wait for history to be loaded before setting maxTimeIndex
    let hasInitialized = false;

    history.subscribe(($history) => {
      // LOAD-ORDER-DEBUG removed

      // Wait for history to be properly loaded before initializing
      if (!hasInitialized && $history.length > 0) {
        console.log('🕰️ SEQUENTIAL-LOAD: First-time initialization with populated history');
        hasInitialized = true;
        timeOperations.updateMaxTimeIndex();
      } else if (hasInitialized) {
        // Normal operation after initialization
        const currentState = get(timeState);
        if (currentState.isLive) {
          // Only update max index when in live mode to prevent time machine corruption
          timeOperations.updateMaxTimeIndex();
        } else {
          console.log(`🕰️ TIME-MACHINE: Ignoring history update while in historical mode (index: ${currentState.currentTimeIndex})`);
        }
      } else {
        console.log('🕰️ SEQUENTIAL-LOAD: Waiting for history to be populated...');
      }
    });
  }
};

// Export stores and operations
export { timeOperations };

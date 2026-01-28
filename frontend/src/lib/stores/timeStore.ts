import { writable, derived, get } from 'svelte/store';
import type { TimeState } from '$lib/types/ui';
import { xlnEnvironment, history } from './xlnStore';

// Load initial state from localStorage
const loadTimeState = (): TimeState => {
  if (typeof localStorage !== 'undefined') {
    try {
      const saved = localStorage.getItem('xln-time-state');
      if (saved) {
        const parsed = JSON.parse(saved);
        const loadedState = {
          currentTimeIndex: parsed.currentTimeIndex ?? -1,
          maxTimeIndex: parsed.maxTimeIndex ?? 0,
          isLive: parsed.isLive ?? true
        };
        console.log('🕰️ Loaded time state from localStorage:', loadedState);
        return loadedState;
      }
    } catch (err) {
      console.warn('Failed to load time state (clearing corrupted storage):', err);
      localStorage.removeItem('xln-time-state');
    }
  }

  const defaultState = {
    currentTimeIndex: -1, // -1 means current time (live)
    maxTimeIndex: 0,
    isLive: true
  };
  console.log('🕰️ Using default time state:', defaultState);
  return defaultState;
};

// Time machine state with persistence
export const timeState = writable<TimeState>(loadTimeState());

// Derived stores
export const currentTimeIndex = derived(timeState, $state => $state.currentTimeIndex);
export const isLive = derived(timeState, $state => $state.isLive);
export const maxTimeIndex = derived(timeState, $state => $state.maxTimeIndex);

// When not live, expose replicas from the selected snapshot; otherwise use live env replicas
export const visibleReplicas = derived(
  [timeState, history, xlnEnvironment],
  ([$timeState, $history, $env]) => {
    if ($timeState.isLive) {
      // CRITICAL FIX: Return NEW Map reference to trigger Svelte reactivity
      // Derived stores only notify subscribers when return value identity changes
      // Mutating eReplicas.set() doesn't change Map reference, so we clone it
      return $env?.eReplicas ? new Map($env.eReplicas) : new Map();
    }
    const idx = $timeState.currentTimeIndex;
    if (idx >= 0 && idx < $history.length) {
      return $history[idx]?.eReplicas || new Map();
    }
    return new Map();
  }
);

// Derived store for getting current visible gossip (based on time index)
function normalizeGossip(gossip: any) {
  if (!gossip) return null;
  if (typeof gossip.getProfiles === 'function') {
    return gossip;
  }

  if (Array.isArray(gossip.profiles)) {
    const cachedProfiles = gossip.profiles.map((profile: any) => ({ ...profile }));
    return {
      getProfiles: () => cachedProfiles
    };
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
    const idx = $timeState.currentTimeIndex;
    if (idx >= 0 && idx < $history.length) {
      return $history[idx];
    }
    return $env; // Fallback to live if index is invalid
  }
);

// Time operations
const timeOperations = {
  // Save time state to localStorage
  saveTimeState(state: TimeState) {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('xln-time-state', JSON.stringify(state));
      } catch (err) {
        console.warn('Failed to save time state to localStorage:', err);
      }
    }
  },

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

    // SAFETY: Only update if the new maxIndex is different and valid
    if (maxIndex !== currentState.maxTimeIndex && maxIndex >= 0) {
      timeState.update(current => ({
        ...current,
        maxTimeIndex: maxIndex
      }));
    } else {
    }
  },

  // Go to specific time index
  goToTimeIndex: (index: number) => {
    const $timeState = get(timeState);
    const clampedIndex = Math.max(-1, Math.min(index, $timeState.maxTimeIndex));

    const newState = {
      currentTimeIndex: clampedIndex,
      maxTimeIndex: $timeState.maxTimeIndex,
      isLive: clampedIndex === -1
    };

    timeState.set(newState);

    // Persist to localStorage
    timeOperations.saveTimeState(newState);

    console.log('🕰️ Time machine moved to index:', clampedIndex);

    // Trigger entity panel updates like old index.html
    timeOperations.triggerEntityPanelUpdates();
  },

  // Go to live (current time)
  goToLive: () => {
    timeOperations.goToTimeIndex(-1);
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

  // Step backward in time
  stepBackward: () => {
    const $timeState = get(timeState);
    const $history = get(history);

    const actualMaxIndex = Math.max(0, $history.length - 1);

    if ($timeState.isLive) {
      timeOperations.goToTimeIndex(actualMaxIndex);
    } else {
      const targetIndex = Math.max(0, $timeState.currentTimeIndex - 1);
      timeOperations.goToTimeIndex(targetIndex);
    }
  },

  // Step forward in time
  stepForward: () => {
    const $timeState = get(timeState);
    const $history = get(history);

    const actualMaxIndex = Math.max(0, $history.length - 1);

    if ($timeState.isLive) {
      return;
    } else if ($timeState.currentTimeIndex < actualMaxIndex) {
      const targetIndex = $timeState.currentTimeIndex + 1;
      timeOperations.goToTimeIndex(targetIndex);
    } else {
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

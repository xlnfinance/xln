import { writable, derived, get } from 'svelte/store';
import type { TimeState } from '../types';
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
      console.warn('Failed to load time state from localStorage:', err);
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
      return $env?.replicas || new Map();
    }
    const idx = $timeState.currentTimeIndex;
    if (idx >= 0 && idx < $history.length) {
      return $history[idx]?.replicas || new Map();
    }
    return new Map();
  }
);

// Derived store for getting current visible gossip (based on time index)
export const visibleGossip = derived(
  [timeState, history, xlnEnvironment],
  ([$timeState, $history, $env]) => {
    if ($timeState.isLive) {
      return $env?.gossip || null;
    }
    const idx = $timeState.currentTimeIndex;
    if (idx >= 0 && idx < $history.length) {
      return $history[idx]?.gossip || null;
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

  // Update max time index based on history length
  updateMaxTimeIndex() {
    const $history = get(history);
    const maxIndex = Math.max(0, $history.length - 1);

    console.log('🕰️ updateMaxTimeIndex():', {
      historyLength: $history.length,
      calculatedMaxIndex: maxIndex,
      currentMaxIndex: get(timeState).maxTimeIndex
    });

    timeState.update(current => ({
      ...current,
      maxTimeIndex: maxIndex
    }));
  },

  // Go to specific time index
  goToTimeIndex(index: number) {
    const $timeState = get(timeState);
    const clampedIndex = Math.max(-1, Math.min(index, $timeState.maxTimeIndex));
    
    const newState = {
      currentTimeIndex: clampedIndex,
      maxTimeIndex: $timeState.maxTimeIndex,
      isLive: clampedIndex === -1
    };
    
    timeState.set(newState);
    
    // Persist to localStorage
    this.saveTimeState(newState);
    
    console.log('🕰️ Time machine moved to index:', clampedIndex);
    
    // Trigger entity panel updates like old index.html
    this.triggerEntityPanelUpdates();
  },

  // Go to live (current time)
  goToLive() {
    this.goToTimeIndex(-1);
  },

  // Go to history start
  goToHistoryStart() {
    this.goToTimeIndex(0);
  },

  // Go to history end (most recent snapshot)
  goToHistoryEnd() {
    const $timeState = get(timeState);
    this.goToTimeIndex($timeState.maxTimeIndex);
  },

  // Step backward in time
  stepBackward() {
    const $timeState = get(timeState);
    const $history = get(history);

    // Calculate the current actual maxTimeIndex from history length
    const actualMaxIndex = Math.max(0, $history.length - 1);

    console.log('🕰️ stepBackward() called:', {
      isLive: $timeState.isLive,
      currentTimeIndex: $timeState.currentTimeIndex,
      storedMaxTimeIndex: $timeState.maxTimeIndex,
      actualMaxIndex: actualMaxIndex,
      historyLength: $history.length
    });

    if ($timeState.isLive) {
      // Currently at live, go to most recent snapshot using ACTUAL max index
      console.log('🕰️ Going from LIVE to most recent snapshot:', actualMaxIndex);
      this.goToTimeIndex(actualMaxIndex);
    } else {
      // Go one step back, but not below 0
      const targetIndex = Math.max(0, $timeState.currentTimeIndex - 1);
      console.log('🕰️ Going one step back to:', targetIndex);
      this.goToTimeIndex(targetIndex);
    }
  },

  // Step forward in time
  stepForward() {
    const $timeState = get(timeState);
    const $history = get(history);

    // Calculate the current actual maxTimeIndex from history length
    const actualMaxIndex = Math.max(0, $history.length - 1);

    console.log('🕰️ stepForward() called:', {
      isLive: $timeState.isLive,
      currentTimeIndex: $timeState.currentTimeIndex,
      storedMaxTimeIndex: $timeState.maxTimeIndex,
      actualMaxIndex: actualMaxIndex,
      historyLength: $history.length
    });

    if ($timeState.isLive) {
      // Already at live, can't go further
      console.log('🕰️ Already at LIVE, cannot step forward');
      return;
    } else if ($timeState.currentTimeIndex < actualMaxIndex) {
      // Normal forward step using actual max index
      const targetIndex = $timeState.currentTimeIndex + 1;
      console.log('🕰️ Going one step forward to:', targetIndex);
      this.goToTimeIndex(targetIndex);
    } else {
      // At last snapshot, go to live
      console.log('🕰️ At last snapshot, going to LIVE');
      this.goToLive();
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
      const snapshot = this.getCurrentSnapshot();
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

  // Initialize time machine
  initialize() {
    this.updateMaxTimeIndex();

    // Subscribe to history changes to update max index automatically
    // CRITICAL: Only update if we're in live mode to prevent time machine corruption
    history.subscribe((newHistory) => {
      const currentState = get(timeState);
      if (currentState.isLive) {
        // Only update max index when in live mode to prevent time machine corruption
        this.updateMaxTimeIndex();
      } else {
        console.log(`🕰️ TIME-MACHINE: Ignoring history update while in historical mode (index: ${currentState.currentTimeIndex})`);
      }
    });
  }
};

// Export stores and operations
export { timeOperations };

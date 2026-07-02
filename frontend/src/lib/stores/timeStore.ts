import { writable, derived, get } from 'svelte/store';
import type { TimeState } from '$lib/types/ui';
import type { EnvSnapshot } from '@xln/runtime/xln-api';
import { history } from './xlnStore';

const defaultTimeState: TimeState = {
  currentTimeIndex: -1,
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

    // Canonical contract: -1 means LIVE/current env; >=0 means historical frame.
    if (maxIndex !== currentState.maxTimeIndex && maxIndex >= 0) {
      timeState.update(current => ({
        ...current,
        maxTimeIndex: maxIndex,
        currentTimeIndex: current.isLive ? -1 : Math.max(0, Math.min(current.currentTimeIndex, maxIndex)),
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

  // Go to live (show current runtime env, not a historical frame)
  goToLive: () => {
    const $history = get(history);
    const maxIndex = Math.max(0, $history.length - 1);
    const newState = {
      currentTimeIndex: -1,
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
    const $history = get(history);
    const actualMaxIndex = Math.max(0, $history.length - 1);
    const visibleIndex = $timeState.isLive ? actualMaxIndex : $timeState.currentTimeIndex;
    const targetIndex = Math.max(0, visibleIndex - 1);
    timeOperations.goToTimeIndex(targetIndex);
  },

  // Step forward in time
  stepForward: () => {
    const $timeState = get(timeState);
    if ($timeState.isLive) return;
    const $history = get(history);
    const actualMaxIndex = Math.max(0, $history.length - 1);

    if ($timeState.currentTimeIndex < actualMaxIndex) {
      timeOperations.goToTimeIndex($timeState.currentTimeIndex + 1);
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
    timeOperations.resetToLive();

    // LOAD-ORDER-DEBUG removed

    // Subscribe to history changes for REACTIVE initialization
    // This ensures we wait for history to be loaded before setting maxTimeIndex
    let hasInitialized = false;

    history.subscribe(($history) => {
      // LOAD-ORDER-DEBUG removed

      // Wait for history to be properly loaded before initializing
      if (!hasInitialized && $history.length > 0) {
        hasInitialized = true;
        timeOperations.updateMaxTimeIndex();
      } else if (hasInitialized) {
        // Normal operation after initialization
        const currentState = get(timeState);
        if (currentState.isLive) {
          // Only update max index when in live mode to prevent time machine corruption
          timeOperations.updateMaxTimeIndex();
        } else {
        }
      } else {
      }
    });
  }
};

// Export stores and operations
export { timeOperations };

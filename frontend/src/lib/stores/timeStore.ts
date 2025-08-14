import { writable, derived, get } from 'svelte/store';
import type { TimeState } from '../types';
import { xlnEnvironment, history } from './xlnStore';

// Time machine state
export const timeState = writable<TimeState>({
  currentTimeIndex: -1, // -1 means current time (live)
  maxTimeIndex: 0,
  isLive: true
});

// Derived stores
export const currentTimeIndex = derived(timeState, $state => $state.currentTimeIndex);
export const isLive = derived(timeState, $state => $state.isLive);
export const maxTimeIndex = derived(timeState, $state => $state.maxTimeIndex);

// Time operations
const timeOperations = {
  // Update max time index based on history length
  updateMaxTimeIndex() {
    const $history = get(history);
    const maxIndex = Math.max(0, $history.length - 1);
    
    timeState.update(current => ({
      ...current,
      maxTimeIndex: maxIndex
    }));
  },

  // Go to specific time index
  goToTimeIndex(index: number) {
    const $timeState = get(timeState);
    const $history = get(history);
    const clampedIndex = Math.max(0, Math.min(index, $timeState.maxTimeIndex));
    
    timeState.set({
      currentTimeIndex: clampedIndex,
      maxTimeIndex: $timeState.maxTimeIndex,
      isLive: false
    });
    
    console.log('🕰️ Time machine moved to index:', clampedIndex, 'of', $history.length, 'snapshots');
  },

  // Go to live (current time)
  goToLive() {
    const $timeState = get(timeState);
    
    timeState.set({
      currentTimeIndex: -1,
      maxTimeIndex: $timeState.maxTimeIndex,
      isLive: true
    });
    
    console.log('🕰️ Time machine moved to LIVE mode');
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
    
    if ($timeState.isLive) {
      // Currently at live, go to most recent snapshot
      this.goToTimeIndex($timeState.maxTimeIndex);
    } else {
      // Go one step back, but not below 0
      this.goToTimeIndex(Math.max(0, $timeState.currentTimeIndex - 1));
    }
  },

  // Step forward in time
  stepForward() {
    const $timeState = get(timeState);
    
    if ($timeState.isLive) {
      // Already at live, can't go further
      return;
    } else if ($timeState.currentTimeIndex < $timeState.maxTimeIndex) {
      // Normal forward step
      this.goToTimeIndex($timeState.currentTimeIndex + 1);
    } else {
      // At last snapshot, go to live
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

  // Initialize time machine
  initialize() {
    this.updateMaxTimeIndex();
    
    // Subscribe to history changes to update max index
    history.subscribe(() => {
      this.updateMaxTimeIndex();
    });
  }
};

// Export stores and operations
export { timeOperations };

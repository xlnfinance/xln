import { writable } from 'svelte/store';
import {
  createActiveTabLockController,
  type ActiveTabLockState,
} from '../../../../packages/browser/src/active-tab-lock';

export type { ActiveTabLockState };

export const activeTabLock = writable<ActiveTabLockState>({
  tabId: '',
  ownerTabId: null,
  isOwner: false,
});

const controller = createActiveTabLockController({
  publishState: (state) => activeTabLock.set(state),
});

export const isInactiveTabStandby = controller.isInactiveTabStandby;
export const ownsActiveTabLock = controller.ownsActiveTabLock;
export const waitForActiveTabLockLoss = controller.waitForActiveTabLockLoss;
export const enterInactiveTabStandby = controller.enterInactiveTabStandby;
export const clearInactiveTabStandby = controller.clearInactiveTabStandby;
export const broadcastHardResetRequest = controller.broadcastHardResetRequest;
export const initializeActiveTabLock = controller.initializeActiveTabLock;
export const tryInitializeActiveTabLock = controller.tryInitializeActiveTabLock;
export const adoptActiveTabLock = controller.adoptActiveTabLock;

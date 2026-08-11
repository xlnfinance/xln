import type { BrowserVMState } from '../../../runtime/types';
import type { BrowserVmChainCheckpoint, BrowserVMProvider } from './browservm-provider';
import type { JAdapter, SnapshotId } from '../types';

type BrowserVmStateMethods = Pick<
  JAdapter,
  'deployStack' | 'snapshot' | 'revert' | 'dumpState' | 'loadState' | 'processBlock'
>;

const requireBrowserVmState = (state: BrowserVMState | string): BrowserVMState => {
  if (typeof state !== 'string') return state;
  try {
    return JSON.parse(state) as BrowserVMState;
  } catch {
    throw new Error('BrowserVM loadState requires serialized BrowserVMState JSON or object');
  }
};

export const createBrowserVmStateMethods = (
  browserVM: BrowserVMProvider,
  invalidateStackBinding: () => void,
  verifyStackBinding: (context: string) => Promise<void>,
): BrowserVmStateMethods => {
  let snapshotCounter = 0;
  const snapshots = new Map<SnapshotId, { root: Uint8Array; chain: BrowserVmChainCheckpoint }>();
  return {
    async deployStack(): Promise<void> {
      await verifyStackBinding('browservm_deploy');
    },
    async snapshot(): Promise<SnapshotId> {
      const root = await browserVM.captureStateRoot();
      const id = `browservm:${++snapshotCounter}:${Buffer.from(root).toString('hex')}`;
      snapshots.set(id, {
        root: new Uint8Array(root),
        chain: browserVM.captureChainCheckpoint(),
      });
      return id;
    },
    async revert(snapshotId: SnapshotId): Promise<void> {
      const snapshot = snapshots.get(snapshotId);
      if (!snapshot) throw new Error(`BrowserVM snapshot not found: ${snapshotId}`);
      invalidateStackBinding();
      await browserVM.timeTravel(snapshot.root);
      await browserVM.restoreChainCheckpoint(snapshot.chain);
      await verifyStackBinding('browservm_revert');
    },
    async dumpState(): Promise<BrowserVMState> {
      return await browserVM.serializeState();
    },
    async loadState(state: BrowserVMState | string): Promise<void> {
      invalidateStackBinding();
      await browserVM.restoreState(requireBrowserVmState(state));
      await verifyStackBinding('browservm_restore');
    },
    async processBlock() {
      return [];
    },
  };
};

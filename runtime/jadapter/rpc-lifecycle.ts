import { ethers } from 'ethers';

import type { BrowserVMState } from '../types';
import { rpcLog } from './rpc-public';
import type { JAdapter, JEvent, SnapshotId } from './types';

type LifecycleMethods = Pick<JAdapter, 'snapshot' | 'revert' | 'dumpState' | 'loadState' | 'processBlock'>;

type RpcLifecycleDeps = {
  provider: ethers.JsonRpcProvider;
  chainId: number;
  stateFile?: string;
  markStackBindingUnverified(): void;
  verifyStackBinding(context: string): Promise<void>;
};

/** Dev-chain lifecycle operations stay separate from financial reads and writes. */
export const createRpcLifecycleMethods = (deps: RpcLifecycleDeps): LifecycleMethods => {
  const { provider, chainId, stateFile, markStackBindingUnverified, verifyStackBinding } = deps;
  return {
    async snapshot(): Promise<SnapshotId> {
      try {
        const rpc = provider as ethers.JsonRpcProvider;
        return await rpc.send('evm_snapshot', []);
      } catch {
        throw new Error('Snapshot not supported by this RPC');
      }
    },

    async revert(snapshotId: SnapshotId): Promise<void> {
      markStackBindingUnverified();
      let reverted: unknown;
      try {
        const rpc = provider as ethers.JsonRpcProvider;
        reverted = await rpc.send('evm_revert', [snapshotId]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`RPC_REVERT_FAILED:${message}`);
      }
      if (reverted !== true) throw new Error(`RPC_REVERT_REJECTED:${snapshotId}`);
      await verifyStackBinding('rpc_revert');
    },

    async dumpState(): Promise<string> {
      try {
        const rpc = provider as ethers.JsonRpcProvider;
        const path = stateFile ?? './data/anvil-state.json';
        await rpc.send('anvil_dumpState', []);
        return path;
      } catch {
        throw new Error('dumpState not supported by this RPC');
      }
    },

    async loadState(state: BrowserVMState | string): Promise<void> {
      if (typeof state !== 'string') {
        throw new Error('RPC requires file path string');
      }
      markStackBindingUnverified();
      try {
        const rpc = provider as ethers.JsonRpcProvider;
        await rpc.send('anvil_loadState', [state]);
      } catch {
        throw new Error('loadState not supported by this RPC');
      }
      await verifyStackBinding('rpc_restore');
    },

    async processBlock(): Promise<JEvent[]> {
      // Try to mine a block (anvil)
      try {
        const rpc = provider as ethers.JsonRpcProvider;
        await rpc.send('evm_mine', []);
      } catch (error) {
        rpcLog.debug('block.manual_mine_unavailable', {
          chainId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return [];
    },
  };
};

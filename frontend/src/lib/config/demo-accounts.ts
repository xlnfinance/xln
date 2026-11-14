import { VALUELESS_CHAIN_IDS } from '@xln/core/jurisdiction/adapter/chain-ids';

/** Labels only: every test wallet gets fresh cryptographic entropy at creation. */
export const DEMO_ACCOUNTS = ['A', 'B', 'C', 'D', 'E'].map(label => ({ label }));

/** Device-unlocked test identities must never bootstrap a real-money jurisdiction. */
export function assertDemoNetwork(chainIds: readonly unknown[]): void {
  if (chainIds.length === 0 || chainIds.some(id => typeof id !== 'number' || !VALUELESS_CHAIN_IDS.has(id))) {
    throw new Error('Test wallets require the local sandbox or a public testnet.');
  }
}

/** Labels only: every test wallet gets fresh cryptographic entropy at creation. */
export const DEMO_ACCOUNTS = ['A', 'B', 'C', 'D', 'E'].map(label => ({ label }));

/** Device-unlocked test identities must never bootstrap a real-money jurisdiction. */
export function assertDemoNetwork(chainIds: readonly unknown[]): void {
  if (chainIds.length === 0 || chainIds.some(id => id !== 31337 && id !== 31338 && id !== 11155111)) {
    throw new Error('Test wallets require the local sandbox or Ethereum Sepolia.');
  }
}

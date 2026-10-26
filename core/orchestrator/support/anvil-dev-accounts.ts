import { getIndexedAccountPath, HDNodeWallet, Mnemonic } from 'ethers';

const DEFAULT_ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';

/**
 * Anvil funds dev accounts 0..9 at genesis. Each one has exactly one signer:
 * - operators from the bottom: `H<n>` -> n - 1 (MM/custody sign as 0);
 * - each Hub's faucet gas from the top: `H<n>` -> 10 - n;
 * - account 5: the Stack Manager browser E2E deployer's gas;
 * - the orchestrator's bootstrap gas directly below the faucets: 9 - hubCount,
 *   skipping account 5.
 * A shared EOA would let one process take a nonce another process already
 * reserved for a durably accepted J transaction.
 */
const ANVIL_FUNDED_DEV_ACCOUNTS = 10;
export const STACK_MANAGER_E2E_FUNDER_INDEX = 5;

const assertUnreserved = (index: number, code: string): number => {
  if (index === STACK_MANAGER_E2E_FUNDER_INDEX) throw new Error(`${code}:reserved=${index}`);
  return index;
};

export const resolveFaucetFunderIndex = (hubSignerIndex: number, hubCount: number): number => {
  const index = ANVIL_FUNDED_DEV_ACCOUNTS - 1 - hubSignerIndex;
  if (index < Math.max(hubCount, hubSignerIndex + 1)) {
    throw new Error(`FAUCET_FUNDER_INDEX_COLLIDES_WITH_OPERATOR:signerIndex=${hubSignerIndex}:hubs=${hubCount}`);
  }
  return assertUnreserved(index, `FAUCET_FUNDER_INDEX_COLLIDES:hubs=${hubCount}`);
};

export const resolveBootstrapFunderIndex = (hubCount: number): number => {
  const candidate = ANVIL_FUNDED_DEV_ACCOUNTS - 1 - hubCount;
  // Skip the account reserved for the Stack Manager spec rather than refuse
  // a topology that still has a free genesis account below it.
  const index = candidate === STACK_MANAGER_E2E_FUNDER_INDEX ? candidate - 1 : candidate;
  if (!Number.isSafeInteger(hubCount) || hubCount < 1 || index < hubCount) {
    throw new Error(`BOOTSTRAP_FUNDER_INDEX_COLLIDES:hubs=${hubCount}`);
  }
  return index;
};

export const deriveAnvilDevPrivateKey = (index: number): string => {
  const mnemonic = Mnemonic.fromPhrase(process.env['ANVIL_MNEMONIC'] || DEFAULT_ANVIL_MNEMONIC);
  return HDNodeWallet.fromMnemonic(mnemonic, getIndexedAccountPath(index)).privateKey;
};

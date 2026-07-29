/** Local EVM chains where development-only contract methods are allowed. */
export const DEV_CHAIN_IDS = new Set<number>([31337, 31338]);

/** TRON networks exposed through the shared JAdapter interface. */
export const TRON_CHAIN_IDS = new Set<number>([728126428, 3448148188]);

export const isTronChainId = (chainId: number): boolean => TRON_CHAIN_IDS.has(chainId);

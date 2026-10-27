import { DEV_CHAIN_IDS } from '../chain-ids';
import type { JAdapterConfig } from '../types';

export const resolveRpcFinalityDepth = (
  config: JAdapterConfig,
  scenarioMode: boolean,
): number => {
  if (config.confirmationDepth !== undefined &&
      (!Number.isSafeInteger(config.confirmationDepth) || config.confirmationDepth < 0)) {
    throw new RangeError(`RPC_CONFIRMATION_DEPTH_INVALID:${config.confirmationDepth}`);
  }
  if (scenarioMode || DEV_CHAIN_IDS.has(config.chainId)) return 0;
  if (config.confirmationDepth !== undefined) {
    const depth = config.confirmationDepth;
    if (config.mode === 'tron' && depth !== 0) {
      throw new Error('TRON_CONFIRMATION_DEPTH_FORBIDDEN: use the SolidityNode solidified head');
    }
    return depth;
  }
  if (config.mode === 'tron') return 0;
  return config.chainId === 1 ? 12 : 2;
};

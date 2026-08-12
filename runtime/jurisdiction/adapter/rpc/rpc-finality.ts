import { DEV_CHAIN_IDS } from '../chain-ids';
import { isTronChainId } from '../rpc-public';
import type { JAdapterConfig } from '../types';

export const resolveRpcFinalityDepth = (
  config: JAdapterConfig,
  scenarioMode: boolean,
): number => {
  if (scenarioMode || DEV_CHAIN_IDS.has(config.chainId)) return 0;
  if (config.confirmationDepth !== undefined && Number.isFinite(config.confirmationDepth)) {
    const depth = Math.max(0, Math.floor(config.confirmationDepth));
    if (isTronChainId(config.chainId) && depth !== 0) {
      throw new Error('TRON_CONFIRMATION_DEPTH_FORBIDDEN: use the SolidityNode solidified head');
    }
    return depth;
  }
  if (config.chainId === 1) return 12;
  return isTronChainId(config.chainId) ? 0 : 2;
};

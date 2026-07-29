import { toJId, type JId } from './identity';

export interface JurisdictionInfo {
  jId: JId;
  name: string;
  chainId?: number;
  rpcUrl?: string;
}

export const jIdFromChainId = (chainId: number): JId =>
  toJId(chainId.toString());

/** Deterministic local label; deliberately not a cryptographic identifier. */
export const createLazyJId = (name: string): JId => {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = ((hash << 5) - hash + name.charCodeAt(index)) | 0;
  }
  return toJId(`lazy_${Math.abs(hash).toString(16)}`);
};

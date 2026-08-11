import type { JId } from './identity';

export interface JurisdictionInfo {
  jId: JId;
  name: string;
  chainId?: number;
  rpcUrl?: string;
}

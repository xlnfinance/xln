import type { JId } from './';

export interface JurisdictionInfo {
  jId: JId;
  name: string;
  chainId?: number;
  rpcUrl?: string;
}

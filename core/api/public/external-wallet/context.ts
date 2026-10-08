import type { JAdapter, JTokenInfo } from '../../../jurisdiction/adapter/types';

export interface ExternalWalletApiContext {
  getJAdapter(entityId?: string): JAdapter | null;
  getRuntimeId(): string;
  getTokenCatalog(entityId?: string): Promise<JTokenInfo[]>;
  jsonHeaders: Record<string, string>;
  faucetSeed: string;
  faucetSignerLabel: string;
  faucetWalletEthTarget: bigint;
  faucetTokenTargetUnits: bigint;
  emitDebugEvent(entry: {
    event: string;
    runtimeId: string;
    status: string;
    reason: string;
    details: Record<string, unknown>;
  }): void;
  fundBrowserVmWallet(address: string, amount: bigint, tokenSymbol?: string): Promise<boolean>;
}

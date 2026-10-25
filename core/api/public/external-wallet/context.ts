import type { JAdapter, JTokenInfo } from '../../../jurisdiction/adapter/types';

export interface ExternalWalletApiContext {
  getJAdapter(entityId?: string, jurisdiction?: string): JAdapter | null;
  getRuntimeId(): string;
  getTokenCatalog(entityId?: string, jurisdiction?: string): Promise<JTokenInfo[]>;
  jsonHeaders: Record<string, string>;
  faucetSeed: string;
  faucetSignerLabel: string;
  /**
   * Dev-chain faucet gas comes from a genesis account that no Runtime signs
   * with, so its nonce has exactly one owner. Null where none is reserved.
   */
  devChainFaucetFunderKey: string | null;
  faucetWalletEthTarget: bigint;
  faucetTokenTargetUnits: bigint;
  emitDebugEvent(entry: {
    event: string;
    runtimeId: string;
    status: string;
    reason: string;
    details: Record<string, unknown>;
  }): void;
  fundBrowserVmWallet(address: string, amount: bigint, tokenSymbol: string | undefined, adapter: JAdapter): Promise<boolean>;
}

/**
 * BrowserJurisdiction - In-memory EVM jurisdiction for simnet
 *
 * Wraps BrowserEVM to implement IJurisdiction interface.
 * Used for local development and demos - instant, free, no gas.
 */

import type {
  IJurisdiction,
  JurisdictionConfig,
  Token,
  EntityInfo,
  TxReceipt,
} from './interface.js';
import { BrowserEVM } from '../evms/browser-evm.js';

export class BrowserJurisdiction implements IJurisdiction {
  readonly type = 'browser' as const;
  readonly chainId: number;

  private evm: BrowserEVM;
  private _ready = false;
  private _depositoryAddress = '';
  private _entityProviderAddress = '';

  constructor(config: JurisdictionConfig) {
    this.chainId = config.chainId;
    this.evm = new BrowserEVM();
  }

  get depositoryAddress(): string {
    if (!this._ready) throw new Error('Jurisdiction not initialized');
    return this._depositoryAddress;
  }

  get entityProviderAddress(): string {
    if (!this._ready) throw new Error('Jurisdiction not initialized');
    return this._entityProviderAddress;
  }

  async init(): Promise<void> {
    if (this._ready) return;

    await this.evm.init();
    this._depositoryAddress = this.evm.getDepositoryAddress();
    this._entityProviderAddress = this.evm.getEntityProviderAddress();
    this._ready = true;

    console.log(`[BrowserJurisdiction] Initialized: chainId=${this.chainId}, depository=${this._depositoryAddress.slice(0, 10)}...`);
  }

  isReady(): boolean {
    return this._ready;
  }

  // === READ OPERATIONS ===

  async getReserves(entityId: string, tokenId: number): Promise<bigint> {
    return this.evm.getReserves(entityId, tokenId);
  }

  async getTokens(): Promise<Token[]> {
    const registry = this.evm.getTokenRegistry();
    return Object.entries(registry).map(([symbol, info]) => ({
      id: (info as any).id,
      address: (info as any).address,
      symbol,
      decimals: 18,
    }));
  }

  async getEntityInfo(entityId: string): Promise<EntityInfo | null> {
    try {
      const info = await this.evm.getEntityInfo(entityId);
      if (!info?.exists) return null;

      // BrowserVM returns { exists, name, currentBoardHash, registrationBlock }
      // To get validators/threshold we'd need to decode the board, which is not implemented yet
      // For now, return null - this is mainly used for verification, not critical
      return null;
    } catch {
      return null;
    }
  }

  async getCollateral(entityId: string, counterpartyId: string, tokenId: number): Promise<bigint> {
    const result = await this.evm.getCollateral(entityId, counterpartyId, tokenId);
    // BrowserVM returns { collateral, ondelta } but interface expects just collateral
    return result.collateral;
  }

  // === WRITE OPERATIONS ===

  async deposit(
    signerPrivateKey: string,
    entityId: string,
    tokenId: number,
    amount: bigint
  ): Promise<TxReceipt> {
    const tokenRegistry = this.evm.getTokenRegistry();
    const tokenInfo = Object.values(tokenRegistry).find((t: any) => t.id === tokenId) as any;
    if (!tokenInfo) throw new Error(`Token ${tokenId} not found`);

    // Convert private key to Uint8Array
    const privKey = hexToBytes(signerPrivateKey);

    // Approve + deposit
    await this.evm.approveErc20(privKey, tokenInfo.address, this._depositoryAddress, amount);
    await this.evm.externalTokenToReserve(privKey, entityId, tokenInfo.address, amount);

    return {
      hash: '0x' + Math.random().toString(16).slice(2),
      blockNumber: 0,
      gasUsed: 0n,
      success: true,
    };
  }

  async withdraw(
    _signerPrivateKey: string,
    _entityId: string,
    _tokenId: number,
    _amount: bigint
  ): Promise<TxReceipt> {
    // TODO: Implement withdrawal via Depository
    throw new Error('Withdraw not yet implemented for BrowserJurisdiction');
  }

  async registerEntity(
    _signerPrivateKey: string,
    entityId: string,
    validators: string[],
    _threshold: bigint
  ): Promise<TxReceipt> {
    // Browser VM uses batch registration
    await this.evm.registerEntitiesWithSigners(validators);

    return {
      hash: '0x' + Math.random().toString(16).slice(2),
      blockNumber: 0,
      gasUsed: 0n,
      success: true,
    };
  }

  // === DEBUG OPERATIONS (simnet only) ===

  async debugFundReserves(entityId: string, tokenId: number, amount: bigint): Promise<void> {
    await this.evm.debugFundReserves(entityId, tokenId, amount);
  }

  async debugFundWallet(address: string, amount: bigint): Promise<void> {
    await this.evm.fundSignerWallet(address, amount);
  }

  // === INTERNAL ACCESS (for legacy code migration) ===

  /** @deprecated Use IJurisdiction methods instead */
  getEVM(): BrowserEVM {
    return this.evm;
  }
}

// Helper
function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

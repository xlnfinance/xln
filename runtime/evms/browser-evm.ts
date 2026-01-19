/**
 * BrowserEVM - In-browser EVM using @ethereumjs/vm
 * Proxies all BrowserVMProvider methods automatically
 */

import type { JurisdictionEVM, XlnomySnapshot, BrowserVMState } from '../types.js';
import { getWallClockMs } from '../time.js';
import { BrowserVMProvider } from '../browservm.js';

// REMOVED: window.__xlnBrowserVM singleton (replaced with env.browserVM per-runtime isolation)
// Each BrowserEVM instance now creates its own isolated BrowserVMProvider

export class BrowserEVM implements JurisdictionEVM {
  type: 'browservm' = 'browservm';
  // Create NEW isolated provider instance per BrowserEVM (no shared state)
  private provider = new BrowserVMProvider();

  // Proxy all provider methods
  async init() { return this.provider.init(); }
  async reset() { return this.provider.reset(); }
  getDepositoryAddress() { return this.provider.getDepositoryAddress(); }
  getDeltaTransformerAddress() { return this.provider.getDeltaTransformerAddress(); }
  getBlockNumber() { return this.provider.getBlockNumber(); }
  async captureStateRoot() { return this.provider.captureStateRoot(); }
  async timeTravel(stateRoot: Uint8Array) { return this.provider.timeTravel(stateRoot); }
  async serializeState(): Promise<BrowserVMState> { return this.provider.serializeState(); }
  async restoreState(data: BrowserVMState): Promise<void> { return this.provider.restoreState(data); }
  setQuietLogs(quiet: boolean): void { this.provider.setQuietLogs(quiet); }
  async debugFundReserves(entityId: string, tokenId: number, amount: bigint) { return this.provider.debugFundReserves(entityId, tokenId, amount); }
  async setDefaultDisputeDelay(delayBlocks: number) { return this.provider.setDefaultDisputeDelay(delayBlocks); }
  async getReserves(entityId: string, tokenId: number) { return this.provider.getReserves(entityId, tokenId); }
  async getCollateral(entity1: string, entity2: string, tokenId: number) { return this.provider.getCollateral(entity1, entity2, tokenId); }
  async getAccountInfo(entityId: string, counterpartyId: string) { return this.provider.getAccountInfo(entityId, counterpartyId); }
  async reserveToReserve(from: string, to: string, tokenId: number, amount: bigint) { return this.provider.reserveToReserve(from, to, tokenId, amount); }
  async settleWithInsurance(
    leftEntity: string,
    rightEntity: string,
    diffs: Array<{ tokenId: number; leftDiff: bigint; rightDiff: bigint; collateralDiff: bigint; ondeltaDiff: bigint; }>,
    forgiveDebtsInTokenIds: number[] = [],
    insuranceRegs: Array<{ insured: string; insurer: string; tokenId: number; limit: bigint; expiresAt: bigint; }> = [],
    sig?: string
  ) {
    return this.provider.settleWithInsurance(leftEntity, rightEntity, diffs, forgiveDebtsInTokenIds, insuranceRegs, sig);
  }
  async processBatch(encodedBatch: string, entityProvider: string, hankoData: string, nonce: bigint) {
    return this.provider.processBatch(encodedBatch, entityProvider, hankoData, nonce);
  }
  getProvider() { return this.provider; }
  getChainId() { return this.provider.getChainId(); }
  async getEntityNonce(entityId: string) { return this.provider.getEntityNonce(entityId); }
  getTokenRegistry() { return this.provider.getTokenRegistry(); }
  getTokenAddress(symbol: string) { return this.provider.getTokenAddress(symbol); }
  getTokenId(symbol: string) { return this.provider.getTokenId(symbol); }
  async getErc20Balance(tokenAddress: string, owner: string) { return this.provider.getErc20Balance(tokenAddress, owner); }
  async getEthBalance(owner: string) { return this.provider.getEthBalance(owner); }
  async getErc20Allowance(tokenAddress: string, owner: string, spender: string) {
    return this.provider.getErc20Allowance(tokenAddress, owner, spender);
  }
  async fundSignerWallet(address: string, amount?: bigint) { return this.provider.fundSignerWallet(address, amount); }
  async approveErc20(privKey: Uint8Array, tokenAddress: string, spender: string, amount: bigint) {
    return this.provider.approveErc20(privKey, tokenAddress, spender, amount);
  }
  async transferErc20(privKey: Uint8Array, tokenAddress: string, to: string, amount: bigint) {
    return this.provider.transferErc20(privKey, tokenAddress, to, amount);
  }
  async externalTokenToReserve(privKey: Uint8Array, entityId: string, tokenAddress: string, amount: bigint) {
    return this.provider.externalTokenToReserve(privKey, entityId, tokenAddress, amount);
  }

  // Event subscription for j-watcher (proxied from BrowserVMProvider)
  onAny(callback: (event: any) => void): () => void { return this.provider.onAny(callback); }
  getBlockHash(): string { return this.provider.getBlockHash(); }
  async registerNumberedEntitiesBatch(boardHashes: string[]): Promise<number[]> { return this.provider.registerNumberedEntitiesBatch(boardHashes); }
  async registerEntitiesWithSigners(signerIds: string[]): Promise<number[]> { return this.provider.registerEntitiesWithSigners(signerIds); }
  async getEntityInfo(entityId: string) { return this.provider.getEntityInfo(entityId); }
  async signSettlement(
    initiatorEntityId: string,
    counterpartyEntityId: string,
    diffs: Array<{ tokenId: number; leftDiff: bigint; rightDiff: bigint; collateralDiff: bigint; ondeltaDiff: bigint; }>,
    forgiveDebtsInTokenIds: number[] = [],
    insuranceRegs: Array<{ insured: string; insurer: string; tokenId: number; limit: bigint; expiresAt: bigint; }> = []
  ): Promise<string> {
    return this.provider.signSettlement(initiatorEntityId, counterpartyEntityId, diffs, forgiveDebtsInTokenIds, insuranceRegs);
  }
  registerEntityWallet(entityId: string, privateKey: string): void {
    this.provider.registerEntityWallet(entityId, privateKey);
  }

  // JurisdictionEVM interface
  async deployContract(bytecode: string, args?: any[]): Promise<string> { throw new Error('Not implemented'); }
  async call(to: string, data: string, from?: string): Promise<string> { throw new Error('Not implemented'); }
  async send(to: string, data: string, value?: bigint): Promise<string> {
    const result = await this.provider.executeTx({ to, data, gasLimit: 1000000n, value: value ?? 0n });
    return result.txHash;
  }
  async getBlock(): Promise<number> { return 0; }
  async getBalance(address: string): Promise<bigint> { throw new Error('Not implemented'); }
  getEntityProviderAddress(): string { return this.provider.getEntityProviderAddress(); }

  async serialize(): Promise<XlnomySnapshot> {
    return {
      name: 'unknown',
      version: '1.0.0',
      created: getWallClockMs(),
      evmType: 'browservm',
      blockTimeMs: 1000,
      jMachine: { position: { x: 0, y: 600, z: 0 }, capacity: 3, jHeight: 0 },
      contracts: {
        entityProviderAddress: this.provider.getEntityProviderAddress(),
        depositoryAddress: this.provider.getDepositoryAddress(),
        deltaTransformerAddress: this.provider.getDeltaTransformerAddress(),
      },
      evmState: { vmState: null },
      entities: [],
    };
  }
}

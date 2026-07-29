import { normalizeEntityId } from '../entity/id';
import type { BrowserVMProvider } from './browservm-provider';
import type { JAdapter, JEvent } from './types';
import { receiptFromEvents } from './browservm-submit';

type BrowserVmIoMethod =
  | 'getReserves'
  | 'getCollateral'
  | 'getAccountInfo'
  | 'getEntityNonce'
  | 'hasProcessedBatch'
  | 'getEntityProviderActionNonce'
  | 'getEntityProviderActionReceipt'
  | 'isEntityRegistered'
  | 'getTokenRegistry'
  | 'readWalletSnapshot'
  | 'getErc20Balance'
  | 'getErc20Balances'
  | 'getErc20Allowance'
  | 'getEthBalance'
  | 'getDebts'
  | 'processBatch'
  | 'enforceDebts'
  | 'debugFundReserves'
  | 'debugFundReservesBatch'
  | 'externalTokenToReserve'
  | 'approveErc20'
  | 'transferErc20'
  | 'transferNative'
  | 'fundSignerWallet'
  | 'getBrowserVM'
  | 'setBlockTimestamp'
  | 'setQuietLogs'
  | 'registerEntityWallet'
  | 'captureStateRoot'
  | 'getCurrentBlockNumber'
  | 'getFinalityDepth'
  | 'syncRuntimeState';

export const createBrowserVmIoMethods = (
  browserVM: BrowserVMProvider,
): Pick<JAdapter, BrowserVmIoMethod> => ({
  async getReserves(entityId, tokenId) {
    return await browserVM.getReserves(entityId, tokenId);
  },
  async getCollateral(entityId, counterpartyId, tokenId) {
    return (await browserVM.getCollateral(entityId, counterpartyId, tokenId)).collateral;
  },
  async getAccountInfo(entityId, counterpartyId) {
    return await browserVM.getAccountInfo(entityId, counterpartyId);
  },
  async getEntityNonce(entityId) {
    return await browserVM.getEntityNonce(normalizeEntityId(entityId));
  },
  async hasProcessedBatch(entityId, batchHash, entityNonce) {
    return browserVM.hasProcessedBatch(normalizeEntityId(entityId), batchHash, entityNonce);
  },
  async getEntityProviderActionNonce(entityId) {
    return await browserVM.getEntityProviderActionNonce(normalizeEntityId(entityId));
  },
  async getEntityProviderActionReceipt(entityId, actionNonce) {
    return browserVM.getEntityProviderActionReceipt(
      normalizeEntityId(entityId),
      actionNonce,
    );
  },
  async isEntityRegistered(entityId) {
    return (await browserVM.getEntityInfo(normalizeEntityId(entityId))).exists;
  },
  async getTokenRegistry() {
    return browserVM.getTokenRegistry();
  },
  async readWalletSnapshot(request) {
    return {
      nativeBalance: request.includeNativeBalance === false ? null : await browserVM.getEthBalance(request.owner),
      tokenBalances: await Promise.all(
        request.tokenAddresses.map(tokenAddress => browserVM.getErc20Balance(tokenAddress, request.owner)),
      ),
      allowances: await Promise.all(
        (request.allowances ?? []).map(allowance =>
          browserVM.getErc20Allowance(allowance.tokenAddress, request.owner, allowance.spender),
        ),
      ),
    };
  },
  async getErc20Balance(tokenAddress, owner) {
    return await browserVM.getErc20Balance(tokenAddress, owner);
  },
  async getErc20Balances(tokenAddresses, owner) {
    return await Promise.all(tokenAddresses.map(tokenAddress => browserVM.getErc20Balance(tokenAddress, owner)));
  },
  async getErc20Allowance(tokenAddress, owner, spender) {
    return await browserVM.getErc20Allowance(tokenAddress, owner, spender);
  },
  async getEthBalance(owner) {
    return await browserVM.getEthBalance(owner);
  },
  async getDebts(entityId, tokenId) {
    return await browserVM.getDebts(entityId, tokenId);
  },
  async processBatch(encodedBatch, hankoData, nonce) {
    return receiptFromEvents(
      await browserVM.processBatch(encodedBatch, hankoData, nonce),
    );
  },
  async enforceDebts(entityId, tokenId, maxIterations) {
    await browserVM.enforceDebts(entityId, tokenId, maxIterations);
  },
  async debugFundReserves(entityId, tokenId, amount) {
    return browserVM.debugFundReserves(entityId, tokenId, amount);
  },
  async debugFundReservesBatch(mints) {
    const events: JEvent[] = [];
    for (const mint of mints) {
      events.push(
        ...await browserVM.debugFundReserves(
          mint.entityId,
          mint.tokenId,
          mint.amount,
        ),
      );
    }
    return events;
  },
  async externalTokenToReserve(signerPrivateKey, entityId, tokenAddress, amount, options) {
    return browserVM.externalTokenToReserve(
      signerPrivateKey,
      entityId,
      tokenAddress,
      amount,
      options,
    );
  },
  async approveErc20(signerPrivateKey, tokenAddress, spender, amount) {
    return browserVM.approveErc20(
      signerPrivateKey,
      tokenAddress,
      spender,
      amount,
    );
  },
  async transferErc20(signerPrivateKey, tokenAddress, to, amount) {
    return await browserVM.transferErc20(signerPrivateKey, tokenAddress, to, amount);
  },
  async transferNative(signerPrivateKey, to, amount) {
    return await browserVM.transferNative(signerPrivateKey, to, amount);
  },
  async fundSignerWallet(address, amount, tokenSymbol) {
    await browserVM.fundSignerWallet(address, amount, tokenSymbol);
  },
  getBrowserVM: () => browserVM,
  setBlockTimestamp: timestamp => browserVM.setBlockTimestamp(timestamp),
  setQuietLogs: quiet => browserVM.setQuietLogs(quiet),
  registerEntityWallet: (entityId, privateKey) => browserVM.registerEntityWallet(entityId, privateKey),
  captureStateRoot: async () => await browserVM.captureStateRoot(),
  getCurrentBlockNumber: async () => Number(browserVM.getBlockNumber()),
  getFinalityDepth: () => 0,
  async syncRuntimeState(accountPairs, tokenIds) {
    return {
      collaterals: await browserVM.syncAllCollaterals(accountPairs, tokenIds),
      blockNumber: BigInt(browserVM.getBlockNumber()),
    };
  },
});

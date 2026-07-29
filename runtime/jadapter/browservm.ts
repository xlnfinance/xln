/**
 * BrowserVM JAdapter.
 *
 * BrowserVM is not release evidence for public testnet/mainnet. It is the
 * local visual-debugger/simnet J-machine used by Graph3D, scenarios, and
 * deterministic browser demos. Keep the boundary explicit: runtime code talks
 * to this module through JAdapter only; BrowserVMProvider owns the in-memory
 * EVM details.
 */

import type { Provider, Signer } from 'ethers';
import {
  Account__factory,
  Depository__factory,
  DeltaTransformer__factory,
  EntityProvider__factory,
} from '../../jurisdictions/typechain-types/index.ts';

import { normalizeEntityId } from '../entity/id';
import type { BrowserVMState, RuntimeState } from '../types';
import {
  normalizeAdapterEvents,
} from './helpers';
import type {
  JAdapter,
  JAdapterConfig,
  JBatchReceipt,
  JEvent,
  JReserveMint,
  JTokenInfo,
  JWalletSnapshot,
  JWalletSnapshotRequest,
  SnapshotId,
} from './types';
import type {
  BrowserVmChainCheckpoint,
  BrowserVMProvider,
  EVMEvent,
} from './browservm-provider';
import {
  assertDepositoryEntityProviderBinding,
  assertJStackAddressMatch,
} from './stack-binding';
import { createBrowserVmHistoryWatcher } from './browservm-history';
import {
  createBrowserVmSubmitTx,
  receiptFromEvents,
} from './browservm-submit';

const asFactoryRunner = (runner: unknown): Parameters<typeof Account__factory.connect>[1] =>
  runner as Parameters<typeof Account__factory.connect>[1];

const requireBrowserVmState = (state: BrowserVMState | string): BrowserVMState => {
  if (typeof state !== 'string') return state;
  try {
    return JSON.parse(state) as BrowserVMState;
  } catch {
    throw new Error('BrowserVM loadState requires serialized BrowserVMState JSON or object');
  }
};

export async function createBrowserVMAdapter(
  config: JAdapterConfig,
  provider: Provider,
  signer: Signer,
  browserVM: BrowserVMProvider,
): Promise<JAdapter> {
  if (config.fromReplica && !config.browserVMState) {
    throw new Error('BrowserVM cannot attach to fromReplica without browserVMState');
  }

  const addresses = {
    account: browserVM.getAccountAddress(),
    depository: browserVM.getDepositoryAddress(),
    entityProvider: browserVM.getEntityProviderAddress(),
    deltaTransformer: browserVM.getDeltaTransformerAddress(),
  };

  const account = Account__factory.connect(addresses.account, asFactoryRunner(signer));
  const depository = Depository__factory.connect(addresses.depository, asFactoryRunner(signer));
  const entityProvider = EntityProvider__factory.connect(addresses.entityProvider, asFactoryRunner(signer));
  const deltaTransformer = DeltaTransformer__factory.connect(addresses.deltaTransformer, asFactoryRunner(signer));

  let stackBindingVerified = false;
  const verifyStackBinding = async (context: string): Promise<void> => {
    stackBindingVerified = false;
    assertJStackAddressMatch(
      `${context}:depository`,
      addresses.depository,
      browserVM.getDepositoryAddress(),
    );
    assertJStackAddressMatch(
      `${context}:entity_provider`,
      addresses.entityProvider,
      browserVM.getEntityProviderAddress(),
    );
    await assertDepositoryEntityProviderBinding(context, depository, addresses.entityProvider);
    stackBindingVerified = true;
  };
  await verifyStackBinding('browservm_connect');

  let snapshotCounter = 0;
  const snapshots = new Map<SnapshotId, { root: Uint8Array; chain: BrowserVmChainCheckpoint }>();

  const toJEvents = (events: EVMEvent[]): JEvent[] => normalizeAdapterEvents(events);

  const historyWatcher = createBrowserVmHistoryWatcher({
    chainId: config.chainId,
    depositoryAddress: addresses.depository,
    entityProviderAddress: addresses.entityProvider,
    depository,
    entityProvider,
    browserVM,
  });
  const submitTx = createBrowserVmSubmitTx({
    chainId: config.chainId,
    addresses,
    browserVM,
    toJEvents,
  });

  const adapter: JAdapter = {
    mode: 'browservm',
    chainId: config.chainId,
    provider,
    signer,
    account,
    depository,
    entityProvider,
    deltaTransformer,
    addresses,
    get entityProviderDeploymentBlock() { return browserVM.getEntityProviderDeploymentBlock(); },

    async deployStack(): Promise<void> {
      await verifyStackBinding('browservm_deploy');
    },

    async snapshot(): Promise<SnapshotId> {
      const root = await browserVM.captureStateRoot();
      const id = `browservm:${++snapshotCounter}:${Buffer.from(root).toString('hex')}`;
      snapshots.set(id, {
        root: new Uint8Array(root),
        chain: browserVM.captureChainCheckpoint(),
      });
      return id;
    },

    async revert(snapshotId: SnapshotId): Promise<void> {
      const snapshot = snapshots.get(snapshotId);
      if (!snapshot) throw new Error(`BrowserVM snapshot not found: ${snapshotId}`);
      stackBindingVerified = false;
      await browserVM.timeTravel(snapshot.root);
      await browserVM.restoreChainCheckpoint(snapshot.chain);
      await verifyStackBinding('browservm_revert');
    },

    async dumpState(): Promise<BrowserVMState> {
      return await browserVM.serializeState();
    },

    async loadState(state: BrowserVMState | string): Promise<void> {
      stackBindingVerified = false;
      await browserVM.restoreState(requireBrowserVmState(state));
      await verifyStackBinding('browservm_restore');
    },

    async processBlock(): Promise<JEvent[]> {
      return [];
    },

    async getReserves(entityId: string, tokenId: number): Promise<bigint> {
      return await browserVM.getReserves(entityId, tokenId);
    },

    async getCollateral(entityId: string, counterpartyId: string, tokenId: number): Promise<bigint> {
      const collateral = await browserVM.getCollateral(entityId, counterpartyId, tokenId);
      return collateral.collateral;
    },

    async getAccountInfo(entityId: string, counterpartyId: string) {
      return await browserVM.getAccountInfo(entityId, counterpartyId);
    },

    async getEntityNonce(entityId: string): Promise<bigint> {
      return await browserVM.getEntityNonce(normalizeEntityId(entityId));
    },

    async hasProcessedBatch(entityId: string, batchHash: string, entityNonce: bigint): Promise<boolean> {
      return browserVM.hasProcessedBatch(normalizeEntityId(entityId), batchHash, entityNonce);
    },

    async getEntityProviderActionNonce(entityId: string): Promise<bigint> {
      return await browserVM.getEntityProviderActionNonce(normalizeEntityId(entityId));
    },

    async getEntityProviderActionReceipt(entityId: string, actionNonce: bigint): Promise<JEvent | null> {
      const receipt = browserVM.getEntityProviderActionReceipt(normalizeEntityId(entityId), actionNonce);
      return receipt ? toJEvents([receipt])[0] ?? null : null;
    },

    async isEntityRegistered(entityId: string): Promise<boolean> {
      return (await browserVM.getEntityInfo(normalizeEntityId(entityId))).exists;
    },

    async getTokenRegistry(): Promise<JTokenInfo[]> {
      return browserVM.getTokenRegistry();
    },

    async readWalletSnapshot(request: JWalletSnapshotRequest): Promise<JWalletSnapshot> {
      const tokenAddresses = request.tokenAddresses;
      const allowances = request.allowances ?? [];
      return {
        nativeBalance: request.includeNativeBalance === false
          ? null
          : await browserVM.getEthBalance(request.owner),
        tokenBalances: await Promise.all(
          tokenAddresses.map((tokenAddress) => browserVM.getErc20Balance(tokenAddress, request.owner)),
        ),
        allowances: await Promise.all(
          allowances.map((allowance) =>
            browserVM.getErc20Allowance(allowance.tokenAddress, request.owner, allowance.spender)
          ),
        ),
      };
    },

    async getErc20Balance(tokenAddress: string, owner: string): Promise<bigint> {
      return await browserVM.getErc20Balance(tokenAddress, owner);
    },

    async getErc20Balances(tokenAddresses: string[], owner: string): Promise<bigint[]> {
      return await Promise.all(tokenAddresses.map((tokenAddress) => browserVM.getErc20Balance(tokenAddress, owner)));
    },

    async getErc20Allowance(tokenAddress: string, owner: string, spender: string): Promise<bigint> {
      return await browserVM.getErc20Allowance(tokenAddress, owner, spender);
    },

    async getEthBalance(owner: string): Promise<bigint> {
      return await browserVM.getEthBalance(owner);
    },

    async getDebts(entityId: string, tokenId: number) {
      return await browserVM.getDebts(entityId, tokenId);
    },

    async processBatch(encodedBatch: string, hankoData: string, nonce: bigint): Promise<JBatchReceipt> {
      return receiptFromEvents(toJEvents(await browserVM.processBatch(encodedBatch, hankoData, nonce)));
    },

    async enforceDebts(entityId: string, tokenId: number, maxIterations?: number | bigint): Promise<void> {
      await browserVM.enforceDebts(entityId, tokenId, maxIterations);
    },

    async debugFundReserves(entityId: string, tokenId: number, amount: bigint): Promise<JEvent[]> {
      return toJEvents(await browserVM.debugFundReserves(entityId, tokenId, amount));
    },

    async debugFundReservesBatch(mints: JReserveMint[]): Promise<JEvent[]> {
      const events: JEvent[] = [];
      for (const mint of mints) {
        events.push(...toJEvents(await browserVM.debugFundReserves(mint.entityId, mint.tokenId, mint.amount)));
      }
      return events;
    },

    async externalTokenToReserve(signerPrivateKey, entityId, tokenAddress, amount, options) {
      return toJEvents(await browserVM.externalTokenToReserve(signerPrivateKey, entityId, tokenAddress, amount, options));
    },

    async approveErc20(signerPrivateKey, tokenAddress, spender, amount): Promise<JEvent[]> {
      return toJEvents(await browserVM.approveErc20(signerPrivateKey, tokenAddress, spender, amount));
    },

    async transferErc20(signerPrivateKey, tokenAddress, to, amount): Promise<string> {
      return await browserVM.transferErc20(signerPrivateKey, tokenAddress, to, amount);
    },

    async transferNative(signerPrivateKey, to, amount): Promise<string> {
      return await browserVM.transferNative(signerPrivateKey, to, amount);
    },

    async fundSignerWallet(address: string, amount?: bigint, tokenSymbol?: string): Promise<void> {
      await browserVM.fundSignerWallet(address, amount, tokenSymbol);
    },

    submitTx,

    startWatching(env: RuntimeState): void {
      if (!stackBindingVerified) {
        throw new Error(`J_STACK_BINDING_UNVERIFIED:browservm:chainId=${config.chainId}`);
      }
      historyWatcher.startWatching(env);
    },

    isWatching(): boolean {
      return historyWatcher.isWatching();
    },

    stopWatching(): void {
      historyWatcher.stopWatching();
    },

    async stopWatchingAndWait(): Promise<void> {
      await historyWatcher.stopWatchingAndWait();
    },

    async pollNow(): Promise<void> {
      await historyWatcher.pollNow();
    },

    getBrowserVM(): BrowserVMProvider {
      return browserVM;
    },

    setBlockTimestamp(timestamp: number): void {
      browserVM.setBlockTimestamp(timestamp);
    },

    setQuietLogs(quiet: boolean): void {
      browserVM.setQuietLogs(quiet);
    },

    registerEntityWallet(entityId: string, privateKey: string): void {
      browserVM.registerEntityWallet(entityId, privateKey);
    },

    async captureStateRoot(): Promise<Uint8Array> {
      return await browserVM.captureStateRoot();
    },

    async getCurrentBlockNumber(): Promise<number> {
      return Number(browserVM.getBlockNumber());
    },

    getWatcherScanProgress() {
      return historyWatcher.getProgress();
    },

    getFinalityDepth(): number {
      return 0;
    },

    async syncRuntimeState(accountPairs, tokenIds) {
      return {
        collaterals: await browserVM.syncAllCollaterals(accountPairs, tokenIds),
        blockNumber: BigInt(browserVM.getBlockNumber()),
      };
    },

    async close(): Promise<void> {
      await adapter.stopWatchingAndWait();
    },
  };

  return adapter;
}

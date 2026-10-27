import { expect, spyOn, test } from 'bun:test';
import { ethers } from 'ethers';
import { sealedHeader } from '../../helpers/jurisdiction/sealed-header';
import { Depository__factory, EntityProvider__factory } from '../../../../jurisdictions/typechain-types';
import { createRpcWatcherController } from '../../../jurisdiction/adapter/rpc/watcher/rpc-watcher-controller';
import { runWatcherPoll } from '../../../jurisdiction/adapter/rpc/watcher/rpc-watcher-poll';
import type { RpcWatcherServices, RpcWatcherSession } from '../../../jurisdiction/adapter/rpc/watcher/rpc-watcher-types';
import { isRpcWatcherTransientError } from '../../../jurisdiction/adapter/rpc/rpc-adapter';
import { rewindValidatorJHistory } from '../../../jurisdiction/machine/local-history';
import { createEntityProposalFixture } from '../../helpers/entity-proposal-fixture';
import { createTestJReplica } from '../../helpers/j-replica';
import { createJurisdictionConfig } from '../../../scenarios/harness/boot';

const hash = (n: number) => ethers.zeroPadValue(ethers.toBeHex(n), 32);
const depositoryAddress = `0x${'aa'.repeat(20)}`;
const entityProviderAddress = `0x${'bb'.repeat(20)}`;
const block41 = sealedHeader({ number: 41, parentHash: hash(40), stateRoot: hash(0) });
const block42 = sealedHeader({ number: 42, parentHash: block41.hash, stateRoot: hash(0) });
const fork42 = sealedHeader({ number: 42, parentHash: block41.hash, stateRoot: hash(0), extraData: '0xbb' });
const localHash = (height: number) => height === 41 ? block41.hash : height === 42 ? block42.hash : hash(height);

const setup = (certified: number, durable = 41) => {
  const { env, replica } = createEntityProposalFixture('recovery-controller', 1n, ['1']).createValidator('1');
  env.scenarioMode = true;
  const watcher = createTestJReplica({ name: 'recovery', chainId: 31337, blockNumber: BigInt(durable),
    entityProviderDeploymentBlock: 1, contracts: { depository: depositoryAddress, entityProvider: entityProviderAddress } });
  env.state.jReplicas.set(watcher.name, watcher);
  replica.state.config.jurisdiction = createJurisdictionConfig(watcher.name, depositoryAddress,
    entityProviderAddress, 'http://127.0.0.1:1', 31337);
  const jurisdictionRef = `stack:31337:${depositoryAddress}`;
  replica.state.lastFinalizedJHeight = certified;
  replica.state.jHistoryFinality = { jurisdictionRef, baseHeight: 0, finalizedThroughHeight: certified,
    tipBlockHash: localHash(certified), eventHistoryRoot: hash(0),
    proposerSignerId: replica.signerId, proposerSignature: '0x', entityHeight: 1 };
  replica.jHistory = { jurisdictionRef, scannedThroughHeight: 42, contiguousThroughHeight: 42,
    tipBlockHash: localHash(42), eventBlocks: new Map(), blockHashes: new Map([[41, localHash(41)], [42, localHash(42)]]) };
  const key = `${replica.entityId}:${replica.signerId}`;
  env.state.eReplicas.set(key, replica);
  const reads: string[] = [];
  class FixtureProvider extends ethers.JsonRpcProvider {
    override async send(method: string, params: unknown[]): Promise<unknown> {
      reads.push(method);
      if (method === 'eth_chainId') return '0x7a69';
      if (method === 'eth_call') return hash(1);
      if (method === 'eth_getBlockByNumber') {
        const height = Number(params[0]);
        if (height === 41) return block41;
        if (height === 42) return chain.replacement === block42.hash ? block42 : fork42;
      }
      throw new Error(`UNEXPECTED_RECOVERY_READ:${method}`);
    }
  }
  const provider = new FixtureProvider(undefined, 31337, { staticNetwork: true });
  const depository = Depository__factory.connect(depositoryAddress, provider);
  const entityProvider = EntityProvider__factory.connect(entityProviderAddress, provider);
  const chain = { head: 42, replacement: fork42.hash };
  const services: RpcWatcherServices = {
    provider, mode: 'browservm', chainId: 31337, depositoryAddress, entityProviderAddress,
    getDepository: () => depository, getEntityProvider: () => entityProvider,
    getLiveDepositoryAddress: async () => depositoryAddress,
    getLiveEntityProviderAddress: async () => entityProviderAddress,
    assertStackBindingVerified() {}, readCurrentBlockNumber: async () => chain.head,
    readSafeBlockNumber: async () => chain.head,
    readBlockHeaders: async heights => {
      reads.push('canonical');
      return heights.map(jHeight => ({ jHeight, jBlockHash: jHeight === 42 ? chain.replacement : localHash(jHeight) }));
    },
    sendAuthenticatedBatch: calls => Promise.all(calls.map(call => provider.send(call.method, call.params))),
    resolveFinalityDepth: () => 0, isTransientRpcUnavailable: isRpcWatcherTransientError,
  };
  return { env, replica, watcher, key, reads, chain, services, controller: createRpcWatcherController(services), provider };
};

test('controller restart reconciles 41/42 A-to-B, waits for rewind, then recovers without publishing 42', async () => {
  const f = setup(41);
  const exit = spyOn(process, 'exit').mockImplementation(() => { throw new Error('FATAL_EXIT'); });
  try {
    f.controller.startWatching(f.env);
    await f.controller.pollNow();
    expect(exit).not.toHaveBeenCalled();
    expect(f.reads).toEqual(['canonical']);
    expect(f.env.runtimeMempool?.runtimeTxs.map(tx => tx.type)).toEqual(['rewindJHistory']);
    await f.controller.pollNow();
    expect(f.reads).toEqual(['canonical', 'canonical']);
    expect(f.env.runtimeMempool?.runtimeTxs).toHaveLength(1);
    f.replica.jHistory = rewindValidatorJHistory(f.replica.state, f.replica.jHistory);
    f.chain.head = 41;
    await f.controller.pollNow();
    expect(exit).not.toHaveBeenCalled();
    expect(f.controller.isWatching()).toBe(true);
    expect(f.watcher.blockNumber).toBe(41n);
    expect(f.env.runtimeMempool?.runtimeTxs.some(tx => tx.type === 'advanceJWatcherCursor')).toBe(false);
  } finally {
    await f.controller.stopWatchingAndWait();
    exit.mockRestore();
    await f.provider.destroy();
  }
});

test('controller restart rejects a changed certified 42 before any recovery or cursor publication', async () => {
  const f = setup(42);
  const exit = spyOn(process, 'exit').mockImplementation(() => { throw new Error('FATAL_EXIT'); });
  try {
    f.controller.startWatching(f.env);
    await expect(f.controller.pollNow()).rejects.toThrow('FATAL_EXIT');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(f.reads).toEqual(['canonical']);
    expect(f.controller.isWatching()).toBe(false);
    expect(f.env.runtimeMempool?.runtimeTxs ?? []).toEqual([]);
  } finally {
    await f.controller.stopWatchingAndWait();
    exit.mockRestore();
    await f.provider.destroy();
  }
});

test('controller restart at a fresh certified anchor with no dispute starts reads no receipt history', async () => {
  const f = setup(42, 0);
  f.chain.replacement = block42.hash;
  const exit = spyOn(process, 'exit').mockImplementation(() => { throw new Error('FATAL_EXIT'); });
  try {
    f.controller.startWatching(f.env);
    await f.controller.pollNow();
    expect(exit).not.toHaveBeenCalled();
    expect(f.reads).toEqual(['canonical']);
    const cursor = f.env.runtimeMempool?.runtimeTxs.find(tx => tx.type === 'advanceJWatcherCursor');
    expect(cursor?.data.blockNumber).toBe(42);
  } finally {
    await f.controller.stopWatchingAndWait();
    exit.mockRestore();
    await f.provider.destroy();
  }
});


test('anchor-commit poll retains only cache through its anchor and performs no authenticated history read', async () => {
  const f = setup(42, 0);
  f.chain.replacement = block42.hash;
  f.watcher.disputeReferences = { bodies: {}, arguments: {}, startBlocks: { retained: 41, future: 99 } };
  const session: RpcWatcherSession = {
    env: f.env, generation: 1, interval: null, manualPolling: true, confirmationDepth: 0, pollMs: 1,
    lastSyncedBlock: 0, scanProgress: { scannedThroughHeight: 0, replicaScannedThrough: {} },
    pendingBlocks: new Map(), pendingHistoryRange: null, pendingHistoryWaitKey: '',
    pendingAnchor: { height: 42, replicaKeys: [f.key] }, pendingRewindReplicaKeys: [],
    lastAuthorityAuditKey: '', boardAnchorAudits: new Map(), reserveAnchorAudits: new Map(),
    actionNonceAudits: new Map(), debtAnchorAudits: new Map(), debtProvenanceAudits: new Set(),
    provenValues: new Map(), lastObservedHead: -1, lastCanonicalAuditAtMs: 0,
    transientFailures: 0, lastTransientLogAtMs: 0,
    rpcCooldown: { backoffMs: 0, untilMs: 0, releaseWait: null }, maxBlocksPerPoll: 256,
    txCounter: { value: 0, _seenLogs: { set: new Set(), order: [] } }, readWatchedErc20Tokens: async () => [],
  };
  try {
    await runWatcherPoll({ session, services: f.services, trace: { step: '', fromBlock: null, toBlock: null },
      isCancelled: () => false, emitDebug() {} });
    expect(session.pendingAnchor).toBeNull();
    expect(session.disputeReferences).toEqual({ bodies: {}, arguments: {}, startBlocks: { retained: 41 } });
    expect(f.reads).toEqual(['canonical']);
  } finally { await f.provider.destroy(); }
});


test('canonical unfinalized suffix is reauthenticated before its lost cache can advance the cursor', async () => {
  const f = setup(41);
  f.chain.replacement = block42.hash;
  try {
    f.controller.startWatching(f.env);
    await f.controller.pollNow();
    expect(f.reads).toContain('eth_getBlockByNumber');
    expect(f.controller.isWatching()).toBe(true);
    expect(f.watcher.blockNumber).toBe(41n);
    expect(f.env.runtimeMempool?.runtimeTxs.some(tx => tx.type === 'advanceJWatcherCursor') ?? false).toBe(false);
  } finally { await f.controller.stopWatchingAndWait(); await f.provider.destroy(); }
});

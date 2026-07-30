import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createJAdapter } from '../jadapter';
import {
  attachLiveJAdapter,
  getLiveJAdapter,
} from '../runtime/live-jadapters';
import {
  applyJEventsToEnv,
  buildJEventsRuntimeInput,
} from '../jadapter/manual-event-ingress';
import { parseReceiptLogsToJEvents } from '../jadapter/j-event-log-decoder';
import { bindLocalJEventIngressSource } from '../jadapter/local-ingress-source';
import { resolveApprovalReceiptLogIndex } from '../jadapter/rpc-public';
import { createEmptyEnv } from '../runtime';
import type { EntityReplica, JurisdictionConfig } from '../entity/types';
import type { JReplica } from '../types/jurisdiction-runtime';

const address = (byte: string): string => `0x${byte.repeat(20)}`;
const entityId = (byte: string): string => `0x${byte.repeat(32)}`;
const blockHash = (byte: string): string => `0x${byte.repeat(32)}`;

const jurisdiction = (
  name: string,
  chainId: number,
  depositoryByte: string,
  entityProviderByte: string,
): JurisdictionConfig => ({
  name,
  address: `rpc://${name}`,
  chainId,
  depositoryAddress: address(depositoryByte),
  entityProviderAddress: address(entityProviderByte),
});

const jReplica = (config: JurisdictionConfig): JReplica => ({
  name: config.name,
  blockNumber: 0n,
  stateRoot: null,
  mempool: [],
  blockDelayMs: 0,
  lastBlockTimestamp: 0,
  chainId: config.chainId,
  depositoryAddress: config.depositoryAddress,
  entityProviderAddress: config.entityProviderAddress,
  contracts: {
    depository: config.depositoryAddress,
    entityProvider: config.entityProviderAddress,
  },
  position: { x: 0, y: 0, z: 0 },
});

const entityReplica = (
  id: string,
  signerId: string,
  config: JurisdictionConfig,
): EntityReplica => ({
  entityId: id,
  signerId,
  entityEncPubKey: '',
  mempool: [],
  isProposer: true,
  state: {
    entityId: id,
    height: 0,
    timestamp: 1,
    nonces: new Map(),
    proposals: new Map(),
    config: {
      mode: 'proposer-based',
      threshold: 1n,
      validators: [signerId],
      shares: { [signerId]: 1n },
      jurisdiction: config,
    },
    reserves: new Map(),
    accounts: new Map(),
    deferredAccountProposals: new Map(),
    lastFinalizedJHeight: 0,
    jBlockChain: [],
    profile: { name: 'source-bound', isHub: false, avatar: '', bio: '', website: '' },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    lockBook: new Map(),
    swapTradingPairs: [],
  },
} as EntityReplica);

describe('manual J-event ingress source binding', () => {
  test('accepts only the exact locally registered replica object', () => {
    const env = createEmptyEnv('manual-j-ingress-object-capability');
    const config = jurisdiction('chain-local', 31_337, 'c1', 'c2');
    const source = jReplica(config);
    env.state.jReplicas.set(config.name, source);

    expect(bindLocalJEventIngressSource(env, source, 'exact')).toMatchObject({
      replica: source,
      chainId: config.chainId,
      depositoryAddress: config.depositoryAddress,
      entityProviderAddress: config.entityProviderAddress,
    });
    expect(() => bindLocalJEventIngressSource(env, { ...source }, 'clone'))
      .toThrow('J_EVENT_LOCAL_SOURCE_NOT_REGISTERED:clone');
  });

  test('a chain-B block cannot be relabeled into chain-A entity history', () => {
    const env = createEmptyEnv('manual-j-ingress-cross-chain');
    // Deterministic CREATE deployments can produce identical stack addresses
    // on different chains. The local object capability plus chainId must still
    // keep their histories disjoint.
    const chainA = jurisdiction('chain-a', 31_337, 'a1', 'a2');
    const chainB = jurisdiction('chain-b', 31_338, 'a1', 'a2');
    const sourceA = jReplica(chainA);
    const sourceB = jReplica(chainB);
    env.state.jReplicas = new Map([[chainA.name, sourceA], [chainB.name, sourceB]]);

    const entityA = entityId('aa');
    const entityB = entityId('bb');
    env.state.eReplicas.set(`${entityA}:1`, entityReplica(entityA, '1', chainA));
    env.state.eReplicas.set(`${entityB}:2`, entityReplica(entityB, '2', chainB));

    const input = buildJEventsRuntimeInput(env, [{
      name: 'ReserveUpdated',
      args: { entity: entityA, tokenId: 1, newBalance: 99n },
      blockNumber: 12,
      blockHash: blockHash('b3'),
      transactionHash: blockHash('b4'),
      logIndex: 7,
    }], 'chain-b-manual-receipt', sourceB);

    expect(input).toBeNull();
    expect(input?.runtimeTxs.some((tx) =>
      tx.type === 'observeJRange' && tx.data.entityId === entityA
    ) ?? false).toBe(false);
  });

  test('receipt parsing preserves the canonical EVM log index', () => {
    const env = createEmptyEnv('manual-j-ingress-log-index');
    const config = jurisdiction('chain-log-index', 31_337, 'd1', 'd2');
    const source = jReplica(config);
    env.state.jReplicas.set(config.name, source);
    const observedEntity = entityId('41');
    env.state.eReplicas.set(`${observedEntity}:1`, entityReplica(observedEntity, '1', config));
    const contractInterface = new ethers.Interface([
      'event ReserveUpdated(bytes32 indexed entity,uint256 indexed tokenId,uint256 newBalance)',
    ]);
    const fragment = contractInterface.getEvent('ReserveUpdated');
    if (!fragment) throw new Error('TEST_RESERVE_UPDATED_EVENT_MISSING');
    const encoded = contractInterface.encodeEventLog(
      fragment,
      [entityId('41'), 3n, 25n],
    );
    const receipt = {
      logs: [{ address: address('43'), topics: encoded.topics, data: encoded.data, index: 9 }],
      blockNumber: 1,
      blockHash: blockHash('44'),
      hash: blockHash('45'),
    };

    const events = parseReceiptLogsToJEvents(
      receipt,
      [{ address: address('43'), interface: contractInterface }],
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.logIndex).toBe(9);
    const input = buildJEventsRuntimeInput(env, events, 'receipt-log-index', source);
    const observed = input?.runtimeTxs.find((tx) => tx.type === 'observeJRange');
    expect(observed?.type === 'observeJRange'
      ? observed.data.blocks[0]?.events[0]?.logIndex
      : undefined).toBe(9);
    expect(() => parseReceiptLogsToJEvents({
      ...receipt,
      logs: [{ ...receipt.logs[0]!, data: '0x01' }],
    }, [{ address: address('43'), interface: contractInterface }])).toThrow('J_RECEIPT_LOG_DECODE_FAILED');
    expect(parseReceiptLogsToJEvents({
      ...receipt,
      logs: [{ ...receipt.logs[0]!, address: address('46') }],
    }, [{ address: address('43'), interface: contractInterface }])).toEqual([]);
    expect(() => parseReceiptLogsToJEvents(receipt, [
      { address: address('43'), interface: contractInterface },
      { address: address('43'), interface: contractInterface },
    ])).toThrow(`J_RECEIPT_CARRIER_ADDRESS_DUPLICATE:${address('43')}`);
    expect(() => parseReceiptLogsToJEvents({
      ...receipt,
      logs: [],
      blockNumber: 0,
      blockHash: '0x',
      hash: '0x',
    }, [])).toThrow('J_ADAPTER_RECEIPT_COORDINATES_INVALID');
  });

  test('manual chain events fail closed when EVM log order is absent', () => {
    const env = createEmptyEnv('manual-j-ingress-log-index-missing');
    const config = jurisdiction('chain-log-index-missing', 31_337, 'e1', 'e2');
    const source = jReplica(config);
    env.state.jReplicas.set(config.name, source);

    expect(() => buildJEventsRuntimeInput(env, [{
      name: 'ReserveUpdated',
      args: { entity: entityId('51'), tokenId: 1, newBalance: 1n },
      blockNumber: 1,
      blockHash: blockHash('51'),
      transactionHash: blockHash('52'),
    }], 'receipt-log-index-missing', source)).toThrow(
      'J_EVENT_MANUAL_LOG_INDEX_MISSING:receipt-log-index-missing:0:ReserveUpdated',
    );
  });

  test('approval delta requires exactly one matching receipt log with canonical index', () => {
    const tokenAddress = address('61');
    const owner = address('62');
    const spender = address('63');
    const receiptHash = blockHash('64');
    const approvalInterface = new ethers.Interface([
      'event Approval(address indexed owner,address indexed spender,uint256 value)',
    ]);
    const fragment = approvalInterface.getEvent('Approval');
    if (!fragment) throw new Error('TEST_APPROVAL_EVENT_MISSING');
    const encoded = approvalInterface.encodeEventLog(fragment, [owner, spender, 77n]);
    const log = {
      address: tokenAddress,
      topics: encoded.topics,
      data: encoded.data,
      index: 11,
    };
    const params = {
      receiptHash,
      tokenAddress,
      owner,
      spender,
      allowance: 77n,
    };
    const logWithoutIndex = {
      address: log.address,
      topics: log.topics,
      data: log.data,
    };

    expect(resolveApprovalReceiptLogIndex({ ...params, logs: [log] })).toBe(11);
    expect(() => resolveApprovalReceiptLogIndex({
      ...params,
      logs: [logWithoutIndex],
    })).toThrow(`APPROVAL_EVENT_LOG_INDEX_INVALID:${receiptHash}:undefined`);
    expect(() => resolveApprovalReceiptLogIndex({
      ...params,
      logs: [log, { ...log, index: 12 }],
    })).toThrow(`APPROVAL_EVENT_MATCH_COUNT_INVALID:${receiptHash}:2`);
  });

  test('two real BrowserVM stacks with identical addresses stay chain-bound', async () => {
    const adapterA = await createJAdapter({ mode: 'browservm', chainId: 31_337 });
    const adapterB = await createJAdapter({ mode: 'browservm', chainId: 31_338 });
    adapterA.setQuietLogs?.(true);
    adapterB.setQuietLogs?.(true);
    try {
      await adapterA.deployStack();
      await adapterB.deployStack();
      expect(adapterB.addresses.depository).toBe(adapterA.addresses.depository);
      expect(adapterB.addresses.entityProvider).toBe(adapterA.addresses.entityProvider);

      const chainA = jurisdiction('real-chain-a', adapterA.chainId, '01', '02');
      const chainB = jurisdiction('real-chain-b', adapterB.chainId, '01', '02');
      chainA.depositoryAddress = adapterA.addresses.depository;
      chainA.entityProviderAddress = adapterA.addresses.entityProvider;
      chainB.depositoryAddress = adapterB.addresses.depository;
      chainB.entityProviderAddress = adapterB.addresses.entityProvider;
      const sourceA = {
        ...jReplica(chainA),
        contracts: { ...adapterA.addresses },
      } satisfies JReplica;
      const sourceB = {
        ...jReplica(chainB),
        contracts: { ...adapterB.addresses },
      } satisfies JReplica;
      const isolatedA = createEmptyEnv('live-jadapter-runtime-a');
      const isolatedB = createEmptyEnv('live-jadapter-runtime-b');
      isolatedA.state.jReplicas.set('shared-name', sourceA);
      isolatedB.state.jReplicas.set('shared-name', sourceB);
      attachLiveJAdapter(isolatedA, 'shared-name', adapterA);
      attachLiveJAdapter(isolatedB, 'shared-name', adapterB);
      expect(getLiveJAdapter(isolatedA, 'shared-name')).toBe(adapterA);
      expect(getLiveJAdapter(isolatedB, 'shared-name')).toBe(adapterB);
      expect(isolatedA.state.jReplicas.get('shared-name')).not.toHaveProperty('jadapter');
      expect(isolatedB.state.jReplicas.get('shared-name')).not.toHaveProperty('jadapter');
      const mismatchedEnv = createEmptyEnv('manual-j-ingress-real-stack-mismatch');
      mismatchedEnv.state.jReplicas.set(chainB.name, {
        ...sourceB,
        entityProviderAddress: address('ff'),
        contracts: { ...sourceB.contracts, entityProvider: address('ff') },
      });
      attachLiveJAdapter(mismatchedEnv, chainB.name, adapterB);
      expect(() => bindLocalJEventIngressSource(
        mismatchedEnv,
        mismatchedEnv.state.jReplicas.get(chainB.name),
        'real-stack-mismatch',
      )).toThrow('J_EVENT_LOCAL_SOURCE_ENTITY_PROVIDER_MISMATCH');
      const env = createEmptyEnv('manual-j-ingress-real-two-stack');
      env.state.jReplicas = new Map([[chainA.name, sourceA], [chainB.name, sourceB]]);
      attachLiveJAdapter(env, chainA.name, adapterA);
      attachLiveJAdapter(env, chainB.name, adapterB);
      const entityA = entityId('71');
      const entityB = entityId('72');
      env.state.eReplicas.set(`${entityA}:1`, entityReplica(entityA, '1', chainA));
      env.state.eReplicas.set(`${entityB}:2`, entityReplica(entityB, '2', chainB));

      const events = await adapterB.debugFundReserves(entityB, 1, 5n);
      expect(events).toHaveLength(1);
      expect(events[0]?.logIndex).toBe(0);
      const relabeled = events.map((event) => ({
        ...event,
        args: { ...event.args, entity: entityA },
      }));
      applyJEventsToEnv(env, relabeled, 'real-chain-b-relabeled', adapterB);
      expect(env.runtimeMempool?.runtimeTxs ?? []).toHaveLength(0);

      applyJEventsToEnv(env, events, 'real-chain-b-valid', adapterB);
      const observations = (env.runtimeMempool?.runtimeTxs ?? [])
        .filter((tx) => tx.type === 'observeJRange');
      expect(observations.map((tx) => tx.data.entityId)).toEqual([entityB]);
      expect(observations.some((tx) => tx.data.entityId === entityA)).toBe(false);
      expect(observations[0]?.data.blocks[0]?.events[0]?.logIndex).toBe(0);
    } finally {
      await adapterA.close();
      await adapterB.close();
    }
  }, 120_000);

  test('frontend HTTP responses cannot be promoted into local consensus events', () => {
    const panelSource = readFileSync(join(
      process.cwd(),
      'frontend/src/lib/components/Entity/EntityPanelTabs.svelte',
    ), 'utf8');
    const walletSource = readFileSync(join(
      process.cwd(),
      'frontend/src/lib/components/Entity/external-wallet-reader.ts',
    ), 'utf8');
    const snapshotFallbackStart = walletSource.indexOf(
      'const response = await fetch(`${apiBase}/api/external-wallet/snapshot`',
    );
    const snapshotFallbackEnd = walletSource.indexOf('const balanceByToken = new Map(', snapshotFallbackStart);
    const faucetStart = panelSource.indexOf('async function faucetReserves(');
    const faucetEnd = panelSource.indexOf('async function faucetOffchain(', faucetStart);
    expect(snapshotFallbackStart).toBeGreaterThan(0);
    expect(snapshotFallbackEnd).toBeGreaterThan(snapshotFallbackStart);
    expect(faucetStart).toBeGreaterThan(0);
    expect(faucetEnd).toBeGreaterThan(faucetStart);
    expect(walletSource.slice(snapshotFallbackStart, snapshotFallbackEnd)).not.toContain(
      'applyCanonicalJEventsToActiveEnv',
    );
    expect(panelSource.slice(faucetStart, faucetEnd)).not.toContain(
      'applyCanonicalJEventsToActiveEnv(result.events',
    );
    expect(panelSource).not.toContain('async function applyCanonicalJEventsToActiveEnv');
    expect(walletSource).not.toContain('async function applyCanonicalJEventsToActiveEnv');
  });
});

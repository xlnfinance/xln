import { bindCrossRuntimeEntry, decodeNativeCrossState } from '../../../scripts/operations/hlt/cross/cross-hub';
import { describe, expect, test } from 'bun:test';

import { withCanonicalCrossJurisdictionRouteHash } from '../../../extensions/cross-j';
import { deriveManagedEntityIdentity } from '../../../orchestrator/daemon-control';
import {
  httpBaseForRuntimeWsUrl,
  resolveLoadJurisdictionRpc,
  toEntityJurisdiction,
} from '../../../scripts/operations/hlt/cross/worker-cross';
import {
  decodeCrossLoadReport,
  decodeCommittedCrossRoutes,
  selectMarketMakerCrossRoute,
} from '../../../scripts/operations/hlt/cross/cross-boundary';
import { decodeCrossRecoveryReport } from '../../../scripts/operations/hlt/cross/cross-recovery-boundary';
import { parseWorkerArgs } from '../../../scripts/operations/hlt/worker-runtime';
import { decodeBuffer } from '../../../storage/codec/codec';
import { groupAtomicCrossJAdmissionOutputs } from '../../../runtime/delivery/pending';
import { validateDeliverableEntityInput } from '../../../runtime/delivery/topology/routing-validation';

test('native H85 interleaved close WAL has the exact TS input-order atomic envelope oracle', async () => {
  const capsule = await Bun.file(
    new URL('../../../../rscore/fixtures/native-cross-close-interleaved-v1.json', import.meta.url),
  ).json();
  const inputs = (capsule.rowsBase64 as string[]).map(row =>
    validateDeliverableEntityInput(decodeBuffer(Buffer.from(row, 'base64'))),
  );
  const byTarget = new Map<string, typeof inputs>();
  for (const input of inputs) {
    const group = byTarget.get(input.runtimeId) ?? [];
    group.push(input);
    byTarget.set(input.runtimeId, group);
  }
  const groups = [...byTarget].flatMap(([target, rows]) =>
    groupAtomicCrossJAdmissionOutputs(rows).map(unit => ({
      target,
      atomic: unit.atomic,
      complete: unit.complete,
      indices: unit.outputs.map(input => inputs.indexOf(input)),
    })),
  );
  expect(groups).toEqual(capsule.expectedGroups);
  expect(groups.map(group => group.indices)).toEqual([
    [0, 3],
    [1, 2],
  ]);
  expect(inputs.map(input => input.sourceRuntimeFrame)).toEqual(
    Array.from({ length: 4 }, () => ({
      height: capsule.height,
      timestamp: capsule.timestamp,
    })),
  );
});

const entity = (byte: string): string => `0x${byte.repeat(64)}`;
const signer = (byte: string): string => `0x${byte.repeat(40)}`;

const route = (orderId: string, sourceHub: string, targetHub: string) =>
  withCanonicalCrossJurisdictionRouteHash({
    orderId,
    makerEntityId: entity('1'),
    hubEntityId: sourceHub,
    bookOwnerEntityId: sourceHub,
    sourceSignerId: signer('1'),
    sourceHubSignerId: signer('2'),
    targetHubSignerId: signer('3'),
    targetSignerId: signer('4'),
    source: {
      jurisdiction: `stack:31337:${signer('a')}`,
      entityId: entity('1'),
      counterpartyEntityId: sourceHub,
      tokenId: 1,
      amount: 10_000_000n,
    },
    target: {
      jurisdiction: `stack:31338:${signer('b')}`,
      entityId: targetHub,
      counterpartyEntityId: entity('4'),
      tokenId: 2,
      amount: 4_000_000_000_000_000n,
    },
    sourceDisputeConfig: { leftResponseSeconds: 3_600, rightResponseSeconds: 86_400 },
    targetDisputeConfig: { leftResponseSeconds: 3_600, rightResponseSeconds: 86_400 },
    priceTicks: 25_000_000n,
    riskMode: 'fully_collateralized',
    status: 'resting',
    createdAt: 1_000,
    updatedAt: 1_000,
    expiresAt: 61_000,
  });

const hubCore = (routes: ReadonlyMap<string, unknown>) => ({
  entityId: entity('9'),
  entityEncryptionPublicKey: '0x01',
  height: 4,
  timestamp: 5,
  profile: {},
  config: {},
  nonces: new Map(),
  proposals: new Map(),
  reserves: new Map(),
  lastFinalizedJHeight: 0,
  paybook: { entries: new Map(), feesEarned: 0n },
  debtTotals: { incoming: new Map(), outgoing: new Map() },
  crossJurisdictionSwaps: routes,
});

describe('production cross-j swap load boundaries', () => {
  test('isolated cross connections retain live capabilities and ignore advertised public hosts', () => {
    const entries = [
      { label: 'Custody', engine: 'ts' as const, token: 'custody-capability', wsUrl: 'wss://custody.xln.finance/rpc' },
      { label: 'H1', engine: 'ts' as const, token: 'hub-capability', wsUrl: 'wss://h1.xln.finance/rpc' },
    ];
    for (const portBase of [20_000, 30_000]) {
      for (const [label, offset] of [
        ['Custody', 8],
        ['H1', 10],
      ] as const) {
        const bound = bindCrossRuntimeEntry(entries, label, portBase);
        expect(bound).toEqual({
          ...entries.find(entry => entry.label === label)!,
          wsUrl: `ws://127.0.0.1:${portBase + offset}/rpc`,
        });
        expect(new URL(bound.wsUrl).hostname).toBe('127.0.0.1');
      }
    }
    expect(entries.map(entry => entry.wsUrl)).toEqual(['wss://custody.xln.finance/rpc', 'wss://h1.xln.finance/rpc']);
  });

  test('native committed cross query preserves routes and rejects frame hash as state root', () => {
    const entityId = entity('9');
    const committed = route('native-query', entityId, entity('8'));
    const value = {
      entityId,
      signerId: signer('2'),
      jurisdiction: { chainId: 31337 },
      frame: { height: 9, canonicalStateHash: entity('a') },
      routes: [committed],
    };
    expect(decodeNativeCrossState(value, entityId)).toEqual({
      identity: { entityId, signerId: signer('2') },
      chainId: 31337,
      frame: value.frame,
      routes: [committed],
    });
    expect(() => decodeNativeCrossState({ ...value, entityId: entity('8') }, entityId)).toThrow(
      'HLT_NATIVE_CROSS_STATE_IDENTITY',
    );
    expect(() =>
      decodeNativeCrossState({ ...value, frame: { height: 9, runtimeFrameHash: entity('a') } }, entityId),
    ).toThrow('HLT_NATIVE_CROSS_FRAME_ROOT');
    expect(() =>
      decodeNativeCrossState(
        { ...value, routes: [{ ...committed, source: { ...committed.source, amount: -1n } }] },
        entityId,
      ),
    ).toThrow();
  });

  test('recovery worker requires a complete old/new process identity pair', () => {
    const base = ['--work-dir', '/tmp/xln-load', '--port-base', '20000', '--mode', 'cross-recovery', '--swaps', '1'];
    expect(() => parseWorkerArgs([...base, '--server-pid-before-restart', '101'])).toThrow(
      'PRODUCTION_SWAP_LOAD_RESTART_PIDS_INCOMPLETE',
    );
    expect(
      parseWorkerArgs([...base, '--server-pid-before-restart', '101', '--server-pid-after-restart', '202']),
    ).toMatchObject({ serverPidBeforeRestart: 101, serverPidAfterRestart: 202 });
  });

  test('relative shard RPCs bind to the production server origin', () => {
    expect(resolveLoadJurisdictionRpc('/rpc2', 'http://127.0.0.1:20004')).toBe('http://127.0.0.1:20004/rpc2');
    expect(() => resolveLoadJurisdictionRpc('ws://127.0.0.1:20004/rpc2', 'http://127.0.0.1:20004')).toThrow(
      'PRODUCTION_SWAP_LOAD_JURISDICTION_RPC_INVALID',
    );
  });

  test('daemon HTTP control follows the actual Runtime websocket endpoint', () => {
    expect(httpBaseForRuntimeWsUrl('ws://127.0.0.1:20008/rpc')).toBe('http://127.0.0.1:20008');
    expect(httpBaseForRuntimeWsUrl('wss://runtime.example/rpc')).toBe('https://runtime.example');
  });

  test('managed load identities commit their exact jurisdiction', () => {
    const jurisdiction = {
      name: 'Tron',
      address: 'jreplica://Tron',
      chainId: 31_338,
      depositoryAddress: signer('a'),
      entityProviderAddress: signer('b'),
    };
    const identity = deriveManagedEntityIdentity({
      name: 'Load Target',
      seed: 'load-target',
      signerLabel: 'load-target',
      jurisdiction,
    });
    expect(identity.consensusConfig.jurisdiction).toEqual(jurisdiction);
  });

  test('Entity jurisdiction authority binds the stack instead of a local catalog alias', () => {
    const jurisdiction = toEntityJurisdiction({
      name: 'Testnet',
      rpc: 'http://127.0.0.1:20004/rpc',
      chainId: 31_337,
      blockTimeMs: 300,
      contracts: {
        account: signer('1'),
        deltaTransformer: signer('2'),
        depository: signer('a'),
        entityProvider: signer('b'),
      },
      entityProviderDeploymentBlock: 3,
    });
    expect(jurisdiction.name).toBe(`stack:31337:${signer('a')}`);
  });

  test('committed route decoder validates bytes and selects the canonical MM route', () => {
    const sourceHub = entity('2');
    const targetHub = entity('3');
    const expensive = route('mmx-expensive', sourceHub, targetHub);
    const { routeHash: _oldRouteHash, ...cheapTerms } = route('mmx-cheap', sourceHub, targetHub);
    const cheap = withCanonicalCrossJurisdictionRouteHash({
      ...cheapTerms,
      priceTicks: 24_999_000n,
    });
    const decoded = decodeCommittedCrossRoutes(
      hubCore(
        new Map([
          [expensive.orderId, expensive],
          [cheap.orderId, cheap],
        ]),
      ),
    );
    expect(selectMarketMakerCrossRoute(decoded, sourceHub, targetHub).orderId).toBe('mmx-cheap');
    expect(() =>
      decodeCommittedCrossRoutes(
        hubCore(new Map([[cheap.orderId, { ...cheap, source: { ...cheap.source, amount: '10000000' } }]])),
      ),
    ).toThrow('PRODUCTION_SWAP_LOAD_CROSS_ROUTE_INVALID');
    expect(() => decodeCommittedCrossRoutes(hubCore(new Map([['wrong-key', cheap]])))).toThrow(
      'PRODUCTION_SWAP_LOAD_CROSS_ROUTE_ID_MISMATCH',
    );
  });

  test('cross report requires full committed fill and ordered timings', () => {
    const root = `0x${'ab'.repeat(32)}`;
    const frame = { height: 10, canonicalStateHash: root };
    const report = {
      schema: 'xln-production-cross-swap-load-v1',
      mode: 'cross',
      configuredBurstSize: 1,
      configuredRounds: 1,
      settledRoutes: 1,
      economicTps: 333.3,
      completionAuthority: 'committed_cross_route_full_fill',
      marketMakerOrderId: 'mmx-1',
      loadOrderId: 'load-1',
      sourceAmount: '100',
      targetAmount: '90',
      routeStatus: 'settled',
      enqueueAckElapsedMs: 1,
      commandObservedElapsedMs: 2,
      economicCompletionElapsedMs: 3,
      hubWalBytesBefore: 10,
      hubWalBytesAfter: 20,
      loadWalBytesBefore: 30,
      loadWalBytesAfter: 40,
      hubDurableBefore: frame,
      hubDurableAfter: frame,
      loadDurableBefore: frame,
      loadDurableAfter: frame,
      environment: {
        disputeHankos: 'always',
        hubWalSync: true,
        lanePersistence: false,
        laneWalSync: false,
        laneNice: 0,
        cryptoPoolWorkers: 'default',
        cryptoSignWorkers: 'default',
        accountWorkers: 4,
      },
    };
    expect(decodeCrossLoadReport(report).routeStatus).toBe('settled');
    expect(() => decodeCrossLoadReport({ ...report, routeStatus: 'cancelled' })).toThrow(
      'PRODUCTION_SWAP_LOAD_CROSS_REPORT_SCHEMA_INVALID',
    );
    expect(() => decodeCrossLoadReport({ ...report, commandObservedElapsedMs: 4 })).toThrow(
      'PRODUCTION_SWAP_LOAD_CROSS_REPORT_TIMING_INVALID',
    );
    expect(() =>
      decodeCrossLoadReport({
        ...report,
        environment: { ...report.environment, accountWorkers: 'unknown' },
      }),
    ).toThrow('PRODUCTION_SWAP_LOAD_CROSS_REPORT_ENVIRONMENT_ACCOUNT_WORKERS_UNKNOWN');
  });

  test('recovery evidence requires the settled route and descendant Runtime heads', () => {
    const frame = { height: 10, canonicalStateHash: `0x${'cd'.repeat(32)}` };
    const report = {
      schema: 'xln-production-cross-swap-recovery-v1',
      completionAuthority: 'committed_route_descendant_heads_and_process_replacement',
      serverPidBeforeRestart: 101,
      serverPidAfterRestart: 202,
      loadOrderId: 'load-1',
      sourceAmount: '100',
      targetAmount: '90',
      routeStatus: 'settled',
      hubBeforeRestart: frame,
      hubAfterRecovery: { ...frame, height: 11 },
      loadBeforeRestart: frame,
      loadAfterRecovery: frame,
    };
    expect(decodeCrossRecoveryReport(report).hubAfterRecovery.height).toBe(11);
    expect(() =>
      decodeCrossRecoveryReport({
        ...report,
        hubAfterRecovery: { ...frame, height: 9 },
      }),
    ).toThrow('PRODUCTION_SWAP_LOAD_CROSS_RECOVERY_HEIGHT_REGRESSION');
    expect(() => decodeCrossRecoveryReport({ ...report, sourceAmount: '1e2' })).toThrow(
      'PRODUCTION_SWAP_LOAD_CROSS_RECOVERY_SOURCE_AMOUNT_INVALID',
    );
    expect(() => decodeCrossRecoveryReport({ ...report, serverPidAfterRestart: 101 })).toThrow(
      'PRODUCTION_SWAP_LOAD_CROSS_RECOVERY_PROCESS_NOT_REPLACED',
    );
    expect(() =>
      decodeCrossRecoveryReport({
        ...report,
        loadAfterRecovery: { ...frame, canonicalStateHash: `0x${'ef'.repeat(32)}` },
      }),
    ).toThrow('PRODUCTION_SWAP_LOAD_CROSS_RECOVERY_SAME_HEIGHT_FORK');
  });
});

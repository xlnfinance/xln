import { expect, test } from 'bun:test';
import { createRuntimeImportController } from '../../../orchestrator/replica-import/runtime-import-controller';
import type { AggregatedHealth, HubChild, MarketMakerChild } from '../../../orchestrator/orchestrator-types';

const hub = (name: string, engine: HubChild['engine'], runtimeId: string): HubChild => ({
  name,
  engine,
  apiPort: name === 'H1' ? 20012 : 20013,
  publicPort: name === 'H1' ? 20016 : 20013,
  authSeed: `${name}-auth`,
  lastInfo: { runtimeId },
  lastHealth: null,
} as unknown as HubChild);

test('runtime import advertises only children that implement the admin adapter', () => {
  const controller = createRuntimeImportController({
    publicWsBaseUrl: 'ws://127.0.0.1:20011',
    walletUrl: 'http://127.0.0.1:20004',
    custodyDaemonPort: 20015,
    custodyPublicRpcUrl: '',
    manifestPath: '/tmp/runtime-import-controller-test.json',
    exposeUrl: false,
    tokenTtlMs: 60_000,
    refreshMarginMs: 1_000,
    hubChildren: [
      hub('H1', 'rust', `0x${'11'.repeat(20)}`),
      hub('H2', 'typescript', `0x${'22'.repeat(20)}`),
    ],
    marketMakerChild: { lastInfo: null, lastHealth: null } as unknown as MarketMakerChild,
    getActiveResetOptions: () => ({ enableMarketMaker: false, enableCustody: false }),
    getCustodySupport: () => null,
    buildAggregatedHealthResponse: async () => ({} as AggregatedHealth),
    warnRefreshFailed: () => undefined,
  });

  const manifest = controller.buildRuntimeImportManifest();

  expect(manifest?.entries.map(({ label, engine, wsUrl }) => ({ label, engine, wsUrl }))).toEqual([
    { label: 'H2', engine: 'ts', wsUrl: 'ws://127.0.0.1:20013/rpc' },
  ]);
});

import { expect, test } from 'bun:test';

import type { JAdapter } from '../../../jurisdiction/adapter/types';
import { waitForJurisdictionAdapter } from '../../../orchestrator/mm-node';
import type { RuntimeReplica } from '../../../runtime/types';
import type { JReplica } from '../../../types/jurisdiction-runtime';
import { attachLiveJAdapter } from '../../../runtime/jurisdiction/live-jadapters';

const adapter = (chainId: number, depository: string): JAdapter => ({
  chainId,
  addresses: { depository },
} as JAdapter);

const replica = (name: string, chainId: number, depository: string): JReplica => ({
  name,
  chainId,
  depositoryAddress: depository,
  entityProviderAddress: `0x${'33'.repeat(20)}`,
  contracts: {
    account: `0x${'11'.repeat(20)}`,
    depository,
    entityProvider: `0x${'33'.repeat(20)}`,
    deltaTransformer: `0x${'44'.repeat(20)}`,
  },
  rpcs: [`http://127.0.0.1:${chainId}`],
  mempool: [],
  blockNumber: 0n,
  stateRoot: null,
  blockDelayMs: 300,
  lastBlockTimestamp: 0,
  position: { x: 0, y: 0, z: 0 },
} as JReplica);

const tronConfig = (depository: string) => ({
  name: 'Tron',
  chainId: 31_338,
  rpc: 'http://127.0.0.1:31338',
  contracts: {
    account: `0x${'11'.repeat(20)}`,
    depository,
    entityProvider: `0x${'33'.repeat(20)}`,
    deltaTransformer: `0x${'44'.repeat(20)}`,
  },
});

test('market maker readiness returns the requested jurisdiction adapter, not the active primary', async () => {
  const arrakisDepository = `0x${'aa'.repeat(20)}`;
  const tronDepository = `0x${'bb'.repeat(20)}`;
  const arrakisAdapter = adapter(31_337, arrakisDepository);
  const tronAdapter = adapter(31_338, tronDepository);
  const env = {
    activeJurisdiction: 'arrakis',
    state: {
  jReplicas: new Map([
        ['arrakis', replica('arrakis', 31_337, arrakisDepository)],
        ['Tron', replica('Tron', 31_338, tronDepository)],
      ]),
    },
  } as RuntimeReplica;
  attachLiveJAdapter(env, 'arrakis', arrakisAdapter);
  attachLiveJAdapter(env, 'Tron', tronAdapter);

  expect(await waitForJurisdictionAdapter(env, tronConfig(tronDepository), 1)).toBe(tronAdapter);
});

test('market maker readiness fails closed on duplicate live replicas for one stack', async () => {
  const depository = `0x${'bb'.repeat(20)}`;
  const first = adapter(31_338, depository);
  const second = adapter(31_338, depository);
  const env = {
    activeJurisdiction: 'arrakis',
    state: {
  jReplicas: new Map([
        ['Tron', replica('Tron', 31_338, depository)],
        ['duplicate', replica('duplicate', 31_338, depository)],
      ]),
    },
  } as RuntimeReplica;
  attachLiveJAdapter(env, 'Tron', first);
  attachLiveJAdapter(env, 'duplicate', second);

  await expect(waitForJurisdictionAdapter(env, tronConfig(depository), 1))
    .rejects.toThrow('JURISDICTION_ADAPTER_AMBIGUOUS');
});

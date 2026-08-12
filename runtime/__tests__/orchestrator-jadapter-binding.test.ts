import { describe, expect, test } from 'bun:test';

import type { JAdapter, JAdapterAddresses } from '../jurisdiction/adapter/types';
import { ensureJurisdictionReplica } from '../orchestrator/market-maker/node/mm-node-core';
import { createEmptyEnv } from '../runtime';
import { getLiveJAdapter } from '../runtime/jurisdiction/live-jadapters';
import { createTestJReplica } from './helpers/j-replica';

const address = (byte: string): string => `0x${byte.repeat(20)}`;
const addresses: JAdapterAddresses = {
  account: address('11'),
  depository: address('12'),
  entityProvider: address('13'),
  deltaTransformer: address('14'),
};

const adapter = (
  overrides: Partial<Pick<JAdapter, 'chainId' | 'addresses'>> = {},
): JAdapter => ({
  mode: 'rpc',
  chainId: 31_337,
  addresses,
  ...overrides,
}) as unknown as JAdapter;

const fixture = () => {
  const env = createEmptyEnv('orchestrator-jadapter-binding');
  const name = 'canonical-rpc';
  env.activeJurisdiction = name;
  const replica = createTestJReplica({
    name,
    chainId: 31_337,
    rpcs: ['http://127.0.0.1:8545/'],
    depositoryAddress: addresses.depository,
    entityProviderAddress: addresses.entityProvider,
    contracts: { ...addresses },
  });
  env.state.jReplicas.set(name, replica);
  return { env, name, replica };
};

describe('orchestrator J-adapter binding', () => {
  test('attaches an exact live adapter without changing committed J state', () => {
    const { env, name, replica } = fixture();
    const before = structuredClone(replica);
    const live = adapter();

    ensureJurisdictionReplica(env, live, 'http://127.0.0.1:8545');

    expect(replica).toEqual(before);
    expect(getLiveJAdapter(env, name)).toBe(live);
  });

  test('rejects chain and RPC rebinding without changing committed J state', () => {
    for (const [live, rpcUrl] of [
      [adapter({ chainId: 1 }), 'http://127.0.0.1:8545'],
      [adapter(), 'http://127.0.0.1:9545'],
    ] as const) {
      const { env, name, replica } = fixture();
      const before = structuredClone(replica);
      expect(() => ensureJurisdictionReplica(env, live, rpcUrl))
        .toThrow('MM_JADAPTER_IDENTITY_MISMATCH');
      expect(replica).toEqual(before);
      expect(getLiveJAdapter(env, name)).toBeUndefined();
    }
  });

  test('rejects contract rebinding without changing committed J state', () => {
    const { env, name, replica } = fixture();
    const before = structuredClone(replica);
    const live = adapter({ addresses: { ...addresses, account: address('21') } });

    expect(() => ensureJurisdictionReplica(env, live, 'http://127.0.0.1:8545'))
      .toThrow('J_STACK_CONNECTED_ADDRESS_MISMATCH');
    expect(replica).toEqual(before);
    expect(getLiveJAdapter(env, name)).toBeUndefined();
  });
});

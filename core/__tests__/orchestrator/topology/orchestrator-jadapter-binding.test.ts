import { describe, expect, test } from 'bun:test';
import { ensureJurisdictionReplica } from '../../../orchestrator/market-maker/node/mm-node-core';
import { createEmptyEnv } from '../../../runtime';
import { getLiveJAdapter } from '../../../runtime/j-submit/live-jadapters';
import { ensureJAdapter } from '../../../scenarios/harness/boot';
import { createTestJReplica } from '../../helpers/j-replica';

const fixture = async () => {
  const live = await ensureJAdapter(undefined, 'browservm', { chainId: 31_337 });
  const env = createEmptyEnv('orchestrator-jadapter-binding');
  const name = 'canonical-browservm';
  env.activeJurisdiction = name;
  const replica = createTestJReplica({
    name, chainId: live.chainId, rpcs: ['browservm://canonical/'],
    depositoryAddress: live.addresses.depository,
    entityProviderAddress: live.addresses.entityProvider,
    contracts: { ...live.addresses },
  });
  env.state.jReplicas.set(name, replica);
  return { env, name, replica, live };
};

describe('orchestrator J-adapter binding', () => {
  test('attaches an exact live adapter without changing committed J state', async () => {
    const { env, name, replica, live } = await fixture();
    try {
      const before = structuredClone(replica);
      ensureJurisdictionReplica(env, live, 'browservm://canonical/');
      expect(replica).toEqual(before);
      expect(getLiveJAdapter(env, name)).toBe(live);
    } finally { await live.close(); }
  });

  test('rejects chain and RPC rebinding without changing committed J state', async () => {
    for (const mismatch of ['chain', 'rpc']) {
      const { env, name, replica, live } = await fixture();
      try {
        if (mismatch === 'chain') replica.chainId = 1;
        const before = structuredClone(replica);
        const rpcUrl = mismatch === 'rpc' ? 'browservm://different/' : 'browservm://canonical/';
        expect(() => ensureJurisdictionReplica(env, live, rpcUrl)).toThrow('MM_JADAPTER_IDENTITY_MISMATCH');
        expect(replica).toEqual(before);
        expect(getLiveJAdapter(env, name)).toBeUndefined();
      } finally { await live.close(); }
    }
  });

  test('rejects contract rebinding without changing committed J state', async () => {
    const { env, name, replica, live } = await fixture();
    try {
      replica.contracts.account = `0x${'21'.repeat(20)}`;
      const before = structuredClone(replica);
      expect(() => ensureJurisdictionReplica(env, live, 'browservm://canonical/'))
        .toThrow('J_STACK_CONNECTED_ADDRESS_MISMATCH');
      expect(replica).toEqual(before);
      expect(getLiveJAdapter(env, name)).toBeUndefined();
    } finally { await live.close(); }
  });
});

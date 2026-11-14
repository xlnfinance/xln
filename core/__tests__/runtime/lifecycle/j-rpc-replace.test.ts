import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { createEmptyEnv } from '../../../runtime';
import { getLiveJAdapter } from '../../../runtime/j-submit/live-jadapters';
import { replaceJurisdictionRpc } from '../../../runtime/recovery/j-rpc-replace';
import { connectVerifiedJAdapter } from '../../../runtime/recovery/j-adapter-restore';
import { createTestJReplica } from '../../helpers/j-replica';
import { startRuntimeAdapterRpc } from '../../helpers/runtime-jadapter';

const contracts = {
  depository: `0x${'41'.repeat(20)}`,
  entityProvider: `0x${'42'.repeat(20)}`,
  account: `0x${'43'.repeat(20)}`,
  deltaTransformer: `0x${'44'.repeat(20)}`,
};

const envWith = (rpcs: string[], chainId = 31_337) => {
  const env = createEmptyEnv('j-rpc-replace');
  env.quietRuntimeLogs = true;
  env.state.jReplicas.set(
    'Testnet',
    createTestJReplica({
      name: 'Testnet',
      chainId,
      rpcs,
      contracts,
      entityProviderDeploymentBlock: 1,
    }),
  );
  return env;
};

// An owner whose Hub-published RPC died must reach the same chain elsewhere,
// but a replacement endpoint never changes committed state and never retires
// the current connection unless it is verified first.
describe('replaceJurisdictionRpc', () => {
  test('rejects an unknown jurisdiction and a BrowserVM jurisdiction', async () => {
    await expect(
      replaceJurisdictionRpc(envWith(['http://127.0.0.1:1/rpc']), 'Other', 'http://127.0.0.1:2'),
    ).rejects.toThrow('J_RPC_REPLACE_JURISDICTION_MISSING:Other');
    await expect(replaceJurisdictionRpc(envWith([]), 'Testnet', 'http://127.0.0.1:2')).rejects.toThrow(
      'J_RPC_REPLACE_NOT_RPC_BACKED:Testnet',
    );
  });

  test('refuses a native TRON jurisdiction instead of implying protection', async () => {
    const env = envWith(['http://127.0.0.1:1/rpc']);
    env.state.jReplicas.set(
      'Tron',
      createTestJReplica({
        name: 'Tron',
        chainId: 728_126_428,
        rpcs: ['http://127.0.0.1:1/rpc2'],
        contracts,
        watcherReceiptCommitment: 'tron-rpc-attested',
      }),
    );
    await expect(replaceJurisdictionRpc(env, 'Tron', 'http://127.0.0.1:2')).rejects.toThrow(
      'J_RPC_REPLACE_TRON_UNSUPPORTED:Tron',
    );
  });

  test('rejects non-HTTP and credential-bearing URLs before touching live bindings', async () => {
    const env = envWith(['http://127.0.0.1:1/rpc']);
    for (const url of ['ws://127.0.0.1:2', 'http://user:pass@127.0.0.1:2', 'not a url']) {
      await expect(replaceJurisdictionRpc(env, 'Testnet', url)).rejects.toThrow('J_RPC_REPLACE_URL_INVALID');
    }
    expect(env.infrastructure?.trustedJurisdictionRpcUrls).toBeUndefined();
  });

  test('an unreachable endpoint leaves bindings, adapter and committed rpcs unchanged', async () => {
    const env = envWith(['http://127.0.0.1:1/rpc']);
    await expect(replaceJurisdictionRpc(env, 'Testnet', 'http://127.0.0.1:9/')).rejects.toThrow();
    expect(env.infrastructure?.trustedJurisdictionRpcUrls).toBeUndefined();
    expect(getLiveJAdapter(env, 'Testnet')).toBeUndefined();
    expect(env.state.jReplicas.get('Testnet')?.rpcs).toEqual(['http://127.0.0.1:1/rpc']);
  });
});

describe('wallet restore during an RPC outage', () => {
  let rpc: Awaited<ReturnType<typeof startRuntimeAdapterRpc>>;
  beforeAll(async () => {
    rpc = await startRuntimeAdapterRpc();
  });
  afterAll(async () => {
    await rpc.close();
  });

  const restore = async (env: ReturnType<typeof envWith>) => {
    const replica = env.state.jReplicas.get('Testnet');
    if (!replica) throw new Error('TEST_J_REPLICA_MISSING');
    return connectVerifiedJAdapter(env, 'Testnet', replica, {
      attempts: 1,
      skipOperatorTransport: true,
      tolerateUnreachable: true,
    });
  };

  test.each([31_338, 503, 504])('a reachable wrong chain %i remains a hard failure', async chainId => {
    const env = envWith([rpc.rpcUrl], chainId);
    await expect(restore(env)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('chainId mismatch'),
    });
    expect(getLiveJAdapter(env, 'Testnet')).toBeUndefined();
    expect(env.state.jReplicas.get('Testnet')?.rpcs).toEqual([rpc.rpcUrl]);
  });

  test('reachable addresses without contract code remain a hard failure', async () => {
    await expect(restore(envWith([rpc.rpcUrl]))).rejects.toThrow('contract addresses have no code');
  });

  test('an unavailable transport leaves the restored chain without a live adapter', async () => {
    const env = envWith(['http://127.0.0.1:9/']);
    expect(await restore(env)).toBeNull();
    expect(getLiveJAdapter(env, 'Testnet')).toBeUndefined();
    expect(env.state.jReplicas.get('Testnet')?.rpcs).toEqual(['http://127.0.0.1:9/']);
  });
});

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { JsonRpcProvider } from 'ethers';
import { createJAdapter, DEFAULT_PRIVATE_KEY, type JAdapter } from '../../../jurisdiction/adapter';
import { getJurisdictionIdentityRef } from '../../../jurisdiction/machine/jurisdiction-runtime';
import { createEmptyEnv } from '../../../runtime';
import { getLiveJAdapter } from '../../../runtime/j-submit/live-jadapters';
import { replaceJurisdictionRpc } from '../../../runtime/recovery/j-rpc-replace';
import { computeCanonicalStateHashFromEnv } from '../../../storage/canonical-hash';
import { createTestJReplica } from '../../helpers/j-replica';
import { startRuntimeAdapterRpc } from '../../helpers/runtime-jadapter';

// Both endpoints run real Anvil nodes and the current deployed XLN contracts.
// Pausing ONLY this fixture's child controls the RPC response order, without
// replacing a provider, contract, signature or financial result.
let slow: Awaited<ReturnType<typeof startRuntimeAdapterRpc>>;
let fast: Awaited<ReturnType<typeof startRuntimeAdapterRpc>>;
let deployed: JAdapter;
const opened: JAdapter[] = [];
beforeAll(async () => {
  slow = await startRuntimeAdapterRpc();
  fast = await startRuntimeAdapterRpc();
  deployed = await createJAdapter({
    mode: 'rpc',
    chainId: 31337,
    rpcUrl: fast.rpcUrl,
    privateKey: DEFAULT_PRIVATE_KEY,
  });
  await deployed.deployStack();
  const a = new JsonRpcProvider(slow.rpcUrl);
  const b = new JsonRpcProvider(fast.rpcUrl);
  try {
    await a.send('anvil_loadState', [await b.send('anvil_dumpState', [])]);
  } finally {
    a.destroy();
    b.destroy();
  }
}, 60_000);
afterAll(async () => {
  slow?.child.kill('SIGCONT');
  for (const adapter of opened) await adapter.close();
  await deployed?.close();
  await slow?.close();
  await fast?.close();
});

const fixture = (wrongChain = false) => {
  const env = createEmptyEnv('rpc-replacement-race');
  env.quietRuntimeLogs = true;
  const contracts = {
    depository: deployed.addresses.depository,
    entityProvider: deployed.addresses.entityProvider,
    account: deployed.addresses.account,
    deltaTransformer: deployed.addresses.deltaTransformer,
  };
  for (const name of wrongChain ? ['A', 'B'] : ['A'])
    env.state.jReplicas.set(
      name,
      createTestJReplica({
        name,
        chainId: name === 'A' && wrongChain ? 31338 : 31337,
        rpcs: ['http://127.0.0.1:9/'],
        contracts,
        entityProviderDeploymentBlock: deployed.entityProviderDeploymentBlock,
      }),
    );
  return env;
};
const remember = (env: ReturnType<typeof fixture>, name: string) => {
  const adapter = getLiveJAdapter(env, name);
  if (adapter) opened.push(adapter);
};
const binding = (env: ReturnType<typeof fixture>, name: string) =>
  env.infrastructure?.trustedJurisdictionRpcUrls?.get(
    getJurisdictionIdentityRef(env.state.jReplicas.get(name)).toLowerCase(),
  );

test('a late failed repair cannot roll back another jurisdiction accepted RPC', async () => {
  const env = fixture(true);
  const root = computeCanonicalStateHashFromEnv(env);
  slow.child.kill('SIGSTOP');
  const pending = replaceJurisdictionRpc(env, 'A', slow.rpcUrl).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await replaceJurisdictionRpc(env, 'B', fast.rpcUrl);
    slow.child.kill('SIGCONT');
    expect(await pending).toBeInstanceOf(Error);
    expect(binding(env, 'B')).toBe(new URL(fast.rpcUrl).href);
    expect(getLiveJAdapter(env, 'B')).toBeDefined();
    expect(computeCanonicalStateHashFromEnv(env)).toBe(root);
  } finally {
    slow.child.kill('SIGCONT');
    await pending;
    remember(env, 'B');
  }
}, 60_000);

test('a late older success cannot replace the newer verified endpoint for the same jurisdiction', async () => {
  const env = fixture();
  slow.child.kill('SIGSTOP');
  const pending = replaceJurisdictionRpc(env, 'A', slow.rpcUrl).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await replaceJurisdictionRpc(env, 'A', fast.rpcUrl);
    const accepted = getLiveJAdapter(env, 'A');
    slow.child.kill('SIGCONT');
    expect(await pending).toMatchObject({ message: 'J_RPC_REPLACE_SUPERSEDED:A' });
    expect(getLiveJAdapter(env, 'A')).toBe(accepted);
    expect(binding(env, 'A')).toBe(new URL(fast.rpcUrl).href);
  } finally {
    slow.child.kill('SIGCONT');
    await pending;
    remember(env, 'A');
  }
}, 60_000);

test('a repair that loses its wallet session cannot attach a capability after lock', async () => {
  const env = fixture();
  let owns = true;
  slow.child.kill('SIGSTOP');
  const pending = replaceJurisdictionRpc(env, 'A', slow.rpcUrl, { owns: () => owns }).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    owns = false;
    slow.child.kill('SIGCONT');
    expect(await pending).toMatchObject({ message: 'J_RPC_REPLACE_CANCELLED:A' });
    expect(getLiveJAdapter(env, 'A')).toBeUndefined();
    expect(env.infrastructure?.trustedJurisdictionRpcUrls).toBeUndefined();
  } finally {
    slow.child.kill('SIGCONT');
    await pending;
    remember(env, 'A');
  }
}, 60_000);

test('a later failed endpoint does not cancel a valid older repair still verifying', async () => {
  const env = fixture();
  slow.child.kill('SIGSTOP');
  const pending = replaceJurisdictionRpc(env, 'A', slow.rpcUrl).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await expect(replaceJurisdictionRpc(env, 'A', 'http://127.0.0.1:9/')).rejects.toThrow();
    slow.child.kill('SIGCONT');
    expect(await pending).toBeNull();
    expect(binding(env, 'A')).toBe(new URL(slow.rpcUrl).href);
    expect(getLiveJAdapter(env, 'A')).toBeDefined();
  } finally {
    slow.child.kill('SIGCONT');
    await pending;
    remember(env, 'A');
  }
}, 60_000);

test('a failed new endpoint leaves the accepted live adapter and binding intact', async () => {
  const env = fixture();
  try {
    await replaceJurisdictionRpc(env, 'A', fast.rpcUrl);
    const accepted = getLiveJAdapter(env, 'A');
    const root = computeCanonicalStateHashFromEnv(env);
    await expect(replaceJurisdictionRpc(env, 'A', 'http://127.0.0.1:9/')).rejects.toThrow();
    expect(getLiveJAdapter(env, 'A')).toBe(accepted);
    expect(binding(env, 'A')).toBe(new URL(fast.rpcUrl).href);
    expect(computeCanonicalStateHashFromEnv(env)).toBe(root);
  } finally {
    remember(env, 'A');
  }
}, 60_000);

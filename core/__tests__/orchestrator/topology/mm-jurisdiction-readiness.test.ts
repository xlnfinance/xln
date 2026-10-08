import { expect, test } from 'bun:test';
import { waitForJurisdictionAdapter } from '../../../orchestrator/mm-node';
import { createEmptyEnv } from '../../../runtime';
import { bindScenarioJReplica, createJReplica, ensureJAdapter } from '../../../scenarios/harness/boot';
import { createBrowserVMAdapter } from '../../../jurisdiction/adapter/browservm/browservm';
import type { JAdapter } from '../../../jurisdiction/adapter/types';

const config = (adapter: JAdapter) => ({
  name: 'secondary', chainId: adapter.chainId, rpc: 'browservm://', contracts: { ...adapter.addresses },
});

test('market maker readiness returns the requested jurisdiction adapter, not the active primary', async () => {
  const env = createEmptyEnv('mm-readiness-domains');
  const primary = await ensureJAdapter(undefined, 'browservm', { chainId: 31_337 });
  const secondary = await ensureJAdapter(undefined, 'browservm', { chainId: 31_338 });
  try {
    bindScenarioJReplica(env, createJReplica(env, 'primary', primary.addresses.depository), primary);
    bindScenarioJReplica(env, createJReplica(env, 'secondary', secondary.addresses.depository), secondary);
    env.activeJurisdiction = 'primary';
    expect(await waitForJurisdictionAdapter(env, config(secondary), 1)).toBe(secondary);
  } finally { await secondary.close(); await primary.close(); }
});

test('market maker readiness fails closed on duplicate live replicas for one stack', async () => {
  const env = createEmptyEnv('mm-readiness-duplicate');
  const live = await ensureJAdapter(undefined, 'browservm', { chainId: 31_338 });
  const vm = live.getBrowserVM();
  if (!vm) throw new Error('MM_READINESS_VM_MISSING');
  const duplicate = await createBrowserVMAdapter({ mode: 'browservm', chainId: live.chainId },
    live.provider, live.signer, vm);
  try {
    bindScenarioJReplica(env, createJReplica(env, 'secondary', live.addresses.depository), live);
    bindScenarioJReplica(env, createJReplica(env, 'duplicate', live.addresses.depository), duplicate);
    await expect(waitForJurisdictionAdapter(env, config(live), 1))
      .rejects.toThrow('JURISDICTION_ADAPTER_AMBIGUOUS');
  } finally { await duplicate.close(); await live.close(); }
});

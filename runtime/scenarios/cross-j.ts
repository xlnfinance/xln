/**
 * Cross-Jurisdiction Swap Scenario
 *
 * The repo had no cross-jurisdiction scenario at all, which is why this area
 * only ever failed in the e2e mesh — where hub-side logs are not captured and
 * every defect had to be excavated from artifacts one at a time.
 *
 * Mirrors the e2e cross-swap topology in one process, on two local anvils:
 *
 *   CrossJ Source            CrossJ Target
 *   ─────────────            ─────────────
 *   MM  <-> HubSrc           HubTgt <-> MMt
 *
 * A cross-j route moves value from (MM, HubSrc) on the source stack to
 * (HubTgt, MMt) on the target stack. The scenario asserts the route actually
 * materialises into account-level offers rather than merely being accepted.
 *
 * INCOMPLETE — deliberately not in any parallel set yet. It reaches the real
 * submission path and stops at the topology contract, which
 * `resolveCrossJurisdictionRuntimeTopology` states exactly:
 *
 *   - both users must share one Runtime,
 *   - both hubs must share one Runtime,
 *   - and those two Runtimes must differ.
 *
 * So the finished form needs two Runtimes in the process (a user Runtime
 * holding MM + MMt and a hub Runtime holding HubSrc + HubTgt), each spanning
 * both jurisdictions — the mesh's shape. Everything up to that point works and
 * has already paid for itself: it surfaced the ambiguous-jurisdiction watcher
 * failure, the single-slot anvil that killed the first chain, and the fact that
 * numbered entity ids collide across EntityProviders.
 */

import type { RuntimeReplica } from '../runtime/types';
import { generateLazyEntityId } from '../entity/factory';
import {
  bootScenario,
  fundEntities,
  ensureJAdapter,
  createJReplica,
  bindScenarioJReplica,
  createJurisdictionConfig,
  resolveScenarioBoardSigner,
} from './boot';
import {
  getProcess,
  converge,
  commitRuntimeInput,
  processJEvents,
  assert,
  findReplica,
  usd,
} from './helpers';

const USDC = 1;
const WETH = 2;

type Registered = { id: string; signer: string; name: string };

/** A second jurisdiction needs its own endpoint; the boot path autostarts anvil there. */
const reserveFreeLocalPort = async (): Promise<number> => {
  const { createServer } = await import('node:net');
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => rejectPort(new Error('CROSS_J_SCENARIO_PORT_RESERVE_FAILED')));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
};

export async function crossJ(_existingEnv?: RuntimeReplica): Promise<RuntimeReplica> {
  const process = await getProcess();

  console.log('\n🌉 Cross-jurisdiction swap scenario\n');

  // ── Source stack ──────────────────────────────────────────────────────────
  const { env, jadapter: sourceAdapter, jurisdiction: sourceJurisdiction } = await bootScenario({
    name: 'cross-j',
    signerIds: ['1', '2', '3', '4'],
    seed: 'cross-j-deterministic',
    jurisdictionName: 'CrossJ Source',
    ...(_existingEnv?.scenarioJAdapterMode ? { mode: _existingEnv.scenarioJAdapterMode } : {}),
  });
  env.quietRuntimeLogs = true;

  // ── Target stack, in the SAME env ─────────────────────────────────────────
  // One Runtime owning entities in two jurisdictions is exactly the mesh's MM
  // shape (an entity per jurisdiction, one process). `sameJurisdiction` is
  // decided on jurisdiction NAME, so both stacks may share a chain id.
  const targetPort = await reserveFreeLocalPort();
  const targetRpcUrl = `http://127.0.0.1:${targetPort}`;
  // Distinct chain id is mandatory, not cosmetic: a jurisdiction is identified
  // by (chainId, depository), and two fresh anvils deploy identical addresses.
  const TARGET_CHAIN_ID = 31338;
  const targetAdapter = await ensureJAdapter(env, sourceAdapter.mode, {
    deployStack: true,
    rpcUrl: targetRpcUrl,
    chainId: TARGET_CHAIN_ID,
  });
  bindScenarioJReplica(
    env,
    createJReplica(env, 'CrossJ Target', targetAdapter.addresses.depository, { x: 400, y: 600, z: 0 }),
    targetAdapter,
  );
  targetAdapter.startWatching(env);
  const targetJurisdiction = createJurisdictionConfig(
    'CrossJ Target',
    targetAdapter.addresses.depository,
    targetAdapter.addresses.entityProvider,
    targetRpcUrl,
    Number(targetAdapter.chainId || 31337),
  );
  console.log(`  ✅ Two jurisdictions up: source + target (${targetRpcUrl})\n`);

  // ── Entities ──────────────────────────────────────────────────────────────
  // Lazy (board-hash) ids, not numbered ones. A numbered id is only unique
  // inside one EntityProvider: both chains hand out 2, 3, … so the target
  // entities would land on the exact bytes32 already bound to the source
  // jurisdiction and the Runtime rejects it with ENTITY_JURISDICTION_CONFLICT.
  // The mesh's hub entities are hashes for the same reason.
  const createEntity = async (
    signerSeed: string,
    name: string,
    jurisdiction: typeof sourceJurisdiction,
    position: { x: number; y: number; z: number },
  ): Promise<Registered> => {
    const signer = resolveScenarioBoardSigner(env, signerSeed);
    const id = generateLazyEntityId([signer], 1n, env).toLowerCase();
    await commitRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica' as const,
        entityId: id,
        signerId: signer,
        data: {
          isProposer: true,
          position,
          config: {
            mode: 'proposer-based' as const,
            threshold: 1n,
            validators: [signer],
            shares: { [signer]: 1n },
            jurisdiction,
          },
        },
      }],
      entityInputs: [],
    });
    console.log(`  ✅ ${name} ${id.slice(-6)} on ${jurisdiction.name}`);
    return { id, signer, name };
  };

  const mm = await createEntity('1', 'MM', sourceJurisdiction, { x: -40, y: -30, z: 0 });
  const hubSrc = await createEntity('2', 'HubSrc', sourceJurisdiction, { x: -10, y: -30, z: 0 });
  const hubTgt = await createEntity('3', 'HubTgt', targetJurisdiction, { x: 10, y: -30, z: 0 });
  const mmt = await createEntity('4', 'MMt', targetJurisdiction, { x: 40, y: -30, z: 0 });
  await processJEvents(env);
  await converge(env);

  await fundEntities(env, sourceAdapter, [
    { id: mm.id, tokenId: USDC, amount: usd(2_000_000) },
    { id: hubSrc.id, tokenId: USDC, amount: usd(2_000_000) },
  ]);
  await fundEntities(env, targetAdapter, [
    { id: hubTgt.id, tokenId: WETH, amount: usd(2_000_000) },
    { id: mmt.id, tokenId: WETH, amount: usd(2_000_000) },
  ]);

  // ── Bilateral accounts, one per stack ─────────────────────────────────────
  await process(env, [{
    entityId: mm.id,
    signerId: mm.signer,
    entityTxs: [{
      type: 'openAccount',
      data: { targetEntityId: hubSrc.id, tokenId: USDC, creditAmount: usd(100_000) },
    }],
  }]);
  await converge(env);
  await process(env, [{
    entityId: mmt.id,
    signerId: mmt.signer,
    entityTxs: [{
      type: 'openAccount',
      data: { targetEntityId: hubTgt.id, tokenId: WETH, creditAmount: usd(100_000) },
    }],
  }]);
  await converge(env);

  const [, mmReplica] = findReplica(env, mm.id);
  const [, mmtReplica] = findReplica(env, mmt.id);
  assert(mmReplica.state.accounts.has(hubSrc.id), 'MM-HubSrc account exists', env);
  assert(mmtReplica.state.accounts.has(hubTgt.id), 'MMt-HubTgt account exists', env);
  console.log('  ✅ Bilateral accounts open on both stacks\n');

  // ── The cross-jurisdiction swap ───────────────────────────────────────────
  // Driven through the Runtime with `process`, exactly like every other
  // scenario. The command API (`submitCrossJurisdictionSwap`) is the entry
  // point for a live node running the event loop; it is fenced on lifecycle
  // phase and persistence, and forcing those flags by hand would only prove the
  // forcing worked. What it actually does is build the route and enqueue one
  // `prepareCrossJurisdictionSwap` per user sibling — so the scenario builds
  // the same route and enqueues the same two entity txs, and the Runtime
  // applies them through the real path.
  const { buildCrossJurisdictionSwapSubmission } = await import('../runtime/jurisdiction-api');
  const orderId = 'cross-j-scenario-1';
  const { route } = buildCrossJurisdictionSwapSubmission(env, {
    orderId,
    sourceUserEntityId: mm.id,
    sourceHubEntityId: hubSrc.id,
    targetHubEntityId: hubTgt.id,
    targetUserEntityId: mmt.id,
    sourceTokenId: USDC,
    sourceAmount: usd(1_000),
    targetTokenId: WETH,
    targetAmount: usd(1_000),
    sourceUserSignerId: mm.signer,
    sourceHubSignerId: hubSrc.signer,
    targetHubSignerId: hubTgt.signer,
    targetUserSignerId: mmt.signer,
  });
  // Target sibling first, mirroring the command API: the source authorization
  // may emit the certified source-user -> source-hub command, and no value may
  // cross the later Account boundary unless both records exist.
  await process(env, [
    {
      entityId: mmt.id,
      signerId: mmt.signer,
      entityTxs: [{ type: 'prepareCrossJurisdictionSwap', data: { route } }],
    },
    {
      entityId: mm.id,
      signerId: mm.signer,
      entityTxs: [{ type: 'prepareCrossJurisdictionSwap', data: { route } }],
    },
  ]);
  console.log(`  → submitted cross-j intent ${orderId}`);

  await converge(env, 40);
  await processJEvents(env);
  await converge(env, 40);

  // ── Assertions: the route must MATERIALISE, not merely be accepted ────────
  const [, hubSrcReplica] = findReplica(env, hubSrc.id);
  const [, hubTgtReplica] = findReplica(env, hubTgt.id);
  const sourceRoute = hubSrcReplica.state.crossJurisdictionSwaps?.get(orderId);
  const targetRoute = hubTgtReplica.state.crossJurisdictionSwaps?.get(orderId);

  console.log(`  source hub route: ${sourceRoute ? sourceRoute.status : 'ABSENT'}`);
  console.log(`  target hub route: ${targetRoute ? targetRoute.status : 'ABSENT'}`);
  console.log(
    `  MM authorizations: ${mmReplica.state.crossJurisdictionAuthorizations?.size ?? 0}, ` +
    `MMt authorizations: ${mmtReplica.state.crossJurisdictionAuthorizations?.size ?? 0}`,
  );

  assert(sourceRoute, 'source hub registered the cross-j route', env);
  assert(targetRoute, 'target hub registered the cross-j route', env);
  assert(
    Boolean(sourceRoute?.sourcePull),
    'source leg materialised a pull rather than staying at intent',
    env,
  );
  assert(
    Boolean(targetRoute?.targetPull),
    'target leg materialised a pull rather than staying at intent',
    env,
  );

  console.log('\n✅ cross-j scenario complete\n');
  return env;
}

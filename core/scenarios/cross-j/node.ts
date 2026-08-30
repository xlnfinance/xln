/**
 * Cross-j P2P node — one Runtime per process.
 *
 *   --role hubs  : HubSrc + HubTgt, deploys both stacks, hosts the relay
 *   --role users : MM + MMt, attaches to published stacks, submits the swap
 *
 * Topology: users share Runtime A, hubs share Runtime B, A ≠ B.
 *
 * Setup phases (never rush orders ahead of credit; fail-fast after each):
 *   1. ACCOUNTS_OPEN  — bilateral open frames committed + idle
 *   2. CREDIT_READY   — hub→MM credit committed, limits verified, idle
 *   3. ORDERS         — MM prepareCrossJurisdictionSwap only after (2)
 *   4. ORDERBOOK      — resting route + same-j offer + cross-j book + pulls
 *   5. SETTLED        — clear/cancel complete
 */

import fs from 'node:fs';
import { defaultAccountDisputeConfigForParties } from '../../account/config/dispute-config';
import net from 'node:net';
import path from 'node:path';

import {
  createLazyEntity,
  enqueueRuntimeInput,
  generateLazyEntityId,
  main,
  processRuntime,
  startP2P,
  startRuntimeLoop,
} from '../../runtime.ts';
import { createHubDirectRuntimeRoute } from '../../orchestrator/hub/hub-runtime-transport';
import { startStandaloneRelayServer } from '../../network/relay/standalone-server';
import { createLocalDeliveryHandler } from '../../network/relay/local-delivery';
import { getEntityReplicaById } from '../../api/server/entities/lookup';
import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
} from '../../account/crypto';
import type { JAdapter } from '../../jurisdiction/adapter/types';
import type { JurisdictionConfig , EntityReplica } from '../../entity/types';
import type { RuntimeReplica } from '../../runtime/types';
import { readCliOption } from '../../config/cli';
import { buildCrossJurisdictionSwapSubmission } from '../../runtime/j-submit/api';
import { createTestEntityImportRuntimeTx } from '../../qa/entity-creation-fixture';
const syncScenarioClockToWall = (env: RuntimeReplica): void => {
  env.state.timestamp = Math.max(Number(env.state.timestamp || 0), Date.now());
};
import {
  bindScenarioJReplica,
  createJReplica,
  createJurisdictionConfig,
  ensureJAdapter,
} from '../harness/boot';
import { ensureLiveJAdapterForReplica } from '../../runtime/recovery/j-adapter-restore';
import { deriveDelta, isLeftEntity } from '../../account/utils';
import { DEFAULT_SPREAD_DISTRIBUTION } from '../../orderbook';
import { hasCrossJurisdictionBookOrder } from '../../orderbook/cross-j';
import type { AccountReplica } from '../../types/account';
import {
  assertAccountsOpenPhase,
  assertCreditReadyPhase,
  assertCrossJOrderbooksReady,
  assertCrossJSettled,
  defaultCrossJCreditPairs,
} from './phase-assert';

const args = globalThis.process.argv.slice(2);
const role = readCliOption(args, '--role', 'users');
const seed = readCliOption(args, '--seed', role);
const relayUrl = readCliOption(args, '--relay-url', 'ws://127.0.0.1:8787');
const seedRuntimeId = readCliOption(args, '--seed-runtime-id');
const relayPort = Number(readCliOption(args, '--relay-port', '0'));
const relayHost = readCliOption(args, '--relay-host', '127.0.0.1');
const stacksJson = readCliOption(args, '--stacks', '');
const orderId = readCliOption(args, '--order-id', 'cross-j-scenario-1');
const barrierDir = readCliOption(args, '--barrier-dir', '');

const USDC = 1;
const WETH = 2;
const DECIMALS = 18n;
const usd = (n: number) => BigInt(n) * 10n ** DECIMALS;
const usdc = (n: number) => BigInt(n) * 10n ** 6n;

type StackPub = {
  name: string;
  chainId: number;
  rpcUrl: string;
  depository: string;
  entityProvider: string;
  account: string;
  deltaTransformer: string;
  entityProviderDeploymentBlock: number;
};

type Party = { id: string; signer: string; name: string };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const reservePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('CROSS_J_NODE_PORT_RESERVE_FAILED')));
        return;
      }
      const { port } = addr;
      server.close(() => resolve(port));
    });
  });


/**
 * Account outputs travel only over authenticated direct Runtime sessions; the
 * relay carries gossip. A scenario hub therefore hosts the production hub
 * inbound route (users dial it; it answers over their session) and advertises
 * the endpoint in its profile.
 */
const startDirectIngress = async (env: RuntimeReplica): Promise<string> => {
  const port = await reservePort();
  const route = createHubDirectRuntimeRoute(env, seed, () => true, { lastSeen: null, lastError: null });
  type Socket = Parameters<typeof route.websocket.open>[0];
  Bun.serve<{ type?: string }>({
    hostname: '127.0.0.1',
    port,
    fetch(request, serverRef) {
      const upgrade = route.maybeUpgrade(request, serverRef);
      if (upgrade.handled) return upgrade.response;
      return new Response('not found', { status: 404 });
    },
    websocket: {
      maxPayloadLength: route.websocket.maxPayloadLength,
      open(ws) { route.websocket.open(ws as Socket); },
      message(ws, raw) { return route.websocket.message(ws as Socket, raw); },
      drain(ws) { route.websocket.drain(ws as Socket); },
      close(ws, code, reason) { route.websocket.close(ws as Socket, code, reason); },
    },
  });
  return `ws://127.0.0.1:${port}/ws`;
};

const registerSigner = (env: RuntimeReplica, label: string): string => {
  const seedBytes = new TextEncoder().encode(seed);
  const privateKey = deriveSignerKeySync(seedBytes, label);
  const signerId = deriveSignerAddressSync(seedBytes, label).toLowerCase();
  registerSignerKey(env, signerId, privateKey);
  return signerId;
};

const createEntity = async (
  env: RuntimeReplica,
  label: string,
  name: string,
  jurisdiction: JurisdictionConfig,
  position: { x: number; y: number; z: number },
): Promise<Party> => {
  const signer = registerSigner(env, label);
  const { config } = createLazyEntity(name, [signer], 1n, jurisdiction, env);
  const id = generateLazyEntityId([signer], 1n, env).toLowerCase();
  enqueueRuntimeInput(env, {
    runtimeTxs: [createTestEntityImportRuntimeTx(env, {
      entityId: id,
      signerId: signer,
      data: { config, isProposer: true, profileName: name, position },
    })],
    entityInputs: [],
  });
  await processRuntime(env);
  console.log(`CROSS_J_ENTITY role=${role} name=${name} id=${id.slice(-6)} j=${jurisdiction.name}`);
  return { id, signer, name };
};

const findReplica = (env: RuntimeReplica, entityId: string): EntityReplica => {
  const want = entityId.toLowerCase();
  for (const [key, replica] of env.state.eReplicas) {
    if (key.startsWith(`${want}:`)) return replica;
  }
  throw new Error(`CROSS_J_NODE_REPLICA_MISSING:${entityId}`);
};

const getAccount = (
  replica: EntityReplica,
  counterpartyId: string,
): AccountReplica | undefined =>
  [...replica.state.accounts.entries()]
    .find(([id]) => id.toLowerCase() === counterpartyId.toLowerCase())?.[1];

const localIsLeft = (account: AccountReplica): boolean =>
  isLeftEntity(account.proofHeader.fromEntity, account.proofHeader.toEntity);

const creditView = (account: AccountReplica, tokenId: number) => {
  const delta = account.state.deltas?.get(tokenId);
  return delta ? deriveDelta(delta, localIsLeft(account)) : null;
};

const accountFrameSettled = (account: AccountReplica, minHeight: number): boolean =>
  !account.pendingFrame && account.currentHeight >= minHeight && account.mempool.length === 0;

/**
 * Canonical hub enablement (orchestrator enableRouting path):
 * setHubConfig → profile.isHub (atomic ACK admission) + initOrderbookExt (book rows).
 */
const enableHub = async (env: RuntimeReplica, hub: Party): Promise<void> => {
  enqueueRuntimeInput(env, {
    runtimeTxs: [],
    entityInputs: [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [
        {
          type: 'setHubConfig',
          data: {
            matchingStrategy: 'amount',
            policyVersion: 1,
            routingFeePPM: 1,
            baseFee: 0n,
            swapTakerFeeBps: 1,
            rebalanceLiquidityFeeBps: 0n,
            rebalanceTimeoutMs: 60_000,
          },
        },
        {
          type: 'initOrderbookExt',
          data: {
            name: hub.name,
            spreadDistribution: DEFAULT_SPREAD_DISTRIBUTION,
            referenceTokenId: USDC,
            usdQuoteAuthorityEntityId: hub.id,
            minTradeSize: 10n * 10n ** DECIMALS,
            supportedPairs: ['1/2', '1/3', '2/3'],
          },
        },
      ],
    }],
  });
  await processRuntime(env);
  const state = findReplica(env, hub.id).state;
  if (state.profile.isHub !== true) throw new Error(`CROSS_J_HUB_NOT_ENABLED:${hub.name}`);
  if (!state.orderbookExt) throw new Error(`CROSS_J_HUB_ORDERBOOK_MISSING:${hub.name}`);
};

const waitUntil = async (
  label: string,
  pred: () => boolean | Promise<boolean>,
  env: RuntimeReplica,
  timeoutMs = 90_000,
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Both child Runtimes are separate processes with real sockets; they
    // share the wall clock the way production Runtimes do. Private tick
    // counts diverged (one node loops more than the other) and moved a signed
    // cross-j route into the sibling's future.
    syncScenarioClockToWall(env);
    await processRuntime(env);
    if (await pred()) return;
    await sleep(100);
  }
  throw new Error(`CROSS_J_NODE_TIMEOUT:${label}`);
};

const phase = (name: string, detail = ''): void => {
  console.log(`CROSS_J_PHASE_${name}${detail ? ` ${detail}` : ''}`);
};

/** Parent writes barrier files only after BOTH runtimes pass the prior phase. */
const waitForBarrier = async (
  name: string,
  env: RuntimeReplica,
  timeoutMs = 180_000,
): Promise<void> => {
  if (!barrierDir) throw new Error('CROSS_J_BARRIER_DIR_MISSING');
  const marker = path.join(barrierDir, name);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await processRuntime(env);
    if (fs.existsSync(marker)) {
      console.log(`CROSS_J_BARRIER_HIT ${name}`);
      return;
    }
    await sleep(50);
  }
  throw new Error(`CROSS_J_BARRIER_TIMEOUT:${name}`);
};

const jurisdictionFromStack = (stack: StackPub): JurisdictionConfig =>
  createJurisdictionConfig(
    stack.name,
    stack.depository,
    stack.entityProvider,
    stack.rpcUrl,
    stack.chainId,
  );

const bindDeployedStack = async (
  env: RuntimeReplica,
  stack: StackPub,
  adapter: JAdapter,
  position: { x: number; y: number; z: number },
): Promise<void> => {
  const replica = createJReplica(env, stack.name, stack.depository, position);
  replica.chainId = stack.chainId;
  replica.entityProviderDeploymentBlock = stack.entityProviderDeploymentBlock;
  replica.contracts = {
    depository: stack.depository,
    entityProvider: stack.entityProvider,
    account: stack.account,
    deltaTransformer: stack.deltaTransformer,
  };
  env.state.jReplicas.set(stack.name, replica);
  bindScenarioJReplica(env, replica, adapter);
  adapter.startWatching(env);
};

const attachExistingStack = async (
  env: RuntimeReplica,
  stack: StackPub,
): Promise<JAdapter> => {
  // importJ owns adapter creation + live attachment. Do not createJAdapter again
  // or the second import conflicts on the existing replica.
  enqueueRuntimeInput(env, {
    runtimeTxs: [{
      type: 'importJ',
      data: {
        name: stack.name,
        chainId: stack.chainId,
        ticker: 'XLN',
        rpcs: [stack.rpcUrl],
        entityProviderDeploymentBlock: stack.entityProviderDeploymentBlock,
        contracts: {
          depository: stack.depository,
          entityProvider: stack.entityProvider,
          account: stack.account,
          deltaTransformer: stack.deltaTransformer,
        },
      },
    }],
    entityInputs: [],
  });
  // importJ → pending → completeImportJ (next frame) → live adapter reconcile.
  await processRuntime(env);
  await processRuntime(env);
  await processRuntime(env);
  const adapter = await ensureLiveJAdapterForReplica(env, stack.name, {
    context: `cross-j-user:${stack.name}`,
  });
  if (!adapter) throw new Error(`CROSS_J_USER_STACK_ADAPTER_MISSING:${stack.name}`);
  return adapter;
};

const fund = async (adapter: JAdapter, entityId: string, tokenId: number, amount: bigint): Promise<void> => {
  await adapter.debugFundReserves(entityId, tokenId, amount);
};

const stackPub = (name: string, adapter: JAdapter, rpcUrl: string): StackPub => ({
  name,
  chainId: Number(adapter.chainId),
  rpcUrl,
  depository: adapter.addresses.depository,
  entityProvider: adapter.addresses.entityProvider,
  account: String(adapter.addresses.account),
  deltaTransformer: String(adapter.addresses.deltaTransformer),
  entityProviderDeploymentBlock: Number(adapter.entityProviderDeploymentBlock ?? 1),
});

const deployHubStacks = async (env: RuntimeReplica): Promise<{
  source: StackPub;
  target: StackPub;
  sourceAdapter: JAdapter;
  targetAdapter: JAdapter;
}> => {
  const sourceRpc = process.env['ANVIL_RPC'] || `http://127.0.0.1:${await reservePort()}`;
  const targetRpc = `http://127.0.0.1:${await reservePort()}`;
  // ensureJAdapter auto-starts anvil when the RPC is unreachable — raw
  // createJAdapter does not.
  const sourceAdapter = await ensureJAdapter(env, 'rpc', {
    deployStack: true,
    rpcUrl: sourceRpc,
    chainId: 31337,
  });
  const targetAdapter = await ensureJAdapter(env, 'rpc', {
    deployStack: true,
    rpcUrl: targetRpc,
    chainId: 31338,
  });
  return {
    source: stackPub('CrossJ Source', sourceAdapter, sourceRpc),
    target: stackPub('CrossJ Target', targetAdapter, targetRpc),
    sourceAdapter,
    targetAdapter,
  };
};

const runHubs = async (): Promise<void> => {
  console.log(`CROSS_J_NODE_CONFIG role=hubs relayUrl=${relayUrl} relayPort=${relayPort}`);
  const env = await main(seed);
  env.scenarioMode = true;
  // Account consensus debug for dual-Runtime credit/opening — flip quiet off
  // when XLN_CROSS_J_ACCOUNT_DEBUG=1 so rejections/ACKs are visible.
  env.quietRuntimeLogs = process.env['XLN_CROSS_J_ACCOUNT_DEBUG'] !== '1';
  startRuntimeLoop(env);

  const { source, target, sourceAdapter, targetAdapter } = await deployHubStacks(env);
  console.log(`CROSS_J_STACKS_READY ${JSON.stringify({ source, target })}`);

  await bindDeployedStack(env, source, sourceAdapter, { x: 0, y: 600, z: 0 });
  await bindDeployedStack(env, target, targetAdapter, { x: 400, y: 600, z: 0 });

  if (!(relayPort > 0)) throw new Error('CROSS_J_RELAY_PORT_MISSING');
  let localDelivery: ReturnType<typeof createLocalDeliveryHandler> | null = null;
  startStandaloneRelayServer({
    host: relayHost,
    port: relayPort,
    serverId: 'hubs',
    ...(env.runtimeId ? { serverRuntimeId: env.runtimeId } : {}),
    onEntityInput: async (from, msg, store) => {
      localDelivery ??= createLocalDeliveryHandler(env, store, getEntityReplicaById);
      await localDelivery(from, msg);
    },
  });
  console.log(`P2P_RELAY_READY host=${relayHost} port=${relayPort}`);

  const sourceJ = jurisdictionFromStack(source);
  const targetJ = jurisdictionFromStack(target);
  const hubSrc = await createEntity(env, 'hub-src', 'HubSrc', sourceJ, { x: -10, y: 0, z: 0 });
  const hubTgt = await createEntity(env, 'hub-tgt', 'HubTgt', targetJ, { x: 10, y: 0, z: 0 });
  await enableHub(env, hubSrc);
  await enableHub(env, hubTgt);
  await fund(sourceAdapter, hubSrc.id, USDC, usd(2_000_000));
  await fund(targetAdapter, hubTgt.id, WETH, usd(2_000_000));
  await processRuntime(env);

  const directWsUrl = await startDirectIngress(env);
  const p2p = startP2P(env, {
    relayUrls: [relayUrl],
    wsUrl: directWsUrl,
    seedRuntimeIds: [],
    advertiseEntityIds: [hubSrc.id, hubTgt.id],
  });
  if (!p2p) throw new Error('CROSS_J_P2P_START_FAILED:hubs');
  console.log(`P2P_NODE_READY role=hubs runtimeId=${env.runtimeId}`);
  console.log(`CROSS_J_HUBS_READY ${JSON.stringify({ runtimeId: env.runtimeId, hubSrc, hubTgt })}`);

  // ── PHASE 1: accounts open + idle ──────────────────────────────────
  await waitUntil('hub-accounts', () => {
    const src = findReplica(env, hubSrc.id);
    const tgt = findReplica(env, hubTgt.id);
    return src.state.accounts.size >= 1 && tgt.state.accounts.size >= 1;
  }, env);
  await waitUntil('hub-accounts-stable', () => {
    for (const hub of [hubSrc, hubTgt]) {
      for (const account of findReplica(env, hub.id).state.accounts.values()) {
        if (!accountFrameSettled(account, 1)) return false;
      }
    }
    return true;
  }, env);
  // Pairs resolved after accounts exist. Fail loud if a hub has ≠1 account —
  // keys()[0] would silently credit/assert the wrong counterparty.
  const requireSingleHubCounterparty = (hub: Party): string => {
    const keys = [...findReplica(env, hub.id).state.accounts.keys()];
    if (keys.length !== 1) {
      throw new Error(`CROSS_J_HUB_ACCOUNT_COUNT_UNEXPECTED:${hub.name}:${keys.length}`);
    }
    return keys[0]!;
  };
  const hubPairs = (): ReturnType<typeof defaultCrossJCreditPairs> =>
    defaultCrossJCreditPairs(
      hubSrc.id,
      requireSingleHubCounterparty(hubSrc),
      hubTgt.id,
      requireSingleHubCounterparty(hubTgt),
      USDC,
      WETH,
    );
  assertAccountsOpenPhase(env, hubPairs(), 'hubs');
  phase('ACCOUNTS_OPEN', 'role=hubs');

  // Do NOT extend credit until users also finished ACCOUNTS_OPEN. Racing
  // set_credit_limit while the left proposer is still finishing height-1
  // leaves hub pending forever (ack_frame h=2 never ACKed).
  await waitForBarrier('accounts-open.ready', env);

  // ── PHASE 2: hub → MM credit (trusted hub extends first) ───────────
  for (const hub of [hubSrc, hubTgt]) {
    const tokenId = hub.name === 'HubSrc' ? USDC : WETH;
    const replica = findReplica(env, hub.id);
    for (const [counterparty] of replica.state.accounts) {
      console.log(
        `CROSS_J_HUB_CREDIT_EXTEND hub=${hub.name} cp=${counterparty.slice(-8)} ` +
        `token=${tokenId} left=${localIsLeft(getAccount(replica, counterparty)!)}`,
      );
      enqueueRuntimeInput(env, {
        runtimeTxs: [],
        entityInputs: [{
          entityId: hub.id,
          signerId: hub.signer,
          entityTxs: [{
            type: 'extendCredit',
            data: { counterpartyEntityId: counterparty, tokenId, amount: usd(500_000) },
          }],
        }],
      });
    }
  }
  await processRuntime(env);

  let creditWaitLogs = 0;
  await waitUntil('hub-credit-acked', () => {
    creditWaitLogs += 1;
    for (const hub of [hubSrc, hubTgt]) {
      const tokenId = hub.name === 'HubSrc' ? USDC : WETH;
      for (const [counterparty, account] of findReplica(env, hub.id).state.accounts) {
        const credit = creditView(account, tokenId);
        // peerCreditLimit = we granted counterparty (deriveDelta only).
        if (!accountFrameSettled(account, 2) || !credit || credit.peerCreditLimit < usd(500_000)) {
          if (creditWaitLogs === 1 || creditWaitLogs % 20 === 0) {
            const pending = (account.pendingFrame?.accountTxs ?? []).map(tx => tx.type).join('+') || 'none';
            console.log(
              `CROSS_J_HUB_CREDIT_WAIT hub=${hub.name} cp=${counterparty.slice(-8)} ` +
              `h=${account.currentHeight} pending=${pending} ` +
              `own=${credit?.ownCreditLimit ?? 0n} peer=${credit?.peerCreditLimit ?? 0n} ` +
              `token=${tokenId} left=${localIsLeft(account)} ` +
              `mempool=${account.mempool.map(tx => tx.type).join('+') || 'empty'} round=${creditWaitLogs}`,
            );
          }
          return false;
        }
      }
    }
    return true;
  }, env, 120_000);
  assertCreditReadyPhase(env, hubPairs(), 'hubs');
  p2p.updateConfig({});
  phase('CREDIT_READY', 'role=hubs');
  console.log('CROSS_J_HUB_CREDIT_READY');
  // Orders/materialize only after parent confirms users are also CREDIT_READY.
  await waitForBarrier('setup-ready', env);
  console.log('CROSS_J_SETUP_FINALIZED role=hubs');

  // ── PHASE 3+: wait for MM orders (users submit only after CREDIT_READY)
  await waitUntil('hub-route-materialized', () => {
    const sourceRoute = findReplica(env, hubSrc.id).state.crossJurisdictionSwaps?.get(orderId);
    const targetRoute = findReplica(env, hubTgt.id).state.crossJurisdictionSwaps?.get(orderId);
    return Boolean(sourceRoute?.sourcePull && targetRoute?.targetPull);
  }, env, 180_000);
  console.log(`CROSS_J_MATERIALIZED orderId=${orderId}`);

  // ── PHASE 4: orderbooks (same-j offer + cross-j book + pulls) ───────
  let orderbookLogs = 0;
  await waitUntil('hub-orderbook-ready', () => {
    orderbookLogs += 1;
    const hubSrcState = findReplica(env, hubSrc.id).state;
    const src = hubSrcState.crossJurisdictionSwaps?.get(orderId);
    const tgt = findReplica(env, hubTgt.id).state.crossJurisdictionSwaps?.get(orderId);
    const sourceUser = String(src?.source?.entityId || '').toLowerCase();
    const sourceAccount = sourceUser ? getAccount(findReplica(env, hubSrc.id), sourceUser) : undefined;
    const offer = Boolean(sourceAccount?.state.swapOffers?.get(orderId)?.crossJurisdiction);
    const book = Boolean(src && hasCrossJurisdictionBookOrder(hubSrcState, src));
    const ready =
      src?.status === 'resting' &&
      tgt?.status === 'resting' &&
      Boolean(src.sourcePull) &&
      Boolean(src.targetPull) &&
      offer &&
      book;
    if (!ready && (orderbookLogs === 1 || orderbookLogs % 40 === 0)) {
      console.log(
        `CROSS_J_HUB_ORDERBOOK_WAIT orderId=${orderId} ` +
        `src=${src?.status ?? 'ABSENT'} tgt=${tgt?.status ?? 'ABSENT'} ` +
        `offer=${offer} book=${book} acctH=${sourceAccount?.currentHeight ?? 'none'} ` +
        `pending=${(sourceAccount?.pendingFrame?.accountTxs ?? []).map(tx => tx.type).join('+') || 'none'} ` +
        `round=${orderbookLogs}`,
      );
    }
    return ready;
  }, env, 180_000);
  assertCrossJOrderbooksReady(env, orderId, hubSrc.id, hubTgt.id);
  phase('ORDERBOOK', `orderId=${orderId}`);
  console.log(`CROSS_J_HUB_ACCOUNT_DIAG orderId=${orderId} orderbook=ok`);

  // ── PHASE 5: clear → settled ───────────────────────────────────────
  console.log(`CROSS_J_CLEAR_SUBMIT orderId=${orderId}`);
  await processRuntime(env, [{
    entityId: hubSrc.id,
    signerId: hubSrc.signer,
    entityTxs: [{
      type: 'requestCrossJurisdictionClear',
      data: { orderId, cancelRemainder: true },
    }],
  }]);
  let lastLogged = '';
  await waitUntil('hub-settled', () => {
    const status = findReplica(env, hubSrc.id).state.crossJurisdictionSwaps?.get(orderId)?.status;
    const stamp = status ?? 'ABSENT';
    if (stamp !== lastLogged) {
      console.log(`CROSS_J_CLEAR_STATUS orderId=${orderId} status=${stamp}`);
      lastLogged = stamp;
    }
    return status === 'settled' || status === 'cancelled';
  }, env, 180_000);
  assertCrossJSettled(env, orderId, hubSrc.id);
  phase('SETTLED', `orderId=${orderId}`);
  console.log(`CROSS_J_SETTLED orderId=${orderId}`);
  for (let i = 0; i < 40; i++) {
    await processRuntime(env);
    await sleep(100);
  }
};

const runUsers = async (): Promise<void> => {
  if (!stacksJson) throw new Error('CROSS_J_STACKS_ARG_MISSING');
  if (!seedRuntimeId) throw new Error('CROSS_J_SEED_RUNTIME_MISSING');
  const published = JSON.parse(stacksJson) as {
    source: StackPub;
    target: StackPub;
    hubSrc: Party;
    hubTgt: Party;
  };
  const { source, target, hubSrc, hubTgt } = published;
  console.log(`CROSS_J_NODE_CONFIG role=users relayUrl=${relayUrl} hubsRuntime=${seedRuntimeId}`);

  const env = await main(seed);
  env.scenarioMode = true;
  env.quietRuntimeLogs = process.env['XLN_CROSS_J_ACCOUNT_DEBUG'] !== '1';
  startRuntimeLoop(env);

  const sourceAdapter = await attachExistingStack(env, source);
  const targetAdapter = await attachExistingStack(env, target);

  const mm = await createEntity(env, 'mm', 'MM', jurisdictionFromStack(source), { x: -40, y: 0, z: 0 });
  const mmt = await createEntity(env, 'mmt', 'MMt', jurisdictionFromStack(target), { x: 40, y: 0, z: 0 });
  await fund(sourceAdapter, mm.id, USDC, usd(2_000_000));
  await fund(targetAdapter, mmt.id, WETH, usd(2_000_000));
  await processRuntime(env);

  const p2p = startP2P(env, {
    relayUrls: [relayUrl],
    seedRuntimeIds: [seedRuntimeId],
    advertiseEntityIds: [mm.id, mmt.id],
  });
  if (!p2p) throw new Error('CROSS_J_P2P_START_FAILED:users');
  console.log(`P2P_NODE_READY role=users runtimeId=${env.runtimeId}`);

  // ── PHASE 1: open accounts (no orders, no rush) ────────────────────
  await sleep(1_000);
  await processRuntime(env);

  enqueueRuntimeInput(env, {
    runtimeTxs: [],
    entityInputs: [
      {
        entityId: mm.id,
        signerId: mm.signer,
        entityTxs: [{
          type: 'openAccount',
          data: {
            targetEntityId: hubSrc.id,
            disputeConfig: defaultAccountDisputeConfigForParties(mm.id, false, hubSrc.id, true),
            tokenId: USDC,
            creditAmount: usd(100_000),
          },
        }],
      },
      {
        entityId: mmt.id,
        signerId: mmt.signer,
        entityTxs: [{
          type: 'openAccount',
          data: {
            targetEntityId: hubTgt.id,
            disputeConfig: defaultAccountDisputeConfigForParties(mmt.id, false, hubTgt.id, true),
            tokenId: WETH,
            creditAmount: usd(100_000),
          },
        }],
      },
    ],
  });
  await processRuntime(env);

  const userPairs = () => defaultCrossJCreditPairs(hubSrc.id, mm.id, hubTgt.id, mmt.id, USDC, WETH);

  await waitUntil('user-accounts-open', () => {
    const mmAcc = getAccount(findReplica(env, mm.id), hubSrc.id);
    const mmtAcc = getAccount(findReplica(env, mmt.id), hubTgt.id);
    return Boolean(mmAcc && mmtAcc && accountFrameSettled(mmAcc, 1) && accountFrameSettled(mmtAcc, 1));
  }, env);
  assertAccountsOpenPhase(env, userPairs(), 'users');
  phase('ACCOUNTS_OPEN', 'role=users');

  // ── PHASE 2: wait until hub credit is fully committed to MM/MMt ─────
  // MM must not place any cross-j order until hub grant ≥ floor and
  // both account machines are idle (no pending/mempool).
  let userCreditLogs = 0;
  await waitUntil('user-hub-credit-ready', () => {
    userCreditLogs += 1;
    for (const [user, hub, tokenId] of [[mm, hubSrc, USDC], [mmt, hubTgt, WETH]] as const) {
      const account = getAccount(findReplica(env, user.id), hub.id);
      const settled = Boolean(account && accountFrameSettled(account, 2));
      const credit = account ? creditView(account, tokenId) : null;
      // Hub→user grant is ownCreditLimit (peer granted us).
      if (!settled || !credit || credit.ownCreditLimit < usd(500_000)) {
        if (userCreditLogs === 1 || userCreditLogs % 20 === 0) {
          console.log(
            `CROSS_J_USER_CREDIT_WAIT user=${user.name} hub=${hub.id.slice(-8)} ` +
            `h=${account?.currentHeight ?? 'none'} settled=${settled} ` +
            `own=${credit?.ownCreditLimit ?? 0n} peer=${credit?.peerCreditLimit ?? 0n} token=${tokenId} ` +
            `left=${account ? localIsLeft(account) : '?'} round=${userCreditLogs}`,
          );
        }
        return false;
      }
    }
    return true;
  }, env, 120_000);
  assertCreditReadyPhase(env, userPairs(), 'users');
  phase('CREDIT_READY', 'role=users');
  console.log('CROSS_J_USERS_READY');

  // Parent releases setup-ready only when hubs AND users are CREDIT_READY.
  await waitForBarrier('setup-ready', env);
  console.log('CROSS_J_SETUP_FINALIZED role=users');

  // ── PHASE 3: only now may MM set the cross-j order ─────────────────
  phase('ORDERS', `orderId=${orderId}`);
  const { route } = buildCrossJurisdictionSwapSubmission(env, {
    orderId,
    sourceUserEntityId: mm.id,
    sourceHubEntityId: hubSrc.id,
    targetHubEntityId: hubTgt.id,
    targetUserEntityId: mmt.id,
    sourceTokenId: USDC,
    // Token 1 is the six-decimal USDC reference asset. Using the generic
    // 18-decimal credit helper here fabricates a $10^15 scenario order and
    // correctly trips the production $6.5m admission cap.
    sourceAmount: usdc(1_000),
    targetTokenId: WETH,
    targetAmount: usd(1_000),
    sourceUserSignerId: mm.signer,
    sourceHubSignerId: hubSrc.signer,
    targetHubSignerId: hubTgt.signer,
    targetUserSignerId: mmt.signer,
  });

  enqueueRuntimeInput(env, {
    runtimeTxs: [],
    entityInputs: [
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
    ],
  });
  await processRuntime(env);
  console.log(`CROSS_J_INTENT_SUBMITTED orderId=${orderId}`);

  await waitUntil('user-auth', () => {
    const mmAuth = findReplica(env, mm.id).state.crossJurisdictionAuthorizations?.has(orderId);
    const mmtAuth = findReplica(env, mmt.id).state.crossJurisdictionAuthorizations?.has(orderId);
    return Boolean(mmAuth && mmtAuth);
  }, env);

  // Observe Account-level materialization (pull/offer), not only Entity route metadata.
  await waitUntil('user-source-pull', () => {
    const mmR = findReplica(env, mm.id);
    const account = [...mmR.state.accounts.values()].find(a =>
      [...(a.state.pulls?.keys() ?? [])].length > 0 ||
      [...(a.state.swapOffers?.keys() ?? [])].includes(orderId),
    );
    if (account) {
      console.log(
        `CROSS_J_USER_ACCOUNT_DIAG orderId=${orderId} ` +
        `pulls=${account.state.pulls?.size ?? 0} offers=${account.state.swapOffers?.size ?? 0}`,
      );
      return true;
    }
    return false;
  }, env, 60_000);

  console.log(`CROSS_J_USERS_DONE orderId=${orderId}`);
  // Stay alive until the orchestrator SIGTERM — hub clear/cancel needs the
  // user Runtime for Account ACKs on both bilateral legs.
  while (true) {
    await processRuntime(env);
    await sleep(100);
  }
};

const run = async (): Promise<void> => {
  if (role === 'hubs') await runHubs();
  else if (role === 'users') await runUsers();
  else throw new Error(`CROSS_J_NODE_ROLE_UNKNOWN:${role}`);
};

run().catch(error => {
  console.error('CROSS_J_NODE_FATAL', error);
  process.exit(1);
});

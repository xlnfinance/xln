/**
 * P2P node runner for multi-runtime relay tests.
 * Usage (internal): bun run runtime/scenarios/p2p-node.ts --role hub|alice|bob ...
 */

import { startRuntimeWsServer } from '../ws-server';
import { main, setRuntimeSeed, startP2P, process as runtimeProcess, applyRuntimeInput, createLazyEntity, generateLazyEntityId } from '../runtime';
import { processUntil, converge } from './helpers';

const args = globalThis.process.argv.slice(2);

const getArg = (name: string, fallback?: string): string | undefined => {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] || fallback;
};

const hasFlag = (name: string): boolean => args.includes(name);

const role = getArg('--role', 'node')!;
const seed = getArg('--seed', role)!;
const relayUrl = getArg('--relay-url', 'ws://127.0.0.1:8787')!;
const seedRuntimeId = getArg('--seed-runtime-id');
const relayPort = Number(getArg('--relay-port', '0'));
const relayHost = getArg('--relay-host', '127.0.0.1')!;
const isHub = hasFlag('--hub');

const USDC = 1;
const DECIMALS = 18n;
const usd = (amount: number | bigint) => BigInt(amount) * 10n ** DECIMALS;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const getProfileByName = (env: any, name: string) => {
  const profiles = env.gossip?.getProfiles?.() || [];
  return profiles.find((profile: any) => (profile.metadata?.name || '').toLowerCase() === name.toLowerCase());
};

const getAccount = (env: any, entityId: string, signerId: string, counterpartyId: string) => {
  const replica = env.eReplicas.get(`${entityId}:${signerId}`);
  return replica?.state.accounts?.get(counterpartyId);
};

const waitForProfile = async (
  env: any,
  name: string,
  maxRounds = 30,
  refresh?: () => void,
  requireRuntimeId = true
) => {
  let lastProfile: any | null = null;
  for (let i = 0; i < maxRounds; i++) {
    const profile = getProfileByName(env, name);
    if (profile) {
      lastProfile = profile;
      if (!requireRuntimeId || profile.runtimeId) return profile;
    }
    refresh?.();
    await sleep(200);
  }
  if (lastProfile && requireRuntimeId && !lastProfile.runtimeId) {
    throw new Error(`PROFILE_MISSING_RUNTIME_ID: ${name}`);
  }
  throw new Error(`PROFILE_TIMEOUT: ${name}`);
};

const waitForAccount = async (env: any, entityId: string, signerId: string, counterpartyId: string) => {
  await processUntil(
    env,
    () => !!getAccount(env, entityId, signerId, counterpartyId),
    30,
    `account ${counterpartyId.slice(-4)}`
  );
};

const waitForPayment = async (env: any, entityId: string, signerId: string, counterpartyId: string) => {
  await processUntil(
    env,
    () => {
      const account = getAccount(env, entityId, signerId, counterpartyId);
      const delta = account?.deltas?.get(USDC);
      return !!delta && delta.offdelta !== 0n;
    },
    40,
    'payment'
  );
};

const run = async () => {
  if (isHub && relayPort > 0) {
    startRuntimeWsServer({ host: relayHost, port: relayPort, serverId: role, requireAuth: false });
  }

  setRuntimeSeed(seed);
  const env = await main();
  env.scenarioMode = true;
  if (!env.runtimeId) {
    throw new Error(`RUNTIME_ID_MISSING: ${role}`);
  }

  const signerId = `${role}-validator`;
  const { config } = createLazyEntity(role, [signerId], 1n);
  const entityId = generateLazyEntityId([signerId], 1n);

  await applyRuntimeInput(env, {
    runtimeTxs: [
      {
        type: 'importReplica',
        entityId,
        signerId,
        data: {
          config,
          isProposer: true,
          position: { x: 0, y: 0, z: 0 },
        },
      },
    ],
    entityInputs: [],
  });

  const p2p = startP2P(env, {
    relayUrls: [relayUrl],
    seedRuntimeIds: seedRuntimeId ? [seedRuntimeId] : [],
    advertiseEntityIds: [entityId],
    isHub,
    profileName: role,
  });

  if (!p2p) {
    throw new Error('P2P_START_FAILED');
  }

  await waitForProfile(env, role, 30, undefined, true);
  console.log(`P2P_NODE_READY role=${role} runtimeId=${env.runtimeId} entityId=${entityId}`);

  if (role === 'hub') {
    const aliceProfile = await waitForProfile(env, 'alice', 30, undefined, true);
    const bobProfile = await waitForProfile(env, 'bob', 30, undefined, true);

    await waitForAccount(env, entityId, signerId, aliceProfile.entityId);
    await waitForAccount(env, entityId, signerId, bobProfile.entityId);

    await runtimeProcess(env, [
      {
        entityId,
        signerId,
        entityTxs: [
          { type: 'extendCredit', data: { counterpartyEntityId: aliceProfile.entityId, tokenId: USDC, amount: usd(500_000) } },
          { type: 'extendCredit', data: { counterpartyEntityId: bobProfile.entityId, tokenId: USDC, amount: usd(500_000) } },
        ],
      },
    ]);

    await converge(env, 20);

    console.log('P2P_HUB_READY');
    await new Promise(() => {});
  }

  const refreshGossip = seedRuntimeId
    ? () => p2p.requestGossip(seedRuntimeId)
    : undefined;
  const hubProfile = await waitForProfile(env, 'hub', 30, refreshGossip, true);

  await runtimeProcess(env, [
    { entityId, signerId, entityTxs: [{ type: 'openAccount', data: { targetEntityId: hubProfile.entityId } }] },
  ]);

  await converge(env, 20);
  await waitForAccount(env, entityId, signerId, hubProfile.entityId);

  if (role === 'alice') {
    await waitForProfile(env, 'bob', 40, refreshGossip, true);
    const bobProfile = getProfileByName(env, 'bob');
    if (!bobProfile) throw new Error('BOB_PROFILE_MISSING');

    await runtimeProcess(env, [
      {
        entityId,
        signerId,
        entityTxs: [
          {
            type: 'directPayment',
            data: {
              targetEntityId: bobProfile.entityId,
              tokenId: USDC,
              amount: usd(1_000),
              route: [entityId, hubProfile.entityId, bobProfile.entityId],
              description: 'p2p-test',
            },
          },
        ],
      },
    ]);

    await converge(env, 30);
    console.log('P2P_PAYMENT_SENT');
    globalThis.process.exit(0);
  }

  if (role === 'bob') {
    await waitForPayment(env, entityId, signerId, hubProfile.entityId);
    console.log('P2P_PAYMENT_RECEIVED');
    globalThis.process.exit(0);
  }
};

run().catch(error => {
  console.error('P2P_NODE_FATAL', error);
  globalThis.process.exit(1);
});

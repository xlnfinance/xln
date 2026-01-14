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
  console.log(`🔍 getProfileByName('${name}'): Searching in ${profiles.length} profiles`);

  const profile = profiles.find((p: any) => (p.metadata?.name || '').toLowerCase() === name.toLowerCase());
  if (profile) {
    console.log(`🔍 FOUND '${name}': ${profile.entityId.slice(-4)} accounts=${profile.accounts?.length || 0} ts=${profile.metadata?.lastUpdated}`);
  } else {
    console.log(`🔍 NOT FOUND '${name}' (names: ${profiles.map((p: any) => p.metadata?.name).join(',')})`);
  }
  return profile;
};

const getAccount = (env: any, entityId: string, signerId: string, counterpartyId: string) => {
  const replica = env.eReplicas.get(`${entityId}:${signerId}`);
  return replica?.state.accounts?.get(counterpartyId);
};

const formatBig = (value: bigint | undefined) => (value === undefined ? undefined : value.toString());

const summarizeTxs = (txs: Array<{ type: string }> | undefined) => (txs || []).map(tx => tx.type);

const describeDelta = (delta: any) => {
  if (!delta) return null;
  return {
    offdelta: formatBig(delta.offdelta),
    ondelta: formatBig(delta.ondelta),
    collateral: formatBig(delta.collateral),
    leftCreditLimit: formatBig(delta.leftCreditLimit),
    rightCreditLimit: formatBig(delta.rightCreditLimit),
    leftAllowance: formatBig(delta.leftAllowance),
    rightAllowance: formatBig(delta.rightAllowance),
  };
};

const describeAccount = (account: any) => {
  if (!account) {
    return { exists: false };
  }
  return {
    exists: true,
    currentHeight: account.currentHeight,
    currentFrameHeight: account.currentFrame?.height,
    pendingFrameHeight: account.pendingFrame?.height ?? null,
    pendingFrameTxs: summarizeTxs(account.pendingFrame?.accountTxs),
    mempoolTxs: summarizeTxs(account.mempool),
    pendingSignatures: account.pendingSignatures?.length ?? 0,
    sentTransitions: account.sentTransitions ?? 0,
    ackedTransitions: account.ackedTransitions ?? 0,
    sendCounter: account.sendCounter ?? 0,
    receiveCounter: account.receiveCounter ?? 0,
  };
};

const logAccountState = (env: any, entityId: string, signerId: string, counterpartyId: string, label: string) => {
  const account = getAccount(env, entityId, signerId, counterpartyId);
  const delta = account?.deltas?.get(USDC);
  console.log(`[P2P_DEBUG] ${label}`, {
    account: describeAccount(account),
    delta: describeDelta(delta),
  });
};

const logEntityState = (env: any, entityId: string, signerId: string, label: string) => {
  const replica = env.eReplicas.get(`${entityId}:${signerId}`);
  if (!replica) {
    console.log(`[P2P_DEBUG] ${label}`, { entity: 'missing' });
    return;
  }
  console.log(`[P2P_DEBUG] ${label}`, {
    mempoolTxs: summarizeTxs(replica.mempool),
    proposalHeight: replica.proposal?.height ?? null,
    lockedHeight: replica.lockedFrame?.height ?? null,
    isProposer: replica.isProposer,
  });
};

const summarizeQueueTargets = (inputs: any[] | undefined) => {
  if (!inputs || inputs.length === 0) return [];
  const targets = new Set<string>();
  for (const input of inputs) {
    if (input?.entityId) targets.add(input.entityId.slice(-4));
  }
  return Array.from(targets.values());
};

const logQueues = (env: any, label: string) => {
  console.log(`[P2P_DEBUG] ${label}`, {
    pendingOutputs: summarizeQueueTargets(env.pendingOutputs),
    pendingNetworkOutputs: summarizeQueueTargets(env.pendingNetworkOutputs),
    networkInbox: summarizeQueueTargets(env.networkInbox),
  });
};

const logProfile = (label: string, profile: any) => {
  if (!profile) {
    console.log(`[P2P_DEBUG] ${label}`, { profile: 'missing' });
    return;
  }
  console.log(`[P2P_DEBUG] ${label}`, {
    entityId: profile.entityId,
    runtimeId: profile.runtimeId,
    endpoints: profile.endpoints || [],
    accounts: (profile.accounts || []).map((acct: any) => acct.counterpartyId?.slice(-4)).filter(Boolean),
    boardSize: Array.isArray(profile.metadata?.board) ? profile.metadata.board.length : 0,
    hasPublicKey: typeof profile.metadata?.entityPublicKey === 'string',
  });
};

const waitForProfile = async (
  env: any,
  name: string,
  maxRounds = 30,
  refresh?: () => void,
  requireRuntimeId = true,
  requireBoard = false,
  requirePublicKey = false
) => {
  let lastProfile: any | null = null;
  for (let i = 0; i < maxRounds; i++) {
    const profile = getProfileByName(env, name);
    if (profile) {
      lastProfile = profile;
      const hasRuntime = !requireRuntimeId || !!profile.runtimeId;
      const hasBoard = !requireBoard || (Array.isArray(profile.metadata?.board) && profile.metadata.board.length > 0);
      const hasPublicKey = !requirePublicKey || typeof profile.metadata?.entityPublicKey === 'string';
      if (hasRuntime && hasBoard && hasPublicKey) return profile;
    }
    refresh?.();
    await sleep(200);
  }
  if (lastProfile && requireRuntimeId && !lastProfile.runtimeId) {
    throw new Error(`PROFILE_MISSING_RUNTIME_ID: ${name}`);
  }
  if (lastProfile && requireBoard && !(Array.isArray(lastProfile.metadata?.board) && lastProfile.metadata.board.length > 0)) {
    throw new Error(`PROFILE_MISSING_BOARD: ${name}`);
  }
  if (lastProfile && requirePublicKey && typeof lastProfile.metadata?.entityPublicKey !== 'string') {
    throw new Error(`PROFILE_MISSING_PUBLIC_KEY: ${name}`);
  }
  throw new Error(`PROFILE_TIMEOUT: ${name}`);
};

const waitForAccount = async (env: any, entityId: string, signerId: string, counterpartyId: string) => {
  await processUntil(
    env,
    () => !!getAccount(env, entityId, signerId, counterpartyId),
    30,
    `account ${counterpartyId.slice(-4)}`,
    round => {
      if (round % 5 === 0) {
        logEntityState(env, entityId, signerId, `wait-account round=${round}`);
        logAccountState(env, entityId, signerId, counterpartyId, `wait-account round=${round}`);
        logQueues(env, `wait-account round=${round}`);
      }
    },
    () => {
      logEntityState(env, entityId, signerId, 'wait-account timeout');
      logAccountState(env, entityId, signerId, counterpartyId, 'wait-account timeout');
      logQueues(env, 'wait-account timeout');
    }
  );
};

const waitForAccountReady = async (env: any, entityId: string, signerId: string, counterpartyId: string) => {
  await processUntil(
    env,
    () => {
      const account = getAccount(env, entityId, signerId, counterpartyId);
      return !!account && !account.pendingFrame && account.currentHeight > 0;
    },
    60,
    `account-ready ${counterpartyId.slice(-4)}`,
    round => {
      if (round % 5 === 0) {
        logEntityState(env, entityId, signerId, `wait-account-ready round=${round}`);
        logAccountState(env, entityId, signerId, counterpartyId, `wait-account-ready round=${round}`);
        logQueues(env, `wait-account-ready round=${round}`);
      }
    },
    () => {
      logEntityState(env, entityId, signerId, 'wait-account-ready timeout');
      logAccountState(env, entityId, signerId, counterpartyId, 'wait-account-ready timeout');
      logQueues(env, 'wait-account-ready timeout');
    }
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
    'payment',
    round => {
      if (round % 5 === 0) {
        logAccountState(env, entityId, signerId, counterpartyId, `wait-payment round=${round}`);
        logQueues(env, `wait-payment round=${round}`);
      }
    },
    () => {
      logAccountState(env, entityId, signerId, counterpartyId, 'wait-payment timeout');
      logQueues(env, 'wait-payment timeout');
    }
  );
};

const waitForHubAccount = async (
  env: any,
  counterpartyId: string,
  refresh?: () => void,
  maxRounds = 40
) => {
  for (let i = 0; i < maxRounds; i++) {
    const profile = getProfileByName(env, 'hub');
    const accounts = profile?.accounts || [];
    const accountIds = accounts.map((a: any) => a.counterpartyId?.slice(-4) || '????');

    if (i % 5 === 0) {
      console.log(`[HUB-ACCOUNT-WAIT] round=${i} hubProfile=${!!profile} accounts=[${accountIds.join(',')}] looking for=${counterpartyId.slice(-4)}`);
    }

    if (profile?.runtimeId && accounts.some((account: any) => account.counterpartyId === counterpartyId)) {
      console.log(`✅ Found hub account with ${counterpartyId.slice(-4)}`);
      return;
    }
    refresh?.();
    await sleep(200);
  }

  // Scope fix for error message
  const finalProfile = getProfileByName(env, 'hub');
  const finalAccounts = finalProfile?.accounts || [];
  const finalAccountIds = finalAccounts.map((a: any) => a.counterpartyId?.slice(-4) || '????');
  console.error(`❌ HUB_ACCOUNT_MISSING: Looking for ${counterpartyId.slice(-4)}, hub has accounts: [${finalAccountIds.join(',')}]`);
  logProfile('wait-hub-account timeout', finalProfile);
  throw new Error(`HUB_ACCOUNT_MISSING: ${counterpartyId}`);
};

const waitForCreditLimit = async (
  env: any,
  entityId: string,
  signerId: string,
  counterpartyId: string,
  amount: bigint,
  maxRounds = 40
) => {
  await processUntil(
    env,
    () => {
      const account = getAccount(env, entityId, signerId, counterpartyId);
      const delta = account?.deltas?.get(USDC);
      if (!delta) return false;
      const counterpartyIsLeft = counterpartyId < entityId;
      const expectedField = counterpartyIsLeft ? 'leftCreditLimit' : 'rightCreditLimit';
      return delta[expectedField] === amount;
    },
    maxRounds,
    `credit-limit ${counterpartyId.slice(-4)}`,
    round => {
      if (round % 5 === 0) {
        logAccountState(env, entityId, signerId, counterpartyId, `wait-credit-limit round=${round}`);
        logQueues(env, `wait-credit-limit round=${round}`);
      }
    },
    () => {
      logAccountState(env, entityId, signerId, counterpartyId, 'wait-credit-limit timeout');
      logQueues(env, 'wait-credit-limit timeout');
    }
  );
};

const run = async () => {
  if (isHub && relayPort > 0) {
    const relay = startRuntimeWsServer({ host: relayHost, port: relayPort, serverId: role, requireAuth: false });
    relay.server.on('listening', () => {
      console.log(`P2P_RELAY_READY host=${relayHost} port=${relayPort}`);
    });
  } else if (isHub) {
    throw new Error(`RELAY_PORT_MISSING: ${relayPort}`);
  }

  console.log(`P2P_NODE_CONFIG role=${role} relayUrl=${relayUrl} relayPort=${relayPort} isHub=${isHub}`);

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

  console.log(`🔧 P2P_CONFIG: role=${role} profileName=${role} entityId=${entityId.slice(-4)}`);

  const p2p = startP2P(env, {
    relayUrls: [relayUrl],
    seedRuntimeIds: seedRuntimeId ? [seedRuntimeId] : [],
    advertiseEntityIds: [entityId],
    isHub,
    profileName: role,  // 'hub', 'alice', 'bob'
  });

  if (!p2p) {
    throw new Error('P2P_START_FAILED');
  }

  console.log(`P2P_NODE_READY role=${role} runtimeId=${env.runtimeId} entityId=${entityId}`);

  if (role === 'hub') {
    // Hub is relay server - just wait for client profiles to arrive via gossip
    console.log('P2P_HUB_WAITING_FOR_PROFILES');

    // Give clients time to connect and send profiles
    await sleep(1000);

    const aliceProfile = await waitForProfile(env, 'alice', 60, undefined, true, true, true);
    const bobProfile = await waitForProfile(env, 'bob', 60, undefined, true, true, true);
    logProfile('hub sees alice', aliceProfile);
    logProfile('hub sees bob', bobProfile);
    console.log('P2P_GOSSIP_READY');

    await waitForAccount(env, entityId, signerId, aliceProfile.entityId);
    await waitForAccount(env, entityId, signerId, bobProfile.entityId);
    logAccountState(env, entityId, signerId, aliceProfile.entityId, 'hub account after open');
    logAccountState(env, entityId, signerId, bobProfile.entityId, 'hub account after open');

    // Mutual credit: Hub extends to Alice, Alice extends to Hub
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

    await converge(env, 30);
    logAccountState(env, entityId, signerId, aliceProfile.entityId, 'hub-alice after hub credit');
    logAccountState(env, entityId, signerId, bobProfile.entityId, 'hub-bob after hub credit');

    console.log('P2P_HUB_READY');
    await new Promise(() => {});
  }

  const refreshGossip = seedRuntimeId
    ? () => p2p.requestGossip(seedRuntimeId)
    : undefined;
  const hubProfile = await waitForProfile(env, 'hub', 30, refreshGossip, true, true, true);
  logProfile(`${role} sees hub`, hubProfile);
  console.log('P2P_HUB_PROFILE_READY');

  await runtimeProcess(env, [
    { entityId, signerId, entityTxs: [{ type: 'openAccount', data: { targetEntityId: hubProfile.entityId } }] },
  ]);

  await converge(env, 20);
  await waitForAccount(env, entityId, signerId, hubProfile.entityId);
  await waitForAccountReady(env, entityId, signerId, hubProfile.entityId);

  // CLIENT extends credit to HUB (so hub can owe us)
  console.log(`${role.toUpperCase()}: Extending credit to hub...`);
  await runtimeProcess(env, [
    {
      entityId,
      signerId,
      entityTxs: [
        { type: 'extendCredit', data: { counterpartyEntityId: hubProfile.entityId, tokenId: USDC, amount: usd(500_000) } },
      ],
    },
  ]);

  await converge(env, 30);
  logAccountState(env, entityId, signerId, hubProfile.entityId, `${role} account after mutual credit`);
  console.log(`${role.toUpperCase()}: Credit extended to hub`);

  if (role === 'alice') {
    await waitForProfile(env, 'bob', 40, refreshGossip, true, true, true);
    const bobProfile = getProfileByName(env, 'bob');
    if (!bobProfile) throw new Error('BOB_PROFILE_MISSING');
    logProfile('alice sees bob', bobProfile);
    await waitForHubAccount(env, bobProfile.entityId, refreshGossip);

    console.log('='.repeat(80));
    console.log('ALICE SENDING PAYMENT TO BOB');
    console.log(`  Alice entityId: ${entityId}`);
    console.log(`  Hub entityId: ${hubProfile.entityId}`);
    console.log(`  Bob entityId: ${bobProfile.entityId}`);
    console.log(`  Route: Alice -> Hub -> Bob`);
    console.log(`  Amount: $1,000 USDC`);
    console.log('='.repeat(80));

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

    console.log('ALICE: directPayment tx submitted to runtime');
    logEntityState(env, entityId, signerId, 'alice after payment submit');
    logAccountState(env, entityId, signerId, hubProfile.entityId, 'alice-hub account after payment');

    await converge(env, 30);
    console.log('P2P_PAYMENT_SENT');
    globalThis.process.exit(0);
  }

  if (role === 'bob') {
    await waitForAccountReady(env, entityId, signerId, hubProfile.entityId);
    const bobAccount = getAccount(env, entityId, signerId, hubProfile.entityId);
    if (!bobAccount) {
      throw new Error(`ACCOUNT_MISSING: ${hubProfile.entityId.slice(-4)}`);
    }
    if (bobAccount.pendingFrame) {
      throw new Error(`ACCOUNT_PENDING_FRAME: ${hubProfile.entityId.slice(-4)} height=${bobAccount.pendingFrame.height}`);
    }
    if (bobAccount.currentHeight === 0) {
      throw new Error(`ACCOUNT_NOT_ACKED: ${hubProfile.entityId.slice(-4)}`);
    }
    const creditAmount = usd(500_000);
    await runtimeProcess(env, [
      {
        entityId,
        signerId,
        entityTxs: [
          {
            type: 'extendCredit',
            data: {
              counterpartyEntityId: hubProfile.entityId,
              tokenId: USDC,
              amount: creditAmount,
            },
          },
        ],
      },
    ]);
    await converge(env, 20);
    await waitForCreditLimit(env, entityId, signerId, hubProfile.entityId, creditAmount, 60);
    console.log('P2P_BOB_READY');
    await waitForPayment(env, entityId, signerId, hubProfile.entityId);
    console.log('P2P_PAYMENT_RECEIVED');
    globalThis.process.exit(0);
  }
};

run().catch(error => {
  console.error('P2P_NODE_FATAL', error);
  globalThis.process.exit(1);
});

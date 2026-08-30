/**
 * P2P node runner for multi-runtime relay tests.
 * Usage (internal): bun run core/scenarios/network/p2p-node.ts --role hub|alice|bob ...
 */

import { ethers } from 'ethers';

import { startStandaloneRelayServer } from '../../network/relay/standalone-server';
import { main, startP2P, processRuntime, enqueueRuntimeInput, createLazyEntity, generateLazyEntityId, getActiveJAdapter, startRuntimeLoop } from '../../runtime.ts';
import { createLocalDeliveryHandler } from '../../network/relay/local-delivery';
import { getEntityReplicaById } from '../../api/server/entities/lookup';
import { processUntil } from '../harness/helpers';
import { isLeftEntity, deriveDelta } from '../../account/utils';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey, getSignerPrivateKey } from '../../account/crypto';
import { loadJurisdictions } from '../../jurisdiction/adapter/kernel/jurisdiction-loader';
import { deployMissingDefaultTokens } from '../../jurisdiction/adapter/operations/dev-token-deployment';
import { hashHtlcSecret } from '../../protocol/htlc/utils';
import type { AccountReplica, Delta } from '../../types/account';
import type { EntityInput, JurisdictionConfig } from '../../entity/types';
import type { RuntimeReplica } from '../../runtime/types';
import { defaultAccountDisputeConfigForParties } from '../../account/config/dispute-config';
import { getLiveJAdapter } from '../../runtime/j-submit/live-jadapters';
import type { JAdapter, JTokenInfo } from '../../jurisdiction/adapter/types';
import type { Profile } from '../../entity/profile';
import { withDeterministicHtlcTestSecret } from '../../protocol/htlc/test-secret-capability';
import { hasCliFlag, readCliOption } from '../../config/cli';
import { quoteHtlcPaymentRoute } from '../../pathfinding/htlc-quote';
import { createTestEntityImportRuntimeTx } from '../../qa/entity-creation-fixture';

const args = globalThis.process.argv.slice(2);

const getArg = (name: string): string | undefined =>
  readCliOption(args, name);
const getArgOr = (name: string, defaultValue: string): string =>
  readCliOption(args, name, defaultValue);

const hasFlag = (name: string): boolean => hasCliFlag(args, name);

const role = getArgOr('--role', 'node');
const seed = getArgOr('--seed', role);
const relayUrl = getArgOr('--relay-url', 'ws://127.0.0.1:8787');
const seedRuntimeId = getArg('--seed-runtime-id');
const relayPort = Number(getArgOr('--relay-port', '0'));
const relayHost = getArgOr('--relay-host', '127.0.0.1');
const isHub = hasFlag('--hub');
const useRpc = hasFlag('--rpc');
const jurisdictionName = getArgOr('--jurisdiction', 'arrakis');
const rpcUrlOverride = getArg('--rpc-url');
const skipWalletFunding = hasFlag('--skip-wallet-funding');
const waitForBobReady = hasFlag('--wait-for-bob-ready');
const stayAliveAfterPayment = hasFlag('--stay-alive-after-payment');

let USDC = 1;
const DECIMALS = 18n;
const usd = (amount: number | bigint) => BigInt(amount) * 10n ** DECIMALS;
const FAUCET_DEPOSIT_AMOUNT = usd(1_000);
const FAUCET_WALLET_AMOUNT = usd(5_000);
const R2R_AMOUNT = usd(250);
const HTLC_AMOUNT = usd(1_000);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type P2PScenarioEnv = RuntimeReplica;

const resolveJurisdiction = (): {
  jurisdiction: JurisdictionConfig;
  rpcUrl: string;
  entityProviderDeploymentBlock: number;
  contracts: { depository: string; entityProvider: string; account: string; deltaTransformer: string };
} => {
  const data = loadJurisdictions();
  const entry = data.jurisdictions?.[jurisdictionName];
  if (!entry) {
    throw new Error(`JURISDICTION_NOT_FOUND: ${jurisdictionName}`);
  }
  const rpcUrl = rpcUrlOverride ?? entry.rpc;
  const contracts = entry.contracts || {};
  if (!rpcUrl) {
    throw new Error(`JURISDICTION_RPC_MISSING: ${jurisdictionName}`);
  }
  if (!contracts.depository || !contracts.entityProvider || !contracts.account || !contracts.deltaTransformer) {
    throw new Error(`JURISDICTION_CONTRACTS_MISSING: ${jurisdictionName}`);
  }
  const completeContracts = {
    depository: contracts.depository,
    entityProvider: contracts.entityProvider,
    account: contracts.account,
    deltaTransformer: contracts.deltaTransformer,
  };
  const entityProviderDeploymentBlock = Number(entry.entityProviderDeploymentBlock);
  if (!Number.isSafeInteger(entityProviderDeploymentBlock) || entityProviderDeploymentBlock < 1) {
    throw new Error(`JURISDICTION_ENTITY_PROVIDER_DEPLOYMENT_BLOCK_INVALID: ${jurisdictionName}`);
  }
  const jurisdiction: JurisdictionConfig = {
    name: jurisdictionName,
    address: rpcUrl,
    entityProviderAddress: contracts.entityProvider,
    depositoryAddress: contracts.depository,
    chainId: entry.chainId,
    entityProviderDeploymentBlock,
  };
  return {
    jurisdiction,
    rpcUrl,
    contracts: completeContracts,
    entityProviderDeploymentBlock,
  };
};

const ensureTokenCatalog = async (jadapter: JAdapter, allowDeploy: boolean): Promise<JTokenInfo[]> => {
  const current = await jadapter.getTokenRegistry();
  if (current.length > 0) {
    if (jadapter.mode !== 'browservm') {
      const firstToken = current[0];
      if (firstToken?.address) {
        const code = await jadapter.provider.getCode(firstToken.address);
        if (code === '0x' || code.length < 10) {
          throw new Error(
            `TOKEN_CONTRACT_CODE_MISSING:${firstToken.symbol}:${firstToken.address}`,
          );
        }
      }
    }
    return current;
  }

  if (allowDeploy) {
    await deployMissingDefaultTokens(jadapter, jurisdictionName);
    return await jadapter.getTokenRegistry();
  }

  return current;
};

const waitForTokenCatalog = async (jadapter: JAdapter, maxRounds = 40): Promise<JTokenInfo[]> => {
  for (let i = 0; i < maxRounds; i++) {
    const tokens = await jadapter.getTokenRegistry();
    if (tokens.length > 0) return tokens;
    await sleep(250);
  }
  throw new Error('TOKEN_CATALOG_EMPTY');
};

const getReserveBalance = (env: P2PScenarioEnv, entityId: string, signerId: string, tokenId: number): bigint => {
  const replica = env.state.eReplicas.get(`${entityId}:${signerId}`);
  if (!replica) return 0n;
  return replica.state.reserves?.get(tokenId) ?? 0n;
};

const waitForReserveBalance = async (
  env: P2PScenarioEnv,
  entityId: string,
  signerId: string,
  tokenId: number,
  minAmount: bigint,
  label: string,
  maxRounds = 300
) => {
  const jadapter = getActiveJAdapter(env);
  if (!jadapter) throw new Error('JADAPTER_MISSING');
  for (let round = 1; round <= maxRounds; round++) {
    if (getReserveBalance(env, entityId, signerId, tokenId) >= minAmount) return;

    await processRuntime(env);
    if (typeof jadapter.pollNow === 'function') {
      await jadapter.pollNow();
      await processRuntime(env);
    }

    if (getReserveBalance(env, entityId, signerId, tokenId) >= minAmount) return;

    if (round % 10 === 0) {
      console.log(`[P2P_DEBUG] wait-reserve ${label} round=${round} reserve=${getReserveBalance(env, entityId, signerId, tokenId)}`);
    }
    await sleep(10);
  }

  console.log(`[P2P_DEBUG] wait-reserve ${label} timeout reserve=${getReserveBalance(env, entityId, signerId, tokenId)}`);
  throw new Error(`processUntil: ${label} not satisfied after ${maxRounds} rounds`);
};

const fundWalletAndDeposit = async (
  env: P2PScenarioEnv,
  jadapter: JAdapter,
  token: JTokenInfo,
  entityId: string,
  signerId: string,
  amount: bigint
) => {
  const signerPrivateKey = getSignerPrivateKey(env, signerId);
  const privateKeyHex = '0x' + Buffer.from(signerPrivateKey).toString('hex');
  const wallet = new ethers.Wallet(privateKeyHex, jadapter.provider);
  const walletAddress = await wallet.getAddress();
  console.log(`[P2P] Faucet: ${signerId.slice(-4)} wallet=${walletAddress.slice(0, 10)} token=${token.symbol}`);

  if (skipWalletFunding) {
    console.log(`[P2P] Faucet: skipping wallet funding (pre-funded)`);
  }

  if (!skipWalletFunding) {
    const targetEth = ethers.parseEther('1');
    const currentEth = await jadapter.provider.getBalance(walletAddress);
    if (currentEth < targetEth) {
      const tx = await jadapter.signer.sendTransaction({ to: walletAddress, value: targetEth - currentEth });
      await tx.wait();
    }

    const erc20 = new ethers.Contract(
      token.address,
      ['function balanceOf(address owner) view returns (uint256)', 'function transfer(address to, uint256 amount) returns (bool)'],
      jadapter.signer
    );
    const balanceOf = erc20.getFunction('balanceOf');
    const transfer = erc20.getFunction('transfer');
    const currentToken = (await balanceOf(walletAddress)) as bigint;
    if (currentToken < FAUCET_WALLET_AMOUNT) {
      const tx = await transfer(walletAddress, FAUCET_WALLET_AMOUNT - currentToken);
      await tx.wait();
    }
  }

  await jadapter.externalTokenToReserve(signerPrivateKey, entityId, token.address, amount, {
    internalTokenId: token.tokenId ?? 0,
  });
  console.log(`[P2P] Faucet: deposited ${amount} ${token.symbol} to ${entityId.slice(-4)}`);
};

const getProfileByName = (env: P2PScenarioEnv, name: string): Profile | undefined => {
  const profiles = env.gossip?.getProfiles?.() || [];
  console.log(`🔍 getProfileByName('${name}'): Searching in ${profiles.length} profiles`);

  const profile = profiles.find((p) => (p.name || '').toLowerCase() === name.toLowerCase());
  if (profile) {
    console.log(`🔍 FOUND '${name}': ${profile.entityId.slice(-4)} accounts=${profile.accounts?.length || 0} ts=${profile.lastUpdated}`);
  } else {
    console.log(`🔍 NOT FOUND '${name}' (names: ${profiles.map((p) => p.name).join(',')})`);
  }
  return profile;
};

const getAccount = (env: P2PScenarioEnv, entityId: string, signerId: string, counterpartyId: string): AccountReplica | undefined => {
  const replica = env.state.eReplicas.get(`${entityId}:${signerId}`);
  return replica?.state.accounts?.get(counterpartyId);
};

const getLeftEntity = (account: AccountReplica | undefined): string | null => {
  const from = account?.proofHeader?.fromEntity;
  const to = account?.proofHeader?.toEntity;
  if (!from || !to) return null;
  return from < to ? from : to;
};

const resolveSides = (account: AccountReplica | undefined, entityId: string, counterpartyId: string) => {
  const leftEntity = getLeftEntity(account);
  if (leftEntity) {
    return {
      weAreLeft: entityId === leftEntity,
      counterpartyIsLeft: counterpartyId === leftEntity,
    };
  }
  const weAreLeft = isLeftEntity(entityId, counterpartyId);
  return {
    weAreLeft,
    counterpartyIsLeft: !weAreLeft,
  };
};

const formatBig = (value: bigint | undefined) => (value === undefined ? undefined : value.toString());

const summarizeTxs = (txs: Array<{ type: string }> | undefined) => (txs || []).map(tx => tx.type);

const describeDelta = (delta: Delta | undefined) => {
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

const describeAccount = (account: AccountReplica | undefined) => {
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
    locks: Array.from(account.state.locks.values()).map(lock => ({
      hashlock: lock.hashlock.slice(0, 10),
      amount: lock.amount.toString(),
      senderIsLeft: lock.senderIsLeft,
    })),
  };
};

const logAccountState = (env: P2PScenarioEnv, entityId: string, signerId: string, counterpartyId: string, label: string) => {
  const account = getAccount(env, entityId, signerId, counterpartyId);
  const delta = account?.state.deltas?.get(USDC);
  console.log(`[P2P_DEBUG] ${label}`, {
    account: describeAccount(account),
    delta: describeDelta(delta),
  });
};

const logEntityState = (env: P2PScenarioEnv, entityId: string, signerId: string, label: string) => {
  const replica = env.state.eReplicas.get(`${entityId}:${signerId}`);
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

const summarizeQueueTargets = (inputs: EntityInput[] | undefined) => {
  if (!inputs || inputs.length === 0) return [];
  const targets = new Set<string>();
  for (const input of inputs) {
    if (input?.entityId) targets.add(input.entityId.slice(-4));
  }
  return Array.from(targets.values());
};

const logQueues = (env: P2PScenarioEnv, label: string) => {
  console.log(`[P2P_DEBUG] ${label}`, {
    pendingOutputs: summarizeQueueTargets(env.pendingOutputs),
    pendingNetworkOutputs: summarizeQueueTargets(env.pendingNetworkOutputs),
    networkInbox: summarizeQueueTargets(env.networkInbox),
  });
};

const logProfile = (label: string, profile: Profile | null | undefined) => {
  if (!profile) {
    console.log(`[P2P_DEBUG] ${label}`, { profile: 'missing' });
    return;
  }
  console.log(`[P2P_DEBUG] ${label}`, {
    entityId: profile.entityId,
    runtimeId: profile.runtimeId,
    wsUrl: profile.wsUrl || null,
    accounts: (profile.accounts || []).map((acct) => acct.counterpartyId?.slice(-4)).filter(Boolean),
    hasEntityEncryptionPublicKey: typeof profile.entityEncryptionPublicKey === 'string',
  });
};

const waitForProfile = async (
  env: P2PScenarioEnv,
  name: string,
  maxRounds = 30,
  refresh?: () => void,
  requireRuntimeId = true,
  requireBoard = false,
  requirePublicKey = false
) => {
  let lastProfile: Profile | null = null;
  for (let i = 0; i < maxRounds; i++) {
    const profile = getProfileByName(env, name);
    if (profile) {
      lastProfile = profile;
      const hasRuntime = !requireRuntimeId || !!profile.runtimeId;
      const hasBoard = !requireBoard || typeof profile.metadata.profileHanko === 'string';
      const hasPublicKey = !requirePublicKey || typeof profile.entityEncryptionPublicKey === 'string';
      if (hasRuntime && hasBoard && hasPublicKey) return profile;
    }
    refresh?.();
    await sleep(200);
  }
  if (lastProfile && requireRuntimeId && !lastProfile.runtimeId) {
    throw new Error(`PROFILE_MISSING_RUNTIME_ID: ${name}`);
  }
  if (lastProfile && requireBoard) {
    if (!lastProfile.metadata.profileHanko) {
      throw new Error(`PROFILE_MISSING_BOARD: ${name}`);
    }
  }
  if (lastProfile && requirePublicKey && typeof lastProfile.entityEncryptionPublicKey !== 'string') {
    throw new Error(`PROFILE_MISSING_PUBLIC_KEY: ${name}`);
  }
  throw new Error(`PROFILE_TIMEOUT: ${name}`);
};

const waitForAccount = async (env: P2PScenarioEnv, entityId: string, signerId: string, counterpartyId: string, maxRounds = 30) => {
  await processUntil(
    env,
    () => !!getAccount(env, entityId, signerId, counterpartyId),
    maxRounds,
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

const waitForAccountReady = async (env: P2PScenarioEnv, entityId: string, signerId: string, counterpartyId: string, maxRounds = 60) => {
  await processUntil(
    env,
    () => {
      const account = getAccount(env, entityId, signerId, counterpartyId);
      return !!account && !account.pendingFrame && account.currentHeight > 0;
    },
    maxRounds,
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

const waitForPayment = async (
  env: P2PScenarioEnv,
  entityId: string,
  signerId: string,
  counterpartyId: string,
  maxRounds = 40
) => {
  const baselineAccount = getAccount(env, entityId, signerId, counterpartyId);
  const baselineDelta = baselineAccount?.state.deltas.get(USDC);
  if (!baselineAccount || !baselineDelta) {
    throw new Error(`PAYMENT_BASELINE_ACCOUNT_DELTA_MISSING:${counterpartyId}`);
  }
  const { weAreLeft } = resolveSides(baselineAccount, entityId, counterpartyId);
  const baselineOutCapacity = deriveDelta(baselineDelta, weAreLeft).outCapacity;
  await processUntil(
    env,
    () => {
      const account = getAccount(env, entityId, signerId, counterpartyId);
      const delta = account?.state.deltas?.get(USDC);
      return Boolean(
        account
        && delta
        && !account.pendingFrame
        && account.state.locks.size === 0
        && deriveDelta(delta, weAreLeft).outCapacity > baselineOutCapacity,
      );
    },
    maxRounds,
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

/**
 * Wait for hub to have our profile in its gossip layer.
 * This is critical: we can't open account until hub can route messages back to us.
 */
const waitForHubToHaveOurProfile = async (
  env: P2PScenarioEnv,
  ourEntityId: string,
  refresh?: () => void,
  maxRounds = 10
) => {
  console.log(`[P2P] Waiting for hub to have our profile ${ourEntityId.slice(-4)}...`);
  for (let i = 0; i < maxRounds; i++) {
    const hubProfile = getProfileByName(env, 'hub');
    if (!hubProfile) {
      refresh?.();
      await sleep(50);
      continue;
    }
    // Profile exchange should be fast since we already have hub's profile
    // and hub should have received ours via gossip announce
    if (i >= 1) {  // Just 1 round is enough
      console.log(`✅ Assumed hub has our profile after ${i} gossip exchanges`);
      return;
    }
    refresh?.();
    await sleep(50);
  }
  console.warn(`⚠️ Could not confirm hub has our profile, proceeding anyway...`);
};

const waitForHubAccount = async (
  env: P2PScenarioEnv,
  counterpartyId: string,
  refresh?: () => void,
  maxRounds = 40
) => {
  for (let i = 0; i < maxRounds; i++) {
    const profile = getProfileByName(env, 'hub');
    const accounts = profile?.accounts || [];
    const accountIds = accounts.map((account) => account.counterpartyId?.slice(-4) || '????');

    if (i % 5 === 0) {
      console.log(`[HUB-ACCOUNT-WAIT] round=${i} hubProfile=${!!profile} accounts=[${accountIds.join(',')}] looking for=${counterpartyId.slice(-4)}`);
    }

    if (profile?.runtimeId && accounts.some((account) => account.counterpartyId === counterpartyId)) {
      console.log(`✅ Found hub account with ${counterpartyId.slice(-4)}`);
      return;
    }
    refresh?.();
    await sleep(200);
  }

  // Scope fix for error message
  const finalProfile = getProfileByName(env, 'hub');
  const finalAccounts = finalProfile?.accounts || [];
  const finalAccountIds = finalAccounts.map((account) => account.counterpartyId?.slice(-4) || '????');
  console.error(`❌ HUB_ACCOUNT_MISSING: Looking for ${counterpartyId.slice(-4)}, hub has accounts: [${finalAccountIds.join(',')}]`);
  logProfile('wait-hub-account timeout', finalProfile);
  throw new Error(`HUB_ACCOUNT_MISSING: ${counterpartyId}`);
};

const waitForCreditLimit = async (
  env: P2PScenarioEnv,
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
      const delta = account?.state.deltas?.get(USDC);
      if (!account || !delta) return false;
      const { weAreLeft } = resolveSides(account, entityId, counterpartyId);
      // Canonical viewer semantics: ownCreditLimit is credit granted to us by
      // the peer, independent of lexicographic LEFT/RIGHT storage layout.
      return !account.pendingFrame && deriveDelta(delta, weAreLeft).ownCreditLimit === amount;
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

const waitForOwnCreditLimit = async (
  env: P2PScenarioEnv,
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
      const delta = account?.state.deltas?.get(USDC);
      if (!account || !delta) return false;
      const { weAreLeft } = resolveSides(account, entityId, counterpartyId);
      // peerCreditLimit is credit we granted the peer. Never inspect the raw
      // left/right fields in a behavioral gate.
      return !account.pendingFrame && deriveDelta(delta, weAreLeft).peerCreditLimit === amount;
    },
    maxRounds,
    `own-credit ${counterpartyId.slice(-4)}`,
    round => {
      if (round % 5 === 0) {
        logAccountState(env, entityId, signerId, counterpartyId, `wait-own-credit round=${round}`);
        logQueues(env, `wait-own-credit round=${round}`);
      }
    },
    () => {
      logAccountState(env, entityId, signerId, counterpartyId, 'wait-own-credit timeout');
      logQueues(env, 'wait-own-credit timeout');
    }
  );
};

const waitForOrchestratorSignal = async (expected: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    let buffered = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`P2P_ORCHESTRATOR_SIGNAL_TIMEOUT:${expected}`));
    }, 30_000);
    const onData = (chunk: Buffer | string): void => {
      buffered += chunk.toString();
      if (buffered.split(/\r?\n/).includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      globalThis.process.stdin.off('data', onData);
    };
    globalThis.process.stdin.on('data', onData);
    globalThis.process.stdin.resume();
  });
};

const run = async () => {
  console.log(`P2P_NODE_CONFIG role=${role} relayUrl=${relayUrl} relayPort=${relayPort} isHub=${isHub}`);

  const env: P2PScenarioEnv = await main(seed);
  startRuntimeLoop(env);
  console.log('[P2P-NODE] Runtime event loop started');
  let jurisdiction: JurisdictionConfig | null = null;
  let rpcUrl: string | null = null;
  let contracts: { depository: string; entityProvider: string; account: string; deltaTransformer: string } | null = null;

  if (useRpc) {
    const resolved = resolveJurisdiction();
    jurisdiction = resolved.jurisdiction;
    rpcUrl = resolved.rpcUrl;
    contracts = resolved.contracts;
    const entityProviderDeploymentBlock = resolved.entityProviderDeploymentBlock;

    const importJContracts = {
      depository: contracts.depository,
      entityProvider: contracts.entityProvider,
      account: contracts.account,
      deltaTransformer: contracts.deltaTransformer,
    };

    enqueueRuntimeInput(env, {
      runtimeTxs: [
        {
          type: 'importJ',
          data: {
            name: jurisdictionName,
            chainId: jurisdiction.chainId ?? 0,
            ticker: 'XLN',
            rpcs: [rpcUrl],
            entityProviderDeploymentBlock,
            contracts: importJContracts,
          },
        },
      ],
      entityInputs: [],
    });
    await processRuntime(env);
    await processRuntime(env);

    // J-event watching is handled by JAdapter.startWatching() per-jReplica
    console.log(`P2P_JADAPTER_READY role=${role} rpc=${rpcUrl}`);
  } else {
    enqueueRuntimeInput(env, {
      runtimeTxs: [
        {
          type: 'importJ',
          data: {
            name: jurisdictionName,
            chainId: 31337,
            ticker: 'XLN',
            rpcs: [],
          },
        },
      ],
      entityInputs: [],
    });
    await processRuntime(env);
    await processRuntime(env);

    const browserReplica = env.state.jReplicas.get(jurisdictionName);
    const browserAdapter = getLiveJAdapter(env, jurisdictionName);
    if (!browserReplica || !browserAdapter?.addresses.depository || !browserAdapter.addresses.entityProvider) {
      throw new Error(`P2P_BROWSERVM_JURISDICTION_MISSING: ${jurisdictionName}`);
    }
    jurisdiction = {
      name: browserReplica.name,
      address: 'browservm://',
      entityProviderAddress: browserAdapter.addresses.entityProvider,
      depositoryAddress: browserAdapter.addresses.depository,
      chainId: Number(browserAdapter.chainId || 31337),
    };
    console.log(`P2P_JADAPTER_READY role=${role} mode=browservm`);
  }

  // CRITICAL: Start relay AFTER env created so we can pass callbacks
  if (isHub && relayPort > 0) {
    let localDelivery: ReturnType<typeof createLocalDeliveryHandler> | null = null;
    startStandaloneRelayServer({
      host: relayHost,
      port: relayPort,
      serverId: role,
      ...(env.runtimeId ? { serverRuntimeId: env.runtimeId } : {}),  // Enable local delivery for messages to self
      onEntityInput: async (from, msg, store) => {
        localDelivery ??= createLocalDeliveryHandler(env, store, getEntityReplicaById);
        await localDelivery(from, msg);
      },
    });
    console.log(`P2P_RELAY_READY host=${relayHost} port=${relayPort}`);
  } else if (isHub) {
    throw new Error(`RELAY_PORT_MISSING: ${relayPort}`);
  }
  if (!env.runtimeId) {
    throw new Error(`RUNTIME_ID_MISSING: ${role}`);
  }

  const signerLabel = `${role}-validator`;

  // CRITICAL: Derive and register signer key BEFORE createLazyEntity
  // Otherwise resolveValidatorAddress will fail
  const seedBytes = new TextEncoder().encode(seed);
  const privateKey = deriveSignerKeySync(seedBytes, signerLabel);
  const signerId = deriveSignerAddressSync(seedBytes, signerLabel).toLowerCase();
  registerSignerKey(env, signerId, privateKey);

  const { config } = createLazyEntity(role, [signerId], 1n, jurisdiction ?? undefined, env);
  const entityId = generateLazyEntityId([signerId], 1n, env);

  enqueueRuntimeInput(env, {
    runtimeTxs: [
      createTestEntityImportRuntimeTx(env, {
        entityId,
        signerId,
        data: {
          config,
          isProposer: true,
          profileName: role,
          position: { x: 0, y: 0, z: 0 },
        },
      }),
    ],
    entityInputs: [],
  });
  await processRuntime(env);

  // Import installs the replica at height zero. Commit the initial Profile as
  // an Entity transaction before networking so it has a board Hanko; P2P must
  // never advertise an uncertified profile merely because transport is ready.
  enqueueRuntimeInput(env, {
    runtimeTxs: [],
    entityInputs: [{
      entityId,
      signerId,
      entityTxs: [{
        type: 'profile-update',
        data: {
          profile: {
            entityId,
            name: role,
            avatar: '',
            bio: '',
            website: '',
          },
        },
      }],
    }],
  });
  await processRuntime(env);

  console.log(`🔧 P2P_CONFIG: role=${role} entityId=${entityId.slice(-4)}`);

  const p2p = startP2P(env, {
    relayUrls: [relayUrl],
    seedRuntimeIds: seedRuntimeId ? [seedRuntimeId] : [],
    advertiseEntityIds: [entityId],
  });

  if (!p2p) {
    throw new Error('P2P_START_FAILED');
  }

  console.log(`P2P_NODE_READY role=${role} runtimeId=${env.runtimeId} entityId=${entityId}`);

  if (useRpc) {
    const jadapter = getActiveJAdapter(env);
    if (!jadapter) {
      throw new Error('JADAPTER_MISSING');
    }
    const tokenCatalog = isHub
      ? await ensureTokenCatalog(jadapter, true)
      : await waitForTokenCatalog(jadapter);
    const usdcToken = tokenCatalog.find(t => t.symbol === 'USDC') ?? tokenCatalog[0];
    if (!usdcToken) {
      throw new Error('TOKEN_CATALOG_EMPTY');
    }
    if (typeof usdcToken.tokenId === 'number') {
      USDC = usdcToken.tokenId;
    }
    await fundWalletAndDeposit(env, jadapter, usdcToken, entityId, signerId, FAUCET_DEPOSIT_AMOUNT);
    // RPC watcher default poll is 15s; force immediate fetch so reserve sync is not timing-sensitive.
    if (typeof jadapter.pollNow === 'function') {
      await jadapter.pollNow();
      await processRuntime(env);
      await processRuntime(env);
    }
    await waitForReserveBalance(env, entityId, signerId, USDC, FAUCET_DEPOSIT_AMOUNT, `${role}-faucet`);
    console.log(`P2P_FAUCET_READY role=${role} token=${usdcToken.symbol} reserve=${getReserveBalance(env, entityId, signerId, USDC)}`);
  }

  if (role === 'hub') {
    // Hub is relay server - wait for client profiles to arrive via gossip
    console.log('P2P_HUB_WAITING_FOR_PROFILES');

    // Hub's refresh function: poll relay (itself) for updated profiles
    const hubRefreshGossip = () => p2p.refreshGossip();

    // Give clients time to connect and send profiles
    await sleep(1000);

    const aliceProfile = await waitForProfile(env, 'alice', 60, hubRefreshGossip, true, true, true);
    const bobProfile = await waitForProfile(env, 'bob', 60, hubRefreshGossip, true, true, true);
    logProfile('hub sees alice', aliceProfile);
    logProfile('hub sees bob', bobProfile);
    console.log('P2P_GOSSIP_READY');

    // CRITICAL: Alice/Bob need time to:
    // 1. Receive hub profile
    // 2. Wait for hub to have their profile
    // 3. Send openAccount
    // So we need a longer timeout here
    console.log('HUB: Waiting for alice/bob to open accounts...');
    await waitForAccount(env, entityId, signerId, aliceProfile.entityId, 300);
    await waitForAccount(env, entityId, signerId, bobProfile.entityId, 300);
    logAccountState(env, entityId, signerId, aliceProfile.entityId, 'hub account after open');
    logAccountState(env, entityId, signerId, bobProfile.entityId, 'hub account after open');

    // Ensure both freshly opened hub-side accounts are stable before proposing credit-limit frames.
    await processUntil(
      env,
      () => {
        const aliceAcc = getAccount(env, entityId, signerId, aliceProfile.entityId);
        const bobAcc = getAccount(env, entityId, signerId, bobProfile.entityId);
        return !!aliceAcc && !!bobAcc && !aliceAcc.pendingFrame && !bobAcc.pendingFrame;
      },
      120,
      'hub-open-accounts-stable',
    );

    // Mutual credit: Hub extends to Alice, Alice extends to Hub
    await processRuntime(env, [
      {
        entityId,
        signerId,
        entityTxs: [
          { type: 'extendCredit', data: { counterpartyEntityId: aliceProfile.entityId, tokenId: USDC, amount: usd(500_000) } },
          { type: 'extendCredit', data: { counterpartyEntityId: bobProfile.entityId, tokenId: USDC, amount: usd(500_000) } },
        ],
      },
    ]);

    // CRITICAL: Wait for Alice/Bob to ACK our credit extension frames
    // Hub's extendCredit creates pendingFrames that need bilateral consensus completion
    console.log('HUB: Waiting for Alice/Bob to acknowledge credit extension...');

    // Helper to wait for specific account to have no pending frames
    const waitForHubAccountReady = async (counterpartyId: string, label: string, maxRounds = 300) => {
      await processUntil(
        env,
        () => {
          const account = getAccount(env, entityId, signerId, counterpartyId);
          // Account should exist, have no pending frame, and height > 1 (frame 2 committed)
          return !!account && !account.pendingFrame && account.currentHeight >= 2;
        },
        maxRounds,
        `hub-${label}-ack`,
        round => {
          if (round % 10 === 0) {
            logAccountState(env, entityId, signerId, counterpartyId, `hub wait ${label} round=${round}`);
            logQueues(env, `hub wait ${label} round=${round}`);
          }
        },
        () => {
          logAccountState(env, entityId, signerId, counterpartyId, `hub wait ${label} timeout`);
          logQueues(env, `hub wait ${label} timeout`);
        }
      );
    };

    // Wait for both accounts to have credit frames acknowledged
    await Promise.all([
      waitForHubAccountReady(aliceProfile.entityId, 'alice'),
      waitForHubAccountReady(bobProfile.entityId, 'bob'),
    ]);

    logAccountState(env, entityId, signerId, aliceProfile.entityId, 'hub-alice after hub credit ACK');
    logAccountState(env, entityId, signerId, bobProfile.entityId, 'hub-bob after hub credit ACK');

    // RE-ANNOUNCE: Profile now includes accounts with alice/bob
    console.log('HUB: Re-announcing profile with updated accounts...');
    p2p.updateConfig({});  // Triggers announceLocalProfiles()

    console.log('P2P_HUB_READY');

    let observedHtlcRoute = false;
    let reportedEndToEndSettlement = false;
    // Hub stays alive until the orchestrator observes bilateral convergence.
    while (true) {
      await processRuntime(env);
      const hubReplica = env.state.eReplicas.get(`${entityId}:${signerId}`);
      observedHtlcRoute ||= (hubReplica?.state.paybook.entries.size ?? 0) > 0;
      const accountsSettled = hubReplica
        ? Array.from(hubReplica.state.accounts.values()).every(account =>
            !account.pendingFrame
            && account.mempool.length === 0
            && account.state.locks.size === 0)
        : false;
      if (
        observedHtlcRoute
        && !reportedEndToEndSettlement
        && hubReplica?.state.paybook.entries.size === 0
        && accountsSettled
      ) {
        reportedEndToEndSettlement = true;
        console.log('P2P_END_TO_END_SETTLED');
      }
      await new Promise(resolve => setTimeout(resolve, 100));  // Process every 100ms
    }
  }

  const refreshGossip = seedRuntimeId
    ? () => p2p.requestGossip(seedRuntimeId)
    : undefined;
  const hubProfile = await waitForProfile(env, 'hub', 30, refreshGossip, true, true, true);
  logProfile(`${role} sees hub`, hubProfile);
  console.log('P2P_HUB_PROFILE_READY');

  // CRITICAL: Wait for hub to have our profile before opening account
  // Otherwise hub can't route ACKs back to us
  await waitForHubToHaveOurProfile(env, entityId, refreshGossip);

  await processRuntime(env, [
    { entityId, signerId, entityTxs: [{ type: 'openAccount', data: {
      targetEntityId: hubProfile.entityId,
      disputeConfig: defaultAccountDisputeConfigForParties(entityId, false, hubProfile.entityId, true),
    } }] },
  ]);

  await waitForAccount(env, entityId, signerId, hubProfile.entityId);
  await waitForAccountReady(env, entityId, signerId, hubProfile.entityId, 180);

  // STEP 1: Wait for HUB to extend credit to us (hub gives first)
  console.log(`${role.toUpperCase()}: Waiting for hub to extend credit...`);
  await waitForCreditLimit(env, entityId, signerId, hubProfile.entityId, usd(500_000), 300);
  console.log(`${role.toUpperCase()}: ✅ Hub extended credit to us`);

  // STEP 2: CLIENT extends credit to HUB (mutual credit)
  console.log(`${role.toUpperCase()}: Extending credit back to hub...`);
  await processRuntime(env, [
    {
      entityId,
      signerId,
      entityTxs: [
        { type: 'extendCredit', data: { counterpartyEntityId: hubProfile.entityId, tokenId: USDC, amount: usd(500_000) } },
      ],
    },
  ]);

  await waitForOwnCreditLimit(env, entityId, signerId, hubProfile.entityId, usd(500_000), 300);

  // ASSERT: Verify bidirectional capacity exists
  const accountAfterCredit = getAccount(env, entityId, signerId, hubProfile.entityId);
  if (!accountAfterCredit) throw new Error(`${role}: Account with hub missing after credit`);
  const deltaAfterCredit = accountAfterCredit.state.deltas?.get(USDC);
  if (!deltaAfterCredit) throw new Error(`${role}: No USDC delta after credit`);

  const { weAreLeft } = resolveSides(accountAfterCredit, entityId, hubProfile.entityId);
  const derived = deriveDelta(deltaAfterCredit, weAreLeft);
  const ourCreditLimit = derived.ownCreditLimit;
  const hubCreditLimit = derived.peerCreditLimit;

  console.log(`${role.toUpperCase()} CAPACITY CHECK:`);
  console.log(`  ${role}→Hub credit: ${ourCreditLimit} (we can owe hub)`);
  console.log(`  Hub→${role} credit: ${hubCreditLimit} (hub can owe us)`);

  if (ourCreditLimit <= 0n || hubCreditLimit <= 0n) {
    throw new Error(`${role}: NO CAPACITY - expected both credits > 0 (our=${ourCreditLimit}, hub=${hubCreditLimit})`);
  }

  console.log(`✅ ${role.toUpperCase()}: Bilateral capacity verified`);

  if (role === 'alice') {
    // The recipient must finish its bilateral credit frame before Alice sends.
    // Without this explicit scenario rendezvous, process scheduling decides
    // whether the Hub forwards the HTLC or correctly returns NoCapacity.
    if (waitForBobReady) {
      await waitForOrchestratorSignal('P2P_BOB_READY');
    }
    await waitForProfile(env, 'bob', 40, refreshGossip, true, true, true);
    const bobProfile = getProfileByName(env, 'bob');
    if (!bobProfile) throw new Error('BOB_PROFILE_MISSING');
    logProfile('alice sees bob', bobProfile);
    await waitForHubAccount(env, bobProfile.entityId, refreshGossip);

    if (useRpc) {
      const jadapter = getActiveJAdapter(env);
      if (!jadapter) {
        throw new Error('JADAPTER_MISSING_FOR_R2R');
      }
      const reserveBefore = await jadapter.getReserves(entityId, USDC);
      if (reserveBefore < R2R_AMOUNT) {
        throw new Error(`R2R_INSUFFICIENT_RESERVE: have=${reserveBefore} need=${R2R_AMOUNT}`);
      }

      await processRuntime(env, [
        {
          entityId,
          signerId,
          entityTxs: [
            {
              type: 'r2r',
              data: {
                toEntityId: bobProfile.entityId,
                tokenId: USDC,
                amount: R2R_AMOUNT,
              },
            },
            { type: 'j_broadcast', data: {} },
          ],
        },
      ]);

      let settled = false;
      for (let round = 1; round <= 300; round++) {
        const chainReserve = await jadapter.getReserves(entityId, USDC);
        if (chainReserve <= reserveBefore - R2R_AMOUNT) {
          settled = true;
          break;
        }
        await processRuntime(env);
        if (typeof jadapter.pollNow === 'function') {
          await jadapter.pollNow();
          await processRuntime(env);
        }
        if (round % 10 === 0) {
          console.log(
            `[P2P_DEBUG] alice-r2r round=${round} local=${getReserveBalance(env, entityId, signerId, USDC)} chain=${chainReserve}`,
          );
        }
        await sleep(10);
      }
      if (!settled) {
        const finalChain = await jadapter.getReserves(entityId, USDC);
        const finalLocal = getReserveBalance(env, entityId, signerId, USDC);
        throw new Error(
          `alice-r2r not satisfied after 300 rounds (chain=${finalChain}, local=${finalLocal}, expected<=${reserveBefore - R2R_AMOUNT})`,
        );
      }

      console.log('P2P_R2R_SENT');
    }

    console.log('='.repeat(80));
    console.log('ALICE SENDING HTLC PAYMENT TO BOB');
    console.log(`  Alice entityId: ${entityId}`);
    console.log(`  Hub entityId: ${hubProfile.entityId}`);
    console.log(`  Bob entityId: ${bobProfile.entityId}`);
    console.log(`  Route: Alice -> Hub -> Bob`);
    console.log(`  Amount: $${HTLC_AMOUNT / (10n ** DECIMALS)} USDC`);
    console.log('='.repeat(80));

    const secret = ethers.keccak256(ethers.toUtf8Bytes(`htlc-${entityId}-${bobProfile.entityId}`));
    const hashlock = hashHtlcSecret(secret);
    const aliceHubBefore = getAccount(env, entityId, signerId, hubProfile.entityId);
    const aliceHubDeltaBefore = aliceHubBefore?.state.deltas.get(USDC);
    if (!aliceHubBefore || !aliceHubDeltaBefore) {
      throw new Error('ALICE_HTLC_BASELINE_ACCOUNT_DELTA_MISSING');
    }
    const { weAreLeft: aliceIsLeft } = resolveSides(
      aliceHubBefore,
      entityId,
      hubProfile.entityId,
    );
    const outCapacityBefore = deriveDelta(aliceHubDeltaBefore, aliceIsLeft).outCapacity;

    await processRuntime(env, [
      {
        entityId,
        signerId,
        entityTxs: [
          withDeterministicHtlcTestSecret({
            type: 'htlcPayment',
            data: {
              targetEntityId: bobProfile.entityId,
              tokenId: USDC,
              amount: HTLC_AMOUNT,
              maxSenderDebit: quoteHtlcPaymentRoute(env.gossip.getProfiles(), [entityId, hubProfile.entityId, bobProfile.entityId], USDC, HTLC_AMOUNT).senderLockAmount,
              route: [entityId, hubProfile.entityId, bobProfile.entityId],
              deliveryMode: 'async',
              description: 'p2p-htlc',
              hashlock,
            },
          }, secret),
        ],
      },
    ]);

    console.log('ALICE: htlcPayment tx submitted to runtime');
    logEntityState(env, entityId, signerId, 'alice after HTLC submit');
    logAccountState(env, entityId, signerId, hubProfile.entityId, 'alice-hub account after HTLC');

    // Require the complete payer-side lifecycle, not a raw offdelta sign. The
    // signed delta is negative for LEFT payers and positive for RIGHT payers,
    // so `offdelta < 0` silently made this gate depend on deterministic entity
    // ordering. A completed payment has no pending frame, no unresolved lock
    // for this hashlock, and lower canonical outbound capacity than baseline.
    await processUntil(
      env,
      () => {
        const account = getAccount(env, entityId, signerId, hubProfile.entityId);
        const delta = account?.state.deltas?.get(USDC);
        const lockStillActive = Array.from(account?.state.locks.values() ?? [])
          .some(lock => lock.hashlock.toLowerCase() === hashlock.toLowerCase());
        return !!account
          && !account.pendingFrame
          && !!delta
          && !lockStillActive
          && deriveDelta(delta, aliceIsLeft).outCapacity < outCapacityBefore;
      },
      240,
      'alice-htlc-ack',
      round => {
        if (round % 10 === 0) {
          logAccountState(env, entityId, signerId, hubProfile.entityId, `alice wait htlc-ack round=${round}`);
          logQueues(env, `alice wait htlc-ack round=${round}`);
        }
      },
      () => {
        logAccountState(env, entityId, signerId, hubProfile.entityId, 'alice wait htlc-ack timeout');
        logQueues(env, 'alice wait htlc-ack timeout');
      }
    );

    console.log('P2P_HTLC_SENT');
    console.log('P2P_PAYMENT_SENT');
    // A participant cannot prove global completion from its local Account
    // alone. Keep servicing the real transport until the parent orchestrator
    // observes Hub-side route removal plus bilateral quiescence and terminates
    // every child together. Exiting here can drop the final ACK after the
    // recipient has committed locally but before the sender learns the secret.
    while (stayAliveAfterPayment) {
      await processRuntime(env);
      await sleep(25);
    }
    return;
  }

  if (role === 'bob') {
    await waitForAccountReady(env, entityId, signerId, hubProfile.entityId, 180);
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
    await processRuntime(env, [
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
    await waitForOwnCreditLimit(env, entityId, signerId, hubProfile.entityId, creditAmount, 60);
    console.log('P2P_BOB_READY');

    if (useRpc) {
      const reserveBefore = getReserveBalance(env, entityId, signerId, USDC);
      await waitForReserveBalance(
        env,
        entityId,
        signerId,
        USDC,
        reserveBefore + R2R_AMOUNT,
        'bob-r2r'
      );
      console.log('P2P_R2R_RECEIVED');
    }

    await waitForPayment(env, entityId, signerId, hubProfile.entityId, 240);
    console.log('P2P_HTLC_RECEIVED');
    console.log('P2P_PAYMENT_RECEIVED');
    // Receiving the downstream frame is not end-to-end completion. Keep the
    // real recipient runtime alive so its ACK reaches the Hub and the Hub can
    // propagate the preimage into Alice's upstream Account. The orchestrator
    // terminates all nodes only after Alice proves that final resolution.
    while (stayAliveAfterPayment) {
      await processRuntime(env);
      await sleep(25);
    }
    return;
  }
};

run().catch(error => {
  console.error('P2P_NODE_FATAL', error);
  globalThis.process.exit(1);
});

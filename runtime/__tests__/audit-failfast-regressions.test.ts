import { describe, expect, test } from 'bun:test';
import { x25519 } from '@noble/curves/ed25519.js';

import { handleAccountInput, proposeAccountFrame } from '../account-consensus';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey, signAccountFrame } from '../account-crypto';
import { deriveAccountWatchSeed } from '../account-watch-seed';
import { handleHtlcLock } from '../account-tx/handlers/htlc-lock';
import { handleHtlcResolve } from '../account-tx/handlers/htlc-resolve';
import { checkAutoRebalance, handleRequestCollateral } from '../account-tx/handlers/request-collateral';
import { handleSwapOffer } from '../account-tx/handlers/swap-offer';
import { createFrameHash, MAX_ACCOUNT_FRAME_TXS } from '../account-consensus-frame';
import { LIMITS } from '../constants';
import { ACCOUNT_PENDING_RESEND_AFTER_MS, executeCrontab, initCrontab } from '../entity-crontab';
import { generateLazyEntityId, generateNumberedEntityId } from '../entity-factory';
import { isLeftEntity } from '../entity-id-utils';
import {
  CROSS_J_PENDING_FILL_ACK_TTL_MS,
  applyEntityFrame,
  applyEntityInput,
} from '../entity-consensus';
import { createEntityFrameHash } from '../entity-consensus-frame';
import {
  assertCrossJurisdictionOrderAdmissible,
  findCrossJurisdictionBookAdmissionForAck,
} from '../entity-consensus/cross-j-orderbook';
import {
  buildCrossJurisdictionBookAdmissionReceipt,
  buildCrossJurisdictionMarketOffer,
  getCrossJurisdictionBookAdmissionError,
  mergeCrossJurisdictionBookAdmission,
} from '../cross-jurisdiction-orderbook';
import {
  buildCrossJurisdictionPullBinding,
  buildCrossJurisdictionCloseProof,
  buildCrossJurisdictionPullReveal,
  buildPreparedCrossJurisdictionRoute,
  deriveCrossJurisdictionPrivateSeed,
  withCanonicalCrossJurisdictionRouteHash,
} from '../cross-jurisdiction';
import { applyEntityTx } from '../entity-tx/apply';
import { applyCommittedCrossJurisdictionAccountTxFollowup } from '../entity-tx/handlers/account-cross-j-followups';
import { applyCommittedHtlcLockFollowup } from '../entity-tx/handlers/account/committed-htlc-followups';
import { handleAdmitCrossJurisdictionBookOrderEntityTx } from '../entity-tx/handlers/cross-j-book-order';
import { handleDisputeFinalize, handleDisputeStart, handlePrepareDispute } from '../entity-tx/handlers/dispute';
import { handleJAbortSentBatch } from '../entity-tx/handlers/j-abort-sent-batch';
import { handleJRebroadcast } from '../entity-tx/handlers/j-rebroadcast';
import { processSettleAction } from '../entity-tx/handlers/settle';
import { handleJEvent } from '../entity-tx/j-events';
import { tryFinalizeAccountJEvents } from '../entity-tx/j-events-account';
import { queueCrossJurisdictionSalvageFromArgumentList } from '../entity-tx/j-events-htlc';
import {
  buildJEventObservationDigest,
  canonicalJurisdictionEventsHash,
} from '../j-event-observation';
import { getRuntimeJurisdictionHeight } from '../j-height';
import { createEmptyBatch } from '../j-batch';
import { applyCommand, createBook, getBookOrder, ORDERBOOK_PRICE_SCALE, SWAP_LOT_SCALE, type OrderbookExtState } from '../orderbook';
import { process, createEmptyEnv, registerEntityRuntimeHint, sendEntityInput, validateRuntimeInputAdmission } from '../runtime';
import { submitRuntimeJOutbox } from '../runtime-j-submit';
import { safeStringify } from '../serialization-utils';
import { projectAccountDoc } from '../storage/projections';
import { createDefaultDelta } from '../validation-utils';
import { captureDisputeArgumentSnapshot, storeDisputeArgumentSnapshot } from '../dispute-arguments';
import { buildAccountProofBody, createDisputeProofHashWithNonce } from '../proof-builder';
import { buildRealHanko } from '../hanko/core';
import { signEntityHashes, verifyHankoForHash } from '../hanko/signing';
import { NobleCryptoProvider } from '../crypto-noble';
import { handleMeshBootstrapLoopError } from '../orchestrator/mesh-bootstrap-fail-fast';
import { fitCrossAmountsToOrderbook } from '../orchestrator/mm-node';
import { resolveEntityProposerId } from '../state-helpers';
import type { AccountInput, AccountMachine, AccountTx, ConsensusConfig, CrossJurisdictionSwapRoute, EntityInput, EntityReplica, EntityState, Env, JurisdictionEvent } from '../types';
import { ethers } from 'ethers';

const makeSingleSignerConfig = (): ConsensusConfig => ({
  mode: 'proposer-based',
  threshold: 1n,
  validators: ['1'],
  shares: { '1': 1n },
});

const makeSingleSignerConfigFor = (signerId: string): ConsensusConfig => ({
  mode: 'proposer-based',
  threshold: 1n,
  validators: [signerId],
  shares: { [signerId]: 1n },
});

const hex20 = (byte: string): string => `0x${byte.repeat(byte.length === 2 ? 20 : 40)}`;
const hexBytes = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
const bufferFromHex = (value: string): Buffer => Buffer.from(value.replace(/^0x/, ''), 'hex');
const hashHankoBoard = (threshold: number, boardEntityIds: string[], weights: number[]): string => {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(abiCoder.encode(
    ['tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)'],
    [[threshold, boardEntityIds, weights, 0, 0, 0]],
  )).toLowerCase();
};
const encodeHankoForTest = (hanko: Awaited<ReturnType<typeof buildRealHanko>>): string => {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return abiCoder.encode(
    ['tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256)[])'],
    [[
      hanko.placeholders.map(hexBytes),
      hexBytes(hanko.packedSignatures),
      hanko.claims.map((claim) => [
        hexBytes(claim.entityId),
        claim.entityIndexes,
        claim.weights,
        claim.threshold,
      ]),
    ]],
  );
};
const makeEmptyProofBody = () => ({
  watchSeed: `0x${'f1'.repeat(32)}`,
  offdeltas: [],
  tokenIds: [],
  transformers: [],
});

const makeProposalAccount = (
  mempool: AccountTx[],
  leftEntity: string,
  rightEntity: string,
): AccountMachine => {
  return {
    leftEntity,
    rightEntity,
    status: 'active',
    mempool: [...mempool],
    currentFrame: {
      height: 0,
      timestamp: 0,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '',
      deltas: [],
      stateHash: '',
      byLeft: true,
    },
    deltas: new Map(),
    locks: new Map(),
    swapOffers: new Map(),
    globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
    currentHeight: 0,
    pendingSignatures: [],
    rollbackCount: 0,
    proofHeader: { fromEntity: leftEntity, toEntity: rightEntity, nonce: 0 },
    proofBody: { tokenIds: [], deltas: [] },
    frameHistory: [],
    pendingWithdrawals: new Map(),
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
    rebalancePolicy: new Map(),
    leftJObservations: [],
    rightJObservations: [],
    jEventChain: [],
    lastFinalizedJHeight: 0,
    watchSeed: deriveAccountWatchSeed({
      runtimeSeed: 'audit-failfast-test-helper',
      entityId: leftEntity,
      counterpartyId: rightEntity,
      timestamp: 0,
    }),
    disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
    onChainSettlementNonce: 0,
  } as AccountMachine;
};

const attachSigningReplica = (
  env: ReturnType<typeof createEmptyEnv>,
  entityId: string,
  signerId: string,
): void => {
  env.eReplicas.set(
    `${entityId}:${signerId}`,
    {
      entityId,
      signerId,
      mempool: [],
      isProposer: true,
      state: {
        entityId,
        config: makeSingleSignerConfigFor(signerId),
      },
    } as unknown as EntityReplica,
  );
};

const registerLazySigner = (
  seed: string,
  signerSlot: string,
): { signerId: string; entityId: string } => {
  const signerId = deriveSignerAddressSync(seed, signerSlot);
  const privateKey = deriveSignerKeySync(seed, signerSlot);
  registerSignerKey(signerId, privateKey);
  return {
    signerId,
    entityId: generateLazyEntityId([signerId], 1n).toLowerCase(),
  };
};

const signJEventObservation = (
  env: ReturnType<typeof createEmptyEnv>,
  entityId: string,
  signerId: string,
  input: {
    blockNumber: number;
    blockHash: string;
    transactionHash: string;
    events: JurisdictionEvent[];
  },
): { eventsHash: string; signature: string } => {
  const eventsHash = canonicalJurisdictionEventsHash(input.events);
  const signature = signAccountFrame(
    env,
    signerId,
    buildJEventObservationDigest({
      entityId,
      signerId,
      blockNumber: input.blockNumber,
      blockHash: input.blockHash,
      transactionHash: input.transactionHash,
      eventsHash,
    }),
  );
  return { eventsHash, signature };
};

const makeReplicaMissingPrevFrameHash = (): EntityReplica => ({
  entityId: `0x${'11'.repeat(32)}`,
  signerId: '1',
  mempool: [],
  isProposer: true,
  state: {
    entityId: `0x${'11'.repeat(32)}`,
    height: 1,
    timestamp: 0,
    nonces: new Map(),
    messages: [],
    proposals: new Map(),
    config: makeSingleSignerConfig(),
    reserves: new Map(),
    accounts: new Map(),
    deferredAccountProposals: new Map(),
    lastFinalizedJHeight: 0,
    jBlockObservations: [],
    jBlockChain: [],
    entityEncPubKey: `0x${'33'.repeat(32)}`,
    entityEncPrivKey: `0x${'44'.repeat(32)}`,
    profile: {
      name: 'Audit Entity',
      isHub: false,
      avatar: '',
      bio: '',
      website: '',
    },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    htlcNotes: new Map(),
    lockBook: new Map(),
    swapTradingPairs: [],
    pendingSwapFillRatios: new Map(),
    crontabState: initCrontab(),
  },
});

const makeEntityState = (entityId: string): EntityState => ({
  entityId,
  height: 0,
  timestamp: 1_000,
  nonces: new Map(),
  messages: [],
  proposals: new Map(),
  config: makeSingleSignerConfig(),
  reserves: new Map(),
  accounts: new Map(),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 0,
  jBlockObservations: [],
  jBlockChain: [],
  entityEncPubKey: `0x${'55'.repeat(32)}`,
  entityEncPrivKey: `0x${'66'.repeat(32)}`,
  profile: {
    name: 'Audit Entity',
    isHub: false,
    avatar: '',
    bio: '',
    website: '',
  },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  htlcNotes: new Map(),
  lockBook: new Map(),
  swapTradingPairs: [],
  pendingSwapFillRatios: new Map(),
});

describe('audit fail-fast regressions', () => {
  test('jurisdiction-specific runtime height ignores higher sibling chain tip', () => {
    const env = createEmptyEnv('jurisdiction-height-specificity');
    env.activeJurisdiction = 'Tron';
    env.jReplicas = new Map([
      ['Testnet', { name: 'Testnet', blockNumber: 3145n }],
      ['Tron', { name: 'Tron', blockNumber: 5794n }],
    ] as any);

    expect(getRuntimeJurisdictionHeight(env, 0, 'Testnet')).toBe(3145);
    expect(getRuntimeJurisdictionHeight(env, 5794, 'Testnet')).toBe(3145);
    expect(getRuntimeJurisdictionHeight(env, 0, 'Tron')).toBe(5794);
    expect(getRuntimeJurisdictionHeight(env, 0)).toBe(5794);
  });

  test('cross-j system entity txs reject remote hops outside the two-runtime route topology', async () => {
    const env = createEmptyEnv('cross-j-intra-runtime-boundary');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const remoteRuntime = `0x${'99'.repeat(20)}`;

    await expect(process(env, [{
      from: remoteRuntime,
      entityId: `0x${'11'.repeat(32)}`,
      signerId: `0x${'01'.repeat(20)}`,
      entityTxs: [{
        type: 'requestCrossJurisdictionSwap',
        data: { route: {} },
      } as any],
    }])).rejects.toThrow('RUNTIME_CROSS_J_TOPOLOGY_INVALID');

    expect(() => sendEntityInput(env, {
      entityId: `0x${'22'.repeat(32)}`,
      signerId: `0x${'02'.repeat(20)}`,
      entityTxs: [{
        type: 'registerCrossJurisdictionSwap',
        data: { route: {} },
      } as any],
    })).toThrow('ROUTE_TARGET_RUNTIME_UNKNOWN');

    registerEntityRuntimeHint(env, `0x${'22'.repeat(32)}`, remoteRuntime);
    expect(() => sendEntityInput(env, {
      entityId: `0x${'22'.repeat(32)}`,
      entityTxs: [{
        type: 'registerCrossJurisdictionSwap',
        data: { route: {} },
      } as any],
    })).toThrow('CROSS_J_REMOTE_TOPOLOGY_INVALID');
  });

  test('runtime ingress retargets stale signer hints only when the local target entity has one replica', async () => {
    const env = createEmptyEnv('stale-signer-retarget');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const entityId = `0x${'81'.repeat(32)}`;
    const actualSignerId = `0x${'83'.repeat(20)}`;
    const staleSignerId = `0xb262${'00'.repeat(18)}`;
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(actualSignerId);
    env.eReplicas.set(`${entityId}:${actualSignerId}`, {
      entityId,
      signerId: actualSignerId,
      mempool: [],
      isProposer: true,
      state,
    });

    await expect(process(env, [{
      entityId,
      signerId: staleSignerId,
      entityTxs: [],
    }])).resolves.toBe(env);
    expect(env.eReplicas.has(`${entityId}:${actualSignerId}`)).toBe(true);
  });

  test('runtime ingress rejects stale signer hints for tx-bearing inputs even with one local replica', async () => {
    const env = createEmptyEnv('stale-signer-tx-bearing');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const entityId = `0x${'84'.repeat(32)}`;
    const actualSignerId = `0x${'85'.repeat(20)}`;
    const staleSignerId = `0x${'86'.repeat(20)}`;
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(actualSignerId);
    env.eReplicas.set(`${entityId}:${actualSignerId}`, {
      entityId,
      signerId: actualSignerId,
      mempool: [],
      isProposer: true,
      state,
    });

    await expect(process(env, [{
      entityId,
      signerId: staleSignerId,
      entityTxs: [{
        type: 'openAccount',
        data: {
          targetEntityId: `0x${'87'.repeat(32)}`,
          tokenId: 1,
          creditAmount: 1n,
        },
      }],
    }])).rejects.toThrow('RUNTIME_REPLICA_NOT_FOUND');
  });

  test('live runtime rejects stale signer tx-bearing inputs instead of dropping them', async () => {
    const env = createEmptyEnv('stale-signer-live-drop');
    env.scenarioMode = false;
    env.quietRuntimeLogs = true;
    const entityId = `0x${'94'.repeat(32)}`;
    const actualSignerId = `0x${'95'.repeat(20)}`;
    const staleSignerId = `0x${'96'.repeat(20)}`;
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(actualSignerId);
    env.eReplicas.set(`${entityId}:${actualSignerId}`, {
      entityId,
      signerId: actualSignerId,
      mempool: [],
      isProposer: true,
      state,
    });

    await expect(process(env, [{
      entityId,
      signerId: staleSignerId,
      entityTxs: [{
        type: 'openAccount',
        data: {
          targetEntityId: `0x${'97'.repeat(32)}`,
          tokenId: 1,
          creditAmount: 1n,
        },
      }],
    }])).rejects.toThrow('RUNTIME_REPLICA_NOT_FOUND');
    expect(env.runtimeState?.quarantinedRuntimeInputs?.[0]?.action).toBe('halted');
    expect(env.eReplicas.get(`${entityId}:${actualSignerId}`)?.state.accounts.size).toBe(0);
  });

  test('live runtime quarantines invalid ingress once instead of requeueing a crash loop', async () => {
    const env = createEmptyEnv('invalid-live-ingress-quarantine');
    env.scenarioMode = false;
    env.quietRuntimeLogs = true;
    const entityId = `0x${'98'.repeat(32)}`;

    await expect(process(env, [{
      entityId,
      signerId: ' ',
      entityTxs: [{
        type: 'openAccount',
        data: {
          targetEntityId: `0x${'99'.repeat(32)}`,
          tokenId: 1,
          creditAmount: 1n,
        },
      }],
    }])).rejects.toThrow('FINANCIAL-SAFETY: signerId is missing');

    const quarantine = env.runtimeState?.quarantinedRuntimeInputs ?? [];
    expect(quarantine.length).toBe(1);
    expect(quarantine[0]?.reason).toBe('FINANCIAL-SAFETY:');
    expect(quarantine[0]?.action).toBe('halted');
    expect(quarantine[0]?.counts.entityInputs).toBe(1);
    expect(env.runtimeMempool?.entityInputs.length).toBe(0);

    await expect(process(env)).resolves.toBe(env);
    expect(env.runtimeState?.quarantinedRuntimeInputs?.length).toBe(1);
    expect(env.runtimeMempool?.entityInputs.length).toBe(0);
  });

  test('local signer resolution prefers an available local signer over stale config validator fallback', () => {
    const env = createEmptyEnv('local-signer-resolution-stale-config');
    env.scenarioMode = false;
    env.quietRuntimeLogs = true;
    const { entityId, signerId: actualSignerId } = registerLazySigner('local-signer-resolution-stale-config', 'actual');
    const staleConfigSignerId = `0x${'9c'.repeat(20)}`;
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(staleConfigSignerId);
    env.eReplicas.set(`${entityId}:${actualSignerId}`, {
      entityId,
      signerId: actualSignerId,
      mempool: [],
      isProposer: false,
      state,
    });

    expect(resolveEntityProposerId(env, entityId, 'audit')).toBe(actualSignerId);
  });

  test('remote signer resolution trusts gossip board over imported replica signer fallback', () => {
    const env = createEmptyEnv('remote-signer-resolution-gossip-board');
    env.scenarioMode = false;
    env.quietRuntimeLogs = true;
    const entityId = `0x${'9d'.repeat(32)}`;
    const importedUserSignerId = `0x${'9e'.repeat(20)}`;
    const hubSignerId = `0x${'9f'.repeat(20)}`;
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(importedUserSignerId);
    env.eReplicas.set(`${entityId}:${importedUserSignerId}`, {
      entityId,
      signerId: importedUserSignerId,
      mempool: [],
      isProposer: false,
      state,
    } as unknown as EntityReplica);
    env.gossip = {
      getProfiles: () => [{
        entityId,
        metadata: {
          board: {
            validators: [{ signerId: hubSignerId }],
          },
        },
      }],
    } as Env['gossip'];

    expect(resolveEntityProposerId(env, entityId, 'remote-output')).toBe(hubSignerId);
  });

  test('runtime input admission rejects tx-bearing stale signer before enqueue', () => {
    const env = createEmptyEnv('runtime-input-admission-stale-signer');
    env.scenarioMode = false;
    env.quietRuntimeLogs = true;
    const { entityId, signerId } = registerLazySigner('runtime-input-admission-stale-signer', '1');
    const staleSignerId = `0x${'9d'.repeat(20)}`;
    attachSigningReplica(env, entityId, signerId);

    expect(() => validateRuntimeInputAdmission(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId,
        signerId: staleSignerId,
        entityTxs: [{
          type: 'openAccount',
          data: {
            targetEntityId: `0x${'9e'.repeat(32)}`,
            tokenId: 1,
            creditAmount: 1n,
          },
        }],
      }],
    })).toThrow('RUNTIME_REPLICA_NOT_FOUND');
    expect(env.runtimeMempool?.entityInputs.length).toBe(0);
  });

  test('hub mesh bootstrap loop fail-fasts unexpected errors instead of logging forever', () => {
    let cleared = 0;
    const exits: number[] = [];
    const logs: unknown[][] = [];

    const halted = handleMeshBootstrapLoopError(new Error('BROKEN_BOOTSTRAP_INVARIANT'), {
      nodeName: 'H1',
      clearLoop: () => { cleared += 1; },
      exit: (code) => { exits.push(code); },
      logError: (...args) => { logs.push(args); },
    });

    expect(halted).toBe(true);
    expect(cleared).toBe(1);
    expect(exits).toEqual([1]);
    expect(String(logs[0]?.[0] || '')).toContain('mesh bootstrap tick fatal');

    const ignored = handleMeshBootstrapLoopError(new Error('fetch failed'), {
      nodeName: 'H1',
      clearLoop: () => { cleared += 1; },
      exit: (code) => { exits.push(code); },
      logError: (...args) => { logs.push(args); },
    });

    expect(ignored).toBe(false);
    expect(cleared).toBe(1);
    expect(exits).toEqual([1]);
  });

  test('runtime input admission accounts for importReplica earlier in the same batch', () => {
    const env = createEmptyEnv('runtime-input-admission-import-replica');
    env.scenarioMode = false;
    env.quietRuntimeLogs = true;
    const entityId = `0x${'9f'.repeat(32)}`;
    const signerId = `0x${'a0'.repeat(20)}`;

    expect(() => validateRuntimeInputAdmission(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId,
        signerId,
        data: {
          config: makeSingleSignerConfigFor(signerId),
          isProposer: true,
        },
      }],
      entityInputs: [{
        entityId,
        signerId,
        entityTxs: [],
      }],
    })).not.toThrow();
  });

  test('cross-j salvage routes tx-bearing output to route target signer over stale gossip signer', () => {
    const env = createEmptyEnv('cross-j-salvage-route-signer');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.timestamp = 10_000;
    const sourceUser = `0x${'a1'.repeat(32)}`;
    const sourceHub = `0x${'a2'.repeat(32)}`;
    const targetHub = `0x${'a3'.repeat(32)}`;
    const targetUser = `0x${'a4'.repeat(32)}`;
    const sourceSigner = `0x${'b1'.repeat(20)}`;
    const sourceHubSigner = `0x${'b2'.repeat(20)}`;
    const targetHubSigner = `0x${'b3'.repeat(20)}`;
    const targetSigner = `0x${'b4'.repeat(20)}`;
    const staleGossipSigner = `0x${'b5'.repeat(20)}`;
    const sourceState = makeEntityState(sourceUser);
    sourceState.config = makeSingleSignerConfigFor(sourceSigner);
    sourceState.crossJurisdictionSwaps = new Map();
    (env as Env & { gossip?: { getProfiles: () => unknown[] } }).gossip = {
      getProfiles: () => [{
        entityId: targetUser,
        metadata: { board: { validators: [{ signerId: staleGossipSigner }] } },
      }],
    };

    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'salvage-route-signer',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      sourceSignerId: sourceSigner,
      sourceHubSignerId: sourceHubSigner,
      targetHubSignerId: targetHubSigner,
      targetSignerId: targetSigner,
      source: {
        jurisdiction: `stack:1:0x${'c1'.repeat(20)}`,
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 100n,
      },
      target: {
        jurisdiction: `stack:2:0x${'c2'.repeat(20)}`,
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 2,
        amount: 200n,
      },
      status: 'resting',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
    }, {
      runtimeSeed: 'cross-j-salvage-route-signer',
      sourceDisputeDelayMs: 5_000,
      now: env.timestamp,
    });
    sourceState.crossJurisdictionSwaps.set(route.orderId, route);

    const binary = buildCrossJurisdictionPullReveal(
      route,
      0x1234,
      deriveCrossJurisdictionPrivateSeed('cross-j-salvage-route-signer', route),
    ).binary;
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const crossPullArgs = abiCoder.encode(
      ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
      [{ fillRatios: [], secrets: [], pulls: [binary] }],
    );
    const starterInitialArguments = abiCoder.encode(['bytes[]'], [[crossPullArgs]]);
    const outputs: EntityInput[] = [];

    expect(queueCrossJurisdictionSalvageFromArgumentList(
      env,
      sourceState,
      outputs,
      sourceHub,
      [starterInitialArguments],
      123,
    )).toBe(true);

    const salvageOutput = outputs.find((output) => output.entityTxs?.some((tx) => tx.type === 'crossJurisdictionSalvage'));
    expect(salvageOutput?.entityId).toBe(targetUser);
    expect(salvageOutput?.signerId).toBe(targetSigner);
    expect(salvageOutput?.signerId).not.toBe(staleGossipSigner);
  });

  test('runtime ingress still rejects stale signer hints when local target signer is ambiguous', async () => {
    const env = createEmptyEnv('stale-signer-ambiguous');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const entityId = `0x${'82'.repeat(32)}`;
    const signerA = `0x${'a1'.repeat(20)}`;
    const signerB = `0x${'b1'.repeat(20)}`;
    const staleSignerId = `0x${'cc'.repeat(20)}`;
    for (const signerId of [signerA, signerB]) {
      const state = makeEntityState(entityId);
      state.config = makeSingleSignerConfigFor(signerId);
      env.eReplicas.set(`${entityId}:${signerId}`, {
        entityId,
        signerId,
        mempool: [],
        isProposer: signerId === signerA,
        state,
      });
    }

    await expect(process(env, [{
      entityId,
      signerId: staleSignerId,
      entityTxs: [],
    }])).rejects.toThrow('RUNTIME_REPLICA_NOT_FOUND');
  });

  test('process requeues oversized runtime input instead of silently dropping it', async () => {
    const env = createEmptyEnv('audit-regression-seed');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;

    const inputs = Array.from({ length: 10001 }, (_, i) => ({
      entityId: `0x${i.toString(16).padStart(64, '0')}`,
      entityTxs: [],
    }));

    await expect(process(env, inputs)).rejects.toThrow('Too many entity inputs');
    expect(env.height).toBe(0);
    expect(env.runtimeMempool?.entityInputs.length).toBe(10001);
  });

  test('safeStringify throws instead of hashing a placeholder string', () => {
    expect(() => safeStringify({ bad: new Date(Number.NaN) })).toThrow('SAFE_STRINGIFY_FAILED');
  });

  test('hanko verification requires the target claim to meet EOA-only threshold', async () => {
    const hash = `0x${'ab'.repeat(32)}`;
    const signerPrivateKey = deriveSignerKeySync('hanko-eoa-threshold-divergence', '1');
    const signerAddress = deriveSignerAddressSync('hanko-eoa-threshold-divergence', '1');
    const signerEntityId = ethers.zeroPadValue(signerAddress, 32).toLowerCase();
    const nestedEntityId = hashHankoBoard(1, [signerEntityId], [1]);
    const rootEntityId = hashHankoBoard(100, [signerEntityId, nestedEntityId], [40, 60]);
    const hanko = await buildRealHanko(bufferFromHex(hash), {
      noEntities: [],
      privateKeys: [signerPrivateKey],
      claims: [
        {
          entityId: bufferFromHex(nestedEntityId),
          entityIndexes: [0],
          weights: [1],
          threshold: 1,
        },
        {
          entityId: bufferFromHex(rootEntityId),
          entityIndexes: [0, 1],
          weights: [40, 60],
          threshold: 100,
        },
      ],
    });

    const result = await verifyHankoForHash(encodeHankoForTest(hanko), hash, rootEntityId);

    // Regression: the contract requires EOA signer weight to satisfy threshold
    // independently. Nested assumed-yes weight can contribute to total power,
    // but cannot make an unenforceable off-chain proof look valid.
    expect(result.valid).toBe(false);
    expect(result.entityId).toBeNull();
  });

  test('registered hanko verification accepts a board that matches local registered config', async () => {
    const hash = `0x${'bc'.repeat(32)}`;
    const env = createEmptyEnv('registered-hanko-board-positive');
    const signerPrivateKey = deriveSignerKeySync('registered-hanko-board-positive', '1');
    const signerAddress = deriveSignerAddressSync('registered-hanko-board-positive', '1').toLowerCase();
    const entityId = generateNumberedEntityId(42).toLowerCase();
    const config: ConsensusConfig = {
      mode: 'proposer-based',
      threshold: 1n,
      validators: [signerAddress],
      shares: { [signerAddress]: 1n },
    };
    env.eReplicas.set(`${entityId}:${signerAddress}`, {
      entityId,
      signerId: signerAddress,
      mempool: [],
      isProposer: true,
      state: { entityId, config },
    } as unknown as EntityReplica);
    const hanko = await buildRealHanko(bufferFromHex(hash), {
      noEntities: [],
      privateKeys: [signerPrivateKey],
      claims: [{
        entityId: bufferFromHex(entityId),
        entityIndexes: [0],
        weights: [1],
        threshold: 1,
      }],
    });

    const result = await verifyHankoForHash(encodeHankoForTest(hanko), hash, entityId, env);

    expect(result.valid).toBe(true);
    expect(result.entityId?.toLowerCase()).toBe(entityId);
  });

  test('registered hanko verification rejects forged self-contained board without local board of record', async () => {
    const hash = `0x${'bd'.repeat(32)}`;
    const signerPrivateKey = deriveSignerKeySync('registered-hanko-board-missing', '1');
    const entityId = generateNumberedEntityId(43).toLowerCase();
    const hanko = await buildRealHanko(bufferFromHex(hash), {
      noEntities: [],
      privateKeys: [signerPrivateKey],
      claims: [{
        entityId: bufferFromHex(entityId),
        entityIndexes: [0],
        weights: [1],
        threshold: 1,
      }],
    });

    const result = await verifyHankoForHash(encodeHankoForTest(hanko), hash, entityId);

    expect(result.valid).toBe(false);
    expect(result.entityId).toBeNull();
  });

  test('registered hanko verification rejects forged board even when signer is a real validator', async () => {
    const hash = `0x${'be'.repeat(32)}`;
    const env = createEmptyEnv('registered-hanko-board-mismatch');
    const signerPrivateKey = deriveSignerKeySync('registered-hanko-board-mismatch', '1');
    const signerAddress = deriveSignerAddressSync('registered-hanko-board-mismatch', '1').toLowerCase();
    const cosignerAddress = deriveSignerAddressSync('registered-hanko-board-mismatch', '2').toLowerCase();
    const entityId = generateNumberedEntityId(44).toLowerCase();
    const config: ConsensusConfig = {
      mode: 'proposer-based',
      threshold: 2n,
      validators: [signerAddress, cosignerAddress],
      shares: { [signerAddress]: 1n, [cosignerAddress]: 1n },
    };
    env.eReplicas.set(`${entityId}:${signerAddress}`, {
      entityId,
      signerId: signerAddress,
      mempool: [],
      isProposer: true,
      state: { entityId, config },
    } as unknown as EntityReplica);
    const forgedHanko = await buildRealHanko(bufferFromHex(hash), {
      noEntities: [],
      privateKeys: [signerPrivateKey],
      claims: [{
        entityId: bufferFromHex(entityId),
        entityIndexes: [0],
        weights: [1],
        threshold: 1,
      }],
    });

    const result = await verifyHankoForHash(encodeHankoForTest(forgedHanko), hash, entityId, env);

    expect(result.valid).toBe(false);
    expect(result.entityId).toBeNull();
  });

  test('j_event rejects non-validator signer ids before observation aggregation', async () => {
    const state = makeEntityState(`0x${'11'.repeat(32)}`);
    const env = createEmptyEnv('j-event-non-validator');

    await expect(handleJEvent(state, {
      from: 'not-a-validator',
      observedAt: 1_000,
      blockNumber: 1,
      blockHash: `0x${'22'.repeat(32)}`,
      transactionHash: `0x${'33'.repeat(32)}`,
      event: {
        type: 'ReserveUpdated',
        data: {
          entity: state.entityId,
          tokenId: 1,
          newBalance: '100',
        },
      },
    }, env)).rejects.toThrow('j_event rejected: non-validator signer');
  });

  test('single-validator j_event observations must still be signed by the claimed signer', async () => {
    const seed = 'j-event-single-validator-signature';
    const env = createEmptyEnv(seed);
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(signerId);
    const event: JurisdictionEvent = {
      type: 'ReserveUpdated',
      data: { entity: entityId, tokenId: 1, newBalance: '100' },
    };
    const common = {
      from: signerId,
      observedAt: 1_000,
      blockNumber: 2,
      blockHash: `0x${'12'.repeat(32)}`,
      transactionHash: `0x${'13'.repeat(32)}`,
      event,
    };
    const signed = signJEventObservation(env, entityId, signerId, {
      blockNumber: common.blockNumber,
      blockHash: common.blockHash,
      transactionHash: common.transactionHash,
      events: [event],
    });

    await expect(handleJEvent(state, { ...common } as any, env)).rejects.toThrow(
      'missing eventsHash',
    );
    await expect(handleJEvent(state, { ...common, eventsHash: signed.eventsHash } as any, env)).rejects.toThrow(
      'missing observation signature',
    );

    const result = await handleJEvent(state, { ...common, ...signed }, env);
    expect(result.newState.jBlockChain.length).toBe(1);
    expect(result.newState.reserves.get(1)).toBe(100n);
  });

  test('AccountSettled applies explicit zero reserve instead of leaving stale local balance', async () => {
    const seed = 'account-settled-zero-reserve';
    const env = createEmptyEnv(seed);
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const counterpartyId = `0x${'42'.repeat(32)}`;
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(signerId);
    state.reserves.set(1, 777n);
    const event: JurisdictionEvent = {
      type: 'AccountSettled',
      data: {
        leftEntity: entityId,
        rightEntity: counterpartyId,
        tokenId: 1,
        leftReserve: '0',
        rightReserve: '12',
        collateral: '0',
        ondelta: '0',
        nonce: 1,
      },
    };
    const common = {
      from: signerId,
      observedAt: 1_000,
      blockNumber: 4,
      blockHash: `0x${'16'.repeat(32)}`,
      transactionHash: `0x${'17'.repeat(32)}`,
      event,
    };
    const signed = signJEventObservation(env, entityId, signerId, {
      blockNumber: common.blockNumber,
      blockHash: common.blockHash,
      transactionHash: common.transactionHash,
      events: [event],
    });

    const result = await handleJEvent(state, { ...common, ...signed }, env);

    expect(result.newState.reserves.get(1)).toBe(0n);
  });

  test('j_event auth rejects are fatal inside applyEntityTx', async () => {
    const seed = 'j-event-auth-reject-fatal';
    const env = createEmptyEnv(seed);
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(signerId);
    const event: JurisdictionEvent = {
      type: 'ReserveUpdated',
      data: { entity: entityId, tokenId: 1, newBalance: '100' },
    };
    const eventsHash = canonicalJurisdictionEventsHash([event]);

    await expect(applyEntityTx(env, state, {
      type: 'j_event',
      data: {
        from: signerId,
        observedAt: 1_000,
        blockNumber: 3,
        blockHash: `0x${'14'.repeat(32)}`,
        transactionHash: `0x${'15'.repeat(32)}`,
        eventsHash,
        event,
      },
    } as any)).rejects.toThrow('j_event rejected: missing observation signature');
  });

  test('entity frame aborts instead of partially committing after a skipped tx', async () => {
    const env = createEmptyEnv('entity-frame-atomicity');
    env.quietRuntimeLogs = true;
    const state = makeEntityState(`0x${'61'.repeat(32)}`);
    const signer = 'atomic-signer';

    await expect(applyEntityFrame(env, state, [
      { type: 'chatMessage', data: { message: 'first mutation' } } as any,
      { type: 'definitely_unknown_entity_tx', data: {} } as any,
      { type: 'chatMessage', data: { message: 'late mutation' } } as any,
    ], 1_000)).rejects.toThrow('ENTITY_FRAME_TX_FAILED: type=definitely_unknown_entity_tx');

    expect(state.messages).toHaveLength(0);
    expect(state.nonces.has(signer)).toBe(false);
  });

  test('cross-j remote route cannot seed missing sibling runtime hints before topology validation', async () => {
    const env = createEmptyEnv('cross-j-topology-hints');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const localRuntime = `0x${'10'.repeat(20)}`;
    const remoteRuntime = `0x${'20'.repeat(20)}`;
    env.runtimeId = localRuntime;
    const sourceUserId = `0x${'31'.repeat(32)}`;
    const targetUserId = `0x${'32'.repeat(32)}`;
    const sourceHubId = `0x${'41'.repeat(32)}`;
    const targetHubId = `0x${'42'.repeat(32)}`;
    attachSigningReplica(env, sourceUserId, '1');
    attachSigningReplica(env, targetUserId, '1');

    await expect(process(env, [{
      from: remoteRuntime,
      entityId: sourceUserId,
      signerId: '1',
      entityTxs: [{
        type: 'registerCrossJurisdictionSwap',
        data: {
          route: {
            orderId: 'route-derived-hint-attack',
            source: { entityId: sourceUserId, counterpartyEntityId: sourceHubId },
            target: { entityId: targetHubId, counterpartyEntityId: targetUserId },
            bookOwnerEntityId: sourceHubId,
            hubEntityId: sourceHubId,
          },
        },
      } as any],
    }])).rejects.toThrow('RUNTIME_CROSS_J_TOPOLOGY_INVALID');
  });

  test('cross-j order admission requires committed source and target pull receipts', () => {
    const sourceUser = `0x${'31'.repeat(32)}`;
    const sourceHub = `0x${'41'.repeat(32)}`;
    const targetHub = `0x${'42'.repeat(32)}`;
    const targetUser = `0x${'32'.repeat(32)}`;
    const sourcePull = {
      pullId: 'source-pull',
      tokenId: 1,
      amount: 1_000n,
      signedAmount: 1_000n,
      revealedUntilTimestamp: 60_000,
      fullHash: `0x${'aa'.repeat(32)}`,
      partialRoot: `0x${'bb'.repeat(32)}`,
    };
    const targetPull = {
      pullId: 'target-pull',
      tokenId: 2,
      amount: 900n,
      signedAmount: 900n,
      revealedUntilTimestamp: 60_000,
      fullHash: `0x${'cc'.repeat(32)}`,
      partialRoot: `0x${'dd'.repeat(32)}`,
    };
    const sourceHubState = {
      entityId: sourceHub,
      accounts: new Map(),
      crossJurisdictionBookAdmissions: new Map(),
    } as EntityState;
    const route = {
      orderId: 'cross-admit-missing-target-lock',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      bookOwnerEntityId: sourceHub,
      venueId: 'cross:test:1/target:2',
      source: {
        jurisdiction: 'test',
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 1_000n,
      },
      target: {
        jurisdiction: 'target',
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 2,
        amount: 900n,
      },
      sourcePull,
      targetPull,
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 60_000,
    } satisfies CrossJurisdictionSwapRoute;
    const sourceReceipt = buildCrossJurisdictionBookAdmissionReceipt(
      route,
      'source',
      {
        type: 'pull_lock',
        data: {
          pullId: sourcePull.pullId,
          tokenId: sourcePull.tokenId,
          amount: sourcePull.signedAmount,
          revealedUntilTimestamp: sourcePull.revealedUntilTimestamp,
          fullHash: sourcePull.fullHash,
          partialRoot: sourcePull.partialRoot,
        },
      },
      sourceHub,
      sourceUser,
      1_000,
    );
    mergeCrossJurisdictionBookAdmission(sourceHubState, route, 1_000, sourceReceipt);

    expect(getCrossJurisdictionBookAdmissionError(sourceHubState, route, 1_000))
      .toContain('CROSS_J_BOOK_ADMISSION_PENDING');
    expect(() => assertCrossJurisdictionOrderAdmissible(sourceHubState, route, 1_000))
      .toThrow('CROSS_J_BOOK_ADMISSION_PENDING');

    const targetReceipt = buildCrossJurisdictionBookAdmissionReceipt(
      route,
      'target',
      {
        type: 'pull_lock',
        data: {
          pullId: targetPull.pullId,
          tokenId: targetPull.tokenId,
          amount: targetPull.signedAmount,
          revealedUntilTimestamp: targetPull.revealedUntilTimestamp,
          fullHash: targetPull.fullHash,
          partialRoot: targetPull.partialRoot,
        },
      },
      targetHub,
      targetUser,
      1_001,
    );
    mergeCrossJurisdictionBookAdmission(sourceHubState, route, 1_001, targetReceipt);
    expect(() => assertCrossJurisdictionOrderAdmissible(sourceHubState, route, 1_001)).not.toThrow();

    const env = createEmptyEnv('cross-j-admit-handler');
    const handlerState = makeEntityState(sourceHub);
    handlerState.accounts.set(sourceUser, {
      ...makeProposalAccount([], sourceUser, sourceHub),
      swapOffers: new Map([[route.orderId, {
        offerId: route.orderId,
        makerIsLeft: true,
        giveTokenId: route.source.tokenId,
        giveAmount: route.source.amount,
        wantTokenId: route.target.tokenId,
        wantAmount: route.target.amount,
        minFillRatio: 0,
        createdHeight: 1,
        crossJurisdiction: route,
      }]]),
    });
    const sourceAdmit = handleAdmitCrossJurisdictionBookOrderEntityTx(env, handlerState, {
      type: 'admitCrossJurisdictionBookOrder',
      data: { route, receipt: sourceReceipt, reason: 'source_pull_committed' },
    });
    expect(sourceAdmit.swapOffersCreated).toHaveLength(0);
    expect(sourceAdmit.newState.crossJurisdictionBookAdmissions?.values().next().value?.status).toBe('pending');

    const targetAdmit = handleAdmitCrossJurisdictionBookOrderEntityTx(env, sourceAdmit.newState, {
      type: 'admitCrossJurisdictionBookOrder',
      data: { route, receipt: targetReceipt, reason: 'target_pull_committed' },
    });
    expect(targetAdmit.swapOffersCreated).toHaveLength(1);
    expect(targetAdmit.swapOffersCreated[0]?.crossJurisdiction?.orderId).toBe(route.orderId);
    expect(targetAdmit.newState.crossJurisdictionBookAdmissions?.values().next().value?.status).toBe('admitted');

    const badTargetReceipt = { ...targetReceipt, signedAmount: targetReceipt.signedAmount + 1n };
    const resolvingAdmission = targetAdmit.newState.crossJurisdictionBookAdmissions?.values().next().value;
    if (!resolvingAdmission) throw new Error('test fixture missing cross-j admission');
    resolvingAdmission.status = 'resolving';
    const duplicateResolvingAdmit = handleAdmitCrossJurisdictionBookOrderEntityTx(env, targetAdmit.newState, {
      type: 'admitCrossJurisdictionBookOrder',
      data: { route, receipt: targetReceipt, reason: 'duplicate_target_pull_committed' },
    });
    expect(duplicateResolvingAdmit.swapOffersCreated).toHaveLength(0);
    expect(duplicateResolvingAdmit.newState.crossJurisdictionBookAdmissions?.values().next().value?.status).toBe('resolving');
    expect(() => handleAdmitCrossJurisdictionBookOrderEntityTx(env, targetAdmit.newState, {
      type: 'admitCrossJurisdictionBookOrder',
      data: { route, receipt: badTargetReceipt, reason: 'bad_duplicate' },
    })).toThrow('CROSS_J_BOOK_ADMISSION_RECEIPT_MISMATCH');

    const closedAdmission = duplicateResolvingAdmit.newState.crossJurisdictionBookAdmissions?.values().next().value;
    if (!closedAdmission) throw new Error('test fixture missing cross-j admission');
    closedAdmission.status = 'closed';
    const duplicateClosedAdmit = handleAdmitCrossJurisdictionBookOrderEntityTx(env, duplicateResolvingAdmit.newState, {
      type: 'admitCrossJurisdictionBookOrder',
      data: { route, receipt: sourceReceipt, reason: 'duplicate_source_pull_committed' },
    });
    expect(duplicateClosedAdmit.swapOffersCreated).toHaveLength(0);
    expect(duplicateClosedAdmit.newState.crossJurisdictionBookAdmissions?.values().next().value?.status).toBe('closed');

    mergeCrossJurisdictionBookAdmission(sourceHubState, route, 1_002, badTargetReceipt);
    expect(() => assertCrossJurisdictionOrderAdmissible(sourceHubState, route, 1_002))
      .toThrow('CROSS_J_BOOK_ADMISSION_RECEIPT_MISMATCH');
  });

  test('committed source pull advances source route to resting before fill notice', () => {
    const env = createEmptyEnv('cross-j-source-commit-resting');
    env.timestamp = 10_000;
    const sourceUser = `0x${'31'.repeat(32)}`;
    const sourceHub = `0x${'41'.repeat(32)}`;
    const targetHub = `0x${'42'.repeat(32)}`;
    const targetUser = `0x${'32'.repeat(32)}`;
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-source-commit-resting',
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      bookOwnerEntityId: sourceHub,
      venueId: 'cross:test:1/target:2',
      source: {
        jurisdiction: 'test',
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 1_000n,
      },
      target: {
        jurisdiction: 'target',
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 2,
        amount: 900n,
      },
      status: 'target_prepared',
      createdAt: 10_000,
      updatedAt: 10_000,
      expiresAt: 60_000,
    }, { runtimeSeed: 'cross-source-commit-resting', sourceDisputeDelayMs: 5_000, now: 10_000 });
    const targetReceipt = buildCrossJurisdictionBookAdmissionReceipt(
      route,
      'target',
      {
        type: 'pull_lock',
        data: {
          pullId: route.targetPull!.pullId,
          tokenId: route.targetPull!.tokenId,
          amount: route.targetPull!.signedAmount,
          revealedUntilTimestamp: route.targetPull!.revealedUntilTimestamp,
          fullHash: route.targetPull!.fullHash,
          partialRoot: route.targetPull!.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'target'),
        },
      },
      targetHub,
      targetUser,
      10_001,
    );
    const sourceHubState = makeEntityState(sourceHub);
    sourceHubState.crossJurisdictionSwaps = new Map([[route.orderId, route]]);
    attachSigningReplica(env, sourceHub, '1');
    const outputs: EntityInput[] = [];

    applyCommittedCrossJurisdictionAccountTxFollowup(env, sourceHubState, sourceUser, {
      type: 'pull_lock',
      data: {
        pullId: route.sourcePull!.pullId,
        tokenId: route.sourcePull!.tokenId,
        amount: route.sourcePull!.signedAmount,
        revealedUntilTimestamp: route.sourcePull!.revealedUntilTimestamp,
        fullHash: route.sourcePull!.fullHash,
        partialRoot: route.sourcePull!.partialRoot,
        crossJurisdiction: buildCrossJurisdictionPullBinding({
          ...route,
          targetReceipt,
          status: 'resting',
        }, 'source'),
      },
    }, outputs);

    const sourceRoute = sourceHubState.crossJurisdictionSwaps.get(route.orderId);
    expect(sourceRoute?.status).toBe('resting');
    expect(sourceRoute?.targetReceipt?.receiptHash).toBe(targetReceipt.receiptHash);
    expect(outputs.some((output) =>
      output.entityTxs?.some((tx) => tx.type === 'admitCrossJurisdictionBookOrder'),
    )).toBe(true);
  });

  test('cross-j same-token swap_offer quantizes by jurisdiction market side', async () => {
    const sourceUser = `0x${'33'.repeat(32)}`;
    const sourceHub = `0x${'43'.repeat(32)}`;
    const targetHub = `0x${'44'.repeat(32)}`;
    const targetUser = `0x${'34'.repeat(32)}`;
    const sourcePull = {
      pullId: 'same-token-source-pull',
      tokenId: 1,
      amount: 2_000_000_000_000n,
      signedAmount: 2_000_000_000_000n,
      revealedUntilTimestamp: 60_000,
      fullHash: `0x${'ab'.repeat(32)}`,
      partialRoot: `0x${'bc'.repeat(32)}`,
    };
    const targetPull = {
      pullId: 'same-token-target-pull',
      tokenId: 1,
      amount: 1_000_000_000_000n,
      signedAmount: 1_000_000_000_000n,
      revealedUntilTimestamp: 60_000,
      fullHash: `0x${'cd'.repeat(32)}`,
      partialRoot: `0x${'de'.repeat(32)}`,
    };
    const route = {
      orderId: 'cross-same-token-offer',
      makerEntityId: sourceUser,
      hubEntityId: targetHub,
      bookOwnerEntityId: targetHub,
      venueId: 'cross:stack:a:dep:1/stack:z:dep:1',
      source: {
        jurisdiction: 'stack:z:dep',
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: sourcePull.amount,
      },
      target: {
        jurisdiction: 'stack:a:dep',
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: targetPull.amount,
      },
      sourcePull,
      targetPull,
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 60_000,
    } satisfies CrossJurisdictionSwapRoute;
    const targetReceipt = buildCrossJurisdictionBookAdmissionReceipt(
      route,
      'target',
      {
        type: 'pull_lock',
        data: {
          pullId: targetPull.pullId,
          tokenId: targetPull.tokenId,
          amount: targetPull.signedAmount,
          revealedUntilTimestamp: targetPull.revealedUntilTimestamp,
          fullHash: targetPull.fullHash,
          partialRoot: targetPull.partialRoot,
        },
      },
      targetHub,
      targetUser,
      1_001,
    );
    const admittedRoute = { ...route, targetReceipt } satisfies CrossJurisdictionSwapRoute;
    const account = makeProposalAccount([], sourceUser, sourceHub);
    (account as AccountMachine & { pulls: Map<string, typeof sourcePull> }).pulls = new Map([[
      sourcePull.pullId,
      {
        ...sourcePull,
        crossJurisdiction: buildCrossJurisdictionPullBinding(admittedRoute, 'source'),
      },
    ]]);

    const result = await handleSwapOffer(account, {
      type: 'swap_offer',
      data: {
        offerId: route.orderId,
        giveTokenId: 1,
        giveAmount: route.source.amount,
        wantTokenId: 1,
        wantAmount: route.target.amount,
        priceTicks: 20_000n,
        minFillRatio: 0,
        crossJurisdiction: admittedRoute,
      },
    }, true, 1);

    expect(result.success).toBe(true);
    const offer = account.swapOffers.get(route.orderId);
    expect(offer?.giveAmount).toBe(route.source.amount);
    expect(offer?.wantAmount).toBe(route.target.amount);
    expect(offer?.priceTicks).toBe(20_000n);
  });

  test('market maker cross amount fitting round-trips through account swap_offer for both market sides', async () => {
    const cases = [
      {
        label: 'source-base',
        sourceJurisdiction: 'stack:31337:0x1111111111111111111111111111111111111111',
        targetJurisdiction: 'stack:31338:0x2222222222222222222222222222222222222222',
        sourceTokenId: 2,
        targetTokenId: 1,
        sourceAmount: 123_456_789n * SWAP_LOT_SCALE,
        targetAmount: 308_642_000_000_000_000_000_000n,
        priceTicks: 25_000_123n,
      },
      {
        label: 'source-quote',
        sourceJurisdiction: 'stack:31337:0x3333333333333333333333333333333333333333',
        targetJurisdiction: 'stack:31338:0x4444444444444444444444444444444444444444',
        sourceTokenId: 1,
        targetTokenId: 2,
        sourceAmount: 308_642_000_000_000_000_000_000n,
        targetAmount: 123_456_789n * SWAP_LOT_SCALE,
        priceTicks: 25_000_123n,
      },
    ] as const;

    for (const entry of cases) {
      const sourceMm = `0x${(entry.label === 'source-base' ? '37' : '38').repeat(32)}`;
      const sourceHub = `0x${(entry.label === 'source-base' ? '47' : '48').repeat(32)}`;
      const targetHub = `0x${(entry.label === 'source-base' ? '57' : '58').repeat(32)}`;
      const targetMm = `0x${(entry.label === 'source-base' ? '67' : '68').repeat(32)}`;
      const amounts = fitCrossAmountsToOrderbook(
        entry.sourceJurisdiction,
        entry.sourceTokenId,
        entry.sourceAmount,
        entry.targetJurisdiction,
        entry.targetTokenId,
        entry.targetAmount,
        entry.priceTicks,
      );
      if (!amounts) throw new Error(`test fixture did not fit ${entry.label}`);
      const route = buildPreparedCrossJurisdictionRoute({
        orderId: `mm-fit-roundtrip-${entry.label}`,
        makerEntityId: sourceMm,
        hubEntityId: sourceHub,
        source: {
          jurisdiction: entry.sourceJurisdiction,
          entityId: sourceMm,
          counterpartyEntityId: sourceHub,
          tokenId: entry.sourceTokenId,
          amount: amounts.sourceAmount,
        },
        target: {
          jurisdiction: entry.targetJurisdiction,
          entityId: targetHub,
          counterpartyEntityId: targetMm,
          tokenId: entry.targetTokenId,
          amount: amounts.targetAmount,
        },
        priceTicks: amounts.priceTicks,
        status: 'intent',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 61_000,
      }, { runtimeSeed: `mm-fit-roundtrip-${entry.label}`, sourceDisputeDelayMs: 5_000, now: 1_000 });
      const targetReceipt = buildCrossJurisdictionBookAdmissionReceipt(
        route,
        'target',
        {
          type: 'pull_lock',
          data: {
            pullId: route.targetPull!.pullId,
            tokenId: route.targetPull!.tokenId,
            amount: route.targetPull!.signedAmount,
            revealedUntilTimestamp: route.targetPull!.revealedUntilTimestamp,
            fullHash: route.targetPull!.fullHash,
            partialRoot: route.targetPull!.partialRoot,
          },
        },
        targetHub,
        targetMm,
        1_001,
      );
      const restingRoute = withCanonicalCrossJurisdictionRouteHash({
        ...route,
        targetReceipt,
        status: 'resting' as const,
        updatedAt: 1_001,
      });
      const account = makeProposalAccount([], sourceMm, sourceHub);
      account.pulls = new Map([[
        route.sourcePull!.pullId,
        {
          pullId: route.sourcePull!.pullId,
          tokenId: route.sourcePull!.tokenId,
          amount: route.sourcePull!.signedAmount,
          claimedRatio: 0,
          claimedAmount: 0n,
          revealedUntilTimestamp: route.sourcePull!.revealedUntilTimestamp,
          fullHash: route.sourcePull!.fullHash,
          partialRoot: route.sourcePull!.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding(restingRoute, 'source'),
          createdHeight: 1,
          createdTimestamp: 1_000,
        },
      ]]);

      const result = await handleSwapOffer(account, {
        type: 'swap_offer',
        data: {
          offerId: restingRoute.orderId,
          giveTokenId: restingRoute.source.tokenId,
          giveAmount: restingRoute.source.amount,
          wantTokenId: restingRoute.target.tokenId,
          wantAmount: restingRoute.target.amount,
          minFillRatio: 0,
          crossJurisdiction: restingRoute,
        },
      }, true, 1);

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      const offer = account.swapOffers.get(restingRoute.orderId);
      expect(offer?.giveAmount).toBe(amounts.sourceAmount);
      expect(offer?.wantAmount).toBe(amounts.targetAmount);
      expect(offer?.priceTicks).toBe(amounts.priceTicks);
    }
  });

  test('target-side cross-j book owner admits remote source offer from committed receipts', () => {
    const sourceUser = `0x${'35'.repeat(32)}`;
    const sourceHub = `0x${'45'.repeat(32)}`;
    const targetHub = `0x${'46'.repeat(32)}`;
    const targetUser = `0x${'36'.repeat(32)}`;
    const sourcePull = {
      pullId: 'remote-source-pull',
      tokenId: 1,
      amount: 75_000_000_000_000_000_000n,
      signedAmount: 75_000_000_000_000_000_000n,
      revealedUntilTimestamp: 60_000,
      fullHash: `0x${'ad'.repeat(32)}`,
      partialRoot: `0x${'be'.repeat(32)}`,
    };
    const targetPull = {
      pullId: 'remote-target-pull',
      tokenId: 2,
      amount: 30_000_000_000_000_000n,
      signedAmount: 30_000_000_000_000_000n,
      revealedUntilTimestamp: 60_000,
      fullHash: `0x${'ad'.repeat(32)}`,
      partialRoot: `0x${'be'.repeat(32)}`,
    };
    const route = {
      orderId: 'remote-source-admit',
      makerEntityId: sourceUser,
      hubEntityId: targetHub,
      bookOwnerEntityId: targetHub,
      venueId: 'cross:base:2/tron:1',
      source: {
        jurisdiction: 'tron',
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: sourcePull.amount,
      },
      target: {
        jurisdiction: 'base',
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 2,
        amount: targetPull.amount,
      },
      sourcePull,
      targetPull,
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 60_000,
    } satisfies CrossJurisdictionSwapRoute;
    const staleTargetRoute = {
      ...route,
      status: 'target_prepared' as const,
      updatedAt: 999,
    } satisfies CrossJurisdictionSwapRoute;
    const env = createEmptyEnv('target-side-cross-book-owner');
    const targetHubState = makeEntityState(targetHub);
    const sourceReceipt = buildCrossJurisdictionBookAdmissionReceipt(
      route,
      'source',
      {
        type: 'pull_lock',
        data: {
          pullId: sourcePull.pullId,
          tokenId: sourcePull.tokenId,
          amount: sourcePull.signedAmount,
          revealedUntilTimestamp: sourcePull.revealedUntilTimestamp,
          fullHash: sourcePull.fullHash,
          partialRoot: sourcePull.partialRoot,
        },
      },
      sourceHub,
      sourceUser,
      1_000,
    );
    const targetReceipt = buildCrossJurisdictionBookAdmissionReceipt(
      staleTargetRoute,
      'target',
      {
        type: 'pull_lock',
        data: {
          pullId: targetPull.pullId,
          tokenId: targetPull.tokenId,
          amount: targetPull.signedAmount,
          revealedUntilTimestamp: targetPull.revealedUntilTimestamp,
          fullHash: targetPull.fullHash,
          partialRoot: targetPull.partialRoot,
        },
      },
      targetHub,
      targetUser,
      1_001,
    );

    const pending = handleAdmitCrossJurisdictionBookOrderEntityTx(env, targetHubState, {
      type: 'admitCrossJurisdictionBookOrder',
      data: { route, receipt: sourceReceipt, reason: 'source_pull_committed' },
    });
    expect(pending.swapOffersCreated).toHaveLength(0);

    const admitted = handleAdmitCrossJurisdictionBookOrderEntityTx(env, pending.newState, {
      type: 'admitCrossJurisdictionBookOrder',
      data: { route: staleTargetRoute, receipt: targetReceipt, reason: 'target_pull_committed' },
    });
    expect(admitted.swapOffersCreated).toHaveLength(1);
    expect(admitted.swapOffersCreated[0]?.accountId).toBe(sourceUser);
    expect(admitted.swapOffersCreated[0]?.fromEntity).toBe(sourceUser);
    expect(admitted.swapOffersCreated[0]?.toEntity).toBe(sourceHub);
    expect(admitted.swapOffersCreated[0]?.crossJurisdiction?.orderId).toBe(route.orderId);
    expect(admitted.swapOffersCreated[0]?.crossJurisdiction?.status).toBe('resting');
  });

  test('j_event finality requires quorum on canonical event set, not only block hash', async () => {
    const entityId = `0x${'44'.repeat(32)}`;
    let state = makeEntityState(entityId);
    state.config = {
      mode: 'proposer-based',
      threshold: 2n,
      validators: ['1', '2', '3'],
      shares: { '1': 1n, '2': 1n, '3': 1n },
    };
    const env = createEmptyEnv('j-event-events-hash-quorum');
    const common = {
      observedAt: 1_000,
      blockNumber: 7,
      blockHash: `0x${'55'.repeat(32)}`,
      transactionHash: `0x${'66'.repeat(32)}`,
    };
    const honestEvent = {
      type: 'ReserveUpdated',
      data: { entity: entityId, tokenId: 1, newBalance: '100' },
    };
    const fakeEvent = {
      type: 'ReserveUpdated',
      data: { entity: entityId, tokenId: 1, newBalance: '999' },
    };
    const signedHonest1 = signJEventObservation(env, entityId, '1', {
      blockNumber: common.blockNumber,
      blockHash: common.blockHash,
      transactionHash: common.transactionHash,
      events: [honestEvent],
    });
    const signedFake = signJEventObservation(env, entityId, '2', {
      blockNumber: common.blockNumber,
      blockHash: common.blockHash,
      transactionHash: common.transactionHash,
      events: [fakeEvent],
    });
    const signedHonest3 = signJEventObservation(env, entityId, '3', {
      blockNumber: common.blockNumber,
      blockHash: common.blockHash,
      transactionHash: common.transactionHash,
      events: [honestEvent],
    });

    state = (await handleJEvent(state, { ...common, from: '1', event: honestEvent, ...signedHonest1 }, env)).newState;
    state = (await handleJEvent(state, { ...common, from: '2', event: fakeEvent, ...signedFake }, env)).newState;
    expect(state.jBlockChain.length).toBe(0);
    expect(state.reserves.get(1)).toBeUndefined();

    state = (await handleJEvent(state, { ...common, from: '3', event: honestEvent, ...signedHonest3 }, env)).newState;
    expect(state.jBlockChain.length).toBe(1);
    expect(state.reserves.get(1)).toBe(100n);
  });

  test('multi-validator j_event observations must be signed by the claimed signer', async () => {
    const entityId = `0x${'4a'.repeat(32)}`;
    const state = makeEntityState(entityId);
    state.config = {
      mode: 'proposer-based',
      threshold: 2n,
      validators: ['1', '2', '3'],
      shares: { '1': 1n, '2': 1n, '3': 1n },
    };
    const env = createEmptyEnv('j-event-observation-signature');
    const event: JurisdictionEvent = {
      type: 'ReserveUpdated',
      data: { entity: entityId, tokenId: 1, newBalance: '100' },
    };
    const common = {
      observedAt: 1_000,
      blockNumber: 8,
      blockHash: `0x${'5a'.repeat(32)}`,
      transactionHash: `0x${'6a'.repeat(32)}`,
      event,
    };
    const signerOne = signJEventObservation(env, entityId, '1', {
      blockNumber: common.blockNumber,
      blockHash: common.blockHash,
      transactionHash: common.transactionHash,
      events: [event],
    });

    await expect(handleJEvent(state, { ...common, from: '1', eventsHash: signerOne.eventsHash }, env)).rejects.toThrow(
      'missing observation signature',
    );
    await expect(handleJEvent(state, { ...common, from: '2', ...signerOne }, env)).rejects.toThrow(
      'invalid observation signature',
    );
  });

  test('htlc_resolve(error) cannot be used by payer to cancel an active lock before expiry', async () => {
    const account = makeProposalAccount([], 'alice', 'hub');
    const amount = 1000n;
    const delta = createDefaultDelta(1);
    delta.leftHold = amount;
    account.deltas.set(1, delta);
    account.locks.set('lock-1', {
      lockId: 'lock-1',
      hashlock: `0x${'77'.repeat(32)}`,
      timelock: 10_000n,
      revealBeforeHeight: 100,
      amount,
      tokenId: 1,
      senderIsLeft: true,
      createdHeight: 0,
      createdTimestamp: 0,
    });

    const payerResult = await handleHtlcResolve(
      account,
      { type: 'htlc_resolve', data: { lockId: 'lock-1', outcome: 'error', reason: 'downstream_error' } },
      true,
      1,
      1_000,
    );
    expect(payerResult.success).toBe(false);
    expect(account.locks.has('lock-1')).toBe(true);
    expect(account.deltas.get(1)?.leftHold).toBe(amount);

    const beneficiaryResult = await handleHtlcResolve(
      account,
      { type: 'htlc_resolve', data: { lockId: 'lock-1', outcome: 'error', reason: 'downstream_error' } },
      false,
      1,
      1_000,
    );
    expect(beneficiaryResult.success).toBe(true);
    expect(account.locks.has('lock-1')).toBe(false);
    expect(account.deltas.get(1)?.leftHold).toBe(0n);
  });

  test('failed account tx mutations do not leak into later valid txs in the same proposal', async () => {
    const env = createEmptyEnv('account-tx-atomicity');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.timestamp = 1_000;
    env.browserVM = { getDepositoryAddress: () => hex20('dd') } as any;
    const { signerId, entityId: left } = registerLazySigner('account-tx-atomicity', '1');
    attachSigningReplica(env, left, signerId);
    const right = `0x${'ff'.repeat(32)}`;
    const account = makeProposalAccount([
      {
        type: 'direct_payment',
        data: {
          tokenId: 1,
          amount: 100n,
          fromEntityId: right,
          toEntityId: left,
          route: [''],
        },
      },
      {
        type: 'set_credit_limit',
        data: {
          tokenId: 1,
          amount: 500n,
        },
      },
    ], left, right);
    account.deltas.set(1, {
      tokenId: 1,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 0n,
      leftCreditLimit: 0n,
      rightCreditLimit: 1_000n,
      leftAllowance: 0n,
      rightAllowance: 0n,
      leftHold: 0n,
      rightHold: 0n,
    });

    const result = await proposeAccountFrame(env, account);

    expect(result.success).toBe(true);
    expect(result.accountInput?.newAccountFrame?.accountTxs.map((tx) => tx.type)).toEqual(['set_credit_limit']);
    const frameDelta = result.accountInput?.newAccountFrame?.deltas.find((delta) => delta.tokenId === 1);
    expect(frameDelta?.offdelta).toBe(0n);
    expect(frameDelta?.rightCreditLimit).toBe(500n);
  });

  test('proposeAccountFrame throws instead of dropping invalid cross-j fill ack', async () => {
    const env = createEmptyEnv('cross-fill-ack-propose-failfast');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const left = `0x${'11'.repeat(32)}`;
    const right = `0x${'22'.repeat(32)}`;
    const account = makeProposalAccount([
      {
        type: 'cross_swap_fill_ack',
        data: {
          offerId: 'missing-cross-offer',
          fillSeq: 1,
          incrementalSourceAmount: 1n,
          incrementalTargetAmount: 1n,
          cumulativeSourceAmount: 1n,
          cumulativeTargetAmount: 1n,
          cumulativeFillRatio: 1,
          executionSourceAmount: 1n,
          executionTargetAmount: 1n,
          cancelRemainder: false,
          pairId: 'cross:testnet:1/tron:1',
        },
      },
    ], left, right);

    await expect(proposeAccountFrame(env, account)).rejects.toThrow(/CROSS_J_FILL_ACK_PROPOSAL_FAILED/);
    expect(account.mempool).toHaveLength(1);
  });

  test('proposeAccountFrame throws instead of dropping invalid cross-j pull resolve', async () => {
    const env = createEmptyEnv('cross-pull-resolve-propose-failfast');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const left = `0x${'11'.repeat(32)}`;
    const right = `0x${'22'.repeat(32)}`;
    const account = makeProposalAccount([
      {
        type: 'pull_resolve',
        data: {
          pullId: 'target-pull',
          binary: '0x1234',
        },
      },
    ], left, right);
    account.pulls = new Map([
      ['target-pull', {
        pullId: 'target-pull',
        tokenId: 1,
        amount: 1_000n,
        claimedRatio: 0,
        claimedAmount: 0n,
        revealedUntilTimestamp: 60_000,
        fullHash: `0x${'aa'.repeat(32)}`,
        partialRoot: `0x${'bb'.repeat(32)}`,
        crossJurisdiction: {
          orderId: 'cross-pull-propose-failfast',
          routeHash: `0x${'cc'.repeat(32)}`,
          leg: 'target',
          status: 'clearing',
          cumulativeFillRatio: 1,
        },
        createdHeight: 0,
        createdTimestamp: 1,
      }],
    ]);

    await expect(proposeAccountFrame(env, account)).rejects.toThrow(/CROSS_J_PULL_RESOLVE_PROPOSAL_FAILED/);
    expect(account.mempool).toHaveLength(1);
  });

  test('proposeAccountFrame throws instead of dropping invalid cross-j swap offer', async () => {
    const env = createEmptyEnv('cross-swap-offer-propose-failfast');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const left = `0x${'11'.repeat(32)}`;
    const right = `0x${'22'.repeat(32)}`;
    const amount = SWAP_LOT_SCALE;
    const route = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'cross-swap-offer-propose-failfast',
      makerEntityId: left,
      hubEntityId: right,
      source: {
        jurisdiction: 'stack:testnet',
        entityId: left,
        counterpartyEntityId: right,
        tokenId: 1,
        amount,
      },
      target: {
        jurisdiction: 'stack:tron',
        entityId: right,
        counterpartyEntityId: left,
        tokenId: 2,
        amount,
      },
      sourcePull: {
        pullId: 'missing-source-pull',
        tokenId: 1,
        amount: -amount,
        signedAmount: -amount,
        revealedUntilTimestamp: 60_000,
        fullHash: `0x${'aa'.repeat(32)}`,
        partialRoot: `0x${'bb'.repeat(32)}`,
      },
      targetPull: {
        pullId: 'target-pull',
        tokenId: 2,
        amount,
        signedAmount: amount,
        revealedUntilTimestamp: 60_000,
        fullHash: `0x${'dd'.repeat(32)}`,
        partialRoot: `0x${'ee'.repeat(32)}`,
      },
      priceTicks: ORDERBOOK_PRICE_SCALE,
      status: 'resting',
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 60_000,
    } as CrossJurisdictionSwapRoute);
    const account = makeProposalAccount([
      {
        type: 'swap_offer',
        data: {
          offerId: route.orderId,
          giveTokenId: 1,
          giveAmount: amount,
          wantTokenId: 2,
          wantAmount: amount,
          minFillRatio: 0,
          crossJurisdiction: route,
        },
      },
    ], left, right);

    await expect(proposeAccountFrame(env, account)).rejects.toThrow(/CROSS_J_SWAP_OFFER_PROPOSAL_FAILED/);
    expect(account.mempool).toHaveLength(1);
  });

  test('proposeAccountFrame keeps valid swap_resolve txs when optimistic batch validation falls back', async () => {
    const env = createEmptyEnv('swap-resolve-batch-fallback');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    env.browserVM = {
      getDepositoryAddress: () => hex20('dd'),
    } as typeof env.browserVM;

    const makerIdentity = registerLazySigner('swap-resolve-batch-fallback', 'maker');
    const hubIdentity = registerLazySigner('swap-resolve-batch-fallback', 'hub');
    const maker = makerIdentity.entityId;
    const hub = hubIdentity.entityId;
    const makerIsLeft = isLeftEntity(maker, hub);
    const [leftEntity, rightEntity] = makerIsLeft ? [maker, hub] : [hub, maker];
    const giveAmount = SWAP_LOT_SCALE;
    const wantAmount = 3_000n * SWAP_LOT_SCALE;
    const validTx: Extract<AccountTx, { type: 'swap_resolve' }> = {
      type: 'swap_resolve',
      data: {
        offerId: 'valid-batch-fill',
        fillRatio: 65_535,
        fillNumerator: 1n,
        fillDenominator: 1n,
        cancelRemainder: true,
        executionGiveAmount: giveAmount,
        executionWantAmount: wantAmount,
      },
    };
    const invalidTx: Extract<AccountTx, { type: 'swap_resolve' }> = {
      type: 'swap_resolve',
      data: {
        offerId: 'missing-batch-fill',
        fillRatio: 65_535,
        fillNumerator: 1n,
        fillDenominator: 1n,
        cancelRemainder: true,
        executionGiveAmount: giveAmount,
        executionWantAmount: wantAmount,
      },
    };
    const account = makeProposalAccount([validTx, invalidTx], leftEntity, rightEntity);
    account.proofHeader = { fromEntity: hub, toEntity: maker, nonce: 0 };
    attachSigningReplica(env, hub, hubIdentity.signerId);

    const giveDelta = createDefaultDelta(2);
    giveDelta.leftCreditLimit = 10n ** 30n;
    giveDelta.rightCreditLimit = 10n ** 30n;
    if (makerIsLeft) giveDelta.leftHold = giveAmount;
    else giveDelta.rightHold = giveAmount;
    account.deltas.set(2, giveDelta);

    const wantDelta = createDefaultDelta(1);
    wantDelta.leftCreditLimit = 10n ** 30n;
    wantDelta.rightCreditLimit = 10n ** 30n;
    account.deltas.set(1, wantDelta);

    account.swapOffers.set('valid-batch-fill', {
      offerId: 'valid-batch-fill',
      giveTokenId: 2,
      giveAmount,
      wantTokenId: 1,
      wantAmount,
      priceTicks: 3_000n * ORDERBOOK_PRICE_SCALE,
      timeInForce: 0,
      minFillRatio: 0,
      makerIsLeft,
      createdHeight: 0,
      quantizedGive: giveAmount,
      quantizedWant: wantAmount,
    });

    const result = await proposeAccountFrame(env, account);

    expect(result.success).toBe(true);
    expect(result.accountInput?.newAccountFrame.accountTxs).toEqual([validTx]);
    expect(account.pendingFrame?.accountTxs).toEqual([validTx]);
    expect(account.mempool).toEqual([]);
  });

  test('entity frame commits mark the entity core doc dirty for storage replay', async () => {
    const seed = 'entity-frame-storage-mark seed alpha beta gamma';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.timestamp = 10_000;
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const replica = {
      entityId,
      signerId,
      mempool: [],
      isProposer: true,
      state: makeEntityState(entityId),
    } as EntityReplica;
    replica.state.config = makeSingleSignerConfigFor(signerId);

    await applyEntityInput(env, replica, {
      entityId,
      signerId,
      entityTxs: [{
        type: 'profile-update',
        data: {
          profile: {
            entityId,
            name: 'Storage Marked',
          },
        },
      } as any],
    });

    const marks = env.runtimeState?.currentStorageOverlayMarks ?? [];
    expect(marks.some((record) => record.family === 'entity' && record.entityId === entityId)).toBe(true);
  });

  test('crontab-only canonical mutations mark entity docs dirty for storage replay', async () => {
    const seed = 'crontab-storage-mark seed alpha beta gamma';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(signerId);
    state.timestamp = 50_000;
    state.crontabState = initCrontab();
    state.crontabState.tasks.clear();
    state.crontabState.hooks.set('test-settlement-window', {
      id: 'test-settlement-window',
      triggerAt: 49_000,
      type: 'settlement_window',
      data: {},
    });
    const replica = {
      entityId,
      signerId,
      mempool: [],
      isProposer: true,
      state,
    } as EntityReplica;

    await executeCrontab(env, replica, state.crontabState, { manualBroadcastInInput: false });

    const marks = env.runtimeState?.currentStorageOverlayMarks ?? [];
    expect(state.crontabState.hooks.has('test-settlement-window')).toBe(false);
    expect(marks.some((record) => record.family === 'entity' && record.entityId === entityId)).toBe(true);
  });

  test('single-signer j_broadcast attaches consensus hanko to J batch output', async () => {
    const seed = 'single-signer-j-broadcast-hanko seed alpha beta gamma';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.timestamp = 30_000;
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const jurisdiction = {
      name: 'Testnet',
      address: 'http://localhost:8545',
      depositoryAddress: hex20('1'),
      entityProviderAddress: hex20('2'),
      chainId: 31337,
    };
    env.activeJurisdiction = 'Testnet';
    env.jReplicas.set('Testnet', {
      name: 'Testnet',
      blockNumber: 0n,
      stateRoot: new Uint8Array(32),
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
      position: { x: 0, y: 0, z: 0 },
      depositoryAddress: jurisdiction.depositoryAddress,
      entityProviderAddress: jurisdiction.entityProviderAddress,
      contracts: {
        account: hex20('3'),
        depository: jurisdiction.depositoryAddress,
        entityProvider: jurisdiction.entityProviderAddress,
        deltaTransformer: hex20('4'),
      },
      rpcs: [jurisdiction.address],
      chainId: jurisdiction.chainId,
    });
    const state = makeEntityState(entityId);
    state.config = {
      ...makeSingleSignerConfigFor(signerId),
      jurisdiction,
    };
    const batch = createEmptyBatch();
    batch.reserveToReserve.push({
      receivingEntity: `0x${'ef'.repeat(32)}`,
      tokenId: 1,
      amount: 10n,
    });
    state.jBatchState = {
      batch,
      jurisdiction,
      lastBroadcast: 0,
      broadcastCount: 0,
      failedAttempts: 0,
      status: 'accumulating',
      entityNonce: 0,
    };
    const replica = {
      entityId,
      signerId,
      mempool: [],
      isProposer: true,
      state,
    } as EntityReplica;

    const result = await applyEntityInput(env, replica, {
      entityId,
      signerId,
      entityTxs: [{ type: 'j_broadcast', data: {} }],
    });

    expect(result.jOutputs).toHaveLength(1);
    const jTx = result.jOutputs[0]?.jTxs[0];
    expect(jTx?.type).toBe('batch');
    if (jTx?.type === 'batch') {
      expect(jTx.data.batchHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(jTx.data.encodedBatch).toMatch(/^0x/);
      expect(jTx.data.entityNonce).toBe(1);
      expect(jTx.data.hankoSignature).toMatch(/^0x/);
    }
  });

  test('finalized j-events mark mutated account docs dirty for storage replay', async () => {
    const seed = 'j-event-account-storage-mark seed alpha beta gamma';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.timestamp = 20_000;
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const counterpartyId = `0x${'34'.repeat(32)}`;
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(signerId);
    const entityIsLeft = isLeftEntity(entityId, counterpartyId);
    const account = makeProposalAccount(
      [],
      entityIsLeft ? entityId : counterpartyId,
      entityIsLeft ? counterpartyId : entityId,
    );
    account.activeDispute = {
      startedByLeft: true,
      initialProofbodyHash: `0x${'56'.repeat(32)}`,
      initialNonce: 7,
      disputeTimeout: 22,
      onChainNonce: 7,
      starterInitialArguments: '0x',
      starterIncrementedArguments: '0x',
      finalizeQueued: true,
    };
    state.accounts.set(counterpartyId, account);
    const replica = {
      entityId,
      signerId,
      mempool: [],
      isProposer: true,
      state,
    } as EntityReplica;
    const disputeFinalizedEvent: JurisdictionEvent = {
      type: 'DisputeFinalized',
      data: {
        sender: entityId,
        counterentity: counterpartyId,
        initialNonce: 7,
        initialProofbodyHash: `0x${'56'.repeat(32)}`,
        finalProofbodyHash: `0x${'57'.repeat(32)}`,
      },
    };
    const signed = signJEventObservation(env, entityId, signerId, {
      blockNumber: 22,
      blockHash: `0x${'99'.repeat(32)}`,
      transactionHash: `0x${'88'.repeat(32)}`,
      events: [disputeFinalizedEvent],
    });

    await applyEntityInput(env, replica, {
      entityId,
      signerId,
      entityTxs: [{
        type: 'j_event',
        data: {
          from: signerId,
          observedAt: 20_000,
          blockNumber: 22,
          blockHash: `0x${'99'.repeat(32)}`,
          transactionHash: `0x${'88'.repeat(32)}`,
          ...signed,
          event: disputeFinalizedEvent,
        },
      } as any],
    });

    const marks = env.runtimeState?.currentStorageOverlayMarks ?? [];
    expect(marks.some((record) =>
      record.family === 'account' &&
      record.entityId === entityId &&
      record.counterpartyId === counterpartyId.toLowerCase(),
    )).toBe(true);
  });

  test('j_abort_sent_batch does not requeue dispute finalize after on-chain finalize already cleared activeDispute', async () => {
    const entityId = `0x${'aa'.repeat(32)}`;
    const counterpartyId = `0x${'bb'.repeat(32)}`;
    const state = makeEntityState(entityId);
    const account = makeProposalAccount([], entityId, counterpartyId);
    delete account.activeDispute;
    state.accounts.set(counterpartyId, account);
    state.jBatchState = {
      batch: createEmptyBatch(),
      jurisdiction: null,
      lastBroadcast: 0,
      broadcastCount: 0,
      failedAttempts: 0,
      status: 'sent',
      sentBatch: {
        batch: {
          ...createEmptyBatch(),
          disputeFinalizations: [
            {
              counterentity: counterpartyId,
              initialNonce: 3,
              finalNonce: 3,
              initialProofbodyHash: `0x${'11'.repeat(32)}`,
              finalProofbody: makeEmptyProofBody(),
              leftArguments: '0x',
              rightArguments: '0x',
              starterInitialArguments: '0x',
              starterIncrementedArguments: '0x',
              sig: '0x',
              startedByLeft: true,
              disputeUntilBlock: 123,
              cooperative: false,
            },
          ],
        },
        batchHash: `0x${'22'.repeat(32)}`,
        encodedBatch: '0x',
        entityNonce: 1,
        firstSubmittedAt: 1000,
        lastSubmittedAt: 1000,
        submitAttempts: 1,
      },
      entityNonce: 1,
    };

    const result = await handleJAbortSentBatch(
      state,
      {
        type: 'j_abort_sent_batch',
        data: { reason: 'submit_failed:E5()', requeueToCurrent: true },
      },
      createEmptyEnv('abort-stale-finalize'),
    );

    expect(result.newState.jBatchState?.sentBatch).toBeUndefined();
    expect(result.newState.jBatchState?.batch.disputeFinalizations.length).toBe(0);
    expect(result.newState.jBatchState?.status).toBe('empty');
  });

  test('j_abort_sent_batch never resurrects dispute finalize into current batch', async () => {
    const entityId = `0x${'cc'.repeat(32)}`;
    const counterpartyId = `0x${'dd'.repeat(32)}`;
    const state = makeEntityState(entityId);
    const account = makeProposalAccount([], entityId, counterpartyId);
    account.activeDispute = {
      startedByLeft: true,
      disputeTimeout: 123,
      initialProofbodyHash: `0x${'44'.repeat(32)}`,
      initialNonce: 5,
      finalizeQueued: true,
    } as AccountMachine['activeDispute'];
    state.accounts.set(counterpartyId, account);
    state.jBatchState = {
      batch: createEmptyBatch(),
      jurisdiction: null,
      lastBroadcast: 0,
      broadcastCount: 0,
      failedAttempts: 0,
      status: 'sent',
      sentBatch: {
        batch: {
          ...createEmptyBatch(),
          disputeFinalizations: [
            {
              counterentity: counterpartyId,
              initialNonce: 5,
              finalNonce: 5,
              initialProofbodyHash: `0x${'44'.repeat(32)}`,
              finalProofbody: makeEmptyProofBody(),
              leftArguments: '0x',
              rightArguments: '0x',
              starterInitialArguments: '0x',
              starterIncrementedArguments: '0x',
              sig: '0x',
              startedByLeft: true,
              disputeUntilBlock: 123,
              cooperative: false,
            },
          ],
        },
        batchHash: `0x${'55'.repeat(32)}`,
        encodedBatch: '0x',
        entityNonce: 1,
        firstSubmittedAt: 1000,
        lastSubmittedAt: 1000,
      },
    };

    const result = await handleJAbortSentBatch(
      state,
      {
        type: 'j_abort_sent_batch',
        data: {
          reason: 'submit_failed',
          requeueToCurrent: true,
        },
      },
      createEmptyEnv('abort-finalize-regression'),
    );

    expect(result.newState.jBatchState?.sentBatch).toBeUndefined();
    expect(result.newState.jBatchState?.batch.disputeFinalizations).toEqual([]);
    expect(result.newState.accounts.get(counterpartyId)?.activeDispute?.finalizeQueued).toBe(false);
  });

  test('submitRuntimeJOutbox stops on transient submit failure without poisoning sentBatch', async () => {
    const entityId = `0x${'ab'.repeat(32)}`;
    const signerId = `0x${'cd'.repeat(20)}`;
    const batchHash = `0x${'11'.repeat(32)}`;
    const env = createEmptyEnv('j-submit-fail-fast');
    env.runtimeId = signerId;
    env.timestamp = 123;
    env.scenarioMode = false;
    const state = makeEntityState(entityId);
    state.jBatchState = {
      batch: createEmptyBatch(),
      jurisdiction: null,
      lastBroadcast: 0,
      broadcastCount: 0,
      failedAttempts: 0,
      status: 'sent',
      sentBatch: {
        batch: {
          ...createEmptyBatch(),
          reserveToReserve: [{
            receivingEntity: `0x${'ef'.repeat(32)}`,
            tokenId: 1,
            amount: 10n,
          }],
        },
        batchHash,
        encodedBatch: '0x1234',
        entityNonce: 1,
        firstSubmittedAt: 123,
        lastSubmittedAt: 123,
        submitAttempts: 1,
      },
    };
    env.eReplicas.set(`${entityId}:1`, {
      entityId,
      signerId,
      mempool: [],
      isProposer: true,
      state,
    } as EntityReplica);
    env.jReplicas = new Map([
      [
        'Testnet',
        {
          jadapter: {
            submitTx: async () => ({ success: false, error: 'ECONNREFUSED' }),
            pollNow: async () => {},
          },
        } as any,
      ],
    ]);
    const queuedInputs: EntityInput[] = [];

    await expect(submitRuntimeJOutbox(
      env,
      [
        {
          jurisdictionName: 'Testnet',
          jTxs: [
            {
              type: 'batch',
              entityId,
              data: {
                batch: {
                  ...createEmptyBatch(),
                  reserveToReserve: [{
                    receivingEntity: `0x${'ef'.repeat(32)}`,
                    tokenId: 1,
                    amount: 10n,
                  }],
                },
                batchHash,
                encodedBatch: '0x1234',
                entityNonce: 1,
                hankoSignature: '0x1234',
                batchSize: 1,
                signerId,
              },
              timestamp: env.timestamp,
            } as any,
          ],
        },
      ],
      {
        enqueueRuntimeInputs: (_env, inputs) => {
          queuedInputs.push(...(inputs ?? []));
        },
      },
    )).rejects.toThrow(/J_SUBMIT_TRANSIENT: ECONNREFUSED/);

    expect(queuedInputs).toHaveLength(0);
    expect(state.jBatchState?.status).toBe('sent');
    expect(state.jBatchState?.failedAttempts).toBe(1);
    expect(state.jBatchState?.sentBatch).toBeDefined();
    expect(state.jBatchState?.sentBatch?.terminalFailure).toBeUndefined();
  });

  test('submitRuntimeJOutbox marks staticCall revert as terminal before halting', async () => {
    const entityId = `0x${'ad'.repeat(32)}`;
    const signerId = `0x${'cd'.repeat(20)}`;
    const batchHash = `0x${'12'.repeat(32)}`;
    const env = createEmptyEnv('j-submit-staticcall-fail-fast');
    env.runtimeId = signerId;
    env.timestamp = 124;
    env.scenarioMode = false;
    const state = makeEntityState(entityId);
    state.jBatchState = {
      batch: createEmptyBatch(),
      jurisdiction: null,
      lastBroadcast: 0,
      broadcastCount: 0,
      failedAttempts: 0,
      status: 'sent',
      sentBatch: {
        batch: {
          ...createEmptyBatch(),
          reserveToReserve: [{
            receivingEntity: `0x${'ef'.repeat(32)}`,
            tokenId: 1,
            amount: 10n,
          }],
        },
        batchHash,
        encodedBatch: '0x1234',
        entityNonce: 1,
        firstSubmittedAt: 124,
        lastSubmittedAt: 124,
        submitAttempts: 1,
      },
    };
    env.eReplicas.set(`${entityId}:1`, {
      entityId,
      signerId,
      mempool: [],
      isProposer: true,
      state,
    } as EntityReplica);
    env.jReplicas = new Map([
      [
        'Testnet',
        {
          jadapter: {
            submitTx: async () => ({ success: false, error: 'staticCall revert: E3()' }),
            pollNow: async () => {},
          },
        } as any,
      ],
    ]);

    await expect(submitRuntimeJOutbox(
      env,
      [
        {
          jurisdictionName: 'Testnet',
          jTxs: [
            {
              type: 'batch',
              entityId,
              data: {
                batch: {
                  ...createEmptyBatch(),
                  reserveToReserve: [{
                    receivingEntity: `0x${'ef'.repeat(32)}`,
                    tokenId: 1,
                    amount: 10n,
                  }],
                },
                batchHash,
                encodedBatch: '0x1234',
                entityNonce: 1,
                hankoSignature: '0x1234',
                batchSize: 1,
                signerId,
              },
              timestamp: env.timestamp,
            } as any,
          ],
        },
      ],
      { enqueueRuntimeInputs: () => {} },
    )).rejects.toThrow(/J_SUBMIT_FATAL: staticCall revert: E3\(\)/);

    expect(state.jBatchState?.status).toBe('failed');
    expect(state.jBatchState?.failedAttempts).toBe(1);
    expect(state.jBatchState?.sentBatch?.terminalFailure).toEqual({
      message: 'staticCall revert: E3()',
      failedAt: 124,
    });
  });

  test('submitRuntimeJOutbox skips sealed batches owned by another runtime signer', async () => {
    const entityId = `0x${'ae'.repeat(32)}`;
    const localRuntimeId = `0x${'11'.repeat(20)}`;
    const remoteSignerId = `0x${'22'.repeat(20)}`;
    const env = createEmptyEnv('j-submit-non-local-signer-skip');
    env.runtimeId = localRuntimeId;
    env.timestamp = 125;
    let adapterCalls = 0;
    env.jReplicas = new Map([
      [
        'Testnet',
        {
          jadapter: {
            submitTx: async () => {
              adapterCalls += 1;
              return { success: true };
            },
            pollNow: async () => {},
          },
        } as any,
      ],
    ]);

    await submitRuntimeJOutbox(
      env,
      [
        {
          jurisdictionName: 'Testnet',
          jTxs: [
            {
              type: 'batch',
              entityId,
              data: {
                batch: {
                  ...createEmptyBatch(),
                  reserveToReserve: [{
                    receivingEntity: `0x${'ef'.repeat(32)}`,
                    tokenId: 1,
                    amount: 10n,
                  }],
                },
                batchHash: `0x${'13'.repeat(32)}`,
                encodedBatch: '0x1234',
                entityNonce: 1,
                hankoSignature: '0x1234',
                batchSize: 1,
                signerId: remoteSignerId,
              },
              timestamp: env.timestamp,
            } as any,
          ],
        },
      ],
      { enqueueRuntimeInputs: () => {} },
    );

    expect(adapterCalls).toBe(0);
  });

  test('submitRuntimeJOutbox submits cached local multi-signer batches even when runtimeId differs', async () => {
    const entityId = `0x${'af'.repeat(32)}`;
    const runtimeId = `0x${'33'.repeat(20)}`;
    const localScenarioSignerId = '97';
    registerSignerKey(
      localScenarioSignerId,
      deriveSignerKeySync('j-submit-local-multi-signer', localScenarioSignerId),
    );

    const env = createEmptyEnv('j-submit-local-multi-signer');
    env.runtimeId = runtimeId;
    env.timestamp = 126;
    let adapterCalls = 0;
    env.jReplicas = new Map([
      [
        'Testnet',
        {
          jadapter: {
            submitTx: async (_tx: unknown, options: { signerId?: string; signerPrivateKey?: Uint8Array }) => {
              adapterCalls += 1;
              expect(options.signerId).toBe(localScenarioSignerId);
              expect(options.signerPrivateKey).toBeInstanceOf(Uint8Array);
              return { success: true };
            },
            pollNow: async () => {},
          },
        } as any,
      ],
    ]);

    await submitRuntimeJOutbox(
      env,
      [
        {
          jurisdictionName: 'Testnet',
          jTxs: [
            {
              type: 'batch',
              entityId,
              data: {
                batch: {
                  ...createEmptyBatch(),
                  reserveToReserve: [{
                    receivingEntity: `0x${'ef'.repeat(32)}`,
                    tokenId: 1,
                    amount: 10n,
                  }],
                },
                batchHash: `0x${'14'.repeat(32)}`,
                encodedBatch: '0x1234',
                entityNonce: 1,
                hankoSignature: '0x1234',
                batchSize: 1,
                signerId: localScenarioSignerId,
              },
              timestamp: env.timestamp,
            } as any,
          ],
        },
      ],
      { enqueueRuntimeInputs: () => {} },
    );

    expect(adapterCalls).toBe(1);
  });

  test('submitRuntimeJOutbox rejects non-empty consensus batch before adapter when hanko is missing', async () => {
    const env = createEmptyEnv('j-submit-unsealed-batch');
    env.timestamp = 123;
    let adapterCalls = 0;
    env.jReplicas = new Map([
      [
        'Testnet',
        {
          jadapter: {
            submitTx: async () => {
              adapterCalls += 1;
              return { success: true };
            },
            pollNow: async () => {},
          },
        } as any,
      ],
    ]);

    await expect(submitRuntimeJOutbox(
      env,
      [
        {
          jurisdictionName: 'Testnet',
          jTxs: [
            {
              type: 'batch',
              entityId: `0x${'ac'.repeat(32)}`,
              data: {
                batch: {
                  ...createEmptyBatch(),
                  reserveToReserve: [{
                    receivingEntity: `0x${'ef'.repeat(32)}`,
                    tokenId: 1,
                    amount: 10n,
                  }],
                },
                batchSize: 1,
                signerId: `0x${'cd'.repeat(20)}`,
              },
              timestamp: env.timestamp,
            } as any,
          ],
        },
      ],
      {
        enqueueRuntimeInputs: () => {},
      },
    )).rejects.toThrow(/J_BATCH_CONSENSUS_HANKO_MISSING/);

    expect(adapterCalls).toBe(0);
  });

  test('request_collateral checks prepaid fee against derived outCapacity', () => {
    const feeDelta = {
      tokenId: 1,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 100n,
      leftCreditLimit: 0n,
      rightCreditLimit: 1000n,
      leftAllowance: 0n,
      rightAllowance: 0n,
      leftHold: 95n,
      rightHold: 0n,
    };
    const accountMachine = {
      deltas: new Map([[1, feeDelta]]),
      requestedRebalance: new Map<number, bigint>(),
      requestedRebalanceFeeState: new Map(),
    };

    const result = handleRequestCollateral(
      accountMachine as Parameters<typeof handleRequestCollateral>[0],
      {
        type: 'request_collateral',
        data: { tokenId: 1, amount: 50n, feeTokenId: 1, feeAmount: 10n, policyVersion: 1 },
      },
      true,
      0,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('insufficient fee capacity');
    expect(accountMachine.requestedRebalance.size).toBe(0);
    expect(feeDelta.offdelta).toBe(100n);
  });

  test('request_collateral tops up an existing pending request without resubmitting in-flight batch', () => {
    const delta = {
      tokenId: 1,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 1_000n,
      leftCreditLimit: 0n,
      rightCreditLimit: 2_000n,
      leftAllowance: 0n,
      rightAllowance: 0n,
      leftHold: 0n,
      rightHold: 0n,
    };
    const accountMachine = {
      deltas: new Map([[1, delta]]),
      requestedRebalance: new Map<number, bigint>([[1, 590n]]),
      requestedRebalanceFeeState: new Map([[1, {
        feeTokenId: 1,
        feePaidUpfront: 10n,
        requestedAmount: 590n,
        policyVersion: 1,
        requestedAt: 1,
        requestedByLeft: true,
        jBatchSubmittedAt: 123,
      }]]),
    };

    const result = handleRequestCollateral(
      accountMachine as Parameters<typeof handleRequestCollateral>[0],
      {
        type: 'request_collateral',
        data: { tokenId: 1, amount: 800n, feeTokenId: 1, feeAmount: 20n, policyVersion: 1 },
      },
      true,
      2,
    );

    expect(result.success).toBe(true);
    expect(accountMachine.requestedRebalance.get(1)).toBe(780n);
    expect(accountMachine.requestedRebalanceFeeState.get(1)?.feePaidUpfront).toBe(20n);
    expect(accountMachine.requestedRebalanceFeeState.get(1)?.jBatchSubmittedAt).toBe(123);
    expect(delta.offdelta).toBe(990n);
  });

  test('auto-rebalance allows pending request top-up during settlement', () => {
    const usd = 10n ** 18n;
    const accountMachine = {
      settlementWorkspace: { status: 'sent' },
      mempool: [],
      pendingFrame: undefined,
      requestedRebalance: new Map<number, bigint>([[1, 590n * usd]]),
      requestedRebalanceFeeState: new Map([[1, {
        feeTokenId: 1,
        feePaidUpfront: 10n * usd,
        requestedAmount: 590n * usd,
        policyVersion: 1,
        requestedAt: 1,
        requestedByLeft: true,
        jBatchSubmittedAt: 123,
      }]]),
      rebalancePolicy: new Map([[1, {
        r2cRequestSoftLimit: 500n * usd,
        hardLimit: 10_000n * usd,
        maxAcceptableFee: 100n * usd,
      }]]),
      deltas: new Map([[1, {
        tokenId: 1,
        collateral: 590n * usd,
        ondelta: 0n,
        offdelta: 1_390n * usd,
        leftCreditLimit: 0n,
        rightCreditLimit: 2_000n * usd,
        leftAllowance: 0n,
        rightAllowance: 0n,
        leftHold: 0n,
        rightHold: 0n,
      }]]),
    };

    const txs = checkAutoRebalance(
      accountMachine as Parameters<typeof checkAutoRebalance>[0],
      `0x${'11'.repeat(32)}`,
      `0x${'ff'.repeat(32)}`,
      { policyVersion: 1, baseFee: 10n * usd, gasFee: 0n, liquidityFeeBps: 0n },
    );

    expect(txs).toHaveLength(1);
    expect(txs[0]?.type).toBe('request_collateral');
    expect(txs[0]?.data.amount).toBe(800n * usd);
  });

  test('auto-rebalance tops up pending request fee when liquidity fee grows', () => {
    const usd = 10n ** 18n;
    const previousRequest = 590n * usd;
    const outPeerCredit = 1_000n * usd;
    const previousFee = 150_100_000_000_000_000n;
    const requiredFee = 200_000_000_000_000_000n;
    const feeTopup = requiredFee - previousFee;
    const delta = {
      tokenId: 1,
      collateral: previousRequest,
      ondelta: 0n,
      offdelta: previousRequest + outPeerCredit,
      leftCreditLimit: 2_000n * usd,
      rightCreditLimit: 2_000n * usd,
      leftAllowance: 0n,
      rightAllowance: 0n,
      leftHold: 0n,
      rightHold: 0n,
    };
    const accountMachine = {
      settlementWorkspace: { status: 'sent' },
      mempool: [],
      pendingFrame: undefined,
      deltas: new Map([[1, delta]]),
      requestedRebalance: new Map<number, bigint>([[1, previousRequest]]),
      requestedRebalanceFeeState: new Map([[1, {
        feeTokenId: 1,
        feePaidUpfront: previousFee,
        requestedAmount: previousRequest,
        policyVersion: 1,
        requestedAt: 1,
        requestedByLeft: true,
        jBatchSubmittedAt: 123,
      }]]),
      rebalancePolicy: new Map([[1, {
        r2cRequestSoftLimit: 500n * usd,
        hardLimit: 10_000n * usd,
        maxAcceptableFee: 300n * usd,
      }]]),
    };

    const txs = checkAutoRebalance(
      accountMachine as Parameters<typeof checkAutoRebalance>[0],
      `0x${'11'.repeat(32)}`,
      `0x${'ff'.repeat(32)}`,
      { policyVersion: 1, baseFee: usd / 10n, gasFee: 0n, liquidityFeeBps: 1n },
    );

    expect(txs).toHaveLength(1);
    expect(txs[0]?.type).toBe('request_collateral');
    expect(txs[0]?.data.amount).toBe(outPeerCredit);
    expect(txs[0]?.data.feeAmount).toBe(requiredFee);

    const result = handleRequestCollateral(
      accountMachine as Parameters<typeof handleRequestCollateral>[0],
      {
        type: 'request_collateral',
        data: { tokenId: 1, amount: outPeerCredit, feeTokenId: 1, feeAmount: requiredFee, policyVersion: 1 },
      },
      true,
      2,
    );

    expect(result.success).toBe(true);
    expect(accountMachine.requestedRebalance.get(1)).toBe(outPeerCredit - requiredFee);
    expect(accountMachine.requestedRebalanceFeeState.get(1)?.feePaidUpfront).toBe(requiredFee);
    expect(accountMachine.requestedRebalanceFeeState.get(1)?.requestedAmount).toBe(outPeerCredit - requiredFee);
    expect(accountMachine.requestedRebalanceFeeState.get(1)?.jBatchSubmittedAt).toBe(123);
    expect(delta.offdelta).toBe(previousRequest + outPeerCredit - feeTopup);
  });

  test('entity proposal fails fast when prevFrameHash is missing above genesis', async () => {
    const env = createEmptyEnv('audit-entity-seed');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;

    const replica = makeReplicaMissingPrevFrameHash();
    const entityInput: EntityInput = {
      entityId: replica.entityId,
      entityTxs: [
        {
          type: 'chatMessage',
          data: { message: 'forces single-signer frame creation' },
        },
      ],
    };

    await expect(applyEntityInput(env, replica, entityInput)).rejects.toThrow(
      'ENTITY_FRAME_CHAIN_CORRUPTED',
    );
  });

  test('entity commit catch-up does not apply unsigned proposed newState mutations', async () => {
    const seed = 'entity-commit-catch-up-state-binding seed alpha beta gamma';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.timestamp = 42_000;
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const frameTxs: EntityTx[] = [{
      type: 'profile-update',
      data: {
        profile: {
          entityId,
          name: 'Signed Profile',
        },
      },
    } as any];

    const honestBaseState = makeEntityState(entityId);
    honestBaseState.config = makeSingleSignerConfigFor(signerId);
    const { newState: honestFrameState } = await applyEntityFrame(
      env,
      honestBaseState,
      frameTxs,
      env.timestamp,
    );
    const honestNewState: EntityState = {
      ...honestFrameState,
      entityId,
      height: 1,
      timestamp: env.timestamp,
    };
    const frameHash = await createEntityFrameHash(
      'genesis',
      1,
      env.timestamp,
      frameTxs,
      honestNewState,
    );
    const frameSig = signAccountFrame(env, signerId, frameHash);
    const tamperedNewState: EntityState = {
      ...honestNewState,
      profile: {
        ...honestNewState.profile,
        name: 'Injected Profile',
      },
    };
    const replica = {
      entityId,
      signerId,
      mempool: [],
      isProposer: false,
      state: makeEntityState(entityId),
    } as EntityReplica;
    replica.state.config = makeSingleSignerConfigFor(signerId);

    const result = await applyEntityInput(env, replica, {
      entityId,
      signerId,
      proposedFrame: {
        height: 1,
        txs: frameTxs,
        hash: frameHash,
        newState: tamperedNewState,
        collectedSigs: new Map([[signerId, [frameSig]]]),
      },
    });

    expect(result.workingReplica.state.height).toBe(1);
    expect(result.workingReplica.state.profile.name).toBe('Signed Profile');
  });

  test('entity commit rejects invalid secondary hash signatures', async () => {
    const seed = 'entity-commit-secondary-signature-binding seed alpha beta gamma';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.timestamp = 43_000;
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const frameTxs: EntityTx[] = [{
      type: 'profile-update',
      data: {
        profile: {
          entityId,
          name: 'Signed Profile',
        },
      },
    } as any];

    const honestBaseState = makeEntityState(entityId);
    honestBaseState.config = makeSingleSignerConfigFor(signerId);
    const { newState: honestFrameState } = await applyEntityFrame(
      env,
      honestBaseState,
      frameTxs,
      env.timestamp,
    );
    const honestNewState: EntityState = {
      ...honestFrameState,
      entityId,
      height: 1,
      timestamp: env.timestamp,
    };
    const frameHash = await createEntityFrameHash(
      'genesis',
      1,
      env.timestamp,
      frameTxs,
      honestNewState,
    );
    const secondaryHash = ethers.keccak256(ethers.toUtf8Bytes('account-frame-secondary-hash'));
    const wrongSecondaryHash = ethers.keccak256(ethers.toUtf8Bytes('wrong-secondary-hash'));
    const frameSig = signAccountFrame(env, signerId, frameHash);
    const forgedSecondarySig = signAccountFrame(env, signerId, wrongSecondaryHash);
    const replica = {
      entityId,
      signerId,
      mempool: [],
      isProposer: false,
      state: makeEntityState(entityId),
    } as EntityReplica;
    replica.state.config = makeSingleSignerConfigFor(signerId);

    const result = await applyEntityInput(env, replica, {
      entityId,
      signerId,
      proposedFrame: {
        height: 1,
        txs: frameTxs,
        hash: frameHash,
        newState: honestNewState,
        hashesToSign: [
          { hash: frameHash, type: 'entityFrame', context: 'entity-frame' },
          { hash: secondaryHash, type: 'accountFrame', context: 'account-frame' },
        ],
        collectedSigs: new Map([[signerId, [frameSig, forgedSecondarySig]]]),
      },
    });

    expect(result.workingReplica.state.height).toBe(0);
    expect(result.workingReplica.state.profile.name).not.toBe('Signed Profile');
  });

  test('swap_offer refuses to add more than the configured per-account cap', async () => {
    const accountMachine = {
      leftEntity: 'left',
      rightEntity: 'right',
      deltas: new Map(),
      swapOffers: new Map(
        Array.from({ length: LIMITS.MAX_ACCOUNT_SWAP_OFFERS }, (_, index) => [String(index), {}]),
      ),
    };

    const result = await handleSwapOffer(
      accountMachine as Parameters<typeof handleSwapOffer>[0],
      {
        type: 'swap_offer',
        data: {
          offerId: 'overflow-offer',
          giveTokenId: 1,
          giveAmount: 100n,
          wantTokenId: 2,
          wantAmount: 100n,
          minFillRatio: 0,
        },
      },
      true,
      1,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain(`max ${LIMITS.MAX_ACCOUNT_SWAP_OFFERS}`);
    expect(accountMachine.swapOffers.size).toBe(LIMITS.MAX_ACCOUNT_SWAP_OFFERS);
  });

  test('proposeAccountFrame accepts a 1000 tx account frame', async () => {
    const seed = 'account-frame-cap-seed';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.browserVM = {
      getDepositoryAddress: () => hex20('dd'),
    } as typeof env.browserVM;

    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    const mempool = Array.from({ length: MAX_ACCOUNT_FRAME_TXS }, (_, index) => ({
      type: 'add_delta' as const,
      data: { tokenId: index + 1 },
    }));
    const accountMachine = makeProposalAccount(mempool, left.entityId, right.entityId);
    attachSigningReplica(env, accountMachine.proofHeader.fromEntity, left.signerId);

    const result = await proposeAccountFrame(env, accountMachine);

    expect(result.success).toBe(true);
    expect(result.accountInput?.newAccountFrame.accountTxs).toHaveLength(MAX_ACCOUNT_FRAME_TXS);
    expect(accountMachine.pendingFrame?.accountTxs).toHaveLength(MAX_ACCOUNT_FRAME_TXS);
    expect(accountMachine.mempool).toHaveLength(0);
  });

  test('proposeAccountFrame bundles the last outbound ACK into the next frame for loss recovery', async () => {
    const seed = 'account-frame-ack-loss-recovery';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.browserVM = {
      getDepositoryAddress: () => hex20('dd'),
    } as typeof env.browserVM;

    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    const accountMachine = makeProposalAccount([
      { type: 'add_delta', data: { tokenId: 1 } },
    ], left.entityId, right.entityId);
    accountMachine.currentHeight = 10;
    accountMachine.currentFrame = {
      ...accountMachine.currentFrame,
      height: 10,
      stateHash: `0x${'ab'.repeat(32)}`,
    };
    accountMachine.lastOutboundFrameAck = {
      height: 10,
      counterpartyEntityId: right.entityId,
      prevHanko: `0x${'cd'.repeat(65)}`,
    };
    attachSigningReplica(env, accountMachine.proofHeader.fromEntity, left.signerId);

    const result = await proposeAccountFrame(env, accountMachine);

    expect(result.success).toBe(true);
    expect(result.accountInput?.kind).toBe('frame_ack');
    expect(result.accountInput?.height).toBe(10);
    expect(result.accountInput?.prevHanko).toBe(accountMachine.lastOutboundFrameAck?.prevHanko);
    expect(result.accountInput?.newAccountFrame.height).toBe(11);
    expect(accountMachine.pendingAccountInput?.kind).toBe('frame_ack');
  });

  test('account storage keeps last outbound ACK so restored runtimes can bundle the next frame', () => {
    const accountMachine = makeProposalAccount([], hex20('11'), hex20('22'));
    accountMachine.lastOutboundFrameAck = {
      height: 8,
      counterpartyEntityId: hex20('22'),
      prevHanko: `0x${'aa'.repeat(65)}`,
    };
    accountMachine.hankoSignature = `0x${'bb'.repeat(65)}`;
    accountMachine.pendingForward = {
      route: [hex20('33'), hex20('44')],
      tokenId: 1,
      amount: 123n,
      description: 'pending-forward-storage',
    };

    const doc = projectAccountDoc(accountMachine);

    expect(doc.lastOutboundFrameAck).toEqual(accountMachine.lastOutboundFrameAck);
    expect(doc.hankoSignature).toBe(accountMachine.hankoSignature);
    expect(doc.pendingForward).toEqual(accountMachine.pendingForward);
  });

  test('crontab resends bundled ACK plus pending frame after relay loss', async () => {
    const env = createEmptyEnv('account-frame-bundled-resend');
    env.quietRuntimeLogs = true;
    const replica = makeReplicaMissingPrevFrameHash();
    replica.state.timestamp = 100_000;
    const counterpartyId = hex20('22');
    const counterpartySignerId = hex20('23');
    env.gossip = {
      getProfiles: () => [{
        entityId: counterpartyId,
        metadata: {
          board: {
            validators: [{ signerId: counterpartySignerId }],
          },
        },
      }],
    } as Env['gossip'];
    const pendingFrame = {
      height: 11,
      timestamp: replica.state.timestamp - ACCOUNT_PENDING_RESEND_AFTER_MS - 1,
      jHeight: 0,
      accountTxs: [{ type: 'add_delta' as const, data: { tokenId: 1 } }],
      prevFrameHash: `0x${'ab'.repeat(32)}`,
      deltas: [],
      stateHash: `0x${'cd'.repeat(32)}`,
      byLeft: true,
    };
    const accountMachine = makeProposalAccount([], replica.entityId, counterpartyId);
    accountMachine.pendingFrame = pendingFrame;
    accountMachine.pendingAccountInput = {
      kind: 'frame_ack',
      fromEntityId: replica.entityId,
      toEntityId: counterpartyId,
      height: 10,
      prevHanko: `0x${'12'.repeat(65)}`,
      newAccountFrame: pendingFrame,
      newHanko: `0x${'34'.repeat(65)}`,
    };
    replica.state.accounts.set(counterpartyId, accountMachine);

    const outputs = await executeCrontab(env, replica, replica.state.crontabState!, {
      manualBroadcastInInput: false,
    });

    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.entityId).toBe(counterpartyId);
    expect(outputs[0]?.signerId).toBe(counterpartySignerId);
    expect(outputs[0]?.entityTxs).toEqual([
      { type: 'accountInput', data: accountMachine.pendingAccountInput },
    ]);
  });

  test('handleAccountInput re-acks duplicate committed frames when the original ACK was lost', async () => {
    const seed = 'account-frame-duplicate-reack';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;

    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    const accountMachine = makeProposalAccount([], left.entityId, right.entityId);
    accountMachine.currentHeight = 10;
    accountMachine.currentFrame = {
      ...accountMachine.currentFrame,
      height: 10,
      stateHash: `0x${'ef'.repeat(32)}`,
    };
    accountMachine.lastOutboundFrameAck = {
      height: 10,
      counterpartyEntityId: right.entityId,
      prevHanko: `0x${'12'.repeat(65)}`,
    };

    const result = await handleAccountInput(env, accountMachine, {
      kind: 'frame',
      fromEntityId: right.entityId,
      toEntityId: left.entityId,
      signerId: right.signerId,
      height: 10,
      newAccountFrame: {
        ...accountMachine.currentFrame,
        prevFrameHash: `0x${'34'.repeat(32)}`,
      },
      newHanko: `0x${'56'.repeat(65)}`,
    });

    expect(result.success).toBe(true);
    expect(result.response?.kind).toBe('ack');
    expect(result.response?.height).toBe(10);
    expect(result.response?.prevHanko).toBe(accountMachine.lastOutboundFrameAck.prevHanko);
  });

  test('handleAccountInput rebuilds duplicate committed ACK when ACK cache was lost', async () => {
    const seed = 'account-frame-duplicate-reack-cache-miss';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;

    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    attachSigningReplica(env, left.entityId, left.signerId);
    const accountMachine = makeProposalAccount([], left.entityId, right.entityId);
    accountMachine.currentHeight = 10;
    accountMachine.currentFrame = {
      ...accountMachine.currentFrame,
      height: 10,
      stateHash: `0x${'ef'.repeat(32)}`,
    };
    delete accountMachine.lastOutboundFrameAck;

    const result = await handleAccountInput(env, accountMachine, {
      kind: 'frame',
      fromEntityId: right.entityId,
      toEntityId: left.entityId,
      signerId: right.signerId,
      height: 10,
      newAccountFrame: {
        ...accountMachine.currentFrame,
        prevFrameHash: `0x${'34'.repeat(32)}`,
      },
      newHanko: `0x${'56'.repeat(65)}`,
    });

    expect(result.success).toBe(true);
    expect(result.response?.kind).toBe('ack');
    expect(result.response?.height).toBe(10);
    expect(result.response?.prevHanko).toBe(accountMachine.lastOutboundFrameAck?.prevHanko);
    expect(result.events).toContain('↩️ Rebuilt ACK for duplicate committed frame 10');
    const verified = await verifyHankoForHash(
      result.response?.prevHanko || '',
      accountMachine.currentFrame.stateHash,
      left.entityId,
      env,
    );
    expect(verified.valid).toBe(true);
  });

  test('handleAccountInput rejects frames whose byLeft does not match the signed proposer', async () => {
    const seed = 'account-frame-by-left-binding';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.timestamp = 10_000;
    env.browserVM = {
      getDepositoryAddress: () => hex20('dd'),
    } as typeof env.browserVM;

    const first = registerLazySigner(seed, '1');
    const second = registerLazySigner(seed, '2');
    const left = isLeftEntity(first.entityId, second.entityId) ? first : second;
    const right = left === first ? second : first;
    attachSigningReplica(env, left.entityId, left.signerId);
    attachSigningReplica(env, right.entityId, right.signerId);

    const receiverAccount = makeProposalAccount([], left.entityId, right.entityId);
    receiverAccount.proofHeader = { fromEntity: right.entityId, toEntity: left.entityId, nonce: 0 };

    const tx: AccountTx = {
      type: 'set_credit_limit',
      data: { tokenId: 1, amount: 100n },
    };
    const maliciousFrame = {
      height: 1,
      timestamp: env.timestamp,
      jHeight: 0,
      accountTxs: [tx],
      prevFrameHash: 'genesis',
      stateHash: '',
      byLeft: false,
      deltas: [{
        tokenId: 1,
        collateral: 0n,
        ondelta: 0n,
        offdelta: 0n,
        leftCreditLimit: 100n,
        rightCreditLimit: 0n,
        leftAllowance: 0n,
        rightAllowance: 0n,
        leftHold: 0n,
        rightHold: 0n,
      }],
    };
    maliciousFrame.stateHash = await createFrameHash(maliciousFrame);
    const [newHanko] = await signEntityHashes(env, left.entityId, left.signerId, [maliciousFrame.stateHash]);

    const result = await handleAccountInput(env, receiverAccount, {
      kind: 'frame',
      fromEntityId: left.entityId,
      toEntityId: right.entityId,
      height: 1,
      newAccountFrame: maliciousFrame,
      newHanko,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Frame proposer side mismatch');
    expect(receiverAccount.deltas.get(1)?.leftCreditLimit ?? 0n).toBe(0n);
  });

  test('handleAccountInput rejects dispute seal hash mismatch before committing frame', async () => {
    const seed = 'account-frame-poisoned-dispute-seal';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.timestamp = 10_000;
    env.browserVM = {
      getDepositoryAddress: () => hex20('dd'),
    } as typeof env.browserVM;

    const first = registerLazySigner(seed, '1');
    const second = registerLazySigner(seed, '2');
    const left = isLeftEntity(first.entityId, second.entityId) ? first : second;
    const right = left === first ? second : first;
    attachSigningReplica(env, left.entityId, left.signerId);
    attachSigningReplica(env, right.entityId, right.signerId);

    const receiverAccount = makeProposalAccount([], left.entityId, right.entityId);
    receiverAccount.proofHeader = { fromEntity: right.entityId, toEntity: left.entityId, nonce: 0 };
    const tx: AccountTx = {
      type: 'set_credit_limit',
      data: { tokenId: 1, amount: 100n },
    };
    const frame = {
      height: 1,
      timestamp: env.timestamp,
      jHeight: 0,
      accountTxs: [tx],
      prevFrameHash: 'genesis',
      stateHash: '',
      byLeft: true,
      deltas: [{
        tokenId: 1,
        collateral: 0n,
        ondelta: 0n,
        offdelta: 0n,
        leftCreditLimit: 100n,
        rightCreditLimit: 0n,
        leftAllowance: 0n,
        rightAllowance: 0n,
        leftHold: 0n,
        rightHold: 0n,
      }],
    };
    frame.stateHash = await createFrameHash(frame);
    const [newHanko] = await signEntityHashes(env, left.entityId, left.signerId, [frame.stateHash]);
    const poisonedHash = `0x${'ab'.repeat(32)}`;
    const [newDisputeHanko] = await signEntityHashes(env, left.entityId, left.signerId, [poisonedHash]);

    const result = await handleAccountInput(env, receiverAccount, {
      kind: 'frame',
      fromEntityId: left.entityId,
      toEntityId: right.entityId,
      height: 1,
      newAccountFrame: frame,
      newHanko,
      newDisputeHanko,
      newDisputeHash: poisonedHash,
      newDisputeProofBodyHash: `0x${'11'.repeat(32)}`,
      disputeProofNonce: 0,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('FRAME:DISPUTE_SEAL_HASH_MISMATCH');
    expect(receiverAccount.currentHeight).toBe(0);
    expect(receiverAccount.deltas.get(1)?.leftCreditLimit ?? 0n).toBe(0n);
    expect(receiverAccount.counterpartyDisputeHash).toBeUndefined();
  });

  test('failed proposal keeps queued txs, including late arrivals, instead of wiping the mempool', async () => {
    const seed = 'account-proposal-failure-retains-mempool';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;

    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    const firstTx: AccountTx = { type: 'add_delta', data: { tokenId: 1 } };
    const lateTx: AccountTx = { type: 'add_delta', data: { tokenId: 2 } };
    const accountMachine = makeProposalAccount([firstTx], left.entityId, right.entityId);
    attachSigningReplica(env, accountMachine.proofHeader.fromEntity, left.signerId);

    queueMicrotask(() => {
      accountMachine.mempool.push(lateTx);
    });

    const result = await proposeAccountFrame(env, accountMachine);

    expect(result.success).toBe(false);
    expect(result.error).toContain('MISSING_DEPOSITORY_ADDRESS');
    expect(accountMachine.pendingFrame).toBeUndefined();
    expect(accountMachine.mempool).toHaveLength(2);
    expect(accountMachine.mempool).toEqual([firstTx, lateTx]);
  });

  test('swap_offer rejects minFillRatio for resting GTC orders', async () => {
    const accountMachine = {
      leftEntity: 'left',
      rightEntity: 'right',
      deltas: new Map(),
      swapOffers: new Map(),
    };

    const result = await handleSwapOffer(
      accountMachine as Parameters<typeof handleSwapOffer>[0],
      {
        type: 'swap_offer',
        data: {
          offerId: 'gtc-aon',
          giveTokenId: 1,
          giveAmount: 10n ** 18n,
          wantTokenId: 2,
          wantAmount: 2n * 10n ** 18n,
          minFillRatio: 32768,
          timeInForce: 0,
        },
      },
      true,
      1,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('minFillRatio > 0 requires timeInForce');
  });

  test('DisputeFinalized scrubs stale sentBatch finalize and failed Hanko does not resurrect it', async () => {
    const entityId = `0x${'12'.repeat(32)}`;
    const counterpartyId = `0x${'34'.repeat(32)}`;
    const state = makeEntityState(entityId);
    const account = makeProposalAccount([], entityId, counterpartyId);
    account.activeDispute = {
      startedByLeft: true,
      disputeTimeout: 123,
      initialProofbodyHash: `0x${'56'.repeat(32)}`,
      initialNonce: 7,
      finalizeQueued: true,
    } as AccountMachine['activeDispute'];
    state.accounts.set(counterpartyId, account);
    state.jBatchState = {
      batch: {
        ...createEmptyBatch(),
        disputeFinalizations: [{
          counterentity: counterpartyId,
          initialNonce: 7,
          finalNonce: 7,
          initialProofbodyHash: `0x${'56'.repeat(32)}`,
          finalProofbody: makeEmptyProofBody(),
          leftArguments: '0x',
              rightArguments: '0x',
              starterInitialArguments: '0x',
              starterIncrementedArguments: '0x',
          sig: '0x',
          startedByLeft: true,
          disputeUntilBlock: 123,
          cooperative: false,
        }],
      },
      jurisdiction: null,
      lastBroadcast: 0,
      broadcastCount: 0,
      failedAttempts: 0,
      status: 'sent',
      sentBatch: {
        batch: {
          ...createEmptyBatch(),
          disputeFinalizations: [{
            counterentity: counterpartyId,
            initialNonce: 7,
            finalNonce: 7,
            initialProofbodyHash: `0x${'56'.repeat(32)}`,
            finalProofbody: makeEmptyProofBody(),
            leftArguments: '0x',
              rightArguments: '0x',
              starterInitialArguments: '0x',
              starterIncrementedArguments: '0x',
            sig: '0x',
            startedByLeft: true,
            disputeUntilBlock: 123,
            cooperative: false,
          }],
        },
        batchHash: `0x${'78'.repeat(32)}`,
        encodedBatch: '0x',
        entityNonce: 7,
        firstSubmittedAt: 1000,
        lastSubmittedAt: 1000,
        submitAttempts: 1,
      },
      entityNonce: 6,
    } as EntityState['jBatchState'];

    const env = createEmptyEnv('dispute-finalize-scrub-seed');
    const disputeFinalizedEvent: JurisdictionEvent = {
      type: 'DisputeFinalized',
      data: {
        sender: entityId,
        counterentity: counterpartyId,
        initialNonce: 7,
        initialProofbodyHash: `0x${'56'.repeat(32)}`,
        finalProofbodyHash: `0x${'57'.repeat(32)}`,
      },
    };
    const signedDisputeFinalized = signJEventObservation(env, entityId, '1', {
      blockNumber: 22,
      blockHash: `0x${'99'.repeat(32)}`,
      transactionHash: `0x${'88'.repeat(32)}`,
      events: [disputeFinalizedEvent],
    });
    const finalized = await handleJEvent(state, {
      from: '1',
      observedAt: 2000,
      blockNumber: 22,
      blockHash: `0x${'99'.repeat(32)}`,
      transactionHash: `0x${'88'.repeat(32)}`,
      ...signedDisputeFinalized,
      event: disputeFinalizedEvent,
    }, env);

    expect(finalized.newState.accounts.get(counterpartyId)?.activeDispute).toBeUndefined();
    expect(finalized.newState.jBatchState?.batch.disputeFinalizations.length).toBe(0);
    expect(finalized.newState.jBatchState?.sentBatch?.batch.disputeFinalizations.length).toBe(0);

    const failedBatchEvent: JurisdictionEvent = {
      type: 'HankoBatchProcessed',
      data: {
        entityId,
        hankoHash: `0x${'55'.repeat(32)}`,
        nonce: 7,
        success: false,
      },
    };
    const signedFailedBatch = signJEventObservation(env, entityId, '1', {
      blockNumber: 23,
      blockHash: `0x${'77'.repeat(32)}`,
      transactionHash: `0x${'66'.repeat(32)}`,
      events: [failedBatchEvent],
    });
    const failed = await handleJEvent(finalized.newState, {
      from: '1',
      observedAt: 3000,
      blockNumber: 23,
      blockHash: `0x${'77'.repeat(32)}`,
      transactionHash: `0x${'66'.repeat(32)}`,
      ...signedFailedBatch,
      event: failedBatchEvent,
    }, env);

    expect(failed.newState.jBatchState?.batch.disputeFinalizations.length).toBe(0);
  });

  test('disputeFinalize waits for on-chain DisputeStarted before drafting a finalization', async () => {
    const starterId = `0x${'41'.repeat(32)}`;
    const finalizerId = `0x${'42'.repeat(32)}`;
    const state = makeEntityState(finalizerId);
    const account = makeProposalAccount([], starterId, finalizerId);
    const initialProof = buildAccountProofBody(account);
    account.disputeProofBodiesByHash = {
      [initialProof.proofBodyHash]: initialProof.proofBodyStruct,
    };
    account.activeDispute = {
      startedByLeft: true,
      initialProofbodyHash: initialProof.proofBodyHash,
      initialNonce: 1,
      disputeTimeout: 100,
      onChainNonce: 0,
      starterInitialArguments: '0x',
      starterIncrementedArguments: '0x',
      observedOnChain: false,
      finalizeQueued: false,
    };
    state.accounts.set(starterId, account);

    const env = createEmptyEnv('placeholder-dispute-finalize-runtime');
    env.quietRuntimeLogs = true;

    const { newState } = await handleDisputeFinalize(
      state,
      {
        type: 'disputeFinalize',
        data: { counterpartyEntityId: starterId },
      },
      env,
    );

    expect(newState.jBatchState?.batch.disputeFinalizations ?? []).toEqual([]);
    expect(newState.accounts.get(starterId)?.activeDispute?.finalizeQueued).toBe(false);
    expect(newState.messages.join('\n')).toContain('blocked until DisputeStarted is observed on-chain');
  });

  test('disputeFinalize uses signed counter-proof and incremented starter arguments when a newer proof is available', async () => {
    const starterId = `0x${'21'.repeat(32)}`;
    const finalizerId = `0x${'22'.repeat(32)}`;
    const depositoryAddress = hex20('1');
    const state = makeEntityState(finalizerId);
    state.config = {
      ...state.config,
      jurisdiction: {
        name: 'Testnet',
        depositoryAddress,
        entityProviderAddress: hex20('2'),
        chainId: 31337,
      },
    } as EntityState['config'];
    const account = makeProposalAccount([], starterId, finalizerId);
    account.proofHeader = { fromEntity: starterId, toEntity: finalizerId, nonce: 2 };
    account.deltas.set(1, { ...createDefaultDelta(1), offdelta: 50n });

    const initialProof = buildAccountProofBody(account);
    storeDisputeArgumentSnapshot(
      account,
      captureDisputeArgumentSnapshot(account, initialProof.proofBodyHash, 1, initialProof.proofBodyStruct),
    );

    account.deltas.set(1, { ...createDefaultDelta(1), offdelta: 75n });
    const counterProof = buildAccountProofBody(account);
    storeDisputeArgumentSnapshot(
      account,
      captureDisputeArgumentSnapshot(account, counterProof.proofBodyHash, 2, counterProof.proofBodyStruct),
    );
    account.disputeProofBodiesByHash = {
      [initialProof.proofBodyHash]: initialProof.proofBodyStruct,
      [counterProof.proofBodyHash]: counterProof.proofBodyStruct,
    };
    account.counterpartyDisputeProofBodyHash = counterProof.proofBodyHash;
    account.counterpartyDisputeProofNonce = 2;
    account.counterpartyDisputeProofHanko = '0x1234';
    account.counterpartyDisputeHash = createDisputeProofHashWithNonce(
      account,
      counterProof.proofBodyHash,
      depositoryAddress,
      2,
    );
    account.activeDispute = {
      startedByLeft: true,
      initialProofbodyHash: initialProof.proofBodyHash,
      initialNonce: 1,
      disputeTimeout: 100,
      onChainNonce: 0,
      starterInitialArguments: '0x1111',
      starterIncrementedArguments: '0x2222',
      observedOnChain: true,
      finalizeQueued: false,
    };
    state.accounts.set(starterId, account);

    const env = createEmptyEnv('counter-finalize-runtime');
    env.quietRuntimeLogs = true;
    env.lastJBlock = 1;

    const { newState } = await handleDisputeFinalize(
      state,
      {
        type: 'disputeFinalize',
        data: { counterpartyEntityId: starterId },
      },
      env,
    );

    const finalization = newState.jBatchState?.batch.disputeFinalizations[0];
    expect(finalization).toBeDefined();
    expect(finalization?.initialNonce).toBe(1);
    expect(finalization?.finalNonce).toBe(2);
    expect(finalization?.sig).toBe('0x1234');
    expect(finalization?.initialProofbodyHash).toBe(initialProof.proofBodyHash);
    expect(finalization?.finalProofbody.offdeltas).toEqual([75n]);
    expect(finalization?.finalProofbody.tokenIds).toEqual([1n]);
    expect(finalization?.leftArguments).toBe('0x2222');
    expect(finalization?.rightArguments).toBe('0x');
    expect(finalization?.starterInitialArguments).toBe('0x1111');
    expect(finalization?.starterIncrementedArguments).toBe('0x2222');
    expect(newState.accounts.get(starterId)?.activeDispute?.finalizeQueued).toBe(true);
  });

  test('auto-approved settlement nonce outranks stale high-nonce dispute proofs', async () => {
    const seed = 'auto-settlement-nonce-bumps-proof';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    const user = registerLazySigner(seed, '1');
    const hub = registerLazySigner(seed, '2');
    attachSigningReplica(env, user.entityId, user.signerId);
    attachSigningReplica(env, hub.entityId, hub.signerId);

    const depositoryAddress = hex20('1');
    const userState = makeEntityState(user.entityId);
    userState.config = {
      ...makeSingleSignerConfigFor(user.signerId),
      jurisdiction: {
        name: 'Testnet',
        depositoryAddress,
        entityProviderAddress: hex20('2'),
        chainId: 31337,
      },
    } as EntityState['config'];

    const account = makeProposalAccount([], user.entityId, hub.entityId);
    account.onChainSettlementNonce = 1;
    account.proofHeader = { fromEntity: user.entityId, toEntity: hub.entityId, nonce: 50 };

    const result = await processSettleAction(
      account,
      {
        type: 'propose',
        ops: [{ type: 'c2r', tokenId: 1, amount: 1n }],
        version: 1,
      },
      hub.entityId,
      user.entityId,
      1_000,
      env,
      userState,
    );

    expect(result.success).toBe(true);
    expect(result.autoApproveOutput?.entityTxs?.[0]?.data?.settleAction?.nonceAtSign).toBe(51);
    expect(account.settlementWorkspace?.nonceAtSign).toBe(51);
    expect(account.settlementWorkspace?.postSettlementDisputeProof?.nonce).toBe(52);
    expect(account.disputeProofNoncesByHash?.[
      account.settlementWorkspace!.postSettlementDisputeProof!.proofBodyHash
    ]).toBe(52);
  });

  test('settlement finalization activates post-settlement dispute hash atomically', () => {
    const leftId = `0x${'31'.repeat(32)}`;
    const rightId = `0x${'32'.repeat(32)}`;
    const depositoryAddress = hex20('1');
    const account = makeProposalAccount([], leftId, rightId);
    account.proofHeader = { fromEntity: leftId, toEntity: rightId, nonce: 2 };
    account.deltas.set(1, { ...createDefaultDelta(1), offdelta: 50n });

    const postProof = buildAccountProofBody(account);
    const postDisputeHash = createDisputeProofHashWithNonce(
      account,
      postProof.proofBodyHash,
      depositoryAddress,
      2,
    );
    account.counterpartyDisputeHash = `0x${'aa'.repeat(32)}`;
    account.settlementWorkspace = {
      ops: [],
      lastModifiedByLeft: true,
      status: 'submitted',
      version: 1,
      createdAt: 1,
      lastUpdatedAt: 2,
      executorIsLeft: true,
      nonceAtSign: 1,
      leftHanko: '0x11',
      rightHanko: '0x22',
      postSettlementDisputeProof: {
        leftHanko: '0x33',
        rightHanko: '0x44',
        disputeHash: postDisputeHash,
        proofBodyHash: postProof.proofBodyHash,
        nonce: 2,
      },
    };

    const settledEvent: JurisdictionEvent = {
      type: 'AccountSettled',
      data: {
        leftEntity: leftId,
        rightEntity: rightId,
        tokenId: 1,
        leftReserve: '0',
        rightReserve: '0',
        collateral: '125',
        ondelta: '0',
        nonce: 1,
      },
    };
    account.leftJObservations = [{
      jHeight: 7,
      jBlockHash: `0x${'77'.repeat(32)}`,
      events: [settledEvent],
      observedAt: 10,
    }];
    account.rightJObservations = [{
      jHeight: 7,
      jBlockHash: `0x${'77'.repeat(32)}`,
      events: [settledEvent],
      observedAt: 11,
    }];

    tryFinalizeAccountJEvents(account, rightId, { timestamp: 100 });

    expect(account.settlementWorkspace).toBeUndefined();
    expect(account.currentDisputeHash).toBe(postDisputeHash);
    expect(account.counterpartyDisputeHash).toBe(postDisputeHash);
    expect(account.currentDisputeProofBodyHash).toBe(postProof.proofBodyHash);
    expect(account.counterpartyDisputeProofBodyHash).toBe(postProof.proofBodyHash);
    expect(account.disputeProofNoncesByHash?.[postProof.proofBodyHash]).toBe(2);
    expect(account.onChainSettlementNonce).toBe(1);
  });

  test('disputeStart rejects unsupported incremented argument override instead of silently ignoring it', async () => {
    const entityId = `0x${'31'.repeat(32)}`;
    const counterpartyId = `0x${'32'.repeat(32)}`;
    const env = createEmptyEnv('dispute-start-incremented-override');
    const state = makeEntityState(entityId);

    await expect(handleDisputeStart(
      state,
      {
        type: 'disputeStart',
        data: {
          counterpartyEntityId: counterpartyId,
          starterIncrementedArguments: '0x1234',
        },
      },
      env,
    )).rejects.toThrow('DISPUTE_INCREMENTED_ARGUMENT_OVERRIDE_UNSUPPORTED');
  });

  test('j_rebroadcast resubmits the exact sent batch without mutating ops', async () => {
    const entityId = `0x${'ab'.repeat(32)}`;
    const counterpartyId = `0x${'cd'.repeat(32)}`;
    const state = makeEntityState(entityId);
    state.config = {
      ...state.config,
      jurisdiction: {
        name: 'Testnet',
        depositoryAddress: hex20('1'),
        entityProviderAddress: hex20('2'),
        chainId: 31337,
      },
    } as EntityState['config'];
    state.jBatchState = {
      batch: createEmptyBatch(),
      jurisdiction: null,
      lastBroadcast: 0,
      broadcastCount: 0,
      failedAttempts: 0,
      status: 'sent',
      sentBatch: {
        batch: {
          ...createEmptyBatch(),
          reserveToReserve: [{
            receivingEntity: `0x${'ef'.repeat(32)}`,
            tokenId: 1,
            amount: 10n,
          }],
          disputeFinalizations: [{
            counterentity: counterpartyId,
            initialNonce: 3,
            finalNonce: 3,
            initialProofbodyHash: `0x${'11'.repeat(32)}`,
            finalProofbody: makeEmptyProofBody(),
            leftArguments: '0x',
              rightArguments: '0x',
              starterInitialArguments: '0x',
              starterIncrementedArguments: '0x',
            sig: '0x',
            startedByLeft: true,
            disputeUntilBlock: 123,
            cooperative: false,
          }],
        },
        batchHash: `0x${'22'.repeat(32)}`,
        encodedBatch: '0x1234',
        entityNonce: 9,
        firstSubmittedAt: 1000,
        lastSubmittedAt: 1000,
        submitAttempts: 1,
      },
      entityNonce: 8,
    } as EntityState['jBatchState'];

    const env = createEmptyEnv('j-rebroadcast-scrub-seed');
    env.activeJurisdiction = 'Testnet';
    env.jReplicas.set('Testnet', {
      name: 'Testnet',
      blockNumber: 0n,
      stateRoot: new Uint8Array(32),
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
      position: { x: 0, y: 0, z: 0 },
      depositoryAddress: hex20('1'),
      entityProviderAddress: hex20('2'),
      contracts: {
        account: hex20('3'),
        depository: hex20('1'),
        entityProvider: hex20('2'),
        deltaTransformer: hex20('4'),
      },
      rpcs: ['http://localhost:8545'],
      chainId: 31337,
    });

    const result = await handleJRebroadcast(
      state,
      { type: 'j_rebroadcast', data: {} },
      env,
    );

    expect(result.jOutputs.length).toBe(1);
    const rebroadcast = result.jOutputs[0]?.jTxs[0];
    expect(rebroadcast?.type).toBe('batch');
    if (rebroadcast?.type === 'batch') {
      expect(rebroadcast.data.batch.disputeFinalizations.length).toBe(1);
      expect(rebroadcast.data.batch.reserveToReserve.length).toBe(1);
    }
    expect(result.newState.jBatchState?.sentBatch?.batch.disputeFinalizations.length).toBe(1);
  });

  test('j_rebroadcast refuses a terminally failed sent batch instead of retrying the same bad tx', async () => {
    const entityId = `0x${'ae'.repeat(32)}`;
    const state = makeEntityState(entityId);
    state.jBatchState = {
      batch: createEmptyBatch(),
      jurisdiction: null,
      lastBroadcast: 0,
      broadcastCount: 0,
      failedAttempts: 1,
      status: 'failed',
      sentBatch: {
        batch: {
          ...createEmptyBatch(),
          reserveToReserve: [{
            receivingEntity: `0x${'ef'.repeat(32)}`,
            tokenId: 1,
            amount: 10n,
          }],
        },
        batchHash: `0x${'22'.repeat(32)}`,
        encodedBatch: '0x1234',
        entityNonce: 9,
        firstSubmittedAt: 1000,
        lastSubmittedAt: 1000,
        submitAttempts: 1,
        terminalFailure: {
          message: 'J_SUBMIT_FATAL: staticCall revert: E3()',
          failedAt: 1001,
        },
      },
      entityNonce: 8,
    } as EntityState['jBatchState'];

    await expect(handleJRebroadcast(
      state,
      { type: 'j_rebroadcast', data: {} },
      createEmptyEnv('j-rebroadcast-terminal-failure'),
    )).rejects.toThrow(/Cannot rebroadcast failed sentBatch/);
  });

  test('HankoBatchProcessed(false) drops stale dispute finalize when on-chain nonce already moved even before DisputeFinalized arrives', async () => {
    const entityId = `0x${'91'.repeat(32)}`;
    const counterpartyId = `0x${'92'.repeat(32)}`;
    const state = makeEntityState(entityId);
    const account = makeProposalAccount([], entityId, counterpartyId);
    account.activeDispute = {
      startedByLeft: true,
      disputeTimeout: 123,
      initialProofbodyHash: `0x${'93'.repeat(32)}`,
      initialNonce: 7,
      finalizeQueued: true,
    } as AccountMachine['activeDispute'];
    account.onChainSettlementNonce = 7;
    state.accounts.set(counterpartyId, account);
    state.jBatchState = {
      batch: createEmptyBatch(),
      jurisdiction: null,
      lastBroadcast: 0,
      broadcastCount: 0,
      failedAttempts: 0,
      status: 'sent',
      sentBatch: {
        batch: {
          ...createEmptyBatch(),
          disputeFinalizations: [{
            counterentity: counterpartyId,
            initialNonce: 7,
            finalNonce: 7,
            initialProofbodyHash: `0x${'94'.repeat(32)}`,
            finalProofbody: makeEmptyProofBody(),
            leftArguments: '0x',
              rightArguments: '0x',
              starterInitialArguments: '0x',
              starterIncrementedArguments: '0x',
            sig: '0x',
            startedByLeft: true,
            disputeUntilBlock: 123,
            cooperative: false,
          }],
        },
        batchHash: `0x${'95'.repeat(32)}`,
        encodedBatch: '0x',
        entityNonce: 7,
        firstSubmittedAt: 1000,
        lastSubmittedAt: 1000,
        submitAttempts: 1,
      },
      entityNonce: 7,
    } as EntityState['jBatchState'];

    const env = createEmptyEnv('failed-batch-stale-finalize');
    const failedBatchEvent: JurisdictionEvent = {
      type: 'HankoBatchProcessed',
      data: {
        entityId,
        hankoHash: `0x${'98'.repeat(32)}`,
        nonce: 7,
        success: false,
      },
    };
    const signedFailedBatch = signJEventObservation(env, entityId, '1', {
      blockNumber: 23,
      blockHash: `0x${'96'.repeat(32)}`,
      transactionHash: `0x${'97'.repeat(32)}`,
      events: [failedBatchEvent],
    });
    const failed = await handleJEvent(state, {
      from: '1',
      observedAt: 3000,
      blockNumber: 23,
      blockHash: `0x${'96'.repeat(32)}`,
      transactionHash: `0x${'97'.repeat(32)}`,
      ...signedFailedBatch,
      event: failedBatchEvent,
    }, env);

    expect(failed.newState.jBatchState?.batch.disputeFinalizations.length).toBe(0);
  });


  test('htlc_lock refuses to add more than the configured per-account cap', async () => {
    const accountMachine = {
      deltas: new Map(),
      currentHeight: 0,
      locks: new Map(
        Array.from({ length: LIMITS.MAX_ACCOUNT_HTLC_LOCKS }, (_, index) => [String(index), {}]),
      ),
    };

    const result = await handleHtlcLock(
      accountMachine as Parameters<typeof handleHtlcLock>[0],
      {
        type: 'htlc_lock',
        data: {
          lockId: 'overflow-lock',
          hashlock: `0x${'11'.repeat(32)}`,
          timelock: 1_000_000n,
          revealBeforeHeight: 100,
          amount: 1n,
          tokenId: 1,
        },
      },
      true,
      0,
      1,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain(`max ${LIMITS.MAX_ACCOUNT_HTLC_LOCKS}`);
    expect(accountMachine.locks.size).toBe(LIMITS.MAX_ACCOUNT_HTLC_LOCKS);
  });

  test('cross-j committed pull_resolve followup rejects malformed binary instead of skipping it', () => {
    const env = createEmptyEnv('cross-pull-resolve-invalid-binary');
    const sourceUser = `0x${'10'.repeat(32)}`;
    const sourceHub = `0x${'20'.repeat(32)}`;
    const targetHub = `0x${'30'.repeat(32)}`;
    const targetUser = `0x${'40'.repeat(32)}`;
    const sourceState = makeEntityState(sourceHub);
    sourceState.crossJurisdictionSwaps = new Map([
      ['cross-invalid-binary', {
        orderId: 'cross-invalid-binary',
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        source: {
          jurisdiction: 'eth',
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 1,
          amount: 1_000n,
        },
        target: {
          jurisdiction: 'tron',
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 1,
          amount: 1_000n,
        },
        sourcePull: {
          pullId: 'source-pull',
          tokenId: 1,
          amount: 1_000n,
          signedAmount: 1_000n,
          revealedUntilTimestamp: 60_000,
          fullHash: `0x${'aa'.repeat(32)}`,
          partialRoot: `0x${'bb'.repeat(32)}`,
        },
        targetPull: {
          pullId: 'target-pull',
          tokenId: 1,
          amount: 1_000n,
          signedAmount: 1_000n,
          revealedUntilTimestamp: 60_000,
          fullHash: `0x${'cc'.repeat(32)}`,
          partialRoot: `0x${'dd'.repeat(32)}`,
        },
        status: 'partially_filled',
        cumulativeFillRatio: 1,
        fillSeq: 1,
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 60_000,
      } satisfies CrossJurisdictionSwapRoute],
    ]);

    expect(() => applyCommittedCrossJurisdictionAccountTxFollowup(
      env,
      sourceState,
      sourceUser,
      {
        type: 'pull_resolve',
        data: {
          pullId: 'source-pull',
          binary: '0x1234',
        },
      },
      [],
    )).toThrow('CROSS_J_PULL_RESOLVE_BINARY_INVALID');
  });

  test('cross-j source fill ack routes book removal to canonical sibling owner', async () => {
    const env = createEmptyEnv('cross-book-owner-removal');
    const sourceUser = `0x${'10'.repeat(32)}`;
    const sourceHub = `0x${'20'.repeat(32)}`;
    const targetHub = `0x${'30'.repeat(32)}`;
    const orderId = 'cross-owner-full-fill';
    const pairId = 'cross:stack:1:0xdep:1/stack:2:0xdep:1';
    const namespacedOrderId = `${sourceUser}:${orderId}`;

    const sourceState = makeEntityState(sourceHub);
    sourceState.config = makeSingleSignerConfigFor('source-signer');
    const route: CrossJurisdictionSwapRoute = {
      orderId,
      bookOwnerEntityId: targetHub,
      venueId: pairId,
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: {
        jurisdiction: 'stack:2:0xdep',
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 1_000n,
      },
      target: {
        jurisdiction: 'stack:1:0xdep',
        entityId: targetHub,
        counterpartyEntityId: `0x${'40'.repeat(32)}`,
        tokenId: 1,
        amount: 1_000n,
      },
      status: 'partially_filled',
      fillSeq: 1,
      cumulativeFillRatio: 100,
      filledSourceAmount: 1n,
      filledTargetAmount: 1n,
      createdAt: 1,
      updatedAt: 1,
    };
    sourceState.crossJurisdictionSwaps = new Map([
      [orderId, route],
    ]);

    let book = createBook({ bucketWidthTicks: 10_000n, maxOrders: 10_000, stpPolicy: 1 });
    book = applyCommand(book, {
      kind: 0,
      ownerId: sourceUser,
      orderId: namespacedOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 10_000n,
      qtyLots: 1n,
    }).state;
    const targetState = makeEntityState(targetHub);
    targetState.config = makeSingleSignerConfigFor('target-signer');
    targetState.orderbookExt = {
      books: new Map([[pairId, book]]),
      orderPairs: new Map([[namespacedOrderId, [pairId]]]),
      referrals: new Map(),
      hubProfile: {
        entityId: targetHub,
        name: 'Target hub',
        spreadDistribution: { makerBps: 0, takerBps: 10_000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 },
        referenceTokenId: 1,
        minTradeSize: 0n,
        supportedPairs: [pairId],
      },
    } satisfies OrderbookExtState;
    env.eReplicas.set(`${sourceHub}:source-signer`, {
      entityId: sourceHub,
      signerId: 'source-signer',
      mempool: [],
      isProposer: true,
      state: sourceState,
    } satisfies EntityReplica);
    env.eReplicas.set(`${targetHub}:target-signer`, {
      entityId: targetHub,
      signerId: 'target-signer',
      mempool: [],
      isProposer: true,
      state: targetState,
    } satisfies EntityReplica);

    const outputs: EntityInput[] = [];
    const ackTx: Extract<AccountTx, { type: 'cross_swap_fill_ack' }> = {
      type: 'cross_swap_fill_ack',
      data: {
        offerId: orderId,
        fillSeq: 1,
        incrementalSourceAmount: 0n,
        incrementalTargetAmount: 0n,
        cumulativeSourceAmount: 1n,
        cumulativeTargetAmount: 1n,
        cumulativeFillRatio: 100,
        cancelRemainder: true,
      },
    };
    const applied = applyCommittedCrossJurisdictionAccountTxFollowup(
      env,
      sourceState,
      sourceUser,
      ackTx,
      outputs,
    );

    expect(applied).toBe(true);
    const removal = outputs.find(output => output.entityId === targetHub && output.entityTxs?.[0]?.type === 'removeCrossJurisdictionBookOrder');
    expect(removal?.signerId).toBe('target-signer');
    expect(removal?.entityTxs?.[0]).toMatchObject({
      type: 'removeCrossJurisdictionBookOrder',
      data: {
        orderId,
        sourceEntityId: sourceUser,
        reason: 'fill_ack_closed',
      },
    });
    expect((removal?.entityTxs?.[0] as any)?.data?.route?.orderId).toBe(orderId);

    const removed = await applyEntityTx(env, targetState, removal!.entityTxs![0]!);
    const nextBook = removed.newState.orderbookExt?.books.get(pairId);
    expect(nextBook ? getBookOrder(nextBook, namespacedOrderId) : null).toBeNull();
  });

  test('cross-j book-owner fill ack routes admitted remote order to source hub', async () => {
    const env = createEmptyEnv('cross-book-owner-fill-notice');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const lot = SWAP_LOT_SCALE;
    const sourceHub = `0x${'20'.repeat(32)}`;
    const bookOwnerHub = `0x${'30'.repeat(32)}`;
    const remoteMaker = `0x${'31'.repeat(32)}`;
    const remoteTargetUser = `0x${'32'.repeat(32)}`;
    const localTaker = `0x${'33'.repeat(32)}`;
    const localTargetUser = `0x${'34'.repeat(32)}`;
    const pairId = 'cross:base:2/tron:1';

    const buildRoute = (
      orderId: string,
      sourceJurisdiction: string,
      sourceEntityId: string,
      sourceHubId: string,
      sourceTokenId: number,
      sourceAmount: bigint,
      targetJurisdiction: string,
      targetHubId: string,
      targetUserId: string,
      targetTokenId: number,
      targetAmount: bigint,
    ): CrossJurisdictionSwapRoute => {
      const prepared = buildPreparedCrossJurisdictionRoute({
        orderId,
        makerEntityId: sourceEntityId,
        hubEntityId: bookOwnerHub,
        bookOwnerEntityId: bookOwnerHub,
        venueId: pairId,
        sourceSignerId: `${orderId}-source-signer`,
        sourceHubSignerId: sourceHubId === sourceHub ? 'source-hub-signer' : 'book-owner-signer',
        targetHubSignerId: targetHubId === bookOwnerHub ? 'book-owner-signer' : 'target-hub-signer',
        targetSignerId: `${orderId}-target-signer`,
        bookHubSignerId: 'book-owner-signer',
        source: {
          jurisdiction: sourceJurisdiction,
          entityId: sourceEntityId,
          counterpartyEntityId: sourceHubId,
          tokenId: sourceTokenId,
          amount: sourceAmount,
        },
        target: {
          jurisdiction: targetJurisdiction,
          entityId: targetHubId,
          counterpartyEntityId: targetUserId,
          tokenId: targetTokenId,
          amount: targetAmount,
        },
        status: 'resting',
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
        expiresAt: env.timestamp + 60_000,
      }, { runtimeSeed: 'cross-book-owner-fill-notice', sourceDisputeDelayMs: 5_000, now: env.timestamp });
      return { ...prepared, status: 'resting', updatedAt: env.timestamp };
    };

    const makerRoute = buildRoute(
      'remote-maker-cross',
      'base',
      remoteMaker,
      sourceHub,
      2,
      30n * lot,
      'tron',
      bookOwnerHub,
      remoteTargetUser,
      1,
      75_000n * lot,
    );
    const takerRoute = buildRoute(
      'local-taker-cross',
      'tron',
      localTaker,
      bookOwnerHub,
      1,
      75_000n * lot,
      'base',
      bookOwnerHub,
      localTargetUser,
      2,
      30n * lot,
    );

    const receipt = (route: CrossJurisdictionSwapRoute, leg: 'source' | 'target') => {
      const pull = leg === 'source' ? route.sourcePull! : route.targetPull!;
      return buildCrossJurisdictionBookAdmissionReceipt(
        route,
        leg,
        {
          type: 'pull_lock',
          data: {
            pullId: pull.pullId,
            tokenId: pull.tokenId,
            amount: pull.signedAmount,
            revealedUntilTimestamp: pull.revealedUntilTimestamp,
            fullHash: pull.fullHash,
            partialRoot: pull.partialRoot,
          },
        },
        leg === 'source' ? route.source.counterpartyEntityId : route.target.entityId,
        leg === 'source' ? route.source.entityId : route.target.counterpartyEntityId,
        env.timestamp,
      );
    };

    const sourceState = makeEntityState(sourceHub);
    sourceState.config = makeSingleSignerConfigFor('source-hub-signer');
    sourceState.config = {
      ...sourceState.config,
      validators: ['source-primary-signer', 'source-hub-signer'],
      shares: { 'source-primary-signer': 1n, 'source-hub-signer': 1n },
    };
    sourceState.crossJurisdictionSwaps = new Map([[makerRoute.orderId, makerRoute]]);
    const makerSourceAccount = makeProposalAccount([], sourceHub, remoteMaker);
    makerSourceAccount.swapOffers.set(makerRoute.orderId, {
      offerId: makerRoute.orderId,
      giveTokenId: makerRoute.source.tokenId,
      giveAmount: makerRoute.source.amount,
      wantTokenId: makerRoute.target.tokenId,
      wantAmount: makerRoute.target.amount,
      makerIsLeft: makerSourceAccount.leftEntity.toLowerCase() === remoteMaker.toLowerCase(),
      minFillRatio: 0,
      timeInForce: 0,
      createdHeight: 1,
      priceTicks: 25_000_000n,
      crossJurisdiction: makerRoute,
    });
    sourceState.accounts.set(remoteMaker, makerSourceAccount);

    const bookOwnerState = makeEntityState(bookOwnerHub);
    bookOwnerState.config = makeSingleSignerConfigFor('book-owner-signer');
    mergeCrossJurisdictionBookAdmission(bookOwnerState, makerRoute, env.timestamp, receipt(makerRoute, 'source'));
    const makerAdmission = mergeCrossJurisdictionBookAdmission(
      bookOwnerState,
      makerRoute,
      env.timestamp,
      receipt(makerRoute, 'target'),
    );
    makerAdmission.status = 'admitted';
    makerAdmission.admittedAt = env.timestamp;
    bookOwnerState.crossJurisdictionSwaps?.set(makerRoute.orderId, makerRoute);

    const makerMeta = buildCrossJurisdictionMarketOffer({
      offerId: makerRoute.orderId,
      accountId: remoteMaker,
      makerIsLeft: true,
      fromEntity: remoteMaker,
      toEntity: sourceHub,
      createdHeight: 1,
      giveTokenId: makerRoute.source.tokenId,
      giveAmount: makerRoute.source.amount,
      wantTokenId: makerRoute.target.tokenId,
      wantAmount: makerRoute.target.amount,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: 25_000_000n,
      crossJurisdiction: makerRoute,
    }, bookOwnerHub);
    expect(makerMeta).not.toBeNull();
    let book = createBook({ bucketWidthTicks: 10_000n, maxOrders: 10_000, stpPolicy: 1 });
    book = applyCommand(book, {
      kind: 0,
      ownerId: makerMeta!.makerId,
      orderId: `${remoteMaker}:${makerRoute.orderId}`,
      side: makerMeta!.side,
      tif: 0,
      postOnly: false,
      priceTicks: makerMeta!.priceTicks,
      qtyLots: makerMeta!.baseAmount / lot,
    }).state;
    bookOwnerState.orderbookExt = {
      books: new Map([[pairId, book]]),
      orderPairs: new Map([[`${remoteMaker}:${makerRoute.orderId}`, [pairId]]]),
      referrals: new Map(),
      hubProfile: {
        entityId: bookOwnerHub,
        name: 'Book owner hub',
        spreadDistribution: { makerBps: 0, takerBps: 10_000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 },
        referenceTokenId: 1,
        minTradeSize: 0n,
        supportedPairs: [pairId],
      },
    } satisfies OrderbookExtState;

    const takerAccount = makeProposalAccount([], bookOwnerHub, localTaker);
    takerAccount.swapOffers.set(takerRoute.orderId, {
      offerId: takerRoute.orderId,
      giveTokenId: takerRoute.source.tokenId,
      giveAmount: takerRoute.source.amount,
      wantTokenId: takerRoute.target.tokenId,
      wantAmount: takerRoute.target.amount,
      makerIsLeft: takerAccount.leftEntity.toLowerCase() === localTaker.toLowerCase(),
      minFillRatio: 0,
      timeInForce: 0,
      createdHeight: 2,
      priceTicks: 25_000_000n,
      crossJurisdiction: takerRoute,
    });
    bookOwnerState.accounts.set(localTaker, takerAccount);

    const collisionOwner = `0x${'35'.repeat(32)}`;
    const collisionState = makeEntityState(collisionOwner);
    collisionState.config = makeSingleSignerConfigFor('collision-signer');
    const collisionAccount = makeProposalAccount([], collisionOwner, remoteMaker);
    collisionAccount.swapOffers.set(makerRoute.orderId, {
      offerId: makerRoute.orderId,
      giveTokenId: makerRoute.source.tokenId,
      giveAmount: makerRoute.source.amount,
      wantTokenId: makerRoute.target.tokenId,
      wantAmount: makerRoute.target.amount,
      makerIsLeft: collisionAccount.leftEntity.toLowerCase() === remoteMaker.toLowerCase(),
      minFillRatio: 0,
      timeInForce: 0,
      createdHeight: 1,
      priceTicks: 25_000_000n,
      crossJurisdiction: makerRoute,
    });
    collisionState.accounts.set(remoteMaker, collisionAccount);
    env.eReplicas.set(`${collisionOwner}:collision-signer`, {
      entityId: collisionOwner,
      signerId: 'collision-signer',
      mempool: [],
      isProposer: true,
      state: collisionState,
    } satisfies EntityReplica);
    env.eReplicas.set(`${sourceHub}:source-hub-signer`, {
      entityId: sourceHub,
      signerId: 'source-hub-signer',
      mempool: [],
      isProposer: true,
      state: sourceState,
    } satisfies EntityReplica);
    env.eReplicas.set(`${bookOwnerHub}:book-owner-signer`, {
      entityId: bookOwnerHub,
      signerId: 'book-owner-signer',
      mempool: [],
      isProposer: true,
      state: bookOwnerState,
    } satisfies EntityReplica);

    makerAdmission.route.sourceHubSignerId = 'stale-source-hub-signer';
    await expect(applyEntityFrame(env, bookOwnerState, [
      {
        type: 'admitCrossJurisdictionBookOrder',
        data: { route: takerRoute, receipt: receipt(takerRoute, 'source'), reason: 'source_pull_committed' },
      },
      {
        type: 'admitCrossJurisdictionBookOrder',
        data: { route: takerRoute, receipt: receipt(takerRoute, 'target'), reason: 'target_pull_committed' },
      },
    ])).rejects.toThrow(/CROSS_J_FILL_ACK_SOURCE_HUB_SIGNER_MISMATCH/);
    makerAdmission.route.sourceHubSignerId = 'source-hub-signer';

    const matched = await applyEntityFrame(env, bookOwnerState, [
      {
        type: 'admitCrossJurisdictionBookOrder',
        data: { route: takerRoute, receipt: receipt(takerRoute, 'source'), reason: 'source_pull_committed' },
      },
      {
        type: 'admitCrossJurisdictionBookOrder',
        data: { route: takerRoute, receipt: receipt(takerRoute, 'target'), reason: 'target_pull_committed' },
      },
    ]);

    const sourceNotice = matched.outputs.find(output =>
      output.entityId.toLowerCase() === sourceHub.toLowerCase() &&
      output.entityTxs?.[0]?.type === 'crossJurisdictionFillNotice'
    );
    expect(sourceNotice?.signerId).toBe('source-hub-signer');
    expect(sourceNotice?.entityTxs?.[0]).toMatchObject({
      type: 'crossJurisdictionFillNotice',
      data: {
        orderId: makerRoute.orderId,
        pairId,
      },
    });
    const collisionNotice = matched.outputs.find(output =>
      output.entityId.toLowerCase() === collisionOwner.toLowerCase() &&
      output.entityTxs?.[0]?.type === 'crossJurisdictionFillNotice'
    );
    expect(collisionNotice).toBeUndefined();

    const sourceApplied = await applyEntityFrame(env, sourceState, sourceNotice!.entityTxs!);
    const sourceAccount = sourceApplied.newState.accounts.get(remoteMaker);
    const queuedAck = [
      ...(sourceAccount?.mempool ?? []),
      ...(sourceAccount?.pendingFrame?.accountTxs ?? []),
    ].find(tx =>
      tx.type === 'cross_swap_fill_ack' && tx.data.offerId === makerRoute.orderId
    );
    expect(queuedAck).toBeDefined();
  });

  test('cross-j local fill ack stays on the local source offer when an admission key collides', async () => {
    const env = createEmptyEnv('cross-local-fill-ack-admission-collision');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const lot = SWAP_LOT_SCALE;
    const sourceHub = `0x${'36'.repeat(32)}`;
    const user = `0x${'37'.repeat(32)}`;
    const targetHub = `0x${'38'.repeat(32)}`;
    const targetUser = `0x${'39'.repeat(32)}`;
    const wrongHub = `0x${'3a'.repeat(32)}`;
    const orderId = 'local-offer-admission-collision';
    const pairId = 'cross:base:2/tron:1';
    const route = buildPreparedCrossJurisdictionRoute({
      orderId,
      makerEntityId: user,
      hubEntityId: sourceHub,
      bookOwnerEntityId: sourceHub,
      venueId: pairId,
      sourceSignerId: 'user-signer',
      sourceHubSignerId: 'source-hub-signer',
      targetHubSignerId: 'target-hub-signer',
      targetSignerId: 'target-user-signer',
      bookHubSignerId: 'source-hub-signer',
      source: {
        jurisdiction: 'base',
        entityId: user,
        counterpartyEntityId: sourceHub,
        tokenId: 2,
        amount: 10n * lot,
      },
      target: {
        jurisdiction: 'tron',
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 25_000n * lot,
      },
      status: 'resting',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: env.timestamp + 60_000,
    }, { runtimeSeed: 'cross-local-fill-ack-admission-collision', sourceDisputeDelayMs: 5_000, now: env.timestamp });
    const restingRoute = { ...route, status: 'resting' as const, updatedAt: env.timestamp };
    const sourceState = makeEntityState(sourceHub);
    sourceState.config = makeSingleSignerConfigFor('source-hub-signer');
    sourceState.crossJurisdictionSwaps = new Map([[orderId, restingRoute]]);
    const account = makeProposalAccount([], sourceHub, user);
    account.swapOffers.set(orderId, {
      offerId: orderId,
      giveTokenId: restingRoute.source.tokenId,
      giveAmount: restingRoute.source.amount,
      wantTokenId: restingRoute.target.tokenId,
      wantAmount: restingRoute.target.amount,
      makerIsLeft: account.leftEntity.toLowerCase() === user.toLowerCase(),
      minFillRatio: 0,
      timeInForce: 0,
      createdHeight: 1,
      priceTicks: 25_000_000n,
      crossJurisdiction: restingRoute,
    });
    sourceState.accounts.set(user, account);

    const conflictingRoute = buildPreparedCrossJurisdictionRoute({
      orderId,
      makerEntityId: user,
      hubEntityId: wrongHub,
      bookOwnerEntityId: wrongHub,
      venueId: pairId,
      sourceSignerId: 'user-signer',
      sourceHubSignerId: 'wrong-hub-signer',
      targetHubSignerId: 'target-hub-signer',
      targetSignerId: 'target-user-signer',
      bookHubSignerId: 'wrong-hub-signer',
      source: {
        jurisdiction: 'base',
        entityId: user,
        counterpartyEntityId: wrongHub,
        tokenId: 2,
        amount: 10n * lot,
      },
      target: {
        jurisdiction: 'tron',
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 25_000n * lot,
      },
      status: 'resting',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: env.timestamp + 60_000,
    }, { runtimeSeed: 'cross-local-fill-ack-admission-collision-conflict', sourceDisputeDelayMs: 5_000, now: env.timestamp });
    const conflictingAdmission = mergeCrossJurisdictionBookAdmission(sourceState, conflictingRoute, env.timestamp);
    conflictingAdmission.status = 'admitted';
    conflictingAdmission.admittedAt = env.timestamp;

    const applied = await applyEntityFrame(env, sourceState, [{
      type: 'crossJurisdictionFillNotice',
      data: {
        orderId,
        fillSeq: 1,
        incrementalSourceAmount: restingRoute.source.amount,
        incrementalTargetAmount: restingRoute.target.amount,
        cumulativeSourceAmount: restingRoute.source.amount,
        cumulativeTargetAmount: restingRoute.target.amount,
        cumulativeFillRatio: 65_535,
        pairId,
      },
    }]);

    const wrongHubNotice = applied.outputs.find(output =>
      output.entityId.toLowerCase() === wrongHub.toLowerCase() &&
      output.entityTxs?.[0]?.type === 'crossJurisdictionFillNotice'
    );
    expect(wrongHubNotice).toBeUndefined();
    const queuedAck = [
      ...(applied.newState.accounts.get(user)?.mempool ?? []),
      ...(applied.newState.accounts.get(user)?.pendingFrame?.accountTxs ?? []),
    ].find(tx => tx.type === 'cross_swap_fill_ack' && tx.data.offerId === orderId);
    expect(queuedAck).toBeDefined();
  });

  test('cross-j fill notice waits for source offer instead of looping fatal errors', async () => {
    const env = createEmptyEnv('cross-fill-notice-pending-source-offer');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const lot = SWAP_LOT_SCALE;
    const sourceHub = `0x${'20'.repeat(32)}`;
    const sourceUser = `0x${'31'.repeat(32)}`;
    const targetHub = `0x${'32'.repeat(32)}`;
    const targetUser = `0x${'33'.repeat(32)}`;
    const orderId = 'source-offer-race';
    const pairId = 'cross:base:2/tron:1';
    const route = buildPreparedCrossJurisdictionRoute({
      orderId,
      makerEntityId: sourceUser,
      hubEntityId: targetHub,
      bookOwnerEntityId: targetHub,
      venueId: pairId,
      sourceSignerId: 'source-user-signer',
      sourceHubSignerId: 'source-hub-signer',
      targetHubSignerId: 'target-hub-signer',
      targetSignerId: 'target-user-signer',
      bookHubSignerId: 'target-hub-signer',
      source: {
        jurisdiction: 'base',
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 2,
        amount: 30n * lot,
      },
      target: {
        jurisdiction: 'tron',
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 75_000n * lot,
      },
      status: 'resting',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: env.timestamp + 60_000,
    }, { runtimeSeed: 'cross-fill-notice-pending-source-offer', sourceDisputeDelayMs: 5_000, now: env.timestamp });
    route.status = 'resting';

    const sourceState = makeEntityState(sourceHub);
    sourceState.config = makeSingleSignerConfigFor('source-hub-signer');
    sourceState.crossJurisdictionSwaps = new Map([[orderId, route]]);
    sourceState.accounts.set(sourceUser, makeProposalAccount([], sourceHub, sourceUser));

    const first = await applyEntityFrame(env, sourceState, [
      {
        type: 'crossJurisdictionFillNotice',
        data: {
          orderId,
          fillSeq: 1,
          incrementalSourceAmount: 30n * lot,
          incrementalTargetAmount: 75_000n * lot,
          cumulativeSourceAmount: 30n * lot,
          cumulativeTargetAmount: 75_000n * lot,
          cumulativeFillRatio: 65_535,
          pairId,
        },
      },
    ]);

    expect(first.newState.pendingCrossJurisdictionFillAcks?.size).toBe(1);
    const pendingAccount = first.newState.accounts.get(sourceUser);
    const prematurelyQueued = [
      ...(pendingAccount?.mempool ?? []),
      ...(pendingAccount?.pendingFrame?.accountTxs ?? []),
    ].find(tx => tx.type === 'cross_swap_fill_ack' && tx.data.offerId === orderId);
    expect(prematurelyQueued).toBeUndefined();

    const expiredState = structuredClone(first.newState) as typeof first.newState;
    const expiredEnv = createEmptyEnv('cross-fill-notice-pending-source-offer-expired');
    expiredEnv.timestamp = env.timestamp + CROSS_J_PENDING_FILL_ACK_TTL_MS + 1;
    expiredState.timestamp = expiredEnv.timestamp;
    const preserved = await applyEntityFrame(expiredEnv, expiredState, []);
    const preservedAck = preserved.newState.pendingCrossJurisdictionFillAcks?.values().next().value;
    expect(preservedAck?.ttlExpiredAt).toBe(expiredEnv.timestamp);

    const stateWithOffer = first.newState;
    const sourceAccount = stateWithOffer.accounts.get(sourceUser)!;
    sourceAccount.swapOffers.set(orderId, {
      offerId: orderId,
      giveTokenId: route.source.tokenId,
      giveAmount: route.source.amount,
      wantTokenId: route.target.tokenId,
      wantAmount: route.target.amount,
      makerIsLeft: sourceAccount.leftEntity.toLowerCase() === sourceUser.toLowerCase(),
      minFillRatio: 0,
      timeInForce: 0,
      createdHeight: 1,
      priceTicks: 25_000_000n,
      crossJurisdiction: route,
    });

    const second = await applyEntityFrame(env, stateWithOffer, []);
    expect(second.newState.pendingCrossJurisdictionFillAcks?.size ?? 0).toBe(0);
    const drainedAccount = second.newState.accounts.get(sourceUser);
    const queuedAck = [
      ...(drainedAccount?.mempool ?? []),
      ...(drainedAccount?.pendingFrame?.accountTxs ?? []),
    ].find(tx => tx.type === 'cross_swap_fill_ack' && tx.data.offerId === orderId);
    expect(queuedAck).toBeDefined();
  });

  test('cross-j fill ack admission fallback requires matching route hash', () => {
    const env = createEmptyEnv('cross-fill-ack-admission-fallback');
    env.timestamp = 10_000;
    const sourceHub = `0x${'20'.repeat(32)}`;
    const sourceUser = `0x${'31'.repeat(32)}`;
    const targetHub = `0x${'32'.repeat(32)}`;
    const targetUser = `0x${'33'.repeat(32)}`;
    const orderId = 'source-admission-fallback';
    const route = buildPreparedCrossJurisdictionRoute({
      orderId,
      makerEntityId: sourceUser,
      hubEntityId: targetHub,
      bookOwnerEntityId: targetHub,
      venueId: 'cross:base:2/tron:1',
      sourceSignerId: 'source-user-signer',
      sourceHubSignerId: 'source-hub-signer',
      targetHubSignerId: 'target-hub-signer',
      targetSignerId: 'target-user-signer',
      bookHubSignerId: 'target-hub-signer',
      source: {
        jurisdiction: 'base',
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 2,
        amount: 10n * SWAP_LOT_SCALE,
      },
      target: {
        jurisdiction: 'tron',
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: 25_000n * SWAP_LOT_SCALE,
      },
      status: 'resting',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: env.timestamp + 60_000,
    }, { runtimeSeed: 'cross-fill-ack-admission-fallback', sourceDisputeDelayMs: 5_000, now: env.timestamp });
    const state = makeEntityState(targetHub);
    const routeHash = route.routeHash || 'route-hash';
    const admission = {
      orderId,
      routeHash,
      sourceEntityId: sourceUser,
      bookOwnerEntityId: targetHub,
      status: 'admitted' as const,
      route,
      updatedAt: env.timestamp,
    };
    state.crossJurisdictionBookAdmissions = new Map([[`${sourceUser.toLowerCase()}:${orderId}`, admission]]);

    expect(findCrossJurisdictionBookAdmissionForAck(state, sourceUser, orderId)).toBe(admission);
    expect(findCrossJurisdictionBookAdmissionForAck(state, sourceUser, orderId, `0x${'ff'.repeat(32)}`)).toBeNull();
    expect(findCrossJurisdictionBookAdmissionForAck(state, sourceUser, orderId, routeHash)).toBe(admission);
    expect(findCrossJurisdictionBookAdmissionForAck(state, targetHub, orderId)).toBeNull();
    expect(findCrossJurisdictionBookAdmissionForAck(state, targetHub, orderId, `0x${'ff'.repeat(32)}`)).toBeNull();
    expect(findCrossJurisdictionBookAdmissionForAck(state, targetHub, orderId, routeHash)).toBe(admission);
  });

  test('target-bonus fill fails closed when target hub route is unavailable', async () => {
    const env = createEmptyEnv('cross-target-bonus-unroutable');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const hubId = `0x${'20'.repeat(32)}`;
    const sourceMaker = `0x${'31'.repeat(32)}`;
    const sourceTaker = `0x${'32'.repeat(32)}`;
    const makerTargetUser = `0x${'33'.repeat(32)}`;
    const missingTargetHub = `0x${'34'.repeat(32)}`;
    const takerTargetUser = `0x${'35'.repeat(32)}`;
    const pairId = 'cross:base:1/tron:1';
    const lot = SWAP_LOT_SCALE;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    const makeHubAccount = (counterpartyId: string): AccountMachine => {
      const [left, right] = hubId.toLowerCase() < counterpartyId.toLowerCase()
        ? [hubId, counterpartyId]
        : [counterpartyId, hubId];
      return makeProposalAccount([], left, right);
    };

    const buildRoute = (
      orderId: string,
      sourceJurisdiction: string,
      sourceEntityId: string,
      sourceHubId: string,
      sourceAmount: bigint,
      targetJurisdiction: string,
      targetHubId: string,
      targetUserId: string,
      targetAmount: bigint,
    ): CrossJurisdictionSwapRoute => {
      const prepared = buildPreparedCrossJurisdictionRoute({
        orderId,
        makerEntityId: sourceEntityId,
        hubEntityId: hubId,
        bookOwnerEntityId: hubId,
        venueId: pairId,
        source: {
          jurisdiction: sourceJurisdiction,
          entityId: sourceEntityId,
          counterpartyEntityId: sourceHubId,
          tokenId: 1,
          amount: sourceAmount,
        },
        target: {
          jurisdiction: targetJurisdiction,
          entityId: targetHubId,
          counterpartyEntityId: targetUserId,
          tokenId: 1,
          amount: targetAmount,
        },
        priceImprovementMode: 'target_bonus',
        status: 'resting',
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
        expiresAt: env.timestamp + 60_000,
      }, { runtimeSeed: 'cross-target-bonus-unroutable', sourceDisputeDelayMs: 5_000, now: env.timestamp });
      return { ...prepared, status: 'resting', updatedAt: env.timestamp };
    };

    const makerRoute = buildRoute(
      'target-bonus-maker-bid',
      'tron',
      sourceMaker,
      hubId,
      3n * lot,
      'base',
      hubId,
      makerTargetUser,
      2n * lot,
    );
    const takerRoute = buildRoute(
      'target-bonus-taker-sell',
      'base',
      sourceTaker,
      hubId,
      2n * lot,
      'tron',
      missingTargetHub,
      takerTargetUser,
      2n * lot,
    );

    const sourceReceipt = (route: CrossJurisdictionSwapRoute) => buildCrossJurisdictionBookAdmissionReceipt(
      route,
      'source',
      {
        type: 'pull_lock',
        data: {
          pullId: route.sourcePull!.pullId,
          tokenId: route.sourcePull!.tokenId,
          amount: route.sourcePull!.signedAmount,
          revealedUntilTimestamp: route.sourcePull!.revealedUntilTimestamp,
          fullHash: route.sourcePull!.fullHash,
          partialRoot: route.sourcePull!.partialRoot,
        },
      },
      route.source.counterpartyEntityId,
      route.source.entityId,
      env.timestamp,
    );
    const targetReceipt = (route: CrossJurisdictionSwapRoute) => buildCrossJurisdictionBookAdmissionReceipt(
      route,
      'target',
      {
        type: 'pull_lock',
        data: {
          pullId: route.targetPull!.pullId,
          tokenId: route.targetPull!.tokenId,
          amount: route.targetPull!.signedAmount,
          revealedUntilTimestamp: route.targetPull!.revealedUntilTimestamp,
          fullHash: route.targetPull!.fullHash,
          partialRoot: route.targetPull!.partialRoot,
        },
      },
      route.target.entityId,
      route.target.counterpartyEntityId,
      env.timestamp,
    );

    mergeCrossJurisdictionBookAdmission(hubState, makerRoute, env.timestamp, sourceReceipt(makerRoute));
    const makerAdmission = mergeCrossJurisdictionBookAdmission(hubState, makerRoute, env.timestamp, targetReceipt(makerRoute));
    makerAdmission.status = 'admitted';
    makerAdmission.admittedAt = env.timestamp;
    hubState.crossJurisdictionSwaps?.set(makerRoute.orderId, makerRoute);
    const makerAccount = makeHubAccount(sourceMaker);
    makerAccount.swapOffers.set(makerRoute.orderId, {
      offerId: makerRoute.orderId,
      giveTokenId: 1,
      giveAmount: makerRoute.source.amount,
      wantTokenId: 1,
      wantAmount: makerRoute.target.amount,
      makerIsLeft: makerAccount.leftEntity.toLowerCase() === sourceMaker.toLowerCase(),
      minFillRatio: 0,
      timeInForce: 0,
      createdHeight: 1,
      priceTicks: 15_000n,
      crossJurisdiction: makerRoute,
    });
    hubState.accounts.set(sourceMaker, makerAccount);

    const makerMeta = buildCrossJurisdictionMarketOffer({
      offerId: makerRoute.orderId,
      accountId: sourceMaker,
      makerIsLeft: true,
      fromEntity: sourceMaker,
      toEntity: hubId,
      createdHeight: 1,
      giveTokenId: 1,
      giveAmount: makerRoute.source.amount,
      wantTokenId: 1,
      wantAmount: makerRoute.target.amount,
      minFillRatio: 0,
      timeInForce: 0,
      priceTicks: 15_000n,
      crossJurisdiction: makerRoute,
    }, hubId);
    expect(makerMeta).not.toBeNull();
    let book = createBook({ bucketWidthTicks: 10_000n, maxOrders: 10_000, stpPolicy: 1 });
    book = applyCommand(book, {
      kind: 0,
      ownerId: makerMeta!.makerId,
      orderId: `${sourceMaker}:${makerRoute.orderId}`,
      side: makerMeta!.side,
      tif: 0,
      postOnly: false,
      priceTicks: makerMeta!.priceTicks,
      qtyLots: makerMeta!.baseAmount / lot,
    }).state;
    hubState.orderbookExt = {
      books: new Map([[pairId, book]]),
      orderPairs: new Map([[`${sourceMaker}:${makerRoute.orderId}`, [pairId]]]),
      referrals: new Map(),
      hubProfile: {
        entityId: hubId,
        name: 'Hub',
        spreadDistribution: { makerBps: 0, takerBps: 10_000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 },
        referenceTokenId: 1,
        minTradeSize: 0n,
        supportedPairs: [pairId],
      },
    } satisfies OrderbookExtState;

    const takerAccount = makeHubAccount(sourceTaker);
    takerAccount.swapOffers.set(takerRoute.orderId, {
      offerId: takerRoute.orderId,
      giveTokenId: 1,
      giveAmount: takerRoute.source.amount,
      wantTokenId: 1,
      wantAmount: takerRoute.target.amount,
      makerIsLeft: takerAccount.leftEntity.toLowerCase() === sourceTaker.toLowerCase(),
      minFillRatio: 0,
      timeInForce: 0,
      createdHeight: 2,
      priceTicks: 10_000n,
      crossJurisdiction: takerRoute,
    });
    hubState.accounts.set(sourceTaker, takerAccount);

    await expect(applyEntityFrame(env, hubState, [
      {
        type: 'admitCrossJurisdictionBookOrder',
        data: { route: takerRoute, receipt: sourceReceipt(takerRoute), reason: 'source_pull_committed' },
      },
      {
        type: 'admitCrossJurisdictionBookOrder',
        data: { route: takerRoute, receipt: targetReceipt(takerRoute), reason: 'target_pull_committed' },
      },
    ])).rejects.toThrow('CROSS_J_TARGET_BONUS_UNROUTABLE');

    expect(getBookOrder(book, `${sourceMaker}:${makerRoute.orderId}`)).not.toBeNull();
  });

  test('disputeStart removes same-account orderbook rows before freezing the account', async () => {
    const env = createEmptyEnv('dispute-start-orderbook-freeze');
    const hubId = `0x${'90'.repeat(32)}`;
    const userId = `0x${'91'.repeat(32)}`;
    const offerId = 'dispute-freeze-offer';
    const pairId = '1/2';
    const namespacedOrderId = `${userId}:${offerId}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    const account = makeProposalAccount([], hubId, userId);
    account.swapOffers.set(offerId, {
      offerId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 2,
      wantAmount: 2_000n,
      makerIsLeft: false,
      minFillRatio: 0,
      createdHeight: 1,
      quantizedGive: 1_000n,
      quantizedWant: 2_000n,
      priceTicks: 2_000n,
    });
    hubState.accounts.set(userId, account);
    let book = createBook({ bucketWidthTicks: 1n, maxOrders: 10, stpPolicy: 1 });
    book = applyCommand(book, {
      kind: 0,
      ownerId: userId,
      orderId: namespacedOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 2_000n,
      qtyLots: 1n,
    }).state;
    hubState.orderbookExt = {
      books: new Map([[pairId, book]]),
      orderPairs: new Map([[namespacedOrderId, [pairId]]]),
      referrals: new Map(),
    } as unknown as OrderbookExtState;

    const result = await handleDisputeStart(
      hubState,
      {
        type: 'disputeStart',
        data: { counterpartyEntityId: userId },
      },
      env,
    );

    const nextBook = result.newState.orderbookExt?.books.get(pairId);
    expect(nextBook ? getBookOrder(nextBook, namespacedOrderId) : null).toBeNull();
    expect(result.newState.messages.some((msg) => msg.includes('Dispute removed 1 local orderbook row'))).toBe(true);
  });

  test('prepareDispute freezes account and removes orderbook rows without queuing on-chain disputeStart', async () => {
    const env = createEmptyEnv('prepare-dispute-orderbook-freeze');
    const hubId = `0x${'92'.repeat(32)}`;
    const userId = `0x${'93'.repeat(32)}`;
    const offerId = 'prepare-dispute-offer';
    const pairId = '1/2';
    const namespacedOrderId = `${userId}:${offerId}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    const account = makeProposalAccount([], hubId, userId);
    account.swapOffers.set(offerId, {
      offerId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 2,
      wantAmount: 2_000n,
      makerIsLeft: false,
      minFillRatio: 0,
      createdHeight: 1,
      quantizedGive: 1_000n,
      quantizedWant: 2_000n,
      priceTicks: 2_000n,
    });
    hubState.accounts.set(userId, account);
    let book = createBook({ bucketWidthTicks: 1n, maxOrders: 10, stpPolicy: 1 });
    book = applyCommand(book, {
      kind: 0,
      ownerId: userId,
      orderId: namespacedOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 2_000n,
      qtyLots: 1n,
    }).state;
    hubState.orderbookExt = {
      books: new Map([[pairId, book]]),
      orderPairs: new Map([[namespacedOrderId, [pairId]]]),
      referrals: new Map(),
    } as unknown as OrderbookExtState;

    const result = await handlePrepareDispute(
      hubState,
      {
        type: 'prepareDispute',
        data: { counterpartyEntityId: userId, description: 'test-prepare' },
      },
      env,
    );

    const nextAccount = result.newState.accounts.get(userId)!;
    const nextBook = result.newState.orderbookExt?.books.get(pairId);
    expect(nextAccount.status).toBe('dispute_preparing');
    expect(nextAccount.disputePrepare?.reason).toBe('test-prepare');
    expect(nextBook ? getBookOrder(nextBook, namespacedOrderId) : null).toBeNull();
    expect(result.newState.jBatchState?.batch.disputeStarts ?? []).toEqual([]);
  });

  test('disputeStart waits when HTLC route can still reveal future dispute evidence', async () => {
    const env = createEmptyEnv('prepare-dispute-awaiting-secret');
    const hubId = `0x${'94'.repeat(32)}`;
    const userId = `0x${'95'.repeat(32)}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    hubState.accounts.set(userId, makeProposalAccount([], hubId, userId));
    const hashlock = `0x${'44'.repeat(32)}`;
    hubState.htlcRoutes.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount: 10n,
      inboundEntity: userId,
      inboundLockId: 'await-secret-lock',
      createdTimestamp: hubState.timestamp,
    });
    hubState.lockBook.set('await-secret-lock', {
      lockId: 'await-secret-lock',
      accountId: userId,
      tokenId: 1,
      amount: 10n,
      hashlock,
      timelock: BigInt(hubState.timestamp + 60_000),
      direction: 'incoming',
      createdAt: BigInt(hubState.timestamp),
    });

    const result = await handleDisputeStart(
      hubState,
      {
        type: 'disputeStart',
        data: { counterpartyEntityId: userId },
      },
      env,
    );

    expect(result.newState.jBatchState?.batch.disputeStarts ?? []).toEqual([]);
    expect(result.newState.messages.some((msg) => msg.includes('htlcAwaitingSecret:1'))).toBe(true);
  });

  test('disputeStart ignores stale HTLC routes whose live lock is already gone', async () => {
    const env = createEmptyEnv('prepare-dispute-stale-htlc-route');
    const hubId = `0x${'94'.repeat(32)}`;
    const userId = `0x${'96'.repeat(32)}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    hubState.accounts.set(userId, makeProposalAccount([], hubId, userId));
    hubState.htlcRoutes.set(`0x${'45'.repeat(32)}`, {
      hashlock: `0x${'45'.repeat(32)}`,
      tokenId: 1,
      amount: 10n,
      inboundEntity: userId,
      inboundLockId: 'stale-timeout-lock',
      createdTimestamp: hubState.timestamp,
    });

    const result = await handleDisputeStart(
      hubState,
      {
        type: 'disputeStart',
        data: { counterpartyEntityId: userId },
      },
      env,
    );

    expect(result.newState.messages.some((msg) => msg.includes('htlcAwaitingSecret'))).toBe(false);
    expect(result.newState.messages.some((msg) => msg.includes('Missing counterparty dispute hanko'))).toBe(true);
  });

  test('committed HTLC forward enforces announced PPM fee, not only base fee', async () => {
    const env = createEmptyEnv('htlc-forward-ppm-fee');
    const hubId = `0x${'a0'.repeat(32)}`;
    const payerId = `0x${'a1'.repeat(32)}`;
    const nextHopId = `0x${'a2'.repeat(32)}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    hubState.accounts.set(nextHopId, makeProposalAccount([], hubId, nextHopId));
    env.gossip = {
      getProfiles: () => [{
        entityId: hubId,
        metadata: {
          routingFeePPM: 100_000,
          baseFee: 10n,
        },
        accounts: [{
          counterpartyId: nextHopId,
          tokenCapacities: new Map([[1, { outCapacity: 1_000_000n, inCapacity: 0n }]]),
        }],
      }],
    } as Env['gossip'];
    const crypto = new NobleCryptoProvider();
    const keyPair = x25519.keygen();
    hubState.entityEncPubKey = hexBytes(keyPair.publicKey);
    hubState.entityEncPrivKey = hexBytes(keyPair.secretKey);
    const lockId = 'ppm-fee-lock';
    const hashlock = `0x${'a3'.repeat(32)}`;
    const encryptedLayer = await crypto.encrypt(JSON.stringify({
      nextHop: nextHopId,
      innerEnvelope: 'opaque-next-hop-envelope',
      forwardAmount: '999990',
    }), hubState.entityEncPubKey);
    const accountMachine = makeProposalAccount([], payerId, hubId);
    accountMachine.locks.set(lockId, {
      lockId,
      hashlock,
      timelock: BigInt(hubState.timestamp + 120_000),
      revealBeforeHeight: 100,
      amount: 1_000_000n,
      tokenId: 1,
      senderIsLeft: true,
      createdHeight: 1,
      createdTimestamp: hubState.timestamp,
      envelope: {
        nextHop: hubId,
        innerEnvelope: encryptedLayer,
      },
    });
    const mempoolOps: Array<{ accountId: string; tx: AccountTx }> = [];

    await applyCommittedHtlcLockFollowup({
      env,
      state: hubState,
      newState: hubState,
      input: {
        fromEntityId: payerId,
        toEntityId: hubId,
      } as AccountInput,
      accountMachine,
      outputs: [],
      mempoolOps,
    }, {
      type: 'htlc_lock',
      data: {
        lockId,
        hashlock,
        timelock: BigInt(hubState.timestamp + 120_000),
        revealBeforeHeight: 100,
        amount: 1_000_000n,
        tokenId: 1,
      },
    }, true);

    expect(mempoolOps).toHaveLength(1);
    expect(mempoolOps[0]?.accountId).toBe(payerId);
    expect(mempoolOps[0]?.tx).toEqual({
      type: 'htlc_resolve',
      data: { lockId, outcome: 'error', reason: 'fee_below_ppm' },
    });
    expect(hubState.htlcRoutes.has(hashlock)).toBe(false);
  });

  test('disputeStart folds evidence tx mempool into dispute arguments instead of blocking', async () => {
    const env = createEmptyEnv('prepare-dispute-evidence-mempool');
    const hubId = `0x${'96'.repeat(32)}`;
    const userId = `0x${'97'.repeat(32)}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    hubState.accounts.set(
      userId,
      makeProposalAccount([
        {
          type: 'swap_resolve',
          data: { offerId: 'pending-fill', fillRatio: 32_768, cancelRemainder: false },
        } as AccountTx,
      ], hubId, userId),
    );

    const result = await handleDisputeStart(
      hubState,
      {
        type: 'disputeStart',
        data: { counterpartyEntityId: userId },
      },
      env,
    );

    expect(result.newState.jBatchState?.batch.disputeStarts ?? []).toEqual([]);
    expect(result.newState.messages.some((msg) => msg.includes('argumentMempool:swap_resolve'))).toBe(false);
    expect(result.newState.messages.some((msg) => msg.includes('Missing counterparty dispute hanko'))).toBe(true);
  });

  test('disputeStart allows matching pending pull_resolve when explicit starter pull args are supplied', async () => {
    const env = createEmptyEnv('prepare-dispute-explicit-pull-evidence');
    env.timestamp = 11_000;
    const hubId = `0x${'9a'.repeat(32)}`;
    const userId = `0x${'9b'.repeat(32)}`;
    const targetHub = `0x${'9c'.repeat(32)}`;
    const targetUser = `0x${'9d'.repeat(32)}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'explicit-pull-evidence',
      makerEntityId: userId,
      hubEntityId: hubId,
      source: {
        jurisdiction: `stack:1:0x${'a1'.repeat(20)}`,
        entityId: userId,
        counterpartyEntityId: hubId,
        tokenId: 1,
        amount: 100n,
      },
      target: {
        jurisdiction: `stack:2:0x${'a2'.repeat(20)}`,
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 2,
        amount: 200n,
      },
      status: 'resting',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
    }, {
      runtimeSeed: 'prepare-dispute-explicit-pull-evidence',
      sourceDisputeDelayMs: 5_000,
      now: env.timestamp,
    });
    const binary = buildCrossJurisdictionPullReveal(
      route,
      0x1234,
      deriveCrossJurisdictionPrivateSeed('prepare-dispute-explicit-pull-evidence', route),
    ).binary;
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const crossPullArgs = abiCoder.encode(
      ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
      [{ fillRatios: [], secrets: [], pulls: [binary] }],
    );
    const starterInitialArguments = abiCoder.encode(['bytes[]'], [[crossPullArgs]]);
    hubState.accounts.set(
      userId,
      makeProposalAccount([
        {
          type: 'pull_resolve',
          data: { pullId: route.targetPull!.pullId, binary },
        } as AccountTx,
      ], hubId, userId),
    );

    const result = await handleDisputeStart(
      hubState,
      {
        type: 'disputeStart',
        data: { counterpartyEntityId: userId, starterInitialArguments },
      },
      env,
    );

    expect(result.newState.jBatchState?.batch.disputeStarts ?? []).toEqual([]);
    expect(result.newState.messages.some((msg) => msg.includes('argumentMempool:pull_resolve'))).toBe(false);
    expect(result.newState.messages.some((msg) => msg.includes('Missing counterparty dispute hanko'))).toBe(true);
  });

  test('disputeStart treats pending cross_pull_close as foldable dispute evidence', async () => {
    const env = createEmptyEnv('prepare-dispute-cross-close-evidence');
    env.timestamp = 12_000;
    env.browserVM = { getDepositoryAddress: () => hex20('dd') } as any;
    const hubSigner = registerLazySigner('prepare-dispute-cross-close-evidence', 'hub');
    const hubId = hubSigner.entityId;
    const userId = `0x${'ab'.repeat(32)}`;
    const targetHub = `0x${'ac'.repeat(32)}`;
    const targetUser = `0x${'ad'.repeat(32)}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor(hubSigner.signerId);
    attachSigningReplica(env, hubId, hubSigner.signerId);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: 'cross-close-evidence',
      makerEntityId: userId,
      hubEntityId: hubId,
      source: {
        jurisdiction: `stack:1:0x${'b1'.repeat(20)}`,
        entityId: userId,
        counterpartyEntityId: hubId,
        tokenId: 1,
        amount: 100n,
      },
      target: {
        jurisdiction: `stack:2:0x${'b2'.repeat(20)}`,
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 2,
        amount: 200n,
      },
      cumulativeFillRatio: 0x4000,
      filledSourceAmount: 25n,
      filledTargetAmount: 50n,
      status: 'clearing',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
    }, {
      runtimeSeed: 'prepare-dispute-cross-close-evidence',
      sourceDisputeDelayMs: 5_000,
      now: env.timestamp,
    });
    const binary = buildCrossJurisdictionPullReveal(
      route,
      0x4000,
      deriveCrossJurisdictionPrivateSeed('prepare-dispute-cross-close-evidence', route),
    ).binary;
    const closeTx: AccountTx = {
      type: 'cross_pull_close',
      data: {
        pullId: route.sourcePull!.pullId,
        binary,
        proof: buildCrossJurisdictionCloseProof(route, binary),
      },
    };
    const account = makeProposalAccount([closeTx], hubId, userId);
    account.pulls = new Map([[
      route.sourcePull!.pullId,
      {
        pullId: route.sourcePull!.pullId,
        tokenId: route.sourcePull!.tokenId,
        amount: route.sourcePull!.signedAmount,
        claimedRatio: 0,
        claimedAmount: 0n,
        revealedUntilTimestamp: route.sourcePull!.revealedUntilTimestamp,
        fullHash: route.sourcePull!.fullHash,
        partialRoot: route.sourcePull!.partialRoot,
        crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'source'),
        createdHeight: 0,
        createdTimestamp: env.timestamp,
      },
    ]]);
    const delta = createDefaultDelta(route.sourcePull!.tokenId);
    delta.rightHold = BigInt(route.sourcePull!.amount);
    account.deltas.set(route.sourcePull!.tokenId, delta);
    const proposed = await proposeAccountFrame(env, account);
    expect(proposed.success).toBe(true);
    const pendingHeight = proposed.accountInput!.newAccountFrame!.height;
    delete account.pendingAccountInput;
    hubState.accounts.set(userId, account);

    const result = await handleDisputeStart(
      hubState,
      {
        type: 'disputeStart',
        data: { counterpartyEntityId: userId },
      },
      env,
    );

    expect(result.newState.jBatchState?.batch.disputeStarts ?? []).toEqual([]);
    expect(result.newState.messages.some((msg) => msg.includes(`pendingFrame:${pendingHeight}`))).toBe(false);
    expect(result.newState.messages.some((msg) => msg.includes('argumentMempool:cross_pull_close'))).toBe(false);
    expect(result.newState.messages.some((msg) => msg.includes('Missing counterparty dispute hanko'))).toBe(true);
  });

  test('disputeFinalize waits when incoming dispute can still collect HTLC evidence', async () => {
    const env = createEmptyEnv('counter-dispute-awaiting-secret');
    const hubId = `0x${'98'.repeat(32)}`;
    const userId = `0x${'99'.repeat(32)}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    const account = makeProposalAccount([], hubId, userId);
    account.status = 'disputed';
    account.activeDispute = {
      startedByLeft: false,
      initialProofbodyHash: `0x${'aa'.repeat(32)}`,
      initialNonce: 1,
      disputeTimeout: 100,
      onChainNonce: 1,
      starterInitialArguments: '0x',
      starterIncrementedArguments: '0x',
      observedOnChain: true,
      finalizeQueued: false,
    };
    hubState.accounts.set(userId, account);
    const hashlock = `0x${'55'.repeat(32)}`;
    hubState.htlcRoutes.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount: 10n,
      inboundEntity: userId,
      inboundLockId: 'counter-await-secret-lock',
      createdTimestamp: hubState.timestamp,
    });
    hubState.lockBook.set('counter-await-secret-lock', {
      lockId: 'counter-await-secret-lock',
      accountId: userId,
      tokenId: 1,
      amount: 10n,
      hashlock,
      timelock: BigInt(hubState.timestamp + 60_000),
      direction: 'incoming',
      createdAt: BigInt(hubState.timestamp),
    });

    const result = await handleDisputeFinalize(
      hubState,
      {
        type: 'disputeFinalize',
        data: { counterpartyEntityId: userId },
      },
      env,
    );

    expect(result.newState.jBatchState?.batch.disputeFinalizations ?? []).toEqual([]);
    expect(result.newState.messages.some((msg) => msg.includes('htlcAwaitingSecret:1'))).toBe(true);
  });
});

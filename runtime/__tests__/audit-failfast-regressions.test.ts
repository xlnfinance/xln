import { describe, expect, spyOn, test } from 'bun:test';
import { x25519 } from '@noble/curves/ed25519.js';

import {
  applyAccountInput,
  getIncomingAccountDeadlineViolation,
  HTLC_ENFORCEMENT_RESERVE_MS,
  isHtlcSecretEnforcementWindowClosed,
  proposeAccountFrame,
  validateAccountFrame,
} from '../account/consensus/index';
import { computeAccountStateRoot } from '../account/state-root';
import { resolveCertifiedAccountCounterpartyProposer } from '../account/counterparty-route';
import { createEmptyAccountJClaimAccumulator } from '../account/j-claim-accumulator';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey, signAccountFrame } from '../account/crypto';
import { deriveAccountWatchSeed } from '../account/watch-seed';
import { applyAccountTx } from '../account/tx/apply';
import { isPullRevealExpired } from '../account/pull-deadline';
import { handleHtlcLock } from '../account/tx/handlers/htlc-lock';
import { handleHtlcResolve } from '../account/tx/handlers/htlc-resolve';
import { createSettlementWorkspaceHash } from '../account/tx/handlers/settle-transition';
import { hashHtlcSecret } from '../protocol/htlc/utils';
import { buildHashLadderProof, revealHashLadder } from '../protocol/htlc/hash-ladder';
import { checkAutoRebalance, handleRequestCollateral } from '../account/tx/handlers/request-collateral';
import { handleSwapOffer } from '../account/tx/handlers/swap-offer';
import { createFrameHash, MAX_ACCOUNT_FRAME_TXS } from '../account/consensus/frame';
import { resolveAutoRebalanceFeePolicy, runPostFrameAutoRebalanceCheck } from '../account/consensus/helpers';
import { HTLC, LIMITS } from '../constants';
import {
  ACCOUNT_PENDING_RESEND_AFTER_MS,
  ACCOUNT_TIMEOUT_MS,
  emitCommittedPendingFrameWarnings,
  executeCrontab,
  HTLC_SECRET_ACK_TIMEOUT_MS,
  initCrontab,
} from '../entity/scheduler';
import { encodeBoard, generateLazyEntityId, generateNumberedEntityId, hashBoard } from '../entity/factory';
import { isLeftEntity } from '../entity/id';
import {
  CROSS_J_PENDING_FILL_ACK_TTL_MS,
  MAX_PENDING_CROSS_J_FILL_ACKS,
  applyEntityFrame,
  applyEntityInput,
} from '../entity/consensus/index';
import { createEntityFrameHash } from '../entity/consensus/frame';
import { buildSignedEntityCommand, prepareLocallyAuthoredEntityTxs } from '../entity/command';
import { signedEntityCommandTx } from '../entity/command-codec';
import { buildCollectiveEntityProposalTx } from '../entity/authorization';
import { generateProposalId } from '../entity/tx/proposals';
import { buildEntityHashesToSign } from '../entity/consensus/hanko-witness';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from '../entity/consensus/state-root';
import {
  assertCrossJurisdictionOrderAdmissible,
  findCrossJurisdictionBookAdmissionForAck,
} from '../orderbook/cross-j-orderbook';
import {
  buildCrossJurisdictionBookAdmissionReceipt,
  buildCrossJurisdictionMarketOffer,
  getCrossJurisdictionBookAdmissionError,
  mergeCrossJurisdictionBookAdmission,
} from '../extensions/cross-j/orderbook';
import {
  buildCrossJurisdictionPullBinding,
  buildCrossJurisdictionCloseProof,
  buildCrossJurisdictionPullReveal,
  buildPreparedCrossJurisdictionRoute,
  deriveCrossJurisdictionPrivateSeed,
  withCanonicalCrossJurisdictionRouteHash,
} from '../extensions/cross-j/index';
import { applyEntityTx } from '../entity/tx/apply';
import { applyCommittedCrossJurisdictionAccountTxFollowup } from '../entity/tx/handlers/account-cross-j-followups';
import { buildCrossJurisdictionEntityOutput } from '../entity/tx/cross-j-outputs';
import { handleHtlcOnionAdvance } from '../entity/tx/handlers/htlc-onion-advance';
import { handleAdmitCrossJurisdictionBookOrderEntityTx } from '../entity/tx/handlers/cross-j-book-order';
import type { SwapOfferEvent } from '../entity/tx/handlers/account';
import { handleDisputeFinalize, handleDisputeStart, handlePrepareDispute } from '../entity/tx/handlers/dispute';
import { handleJAbortSentBatch } from '../entity/tx/handlers/j-abort-sent-batch';
import { handleJRebroadcast } from '../entity/tx/handlers/j-rebroadcast';
import {
  handleSetHubConfigEntityTx,
  handleSetRebalancePolicyEntityTx,
} from '../entity/tx/handlers/account-admin';
import {
  buildSettlementSealDraft,
  processCommittedSettlementTransitionFollowup,
} from '../entity/tx/handlers/settle';
import { applyJEvent } from '../entity/tx/j-events';
import {
  applyJEventRange,
  buildJEventRangeData,
} from './helpers/j-history';
import { applyFinalizedAccountJEvents } from '../entity/tx/j-events-account';
import { queueCrossJurisdictionSalvageFromArgumentList } from '../entity/tx/j-events-htlc';
import {
  canonicalDisputeFinalizationEvidenceHash,
  canonicalJurisdictionEventsHash,
  getJEventJurisdictionRef,
} from '../jurisdiction/event-observation';
import { getRuntimeJurisdictionHeight } from '../jurisdiction/height';
import { recordValidatorJHistory } from '../jurisdiction/local-history';
import { buildLocalJPrefixAttestation } from '../jurisdiction/j-prefix-consensus';
import { createEmptyBatch } from '../jurisdiction/batch';
import {
  getCertifiedBoardNodeStore,
  resolveCertifiedRegisteredBoardHash,
  resolveObserverCertifiedBoardRecord,
} from '../jurisdiction/board-registry';
import { applyCommand, createBook, getBookOrder, getSwapLotScale, ORDERBOOK_PRICE_SCALE, SWAP_LOT_SCALE, type OrderbookExtState } from '../orderbook';
import { process, createEmptyEnv, registerEntityRuntimeHint, sendEntityInput, validateRuntimeInputAdmission } from '../runtime';
import { createJReplica } from '../scenarios/boot';
import { applyMergedEntityInputs } from '../machine/entity-inputs';
import { submitRuntimeJOutbox } from '../machine/j-submit';
import {
  buildJSubmitAttemptId,
  registerPendingCommittedJOutbox,
} from '../machine/j-submit-state';
import { safeStringify } from '../protocol/serialization';
import type { ProofBodyStruct } from '../protocol/dispute/proof-body';
import { hydrateAccountDocFromStorage, projectAccountDoc } from '../storage/projections';
import { validateStorageAccountDocValue } from '../storage/authoritative-schema';
import { decodeValidatedBuffer, encodeBuffer } from '../storage/codec';
import { createDefaultDelta } from '../validation-utils';
import {
  buildDisputeArgumentsForSnapshot,
  captureDisputeArgumentSnapshot,
  storeDisputeArgumentSnapshot,
} from '../protocol/dispute/arguments';
import {
  buildAccountProofBody,
  createDisputeProofHashWithNonce,
  hashProofBodyStruct,
} from '../protocol/dispute/proof-builder';
import { encodeSignedHanko } from '../hanko/codec';
import { resolveHankoBoardDelays } from '../hanko/claims';
import { signEntityHashes, verifyHankoForHash } from '../hanko/signing';
import { NobleCryptoProvider } from '../protocol/crypto/noble';
import {
  computeHtlcEnvelopeContextHash,
  computeHtlcSecretOfferContextHash,
} from '../protocol/htlc/envelope';
import { encryptBytesForValidatorManifest } from '../protocol/htlc/multi-recipient';
import { buildHtlcOnionAdvanceTx } from '../protocol/htlc/onion-advance';
import { encodeHtlcSecretOffer, encodeOnionLayer } from '../protocol/htlc/onion-codec';
import {
  computeEntityProfileCertificationHash,
  computeValidatorEncryptionAttestationDigest,
  requireCompleteValidatorEncryptionManifest,
} from '../protocol/htlc/validator-encryption';
import { handleMeshBootstrapLoopError } from '../orchestrator/mesh-bootstrap-fail-fast';
import { fitCrossAmountsToOrderbook } from '../orchestrator/mm-node';
import { cloneAccountMachine, resolveEntityProposerId } from '../state-helpers';
import { QUOTE_EXPIRY_MS } from '../types';
import type { AccountFrame, AccountInput, AccountMachine, AccountTx, ConsensusConfig, CrossJurisdictionSwapRoute, DisputeFinalizationEvidence, EntityInput, EntityReplica, EntityState, EntityTx, Env, JInput, JurisdictionConfig, JurisdictionEvent, RuntimeTx } from '../types';
import { installCanonicalRegisteredBoardAuthority } from './helpers/registration-evidence';
import { ethers } from 'ethers';

const makeSingleSignerConfig = (): EntityState['config'] => ({
  mode: 'proposer-based',
  threshold: 1n,
  validators: ['1'],
  shares: { '1': 1n },
  jurisdiction: {
    name: 'AuditTestnet',
    chainId: 31337,
    depositoryAddress: `0x${'dd'.repeat(20)}`,
    entityProviderAddress: `0x${'ee'.repeat(20)}`,
  },
});

const makeSingleSignerConfigFor = (signerId: string): EntityState['config'] => ({
  mode: 'proposer-based',
  threshold: 1n,
  validators: [signerId],
  shares: { [signerId]: 1n },
  jurisdiction: {
    name: 'AuditTestnet',
    chainId: 31337,
    depositoryAddress: `0x${'dd'.repeat(20)}`,
    entityProviderAddress: `0x${'ee'.repeat(20)}`,
  },
});

const installSingleSignerBoard = (env: Env, state: EntityState, slot = '1'): string => {
  const seed = env.runtimeSeed;
  if (!seed) throw new Error('TEST_RUNTIME_SEED_REQUIRED');
  const signerId = deriveSignerAddressSync(seed, slot).toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync(seed, slot));
  state.config = makeSingleSignerConfigFor(signerId);
  return signerId;
};

const hex20 = (byte: string): string => `0x${byte.repeat(byte.length === 2 ? 20 : 40)}`;
const hexBytes = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
const HANKO_DELAYS = resolveHankoBoardDelays();
const hashHankoBoard = (threshold: number, boardEntityIds: string[], weights: number[]): string => {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(abiCoder.encode(
    ['tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)'],
    [[threshold, boardEntityIds, weights, 0, 0, 0]],
  )).toLowerCase();
};
const signedHankoForTest = (
  hash: string,
  privateKeys: readonly Uint8Array[],
  placeholders: readonly string[],
  claims: readonly [string, readonly bigint[], readonly bigint[], bigint][],
): string => encodeSignedHanko({
  digest: hash,
  privateKeys,
  placeholders: placeholders.map((value) => value as `0x${string}`),
  claims: claims.map(([entityId, entityIndexes, weights, threshold]) => ({
    entityId: entityId as `0x${string}`,
    entityIndexes,
    weights,
    threshold,
    ...HANKO_DELAYS,
  })),
});
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
    domain: { chainId: 31337, depositoryAddress: `0x${'dd'.repeat(20)}` },
    status: 'active',
    mempool: [...mempool],
    currentFrame: {
      height: 0,
      timestamp: 0,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '',
      accountStateRoot: `0x${'00'.repeat(32)}`,
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
    proofHeader: { fromEntity: leftEntity, toEntity: rightEntity, nextProofNonce: 0 },
    proofBody: { tokenIds: [], deltas: [] },
    frameHistory: [],
    pendingWithdrawals: new Map(),
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
    shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
    leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
    rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
    lastFinalizedJHeight: 0,
    watchSeed: deriveAccountWatchSeed({
      runtimeSeed: 'audit-failfast-test-helper',
      entityId: leftEntity,
      counterpartyId: rightEntity,
      timestamp: 0,
    }),
    disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
    jNonce: 0,
  } as AccountMachine;
};

const setSyntheticPendingAccountProposal = (
  account: AccountMachine,
  accountTxs: AccountTx[],
  timestamp: number,
  targetSignerId = 'fixture-counterparty-signer',
): void => {
  const pendingFrame = {
    ...account.currentFrame,
    height: account.currentHeight + 1,
    timestamp,
    accountTxs: structuredClone(accountTxs),
    prevFrameHash: account.currentHeight === 0 ? 'genesis' : account.currentFrame.stateHash,
    stateHash: `0x${'f0'.repeat(32)}`,
  };
  account.pendingFrame = pendingFrame;
  account.pendingAccountInput = {
    kind: 'frame',
    fromEntityId: account.proofHeader.fromEntity,
    toEntityId: account.proofHeader.toEntity,
    domain: structuredClone(account.domain),
    proposal: { frame: structuredClone(pendingFrame) },
  };
  account.pendingAccountInputSignerId = targetSignerId;
};

const makeIncomingAccountFrame = (
  account: AccountMachine,
  tx: AccountTx,
  byLeft: boolean,
  timestamp = 10_000,
  jHeight = 1,
): AccountFrame => ({
  ...account.currentFrame,
  height: account.currentHeight + 1,
  timestamp,
  jHeight,
  accountTxs: [tx],
  byLeft,
});

const attachSigningReplica = (
  env: ReturnType<typeof createEmptyEnv>,
  entityId: string,
  signerId: string,
): void => {
  const browserDepository = (env.browserVM as { getDepositoryAddress?: () => string } | undefined)?.getDepositoryAddress?.();
  const config = makeSingleSignerConfigFor(signerId);
  const jurisdiction = config.jurisdiction!;
  const depository = browserDepository ?? jurisdiction.depositoryAddress;
  if (!env.jReplicas.has('__audit_test__')) {
    env.jReplicas.set('__audit_test__', {
      name: '__audit_test__',
      chainId: jurisdiction.chainId,
      rpcs: [],
      depositoryAddress: depository,
      entityProviderAddress: jurisdiction.entityProviderAddress,
      contracts: {
        depository,
        entityProvider: jurisdiction.entityProviderAddress,
        account: hex20('98'),
        deltaTransformer: hex20('99'),
      },
      blockNumber: 0n,
      stateRoot: null,
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
      position: { x: 0, y: 0, z: 0 },
    });
  }
  env.eReplicas.set(
    `${entityId}:${signerId}`,
    {
      entityId,
      signerId,
      mempool: [],
      isProposer: true,
      state: {
        ...makeEntityState(entityId),
        config,
      },
    } satisfies EntityReplica,
  );
};

const registerLazySigner = (
  seed: string,
  signerSlot: string,
): { signerId: string; entityId: string } => {
  const signerId = deriveSignerAddressSync(seed, signerSlot);
  const privateKey = deriveSignerKeySync(seed, signerSlot);
  registerSignerKey(seed, signerId, privateKey);
  return {
    signerId,
    entityId: generateLazyEntityId([signerId], 1n).toLowerCase(),
  };
};

const ensureCanonicalCommandBoardAuthority = async (
  env: Env,
  state: EntityState,
): Promise<void> => {
  const boardHash = hashBoard(encodeBoard(state.config, env)).toLowerCase();
  if (state.entityId.toLowerCase() === boardHash) return;
  const jurisdiction = state.config.jurisdiction;
  if (!jurisdiction) throw new Error(`TEST_ENTITY_JURISDICTION_REQUIRED:${state.entityId}`);
  const existing = resolveObserverCertifiedBoardRecord(
    state,
    getCertifiedBoardNodeStore(env),
    state.entityId,
  );
  if (existing) {
    if (existing.boardHash !== boardHash) {
      throw new Error(`TEST_ENTITY_BOARD_AUTHORITY_CONFLICT:${existing.boardHash}:${boardHash}`);
    }
    return;
  }
  let replica = Array.from(env.jReplicas.values()).find(candidate => (
    candidate.chainId === jurisdiction.chainId &&
    candidate.depositoryAddress?.toLowerCase() === jurisdiction.depositoryAddress.toLowerCase() &&
    candidate.entityProviderAddress?.toLowerCase() === jurisdiction.entityProviderAddress.toLowerCase()
  ));
  if (!replica) {
    replica = createJReplica(env, jurisdiction.name, jurisdiction.depositoryAddress);
    replica.chainId = jurisdiction.chainId;
    replica.depositoryAddress = jurisdiction.depositoryAddress;
    replica.entityProviderAddress = jurisdiction.entityProviderAddress;
  }
  replica.watcherConfirmationDepth = 0;
  await installCanonicalRegisteredBoardAuthority(env, jurisdiction, state, boardHash);
};

const buildQuorumAuthorizedFrameTxs = async (
  env: Env,
  state: EntityState,
  collectiveTxs: EntityTx[],
  frameTimestamp: number = env.timestamp,
): Promise<EntityTx[]> => {
  await ensureCanonicalCommandBoardAuthority(env, state);
  const [proposer, ...otherValidators] = state.config.validators;
  if (!proposer) throw new Error('TEST_ENTITY_PROPOSER_REQUIRED');
  const proposalTx = buildCollectiveEntityProposalTx(proposer, collectiveTxs);
  if (proposalTx.type !== 'propose') throw new Error('TEST_ENTITY_PROPOSAL_TX_INVALID');
  const proposalId = generateProposalId(
    env,
    proposalTx.data.action,
    proposer.toLowerCase(),
    { ...state, timestamp: frameTimestamp },
  );
  const frameTxs = [signedEntityCommandTx(buildSignedEntityCommand(env, state, proposer, [proposalTx]))];
  let approvedPower = state.config.shares[proposer] ?? 0n;
  for (const validator of otherValidators) {
    if (approvedPower >= state.config.threshold) break;
    const voteTx: EntityTx = {
      type: 'vote',
      data: { proposalId, voter: validator, choice: 'yes' },
    };
    frameTxs.push(signedEntityCommandTx(buildSignedEntityCommand(env, state, validator, [voteTx])));
    approvedPower += state.config.shares[validator] ?? 0n;
  }
  if (approvedPower < state.config.threshold) {
    throw new Error(`TEST_ENTITY_PROPOSAL_QUORUM_UNAVAILABLE:${approvedPower}:${state.config.threshold}`);
  }
  return frameTxs;
};

const prepareJEventInput = (
  env: ReturnType<typeof createEmptyEnv>,
  entityId: string,
  signerId: string,
	  input: {
	    blockNumber: number;
	    blockHash: string;
	    transactionHash: string;
	    events: JurisdictionEvent[];
	    disputeFinalizationEvidence?: DisputeFinalizationEvidence[];
	    jurisdictionRef?: string;
	  },
): { jurisdictionRef: string; eventsHash: string; disputeFinalizationEvidenceHash?: string } => {
	  const eventsHash = canonicalJurisdictionEventsHash(input.events);
	  const jurisdictionRef = input.jurisdictionRef ?? getJEventJurisdictionRef(undefined);
	  const disputeFinalizationEvidenceHash = input.disputeFinalizationEvidence?.length
	    ? canonicalDisputeFinalizationEvidenceHash(input.disputeFinalizationEvidence)
	    : undefined;
	  return {
	    jurisdictionRef,
	    eventsHash,
	    ...(disputeFinalizationEvidenceHash ? { disputeFinalizationEvidenceHash } : {}),
	  };
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
  crontabState: initCrontab(),
});

const makeDisputeFinalizedFixture = (
  seed: string,
  finalProofbody: ProofBodyStruct,
  storeFinalProofbody: boolean,
) => {
  const entityId = `0x${'12'.repeat(32)}`;
  const counterpartyId = `0x${'34'.repeat(32)}`;
  const state = makeEntityState(entityId);
  const account = makeProposalAccount([], entityId, counterpartyId);
  const finalProofbodyHash = hashProofBodyStruct(finalProofbody);
  if (storeFinalProofbody) {
    account.disputeProofBodiesByHash = { [finalProofbodyHash]: finalProofbody };
  }
  account.activeDispute = {
    startedByLeft: true,
    disputeTimeout: 123,
    initialProofbodyHash: finalProofbodyHash,
    initialNonce: 7,
    finalizeQueued: true,
  } as AccountMachine['activeDispute'];
  state.accounts.set(counterpartyId, account);
  return {
    account,
    counterpartyId,
    env: createEmptyEnv(seed),
    event: {
      type: 'DisputeFinalized',
      data: {
        sender: entityId,
        counterentity: counterpartyId,
        initialNonce: 7,
        initialProofbodyHash: finalProofbodyHash,
        finalProofbodyHash,
      },
    } satisfies JurisdictionEvent,
    finalProofbodyHash,
    state,
  };
};

const applyDisputeFinalizedFixture = async (
  fixture: ReturnType<typeof makeDisputeFinalizedFixture>,
) => applyJEventRange(fixture.state, {
  from: '1',
  observedAt: 22,
  blockNumber: 22,
  blockHash: `0x${'99'.repeat(32)}`,
  transactionHash: `0x${'88'.repeat(32)}`,
  event: fixture.event,
  jurisdictionRef: getJEventJurisdictionRef(fixture.state.config.jurisdiction),
}, fixture.env);

const sealAuditJSubmitAttempts = (env: Env, inputs: JInput[]): void => {
  for (const input of inputs) {
    for (const jTx of input.jTxs) {
      if (jTx.type !== 'batch' || !jTx.data.runtimeSubmitAttempt) continue;
      const signerId = String(jTx.data.signerId || '');
      const batchGeneration = 1;
      const attemptId = buildJSubmitAttemptId({
        jurisdictionName: input.jurisdictionName,
        entityId: jTx.entityId,
        signerId,
        entityNonce: Number(jTx.data.entityNonce),
        batchGeneration,
        batchHash: String(jTx.data.batchHash || ''),
        attemptNumber: jTx.data.runtimeSubmitAttempt.attemptNumber,
      });
      jTx.data.batchGeneration = batchGeneration;
      jTx.data.runtimeSubmitAttempt = {
        ...jTx.data.runtimeSubmitAttempt,
        attemptId,
        batchGeneration,
      };
      const existing = Array.from(env.eReplicas.values()).find((replica) => (
        replica.entityId.toLowerCase() === jTx.entityId.toLowerCase() &&
        replica.signerId.toLowerCase() === signerId.toLowerCase()
      ));
      const state = existing?.state ?? makeEntityState(jTx.entityId);
      state.jBatchState = {
        batch: createEmptyBatch(),
        jurisdiction: null,
        lastBroadcast: jTx.timestamp,
        broadcastCount: batchGeneration,
        failedAttempts: 0,
        status: 'sent',
        sentBatch: {
          batch: structuredClone(jTx.data.batch),
          batchHash: String(jTx.data.batchHash || ''),
          encodedBatch: String(jTx.data.encodedBatch || '0x'),
          entityNonce: Number(jTx.data.entityNonce),
          firstSubmittedAt: jTx.data.runtimeSubmitAttempt.attemptedAt,
          lastSubmittedAt: jTx.data.runtimeSubmitAttempt.attemptedAt,
          submitAttempts: jTx.data.runtimeSubmitAttempt.attemptNumber,
        },
      };
      const replica = existing ?? {
        entityId: jTx.entityId,
        signerId,
        mempool: [],
        isProposer: true,
        state,
      } as EntityReplica;
      replica.jSubmitState = {
        jurisdictionName: input.jurisdictionName,
        batchHash: String(jTx.data.batchHash || ''),
        entityNonce: Number(jTx.data.entityNonce),
        batchGeneration,
        submitAttempts: jTx.data.runtimeSubmitAttempt.attemptNumber,
        lastSubmittedAt: jTx.data.runtimeSubmitAttempt.attemptedAt,
      };
      env.eReplicas.set(`${jTx.entityId}:${signerId}`, replica);
    }
  }
  registerPendingCommittedJOutbox(env, inputs);
};

const submitAuditRuntimeJOutbox = async (
  env: Env,
  inputs: JInput[],
  deps: Parameters<typeof submitRuntimeJOutbox>[2],
): Promise<void> => {
  sealAuditJSubmitAttempts(env, inputs);
  await submitRuntimeJOutbox(env, inputs, deps);
};

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
    }])).rejects.toThrow('RUNTIME_CROSS_J_EXTERNAL_INGRESS_FORBIDDEN');

    await expect(process(env, [{
      from: remoteRuntime,
      entityId: `0x${'11'.repeat(32)}`,
      signerId: `0x${'01'.repeat(20)}`,
      entityTxs: [{
        type: 'consensusOutput',
        data: {
          origin: {
            sourceEntityId: `0x${'33'.repeat(32)}`,
            lane: 'generic',
            sequence: 1n,
            semanticHash: `0x${'44'.repeat(32)}`,
            height: 1,
            frameHash: `0x${'55'.repeat(32)}`,
            outputIndex: 0,
          },
          outputHanko: '0x01',
          targetEntityId: `0x${'11'.repeat(32)}`,
          entityTxs: [{
            type: 'requestCrossJurisdictionSwap',
            data: { route: {} },
          }],
        },
      } as any],
    }])).rejects.toThrow('RUNTIME_CROSS_J_EXTERNAL_INGRESS_FORBIDDEN');

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
    })).toThrow('CROSS_J_REMOTE_OUTPUT_FORBIDDEN');
  });

  test('live runtime drops remote cross-j ingress and records a bounded warning without halting', async () => {
    const env = createEmptyEnv('cross-j-live-ingress-drop');
    env.scenarioMode = false;
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
    }])).resolves.toBe(env);

    expect(env.runtimeState?.halted).not.toBe(true);
    expect(env.runtimeState?.lifecyclePhase).not.toBe('halted');
    expect(env.runtimeState?.quarantinedRuntimeInputs?.at(-1)?.action).toBe('dropped');
    expect([...env.runtimeState!.securityIncidents!.values()]).toContainEqual(expect.objectContaining({
      code: 'CROSS_J_REMOTE_INPUT_REJECTED',
      source: 'remote-ingress',
      severity: 'warning',
      status: 'active',
      occurrences: 1,
    }));
  });

  test('runtime ingress retargets stale signer hints only when the local target entity has one replica', async () => {
    const env = createEmptyEnv('stale-signer-retarget');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const actualSignerId = `0x${'83'.repeat(20)}`;
    const entityId = generateLazyEntityId([actualSignerId], 1n).toLowerCase();
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
    const actualSignerId = `0x${'85'.repeat(20)}`;
    const entityId = generateLazyEntityId([actualSignerId], 1n).toLowerCase();
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

  test('live runtime drops stale signer tx-bearing inputs without halting', async () => {
    const env = createEmptyEnv('stale-signer-live-drop');
    env.scenarioMode = false;
    env.quietRuntimeLogs = true;
    const actualSignerId = `0x${'95'.repeat(20)}`;
    const entityId = generateLazyEntityId([actualSignerId], 1n).toLowerCase();
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
    }])).resolves.toBe(env);
    expect(env.runtimeState?.quarantinedRuntimeInputs?.[0]?.action).toBe('dropped');
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
    }])).resolves.toBe(env);

    const quarantine = env.runtimeState?.quarantinedRuntimeInputs ?? [];
    expect(quarantine.length).toBe(1);
    expect(quarantine[0]?.reason).toBe('FINANCIAL-SAFETY:');
    expect(quarantine[0]?.action).toBe('dropped');
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

  test('local signer resolution prefers an available local signer over stale gossip board fallback', () => {
    const env = createEmptyEnv('local-signer-resolution-stale-gossip');
    env.scenarioMode = false;
    env.quietRuntimeLogs = true;
    const { entityId, signerId: actualSignerId } = registerLazySigner('local-signer-resolution-stale-gossip', 'actual');
    const staleGossipSignerId = `0x${'9b'.repeat(20)}`;
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(actualSignerId);
    env.eReplicas.set(`${entityId}:${actualSignerId}`, {
      entityId,
      signerId: actualSignerId,
      mempool: [],
      isProposer: true,
      state,
    });
    env.gossip = {
      getProfiles: () => [{
        entityId,
        metadata: {
          board: {
            validators: [{ signerId: staleGossipSignerId }],
          },
        },
      }],
    } as Env['gossip'];

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

    const ignored = handleMeshBootstrapLoopError(new Error('ECONNRESET: response ended prematurely'), {
      nodeName: 'H1',
      clearLoop: () => { cleared += 1; },
      exit: (code) => { exits.push(code); },
      logError: (...args) => { logs.push(args); },
    });

    expect(ignored).toBe(false);
    expect(cleared).toBe(1);
    expect(exits).toEqual([1]);
    expect(String(logs.at(-1)?.[0] || '')).toContain('mesh bootstrap transport retry');
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
    attachSigningReplica(env, targetUser, targetSigner);
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
    const signerA = `0x${'a1'.repeat(20)}`;
    const signerB = `0x${'b1'.repeat(20)}`;
    const entityId = generateLazyEntityId([signerA, signerB], 2n).toLowerCase();
    const staleSignerId = `0x${'cc'.repeat(20)}`;
    const config: EntityState['config'] = {
      ...makeSingleSignerConfigFor(signerA),
      threshold: 2n,
      validators: [signerA, signerB],
      shares: { [signerA]: 1n, [signerB]: 1n },
    };
    for (const signerId of [signerA, signerB]) {
      const state = makeEntityState(entityId);
      state.config = structuredClone(config);
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

  test('hanko verification lets an already-verified child satisfy its parent threshold', async () => {
    const hash = `0x${'ab'.repeat(32)}`;
    const signerPrivateKey = deriveSignerKeySync('hanko-eoa-threshold-divergence', '1');
    const signerAddress = deriveSignerAddressSync('hanko-eoa-threshold-divergence', '1');
    const signerEntityId = ethers.zeroPadValue(signerAddress, 32).toLowerCase();
    const proposerAddress = deriveSignerAddressSync('hanko-eoa-threshold-divergence', '2');
    const proposerEntityId = ethers.zeroPadValue(proposerAddress, 32).toLowerCase();
    const nestedEntityId = hashHankoBoard(1, [signerEntityId], [1]);
    const rootEntityId = hashHankoBoard(60, [proposerEntityId, nestedEntityId], [40, 60]);
    const hanko = signedHankoForTest(hash, [signerPrivateKey], [proposerEntityId], [
      [nestedEntityId, [1n], [1n], 1n],
      [rootEntityId, [0n, 2n], [40n, 60n], 60n],
    ]);

    const result = await verifyHankoForHash(hanko, hash, rootEntityId);

    // The child claim independently reaches quorum from the real EOA. The
    // ordered parent may therefore count the child's configured board weight.
    expect(result.valid).toBe(true);
    expect(result.entityId).toBe(rootEntityId);
  });

  test('registered hanko verification accepts a board that matches local registered config', async () => {
    const hash = `0x${'bc'.repeat(32)}`;
    const env = createEmptyEnv('registered-hanko-board-positive');
    const signerPrivateKey = deriveSignerKeySync('registered-hanko-board-positive', '1');
    const signerAddress = deriveSignerAddressSync('registered-hanko-board-positive', '1').toLowerCase();
    const entityId = generateNumberedEntityId(42).toLowerCase();
    const jurisdiction = {
      name: 'Registered Hanko positive',
      address: 'http://127.0.0.1:8545',
      chainId: 31_337,
      depositoryAddress: `0x${'31'.repeat(20)}`,
      entityProviderAddress: `0x${'32'.repeat(20)}`,
      entityProviderDeploymentBlock: 4,
      registrationBlock: 5,
    } satisfies JurisdictionConfig;
    const config: ConsensusConfig = {
      mode: 'proposer-based',
      threshold: 1n,
      validators: [signerAddress],
      shares: { [signerAddress]: 1n },
      jurisdiction,
    };
    env.eReplicas.set(`${entityId}:${signerAddress}`, {
      entityId,
      signerId: signerAddress,
      mempool: [],
      isProposer: true,
      state: { entityId, config },
    } as unknown as EntityReplica);
    const jReplica = createJReplica(env, jurisdiction.name, jurisdiction.depositoryAddress);
    jReplica.chainId = jurisdiction.chainId;
    jReplica.depositoryAddress = jurisdiction.depositoryAddress;
    jReplica.entityProviderAddress = jurisdiction.entityProviderAddress;
    jReplica.watcherConfirmationDepth = 0;
    const state = env.eReplicas.get(`${entityId}:${signerAddress}`)!.state;
    const boardHash = hashHankoBoard(1, [ethers.zeroPadValue(signerAddress, 32)], [1]);
    await installCanonicalRegisteredBoardAuthority(env, jurisdiction, state, boardHash);
    const hanko = signedHankoForTest(hash, [signerPrivateKey], [], [
      [entityId, [0n], [1n], 1n],
    ]);

    const registeredBoardHash = resolveCertifiedRegisteredBoardHash(env, entityId, jurisdiction);
    const result = await verifyHankoForHash(
      hanko,
      hash,
      entityId,
      env,
      registeredBoardHash ? { registeredBoardHash } : undefined,
    );

    expect(registeredBoardHash).toBe(boardHash);
    expect(result.valid).toBe(true);
    expect(result.entityId?.toLowerCase()).toBe(entityId);
  });

  test('registered hanko verification rejects forged self-contained board without local board of record', async () => {
    const hash = `0x${'bd'.repeat(32)}`;
    const signerPrivateKey = deriveSignerKeySync('registered-hanko-board-missing', '1');
    const entityId = generateNumberedEntityId(43).toLowerCase();
    const hanko = signedHankoForTest(hash, [signerPrivateKey], [], [
      [entityId, [0n], [1n], 1n],
    ]);

    const result = await verifyHankoForHash(hanko, hash, entityId);

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
    const forgedHanko = signedHankoForTest(hash, [signerPrivateKey], [], [
      [entityId, [0n], [1n], 1n],
    ]);

    const result = await verifyHankoForHash(forgedHanko, hash, entityId, env);

    expect(result.valid).toBe(false);
    expect(result.entityId).toBeNull();
  });

  test('j_event rejects non-validator signer ids before observation aggregation', async () => {
    const seed = 'j-event-non-validator';
    const env = createEmptyEnv(seed);
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(signerId);
    const event: JurisdictionEvent = {
      type: 'ReserveUpdated',
      data: {
        entity: state.entityId,
        tokenId: 1,
        newBalance: '100',
      },
    };
    const validRange = buildJEventRangeData(state, {
      from: signerId,
      jurisdictionRef: getJEventJurisdictionRef(state.config.jurisdiction),
      observedAt: 1_000,
      blockNumber: 1,
      blockHash: `0x${'22'.repeat(32)}`,
      transactionHash: `0x${'33'.repeat(32)}`,
      event,
    }, env);

    await expect(applyJEvent(state, {
      ...validRange,
      from: 'not-a-validator',
    }, env)).rejects.toThrow('J_RANGE_NOT_ACTIVE_PROPOSER');
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
      jurisdictionRef: getJEventJurisdictionRef(state.config.jurisdiction),
      observedAt: 1_000,
      blockNumber: 2,
      blockHash: `0x${'12'.repeat(32)}`,
      transactionHash: `0x${'13'.repeat(32)}`,
      event,
    };
    const signed = prepareJEventInput(env, entityId, signerId, {
      blockNumber: common.blockNumber,
      blockHash: common.blockHash,
      transactionHash: common.transactionHash,
      events: [event],
      jurisdictionRef: getJEventJurisdictionRef(state.config.jurisdiction),
    });

    const unsignedSignature = buildJEventRangeData(state, { ...common, ...signed }, env);
    await expect(applyJEvent(state, { ...unsignedSignature, signature: '' }, env)).rejects.toThrow(
      'invalid proposer signature',
    );

    const result = await applyJEventRange(state, { ...common, ...signed }, env);
    expect(result.newState.jBlockChain.length).toBe(1);
    expect(result.newState.reserves.get(1)).toBe(100n);
  });

  test('AccountSettled applies explicit zero reserve instead of leaving stale local balance', async () => {
    const seed = 'account-settled-zero-reserve';
    const env = createEmptyEnv(seed);
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const counterpartyId = `0x${'42'.repeat(32)}`;
    let state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(signerId);
    const initialReserveEvent: JurisdictionEvent = {
      type: 'ReserveUpdated',
      data: {
        entity: entityId,
        tokenId: 1,
        newBalance: '777',
      },
    };
    const initialCommon = {
      from: signerId,
      observedAt: 1_000,
      blockNumber: 3,
      blockHash: `0x${'15'.repeat(32)}`,
      transactionHash: `0x${'18'.repeat(32)}`,
      event: initialReserveEvent,
    };
    const initialSigned = prepareJEventInput(env, entityId, signerId, {
      blockNumber: initialCommon.blockNumber,
      blockHash: initialCommon.blockHash,
      transactionHash: initialCommon.transactionHash,
      events: [initialReserveEvent],
      jurisdictionRef: getJEventJurisdictionRef(state.config.jurisdiction),
    });
    state = (await applyJEventRange(state, { ...initialCommon, ...initialSigned }, env)).newState;
    expect(state.reserves.get(1)).toBe(777n);
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
    const signed = prepareJEventInput(env, entityId, signerId, {
      blockNumber: common.blockNumber,
      blockHash: common.blockHash,
      transactionHash: common.transactionHash,
      events: [event],
      jurisdictionRef: getJEventJurisdictionRef(state.config.jurisdiction),
    });

    const result = await applyJEventRange(state, { ...common, ...signed }, env);

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
    const range = buildJEventRangeData(state, {
      from: signerId,
      jurisdictionRef: getJEventJurisdictionRef(state.config.jurisdiction),
      observedAt: 3,
      blockNumber: 3,
      blockHash: `0x${'14'.repeat(32)}`,
      transactionHash: `0x${'15'.repeat(32)}`,
      event,
    }, env);

    await expect(applyEntityTx(env, state, {
      type: 'j_event',
      data: { ...range, signature: '' },
    })).rejects.toThrow('j_event rejected: invalid proposer signature');
  });

  test('swap requests fail loud when the target account is missing', async () => {
    const env = createEmptyEnv('swap-request-missing-account');
    const state = makeEntityState(`0x${'62'.repeat(32)}`);
    const missingCounterparty = `0x${'63'.repeat(32)}`;

    await expect(applyEntityTx(env, state, {
      type: 'placeSwapOffer',
      data: {
        counterpartyEntityId: missingCounterparty,
        offerId: 'missing-account-offer',
        giveTokenId: 1,
        giveAmount: 100n,
        wantTokenId: 2,
        wantAmount: 200n,
        minFillRatio: 0,
      },
    } as any)).rejects.toThrow('SWAP_REQUEST_ACCOUNT_MISSING:placeSwapOffer');

    await expect(applyEntityTx(env, state, {
      type: 'resolveSwap',
      data: {
        counterpartyEntityId: missingCounterparty,
        offerId: 'missing-account-offer',
        fillRatio: 0,
        cancelRemainder: true,
      },
    } as any)).rejects.toThrow('SWAP_REQUEST_ACCOUNT_MISSING:resolveSwap');

    await expect(applyEntityTx(env, state, {
      type: 'proposeCancelSwap',
      data: {
        counterpartyEntityId: missingCounterparty,
        offerId: 'missing-account-offer',
      },
    } as any)).rejects.toThrow('SWAP_REQUEST_ACCOUNT_MISSING:proposeCancelSwap');
  });

  test('direct payment fails loud for invalid route topology', async () => {
    const env = createEmptyEnv('direct-payment-invalid-route');
    env.quietRuntimeLogs = true;
    const source = `0x${'64'.repeat(32)}`;
    const wrongStart = `0x${'65'.repeat(32)}`;
    const target = `0x${'66'.repeat(32)}`;
    const missingNextHop = `0x${'67'.repeat(32)}`;
    const wrongEnd = `0x${'68'.repeat(32)}`;
    const state = makeEntityState(source);
    const signerId = installSingleSignerBoard(env, state);

    expect(() => prepareLocallyAuthoredEntityTxs(env, state, signerId, [{
      type: 'directPayment',
      data: { targetEntityId: target, tokenId: 1, amount: 100n, route: [] },
    }])).toThrow('DIRECT_PAYMENT_ROUTE_REQUIRED');

    await expect(applyEntityTx(env, state, {
      type: 'directPayment',
      data: {
        targetEntityId: target,
        tokenId: 1,
        amount: 100n,
        route: [],
      },
    } as any)).rejects.toThrow('DIRECT_PAYMENT_ROUTE_REQUIRED');

    await expect(applyEntityTx(env, state, {
      type: 'directPayment',
      data: {
        targetEntityId: target,
        tokenId: 1,
        amount: 100n,
        route: [wrongStart, target],
      },
    } as any)).rejects.toThrow('DIRECT_PAYMENT_ROUTE_START_INVALID');

    await expect(applyEntityTx(env, state, {
      type: 'directPayment',
      data: {
        targetEntityId: target,
        tokenId: 1,
        amount: 100n,
        route: [source, wrongEnd],
      },
    } as any)).rejects.toThrow('DIRECT_PAYMENT_ROUTE_END_INVALID');

    await expect(applyEntityTx(env, state, {
      type: 'directPayment',
      data: {
        targetEntityId: target,
        tokenId: 1,
        amount: 100n,
        route: [source, missingNextHop, target],
      },
    } as any)).rejects.toThrow('DIRECT_PAYMENT_NEXT_HOP_ACCOUNT_MISSING');
  });

  test('entity frame aborts instead of partially committing after a skipped tx', async () => {
    const env = createEmptyEnv('entity-frame-atomicity');
    env.quietRuntimeLogs = true;
    const state = makeEntityState(`0x${'61'.repeat(32)}`);
    const signer = installSingleSignerBoard(env, state);
    const frameTimestamp = 1_000;

    await expect(applyEntityFrame(env, state, await buildQuorumAuthorizedFrameTxs(env, state, [
      { type: 'chatMessage', data: { message: 'first mutation' } } as any,
      { type: 'definitely_unknown_entity_tx', data: {} } as any,
      { type: 'chatMessage', data: { message: 'late mutation' } } as any,
    ], frameTimestamp), frameTimestamp)).rejects.toThrow('ENTITY_FRAME_TX_FAILED: type=definitely_unknown_entity_tx');

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
    const sourceSigner = `0x${'33'.repeat(20)}`;
    const targetSigner = `0x${'34'.repeat(20)}`;
    const sourceUserId = generateLazyEntityId([sourceSigner], 1n).toLowerCase();
    const targetUserId = generateLazyEntityId([targetSigner], 1n).toLowerCase();
    const sourceHubId = `0x${'41'.repeat(32)}`;
    const targetHubId = `0x${'42'.repeat(32)}`;
    attachSigningReplica(env, sourceUserId, sourceSigner);
    attachSigningReplica(env, targetUserId, targetSigner);

    await expect(process(env, [{
      from: remoteRuntime,
      entityId: sourceUserId,
      signerId: sourceSigner,
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
    }])).rejects.toThrow('RUNTIME_CROSS_J_EXTERNAL_INGRESS_FORBIDDEN');
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
      sourceSignerId: 'source-user-signer',
      sourceHubSignerId: '1',
      targetHubSignerId: 'target-hub-signer',
      targetSignerId: 'target-user-signer',
      bookHubSignerId: '1',
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
      sourceHubSignerId: '1',
      targetHubSignerId: 'target-hub-signer',
      bookHubSignerId: '1',
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
    const swapOffersCreated: SwapOfferEvent[] = [];
    const committedRoute = {
      ...route,
      targetReceipt,
      status: 'resting' as const,
    };

    applyCommittedCrossJurisdictionAccountTxFollowup(env, sourceHubState, sourceUser, {
      type: 'pull_lock',
      data: {
        pullId: route.sourcePull!.pullId,
        tokenId: route.sourcePull!.tokenId,
        amount: route.sourcePull!.signedAmount,
        revealedUntilTimestamp: route.sourcePull!.revealedUntilTimestamp,
        fullHash: route.sourcePull!.fullHash,
        partialRoot: route.sourcePull!.partialRoot,
        crossJurisdiction: buildCrossJurisdictionPullBinding(committedRoute, 'source'),
        crossJurisdictionRoute: committedRoute,
      },
    }, outputs, env.timestamp, swapOffersCreated);

    const sourceRoute = sourceHubState.crossJurisdictionSwaps.get(route.orderId);
    expect(sourceRoute?.status).toBe('resting');
    expect(sourceRoute?.targetReceipt?.receiptHash).toBe(targetReceipt.receiptHash);
    expect(outputs).toHaveLength(0);
    expect(sourceHubState.crossJurisdictionBookAdmissions?.size).toBe(1);
    expect(sourceHubState.crossJurisdictionBookAdmissions?.values().next().value?.status).toBe('pending');
    expect(swapOffersCreated).toHaveLength(0);
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
      venueId: 'cross:stack:31337:0x1111111111111111111111111111111111111111:1/stack:31338:0x2222222222222222222222222222222222222222:1',
      source: {
        jurisdiction: 'stack:31338:0x2222222222222222222222222222222222222222',
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: sourcePull.amount,
      },
      target: {
        jurisdiction: 'stack:31337:0x1111111111111111111111111111111111111111',
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

  test('signed non-deadline account frame remains valid after a ten-minute outage', async () => {
    const seed = 'account-frame-watcher-lag';
    const env = createEmptyEnv(seed);
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const first = registerLazySigner(seed, '1');
    const second = registerLazySigner(seed, '2');
    const left = isLeftEntity(first.entityId, second.entityId) ? first : second;
    const right = left === first ? second : first;
    attachSigningReplica(env, left.entityId, left.signerId);
    attachSigningReplica(env, right.entityId, right.signerId);
    const proposer = makeProposalAccount([
      { type: 'set_credit_limit', data: { tokenId: 1, amount: 100n } },
    ], left.entityId, right.entityId);
    const receiver = cloneAccountMachine(proposer);
    receiver.mempool = [];
    receiver.proofHeader = { fromEntity: right.entityId, toEntity: left.entityId, nextProofNonce: 0 };

    const proposal = await proposeAccountFrame(env, proposer, env.timestamp, 9);
    if (!proposal.success || !proposal.accountInput) throw new Error(proposal.error || 'proposal failed');
    const result = await applyAccountInput(env, receiver, proposal.accountInput, {
      entityTimestamp: env.timestamp + 10 * 60_000,
      finalizedJHeight: 10,
    });

    expect(result.success).toBe(true);
    expect(receiver.currentHeight).toBe(1);
  });

  test('Entity flush batches a committed peer J-claim ACK with the local claim', async () => {
    const seed = 'account-j-claim-overlay-batched-ack';
    const env = createEmptyEnv(seed);
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const first = registerLazySigner(seed, '1');
    const second = registerLazySigner(seed, '2');
    const left = isLeftEntity(first.entityId, second.entityId) ? first : second;
    const right = left === first ? second : first;
    attachSigningReplica(env, left.entityId, left.signerId);
    attachSigningReplica(env, right.entityId, right.signerId);
    const claim: AccountTx = {
      type: 'j_event_claim',
      data: {
        jHeight: 7,
        jBlockHash: `0x${'73'.repeat(32)}`,
        events: [{
          type: 'AccountSettled',
          data: {
            leftEntity: left.entityId,
            rightEntity: right.entityId,
            tokenId: 1,
            leftReserve: '0',
            rightReserve: '0',
            collateral: '5',
            ondelta: '0',
            nonce: 1,
          },
        }],
      },
    };
    const proposer = makeProposalAccount([structuredClone(claim)], left.entityId, right.entityId);
    const receiver = cloneAccountMachine(proposer);
    receiver.mempool = [structuredClone(claim)];
    receiver.proofHeader = { fromEntity: right.entityId, toEntity: left.entityId, nextProofNonce: 0 };

    const proposed = await proposeAccountFrame(env, proposer, env.timestamp, 7);
    if (!proposed.success || !proposed.accountInput) throw new Error(proposed.error || 'proposal failed');
    const result = await applyAccountInput(env, receiver, proposed.accountInput, {
      entityTimestamp: env.timestamp,
      finalizedJHeight: 7,
    });

    expect(result.success).toBe(true);
    expect(result.response?.kind).toBe('ack');
    const newClaimNodes = new Map(
      result.accountJClaimNodeChanges?.newNodes.map(({ hash, node }) => [hash, node]) ?? [],
    );
    const flushed = await proposeAccountFrame(env, receiver, env.timestamp, 7, {
      get: hash => newClaimNodes.get(hash),
    });
    expect(flushed.success).toBe(true);
    expect(flushed.accountInput?.kind).toBe('frame_ack');
    if (flushed.accountInput?.kind !== 'frame_ack') throw new Error('expected Entity-flushed frame_ack');
    expect(receiver.pendingAccountInput?.kind).toBe('frame_ack');
    expect(receiver.pendingAccountInput).toEqual(flushed.accountInput);
    expect(flushed.accountInput.proposal.frame.accountTxs.map((tx) => tx.type)).toEqual(['j_event_claim']);
    expect(receiver.currentHeight).toBe(1);
    expect(receiver.pendingFrame?.height).toBe(2);
    expect(receiver.leftPendingJClaims.count).toBe(1n);
    expect(receiver.rightPendingJClaims.count).toBe(0n);
    expect(result.accountJClaimNodeChanges?.newNodes.map(({ hash }) => hash)).toEqual([
      receiver.leftPendingJClaims.root,
    ]);
    expect(result.accountJClaimNodeChanges?.replacedNodeHashes).toEqual([]);
  });

  test('account frame freshness rejects future skew but permits old and regressed signed frames', () => {
    const account = makeProposalAccount([], 'alice', 'hub');
    const oldFrame = makeIncomingAccountFrame(
      account,
      { type: 'set_credit_limit', data: { tokenId: 1, amount: 1n } },
      true,
      1_000,
    );
    const futureFrame = { ...oldFrame, timestamp: 130_001 };
    const regressedFrame = { ...oldFrame, timestamp: 999 };

    expect(validateAccountFrame(oldFrame, 100_000)).toBe(true);
    expect(validateAccountFrame(futureFrame, 100_000)).toBe(false);
    expect(validateAccountFrame(regressedFrame, 100_000)).toBe(true);
  });

  test('HTLC secret enforcement reserve closes on either entity time or finalized J-height', () => {
    const lock = { timelock: 100_000n, revealBeforeHeight: 20 };
    expect(isHtlcSecretEnforcementWindowClosed(lock, {
      entityTimestamp: 69_999,
      finalizedJHeight: 20,
    })).toBe(false);
    expect(isHtlcSecretEnforcementWindowClosed(lock, {
      entityTimestamp: 70_000,
      finalizedJHeight: 20,
    })).toBe(true);
    expect(isHtlcSecretEnforcementWindowClosed(lock, {
      entityTimestamp: 1,
      finalizedJHeight: 21,
    })).toBe(true);
  });

  test('late invalid HTLC preimage never becomes dispute evidence', () => {
    const secret = `0x${'82'.repeat(32)}`;
    const account = makeProposalAccount([], 'alice', 'hub');
    account.locks.set('late-preimage-lock', {
      lockId: 'late-preimage-lock',
      hashlock: hashHtlcSecret(secret),
      timelock: 10n,
      revealBeforeHeight: 1,
      amount: 1n,
      tokenId: 1,
      senderIsLeft: true,
      createdHeight: 0,
      createdTimestamp: 0,
    });
    const context = { entityTimestamp: 100, finalizedJHeight: 2 };
    const frameFor = (candidate: string) => makeIncomingAccountFrame(account, {
      type: 'htlc_resolve',
      data: { lockId: 'late-preimage-lock', outcome: 'secret', secret: candidate },
    }, false);

    expect(getIncomingAccountDeadlineViolation(account, frameFor(`0x${'83'.repeat(32)}`), context))
      .toBeUndefined();
    expect(getIncomingAccountDeadlineViolation(account, frameFor(secret), context)?.evidenceSecrets)
      .toEqual([{ hashlock: hashHtlcSecret(secret), secret }]);
  });

  test('late signed HTLC secret is retained as evidence and prepares a dispute', async () => {
    const seed = 'late-htlc-secret-dispute';
    const env = createEmptyEnv(seed);
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const first = registerLazySigner(seed, '1');
    const second = registerLazySigner(seed, '2');
    const left = isLeftEntity(first.entityId, second.entityId) ? first : second;
    const right = left === first ? second : first;
    attachSigningReplica(env, left.entityId, left.signerId);
    attachSigningReplica(env, right.entityId, right.signerId);
    const secret = `0x${'91'.repeat(32)}`;
    const hashlock = hashHtlcSecret(secret);
    const lockId = 'late-secret-lock';
    const upstreamEntityId = `0x${'73'.repeat(32)}`;
    const upstreamLockId = 'late-secret-upstream-lock';
    const amount = 7n;
    const timelock = BigInt(env.timestamp + HTLC_ENFORCEMENT_RESERVE_MS - 1);
    const resolveTx: AccountTx = {
      type: 'htlc_resolve',
      data: { lockId, outcome: 'secret', secret },
    };
    const proposer = makeProposalAccount([resolveTx], left.entityId, right.entityId);
    const receiver = cloneAccountMachine(proposer);
    receiver.mempool = [];
    receiver.proofHeader = { fromEntity: right.entityId, toEntity: left.entityId, nextProofNonce: 0 };
    for (const account of [proposer, receiver]) {
      const delta = createDefaultDelta(1);
      delta.rightHold = amount;
      account.deltas.set(1, delta);
      account.locks.set(lockId, {
        lockId,
        hashlock,
        timelock,
        revealBeforeHeight: 100,
        amount,
        tokenId: 1,
        senderIsLeft: false,
        createdHeight: 0,
        createdTimestamp: 0,
      });
    }
    const proposal = await proposeAccountFrame(env, proposer, env.timestamp, 1);
    if (!proposal.success || !proposal.accountInput) throw new Error(proposal.error || 'proposal failed');

    const receiverState = makeEntityState(right.entityId);
    receiverState.config = makeSingleSignerConfigFor(right.signerId);
    receiverState.timestamp = env.timestamp;
    receiverState.lastFinalizedJHeight = 1;
    receiverState.accounts.set(left.entityId, receiver);
    receiverState.htlcRoutes.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount,
      inboundEntity: upstreamEntityId,
      inboundLockId: upstreamLockId,
      outboundEntity: left.entityId,
      outboundLockId: lockId,
      createdTimestamp: env.timestamp,
    });
    const applied = await applyEntityTx(env, receiverState, {
      type: 'accountInput',
      data: proposal.accountInput,
    });

    const rejectedAccount = applied.newState.accounts.get(left.entityId)!;
    expect(rejectedAccount.currentHeight).toBe(0);
    expect(rejectedAccount.status).toBe('dispute_preparing');
    expect(rejectedAccount.counterpartyFrameHanko).toBeUndefined();
    expect(applied.newState.htlcRoutes.get(hashlock)).toMatchObject({
      secret,
      inboundEntity: upstreamEntityId,
      inboundLockId: upstreamLockId,
      outboundEntity: left.entityId,
      outboundLockId: lockId,
      secretAckPending: true,
      secretAckStartedAt: env.timestamp,
      secretAckDeadlineAt: env.timestamp + HTLC_SECRET_ACK_TIMEOUT_MS,
    });
    expect(applied.newState.crontabState?.hooks.get(`htlc-secret-ack:${hashlock}`)).toEqual({
      id: `htlc-secret-ack:${hashlock}`,
      triggerAt: env.timestamp + HTLC_SECRET_ACK_TIMEOUT_MS,
      type: 'htlc_secret_ack_timeout',
      data: {
        hashlock,
        counterpartyEntityId: upstreamEntityId,
        inboundLockId: upstreamLockId,
      },
    });
    expect(applied.mempoolOps).toContainEqual({
      accountId: upstreamEntityId,
      tx: {
        type: 'htlc_resolve',
        data: { lockId: upstreamLockId, outcome: 'secret', secret },
      },
    });

    const proofbodyHash = `0x${'ab'.repeat(32)}`;
    storeDisputeArgumentSnapshot(
      rejectedAccount,
      captureDisputeArgumentSnapshot(rejectedAccount, proofbodyHash, 0, makeEmptyProofBody()),
    );
    const { leftArguments } = buildDisputeArgumentsForSnapshot(
      rejectedAccount,
      applied.newState,
      left.entityId,
      proofbodyHash,
      { secretsSide: 'left' },
    );
    const [wrapped] = ethers.AbiCoder.defaultAbiCoder().decode(['bytes[]'], leftArguments);
    const [transformerArguments] = ethers.AbiCoder.defaultAbiCoder().decode(
      ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
      wrapped[0],
    );
    expect(Array.from(transformerArguments.secrets)).toEqual([secret]);
  });

  test('signed deterministic replay failure freezes only the account and retains evidence', async () => {
    const seed = 'signed-invalid-account-frame';
    const env = createEmptyEnv(seed);
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const first = registerLazySigner(seed, '1');
    const second = registerLazySigner(seed, '2');
    const left = isLeftEntity(first.entityId, second.entityId) ? first : second;
    const right = left === first ? second : first;
    attachSigningReplica(env, left.entityId, left.signerId);
    attachSigningReplica(env, right.entityId, right.signerId);

    const receiver = makeProposalAccount([], left.entityId, right.entityId);
    receiver.proofHeader = { fromEntity: right.entityId, toEntity: left.entityId, nextProofNonce: 0 };
    const invalidFrame = makeIncomingAccountFrame(
      receiver,
      { type: 'set_credit_limit', data: { tokenId: 1, amount: -1n } },
      true,
      env.timestamp,
      0,
    );
    invalidFrame.prevFrameHash = 'genesis';
    invalidFrame.stateHash = await createFrameHash(invalidFrame);
    const [frameHanko] = await signEntityHashes(env, left.entityId, left.signerId, [invalidFrame.stateHash]);
    if (!frameHanko) throw new Error('SIGNED_INVALID_FRAME_HANKO_MISSING');
    const accountInput: AccountInput = {
      kind: 'frame',
      fromEntityId: left.entityId,
      toEntityId: right.entityId,
      domain: structuredClone(receiver.domain),
      proposal: { frame: invalidFrame, frameHanko },
    };

    const accountResult = await applyAccountInput(env, cloneAccountMachine(receiver), accountInput, {
      entityTimestamp: env.timestamp,
      finalizedJHeight: 0,
    });
    expect(accountResult.success).toBe(false);
    expect(accountResult.disputeRequired?.reason).toContain('Credit limit cannot be negative');
    expect(accountResult.disputeRequired?.signedFrame).toEqual({ frame: invalidFrame, frameHanko });

    const receiverState = makeEntityState(right.entityId);
    receiverState.config = makeSingleSignerConfigFor(right.signerId);
    receiverState.timestamp = env.timestamp;
    receiverState.accounts.set(left.entityId, receiver);
    const applied = await applyEntityTx(env, receiverState, {
      type: 'accountInput',
      data: accountInput,
    });
    const rejectedAccount = applied.newState.accounts.get(left.entityId)!;
    expect(rejectedAccount.currentHeight).toBe(0);
    expect(rejectedAccount.deltas.size).toBe(0);
    expect(rejectedAccount.status).toBe('dispute_preparing');
    expect(rejectedAccount).not.toHaveProperty('rejectedFrameEvidence');
    expect(rejectedAccount.shadow.rejectedFrameEvidence).toEqual({
      reason: expect.stringContaining('Credit limit cannot be negative'),
      frame: invalidFrame,
      frameHanko,
    });
  });

  test('receiver-local preflight rejects stale creation of unenforceable HTLC and pull locks', () => {
    const account = makeProposalAccount([], 'alice', 'hub');
    const context = { entityTimestamp: 100_000, finalizedJHeight: 50 };
    const htlcTx: AccountTx = {
      type: 'htlc_lock',
      data: {
        lockId: 'stale-lock',
        hashlock: `0x${'31'.repeat(32)}`,
        timelock: 120_000n,
        revealBeforeHeight: 50,
        amount: 1n,
        tokenId: 1,
      },
    };
    const pullProof = buildHashLadderProof('stale-pull-lock');
    const pullTx: AccountTx = {
      type: 'pull_lock',
      data: {
        pullId: 'stale-pull',
        tokenId: 1,
        amount: -1n,
        revealedUntilTimestamp: 120_000,
        fullHash: pullProof.fullHash,
        partialRoot: pullProof.partialRoot,
      },
    };

    expect(getIncomingAccountDeadlineViolation(
      account,
      makeIncomingAccountFrame(account, htlcTx, true),
      context,
    )?.reason).toContain('HTLC_LOCK_ENFORCEMENT_WINDOW_TOO_SHORT');
    expect(getIncomingAccountDeadlineViolation(
      account,
      makeIncomingAccountFrame(account, pullTx, true),
      context,
    )?.reason).toContain('PULL_LOCK_ENFORCEMENT_WINDOW_TOO_SHORT');
  });

  test('receiver-local preflight matches Solidity pull deadline seconds exactly', () => {
    const account = makeProposalAccount([], 'alice', 'hub');
    const proof = buildHashLadderProof('stale-pull-resolve');
    const reveal = revealHashLadder(proof, 32_768);
    account.pulls = new Map([['pull-1', {
      pullId: 'pull-1',
      tokenId: 1,
      amount: -100n,
      claimedRatio: 0,
      claimedAmount: 0n,
      revealedUntilTimestamp: 20_000,
      fullHash: proof.fullHash,
      partialRoot: proof.partialRoot,
      createdHeight: 0,
      createdTimestamp: 0,
    }]]);
    const claimFrame = makeIncomingAccountFrame(account, {
      type: 'pull_resolve',
      data: { pullId: 'pull-1', binary: reveal.binary },
    }, false);

    expect(isPullRevealExpired(20_000, 20_999)).toBe(false);
    expect(isPullRevealExpired(20_000, 21_000)).toBe(true);
    expect(getIncomingAccountDeadlineViolation(
      account,
      claimFrame,
      { entityTimestamp: 20_999, finalizedJHeight: 1 },
    )).toBeUndefined();

    expect(getIncomingAccountDeadlineViolation(
      account,
      claimFrame,
      { entityTimestamp: 21_000, finalizedJHeight: 1 },
    )?.reason).toContain('PULL_CLAIM_AFTER_LOCAL_EXPIRY');
    expect(getIncomingAccountDeadlineViolation(
      account,
      makeIncomingAccountFrame(account, {
        type: 'cross_pull_close',
        data: {
          pullId: 'pull-1',
          binary: reveal.binary,
          proof: {
            orderId: 'order-1',
            routeHash: `0x${'51'.repeat(32)}`,
            sourcePullId: 'pull-1',
            targetPullId: 'pull-2',
            fillRatio: reveal.fillRatio,
            cumulativeSourceAmount: 50n,
            cumulativeTargetAmount: 50n,
            binaryHash: `0x${'52'.repeat(32)}`,
            closeMode: 'partial_cancel_remainder',
          },
        },
      }, false),
      { entityTimestamp: 21_000, finalizedJHeight: 1 },
    )?.reason).toContain('CROSS_PULL_CLAIM_AFTER_LOCAL_EXPIRY');
  });

  test('receiver-local preflight blocks payer pull cancellation before local expiry', () => {
    const account = makeProposalAccount([], 'alice', 'hub');
    const proof = buildHashLadderProof('early-pull-cancel');
    account.pulls = new Map([['pull-1', {
      pullId: 'pull-1',
      tokenId: 1,
      amount: -100n,
      claimedRatio: 0,
      claimedAmount: 0n,
      revealedUntilTimestamp: 120_000,
      fullHash: proof.fullHash,
      partialRoot: proof.partialRoot,
      createdHeight: 0,
      createdTimestamp: 0,
    }]]);

    expect(getIncomingAccountDeadlineViolation(
      account,
      makeIncomingAccountFrame(account, {
        type: 'pull_cancel',
        data: { pullId: 'pull-1', reason: 'expired' },
      }, true, 120_001),
      { entityTimestamp: 100_000, finalizedJHeight: 1 },
    )?.reason).toContain('PULL_PAYER_CANCEL_BEFORE_LOCAL_EXPIRY');

    expect(getIncomingAccountDeadlineViolation(
      account,
      makeIncomingAccountFrame(account, {
        type: 'pull_cancel',
        data: { pullId: 'pull-1', reason: 'expired' },
      }, true, 120_999),
      { entityTimestamp: 120_999, finalizedJHeight: 1 },
    )?.reason).toContain('PULL_PAYER_CANCEL_BEFORE_LOCAL_EXPIRY');

    expect(getIncomingAccountDeadlineViolation(
      account,
      makeIncomingAccountFrame(account, {
        type: 'pull_cancel',
        data: { pullId: 'pull-1', reason: 'expired' },
      }, true, 121_000),
      { entityTimestamp: 121_000, finalizedJHeight: 1 },
    )).toBeUndefined();
  });

  test('receiver-local preflight blocks payer HTLC timeout using future peer J-height', () => {
    const account = makeProposalAccount([], 'alice', 'hub');
    account.locks.set('lock-1', {
      lockId: 'lock-1',
      hashlock: `0x${'41'.repeat(32)}`,
      timelock: 120_000n,
      revealBeforeHeight: 10,
      amount: 100n,
      tokenId: 1,
      senderIsLeft: true,
      createdHeight: 0,
      createdTimestamp: 0,
    });

    expect(getIncomingAccountDeadlineViolation(
      account,
      makeIncomingAccountFrame(account, {
        type: 'htlc_resolve',
        data: { lockId: 'lock-1', outcome: 'error', reason: 'timeout' },
      }, true, 100_000, 11),
      { entityTimestamp: 100_000, finalizedJHeight: 5 },
    )?.reason).toContain('HTLC_PAYER_CANCEL_BEFORE_LOCAL_EXPIRY');

    expect(getIncomingAccountDeadlineViolation(
      account,
      makeIncomingAccountFrame(account, {
        type: 'htlc_resolve',
        data: { lockId: 'lock-1', outcome: 'error', reason: 'timeout' },
      }, true, 120_000, 5),
      { entityTimestamp: 120_000, finalizedJHeight: 5 },
    )).toBeUndefined();
  });

  test('receiver-local preflight follows HTLC transitions before checking reused ids', () => {
    const account = makeProposalAccount([], 'alice', 'hub');
    const secret = `0x${'42'.repeat(32)}`;
    account.locks.set('reused-lock', {
      lockId: 'reused-lock',
      hashlock: hashHtlcSecret(secret),
      timelock: 300_000n,
      revealBeforeHeight: 100,
      amount: 100n,
      tokenId: 1,
      senderIsLeft: true,
      createdHeight: 0,
      createdTimestamp: 0,
    });
    const frame = makeIncomingAccountFrame(account, {
      type: 'htlc_resolve',
      data: { lockId: 'reused-lock', outcome: 'secret', secret },
    }, false);
    frame.accountTxs.push({
      type: 'htlc_lock',
      data: {
        lockId: 'reused-lock',
        hashlock: `0x${'43'.repeat(32)}`,
        timelock: 120_000n,
        revealBeforeHeight: 51,
        amount: 100n,
        tokenId: 1,
      },
    });

    expect(getIncomingAccountDeadlineViolation(
      account,
      frame,
      { entityTimestamp: 100_000, finalizedJHeight: 50 },
    )?.reason).toContain('HTLC_LOCK_ENFORCEMENT_WINDOW_TOO_SHORT');
  });

  test('receiver-local preflight follows pull cancellation before checking reused ids', () => {
    const account = makeProposalAccount([], 'alice', 'hub');
    const existingProof = buildHashLadderProof('existing-reused-pull');
    const replacementProof = buildHashLadderProof('replacement-reused-pull');
    account.pulls = new Map([['reused-pull', {
      pullId: 'reused-pull',
      tokenId: 1,
      amount: -100n,
      claimedRatio: 0,
      claimedAmount: 0n,
      revealedUntilTimestamp: 120_000,
      fullHash: existingProof.fullHash,
      partialRoot: existingProof.partialRoot,
      createdHeight: 0,
      createdTimestamp: 0,
    }]]);
    const frame = makeIncomingAccountFrame(account, {
      type: 'pull_cancel',
      data: { pullId: 'reused-pull', reason: 'expired' },
    }, true, 121_000);
    frame.accountTxs.push({
      type: 'pull_lock',
      data: {
        pullId: 'reused-pull',
        tokenId: 1,
        amount: -100n,
        revealedUntilTimestamp: 130_000,
        fullHash: replacementProof.fullHash,
        partialRoot: replacementProof.partialRoot,
      },
    });

    expect(getIncomingAccountDeadlineViolation(
      account,
      frame,
      { entityTimestamp: 121_000, finalizedJHeight: 50 },
    )?.reason).toContain('PULL_LOCK_ENFORCEMENT_WINDOW_TOO_SHORT');
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

    const result = await proposeAccountFrame(env, account, env.timestamp);

    expect(result.success).toBe(true);
    expect(result.accountInput?.proposal.frame?.accountTxs.map((tx) => tx.type)).toEqual(['set_credit_limit']);
    const frameDelta = result.accountInput?.proposal.frame?.deltas.find((delta) => delta.tokenId === 1);
    expect(frameDelta?.offdelta).toBe(0n);
    expect(frameDelta?.rightCreditLimit).toBe(500n);
  });

  test('proposer and receiver use the exact Entity frame timestamp for pull state', async () => {
    const env = createEmptyEnv('account-frame-timestamp-parity');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.timestamp = 1_000;
    const depositoryAddress = hex20('dd');
    env.browserVM = { getDepositoryAddress: () => depositoryAddress } as any;
    const { signerId, entityId: left } = registerLazySigner('account-frame-timestamp-parity', '1');
    attachSigningReplica(env, left, signerId);
    const right = `0x${'ff'.repeat(32)}`;
    const pullLock: AccountTx = {
      type: 'pull_lock',
      data: {
        pullId: 'timestamp-parity-pull',
        tokenId: 1,
        amount: -100n,
        revealedUntilTimestamp: 10_000,
        fullHash: `0x${'a1'.repeat(32)}`,
        partialRoot: `0x${'b2'.repeat(32)}`,
      },
    };
    const proposer = makeProposalAccount([pullLock], left, right);
    proposer.currentHeight = 4;
    proposer.currentFrame.height = 4;
    proposer.currentFrame.timestamp = env.timestamp;
    proposer.currentFrame.stateHash = `0x${'cc'.repeat(32)}`;
    const delta = createDefaultDelta(1);
    delta.leftCreditLimit = 1_000n;
    proposer.deltas.set(1, delta);
    const receiver = cloneAccountMachine(proposer);
    receiver.proofHeader = { fromEntity: right, toEntity: left, nextProofNonce: 0 };

    const proposed = await proposeAccountFrame(env, proposer, env.timestamp);
    if (!proposed.success) throw new Error(proposed.error || 'proposal failed');
    const frame = proposed.accountInput!.proposal.frame;
    expect(frame.timestamp).toBe(env.timestamp);

    const replayed = await applyAccountTx(
      receiver,
      pullLock,
      frame.byLeft!,
      frame.timestamp,
      frame.jHeight,
      true,
      env,
    );
    expect(replayed.success).toBe(true);
    expect(computeAccountStateRoot(receiver)).toBe(frame.accountStateRoot);
  });

  test('nested Account proposal accepts a future committed Entity timestamp across validator ticks', async () => {
    const seed = 'account-frame-entity-timestamp-authority';
    const proposerEnv = createEmptyEnv(seed);
    const validatorEnv = createEmptyEnv(seed);
    proposerEnv.timestamp = 1_000;
    validatorEnv.timestamp = 1_100;
    proposerEnv.browserVM = { getDepositoryAddress: () => hex20('dd') } as typeof proposerEnv.browserVM;
    validatorEnv.browserVM = { getDepositoryAddress: () => hex20('dd') } as typeof validatorEnv.browserVM;
    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    attachSigningReplica(proposerEnv, left.entityId, left.signerId);
    attachSigningReplica(validatorEnv, left.entityId, left.signerId);
    const base = makeProposalAccount([
      { type: 'set_credit_limit', data: { tokenId: 1, amount: 100n } },
    ], left.entityId, right.entityId);
    base.deltas.set(1, createDefaultDelta(1));
    const committedEntityTimestamp = 1_777;

    const proposer = await proposeAccountFrame(
      proposerEnv,
      cloneAccountMachine(base),
      committedEntityTimestamp,
    );
    const validator = await proposeAccountFrame(
      validatorEnv,
      cloneAccountMachine(base),
      committedEntityTimestamp,
    );

    expect(proposer.success).toBe(true);
    expect(validator.success).toBe(true);
    expect(proposer.accountInput?.proposal.frame.timestamp).toBe(committedEntityTimestamp);
    expect(validator.accountInput?.proposal.frame).toEqual(proposer.accountInput?.proposal.frame);
  });

  test('profile update preserves the committed Entity timestamp across validator ticks', async () => {
    const entityId = `0x${'a7'.repeat(32)}`;
    const proposerState = makeEntityState(entityId);
    const validatorState = makeEntityState(entityId);
    proposerState.timestamp = 777;
    validatorState.timestamp = 777;
    const proposerEnv = createEmptyEnv('profile-timestamp-proposer');
    const validatorEnv = createEmptyEnv('profile-timestamp-validator');
    proposerEnv.timestamp = 1_000;
    validatorEnv.timestamp = 1_100;
    const tx = {
      type: 'profile-update',
      data: { profile: { entityId, name: 'Committed timestamp' } },
    } as const;

    const proposer = await applyEntityTx(proposerEnv, proposerState, tx);
    const validator = await applyEntityTx(validatorEnv, validatorState, tx);

    expect(proposer.newState.timestamp).toBe(777);
    expect(validator.newState).toEqual(proposer.newState);
  });

  test('r2c quote expiry uses the committed Entity timestamp across validator ticks', async () => {
    const entityId = `0x${'a8'.repeat(32)}`;
    const counterpartyId = `0x${'a9'.repeat(32)}`;
    const quoteId = 1_000;
    const makeState = (): EntityState => {
      const state = makeEntityState(entityId);
      state.timestamp = quoteId + QUOTE_EXPIRY_MS;
      state.reserves.set(1, 100n);
      const account = makeProposalAccount([], entityId, counterpartyId);
      account.shadow.rebalance.activeQuote = {
        quoteId,
        tokenId: 1,
        amount: 10n,
        feeTokenId: 1,
        feeAmount: 1n,
        accepted: true,
      };
      state.accounts.set(counterpartyId, account);
      return state;
    };
    const proposerEnv = createEmptyEnv('r2c-timestamp-proposer');
    const validatorEnv = createEmptyEnv('r2c-timestamp-validator');
    proposerEnv.timestamp = quoteId + QUOTE_EXPIRY_MS;
    validatorEnv.timestamp = proposerEnv.timestamp + 1;
    const tx = {
      type: 'r2c',
      data: {
        counterpartyId,
        tokenId: 1,
        amount: 10n,
        rebalanceQuoteId: quoteId,
        rebalanceFeeTokenId: 1,
        rebalanceFeeAmount: 1n,
      },
    } as const;

    const proposer = await applyEntityTx(proposerEnv, makeState(), tx);
    const validator = await applyEntityTx(validatorEnv, makeState(), tx);

    expect(validator.newState).toEqual(proposer.newState);
    expect(validator.newState.messages.some(message => message.includes('quote expired'))).toBe(false);
  });

  test('openAccount rejects an unmaterialized watch seed and replays the signed seed identically', async () => {
    const seed = 'open-account-watch-seed-materialization';
    const proposerEnv = createEmptyEnv(seed);
    const validatorEnv = createEmptyEnv('different-validator-runtime-seed');
    proposerEnv.timestamp = 1_000;
    validatorEnv.timestamp = 1_100;
    const author = registerLazySigner(seed, '1');
    const targetEntityId = `0x${'b7'.repeat(32)}`;
    const state = makeEntityState(author.entityId);
    state.timestamp = 777;
    state.config = makeSingleSignerConfigFor(author.signerId);
    attachSigningReplica(proposerEnv, author.entityId, author.signerId);
    const installTarget = (env: Env): void => {
      const target = makeEntityState(targetEntityId);
      target.config = state.config;
      env.eReplicas.set(`${targetEntityId}:target-signer`, {
        entityId: targetEntityId,
        signerId: 'target-signer',
        mempool: [],
        isProposer: true,
        state: target,
      });
    };
    installTarget(proposerEnv);
    installTarget(validatorEnv);
    const rawTx = {
      type: 'openAccount',
      data: { targetEntityId },
    } as const;

    const rejected = await applyEntityTx(proposerEnv, state, rawTx);
    expect(rejected.skippedError).toBe('OPEN_ACCOUNT_WATCH_SEED_REQUIRED');
    expect(rejected.newState.accounts.size).toBe(0);

    const [commandTx] = prepareLocallyAuthoredEntityTxs(
      proposerEnv,
      state,
      author.signerId,
      [rawTx],
    );
    if (commandTx?.type !== 'entityCommand') throw new Error('TEST_OPEN_ACCOUNT_COMMAND_MISSING');
    const proposalTx = commandTx.data.txs[0];
    if (proposalTx?.type !== 'propose' || proposalTx.data.action.type !== 'entity_transaction') {
      throw new Error('TEST_OPEN_ACCOUNT_PROPOSAL_MISSING');
    }
    const materializedTx = proposalTx.data.action.data.txs[0];
    if (materializedTx?.type !== 'openAccount') throw new Error('TEST_OPEN_ACCOUNT_TX_MISSING');
    expect(materializedTx.data.watchSeed).toMatch(/^0x[0-9a-f]{64}$/);

    const proposer = await applyEntityTx(proposerEnv, makeEntityState(author.entityId), materializedTx);
    const validatorState = makeEntityState(author.entityId);
    validatorState.config = state.config;
    const validator = await applyEntityTx(validatorEnv, validatorState, materializedTx);
    expect(validator.newState.accounts.get(targetEntityId)?.watchSeed)
      .toBe(proposer.newState.accounts.get(targetEntityId)?.watchSeed);
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

    await expect(proposeAccountFrame(env, account, env.timestamp)).rejects.toThrow(/CROSS_J_FILL_ACK_PROPOSAL_FAILED/);
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

    await expect(proposeAccountFrame(env, account, env.timestamp)).rejects.toThrow(/CROSS_J_PULL_RESOLVE_PROPOSAL_FAILED/);
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
        jurisdiction: `stack:1:0x${'c1'.repeat(20)}`,
        entityId: left,
        counterpartyEntityId: right,
        tokenId: 1,
        amount,
      },
      target: {
        jurisdiction: `stack:2:0x${'c2'.repeat(20)}`,
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

    await expect(proposeAccountFrame(env, account, env.timestamp)).rejects.toThrow(/CROSS_J_SWAP_OFFER_PROPOSAL_FAILED/);
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
    account.proofHeader = { fromEntity: hub, toEntity: maker, nextProofNonce: 0 };
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

    const result = await proposeAccountFrame(env, account, env.timestamp);

    expect(result.success).toBe(true);
    expect(result.accountInput?.proposal.frame.accountTxs).toEqual([validTx]);
    expect(account.pendingFrame?.accountTxs).toEqual([validTx]);
    expect(account.mempool).toEqual([]);
  });

  test('same-chain offers match and queue both resolves in one hub Entity frame', async () => {
    const seed = 'same-chain-single-hub-frame';
    const env = createEmptyEnv(seed);
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const hub = registerLazySigner(seed, 'hub');
    const maker = registerLazySigner(seed, 'maker');
    const taker = registerLazySigner(seed, 'taker');
    for (const identity of [hub, maker, taker]) {
      attachSigningReplica(env, identity.entityId, identity.signerId);
    }

    const fundedAccount = (proposerId: string, counterpartyId: string): AccountMachine => {
      const leftEntity = isLeftEntity(proposerId, counterpartyId) ? proposerId : counterpartyId;
      const rightEntity = leftEntity === proposerId ? counterpartyId : proposerId;
      const account = makeProposalAccount([], leftEntity, rightEntity);
      account.proofHeader = { fromEntity: proposerId, toEntity: counterpartyId, nextProofNonce: 0 };
      for (const tokenId of [1, 2]) {
        account.deltas.set(tokenId, {
          ...createDefaultDelta(tokenId),
          leftCreditLimit: 10n ** 24n,
          rightCreditLimit: 10n ** 24n,
        });
      }
      return account;
    };

    const proposalFor = async (
      identity: typeof maker,
      tx: Extract<AccountTx, { type: 'swap_offer' }>,
    ): Promise<{ input: AccountInput; hubAccount: AccountMachine }> => {
      const proposerAccount = fundedAccount(identity.entityId, hub.entityId);
      proposerAccount.mempool.push(tx);
      const proposed = await proposeAccountFrame(env, proposerAccount, env.timestamp, 0);
      if (!proposed.success || !proposed.accountInput) {
        throw new Error(`SAME_CHAIN_PROPOSAL_FAILED:${proposed.error || 'missing input'}`);
      }
      return {
        input: proposed.accountInput,
        hubAccount: fundedAccount(hub.entityId, identity.entityId),
      };
    };

    const baseAmount = SWAP_LOT_SCALE;
    const quoteAmount = 1_000_000n;
    const makerOffer = await proposalFor(maker, {
      type: 'swap_offer',
      data: {
        offerId: 'same-frame-maker',
        giveTokenId: 2,
        giveAmount: baseAmount,
        wantTokenId: 1,
        wantAmount: quoteAmount,
        minFillRatio: 0,
      },
    });
    const takerOffer = await proposalFor(taker, {
      type: 'swap_offer',
      data: {
        offerId: 'same-frame-taker',
        giveTokenId: 1,
        giveAmount: quoteAmount,
        wantTokenId: 2,
        wantAmount: baseAmount,
        minFillRatio: 0,
      },
    });

    const hubState = makeEntityState(hub.entityId);
    hubState.config = makeSingleSignerConfigFor(hub.signerId);
    hubState.profile.isHub = true;
    hubState.accounts.set(maker.entityId, makerOffer.hubAccount);
    hubState.accounts.set(taker.entityId, takerOffer.hubAccount);
    hubState.orderbookExt = {
      books: new Map(),
      orderPairs: new Map(),
      referrals: new Map(),
      hubProfile: {
        entityId: hub.entityId,
        name: 'Single-frame Hub',
        minTradeSize: 0n,
        spreadDistribution: {
          makerBps: 0,
          takerBps: 10_000,
          hubBps: 0,
          makerReferrerBps: 0,
          takerReferrerBps: 0,
        },
        referenceTokenId: 1,
        supportedPairs: ['1/2'],
      },
    };

    const result = await applyEntityFrame(env, hubState, [
      { type: 'accountInput', data: makerOffer.input },
      { type: 'accountInput', data: takerOffer.input },
    ], env.timestamp);

    for (const accountId of [maker.entityId, taker.entityId]) {
      const pending = result.newState.accounts.get(accountId)?.pendingFrame;
      expect(pending?.accountTxs.some((tx) => tx.type === 'swap_resolve')).toBe(true);
    }
    expect(result.outputs.filter((output) => (
      output.entityTxs?.some((tx) => (
        tx.type === 'accountInput'
        && 'proposal' in tx.data
        && tx.data.proposal.frame.accountTxs.some((accountTx) => accountTx.type === 'swap_resolve')
      ))
    ))).toHaveLength(2);
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
      expect(jTx.data.batchGeneration).toBe(1);
      expect(jTx.data.hankoSignature).toMatch(/^0x/);
    }
    expect(result.workingReplica.state.jBatchState?.broadcastCount).toBe(1);
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
    const finalProofbody = makeEmptyProofBody();
    const finalProofbodyHash = hashProofBodyStruct(finalProofbody);
    account.disputeProofBodiesByHash = { [finalProofbodyHash]: finalProofbody };
    account.activeDispute = {
      startedByLeft: true,
      initialProofbodyHash: finalProofbodyHash,
      initialNonce: 7,
      disputeTimeout: 22,
      jNonce: 7,
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
        initialProofbodyHash: finalProofbodyHash,
        finalProofbodyHash,
      },
    };
    const signed = prepareJEventInput(env, entityId, signerId, {
      blockNumber: 22,
      blockHash: `0x${'99'.repeat(32)}`,
      transactionHash: `0x${'88'.repeat(32)}`,
      events: [disputeFinalizedEvent],
      jurisdictionRef: getJEventJurisdictionRef(state.config.jurisdiction),
    });

    const rangeData = buildJEventRangeData(state, {
      from: signerId,
      jurisdictionRef: getJEventJurisdictionRef(state.config.jurisdiction),
      observedAt: 22,
      blockNumber: 22,
      blockHash: `0x${'99'.repeat(32)}`,
      transactionHash: `0x${'88'.repeat(32)}`,
      event: disputeFinalizedEvent,
      ...signed,
    }, env);
    replica.jHistory = recordValidatorJHistory(undefined, {
      jurisdictionRef: rangeData.jurisdictionRef,
      scannedThroughHeight: rangeData.scannedThroughHeight,
      tipBlockHash: rangeData.tipBlockHash,
      headers: Array.from({ length: rangeData.scannedThroughHeight }, (_, index) => {
        const jHeight = index + 1;
        return {
          jHeight,
          jBlockHash: jHeight === 22
            ? rangeData.tipBlockHash
            : `0x${jHeight.toString(16).padStart(64, '0')}`,
        };
      }),
      blocks: rangeData.blocks.map((block) => ({
        jurisdictionRef: rangeData.jurisdictionRef,
        jHeight: block.blockNumber,
        jBlockHash: block.blockHash,
        eventsHash: block.eventsHash,
        events: block.events,
        ...(block.disputeFinalizationEvidence ? { disputeFinalizationEvidence: block.disputeFinalizationEvidence } : {}),
        ...(block.disputeFinalizationEvidenceHash
          ? { disputeFinalizationEvidenceHash: block.disputeFinalizationEvidenceHash }
          : {}),
      })),
    });
    const attestation = buildLocalJPrefixAttestation(env, replica);
    if (!attestation) throw new Error('TEST_J_PREFIX_ATTESTATION_MISSING');
    const applied = await applyEntityInput(env, replica, {
      entityId,
      signerId,
      jPrefixAttestations: new Map([[signerId, attestation]]),
    });
    expect(applied.outcome).toEqual({ kind: 'committed' });
    expect(applied.newState.lastFinalizedJHeight).toBe(rangeData.scannedThroughHeight);
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
              starterArguments: '0x',
              otherArguments: '0x',
              sig: '0x',
              startedByLeft: true,
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
              starterArguments: '0x',
              otherArguments: '0x',
              sig: '0x',
              startedByLeft: true,
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

  test('submitRuntimeJOutbox queues a durable transient result without poisoning Entity consensus', async () => {
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
    const queuedRuntimeTxs: RuntimeTx[] = [];

    await submitAuditRuntimeJOutbox(
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
                runtimeSubmitAttempt: { attemptId: 'transient-attempt-1', attemptNumber: 1, attemptedAt: 123 },
              },
              timestamp: env.timestamp,
            } as any,
          ],
        },
      ],
      {
        enqueueRuntimeInputs: (_env, inputs, runtimeTxs) => {
          queuedInputs.push(...(inputs ?? []));
          queuedRuntimeTxs.push(...(runtimeTxs ?? []));
        },
      },
    );

    expect(queuedInputs).toHaveLength(0);
    expect(queuedRuntimeTxs).toMatchObject([{
      type: 'recordJSubmitResult',
      data: { outcome: 'transientFailure', message: 'ECONNREFUSED' },
    }]);
    expect(state.jBatchState?.status).toBe('sent');
    expect(state.jBatchState?.failedAttempts).toBe(0);
    expect(state.jBatchState?.sentBatch).toBeDefined();
    expect(state.jBatchState?.sentBatch?.lastFailure).toBeUndefined();
    expect(state.jBatchState?.sentBatch?.terminalFailure).toBeUndefined();
  });

  test('submitRuntimeJOutbox reconciles an on-chain finalized dispute before submitting its stale batch', async () => {
    const entityId = `0x${'ac'.repeat(32)}`;
    const counterpartyId = `0x${'bd'.repeat(32)}`;
    const signerId = `0x${'ce'.repeat(20)}`;
    const batchHash = `0x${'13'.repeat(32)}`;
    const disputeFinalize = {
      counterentity: counterpartyId,
      initialNonce: 3,
      finalNonce: 3,
      initialProofbodyHash: `0x${'14'.repeat(32)}`,
      finalProofbody: makeEmptyProofBody(),
      starterArguments: '0x',
      otherArguments: '0x',
      sig: '0x',
      startedByLeft: true,
      cooperative: false,
    };
    const batch = { ...createEmptyBatch(), disputeFinalizations: [disputeFinalize] };
    const env = createEmptyEnv('j-submit-stale-dispute-finalize');
    env.runtimeId = signerId;
    env.timestamp = 125;
    const state = makeEntityState(entityId);
    state.jBatchState = {
      batch: createEmptyBatch(),
      jurisdiction: null,
      lastBroadcast: 0,
      broadcastCount: 0,
      failedAttempts: 0,
      status: 'sent',
      sentBatch: {
        batch,
        batchHash,
        encodedBatch: '0x1234',
        entityNonce: 1,
        firstSubmittedAt: 125,
        lastSubmittedAt: 125,
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
    let submitCalls = 0;
    env.jReplicas = new Map([['Testnet', {
      jadapter: {
        getAccountInfo: async () => ({
          nonce: 4n,
          disputeHash: `0x${'00'.repeat(32)}`,
          disputeTimeout: 0n,
        }),
        submitTx: async () => {
          submitCalls += 1;
          return { success: true, events: [], txHash: `0x${'18'.repeat(32)}` };
        },
        pollNow: async () => {},
      },
    } as any]]);
    const queuedInputs: EntityInput[] = [];

    await submitAuditRuntimeJOutbox(env, [{
      jurisdictionName: 'Testnet',
      jTxs: [{
        type: 'batch',
        entityId,
        data: {
          batch,
          batchHash,
          encodedBatch: '0x1234',
          entityNonce: 1,
          hankoSignature: '0x1234',
          batchSize: 1,
          signerId,
          runtimeSubmitAttempt: { attemptId: 'reconcile-before-1', attemptNumber: 1, attemptedAt: 125 },
        },
        timestamp: env.timestamp,
      } as any, {
        type: 'batch',
        entityId: `0x${'19'.repeat(32)}`,
        data: {
          batch: createEmptyBatch(),
          batchHash: `0x${'19'.repeat(32)}`,
          entityNonce: 1,
          signerId,
          batchSize: 0,
          runtimeSubmitAttempt: { attemptId: 'reconcile-before-2', attemptNumber: 1, attemptedAt: 125 },
        },
        timestamp: env.timestamp,
      } as any],
    }], {
      enqueueRuntimeInputs: (_env, inputs) => queuedInputs.push(...(inputs ?? [])),
    });

    expect(submitCalls).toBe(1);
    expect(state.jBatchState?.sentBatch).toBeDefined();
    expect(queuedInputs).toEqual([{
      entityId,
      signerId,
      entityTxs: [{
        type: 'j_abort_sent_batch',
        data: { reason: 'counterparty-finalized-before-submit', requeueToCurrent: true },
      }],
    }]);
  });

  test('submitRuntimeJOutbox reconciles on-chain finality observed after a failed submit and continues', async () => {
    const entityId = `0x${'ca'.repeat(32)}`;
    const counterpartyId = `0x${'cb'.repeat(32)}`;
    const signerId = `0x${'cc'.repeat(20)}`;
    const initialProofbodyHash = `0x${'cd'.repeat(32)}`;
    const env = createEmptyEnv('j-submit-post-failure-reconcile');
    env.runtimeId = signerId;
    env.timestamp = 126;
    let accountReadCalls = 0;
    let submitCalls = 0;
    env.jReplicas = new Map([['Testnet', {
      jadapter: {
        getAccountInfo: async () => {
          accountReadCalls += 1;
          return accountReadCalls === 1
            ? { nonce: 7n, disputeHash: `0x${'ab'.repeat(32)}`, disputeTimeout: 123n }
            : { nonce: 8n, disputeHash: `0x${'00'.repeat(32)}`, disputeTimeout: 0n };
        },
        submitTx: async () => {
          submitCalls += 1;
          return submitCalls === 1
            ? { success: false, error: 'staticCall revert: E5()' }
            : { success: true, events: [], txHash: `0x${'ce'.repeat(32)}` };
        },
        pollNow: async () => {},
      },
    } as any]]);
    const queuedInputs: EntityInput[] = [];
    const disputeBatch = {
      ...createEmptyBatch(),
      disputeFinalizations: [{
        counterentity: counterpartyId,
        initialNonce: 7,
        finalNonce: 7,
        initialProofbodyHash,
        finalProofbody: makeEmptyProofBody(),
        starterArguments: '0x',
        otherArguments: '0x',
        sig: '0x',
        startedByLeft: true,
        cooperative: false,
      }],
    };

    await submitAuditRuntimeJOutbox(env, [{
      jurisdictionName: 'Testnet',
      jTxs: [{
        type: 'batch',
        entityId,
        data: {
          batch: disputeBatch,
          batchHash: `0x${'d2'.repeat(32)}`,
          encodedBatch: '0x1234',
          entityNonce: 7,
          hankoSignature: '0x1234',
          batchSize: 1,
          signerId,
          runtimeSubmitAttempt: { attemptId: 'reconcile-after-1', attemptNumber: 1, attemptedAt: 126 },
        },
        timestamp: env.timestamp,
      } as any, {
        type: 'batch',
        entityId: `0x${'d3'.repeat(32)}`,
        data: {
          batch: createEmptyBatch(),
          batchHash: `0x${'d3'.repeat(32)}`,
          entityNonce: 1,
          signerId,
          batchSize: 0,
          runtimeSubmitAttempt: { attemptId: 'reconcile-after-2', attemptNumber: 1, attemptedAt: 126 },
        },
        timestamp: env.timestamp,
      } as any],
    }], {
      enqueueRuntimeInputs: (_env, inputs) => queuedInputs.push(...(inputs ?? [])),
    });

    expect(accountReadCalls).toBe(2);
    expect(submitCalls).toBe(2);
    expect(queuedInputs).toEqual([{
      entityId,
      signerId,
      entityTxs: [{
        type: 'j_abort_sent_batch',
        data: { reason: 'counterparty-finalized-after-submit-failure', requeueToCurrent: true },
      }],
    }]);
  });

  test('submitRuntimeJOutbox keeps E5 fatal without matching finalized-dispute evidence', async () => {
    const entityId = `0x${'ae'.repeat(32)}`;
    const signerId = `0x${'cf'.repeat(20)}`;
    const env = createEmptyEnv('j-submit-unproven-e5');
    env.runtimeId = signerId;
    env.timestamp = 126;
    env.jReplicas = new Map([['Testnet', {
      jadapter: {
        submitTx: async () => ({ success: false, error: 'staticCall revert: E5()' }),
        pollNow: async () => {},
      },
    } as any]]);
    const queuedRuntimeTxs: RuntimeTx[] = [];

    await submitAuditRuntimeJOutbox(env, [{
      jurisdictionName: 'Testnet',
      jTxs: [{
        type: 'batch',
        entityId,
        data: {
          batch: { ...createEmptyBatch(), reserveToReserve: [{
            receivingEntity: `0x${'ef'.repeat(32)}`,
            tokenId: 1,
            amount: 10n,
          }] },
          batchHash: `0x${'18'.repeat(32)}`,
          encodedBatch: '0x1234',
          entityNonce: 1,
          hankoSignature: '0x1234',
          batchSize: 1,
          signerId,
          runtimeSubmitAttempt: { attemptId: 'fatal-e5-1', attemptNumber: 1, attemptedAt: 126 },
        },
        timestamp: env.timestamp,
      } as any],
    }], {
      enqueueRuntimeInputs: (_env, _inputs, runtimeTxs) => queuedRuntimeTxs.push(...(runtimeTxs ?? [])),
    });
    expect(queuedRuntimeTxs).toMatchObject([{
      type: 'recordJSubmitResult',
      data: { outcome: 'terminalFailure', message: 'staticCall revert: E5()' },
    }]);
  });

  test('submitRuntimeJOutbox queues terminal staticCall result without mutating Entity consensus', async () => {
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
    const queuedRuntimeTxs: RuntimeTx[] = [];

    await submitAuditRuntimeJOutbox(
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
                runtimeSubmitAttempt: { attemptId: 'fatal-e3-1', attemptNumber: 1, attemptedAt: 124 },
              },
              timestamp: env.timestamp,
            } as any,
          ],
        },
      ],
      { enqueueRuntimeInputs: (_env, _inputs, runtimeTxs) => queuedRuntimeTxs.push(...(runtimeTxs ?? [])) },
    );

    expect(queuedRuntimeTxs).toMatchObject([{
      type: 'recordJSubmitResult',
      data: { outcome: 'terminalFailure', message: 'staticCall revert: E3()' },
    }]);
    expect(state.jBatchState?.status).toBe('sent');
    expect(state.jBatchState?.failedAttempts).toBe(0);
    expect(state.jBatchState?.sentBatch?.terminalFailure).toBeUndefined();
    expect(state.jBatchState?.sentBatch?.lastFailure).toBeUndefined();
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
    const queuedRuntimeTxs: RuntimeTx[] = [];

    await submitAuditRuntimeJOutbox(
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
                runtimeSubmitAttempt: { attemptId: 'non-local-1', attemptNumber: 1, attemptedAt: 125 },
              },
              timestamp: env.timestamp,
            } as any,
          ],
        },
      ],
      { enqueueRuntimeInputs: (_env, _inputs, runtimeTxs) => queuedRuntimeTxs.push(...(runtimeTxs ?? [])) },
    );

    expect(adapterCalls).toBe(0);
    expect(queuedRuntimeTxs).toMatchObject([{
      type: 'recordJSubmitResult',
      data: { outcome: 'terminalFailure' },
    }]);
  });

  test('submitRuntimeJOutbox submits Env-local multi-signer batches even when runtimeId differs', async () => {
    const entityId = `0x${'af'.repeat(32)}`;
    const runtimeId = `0x${'33'.repeat(20)}`;
    const localScenarioSignerId = '97';
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

    await submitAuditRuntimeJOutbox(
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
                runtimeSubmitAttempt: { attemptId: 'local-multisig-1', attemptNumber: 1, attemptedAt: 126 },
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
    const queuedRuntimeTxs: RuntimeTx[] = [];

    await submitAuditRuntimeJOutbox(
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
                batchHash: `0x${'15'.repeat(32)}`,
                entityNonce: 1,
                runtimeSubmitAttempt: { attemptId: 'missing-hanko-1', attemptNumber: 1, attemptedAt: 123 },
              },
              timestamp: env.timestamp,
            } as any,
          ],
        },
      ],
      {
        enqueueRuntimeInputs: (_env, _inputs, runtimeTxs) => queuedRuntimeTxs.push(...(runtimeTxs ?? [])),
      },
    );

    expect(adapterCalls).toBe(0);
    expect(queuedRuntimeTxs).toMatchObject([{
      type: 'recordJSubmitResult',
      data: { outcome: 'terminalFailure' },
    }]);
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
      }]]),
      shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map([[1, 123]]) } },
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
    expect(accountMachine.shadow.rebalance.submittedAtByToken.get(1)).toBe(123);
    expect(delta.offdelta).toBe(990n);
  });

  test('auto-rebalance allows pending request top-up during settlement', () => {
    const usd = 10n ** 18n;
    const accountMachine = {
      leftEntity: `0x${'11'.repeat(32)}`,
      rightEntity: `0x${'ff'.repeat(32)}`,
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
      }]]),
      shadow: { rebalance: {
        policy: new Map([[1, {
          r2cRequestSoftLimit: 500n * usd,
          hardLimit: 10_000n * usd,
          maxAcceptableFee: 100n * usd,
        }]]),
        submittedAtByToken: new Map([[1, 123]]),
      } },
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
      rebalanceFeePolicies: new Map([[1, { right: {
        policyVersion: 1, baseFee: 10n * usd, gasFee: 0n, liquidityFeeBps: 0n, updatedAt: 1,
      } }]]),
    };

    const txs = checkAutoRebalance(
      accountMachine as Parameters<typeof checkAutoRebalance>[0],
      `0x${'11'.repeat(32)}`,
      `0x${'ff'.repeat(32)}`,
    );

    expect(txs).toHaveLength(1);
    expect(txs[0]?.type).toBe('request_collateral');
    expect(txs[0]?.data.amount).toBe(800n * usd);
  });

  test('auto-rebalance fee policy ignores live sibling topology', () => {
    const env = createEmptyEnv('rebalance-policy-consensus-purity');
    const entityId = `0x${'13'.repeat(32)}`;
    const hubId = `0x${'14'.repeat(32)}`;
    const account = makeProposalAccount([], entityId, hubId);
    const hubState = makeEntityState(hubId);
    hubState.hubRebalanceConfig = {
      matchingStrategy: 'amount',
      policyVersion: 9,
      routingFeePPM: 0,
      baseFee: 999n,
      rebalanceLiquidityFeeBps: 88n,
    };
    env.eReplicas.set(`${hubId}:hub`, {
      entityId: hubId,
      signerId: 'hub',
      state: hubState,
    } as never);

    expect(resolveAutoRebalanceFeePolicy(account, entityId, 1)).toBeUndefined();

    account.rebalanceFeePolicies = new Map([[1, { right: {
      policyVersion: 3, baseFee: 7n, liquidityFeeBps: 5n, gasFee: 11n, updatedAt: 1,
    } }]]);
    expect(resolveAutoRebalanceFeePolicy(account, entityId, 1)).toEqual({
      policyVersion: 3,
      baseFee: 7n,
      liquidityFeeBps: 5n,
      gasFee: 11n,
    });
  });

  test('explicit rebalance policy AccountTx binds the snapshot to proposer side and token', async () => {
    const leftId = `0x${'15'.repeat(32)}`;
    const rightId = `0x${'f5'.repeat(32)}`;
    const account = makeProposalAccount([], leftId, rightId);
    account.deltas.set(1, createDefaultDelta(1));
    const tx: AccountTx = {
      type: 'rebalance_policy',
      data: {
        tokenId: 1,
        policyVersion: 4,
        baseFee: 7n,
        liquidityFeeBps: 5n,
        gasFee: 11n,
      },
    };

    const result = await applyAccountTx(account, tx, true, 123, 0);

    expect(result.success).toBe(true);
    expect(account.rebalanceFeePolicies?.get(1)?.left).toEqual({
      policyVersion: 4,
      baseFee: 7n,
      liquidityFeeBps: 5n,
      gasFee: 11n,
      updatedAt: 123,
    });
    expect(account.rebalanceFeePolicies?.get(1)?.right).toBeUndefined();

    const retry = await applyAccountTx(account, tx, true, 999, 0);
    expect(retry.success).toBe(true);
    expect(account.rebalanceFeePolicies?.get(1)?.left?.updatedAt).toBe(123);

    const beforeConflict = computeAccountStateRoot(account);
    const conflict = await applyAccountTx(account, {
      ...tx,
      data: { ...tx.data, baseFee: 8n },
    }, true, 999, 0);
    expect(conflict).toMatchObject({ success: false, error: expect.stringContaining('REBALANCE_POLICY_EQUIVOCATION') });
    expect(computeAccountStateRoot(account)).toBe(beforeConflict);

    const stale = await applyAccountTx(account, {
      ...tx,
      data: { ...tx.data, policyVersion: 3 },
    }, true, 999, 0);
    expect(stale.success).toBe(true);
    expect(computeAccountStateRoot(account)).toBe(beforeConflict);

    const right = await applyAccountTx(account, {
      ...tx,
      data: { ...tx.data, policyVersion: 1, baseFee: 13n },
    }, false, 456, 0);
    expect(right.success).toBe(true);
    expect(account.rebalanceFeePolicies?.get(1)?.right?.baseFee).toBe(13n);
    expect(account.rebalanceFeePolicies?.get(1)?.left?.baseFee).toBe(7n);
  });

  test('rebalance policy rejects non-bigint fee terms before mutating Account state', async () => {
    const leftId = `0x${'18'.repeat(32)}`;
    const rightId = `0x${'f8'.repeat(32)}`;
    const account = makeProposalAccount([], leftId, rightId);
    account.deltas.set(1, createDefaultDelta(1));
    const before = computeAccountStateRoot(account);
    const malformed = {
      type: 'rebalance_policy',
      data: { tokenId: 1, policyVersion: 1, baseFee: 7, liquidityFeeBps: 5, gasFee: 11 },
    } as unknown as AccountTx;

    const result = await applyAccountTx(account, malformed, true, 123, 0);

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('invalid fee types') });
    expect(computeAccountStateRoot(account)).toBe(before);
    expect(account.rebalanceFeePolicies).toBeUndefined();
  });

  test('auto-rebalance output order survives compact storage map canonicalization', () => {
    const entityId = `0x${'19'.repeat(32)}`;
    const hubId = `0x${'f9'.repeat(32)}`;
    const account = makeProposalAccount([], entityId, hubId);
    for (const tokenId of [3, 1, 2]) {
      const delta = createDefaultDelta(tokenId);
      delta.offdelta = 1_000n;
      delta.rightCreditLimit = 2_000n;
      account.deltas.set(tokenId, delta);
      account.shadow.rebalance.policy.set(tokenId, {
        r2cRequestSoftLimit: 100n,
        hardLimit: 2_000n,
        maxAcceptableFee: 100n,
      });
      const policies = account.rebalanceFeePolicies ?? new Map();
      policies.set(tokenId, { right: {
        policyVersion: 1,
        baseFee: 1n,
        liquidityFeeBps: 0n,
        gasFee: 0n,
        updatedAt: 1,
      } });
      account.rebalanceFeePolicies = policies;
    }
    const restored = hydrateAccountDocFromStorage(decodeValidatedBuffer(
      encodeBuffer(projectAccountDoc(account)),
      validateStorageAccountDocValue,
    ));

    const liveTxs = checkAutoRebalance(account, entityId, hubId);
    const restoredTxs = checkAutoRebalance(restored, entityId, hubId);

    expect(liveTxs).toEqual(restoredTxs);
    expect(liveTxs.map((tx) => tx.data.tokenId)).toEqual([1, 2, 3]);
  });

  test('setHubConfig publishes an explicit fee policy into every established Account lane', () => {
    const env = createEmptyEnv('rebalance-policy-publish');
    const hubId = `0x${'16'.repeat(32)}`;
    const userId = `0x${'f6'.repeat(32)}`;
    const state = makeEntityState(hubId);
    const account = makeProposalAccount([], hubId, userId);
    account.deltas.set(1, createDefaultDelta(1));
    account.deltas.set(2, createDefaultDelta(2));
    state.accounts.set(userId, account);

    const result = handleSetHubConfigEntityTx(env, state, {
      type: 'setHubConfig',
      data: {
        policyVersion: 4,
        rebalanceLiquidityFeeBps: 5n,
      },
    });

    expect(result.mempoolOps?.map(({ tx }) => tx)).toEqual([
      {
        type: 'rebalance_policy',
        data: { tokenId: 1, policyVersion: 4, baseFee: 100_000n, liquidityFeeBps: 5n, gasFee: 0n },
      },
      {
        type: 'rebalance_policy',
        data: { tokenId: 2, policyVersion: 4, baseFee: 100_000_000_000_000_000n, liquidityFeeBps: 5n, gasFee: 0n },
      },
    ]);
    expect(result.outputs).toHaveLength(1);
    expect(() => handleSetHubConfigEntityTx(env, result.newState, {
      type: 'setHubConfig',
      data: { policyVersion: 4, rebalanceLiquidityFeeBps: 6n },
    })).toThrow('HUB_REBALANCE_POLICY_EQUIVOCATION:version=4');
    expect(() => handleSetHubConfigEntityTx(env, result.newState, {
      type: 'setHubConfig',
      data: { policyVersion: 3, rebalanceLiquidityFeeBps: 5n },
    })).toThrow('HUB_REBALANCE_POLICY_VERSION_STALE:3<4');
  });

  test('bilateral rebalance policies survive compact storage decode with strict shape validation', () => {
    const leftId = `0x${'17'.repeat(32)}`;
    const rightId = `0x${'f7'.repeat(32)}`;
    const account = makeProposalAccount([], leftId, rightId);
    account.deltas.set(1, createDefaultDelta(1));
    account.rebalanceFeePolicies = new Map([[1, {
      left: { policyVersion: 2, baseFee: 3n, liquidityFeeBps: 4n, gasFee: 5n, updatedAt: 6 },
      right: { policyVersion: 7, baseFee: 8n, liquidityFeeBps: 9n, gasFee: 10n, updatedAt: 11 },
    }]]);
    const root = computeAccountStateRoot(account);

    const restored = hydrateAccountDocFromStorage(decodeValidatedBuffer(
      encodeBuffer(projectAccountDoc(account)),
      validateStorageAccountDocValue,
    ));

    expect(restored.rebalanceFeePolicies).toEqual(account.rebalanceFeePolicies);
    expect(computeAccountStateRoot(restored)).toBe(root);

    const corrupt = projectAccountDoc(account);
    const left = corrupt.rebalanceFeePolicies?.get(1)?.left;
    if (!left) throw new Error('TEST_REBALANCE_POLICY_REQUIRED');
    (left as typeof left & { unexpected: boolean }).unexpected = true;
    expect(() => decodeValidatedBuffer(
      encodeBuffer(corrupt),
      validateStorageAccountDocValue,
    )).toThrow('contains unexpected fields');
  });

  test('post-frame auto-rebalance uses explicit owner role and committed exact fees', async () => {
    const entityId = `0x${'15'.repeat(32)}`;
    const hubId = `0x${'f5'.repeat(32)}`;
    const account = makeProposalAccount([], entityId, hubId);
    account.rebalanceFeePolicies = new Map([[1, { right: {
      policyVersion: 4, baseFee: 7n, liquidityFeeBps: 5n, gasFee: 11n, updatedAt: 1,
    } }]]);
    account.shadow.rebalance.policy.set(1, {
      r2cRequestSoftLimit: 500n,
      hardLimit: 100_000n,
      maxAcceptableFee: 1_000n,
    });
    const delta = createDefaultDelta(1);
    delta.offdelta = 60_000n;
    delta.rightCreditLimit = 100_000n;
    account.deltas.set(1, delta);
    const withSibling = createEmptyEnv('rebalance-explicit-role-with-sibling');
    const withoutSibling = createEmptyEnv('rebalance-explicit-role-without-sibling');
    const misleadingOwner = makeEntityState(entityId);
    misleadingOwner.hubRebalanceConfig = {
      matchingStrategy: 'amount',
      policyVersion: 99,
      routingFeePPM: 0,
      baseFee: 999n,
    };
    withSibling.eReplicas.set(`${entityId}:misleading`, {
      entityId,
      signerId: 'misleading',
      state: misleadingOwner,
    } as never);

    const [withResult, withoutResult] = await Promise.all([
      runPostFrameAutoRebalanceCheck(withSibling, structuredClone(account), entityId, hubId, 1, false),
      runPostFrameAutoRebalanceCheck(withoutSibling, structuredClone(account), entityId, hubId, 1, false),
    ]);

    expect(withResult).toEqual(withoutResult);
    expect(withResult[0]?.data.feeAmount).toBe(48n);
  });

  test('private rebalance policy immediately queues collateral for existing exposure', () => {
    const env = createEmptyEnv('rebalance-policy-existing-exposure');
    const entityId = `0x${'11'.repeat(32)}`;
    const hubId = `0x${'ff'.repeat(32)}`;
    const usd = 10n ** 18n;
    const state = makeEntityState(entityId);
    const account = makeProposalAccount([], entityId, hubId);
    account.rebalanceFeePolicies = new Map([[1, { right: {
      policyVersion: 1, baseFee: 1n * usd, liquidityFeeBps: 1n, gasFee: 0n, updatedAt: 1,
    } }]]);
    account.deltas.set(1, {
      tokenId: 1,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 550n * usd,
      leftCreditLimit: 0n,
      rightCreditLimit: 2_000n * usd,
      leftAllowance: 0n,
      rightAllowance: 0n,
      leftHold: 0n,
      rightHold: 0n,
    });
    state.accounts.set(hubId, account);

    const result = handleSetRebalancePolicyEntityTx(env, state, {
      type: 'setRebalancePolicy',
      data: {
        counterpartyEntityId: hubId,
        tokenId: 1,
        r2cRequestSoftLimit: 500n * usd,
        hardLimit: 10_000n * usd,
        maxAcceptableFee: 20n * usd,
      },
    });

    expect(result.newState.accounts.get(hubId)?.shadow.rebalance.policy.get(1)?.r2cRequestSoftLimit).toBe(500n * usd);
    expect(result.mempoolOps).toHaveLength(1);
    expect(result.mempoolOps?.[0]?.tx.type).toBe('request_collateral');
    expect(result.mempoolOps?.[0]?.tx.data.feeAmount).toBe(1_055_000_000_000_000_000n);
    expect(result.outputs).toHaveLength(1);
    expect('rebalancePolicy' in result.newState.accounts.get(hubId)!).toBe(false);
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
      leftEntity: `0x${'11'.repeat(32)}`,
      rightEntity: `0x${'ff'.repeat(32)}`,
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
      }]]),
      shadow: { rebalance: {
        policy: new Map([[1, {
          r2cRequestSoftLimit: 500n * usd,
          hardLimit: 10_000n * usd,
          maxAcceptableFee: 300n * usd,
        }]]),
        submittedAtByToken: new Map([[1, 123]]),
      } },
      rebalanceFeePolicies: new Map([[1, { right: {
        policyVersion: 1, baseFee: usd / 10n, gasFee: 0n, liquidityFeeBps: 1n, updatedAt: 1,
      } }]]),
    };

    const txs = checkAutoRebalance(
      accountMachine as Parameters<typeof checkAutoRebalance>[0],
      `0x${'11'.repeat(32)}`,
      `0x${'ff'.repeat(32)}`,
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
    expect(accountMachine.shadow.rebalance.submittedAtByToken.get(1)).toBe(123);
    expect(delta.offdelta).toBe(previousRequest + outPeerCredit - feeTopup);
  });

  test('entity proposal fails fast when prevFrameHash is missing above genesis', async () => {
    const seed = 'audit-entity-missing-parent-seed';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;

    const replica = makeReplicaMissingPrevFrameHash();
    const { signerId, entityId } = registerLazySigner(seed, '1');
    replica.entityId = entityId;
    replica.signerId = signerId;
    replica.state.entityId = entityId;
    replica.state.config = makeSingleSignerConfigFor(signerId);
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

  test('entity mempool admission rejects overflow before clone and push', async () => {
    const env = createEmptyEnv('entity-mempool-admission-overflow');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const replica = makeReplicaMissingPrevFrameHash();
    const queuedTx: EntityTx = {
      type: 'chatMessage',
      data: { message: 'already queued' },
    };
    replica.mempool = Array.from({ length: LIMITS.MEMPOOL_SIZE }, () => queuedTx);

    const result = await applyEntityInput(env, replica, {
      entityId: replica.entityId,
      entityTxs: [{
        type: 'chatMessage',
        data: { message: 'must not allocate into mempool' },
      }],
    });

    expect(result.outcome).toEqual({ kind: 'rejected', code: 'ENTITY_MEMPOOL_ADMISSION_REJECTED' });
    expect(result.workingReplica).toBe(replica);
    expect(result.outputs).toEqual([]);
    expect(result.jOutputs).toEqual([]);
    expect(replica.mempool).toHaveLength(LIMITS.MEMPOOL_SIZE);
  });

  test('rejected remote entity input creates neither applied receipt nor route hint', async () => {
    const env = createEmptyEnv('entity-input-rejected-route-hint');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.runtimeId = `0x${'51'.repeat(20)}`;
    env.runtimeState ??= {};
    env.runtimeState.entityRuntimeHints = new Map();
    const replica = makeReplicaMissingPrevFrameHash();
    const queuedTx: EntityTx = { type: 'chatMessage', data: { message: 'full' } };
    replica.mempool = Array.from({ length: LIMITS.MEMPOOL_SIZE }, () => queuedTx);
    env.eReplicas.set(`${replica.entityId}:${replica.signerId}`, replica);
    const remoteEntityId = `0x${'52'.repeat(32)}`;

    const result = await applyMergedEntityInputs(env, [{
      from: `0x${'53'.repeat(20)}`,
      entityId: replica.entityId,
      signerId: replica.signerId,
      entityTxs: [{
        type: 'accountInput',
        data: { fromEntityId: remoteEntityId, toEntityId: replica.entityId },
      } as never],
    }], [], {
      isReplay: false,
      routingDeps: {
        ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
        enqueueRuntimeInputs: () => {},
        extractEntityId: (replicaKey) => replicaKey.split(':')[0] ?? '',
        hasLocalSignerForEntity: () => true,
        hasLocalSignerForEntitySigner: () => true,
        resolveSoleLocalSignerForEntity: () => replica.signerId,
        getP2P: () => null,
      },
    });

    expect(result.appliedEntityInputs).toEqual([]);
    expect(env.runtimeState.entityRuntimeHints.has(remoteEntityId)).toBe(false);
  });

  test('entity commit catch-up derives committed state only from local replay', async () => {
    const seed = 'entity-commit-catch-up-state-binding seed alpha beta gamma';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.timestamp = 42_000;
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const collectiveTxs: EntityTx[] = [{
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
    const frameTxs = await buildQuorumAuthorizedFrameTxs(env, honestBaseState, collectiveTxs);
    const {
      newState: honestFrameState,
      collectedHashes = [],
    } = await applyEntityFrame(
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
      leaderState: { activeValidatorId: signerId, view: 0, changedAtHeight: 0 },
    };
    const frameHash = await createEntityFrameHash(
      'genesis',
      1,
      env.timestamp,
      frameTxs,
      honestNewState,
    );
    const hashesToSign = buildEntityHashesToSign(entityId, 1, frameHash, collectedHashes);
    const stateRoot = computeCanonicalEntityConsensusStateHash(honestNewState);
    const authorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(honestNewState));
    const frameSignatures = hashesToSign.map(({ hash }) => signAccountFrame(env, signerId, hash));
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
        parentFrameHash: 'genesis',
        stateRoot,
        authorityRoot,
        timestamp: env.timestamp,
        txs: frameTxs,
        hash: frameHash,
        leader: { proposerSignerId: signerId, view: 0 },
        hashesToSign,
        collectedSigs: new Map([[signerId, frameSignatures]]),
      },
    });
    expect(result.workingReplica.state.height).toBe(1);
    expect(result.workingReplica.state.profile.name).toBe('Signed Profile');
  });

  test('entity validator signs only the secondary hash manifest emitted by local replay', async () => {
    const seed = 'entity-validator-local-secondary-manifest seed alpha beta gamma';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.timestamp = 42_500;
    const first = registerLazySigner(seed, '1');
    const second = registerLazySigner(seed, '2');
    const entityId = generateLazyEntityId([first.signerId, second.signerId], 2n).toLowerCase();
    const config: ConsensusConfig = {
      ...makeSingleSignerConfigFor(first.signerId),
      threshold: 2n,
      validators: [first.signerId, second.signerId],
      shares: { [first.signerId]: 1n, [second.signerId]: 1n },
    };
    const collectiveTxs: EntityTx[] = [{
      type: 'profile-update',
      data: { profile: { entityId, name: 'Manifest Bound' } },
    } as any];
    const baseState = makeEntityState(entityId);
    baseState.config = config;
    const frameTxs = await buildQuorumAuthorizedFrameTxs(env, baseState, collectiveTxs);
    const { newState: replayedState, collectedHashes = [] } = await applyEntityFrame(
      env,
      baseState,
      frameTxs,
      env.timestamp,
    );
    const leaderState = { activeValidatorId: first.signerId, view: 0, changedAtHeight: 0 };
    const frameHash = await createEntityFrameHash(
      'genesis',
      1,
      env.timestamp,
      frameTxs,
      { ...replayedState, entityId, height: 1, timestamp: env.timestamp, leaderState },
    );
    const localManifest = buildEntityHashesToSign(entityId, 1, frameHash, collectedHashes);
    const stateRoot = computeCanonicalEntityConsensusStateHash({
      ...replayedState,
      entityId,
      height: 1,
      timestamp: env.timestamp,
      leaderState,
    });
    const authorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority({
      ...replayedState,
      entityId,
      height: 1,
      timestamp: env.timestamp,
      leaderState,
    }));
    const attackerHash = ethers.keccak256(ethers.toUtf8Bytes('attacker-selected-dispute-hash'));
    const validatorReplica: EntityReplica = {
      entityId,
      signerId: second.signerId,
      mempool: [],
      isProposer: false,
      state: baseState,
    };

    const invalidFrameHashResult = await applyEntityInput(env, validatorReplica, {
      entityId,
      signerId: second.signerId,
      proposedFrame: {
        height: 1,
        parentFrameHash: 'genesis',
        stateRoot,
        authorityRoot,
        timestamp: env.timestamp,
        txs: frameTxs,
        hash: ethers.keccak256(ethers.toUtf8Bytes('proposer-selected-invalid-frame-hash')),
        leader: { proposerSignerId: first.signerId, view: 0 },
        hashesToSign: localManifest,
      },
    });
    expect(invalidFrameHashResult.outcome).toEqual({
      kind: 'rejected',
      code: 'PROPOSAL_FRAME_HASH_MISMATCH',
    });
    expect(invalidFrameHashResult.outputs).toEqual([]);
    expect(invalidFrameHashResult.workingReplica.lockedFrame).toBeUndefined();

    const forgedProposalResult = await applyEntityInput(env, validatorReplica, {
      entityId,
      signerId: second.signerId,
      proposedFrame: {
        height: 1,
        timestamp: env.timestamp,
        txs: frameTxs,
        hash: frameHash,
        leader: { proposerSignerId: first.signerId, view: 0 },
        hashesToSign: [
          ...localManifest,
          { hash: attackerHash, type: 'dispute', context: 'attacker-selected' },
        ],
      },
    });

    expect(forgedProposalResult.outcome.kind).toBe('rejected');
    expect(forgedProposalResult.outputs).toEqual([]);
    expect(forgedProposalResult.workingReplica.lockedFrame).toBeUndefined();

    const honestProposal = {
      height: 1,
      parentFrameHash: 'genesis',
      stateRoot,
      authorityRoot,
      timestamp: env.timestamp,
      txs: frameTxs,
      hash: frameHash,
      leader: { proposerSignerId: first.signerId, view: 0 },
      hashesToSign: localManifest,
    };
    const precommitResult = await applyEntityInput(env, validatorReplica, {
      entityId,
      signerId: second.signerId,
      proposedFrame: honestProposal,
    });
    expect(precommitResult.workingReplica.lockedFrame?.hash).toBe(frameHash);

    const signaturesBySigner = new Map([
      [first.signerId, localManifest.map(({ hash }) => signAccountFrame(env, first.signerId, hash))],
      [second.signerId, localManifest.map(({ hash }) => signAccountFrame(env, second.signerId, hash))],
    ]);
    const relabeledManifest = localManifest.map((entry, index) => index === 0
      ? { ...entry, type: 'accountFrame' as const, context: 'relabeled-after-precommit' }
      : entry);
    const mutatedCommitResult = await applyEntityInput(env, precommitResult.workingReplica, {
      entityId,
      signerId: second.signerId,
      proposedFrame: {
        ...honestProposal,
        hashesToSign: relabeledManifest,
        collectedSigs: signaturesBySigner,
      },
    });

    expect(mutatedCommitResult.outcome.kind).toBe('rejected');
    expect(mutatedCommitResult.workingReplica.state.height).toBe(0);

    env.runtimeId = `0x${'71'.repeat(20)}`;
    env.runtimeState ??= {};
    env.runtimeState.entityRuntimeHints = new Map();
    env.eReplicas.set(`${entityId}:${second.signerId}`, precommitResult.workingReplica);
    const remoteEntityId = `0x${'72'.repeat(32)}`;
    const lockedMempoolSize = precommitResult.workingReplica.mempool.length;
    const mergedResult = await applyMergedEntityInputs(env, [{
      from: `0x${'73'.repeat(20)}`,
      entityId,
      signerId: second.signerId,
      entityTxs: [{
        type: 'accountInput',
        data: { fromEntityId: remoteEntityId, toEntityId: entityId },
      } as never],
      proposedFrame: {
        ...honestProposal,
        hash: ethers.keccak256(ethers.toUtf8Bytes('commit-does-not-match-validator-lock')),
        collectedSigs: signaturesBySigner,
      },
    }], [], {
      isReplay: false,
      routingDeps: {
        ensureRuntimeState: (targetEnv) => targetEnv.runtimeState!,
        enqueueRuntimeInputs: () => {},
        extractEntityId: (replicaKey) => replicaKey.split(':')[0] ?? '',
        hasLocalSignerForEntity: () => true,
        hasLocalSignerForEntitySigner: () => true,
        resolveSoleLocalSignerForEntity: () => second.signerId,
        getP2P: () => null,
      },
    });

    expect(mergedResult.appliedEntityInputs).toEqual([]);
    expect(env.eReplicas.get(`${entityId}:${second.signerId}`)?.mempool).toHaveLength(lockedMempoolSize);
    expect(env.runtimeState.entityRuntimeHints.has(remoteEntityId)).toBe(false);
  });

  test('entity catch-up commit rejects a secondary hash not emitted by local replay', async () => {
    const seed = 'entity-commit-secondary-signature-binding seed alpha beta gamma';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.timestamp = 43_000;
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const collectiveTxs: EntityTx[] = [{
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
    const frameTxs = await buildQuorumAuthorizedFrameTxs(env, honestBaseState, collectiveTxs);
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
    const frameSig = signAccountFrame(env, signerId, frameHash);
    const secondarySig = signAccountFrame(env, signerId, secondaryHash);
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
        timestamp: env.timestamp,
        txs: frameTxs,
        hash: frameHash,
        leader: { proposerSignerId: signerId, view: 0 },
        hashesToSign: [
          { hash: frameHash, type: 'entityFrame', context: 'entity-frame' },
          { hash: secondaryHash, type: 'accountFrame', context: 'account-frame' },
        ],
        collectedSigs: new Map([[signerId, [frameSig, secondarySig]]]),
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
    env.timestamp = 1_000;
    env.browserVM = {
      getDepositoryAddress: () => hex20('dd'),
    } as typeof env.browserVM;

    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    const mempool = Array.from({ length: MAX_ACCOUNT_FRAME_TXS }, () => ({
      type: 'add_delta' as const,
      // Exercise the 1000-tx frame cap without manufacturing a ProofBody that
      // the jurisdiction rejects (>128 distinct token rows). add_delta is
      // intentionally idempotent, so every tx still replays deterministically.
      data: { tokenId: 1 },
    }));
    const accountMachine = makeProposalAccount(mempool, left.entityId, right.entityId);
    attachSigningReplica(env, accountMachine.proofHeader.fromEntity, left.signerId);

    const result = await proposeAccountFrame(env, accountMachine, env.timestamp);

    expect(result.success).toBe(true);
    expect(result.accountInput?.proposal.frame.accountTxs).toHaveLength(MAX_ACCOUNT_FRAME_TXS);
    expect(accountMachine.pendingFrame?.accountTxs).toHaveLength(MAX_ACCOUNT_FRAME_TXS);
    expect(accountMachine.mempool).toHaveLength(0);
  });

  test('proposeAccountFrame bundles the last outbound ACK into the next frame for loss recovery', async () => {
    const seed = 'account-frame-ack-loss-recovery';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.timestamp = 1_000;
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
      response: {
        kind: 'ack',
        fromEntityId: left.entityId,
        toEntityId: right.entityId,
        ack: {
          height: 10,
          frameHash: accountMachine.currentFrame.stateHash,
          frameHanko: `0x${'cd'.repeat(65)}`,
        },
      },
    };
    attachSigningReplica(env, accountMachine.proofHeader.fromEntity, left.signerId);

    const result = await proposeAccountFrame(env, accountMachine, env.timestamp);

    expect(result.success).toBe(true);
    expect(result.accountInput?.kind).toBe('frame_ack');
    expect(result.accountInput?.kind === 'frame_ack' ? result.accountInput.ack.height : undefined).toBe(10);
    expect(result.accountInput?.kind === 'frame_ack' ? result.accountInput.ack.frameHanko : undefined)
      .toBe(accountMachine.lastOutboundFrameAck?.response.ack.frameHanko);
    expect(result.accountInput?.proposal.frame.height).toBe(11);
    expect(accountMachine.pendingAccountInput?.kind).toBe('frame_ack');
  });

  test('credit-limit-only frame reuses unchanged on-chain dispute proof', async () => {
    const seed = 'account-credit-limit-reuses-proof';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.timestamp = 1_000;
    env.browserVM = { getDepositoryAddress: () => hex20('dd') } as typeof env.browserVM;
    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    const accountMachine = makeProposalAccount([
      { type: 'set_credit_limit', data: { tokenId: 1, amount: 100n } },
    ], left.entityId, right.entityId);
    accountMachine.deltas.set(1, createDefaultDelta(1));
    accountMachine.currentDisputeProofBodyHash = buildAccountProofBody(accountMachine, '').proofBodyHash;
    accountMachine.currentDisputeProofNonce = 1;
    accountMachine.jNonce = 0;
    accountMachine.currentDisputeHash = createDisputeProofHashWithNonce(
      accountMachine,
      accountMachine.currentDisputeProofBodyHash,
      { chainId: 31337, depositoryAddress: hex20('dd') },
      1,
    );
    accountMachine.currentDisputeProofHanko = '0xcafe';
    const nonceBefore = accountMachine.proofHeader.nextProofNonce;
    attachSigningReplica(env, left.entityId, left.signerId);

    const result = await proposeAccountFrame(env, accountMachine, env.timestamp);

    expect(result.success).toBe(true);
    expect(result.accountInput?.kind === 'frame' ? result.accountInput.proposal.disputeSeal : undefined).toEqual({
      hanko: '0xcafe',
      hash: accountMachine.currentDisputeHash,
      proofBodyHash: accountMachine.currentDisputeProofBodyHash,
      proofNonce: 1,
    });
    expect(accountMachine.proofHeader.nextProofNonce).toBe(nonceBefore);
  });

  test('consumed dispute proof nonce opens a fresh persisted evidence epoch', async () => {
    const seed = 'account-consumed-proof-opens-evidence-epoch';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.timestamp = 1_000;
    env.browserVM = { getDepositoryAddress: () => hex20('dd') } as typeof env.browserVM;
    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    const accountMachine = makeProposalAccount([
      { type: 'set_credit_limit', data: { tokenId: 1, amount: 100n } },
    ], left.entityId, right.entityId);
    accountMachine.deltas.set(1, createDefaultDelta(1));
    const proof = buildAccountProofBody(accountMachine, '');
    accountMachine.currentDisputeProofBodyHash = proof.proofBodyHash;
    accountMachine.currentDisputeProofNonce = 7;
    accountMachine.jNonce = 8;
    accountMachine.disputeProofBodiesByHash = undefined;
    accountMachine.disputeProofNoncesByHash = undefined;
    accountMachine.disputeArgumentSnapshotsByHash = undefined;
    attachSigningReplica(env, left.entityId, left.signerId);

    const result = await proposeAccountFrame(env, accountMachine, env.timestamp);

    expect(result.success).toBe(true);
    expect(result.accountInput?.kind === 'frame' ? result.accountInput.proposal.disputeSeal : undefined)
      .toMatchObject({ proofBodyHash: proof.proofBodyHash, proofNonce: 9 });
    expect(Object.keys(accountMachine.disputeProofBodiesByHash ?? {})).toEqual([proof.proofBodyHash]);
    expect(accountMachine.disputeProofNoncesByHash).toEqual({ [proof.proofBodyHash]: 9 });
    expect(Object.keys(accountMachine.disputeArgumentSnapshotsByHash ?? {})).toEqual([proof.proofBodyHash]);
    const persisted = hydrateAccountDocFromStorage(structuredClone(projectAccountDoc(accountMachine)));
    expect(Object.keys(persisted.disputeProofBodiesByHash ?? {})).toEqual([proof.proofBodyHash]);
    expect(persisted.disputeProofNoncesByHash).toEqual({ [proof.proofBodyHash]: 9 });
    expect(Object.keys(persisted.disputeArgumentSnapshotsByHash ?? {})).toEqual([proof.proofBodyHash]);
  });

  test('account frame property matrix preserves explicit zero jHeight through receive, replay, and ACK commit', async () => {
    const propertyCases = [1, 10, 100].flatMap(accountHeight =>
      [3, 11, 101].flatMap(finalizedJHeight =>
        [1, 2, 11].map(revealBeforeHeight => ({ accountHeight, finalizedJHeight, revealBeforeHeight })),
      ),
    );
    for (const { accountHeight, finalizedJHeight, revealBeforeHeight } of propertyCases) {
      const seed = `account-frame-zero-jheight-${accountHeight}-${finalizedJHeight}-${revealBeforeHeight}`;
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

      const makeFundedDelta = () => ({
        ...createDefaultDelta(1),
        leftCreditLimit: 10n,
      });
      const lockId = `zero-jheight-lock-${accountHeight}-${revealBeforeHeight}`;
      const htlcTx: AccountTx = {
        type: 'htlc_lock',
        data: {
          lockId,
          hashlock: `0x${'31'.repeat(32)}`,
          timelock: BigInt(env.timestamp + 60_000),
          revealBeforeHeight,
          amount: 1n,
          tokenId: 1,
        },
      };
      const previousStateHash = `0x${'ab'.repeat(32)}`;
      const proposerAccount = makeProposalAccount([htlcTx], left.entityId, right.entityId);
      proposerAccount.lastFinalizedJHeight = finalizedJHeight;
      proposerAccount.currentHeight = accountHeight;
      proposerAccount.currentFrame = {
        ...proposerAccount.currentFrame,
        height: accountHeight,
        timestamp: env.timestamp - 1,
        stateHash: previousStateHash,
      };
      proposerAccount.deltas.set(1, makeFundedDelta());

      const proposed = await proposeAccountFrame(env, proposerAccount, env.timestamp, 0);
      if (!proposed.success) throw new Error(`ZERO_JHEIGHT_PROPOSAL_FAILED:${proposed.error}`);
      expect(proposed.success).toBe(true);
      expect(proposed.accountInput?.proposal.frame.jHeight).toBe(0);

      const receiverAccount = makeProposalAccount([], left.entityId, right.entityId);
      receiverAccount.proofHeader = { fromEntity: right.entityId, toEntity: left.entityId, nextProofNonce: 0 };
      receiverAccount.lastFinalizedJHeight = finalizedJHeight;
      receiverAccount.currentHeight = accountHeight;
      receiverAccount.currentFrame = {
        ...receiverAccount.currentFrame,
        height: accountHeight,
        timestamp: env.timestamp - 1,
        stateHash: previousStateHash,
      };
      receiverAccount.deltas.set(1, makeFundedDelta());
      const replayedReceiverAccount = hydrateAccountDocFromStorage(structuredClone(projectAccountDoc(receiverAccount)));

      const result = await applyAccountInput(env, receiverAccount, proposed.accountInput!);
      const replayResult = await applyAccountInput(env, replayedReceiverAccount, proposed.accountInput!);

      expect(result.success).toBe(true);
      if (!replayResult.success) throw new Error(`ZERO_JHEIGHT_REPLAY_FAILED:${replayResult.error}`);
      expect(replayResult.success).toBe(true);
      expect(receiverAccount.currentHeight).toBe(accountHeight + 1);
      expect(receiverAccount.currentFrame.jHeight).toBe(0);
      expect(receiverAccount.locks.has(lockId)).toBe(true);
      expect(safeStringify(projectAccountDoc(replayedReceiverAccount))).toBe(
        safeStringify(projectAccountDoc(receiverAccount)),
      );
      expect(replayResult.response).toEqual(result.response);

      if (!result.response) throw new Error('ZERO_JHEIGHT_ACK_MISSING');
      if (accountHeight === 1 && finalizedJHeight === 3 && revealBeforeHeight === 1) {
        const tamperedResponse = structuredClone(result.response);
        if (tamperedResponse.kind !== 'ack' && tamperedResponse.kind !== 'frame_ack') {
          throw new Error('ZERO_JHEIGHT_ACK_KIND_INVALID');
        }
        tamperedResponse.ack.frameHash = `0x${'ff'.repeat(32)}`;
        const tamperedResult = await applyAccountInput(
          env,
          structuredClone(proposerAccount),
          tamperedResponse,
        );
        expect(tamperedResult.success).toBe(false);
        expect(tamperedResult.error).toContain('ACK frameHash mismatch');
      }
      const ackResult = await applyAccountInput(env, proposerAccount, result.response);
      expect(ackResult.success).toBe(true);
      expect(proposerAccount.currentHeight).toBe(accountHeight + 1);
      expect(proposerAccount.currentFrame.jHeight).toBe(0);
      expect(proposerAccount.currentFrame.stateHash).toBe(receiverAccount.currentFrame.stateHash);
      expect(proposerAccount.locks.has(lockId)).toBe(true);
    }
  });

  test('account storage keeps last outbound ACK so restored runtimes can bundle the next frame', () => {
    const accountMachine = makeProposalAccount([], hex20('11'), hex20('22'));
    accountMachine.lastOutboundFrameAck = {
      height: 8,
      counterpartyEntityId: hex20('22'),
      response: {
        kind: 'ack',
        fromEntityId: hex20('11'),
        toEntityId: hex20('22'),
        ack: { height: 8, frameHash: `0x${'08'.repeat(32)}`, frameHanko: `0x${'aa'.repeat(65)}` },
      },
    };
    accountMachine.hankoSignature = `0x${'bb'.repeat(65)}`;
    accountMachine.pendingForwards = [{
      route: [hex20('33'), hex20('44')],
      tokenId: 1,
      amount: 123n,
      description: 'pending-forward-storage',
    }];

    const doc = projectAccountDoc(accountMachine);

    expect(doc.lastOutboundFrameAck).toEqual(accountMachine.lastOutboundFrameAck);
    expect(doc.hankoSignature).toBe(accountMachine.hankoSignature);
    expect(doc.pendingForwards).toEqual(accountMachine.pendingForwards);
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
      accountStateRoot: `0x${'00'.repeat(32)}`,
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
      ack: { height: 10, frameHash: pendingFrame.prevFrameHash, frameHanko: `0x${'12'.repeat(65)}` },
      proposal: { frame: pendingFrame, frameHanko: `0x${'34'.repeat(65)}` },
    };
    accountMachine.pendingAccountInputSignerId = counterpartySignerId;
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

  test('crontab rolls back a pending HTLC exactly at its timelock boundary', async () => {
    const env = createEmptyEnv('pending-htlc-exact-timelock');
    env.quietRuntimeLogs = true;
    const replica = makeReplicaMissingPrevFrameHash();
    replica.state.timestamp = 100_000;
    const counterpartyId = hex20('22');
    const accountMachine = makeProposalAccount([], replica.entityId, counterpartyId);
    accountMachine.pendingFrame = {
      height: 11,
      timestamp: 90_000,
      jHeight: 0,
      accountTxs: [{
        type: 'htlc_lock',
        data: {
          lockId: `0x${'45'.repeat(32)}`,
          hashlock: `0x${'46'.repeat(32)}`,
          timelock: 100_000n,
          revealBeforeHeight: 100,
          amount: 1n,
          tokenId: 1,
        },
      }],
      prevFrameHash: `0x${'ab'.repeat(32)}`,
      accountStateRoot: `0x${'00'.repeat(32)}`,
      deltas: [],
      stateHash: `0x${'cd'.repeat(32)}`,
      byLeft: true,
    };
    replica.state.accounts.set(counterpartyId, accountMachine);
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const outputs = await executeCrontab(env, replica, replica.state.crontabState!, {
        manualBroadcastInInput: false,
      });
      const rollback = outputs.flatMap(output => output.entityTxs ?? [])
        .find(tx => tx.type === 'rollbackTimedOutFrames');
      expect(rollback).toEqual({
        type: 'rollbackTimedOutFrames',
        data: { timedOutAccounts: [{ counterpartyId, frameHeight: 11 }] },
      });
    } finally {
      warning.mockRestore();
    }
  });

  test('restored Account resolves its counterparty proposer from the certified frame Hanko without gossip', async () => {
    const counterpartySeed = 'account-certified-counterparty-route';
    const counterpartySignerId = deriveSignerAddressSync(counterpartySeed, '1').toLowerCase();
    const counterpartyId = generateLazyEntityId([counterpartySignerId], 1n).toLowerCase();
    const localEntityId = `0x${'24'.repeat(32)}`;
    const account = makeProposalAccount([], localEntityId, counterpartyId);
    const frameHash = `0x${'bc'.repeat(32)}`;
    account.currentHeight = 1;
    account.currentFrame = {
      ...account.currentFrame,
      height: 1,
      stateHash: frameHash,
      accountStateRoot: frameHash,
    };
    account.counterpartyFrameHanko = signedHankoForTest(
      frameHash,
      [deriveSignerKeySync(counterpartySeed, '1')],
      [],
      [[counterpartyId, [0n], [1n], 1n]],
    );
    const env = createEmptyEnv('account-certified-counterparty-route-local');

    expect(() => resolveEntityProposerId(env, counterpartyId, 'legacy-gossip-route')).toThrow(
      'SIGNER_RESOLUTION_FAILED',
    );
    expect(await resolveCertifiedAccountCounterpartyProposer(env, account, counterpartyId)).toBe(
      counterpartySignerId,
    );
  });

  test('crontab resends a restored pending frame from its durable exact signer route', async () => {
    const env = createEmptyEnv('account-frame-restored-resend');
    env.quietRuntimeLogs = true;
    const replica = makeReplicaMissingPrevFrameHash();
    replica.state.timestamp = 100_000;
    const counterpartyId = `0x${'25'.repeat(32)}`;
    const counterpartySignerId = hex20('26');
    const pendingFrame = {
      height: 11,
      timestamp: replica.state.timestamp - ACCOUNT_PENDING_RESEND_AFTER_MS - 1,
      jHeight: 0,
      accountTxs: [{ type: 'add_delta' as const, data: { tokenId: 1 } }],
      prevFrameHash: `0x${'ab'.repeat(32)}`,
      accountStateRoot: `0x${'00'.repeat(32)}`,
      deltas: [],
      stateHash: `0x${'cd'.repeat(32)}`,
      byLeft: true,
    };
    const accountMachine = makeProposalAccount([], replica.entityId, counterpartyId);
    accountMachine.pendingFrame = pendingFrame;
    accountMachine.pendingAccountInput = {
      kind: 'frame',
      fromEntityId: replica.entityId,
      toEntityId: counterpartyId,
      domain: structuredClone(accountMachine.domain),
      proposal: { frame: pendingFrame, frameHanko: `0x${'34'.repeat(65)}` },
    };
    accountMachine.pendingAccountInputSignerId = counterpartySignerId;
    const persistedAccount = projectAccountDoc(accountMachine);
    const restoredAccount = hydrateAccountDocFromStorage(decodeValidatedBuffer(
      encodeBuffer(persistedAccount),
      validateStorageAccountDocValue,
    ));
    const corruptFrameBinding = projectAccountDoc(accountMachine);
    if (!corruptFrameBinding.pendingAccountInput || corruptFrameBinding.pendingAccountInput.kind !== 'frame') {
      throw new Error('TEST_PENDING_ACCOUNT_INPUT_REQUIRED');
    }
    corruptFrameBinding.pendingAccountInput.proposal.frame.stateHash = `0x${'ff'.repeat(32)}`;
    expect(() => decodeValidatedBuffer(
      encodeBuffer(corruptFrameBinding),
      validateStorageAccountDocValue,
    )).toThrow('pendingAccountInput proposal must exactly match pendingFrame');
    const corruptEndpointBinding = projectAccountDoc(accountMachine);
    if (!corruptEndpointBinding.pendingAccountInput) throw new Error('TEST_PENDING_ACCOUNT_INPUT_REQUIRED');
    corruptEndpointBinding.pendingAccountInput.fromEntityId = `0x${'ee'.repeat(32)}`;
    expect(() => decodeValidatedBuffer(
      encodeBuffer(corruptEndpointBinding),
      validateStorageAccountDocValue,
    )).toThrow('pendingAccountInput endpoints must match proofHeader');
    const corruptDomainBinding = projectAccountDoc(accountMachine);
    if (!corruptDomainBinding.pendingAccountInput) throw new Error('TEST_PENDING_ACCOUNT_INPUT_REQUIRED');
    corruptDomainBinding.pendingAccountInput.domain = {
      ...corruptDomainBinding.pendingAccountInput.domain,
      chainId: 1,
    };
    expect(() => decodeValidatedBuffer(
      encodeBuffer(corruptDomainBinding),
      validateStorageAccountDocValue,
    )).toThrow('pendingAccountInput domain must match Account domain');
    replica.state.accounts.set(counterpartyId, restoredAccount);
    const rootBeforeRouteChange = computeCanonicalEntityConsensusStateHash(replica.state);
    restoredAccount.pendingAccountInputSignerId = hex20('27');
    expect(computeCanonicalEntityConsensusStateHash(replica.state)).toBe(rootBeforeRouteChange);
    restoredAccount.pendingAccountInputSignerId = counterpartySignerId;

    const outputs = await executeCrontab(env, replica, replica.state.crontabState!, {
      manualBroadcastInInput: false,
    });

    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.entityId).toBe(counterpartyId);
    expect(outputs[0]?.signerId).toBe(counterpartySignerId);
    expect(outputs[0]?.entityTxs).toEqual([
      { type: 'accountInput', data: restoredAccount.pendingAccountInput },
    ]);
  });

  test('pending-frame liveness warning is evaluated from committed post-frame state', () => {
    const replica = makeReplicaMissingPrevFrameHash();
    replica.state.timestamp = 100_000;
    const counterpartyId = hex20('24');
    const account = makeProposalAccount([], replica.entityId, counterpartyId);
    account.pendingFrame = {
      height: 11,
      timestamp: replica.state.timestamp - ACCOUNT_TIMEOUT_MS - 1,
      jHeight: 0,
      accountTxs: [{ type: 'add_delta', data: { tokenId: 1 } }],
      prevFrameHash: `0x${'ab'.repeat(32)}`,
      accountStateRoot: `0x${'00'.repeat(32)}`,
      deltas: [],
      stateHash: `0x${'cd'.repeat(32)}`,
      byLeft: true,
    };
    replica.state.accounts.set(counterpartyId, account);
    const previousState = structuredClone(replica.state);
    const committedPending = structuredClone(replica.state);
    committedPending.crontabState!.tasks.get('checkAccountTimeouts')!.lastRun = committedPending.timestamp;
    const committedAcked = structuredClone(committedPending);
    delete committedAcked.accounts.get(counterpartyId)!.pendingFrame;
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      emitCommittedPendingFrameWarnings(previousState, committedPending);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('PENDING-FRAME-STALE'));
      warning.mockClear();

      emitCommittedPendingFrameWarnings(previousState, committedAcked);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  test('applyAccountInput re-acks duplicate committed frames when the original ACK was lost', async () => {
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
      response: {
        kind: 'ack',
        fromEntityId: left.entityId,
        toEntityId: right.entityId,
        ack: {
          height: 10,
          frameHash: accountMachine.currentFrame.stateHash,
          frameHanko: `0x${'12'.repeat(65)}`,
          disputeSeal: {
            hanko: `0x${'13'.repeat(65)}`,
            hash: `0x${'14'.repeat(32)}`,
            proofBodyHash: `0x${'15'.repeat(32)}`,
            proofNonce: 7,
          },
        },
      },
    };

    const result = await applyAccountInput(env, accountMachine, {
      kind: 'frame',
      fromEntityId: right.entityId,
      toEntityId: left.entityId,
      signerId: right.signerId,
      proposal: {
        frame: {
          ...accountMachine.currentFrame,
          prevFrameHash: `0x${'34'.repeat(32)}`,
        },
        frameHanko: `0x${'56'.repeat(65)}`,
      },
    });

    expect(result.success).toBe(true);
    expect(result.response?.kind).toBe('ack');
    expect(result.response?.kind === 'ack' ? result.response.ack.height : undefined).toBe(10);
    expect(result.response).toEqual(accountMachine.lastOutboundFrameAck.response);
  });

  test('Entity flush batches ACK and successor without mutating live Entity replicas', async () => {
    const seed = 'account-frame-bundled-proposal-lost';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.timestamp = 10_000;
    env.browserVM = { getDepositoryAddress: () => hex20('dd') } as typeof env.browserVM;

    const first = registerLazySigner(seed, '1');
    const second = registerLazySigner(seed, '2');
    const left = isLeftEntity(first.entityId, second.entityId) ? first : second;
    const right = left === first ? second : first;
    attachSigningReplica(env, left.entityId, left.signerId);
    attachSigningReplica(env, right.entityId, right.signerId);
    const liveHubTasks = [left, right].map(({ entityId, signerId }) => {
      const task = env.eReplicas.get(`${entityId}:${signerId}`)?.state.crontabState?.tasks.get('hubRebalance');
      if (!task) throw new Error(`TEST_HUB_REBALANCE_TASK_MISSING:${entityId}`);
      task.lastRun = 500;
      return task;
    });

    const proposer = makeProposalAccount([
      { type: 'add_delta', data: { tokenId: 1 } },
    ], left.entityId, right.entityId);
    const receiver = makeProposalAccount([
      { type: 'add_delta', data: { tokenId: 2 } },
    ], left.entityId, right.entityId);
    receiver.proofHeader = { fromEntity: right.entityId, toEntity: left.entityId, nextProofNonce: 0 };

    const proposed = await proposeAccountFrame(env, proposer, env.timestamp);
    if (!proposed.success || !proposed.accountInput) {
      throw new Error(`BUNDLED_ACK_SOURCE_PROPOSAL_FAILED:${proposed.error ?? 'missing input'}`);
    }
    const accepted = await applyAccountInput(env, receiver, proposed.accountInput);

    expect(accepted.success).toBe(true);
    expect(accepted.response?.kind).toBe('ack');
    expect(receiver.currentHeight).toBe(1);
    expect(receiver.pendingFrame).toBeUndefined();
    expect(receiver.lastOutboundFrameAck?.height).toBe(1);
    expect(liveHubTasks.map(task => task.lastRun)).toEqual([500, 500]);
    const flushed = await proposeAccountFrame(env, receiver, env.timestamp);
    if (!flushed.success || flushed.accountInput?.kind !== 'frame_ack') {
      throw new Error('ENTITY_FLUSHED_ACK_RESPONSE_MISSING');
    }
    const proposalSeal = flushed.accountInput.proposal.disputeSeal;
    const ackSeal = flushed.accountInput.ack.disputeSeal;
    expect(ackSeal).toBeDefined();
    expect(proposalSeal).toBeDefined();
    expect([...(accepted.hashesToSign ?? []), ...(flushed.hashesToSign ?? [])]).toEqual(expect.arrayContaining([
      {
        hash: proposed.accountInput.proposal.frame.stateHash,
        type: 'accountFrame',
        context: `account:${left.entityId.slice(-8)}:ack:1`,
      },
      {
        hash: ackSeal!.hash,
        type: 'dispute',
        context: `account:${left.entityId.slice(-8)}:ack-dispute`,
      },
      {
        hash: flushed.accountInput.proposal.frame.stateHash,
        type: 'accountFrame',
        context: expect.stringContaining(':frame:2'),
      },
      {
        hash: proposalSeal!.hash,
        type: 'dispute',
        context: expect.stringContaining(':dispute'),
      },
    ]));
    expect(new Set(
      [...(accepted.hashesToSign ?? []), ...(flushed.hashesToSign ?? [])].map(({ hash }) => hash),
    ).size).toBe(4);
    const committedBundled = await applyAccountInput(env, proposer, flushed.accountInput);
    expect(committedBundled.success).toBe(true);
    expect(liveHubTasks.map(task => task.lastRun)).toEqual([500, 500]);
    expect(proposer.currentHeight).toBe(2);
    expect(proposer.counterpartyDisputeProofBodyHash).toBe(proposalSeal?.proofBodyHash);
    expect(proposer.counterpartyDisputeProofHanko).toBe(proposalSeal?.hanko);
    const retainedAck = structuredClone(receiver.lastOutboundFrameAck?.response);

    // The new proposal can be discarded independently (for example by the
    // simultaneous-frame tiebreaker). The ACK for committed height 1 remains.
    delete receiver.pendingFrame;
    delete receiver.pendingAccountInput;
    const retried = await applyAccountInput(env, receiver, proposed.accountInput);

    expect(retried.success).toBe(true);
    expect(retried.response).toEqual(retainedAck);
    expect(retried.response?.kind).toBe('ack');
    expect(receiver.currentHeight).toBe(1);
  });

  test('applyAccountInput re-sends bundled ACK plus frame when that response was lost', async () => {
    const seed = 'account-frame-duplicate-bundled-response';
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
    const pendingFrame = {
      ...accountMachine.currentFrame,
      height: 11,
      prevFrameHash: accountMachine.currentFrame.stateHash,
      stateHash: `0x${'ab'.repeat(32)}`,
    };
    accountMachine.pendingFrame = pendingFrame;
    accountMachine.pendingAccountInput = {
      kind: 'frame_ack',
      fromEntityId: left.entityId,
      toEntityId: right.entityId,
      ack: {
        height: 10,
        frameHash: accountMachine.currentFrame.stateHash,
        frameHanko: `0x${'12'.repeat(65)}`,
      },
      proposal: { frame: pendingFrame, frameHanko: `0x${'34'.repeat(65)}` },
    };
    accountMachine.pendingAccountInputSignerId = right.signerId;
    delete accountMachine.lastOutboundFrameAck;

    const result = await applyAccountInput(env, accountMachine, {
      kind: 'frame',
      fromEntityId: right.entityId,
      toEntityId: left.entityId,
      signerId: right.signerId,
      proposal: {
        frame: {
          ...accountMachine.currentFrame,
          prevFrameHash: `0x${'56'.repeat(32)}`,
        },
        frameHanko: `0x${'78'.repeat(65)}`,
      },
    });

    expect(result.success).toBe(true);
    expect(result.response).toEqual(accountMachine.pendingAccountInput);
    expect(result.response?.kind).toBe('frame_ack');
    expect(accountMachine.currentHeight).toBe(10);
    expect(accountMachine.pendingFrame?.height).toBe(11);
  });

  test('applyAccountInput fails loud when the full duplicate ACK cache was lost', async () => {
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

    const result = await applyAccountInput(env, accountMachine, {
      kind: 'frame',
      fromEntityId: right.entityId,
      toEntityId: left.entityId,
      signerId: right.signerId,
      proposal: {
        frame: {
          ...accountMachine.currentFrame,
          prevFrameHash: `0x${'34'.repeat(32)}`,
        },
        frameHanko: `0x${'56'.repeat(65)}`,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('DUPLICATE_ACK_CACHE_MISSING: height=10');
  });

  test('applyAccountInput ignores obsolete ACK after dispute freeze clears pending frame', async () => {
    const seed = 'account-frame-frozen-obsolete-ack';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;

    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    const accountMachine = makeProposalAccount([], left.entityId, right.entityId);
    accountMachine.currentHeight = 8;
    accountMachine.currentFrame = {
      ...accountMachine.currentFrame,
      height: 8,
      stateHash: `0x${'ef'.repeat(32)}`,
    };
    accountMachine.status = 'disputed';
    delete accountMachine.pendingFrame;
    delete accountMachine.pendingAccountInput;

    const result = await applyAccountInput(env, accountMachine, {
      kind: 'ack',
      fromEntityId: right.entityId,
      toEntityId: left.entityId,
      ack: { height: 9, frameHash: `0x${'09'.repeat(32)}`, frameHanko: `0x${'12'.repeat(65)}` },
    });

    expect(result.success).toBe(true);
    expect(result.response).toBeUndefined();
    expect(accountMachine.currentHeight).toBe(8);
    expect(result.events.some((event) => event.includes('Ignored obsolete ACK for frozen account frame 9'))).toBe(true);
  });

  test('applyAccountInput tolerates reordered next ACK before local pending frame install', async () => {
    const seed = 'account-frame-early-next-ack';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;

    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    const accountMachine = makeProposalAccount([], left.entityId, right.entityId);
    accountMachine.currentHeight = 19;
    accountMachine.currentFrame = {
      ...accountMachine.currentFrame,
      height: 19,
      stateHash: `0x${'ef'.repeat(32)}`,
    };
    delete accountMachine.pendingFrame;
    delete accountMachine.pendingAccountInput;

    const result = await applyAccountInput(env, accountMachine, {
      kind: 'ack',
      fromEntityId: right.entityId,
      toEntityId: left.entityId,
      ack: { height: 20, frameHash: `0x${'20'.repeat(32)}`, frameHanko: `0x${'12'.repeat(65)}` },
    });

    expect(result.success).toBe(true);
    expect(result.response).toBeUndefined();
    expect(accountMachine.currentHeight).toBe(19);
    expect(accountMachine.pendingFrame).toBeUndefined();
    expect(result.events).toContain('Ignored early ACK for frame 20 (current=19, pending=none)');
  });

  test('applyAccountInput rejects frames whose byLeft does not match the signed proposer', async () => {
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
    receiverAccount.proofHeader = { fromEntity: right.entityId, toEntity: left.entityId, nextProofNonce: 0 };

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
      accountStateRoot: `0x${'00'.repeat(32)}`,
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

    const result = await applyAccountInput(env, receiverAccount, {
      kind: 'frame',
      fromEntityId: left.entityId,
      toEntityId: right.entityId,
      proposal: { frame: maliciousFrame, frameHanko: newHanko! },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Frame proposer side mismatch');
    expect(receiverAccount.deltas.get(1)?.leftCreditLimit ?? 0n).toBe(0n);
  });

  test('applyAccountInput rejects dispute seal hash mismatch before committing frame', async () => {
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
    receiverAccount.proofHeader = { fromEntity: right.entityId, toEntity: left.entityId, nextProofNonce: 0 };
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
      accountStateRoot: `0x${'00'.repeat(32)}`,
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

    const result = await applyAccountInput(env, receiverAccount, {
      kind: 'frame',
      fromEntityId: left.entityId,
      toEntityId: right.entityId,
      proposal: {
        frame,
        frameHanko: newHanko!,
        disputeSeal: {
          hanko: newDisputeHanko!,
          hash: poisonedHash,
          proofBodyHash: `0x${'11'.repeat(32)}`,
          proofNonce: 0,
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('ACCOUNT_PROPOSAL:DISPUTE_SEAL_HASH_MISMATCH');
    expect(receiverAccount.currentHeight).toBe(0);
    expect(receiverAccount.deltas.get(1)?.leftCreditLimit ?? 0n).toBe(0n);
    expect(receiverAccount.counterpartyDisputeHash).toBeUndefined();
  });

  test('invalid simultaneous proposal cannot roll back the pending frame', async () => {
    const seed = 'invalid-simultaneous-proposal-is-atomic';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.timestamp = 10_000;
    env.browserVM = { getDepositoryAddress: () => hex20('dd') } as typeof env.browserVM;

    const first = registerLazySigner(seed, '1');
    const second = registerLazySigner(seed, '2');
    const left = isLeftEntity(first.entityId, second.entityId) ? first : second;
    const right = left === first ? second : first;
    attachSigningReplica(env, left.entityId, left.signerId);
    attachSigningReplica(env, right.entityId, right.signerId);

    const leftAccount = makeProposalAccount(
      [{ type: 'add_delta', data: { tokenId: 1 } }],
      left.entityId,
      right.entityId,
    );
    const rightAccount = makeProposalAccount(
      [{ type: 'add_delta', data: { tokenId: 2 } }],
      left.entityId,
      right.entityId,
    );
    rightAccount.proofHeader = {
      fromEntity: right.entityId,
      toEntity: left.entityId,
      nextProofNonce: 0,
    };

    const leftProposal = await proposeAccountFrame(env, leftAccount, env.timestamp);
    const rightProposal = await proposeAccountFrame(env, rightAccount, env.timestamp);
    if (!leftProposal.success || !leftProposal.accountInput || leftProposal.accountInput.kind !== 'frame') {
      throw new Error(`LEFT_SIMULTANEOUS_PROPOSAL_FAILED:${leftProposal.error ?? 'missing frame'}`);
    }
    if (!rightProposal.success || !rightProposal.accountInput || rightProposal.accountInput.kind !== 'frame') {
      throw new Error(`RIGHT_SIMULTANEOUS_PROPOSAL_FAILED:${rightProposal.error ?? 'missing frame'}`);
    }

    const invalidInput = structuredClone(leftProposal.accountInput);
    invalidInput.proposal.frameHanko = `0x${'ff'.repeat(65)}`;
    const stateBefore = safeStringify(rightAccount);
    const result = await applyAccountInput(env, rightAccount, invalidInput);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid hanko signature');
    expect(safeStringify(rightAccount)).toBe(stateBefore);

    const accepted = await applyAccountInput(env, rightAccount, leftProposal.accountInput);
    expect(accepted.success).toBe(true);
    expect(rightAccount.currentHeight).toBe(1);
    // Account apply only commits the winning frame and restores the losing
    // intent. The Entity's one final proposableAccounts pass owns creation of
    // the successor frame, so direct apply must not install it early.
    expect(rightAccount.pendingFrame).toBeUndefined();
    expect(rightAccount.mempool).toEqual([
      { type: 'add_delta', data: { tokenId: 2 } },
    ]);
    expect(rightAccount.rollbackCount).toBe(1);
  });

  test('Entity flush re-sends LEFT winning proposal after simultaneous-frame collision', async () => {
    const seed = 'entity-flush-simultaneous-left-winner';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.timestamp = 10_000;
    env.browserVM = { getDepositoryAddress: () => hex20('dd') } as typeof env.browserVM;

    const first = registerLazySigner(seed, '1');
    const second = registerLazySigner(seed, '2');
    const left = isLeftEntity(first.entityId, second.entityId) ? first : second;
    const right = left === first ? second : first;
    attachSigningReplica(env, left.entityId, left.signerId);
    attachSigningReplica(env, right.entityId, right.signerId);

    const leftAccount = makeProposalAccount(
      [{ type: 'add_delta', data: { tokenId: 1 } }],
      left.entityId,
      right.entityId,
    );
    const rightAccount = makeProposalAccount(
      [{ type: 'add_delta', data: { tokenId: 2 } }],
      left.entityId,
      right.entityId,
    );
    rightAccount.proofHeader = {
      fromEntity: right.entityId,
      toEntity: left.entityId,
      nextProofNonce: 0,
    };

    const leftProposal = await proposeAccountFrame(env, leftAccount, env.timestamp);
    const rightProposal = await proposeAccountFrame(env, rightAccount, env.timestamp);
    if (!leftProposal.success || !leftProposal.accountInput) {
      throw new Error(`LEFT_SIMULTANEOUS_PROPOSAL_FAILED:${leftProposal.error ?? 'missing input'}`);
    }
    if (!rightProposal.success || !rightProposal.accountInput) {
      throw new Error(`RIGHT_SIMULTANEOUS_PROPOSAL_FAILED:${rightProposal.error ?? 'missing input'}`);
    }
    leftAccount.pendingAccountInputSignerId = right.signerId;

    const leftState = makeEntityState(left.entityId);
    leftState.config = makeSingleSignerConfigFor(left.signerId);
    leftState.accounts.set(right.entityId, leftAccount);
    const applied = await applyEntityFrame(env, leftState, [{
      type: 'accountInput',
      data: rightProposal.accountInput,
    }], env.timestamp);

    const accountOutputs = applied.outputs.flatMap(output => output.entityTxs ?? [])
      .filter((tx): tx is Extract<EntityTx, { type: 'accountInput' }> => tx.type === 'accountInput');
    expect(accountOutputs).toHaveLength(1);
    expect(accountOutputs[0]?.data).toEqual(leftProposal.accountInput);
    expect(accountOutputs[0]?.data.kind).toBe('frame');
    expect(applied.newState.accounts.get(right.entityId)?.pendingFrame?.stateHash)
      .toBe(leftAccount.pendingFrame?.stateHash);
  });

  test('failed proposal keeps queued txs, including late arrivals, instead of wiping the mempool', async () => {
    const seed = 'account-proposal-failure-retains-mempool';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.timestamp = 1_000;

    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    const firstTx: AccountTx = { type: 'add_delta', data: { tokenId: 1 } };
    const lateTx: AccountTx = { type: 'add_delta', data: { tokenId: 2 } };
    const accountMachine = makeProposalAccount([firstTx], left.entityId, right.entityId);
    attachSigningReplica(env, accountMachine.proofHeader.fromEntity, left.signerId);
    const signingJurisdiction = Array.from(env.jReplicas.values()).find(replica => (
      replica.chainId === accountMachine.domain.chainId
      && replica.contracts?.depository?.toLowerCase() === accountMachine.domain.depositoryAddress.toLowerCase()
    ));
    if (!signingJurisdiction?.contracts) throw new Error('TEST_SIGNING_JURISDICTION_MISSING');
    delete signingJurisdiction.contracts.deltaTransformer;

    queueMicrotask(() => {
      accountMachine.mempool.push(lateTx);
    });

    await expect(proposeAccountFrame(env, accountMachine, env.timestamp))
      .rejects.toThrow('DISPUTE_PROOF_BUILD_FAILED: JURISDICTION_DURABLE_STACK_DELTA_TRANSFORMER_MISSING');
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
    const finalProofbody: ProofBodyStruct = {
      watchSeed: account.watchSeed,
      offdeltas: [50n],
      tokenIds: [1n],
      transformers: [],
    };
    const finalProofbodyHash = hashProofBodyStruct(finalProofbody);
    account.deltas.set(1, {
      tokenId: 1,
      collateral: 100n,
      ondelta: 25n,
      offdelta: 50n,
      leftCreditLimit: 0n,
      rightCreditLimit: 0n,
      leftAllowance: 5n,
      rightAllowance: 7n,
      leftHold: 11n,
      rightHold: 13n,
    });
    account.disputeProofBodiesByHash = {
      [finalProofbodyHash]: finalProofbody,
    };
    account.activeDispute = {
      startedByLeft: true,
      disputeTimeout: 123,
      initialProofbodyHash: finalProofbodyHash,
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
          initialProofbodyHash: finalProofbodyHash,
          finalProofbody,
          starterArguments: '0x',
          otherArguments: '0x',
          sig: '0x',
          startedByLeft: true,
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
            initialProofbodyHash: finalProofbodyHash,
            finalProofbody,
            starterArguments: '0x',
            otherArguments: '0x',
            sig: '0x',
            startedByLeft: true,
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
          initialProofbodyHash: finalProofbodyHash,
        finalProofbodyHash,
      },
    };
    const disputeFinalizationEvidence: DisputeFinalizationEvidence[] = [{
      sender: entityId,
      counterentity: counterpartyId,
      initialNonce: '7',
      finalNonce: '7',
      initialProofbodyHash: finalProofbodyHash,
      finalProofbodyHash,
      leftArguments: '0x',
      rightArguments: '0x',
      starterInitialArguments: '0x',
      starterIncrementedArguments: '0x',
      sig: '0x',
    }];
    const signedDisputeFinalized = prepareJEventInput(env, entityId, '1', {
      blockNumber: 22,
      blockHash: `0x${'99'.repeat(32)}`,
      transactionHash: `0x${'88'.repeat(32)}`,
      events: [disputeFinalizedEvent],
      disputeFinalizationEvidence,
      jurisdictionRef: getJEventJurisdictionRef(state.config.jurisdiction),
    });
    const finalized = await applyJEventRange(state, {
      from: '1',
      observedAt: 2000,
      blockNumber: 22,
      blockHash: `0x${'99'.repeat(32)}`,
      transactionHash: `0x${'88'.repeat(32)}`,
      ...signedDisputeFinalized,
      event: disputeFinalizedEvent,
      disputeFinalizationEvidence,
    }, env);

    expect(finalized.newState.accounts.get(counterpartyId)?.activeDispute).toBeUndefined();
    expect(finalized.newState.jBatchState?.batch.disputeFinalizations.length).toBe(0);
    expect(finalized.newState.jBatchState?.sentBatch?.batch.disputeFinalizations.length).toBe(0);
    const finalizedDelta = finalized.newState.accounts.get(counterpartyId)?.deltas.get(1);
    expect(finalizedDelta?.collateral).toBe(0n);
    expect(finalizedDelta?.ondelta).toBe(0n);
    expect(finalizedDelta?.offdelta).toBe(0n);
    expect(finalizedDelta?.leftAllowance).toBe(0n);
    expect(finalizedDelta?.rightAllowance).toBe(0n);
    expect(finalized.newState.accounts.get(counterpartyId)?.jNonce).toBe(8);

    const failedBatchEvent: JurisdictionEvent = {
      type: 'HankoBatchProcessed',
      data: {
        entityId,
        batchHash: `0x${'78'.repeat(32)}`,
        nonce: 7,
        success: false,
      },
    };
    const signedFailedBatch = prepareJEventInput(env, entityId, '1', {
      blockNumber: 23,
      blockHash: `0x${'77'.repeat(32)}`,
      transactionHash: `0x${'66'.repeat(32)}`,
      events: [failedBatchEvent],
      jurisdictionRef: getJEventJurisdictionRef(finalized.newState.config.jurisdiction),
    });
    const failed = await applyJEventRange(finalized.newState, {
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

  test('DisputeFinalized rejects missing signed final body before mutating account state', async () => {
    const finalProofbody: ProofBodyStruct = {
      watchSeed: `0x${'f1'.repeat(32)}`,
      offdeltas: [50n],
      tokenIds: [1n],
      transformers: [],
    };
    const fixture = makeDisputeFinalizedFixture('dispute-finalized-body-missing', finalProofbody, false);
    fixture.account.deltas.set(1, { ...createDefaultDelta(1), collateral: 100n, offdelta: 50n });
    const stateBefore = safeStringify(fixture.state);

    await expect(applyDisputeFinalizedFixture(fixture)).rejects.toThrow(
      'J_EVENT_DISPUTE_FINAL_PROOFBODY_MISSING',
    );
    expect(safeStringify(fixture.state)).toBe(stateBefore);
  });

  test('DisputeFinalized rejects a stored body whose hash does not match its key', async () => {
    const finalProofbody: ProofBodyStruct = {
      watchSeed: `0x${'f1'.repeat(32)}`,
      offdeltas: [50n],
      tokenIds: [1n],
      transformers: [],
    };
    const fixture = makeDisputeFinalizedFixture('dispute-finalized-body-hash-mismatch', finalProofbody, true);
    fixture.account.disputeProofBodiesByHash![fixture.finalProofbodyHash] = {
      ...finalProofbody,
      offdeltas: [51n],
    };

    await expect(applyDisputeFinalizedFixture(fixture)).rejects.toThrow(
      'J_EVENT_DISPUTE_FINAL_PROOFBODY_HASH_MISMATCH',
    );
  });

  test('DisputeFinalized rejects malformed token/offdelta shape instead of clearing every delta', async () => {
    const malformedProofbody: ProofBodyStruct = {
      watchSeed: `0x${'f1'.repeat(32)}`,
      offdeltas: [],
      tokenIds: [1n],
      transformers: [],
    };
    const fixture = makeDisputeFinalizedFixture('dispute-finalized-body-shape', malformedProofbody, true);
    fixture.account.deltas.set(1, { ...createDefaultDelta(1), collateral: 100n, offdelta: 50n });

    await expect(applyDisputeFinalizedFixture(fixture)).rejects.toThrow(
      'J_DISPUTE_PROOFBODY_LENGTH_MISMATCH',
    );
  });

  test('DisputeFinalized clears only exact proof tokens and retires the consumed evidence epoch', async () => {
    const finalProofbody: ProofBodyStruct = {
      watchSeed: `0x${'f1'.repeat(32)}`,
      offdeltas: [50n],
      tokenIds: [1n],
      transformers: [],
    };
    const fixture = makeDisputeFinalizedFixture('dispute-finalized-exact-token-cleanup', finalProofbody, true);
    const staleHash = `0x${'ab'.repeat(32)}`;
    fixture.account.disputeProofBodiesByHash![staleHash] = makeEmptyProofBody();
    fixture.account.disputeProofNoncesByHash = { [fixture.finalProofbodyHash]: 7, [staleHash]: 6 };
    fixture.account.disputeArgumentSnapshotsByHash = {
      [fixture.finalProofbodyHash]: captureDisputeArgumentSnapshot(
        fixture.account,
        fixture.finalProofbodyHash,
        7,
        finalProofbody,
      ),
      [staleHash]: captureDisputeArgumentSnapshot(fixture.account, staleHash, 6, makeEmptyProofBody()),
    };
    fixture.account.deltas.set(1, { ...createDefaultDelta(1), collateral: 100n, offdelta: 50n });
    fixture.account.deltas.set(2, { ...createDefaultDelta(2), collateral: 200n, offdelta: 75n });

    const finalized = await applyDisputeFinalizedFixture(fixture);
    const account = finalized.newState.accounts.get(fixture.counterpartyId)!;
    expect(account.deltas.get(1)).toMatchObject({ collateral: 0n, ondelta: 0n, offdelta: 0n });
    expect(account.deltas.get(2)).toMatchObject({ collateral: 200n, offdelta: 75n });
    expect(account.disputeProofBodiesByHash).toBeUndefined();
    expect(account.disputeProofNoncesByHash).toBeUndefined();
    expect(account.disputeArgumentSnapshotsByHash).toBeUndefined();
    expect(projectAccountDoc(account).disputeProofBodiesByHash).toBeUndefined();
    expect(projectAccountDoc(account).disputeProofNoncesByHash).toBeUndefined();
    expect(projectAccountDoc(account).disputeArgumentSnapshotsByHash).toBeUndefined();

    const nextProofbody: ProofBodyStruct = { ...finalProofbody, offdeltas: [75n], tokenIds: [2n] };
    const nextHash = hashProofBodyStruct(nextProofbody);
    account.disputeProofBodiesByHash = { [nextHash]: nextProofbody };
    account.disputeProofNoncesByHash = { [nextHash]: 8 };
    storeDisputeArgumentSnapshot(
      account,
      captureDisputeArgumentSnapshot(account, nextHash, 8, nextProofbody),
    );
    const persisted = hydrateAccountDocFromStorage(structuredClone(projectAccountDoc(account)));
    expect(Object.keys(persisted.disputeProofBodiesByHash ?? {})).toEqual([nextHash]);
    expect(Object.keys(persisted.disputeProofNoncesByHash ?? {})).toEqual([nextHash]);
    expect(Object.keys(persisted.disputeArgumentSnapshotsByHash ?? {})).toEqual([nextHash]);
  });

  test('DisputeFinalized invalidates a competing settlement workspace and its deferred retry', async () => {
    const finalProofbody: ProofBodyStruct = {
      watchSeed: `0x${'f2'.repeat(32)}`,
      offdeltas: [50n],
      tokenIds: [1n],
      transformers: [],
    };
    const fixture = makeDisputeFinalizedFixture('dispute-finalized-settlement-race', finalProofbody, true);
    fixture.account.deltas.set(1, {
      ...createDefaultDelta(1),
      collateral: 100n,
      offdelta: 50n,
      leftCreditLimit: 100n,
      rightCreditLimit: 100n,
    });
    const upsertTx: AccountTx = {
      type: 'settle_transition',
      data: {
        kind: 'upsert',
        version: 1,
        ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
        executorIsLeft: true,
      },
    };
    expect((await applyAccountTx(fixture.account, upsertTx, true, 1_000)).success).toBe(true);
    fixture.account.settlementWorkspace!.leftHanko = '0x1234';
    fixture.account.settlementWorkspace!.nonceAtSign = 8;
    fixture.account.settlementWorkspace!.settlementHash = `0x${'81'.repeat(32)}`;
    fixture.account.mempool.push(structuredClone(upsertTx));
    fixture.state.deferredAccountProposals = new Map([
      [fixture.counterpartyId, fixture.account.settlementWorkspace!.workspaceHash],
    ]);
    expect(fixture.account.deltas.get(1)?.leftHold).toBe(4n);

    const finalized = await applyDisputeFinalizedFixture(fixture);
    const account = finalized.newState.accounts.get(fixture.counterpartyId)!;
    expect(account.settlementWorkspace).toBeUndefined();
    expect(account.deltas.get(1)?.leftHold).toBe(0n);
    expect(account.mempool.some((tx) => tx.type === 'settle_transition')).toBe(false);
    expect(finalized.newState.deferredAccountProposals?.has(fixture.counterpartyId)).toBe(false);
  });

  test('disputeFinalize waits for on-chain DisputeStarted before drafting a finalization', async () => {
    const starterId = `0x${'41'.repeat(32)}`;
    const finalizerId = `0x${'42'.repeat(32)}`;
    const state = makeEntityState(finalizerId);
    const account = makeProposalAccount([], starterId, finalizerId);
    const initialProof = buildAccountProofBody(account, '');
    account.disputeProofBodiesByHash = {
      [initialProof.proofBodyHash]: initialProof.proofBodyStruct,
    };
    account.activeDispute = {
      startedByLeft: true,
      initialProofbodyHash: initialProof.proofBodyHash,
      initialNonce: 1,
      disputeTimeout: 100,
      jNonce: 0,
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
    account.domain = { chainId: 31337, depositoryAddress };
    account.proofHeader = { fromEntity: starterId, toEntity: finalizerId, nextProofNonce: 2 };
    account.deltas.set(1, { ...createDefaultDelta(1), offdelta: 50n });

    const initialProof = buildAccountProofBody(account, '');
    storeDisputeArgumentSnapshot(
      account,
      captureDisputeArgumentSnapshot(account, initialProof.proofBodyHash, 1, initialProof.proofBodyStruct),
    );

    account.deltas.set(1, { ...createDefaultDelta(1), offdelta: 75n });
    const counterProof = buildAccountProofBody(account, '');
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
      { chainId: 31337, depositoryAddress },
      2,
    );
    account.activeDispute = {
      startedByLeft: true,
      initialProofbodyHash: initialProof.proofBodyHash,
      initialNonce: 1,
      disputeTimeout: 100,
      jNonce: 0,
      starterInitialArguments: '0x1111',
      starterIncrementedArguments: '0x2222',
      observedOnChain: true,
      finalizeQueued: false,
    };
    state.accounts.set(starterId, account);

    const env = createEmptyEnv('counter-finalize-runtime');
    env.quietRuntimeLogs = true;
    env.lastJBlock = 1;
    env.jReplicas.set('Testnet', {
      name: 'Testnet',
      blockNumber: 1n,
      stateRoot: new Uint8Array(32),
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
      position: { x: 0, y: 0, z: 0 },
      depositoryAddress,
      entityProviderAddress: hex20('2'),
      contracts: {
        account: hex20('3'),
        depository: depositoryAddress,
        entityProvider: hex20('2'),
        deltaTransformer: hex20('4'),
      },
      rpcs: ['http://localhost:8545'],
      chainId: 31337,
    });

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
    expect(finalization?.starterArguments).toBe('0x2222');
    expect(finalization?.otherArguments).toBe('0x');
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
    account.jNonce = 1;
    account.proofHeader = { fromEntity: user.entityId, toEntity: hub.entityId, nextProofNonce: 50 };
    account.deltas.set(1, { ...createDefaultDelta(1), collateral: 10n });

    const transition: AccountTx = {
      type: 'settle_transition',
      data: {
        kind: 'upsert',
        version: 1,
        ops: [{ type: 'c2r', tokenId: 1, amount: 1n }],
        executorIsLeft: true,
      },
    };
    const applied = await applyAccountTx(account, transition, false, 1_000);
    expect(applied.success).toBe(true);
    const result = await processCommittedSettlementTransitionFollowup(
      account,
      transition,
      {
        ...account.currentFrame,
        height: 1,
        timestamp: 1_000,
        accountTxs: [transition],
        byLeft: false,
      },
      hub.entityId,
      userState,
      env,
    );

    expect(result.outputs).toEqual([]);
    expect(result.mempoolOps).toEqual([]);
    expect(userState.deferredAccountProposals?.get(hub.entityId))
      .toBe(account.settlementWorkspace?.workspaceHash);
    expect(buildSettlementSealDraft(account, userState, hub.entityId, env).tx).toMatchObject({
      type: 'settle_transition',
      data: {
        kind: 'seal',
        settlementNonce: 50,
        postProof: { nonce: 51 },
      },
    });
    expect(account.settlementWorkspace?.nonceAtSign).toBeUndefined();
    expect(account.settlementWorkspace?.postSettlementDisputeProof).toBeUndefined();
  });

  test('settlement finalization activates post-settlement dispute hash atomically', () => {
    const leftId = `0x${'31'.repeat(32)}`;
    const rightId = `0x${'32'.repeat(32)}`;
    const depositoryAddress = hex20('1');
    const account = makeProposalAccount([], leftId, rightId);
    account.proofHeader = { fromEntity: leftId, toEntity: rightId, nextProofNonce: 2 };
    account.deltas.set(1, { ...createDefaultDelta(1), offdelta: 50n });

    const postProof = buildAccountProofBody(account, '');
    const postDisputeHash = createDisputeProofHashWithNonce(
      account,
      postProof.proofBodyHash,
      { chainId: 31337, depositoryAddress },
      2,
    );
    account.counterpartyDisputeHash = `0x${'aa'.repeat(32)}`;
    account.settlementWorkspace = {
      workspaceHash: '',
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
    account.settlementWorkspace.workspaceHash = createSettlementWorkspaceHash(
      account,
      account.settlementWorkspace,
    );

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
    applyFinalizedAccountJEvents(account, rightId, [settledEvent], '');
    account.lastFinalizedJHeight = 7;

    expect(account.settlementWorkspace).toBeUndefined();
    expect(account.currentDisputeHash).toBe(postDisputeHash);
    expect(account.counterpartyDisputeHash).toBe(postDisputeHash);
    expect(account.currentDisputeProofBodyHash).toBe(postProof.proofBodyHash);
    expect(account.counterpartyDisputeProofBodyHash).toBe(postProof.proofBodyHash);
    expect(account.disputeProofNoncesByHash?.[postProof.proofBodyHash]).toBe(2);
    expect(account.jNonce).toBe(1);
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
            starterArguments: '0x',
            otherArguments: '0x',
            sig: '0x',
            startedByLeft: true,
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
      broadcastCount: 1,
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
        batchHash: `0x${'22'.repeat(32)}`,
        encodedBatch: '0x1234',
        entityNonce: 9,
        firstSubmittedAt: 1000,
        lastSubmittedAt: 1000,
        submitAttempts: 1,
      },
      entityNonce: 8,
    } as EntityState['jBatchState'];
    const signerId = state.config.validators[0]!;
    const failure = {
      message: 'J_SUBMIT_FATAL: staticCall revert: E3()',
      failedAt: 1001,
      failure: {
        category: 'Contradiction' as const,
        code: 'J_SUBMIT_FATAL',
        message: 'J_SUBMIT_FATAL: staticCall revert: E3()',
        retryable: false,
        fatal: true,
      },
    };
    const replica: EntityReplica = {
      entityId,
      signerId,
      state,
      mempool: [],
      isProposer: true,
      jSubmitState: {
        jurisdictionName: 'Testnet',
        batchHash: state.jBatchState.sentBatch!.batchHash,
        entityNonce: state.jBatchState.sentBatch!.entityNonce,
        batchGeneration: state.jBatchState.broadcastCount,
        submitAttempts: 1,
        lastSubmittedAt: 1000,
        lastFailure: failure,
        terminalFailure: failure,
        lastResultAttemptId: `0x${'33'.repeat(32)}`,
        lastResultAt: 1001,
        lastResultOutcome: 'terminalFailure',
        lastResultFingerprint: 'terminal-result-fingerprint',
      },
    };

    await expect(applyEntityInput(
      createEmptyEnv('j-rebroadcast-terminal-failure'),
      replica,
      { entityId, signerId, entityTxs: [{ type: 'j_rebroadcast', data: {} }] },
    )).rejects.toThrow(/Cannot rebroadcast terminal J-submit/);
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
    account.jNonce = 7;
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
            starterArguments: '0x',
            otherArguments: '0x',
            sig: '0x',
            startedByLeft: true,
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
        batchHash: `0x${'95'.repeat(32)}`,
        nonce: 7,
        success: false,
      },
    };
    const signedFailedBatch = prepareJEventInput(env, entityId, '1', {
      blockNumber: 23,
      blockHash: `0x${'96'.repeat(32)}`,
      transactionHash: `0x${'97'.repeat(32)}`,
      events: [failedBatchEvent],
      jurisdictionRef: getJEventJurisdictionRef(state.config.jurisdiction),
    });
    const failed = await applyJEventRange(state, {
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
    const sourceSigner = deriveSignerAddressSync('cross-book-owner-removal', 'source');
    const targetSigner = deriveSignerAddressSync('cross-book-owner-removal', 'target');
    const sourceUser = `0x${'10'.repeat(32)}`;
    const sourceHub = `0x${'20'.repeat(32)}`;
    const targetHub = `0x${'30'.repeat(32)}`;
    const orderId = 'cross-owner-full-fill';
    const pairId = 'cross:stack:1:0xdep:1/stack:2:0xdep:1';
    const namespacedOrderId = `${sourceUser}:${orderId}`;

    const sourceState = makeEntityState(sourceHub);
    sourceState.config = makeSingleSignerConfigFor(sourceSigner);
    const route: CrossJurisdictionSwapRoute = {
      orderId,
      bookOwnerEntityId: targetHub,
      venueId: pairId,
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      targetHubSignerId: targetSigner,
      bookHubSignerId: targetSigner,
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
    targetState.config = makeSingleSignerConfigFor(targetSigner);
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
    env.eReplicas.set(`${sourceHub}:${sourceSigner}`, {
      entityId: sourceHub,
      signerId: sourceSigner,
      mempool: [],
      isProposer: true,
      state: sourceState,
    } satisfies EntityReplica);
    env.eReplicas.set(`${targetHub}:${targetSigner}`, {
      entityId: targetHub,
      signerId: targetSigner,
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
    expect(removal?.signerId).toBe(targetSigner);
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
    const sourceHubIdentity = registerLazySigner('cross-book-owner-fill-notice', '1');
    const bookOwnerIdentity = registerLazySigner('cross-book-owner-fill-notice', '2');
    const sourceHub = sourceHubIdentity.entityId;
    const bookOwnerHub = bookOwnerIdentity.entityId;
    const remoteMaker = `0x${'31'.repeat(32)}`;
    const remoteTargetUser = `0x${'32'.repeat(32)}`;
    const localTaker = `0x${'33'.repeat(32)}`;
    const localTargetUser = `0x${'34'.repeat(32)}`;
    const sourceJurisdiction = 'stack:31338:0x2222222222222222222222222222222222222222';
    const bookOwnerJurisdiction = 'stack:31337:0x1111111111111111111111111111111111111111';
    const pairId = `cross:${sourceJurisdiction}:2/${bookOwnerJurisdiction}:1`;
    const sourceHubSigner = sourceHubIdentity.signerId;
    const bookOwnerSigner = bookOwnerIdentity.signerId;
    const collisionSigner = '3';
    attachSigningReplica(env, sourceHub, sourceHubSigner);
    const makeCanonicalAccount = (selfId: string, counterpartyId: string): AccountMachine => {
      const [leftEntity, rightEntity] = selfId.toLowerCase() < counterpartyId.toLowerCase()
        ? [selfId, counterpartyId]
        : [counterpartyId, selfId];
      const account = makeProposalAccount([], leftEntity, rightEntity);
      account.proofHeader = { fromEntity: selfId, toEntity: counterpartyId, nextProofNonce: 0 };
      return account;
    };
    env.gossip = {
      getProfiles: () => [
        {
          entityId: localTaker,
          metadata: { board: { validators: [{ signerId: 'local-taker-cross-source-signer' }] } },
        },
        {
          entityId: remoteMaker,
          metadata: { board: { validators: [{ signerId: 'remote-maker-cross-source-signer' }] } },
        },
      ],
    } as Env['gossip'];

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
        sourceHubSignerId: sourceHubId === sourceHub ? sourceHubSigner : bookOwnerSigner,
        targetHubSignerId: targetHubId === bookOwnerHub ? bookOwnerSigner : 'target-hub-signer',
        targetSignerId: `${orderId}-target-signer`,
        bookHubSignerId: bookOwnerSigner,
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
      sourceJurisdiction,
      remoteMaker,
      sourceHub,
      2,
      30n * lot,
      bookOwnerJurisdiction,
      bookOwnerHub,
      remoteTargetUser,
      1,
      75_000n * lot,
    );
    const takerRoute = buildRoute(
      'local-taker-cross',
      bookOwnerJurisdiction,
      localTaker,
      bookOwnerHub,
      1,
      75_000n * lot,
      sourceJurisdiction,
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
    sourceState.config = makeSingleSignerConfigFor(sourceHubSigner);
    sourceState.config = {
      ...sourceState.config,
      validators: [sourceHubSigner],
      shares: { [sourceHubSigner]: 1n },
    };
    sourceState.crossJurisdictionSwaps = new Map([[makerRoute.orderId, makerRoute]]);
    const makerSourceAccount = makeCanonicalAccount(sourceHub, remoteMaker);
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
    bookOwnerState.config = makeSingleSignerConfigFor(bookOwnerSigner);
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

    const takerAccount = makeCanonicalAccount(bookOwnerHub, localTaker);
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
    collisionState.config = makeSingleSignerConfigFor(collisionSigner);
    const collisionAccount = makeCanonicalAccount(collisionOwner, remoteMaker);
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
    env.eReplicas.set(`${collisionOwner}:${collisionSigner}`, {
      entityId: collisionOwner,
      signerId: collisionSigner,
      mempool: [],
      isProposer: true,
      state: collisionState,
    } satisfies EntityReplica);
    env.eReplicas.set(`${sourceHub}:${sourceHubSigner}`, {
      entityId: sourceHub,
      signerId: sourceHubSigner,
      mempool: [],
      isProposer: true,
      state: sourceState,
    } satisfies EntityReplica);
    env.eReplicas.set(`${bookOwnerHub}:${bookOwnerSigner}`, {
      entityId: bookOwnerHub,
      signerId: bookOwnerSigner,
      mempool: [],
      isProposer: true,
      state: bookOwnerState,
    } satisfies EntityReplica);

    const takerAdmissionTxs: EntityTx[] = [
      {
        type: 'admitCrossJurisdictionBookOrder',
        data: { route: takerRoute, receipt: receipt(takerRoute, 'source'), reason: 'source_pull_committed' },
      },
      {
        type: 'admitCrossJurisdictionBookOrder',
        data: { route: takerRoute, receipt: receipt(takerRoute, 'target'), reason: 'target_pull_committed' },
      },
    ];
    makerAdmission.route.sourceHubSignerId = 'committed-source-hub-route';

    const matched = await applyEntityFrame(
      env,
      bookOwnerState,
      await buildQuorumAuthorizedFrameTxs(env, bookOwnerState, takerAdmissionTxs),
    );

    const sourceNotice = matched.outputs.find(output =>
      output.entityId.toLowerCase() === sourceHub.toLowerCase() &&
      output.entityTxs?.[0]?.type === 'crossJurisdictionFillNotice'
    );
    expect(sourceNotice?.signerId).toBe('committed-source-hub-route');
    expect(sourceNotice?.localRuntimeProtocol).toBe('cross-j');
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

    const sourceApplied = await applyEntityFrame(
      env,
      sourceState,
      [{
        type: 'runtimeOutput',
        data: {
          protocol: 'cross-j',
          sourceEntityId: bookOwnerHub,
          targetEntityId: sourceHub,
          entityTxs: sourceNotice!.entityTxs!,
        },
      }],
    );
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
    installSingleSignerBoard(env, sourceState);
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

    const fillNoticeTxs: EntityTx[] = [{
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
    }];
    const applied = await applyEntityFrame(
      env,
      sourceState,
      await buildQuorumAuthorizedFrameTxs(env, sourceState, fillNoticeTxs),
    );

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
    installSingleSignerBoard(env, sourceState);
    sourceState.crossJurisdictionSwaps = new Map([[orderId, route]]);
    sourceState.accounts.set(sourceUser, makeProposalAccount([], sourceHub, sourceUser));

    const cappedState = structuredClone(sourceState) as typeof sourceState;
    cappedState.pendingCrossJurisdictionFillAcks = new Map();
    for (let index = 0; index < MAX_PENDING_CROSS_J_FILL_ACKS; index += 1) {
      const oldAck: Extract<AccountTx, { type: 'cross_swap_fill_ack' }> = {
        type: 'cross_swap_fill_ack',
        data: {
          offerId: `old-source-offer-race-${index}`,
          routeHash: route.routeHash,
          fillSeq: index + 1,
          cumulativeFillRatio: index % 65_536,
          cumulativeSourceAmount: 1n,
          cumulativeTargetAmount: 1n,
        },
      };
      cappedState.pendingCrossJurisdictionFillAcks.set(`old-${index}`, {
        accountId: sourceUser,
        tx: oldAck,
        storedAt: env.timestamp - 100_000 - index,
        ttlExpiredAt: env.timestamp - 50_000 - index,
        reason: 'test-cap',
      });
    }
    const fillNoticeTxs: EntityTx[] = [
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
    ];
    await expect(applyEntityFrame(
      env,
      cappedState,
      await buildQuorumAuthorizedFrameTxs(env, cappedState, fillNoticeTxs),
    )).rejects.toThrow('CROSS_J_FILL_ACK_PENDING_CAPACITY');
    expect(cappedState.pendingCrossJurisdictionFillAcks.size).toBe(MAX_PENDING_CROSS_J_FILL_ACKS);
    expect(Array.from(cappedState.pendingCrossJurisdictionFillAcks.values()).some((entry) =>
      entry.tx.data.offerId === orderId && entry.tx.data.fillSeq === 1
    )).toBe(false);

    const first = await applyEntityFrame(
      env,
      sourceState,
      await buildQuorumAuthorizedFrameTxs(env, sourceState, fillNoticeTxs),
    );

    expect(first.newState.pendingCrossJurisdictionFillAcks?.size).toBe(1);
    const pendingAccount = first.newState.accounts.get(sourceUser);
    const prematurelyQueued = [
      ...(pendingAccount?.mempool ?? []),
      ...(pendingAccount?.pendingFrame?.accountTxs ?? []),
    ].find(tx => tx.type === 'cross_swap_fill_ack' && tx.data.offerId === orderId);
    expect(prematurelyQueued).toBeUndefined();

    const expiredState = structuredClone(first.newState) as typeof first.newState;
    const originalTimestamp = env.timestamp;
    env.timestamp = originalTimestamp + CROSS_J_PENDING_FILL_ACK_TTL_MS + 1;
    const expiredEnv = env;
    expiredState.timestamp = expiredEnv.timestamp;
    const preserved = await applyEntityFrame(expiredEnv, expiredState, []);
    const preservedAck = preserved.newState.pendingCrossJurisdictionFillAcks?.values().next().value;
    expect(preservedAck?.ttlExpiredAt).toBe(expiredEnv.timestamp);
    expect([...expiredEnv.runtimeState!.securityIncidents!.values()]).toContainEqual(expect.objectContaining({
      code: 'CROSS_J_FILL_ACK_TTL_EXPIRED',
      status: 'active',
      entityId: sourceState.entityId,
      offerId: orderId,
    }));
    env.timestamp = originalTimestamp;

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

  test('committed cross-j signer requires its local sibling and ignores unrelated topology', () => {
    const missing = createEmptyEnv('cross-output-topology-missing');
    const minimal = createEmptyEnv('cross-output-topology-minimal');
    const populated = createEmptyEnv('cross-output-topology-populated');
    const target = `0x${'ab'.repeat(32)}`;
    const committedSigner = `0x${'cd'.repeat(20)}`;
    const staleSigner = `0x${'ef'.repeat(20)}`;
    const txs: EntityTx[] = [{ type: 'j_broadcast', data: {} }];
    attachSigningReplica(minimal, target, committedSigner);
    attachSigningReplica(populated, target, committedSigner);
    populated.eReplicas.set('stale-topology', {
      entityId: target.toUpperCase(),
      signerId: staleSigner,
      mempool: [],
      isProposer: true,
      state: {
        ...makeEntityState(target.toUpperCase()),
        config: makeSingleSignerConfigFor(staleSigner),
      },
    } satisfies EntityReplica);

    expect(() => buildCrossJurisdictionEntityOutput(missing, target, txs, committedSigner))
      .toThrow('CROSS_J_SIBLING_TARGET_NOT_LOCAL');
    expect(buildCrossJurisdictionEntityOutput(minimal, target, txs, committedSigner)).toEqual(
      buildCrossJurisdictionEntityOutput(populated, target, txs, committedSigner),
    );
  });

  test('cross-j rejects target-side bonus economics before route commitment', () => {
    const unsupportedRoute = {
      orderId: 'target-bonus-unsupported',
      priceImprovementMode: 'target_bonus',
    } as unknown as CrossJurisdictionSwapRoute;

    expect(() => withCanonicalCrossJurisdictionRouteHash(unsupportedRoute))
      .toThrow('CROSS_J_PRICE_IMPROVEMENT_MODE_UNSUPPORTED:target-bonus-unsupported:target_bonus');
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

  test('disputeStart routes remote cross-j removal from the committed book signer', async () => {
    const env = createEmptyEnv('dispute-start-cross-j-remote-book');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const sourceHub = `0x${'92'.repeat(32)}`;
    const sourceUser = `0x${'93'.repeat(32)}`;
    const targetHub = `0x${'94'.repeat(32)}`;
    const targetUser = `0x${'95'.repeat(32)}`;
    const offerId = 'dispute-cross-j-remote-book';
    const state = makeEntityState(sourceHub);
    state.config = makeSingleSignerConfigFor('source-hub-signer');
    const account = makeProposalAccount([], sourceHub, sourceUser);
    const route = buildPreparedCrossJurisdictionRoute({
      orderId: offerId,
      makerEntityId: sourceUser,
      hubEntityId: targetHub,
      bookOwnerEntityId: targetHub,
      sourceSignerId: 'source-user-signer',
      sourceHubSignerId: 'source-hub-signer',
      targetHubSignerId: 'committed-book-owner-signer',
      targetSignerId: 'target-user-signer',
      bookHubSignerId: 'committed-book-owner-signer',
      source: {
        jurisdiction: 'stack:31338:0x2222222222222222222222222222222222222222',
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 1_000n,
      },
      target: {
        jurisdiction: 'stack:31337:0x1111111111111111111111111111111111111111',
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 2,
        amount: 2_000n,
      },
      status: 'resting',
      createdAt: env.timestamp,
      updatedAt: env.timestamp,
      expiresAt: env.timestamp + 60_000,
    }, { runtimeSeed: 'dispute-start-cross-j-remote-book', sourceDisputeDelayMs: 5_000, now: env.timestamp });
    account.swapOffers.set(offerId, {
      offerId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 2,
      wantAmount: 2_000n,
      makerIsLeft: false,
      minFillRatio: 0,
      createdHeight: 1,
      crossJurisdiction: route,
    });
    state.accounts.set(sourceUser, account);

    const result = await handleDisputeStart(
      state,
      { type: 'disputeStart', data: { counterpartyEntityId: sourceUser } },
      env,
    );

    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toMatchObject({
      entityId: targetHub,
      signerId: 'committed-book-owner-signer',
      entityTxs: [{
        type: 'removeCrossJurisdictionBookOrder',
        data: { orderId: offerId, sourceEntityId: sourceUser, reason: 'account_dispute_start' },
      }],
    });
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

  test('disputeStart freezes optimistic traffic and treats an unknown HTLC secret as optional evidence', async () => {
    const env = createEmptyEnv('prepare-dispute-awaiting-secret');
    const hubId = `0x${'94'.repeat(32)}`;
    const userId = `0x${'95'.repeat(32)}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    const account = makeProposalAccount([{
      type: 'set_credit_limit',
      data: { tokenId: 1, amount: 5n },
    } as AccountTx], hubId, userId);
    setSyntheticPendingAccountProposal(account, [{
      type: 'set_credit_limit',
      data: { tokenId: 1, amount: 7n },
    } as AccountTx], hubState.timestamp);
    hubState.accounts.set(userId, account);
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

    const nextAccount = result.newState.accounts.get(userId)!;
    expect(result.newState.jBatchState?.batch.disputeStarts ?? []).toEqual([]);
    expect(result.newState.messages.some((msg) => msg.includes('htlcAwaitingSecret'))).toBe(false);
    expect(result.newState.messages.some((msg) => msg.includes('Missing counterparty dispute hanko'))).toBe(true);
    expect(nextAccount.pendingFrame).toBeUndefined();
    expect(nextAccount.mempool).toEqual([]);
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
    const seed = 'htlc-forward-ppm-fee';
    const env = createEmptyEnv(seed);
    const signerId = deriveSignerAddressSync(seed, 'hub');
    const signerKey = deriveSignerKeySync(seed, 'hub');
    const nextHopSignerId = deriveSignerAddressSync(seed, 'next-hop');
    const nextHopSignerKey = deriveSignerKeySync(seed, 'next-hop');
    registerSignerKey(env, signerId, signerKey);
    registerSignerKey(env, nextHopSignerId, nextHopSignerKey);
    const hubId = generateLazyEntityId([signerId], 1n).toLowerCase();
    const payerId = `0x${'a1'.repeat(32)}`;
    const nextHopId = generateLazyEntityId([nextHopSignerId], 1n).toLowerCase();
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor(signerId);
    hubState.hubRebalanceConfig = {
      matchingStrategy: 'amount',
      policyVersion: 1,
      routingFeePPM: 100_000,
      baseFee: 10n,
    };
    hubState.accounts.set(
      nextHopId,
      isLeftEntity(hubId, nextHopId)
        ? makeProposalAccount([], hubId, nextHopId)
        : makeProposalAccount([], nextHopId, hubId),
    );
    const crypto = new NobleCryptoProvider();
    const keyPair = x25519.keygen();
    hubState.entityEncPubKey = hexBytes(keyPair.publicKey);
    hubState.entityEncPrivKey = hexBytes(keyPair.secretKey);
    const signerPublicKey = new ethers.SigningKey(hexBytes(signerKey)).publicKey.toLowerCase();
    const attestationBody = {
      version: 'xln:validator-encryption-key:v1' as const,
      entityId: hubId,
      signerId,
      signer: signerId,
      publicKey: signerPublicKey,
      weight: 1,
      encryptionPublicKey: hubState.entityEncPubKey,
    };
    const manifest = requireCompleteValidatorEncryptionManifest({
      entityId: hubId,
      threshold: 1,
      validators: [{
        signerId,
        signer: signerId,
        publicKey: signerPublicKey,
        weight: 1,
      }],
    }, [{
      ...attestationBody,
      signature: signAccountFrame(
        env,
        signerId,
        computeValidatorEncryptionAttestationDigest(attestationBody),
      ),
    }]);
    hubState.profileEncryptionManifest = structuredClone(manifest);
    const lockId = 'ppm-fee-lock';
    const finalSecret = `0x${'a4'.repeat(32)}`;
    const hashlock = hashHtlcSecret(finalSecret);
    const timelock = BigInt(hubState.timestamp + 120_000);
    const contextHash = computeHtlcEnvelopeContextHash({
      entityId: hubId,
      lockId,
      hashlock,
      tokenId: 1,
      amount: 1_000_000n,
      timelock,
      revealBeforeHeight: 100,
    });
    const routingStateHash = ethers.keccak256(ethers.toUtf8Bytes('ppm-fee-routing-state'));
    const profileHash = computeEntityProfileCertificationHash(manifest.hash, routingStateHash);
    const [profileHanko] = await signEntityHashes(env, hubId, signerId, [profileHash], hubState);
    if (!profileHanko) throw new Error('TEST_PROFILE_HANKO_MISSING');
    const profileCertification = { profileHash, routingStateHash, hanko: profileHanko };

    const nextHopState = makeEntityState(nextHopId);
    nextHopState.config = makeSingleSignerConfigFor(nextHopSignerId);
    const nextHopKeyPair = x25519.keygen();
    const nextHopEncryptionPublicKey = hexBytes(nextHopKeyPair.publicKey);
    const nextHopSignerPublicKey = new ethers.SigningKey(hexBytes(nextHopSignerKey)).publicKey.toLowerCase();
    const nextHopAttestationBody = {
      version: 'xln:validator-encryption-key:v1' as const,
      entityId: nextHopId,
      signerId: nextHopSignerId,
      signer: nextHopSignerId,
      publicKey: nextHopSignerPublicKey,
      weight: 1,
      encryptionPublicKey: nextHopEncryptionPublicKey,
    };
    const nextHopManifest = requireCompleteValidatorEncryptionManifest({
      entityId: nextHopId,
      threshold: 1,
      validators: [{
        signerId: nextHopSignerId,
        signer: nextHopSignerId,
        publicKey: nextHopSignerPublicKey,
        weight: 1,
      }],
    }, [{
      ...nextHopAttestationBody,
      signature: signAccountFrame(
        env,
        nextHopSignerId,
        computeValidatorEncryptionAttestationDigest(nextHopAttestationBody),
      ),
    }]);
    const nextHopRoutingStateHash = ethers.keccak256(ethers.toUtf8Bytes('next-hop-routing-state'));
    const nextHopProfileHash = computeEntityProfileCertificationHash(
      nextHopManifest.hash,
      nextHopRoutingStateHash,
    );
    const [nextHopProfileHanko] = await signEntityHashes(
      env,
      nextHopId,
      nextHopSignerId,
      [nextHopProfileHash],
      nextHopState,
    );
    if (!nextHopProfileHanko) throw new Error('TEST_NEXT_HOP_PROFILE_HANKO_MISSING');
    const forwardAmount = 999_990n;
    const forwardTimelock = timelock - BigInt(HTLC.MIN_TIMELOCK_DELTA_MS);
    const forwardRevealBeforeHeight = 100 - HTLC.MIN_REVEAL_HEIGHT_DELTA_BLOCKS;
    const innerContextHash = computeHtlcEnvelopeContextHash({
      entityId: nextHopId,
      lockId: `${lockId}-fwd`,
      hashlock,
      tokenId: 1,
      amount: forwardAmount,
      timelock: forwardTimelock,
      revealBeforeHeight: forwardRevealBeforeHeight,
    });
    const secretOffer = await encryptBytesForValidatorManifest(
      encodeHtlcSecretOffer({ secret: finalSecret }),
      manifest,
      profileCertification,
      computeHtlcSecretOfferContextHash({
        entityId: nextHopId,
        payerEntityId: hubId,
        beneficiaryEntityId: nextHopId,
        lockId: `${lockId}-fwd`,
        hashlock,
        tokenId: 1,
        amount: forwardAmount,
        timelock: forwardTimelock,
        revealBeforeHeight: forwardRevealBeforeHeight,
      }),
      crypto,
      signerId,
    );
    const innerEnvelope = await encryptBytesForValidatorManifest(
      encodeOnionLayer({ finalRecipient: true, secretOffer }),
      nextHopManifest,
      {
        profileHash: nextHopProfileHash,
        routingStateHash: nextHopRoutingStateHash,
        hanko: nextHopProfileHanko,
      },
      innerContextHash,
      crypto,
      nextHopSignerId,
    );
    const encryptedLayer = await encryptBytesForValidatorManifest(
      encodeOnionLayer({
        nextHop: nextHopId,
        innerEnvelope,
        forwardAmount: forwardAmount.toString(),
      }),
      manifest,
      profileCertification,
      contextHash,
      crypto,
      signerId,
    );
    const accountMachine = isLeftEntity(payerId, hubId)
      ? makeProposalAccount([], payerId, hubId)
      : makeProposalAccount([], hubId, payerId);
    accountMachine.locks.set(lockId, {
      lockId,
      hashlock,
      timelock,
      revealBeforeHeight: 100,
      amount: 1_000_000n,
      tokenId: 1,
      senderIsLeft: true,
      createdHeight: 1,
      createdTimestamp: hubState.timestamp,
      envelope: encryptedLayer,
    });
    hubState.accounts.set(payerId, accountMachine);
    const lock = accountMachine.locks.get(lockId);
    if (!lock) throw new Error('TEST_HTLC_LOCK_MISSING');
    const advanceTx = buildHtlcOnionAdvanceTx(
      hubState,
      payerId,
      lock,
      encryptedLayer,
      { nextHop: nextHopId, innerEnvelope, forwardAmount: forwardAmount.toString() },
    );
    const result = await handleHtlcOnionAdvance(env, hubState, advanceTx);

    expect(result.mempoolOps).toHaveLength(1);
    expect(result.mempoolOps[0]?.accountId).toBe(payerId);
    expect(result.mempoolOps[0]?.tx).toEqual({
      type: 'htlc_resolve',
      data: { lockId, outcome: 'error', reason: 'fee_below_ppm' },
    });
    expect(result.newState.htlcRoutes.has(hashlock)).toBe(false);

    const replay = await handleHtlcOnionAdvance(env, structuredClone(hubState), advanceTx);
    expect(replay.mempoolOps).toEqual(result.mempoolOps);
    expect(replay.newState.htlcRoutes).toEqual(result.newState.htlcRoutes);
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
    const proposed = await proposeAccountFrame(env, account, env.timestamp);
    expect(proposed.success).toBe(true);
    const pendingHeight = proposed.accountInput!.proposal.frame.height;
    account.pendingAccountInputSignerId = 'fixture-counterparty-signer';
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

  test('disputeFinalize queues the exact proof despite unknown HTLC evidence and stale optimistic traffic', async () => {
    const env = createEmptyEnv('counter-dispute-awaiting-secret');
    const hubId = `0x${'98'.repeat(32)}`;
    const userId = `0x${'99'.repeat(32)}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    attachSigningReplica(env, hubId, 'hub-signer');
    const account = makeProposalAccount([], hubId, userId);
    account.deltas.set(1, createDefaultDelta(1));
    account.locks.set('counter-await-secret-lock', {
      lockId: 'counter-await-secret-lock',
      hashlock: `0x${'55'.repeat(32)}`,
      timelock: BigInt(hubState.timestamp + 60_000),
      amount: 10n,
      tokenId: 1,
      senderIsLeft: false,
      createdHeight: 1,
      createdTimestamp: hubState.timestamp,
    });
    const initialProof = buildAccountProofBody(account, hex20('99'));
    storeDisputeArgumentSnapshot(
      account,
      captureDisputeArgumentSnapshot(account, initialProof.proofBodyHash, 1, initialProof.proofBodyStruct),
    );
    account.disputeProofBodiesByHash = {
      [initialProof.proofBodyHash]: initialProof.proofBodyStruct,
    };
    account.status = 'disputed';
    account.activeDispute = {
      startedByLeft: false,
      initialProofbodyHash: initialProof.proofBodyHash,
      initialNonce: 1,
      disputeTimeout: 100,
      jNonce: 1,
      starterInitialArguments: '0x',
      starterIncrementedArguments: '0x',
      observedOnChain: true,
      finalizeQueued: false,
    };
    setSyntheticPendingAccountProposal(account, [{
      type: 'set_credit_limit',
      data: { tokenId: 1, amount: 9n },
    } as AccountTx], hubState.timestamp);
    account.mempool = [{
      type: 'set_credit_limit',
      data: { tokenId: 1, amount: 11n },
    } as AccountTx];
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

    const finalization = result.newState.jBatchState?.batch.disputeFinalizations[0];
    const nextAccount = result.newState.accounts.get(userId)!;
    expect(finalization).toBeDefined();
    expect(finalization?.initialProofbodyHash).toBe(initialProof.proofBodyHash);
    expect(finalization?.finalProofbody).toEqual(initialProof.proofBodyStruct);
    expect(finalization?.starterArguments).toBe('0x');
    expect(finalization?.otherArguments).toBe('0x');
    expect(result.newState.messages.some((msg) => msg.includes('htlcAwaitingSecret'))).toBe(false);
    expect(nextAccount.pendingFrame).toBeUndefined();
    expect(nextAccount.mempool).toEqual([]);
  });
});

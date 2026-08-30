/**
 * RAM-only bilateral counterparties for the single-entity native replay fixture.
 * Each peer is exactly one canonical AccountReplica plus Hanko signing state:
 * no peer RuntimeReplica processing, zero peer EntityReplicas. Peer replies run
 * the production boundary (applyAccountInput -> draft hashes ->
 * attachAccountDraftHankosAsEntity, as in benchmark/bench-account-inputs).
 */

import { applyAccountInput, proposeAccountFrame } from '../../../../../account/consensus';
import { accountInputFailureMessage, isProposedAccountFrame, proposeAccountFrameMessage } from '../../../../../account/consensus/result';
import { accountStateDomainFromJurisdiction, normalizeAccountStateDomain, sameAccountStateDomain } from '../../../../../account/commitment/state-root';
import { canonicalAccountDisputeConfig } from '../../../../../account/config/dispute-config';
import { registerSignerKey } from '../../../../../account/crypto';
import { createAccountConsensusContext } from '../../../../../entity/account/account-consensus-context';
import { computeEntityAccountValueHash } from '../../../../../entity/consensus/state-root';
import { getEntityAccountForWrite, PersistentEntityAccountMap } from '../../../../../entity/state/persistent-account-map';
import { handleExtendCreditEntityTx } from '../../../../../entity/tx/handlers/account/lifecycle/admin';
import { handleOpenAccountEntityTx } from '../../../../../entity/tx/handlers/account/lifecycle/open-account';
import type { EntityInput, EntityState } from '../../../../../entity/types';
import type { ManagedEntityIdentity } from '../../../../../orchestrator/daemon-control';
import { deliveryAccepted } from '../../../../../protocol/payments/delivery-result';
import type { JurisdictionConfig } from '../../../../../protocol/config/jurisdiction-config';
import { deriveAccountWatchSeed, normalizeAccountWatchSeed } from '../../../../../protocol/identity/account-watch-seed';
import { attachAccountDraftHankosAsEntity } from '../../../../../qa/account/draft';
import type { RuntimeEntityInputsEnvelope, RuntimeReplica } from '../../../../../runtime/types';
import { hexToBytes } from '../../../../../support/bytes/hex-bytes';
import type { AccountInput, AccountPeerInput, AccountReplica } from '../../../../../types/account';
import type { EntityTx } from '../../../../../types/entity-tx';

type RuntimeApi = typeof import('../../../../../runtime');

type FixturePeer = {
  identity: ManagedEntityIdentity;
  /** Bare signing/authority state only; never an EntityReplica in any Runtime. */
  state: EntityState;
  account: AccountReplica | null;
};

type AccountDraft = {
  accountInput?: AccountInput;
  hashesToSign?: Array<{ hash: string; type: 'accountFrame' | 'dispute'; context: string }>;
};

export type FixturePeerAccounts = Readonly<{
  peerRuntimeId: string;
  /** Bind H1 direct dispatch: account EntityTxs queue in order; anything else fails loudly. */
  installDispatch: () => void;
  /** Apply one peerSetupBatch of setup EntityInputs; proposes each genesis frame to H1. */
  seedAccounts: (inputs: readonly EntityInput[], timestamp: number) => Promise<number>;
  /** Apply queued H1 outbound inputs to peer replicas, sign replies, enqueue them into H1. */
  drainReplies: (timestamp: number) => Promise<number>;
  pendingInbound: () => number;
  assertQuiescent: () => void;
  /** Signing env + bare peer states for canonical peer profile publication. */
  signingContext: () => Readonly<{ env: RuntimeReplica; peers: ReadonlyArray<{ identity: ManagedEntityIdentity; state: EntityState }> }>;
}>;

/** Exact ingress normalization of entity/command/index.ts materializeLocallyAuthoredEntityTx (openAccount branch). */
const materializePeerOpenAccount = (
  env: RuntimeReplica,
  state: EntityState,
  tx: Extract<EntityTx, { type: 'openAccount' }>,
): Extract<EntityTx, { type: 'openAccount' }> => {
  const jurisdiction = state.config?.jurisdiction;
  if (!jurisdiction) throw new Error(`OPEN_ACCOUNT_SOURCE_JURISDICTION_REQUIRED:${state.entityId}`);
  const committedDomain = accountStateDomainFromJurisdiction(jurisdiction);
  const suppliedDomain = tx.data.accountDomain;
  if (suppliedDomain !== undefined &&
      !sameAccountStateDomain(normalizeAccountStateDomain(suppliedDomain), committedDomain)) {
    throw new Error('OPEN_ACCOUNT_DOMAIN_MISMATCH');
  }
  const counterpartyId = String(tx.data.targetEntityId ?? '').trim().toLowerCase();
  if (tx.data.disputeConfig === undefined) throw new Error('OPEN_ACCOUNT_DISPUTE_CONFIG_REQUIRED');
  const disputeConfig = canonicalAccountDisputeConfig(tx.data.disputeConfig);
  const watchSeed = tx.data.watchSeed === undefined
    ? deriveAccountWatchSeed({
        runtimeSeed: env.runtimeSeed ?? '', runtimeId: env.runtimeId ?? null,
        entityId: state.entityId, counterpartyId,
      })
    : normalizeAccountWatchSeed(tx.data.watchSeed, 'OPEN_ACCOUNT');
  return { ...tx, data: { ...tx.data, disputeConfig, accountDomain: committedDomain, watchSeed } };
};

const barePeerEntityState = (identity: ManagedEntityIdentity): EntityState => {
  if (!identity.consensusConfig.jurisdiction) {
    throw new Error(`FIXTURE_PEER_JURISDICTION_MISSING:${identity.entityId}`);
  }
  return {
    entityId: identity.entityId,
    entityEncryptionPublicKey: `0x${'11'.repeat(32)}`,
    height: 1,
    timestamp: 0,
    nonces: new Map(),
    proposals: new Map(),
    config: identity.consensusConfig,
    reserves: new Map(),
    accounts: PersistentEntityAccountMap.empty(identity.entityId, computeEntityAccountValueHash),
    lastFinalizedJHeight: 0,
    profile: { name: identity.name, isHub: false, avatar: '', bio: '', website: '' },
    paybook: { entries: new Map(), feesEarned: 0n },
    crossJurisdictionSwaps: new Map(),
    swapTradingPairs: [],
  } as EntityState;
};

export const createFixturePeerAccounts = (args: Readonly<{
  runtime: RuntimeApi;
  main: () => RuntimeReplica;
  mainIdentity: ManagedEntityIdentity;
  peerIdentities: readonly ManagedEntityIdentity[];
  jurisdiction: JurisdictionConfig;
  peerSeed: string;
}>): FixturePeerAccounts => {
  const { runtime, main, mainIdentity, jurisdiction } = args;
  // One signing-only RuntimeReplica: canonical keystore + deterministic
  // seed-derived runtimeId, zero EntityReplicas, never processed.
  const peerEnv = runtime.createEmptyEnv(args.peerSeed);
  peerEnv.scenarioMode = true;
  peerEnv.quietRuntimeLogs = true;
  if (!peerEnv.runtimeId) throw new Error('FIXTURE_PEER_RUNTIME_ID_MISSING');
  const peerRuntimeId = peerEnv.runtimeId;
  peerEnv.activeJurisdiction = jurisdiction.name;
  peerEnv.state.jReplicas.set(jurisdiction.name, {
    name: jurisdiction.name,
    chainId: jurisdiction.chainId,
    rpcs: [jurisdiction.address],
    depositoryAddress: jurisdiction.depositoryAddress,
    entityProviderAddress: jurisdiction.entityProviderAddress,
    blockTimeMs: jurisdiction.blockTimeMs,
    contracts: {
      account: '0x000000000000000000000000000000000000cafe',
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
      deltaTransformer: '0x000000000000000000000000000000000000babe',
    },
  } as never);

  const peers = new Map<string, FixturePeer>();
  for (const identity of args.peerIdentities) {
    registerSignerKey(peerEnv, identity.signerId, hexToBytes(identity.privateKeyHex));
    peers.set(identity.entityId.toLowerCase(), {
      identity,
      state: barePeerEntityState(identity),
      account: null,
    });
  }
  if (peers.size !== args.peerIdentities.length) {
    throw new Error(`FIXTURE_PEER_DUPLICATE_ENTITY:${peers.size}:${args.peerIdentities.length}`);
  }
  const mainEntityKey = mainIdentity.entityId.toLowerCase();

  const queue: Array<{ peerKey: string; input: AccountPeerInput }> = [];
  let replyHeight = 0;

  const enqueueReply = (signed: AccountPeerInput, timestamp: number): void => {
    if (signed.toEntityId.toLowerCase() !== mainEntityKey) {
      throw new Error(`FIXTURE_PEER_REPLY_TARGET_MISMATCH:${signed.toEntityId}`);
    }
    const envelope: RuntimeEntityInputsEnvelope = {
      sourceRuntimeId: peerRuntimeId,
      sourceRuntimeHeight: (replyHeight += 1),
      sourceRuntimeTimestamp: timestamp,
      entityInputs: [{
        entityId: mainIdentity.entityId,
        signerId: mainIdentity.signerId,
        runtimeId: main().runtimeId!,
        entityTxs: [{ type: 'accountInput', data: signed }],
      }],
    };
    const inbound = runtime.handleInboundP2PEntityInputs(main(), peerRuntimeId, envelope, timestamp, {
      envelopeSourceVerified: true,
      entityInputsValidated: true,
    });
    if (inbound.kind !== 'queued') throw new Error(`FIXTURE_PEER_REPLY_NOT_QUEUED:${mainIdentity.entityId}`);
  };

  const signAndSend = async (peer: FixturePeer, draft: AccountDraft, timestamp: number): Promise<void> => {
    const signed = await attachAccountDraftHankosAsEntity(
      peerEnv, peer.identity.entityId, peer.identity.signerId, draft,
    );
    if (signed.kind !== 'frame' && signed.kind !== 'ack' && signed.kind !== 'ack_frame') {
      throw new Error(`FIXTURE_PEER_REPLY_KIND_INVALID:${signed.kind}`);
    }
    enqueueReply(signed, timestamp);
  };

  const installDispatch = (): void => {
    const env = main();
    env.infrastructure ??= {};
    env.infrastructure.directEntityInputsDispatch = (targetRuntimeId, envelope) => {
      if (targetRuntimeId.toLowerCase() !== peerRuntimeId.toLowerCase()) {
        throw new Error(`FIXTURE_PEER_DIRECT_TARGET_MISMATCH:${targetRuntimeId}`);
      }
      if (envelope.atomicCrossJurisdictionPair) throw new Error('FIXTURE_PEER_ATOMIC_CROSS_J_UNSUPPORTED');
      for (const input of envelope.entityInputs) {
        const tx = input.entityTxs?.length === 1 ? input.entityTxs[0] : undefined;
        if (!tx || tx.type !== 'accountInput') {
          throw new Error(`FIXTURE_PEER_NON_ACCOUNT_DISPATCH:${input.entityId}:${tx?.type ?? 'missing'}`);
        }
        const peerKey = input.entityId.toLowerCase();
        if (!peers.has(peerKey)) throw new Error(`FIXTURE_PEER_UNKNOWN_TARGET:${input.entityId}`);
        if (tx.data.toEntityId.toLowerCase() !== peerKey) {
          throw new Error(`FIXTURE_PEER_ACCOUNT_TARGET_MISMATCH:${input.entityId}:${tx.data.toEntityId}`);
        }
        queue.push({ peerKey, input: tx.data });
      }
      return deliveryAccepted('FIXTURE_PEER_QUEUED');
    };
  };

  const seedAccounts = async (inputs: readonly EntityInput[], timestamp: number): Promise<number> => {
    peerEnv.state.timestamp = timestamp;
    const ctx = createAccountConsensusContext(peerEnv);
    let proposed = 0;
    for (const input of inputs) {
      const peerKey = input.entityId.toLowerCase();
      const peer = peers.get(peerKey);
      if (!peer) throw new Error(`FIXTURE_PEER_SETUP_UNKNOWN_ENTITY:${input.entityId}`);
      if (input.signerId !== peer.identity.signerId) throw new Error(`FIXTURE_PEER_SETUP_SIGNER_MISMATCH:${input.entityId}`);
      if (!input.entityTxs?.length) throw new Error(`FIXTURE_PEER_SETUP_TXS_EMPTY:${input.entityId}`);
      let state = peer.state;
      for (const tx of input.entityTxs) {
        if (tx.type === 'openAccount') {
          const openTx = tx as Extract<EntityTx, { type: 'openAccount' }>; // discriminant above proves the cast
          const opened = await handleOpenAccountEntityTx(
            state, materializePeerOpenAccount(peerEnv, state, openTx), ctx,
          );
          state = opened.newState;
        } else if (tx.type === 'extendCredit') {
          const credited = handleExtendCreditEntityTx(state, tx);
          state = credited.newState;
          if ((credited.accountTxs?.length ?? 0) !== 1) {
            throw new Error(`FIXTURE_PEER_CREDIT_TARGET_MISSING:${input.entityId}:${tx.data.tokenId}`);
          }
          const target = credited.accountTxs![0]!;
          const account = getEntityAccountForWrite(state.accounts, target.accountId);
          if (!account) throw new Error(`FIXTURE_PEER_CREDIT_ACCOUNT_MISSING:${input.entityId}:${target.accountId}`);
          const admission = await applyAccountInput(ctx, account, { kind: 'enqueue', txs: [target.tx] });
          if (!admission.ok || admission.admittedAccountTxCount !== 1) {
            throw new Error(
              `FIXTURE_PEER_CREDIT_NOT_ADMITTED:${input.entityId}:${accountInputFailureMessage(admission)}`,
            );
          }
        } else {
          throw new Error(`FIXTURE_PEER_SETUP_TX_UNSUPPORTED:${input.entityId}:${tx.type}`);
        }
      }
      peer.state = state;
      const account = getEntityAccountForWrite(state.accounts, mainEntityKey);
      if (!account) throw new Error(`FIXTURE_PEER_GENESIS_ACCOUNT_MISSING:${input.entityId}`);
      peer.account = account;
      const proposal = await proposeAccountFrame(ctx, account, timestamp);
      if (!isProposedAccountFrame(proposal)) {
        throw new Error(`FIXTURE_PEER_GENESIS_PROPOSE_FAILED:${input.entityId}:${proposeAccountFrameMessage(proposal)}`);
      }
      await signAndSend(peer, proposal, timestamp);
      proposed += 1;
    }
    return proposed;
  };

  const drainReplies = async (timestamp: number): Promise<number> => {
    peerEnv.state.timestamp = timestamp;
    const ctx = createAccountConsensusContext(peerEnv);
    let replies = 0;
    let cursor = 0;
    while (cursor < queue.length) {
      const entry = queue[cursor++]!;
      const peer = peers.get(entry.peerKey)!;
      if (!peer.account) throw new Error(`FIXTURE_PEER_ACCOUNT_UNSEEDED:${entry.peerKey}`);
      const received = await applyAccountInput(ctx, peer.account, entry.input);
      if (!received.ok) throw new Error(`FIXTURE_PEER_INPUT_REJECTED:${entry.peerKey}:${accountInputFailureMessage(received)}`);
      if (!received.response) continue;
      const hashesToSign = received.hashesToSign;
      if (!hashesToSign?.length) throw new Error(`FIXTURE_PEER_RESPONSE_UNSIGNED:${entry.peerKey}`);
      const draft: AccountDraft = {
        accountInput: received.response,
        hashesToSign,
      };
      await signAndSend(peer, draft, timestamp);
      replies += 1;
    }
    // One linear compaction after the batch; Array.shift() made a 10k-peer
    // fixture quadratic by moving the remaining queue for every reply.
    queue.splice(0, cursor);
    return replies;
  };

  return {
    peerRuntimeId,
    installDispatch,
    seedAccounts,
    drainReplies,
    pendingInbound: () => queue.length,
    assertQuiescent: () => {
      if (queue.length > 0) throw new Error(`FIXTURE_PEER_INBOUND_PENDING:${queue.length}`);
      if (peerEnv.state.eReplicas.size !== 0) {
        throw new Error(`FIXTURE_PEER_ENTITY_REPLICAS_FORBIDDEN:${peerEnv.state.eReplicas.size}`);
      }
    },
    signingContext: () => ({ env: peerEnv, peers: [...peers.values()] }),
  };
};

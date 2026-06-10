import type {
  EntityInput,
  EntityState,
  JBlockObservation,
  JBlockFinalized,
  JurisdictionEvent,
  Env,
} from '../types';
import { cloneEntityState, addMessage } from '../state-helpers';
import { getTokenInfo } from '../account-utils';
import { CANONICAL_J_EVENTS } from '../jadapter/helpers';
import { hashHtlcSecret } from '../htlc-utils';
import { scheduleHook as scheduleCrontabHook, cancelHook as cancelCrontabHook } from '../entity-crontab';
import { getRuntimeJurisdictionDefaultDisputeDelayBlocks } from '../j-height';
import { scrubDisputeFinalizationsForCounterparty } from './dispute-finalize-guards';
import {
  canonicalJurisdictionEventKey,
  normalizeJurisdictionEvent,
  normalizeJurisdictionEvents,
} from '../j-event-normalization';
import {
  buildJEventObservationDigest,
  canonicalJurisdictionEventsHash,
} from '../j-event-observation';
import { verifyAccountSignature } from '../account-crypto';
import { markStorageEntityDirty } from '../env-events';
import { applyDebtCreated, applyDebtEnforced, applyDebtForgiven } from './j-events-debt';
import { createStructuredLogger, shortHash, shortId } from '../logger';
import {
  applyKnownHtlcSecret,
  decodeDisputeStarterInitialSecrets,
  queueCrossJurisdictionSalvageFromDispute,
  queueCrossJurisdictionSourceDisputeFromTargetDispute,
} from './j-events-htlc';
import {
  mergeAccountJObservations,
  mergeJEventClaimOps,
} from './j-events-account';
import type { JEventApplyResult, JEventMempoolOp } from './j-events-types';
import { appendBatchHistory, emptyOpBreakdown } from './j-events-history';
import { applyHankoBatchProcessedEvent } from './j-events-batch';

const jEventLog = createStructuredLogger('j.event');

// J-events are observed chain events. State changes apply only after validator
// threshold agreement on the canonical event set.
export interface JEventEntityTxData {
  from: string;  // Signer ID that observed the event
  event: {
    type: string;  // Event name (e.g., "ReserveUpdated", "AccountSettled")
    data: Record<string, unknown>;  // Event-specific data from blockchain
  };
  events?: Array<{
    type: string;  // Event name (e.g., "ReserveUpdated", "AccountSettled")
    data: Record<string, unknown>;
  }>;
  observedAt: number;  // Timestamp when event was observed (ms)
  blockNumber: number;  // Blockchain block number where event occurred
  blockHash: string;    // Block hash for JBlock consensus
  transactionHash: string;  // Blockchain transaction hash
  eventsHash?: string;
  signature?: string;
}

const normalizeSignerId = (value: unknown): string => String(value || '').trim().toLowerCase();

const signerVotingPower = (state: EntityState, signers: Iterable<string>): bigint => {
  let total = 0n;
  const seen = new Set<string>();
  const sharesByNormalized = new Map<string, bigint>();
  for (const [signerId, shares] of Object.entries(state.config.shares || {})) {
    sharesByNormalized.set(normalizeSignerId(signerId), BigInt(shares));
  }
  for (const signerId of signers) {
    const normalized = normalizeSignerId(signerId);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    total += sharesByNormalized.get(normalized) ?? 0n;
  }
  return total;
};

const isValidatorSigner = (state: EntityState, signerId: string): boolean => {
  const normalized = normalizeSignerId(signerId);
  return (state.config.validators || []).some((validatorId) => normalizeSignerId(validatorId) === normalized);
};

const observationEventsHash = (observation: JBlockObservation): string => {
  const existing = typeof observation.eventsHash === 'string' && observation.eventsHash.trim()
    ? observation.eventsHash.toLowerCase()
    : '';
  return existing || canonicalJurisdictionEventsHash(observation.events || []);
};

const getTokenSymbol = (tokenId: number): string => {
  return getTokenInfo(tokenId).symbol;
};

const getTokenDecimals = (tokenId: number): number => {
  return getTokenInfo(tokenId).decimals;
};

export const handleJEvent = async (entityState: EntityState, entityTxData: JEventEntityTxData, env: Env): Promise<JEventApplyResult> => {
  const { from: signerId, observedAt, blockNumber, blockHash } = entityTxData;
  if (!isValidatorSigner(entityState, signerId)) {
    throw new Error(`j_event rejected: non-validator signer ${String(signerId)}`);
  }
  type RawJEventBatchData = JEventEntityTxData & {
    events?: unknown[];
    event?: unknown;
    transactionHash?: string;
    eventsHash?: string;
    signature?: string;
  };
  const batchData = entityTxData as RawJEventBatchData;
  const rawEvents = Array.isArray(batchData.events)
    ? batchData.events
    : batchData.event !== undefined
      ? [batchData.event]
      : [];

  // Already-finalized heights are idempotent only when the hash matches.
  const finalizedAtHeight = entityState.jBlockChain.find(b => b.jHeight === blockNumber);
  if (finalizedAtHeight) {
    if (finalizedAtHeight.jBlockHash !== blockHash) {
      throw new Error(
        `j_event conflict: block ${blockNumber} finalized as ${finalizedAtHeight.jBlockHash}, observed ${blockHash}`,
      );
    }
    return { newState: entityState, mempoolOps: [], outputs: [], dirtyAccounts: [] };
  }

  if (blockNumber <= entityState.lastFinalizedJHeight) {
    return { newState: entityState, mempoolOps: [], outputs: [], dirtyAccounts: [] };
  }

  const jEvents: JurisdictionEvent[] = [];
  for (const raw of rawEvents) {
    const normalized = normalizeJurisdictionEvent({
      ...(raw || {}),
      blockNumber,
      blockHash,
      transactionHash:
        (typeof raw === 'object' && raw !== null && 'transactionHash' in raw && typeof (raw as { transactionHash?: unknown }).transactionHash === 'string')
          ? (raw as { transactionHash: string }).transactionHash
          : batchData.transactionHash,
    });
    if (!normalized) {
      jEventLog.warn('observation.event_malformed', { block: blockNumber });
      jEventLog.trace('observation.event_malformed_payload', { block: blockNumber, event: raw });
      continue;
    }
    jEvents.push(normalized);
  }
  if (jEvents.length === 0) {
    jEventLog.warn('observation.empty_after_normalize', { block: blockNumber });
    return { newState: entityState, mempoolOps: [], outputs: [], dirtyAccounts: [] };
  }
  const canonicalEventsHash = canonicalJurisdictionEventsHash(jEvents);
  const suppliedEventsHash = typeof batchData.eventsHash === 'string' ? batchData.eventsHash.toLowerCase() : '';
  if (!suppliedEventsHash) {
    throw new Error(`j_event rejected: missing eventsHash for signer ${String(signerId)} block ${blockNumber}`);
  }
  if (suppliedEventsHash !== canonicalEventsHash) {
    throw new Error(
      `j_event rejected: eventsHash mismatch for signer ${String(signerId)} block ${blockNumber}`,
    );
  }

  const signature = typeof batchData.signature === 'string' ? batchData.signature : '';
  if (!signature) {
    throw new Error(`j_event rejected: missing observation signature for signer ${String(signerId)}`);
  }
  const digest = buildJEventObservationDigest({
    entityId: entityState.entityId,
    signerId: String(signerId),
    blockNumber,
    blockHash,
    transactionHash: batchData.transactionHash || '',
    eventsHash: canonicalEventsHash,
  });
  if (!verifyAccountSignature(env, String(signerId), digest, signature)) {
    throw new Error(`j_event rejected: invalid observation signature for signer ${String(signerId)}`);
  }

  let newEntityState = cloneEntityState(entityState);

  const observation: JBlockObservation = {
    signerId: normalizeSignerId(signerId),
    jHeight: blockNumber,
    jBlockHash: blockHash,
    eventsHash: canonicalEventsHash,
    events: jEvents,
    observedAt,
  };

  newEntityState.jBlockObservations.push(observation);

  const { newState, mempoolOps, outputs, dirtyAccounts } = await tryFinalizeJBlocks(newEntityState, entityState.config.threshold, env);
  newEntityState = newState;

  return { newState: newEntityState, mempoolOps, outputs, dirtyAccounts };
};

async function tryFinalizeJBlocks(
  state: EntityState,
  threshold: bigint,
  env: Env
): Promise<JEventApplyResult> {
  const allMempoolOps: JEventMempoolOp[] = [];
  const allOutputs: EntityInput[] = [];
  const dirtyAccounts = new Set<string>();

  // A block-hash quorum is not enough: signers must agree on the event-set hash
  // too, otherwise a Byzantine signer could union fake events into a real block.
  const observationGroups = new Map<string, JBlockObservation[]>();
  const signerObservationHashes = new Map<string, string>();

  for (const obs of state.jBlockObservations) {
    if (!isValidatorSigner(state, obs.signerId)) {
      throw new Error(`j_event rejected: non-validator signer ${String(obs.signerId)}`);
    }
    const signerId = normalizeSignerId(obs.signerId);
    const eventsHash = observationEventsHash(obs);
    const signerKey = `${obs.jHeight}:${obs.jBlockHash}:${signerId}`;
    const previousEventsHash = signerObservationHashes.get(signerKey);
    if (previousEventsHash && previousEventsHash !== eventsHash) {
      throw new Error(
        `j_event conflict: signer ${signerId} submitted multiple event sets for block ${obs.jHeight}:${obs.jBlockHash}`,
      );
    }
    signerObservationHashes.set(signerKey, eventsHash);
    const key = `${obs.jHeight}:${obs.jBlockHash}:${eventsHash}`;
    if (!observationGroups.has(key)) {
      observationGroups.set(key, []);
    }
    observationGroups.get(key)!.push({ ...obs, signerId, eventsHash });
  }

  const finalizedHeights: number[] = [];

  const thresholdHashesByHeight = new Map<number, Set<string>>();
  const thresholdEventHashesByBlock = new Map<string, Set<string>>();
  for (const observations of observationGroups.values()) {
    const uniqueSigners = new Set(observations.map(o => normalizeSignerId(o.signerId)));
    if (signerVotingPower(state, uniqueSigners) < threshold) continue;
    const jHeight = observations[0]!.jHeight;
    const jBlockHash = observations[0]!.jBlockHash;
    const eventsHash = observationEventsHash(observations[0]!);
    const hashes = thresholdHashesByHeight.get(jHeight) ?? new Set<string>();
    hashes.add(jBlockHash);
    thresholdHashesByHeight.set(jHeight, hashes);
    if (hashes.size > 1) {
      throw new Error(
        `j_event conflict: multiple threshold hashes for block ${jHeight}: ${Array.from(hashes).join(', ')}`,
      );
    }
    const blockKey = `${jHeight}:${jBlockHash}`;
    const eventHashes = thresholdEventHashesByBlock.get(blockKey) ?? new Set<string>();
    eventHashes.add(eventsHash);
    thresholdEventHashesByBlock.set(blockKey, eventHashes);
    if (eventHashes.size > 1) {
      throw new Error(
        `j_event conflict: multiple threshold event sets for block ${blockKey}: ${Array.from(eventHashes).join(', ')}`,
      );
    }
  }

  for (const [_key, observations] of observationGroups) {
    const uniqueSigners = new Set(observations.map(o => normalizeSignerId(o.signerId)));
    const signerCount = uniqueSigners.size;
    const signerPower = signerVotingPower(state, uniqueSigners);

    if (signerPower >= threshold) {
      const jHeight = observations[0]!.jHeight;
      const jBlockHash = observations[0]!.jBlockHash;

      const alreadyInChain = state.jBlockChain.some(b => b.jHeight === jHeight);
      if (alreadyInChain) {
        continue;
      }

      const events = mergeSignerObservations(observations);

      const finalized: JBlockFinalized = {
        jHeight,
        jBlockHash,
        events,
        finalizedAt: state.timestamp, // Entity-level timestamp for determinism across validators
        signerCount,
      };

      // Add to jBlockChain before applying events to prevent duplicate
      // finalization if an event handler clones state.
      state.jBlockChain.push(finalized);
      state.lastFinalizedJHeight = jHeight;
      finalizedHeights.push(jHeight);

      for (const event of events) {
        const { newState, mempoolOps, outputs, dirtyAccounts: eventDirtyAccounts } = await applyFinalizedJEvent(state, event, env);
        state = newState;
        allMempoolOps.push(...mempoolOps);
        allOutputs.push(...outputs);
        for (const accountId of eventDirtyAccounts) dirtyAccounts.add(accountId);
        if (!state.jBlockChain.some(b => b.jHeight === jHeight)) {
          jEventLog.warn('finalize.clone_lost_chain', { height: jHeight });
          state.jBlockChain.push(finalized);
          state.lastFinalizedJHeight = jHeight;
        }
      }

      // Multiple AccountSettled events from the same batch create separate observations
      // and j_event_claims per token. Merge them so tryFinalizeAccountJEvents processes
      // all token updates atomically in one bilateral consensus round.
      for (const [cpId, account] of state.accounts) {
        const leftChanged = mergeAccountJObservations(account.leftJObservations);
        const rightChanged = mergeAccountJObservations(account.rightJObservations);
        if (leftChanged || rightChanged) dirtyAccounts.add(String(cpId).toLowerCase());
      }
      mergeJEventClaimOps(allMempoolOps);
    }
  }

  // Only remove observations for heights that were actually finalized.
  // Keep observations for unfinalized heights (even if lower than highest finalized)
  // to allow out-of-order finalization and detect conflicts.
  if (finalizedHeights.length > 0) {
    const finalizedSet = new Set(finalizedHeights);
    state.jBlockObservations = state.jBlockObservations.filter(
      obs => !finalizedSet.has(obs.jHeight)
    );
  }

  return { newState: state, mempoolOps: allMempoolOps, outputs: allOutputs, dirtyAccounts: Array.from(dirtyAccounts) };
}

function mergeSignerObservations(observations: JBlockObservation[]): JurisdictionEvent[] {
  const eventMap = new Map<string, JurisdictionEvent>();

  for (const obs of observations) {
    const normalized = normalizeJurisdictionEvents(obs.events);
    for (const event of normalized) {
      const key = canonicalJurisdictionEventKey(event);
      if (!eventMap.has(key)) {
        eventMap.set(key, event);
      }
    }
  }

  return Array.from(eventMap.values());
}

async function applyFinalizedJEvent(
  entityState: EntityState,
  event: JurisdictionEvent,
  env: Env
): Promise<JEventApplyResult> {
  const blockNumber = event.blockNumber ?? 0;
  const transactionHash = event.transactionHash || 'unknown';
  const txHashShort = transactionHash.slice(0, 10) + '...';

  const newState = cloneEntityState(entityState);
  const mempoolOps: JEventMempoolOp[] = [];
  const outputs: EntityInput[] = [];
  const dirtyAccounts = new Set<string>();
  const done = (): JEventApplyResult => ({
    newState,
    mempoolOps,
    outputs,
    dirtyAccounts: Array.from(dirtyAccounts),
  });

  if (event.type === 'ReserveUpdated') {
    const { entity, tokenId, newBalance } = event.data;
    const tokenIdNum = Number(tokenId);
    const tokenSymbol = getTokenSymbol(tokenIdNum);
    const decimals = getTokenDecimals(tokenIdNum);
    const balanceDisplay = (Number(newBalance) / (10 ** decimals)).toFixed(4);

    if (String(entity).toLowerCase() === String(entityState.entityId).toLowerCase()) {
      newState.reserves.set(tokenIdNum, BigInt(newBalance as string | number | bigint));
    }

    addMessage(newState, `📊 RESERVE: ${tokenSymbol} = ${balanceDisplay} | Block ${blockNumber} | Tx ${txHashShort}`);

  } else if (event.type === 'SecretRevealed') {
    const { hashlock, secret } = event.data;
    applyKnownHtlcSecret(newState, mempoolOps, outputs, String(hashlock), String(secret), blockNumber, 'SecretRevealed');

  } else if (event.type === 'AccountSettled') {
    const { leftEntity, rightEntity, tokenId, leftReserve, rightReserve, collateral } = event.data;
    const tokenIdNum = Number(tokenId);
    const myEntityId = String(entityState.entityId).toLowerCase();
    const leftId = String(leftEntity).toLowerCase();
    const rightId = String(rightEntity).toLowerCase();
    const myIsLeft = myEntityId === leftId;
    const myIsRight = myEntityId === rightId;
    if (!myIsLeft && !myIsRight) {
      jEventLog.warn('account_settled.wrong_entity', { entity: shortId(entityState.entityId), left: shortId(leftId), right: shortId(rightId) });
      return done();
    }
    const counterpartyEntityId = myIsLeft ? rightEntity : leftEntity;
    const cpShort = String(counterpartyEntityId).slice(-4);
    const ownReserve = myIsLeft ? leftReserve : rightReserve;
    const tokenSymbol = getTokenSymbol(tokenIdNum);
    const decimals = getTokenDecimals(tokenIdNum);

    if (ownReserve) {
      const newReserve = BigInt(ownReserve as string | number | bigint);
      newState.reserves.set(tokenIdNum, newReserve);
    } else {
      jEventLog.warn('account_settled.reserve_missing', { counterparty: shortId(cpShort), tokenId: tokenIdNum });
    }

    // Account deltas move only through bilateral account-frame consensus.
    const account = newState.accounts.get(counterpartyEntityId as string);
    if (!account) {
      jEventLog.warn('account_settled.account_missing', { counterparty: shortId(cpShort) });
      return done();
    }
    dirtyAccounts.add(String(counterpartyEntityId).toLowerCase());

    if (!account.leftJObservations) account.leftJObservations = [];
    if (!account.rightJObservations) account.rightJObservations = [];
    if (!account.jEventChain) account.jEventChain = [];
    if (account.lastFinalizedJHeight === undefined) account.lastFinalizedJHeight = 0;

    const jHeight = event.blockNumber ?? blockNumber;
    const jBlockHash = event.blockHash || '';

    // The claim uses normalized payload so both sides hash the same data.
    const normalizedClaimEvents = normalizeJurisdictionEvents([event]);
    if (normalizedClaimEvents.length !== 1) {
      jEventLog.warn('account_settled.claim_normalize_failed', { tokenId: tokenIdNum, counterparty: shortId(cpShort), block: blockNumber });
      return done();
    }
    const normalizedClaimEvent = normalizedClaimEvents[0];
    if (!normalizedClaimEvent) return done();
    const eventCopy = structuredClone(normalizedClaimEvent);
    const observedAt = entityState.timestamp || 0;
    mempoolOps.push({
      accountId: counterpartyEntityId as string,
      tx: { type: 'j_event_claim', data: { jHeight, jBlockHash, events: [eventCopy], observedAt } },
    });
    const p2p = env.runtimeState?.p2p as { sendDebugEvent?: (payload: unknown) => boolean } | undefined;
    if (typeof p2p?.sendDebugEvent === 'function') {
      p2p.sendDebugEvent({
        level: 'info',
        code: 'REB_STEP',
        step: 4,
        status: 'ok',
        event: 'j_event_claim_queued',
        entityId: entityState.entityId,
        counterpartyId: String(counterpartyEntityId),
        tokenId: tokenIdNum,
        jHeight,
      });
    }

    const collDisplay = (Number(collateral) / (10 ** decimals)).toFixed(4);
    addMessage(newState, `⚖️ OBSERVED: ${tokenSymbol} ${cpShort} | coll=${collDisplay} | j-block ${blockNumber} (awaiting 2-of-2)`);

  } else if (event.type === 'DebtCreated') {
    const { debtor, creditor, tokenId, amount } = event.data;
    const tokenSymbol = getTokenSymbol(tokenId as number);
    const decimals = getTokenDecimals(tokenId as number);
    const amountDisplay = (Number(amount) / (10 ** decimals)).toFixed(4);
    applyDebtCreated(newState, event);

    addMessage(newState, `🔴 DEBT: ${(debtor as string).slice(-8)} owes ${amountDisplay} ${tokenSymbol} to ${(creditor as string).slice(-8)} | Block ${blockNumber}`);

  } else if (event.type === 'DebtEnforced') {
    const { creditor, tokenId, amountPaid } = event.data;
    const tokenSymbol = getTokenSymbol(tokenId as number);
    const decimals = getTokenDecimals(tokenId as number);
    const paidDisplay = (Number(amountPaid) / (10 ** decimals)).toFixed(4);
    applyDebtEnforced(newState, event);

    addMessage(newState, `✅ DEBT PAID: ${paidDisplay} ${tokenSymbol} to ${(creditor as string).slice(-8)} | Block ${blockNumber}`);

  } else if (event.type === 'DebtForgiven') {
    const { debtor, creditor, tokenId, amountForgiven, debtIndex } = event.data;
    const tokenSymbol = getTokenSymbol(tokenId as number);
    const decimals = getTokenDecimals(tokenId as number);
    const forgivenDisplay = (Number(amountForgiven) / (10 ** decimals)).toFixed(4);
    applyDebtForgiven(newState, event);

    addMessage(newState, `🩶 DEBT FORGIVEN: ${forgivenDisplay} ${tokenSymbol} between ${(debtor as string).slice(-8)} and ${(creditor as string).slice(-8)} | Block ${blockNumber} · debt #${debtIndex}`);

  } else if (event.type === 'DisputeStarted') {
    const { sender, counterentity, nonce, proofbodyHash } = event.data as {
      sender: string;
      counterentity: string;
      nonce: string;
      proofbodyHash: string;
      starterInitialArguments: string;
      starterIncrementedArguments: string;
    };
    const normalizeId = (id: string) => String(id).toLowerCase();
    const senderStr = normalizeId(sender as string);
    const counterentityStr = normalizeId(counterentity as string);
    const entityIdNorm = normalizeId(newState.entityId);

    const candidateCounterpartyId = senderStr === entityIdNorm ? counterentityStr : senderStr;
    let counterpartyId = candidateCounterpartyId;
    let account = newState.accounts.get(counterpartyId);
    if (!account) {
      for (const [key, value] of newState.accounts.entries()) {
        if (normalizeId(key) === candidateCounterpartyId) {
          counterpartyId = key;
          account = value;
          break;
        }
      }
    }

    if (account) {
      dirtyAccounts.add(counterpartyId.toLowerCase());
      account.status = 'disputed';
      const weAreStarter = senderStr === entityIdNorm;
      const disputeEventData = event.data as typeof event.data & {
        disputeTimeout?: unknown;
        onChainNonce?: unknown;
      };
      const disputeTimeout =
        Number(disputeEventData.disputeTimeout ?? 0) ||
        (
          Number(blockNumber || 0) +
          getRuntimeJurisdictionDefaultDisputeDelayBlocks(env, newState.config.jurisdiction?.name, 5)
        );
      const onChainNonce = Number(disputeEventData.onChainNonce ?? nonce);

      // Unified nonce: initialNonce = the nonce used in disputeStart (from event)
      // onChainNonce defaults to the dispute nonce when no richer event payload exists.
      account.activeDispute = {
        startedByLeft: senderStr < counterentityStr,
        initialProofbodyHash: String(proofbodyHash),  // From event (committed on-chain)
        initialNonce: Number(nonce),
        disputeTimeout,
        onChainNonce,
        starterInitialArguments: event.data.starterInitialArguments || '0x',
        starterIncrementedArguments: event.data.starterIncrementedArguments || '0x',
        finalizeQueued: false,
      };
      account.onChainSettlementNonce = Math.max(Number(account.onChainSettlementNonce ?? 0), onChainNonce);

      const { buildAccountProofBody } = await import('../proof-builder');
      const localProof = buildAccountProofBody(account);
      if (localProof.proofBodyHash !== account.activeDispute.initialProofbodyHash) {
        jEventLog.error('dispute.proof_hash_mismatch', { counterparty: shortId(counterpartyId), local: shortHash(localProof.proofBodyHash), onChain: shortHash(account.activeDispute.initialProofbodyHash) });
      }

      const starterInitialArguments = event.data.starterInitialArguments || '0x';
      const disputeSecrets = decodeDisputeStarterInitialSecrets(starterInitialArguments);
      if (disputeSecrets.length > 0) {
        for (const disputeSecret of disputeSecrets) {
          const hashlock = hashHtlcSecret(disputeSecret);
          applyKnownHtlcSecret(newState, mempoolOps, outputs, hashlock, disputeSecret, blockNumber, 'DisputeStarted');
        }
      }
      queueCrossJurisdictionSalvageFromDispute(
        newState,
        outputs,
        counterpartyId,
        starterInitialArguments,
        blockNumber,
      );
      queueCrossJurisdictionSourceDisputeFromTargetDispute(
        env,
        newState,
        outputs,
        counterpartyId,
        starterInitialArguments,
      );

      addMessage(newState, `⚔️ DISPUTE ${weAreStarter ? 'STARTED' : 'vs us'} with ${counterpartyId.slice(-4)}, timeout: block ${account.activeDispute.disputeTimeout}`);
      if (!weAreStarter) {
        const ops = emptyOpBreakdown();
        ops.disputeStarts = 1;
        appendBatchHistory(newState, {
          batchHash: `event:dispute-start:${String(proofbodyHash).slice(0, 12)}`,
          txHash: transactionHash || '',
          status: 'confirmed' as const,
          broadcastedAt: newState.timestamp,
          confirmedAt: newState.timestamp,
          opCount: 1,
          entityNonce: Number(nonce || 0),
          jBlockNumber: Number(blockNumber || 0),
          batch: {
            flashloans: [],
            reserveToReserve: [],
            reserveToCollateral: [],
            collateralToReserve: [],
            settlements: [],
            disputeStarts: [{
              counterentity: counterpartyId,
              nonce: Number(nonce || 0),
              proofbodyHash: String(proofbodyHash || '0x'),
              sig: '0x',
              starterInitialArguments: String(starterInitialArguments || '0x'),
              starterIncrementedArguments: String(event.data.starterIncrementedArguments || '0x'),
            }],
            disputeFinalizations: [],
            externalTokenToReserve: [],
            reserveToExternalToken: [],
            revealSecrets: [],
            hub_id: 0,
          },
          operations: ops,
          source: 'counterparty-event' as const,
          eventType: 'DisputeStarted' as const,
          note: `Counterparty ${senderStr.slice(-4)} started dispute`,
        });
      }

      if (newState.crontabState) {
        const kickoffDelayMs = weAreStarter ? 1 : 5000;
        const logicalTimestamp =
          Number.isFinite(Number(newState.timestamp)) && Number(newState.timestamp) >= 0
            ? Number(newState.timestamp)
            : 0;
        scheduleCrontabHook(newState.crontabState, {
          id: `dispute-deadline:${counterpartyId.toLowerCase()}`,
          triggerAt: logicalTimestamp + kickoffDelayMs,
          type: 'dispute_deadline',
          data: { accountId: counterpartyId },
        });
        markStorageEntityDirty(env, newState.entityId);
      }
    } else {
      jEventLog.warn('dispute_started.account_missing', { account: shortId(candidateCounterpartyId), entity: shortId(entityIdNorm) });
    }

  } else if (event.type === 'DisputeFinalized') {
    const { sender, counterentity, initialNonce, initialProofbodyHash } = event.data as { sender: string; counterentity: string; initialNonce: string; initialProofbodyHash: string; finalProofbodyHash: string };
    const normalizeId = (id: string) => String(id).toLowerCase();
    const senderStr = normalizeId(sender as string);
    const counterentityStr = normalizeId(counterentity as string);
    const entityIdNorm = normalizeId(newState.entityId);

    const candidateCounterpartyId = senderStr === entityIdNorm ? counterentityStr : senderStr;
    let counterpartyId = candidateCounterpartyId;
    let account = newState.accounts.get(counterpartyId);
    if (!account) {
      for (const [key, value] of newState.accounts.entries()) {
        if (normalizeId(key) === candidateCounterpartyId) {
          counterpartyId = key;
          account = value;
          break;
        }
      }
    }

    if (account) {
      dirtyAccounts.add(counterpartyId.toLowerCase());
      const weAreFinalizer = senderStr === entityIdNorm;
      const finalProofbodyHash = String(event.data.finalProofbodyHash || '0x');
      const finalizedOnChainNonce = Math.max(
        Number(account.onChainSettlementNonce ?? 0),
        Number(initialNonce || 0),
      );
      account.onChainSettlementNonce = finalizedOnChainNonce;
      if (account.activeDispute) {
        delete account.activeDispute;
        addMessage(newState, `✅ DISPUTE FINALIZED with ${counterpartyId.slice(-4)} (nonce ${Number(initialNonce)})`);
        if (newState.crontabState) {
          cancelCrontabHook(newState.crontabState, `dispute-deadline:${counterpartyId.toLowerCase()}`);
          markStorageEntityDirty(env, newState.entityId);
        }
      } else {
        jEventLog.warn('dispute_finalized.no_active_dispute', { counterparty: shortId(counterpartyId) });
      }
      if (account.proofHeader.nonce <= finalizedOnChainNonce) {
        account.proofHeader.nonce = finalizedOnChainNonce + 1;
      }
      account.status = 'disputed';
      delete account.pendingFrame;
      delete account.pendingAccountInput;
      delete account.clonedForValidation;
      account.rollbackCount = 0;
      delete account.lastRollbackFrameHash;
      delete account.counterpartyDisputeProofHanko;
      delete account.counterpartyDisputeProofNonce;
      delete account.counterpartyDisputeProofBodyHash;
      if (!weAreFinalizer) {
        const ops = emptyOpBreakdown();
        ops.disputeFinalizations = 1;
        appendBatchHistory(newState, {
          batchHash: `event:dispute-finalize:${String(initialProofbodyHash).slice(0, 12)}`,
          txHash: transactionHash || '',
          status: 'confirmed' as const,
          broadcastedAt: newState.timestamp,
          confirmedAt: newState.timestamp,
          opCount: 1,
          entityNonce: Number(initialNonce || 0),
          jBlockNumber: Number(blockNumber || 0),
          batch: {
            flashloans: [],
            reserveToReserve: [],
            reserveToCollateral: [],
            collateralToReserve: [],
            settlements: [],
            disputeStarts: [],
            disputeFinalizations: [{
              counterentity: counterpartyId,
              initialNonce: Number(initialNonce || 0),
              finalNonce: Number(initialNonce || 0),
              initialProofbodyHash: String(initialProofbodyHash || '0x'),
              finalProofbody: {
                offdeltas: [],
                tokenIds: [],
                transformers: [],
              },
              leftArguments: '0x',
              rightArguments: '0x',
              starterInitialArguments: '0x',
              starterIncrementedArguments: '0x',
              sig: '0x',
              startedByLeft: false,
              disputeUntilBlock: Number(blockNumber || 0),
              cooperative: false,
            }],
            externalTokenToReserve: [],
            reserveToExternalToken: [],
            revealSecrets: [],
            hub_id: 0,
          },
          operations: ops,
          source: 'counterparty-event' as const,
          eventType: 'DisputeFinalized' as const,
          note: `Counterparty ${senderStr.slice(-4)} finalized dispute`,
        });
      }

      // Drop stale local draft dispute-finalize ops for this account.
      // If the dispute is already finalized on-chain, re-broadcasting the same finalize
      // in a future mixed batch can revert the whole batch.
      const removedDraft = scrubDisputeFinalizationsForCounterparty(
        newState.jBatchState?.batch,
        candidateCounterpartyId,
      );
      const removedSent = scrubDisputeFinalizationsForCounterparty(
        newState.jBatchState?.sentBatch?.batch,
        candidateCounterpartyId,
      );
      const removed = removedDraft + removedSent;
      if (removed > 0) {
        addMessage(newState, `🧹 Removed ${removed} stale dispute-finalize op(s) for ${counterpartyId.slice(-4)}`);
      }

      // DisputeFinalized is authoritative. Clear the off-chain component and transient holds
      // using locally stored proof-body knowledge only.
      const finalizedProofBody = finalProofbodyHash
        ? account.disputeProofBodiesByHash?.[finalProofbodyHash] as { tokenIds?: unknown[]; offdeltas?: unknown[] } | undefined
        : undefined;
      if (finalizedProofBody && Array.isArray(finalizedProofBody.tokenIds) && Array.isArray(finalizedProofBody.offdeltas)) {
        for (let i = 0; i < finalizedProofBody.tokenIds.length; i += 1) {
          const tokenId = Number(finalizedProofBody.tokenIds[i]);
          const delta = account.deltas.get(tokenId);
          if (!delta) continue;
          delta.offdelta = 0n;
          delta.leftHold = 0n;
          delta.rightHold = 0n;
          delta.leftAllowance = 0n;
          delta.rightAllowance = 0n;
        }
      } else {
        jEventLog.warn('dispute_finalized.proof_body_missing', { counterparty: shortId(counterpartyId) });
        for (const delta of account.deltas.values()) {
          delta.offdelta = 0n;
          delta.leftHold = 0n;
          delta.rightHold = 0n;
          delta.leftAllowance = 0n;
          delta.rightAllowance = 0n;
        }
      }

      // Drop off-chain intents from pre-dispute epoch.
      if (account.swapOffers.size > 0) {
        account.swapOffers.clear();
      }
      if (account.locks.size > 0) {
        account.locks.clear();
      }
    } else {
      jEventLog.warn('dispute_finalized.account_missing', { account: shortId(candidateCounterpartyId), entity: shortId(entityIdNorm) });
    }

  } else if (event.type === 'HankoBatchProcessed') {
    await applyHankoBatchProcessedEvent({ newState, event, transactionHash, blockNumber, dirtyAccounts });

  } else {
    // Unknown event - log but don't fail
    addMessage(newState, `⚠️ Unknown j-event: ${event.type} | Block ${blockNumber}`);
    jEventLog.warn('unknown_event', { type: event.type, canonical: CANONICAL_J_EVENTS });
  }

  return done();
}

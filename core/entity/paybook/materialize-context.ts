import { deriveDelta } from '../../account/utils';
import { getAccountPerspective } from '../../account/state/perspective';
import { accountInputProposal } from '../../account/consensus/flush';
import type { AccountTx } from '../../types/account';
import type { EntityTx } from '../../types/entity-tx';
import {
  preparedHtlcBindingKey,
  type HtlcPreparedInfraContext,
  type PreparedHtlcEntry,
} from '../../types/entity/htlc-infra-context';
import { computeHtlcEnvelopeContextHash , unwrapEnvelope, validateEnvelope } from '../../protocol/htlc/codec/envelope';
import {
  assertEntityEncryptionKeypair,
  assertOpaqueHtlcCiphertext,
  decryptOpaqueHtlcBytes,
  HtlcCiphertextAuthenticationError,
  isDecryptedOpaqueHtlcLayerPrimed,
  primeDecryptedOpaqueHtlcLayer,
} from '../../protocol/htlc/multi-recipient';
import { encryptedHtlcLayer, hashEncryptedHtlcLayer } from '../../protocol/htlc/codec/onion-layer';
import type { EntityState } from '../types';
import { findAccountKey } from '../tx/account-key';
import { HTLC } from '../../config/constants';
import { calculateDirectionalFeePPM, calculateHopFee, sanitizeBaseFee, sanitizeFeePPM } from '../../pathfinding/fees';
import type { Profile } from '../profile';
import { assertOriginatedHtlcPayments, materializeOriginatedHtlcPayments } from './payment-admission';
import type { EntityInfraContext } from '../../types/entity/infra-context';
import { canonicalConsensusValuesEqual } from '../../protocol/serialization/binary-codec';
import { validateHtlcPreparedInfraContext } from './prepared-context-validation';
import { getEffectiveEntityInputTxs } from '../consensus/output/envelope';
import { resolveCanonicalEntityBoardShares } from '../auth/authorization';
import { normalizeAccountStateDomain } from '../../account/commitment/state-root';
import { cryptoPoolEnabled, decryptOnionLayersBatch, type OnionJobItem } from '../../protocol/crypto/crypto-pool';
import { countOp, OP_COUNTERS_ENABLED } from '../../support/performance/op-counters';
import { getPerfMs } from '../../support/time';
import { RecencyMemo } from '../../support/collections/recency-memo';
import { timePerfPhase } from '../../support/performance/profile';
import { compareStableText } from '../../protocol/serialization';

export type MaterializeHtlcPreparedContextInput = Readonly<{
  state: EntityState;
  proposalTxs: readonly EntityTx[];
  entityEncryptionPublicKey: string;
  entityEncryptionPrivateKey: string;
  isEntityOnline(entityId: string): boolean;
  profiles: readonly Profile[];
  parentFrameHash: string;
  height: number;
  resolveRoute(tx: Extract<EntityTx, { type: 'htlcPayment' }>): Promise<readonly string[]>;
}>;

export type AssertHtlcPreparedInfraContextInput = Readonly<{
  state: EntityState;
  proposalTxs: readonly EntityTx[];
  context: EntityInfraContext;
  entityEncryptionPrivateKey: string;
}>;

/** Reducer-visible txs whose HTLC facts must be committed by the frame context. */
export const getEffectiveHtlcFrameTxs = (
  state: EntityState,
  proposalTxs: readonly EntityTx[],
): EntityTx[] => {
  const shares = resolveCanonicalEntityBoardShares(state.config);
  const expand = (tx: EntityTx): EntityTx[] => {
    if (tx.type === 'entityCommand') return tx.data.txs.flatMap(expand);
    if (tx.type === 'propose' && tx.data.action.type === 'entity_transaction') {
      const proposerShare = shares.bySigner.get(tx.data.proposer.trim().toLowerCase()) ?? 0n;
      return proposerShare >= state.config.threshold ? tx.data.action.data.txs.flatMap(expand) : [];
    }
    if (tx.type === 'vote') {
      const proposal = state.proposals.get(tx.data.proposalId);
      if (!proposal || tx.data.choice !== 'yes') return [];
      const currentYes = [...proposal.votes.entries()].reduce((total, [signerId, rawVote]) => {
        const choice = typeof rawVote === 'object' ? rawVote.choice : rawVote;
        return choice === 'yes' ? total + (shares.bySigner.get(signerId) ?? 0n) : total;
      }, 0n);
      const voterShare = proposal.votes.has(tx.data.voter.trim().toLowerCase())
        ? 0n
        : (shares.bySigner.get(tx.data.voter.trim().toLowerCase()) ?? 0n);
      return currentYes + voterShare >= state.config.threshold && proposal.action.type === 'entity_transaction'
        ? proposal.action.data.txs.flatMap(expand)
        : [];
    }
    return [tx];
  };
  return getEffectiveEntityInputTxs({ entityTxs: [...proposalTxs] }).flatMap(expand);
};

const reject = (
  binding: PreparedHtlcEntry['binding'],
  reason: Extract<PreparedHtlcEntry['outcome'], { kind: 'reject' }>['reason'],
): PreparedHtlcEntry => ({
  binding,
  outcome: { kind: 'reject', reason },
});

type AccountInputTx = Extract<EntityTx, { type: 'accountInput' }>;
type HtlcLockTx = Extract<AccountTx, { type: 'htlc_lock' }>;
type PreparedEnvelope = ReturnType<typeof unwrapEnvelope>;

// Ingress priming, wire fitting and materialization all derive the same
// binding and AAD context hash from one lock tx object; derive once per object.
type InboundBindingMemo = { binding: PreparedHtlcEntry['binding']; contextHash: string };
const inboundBindingMemos = new RecencyMemo<HtlcLockTx, InboundBindingMemo>(16_384);

const inboundBindingWithContext = (
  tx: AccountInputTx,
  proposal: NonNullable<ReturnType<typeof accountInputProposal>>,
  accountTx: HtlcLockTx,
): InboundBindingMemo => {
  const hit = inboundBindingMemos.get(accountTx);
  if (
    hit
    && hit.binding.accountFrameHash === proposal.frame.stateHash.toLowerCase()
    && hit.binding.fromEntityId === tx.data.fromEntityId.toLowerCase()
  ) {
    // Every entry owns its binding (see buildInboundBinding on shared references).
    return { binding: { ...hit.binding, domain: { ...hit.binding.domain } }, contextHash: hit.contextHash };
  }
  const binding = buildInboundBinding(tx, proposal, accountTx);
  const contextHash = computeHtlcEnvelopeContextHash({
    fromEntityId: binding.fromEntityId, toEntityId: binding.toEntityId,
    domain: binding.domain, hashlock: binding.hashlock,
    tokenId: binding.tokenId, amount: binding.amount, timelock: binding.timelock,
    revealBeforeHeight: binding.revealBeforeHeight,
  });
  const entry = { binding, contextHash };
  inboundBindingMemos.set(accountTx, entry);
  return entry;
};

const buildInboundBinding = (
  tx: AccountInputTx,
  proposal: NonNullable<ReturnType<typeof accountInputProposal>>,
  accountTx: HtlcLockTx,
): PreparedHtlcEntry['binding'] => {
  const layer = encryptedHtlcLayer(accountTx.data.envelope);
  if (!layer) throw new Error(`HTLC_PREPARED_LAYER_REQUIRED:${accountTx.data.lockId}`);
  if (accountTx.data.lockId.toLowerCase() !== accountTx.data.hashlock.toLowerCase()) {
    throw new Error(`PAYBOOK_LOCK_ID_MUST_EQUAL_HASHLOCK:${accountTx.data.lockId}:${accountTx.data.hashlock}`);
  }
  return {
    fromEntityId: tx.data.fromEntityId.toLowerCase(),
    toEntityId: tx.data.toEntityId.toLowerCase(),
    // Each binding owns canonical domain bytes. Reusing one input object across
    // batched locks makes protocol values depend on JavaScript object identity
    // and triggers Bun's known repeated-reference structuredClone corruption.
    domain: normalizeAccountStateDomain(tx.data.domain, 'HTLC_PREPARED_DOMAIN'),
    accountFrameHash: proposal.frame.stateHash.toLowerCase(),
    accountHeight: proposal.frame.height,
    envelopeHash: hashEncryptedHtlcLayer(layer),
    hashlock: accountTx.data.hashlock.toLowerCase(),
    tokenId: accountTx.data.tokenId,
    amount: accountTx.data.amount,
    timelock: accountTx.data.timelock,
    revealBeforeHeight: accountTx.data.revealBeforeHeight,
  };
};

// The same inbound lock is decrypted by the wire-budget fit (per attempt), by
// the proposal and by validator replay of the same frame. The X25519+cipher
// round is pure in (ciphertext, AAD, keys), so memoize by content.
type DecryptedInboundEnvelope = PreparedEnvelope | { rejectReason: 'decrypt_failed' | 'ciphertext_invalid' };
const decryptedInboundEnvelopes = new Map<string, DecryptedInboundEnvelope>();
const DECRYPTED_ENVELOPE_MEMO_MAX = 65_536;

const decryptInboundEnvelope = (
  input: MaterializeHtlcPreparedContextInput,
  accountTx: HtlcLockTx,
  binding: PreparedHtlcEntry['binding'],
  contextHash: string,
): PreparedEnvelope | PreparedHtlcEntry => {
  const key = `${input.entityEncryptionPublicKey}|${binding.envelopeHash}|${contextHash}`;
  let result = decryptedInboundEnvelopes.get(key);
  if (result === undefined) {
    result = decryptInboundEnvelopeUncached(input, accountTx, contextHash);
    if (decryptedInboundEnvelopes.size >= DECRYPTED_ENVELOPE_MEMO_MAX) decryptedInboundEnvelopes.clear();
    decryptedInboundEnvelopes.set(key, result);
  }
  return 'rejectReason' in result ? reject(binding, result.rejectReason) : result;
};

const decryptInboundEnvelopeUncached = (
  input: MaterializeHtlcPreparedContextInput,
  accountTx: HtlcLockTx,
  contextHash: ReturnType<typeof computeHtlcEnvelopeContextHash>,
): DecryptedInboundEnvelope => {
  const layer = encryptedHtlcLayer(accountTx.data.envelope)!;
  let plaintext: Uint8Array;
  try {
    plaintext = decryptOpaqueHtlcBytes(
      layer,
      input.entityEncryptionPublicKey,
      input.entityEncryptionPrivateKey,
      contextHash,
    );
  } catch (error) {
    if (!(error instanceof HtlcCiphertextAuthenticationError)) throw error;
    return { rejectReason: 'decrypt_failed' };
  }
  try {
    const envelope = unwrapEnvelope(plaintext);
    validateEnvelope(envelope);
    return envelope;
  } catch {
    return { rejectReason: 'ciphertext_invalid' };
  }
};

const materializeForwardOutcome = (
  input: MaterializeHtlcPreparedContextInput,
  binding: PreparedHtlcEntry['binding'],
  envelope: Exclude<PreparedEnvelope, { finalRecipient: unknown }>,
): PreparedHtlcEntry => {
  const nextHopEntityId = envelope.nextHop.toLowerCase();
  const accountKey = findAccountKey(input.state, nextHopEntityId);
  const account = accountKey === null ? undefined : input.state.accounts.get(accountKey);
  if (!account) return reject(binding, 'next_hop_account_missing');
  if (!input.isEntityOnline(nextHopEntityId)) return reject(binding, 'next_hop_offline');
  const delta = account.state.deltas.get(binding.tokenId);
  const forwardAmount = BigInt(envelope.forwardAmount);
  if (!delta) return reject(binding, 'insufficient_capacity');
  const capacity = deriveDelta(delta, getAccountPerspective(account.state, input.state.entityId).iAmLeft);
  if (capacity.outCapacity < forwardAmount) return reject(binding, 'insufficient_capacity');
  const config = input.state.hubRebalanceConfig;
  const requiredFee = calculateHopFee(
    binding.amount,
    calculateDirectionalFeePPM(
      sanitizeFeePPM(config?.routingFeePPM ?? 1, 1),
      capacity.outCapacity,
      capacity.inCapacity,
    ),
    sanitizeBaseFee(config?.baseFee ?? 0n),
  );
  if (binding.amount - forwardAmount < requiredFee) return reject(binding, 'fee_below_policy');
  if (
    binding.timelock - BigInt(HTLC.MIN_TIMELOCK_DELTA_MS)
      <= BigInt(input.state.timestamp) + BigInt(HTLC.MIN_FORWARD_TIMELOCK_MS)
    || binding.revealBeforeHeight - HTLC.MIN_REVEAL_HEIGHT_DELTA_BLOCKS
      <= input.state.lastFinalizedJHeight
  ) return reject(binding, 'deadline_unsafe');
  return {
    binding,
    outcome: {
      kind: 'forward',
      nextHopEntityId,
      forwardAmount,
      // Own a 2-key ciphertext object. The decrypt memo returns the onion
      // layer; sharing that innerEnvelope across bindings is the same class
      // of Bun structuredClone aliasing as a reused domain object.
      innerEnvelope: assertOpaqueHtlcCiphertext(envelope.innerEnvelope),
    },
  };
};

const materializeInboundEntry = (
  input: MaterializeHtlcPreparedContextInput,
  tx: AccountInputTx,
  proposal: NonNullable<ReturnType<typeof accountInputProposal>>,
  accountTx: HtlcLockTx,
): PreparedHtlcEntry => {
  const { binding, contextHash } = inboundBindingWithContext(tx, proposal, accountTx);
  const envelope = decryptInboundEnvelope(input, accountTx, binding, contextHash);
  if ('binding' in envelope) return envelope;
  if ('finalRecipient' in envelope) {
    return {
      binding,
      outcome: {
        kind: 'final', secret: envelope.secret,
        ...(envelope.description !== undefined ? { description: envelope.description } : {}),
        ...(envelope.startedAtMs !== undefined ? { startedAtMs: envelope.startedAtMs } : {}),
      },
    };
  }
  return materializeForwardOutcome(input, binding, envelope);
};

const collectInboundEntries = (
  input: MaterializeHtlcPreparedContextInput,
): PreparedHtlcEntry[] => input.proposalTxs.flatMap(tx => {
  if (tx.type !== 'accountInput') return [];
  const proposal = accountInputProposal(tx.data);
  if (!proposal) return [];
  return proposal.frame.accountTxs.flatMap(accountTx =>
    accountTx.type === 'htlc_lock' && accountTx.data.envelope !== undefined
      ? [materializeInboundEntry(input, tx, proposal, accountTx)]
      : []);
});

/**
 * Exact ordered-prefix fingerprint available to WAL replay without repeating
 * X25519 decryption. A persisted context can only describe a FIFO proposal
 * prefix whose inbound binding set is exactly this set.
 */
export const collectInboundHtlcBindingKeys = (
  state: EntityState,
  proposalTxs: readonly EntityTx[],
): string[] => {
  const keys = getEffectiveHtlcFrameTxs(state, proposalTxs).flatMap(tx => {
    if (tx.type !== 'accountInput') return [];
    const proposal = accountInputProposal(tx.data);
    if (!proposal) return [];
    return proposal.frame.accountTxs.flatMap(accountTx =>
      accountTx.type === 'htlc_lock' && accountTx.data.envelope !== undefined
        ? [preparedHtlcBindingKey(inboundBindingWithContext(tx, proposal, accountTx).binding)]
        : []);
  });
  return [...new Set(keys)].sort(compareStableText);
};

/**
 * One Account frame can reach a proposer twice in the same Runtime frame — a
 * peer retransmits, or the same proposal arrives over two transports — and
 * batching makes that ordinary rather than rare, because a wider frame covers
 * a wider delivery window. Two materializations of the same lock are the same
 * fact, so an identical repeat collapses. Only a genuine contradiction, two
 * different outcomes claimed for one lock, is a fault worth halting on.
 */
const canonicalizeInboundEntries = (entries: PreparedHtlcEntry[]): PreparedHtlcEntry[] => {
  const decorated = entries.map(entry => ({ key: preparedHtlcBindingKey(entry.binding), entry }));
  decorated.sort((left, right) => compareStableText(left.key, right.key));
  const canonical: PreparedHtlcEntry[] = [];
  for (const { entry } of decorated) {
    const previous = canonical[canonical.length - 1];
    if (
      previous === undefined ||
      previous.binding.accountFrameHash !== entry.binding.accountFrameHash ||
      previous.binding.hashlock !== entry.binding.hashlock
    ) {
      canonical.push(entry);
      continue;
    }
    if (!canonicalConsensusValuesEqual(previous, entry)) {
      throw new Error(
        `HTLC_PREPARED_BINDING_CONFLICT:${entry.binding.accountFrameHash}:${entry.binding.hashlock}`,
      );
    }
  }
  return canonical;
};

/**
 * Every inbound lock layer costs one X25519 scalar multiplication plus an AEAD
 * open. On a Hub that is thousands per frame; the crypto pool decrypts them
 * in parallel and warms the layer memo, so the synchronous walk below only
 * unwraps plaintext. Failures are left to the synchronous path to classify.
 */
type LayerPrimingInput = Pick<MaterializeHtlcPreparedContextInput, 'state' | 'proposalTxs' | 'entityEncryptionPublicKey' | 'entityEncryptionPrivateKey'>;

// Priming started at proposal start overlaps selection and fit; materialize
// awaits it and then primes only what that pass did not cover.
let inflightLayerPriming: { txs: readonly EntityTx[]; done: Promise<void> } | null = null;

/** Fire-and-forget: decrypt this proposal's inbound layers on the pool while the main thread selects/fits. */
export const startInboundLayerPriming = (input: LayerPrimingInput): void => {
  if (!cryptoPoolEnabled()) return;
  const effective = { ...input, proposalTxs: getEffectiveHtlcFrameTxs(input.state, input.proposalTxs) };
  const done = primeInboundLayerDecryption(effective).catch(() => undefined);
  const entry = { txs: effective.proposalTxs, done };
  inflightLayerPriming = entry;
  void done.finally(() => {
    if (inflightLayerPriming === entry) inflightLayerPriming = null;
  });
};

/**
 * Ingress priming: inputs arrive while the main thread is still applying the
 * previous frame, so pool decryption started here overlaps real work. Results
 * only warm the layer memo; nothing is awaited.
 */
export const primeInboundLayersAtIngress = (input: LayerPrimingInput): void => {
  if (!cryptoPoolEnabled()) return;
  void primeInboundLayerDecryption({ ...input, proposalTxs: getEffectiveHtlcFrameTxs(input.state, input.proposalTxs) })
    .catch(() => undefined);
};

const isPrefixOf = (prefix: readonly EntityTx[], whole: readonly EntityTx[]): boolean =>
  prefix.length <= whole.length && prefix.every((tx, index) => whole[index] === tx);

const primeInboundLayerDecryption = async (input: LayerPrimingInput): Promise<void> => {
  if (!cryptoPoolEnabled()) return;
  const startedAt = OP_COUNTERS_ENABLED ? getPerfMs() : 0;
  const items: OnionJobItem[] = [];
  for (const tx of input.proposalTxs) {
    if (tx.type !== 'accountInput') continue;
    const proposal = accountInputProposal(tx.data);
    if (!proposal) continue;
    for (const accountTx of proposal.frame.accountTxs) {
      if (accountTx.type !== 'htlc_lock' || accountTx.data.envelope === undefined) continue;
      const layer = encryptedHtlcLayer(accountTx.data.envelope);
      if (!layer) continue;
      const { contextHash } = inboundBindingWithContext(tx, proposal, accountTx);
      if (isDecryptedOpaqueHtlcLayerPrimed(layer, input.entityEncryptionPublicKey, contextHash)) continue;
      items.push({
        ciphertext: layer,
        publicKey: input.entityEncryptionPublicKey,
        privateKey: input.entityEncryptionPrivateKey,
        contextHash,
      });
    }
  }
  countOp('htlc.onion.prime.collect', items.length, OP_COUNTERS_ENABLED ? Math.round((getPerfMs() - startedAt) * 1_000) : 0);
  if (items.length === 0) return;
  const awaitedAt = OP_COUNTERS_ENABLED ? getPerfMs() : 0;
  const results = await decryptOnionLayersBatch(items);
  countOp('htlc.onion.prime.await', items.length, OP_COUNTERS_ENABLED ? Math.round((getPerfMs() - awaitedAt) * 1_000) : 0);
  if (!results) return;
  let primed = 0;
  results.forEach((result, index) => {
    const item = items[index];
    if (!item || !(result instanceof Uint8Array)) return;
    primeDecryptedOpaqueHtlcLayer(item.ciphertext, item.publicKey, item.contextHash, result);
    primed += 1;
  });
  countOp('htlc.onion.prime.primed', primed);
};

/** Proposer-only materialization. Validators replay only the returned bytes. */
export const materializeHtlcPreparedInfraContext = async (
  input: MaterializeHtlcPreparedContextInput,
): Promise<HtlcPreparedInfraContext> => {
  // Infrastructure/key provisioning failures are never peer-rejectable data.
  // Validate once, outside the attacker-controlled envelope loop, and fail loud.
  assertEntityEncryptionKeypair(input.entityEncryptionPublicKey, input.entityEncryptionPrivateKey);
  const effectiveInput = { ...input, proposalTxs: getEffectiveHtlcFrameTxs(input.state, input.proposalTxs) };
  const inflight = inflightLayerPriming;
  if (inflight) await timePerfPhase('htlc.materialize.awaitPrime', () => inflight.done);
  // A fitted prefix of the candidate set is already covered by that pass.
  if (!inflight || !isPrefixOf(effectiveInput.proposalTxs, inflight.txs)) {
    await timePerfPhase('htlc.materialize.prime', () => primeInboundLayerDecryption(effectiveInput));
  }
  const entries = timePerfPhase('htlc.materialize.collect', () =>
    canonicalizeInboundEntries(collectInboundEntries(effectiveInput)));
  const originated = await timePerfPhase('htlc.materialize.originated', () => materializeOriginatedHtlcPayments({
    state: effectiveInput.state,
    proposalTxs: effectiveInput.proposalTxs,
    profiles: effectiveInput.profiles,
    height: effectiveInput.height,
    resolveRoute: effectiveInput.resolveRoute,
  }));
  return { version: 1, entries, originated };
};

/** Validators reproduce proposer materialization from committed facts exactly. */
export const assertHtlcPreparedInfraContext = async (
  input: AssertHtlcPreparedInfraContextInput,
): Promise<void> => {
  const effectiveProposalTxs = getEffectiveHtlcFrameTxs(input.state, input.proposalTxs);
  const actual = validateHtlcPreparedInfraContext(input.context.htlc);
  const online = new Map(input.context.peerAssertions.map(assertion => [assertion.entityId, assertion.online]));
  const replayInput: MaterializeHtlcPreparedContextInput = {
    state: input.state,
    proposalTxs: effectiveProposalTxs,
    entityEncryptionPublicKey: input.state.entityEncryptionPublicKey,
    entityEncryptionPrivateKey: input.entityEncryptionPrivateKey,
    isEntityOnline: entityId => online.get(entityId) === true,
    profiles: input.context.gossipProfiles,
    parentFrameHash: input.context.parentFrameHash,
    height: input.context.height,
    resolveRoute: async () => { throw new Error('HTLC_PAYMENT_VALIDATOR_ROUTE_RESOLUTION_FORBIDDEN'); },
  };
  assertEntityEncryptionKeypair(replayInput.entityEncryptionPublicKey, replayInput.entityEncryptionPrivateKey);
  const expectedEntries = canonicalizeInboundEntries(collectInboundEntries(replayInput));
  if (!canonicalConsensusValuesEqual(expectedEntries, actual.entries)) {
    const expectedKeys = expectedEntries.map(entry => preparedHtlcBindingKey(entry.binding));
    const actualKeys = actual.entries.map(entry => preparedHtlcBindingKey(entry.binding));
    const mismatchIndex = expectedKeys.findIndex((key, index) => key !== actualKeys[index]);
    const firstMismatch = mismatchIndex >= 0
      ? mismatchIndex
      : Math.min(expectedKeys.length, actualKeys.length);
    throw new Error(
      `HTLC_PREPARED_INBOUND_REPLAY_MISMATCH:` +
      `expected=${expectedEntries.length}:actual=${actual.entries.length}:` +
      `index=${firstMismatch}:` +
      `expectedKey=${expectedKeys[firstMismatch] ?? 'missing'}:` +
      `actualKey=${actualKeys[firstMismatch] ?? 'missing'}`,
    );
  }
  assertOriginatedHtlcPayments({
    state: input.state,
    proposalTxs: effectiveProposalTxs,
    profiles: input.context.gossipProfiles,
    height: input.context.height,
    originated: actual.originated,
  });
};

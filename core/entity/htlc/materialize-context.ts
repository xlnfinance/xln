import { deriveDelta } from '../../account/utils';
import { getAccountPerspective } from '../../account/state/perspective';
import { accountInputProposal } from '../../account/consensus/flush';
import type { AccountTx } from '../../types/account';
import type { EntityTx } from '../../types/entity-tx';
import { preparedHtlcBindingKey, type HtlcPreparedInfraContext, type PreparedHtlcEntry } from '../../types/entity/htlc-infra-context';
import { computeHtlcEnvelopeContextHash , unwrapEnvelope, validateEnvelope } from '../../protocol/htlc/codec/envelope';
import {
  assertEntityEncryptionKeypair,
  assertOpaqueHtlcCiphertext,
  decryptOpaqueHtlcBytes,
  HtlcCiphertextAuthenticationError,
} from '../../protocol/htlc/multi-recipient';
import { encryptedHtlcLayer, hashEncryptedHtlcLayer } from '../../protocol/htlc/codec/onion-layer';
import type { EntityState } from '../types';
import { findAccountKey } from '../tx/account-key';
import { HTLC } from '../../config/constants';
import { calculateDirectionalFeePPM, calculateHopFee, sanitizeBaseFee, sanitizeFeePPM } from '../../pathfinding/fees';
import type { Profile } from '../profile';
import { assertOriginatedHtlcPayments, materializeOriginatedHtlcPayments } from './payment-admission';
import type { EntityInfraContext } from '../../types/entity/infra-context';
import { encodeCanonicalConsensusValue } from '../../protocol/serialization/canonical-consensus-value';
import { validateHtlcPreparedInfraContext } from './prepared-context-validation';
import { getEffectiveEntityInputTxs } from '../consensus/output/envelope';
import { resolveCanonicalEntityBoardShares } from '../auth/authorization';
import { normalizeAccountStateDomain } from '../../account/commitment/state-root';

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
): PreparedHtlcEntry => ({ binding, outcome: { kind: 'reject', reason } });

type AccountInputTx = Extract<EntityTx, { type: 'accountInput' }>;
type HtlcLockTx = Extract<AccountTx, { type: 'htlc_lock' }>;
type PreparedEnvelope = ReturnType<typeof unwrapEnvelope>;

const buildInboundBinding = (
  tx: AccountInputTx,
  proposal: NonNullable<ReturnType<typeof accountInputProposal>>,
  accountTx: HtlcLockTx,
): PreparedHtlcEntry['binding'] => {
  const layer = encryptedHtlcLayer(accountTx.data.envelope);
  if (!layer) throw new Error(`HTLC_PREPARED_LAYER_REQUIRED:${accountTx.data.lockId}`);
  return {
    fromEntityId: tx.data.fromEntityId.toLowerCase(),
    toEntityId: tx.data.toEntityId.toLowerCase(),
    // Each binding owns canonical domain bytes. Reusing one input object across
    // batched locks makes protocol values depend on JavaScript object identity
    // and triggers Bun's known repeated-reference structuredClone corruption.
    domain: normalizeAccountStateDomain(tx.data.domain, 'HTLC_PREPARED_DOMAIN'),
    accountFrameHash: proposal.frame.stateHash.toLowerCase(),
    accountHeight: proposal.frame.height,
    lockId: accountTx.data.lockId.toLowerCase(),
    envelopeHash: hashEncryptedHtlcLayer(layer),
    hashlock: accountTx.data.hashlock.toLowerCase(),
    tokenId: accountTx.data.tokenId,
    amount: accountTx.data.amount,
    timelock: accountTx.data.timelock,
    revealBeforeHeight: accountTx.data.revealBeforeHeight,
  };
};

// The same inbound lock is decrypted by the wire-budget fit (per attempt), by
// the proposal, by the validator replay of the same frame, and again when the
// payer re-sends its still-pending proposal (a fresh tx object each time). The
// X25519+cipher round is pure in (ciphertext, AAD, keys), so memoize by content.
type DecryptedInboundEnvelope = PreparedEnvelope | { rejectReason: 'decrypt_failed' | 'ciphertext_invalid' };
const decryptedInboundEnvelopes = new Map<string, DecryptedInboundEnvelope>();
const DECRYPTED_ENVELOPE_MEMO_MAX = 65_536;

const decryptInboundEnvelope = (
  input: MaterializeHtlcPreparedContextInput,
  accountTx: HtlcLockTx,
  binding: PreparedHtlcEntry['binding'],
): PreparedEnvelope | PreparedHtlcEntry => {
  const contextHash = computeHtlcEnvelopeContextHash({
    fromEntityId: binding.fromEntityId, toEntityId: binding.toEntityId,
    domain: binding.domain, lockId: binding.lockId, hashlock: binding.hashlock,
    tokenId: binding.tokenId, amount: binding.amount, timelock: binding.timelock,
    revealBeforeHeight: binding.revealBeforeHeight,
  });
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
  const binding = buildInboundBinding(tx, proposal, accountTx);
  const envelope = decryptInboundEnvelope(input, accountTx, binding);
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
 * One Account frame can reach a proposer twice in the same Runtime frame — a
 * peer retransmits, or the same proposal arrives over two transports — and
 * batching makes that ordinary rather than rare, because a wider frame covers
 * a wider delivery window. Two materializations of the same lock are the same
 * fact, so an identical repeat collapses. Only a genuine contradiction, two
 * different outcomes claimed for one lock, is a fault worth halting on.
 */
const canonicalizeInboundEntries = (entries: PreparedHtlcEntry[]): PreparedHtlcEntry[] => {
  const decorated = entries.map(entry => ({ key: preparedHtlcBindingKey(entry.binding), entry }));
  decorated.sort((left, right) => left.key.localeCompare(right.key));
  const canonical: PreparedHtlcEntry[] = [];
  for (const { entry } of decorated) {
    const previous = canonical[canonical.length - 1];
    if (
      previous === undefined ||
      previous.binding.accountFrameHash !== entry.binding.accountFrameHash ||
      previous.binding.lockId !== entry.binding.lockId
    ) {
      canonical.push(entry);
      continue;
    }
    if (encodeCanonicalConsensusValue(previous) !== encodeCanonicalConsensusValue(entry)) {
      throw new Error(
        `HTLC_PREPARED_BINDING_CONFLICT:${entry.binding.accountFrameHash}:${entry.binding.lockId}`,
      );
    }
  }
  return canonical;
};

/** Proposer-only materialization. Validators replay only the returned bytes. */
export const materializeHtlcPreparedInfraContext = async (
  input: MaterializeHtlcPreparedContextInput,
): Promise<HtlcPreparedInfraContext> => {
  // Infrastructure/key provisioning failures are never peer-rejectable data.
  // Validate once, outside the attacker-controlled envelope loop, and fail loud.
  assertEntityEncryptionKeypair(input.entityEncryptionPublicKey, input.entityEncryptionPrivateKey);
  const effectiveInput = { ...input, proposalTxs: getEffectiveHtlcFrameTxs(input.state, input.proposalTxs) };
  const entries = canonicalizeInboundEntries(collectInboundEntries(effectiveInput));
  const originated = await materializeOriginatedHtlcPayments({
    state: effectiveInput.state,
    proposalTxs: effectiveInput.proposalTxs,
    profiles: effectiveInput.profiles,
    height: effectiveInput.height,
    resolveRoute: effectiveInput.resolveRoute,
  });
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
  if (encodeCanonicalConsensusValue(expectedEntries) !== encodeCanonicalConsensusValue(actual.entries)) {
    throw new Error('HTLC_PREPARED_INBOUND_REPLAY_MISMATCH');
  }
  assertOriginatedHtlcPayments({
    state: input.state,
    proposalTxs: effectiveProposalTxs,
    profiles: input.context.gossipProfiles,
    height: input.context.height,
    originated: actual.originated,
  });
};

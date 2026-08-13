import { deriveDelta } from '../../account/utils';
import { getAccountPerspective } from '../../account/state/perspective';
import { accountInputProposal } from '../../account/consensus/flush';
import type { AccountTx } from '../../types/account';
import type { EntityTx } from '../../types/entity-tx';
import { preparedHtlcBindingKey, type HtlcPreparedInfraContext, type PreparedHtlcEntry } from '../../types/entity/htlc-infra-context';
import { computeHtlcEnvelopeContextHash } from '../../protocol/htlc/codec/envelope';
import {
  assertEntityEncryptionKeypair,
  decryptOpaqueHtlcBytes,
  HtlcCiphertextAuthenticationError,
} from '../../protocol/htlc/multi-recipient';
import { encryptedHtlcLayer, hashEncryptedHtlcLayer } from '../../protocol/htlc/codec/onion-layer';
import { unwrapEnvelope, validateEnvelope } from '../../protocol/htlc/codec/envelope';
import type { EntityState } from '../types';
import { findAccountKey } from '../tx/account-key';
import { HTLC } from '../../config/constants';
import { calculateDirectionalFeePPM, calculateHopFee, sanitizeBaseFee, sanitizeFeePPM } from '../../routing/fees';
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
      if (!proposal || proposal.status !== 'pending' || tx.data.choice !== 'yes') return [];
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

const decryptInboundEnvelope = (
  input: MaterializeHtlcPreparedContextInput,
  accountTx: HtlcLockTx,
  binding: PreparedHtlcEntry['binding'],
): PreparedEnvelope | PreparedHtlcEntry => {
  const layer = encryptedHtlcLayer(accountTx.data.envelope)!;
  let plaintext: Uint8Array;
  try {
    plaintext = decryptOpaqueHtlcBytes(
      layer,
      input.entityEncryptionPublicKey,
      input.entityEncryptionPrivateKey,
      computeHtlcEnvelopeContextHash({
        fromEntityId: binding.fromEntityId, toEntityId: binding.toEntityId,
        domain: binding.domain, lockId: binding.lockId, hashlock: binding.hashlock,
        tokenId: binding.tokenId, amount: binding.amount, timelock: binding.timelock,
        revealBeforeHeight: binding.revealBeforeHeight,
      }),
    );
  } catch (error) {
    if (!(error instanceof HtlcCiphertextAuthenticationError)) throw error;
    return reject(binding, 'decrypt_failed');
  }
  try {
    const envelope = unwrapEnvelope(plaintext);
    validateEnvelope(envelope);
    return envelope;
  } catch {
    return reject(binding, 'ciphertext_invalid');
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
    outcome: { kind: 'forward', nextHopEntityId, forwardAmount, innerEnvelope: envelope.innerEnvelope },
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

const canonicalizeInboundEntries = (entries: PreparedHtlcEntry[]): PreparedHtlcEntry[] => {
  entries.sort((left, right) =>
    preparedHtlcBindingKey(left.binding).localeCompare(preparedHtlcBindingKey(right.binding)));
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1]!.binding;
    const current = entries[index]!.binding;
    if (previous.accountFrameHash === current.accountFrameHash && previous.lockId === current.lockId) {
      throw new Error(`HTLC_PREPARED_BINDING_DUPLICATE:${current.accountFrameHash}:${current.lockId}`);
    }
  }
  return entries;
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

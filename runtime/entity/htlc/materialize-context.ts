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
import { hashRawHtlcPaymentTx, materializeOriginatedHtlcPayments } from './payment-admission';
import type { EntityInfraContext } from '../../types/entity/infra-context';
import { encodeCanonicalConsensusValue } from '../../protocol/serialization/canonical-consensus-value';
import { validateHtlcPreparedInfraContext } from './prepared-context-validation';

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
    domain: tx.data.domain,
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
  const entries = canonicalizeInboundEntries(collectInboundEntries(input));
  const originated = await materializeOriginatedHtlcPayments({
    state: input.state,
    proposalTxs: input.proposalTxs,
    profiles: input.profiles,
    sourceEntityEncryptionPrivateKey: input.entityEncryptionPrivateKey,
    parentFrameHash: input.parentFrameHash,
    height: input.height,
    resolveRoute: input.resolveRoute,
  });
  return { version: 1, entries, originated };
};

/** Validators reproduce proposer materialization from committed facts exactly. */
export const assertHtlcPreparedInfraContext = async (
  input: AssertHtlcPreparedInfraContextInput,
): Promise<void> => {
  const actual = validateHtlcPreparedInfraContext(input.context.htlc);
  const online = new Map(input.context.peerAssertions.map(assertion => [assertion.entityId, assertion.online]));
  const routes = new Map(actual.originated.map(origin => [origin.txHash, origin.route]));
  const expected = await materializeHtlcPreparedInfraContext({
    state: input.state,
    proposalTxs: input.proposalTxs,
    entityEncryptionPublicKey: input.state.entityEncryptionPublicKey,
    entityEncryptionPrivateKey: input.entityEncryptionPrivateKey,
    isEntityOnline: entityId => online.get(entityId) === true,
    profiles: input.context.gossipProfiles,
    parentFrameHash: input.context.parentFrameHash,
    height: input.context.height,
    resolveRoute: async tx => {
      const txHash = hashRawHtlcPaymentTx(tx);
      const route = routes.get(txHash);
      if (!route) throw new Error(`HTLC_PAYMENT_DISCOVERED_ROUTE_REQUIRED:${txHash}`);
      return route;
    },
  });
  if (encodeCanonicalConsensusValue(expected) !== encodeCanonicalConsensusValue(actual)) {
    throw new Error('HTLC_PREPARED_CONTEXT_REPLAY_MISMATCH');
  }
};

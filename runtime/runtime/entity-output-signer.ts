import { accountInputProposal } from '../account/consensus/flush';
import { resolveCertifiedAccountCounterpartyProposer } from './account-counterparty-route';
import { getLocalSignerPrivateKey } from '../account/crypto';
import { getEntityLeaderState, isEntityActiveLeader } from '../entity/consensus/leader';
import type { Profile } from '../entity/profile';
import { computeHtlcEnvelopeContextHash } from '../protocol/htlc/envelope';
import { validateMultiRecipientCiphertext } from '../protocol/htlc/multi-recipient';
import { encryptedHtlcLayer } from '../protocol/htlc/onion-layer';
import type { AccountPeerInput } from '../types/account';
import type { EntityOutput, EntityReplica } from '../entity/types';
import type { RuntimeState } from '../types';
import type { EntityTx } from '../types/entity-tx';

const REPLAY_OUTPUT_SIGNER_HINTS = Symbol.for('xln.runtime.replay.output-signer-hints');

type RuntimeStateWithReplaySignerHints = RuntimeState & {
  [REPLAY_OUTPUT_SIGNER_HINTS]?: ReadonlyMap<string, string>;
};

export const installReplayOutputSignerHints = (env: RuntimeState, hints: ReadonlyMap<string, string>): void => {
  const canonical = new Map<string, string>();
  for (const [rawEntityId, rawSignerId] of hints) {
    const entityId = String(rawEntityId || '')
      .trim()
      .toLowerCase();
    const signerId = String(rawSignerId || '')
      .trim()
      .toLowerCase();
    if (!entityId || !signerId) {
      throw new Error('REPLAY_OUTPUT_SIGNER_HINT_INVALID');
    }
    canonical.set(entityId, signerId);
  }
  Object.defineProperty(env, REPLAY_OUTPUT_SIGNER_HINTS, {
    value: canonical,
    configurable: true,
    enumerable: false,
    writable: false,
  });
};

export const clearReplayOutputSignerHints = (env: RuntimeState): void => {
  const transient: RuntimeStateWithReplaySignerHints = env;
  delete transient[REPLAY_OUTPUT_SIGNER_HINTS];
};

const replayOutputSignerHint = (env: RuntimeState, entityId: string): string | null => {
  const transient: RuntimeStateWithReplaySignerHints = env;
  const hints = transient[REPLAY_OUTPUT_SIGNER_HINTS];
  return hints instanceof Map ? String(hints.get(entityId) || '') || null : null;
};

/**
 * Resolve which local signer may emit a committed Entity output.
 *
 * Sparse-WAL replay runs before gossip/network infrastructure is attached.
 * The atomically hashed WAL record already contains the durable outbox, so its
 * exact signer hint is valid local routing evidence. The hint never enters
 * Runtime/Entity/Account consensus state and is cleared after each replayed
 * Runtime frame.
 */
export const resolveEntityProposerId = (env: RuntimeState, entityId: string, context: string): string => {
  const targetEntityId = String(entityId || '').toLowerCase();
  let localKeyReplicaFallback: string | null = null;
  let configFallback: string | null = null;
  let gossipFallback: string | null = null;

  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    const keyParts = String(replicaKey).split(':');
    const keyEntityId = String(keyParts[0] || '').toLowerCase();
    const replicaEntityId = String(replica.entityId || '').toLowerCase();
    if (replicaEntityId !== targetEntityId && keyEntityId !== targetEntityId) {
      continue;
    }

    const replicaSignerId = String(replica.signerId || keyParts[1] || '').trim();
    const configuredValidators = replica.state.config.validators || [];
    if (isEntityActiveLeader(replica) && replicaSignerId && getLocalSignerPrivateKey(env, replicaSignerId)) {
      return replicaSignerId;
    }
    if (!localKeyReplicaFallback && replicaSignerId && getLocalSignerPrivateKey(env, replicaSignerId)) {
      localKeyReplicaFallback = replicaSignerId;
    }
    if (!configFallback) {
      configFallback = getEntityLeaderState(replica.state).activeValidatorId || configuredValidators[0] || null;
    }
  }

  if (env.gossip?.getProfiles) {
    const profile = (env.gossip.getProfiles() as Profile[]).find(
      candidate => String(candidate.entityId || '').toLowerCase() === targetEntityId,
    );
    const firstValidator = profile?.metadata.board?.validators?.[0];
    gossipFallback = firstValidator?.signerId || firstValidator?.signer || null;
  }

  if (localKeyReplicaFallback) return localKeyReplicaFallback;
  if (configFallback && getLocalSignerPrivateKey(env, configFallback)) {
    return configFallback;
  }
  const replayHint = replayOutputSignerHint(env, targetEntityId);
  if (replayHint) return replayHint;
  if (gossipFallback) return gossipFallback;
  if (configFallback) return configFallback;

  throw new Error(`SIGNER_RESOLUTION_FAILED: ${context} entityId=${entityId}`);
};

const nestedAccountInputs = (txs: readonly EntityTx[]): AccountPeerInput[] =>
  txs.flatMap((tx): AccountPeerInput[] => {
    if (tx.type === 'accountInput') return [tx.data];
    if (tx.type !== 'consensusOutput') return [];
    return tx.data.entityTxs.flatMap(nested =>
      nested.type === 'accountInput' ? [nested.data] : [],
    );
  });

const entityOutputAccountInput = (output: EntityOutput): AccountPeerInput | null => {
  const inputs = output.entityTxs ? nestedAccountInputs(output.entityTxs) : [];
  if (inputs.length > 1) {
    throw new Error(
      `ENTITY_OUTPUT_ACCOUNT_ROUTE_AMBIGUOUS:${output.entityId}:${inputs.length}`,
    );
  }
  return inputs[0] ?? null;
};

const encryptedAccountSignerHint = (
  targetEntityId: string,
  input: AccountPeerInput,
): string | null => {
  const proposal = accountInputProposal(input);
  if (!proposal) return null;
  const target = targetEntityId.toLowerCase();
  const signerIds = new Set<string>();
  for (const tx of proposal.frame.accountTxs) {
    if (tx.type !== 'htlc_lock') continue;
    const encryptedLayer = encryptedHtlcLayer(tx.data.envelope);
    if (!encryptedLayer) continue;
    const contextHash = computeHtlcEnvelopeContextHash({
      entityId: target,
      lockId: tx.data.lockId,
      hashlock: tx.data.hashlock,
      tokenId: tx.data.tokenId,
      amount: tx.data.amount,
      timelock: tx.data.timelock,
      revealBeforeHeight: tx.data.revealBeforeHeight,
    });
    const layer = validateMultiRecipientCiphertext(
      encryptedLayer,
      target,
      contextHash,
    );
    const signerId = String(layer.recipients[0]?.signerId ?? '')
      .trim()
      .toLowerCase();
    if (!signerId) {
      throw new Error(
        `ACCOUNT_OUTPUT_CERTIFIED_SIGNER_MISSING:${tx.data.lockId}`,
      );
    }
    signerIds.add(signerId);
  }
  if (signerIds.size > 1) {
    throw new Error(
      `ACCOUNT_OUTPUT_CERTIFIED_SIGNER_CONFLICT:${target}:` +
        [...signerIds].sort().join(','),
    );
  }
  return signerIds.values().next().value ?? null;
};

/**
 * Bind a committed Entity output to one validator replica.
 *
 * Entity consensus has already certified destination Entity plus payload.
 * Runtime may use local keys, certified Account evidence, encrypted-recipient
 * hints or replay metadata to choose the transport route. The chosen signer is
 * then stored in the Runtime frame and remains invisible externally until that
 * frame's WAL commit succeeds.
 */
export const resolveEntityOutputSignerId = async (
  env: RuntimeState,
  sourceReplica: EntityReplica,
  output: EntityOutput,
): Promise<string> => {
  if (output.signerId !== undefined) return output.signerId.toLowerCase();

  const accountInput = entityOutputAccountInput(output);
  if (accountInput) {
    const sourceAccount = sourceReplica.state.accounts.get(output.entityId);
    if (!sourceAccount) {
      throw new Error(
        `ENTITY_OUTPUT_SOURCE_ACCOUNT_MISSING:${sourceReplica.entityId}:${output.entityId}`,
      );
    }
    const encryptedSigner = encryptedAccountSignerHint(
      output.entityId,
      accountInput,
    );
    const certifiedSigner = await resolveCertifiedAccountCounterpartyProposer(
      env,
      sourceAccount,
      output.entityId,
    );
    if (
      encryptedSigner &&
      certifiedSigner &&
      encryptedSigner !== certifiedSigner
    ) {
      throw new Error(
        `ACCOUNT_OUTPUT_SIGNER_HINT_CONFLICT:${output.entityId}:` +
          `${encryptedSigner}:${certifiedSigner}`,
      );
    }
    const evidenceSigner = encryptedSigner ?? certifiedSigner;
    if (evidenceSigner) return evidenceSigner;
  }

  return resolveEntityProposerId(
    env,
    output.entityId,
    `Entity output ${sourceReplica.entityId}->${output.entityId}`,
  );
};

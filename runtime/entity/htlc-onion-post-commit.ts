import { createStructuredLogger } from '../infra/logger';
import { buildValidatorEncryptionBoard } from '../networking/profile-encryption';
import { NobleCryptoProvider } from '../protocol/crypto/noble';
import { unwrapEnvelope, validateEnvelope } from '../protocol/htlc/envelope';
import { decodeHtlcSecretOffer } from '../protocol/htlc/onion-codec';
import { decryptBytesForLocalValidator } from '../protocol/htlc/multi-recipient';
import {
  buildHtlcOnionAcceptOfferTx,
  buildHtlcOnionAdvanceTx,
  buildHtlcOnionRevealAcceptedTx,
  committedHtlcLockEnvelope,
  hashEncryptedHtlcLayer,
  htlcSecretOfferContextHash,
  validateHtlcSecretOfferForLock,
  validateLocalCommittedHtlcLayer,
} from '../protocol/htlc/onion-advance';
import { hashHtlcSecret } from '../protocol/htlc/utils';
import { accountInputAck } from '../account/consensus/flush';
import type { AccountTx, EntityInput, EntityReplica, EntityTx, Env, HtlcLock } from '../types';
import { verifyCertifiedEntityOutput } from './consensus/output-certification';

const log = createStructuredLogger('entity.htlc_onion_post_commit');

const normalized = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const nestedTxs = (tx: EntityTx): readonly EntityTx[] =>
  tx.type === 'entityCommand'
    ? tx.data.txs
    : tx.type === 'consensusOutput'
      ? tx.data.entityTxs
      : [tx];

const hasPendingAdvance = (replica: EntityReplica, lockId: string): boolean =>
  replica.mempool.some((tx) => nestedTxs(tx).some(
    (nested) => nested.type === 'htlcOnionAdvance' && nested.data.inboundLockId === lockId,
  ));

const hasAccountResolution = (
  replica: EntityReplica,
  accountId: string,
  lockId: string,
): boolean => {
  const account = replica.state.accounts.get(accountId);
  return Boolean(
    account?.mempool.some((tx) => tx.type === 'htlc_resolve' && tx.data.lockId === lockId)
    || account?.pendingFrame?.accountTxs.some((tx) => tx.type === 'htlc_resolve' && tx.data.lockId === lockId),
  );
};

const alreadyAdvanced = (replica: EntityReplica, accountId: string, lock: HtlcLock): boolean => {
  const route = replica.state.htlcRoutes.get(lock.hashlock);
  return route?.inboundLockId === lock.lockId
    || hasAccountResolution(replica, accountId, lock.lockId)
    || hasPendingAdvance(replica, lock.lockId);
};

type HtlcLockEnvelope = NonNullable<Extract<AccountTx, { type: 'htlc_lock' }>['data']['envelope']>;

const candidateLocks = (replica: EntityReplica): Array<{ accountId: string; lock: HtlcLock; envelope: HtlcLockEnvelope }> => {
  const candidates: Array<{ accountId: string; lock: HtlcLock; envelope: HtlcLockEnvelope }> = [];
  for (const [accountId, account] of replica.state.accounts) {
    for (const lock of account.locks.values()) {
      if (alreadyAdvanced(replica, accountId, lock)) continue;
      const envelope = committedHtlcLockEnvelope(account, lock.lockId);
      if (envelope) candidates.push({ accountId, lock, envelope });
    }
  }
  return candidates.sort((left, right) =>
    left.accountId.localeCompare(right.accountId) || left.lock.lockId.localeCompare(right.lock.lockId)
  );
};

const candidateSecretOffers = (replica: EntityReplica): Array<{ accountId: string; lock: HtlcLock }> => {
  const candidates: Array<{ accountId: string; lock: HtlcLock }> = [];
  for (const [accountId, account] of replica.state.accounts) {
    const localIsLeft = normalized(account.leftEntity) === normalized(replica.entityId);
    for (const lock of account.locks.values()) {
      if (!lock.secretOffer || lock.senderIsLeft !== localIsLeft) continue;
      if (hasAccountResolution(replica, accountId, lock.lockId) || hasPendingAdvance(replica, lock.lockId)) continue;
      candidates.push({ accountId, lock });
    }
  }
  return candidates.sort((left, right) =>
    left.accountId.localeCompare(right.accountId) || left.lock.lockId.localeCompare(right.lock.lockId)
  );
};

const decryptAdvance = async (
  env: Env,
  replica: EntityReplica,
  accountId: string,
  lock: HtlcLock,
  encryptedEnvelope: HtlcLockEnvelope,
): Promise<EntityTx | null> => {
  const layerEntityId = typeof encryptedEnvelope === 'object' && 'manifest' in encryptedEnvelope
    ? normalized(encryptedEnvelope.manifest?.entityId)
    : typeof encryptedEnvelope === 'object' && encryptedEnvelope.innerEnvelope
      ? normalized(encryptedEnvelope.innerEnvelope.manifest.entityId)
      : '';
  if (layerEntityId !== normalized(replica.entityId)) return null;
  const layer = await validateLocalCommittedHtlcLayer(env, replica.state, lock, encryptedEnvelope);
  const proposerSignerId = normalized(replica.state.config.validators[0]);
  const proposerAttestations = layer.manifest.attestations.filter(
    (attestation) => attestation.signerId === proposerSignerId,
  );
  if (proposerAttestations.length !== 1) {
    throw new Error(`HTLC_DEFAULT_PROPOSER_ATTESTATION_MATCH: matches=${proposerAttestations.length}`);
  }
  if (proposerAttestations[0]!.encryptionPublicKey !== normalized(replica.state.entityEncPubKey)) {
    throw new Error('HTLC_DEFAULT_PROPOSER_ENCRYPTION_KEY_MISMATCH');
  }
  if (!replica.state.entityEncPrivKey) throw new Error('HTLC_DEFAULT_PROPOSER_PRIVATE_KEY_MISSING');
  const plaintext = await decryptBytesForLocalValidator(
    layer,
    buildValidatorEncryptionBoard(env, replica.state),
    proposerSignerId,
    replica.state.entityEncPubKey,
    replica.state.entityEncPrivKey,
    layer.contextHash,
    new NobleCryptoProvider(),
  );
  const envelope = unwrapEnvelope(plaintext);
  validateEnvelope(envelope);
  return buildHtlcOnionAdvanceTx(replica.state, accountId, lock, layer, envelope);
};

const decryptSecretOfferPayload = async (
  env: Env,
  replica: EntityReplica,
  accountId: string,
  lock: HtlcLock,
): Promise<ReturnType<typeof decodeHtlcSecretOffer>> => {
  const offer = await validateHtlcSecretOfferForLock(
    env,
    replica.state,
    replica.entityId,
    accountId,
    lock,
    lock.secretOffer!,
  );
  const proposerSignerId = normalized(replica.state.config.validators[0]);
  if (!replica.state.entityEncPrivKey) throw new Error('HTLC_DEFAULT_PROPOSER_PRIVATE_KEY_MISSING');
  const plaintext = await decryptBytesForLocalValidator(
    offer,
    buildValidatorEncryptionBoard(env, replica.state),
    proposerSignerId,
    replica.state.entityEncPubKey,
    replica.state.entityEncPrivKey,
    htlcSecretOfferContextHash(replica.entityId, accountId, lock),
    new NobleCryptoProvider(),
  );
  const decoded = decodeHtlcSecretOffer(plaintext);
  if (hashHtlcSecret(decoded.secret).toLowerCase() !== lock.hashlock.toLowerCase()) {
    throw new Error('HTLC_SECRET_OFFER_PREIMAGE_MISMATCH');
  }
  return decoded;
};

const decryptSecretOffer = async (
  env: Env,
  replica: EntityReplica,
  accountId: string,
  lock: HtlcLock,
): Promise<EntityTx> => {
  await decryptSecretOfferPayload(env, replica, accountId, lock);
  return buildHtlcOnionAcceptOfferTx(replica.state, accountId, lock, lock.secretOffer!);
};

const hasPendingReveal = (replica: EntityReplica, lockId: string): boolean =>
  replica.mempool.some((tx) => nestedTxs(tx).some((nested) =>
    nested.type === 'htlcOnionAdvance'
    && nested.data.inboundLockId === lockId
    && nested.data.advance.kind === 'revealAccepted'
  ));

const carriesAcceptedHtlcAck = (
  replica: EntityReplica,
  tx: EntityTx,
): tx is Extract<EntityTx, { type: 'consensusOutput' }> => {
  if (tx.type !== 'consensusOutput') return false;
  if (normalized(tx.data.targetEntityId) !== normalized(replica.entityId)) return false;
  if (!Array.isArray(tx.data.entityTxs)) return false;
  return tx.data.entityTxs.some((nested) => {
    if (nested.type !== 'accountInput') return false;
    const ack = accountInputAck(nested.data);
    if (!ack?.frameHanko) return false;
    const pendingFrame = replica.state.accounts.get(normalized(nested.data.fromEntityId))?.pendingFrame;
    return pendingFrame?.height === ack.height
      && pendingFrame.stateHash.toLowerCase() === ack.frameHash.toLowerCase()
      && pendingFrame.accountTxs.some((accountTx) =>
        accountTx.type === 'htlc_resolve'
        && accountTx.data.outcome === 'secret'
        && 'offerHash' in accountTx.data
      );
  });
};

/**
 * The Account ACK is already a durable bilateral certificate when it reaches
 * the payer proposer. Append the self-authored reveal to the same Entity
 * proposal so phase 1 commits that exact ACK and phase 2 propagates the
 * preimage through the Entity lockbook without an idle follow-up frame.
 */
export const appendDefaultProposerAcceptedHtlcReveals = async (
  env: Env,
  replica: EntityReplica,
  txs: readonly EntityTx[],
): Promise<EntityTx[]> => {
  const defaultProposer = normalized(replica.state.config.validators[0]);
  if (!defaultProposer || normalized(replica.signerId) !== defaultProposer) return [...txs];
  const reveals: EntityTx[] = [];
  for (const certifiedOutput of txs) {
    // Only an exact source-board certificate may unlock the target proposer's
    // local secret. Bare or merely nested transport bytes are not authority.
    if (!carriesAcceptedHtlcAck(replica, certifiedOutput)) continue;
    const verified = await verifyCertifiedEntityOutput(env, replica.state, certifiedOutput);
    for (const tx of verified.entityTxs) {
      if (tx.type !== 'accountInput') continue;
      const ack = accountInputAck(tx.data);
      if (!ack?.frameHanko) continue;
      const accountId = normalized(tx.data.fromEntityId);
      const account = replica.state.accounts.get(accountId);
      const pendingFrame = account?.pendingFrame;
      if (!account || !pendingFrame) continue;
      if (pendingFrame.height !== ack.height || pendingFrame.stateHash.toLowerCase() !== ack.frameHash.toLowerCase()) {
        continue;
      }
      for (const accountTx of pendingFrame.accountTxs) {
        if (accountTx.type !== 'htlc_resolve' || accountTx.data.outcome !== 'secret' || !('offerHash' in accountTx.data)) {
          continue;
        }
        if (hasPendingReveal(replica, accountTx.data.lockId)) continue;
        const lock = account.locks.get(accountTx.data.lockId);
        if (!lock?.secretOffer) throw new Error(`HTLC_ACCEPTED_OFFER_LOCK_MISSING:${accountTx.data.lockId}`);
        const offerHash = hashEncryptedHtlcLayer(lock.secretOffer);
        if (accountTx.data.offerHash.toLowerCase() !== offerHash) {
          throw new Error(`HTLC_ACCEPTED_OFFER_HASH_MISMATCH:${accountTx.data.lockId}`);
        }
        const decoded = await decryptSecretOfferPayload(env, replica, accountId, lock);
        reveals.push(buildHtlcOnionRevealAcceptedTx(
          replica.state,
          accountId,
          lock,
          lock.secretOffer,
          ack.frameHash,
          ack.height,
          decoded.secret,
        ));
      }
    }
  }
  return reveals.length > 0 ? [...txs, ...reveals] : [...txs];
};

/**
 * Local custody hook. It runs only after a frame is committed and never feeds
 * plaintext into that frame's replay result. The signed advance is ordinary
 * next-frame input, so every validator applies the same public transition.
 */
export const emitDefaultProposerHtlcOnionAdvances = async (
  env: Env,
  replica: EntityReplica,
  outbox: EntityInput[],
): Promise<void> => {
  const defaultProposer = normalized(replica.state.config.validators[0]);
  if (!defaultProposer || normalized(replica.signerId) !== defaultProposer) return;
  for (const { accountId, lock } of candidateSecretOffers(replica)) {
    try {
      const tx = await decryptSecretOffer(env, replica, accountId, lock);
      outbox.push({ entityId: replica.entityId, signerId: replica.signerId, entityTxs: [tx] });
      log.debug('secret_offer_accepted', { entityId: replica.entityId, lockId: lock.lockId });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      env.error('network', 'HTLC_SECRET_OFFER_DECRYPT_FAILED', {
        entityId: replica.entityId,
        lockId: lock.lockId,
        reason,
      }, replica.entityId);
    }
  }
  for (const { accountId, lock, envelope } of candidateLocks(replica)) {
    try {
      const tx = await decryptAdvance(env, replica, accountId, lock, envelope);
      if (!tx) continue;
      outbox.push({
        entityId: replica.entityId,
        signerId: replica.signerId,
        entityTxs: [tx],
      });
      log.debug('advance_emitted', { entityId: replica.entityId, lockId: lock.lockId });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      env.error('network', 'HTLC_ONION_PROPOSER_DECRYPT_FAILED', {
        entityId: replica.entityId,
        lockId: lock.lockId,
        reason,
      }, replica.entityId);
      // A missing/default-proposer key is a liveness failure by design. The
      // committed lock remains untouched for the normal timeout/dispute path.
    }
  }
};

import { keccak256 } from 'ethers';

import type { AccountReplica, AccountTx, HtlcLock } from '../../types/account';
import { encodeCanonicalConsensusValue } from '../canonical-consensus-value';
import { computeHtlcSecretOfferContextHash, type HtlcEnvelope } from './envelope';
import { isMultiRecipientCiphertext, type MultiRecipientCiphertext } from './multi-recipient';

export type HtlcEncryptedEnvelope = HtlcEnvelope | MultiRecipientCiphertext | string | undefined;

export const committedHtlcLockEnvelope = (
  account: AccountReplica,
  lockId: string,
): HtlcEncryptedEnvelope => {
  for (const frame of [account.pendingFrame, account.currentFrame]) {
    const tx = frame?.accountTxs.find(
      candidate => candidate.type === 'htlc_lock' && candidate.data.lockId === lockId,
    ) as Extract<AccountTx, { type: 'htlc_lock' }> | undefined;
    if (tx?.data.envelope !== undefined) return tx.data.envelope;
  }
  return undefined;
};

export const encryptedHtlcLayer = (
  envelope: HtlcEncryptedEnvelope,
): MultiRecipientCiphertext | null => {
  if (isMultiRecipientCiphertext(envelope)) return envelope;
  if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
    return isMultiRecipientCiphertext(envelope.innerEnvelope) ? envelope.innerEnvelope : null;
  }
  return null;
};

export const hashEncryptedHtlcLayer = (layer: MultiRecipientCiphertext): string =>
  keccak256(new TextEncoder().encode(encodeCanonicalConsensusValue(layer))).toLowerCase();

export const htlcSecretOfferContextHash = (
  payerEntityId: string,
  beneficiaryEntityId: string,
  lock: HtlcLock,
): string =>
  computeHtlcSecretOfferContextHash({
    payerEntityId,
    beneficiaryEntityId,
    entityId: beneficiaryEntityId,
    lockId: lock.lockId,
    hashlock: lock.hashlock,
    tokenId: lock.tokenId,
    amount: lock.amount,
    timelock: lock.timelock,
    revealBeforeHeight: lock.revealBeforeHeight,
  });

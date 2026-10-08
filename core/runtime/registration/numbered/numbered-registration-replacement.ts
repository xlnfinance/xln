import { validateTronReplacement } from '../../../jurisdiction/adapter/operations/tron-replacement';
import { getSignerPrivateKey } from '../../../account/crypto';
import { decodeSignedTronTransaction } from '../../../jurisdiction/adapter/operations/tron-transaction';
import type { JAdapter, JPreparedTransactionAcceptance } from '../../../jurisdiction/adapter/types';
import type { PendingNumberedRegistration, ReplaceNumberedRegistrationData, RuntimeReplica, RuntimeTx } from '../../types';
import { getTrustedRegistrationAdapter } from './numbered-registration';
import { markLocalNumberedRegistrationTx } from './numbered-registration-auth';
import { numberedRegistrationUsesNativeTron, parseNumberedRegistrationIntentTransaction,
  encodeNumberedRegistrationCalldata } from './numbered-registration-codec';

/** A local RPC-attested absence claim is WAL input, not a cryptographic receipt
 * proof. Only the same committed native intent may exchange its expired wire;
 * its request, signer and economic call remain unchanged across the crash. */
export const applyNumberedRegistrationReplacement = (
  env: RuntimeReplica, replacement: ReplaceNumberedRegistrationData,
): void => {
  const records = env.infrastructure?.numberedRegistrationIntents;
  const current = records?.get(replacement.intentId);
  if (!current || current.status !== 'pending' || current.requestHash !== replacement.requestHash) {
    throw new Error('NUMBERED_REGISTRATION_REPLACEMENT_INTENT_MISMATCH');
  }
  if (!numberedRegistrationUsesNativeTron(env, current.request)) throw new Error('NUMBERED_REGISTRATION_REPLACEMENT_NATIVE_REQUIRED');
  const next = decodeSignedTronTransaction(replacement.rawTransaction);
  const pending: PendingNumberedRegistration = { ...current, rawTransaction: replacement.rawTransaction,
    transactionHash: next.hash, transactionNonce: next.nonce };
  parseNumberedRegistrationIntentTransaction(pending, true);
  validateTronReplacement(current.rawTransaction, replacement.rawTransaction, replacement.previousTransactionHash, replacement.evidence);
  if (current.rawTransaction === replacement.rawTransaction) return;
  if (!records) throw new Error('NUMBERED_REGISTRATION_REPLACEMENT_STORE_MISSING');
  records.set(replacement.intentId, structuredClone(pending));
};

export const replaceExpiredNumberedRegistrationIntent = async (
  env: RuntimeReplica, adapter: JAdapter, current: PendingNumberedRegistration,
  commit: (txs: RuntimeTx[]) => Promise<JPreparedTransactionAcceptance>,
): Promise<PendingNumberedRegistration> => {
  if (adapter.mode !== 'tron') return current;
  if (!numberedRegistrationUsesNativeTron(env, current.request) || !adapter.getTronExpiryEvidence) {
    throw new Error('NUMBERED_REGISTRATION_REPLACEMENT_NATIVE_AUTHORITY_REQUIRED');
  }
  const jurisdiction = current.request.entities[0]?.config.jurisdiction;
  if (!jurisdiction || getTrustedRegistrationAdapter(env, jurisdiction) !== adapter) {
    throw new Error('NUMBERED_REGISTRATION_REPLACEMENT_ADAPTER_IDENTITY_MISMATCH');
  }
  const evidence = await adapter.getTronExpiryEvidence(current.rawTransaction);
  if (!evidence) return current;
  await adapter.prepareDurableTransaction(getSignerPrivateKey(env, current.request.payerSignerId), {
    to: current.request.entityProviderAddress, data: encodeNumberedRegistrationCalldata(current.request), value: 0n,
  }, async prepared => {
    const replacement: ReplaceNumberedRegistrationData = { intentId: current.request.intentId,
      requestHash: current.requestHash, previousTransactionHash: current.transactionHash,
      rawTransaction: prepared.rawTransaction, evidence };
    const accepted = await commit([markLocalNumberedRegistrationTx({ type: 'replaceNumberedRegistrationIntent', data: replacement })]);
    if (accepted === 'accepted') {
      const durable = env.infrastructure?.numberedRegistrationIntents?.get(current.request.intentId);
      if (durable?.status !== 'pending' || durable.rawTransaction !== prepared.rawTransaction) {
        throw new Error('NUMBERED_REGISTRATION_REPLACEMENT_NOT_DURABLE');
      }
    }
    return accepted;
  });
  const durable = env.infrastructure?.numberedRegistrationIntents?.get(current.request.intentId);
  if (durable?.status !== 'pending') throw new Error('NUMBERED_REGISTRATION_REPLACEMENT_NOT_PENDING');
  return durable;
};

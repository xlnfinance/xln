import { ethers, type TransactionReceipt } from 'ethers';

import type { JAdapter } from '../jadapter/types';
import {
  computeRegistrationEvidenceHash,
  registrationEvidenceKey,
} from '../jurisdiction/registration-evidence';
import type {
  CompletedNumberedRegistration,
  Env,
  NumberedRegistrationRecord,
  NumberedRegistrationRequest,
  PendingNumberedRegistration,
  ResolveNumberedRegistrationData,
  RuntimeTx,
} from '../types';
import {
  encodeBoard,
  getNumberedRegistrationWallet,
  getTrustedRegistrationAdapter,
  hashBoard,
  parseNumberedEntityRegistrationReceipt,
  type NumberedEntityRegistration,
} from './factory';
import {
  assertNumberedRegistrationRequest,
  computeNumberedRegistrationRequestHash,
  encodeNumberedRegistrationCalldata,
  numberedRegistrationBytes32,
  parseNumberedRegistrationIntentTransaction,
} from './numbered-registration-codec';

export { buildNumberedRegistrationRequest } from './numbered-registration-codec';

export type RegistrationSubmission =
  | { kind: 'receipt'; receipt: TransactionReceipt; registrations: NumberedEntityRegistration[] }
  | { kind: 'nonce-conflict'; reason: string };

export const getNumberedRegistrationRecord = (
  env: Env,
  intentId: string,
): NumberedRegistrationRecord | undefined => env.runtimeState?.numberedRegistrationIntents?.get(
  numberedRegistrationBytes32(intentId, 'INTENT_ID'),
);

export const prepareNumberedRegistrationIntent = async (
  env: Env,
  adapter: JAdapter,
  request: NumberedRegistrationRequest,
): Promise<NumberedRegistrationRecord> => {
  assertNumberedRegistrationRequest(env, request);
  const expectedHash = computeNumberedRegistrationRequestHash(request);
  const existing = getNumberedRegistrationRecord(env, request.intentId);
  if (existing) {
    if (existing.requestHash !== expectedHash) throw new Error('NUMBERED_REGISTRATION_INTENT_PAYLOAD_CONFLICT');
    return existing;
  }
  if (!adapter.isWatching()) throw new Error('NUMBERED_REGISTRATION_WATCHER_REQUIRED');
  if (getTrustedRegistrationAdapter(env, request.entities[0]!.config.jurisdiction!) !== adapter) {
    throw new Error('NUMBERED_REGISTRATION_ADAPTER_IDENTITY_MISMATCH');
  }
  const wallet = getNumberedRegistrationWallet(env, adapter, request.payerSignerId);
  const unsigned = await wallet.populateTransaction({
    to: request.entityProviderAddress,
    data: encodeNumberedRegistrationCalldata(adapter, request),
    value: 0n,
  });
  const rawTransaction = (await wallet.signTransaction(unsigned)).toLowerCase();
  const tx = ethers.Transaction.from(rawTransaction);
  if (!tx.hash) throw new Error('NUMBERED_REGISTRATION_TX_HASH_MISSING');
  const pending: PendingNumberedRegistration = {
    status: 'pending',
    request: structuredClone(request),
    requestHash: expectedHash,
    rawTransaction,
    transactionHash: tx.hash.toLowerCase(),
    transactionNonce: tx.nonce,
  };
  parseNumberedRegistrationIntentTransaction(adapter, pending);
  return pending;
};

export const applyNumberedRegistrationIntent = (env: Env, pending: PendingNumberedRegistration): void => {
  assertNumberedRegistrationRequest(env, pending.request);
  if (computeNumberedRegistrationRequestHash(pending.request) !== pending.requestHash) throw new Error('NUMBERED_REGISTRATION_REQUEST_HASH_MISMATCH');
  const adapter = getTrustedRegistrationAdapter(env, pending.request.entities[0]!.config.jurisdiction!);
  parseNumberedRegistrationIntentTransaction(adapter, pending);
  env.runtimeState ??= {};
  env.runtimeState.numberedRegistrationIntents ??= new Map();
  const existing = env.runtimeState.numberedRegistrationIntents.get(pending.request.intentId);
  if (existing) {
    if (existing.requestHash !== pending.requestHash) throw new Error('NUMBERED_REGISTRATION_INTENT_PAYLOAD_CONFLICT');
    if (existing.status === 'pending' && existing.transactionHash !== pending.transactionHash) {
      throw new Error('NUMBERED_REGISTRATION_INTENT_TX_CONFLICT');
    }
    return;
  }
  env.runtimeState.numberedRegistrationIntents.set(pending.request.intentId, structuredClone(pending));
};

export const submitNumberedRegistrationIntent = async (
  adapter: JAdapter,
  pending: PendingNumberedRegistration,
): Promise<RegistrationSubmission> => {
  const tx = parseNumberedRegistrationIntentTransaction(adapter, pending);
  let receipt = await adapter.provider.getTransactionReceipt(pending.transactionHash);
  if (!receipt) {
    const latestNonce = await adapter.provider.getTransactionCount(pending.request.payerSignerId, 'latest');
    if (latestNonce > pending.transactionNonce) {
      return { kind: 'nonce-conflict', reason: `payer_nonce_consumed:expected=${pending.transactionNonce}:actual=${latestNonce}` };
    }
    const response = await adapter.provider.broadcastTransaction(pending.rawTransaction);
    if (response.hash.toLowerCase() !== tx.hash!.toLowerCase()) throw new Error('NUMBERED_REGISTRATION_BROADCAST_HASH_MISMATCH');
    receipt = await response.wait();
  }
  if (!receipt) throw new Error('NUMBERED_REGISTRATION_RECEIPT_MISSING');
  if (receipt.hash.toLowerCase() !== pending.transactionHash || receipt.status !== 1) {
    throw new Error('NUMBERED_REGISTRATION_RECEIPT_INVALID');
  }
  return {
    kind: 'receipt',
    receipt,
    registrations: parseNumberedEntityRegistrationReceipt(
      adapter,
      receipt,
      pending.request.entities.map(entity => entity.boardHash),
    ),
  };
};

const completedResolution = (
  env: Env,
  pending: PendingNumberedRegistration,
  submission: Extract<RegistrationSubmission, { kind: 'receipt' }>,
): Extract<ResolveNumberedRegistrationData, { kind: 'completed' }> => {
  const { receipt, registrations } = submission;
  const results = registrations.map((registration, index) => {
    const planned = pending.request.entities[index]!;
    const evidence = env.runtimeState?.certifiedRegistrationEvidence?.get(
      registrationEvidenceKey(pending.request.stackKey, registration.entityId),
    );
    if (!evidence) throw new Error(`NUMBERED_REGISTRATION_EVIDENCE_MISSING:${registration.entityId}`);
    if (
      evidence.transactionHash !== pending.transactionHash ||
      evidence.blockHash !== receipt.blockHash.toLowerCase() ||
      evidence.activationHeight !== receipt.blockNumber ||
      evidence.logIndex !== registration.logIndex ||
      evidence.boardHash !== planned.boardHash
    ) throw new Error(`NUMBERED_REGISTRATION_EVIDENCE_MISMATCH:${registration.entityId}`);
    return {
      entityNumber: registration.entityNumber,
      entityId: registration.entityId,
      registrationBlock: receipt.blockNumber,
      evidenceHash: computeRegistrationEvidenceHash(evidence),
    };
  });
  return {
    kind: 'completed',
    intentId: pending.request.intentId,
    requestHash: pending.requestHash,
    transactionHash: pending.transactionHash,
    results,
  };
};

export const buildNumberedRegistrationCompletionRuntimeTxs = (
  env: Env,
  pending: PendingNumberedRegistration,
  submission: Extract<RegistrationSubmission, { kind: 'receipt' }>,
): RuntimeTx[] => {
  const adapter = getTrustedRegistrationAdapter(env, pending.request.entities[0]!.config.jurisdiction!);
  const completion = completedResolution(env, pending, submission);
  return [
    ...completion.results.map((result, index): RuntimeTx => {
      const planned = pending.request.entities[index]!;
      return {
        type: 'importReplica',
        entityId: result.entityId,
        signerId: planned.config.validators[0]!,
        data: {
          isProposer: true,
          config: {
            ...planned.config,
            jurisdiction: {
              ...planned.config.jurisdiction!,
              entityProviderDeploymentBlock: adapter.entityProviderDeploymentBlock,
              registrationBlock: result.registrationBlock,
            },
          },
          profileName: planned.profileName ?? planned.name,
          ...(planned.position ? { position: structuredClone(planned.position) } : {}),
        },
      };
    }),
    { type: 'resolveNumberedRegistrationIntent', data: completion },
  ];
};

export const applyNumberedRegistrationResolution = (
  env: Env,
  resolution: ResolveNumberedRegistrationData,
): void => {
  const records = env.runtimeState?.numberedRegistrationIntents;
  const pending = records?.get(numberedRegistrationBytes32(resolution.intentId, 'INTENT_ID'));
  if (!pending || pending.status !== 'pending') {
    if (pending?.status === 'completed' && resolution.kind === 'completed' && pending.requestHash === resolution.requestHash) return;
    throw new Error('NUMBERED_REGISTRATION_PENDING_INTENT_MISSING');
  }
  if (pending.requestHash !== resolution.requestHash || pending.transactionHash !== resolution.transactionHash) {
    throw new Error('NUMBERED_REGISTRATION_RESOLUTION_IDENTITY_MISMATCH');
  }
  if (resolution.kind === 'quarantined') {
    records!.set(pending.request.intentId, { ...structuredClone(pending), status: 'quarantined', reason: resolution.reason });
    return;
  }
  if (resolution.results.length !== pending.request.entities.length) throw new Error('NUMBERED_REGISTRATION_RESULT_COUNT_MISMATCH');
  for (const [index, result] of resolution.results.entries()) {
    const planned = pending.request.entities[index]!;
    const evidence = env.runtimeState?.certifiedRegistrationEvidence?.get(
      registrationEvidenceKey(pending.request.stackKey, result.entityId),
    );
    const signerId = planned.config.validators[0]!.toLowerCase();
    const replica = [...env.eReplicas.values()].find(candidate =>
      candidate.entityId.toLowerCase() === result.entityId && candidate.signerId.toLowerCase() === signerId);
    if (!evidence || computeRegistrationEvidenceHash(evidence) !== result.evidenceHash || !replica) {
      throw new Error(`NUMBERED_REGISTRATION_COMPLETION_INCOMPLETE:${result.entityId}`);
    }
    if (hashBoard(encodeBoard(replica.state.config, env)).toLowerCase() !== planned.boardHash) {
      throw new Error(`NUMBERED_REGISTRATION_COMPLETION_BOARD_MISMATCH:${result.entityId}`);
    }
  }
  const completed: CompletedNumberedRegistration = { status: 'completed', ...structuredClone(resolution) };
  delete (completed as CompletedNumberedRegistration & { kind?: string }).kind;
  records!.set(pending.request.intentId, completed);
};

export type NumberedRegistrationResult = {
  config: NumberedRegistrationRequest['entities'][number]['config'];
  entityNumber: number;
  entityId: string;
};

const completedResults = (
  env: Env,
  request: NumberedRegistrationRequest,
  completed: CompletedNumberedRegistration,
): NumberedRegistrationResult[] => completed.results.map((result, index) => {
  const signerId = request.entities[index]!.config.validators[0]!.toLowerCase();
  const replica = [...env.eReplicas.values()].find(candidate =>
    candidate.entityId.toLowerCase() === result.entityId && candidate.signerId.toLowerCase() === signerId);
  if (!replica) throw new Error(`NUMBERED_REGISTRATION_COMPLETED_REPLICA_MISSING:${result.entityId}`);
  return { config: structuredClone(replica.state.config), entityNumber: result.entityNumber, entityId: result.entityId };
});

export const runNumberedRegistrationIntent = async (
  env: Env,
  adapter: JAdapter,
  request: NumberedRegistrationRequest,
  commit: (runtimeTxs: RuntimeTx[]) => Promise<void>,
  drainEvidence: () => Promise<void>,
): Promise<NumberedRegistrationResult[]> => {
  let record = await prepareNumberedRegistrationIntent(env, adapter, request);
  if (record.status === 'completed') return completedResults(env, request, record);
  if (record.status === 'quarantined') throw new Error(`NUMBERED_REGISTRATION_INTENT_QUARANTINED:${record.reason}`);
  if (!getNumberedRegistrationRecord(env, request.intentId)) {
    await commit([{ type: 'recordNumberedRegistrationIntent', data: record }]);
    const durable = getNumberedRegistrationRecord(env, request.intentId);
    if (!durable || durable.status !== 'pending') throw new Error('NUMBERED_REGISTRATION_INTENT_NOT_DURABLE');
    record = durable;
  }
  const submission = await submitNumberedRegistrationIntent(adapter, record);
  if (submission.kind === 'nonce-conflict') {
    await commit([{
      type: 'resolveNumberedRegistrationIntent',
      data: {
        kind: 'quarantined',
        intentId: record.request.intentId,
        requestHash: record.requestHash,
        transactionHash: record.transactionHash,
        reason: submission.reason,
      },
    }]);
    throw new Error(`NUMBERED_REGISTRATION_PAYER_NONCE_CONFLICT:${submission.reason}`);
  }
  await drainEvidence();
  await commit(buildNumberedRegistrationCompletionRuntimeTxs(env, record, submission));
  const completed = getNumberedRegistrationRecord(env, request.intentId);
  if (!completed || completed.status !== 'completed') throw new Error('NUMBERED_REGISTRATION_COMPLETION_NOT_DURABLE');
  return completedResults(env, request, completed);
};

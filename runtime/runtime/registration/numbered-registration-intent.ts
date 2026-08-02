import type { TransactionReceipt } from 'ethers';

import type {
  JAdapter,
  JPreparedTransactionAcceptance,
} from '../../jurisdiction/adapter/types';
import {
  computeRegistrationEvidenceHash,
  registrationEvidenceKey,
} from '../../jurisdiction/machine/registration-evidence';
import type {
  CompletedNumberedRegistration,
  RuntimeReplica,
  NumberedRegistrationRecord,
  NumberedRegistrationRequest,
  PendingNumberedRegistration,
  ResolveNumberedRegistrationData,
  RuntimeTx,
} from '../types';
import { encodeBoard, hashBoard } from '../../entity/factory';
import { getSignerPrivateKey } from '../../account/crypto';
import {
  getTrustedRegistrationAdapter,
  parseNumberedEntityRegistrationReceipt,
  type NumberedEntityRegistration,
} from './numbered-registration';
import {
  assertNumberedRegistrationRequest,
  computeNumberedRegistrationRequestHash,
  encodeNumberedRegistrationCalldata,
  numberedRegistrationBytes32,
  parseNumberedRegistrationIntentTransaction,
} from './numbered-registration-codec';
import { markLocalNumberedRegistrationTx } from './numbered-registration-auth';

export { buildNumberedRegistrationRequest } from './numbered-registration-codec';

export type RegistrationSubmission =
  | { kind: 'receipt'; receipt: TransactionReceipt; registrations: NumberedEntityRegistration[] }
  | { kind: 'nonce-conflict'; reason: string }
  | { kind: 'mined-failure'; reason: string };

const REGISTRATION_FINALITY_WAIT_TIMEOUT_MS = 15 * 60 * 1_000;

const waitForMinedRegistrationReceipt = async (
  adapter: JAdapter,
  transactionHash: string,
): Promise<TransactionReceipt> => {
  const receipt = await adapter.provider.waitForTransaction(
    transactionHash,
    1,
    REGISTRATION_FINALITY_WAIT_TIMEOUT_MS,
  );
  if (!receipt) throw new Error('NUMBERED_REGISTRATION_RECEIPT_WAIT_TIMEOUT');
  return receipt;
};

const registrationFinalityDepth = (adapter: JAdapter): number => {
  const depth = adapter.getFinalityDepth?.() ?? 0;
  if (!Number.isSafeInteger(depth) || depth < 0) {
    throw new Error(`NUMBERED_REGISTRATION_FINALITY_DEPTH_INVALID:${String(depth)}`);
  }
  return depth;
};

const waitForCanonicalRegistrationReceipt = async (
  adapter: JAdapter,
  receipt: TransactionReceipt,
): Promise<TransactionReceipt> => {
  const finalityDepth = registrationFinalityDepth(adapter);
  if (finalityDepth === 0) return receipt;
  // Ethers counts the inclusion block as confirmation #1, whereas watcher
  // finality is head - inclusion >= depth. Waiting for depth + 1 therefore
  // applies exactly the same canonical-chain policy to success and revert.
  const canonical = await adapter.provider.waitForTransaction(
    receipt.hash,
    finalityDepth + 1,
    REGISTRATION_FINALITY_WAIT_TIMEOUT_MS,
  );
  if (!canonical) throw new Error('NUMBERED_REGISTRATION_RECEIPT_FINALITY_TIMEOUT');
  if (canonical.hash.toLowerCase() !== receipt.hash.toLowerCase()) {
    throw new Error('NUMBERED_REGISTRATION_FINAL_RECEIPT_HASH_MISMATCH');
  }
  return canonical;
};

const readFinalizedPayerNonce = async (
  adapter: JAdapter,
  payer: string,
): Promise<number> => {
  const finalityDepth = registrationFinalityDepth(adapter);
  if (finalityDepth === 0) {
    return await adapter.provider.getTransactionCount(payer, 'latest');
  }
  const head = await adapter.provider.getBlockNumber();
  if (!Number.isSafeInteger(head) || head < finalityDepth) {
    throw new Error(`NUMBERED_REGISTRATION_FINALITY_HEAD_INVALID:${String(head)}:${finalityDepth}`);
  }
  // A pending replacement can raise the pending nonce and later disappear.
  // Only a canonical block at the watcher's finality depth can prove that the
  // durable intent's nonce was consumed by another transaction.
  return await adapter.provider.getTransactionCount(payer, head - finalityDepth);
};

export const getNumberedRegistrationRecord = (
  env: RuntimeReplica,
  intentId: string,
): NumberedRegistrationRecord | undefined => env.infrastructure?.numberedRegistrationIntents?.get(
  numberedRegistrationBytes32(intentId, 'INTENT_ID'),
);

export const prepareNumberedRegistrationIntent = async (
  env: RuntimeReplica,
  adapter: JAdapter,
  request: NumberedRegistrationRequest,
  accept: (pending: PendingNumberedRegistration) => Promise<JPreparedTransactionAcceptance>,
): Promise<NumberedRegistrationRecord> => {
  assertNumberedRegistrationRequest(env, request);
  for (const entity of request.entities) {
    if (entity.localSignerId !== null) getSignerPrivateKey(env, entity.localSignerId);
  }
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
  await adapter.prepareDurableTransaction(
    getSignerPrivateKey(env, request.payerSignerId),
    {
      to: request.entityProviderAddress,
      data: encodeNumberedRegistrationCalldata(request),
      value: 0n,
    },
    async prepared => {
      const pending: PendingNumberedRegistration = {
        status: 'pending',
        request: structuredClone(request),
        requestHash: expectedHash,
        rawTransaction: prepared.rawTransaction,
        transactionHash: prepared.transactionHash,
        transactionNonce: prepared.transactionNonce,
      };
      parseNumberedRegistrationIntentTransaction(pending);
      const acceptance = await accept(pending);
      if (acceptance === 'accepted') {
        const durable = getNumberedRegistrationRecord(env, request.intentId);
        if (
          !durable ||
          durable.status !== 'pending' ||
          durable.requestHash !== pending.requestHash ||
          durable.transactionHash !== pending.transactionHash
        ) {
          throw new Error('NUMBERED_REGISTRATION_ACCEPTED_INTENT_NOT_DURABLE');
        }
      }
      return acceptance;
    },
  );
  const durable = getNumberedRegistrationRecord(env, request.intentId);
  if (!durable || durable.status !== 'pending') {
    throw new Error('NUMBERED_REGISTRATION_INTENT_NOT_DURABLE');
  }
  return durable;
};

export const applyNumberedRegistrationIntent = (env: RuntimeReplica, pending: PendingNumberedRegistration): void => {
  assertNumberedRegistrationRequest(env, pending.request);
  if (computeNumberedRegistrationRequestHash(pending.request) !== pending.requestHash) throw new Error('NUMBERED_REGISTRATION_REQUEST_HASH_MISMATCH');
  parseNumberedRegistrationIntentTransaction(pending);
  env.infrastructure ??= {};
  env.infrastructure.numberedRegistrationIntents ??= new Map();
  const existing = env.infrastructure.numberedRegistrationIntents.get(pending.request.intentId);
  if (existing) {
    if (existing.requestHash !== pending.requestHash) throw new Error('NUMBERED_REGISTRATION_INTENT_PAYLOAD_CONFLICT');
    if (existing.status === 'pending' && existing.transactionHash !== pending.transactionHash) {
      throw new Error('NUMBERED_REGISTRATION_INTENT_TX_CONFLICT');
    }
    return;
  }
  env.infrastructure.numberedRegistrationIntents.set(pending.request.intentId, structuredClone(pending));
};

export const submitNumberedRegistrationIntent = async (
  adapter: JAdapter,
  pending: PendingNumberedRegistration,
): Promise<RegistrationSubmission> => {
  const tx = parseNumberedRegistrationIntentTransaction(pending);
  let receipt = await adapter.provider.getTransactionReceipt(pending.transactionHash);
  if (!receipt) {
    const existingTransaction = await adapter.provider.getTransaction(pending.transactionHash);
    if (existingTransaction) {
      receipt = await waitForMinedRegistrationReceipt(adapter, pending.transactionHash);
    }
  }
  if (!receipt) {
    const chainNonce = await readFinalizedPayerNonce(
      adapter,
      pending.request.payerSignerId,
    );
    if (chainNonce > pending.transactionNonce) {
      return { kind: 'nonce-conflict', reason: `payer_nonce_consumed:expected=${pending.transactionNonce}:actual=${chainNonce}` };
    }
    const response = await adapter.provider.broadcastTransaction(pending.rawTransaction);
    if (response.hash.toLowerCase() !== tx.hash!.toLowerCase()) throw new Error('NUMBERED_REGISTRATION_BROADCAST_HASH_MISMATCH');
    receipt = await waitForMinedRegistrationReceipt(adapter, response.hash);
  }
  if (!receipt) throw new Error('NUMBERED_REGISTRATION_RECEIPT_MISSING');
  if (receipt.hash.toLowerCase() !== pending.transactionHash) {
    throw new Error('NUMBERED_REGISTRATION_RECEIPT_HASH_MISMATCH');
  }
  receipt = await waitForCanonicalRegistrationReceipt(adapter, receipt);
  if (receipt.status === 0) {
    return {
      kind: 'mined-failure',
      reason: `mined_revert:status=0:blockNumber=${receipt.blockNumber}:blockHash=${receipt.blockHash.toLowerCase()}`,
    };
  }
  if (receipt.status !== 1) {
    throw new Error(`NUMBERED_REGISTRATION_RECEIPT_STATUS_INVALID:${String(receipt.status)}`);
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

const quarantineNumberedRegistrationIntent = async (
  pending: PendingNumberedRegistration,
  reason: string,
  commit: (runtimeTxs: RuntimeTx[]) => Promise<JPreparedTransactionAcceptance>,
): Promise<void> => {
  const acceptance = await commit([markLocalNumberedRegistrationTx({
    type: 'resolveNumberedRegistrationIntent',
    data: {
      kind: 'quarantined',
      intentId: pending.request.intentId,
      requestHash: pending.requestHash,
      transactionHash: pending.transactionHash,
      reason,
    },
  })]);
  if (acceptance !== 'accepted') throw new Error('NUMBERED_REGISTRATION_QUARANTINE_COMMIT_REJECTED');
};

const completedResolution = (
  env: RuntimeReplica,
  pending: PendingNumberedRegistration,
  submission: Extract<RegistrationSubmission, { kind: 'receipt' }>,
): Extract<ResolveNumberedRegistrationData, { kind: 'completed' }> => {
  const { receipt, registrations } = submission;
  const results = registrations.map((registration, index) => {
    const planned = pending.request.entities[index]!;
    const evidence = env.infrastructure?.certifiedRegistrationEvidence?.get(
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
  env: RuntimeReplica,
  pending: PendingNumberedRegistration,
  submission: Extract<RegistrationSubmission, { kind: 'receipt' }>,
): RuntimeTx[] => {
  const adapter = getTrustedRegistrationAdapter(env, pending.request.entities[0]!.config.jurisdiction!);
  const completion = completedResolution(env, pending, submission);
  return [
    ...completion.results.flatMap((result, index): RuntimeTx[] => {
      const planned = pending.request.entities[index]!;
      if (planned.localSignerId === null) return [];
      getSignerPrivateKey(env, planned.localSignerId);
      const localBoardIndex = planned.config.validators.findIndex(
        validator => validator.toLowerCase() === planned.localSignerId,
      );
      if (localBoardIndex < 0) {
        throw new Error(`NUMBERED_REGISTRATION_LOCAL_SIGNER_NOT_ON_BOARD:${index}`);
      }
      return [{
        type: 'importReplica',
        entityId: result.entityId,
        signerId: planned.localSignerId,
        data: {
          isProposer: localBoardIndex === 0,
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
      }];
    }),
    markLocalNumberedRegistrationTx({ type: 'resolveNumberedRegistrationIntent', data: completion }),
  ];
};

export const applyNumberedRegistrationResolution = (
  env: RuntimeReplica,
  resolution: ResolveNumberedRegistrationData,
): void => {
  const records = env.infrastructure?.numberedRegistrationIntents;
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
    const evidence = env.infrastructure?.certifiedRegistrationEvidence?.get(
      registrationEvidenceKey(pending.request.stackKey, result.entityId),
    );
    const replica = planned.localSignerId !== null
      ? [...env.state.eReplicas.values()].find(candidate =>
          candidate.entityId.toLowerCase() === result.entityId &&
          candidate.signerId.toLowerCase() === planned.localSignerId)
      : undefined;
    if (!evidence || computeRegistrationEvidenceHash(evidence) !== result.evidenceHash || (planned.localSignerId !== null && !replica)) {
      throw new Error(`NUMBERED_REGISTRATION_COMPLETION_INCOMPLETE:${result.entityId}`);
    }
    if (replica && hashBoard(encodeBoard(replica.state.config, env)).toLowerCase() !== planned.boardHash) {
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
  env: RuntimeReplica,
  request: NumberedRegistrationRequest,
  completed: CompletedNumberedRegistration,
): NumberedRegistrationResult[] => completed.results.map((result, index) => {
  const planned = request.entities[index]!;
  const replica = planned.localSignerId !== null
    ? [...env.state.eReplicas.values()].find(candidate =>
        candidate.entityId.toLowerCase() === result.entityId &&
        candidate.signerId.toLowerCase() === planned.localSignerId)
    : undefined;
  if (planned.localSignerId !== null && !replica) {
    throw new Error(`NUMBERED_REGISTRATION_COMPLETED_REPLICA_MISSING:${result.entityId}`);
  }
  const config = replica?.state.config ?? {
    ...planned.config,
    jurisdiction: {
      ...planned.config.jurisdiction!,
      registrationBlock: result.registrationBlock,
    },
  };
  return { config: structuredClone(config), entityNumber: result.entityNumber, entityId: result.entityId };
});

export const runNumberedRegistrationIntent = async (
  env: RuntimeReplica,
  adapter: JAdapter,
  request: NumberedRegistrationRequest,
  commit: (runtimeTxs: RuntimeTx[]) => Promise<JPreparedTransactionAcceptance>,
  drainEvidence: (
    submission: Extract<RegistrationSubmission, { kind: 'receipt' }>,
  ) => Promise<void>,
): Promise<NumberedRegistrationResult[]> => {
  let record = await prepareNumberedRegistrationIntent(
    env,
    adapter,
    request,
    pending => commit([
      markLocalNumberedRegistrationTx({ type: 'recordNumberedRegistrationIntent', data: pending }),
    ]),
  );
  if (record.status === 'completed') return completedResults(env, request, record);
  if (record.status === 'quarantined') throw new Error(`NUMBERED_REGISTRATION_INTENT_QUARANTINED:${record.reason}`);
  const submission = await submitNumberedRegistrationIntent(adapter, record);
  if (submission.kind !== 'receipt') {
    await quarantineNumberedRegistrationIntent(record, submission.reason, commit);
    const code = submission.kind === 'nonce-conflict'
      ? 'NUMBERED_REGISTRATION_PAYER_NONCE_CONFLICT'
      : 'NUMBERED_REGISTRATION_MINED_REVERT';
    throw new Error(`${code}:${submission.reason}`);
  }
  await drainEvidence(submission);
  const completionAcceptance = await commit(buildNumberedRegistrationCompletionRuntimeTxs(env, record, submission));
  if (completionAcceptance !== 'accepted') throw new Error('NUMBERED_REGISTRATION_COMPLETION_COMMIT_REJECTED');
  const completed = getNumberedRegistrationRecord(env, request.intentId);
  if (!completed || completed.status !== 'completed') throw new Error('NUMBERED_REGISTRATION_COMPLETION_NOT_DURABLE');
  return completedResults(env, request, completed);
};

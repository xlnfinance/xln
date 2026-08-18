import { haltRuntimeFailure } from "../../protocol/errors/failure-taxonomy";

import type { AccountReplica, AccountInput } from '../../types/account';
import {
  assertJBatchWithinContractLimits,
  type JBatch,
  type JBatchState,
} from '../../jurisdiction/machine/batch';
import type { ProofBodyStruct } from '../../protocol/dispute/proof-body';
import {
  accountInputAck,
  accountInputDisputeSeal,
  accountInputProposal,
} from '../consensus/flush';
import { hashProofBodyStruct } from '../../protocol/dispute/proof-builder';
import { toEvidenceHash, type EvidenceHash } from '../../protocol/hashes';

const PROOF_HASH_PATTERN = /^0x[0-9a-f]{64}$/;

const requireProofHash = (value: unknown, context: string): EvidenceHash => {
  const hash = String(value ?? '').trim();
  const normalized = hash.toLowerCase();
  if (!PROOF_HASH_PATTERN.test(normalized)) {
    throw haltRuntimeFailure("DISPUTE_EVIDENCE_HASH_INVALID", `DISPUTE_EVIDENCE_HASH_INVALID:${context}:${hash || 'missing'}`);
  }
  if (hash !== normalized) {
    throw haltRuntimeFailure("DISPUTE_EVIDENCE_HASH_NON_CANONICAL", `DISPUTE_EVIDENCE_HASH_NON_CANONICAL:${context}:${hash}`);
  }
  return toEvidenceHash(normalized);
};

const addOptionalHash = (
  hashes: Set<string>,
  value: unknown,
  context: string,
): void => {
  if (value === undefined || value === null) return;
  hashes.add(requireProofHash(value, context));
};

const addInputHashes = (
  hashes: Set<string>,
  input: AccountInput | undefined,
  context: string,
): void => {
  if (!input) return;
  const seals = [
    accountInputAck(input)?.disputeSeal,
    accountInputProposal(input)?.disputeSeal,
    accountInputDisputeSeal(input),
  ];
  seals.forEach((seal, index) =>
    addOptionalHash(hashes, seal?.proofBodyHash, `${context}.seal[${index}]`));
};

const addBatchHashes = (
  hashes: Set<string>,
  batch: JBatch | undefined,
  counterpartyId: string,
  context: string,
): void => {
  if (!batch) return;
  assertJBatchWithinContractLimits(batch, `${context}.evidenceRetention`);
  batch.disputeStarts.forEach((start, index) => {
    if (String(start.counterentity).toLowerCase() !== counterpartyId) return;
    const claimed = requireProofHash(start.proofbodyHash, `${context}.start[${index}]`);
    const computed = hashProofBodyStruct(start.initialProofbody).toLowerCase();
    if (claimed !== computed) {
      throw haltRuntimeFailure("DISPUTE_EVIDENCE_J_START_PROOFBODY_HASH_MISMATCH", `DISPUTE_EVIDENCE_J_START_PROOFBODY_HASH_MISMATCH:${claimed}:${computed}`);
    }
    hashes.add(claimed);
  });
  batch.disputeFinalizations.forEach((finalization, index) => {
    if (String(finalization.counterentity).toLowerCase() !== counterpartyId) return;
    addOptionalHash(
      hashes,
      finalization.initialProofbodyHash,
      `${context}.finalization[${index}].initial`,
    );
    hashes.add(hashProofBodyStruct(finalization.finalProofbody).toLowerCase());
  });
};

export const collectReachableDisputeEvidenceHashes = (
  account: AccountReplica,
  jBatchState?: JBatchState,
): Set<string> => {
  const hashes = new Set<string>();
  addOptionalHash(hashes, account.currentDisputeProofBodyHash, 'account.current');
  addOptionalHash(hashes, account.counterpartyDisputeProofBodyHash, 'account.counterparty');
  addOptionalHash(hashes, account.activeDispute?.initialProofbodyHash, 'account.active');
  addOptionalHash(
    hashes,
    account.state.settlementWorkspace?.postSettlementDisputeProof?.proofBodyHash,
    'account.pendingSettlement',
  );
  addInputHashes(hashes, account.pendingAccountInput, 'account.pending');
  addInputHashes(hashes, account.lastOutboundFrameAck?.response, 'account.cachedAck');
  const counterpartyId = String(account.proofHeader.toEntity).toLowerCase();
  addBatchHashes(hashes, jBatchState?.batch, counterpartyId, 'jBatch.draft');
  addBatchHashes(hashes, jBatchState?.sentBatch?.batch, counterpartyId, 'jBatch.sent');
  for (const [index, recoveryBatch] of (jBatchState?.recoveryBatches ?? []).entries()) {
    addBatchHashes(hashes, recoveryBatch, counterpartyId, `jBatch.recovery[${index}]`);
  }
  return hashes;
};

const assertRecordKeysCanonical = (
  record: Record<string, unknown> | undefined,
  context: string,
): void => {
  const seen = new Set<string>();
  for (const key of Object.keys(record ?? {})) {
    const normalized = String(key).toLowerCase();
    if (seen.has(normalized)) {
      throw haltRuntimeFailure("DISPUTE_EVIDENCE_HASH_AMBIGUOUS", `DISPUTE_EVIDENCE_HASH_AMBIGUOUS:${normalized}`);
    }
    seen.add(normalized);
    requireProofHash(key, `${context}.key`);
  }
};

const compactRecord = <T>(
  record: Record<string, T> | undefined,
  reachable: ReadonlySet<string>,
  context: string,
): Record<string, T> | undefined => {
  assertRecordKeysCanonical(record, context);
  const retained = Object.entries(record ?? {})
    .filter(([hash]) => reachable.has(hash)) as Array<[string, T]>;
  return retained.length > 0 ? Object.fromEntries(retained) : undefined;
};

const assertRetainedProofBodies = (
  record: AccountReplica['disputeProofBodiesByHash'],
  reachable: ReadonlySet<string>,
  account: AccountReplica,
): void => {
  for (const hash of reachable) {
    const body = record?.[hash];
    if (!body) {
      const source = account.currentDisputeProofBodyHash?.toLowerCase() === hash
        ? 'current'
        : account.counterpartyDisputeProofBodyHash?.toLowerCase() === hash
          ? 'counterparty'
          : account.activeDispute?.initialProofbodyHash?.toLowerCase() === hash
            ? 'active'
            : 'pending';
      throw haltRuntimeFailure(
        "DISPUTE_EVIDENCE_REACHABLE_PROOFBODY_MISSING",
        `DISPUTE_EVIDENCE_REACHABLE_PROOFBODY_MISSING:${source}:${hash}:retained=${Object.keys(record ?? {}).join(',') || 'none'}`,
      );
    }
    let computed: string;
    try {
      computed = hashProofBodyStruct(body as ProofBodyStruct).toLowerCase();
    } catch (cause) {
      throw haltRuntimeFailure("DISPUTE_EVIDENCE_REACHABLE_PROOFBODY_INVALID", `DISPUTE_EVIDENCE_REACHABLE_PROOFBODY_INVALID:${hash}`, cause);
    }
    if (computed !== hash) {
      throw haltRuntimeFailure("DISPUTE_EVIDENCE_REACHABLE_PROOFBODY_HASH_MISMATCH", `DISPUTE_EVIDENCE_REACHABLE_PROOFBODY_HASH_MISMATCH:${hash}:${computed}`);
    }
  }
};

const assertRetainedNonces = (
  record: AccountReplica['disputeProofNoncesByHash'],
  reachable: ReadonlySet<string>,
): void => {
  for (const hash of reachable) {
    const nonce = record?.[hash];
    if (!Number.isSafeInteger(nonce) || Number(nonce) <= 0) {
      throw haltRuntimeFailure("DISPUTE_EVIDENCE_REACHABLE_NONCE_INVALID", `DISPUTE_EVIDENCE_REACHABLE_NONCE_INVALID:${hash}:${String(nonce)}`);
    }
  }
};

const assertRetainedSnapshots = (
  record: AccountReplica['disputeArgumentSnapshotsByHash'],
  reachable: ReadonlySet<string>,
): void => {
  for (const hash of reachable) {
    const snapshot = record?.[hash];
    if (!snapshot) throw haltRuntimeFailure("DISPUTE_EVIDENCE_REACHABLE_ARGUMENT_SNAPSHOT_MISSING", `DISPUTE_EVIDENCE_REACHABLE_ARGUMENT_SNAPSHOT_MISSING:${hash}`);
    const claimed = requireProofHash(snapshot.proofbodyHash, `snapshot.${hash}`);
    const computed = hashProofBodyStruct(snapshot.proofBodyStruct).toLowerCase();
    if (claimed !== hash || computed !== hash) {
      throw haltRuntimeFailure("DISPUTE_EVIDENCE_REACHABLE_ARGUMENT_SNAPSHOT_MISMATCH", `DISPUTE_EVIDENCE_REACHABLE_ARGUMENT_SNAPSHOT_MISMATCH:${hash}:${claimed}:${computed}`);
    }
  }
};

const recordHashCount = (records: Array<Record<string, unknown> | undefined>): number =>
  new Set(records.flatMap((record) => Object.keys(record ?? {}))).size;

export const pruneUnreachableDisputeEvidence = (
  account: AccountReplica,
  jBatchState?: JBatchState,
): { before: number; after: number } => {
  const reachable = collectReachableDisputeEvidenceHashes(account, jBatchState);
  const before = recordHashCount([
    account.disputeProofBodiesByHash,
    account.disputeProofNoncesByHash,
    account.disputeArgumentSnapshotsByHash,
  ]);
  const bodies = compactRecord(account.disputeProofBodiesByHash, reachable, 'proofBodies');
  const nonces = compactRecord(account.disputeProofNoncesByHash, reachable, 'proofNonces');
  const snapshots = compactRecord(account.disputeArgumentSnapshotsByHash, reachable, 'argumentSnapshots');
  assertRetainedProofBodies(bodies, reachable, account);
  assertRetainedNonces(nonces, reachable);
  assertRetainedSnapshots(snapshots, reachable);

  if (bodies) account.disputeProofBodiesByHash = bodies;
  else delete account.disputeProofBodiesByHash;
  if (nonces) account.disputeProofNoncesByHash = nonces;
  else delete account.disputeProofNoncesByHash;
  if (snapshots) account.disputeArgumentSnapshotsByHash = snapshots;
  else delete account.disputeArgumentSnapshotsByHash;
  return { before, after: reachable.size };
};

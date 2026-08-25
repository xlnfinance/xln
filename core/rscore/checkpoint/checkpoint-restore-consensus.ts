import { computeFrameHash, getAccountFrameStructuralError } from '../../account/consensus/frame/hash';
import { assertAccountMempoolWithinLimit } from '../../account/input/mempool';
import type { AccountFrame, AccountTx } from '../../types/account';
import { decodeRscoreAccountTx } from '../account-tx-wire-decode';
import { rscoreCheckpointList, rscoreCheckpointTuple } from './checkpoint-wire';
import {
  checkpointBool,
  checkpointHanko,
  checkpointHex,
  checkpointOptionalHanko,
  checkpointOptionalHex,
  checkpointOptionalTuple,
  checkpointRestoreFail,
  checkpointSafeInt,
  checkpointText,
} from './checkpoint-restore-read';
import { decodeRscoreCheckpointDelta } from './checkpoint-restore-state';

export type RscoreDisputeDraft = Readonly<{
  hash: string;
  proofBodyHash: string;
  nonce: number;
  proposerIsLeft: boolean;
}>;

export type RscoreOutboundAck = Readonly<{
  height: number;
  frameHash: string;
  /** Exact resend certificate; intentionally excluded from the Entity leaf. */
  frameHanko: string;
  dispute?: RscoreDisputeDraft;
}>;

export type RscorePendingFrame = Readonly<{
  frame: AccountFrame;
  hanko: string;
  bundledAck?: RscoreOutboundAck;
  proposalDispute?: RscoreDisputeDraft;
}>;

type RscoreCounterpartyDispute = Readonly<{
  hanko?: string;
  hash: string;
  proofBodyHash: string;
  nonce: number;
  proposerIsLeft: boolean;
}>;

export type RscoreConsensusSeed = Readonly<{
  mempool: readonly AccountTx[];
  currentFrame?: AccountFrame;
  pending?: RscorePendingFrame;
  rollbackCount: number;
  lastRollbackFrameHash?: string;
  counterpartyFrameHanko?: string;
  localCommittedFrameHanko?: string;
  lastOutboundAck?: RscoreOutboundAck;
  dispute?: RscoreDisputeDraft;
  nextProofNonce: number;
  counterpartyDispute?: RscoreCounterpartyDispute;
}>;

/**
 * Recomputing the frame hash proves the body matches the `stateHash` shipped
 * beside it. A checkpoint read off disk must always do that. A wave read from
 * the engine is a different question: every other check on that path — the
 * Entity account leaf, the section roots, the restore row — is already gated on
 * `XLN_RSCORE_CUTOVER_TRUST_ENGINE`, and this one was not, which was an
 * oversight rather than a deliberate second opinion. It is also the expensive
 * one: hashing the frame is ~63% of decoding it.
 */
const decodeFrame = (
  value: unknown,
  stateHashValue: unknown,
  field: string,
  verifyFrameHash: boolean,
): AccountFrame => {
  const row = rscoreCheckpointTuple(value, 8, `RESTORE_${field}`);
  const stateHash = checkpointHex(stateHashValue, 32, `${field}_STATE_HASH`);
  const frame: AccountFrame = {
    height: checkpointSafeInt(row[0], `${field}_HEIGHT`),
    timestamp: checkpointSafeInt(row[1], `${field}_TIMESTAMP`),
    jHeight: checkpointSafeInt(row[2], `${field}_J_HEIGHT`),
    accountTxs: rscoreCheckpointList(row[3], `RESTORE_${field}_TXS`).map(decodeRscoreAccountTx),
    prevFrameHash: checkpointText(row[4], `${field}_PREV_HASH`),
    accountStateRoot: checkpointHex(row[5], 32, `${field}_ACCOUNT_ROOT`),
    byLeft: checkpointBool(row[6], `${field}_BY_LEFT`),
    deltas: rscoreCheckpointList(row[7], `RESTORE_${field}_DELTAS`).map((delta, index) =>
      decodeRscoreCheckpointDelta(delta, index),
    ),
    stateHash,
  };
  const structuralError = getAccountFrameStructuralError(frame);
  if (structuralError) checkpointRestoreFail(`${field}_STRUCTURE:${structuralError}`);
  if (frame.prevFrameHash !== 'genesis' && !/^0x[0-9a-f]{64}$/.test(frame.prevFrameHash)) {
    checkpointRestoreFail(`${field}_PREV_HASH`);
  }
  if (verifyFrameHash && computeFrameHash(frame) !== stateHash) {
    checkpointRestoreFail(`${field}_HASH_MISMATCH`);
  }
  return frame;
};

const decodeDispute = (value: unknown, field: string): RscoreDisputeDraft | undefined => {
  const row = checkpointOptionalTuple(value, 4, field);
  return row === undefined
    ? undefined
    : {
        hash: checkpointHex(row[0], 32, `${field}_HASH`),
        proofBodyHash: checkpointHex(row[1], 32, `${field}_PROOF_BODY_HASH`),
        nonce: checkpointSafeInt(row[2], `${field}_NONCE`),
        proposerIsLeft: checkpointBool(row[3], `${field}_PROPOSER`),
      };
};

const decodeAck = (value: unknown, field: string): RscoreOutboundAck | undefined => {
  const row = checkpointOptionalTuple(value, 4, field);
  if (row === undefined) return undefined;
  const dispute = decodeDispute(row[3], `${field}_DISPUTE`);
  return {
    height: checkpointSafeInt(row[0], `${field}_HEIGHT`),
    frameHash: checkpointHex(row[1], 32, `${field}_FRAME_HASH`),
    frameHanko: checkpointHanko(row[2], `${field}_FRAME`),
    ...(dispute ? { dispute } : {}),
  };
};

const decodeCurrent = (value: unknown, verifyFrameHash: boolean): AccountFrame | undefined => {
  const row = checkpointOptionalTuple(value, 2, 'CURRENT');
  return row === undefined ? undefined : decodeFrame(row[0], row[1], 'CURRENT_FRAME', verifyFrameHash);
};

const decodePending = (value: unknown, verifyFrameHash: boolean): RscorePendingFrame | undefined => {
  const row = checkpointOptionalTuple(value, 5, 'PENDING');
  if (row === undefined) return undefined;
  const bundledAck = decodeAck(row[3], 'PENDING_ACK');
  const proposalDispute = decodeDispute(row[4], 'PENDING_DISPUTE');
  return {
    frame: decodeFrame(row[0], row[1], 'PENDING_FRAME', verifyFrameHash),
    hanko: checkpointHanko(row[2], 'PENDING'),
    ...(bundledAck ? { bundledAck } : {}),
    ...(proposalDispute ? { proposalDispute } : {}),
  };
};

const decodeCounterpartyDispute = (value: unknown): RscoreCounterpartyDispute | undefined => {
  const row = checkpointOptionalTuple(value, 5, 'COUNTERPARTY_DISPUTE');
  return row === undefined
    ? undefined
    : {
        ...(row[0] === null ? {} : { hanko: checkpointHanko(row[0], 'COUNTERPARTY_DISPUTE') }),
        hash: checkpointHex(row[1], 32, 'COUNTERPARTY_DISPUTE_HASH'),
        proofBodyHash: checkpointHex(row[2], 32, 'COUNTERPARTY_DISPUTE_PROOF_BODY'),
        nonce: checkpointSafeInt(row[3], 'COUNTERPARTY_DISPUTE_NONCE'),
        proposerIsLeft: checkpointBool(row[4], 'COUNTERPARTY_DISPUTE_PROPOSER'),
      };
};

export const decodeRscoreConsensusSeed = (
  value: unknown,
  /** Off by default: only a caller that named the engine as its source may skip it. */
  verifyFrameHash = true,
): RscoreConsensusSeed => {
  const row = rscoreCheckpointTuple(value, 11, 'RESTORE_CONSENSUS');
  const mempool = rscoreCheckpointList(row[0], 'RESTORE_CONSENSUS_MEMPOOL').map(decodeRscoreAccountTx);
  const currentFrame = decodeCurrent(row[1], verifyFrameHash);
  const pending = decodePending(row[2], verifyFrameHash);
  const counterpartyFrameHanko = checkpointOptionalHanko(row[5], 'COUNTERPARTY_FRAME');
  const localCommittedFrameHanko = checkpointOptionalHanko(row[6], 'LOCAL_COMMITTED_FRAME');
  if (
    (currentFrame === undefined) !== (counterpartyFrameHanko === undefined) ||
    (currentFrame === undefined) !== (localCommittedFrameHanko === undefined)
  )
    checkpointRestoreFail('CURRENT_FRAME_CERTIFICATE');
  if (pending) {
    const expectedHeight = (currentFrame?.height ?? 0) + 1;
    const expectedPrevious = currentFrame?.stateHash ?? 'genesis';
    if (pending.frame.height !== expectedHeight) checkpointRestoreFail('PENDING_HEIGHT');
    if (pending.frame.prevFrameHash !== expectedPrevious) checkpointRestoreFail('PENDING_PREV_HASH');
  }
  assertAccountMempoolWithinLimit({ mempool, pendingFrame: pending?.frame }, 'rscore.checkpoint.restore');
  const lastOutboundAck = decodeAck(row[7], 'LAST_OUTBOUND_ACK');
  const dispute = decodeDispute(row[8], 'LOCAL_DISPUTE');
  const counterpartyDispute = decodeCounterpartyDispute(row[10]);
  const lastRollbackFrameHash = checkpointOptionalHex(row[4], 32, 'LAST_ROLLBACK_HASH');
  return {
    mempool,
    ...(currentFrame ? { currentFrame } : {}),
    ...(pending ? { pending } : {}),
    rollbackCount: checkpointSafeInt(row[3], 'ROLLBACK_COUNT'),
    ...(lastRollbackFrameHash ? { lastRollbackFrameHash } : {}),
    ...(counterpartyFrameHanko ? { counterpartyFrameHanko } : {}),
    ...(localCommittedFrameHanko ? { localCommittedFrameHanko } : {}),
    ...(lastOutboundAck ? { lastOutboundAck } : {}),
    ...(dispute ? { dispute } : {}),
    nextProofNonce: checkpointSafeInt(row[9], 'NEXT_PROOF_NONCE'),
    ...(counterpartyDispute ? { counterpartyDispute } : {}),
  };
};

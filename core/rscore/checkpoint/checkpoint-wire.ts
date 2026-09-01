import type { RscoreWireValue } from '../client';
import { buffersEqual } from '../../protocol/serialization';

export type RscoreCheckpointToken = [
  baseRevision: number | bigint,
  revision: number | bigint,
  accountsRoot: Uint8Array,
  signerDigest: Uint8Array,
  accountCount: number,
];

export type RscoreCheckpointChanges = Readonly<{
  /** Acknowledges these incremental rows after the Runtime WAL fsync. */
  commitToken: RscoreCheckpointToken;
  /** Stored with the rows and handed to RestoreExact after a process death. */
  restoreToken: RscoreCheckpointToken;
  accounts: RscoreWireValue[][];
  removed: Uint8Array[];
}>;

/** Exact materialized rows handed back to RestoreExact after a process death. */
export type RscoreExactCheckpoint = Readonly<{
  ownerEntityId: string;
  protocolFingerprint: string;
  restoreToken: RscoreCheckpointToken;
  accounts: RscoreWireValue[][];
}>;

export const rscoreCheckpointTuple = (
  value: unknown,
  arity: number,
  field: string,
): RscoreWireValue[] => {
  if (!Array.isArray(value) || value.length !== arity) {
    throw new Error(`RSCORE_CHECKPOINT_${field}_ARITY`);
  }
  return value as RscoreWireValue[];
};

export const rscoreCheckpointList = (value: unknown, field: string): RscoreWireValue[] => {
  if (!Array.isArray(value)) throw new Error(`RSCORE_CHECKPOINT_${field}_LIST`);
  return value as RscoreWireValue[];
};

export const rscoreCheckpointBytes = (
  value: unknown,
  length: number,
  field: string,
): Uint8Array => {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new Error(`RSCORE_CHECKPOINT_${field}_BYTES`);
  }
  return value;
};

const checkpointUnsigned = (value: unknown, field: string): number | bigint => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'bigint' && value >= 0n && value <= 0xffff_ffff_ffff_ffffn) return value;
  throw new Error(`RSCORE_CHECKPOINT_${field}_INTEGER`);
};

export const decodeRscoreCheckpointToken = (
  value: unknown,
  field: string,
): RscoreCheckpointToken => {
  const tuple = rscoreCheckpointTuple(value, 5, `${field}_TOKEN`);
  const count = checkpointUnsigned(tuple[4], `${field}_ACCOUNT_COUNT`);
  if (typeof count !== 'number' || count > 65_536) {
    throw new Error(`RSCORE_CHECKPOINT_${field}_ACCOUNT_COUNT`);
  }
  return [
    checkpointUnsigned(tuple[0], `${field}_BASE_REVISION`),
    checkpointUnsigned(tuple[1], `${field}_REVISION`),
    rscoreCheckpointBytes(tuple[2], 32, `${field}_ACCOUNTS_ROOT`),
    rscoreCheckpointBytes(tuple[3], 32, `${field}_SIGNER_DIGEST`),
    count,
  ];
};

const sameRscoreCheckpointTokenBody = (
  left: RscoreCheckpointToken,
  right: RscoreCheckpointToken,
): boolean =>
  BigInt(left[1]) === BigInt(right[1]) &&
  buffersEqual(Buffer.from(left[2]), Buffer.from(right[2])) &&
  buffersEqual(Buffer.from(left[3]), Buffer.from(right[3])) &&
  left[4] === right[4];

export const decodeRscoreCheckpointChanges = (value: unknown): RscoreCheckpointChanges => {
  const tuple = rscoreCheckpointTuple(value, 4, 'RESPONSE');
  const commitToken = decodeRscoreCheckpointToken(tuple[0], 'COMMIT');
  const restoreToken = decodeRscoreCheckpointToken(tuple[1], 'RESTORE');
  if (
    BigInt(commitToken[1]) < BigInt(commitToken[0]) ||
    !sameRscoreCheckpointTokenBody(commitToken, restoreToken) ||
    BigInt(restoreToken[0]) !== BigInt(restoreToken[1])
  ) {
    throw new Error('RSCORE_CHECKPOINT_TOKEN_RELATION');
  }
  const accounts = rscoreCheckpointList(tuple[2], 'ACCOUNTS')
    .map((account, index) => {
      const row = rscoreCheckpointTuple(account, 12, `ACCOUNT_${index}`);
      rscoreCheckpointBytes(row[0], 32, `ACCOUNT_${index}_ID`);
      rscoreCheckpointBytes(row[1], 32, `ACCOUNT_${index}_LEAF`);
      return row;
    });
  const removed = rscoreCheckpointList(tuple[3], 'REMOVED')
    .map((accountId, index) => rscoreCheckpointBytes(accountId, 32, `REMOVED_${index}`));
  const removedKeys = removed.map(accountId => Buffer.from(accountId).toString('hex'));
  if (new Set(removedKeys).size !== removedKeys.length) {
    throw new Error('RSCORE_CHECKPOINT_REMOVED_DUPLICATE');
  }
  return { commitToken, restoreToken, accounts, removed };
};

/** Candidate identity that the checkpoint must durably describe. */
export const assertRscoreCheckpointCandidate = (
  checkpoint: RscoreCheckpointChanges,
  expected: Readonly<{ revision: number | bigint; accountsRoot: string; accountCount: number }>,
): void => {
  const checkpointRoot = `0x${Buffer.from(checkpoint.restoreToken[2]).toString('hex')}`;
  if (
    BigInt(checkpoint.restoreToken[1]) !== BigInt(expected.revision) ||
    checkpointRoot.toLowerCase() !== expected.accountsRoot.toLowerCase() ||
    checkpoint.restoreToken[4] !== expected.accountCount
  ) {
    throw new Error(
      `RSCORE_CHECKPOINT_CANDIDATE_MISMATCH:` +
      `revision=${String(checkpoint.restoreToken[1])}/${String(expected.revision)}:` +
      `root=${checkpointRoot.toLowerCase()}/${expected.accountsRoot.toLowerCase()}:` +
      `count=${String(checkpoint.restoreToken[4])}/${String(expected.accountCount)}`,
    );
  }
};

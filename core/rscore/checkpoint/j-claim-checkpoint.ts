/** Strict checkpoint codec for Rust-owned Account J-claim Patricia nodes. */
import { hashAccountJClaimNode } from '../../account/j-claims/j-claim-codec';
import type { AccountJClaimNode } from '../../types/finance/account-j-claims';
import { jClaimNodeFromWire } from '../process/j-claim-wire';
import type { RscoreWireValue } from '../client';
import {
  rscoreCheckpointBytes,
  rscoreCheckpointList,
  rscoreCheckpointTuple,
} from './checkpoint-wire';

export type RscoreJClaimNodeEntry = Readonly<{
  hash: string;
  node: AccountJClaimNode;
  wire: readonly RscoreWireValue[];
}>;

export type RscoreJClaimNodeChanges = Readonly<{
  puts: readonly RscoreJClaimNodeEntry[];
  dels: readonly Uint8Array[];
}>;

const fail = (code: string): never => {
  throw new Error(`RSCORE_J_CLAIM_CHECKPOINT_${code}`);
};

const hashHex = (value: unknown, field: string): string =>
  `0x${Buffer.from(rscoreCheckpointBytes(value, 32, field)).toString('hex')}`;

const decodeRscoreJClaimNodeEntry = (
  value: unknown,
  field: string,
): RscoreJClaimNodeEntry => {
  const wire = rscoreCheckpointTuple(value, 2, field);
  const hash = hashHex(wire[0], `${field}_HASH`);
  const node = jClaimNodeFromWire(wire[1]);
  const actual = hashAccountJClaimNode(node);
  if (actual !== hash) fail(`${field}_HASH_MISMATCH:${hash}:${actual}`);
  return { hash, node, wire };
};

const assertCanonicalHashes = (hashes: readonly string[], field: string): void => {
  for (let index = 1; index < hashes.length; index += 1) {
    const previous = hashes[index - 1];
    const current = hashes[index];
    if (previous === undefined || current === undefined || previous >= current) {
      fail(`${field}_ORDER:${index}`);
    }
  }
};

export const decodeRscoreJClaimNodeChanges = (
  value: unknown,
  field: string,
): RscoreJClaimNodeChanges => {
  const row = rscoreCheckpointTuple(value, 2, field);
  const puts = rscoreCheckpointList(row[0], `${field}_PUTS`)
    .map((entry, index) => decodeRscoreJClaimNodeEntry(entry, `${field}_PUT_${index}`));
  const dels = rscoreCheckpointList(row[1], `${field}_DELS`)
    .map((hash, index) => rscoreCheckpointBytes(hash, 32, `${field}_DEL_${index}`));
  const putHashes = puts.map(entry => entry.hash);
  const delHashes = dels.map(hash => `0x${Buffer.from(hash).toString('hex')}`);
  assertCanonicalHashes(putHashes, `${field}_PUTS`);
  assertCanonicalHashes(delHashes, `${field}_DELS`);
  const deleted = new Set(delHashes);
  if (putHashes.some(hash => deleted.has(hash))) fail(`${field}_PUT_DELETE_OVERLAP`);
  return { puts, dels };
};

export const decodeRscoreExactJClaimNodes = (
  value: unknown,
  field: string,
): readonly RscoreJClaimNodeEntry[] => {
  const entries = rscoreCheckpointList(value, field)
    .map((entry, index) => decodeRscoreJClaimNodeEntry(entry, `${field}_${index}`));
  assertCanonicalHashes(entries.map(entry => entry.hash), field);
  return entries;
};

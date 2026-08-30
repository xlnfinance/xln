import { ethers } from 'ethers';

import { computeIntegrityDigest } from '../../support/bytes/integrity-checksum';
import { compareStableText } from '../../protocol/serialization';
import { encodeBinaryPayload } from '../../protocol/serialization/binary-codec';

export type StorageReplicaMetaDigestEntry = Readonly<{
  key: Uint8Array;
  value: Uint8Array;
}>;

/**
 * Commits validator-local recovery state without making it Entity consensus
 * state. Keys are sorted explicitly, and values are independently hashed so
 * no key/value concatenation ambiguity can produce the same digest.
 */
export const computeStorageReplicaMetaDigest = (
  entries: readonly StorageReplicaMetaDigestEntry[],
): string => computeIntegrityDigest(encodeBinaryPayload({
  kind: 'xln.storage.replicaMeta.v1',
  entries: entries
    .map((entry) => ({
      key: ethers.hexlify(entry.key).toLowerCase(),
      valueHash: computeIntegrityDigest(entry.value),
    }))
    .sort((left, right) => {
      const byKey = compareStableText(left.key, right.key);
      return byKey !== 0 ? byKey : compareStableText(left.valueHash, right.valueHash);
    }),
}));

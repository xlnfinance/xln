import { createHash } from 'node:crypto';

import { safeStringify } from '../../../../protocol/serialization';

/**
 * Non-secret identity of the offered workload. A worker-count comparison is
 * invalid unless this value is identical on both sides.
 */
export const hltWorkloadFingerprint = (kind: string, value: unknown): string =>
  `0x${createHash('sha256')
    .update('xln.hlt.workload.v1\0')
    .update(kind)
    .update('\0')
    .update(safeStringify(value))
    .digest('hex')}`;

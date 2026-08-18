import type { RuntimeReplica } from '../types';
import { buildCanonicalRuntimeStateSnapshot } from '../../storage/wal/snapshot';
import { encodeBuffer } from '../../storage/codec/codec';

/**
 * Operational estimate of the deterministic payload copied for a frame.
 * It is intentionally opt-in because encoding the canonical snapshot adds
 * measurement cost. Shared process handles are excluded by the snapshot.
 */
export const measureRuntimeFrameCloneBytes = (source: RuntimeReplica): number =>
  encodeBuffer(buildCanonicalRuntimeStateSnapshot(source), { omitSymbolKeys: true }).byteLength;

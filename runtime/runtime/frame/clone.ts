import { copyLocalEntityLeaderTimeoutVoteAuthorization } from '../../entity/consensus/leader';
import type { RuntimeReplica, RuntimeInput } from '../types';
import { copyLocalJAuthorityRuntimeTxAuthorization } from '../../jurisdiction/machine/registration-evidence';
import { cloneIsolatedRuntimeInput } from '../../runtime/input-clone';
import { copyDeterministicHtlcTestSecretCapability } from '../../protocol/htlc/test-secret-capability';
import { copyLocalRuntimeAdapterCommandAuthorization } from '../command-frontier-auth';
import { buildCanonicalRuntimeStateSnapshot } from '../../storage/wal/snapshot';
import { encodeBuffer } from '../../storage/codec';
import { copyLocalEntityProviderActionRuntimeTxAuthorization } from '../entity-provider-action-submit-auth';
import { copyLocalJImportResultRuntimeTxAuthorization } from '../jurisdiction-import';
import { copyLocalJSubmitRuntimeTxAuthorization } from '../j-submit-state';
import { copyLocalScheduledWakeAuthorization } from '../scheduled-wake';

export const cloneRuntimeFrameMempool = (input: RuntimeInput): RuntimeInput => {
  const cloned = cloneIsolatedRuntimeInput(input);
  input.runtimeTxs.forEach((source, index) => {
    const target = cloned.runtimeTxs[index];
    if (!target) throw new Error(`RUNTIME_FRAME_RUNTIME_TX_CLONE_MISSING:${index}`);
    copyLocalJAuthorityRuntimeTxAuthorization(source, target);
    copyLocalJSubmitRuntimeTxAuthorization(source, target);
    copyLocalJImportResultRuntimeTxAuthorization(source, target);
    copyLocalEntityProviderActionRuntimeTxAuthorization(source, target);
    copyLocalRuntimeAdapterCommandAuthorization(source, target);
  });
  input.entityInputs.forEach((source, inputIndex) => {
    const target = cloned.entityInputs[inputIndex];
    if (!target) throw new Error(`RUNTIME_FRAME_ENTITY_INPUT_CLONE_MISSING:${inputIndex}`);
    if ((target.entityTxs?.length ?? 0) !== (source.entityTxs?.length ?? 0)) {
      throw new Error(`RUNTIME_FRAME_ENTITY_TX_CLONE_SHAPE_MISMATCH:${inputIndex}`);
    }
    source.entityTxs?.forEach((sourceTx, txIndex) => {
      const targetTx = target.entityTxs?.[txIndex];
      if (!targetTx) throw new Error(`RUNTIME_FRAME_ENTITY_TX_CLONE_MISSING:${inputIndex}:${txIndex}`);
      copyLocalScheduledWakeAuthorization(sourceTx, targetTx);
      copyDeterministicHtlcTestSecretCapability(sourceTx, targetTx);
    });
    if (source.leaderTimeoutVote) {
      if (!target.leaderTimeoutVote) {
        throw new Error(`RUNTIME_FRAME_LEADER_VOTE_CLONE_MISSING:${inputIndex}`);
      }
      copyLocalEntityLeaderTimeoutVoteAuthorization(source.leaderTimeoutVote, target.leaderTimeoutVote);
    }
  });
  return cloned;
};

/**
 * Operational estimate of the deterministic payload copied for a frame.
 * It is intentionally opt-in because encoding the canonical snapshot adds
 * measurement cost. Shared process handles are excluded by the snapshot.
 */
export const measureRuntimeFrameCloneBytes = (source: RuntimeReplica): number =>
  encodeBuffer(buildCanonicalRuntimeStateSnapshot(source)).byteLength;

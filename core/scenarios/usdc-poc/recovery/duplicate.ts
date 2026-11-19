import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { enqueueRuntimeInput, registerRuntimeFrameCommitCallback } from '../../../runtime';
import { safeStringify } from '../../../protocol/serialization';
import { encodeCanonicalConsensusBytes } from '../../../protocol/serialization/binary-codec';
import { keccakBytesHash } from '../../../protocol/crypto/keccak-text';
import type { PocUser } from '../user';

/** Re-admit exact received signed Account inputs; consensus still verifies every Hanko. */
export const installDuplicateAccountDelivery = (user: PocUser): void => {
  const scheduled = new Map<string, { kind: string; originalHeight: number }>();
  const kinds = new Set<string>();
  const repeated: Array<{ kind: string; originalHeight: number; repeatedHeight: number; digest: string }> = [];
  registerRuntimeFrameCommitCallback(user.env, ({ height, runtimeInput }) => {
    const deliveries = runtimeInput.entityInputs.flatMap(input =>
      (input.entityTxs ?? []).flatMap(tx => {
        if (tx.type !== 'accountInput' || (tx.data.kind !== 'ack' && tx.data.kind !== 'ack_frame')) return [];
        const frameHeight = tx.data.kind === 'ack' ? tx.data.ack.height : tx.data.proposal.frame.height;
        const hanko = tx.data.kind === 'ack' ? tx.data.ack.frameHanko : tx.data.proposal.frameHanko;
        return frameHeight >= 3 && hanko
          ? [{ kind: tx.data.kind, digest: keccakBytesHash(encodeCanonicalConsensusBytes(tx)) }]
          : [];
      }),
    );
    for (const delivery of deliveries) {
      const original = scheduled.get(delivery.digest);
      if (original && height > original.originalHeight)
        repeated.push({ ...original, repeatedHeight: height, digest: delivery.digest });
    }
    if (repeated.length)
      writeFileSync(join(user.directory, `duplicate-delivery-${process.pid}.json`), safeStringify({ repeated }, 2));
    const accountOnly =
      runtimeInput.runtimeTxs.length === 0 &&
      !runtimeInput.jInputs?.length &&
      runtimeInput.entityInputs.every(
        input =>
          !input.proposedFrame &&
          !input.hashPrecommits &&
          !input.leaderTimeoutVote &&
          input.entityTxs?.length &&
          input.entityTxs.every(tx => tx.type === 'accountInput'),
      );
    if (!accountOnly || !deliveries.some(delivery => !kinds.has(delivery.kind))) return;
    for (const delivery of deliveries) {
      kinds.add(delivery.kind);
      scheduled.set(delivery.digest, { kind: delivery.kind, originalHeight: height });
    }
    // Cross-J admission pairs are positional. Repeating only one Entity would
    // turn an exact duplicate into an invalid, incomplete atomic cohort.
    enqueueRuntimeInput(user.env, { runtimeTxs: [], entityInputs: structuredClone(runtimeInput.entityInputs) });
  });
};

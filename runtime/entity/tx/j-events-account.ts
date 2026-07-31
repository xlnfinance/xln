import {
  canonicalJurisdictionEventKey,
  compareCanonicalJurisdictionEvents,
  requireCanonicalJurisdictionEvents,
} from '../../jurisdiction/machine/event-normalization';
import type { JEventClaimTx, JEventAccountTx } from './j-events-types';

const isJEventClaimOp = (
  op: JEventAccountTx,
): op is { accountId: string; tx: JEventClaimTx } =>
  op.tx.type === 'j_event_claim';

/**
 * Entity owns claim ordering only. Financial application of finalized claims
 * lives in Account handlers, where delta/proof invariants can be enforced.
 */
export function mergeJEventClaimOps(ops: JEventAccountTx[]): void {
  const groups = new Map<string, number>();
  for (let index = 0; index < ops.length; ) {
    const op = ops[index];
    if (!op) {
      ops.splice(index, 1);
      continue;
    }
    if (!isJEventClaimOp(op)) {
      index += 1;
      continue;
    }
    const key =
      `${op.accountId.toLowerCase()}:${op.tx.data.jHeight}:` +
      op.tx.data.jBlockHash.toLowerCase();
    const targetIndex = groups.get(key);
    if (targetIndex === undefined) {
      groups.set(key, index);
      index += 1;
      continue;
    }
    const target = ops[targetIndex];
    if (!target || !isJEventClaimOp(target)) {
      throw new Error(`ACCOUNT_J_CLAIM_MERGE_TARGET_MISSING:${key}`);
    }
    target.tx.data.events.push(
      ...requireCanonicalJurisdictionEvents(op.tx.data.events),
    );
    ops.splice(index, 1);
  }
  for (const op of ops) {
    if (!isJEventClaimOp(op)) continue;
    const events = requireCanonicalJurisdictionEvents(op.tx.data.events).sort(
      compareCanonicalJurisdictionEvents,
    );
    const keys = events.map(canonicalJurisdictionEventKey);
    if (new Set(keys).size !== keys.length) {
      throw new Error('ACCOUNT_J_CLAIM_EVENT_DUPLICATE');
    }
    op.tx.data.events = events;
  }
  const claims = ops.filter(isJEventClaimOp).sort(
    (left, right) =>
      left.accountId.localeCompare(right.accountId) ||
      left.tx.data.jHeight - right.tx.data.jHeight ||
      left.tx.data.jBlockHash.localeCompare(right.tx.data.jBlockHash),
  );
  let claimIndex = 0;
  for (let index = 0; index < ops.length; index += 1) {
    if (isJEventClaimOp(ops[index]!)) ops[index] = claims[claimIndex++]!;
  }
}

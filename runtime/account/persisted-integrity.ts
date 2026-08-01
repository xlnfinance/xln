import type { AccountFrame, AccountReplica } from '../types/account';
import { createFrameHashSync } from './consensus/frame';

const assertFrameHash = (frame: AccountFrame, context: string): void => {
  if (frame.height === 0) {
    if (frame.stateHash !== '') throw new Error(`${context}.stateHash must be empty at genesis`);
    return;
  }
  const expected = createFrameHashSync(frame).toLowerCase();
  if (frame.stateHash.toLowerCase() !== expected) {
    throw new Error(
      `${context}.stateHash mismatch:stored=${frame.stateHash.toLowerCase()}:computed=${expected}`,
    );
  }
};

/**
 * Verify persisted frame linkage and canonical digests before installing the
 * replica into live state.
 *
 * A live AccountState root is deliberately not compared with currentFrame's
 * root: certified J-finality may advance the live bilateral projection without
 * creating another Account frame.
 *
 * Recomputed roots plus hashes remain signed-consensus evidence, not a new
 * Account storage authority layer; recovery and peer replay verify that trust.
 */
export const assertPersistedAccountReplicaIntegrity = (
  account: AccountReplica,
  context: string,
): void => {
  if (account.currentHeight !== account.currentFrame.height) {
    throw new Error(
      `${context}.currentHeight/currentFrame.height mismatch:` +
      `${account.currentHeight}/${account.currentFrame.height}`,
    );
  }
  assertFrameHash(account.currentFrame, `${context}.currentFrame`);

  if (!account.pendingFrame) return;
  if (account.pendingFrame.height !== account.currentHeight + 1) {
    throw new Error(`${context}.pendingFrame.height must follow currentHeight`);
  }
  const expectedPrevious = account.currentHeight === 0
    ? 'genesis'
    : account.currentFrame.stateHash.toLowerCase();
  if (account.pendingFrame.prevFrameHash.toLowerCase() !== expectedPrevious) {
    throw new Error(`${context}.pendingFrame.prevFrameHash does not link currentFrame`);
  }
  assertFrameHash(account.pendingFrame, `${context}.pendingFrame`);
};

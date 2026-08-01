import type { AccountFrame, AccountReplica } from '../types/account';
import { createFrameHash } from './consensus/frame';

export type PersistedAccountHankoVerifier = (
  hanko: string,
  digest: string,
  expectedEntityId: string,
) => Promise<boolean>;

const assertFrameHash = async (frame: AccountFrame, context: string): Promise<void> => {
  if (frame.height === 0) {
    if (frame.stateHash !== '') throw new Error(`${context}.stateHash must be empty at genesis`);
    return;
  }
  const expected = (await createFrameHash(frame)).toLowerCase();
  if (frame.stateHash.toLowerCase() !== expected) {
    throw new Error(
      `${context}.stateHash mismatch:stored=${frame.stateHash.toLowerCase()}:computed=${expected}`,
    );
  }
};

const assertHanko = async (
  verifier: PersistedAccountHankoVerifier | undefined,
  hanko: string | undefined,
  frameHash: string,
  expectedEntityId: string,
  context: string,
): Promise<void> => {
  if (hanko === undefined || verifier === undefined) return;
  if (!await verifier(hanko, frameHash, expectedEntityId)) {
    throw new Error(`${context} does not certify ${expectedEntityId}`);
  }
};

/**
 * Verify relationships that require canonical hashing or parent-owned board
 * authority. Shape decoding stays synchronous; storage/recovery must await
 * this function before installing the replica into live state.
 *
 * A live AccountState root is deliberately not compared with currentFrame's
 * root: certified J-finality may advance the live bilateral projection without
 * creating another Account frame.
 */
export const assertPersistedAccountReplicaIntegrity = async (
  account: AccountReplica,
  context: string,
  verifyHanko?: PersistedAccountHankoVerifier,
): Promise<void> => {
  if (account.currentHeight !== account.currentFrame.height) {
    throw new Error(
      `${context}.currentHeight/currentFrame.height mismatch:` +
      `${account.currentHeight}/${account.currentFrame.height}`,
    );
  }
  await assertFrameHash(account.currentFrame, `${context}.currentFrame`);
  await assertHanko(
    verifyHanko,
    account.currentFrameHanko,
    account.currentFrame.stateHash,
    account.proofHeader.fromEntity,
    `${context}.currentFrameHanko`,
  );
  await assertHanko(
    verifyHanko,
    account.counterpartyFrameHanko,
    account.currentFrame.stateHash,
    account.proofHeader.toEntity,
    `${context}.counterpartyFrameHanko`,
  );

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
  await assertFrameHash(account.pendingFrame, `${context}.pendingFrame`);
  const pendingInput = account.pendingAccountInput;
  const proposalHanko = pendingInput?.kind === 'frame'
    ? pendingInput.proposal.frameHanko
    : undefined;
  await assertHanko(
    verifyHanko,
    proposalHanko,
    account.pendingFrame.stateHash,
    account.proofHeader.fromEntity,
    `${context}.pendingAccountInput.proposal.frameHanko`,
  );
};

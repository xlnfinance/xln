import type { AccountFrame, AccountMachine, Env } from './types';
import { validateEntityState } from './validation-utils';
import { computeFrameHash } from './account-consensus';

const formatAccountLabel = (replicaKey: string, counterpartyId: string): string =>
  `${replicaKey.slice(-4)}↔${counterpartyId.slice(-4)}`;

const assertFrameShape = (frame: AccountFrame, label: string): void => {
  if (frame.tokenIds.length !== frame.deltas.length) {
    throw new Error(`[STRICT] ${label}: tokenIds/deltas length mismatch`);
  }
  if (frame.fullDeltaStates && frame.fullDeltaStates.length !== frame.tokenIds.length) {
    throw new Error(`[STRICT] ${label}: fullDeltaStates length mismatch`);
  }
};

const assertFrameHash = async (frame: AccountFrame, label: string): Promise<void> => {
  if (!frame.stateHash) {
    throw new Error(`[STRICT] ${label}: missing stateHash`);
  }
  if (!frame.fullDeltaStates) {
    throw new Error(`[STRICT] ${label}: missing fullDeltaStates`);
  }
  const recomputed = await computeFrameHash(frame);
  if (recomputed !== frame.stateHash) {
    throw new Error(`[STRICT] ${label}: stateHash mismatch (recomputed=${recomputed}, stored=${frame.stateHash})`);
  }
};

const assertAccountFrames = async (
  account: AccountMachine,
  replicaKey: string,
  counterpartyId: string
): Promise<void> => {
  const label = formatAccountLabel(replicaKey, counterpartyId);
  const { currentFrame } = account;

  if (currentFrame.height !== account.currentHeight) {
    throw new Error(`[STRICT] ${label}: currentFrame.height ${currentFrame.height} != currentHeight ${account.currentHeight}`);
  }
  if (account.proofHeader.disputeNonce !== account.currentHeight) {
    throw new Error(`[STRICT] ${label}: disputeNonce ${account.proofHeader.disputeNonce} != currentHeight ${account.currentHeight}`);
  }

  assertFrameShape(currentFrame, `${label} currentFrame`);
  if (account.currentHeight > 0) {
    await assertFrameHash(currentFrame, `${label} currentFrame`);
  }

  if (account.frameHistory.length > 0) {
    const lastFrame = account.frameHistory[account.frameHistory.length - 1];
    if (lastFrame.height !== account.currentHeight) {
      throw new Error(`[STRICT] ${label}: frameHistory tail height ${lastFrame.height} != currentHeight ${account.currentHeight}`);
    }
    if (lastFrame.stateHash !== account.currentFrame.stateHash) {
      throw new Error(`[STRICT] ${label}: frameHistory tail hash mismatch`);
    }
  }

  if (account.pendingFrame) {
    const pending = account.pendingFrame;
    const expectedHeight = account.currentHeight + 1;
    if (pending.height !== expectedHeight) {
      throw new Error(`[STRICT] ${label}: pendingFrame.height ${pending.height} != expected ${expectedHeight}`);
    }
    const expectedPrev = account.currentHeight === 0 ? 'genesis' : account.currentFrame.stateHash;
    if (pending.prevFrameHash !== expectedPrev) {
      throw new Error(`[STRICT] ${label}: pendingFrame.prevFrameHash mismatch`);
    }
    assertFrameShape(pending, `${label} pendingFrame`);
    await assertFrameHash(pending, `${label} pendingFrame`);
  }
};

export async function assertRuntimeStateStrict(env: Env): Promise<void> {
  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    validateEntityState(replica.state, `strictScenario.${replicaKey}`);
    for (const [counterpartyId, account] of replica.state.accounts.entries()) {
      await assertAccountFrames(account, replicaKey, counterpartyId);
    }
  }
}

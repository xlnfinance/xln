/**
 * Quorum Hankos are self-authenticating witnesses, not unique consensus
 * bytes: different valid threshold subsets can authorize the same hash.
 * Commit the authorized payload everywhere while retaining the exact witness
 * locally for contract submission.
 */

import type { AccountFrame, AccountTx, SettlementWorkspace } from '../../types/account';
import { cloneIsolatedAccountTx } from '../../protocol/state/account-input-clone';

export const settlementWorkspaceWithoutHankos = (
  workspace: SettlementWorkspace | undefined,
): unknown => {
  if (!workspace) return undefined;
  const {
    leftHanko: _leftHanko,
    rightHanko: _rightHanko,
    postSettlementDisputeProof,
    ...state
  } = workspace;
  if (!postSettlementDisputeProof) return state;
  const {
    leftHanko: _postLeftHanko,
    rightHanko: _postRightHanko,
    ...postSettlementState
  } = postSettlementDisputeProof;
  return { ...state, postSettlementDisputeProof: postSettlementState };
};

/**
 * The bilateral Account root excludes both sides' quorum encodings because
 * they are attached after their signed targets exist. The owning Entity root
 * is stricter: an exact peer witness selected by its proposer is deterministic
 * input evidence, while its own independently assembled subset stays shadow.
 */
export const counterpartySettlementHankos = (
  workspace: SettlementWorkspace | undefined,
  localIsLeft: boolean,
): unknown => {
  if (!workspace) return undefined;
  const settlementHanko = localIsLeft ? workspace.rightHanko : workspace.leftHanko;
  const postProofHanko = localIsLeft
    ? workspace.postSettlementDisputeProof?.rightHanko
    : workspace.postSettlementDisputeProof?.leftHanko;
  if (!settlementHanko && !postProofHanko) return undefined;
  return {
    ...(settlementHanko ? { settlementHanko } : {}),
    ...(postProofHanko ? { postProofHanko } : {}),
  };
};

/** Read-only projection: only a `hanko` settle_transition has Hankos to strip, so only it is cloned. */
export const accountTxWithoutPostCommitHankos = (tx: AccountTx): AccountTx => {
  if (!(tx.type === 'settle_transition' && tx.data.kind === 'hanko')) return tx;
  const unsigned = cloneIsolatedAccountTx(tx);
  if (unsigned.type === 'settle_transition' && unsigned.data.kind === 'hanko') {
    delete unsigned.data.settlementHanko;
    delete unsigned.data.postProof.hanko;
  }
  return unsigned;
};

/** Owned copy for the certified history record: every tx is cloned, hankos stripped. */
export const accountFrameWithoutPostCommitHankos = (frame: AccountFrame): AccountFrame => ({
  ...frame,
  accountTxs: frame.accountTxs.map(tx => accountTxWithoutPostCommitHankos(cloneIsolatedAccountTx(tx))),
});

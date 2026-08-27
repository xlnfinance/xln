import type { AccountFrame, AccountReplica, AccountTx } from '../../../types/account';
import { HEAVY_LOGS } from '../../../support/debug-flags';
import { createStructuredLogger } from '../../../support/logger';
import {
  computeFrameHash,
} from '../frame/hash';
import {
  computeAccountStateRoot,
  computeAccountStateSectionHashes,
  type AccountStateRootTiming,
} from '../../commitment/state-root';
import type { ProposeAccountFrameResult } from '../types';
import { proposeAccountFrameRejected } from '../result';
import { cloneIsolatedAccountTx } from '../../../protocol/state/account-input-clone';

const accountLog = createStructuredLogger('account');

export type ProposalFrameBuildResult =
  | {
      ok: true;
      frame: AccountFrame;
      stateRootTiming: AccountStateRootTiming;
    }
  | {
      ok: false;
      result: ProposeAccountFrameResult;
    };

const buildFrameData = async (
  account: AccountReplica,
  validTxs: readonly AccountTx[],
  timestamp: number,
  jHeight: number,
  accountStateRoot: string,
): Promise<AccountFrame> => {
  const frame: AccountFrame = {
    height: account.currentHeight + 1,
    timestamp,
    jHeight,
    accountTxs: validTxs.map(cloneIsolatedAccountTx),
    prevFrameHash: account.currentHeight === 0
      ? 'genesis'
      : account.currentFrame.stateHash,
    accountStateRoot,
    stateHash: '',
  };
  frame.stateHash = computeFrameHash(frame);
  return frame;
};

export const buildProposalFrame = async (
  account: AccountReplica,
  candidate: AccountReplica,
  validTxs: readonly AccountTx[],
  timestamp: number,
  jHeight: number,
  events: string[],
  checkpointProfile: (label: string) => void,
  collectStateRootTiming = false,
): Promise<ProposalFrameBuildResult> => {
  // Fine-grained timing bypasses the Account-root memo by design. Enabling it
  // unconditionally made production compute the same candidate root again
  // when the Account leaf entered the Entity radix. The phase checkpoint is
  // sufficient for slow-path logs; detailed sections are explicit profiling.
  const stateRootTiming: AccountStateRootTiming | undefined = collectStateRootTiming ? {} : undefined;
  let accountStateRoot: string;
  try {
    accountStateRoot = computeAccountStateRoot(candidate.state, stateRootTiming, 'proposalFrame');
  } catch (error) {
    return {
      ok: false,
      result: proposeAccountFrameRejected(
        `ACCOUNT_STATE_ROOT_BUILD_FAILED: ${(error as Error).message}`,
        events,
      ),
    };
  }
  checkpointProfile('stateRoot');
  const frameData = await buildFrameData(
    account,
    validTxs,
    timestamp,
    jHeight,
    accountStateRoot,
  );
  checkpointProfile('frameHash');
  if (HEAVY_LOGS) {
    accountLog.debug('proposal.frame_built', {
      height: frameData.height,
      stateHash: frameData.stateHash,
      accountStateRoot,
      accountStateSectionHashes: computeAccountStateSectionHashes(candidate.state),
      txs: frameData.accountTxs.map(tx => tx.type),
    });
  }

  // frameData is assembled in-module from already-decoded mempool txs. Its size is
  // bounded by the Account mempool limit; the Entity wire fit bounds the frame.
  checkpointProfile('frameValidation');
  return { ok: true, frame: frameData, stateRootTiming: stateRootTiming ?? {} };
};

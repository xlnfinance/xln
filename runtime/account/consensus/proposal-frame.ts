import type { AccountFrame, AccountReplica, AccountTx } from '../../types/account';
import { HEAVY_LOGS } from '../../infra/debug-flags';
import { safeStringify } from '../../protocol/serialization';
import { decodeAccountFrame } from '../frame-validation';
import { createStructuredLogger } from '../../infra/logger';
import {
  createFrameHash,
  MAX_FRAME_SIZE_BYTES,
} from './frame';
import { isLeftEntity } from '../utils';
import { shouldIncludeToken } from './helpers';
import {
  computeAccountStateRoot,
  computeAccountStateSectionHashes,
  type AccountStateRootTiming,
} from '../state-root';
import type { ProposeAccountFrameResult } from './types';

const accountLog = createStructuredLogger('account');

export type ProposalFrameBuildResult =
  | {
      success: true;
      frame: AccountFrame;
      stateRootTiming: AccountStateRootTiming;
    }
  | {
      success: false;
      result: ProposeAccountFrameResult;
    };

const collectFrameDeltas = (machine: AccountReplica): AccountFrame['deltas'] => {
  const deltas: AccountFrame['deltas'] = [];
  const sortedTokens = [...machine.state.deltas.entries()].sort((left, right) => left[0] - right[0]);
  for (const [tokenId, delta] of sortedTokens) {
    // Only off-chain bilateral state belongs in frame comparison. `ondelta`
    // follows independently observed J events and may arrive at different
    // Runtime frames on the two peers.
    if (!shouldIncludeToken(delta, delta.offdelta)) {
      if (HEAVY_LOGS) accountLog.debug('token.skip_unused', { tokenId });
      continue;
    }
    deltas.push({ ...delta });
  }
  return deltas;
};

const buildFrameData = async (
  account: AccountReplica,
  candidate: AccountReplica,
  validTxs: readonly AccountTx[],
  timestamp: number,
  jHeight: number,
  accountStateRoot: string,
): Promise<AccountFrame> => {
  const frame: AccountFrame = {
    height: account.currentHeight + 1,
    timestamp,
    jHeight,
    accountTxs: structuredClone([...validTxs]),
    prevFrameHash: account.currentHeight === 0
      ? 'genesis'
      : account.currentFrame.stateHash || '',
    accountStateRoot,
    stateHash: '',
    byLeft: isLeftEntity(account.proofHeader.fromEntity, account.proofHeader.toEntity),
    deltas: collectFrameDeltas(candidate),
  };
  frame.stateHash = await createFrameHash(frame);
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
): Promise<ProposalFrameBuildResult> => {
  const stateRootTiming: AccountStateRootTiming = {};
  let accountStateRoot: string;
  try {
    accountStateRoot = computeAccountStateRoot(candidate.state, stateRootTiming);
  } catch (error) {
    return {
      success: false,
      result: {
        success: false,
        error: `ACCOUNT_STATE_ROOT_BUILD_FAILED: ${(error as Error).message}`,
        events,
      },
    };
  }
  checkpointProfile('stateRoot');
  const frameData = await buildFrameData(
    account,
    candidate,
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

  let frame: AccountFrame;
  try {
    frame = decodeAccountFrame(frameData, 'proposeAccountFrame');
  } catch (error) {
    accountLog.warn('frame.validation_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      result: {
        success: false,
        error: `Frame validation failed: ${(error as Error).message}`,
        events,
      },
    };
  }
  const frameSize = safeStringify(frame).length;
  if (frameSize > MAX_FRAME_SIZE_BYTES) {
    accountLog.warn('frame.too_large', { frameSize, limit: MAX_FRAME_SIZE_BYTES });
    return {
      success: false,
      result: {
        success: false,
        error: `Frame exceeds ${MAX_FRAME_SIZE_BYTES} byte limit: ${frameSize} bytes`,
        events,
      },
    };
  }
  checkpointProfile('frameValidation');
  return { success: true, frame, stateRootTiming };
};

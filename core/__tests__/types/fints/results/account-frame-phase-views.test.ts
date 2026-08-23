import { describe, expect, test } from 'bun:test';

import {
  isCertifiedAccountFrameAck,
  isCertifiedAccountFrameProposal,
  isDraftAccountFrameAck,
  isDraftAccountFrameProposal,
} from '../../../../account/consensus/frame/phase-views';
import type { AccountFrame, AccountFrameAck, AccountFrameProposal } from '../../../../types/account';

const frame = (): AccountFrame => ({
  height: 1,
  timestamp: 1,
  jHeight: 1,
  accountTxs: [],
  prevFrameHash: 'genesis',
  accountStateRoot: `0x${'11'.repeat(32)}`,
  stateHash: `0x${'22'.repeat(32)}`,
  byLeft: true,
  deltas: [],
});

describe('FinTS Account frame certification views', () => {
  test('narrows proposal and ACK phases without cloning', () => {
    const proposal: AccountFrameProposal = { frame: frame() };
    const ack: AccountFrameAck = { height: 1, frameHash: proposal.frame.stateHash };
    expect(isDraftAccountFrameProposal(proposal)).toBe(true);
    expect(isDraftAccountFrameAck(ack)).toBe(true);

    proposal.frameHanko = '0x01';
    ack.frameHanko = '0x02';
    expect(isCertifiedAccountFrameProposal(proposal)).toBe(true);
    expect(isCertifiedAccountFrameAck(ack)).toBe(true);
  });

  test('rejects a partially certified optional dispute Hanko', () => {
    const proposal: AccountFrameProposal = {
      frame: frame(),
      frameHanko: '0x01',
      disputeHanko: {
        hash: `0x${'33'.repeat(32)}`,
        proofBodyHash: `0x${'44'.repeat(32)}`,
        proofNonce: 1,
        proposerIsLeft: true,
      },
    };
    expect(isCertifiedAccountFrameProposal(proposal)).toBe(false);
  });
});

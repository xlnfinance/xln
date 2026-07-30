import { expect, test } from 'bun:test';

import { validateProposedEntityFrame } from '../entity/consensus/frame-validation';

test('proposed Entity frames reject malformed transactions before replay', () => {
  const malformedFrame = {
    height: 1,
    parentFrameHash: 'genesis',
    stateRoot: `0x${'11'.repeat(32)}`,
    authorityRoot: `0x${'22'.repeat(32)}`,
    timestamp: 1,
    txs: [{ type: 'chat', data: { from: 'validator-without-message' } }],
    events: [],
    hash: `0x${'33'.repeat(32)}`,
    leader: { proposerSignerId: `0x${'44'.repeat(20)}`, view: 0 },
  };

  expect(() => validateProposedEntityFrame(malformedFrame, 'EntityFrame'))
    .toThrow('EntityFrame.txs_0_DATA_FIELDS');
});

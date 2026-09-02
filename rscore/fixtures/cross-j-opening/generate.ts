/** Canonical TypeScript oracle for cross-J opening proposal selection. */
import { safeStringify } from '../../../core/protocol/serialization';
import {
  CROSS_J_OPENING_VECTOR_SPECS,
  executeCrossJOpeningVector,
} from './cases';

const fixture = {
  version: 1,
  canonicalSource: 'TypeScript selectCrossJOpeningAccountProposalTxs',
  frame: {
    height: 3,
    timestamp: 1_700_000_000_000,
    jHeight: 7,
    prevFrameHash: `0x${'71'.repeat(32)}`,
    accountStateRoot: `0x${'72'.repeat(32)}`,
  },
  cases: CROSS_J_OPENING_VECTOR_SPECS.map(spec => ({
    ...spec,
    expected: executeCrossJOpeningVector(spec),
  })),
};

process.stdout.write(`${safeStringify(fixture, 2)}\n`);

import { expect, test } from 'bun:test';

import { buildHltEntityEffectEvidence } from '../../../../scripts/operations/hlt/replay/entity-effect-evidence';
import type { FrameLogEntry } from '../../../../types/logging';

test('projects request_collateral_committed into the canonical Rust effect commitment', () => {
  const entry = {
    id: 1,
    timestamp: 1_700_000_000_000,
    level: 'info',
    category: 'account',
    message: 'request_collateral_committed',
    data: {
      entityId: `0x${'11'.repeat(32)}`,
      accountId: `0x${'22'.repeat(32)}`,
      tokenId: 7,
      requestedAmount: '12345678901234567890',
      prepaidFee: '321',
      requestedAt: 1_700_000_000_123,
    },
  } satisfies FrameLogEntry;

  expect(buildHltEntityEffectEvidence(42, [entry])).toEqual({
    runtimeHeight: 42,
    effectCount: 1,
    orderedEffectDigest: '0xe47868974d9809f82aaba1940660459154bbb7d87931db8fe0f74d19354d9dd8',
  });
});

import { expect, test } from 'bun:test';

import {
  getAccountUiStatus,
  getAccountUiStatusDescription,
  getAccountUiStatusLabel,
} from '../../frontend/src/lib/utils/accountStatus';

test('account pendingFrame is labeled as off-chain account work, not on-chain confirmation', () => {
  const status = getAccountUiStatus({
    status: 'active',
    mempool: [],
    pendingFrame: { height: 1 },
  } as any);

  expect(status).toBe('sent');
  expect(getAccountUiStatusLabel(status)).toBe('PENDING');
  expect(getAccountUiStatusDescription(status).toLowerCase()).toContain('off-chain');
  expect(getAccountUiStatusDescription(status).toLowerCase()).not.toContain('on-chain');
});

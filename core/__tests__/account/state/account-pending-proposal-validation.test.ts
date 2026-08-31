import { expect, test } from 'bun:test';

import { validatePendingAccountProposal } from '../../../account/validation/pending-proposal-validation';

test('rejects a retired standalone frame pending input', () => {
  expect(() => validatePendingAccountProposal({
    state: {},
    pendingFrame: {},
    pendingAccountInput: { kind: 'frame' },
  }, 'account')).toThrow('pendingAccountInput must carry a frame proposal');
});

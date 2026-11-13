import { expect, test } from 'bun:test';
import { executionPolicy } from '../../../../jurisdictions/scripts/deployment/engine.cjs';
import { executeStack } from '../../../../jurisdictions/scripts/deploy-stack.cjs';
import { runStack } from '../../../../jurisdictions/scripts/deployment/dispatch.cjs';

test('preserves an explicit operator fee-bump prohibition and retry policy when network fields are undefined', () => {
  const policy = executionPolicy({ disableFeeBumping: true, maxRetries: 9, retryInterval: 1200 }, {
    disableFeeBumping: undefined, maxRetries: undefined, retryInterval: undefined,
  });
  expect(policy.disableFeeBumping).toBeTrue();
  expect(policy.maxRetries).toBe(9);
  expect(policy.retryInterval).toBe(1200);
  expect(policy.requiredConfirmations).toBe(1);
});

test('uses native Hardhat global-first precedence and network retry defaults', () => {
  expect(executionPolicy({ disableFeeBumping: false, maxRetries: 7, retryInterval: 900 }, {
    disableFeeBumping: true, maxRetries: 2, retryInterval: 1,
  })).toMatchObject({ disableFeeBumping: false, maxRetries: 7, retryInterval: 900 });
  expect(executionPolicy({}, { disableFeeBumping: true, maxRetries: 4, retryInterval: 500 }))
    .toMatchObject({ disableFeeBumping: true, maxRetries: 4, retryInterval: 500 });
});

test('imports executor and variant dispatcher as callable functions without starting an operation', () => {
  expect(typeof executeStack).toBe('function');
  expect(typeof runStack).toBe('function');
});

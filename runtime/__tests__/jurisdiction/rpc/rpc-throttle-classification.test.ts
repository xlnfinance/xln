import { expect, test } from 'bun:test';

import { isTransientRpcUnavailableError } from '../../../jurisdiction/adapter/rpc-public';
import { isRpcWatcherTransientError } from '../../../jurisdiction/adapter/rpc/rpc-adapter';
import { ReceiptAvailabilityError } from '../../../jurisdiction/adapter/receipt-root';

/**
 * A shared public RPC rate-limits by IP. Classifying that throttle as fatal
 * permanently halted the jurisdiction watcher for the whole adapter instance,
 * and every restart afterwards short-circuited on the recorded fatal error.
 */
test('HTTP 429 throttling is transient, like the 5xx family already in the list', () => {
  expect(isTransientRpcUnavailableError(new Error('RPC_BATCH_HTTP_429'))).toBe(true);
  expect(isTransientRpcUnavailableError(new Error('429 Too Many Requests'))).toBe(true);
  expect(isTransientRpcUnavailableError(new Error('server response 429'))).toBe(true);
  expect(isTransientRpcUnavailableError(new Error('responseStatus: 429'))).toBe(true);
});

test('existing transient classifications still hold', () => {
  for (const message of [
    'RPC_BATCH_HTTP_503',
    'RPC_BATCH_HTTP_502',
    '504 Gateway Timeout',
    'ECONNREFUSED',
    'Failed to fetch',
    'RPC_BATCH_TIMEOUT:30000',
  ]) {
    expect(isTransientRpcUnavailableError(new Error(message))).toBe(true);
  }
});

test('typed receipt availability failures stay retryable at the watcher controller boundary', () => {
  expect(isRpcWatcherTransientError(
    new ReceiptAvailabilityError('J_RECEIPT_BLOCK_MISSING', '123'),
  )).toBe(true);
  expect(isRpcWatcherTransientError(
    new ReceiptAvailabilityError('J_RECEIPT_TRANSACTION_RECEIPT_MISSING', '0x1234'),
  )).toBe(true);
  expect(isRpcWatcherTransientError(new Error('J_RECEIPT_ROOT_MISMATCH'))).toBe(false);
});

test('genuine faults stay fatal so a broken stack still fails loudly', () => {
  for (const message of [
    'RPC_BATCH_HTTP_400',
    'RPC_BATCH_HTTP_401',
    'RPC_BATCH_HTTP_404',
    'DEPOSITORY_ENTITY_PROVIDER_BINDING_MISMATCH',
    'J_RECEIPT_ROOT_MISMATCH',
  ]) {
    expect(isTransientRpcUnavailableError(new Error(message))).toBe(false);
  }
});

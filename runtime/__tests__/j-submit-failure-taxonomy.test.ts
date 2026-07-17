import { describe, expect, test } from 'bun:test';

import { isTransientJAdapterStartupError } from '../jadapter/retry';
import { makeJAdapterFailureResult } from '../jadapter/failure';
import { isTransientJSubmitFailure } from '../machine/j-submit';

const ethersError = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(message), { code });

describe('structured J-adapter failure taxonomy', () => {
  test.each(['NETWORK_ERROR', 'SERVER_ERROR', 'TIMEOUT'])(
    '%s remains transient even when its message lacks transport keywords',
    (code) => {
      const error = ethersError(code, 'provider operation failed');
      expect(isTransientJSubmitFailure(error)).toBe(true);
      expect(isTransientJAdapterStartupError(error)).toBe(true);
    },
  );

  test('CALL_EXCEPTION and explicit revert stay terminal even with transient-looking text', () => {
    const callException = ethersError('CALL_EXCEPTION', 'execution reverted after ECONNRESET');
    expect(isTransientJSubmitFailure(callException)).toBe(false);
    expect(isTransientJAdapterStartupError(callException)).toBe(false);
    expect(isTransientJSubmitFailure('staticCall revert: server timeout')).toBe(false);
  });

  test('adapter result preserves the original ethers code and chosen category', () => {
    expect(makeJAdapterFailureResult(ethersError('SERVER_ERROR', 'provider operation failed')))
      .toEqual({
        success: false,
        error: 'provider operation failed',
        failure: {
          category: 'transient',
          code: 'SERVER_ERROR',
          message: 'provider operation failed',
        },
      });
    expect(makeJAdapterFailureResult(ethersError('CALL_EXCEPTION', 'execution reverted')))
      .toMatchObject({ failure: { category: 'terminal', code: 'CALL_EXCEPTION' } });
  });

  test.each([
    ['NONCE_EXPIRED', 'nonce has already been used'],
    ['REPLACEMENT_UNDERPRICED', 'replacement fee too low'],
    ['TRANSACTION_REPLACED', 'transaction replaced'],
    ['UNKNOWN_ERROR', 'nonce too low'],
  ])('%s nonce-envelope contention remains transient', (code, message) => {
    const error = ethersError(code, message);
    expect(isTransientJSubmitFailure(error)).toBe(true);
    expect(isTransientJAdapterStartupError(error)).toBe(true);
    expect(makeJAdapterFailureResult(error).failure).toMatchObject({ category: 'transient', code });
  });

  test('revert evidence still outranks nonce-looking text', () => {
    const error = ethersError('UNKNOWN_ERROR', 'execution reverted: nonce too low');
    expect(makeJAdapterFailureResult(error).failure.category).toBe('terminal');
  });

  test('nested ethers JSON-RPC nonce evidence is classified without replacing its root message', () => {
    const error = Object.assign(new Error('could not coalesce error'), {
      code: 'UNKNOWN_ERROR',
      info: { error: { code: -32_000, message: 'nonce too low' } },
    });
    expect(makeJAdapterFailureResult(error).failure).toEqual({
      category: 'transient',
      code: 'UNKNOWN_ERROR',
      message: 'could not coalesce error',
    });
  });
});

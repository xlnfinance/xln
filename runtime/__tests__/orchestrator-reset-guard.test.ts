import { describe, expect, test } from 'bun:test';

import {
  assertOrchestratorResetAllowed,
  ORCHESTRATOR_RESET_CONFIRMATION,
  OrchestratorResetRejectedError,
} from '../orchestrator/reset-guard';

const makeRequest = (headers: Record<string, string> = {}): Request =>
  new Request('http://127.0.0.1:8080/api/reset', {
    method: 'POST',
    headers,
  });

const expectRejected = (
  fn: () => void,
  code: string,
  status: number,
): void => {
  try {
    fn();
    throw new Error('expected rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(OrchestratorResetRejectedError);
    expect((error as OrchestratorResetRejectedError).code).toBe(code);
    expect((error as OrchestratorResetRejectedError).status).toBe(status);
  }
};

describe('orchestrator reset guardrails', () => {
  test('rejects reset when the endpoint is not explicitly enabled', () => {
    expectRejected(
      () => assertOrchestratorResetAllowed(
        makeRequest(),
        { confirm: ORCHESTRATOR_RESET_CONFIRMATION },
        { resetAllowed: false, bindHost: '127.0.0.1' },
      ),
      'RESET_DISABLED',
      403,
    );
  });

  test('requires an explicit destructive-action confirmation even on local dev', () => {
    expectRejected(
      () => assertOrchestratorResetAllowed(
        makeRequest(),
        {},
        { resetAllowed: true, bindHost: '127.0.0.1' },
      ),
      'RESET_CONFIRMATION_REQUIRED',
      428,
    );
  });

  test('allows confirmed local reset without a token', () => {
    expect(() => assertOrchestratorResetAllowed(
      makeRequest(),
      { confirm: ORCHESTRATOR_RESET_CONFIRMATION },
      { resetAllowed: true, bindHost: '127.0.0.1' },
    )).not.toThrow();
  });

  test('rejects public bind reset unless a token is configured and supplied', () => {
    expectRejected(
      () => assertOrchestratorResetAllowed(
        makeRequest(),
        { confirm: ORCHESTRATOR_RESET_CONFIRMATION },
        { resetAllowed: true, bindHost: '0.0.0.0' },
      ),
      'RESET_TOKEN_REQUIRED_FOR_PUBLIC_BIND',
      403,
    );
  });

  test('requires the configured reset token', () => {
    expectRejected(
      () => assertOrchestratorResetAllowed(
        makeRequest({ 'X-XLN-Reset-Token': 'wrong' }),
        { confirm: ORCHESTRATOR_RESET_CONFIRMATION },
        { resetAllowed: true, bindHost: '127.0.0.1', resetToken: 'secret' },
      ),
      'RESET_TOKEN_INVALID',
      401,
    );

    expect(() => assertOrchestratorResetAllowed(
      makeRequest({ Authorization: 'Bearer secret' }),
      { confirm: ORCHESTRATOR_RESET_CONFIRMATION },
      { resetAllowed: true, bindHost: '0.0.0.0', resetToken: 'secret' },
    )).not.toThrow();
  });
});

import { describe, expect, test } from 'bun:test';

import {
  assertOrchestratorResetAllowed,
  ORCHESTRATOR_RESET_CONFIRMATION,
  OrchestratorResetRejectedError,
} from '../../../orchestrator/server/reset-guard';
import { handleResetHttpRequest, type ResetHttpDeps } from '../../../orchestrator/server/reset-http';
import type { AggregatedHealth } from '../../../orchestrator/orchestrator-types';

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
        { resetAllowed: false, operatorAuthorized: true, bindHost: '127.0.0.1' },
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
        { resetAllowed: true, operatorAuthorized: true, bindHost: '127.0.0.1' },
      ),
      'RESET_CONFIRMATION_REQUIRED',
      428,
    );
  });

  test('allows confirmed local reset without a token', () => {
    expect(() => assertOrchestratorResetAllowed(
      makeRequest(),
      { confirm: ORCHESTRATOR_RESET_CONFIRMATION },
      { resetAllowed: true, operatorAuthorized: true, bindHost: '127.0.0.1' },
    )).not.toThrow();
  });

  test('requires operator authority even when reset is enabled on loopback', () => {
    expectRejected(
      () => assertOrchestratorResetAllowed(
        makeRequest(),
        { confirm: ORCHESTRATOR_RESET_CONFIRMATION },
        { resetAllowed: true, operatorAuthorized: false, bindHost: '127.0.0.1' },
      ),
      'RESET_OPERATOR_AUTH_REQUIRED',
      403,
    );
  });

  test('rejects public bind reset unless a token is configured and supplied', () => {
    expectRejected(
      () => assertOrchestratorResetAllowed(
        makeRequest(),
        { confirm: ORCHESTRATOR_RESET_CONFIRMATION },
        { resetAllowed: true, operatorAuthorized: true, bindHost: '0.0.0.0' },
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
        { resetAllowed: true, operatorAuthorized: true, bindHost: '127.0.0.1', resetToken: 'secret' },
      ),
      'RESET_TOKEN_INVALID',
      401,
    );

    expect(() => assertOrchestratorResetAllowed(
      makeRequest({ Authorization: 'Bearer secret' }),
      { confirm: ORCHESTRATOR_RESET_CONFIRMATION },
      { resetAllowed: true, operatorAuthorized: true, bindHost: '0.0.0.0', resetToken: 'secret' },
    )).not.toThrow();
  });

  test('compares the reset token as a secret, rejecting an equal-length mismatch', () => {
    const config = { resetAllowed: true, operatorAuthorized: true, bindHost: '0.0.0.0', resetToken: 'reset-secret-1' };
    const body = { confirm: ORCHESTRATOR_RESET_CONFIRMATION };
    expectRejected(
      () => assertOrchestratorResetAllowed(makeRequest({ 'X-XLN-Reset-Token': 'reset-secret-2' }), body, config),
      'RESET_TOKEN_INVALID',
      401,
    );
    expect(() => assertOrchestratorResetAllowed(
      makeRequest({ 'X-XLN-Reset-Token': 'reset-secret-1' }),
      body,
      config,
    )).not.toThrow();
  });
});

describe('orchestrator reset HTTP body', () => {
  const resetCalls: Array<{ enableMarketMaker: boolean; enableCustody: boolean }> = [];
  const deps: ResetHttpDeps = {
    resetAllowed: true,
    bindHost: '127.0.0.1',
    resetToken: '',
    mmEnabled: true,
    custodyEnabled: true,
    ensureResetWithOptions: async options => {
      resetCalls.push(options);
    },
    pollAllHubHealth: async () => {},
    pollMarketMakerHealth: async () => {},
    buildAggregatedHealthResponse: async () => ({ systemOk: true } as unknown as AggregatedHealth),
    serializeError: error => String(error),
  };
  const post = (body: string): Request => new Request('http://127.0.0.1:8080/api/reset', {
    method: 'POST',
    headers: { 'x-xln-reset-confirm': ORCHESTRATOR_RESET_CONFIRMATION },
    body,
  });

  test('a malformed reset body is rejected with 400 instead of resetting with defaults', async () => {
    resetCalls.length = 0;
    for (const body of ['{"enableMarketMaker": false,', '[]', '"reset"']) {
      const response = await handleResetHttpRequest(post(body), '/api/reset', true, {}, deps);
      expect(response?.status).toBe(400);
      expect(await response?.text()).toContain('RESET_BODY_INVALID');
    }
    expect(resetCalls).toEqual([]);
  });

  test('an empty body still resets with the configured options', async () => {
    resetCalls.length = 0;
    const response = await handleResetHttpRequest(post(''), '/api/reset', true, {}, deps);
    expect(response?.status).toBe(200);
    expect(resetCalls).toEqual([{ enableMarketMaker: true, enableCustody: true }]);
  });
});

import { expect, test } from 'bun:test';

import { isRuntimeTransportReady, runtimeTransportStartupResponse } from '../../../api/server/rpc/startup-gate';

test('Runtime transport rejects every pre-ready and failed startup phase without queueing', () => {
  for (const phase of ['starting', 'runtime', 'bootstrap', 'failed'] as const) {
    expect(isRuntimeTransportReady(phase)).toBeFalse();
    const response = runtimeTransportStartupResponse(phase);
    expect(response?.status).toBe(503);
    expect(response?.headers.get('Retry-After')).toBe('1');
  }
  expect(isRuntimeTransportReady('ready')).toBeTrue();
  expect(runtimeTransportStartupResponse('ready')).toBeNull();
});

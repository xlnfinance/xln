import { describe, expect, test } from 'bun:test';
import { requiresLocalNodeOperator } from '../server/node-http-access';

describe('node HTTP access boundary', () => {
  test('keeps control and diagnostic state local while leaving public data routes explicit', () => {
    const privateUrls = [
      '/api/info',
      '/api/account/status',
      '/api/control/p2p/stop',
      '/api/control/runtime-input/receipt/status',
      '/api/debug/activity',
      '/api/health/full',
      '/api/health?full=1',
    ];
    for (const path of privateUrls) {
      expect(requiresLocalNodeOperator(new URL(`http://node${path}`))).toBe(true);
    }

    for (const path of ['/api/health', '/api/tokens', '/api/faucet/offchain']) {
      expect(requiresLocalNodeOperator(new URL(`http://node${path}`))).toBe(false);
    }
  });
});

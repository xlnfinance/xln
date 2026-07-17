import { describe, expect, test } from 'bun:test';

import { safeStringify } from '../protocol/serialization';

describe('JAdapter dispute diagnostics', () => {
  test('serialize bigint fields without crashing the submit path', async () => {
    const diagnostics = [{ nonce: 7n, threshold: 2n, entityIndexes: [0n, 1n] }];
    expect(() => safeStringify(diagnostics)).not.toThrow();

    const source = await Bun.file(new URL('../jadapter/rpc.ts', import.meta.url)).text();
    expect(source).toContain('disputeStart.batch ${safeStringify(disputeStartDebug)}');
    expect(source).toContain('disputeStart=${safeStringify(disputeStartDebug)}');
    expect(source).not.toContain('JSON.stringify(disputeStartDebug)');
  });
});

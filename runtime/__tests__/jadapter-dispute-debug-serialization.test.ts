import { describe, expect, test } from 'bun:test';

import { safeStringify } from '../protocol/serialization';

describe('JAdapter dispute diagnostics', () => {
  test('serialize bigint fields without crashing the submit path', async () => {
    const diagnostics = [{ nonce: 7n, threshold: 2n, entityIndexes: [0n, 1n] }];
    expect(() => safeStringify(diagnostics)).not.toThrow();

    const source = await Promise.all([
      'rpc-public.ts',
      'rpc/rpc-adapter.ts',
      'rpc/write/rpc-batch-preflight.ts',
      'rpc/rpc-lifecycle.ts',
      'rpc/rpc-reads.ts',
      'rpc/wallet/rpc-wallet-writes.ts',
    ].map(file => Bun.file(new URL(`../jurisdiction/adapter/${file}`, import.meta.url)).text())).then(parts => parts.join('\n'));
    expect(source).toContain('disputeStart=${safeStringify(input.disputeStartDebug)}');
    expect(source).not.toContain('JSON.stringify(input.disputeStartDebug)');
  });
});

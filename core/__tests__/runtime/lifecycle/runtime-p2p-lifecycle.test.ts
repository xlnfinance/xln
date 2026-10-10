import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('runtime p2p lifecycle diagnostics use structured logging', () => {
  const source = readFileSync(join(process.cwd(), 'core/runtime/envelope/p2p-lifecycle.ts'), 'utf8');

  expect(source).toContain("const p2pLifecycleLog = createStructuredLogger('p2p.lifecycle');");
  expect(source).toContain("p2pLifecycleLog.info('gossip.accepted'");
  expect(source).not.toContain('console.');
});

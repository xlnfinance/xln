import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('entity frame hash diagnostics use structured logging only', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/entity/consensus/frame.ts'), 'utf8');

  expect(source).toContain("createStructuredLogger('entity.frame')");
  expect(source).toContain("entityFrameLog.debug('frame_hash.input'");
  expect(source).not.toContain('console.');
});

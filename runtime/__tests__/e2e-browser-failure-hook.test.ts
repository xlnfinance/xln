import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Playwright browser failure hook', () => {
  test('settles evidence for every page before guaranteed parallel quiescence', () => {
    const fixture = readFileSync(resolve(process.cwd(), 'tests/global-setup.ts'), 'utf8');

    expect(fixture).toContain('Promise.allSettled(');
    expect(fixture).toContain('E2E_FAILURE_HOOK_TIMEOUT');
    expect(fixture).toContain('browser-runtime-${index + 1}.error.txt');
    expect(fixture).toContain('captureFailedRuntimeSnapshots(testInfo, pages)');
    expect(fixture).toContain('quiesceRuntimePages(pages)');
    expect(fixture.indexOf('captureFailedRuntimeSnapshots(testInfo, pages)'))
      .toBeLessThan(fixture.indexOf('quiesceRuntimePages(pages)'));
    expect(fixture).toContain("new AggregateError(secondaryErrors, 'E2E_FAILURE_HOOK_SECONDARY_ERRORS')");
  });
});

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = join(import.meta.dir, '..', '..');
const sourcePath = join(repoRoot, 'frontend/src/lib/components/Embed/ScenarioPlayer.svelte');

describe('ScenarioPlayer diagnostics', () => {
  test('surfaces scenario failures in UI without raw console noise', () => {
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).not.toContain('console.error');
    expect(source).not.toContain('console.warn');
    expect(source).toContain('data-testid="scenario-error"');
    expect(source).toContain('data-testid="scenario-diagnostics"');
    expect(source).toContain('formatErrorMessage');
    expect(source).toContain('appendDiagnostics');
  });
});

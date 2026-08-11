import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = join(import.meta.dir, '..', '..');
const sourcePath = join(repoRoot, 'frontend/src/lib/components/Embed/ScenarioPlayer.svelte');
const architectPath = join(repoRoot, 'frontend/src/lib/view/panels/ArchitectPanel.svelte');

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

  test('does not expose BrowserVM runners that lack complete history parity', () => {
    const source = readFileSync(sourcePath, 'utf8');
    const architect = readFileSync(architectPath, 'utf8');

    expect(source).not.toContain("id: 'lock-ahb'");
    expect(architect).not.toContain('startHTLCTutorial');
    expect(architect).not.toContain('XLN.scenarios.lockAhb');
  });
});

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('release gate ordering', () => {
  test('runs one full E2E only after every cheaper release check', () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'runtime/scripts/release/run-release-gate.ts', '--profile=release', '--plan'],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = result.stdout.toString();
    const commands = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('bun run '));
    const browserE2eCommands = commands.filter((command) =>
      /^bun run test:e2e:(?:fast|core|full)$/.test(command),
    );

    expect(result.exitCode).toBe(0);
    expect(browserE2eCommands).toEqual(['bun run test:e2e:full']);
    expect(commands.at(-1)).toBe('bun run test:e2e:full');
  });

  test('publishes only a checked canonical tag through immutable actions', () => {
    const workflow = readFileSync('.github/workflows/distribution-release.yml', 'utf8');
    const actions = [...workflow.matchAll(/uses:\s+\S+@([^\s#]+)/g)].map((match) => match[1]);

    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((revision) => /^[0-9a-f]{40}$/.test(revision))).toBe(true);
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(4);
    expect(workflow.match(/working-directory: jurisdictions/g)).toHaveLength(3);
    expect(workflow).toContain('RELEASE_TAG: ${{ github.ref_name }}');
    expect(workflow).toContain('test "$RELEASE_REF_TYPE" = tag');
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$RELEASE_SHA"');
    expect(workflow).toContain('- run: bun run check');
    expect(workflow).toContain('- run: bun run test:release-integrity');
    expect(workflow).toContain('git ls-remote --exit-code origin "refs/tags/$RELEASE_TAG^{}"');
    expect(workflow).toContain('test "$remote_sha" = "$RELEASE_SHA"');
    expect(workflow).toContain('gh release create "$RELEASE_TAG"');
    expect(workflow).not.toContain('inputs.tag');
  });
});

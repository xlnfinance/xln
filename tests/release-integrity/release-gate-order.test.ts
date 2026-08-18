import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

const isCrossJReleaseTest = (name: string): boolean => (
  name.endsWith('.test.ts') &&
  ['cross-j', 'cross-jurisdiction', 'hash-ladder', 'pull-registry'].some(marker => name.includes(marker))
);

const collectCrossJReleaseTests = (directory: string): string[] => (
  readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return collectCrossJReleaseTests(path);
    return entry.isFile() && isCrossJReleaseTest(entry.name) ? [path] : [];
  })
);

describe('release gate ordering', () => {
  test('every GitHub workflow action is pinned to an immutable commit', () => {
    const workflows = readdirSync('.github/workflows')
      .filter(name => name.endsWith('.yml'))
      .map(name => `.github/workflows/${name}`);
    expect(workflows.length).toBeGreaterThan(0);
    for (const path of workflows) {
      const workflow = readFileSync(path, 'utf8');
      const actions = [...workflow.matchAll(/^\s*uses:\s+\S+@([^\s#]+)/gm)]
        .map(match => match[1]);
      expect(actions.length).toBeGreaterThan(0);
      expect(actions.every(revision => /^[0-9a-f]{40}$/.test(revision))).toBe(true);
    }
  });

  test('runs one full E2E only after every cheaper release check', () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'core/scripts/release/run-release-gate.ts', '--profile=release', '--plan'],
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
    expect(stdout).toContain('25. full E2E gate\n   bun run test:e2e:full\n   timeoutMs=3600000');
  });

  test('release runtime core includes the exact recursive cross-j family', () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'core/scripts/release/run-release-gate.ts', '--profile=release', '--plan'],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const runtimeCoreCommand = result.stdout.toString()
      .split('\n')
      .map(line => line.trim())
      .find(line => line.startsWith('bun test core/__tests__'));
    const plannedFamily = runtimeCoreCommand
      ?.split(/\s+/)
      .slice(2)
      .filter(path => isCrossJReleaseTest(path.split('/').at(-1) ?? ''))
      .sort();
    const expectedFamily = collectCrossJReleaseTests('core/__tests__').sort();

    expect(result.exitCode).toBe(0);
    expect(expectedFamily).toHaveLength(20);
    expect(plannedFamily).toEqual(expectedFamily);
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
    expect(workflow).toContain('Build signed and notarized macOS release');
    expect(workflow).toContain('XLN_MACOS_CODESIGN_IDENTITY');
    expect(workflow).toContain('Build signed Android release');
    expect(workflow).toContain('XLN_ANDROID_KEYSTORE_PATH');
    expect(workflow).toContain('XLN_ANDROID_SIGNER_CERT_SHA256');
    expect(workflow).not.toContain('inputs.tag');
  });

  test('launcher has no mutable registry-tag updater', () => {
    const launcher = readFileSync('packages/npm/xlnfinance/bin/xln.js', 'utf8');
    const channels = readFileSync('release/channels.json', 'utf8');
    expect(launcher).not.toContain('xlnfinance@latest');
    expect(launcher).not.toContain("command === 'update'");
    expect(channels).toContain('versioned-github-release-archive');
    expect(channels).toContain('explicit-immutable-versioned-release-install');
  });
});

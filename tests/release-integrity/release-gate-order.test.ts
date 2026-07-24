import { describe, expect, test } from 'bun:test';

describe('release gate ordering', () => {
  test('runs one full E2E only after every cheaper release check', () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'runtime/scripts/run-release-gate.ts', '--profile=release', '--plan'],
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
});

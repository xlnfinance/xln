import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../..');
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

const canonicalEntrypoints = {
  deploy: './scripts/deployment/deploy-platform.sh',
} as const;

const commandSegments = (command: string): string[] => command.split(/\s+(?:&&|\|\||;)\s+/u);

const commandWords = (segment: string): string[] =>
  (segment.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/gu) ?? []).map(word => {
    const quoted = (word.startsWith('"') && word.endsWith('"')) || (word.startsWith("'") && word.endsWith("'"));
    return quoted ? word.slice(1, -1) : word;
  });

const assertLocalFile = (alias: string, absolutePath: string, displayedPath: string): void => {
  expect(existsSync(absolutePath), `${alias} entrypoint missing: ${displayedPath}`).toBe(true);
  expect(statSync(absolutePath).isFile(), `${alias} entrypoint is not a file: ${displayedPath}`).toBe(true);
};

const assertExecutable = (alias: string, absolutePath: string, displayedPath: string): void => {
  assertLocalFile(alias, absolutePath, displayedPath);
  expect(
    statSync(absolutePath).mode & 0o111,
    `${alias} entrypoint is not executable: ${displayedPath}`,
  ).not.toBe(0);
};

describe('repository command surface', () => {
  test('root contains no command launchers', () => {
    const rootCommands = readdirSync(repoRoot)
      .filter(name => {
        const absolutePath = join(repoRoot, name);
        return statSync(absolutePath).isFile() && readFileSync(absolutePath, 'utf8').startsWith('#!');
      })
      .sort();
    expect(rootCommands).toEqual([]);
  });

  test('canonical command aliases resolve to the intended scripts', () => {
    for (const [alias, target] of Object.entries(canonicalEntrypoints)) {
      expect(packageJson.scripts[alias]).toBe(target);
    }
    for (const alias of [
      'deploy:frontend',
      'deploy:full',
      'deploy:fresh',
      'deploy:prod',
      'deploy:prod:frontend',
      'deploy:prod:runtime',
      'deploy:prod:runtime:reset',
      'deploy:prod:full',
      'deploy:prod:fresh',
    ]) {
      expect(packageJson.scripts[alias]?.startsWith(`${canonicalEntrypoints.deploy} `)).toBe(true);
    }
  });

  test('every local package entrypoint exists and direct launchers are executable', () => {
    for (const [alias, command] of Object.entries(packageJson.scripts)) {
      let commandCwd = repoRoot;
      for (const segment of commandSegments(command)) {
        const words = commandWords(segment);
        if (words[0] === 'cd' && words[1]) {
          commandCwd = resolve(commandCwd, words[1]);
          continue;
        }

        for (const match of segment.matchAll(/(?:^|[\s"'=])((?:\.\/)?[A-Za-z0-9_./-]+\.sh)(?=$|[\s"';&|])/gu)) {
          const displayedPath = match[1];
          if (!displayedPath) continue;
          const absolutePath = resolve(commandCwd, displayedPath);
          assertExecutable(alias, absolutePath, displayedPath);
        }

        let executableIndex = 0;
        while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[executableIndex] ?? '')) executableIndex += 1;
        const executable = words[executableIndex];
        if (executable?.startsWith('./')) {
          assertExecutable(alias, resolve(commandCwd, executable), executable);
          continue;
        }
        if (executable !== 'bun') continue;
        executableIndex += 1;
        while ((words[executableIndex] ?? '').startsWith('-')) executableIndex += 1;
        const bunEntrypoint = words[executableIndex];
        if (!bunEntrypoint?.match(/\.(?:ts|js|cjs|mjs)$/u)) continue;
        assertLocalFile(alias, resolve(commandCwd, bunEntrypoint), bunEntrypoint);
      }
    }
  });

  test('retired root and legacy launchers stay absent', () => {
    for (const retiredPath of [
      'deploy.sh',
      'deploy-contracts.sh',
      'reset-networks.sh',
      'scripts/deploy-fresh.sh',
      'scripts/deployment/deploy-bun.sh',
      'scripts/deployment/deploy-to-vultr.sh',
      'scripts/deployment/setup-server-bun.sh',
      'scripts/deployment/setup-server.sh',
      'scripts/dev/dev.sh',
      'scripts/dev/dev-ci.sh',
      'scripts/dev/dev-quick.sh',
      'scripts/dev/dev-watch.sh',
      'scripts/dev/start-networks.sh',
      'scripts/dev/stop-networks.sh',
      'scripts/dev/deploy-local-contracts.sh',
      'scripts/dev/reset-local-network.sh',
    ]) {
      expect(existsSync(join(repoRoot, retiredPath)), `retired launcher restored: ${retiredPath}`).toBe(false);
    }
  });
});

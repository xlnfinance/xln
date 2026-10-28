import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('contract reproducibility overlay includes both paths of a staged Solidity rename', () => {
  const gate = readFileSync('core/scripts/checks/contracts/check-contract-artifact-reproducibility.ts', 'utf8');
  const enumeration = gate.match(/const changed = run\((\[[^\n]+\])\);/);
  if (!enumeration?.[1]) throw new Error('CONTRACT_REPRODUCIBILITY_CHANGE_ENUMERATION_MISSING');
  // Run the production enumeration against real Git rename detection, without compiler builds.
  const command = JSON.parse(enumeration[1].replaceAll("'", '"')) as string[];
  const fixture = mkdtempSync(join(tmpdir(), 'xln-contract-rename-'));
  const original = 'jurisdictions/contracts/ERC721Mock.sol';
  const renamed = 'jurisdictions/contracts/ERC721Renamed.sol';
  const run = (args: string[]): string => {
    const result = Bun.spawnSync(args, { cwd: fixture, stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  try {
    mkdirSync(join(fixture, 'jurisdictions/contracts'), { recursive: true });
    copyFileSync(original, join(fixture, original));
    run(['git', 'init', '--quiet', '--initial-branch=main']);
    run(['git', 'add', original]);
    run(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']);
    run(['git', 'mv', original, renamed]);
    expect(run(['git', 'diff', '--cached', '--name-status', '--find-renames', 'HEAD']).trim())
      .toBe(`R100\t${original}\t${renamed}`);
    expect(run(command).split('\0').filter(Boolean).sort()).toEqual([original, renamed].sort());
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

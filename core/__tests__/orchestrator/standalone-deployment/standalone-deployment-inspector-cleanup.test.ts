import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStringify } from '../../../protocol/serialization';
import { stopProcessGroup } from '../../../scripts/e2e/runners/process-group';
import { launchInspectedDeployment } from './standalone-deployment-inspector-support';
import { startStandaloneNode } from './standalone-deployment-support';

const ownedInspectors = (directory: string) => execFileSync('ps', ['-axo', 'pid=,pgid=,command='], { encoding: 'utf8' })
  .split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || !match[3]!.includes('--inspect-brk=127.0.0.1:0') || !match[3]!.includes(directory)) return [];
    return [{ pid: Number(match[1]), pgid: Number(match[2]) }];
  });

test('a real missing ps diagnostic cannot leak the already spawned Inspector child', async () => {
  const fixture = await startStandaloneNode(0);
  const originalPath = process.env['PATH'];
  let survivors: ReturnType<typeof ownedInspectors> = [];
  try {
    const node = Bun.which('node');
    if (!node) throw new Error('INSPECTOR_NODE_NOT_FOUND');
    const bin = join(fixture.directory, 'node-only-path');
    await mkdir(bin);
    await symlink(node, join(bin, 'node'));
    let code = '';
    try {
      // Real Node remains executable; the OS cannot resolve ps. No replacement
      // executable, process-table response or financial component is supplied.
      process.env['PATH'] = bin;
      await launchInspectedDeployment(fixture, 'missing-ps', {
        source: 'jurisdictions/scripts/deployment/manifest.cjs', statement: 'renameSync(temporary, path);',
      });
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error)) throw error;
      code = String(error.code);
    } finally { process.env['PATH'] = originalPath; }
    survivors = ownedInspectors(fixture.nativeDirectory);
    const proof = join(fixture.directory, 'inspector-startup-proof.json');
    await writeFile(proof, safeStringify({ errorCode: code, survivors, nativeDirectory: fixture.nativeDirectory }, 2));
    expect(code).toBe('ENOENT');
    expect(survivors).toHaveLength(0);
    expect(fixture.submissions()).toBe(0);
    console.log(`STANDALONE_INSPECTOR_STARTUP_EVIDENCE:${proof}`);
  } finally {
    process.env['PATH'] = originalPath;
    for (const survivor of survivors) {
      expect(survivor.pgid).toBe(survivor.pid);
      await stopProcessGroup({ pid: survivor.pgid, signal: 'SIGKILL', termTimeoutMs: 2_000,
        killTimeoutMs: 2_000, timeoutError: 'INSPECTOR_STARTUP_TEST_GROUP_REMAINS' });
    }
    await fixture.close();
  }
}, 60_000);

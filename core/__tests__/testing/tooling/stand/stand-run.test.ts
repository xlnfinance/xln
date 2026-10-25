import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireStandLock, readStandLockHolder } from '../../../../../tools/stand-lock';
import { runStandChild } from '../../../../../tools/stand/run';
import { safeStringify } from '../../../../protocol/serialization';

for (const code of [0, 7]) {
  test(`stand supervisor cleans remaining children after exit ${code}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-stand-run-test-'));
    const pidFile = join(root, 'child.pid');
    try {
      const grant = await acquireStandLock({ reason: 'supervisor-test', waitMs: 0, root });
      const source = `import {spawn} from 'node:child_process';
        import {writeFileSync} from 'node:fs';
        const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
        writeFileSync(${safeStringify(pidFile)},String(child.pid));
        process.exit(${code});`;
      expect(await runStandChild(grant, [process.execPath, '-e', source], 3_000)).toBe(code);
      expect(readStandLockHolder(root, 0)).toBeNull();
      const pid = Number(readFileSync(pidFile, 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('stand timeout waits for termination before releasing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-stand-run-test-'));
  try {
    const grant = await acquireStandLock({ reason: 'timeout-test', waitMs: 0, root });
    expect(await runStandChild(grant, [process.execPath, '-e', 'setInterval(()=>{},1000)'], 100)).toBe(124);
    expect(readStandLockHolder(root, 0)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('independent competing processes never overlap slot ownership', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-stand-race-test-'));
  const events = join(root, 'events');
  const modulePath = new URL('../../../../../tools/stand-lock.ts', import.meta.url).pathname;
  const source = `import {acquireStandLock,releaseStandLock} from ${safeStringify(modulePath)};
    import {appendFileSync} from 'node:fs';
    const grant=await acquireStandLock({root:${safeStringify(root)},reason:'race',waitMs:3000,pollMs:2});
    appendFileSync(${safeStringify(events)},'start '+process.pid+'\\n');
    await Bun.sleep(10);
    appendFileSync(${safeStringify(events)},'end '+process.pid+'\\n');
    releaseStandLock(grant);`;
  const children = Array.from({ length: 12 }, () => Bun.spawn([process.execPath, '-e', source], { stdout: 'ignore', stderr: 'inherit' }));
  try {
    expect(await Promise.all(children.map(child => child.exited))).toEqual(Array(12).fill(0));
    const rows = readFileSync(events, 'utf8').trim().split('\n');
    expect(rows.length).toBe(24);
    for (let index = 0; index < rows.length; index += 2) {
      expect(rows[index]).toMatch(/^start \d+$/);
      expect(rows[index + 1]).toBe(rows[index]!.replace('start ', 'end '));
    }
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map(child => child.exited));
    rmSync(root, { recursive: true, force: true });
  }
});


test('nested stand CLI preserves the parent lease through child exit and timeout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-nested-stand-test-'));
  const cli = new URL('../../../../../tools/stand-lock.ts', import.meta.url).pathname;
  const resultFile = join(root, 'result.json');
  try {
    // An isolated Git fixture gives the actual CLI its own canonical lock root.
    // Neither this test nor its children touch the live machine's stand metadata.
    const initialized = spawnSync('git', ['init', '-q', root]);
    expect(initialized.status).toBe(0);
    const source = `import {readStandLockHolder,standLockRoot,STAND_LOCK_TOKEN_ENV} from ${safeStringify(cli)};
      import {writeFileSync} from 'node:fs';
      const root=standLockRoot();
      const before=readStandLockHolder(root,0);
      const outcomes=[];
      for (const [body,timeout,token] of [
        ['process.exit(0)',1000,process.env[STAND_LOCK_TOKEN_ENV]],
        ['process.exit(7)',1000,process.env[STAND_LOCK_TOKEN_ENV]],
        ['setInterval(()=>{},1000)',100,process.env[STAND_LOCK_TOKEN_ENV]],
        ['process.exit(0)',1000,'foreign-token']
      ]) {
        const child=Bun.spawn([process.execPath,${safeStringify(cli)},'run','--reason','nested','--wait-ms','0','--timeout-ms',String(timeout),'--',process.execPath,'-e',body],
          {env:{...process.env,[STAND_LOCK_TOKEN_ENV]:token},stdout:'ignore',stderr:'inherit'});
        outcomes.push({code:await child.exited,holder:readStandLockHolder(root,0)});
      }
      writeFileSync(${safeStringify(resultFile)},JSON.stringify({before,outcomes}));`;
    const outer = Bun.spawn(
      [
        process.execPath,
        cli,
        'run',
        '--reason',
        'outer',
        '--wait-ms',
        '0',
        '--timeout-ms',
        '5000',
        '--',
        process.execPath,
        '-e',
        source,
      ],
      { cwd: root, env: { ...process.env, XLN_STAND_LOCK_TOKEN: '' }, stdout: 'ignore', stderr: 'inherit' },
    );
    expect(await outer.exited).toBe(0);
    const result = JSON.parse(readFileSync(resultFile, 'utf8'));
    expect(result.outcomes.map((entry: { code: number }) => entry.code)).toEqual([0, 7, 124, 1]);
    for (const outcome of result.outcomes) expect(outcome.holder).toEqual(result.before);
    expect(readStandLockHolder(join(root, '.xln-stand-lock'), 0)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stand CLI reads --flag=value and never the child argv', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-stand-flags-test-'));
  const cli = new URL('../../../../../tools/stand-lock.ts', import.meta.url).pathname;
  try {
    expect(spawnSync('git', ['init', '-q', root]).status).toBe(0);
    const run = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, cli, 'run', ...args], {
        cwd: root,
        env: { ...process.env, XLN_STAND_LOCK_TOKEN: '' },
        stdout: 'ignore',
        stderr: 'inherit',
      });
      return await child.exited;
    };
    // The default timeout is 30 s, so an ignored `=` form would outlive this test.
    expect(await run(['--reason=equals', '--wait-ms=0', '--timeout-ms=100', '--',
      process.execPath, '-e', 'setInterval(()=>{},1000)'])).toBe(124);
    // A child flag of the same name must not replace the supervisor's own.
    expect(await run(['--reason=child-flag', '--wait-ms=0', '--timeout-ms=5000', '--',
      process.execPath, '-e', 'setTimeout(()=>process.exit(0),200)', '--timeout-ms', '1'])).toBe(0);
    expect(readStandLockHolder(join(root, '.xln-stand-lock'), 0)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

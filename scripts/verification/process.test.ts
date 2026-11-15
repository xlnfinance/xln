import { afterAll, expect, test } from 'bun:test';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeStringify } from '../../core/protocol/serialization';
import { runBoundedCommand } from './process';

const temporary = mkdtempSync(join(tmpdir(), 'xln-verification-process-'));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

test('kills a separately detached grandchild while preserving an unrelated process', async () => {
  const root = mkdtempSync(join(temporary, 'cwd-'));
  const logPath = join(root, 'detached-timeout.log');
  const log = openSync(logPath, 'wx');
  const failures: unknown[] = [];
  let unrelated: Bun.NullSubprocess | null = null;
  let grandchildPid = 0;
  try {
    const unrelatedProcess = Bun.spawn([process.execPath, '-e', 'setInterval(()=>{},1000)'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    unrelated = unrelatedProcess;
    const grandchild =
      'const {spawn}=require("node:child_process"); const p=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"}); console.log("grandchild="+p.pid); setInterval(()=>{},1000);';
    const command = `const p=Bun.spawn([process.execPath,"-e",${safeStringify(grandchild)}],{stdout:"inherit",stderr:"inherit"}); setInterval(()=>{},1000);`;
    const result = await runBoundedCommand([process.execPath, '-e', command], root, log, 300);
    grandchildPid = Number(readFileSync(logPath, 'utf8').match(/grandchild=(\d+)/u)?.[1]);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(grandchildPid).toBeGreaterThan(0);
    expect(result.cleanup?.pids).toContain(grandchildPid);
    expect(result.cleanup?.groups).toContain(grandchildPid);
    expect(result.cleanup?.pids).not.toContain(unrelatedProcess.pid);
    expect(result.error).toBeNull();
    expect(() => process.kill(grandchildPid, 0)).toThrow();
    expect(() => process.kill(unrelatedProcess.pid, 0)).not.toThrow();
  } catch (error) {
    failures.push(error);
  }
  if (grandchildPid) {
    try {
      process.kill(grandchildPid, 'SIGKILL');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) failures.push(error);
    }
  }
  try {
    closeSync(log);
  } catch (error) {
    failures.push(error);
  }
  if (unrelated) {
    try {
      unrelated.kill('SIGKILL');
      await unrelated.exited;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Detached process regression and cleanup failures');
});

import { afterAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { git } from './git';
import { install } from './install';
import { validateUpdates } from './pre-push';
import { runBoundedCommand } from './process';
import { verify } from './verify';

const temporary = mkdtempSync(join(tmpdir(), 'xln-verification-'));
let sequence = 0;
const project = resolve(import.meta.dir, '../..');

const commit = (root: string): void => {
  git(root, ['add', '.']);
  git(root, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'verification fixture']);
};

const fixture = (body = 'console.log("fixture-check-output");'): string => {
  const root = join(temporary, `repo ${sequence++}`);
  mkdirSync(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Verification Test']);
  git(root, ['config', 'user.email', 'verification@example.invalid']);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { check: 'bun check.ts' } }));
  writeFileSync(join(root, 'check.ts'), body);
  writeFileSync(join(root, 'input.txt'), 'committed\n');
  commit(root);
  return root;
};

const copyGate = (root: string): void => {
  for (const path of [
    ...['git', 'install', 'pre-push', 'process', 'verify'].map(name => `scripts/verification/${name}.ts`),
    'core/scripts/e2e/runners/process-group.ts',
    'tools/release-snapshot/scope.ts',
    '.githooks/pre-push',
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(project, path), join(root, path));
  }
  chmodSync(join(root, '.githooks/pre-push'), 0o755);
  commit(root);
};

afterAll(() => rmSync(temporary, { recursive: true, force: true }));

describe('host-independent verification', () => {
  test('records exact clean commit, command, machine versions and complete log', async () => {
    const root = fixture();
    const result = await verify(root);
    expect(result.passed).toBe(true);
    expect(result.before.head).toBe(git(root, ['rev-parse', 'HEAD']).trim());
    expect(result.before.tree).toBe(git(root, ['rev-parse', 'HEAD^{tree}']).trim());
    expect(result.command.argv).toEqual([process.execPath, 'run', 'check']);
    expect(result.command.budgetMs).toBe(300_000);
    expect(result.tools.bun.executable).toBe(process.execPath);
    expect(readFileSync(result.logPath, 'utf8')).toContain('fixture-check-output');
    expect(JSON.parse(readFileSync(result.resultPath, 'utf8')).passed).toBe(true);
    expect(readdirSync(dirname(result.resultPath)).sort()).toEqual(['check.log', 'result.json']);
    expect((await verify(root)).resultPath).not.toBe(result.resultPath);
  });

  test('rejects dirty tracked and untracked paths without running or modifying them', async () => {
    const root = fixture('throw new Error("must not execute");');
    writeFileSync(join(root, 'input.txt'), 'owner edit\n');
    writeFileSync(join(root, 'owner file $keep.txt'), 'owner untracked\n');
    const result = await verify(root);
    expect(result.passed).toBe(false);
    expect(result.problem).toBe('VERIFY_DIRTY_SOURCE:tracked=1:untracked=1');
    expect(result.command.result).toBeNull();
    expect(result.before.untracked).toEqual(['owner file $keep.txt']);
    expect(readFileSync(join(root, 'input.txt'), 'utf8')).toBe('owner edit\n');
    expect(readFileSync(join(root, 'owner file $keep.txt'), 'utf8')).toBe('owner untracked\n');
  });

  test('retains a failing check exit and both output streams', async () => {
    const result = await verify(
      fixture('console.log("before-failure"); console.error("failure-detail"); process.exit(7);'),
    );
    expect(result.passed).toBe(false);
    expect(result.problem).toBe('VERIFY_CHECK_FAILED:exitCode=7');
    expect(result.command.result?.exitCode).toBe(7);
    const log = readFileSync(result.logPath, 'utf8');
    expect(log).toContain('before-failure');
    expect(log).toContain('failure-detail');
  });

  test('rejects index flags that hide modified tracked source without resetting them', async () => {
    const root = fixture();
    git(root, ['update-index', '--assume-unchanged', 'input.txt']);
    writeFileSync(join(root, 'input.txt'), 'hidden owner edit\n');
    expect(git(root, ['diff', '--name-only'])).toBe('');
    const result = await verify(root);
    expect(result.passed).toBe(false);
    expect(result.problem).toBe('VERIFY_HIDDEN_INDEX_PATHS:count=1');
    expect(result.before.hiddenTracked).toEqual(['input.txt']);
    expect(git(root, ['ls-files', '-v', 'input.txt']).startsWith('h ')).toBe(true);
    expect(readFileSync(join(root, 'input.txt'), 'utf8')).toBe('hidden owner edit\n');
  });

  test('invalidates a check that modifies tracked source', async () => {
    const result = await verify(fixture('await Bun.write("input.txt", "changed during check");'));
    expect(result.passed).toBe(false);
    expect(result.problem).toBe('VERIFY_DIRTY_SOURCE:tracked=1:untracked=0');
    expect(result.after?.tracked).toEqual(['input.txt']);
  });

  test('invalidates a check that changes HEAD even if source finishes clean', async () => {
    const result = await verify(
      fixture(
        'const p=Bun.spawnSync(["git","-c","commit.gpgsign=false","commit","--allow-empty","-qm","concurrent commit"]); process.exit(p.exitCode);',
      ),
    );
    expect(result.passed).toBe(false);
    expect(result.problem).toBe('VERIFY_COMMIT_CHANGED_DURING_CHECK');
    expect(result.after?.tracked).toEqual([]);
    expect(result.after?.head).not.toBe(result.before.head);
  });

  test('rejects detached HEAD without running checks', async () => {
    const root = fixture();
    git(root, ['checkout', '--detach']);
    const result = await verify(root);
    expect(result.passed).toBe(false);
    expect(result.problem).toBe('VERIFY_REQUIRES_MAIN:branch=HEAD');
    expect(result.command.result).toBeNull();
  });

  test('kills the exact timed-out process group including a live child', async () => {
    const root = fixture();
    const logPath = join(temporary, 'timeout.log');
    const log = openSync(logPath, 'wx');
    const command =
      'const p=Bun.spawn([process.execPath,"-e","setInterval(()=>{},1000)"],{stdout:"inherit",stderr:"inherit"}); console.log("child="+p.pid); setInterval(()=>{},1000);';
    try {
      const result = await runBoundedCommand([process.execPath, '-e', command], root, log, 200);
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(124);
      const childPid = Number(readFileSync(logPath, 'utf8').match(/child=(\d+)/u)?.[1]);
      expect(childPid).toBeGreaterThan(0);
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      closeSync(log);
    }
  });

  test('kills a separately detached grandchild while preserving an unrelated process', async () => {
    const root = fixture();
    const logPath = join(temporary, 'detached-timeout.log');
    const log = openSync(logPath, 'wx');
    const unrelated = Bun.spawn([process.execPath, '-e', 'setInterval(()=>{},1000)'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const grandchild =
      'const {spawn}=require("node:child_process"); const p=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"}); console.log("grandchild="+p.pid); setInterval(()=>{},1000);';
    const command = `const p=Bun.spawn([process.execPath,"-e",${JSON.stringify(grandchild)}],{stdout:"inherit",stderr:"inherit"}); setInterval(()=>{},1000);`;
    let grandchildPid = 0;
    try {
      const result = await runBoundedCommand([process.execPath, '-e', command], root, log, 300);
      grandchildPid = Number(readFileSync(logPath, 'utf8').match(/grandchild=(\d+)/u)?.[1]);
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(124);
      expect(grandchildPid).toBeGreaterThan(0);
      expect(result.cleanup?.pids).toContain(grandchildPid);
      expect(result.cleanup?.groups).toContain(grandchildPid);
      expect(result.cleanup?.pids).not.toContain(unrelated.pid);
      expect(result.error).toBeNull();
      expect(() => process.kill(grandchildPid, 0)).toThrow();
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
    } finally {
      if (grandchildPid) {
        try {
          process.kill(grandchildPid, 'SIGKILL');
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
        }
      }
      unrelated.kill('SIGKILL');
      await unrelated.exited;
      closeSync(log);
    }
  });

  test('lets the existing cleanup wrapper stop its detached child and release its fixture lease', async () => {
    const root = fixture();
    const logPath = join(temporary, 'cleanup-wrapper.log');
    const log = openSync(logPath, 'wx');
    const wrapper = join(project, 'core/scripts/e2e/runners/run-with-test-cleanup.ts');
    const args = [
      wrapper,
      '--reason=verification-timeout',
      '--cwd',
      root,
      '--child-cwd',
      root,
      '--keep-test-artifacts',
      '--',
      process.execPath,
      '-e',
      'console.log("owned-child="+process.pid); setInterval(()=>{},1000);',
    ];
    const command = `const p=Bun.spawn([process.execPath,...${JSON.stringify(args)}],{env:{...process.env,XLN_FOUNDRY_HOME:${JSON.stringify(join(root, 'foundry'))}},stdout:"inherit",stderr:"inherit"}); setInterval(()=>{},1000);`;
    try {
      const result = await runBoundedCommand([process.execPath, '-e', command], root, log, 800);
      const childPid = Number(readFileSync(logPath, 'utf8').match(/owned-child=(\d+)/u)?.[1]);
      expect(result.timedOut).toBe(true);
      expect(result.error).toBeNull();
      expect(childPid).toBeGreaterThan(0);
      expect(result.cleanup?.groups).toContain(childPid);
      expect(() => process.kill(childPid, 0)).toThrow();
      expect(existsSync(join(root, '.logs/.test-artifact-run-lock.json'))).toBe(false);
    } finally {
      closeSync(log);
    }
  });
});

describe('local Git push gate', () => {
  test('rejects non-main or non-HEAD code updates but permits deletion-only input', () => {
    const head = '1'.repeat(40);
    const zero = '0'.repeat(40);
    expect(validateUpdates(`refs/heads/main ${head} refs/heads/main ${zero}\n`, head)).toBe(true);
    expect(validateUpdates(`(delete) ${zero} refs/heads/retired ${head}\n`, head)).toBe(false);
    expect(() => validateUpdates(`refs/heads/task ${head} refs/heads/task ${zero}\n`, head)).toThrow(
      'VERIFY_PUSH_REQUIRES_MAIN',
    );
    expect(() => validateUpdates(`refs/heads/main ${'2'.repeat(40)} refs/heads/main ${zero}\n`, head)).toThrow(
      'VERIFY_PUSH_REQUIRES_EXACT_HEAD',
    );
  });

  test('preserves conflicting core.hooksPath and existing executable default hooks', () => {
    const root = fixture();
    copyGate(root);
    git(root, ['config', '--local', 'core.hooksPath', 'owner-hooks']);
    expect(() => install(root)).toThrow('VERIFY_HOOK_CONFIG_CONFLICT');
    expect(git(root, ['config', '--local', '--get', 'core.hooksPath']).trim()).toBe('owner-hooks');
    git(root, ['config', '--local', '--unset', 'core.hooksPath']);
    const hook = join(root, '.git/hooks/pre-commit');
    writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(() => install(root)).toThrow('VERIFY_EXISTING_HOOKS_CONFLICT');
    expect(existsSync(hook)).toBe(true);
  });

  test('checks an actual push to a local bare remote and blocks dirty source', () => {
    const root = fixture();
    copyGate(root);
    install(root);
    install(root);
    const remote = join(temporary, `remote ${sequence++}.git`);
    git(temporary, ['init', '--bare', remote]);
    git(root, ['remote', 'add', 'local-test', remote]);
    git(root, ['push', 'local-test', 'main']);
    expect(git(remote, ['rev-parse', 'refs/heads/main']).trim()).toBe(git(root, ['rev-parse', 'HEAD']).trim());
    writeFileSync(join(root, 'input.txt'), 'next commit\n');
    commit(root);
    writeFileSync(join(root, 'input.txt'), 'uncommitted owner edit\n');
    const pushed = Bun.spawnSync(['git', 'push', 'local-test', 'main'], { cwd: root, timeout: 10_000 });
    expect(pushed.exitCode).not.toBe(0);
    expect(pushed.stderr.toString()).toContain('VERIFY_PUSH_REJECTED');
    expect(git(remote, ['rev-parse', 'refs/heads/main']).trim()).not.toBe(git(root, ['rev-parse', 'HEAD']).trim());
    expect(readFileSync(join(root, 'input.txt'), 'utf8')).toBe('uncommitted owner edit\n');
  });
});

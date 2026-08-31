/** Runs every compiled Rust test target concurrently, then runs doctests. */

import { availableParallelism } from 'node:os';

const ROOT = import.meta.dir + '/..';
const MANIFEST = ROOT + '/rscore/Cargo.toml';
const concurrency = Math.max(1, availableParallelism());
const active = new Set<ReturnType<typeof Bun.spawn>>();

const stopChildren = (): void => {
  for (const child of active) child.kill('SIGTERM');
};

process.on('SIGINT', stopChildren);
process.on('SIGTERM', stopChildren);

const compile = Bun.spawnSync([
  'cargo', 'test', '--manifest-path', MANIFEST, '--workspace', '--all-features',
  '--no-run', '--message-format=json',
], { cwd: ROOT, stdout: 'pipe', stderr: 'inherit' });
if (compile.exitCode !== 0) process.exit(compile.exitCode);

const executables = [...new Set(
  compile.stdout.toString().trim().split('\n').flatMap(line => {
    try {
      const message = JSON.parse(line) as {
        reason?: string;
        profile?: { test?: boolean };
        executable?: string | null;
      };
      return message.reason === 'compiler-artifact' && message.profile?.test && message.executable
        ? [message.executable]
        : [];
    } catch {
      return [];
    }
  }),
)];
if (executables.length === 0) throw new Error('RSCORE_TEST_EXECUTABLES_MISSING');

type Failure = Readonly<{ executable: string; exitCode: number; output: string }>;
const failures: Failure[] = [];
let nextIndex = 0;

const runLane = async (): Promise<void> => {
  while (nextIndex < executables.length && failures.length === 0) {
    const executable = executables[nextIndex++];
    if (!executable) break;
    const child = Bun.spawn([executable, '--test-threads=1'], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    active.add(child);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    active.delete(child);
    if (exitCode !== 0) failures.push({
      executable,
      exitCode,
      output: stdout + stderr,
    });
  }
};

await Promise.all(Array.from(
  { length: Math.min(concurrency, executables.length) },
  runLane,
));
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`RSCORE_TEST_FAILED:${failure.executable}:exit=${failure.exitCode}`);
    console.error(failure.output);
  }
  process.exit(1);
}

const docs = Bun.spawnSync([
  'cargo', 'test', '--manifest-path', MANIFEST, '--workspace', '--all-features', '--doc',
], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });
if (docs.exitCode !== 0) process.exit(docs.exitCode);

console.log(`RSCORE_TESTS_OK executables=${executables.length} concurrency=${concurrency}`);

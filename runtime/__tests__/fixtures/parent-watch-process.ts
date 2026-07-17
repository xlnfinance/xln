import { spawn } from 'node:child_process';
import { startParentLivenessWatch } from '../../orchestrator/parent-watch';

const mode = process.argv[2];

if (mode === 'child') {
  const parentPid = process.env['TEST_PARENT_PID'];
  startParentLivenessWatch('subprocess-test-child', parentPid, () => process.exit(42), 25);
  process.stdout.write(`CHILD_READY:${process.pid}\n`);
  setInterval(() => {}, 1_000);
} else if (mode === 'parent') {
  const child = spawn('bun', [import.meta.path, 'child'], {
    env: { ...process.env, TEST_PARENT_PID: String(process.pid) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  setInterval(() => {}, 1_000);
} else {
  throw new Error(`PARENT_WATCH_TEST_MODE_INVALID:${String(mode)}`);
}

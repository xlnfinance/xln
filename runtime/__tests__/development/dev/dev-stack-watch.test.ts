import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const script = readFileSync(resolve(import.meta.dir, '../../../../scripts/dev/run-dev-child.sh'), 'utf8');
const cleanSlate = readFileSync(resolve(import.meta.dir, '../../../../scripts/dev/clean-slate.sh'), 'utf8');

/**
 * Only the browser bundle may rebuild from source changes. A source edit must
 * never restart a runtime process: the restart drops live state and makes a
 * running dev session behave differently from the code under test.
 */
test('dev stack starts the mesh once and never reloads durable runtimes from source changes', () => {
  expect(script).not.toContain('watch-process-tree');
  expect(script).not.toContain('--watch-root');
  expect(script).toContain('bun --no-orphans runtime/orchestrator/orchestrator.ts');
  expect(script).toContain('bun --no-orphans runtime/watchtower/standalone-server.ts');
});

test('no dev child process reloads itself on source changes', () => {
  const watchingProcesses = script
    .split('\n')
    .filter(line => /(^|\s)--watch(\s|$)/.test(line) && !line.includes('watch-runtime-build.sh'));
  expect(watchingProcesses).toEqual([]);
});

test('dev cleanup only reaps canonical dev ports and db paths', () => {
  expect(cleanSlate).toContain('RPC2_PORT="$(xln_rpc2_port)"');
  expect(cleanSlate).toContain('stop_owned_dev_processes "$DEV_OWNER_FILE" "$DEV_PID_DIR" "$ROOT_DIR"');
  expect(cleanSlate).toContain('assert_dev_ports_clear "$DEV_PID_DIR" "$DEV_OWNER_FILE"');
  expect(cleanSlate).toContain('"$RPC_PORT" "$RPC2_PORT"');
  expect(cleanSlate).toContain('rm -rf "$DEV_DATA_ROOT"');
  expect(cleanSlate).not.toContain('kill_by_port');
  expect(cleanSlate).not.toContain('pkill');
  expect(cleanSlate).not.toMatch(/rm -rf db(?:\s|$)/);
});

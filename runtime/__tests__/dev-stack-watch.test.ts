import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const script = readFileSync(resolve(import.meta.dir, '../../scripts/dev/run-dev-child.sh'), 'utf8');
const cleanSlate = readFileSync(resolve(import.meta.dir, '../../scripts/dev/clean-slate.sh'), 'utf8');

test('dev stack starts the mesh once and never reloads durable runtimes from source changes', () => {
  expect(script).not.toContain('watch-process-tree');
  expect(script).not.toContain('--watch-root');
  expect(script).toContain('bun --no-orphans runtime/orchestrator/orchestrator.ts');
  expect(script).toContain('bun --no-orphans --watch runtime/watchtower/standalone-server.ts');
});

test('dev cleanup only reaps canonical dev ports and db paths', () => {
  expect(cleanSlate).toContain('RPC2_PORT="$(xln_rpc2_port)"');
  expect(cleanSlate).toContain('stop_owned_dev_processes "$DEV_OWNER_FILE" "$DEV_PID_DIR" "$ROOT_DIR"');
  expect(cleanSlate).toContain('assert_port_clear "$RPC2_PORT"');
  expect(cleanSlate).toContain('rm -rf "$DEV_DATA_ROOT"');
  expect(cleanSlate).not.toContain('kill_by_port');
  expect(cleanSlate).not.toContain('pkill');
  expect(cleanSlate).not.toMatch(/rm -rf db(?:\s|$)/);
});

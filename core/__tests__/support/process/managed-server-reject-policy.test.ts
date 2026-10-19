import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { safeStringify } from '../../../protocol/serialization';

const root = resolve(import.meta.dir, '../../..');
const script = readFileSync(resolve(root, '../scripts/operations/start-server.sh'), 'utf8');
const boundary = script.indexOf('SCRIPT_DIR=');
if (boundary < 0) throw new Error('MANAGED_SERVER_STARTUP_BOUNDARY_MISSING');
const prelude = script.slice(0, boundary);
const policy = resolve(root, 'runtime/frame/intake/discard.ts');
const probe = `
import { applyRejectedIngressPolicy } from ${safeStringify(policy)};
try {
  applyRejectedIngressPolicy([{
    origin: 'remote', entityId: 'peer', signerId: 'sender',
    sourceRuntimeId: 'remote', rejectionCode: 'INVALID_SIGNED_INPUT'
  }]);
  console.log('serving');
} catch { console.log('surfaced'); }
`;

test('managed server keeps serving after a rejected sender input by default', () => {
  const env = { ...process.env };
  delete env['NODE_ENV'];
  delete env['XLN_REJECT_FAIL_FAST'];
  const child = Bun.spawnSync(
    ['bash', '-c', `${prelude}\nexec "$1" -e "$2"`, 'managed-server-policy', process.execPath, probe],
    { env },
  );
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString().trim()).toBe('serving');
});

test('managed server retains explicit diagnostic fail-fast policy', () => {
  const child = Bun.spawnSync(
    ['bash', '-c', `${prelude}\nexec "$1" -e "$2"`, 'managed-server-policy', process.execPath, probe],
    {
      env: { ...process.env, NODE_ENV: 'production', XLN_REJECT_FAIL_FAST: '1' },
    },
  );
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString().trim()).toBe('surfaced');
});

import { expect, test } from 'bun:test';
import {
  buildRuntimeImportLogLine,
  redactTokenBearingUrlForLog,
  type RuntimeImportLogManifest,
} from '../orchestrator/runtime-import-log';

test('runtime import stdout log omits token-bearing import URL and capability tokens', () => {
  const manifest = {
    expiresAt: 1_797_123_456_000,
    entries: [
      {
        label: 'H1',
        wsUrl: 'ws://127.0.0.1:8091/rpc',
        token: 'xlnra1.read.1797123456000.secret-token',
      },
      {
        label: 'Custody xlnra1.full.1797123456000.label-secret',
        wsUrl: 'ws://127.0.0.1:8099/rpc',
        token: 'xlnra1.full.1797123456000.custody-secret',
      },
    ],
  } as unknown as RuntimeImportLogManifest;
  const encodedManifest = Buffer.from(JSON.stringify(manifest), 'utf8').toString('base64url');
  const importUrl = `http://127.0.0.1:8080/app?qaToken=query-secret#runtime-import=${encodedManifest}`;

  const line = buildRuntimeImportLogLine({
    manifest,
    importUrl,
    access: 'admin',
    manifestPath: '/tmp/xln/runtime import=manifest.json',
  });

  expect(line).toContain('[MESH] RUNTIME_IMPORT_READY');
  expect(line).toContain('count=2');
  expect(line).toContain('access=admin');
  expect(line).toContain('expiresAt=1797123456000');
  expect(line).toContain('wallet=http://127.0.0.1:8080/app');
  expect(line).not.toContain('runtime-import=');
  expect(line).not.toContain(encodedManifest);
  expect(line).not.toContain('xlnra1.');
  expect(line).not.toContain('secret');
  expect(line).not.toContain('qaToken');
});

test('token-bearing inspect URLs are logged without query or hash secrets', () => {
  const inspectUrl = [
    'http://localhost:8080/app',
    '?runtime=remote',
    '&ws=ws%3A%2F%2F127.0.0.1%3A8091%2Frpc',
    '&token=xlnra1.read.1797123456000.inspect-secret',
    '#accounts',
  ].join('');

  const redacted = redactTokenBearingUrlForLog(inspectUrl);

  expect(redacted).toBe('http://localhost:8080/app');
  expect(redacted).not.toContain('runtime=remote');
  expect(redacted).not.toContain('ws=');
  expect(redacted).not.toContain('token=');
  expect(redacted).not.toContain('xlnra1.');
  expect(redacted).not.toContain('inspect-secret');
});

test('runtime import stdout log can expose the full URL only when explicitly requested', () => {
  const manifest = {
    expiresAt: 1_797_123_456_000,
    entries: [{ label: 'H1' }],
  } as unknown as RuntimeImportLogManifest;
  const importUrl = 'https://localhost:8080/app?runtimeList=H1%20%7C%20read%20%7C%20ws%3A%2F%2Flocalhost%3A8092%2Frpc%20%7C%20xlnra1.read.secret';

  const line = buildRuntimeImportLogLine({
    manifest,
    importUrl,
    access: 'read',
    manifestPath: '/tmp/runtime-import-manifest.json',
    exposeUrl: true,
  });

  expect(line).toContain(`wallet=${importUrl}`);
  expect(line).toContain('xlnra1.read.secret');
});

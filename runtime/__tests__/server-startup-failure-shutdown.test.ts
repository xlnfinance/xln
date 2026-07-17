import { afterEach, expect, test } from 'bun:test';
import { createServer } from 'node:net';

const children: Bun.Subprocess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

const reservePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      reject(new Error('TEST_SERVER_PORT_RESERVATION_FAILED'));
      return;
    }
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});

test('startup failure closes the already-bound HTTP listener and exits nonzero', async () => {
  const port = await reservePort();
  const child = Bun.spawn([
    'bun',
    'runtime/server/index.ts',
    '--port',
    String(port),
    '--host',
    '127.0.0.1',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      XLN_RUNTIME_SEED: 'startup-failure-listener-regression',
      XLN_DB_PATH: `/tmp/xln-startup-failure-${process.pid}-${port}`,
      XLN_STORAGE_FORCE_RESTORE: '1',
      XLN_SKIP_SERVER_BOOTSTRAP: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.push(child);

  const exitCode = await Promise.race([
    child.exited,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('SERVER_STARTUP_FAILURE_DID_NOT_EXIT')), 10_000);
    }),
  ]);
  const output = `${await new Response(child.stdout).text()}\n${await new Response(child.stderr).text()}`;

  expect(exitCode).not.toBe(0);
  expect(output).toContain('STORAGE_SAFETY_OVERRIDE_FORBIDDEN_IN_PRODUCTION');
  await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
}, 15_000);

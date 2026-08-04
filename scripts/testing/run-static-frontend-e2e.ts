import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview, type PreviewServer } from 'vite';
import { parseStaticFrontendSpecs, staticFrontendTarget, type StaticFrontendTarget } from './static-frontend-e2e-contract';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..', '..');
const FRONTEND_ROOT = join(REPO_ROOT, 'frontend');
const PLAYWRIGHT_CLI = join(REPO_ROOT, 'node_modules', '@playwright', 'test', 'cli.js');

const run = async (
  executable: string,
  args: readonly string[],
  cwd: string,
  env = process.env,
): Promise<void> => {
  const child = spawn(executable, [...args], { cwd, env, stdio: 'inherit' });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`STATIC_FRONTEND_E2E_COMMAND_FAILED:${executable}:${exitCode}`);
};

const reserveLoopbackPort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('STATIC_FRONTEND_E2E_PORT_INVALID');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
};

const startPreview = async (port: number, target: StaticFrontendTarget): Promise<PreviewServer> => {
  const originalCwd = process.cwd();
  const originalForceHttp = process.env['XLN_VITE_FORCE_HTTP'];
  const originalSurface = process.env['XLN_FRONTEND_SURFACE'];
  process.chdir(FRONTEND_ROOT);
    process.env['XLN_VITE_FORCE_HTTP'] = '1';
    process.env['XLN_FRONTEND_SURFACE'] = target;
    try {
      const server = await preview({
        configFile: join(FRONTEND_ROOT, 'vite.config.ts'),
        preview: { host: '127.0.0.1', port, strictPort: true, open: false },
    });
    const address = server.httpServer.address();
    if (address && typeof address !== 'string' && address.port === port) return server;
    await server.close();
    throw new Error('STATIC_FRONTEND_E2E_PREVIEW_ADDRESS_INVALID');
  } finally {
    process.chdir(originalCwd);
    if (originalForceHttp === undefined) delete process.env['XLN_VITE_FORCE_HTTP'];
    else process.env['XLN_VITE_FORCE_HTTP'] = originalForceHttp;
    if (originalSurface === undefined) delete process.env['XLN_FRONTEND_SURFACE'];
    else process.env['XLN_FRONTEND_SURFACE'] = originalSurface;
  }
};

const runPlaywright = async (baseUrl: string, specs: readonly string[]): Promise<void> => {
  const env = {
    ...process.env,
    E2E_BASE_URL: baseUrl,
    PW_BASE_URL: baseUrl,
    PW_ONLY_CHROMIUM: '1',
    PW_SCREENSHOT: 'on',
    PW_SIMPLE_REPORTER: '1',
    PW_SKIP_WEBSERVER: '1',
    PW_STATIC_FRONTEND: '1',
    PW_TRACE: 'off',
    PW_VIDEO: 'off',
    PW_WORKERS: '1',
    XLN_BUN_EXECUTABLE: process.execPath,
  };
  await run('node', [PLAYWRIGHT_CLI, 'test', ...specs, '--project=chromium'], REPO_ROOT, env);
};

export const main = async (args: readonly string[]): Promise<void> => {
  const specs = parseStaticFrontendSpecs(args);
  const target = staticFrontendTarget(specs);
  const httpEnv = {
    ...process.env,
    XLN_BUN_EXECUTABLE: process.execPath,
    XLN_VITE_FORCE_HTTP: '1',
  };
  await run(process.execPath, ['copy-static-files.js'], FRONTEND_ROOT, httpEnv);
  await run('node', [join(FRONTEND_ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'vite.config.ts'], FRONTEND_ROOT, {
    ...httpEnv,
    XLN_FRONTEND_SURFACE: target,
  });
  const port = await reserveLoopbackPort();
  const server = await startPreview(port, target);
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await runPlaywright(baseUrl, specs);
    console.log(`STATIC_FRONTEND_E2E_PASS specs=${specs.join(',')} baseUrl=${baseUrl}`);
  } finally {
    await server.close();
  }
};

if (import.meta.main) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

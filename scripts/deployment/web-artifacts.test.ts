import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { serveStaticApp } from '../../core/api/server/static-assets';

const project = resolve(import.meta.dir, '../..');
const script = join(import.meta.dir, 'web-artifacts.sh');
const temporary = mkdtempSync(join(tmpdir(), 'xln-web-artifact-'));
const archive = join(temporary, 'current.tar.gz');
let sequence = 0;
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

const run = (cwd: string, command: string[]) =>
  Bun.spawnSync(command, { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 20_000 });
const site = (): string => {
  const root = join(temporary, `site-${sequence++}`);
  for (const directory of ['frontend/build', 'ui/dist']) {
    mkdirSync(join(root, directory), { recursive: true });
    copyFileSync(join(project, directory, 'index.html'), join(root, directory, 'index.html'));
  }
  writeFileSync(join(root, 'operator.env'), 'preserve operator configuration\n');
  return root;
};
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

beforeAll(() => {
  // Use the actual current builds; missing prerequisites are a failure, never a skip.
  const result = run(project, ['bash', script, 'pack', archive]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}, 20_000);

test('one archive installs the real hosted wallet, observer and identical current runtime/worker', async () => {
  const root = site();
  const installed = run(root, ['bash', script, 'install', archive]);
  expect(installed.stderr.toString()).toBe('');
  expect(installed.exitCode).toBe(0);
  const landing = join(root, 'frontend/build');
  const wallet = join(root, 'ui/dist');
  for (const path of ['/ui/', '/ui/assets', '/ui/board/deep']) {
    const response = await serveStaticApp(new Request(`http://localhost:8080${path}`), path, landing, wallet);
    if (!response) throw new Error(`STATIC_WALLET_RESPONSE_MISSING:${path}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('/ui/assets/');
  }
  for (const [path, source] of [
    ['/ui/runtime.js', 'runtime.js'],
    ['/account-worker.js', 'account-worker.js'],
  ]) {
    if (!path || !source) throw new Error('WEB_ARTIFACT_TEST_ASSET_MISSING');
    const response = await serveStaticApp(new Request(`http://localhost:8080${path}`), path, landing, wallet);
    if (!response) throw new Error(`STATIC_ASSET_RESPONSE_MISSING:${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
    expect(hash(new Uint8Array(await response.arrayBuffer()))).toBe(
      hash(readFileSync(join(project, 'ui/dist', source))),
    );
  }
  expect(readFileSync(join(root, 'operator.env'), 'utf8')).toBe('preserve operator configuration\n');
});

test('rejects the obsolete single-root deploy archive before changing either current build', () => {
  const old = join(temporary, 'obsolete.tar.gz');
  expect(run(project, ['tar', '-czf', old, '-C', 'frontend', 'build']).exitCode).toBe(0);
  const root = site();
  const before = readFileSync(join(root, 'ui/dist/index.html'), 'utf8');
  const result = run(root, ['bash', script, 'install', old]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('WEB_ARTIFACT_PATH_INVALID');
  expect(readFileSync(join(root, 'ui/dist/index.html'), 'utf8')).toBe(before);
  expect(readFileSync(join(root, 'frontend/build/index.html'), 'utf8')).toBe(
    readFileSync(join(project, 'frontend/build/index.html'), 'utf8'),
  );
}, 30_000);

test('installs public assets readable by the web server under a restrictive umask', () => {
  const source = site();
  expect(run(source, ['tar', '-xzf', archive]).exitCode).toBe(0);
  const paths = ['frontend/build', 'ui/dist'].flatMap(directory => [
    directory,
    ...readdirSync(join(source, directory), { recursive: true }).map(path => join(directory, String(path))),
  ]);
  const files = paths.filter(path => statSync(join(source, path)).isFile());
  const directories = paths.filter(path => statSync(join(source, path)).isDirectory());
  const before = files.map(path => hash(readFileSync(join(source, path))));
  for (const path of directories) chmodSync(join(source, path), 0o700);
  for (const path of files) chmodSync(join(source, path), 0o600);
  const restricted = join(temporary, 'restricted.tar.gz');
  expect(run(source, ['bash', script, 'pack', restricted]).exitCode).toBe(0);
  const target = site();
  const privateFile = join(target, 'operator.env');
  chmodSync(privateFile, 0o600);
  const result = run(target, ['bash', '-c', 'umask 077; exec bash "$1" install "$2"', '--', script, restricted]);
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
  expect([...new Set(directories.map(path => statSync(join(target, path)).mode & 0o777))]).toEqual([0o755]);
  expect([...new Set(files.map(path => statSync(join(target, path)).mode & 0o777))]).toEqual([0o644]);
  expect(files.map(path => hash(readFileSync(join(target, path))))).toEqual(before);
  expect(statSync(privateFile).mode & 0o777).toBe(0o600);
  expect(readFileSync(privateFile, 'utf8')).toBe('preserve operator configuration\n');
}, 45_000);

test('rejects a missing Account worker before replacing the existing wallet', () => {
  const incomplete = join(temporary, 'incomplete.tar.gz');
  expect(
    run(project, ['tar', '--exclude=ui/dist/account-worker.js', '-czf', incomplete, 'frontend/build', 'ui/dist'])
      .exitCode,
  ).toBe(0);
  const root = site();
  const before = readFileSync(join(root, 'ui/dist/index.html'), 'utf8');
  const result = run(root, ['bash', script, 'install', incomplete]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('WEB_ARTIFACT_MISSING:ui/dist/account-worker.js');
  expect(readFileSync(join(root, 'ui/dist/index.html'), 'utf8')).toBe(before);
}, 30_000);

test('refuses different runtime bytes between the observer and wallet', () => {
  const root = site();
  expect(run(root, ['bash', script, 'install', archive]).exitCode).toBe(0);
  writeFileSync(join(root, 'ui/dist/runtime.js'), readFileSync(join(root, 'ui/dist/runtime.js'), 'utf8') + '\n');
  const result = run(root, ['bash', script, 'pack', join(temporary, 'mismatched.tar.gz')]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('WEB_ARTIFACT_RUNTIME_MISMATCH:runtime.js');
});

test('rejects a link in an archive before extracting or replacing current builds', () => {
  const root = site();
  symlinkSync(join(project, 'ui/dist/runtime.js'), join(root, 'ui/dist/runtime.js'));
  const linked = join(temporary, 'linked.tar.gz');
  expect(run(root, ['tar', '-czf', linked, 'frontend/build', 'ui/dist']).exitCode).toBe(0);
  const target = site();
  const before = readFileSync(join(target, 'ui/dist/index.html'), 'utf8');
  const result = run(target, ['bash', script, 'install', linked]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('WEB_ARTIFACT_LINK_OR_SPECIAL_FILE_FORBIDDEN');
  expect(readFileSync(join(target, 'ui/dist/index.html'), 'utf8')).toBe(before);
});

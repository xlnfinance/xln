import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveStaticApp } from '../../../api/server/static-assets';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true }); });
const build = () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-static-gateway-')); roots.push(root);
  const observer = join(root, 'frontend'); const wallet = join(root, 'wallet');
  mkdirSync(observer); mkdirSync(wallet);
  writeFileSync(join(observer, 'index.html'), '<h1>Observer landing</h1>');
  writeFileSync(join(observer, 'app.html'), '<h1>Observer app</h1>');
  writeFileSync(join(wallet, 'index.html'), '<h1>React wallet</h1>');
  writeFileSync(join(wallet, 'runtime.js'), 'export const currentRuntime = true;');
  writeFileSync(join(observer, 'account-worker.js'), 'self.onmessage = () => {};');
  return (path: string, method = 'GET') => serveStaticApp(new Request('http://localhost:8080' + path, { method }), path, observer, wallet);
};
test('mesh uses the canonical static handler before its 404', () => {
  const source = readFileSync('core/orchestrator/orchestrator.ts', 'utf8');
  const route = source.indexOf('serveStaticApp(request, pathname, FRONTEND_STATIC_DIR)');
  expect(route).toBeGreaterThan(0);
  expect(source.indexOf('Unhandled mesh-control route')).toBeGreaterThan(route);
});
test('React owns prefix and deep reload while observer keeps its own pages', async () => {
  const serve = build();
  expect((await serve('/ui'))?.headers.get('location')).toBe('http://localhost:8080/ui/');
  expect(await (await serve('/ui/'))?.text()).toContain('React wallet');
  expect(await (await serve('/ui/manage/assets'))?.text()).toContain('React wallet');
  expect(await (await serve('/app'))?.text()).toContain('Observer app');
});
test('current runtime and Account worker retain JavaScript MIME and exact bytes', async () => {
  const serve = build();
  for (const [path, body] of [['/ui/runtime.js', 'export const currentRuntime = true;'], ['/account-worker.js', 'self.onmessage = () => {};']]) {
    const response = await serve(path);
    expect(response?.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await response?.text()).toBe(body);
    expect(await (await serve(path, 'HEAD'))?.text()).toBe('');
  }
});
test('missing current bundles fail without consulting another build or returning HTML', async () => {
  const serve = build();
  expect((await serve('/runtime.js'))?.status).toBe(503);
  expect((await serve('/ui/account-worker.js'))?.status).toBe(503);
  expect((await serve('/ui/assets/missing.js'))?.status).toBe(404);
});
test('encoded traversal cannot escape either asset owner', async () => {
  const serve = build();
  for (const path of ['/ui/%2e%2e/secret', '/%2e%2e/secret', '/ui/%5csecret', '/ui/%00'])
    expect((await serve(path))?.status).toBe(403);
  expect((await serve('/ui/%zz'))?.status).toBe(400);
  expect(await serve('/ui/', 'POST')).toBeNull();
});

test('configured current wallet build is authoritative and missing builds fail loudly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-wallet-owner-')); roots.push(root);
  writeFileSync(join(root, 'index.html'), '<h1>Current isolated React artifact</h1>');
  const previous = process.env['XLN_UI_BUILD_DIR'];
  try {
    process.env['XLN_UI_BUILD_DIR'] = root;
    const request = new Request('http://localhost:8080/ui/manage');
    const current = await serveStaticApp(request, '/ui/manage', join(root, 'observer'));
    expect(current?.status).toBe(200);
    expect(await current?.text()).toContain('Current isolated React artifact');
    process.env['XLN_UI_BUILD_DIR'] = join(root, 'missing');
    expect((await serveStaticApp(request, '/ui/manage', root))?.status).toBe(503);
  } finally {
    if (previous === undefined) delete process.env['XLN_UI_BUILD_DIR'];
    else process.env['XLN_UI_BUILD_DIR'] = previous;
  }
});

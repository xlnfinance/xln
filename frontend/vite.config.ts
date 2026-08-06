import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

import { createDocsBuildPlugin } from './apps/docs/build/docs-build-plugin';
import { createOpsBuildPlugin } from './apps/ops/build/ops-build-plugin';
import { createSiteBuildPlugin } from './apps/site/build/site-build-plugin';
import { createWalletBuildPlugin } from './apps/wallet/build/wallet-build-plugin';
import {
  createReactViteSurfaceContract,
  resolveReactFrontendSurface,
  type ReactViteSurfaceContract,
} from './packages/build-contracts/vite-surfaces';
import { isResetDbConfirmationValid, RESET_CONFIRM_COOKIE } from './src/lib/utils/resetDbGuard';
import { configureWsProxyLifecycle } from './vite-ws-proxy-lifecycle';

const FRONTEND_ROOT = fileURLToPath(new URL('.', import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const API_PROXY_TARGET = process.env['VITE_API_PROXY_TARGET'] || 'http://localhost:8082';
const API_PROXY_AGENT = API_PROXY_TARGET.startsWith('https:')
  ? new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 64 })
  : new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 64 });

const BUILD_NUMBER = (() => {
  const explicit = String(process.env['XLN_BUILD_NUMBER'] || '').trim();
  if (explicit) return explicit;
  try {
    return execSync('git rev-list --count HEAD', {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || '0';
  } catch {
    return '0';
  }
})();

const proxy = {
  '/api': { target: API_PROXY_TARGET, agent: API_PROXY_AGENT, changeOrigin: true, secure: false },
  '/rpc': {
    target: API_PROXY_TARGET,
    agent: API_PROXY_AGENT,
    changeOrigin: true,
    secure: false,
    ws: true,
    configure: configureWsProxyLifecycle,
  },
  '/rpc2': {
    target: API_PROXY_TARGET,
    agent: API_PROXY_AGENT,
    changeOrigin: true,
    secure: false,
    ws: true,
    configure: configureWsProxyLifecycle,
  },
  '/relay': {
    target: API_PROXY_TARGET,
    agent: API_PROXY_AGENT,
    changeOrigin: false,
    ws: true,
    configure: configureWsProxyLifecycle,
  },
};

const canonicalRoutes = (contract: ReactViteSurfaceContract): readonly (readonly [string, string])[] => (
  contract.routes.map(route => {
    const input = contract.inputs[route.id];
    if (!input) throw new Error(`FRONTEND_ENTRY_MISSING:${route.id}`);
    const relative = input.slice(contract.root.length).replaceAll('\\', '/').replace(/^\/+/, '');
    return [route.pattern, `/${relative}`] as const;
  })
);

const matchesPagePattern = (pattern: string, pathname: string): boolean => {
  const patternSegments = pattern.split('/').filter(Boolean);
  const pathSegments = pathname.split('/').filter(Boolean);
  const optionalTail = patternSegments.at(-1)?.startsWith(':') && patternSegments.at(-1)?.endsWith('?');
  const minimum = optionalTail ? patternSegments.length - 1 : patternSegments.length;
  if (pathSegments.length < minimum || pathSegments.length > patternSegments.length) return false;
  return patternSegments.every((segment, index) => (
    segment.startsWith(':') ? segment.endsWith('?') || pathSegments[index] !== undefined : segment === pathSegments[index]
  ));
};

const rewriteCanonicalRequest = (
  request: { url?: string | undefined },
  routes: readonly (readonly [string, string])[],
): void => {
  const url = new URL(request.url ?? '/', 'http://xln.local');
  const pathname = url.pathname === '/' ? '/' : url.pathname.replace(/\/$/, '');
  const match = routes.find(([pattern]) => matchesPagePattern(pattern, pathname));
  if (match) request.url = `${match[1]}${url.search}`;
};

const normalizeReturnTo = (candidate: string | null): string => (
  candidate?.startsWith('/') && !candidate.startsWith('//') ? candidate : '/app'
);

const resetHtml = (returnTo: string): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="1;url=${returnTo.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"><title>Resetting</title><style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0f;color:#f3f3f5;font:500 16px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}p{opacity:.72;letter-spacing:.08em;text-transform:uppercase}</style></head><body><p>Resetting local data…</p><script>setTimeout(()=>location.replace(${JSON.stringify(returnTo)}),250)</script></body></html>`;

const devHtmlBase = (filename: string): string => {
  const directory = relative(FRONTEND_ROOT, dirname(filename)).replaceAll('\\', '/');
  if (!directory || directory.startsWith('../')) throw new Error(`FRONTEND_DEV_ENTRY_OUTSIDE_ROOT:${filename}`);
  return `/${directory}/`;
};

const canonicalRoutePlugin = (contract: ReactViteSurfaceContract, devServer: boolean): Plugin => {
  const routes = canonicalRoutes(contract);
  const install = (middlewares: { use(handler: (request: http.IncomingMessage, response: http.ServerResponse, next: () => void) => void): void }): void => {
    middlewares.use((request, response, next) => {
      const url = new URL(request.url ?? '/', 'http://xln.local');
      if (url.pathname === '/admin' || url.pathname === '/radapter') {
        if (url.pathname === '/radapter' && url.search) {
          response.statusCode = 400;
          response.setHeader('cache-control', 'no-store, max-age=0');
          response.setHeader('content-type', 'text/plain; charset=utf-8');
          response.end('RADAPTER_QUERY_PARAMETERS_FORBIDDEN');
          return;
        }
        response.statusCode = 308;
        response.setHeader('location', url.pathname === '/admin' ? '/health' : '/app');
        response.end();
        return;
      }
      if (url.pathname === '/resetdb') {
        if (!isResetDbConfirmationValid(url, request.headers.cookie ?? null)) {
          response.statusCode = 403;
          response.setHeader('cache-control', 'no-store, max-age=0');
          response.setHeader('content-type', 'text/plain; charset=utf-8');
          response.end('RESET_CONFIRMATION_REQUIRED');
          return;
        }
        const returnTo = normalizeReturnTo(url.searchParams.get('returnTo'));
        response.statusCode = 200;
        response.setHeader('cache-control', 'no-store, max-age=0');
        response.setHeader('clear-site-data', '"*"');
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.setHeader('set-cookie', `${RESET_CONFIRM_COOKIE}=; Path=/resetdb; Max-Age=0; SameSite=Strict`);
        response.end(resetHtml(returnTo));
        return;
      }
      rewriteCanonicalRequest(request, routes);
      next();
    });
  };
  return {
    name: 'xln-canonical-routes',
    configureServer(server) { install(server.middlewares); },
    configurePreviewServer(server) { install(server.middlewares); },
    ...(devServer ? {
      transformIndexHtml: (_html, context) => [{
        tag: 'base',
        attrs: { href: devHtmlBase(context.filename) },
        injectTo: 'head-prepend' as const,
      }],
    } : {}),
  };
};

const localTls = (): false | { cert: Buffer; key: Buffer } => {
  if (process.env['XLN_VITE_FORCE_HTTP'] === '1') return false;
  for (const base of ['localhost+3', 'localhost+2', '192.168.1.23+2']) {
    const cert = resolve(FRONTEND_ROOT, `${base}.pem`);
    const key = resolve(FRONTEND_ROOT, `${base}-key.pem`);
    if (existsSync(cert) && existsSync(key)) return { cert: readFileSync(cert), key: readFileSync(key) };
  }
  return false;
};

export default defineConfig(({ command }) => {
  const surface = resolveReactFrontendSurface(process.env['XLN_FRONTEND_SURFACE']);
  const baseContract = createReactViteSurfaceContract(FRONTEND_ROOT, surface);
  const contract: ReactViteSurfaceContract = process.env['XLN_FRONTEND_BUILD_DIR']
    ? { ...baseContract, outDir: resolve(FRONTEND_ROOT, process.env['XLN_FRONTEND_BUILD_DIR']) }
    : baseContract;
  const staticRoot = process.env['XLN_FRONTEND_STATIC_DIR']
    ? resolve(FRONTEND_ROOT, process.env['XLN_FRONTEND_STATIC_DIR'])
    : resolve(FRONTEND_ROOT, 'static');
  const port = Number(process.env['VITE_DEV_PORT'] || '8080');
  const enableHmr = /^(?:1|true|yes)$/i.test(String(process.env['VITE_ENABLE_HMR'] || ''));
  const httpsOptions = localTls();
  return {
    root: contract.root,
    base: '/',
    publicDir: command === 'serve' ? staticRoot : false,
    cacheDir: process.env['VITE_CACHE_DIR'] || `node_modules/.vite-${port}`,
    plugins: [
      canonicalRoutePlugin(contract, command === 'serve'),
      react(),
      createSiteBuildPlugin(staticRoot, contract),
      createDocsBuildPlugin(staticRoot, contract),
      createWalletBuildPlugin(staticRoot, contract),
      createOpsBuildPlugin(FRONTEND_ROOT, contract),
    ],
    define: { global: 'globalThis', __BUILD_NUMBER__: JSON.stringify(BUILD_NUMBER) },
    resolve: {
      alias: {
        '$lib': resolve(FRONTEND_ROOT, 'src/lib'),
        '@xln/brainvault': resolve(FRONTEND_ROOT, '../brainvault'),
        '@xln/runtime': resolve(FRONTEND_ROOT, '../runtime'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: Number.isFinite(port) && port > 0 ? Math.floor(port) : 8080,
      strictPort: true,
      allowedHosts: ['all'],
      fs: { allow: ['..'] },
      hmr: enableHmr,
      ...(httpsOptions ? { https: httpsOptions } : {}),
      proxy,
    },
    preview: { proxy },
    build: {
      outDir: contract.outDir,
      assetsDir: contract.surface === 'all' ? 'assets' : `assets-${contract.surface}`,
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: { input: contract.inputs },
    },
  };
});

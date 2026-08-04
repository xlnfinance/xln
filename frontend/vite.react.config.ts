import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

import { createSiteBuildPlugin } from './apps/site/build/site-build-plugin';
import { createDocsBuildPlugin } from './apps/docs/build/docs-build-plugin';
import { createWalletBuildPlugin } from './apps/wallet/build/wallet-build-plugin';
import { configureWsProxyLifecycle } from './vite-ws-proxy-lifecycle';
import {
  createReactViteSurfaceContract,
  resolveReactFrontendSurface,
  type ReactViteSurfaceContract,
} from './packages/build-contracts/vite-surfaces';

const FRONTEND_ROOT = fileURLToPath(new URL('.', import.meta.url));

const apiProxyTarget = process.env['VITE_API_PROXY_TARGET'] || 'http://localhost:8082';
const proxy = {
  '/api': { target: apiProxyTarget, changeOrigin: true, secure: false },
  '/rpc': {
    target: apiProxyTarget,
    changeOrigin: true,
    secure: false,
    ws: true,
    configure: configureWsProxyLifecycle,
  },
  '/rpc2': {
    target: apiProxyTarget,
    changeOrigin: true,
    secure: false,
    ws: true,
    configure: configureWsProxyLifecycle,
  },
  '/relay': {
    target: apiProxyTarget,
    changeOrigin: false,
    ws: true,
    configure: configureWsProxyLifecycle,
  },
};

const canonicalRoutes = (contract: ReactViteSurfaceContract): readonly (readonly [string, string])[] => (
  contract.routes.map(route => {
    const input = contract.inputs[route.id];
    if (!input) throw new Error(`REACT_FRONTEND_ENTRY_MISSING:${route.id}`);
    const relative = input.slice(contract.root.length).replaceAll('\\', '/').replace(/^\/+/, '');
    return [route.pattern, `/${relative}`] as const;
  })
);

const rewriteCanonicalRequest = (
  request: { url?: string | undefined },
  routes: readonly (readonly [string, string])[],
): void => {
  const url = new URL(request.url ?? '/', 'http://xln.local');
  const route = url.pathname === '/' ? '/' : url.pathname.replace(/\/$/, '');
  const pathSegments = route.split('/').filter(Boolean);
  const match = routes.find(([pathname]) => {
    const patternSegments = pathname.split('/').filter(Boolean);
    if (patternSegments.length !== pathSegments.length) return false;
    return patternSegments.every((segment, index) => segment.startsWith(':') || segment === pathSegments[index]);
  });
  if (match) request.url = `${match[1]}${url.search}`;
};

const canonicalRoutePlugin = (contract: ReactViteSurfaceContract): Plugin => {
  const routes = canonicalRoutes(contract);
  return {
    name: 'xln-react-canonical-routes',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        rewriteCanonicalRequest(request, routes);
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((request, _response, next) => {
        rewriteCanonicalRequest(request, routes);
        next();
      });
    },
  };
};

export default defineConfig(({ command }) => {
  const surface = resolveReactFrontendSurface(process.env['XLN_FRONTEND_SURFACE']);
  const baseContract = createReactViteSurfaceContract(FRONTEND_ROOT, surface);
  const contract: ReactViteSurfaceContract = process.env['XLN_REACT_BUILD_DIR']
    ? { ...baseContract, outDir: resolve(FRONTEND_ROOT, process.env['XLN_REACT_BUILD_DIR']) }
    : baseContract;
  return {
    root: contract.root,
    base: '/',
    publicDir: command === 'serve' ? resolve(FRONTEND_ROOT, 'static') : false,
    plugins: [
      canonicalRoutePlugin(contract),
      react(),
      createSiteBuildPlugin(FRONTEND_ROOT, contract),
      createDocsBuildPlugin(FRONTEND_ROOT, contract),
      createWalletBuildPlugin(FRONTEND_ROOT, contract),
    ],
    resolve: {
      alias: {
        '$lib': resolve(FRONTEND_ROOT, 'src/lib'),
        '@xln/brainvault': resolve(FRONTEND_ROOT, '../brainvault'),
        '@xln/runtime': resolve(FRONTEND_ROOT, '../runtime'),
      },
    },
    server: { proxy },
    preview: { proxy },
    build: {
      outDir: contract.outDir,
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: { input: contract.inputs },
    },
  };
});

import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

import { createSiteBuildPlugin } from './apps/site/build/site-build-plugin';
import { createDocsBuildPlugin } from './apps/docs/build/docs-build-plugin';
import {
  createReactViteSurfaceContract,
  resolveReactFrontendSurface,
  type ReactViteSurfaceContract,
} from './packages/build-contracts/vite-surfaces';

const FRONTEND_ROOT = fileURLToPath(new URL('.', import.meta.url));

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
  const match = routes.find(([pathname]) => pathname === route);
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
  const contract = createReactViteSurfaceContract(FRONTEND_ROOT, surface);
  return {
    root: contract.root,
    base: '/',
    publicDir: command === 'serve' ? resolve(FRONTEND_ROOT, 'static') : false,
    plugins: [
      canonicalRoutePlugin(contract),
      react(),
      createSiteBuildPlugin(FRONTEND_ROOT, contract),
      createDocsBuildPlugin(FRONTEND_ROOT, contract),
    ],
    resolve: {
      alias: {
        '$lib': resolve(FRONTEND_ROOT, 'src/lib'),
        '@xln/runtime': resolve(FRONTEND_ROOT, '../runtime'),
      },
    },
    build: {
      outDir: contract.outDir,
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: { input: contract.inputs },
    },
  };
});

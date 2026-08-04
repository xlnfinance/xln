import { createReadStream, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';

import type { ReactViteSurfaceContract } from '../../../packages/build-contracts/vite-surfaces';

export const createOpsBuildPlugin = (frontendRoot: string, contract: ReactViteSurfaceContract): Plugin => {
  const runtimeBundlePath = process.env['XLN_RUNTIME_BUNDLE_PATH'] || resolve(frontendRoot, 'static/runtime.js');
  const serveRuntime = (server: Pick<ViteDevServer, 'middlewares'> | Pick<PreviewServer, 'middlewares'>): void => {
    if (contract.surface !== 'ops' && contract.surface !== 'all') return;
    server.middlewares.use((request, response, next) => {
      if (String(request.url || '').split('?')[0] !== '/runtime.js') { next(); return; }
      if (!existsSync(runtimeBundlePath)) {
        response.statusCode = 503; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ error: 'RUNTIME_BUNDLE_MISSING' })); return;
      }
      response.statusCode = 200; response.setHeader('content-type', 'text/javascript; charset=utf-8'); response.setHeader('cache-control', 'no-store, must-revalidate'); createReadStream(runtimeBundlePath).pipe(response);
    });
  };
  return {
  name: 'xln-ops-runtime',
  enforce: 'pre',
  configureServer(server) { serveRuntime(server); },
  configurePreviewServer(server) { serveRuntime(server); },
  };
};

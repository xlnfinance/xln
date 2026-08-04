import { createReadStream, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';

import {
  buildReactOpsCandidateManifest,
  REACT_CANDIDATE_MANIFEST_FILE,
} from '../../../packages/build-contracts/react-candidate';
import type { ReactViteSurfaceContract } from '../../../packages/build-contracts/vite-surfaces';

export const createOpsBuildPlugin = (contract: ReactViteSurfaceContract): Plugin => {
  const runtimeBundlePath = process.env['XLN_RUNTIME_BUNDLE_PATH'] || resolve(contract.root, '../../static/runtime.js');
  const serveRuntime = (server: Pick<ViteDevServer, 'middlewares'> | Pick<PreviewServer, 'middlewares'>): void => {
    if (contract.surface !== 'ops') return;
    server.middlewares.use((request, response, next) => {
      if (String(request.url || '').split('?')[0] !== '/runtime.js') { next(); return; }
      if (!existsSync(runtimeBundlePath)) {
        response.statusCode = 503; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ error: 'RUNTIME_BUNDLE_MISSING' })); return;
      }
      response.statusCode = 200; response.setHeader('content-type', 'text/javascript; charset=utf-8'); response.setHeader('cache-control', 'no-store, must-revalidate'); createReadStream(runtimeBundlePath).pipe(response);
    });
  };
  return {
  name: 'xln-react-ops-runtime-and-manifest',
  enforce: 'pre',
  configureServer(server) { serveRuntime(server); },
  configurePreviewServer(server) { serveRuntime(server); },
  closeBundle() {
    if (contract.surface !== 'ops') return;
    writeFileSync(
      join(contract.outDir, REACT_CANDIDATE_MANIFEST_FILE),
      `${JSON.stringify(buildReactOpsCandidateManifest(contract.routes), null, 2)}\n`,
    );
  },
  };
};

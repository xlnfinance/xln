import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UserConfig } from 'vite';

import { getSurface, type SurfaceId } from './surfaces';

const FRONTEND_ROOT = fileURLToPath(new URL('..', import.meta.url));
const USE_DEVELOPMENT_GATEWAY = process.env['XLN_REACT_DEV_GATEWAY'] === '1';

type ReactAppConfigInput = Readonly<{
  surfaceId: SurfaceId;
  rootDirectory: string;
}>;

export const createReactAppConfig = ({ surfaceId, rootDirectory }: ReactAppConfigInput): UserConfig => {
  const surface = getSurface(surfaceId);
  return {
    root: rootDirectory,
    base: '/',
    appType: 'spa',
    publicDir: false,
    plugins: [react()],
    cacheDir: resolve(FRONTEND_ROOT, 'node_modules/.vite-react', surfaceId),
    server: {
      host: '127.0.0.1',
      port: surface.developmentPort,
      strictPort: true,
      hmr: {
        path: surface.hmrPath,
        clientPort: USE_DEVELOPMENT_GATEWAY ? 8080 : surface.developmentPort,
      },
    },
    build: {
      outDir: resolve(FRONTEND_ROOT, surface.artifactDirectory),
      assetsDir: surface.assetDirectory,
      emptyOutDir: true,
      manifest: 'manifest.json',
      rollupOptions: {
        input: resolve(rootDirectory, 'index.html'),
      },
    },
  };
};

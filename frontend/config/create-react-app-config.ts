import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UserConfig } from 'vite';

import { parseDevelopmentGatewayPort } from './development-gateway';
import { getSurface, type SurfaceId } from './surfaces';

const FRONTEND_ROOT = fileURLToPath(new URL('..', import.meta.url));
const USE_DEVELOPMENT_GATEWAY = process.env['XLN_REACT_DEV_GATEWAY'] === '1';

type ReactAppConfigInput = Readonly<{
  surfaceId: SurfaceId;
  rootDirectory: string;
}>;

export const getReactAppBase = (
  surfaceId: SurfaceId,
  useDevelopmentGateway: boolean,
): '/' | `/__app/${SurfaceId}/` => useDevelopmentGateway ? `/__app/${surfaceId}/` : '/';

export const createReactAppConfig = ({ surfaceId, rootDirectory }: ReactAppConfigInput): UserConfig => {
  const surface = getSurface(surfaceId);
  return {
    root: rootDirectory,
    base: getReactAppBase(surfaceId, USE_DEVELOPMENT_GATEWAY),
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
        clientPort: USE_DEVELOPMENT_GATEWAY
          ? parseDevelopmentGatewayPort(process.env['XLN_REACT_GATEWAY_PORT'])
          : surface.developmentPort,
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

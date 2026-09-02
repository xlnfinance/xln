import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, UserConfig } from 'vite';

import { CONTENT_SECURITY_POLICY } from './content-security-policy.js';
import {
  parseDevelopmentGatewayPort,
  parseDevelopmentPortOffset,
  resolveDevelopmentSurfacePort,
} from './development-gateway';
import { hasPreparedGeneratedInputs } from './generated-inputs';
import { getSurface, type SurfaceId } from './surfaces';

const FRONTEND_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const USE_DEVELOPMENT_GATEWAY = process.env['XLN_REACT_DEV_GATEWAY'] === '1';

type ReactAppConfigInput = Readonly<{
  surfaceId: SurfaceId;
  rootDirectory: string;
}>;

const createWalletContentSecurityPolicyPlugin = (policy: string): Plugin => ({
  name: 'xln-wallet-content-security-policy',
  apply: 'build',
  transformIndexHtml: () => [{
    tag: 'meta',
    attrs: {
      'http-equiv': 'Content-Security-Policy',
      content: policy,
    },
    injectTo: 'head-prepend',
  }],
});

export const getReactContentSecurityPolicy = (surfaceId: SurfaceId): string | null =>
  surfaceId === 'wallet' ? CONTENT_SECURITY_POLICY : null;

export const getReactAppBase = (
  surfaceId: SurfaceId,
  useDevelopmentGateway: boolean,
): '/' | `/__app/${SurfaceId}/` => useDevelopmentGateway ? `/__app/${surfaceId}/` : '/';

export const getReactPublicDirectory = (
  surfaceId: SurfaceId,
  useDevelopmentGateway: boolean,
): string | false => useDevelopmentGateway && hasPreparedGeneratedInputs(surfaceId)
  ? resolve(FRONTEND_ROOT, '.artifacts/public', surfaceId)
  : false;

export const getReactViteCacheDirectory = (
  surfaceId: SurfaceId,
  configuredRoot = process.env['XLN_REACT_VITE_CACHE_ROOT'],
): string => resolve(FRONTEND_ROOT, configuredRoot?.trim() || 'node_modules/.vite-react', surfaceId);

export const createReactAppConfig = ({ surfaceId, rootDirectory }: ReactAppConfigInput): UserConfig => {
  const surface = getSurface(surfaceId);
  const contentSecurityPolicy = getReactContentSecurityPolicy(surfaceId);
  const developmentPort = resolveDevelopmentSurfacePort(
    surface.developmentPort,
    parseDevelopmentPortOffset(process.env['XLN_REACT_PORT_OFFSET']),
  );
  return {
    root: rootDirectory,
    base: getReactAppBase(surfaceId, USE_DEVELOPMENT_GATEWAY),
    appType: 'spa',
    publicDir: getReactPublicDirectory(surfaceId, USE_DEVELOPMENT_GATEWAY),
    plugins: [react(), ...(contentSecurityPolicy ? [createWalletContentSecurityPolicyPlugin(contentSecurityPolicy)] : [])],
    resolve: {
      alias: {
        '@xln/core': resolve(REPOSITORY_ROOT, 'core'),
      },
    },
    cacheDir: getReactViteCacheDirectory(surfaceId),
    server: {
      host: '127.0.0.1',
      port: developmentPort,
      strictPort: true,
      hmr: {
        path: surface.hmrPath,
        clientPort: USE_DEVELOPMENT_GATEWAY
          ? parseDevelopmentGatewayPort(process.env['XLN_REACT_GATEWAY_PORT'])
          : developmentPort,
      },
    },
    build: {
      copyPublicDir: false,
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

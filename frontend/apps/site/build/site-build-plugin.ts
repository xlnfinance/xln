import {
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

import type { ReactViteSurfaceContract } from '../../../packages/build-contracts/vite-surfaces';

export const SITE_ASSET_DIRECTORIES = ['bikes', 'img', 'news'] as const;
export const SITE_ASSET_FILES = [
  'android-chrome-192x192.png',
  'android-chrome-512x512.png',
  'apple-touch-icon.png',
  'favicon-16x16.png',
  'favicon-32x32.png',
  'favicon.ico',
  'install.sh',
  'superprompt.txt',
] as const;

const copySiteAssets = (staticRoot: string, outputRoot: string): void => {
  SITE_ASSET_DIRECTORIES.forEach(directory => {
    const source = join(staticRoot, directory);
    if (!existsSync(source)) throw new Error(`REACT_SITE_ASSET_MISSING:${source}`);
    cpSync(source, join(outputRoot, directory), { recursive: true, force: true });
  });
  SITE_ASSET_FILES.forEach(file => {
    const source = join(staticRoot, file);
    if (!existsSync(source)) throw new Error(`REACT_SITE_ASSET_MISSING:${source}`);
    const destination = join(outputRoot, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  });
};

const safeStaticPath = (staticRoot: string, pathname: string): string | null => {
  const decoded = decodeURIComponent(pathname).replace(/^\/+/, '');
  const candidate = resolve(staticRoot, decoded);
  return candidate.startsWith(`${resolve(staticRoot)}${sep}`) ? candidate : null;
};

export const createSiteBuildPlugin = (
  staticRoot: string,
  contract: ReactViteSurfaceContract,
): Plugin => ({
  name: 'xln-site-assets',
  configurePreviewServer(server) {
    server.middlewares.use('/docs-catalog', (request, response, next) => {
      const pathname = new URL(request.url ?? '/', 'http://xln.local').pathname;
      const source = safeStaticPath(staticRoot, `/docs-catalog${pathname}`);
      if (!source || !existsSync(source)) return next();
      response.setHeader('cache-control', 'no-store');
      response.setHeader('content-type', source.endsWith('.json') ? 'application/json' : 'text/markdown');
      createReadStream(source).pipe(response);
    });
  },
  closeBundle() {
    if (contract.surface !== 'site' && contract.surface !== 'all') return;
    copySiteAssets(staticRoot, contract.outDir);
  },
});

import {
  copyFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Plugin } from 'vite';

import type { ReactViteSurfaceContract } from '../../../packages/build-contracts/vite-surfaces';

export const WALLET_STATIC_ASSETS = [
  'android-chrome-192x192.png',
  'android-chrome-512x512.png',
  'apple-touch-icon.png',
  'brainvault-worker.js',
  'favicon-16x16.png',
  'favicon-32x32.png',
  'favicon.ico',
  'push-wake-sw.js',
  'runtime.js',
  'site.webmanifest',
] as const;

const copyWalletAssets = (staticRoot: string, outputRoot: string): void => {
  for (const file of WALLET_STATIC_ASSETS) {
    const source = file === 'runtime.js' && process.env['XLN_RUNTIME_BUNDLE_PATH']
      ? resolve(process.env['XLN_RUNTIME_BUNDLE_PATH'])
      : join(staticRoot, file);
    if (!existsSync(source)) throw new Error(`REACT_WALLET_ASSET_MISSING:${source}`);
    const destination = join(outputRoot, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
};

export const createWalletBuildPlugin = (
  staticRoot: string,
  contract: ReactViteSurfaceContract,
): Plugin => ({
  name: 'xln-wallet-assets',
  closeBundle() {
    if (contract.surface !== 'wallet' && contract.surface !== 'all') return;
    copyWalletAssets(staticRoot, contract.outDir);
  },
});

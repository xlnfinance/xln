import {
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Plugin } from 'vite';

import {
  buildReactWalletCandidateManifest,
  REACT_CANDIDATE_MANIFEST_FILE,
} from '../../../packages/build-contracts/react-candidate';
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
  frontendRoot: string,
  contract: ReactViteSurfaceContract,
): Plugin => ({
  name: 'xln-react-wallet-assets',
  closeBundle() {
    if (contract.surface !== 'wallet') return;
    const staticRoot = process.env['XLN_REACT_STATIC_ROOT']
      ? resolve(process.env['XLN_REACT_STATIC_ROOT'])
      : resolve(frontendRoot, 'static');
    copyWalletAssets(staticRoot, contract.outDir);
    const manifest = buildReactWalletCandidateManifest(contract.routes);
    writeFileSync(
      join(contract.outDir, REACT_CANDIDATE_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  },
});

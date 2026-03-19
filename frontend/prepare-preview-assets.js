#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const assets = [
  'favicon.ico',
  'favicon-16x16.png',
  'favicon-32x32.png',
  'apple-touch-icon.png',
  'android-chrome-192x192.png',
  'android-chrome-512x512.png',
  'site.webmanifest',
  'brainvault-worker.js',
];

const sourceDir = resolve('static');
const targetDir = resolve('.svelte-kit/output/client');
mkdirSync(targetDir, { recursive: true });

for (const asset of assets) {
  const source = resolve(sourceDir, asset);
  if (!existsSync(source)) {
    throw new Error(`Missing preview asset: ${source}`);
  }
  copyFileSync(source, resolve(targetDir, asset));
}

console.log(`✅ Prepared preview assets in ${targetDir}`);

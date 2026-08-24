import type { SurfaceId } from './surfaces';

export type GeneratedInputOwner = SurfaceId | 'assembly';

export type GeneratedInputCopy = Readonly<{
  sourcePath: string;
  destinationPath: string;
}>;

type GeneratedInputBase = Readonly<{
  id: string;
  owner: GeneratedInputOwner;
  sourcePaths: readonly string[];
  outputNamespace: string;
}>;

export type CopyGeneratedInputDefinition = GeneratedInputBase & Readonly<{
  producer: Readonly<{
    kind: 'copy';
    entries: readonly GeneratedInputCopy[];
  }>;
}>;

type DeferredGeneratedInputDefinition = GeneratedInputBase & Readonly<{
  producer: Readonly<{
    kind: 'deferred';
  }>;
}>;

export type GeneratedInputDefinition =
  | CopyGeneratedInputDefinition
  | DeferredGeneratedInputDefinition;

export const GENERATED_INPUTS: readonly GeneratedInputDefinition[] = [
  {
    id: 'docs-catalog',
    owner: 'docs',
    sourcePaths: ['frontend/docs-catalog.js', 'docs'],
    outputNamespace: 'docs-catalog',
    producer: { kind: 'deferred' },
  },
  {
    id: 'site-public-static',
    owner: 'site',
    sourcePaths: [
      'frontend/static/install.sh',
      'frontend/static/img',
      'frontend/static/bikes',
      'frontend/static/favicon.ico',
      'frontend/static/favicon-16x16.png',
      'frontend/static/favicon-32x32.png',
      'frontend/static/apple-touch-icon.png',
      'frontend/static/android-chrome-192x192.png',
      'frontend/static/android-chrome-512x512.png',
      'frontend/static/site.webmanifest',
    ],
    outputNamespace: 'site-public-static',
    producer: {
      kind: 'copy',
      entries: [
        { sourcePath: 'frontend/static/install.sh', destinationPath: 'install.sh' },
        { sourcePath: 'frontend/static/img', destinationPath: 'img' },
        { sourcePath: 'frontend/static/bikes', destinationPath: 'bikes' },
        { sourcePath: 'frontend/static/favicon.ico', destinationPath: 'favicon.ico' },
        { sourcePath: 'frontend/static/favicon-16x16.png', destinationPath: 'favicon-16x16.png' },
        { sourcePath: 'frontend/static/favicon-32x32.png', destinationPath: 'favicon-32x32.png' },
        { sourcePath: 'frontend/static/apple-touch-icon.png', destinationPath: 'apple-touch-icon.png' },
        {
          sourcePath: 'frontend/static/android-chrome-192x192.png',
          destinationPath: 'android-chrome-192x192.png',
        },
        {
          sourcePath: 'frontend/static/android-chrome-512x512.png',
          destinationPath: 'android-chrome-512x512.png',
        },
        { sourcePath: 'frontend/static/site.webmanifest', destinationPath: 'site.webmanifest' },
      ],
    },
  },
  {
    id: 'wallet-runtime-assets',
    owner: 'wallet',
    sourcePaths: ['scripts/build-runtime.sh', 'brainvault', 'jurisdictions/typechain-types'],
    outputNamespace: 'assets/wallet',
    producer: { kind: 'deferred' },
  },
  {
    id: 'ops-comparative-results',
    owner: 'ops',
    sourcePaths: ['frontend/static/comparative-results.json'],
    outputNamespace: 'ops-comparative-results',
    producer: {
      kind: 'copy',
      entries: [{
        sourcePath: 'frontend/static/comparative-results.json',
        destinationPath: 'comparative-results.json',
      }],
    },
  },
  {
    id: 'ops-scenario-assets',
    owner: 'ops',
    sourcePaths: ['core/scenarios'],
    outputNamespace: 'scenarios',
    producer: { kind: 'deferred' },
  },
  {
    id: 'release-assembly',
    owner: 'assembly',
    sourcePaths: ['frontend/config/surfaces.ts'],
    outputNamespace: 'release-manifest',
    producer: { kind: 'deferred' },
  },
] as const;

export const isCopyGeneratedInput = (
  input: GeneratedInputDefinition,
): input is CopyGeneratedInputDefinition => input.producer.kind === 'copy';

export const COPY_GENERATED_INPUTS = GENERATED_INPUTS.filter(isCopyGeneratedInput);

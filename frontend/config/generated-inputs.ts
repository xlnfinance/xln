import type { RouteRule, SurfaceId } from './surfaces';

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

export type CommandGeneratedInputDefinition = GeneratedInputBase & Readonly<{
  producer: Readonly<{
    kind: 'command';
    argv: readonly string[];
    outputEnvironment: string;
    environment: Readonly<Record<string, string>>;
    copies: readonly GeneratedInputCopy[];
    outputRoutes: readonly RouteRule[];
  }>;
}>;

type DeferredGeneratedInputDefinition = GeneratedInputBase & Readonly<{
  producer: Readonly<{
    kind: 'deferred';
  }>;
}>;

export type GeneratedInputDefinition =
  | CopyGeneratedInputDefinition
  | CommandGeneratedInputDefinition
  | DeferredGeneratedInputDefinition;

export const GENERATED_INPUTS: readonly GeneratedInputDefinition[] = [
  {
    id: 'docs-catalog',
    owner: 'docs',
    sourcePaths: [
      'frontend/copy-static-files.js',
      'frontend/docs-catalog.js',
      'frontend/static/docs-static',
      'scripts/debug/gpt.cjs',
      'docs',
    ],
    outputNamespace: 'docs-public-assets',
    producer: {
      kind: 'command',
      argv: ['bun', 'frontend/copy-static-files.js', '--docs-only', '--rebuild-llms'],
      outputEnvironment: 'XLN_STATIC_DIR',
      environment: {
        GIT_COMMIT: 'candidate',
        XLN_GENERATED_AT: '1970-01-01T00:00:00.000Z',
      },
      copies: [{
        sourcePath: 'frontend/static/docs-static',
        destinationPath: 'docs-static',
      }],
      outputRoutes: [
        { kind: 'prefix', pathname: '/docs-catalog' },
        { kind: 'prefix', pathname: '/docs-static' },
        { kind: 'stem', pathname: '/llms' },
      ],
    },
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
    id: 'wallet-runtime-bundle',
    owner: 'wallet',
    sourcePaths: [
      'scripts/build-runtime.sh',
      'core/api/public',
    ],
    outputNamespace: 'wallet-runtime-bundle',
    producer: { kind: 'deferred' },
  },
  {
    id: 'wallet-browser-assets',
    owner: 'wallet',
    sourcePaths: [
      'frontend/copy-static-files.js',
      'frontend/static/contracts',
      'brainvault',
      'jurisdictions/artifacts',
    ],
    outputNamespace: 'wallet-browser-assets',
    producer: {
      kind: 'command',
      argv: ['bun', 'frontend/copy-static-files.js', '--wallet-only'],
      outputEnvironment: 'XLN_STATIC_DIR',
      environment: {},
      copies: [],
      outputRoutes: [
        { kind: 'exact', pathname: '/brainvault-worker.js' },
        { kind: 'prefix', pathname: '/contracts' },
      ],
    },
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
    sourcePaths: [
      'frontend/scripts/scenario-assets.js',
      'core/scenarios/runner/catalog.ts',
    ],
    outputNamespace: 'scenarios',
    producer: {
      kind: 'command',
      argv: ['bun', 'frontend/scripts/scenario-assets.js'],
      outputEnvironment: 'XLN_SCENARIO_ASSET_DIR',
      environment: {},
      copies: [],
      outputRoutes: [{ kind: 'exact', pathname: '/scenarios/catalog.json' }],
    },
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

export const isCommandGeneratedInput = (
  input: GeneratedInputDefinition,
): input is CommandGeneratedInputDefinition => input.producer.kind === 'command';

export type PreparedGeneratedInputDefinition =
  | CopyGeneratedInputDefinition
  | CommandGeneratedInputDefinition;

export const isPreparedGeneratedInput = (
  input: GeneratedInputDefinition,
): input is PreparedGeneratedInputDefinition => input.producer.kind !== 'deferred';

export const PREPARED_GENERATED_INPUTS = GENERATED_INPUTS.filter(isPreparedGeneratedInput);

export const hasPreparedGeneratedInputs = (surfaceId: SurfaceId): boolean =>
  PREPARED_GENERATED_INPUTS.some(({ owner }) => owner === surfaceId);

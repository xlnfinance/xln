import type { RouteRule, SurfaceId } from './surfaces';

export type GeneratedInputOwner = SurfaceId;

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
    outputPath?: string;
    environment: Readonly<Record<string, string>>;
    copies: readonly GeneratedInputCopy[];
    outputRoutes: readonly RouteRule[];
  }>;
}>;

export type GeneratedInputDefinition =
  | CopyGeneratedInputDefinition
  | CommandGeneratedInputDefinition;

export const GENERATED_INPUTS: readonly GeneratedInputDefinition[] = [
  {
    id: 'docs-catalog',
    owner: 'docs',
    sourcePaths: [
      'frontend/copy-static-files.js',
      'frontend/docs-catalog.js',
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
      copies: [],
      outputRoutes: [
        { kind: 'prefix', pathname: '/docs-catalog' },
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
      ],
    },
  },
  {
    id: 'wallet-pwa-static',
    owner: 'wallet',
    sourcePaths: [
      'frontend/static/apple-touch-icon.png',
      'frontend/static/android-chrome-192x192.png',
      'frontend/static/android-chrome-512x512.png',
      'frontend/static/site.webmanifest',
      'frontend/static/push-wake-sw.js',
      'frontend/static/route-mode.js',
    ],
    outputNamespace: 'wallet-pwa-static',
    producer: {
      kind: 'copy',
      entries: [
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
        { sourcePath: 'frontend/static/push-wake-sw.js', destinationPath: 'push-wake-sw.js' },
        { sourcePath: 'frontend/static/route-mode.js', destinationPath: 'route-mode.js' },
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
    producer: {
      kind: 'command',
      argv: ['bash', 'scripts/build-runtime.sh'],
      outputEnvironment: 'XLN_RUNTIME_BUNDLE_OUT',
      outputPath: 'runtime.js',
      environment: {},
      copies: [],
      outputRoutes: [{ kind: 'exact', pathname: '/runtime.js' }],
    },
  },
  {
    id: 'wallet-browser-assets',
    owner: 'wallet',
    sourcePaths: [
      'frontend/copy-static-files.js',
      'frontend/static/contracts',
      'brainvault',
    ],
    outputNamespace: 'wallet-browser-assets',
    producer: {
      kind: 'command',
      argv: ['bun', 'frontend/copy-static-files.js', '--wallet-only', '--bundled-contracts'],
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
] as const;

export const isCopyGeneratedInput = (
  input: GeneratedInputDefinition,
): input is CopyGeneratedInputDefinition => input.producer.kind === 'copy';

export const COPY_GENERATED_INPUTS = GENERATED_INPUTS.filter(isCopyGeneratedInput);

export const isCommandGeneratedInput = (
  input: GeneratedInputDefinition,
): input is CommandGeneratedInputDefinition => input.producer.kind === 'command';

export type PreparedGeneratedInputDefinition = GeneratedInputDefinition;

export const PREPARED_GENERATED_INPUTS = GENERATED_INPUTS;

export const hasPreparedGeneratedInputs = (surfaceId: SurfaceId): boolean =>
  PREPARED_GENERATED_INPUTS.some(({ owner }) => owner === surfaceId);

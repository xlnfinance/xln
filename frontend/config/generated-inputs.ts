import type { SurfaceId } from './surfaces';

export type GeneratedInputOwner = SurfaceId | 'assembly';

export type GeneratedInputDefinition = Readonly<{
  id: string;
  owner: GeneratedInputOwner;
  sourcePaths: readonly string[];
  outputNamespace: string;
}>;

export const GENERATED_INPUTS = [
  {
    id: 'docs-catalog',
    owner: 'docs',
    sourcePaths: ['frontend/docs-catalog.js', 'docs'],
    outputNamespace: 'docs-catalog',
  },
  {
    id: 'site-public-static',
    owner: 'site',
    sourcePaths: ['frontend/static/install.sh', 'frontend/static/img'],
    outputNamespace: 'assets/site',
  },
  {
    id: 'wallet-runtime-assets',
    owner: 'wallet',
    sourcePaths: ['scripts/build-runtime.sh', 'brainvault', 'jurisdictions/typechain-types'],
    outputNamespace: 'assets/wallet',
  },
  {
    id: 'ops-scenario-assets',
    owner: 'ops',
    sourcePaths: ['core/scenarios', 'frontend/static/comparative-results.json'],
    outputNamespace: 'assets/ops',
  },
  {
    id: 'release-assembly',
    owner: 'assembly',
    sourcePaths: ['frontend/config/surfaces.ts'],
    outputNamespace: 'release-manifest',
  },
] as const satisfies readonly GeneratedInputDefinition[];

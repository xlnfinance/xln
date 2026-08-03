import type { FrontendRoute } from '../../src/lib/contracts/frontendSurfaces';

export const REACT_CANDIDATE_MANIFEST_FILE = 'react-candidate.json';

export type ReactCandidateSurface = 'site' | 'docs';

type ReactCandidateBase = Readonly<{
  schemaVersion: 1;
  activationBlocked: true;
  entrypoints: readonly string[];
}>;

export type ReactCandidateManifest =
  | (ReactCandidateBase & Readonly<{ surface: 'site' }>)
  | (ReactCandidateBase & Readonly<{ surface: 'docs'; catalogSha256: string }>);

export const buildReactCandidateManifest = (
  surface: ReactCandidateSurface,
  routes: readonly FrontendRoute[],
  catalogSha256?: string,
): ReactCandidateManifest => {
  const base = {
    schemaVersion: 1 as const,
    activationBlocked: true as const,
    entrypoints: routes
      .filter(route => route.surface === surface && route.kind === 'page')
      .map(route => route.outputEntry)
      .filter((entry): entry is string => entry !== null)
      .toSorted((left, right) => left.localeCompare(right)),
  };
  if (surface === 'site') return { ...base, surface };
  if (!catalogSha256 || !/^[a-f0-9]{64}$/.test(catalogSha256)) {
    throw new Error('REACT_DOCS_CATALOG_SHA256_INVALID');
  }
  return { ...base, surface: 'docs', catalogSha256 };
};

export const buildReactSiteCandidateManifest = (
  routes: readonly FrontendRoute[],
): ReactCandidateManifest => buildReactCandidateManifest('site', routes);

export const validateReactCandidateManifest = (
  value: unknown,
  expectedEntrypoints: readonly string[],
  expectedSurface: ReactCandidateSurface = 'site',
  expectedCatalogSha256?: string,
): readonly string[] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['CANDIDATE_NOT_OBJECT'];
  const candidate = value as Partial<ReactCandidateManifest>;
  const errors: string[] = [];
  if (candidate.schemaVersion !== 1) errors.push('CANDIDATE_SCHEMA_INVALID');
  if (candidate.surface !== expectedSurface) errors.push('CANDIDATE_SURFACE_INVALID');
  if (candidate.activationBlocked !== true) errors.push('CANDIDATE_ACTIVATION_NOT_BLOCKED');
  if (!Array.isArray(candidate.entrypoints)) errors.push('CANDIDATE_ENTRYPOINTS_INVALID');
  else if (candidate.entrypoints.join('\n') !== [...expectedEntrypoints].toSorted((left, right) => left.localeCompare(right)).join('\n')) {
    errors.push('CANDIDATE_ENTRYPOINTS_MISMATCH');
  }
  if (expectedSurface === 'docs') {
    const catalogSha256 = 'catalogSha256' in candidate ? candidate.catalogSha256 : undefined;
    if (!/^[a-f0-9]{64}$/.test(String(catalogSha256 ?? ''))) errors.push('CANDIDATE_CATALOG_SHA256_INVALID');
    else if (expectedCatalogSha256 && catalogSha256 !== expectedCatalogSha256) errors.push('CANDIDATE_CATALOG_SHA256_MISMATCH');
  } else if ('catalogSha256' in candidate) {
    errors.push('CANDIDATE_CATALOG_SHA256_UNEXPECTED');
  }
  return errors;
};

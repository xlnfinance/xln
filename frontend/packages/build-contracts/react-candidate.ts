import type { FrontendRoute } from '../../src/lib/contracts/frontendSurfaces';

export const REACT_CANDIDATE_MANIFEST_FILE = 'react-candidate.json';

export type ReactCandidateManifest = Readonly<{
  schemaVersion: 1;
  surface: 'site';
  activationBlocked: true;
  entrypoints: readonly string[];
}>;

export const buildReactSiteCandidateManifest = (
  routes: readonly FrontendRoute[],
): ReactCandidateManifest => ({
  schemaVersion: 1,
  surface: 'site',
  activationBlocked: true,
  entrypoints: routes
    .filter(route => route.surface === 'site' && route.kind === 'page')
    .map(route => route.outputEntry)
    .filter((entry): entry is string => entry !== null)
    .toSorted((left, right) => left.localeCompare(right)),
});

export const validateReactCandidateManifest = (
  value: unknown,
  expectedEntrypoints: readonly string[],
): readonly string[] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['CANDIDATE_NOT_OBJECT'];
  const candidate = value as Partial<ReactCandidateManifest>;
  const errors: string[] = [];
  if (candidate.schemaVersion !== 1) errors.push('CANDIDATE_SCHEMA_INVALID');
  if (candidate.surface !== 'site') errors.push('CANDIDATE_SURFACE_INVALID');
  if (candidate.activationBlocked !== true) errors.push('CANDIDATE_ACTIVATION_NOT_BLOCKED');
  if (!Array.isArray(candidate.entrypoints)) errors.push('CANDIDATE_ENTRYPOINTS_INVALID');
  else if (candidate.entrypoints.join('\n') !== [...expectedEntrypoints].toSorted((left, right) => left.localeCompare(right)).join('\n')) {
    errors.push('CANDIDATE_ENTRYPOINTS_MISMATCH');
  }
  return errors;
};

export const STATIC_FRONTEND_SPECS = [
  'tests/docs-site.spec.ts',
  'tests/install-site.spec.ts',
  'tests/landing-site.spec.ts',
  'tests/public-site-react.spec.ts',
] as const;

export type StaticFrontendSpec = typeof STATIC_FRONTEND_SPECS[number];

const staticSpecSet = new Set<string>(STATIC_FRONTEND_SPECS);

export type StaticFrontendTarget = 'legacy-docs' | 'react-site';

export const staticFrontendTarget = (specs: readonly StaticFrontendSpec[]): StaticFrontendTarget => {
  const targets = new Set(specs.map(spec => spec === 'tests/docs-site.spec.ts' ? 'legacy-docs' : 'react-site'));
  if (targets.size !== 1) throw new Error('STATIC_FRONTEND_E2E_MIXED_TARGETS');
  return [...targets][0]!;
};

export const parseStaticFrontendSpecs = (args: readonly string[]): StaticFrontendSpec[] => {
  if (args.length === 0) throw new Error('STATIC_FRONTEND_E2E_SPEC_REQUIRED');
  const unique = new Set<string>();
  for (const value of args) {
    if (!staticSpecSet.has(value)) throw new Error(`STATIC_FRONTEND_E2E_SPEC_NOT_ALLOWED:${value}`);
    if (unique.has(value)) throw new Error(`STATIC_FRONTEND_E2E_SPEC_DUPLICATE:${value}`);
    unique.add(value);
  }
  return [...unique] as StaticFrontendSpec[];
};

export const isStaticFrontendSpecPath = (file: string): boolean => {
  const normalized = file.replaceAll('\\', '/');
  return STATIC_FRONTEND_SPECS.some(spec => (
    normalized === spec || normalized.endsWith(`/${spec}`)
  ));
};

export const shouldQueryRuntimeIncidents = (
  tags: readonly string[],
  staticFrontendRun: boolean,
): boolean => !staticFrontendRun && (
  tags.includes('@functional') || tags.includes('@resilience')
);

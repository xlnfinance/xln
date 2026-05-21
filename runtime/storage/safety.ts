import { runtimeProcessEnv } from '../runtime-platform';

const truthyEnv = (name: string): boolean => {
  const raw = String(runtimeProcessEnv?.[name] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
};

export const assertStorageSafetyOverridesAllowed = (): void => {
  const nodeEnv = String(runtimeProcessEnv?.['NODE_ENV'] ?? '').trim().toLowerCase();
  if (nodeEnv !== 'production') return;

  const blockedFlags = [
    'XLN_STORAGE_SKIP_VERIFY_ON_OPEN',
    'XLN_STORAGE_FORCE_RESTORE',
  ].filter(truthyEnv);

  if (blockedFlags.length > 0) {
    throw new Error(`STORAGE_SAFETY_OVERRIDE_FORBIDDEN_IN_PRODUCTION: flags=${blockedFlags.join(',')}`);
  }
};

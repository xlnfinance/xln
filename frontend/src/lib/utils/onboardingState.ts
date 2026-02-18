const ONBOARDING_COMPLETE_PREFIX = 'xln-onboarding-complete:';

const normalizeEntityId = (entityId: string): string =>
  String(entityId || '').trim().toLowerCase();

export const getOnboardingCompleteKey = (entityId: string): string =>
  `${ONBOARDING_COMPLETE_PREFIX}${normalizeEntityId(entityId)}`;

export const readOnboardingComplete = (entityId: string): boolean => {
  if (typeof localStorage === 'undefined') return false;
  const normalized = normalizeEntityId(entityId);
  if (!normalized) return false;
  return localStorage.getItem(getOnboardingCompleteKey(normalized)) === 'true';
};

export const writeOnboardingComplete = (entityId: string, complete = true): void => {
  if (typeof localStorage === 'undefined') return;
  const normalized = normalizeEntityId(entityId);
  if (!normalized) return;
  const key = getOnboardingCompleteKey(normalized);
  if (complete) {
    localStorage.setItem(key, 'true');
  } else {
    localStorage.removeItem(key);
  }
};

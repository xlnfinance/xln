export const isVaultAuthorityLeaseExpired = (
  unlockUntil: number | null | undefined,
  now = Date.now(),
): boolean => typeof unlockUntil === 'number' && unlockUntil <= now;

import type { FrontendXlnFunctions } from '$lib/stores/xlnStore';

export function seedAvatar(
  functions: FrontendXlnFunctions | null,
  seed: string,
  size: number = 40,
): string {
  const canonicalSeed = String(seed || '').trim();
  if (!functions || !functions.isReady || !canonicalSeed) return '';
  return functions.hashToAvatar(canonicalSeed, size);
}

export function entityAvatar(
  functions: FrontendXlnFunctions | null,
  entityId: string,
): string {
  const canonicalEntityId = String(entityId || '').trim();
  if (!functions || !functions.isReady || !canonicalEntityId) return '';
  return functions.generateEntityAvatar(canonicalEntityId);
}

export function preferredAvatar(
  functions: FrontendXlnFunctions | null,
  entityId: string,
  fallbackSeed: string,
  size: number = 40,
): string {
  const entity = entityAvatar(functions, entityId);
  if (entity) return entity;
  return seedAvatar(functions, fallbackSeed, size);
}

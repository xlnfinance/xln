import type { JurisdictionConfig } from '@xln/runtime/xln-api';

export type FormationJurisdiction = JurisdictionConfig & {
  chainId?: number;
};

export type FormationRuntimeProjection = {
  jurisdictions: FormationJurisdiction[];
  existingEntityIds: string[];
};

export const emptyFormationRuntimeProjection = (): FormationRuntimeProjection => ({
  jurisdictions: [],
  existingEntityIds: [],
});

export const hasProjectedEntityId = (
  projection: FormationRuntimeProjection,
  entityId: string,
): boolean => {
  const normalized = String(entityId || '').trim().toLowerCase();
  return Boolean(normalized && projection.existingEntityIds.some((candidate) =>
    String(candidate || '').trim().toLowerCase() === normalized
  ));
};

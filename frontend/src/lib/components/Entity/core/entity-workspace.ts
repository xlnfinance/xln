const normalizeId = (value: string | null | undefined): string => String(value || '').trim().toLowerCase();

export const runtimeProjectionMatchesRuntime = (
  projectionRuntimeId: string | null | undefined,
  selectedRuntimeId: string | null | undefined,
): boolean => {
  const projection = normalizeId(projectionRuntimeId);
  const selected = normalizeId(selectedRuntimeId);
  return projection.length > 0 && selected.length > 0 && projection === selected;
};

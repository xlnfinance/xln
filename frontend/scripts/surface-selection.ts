import { SURFACE_IDS, type SurfaceId } from '../config/surfaces';

const isSurfaceId = (value: string): value is SurfaceId =>
  SURFACE_IDS.some((surfaceId) => surfaceId === value);

export const parseSurfaceSelection = (args: readonly string[]): readonly SurfaceId[] => {
  let selectedSurface: SurfaceId | null = null;
  let allSelected = false;

  for (const arg of args) {
    if (arg === '--all') {
      allSelected = true;
      continue;
    }
    if (arg.startsWith('--surface=')) {
      const value = arg.slice('--surface='.length);
      if (!isSurfaceId(value)) throw new Error(`FRONTEND_SURFACE_UNKNOWN:${value}`);
      if (selectedSurface !== null) throw new Error('FRONTEND_SURFACE_DUPLICATE');
      selectedSurface = value;
      continue;
    }
    throw new Error(`FRONTEND_ARGUMENT_UNKNOWN:${arg}`);
  }

  if (allSelected && selectedSurface !== null) throw new Error('FRONTEND_SURFACE_SELECTION_CONFLICT');
  if (allSelected) return [...SURFACE_IDS];
  if (selectedSurface !== null) return [selectedSurface];
  throw new Error('FRONTEND_SURFACE_REQUIRED');
};

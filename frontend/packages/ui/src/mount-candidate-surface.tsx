import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import type { SurfaceId } from '../../../config/surfaces';
import { CandidateShell, type CandidateSurfaceCopy } from './candidate-shell';

const getRootElement = (): HTMLElement => {
  const rootElement = document.getElementById('root');
  if (!rootElement) throw new Error('FRONTEND_REACT_ROOT_MISSING');
  return rootElement;
};

export const mountCandidateSurface = (surfaceId: SurfaceId, copy: CandidateSurfaceCopy): void => {
  createRoot(getRootElement()).render(
    <StrictMode>
      <CandidateShell surfaceId={surfaceId} copy={copy} />
    </StrictMode>,
  );
};

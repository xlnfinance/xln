import { BROWSER_PERSISTENCE_CONTRACT } from './browserPersistence';
import {
  FRONTEND_ROUTES,
  FRONTEND_SURFACES,
  validateFrontendSurfaceContract,
} from './frontendSurfaces';

export const FRONTEND_MIGRATION_CONTRACT_VERSION = 1;

export const buildFrontendMigrationContractReport = () => {
  const validationErrors = validateFrontendSurfaceContract();
  if (validationErrors.length > 0) {
    throw new Error(`FRONTEND_SURFACE_CONTRACT_INVALID:${validationErrors.join(',')}`);
  }

  return {
    version: FRONTEND_MIGRATION_CONTRACT_VERSION,
    originPolicy: BROWSER_PERSISTENCE_CONTRACT.originPolicy,
    surfaces: [...FRONTEND_SURFACES].sort((left, right) => left.id.localeCompare(right.id)),
    routes: [...FRONTEND_ROUTES].sort((left, right) => left.id.localeCompare(right.id)),
    persistence: BROWSER_PERSISTENCE_CONTRACT,
  } as const;
};

export const serializeFrontendMigrationContractReport = (): string =>
  `${JSON.stringify(buildFrontendMigrationContractReport(), null, 2)}\n`;

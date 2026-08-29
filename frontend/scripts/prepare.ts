import { fileURLToPath } from 'node:url';

import { prepareGeneratedInputs } from './generated-inputs';
import { parseSurfaceSelection } from './surface-selection';

const FRONTEND_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const run = async (): Promise<void> => {
  const surfaceIds = parseSurfaceSelection(Bun.argv.slice(2));
  const manifests = await prepareGeneratedInputs(REPOSITORY_ROOT, FRONTEND_ROOT, surfaceIds);
  console.info(
    `FRONTEND_PREPARE_OK surfaces=${surfaceIds.join(',')} inputs=${manifests.map(({ id }) => id).join(',')}`,
  );
};

if (import.meta.main) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

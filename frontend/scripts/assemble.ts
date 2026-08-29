import { fileURLToPath } from 'node:url';

import { SURFACE_IDS } from '../config/surfaces';
import { assembleCandidateRelease } from './candidate-release';
import { prepareGeneratedInputs } from './generated-inputs';

const FRONTEND_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const run = async (): Promise<void> => {
  if (Bun.argv.length > 2) throw new Error(`FRONTEND_ASSEMBLY_ARGUMENT_UNSUPPORTED:${Bun.argv[2]}`);
  await prepareGeneratedInputs(REPOSITORY_ROOT, FRONTEND_ROOT, SURFACE_IDS);
  const plan = await assembleCandidateRelease(FRONTEND_ROOT);
  console.info(
    `FRONTEND_ASSEMBLY_OK release=${plan.releaseId} files=${plan.files.length} path=${plan.releaseDirectory}`,
  );
};

if (import.meta.main) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

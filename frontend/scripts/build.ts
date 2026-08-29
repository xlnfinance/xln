import type { SurfaceId } from '../config/surfaces';
import { runCommands, type CommandSpec } from './command-runner';
import { parseSurfaceSelection } from './surface-selection';

export const createBuildCommands = (surfaceIds: readonly SurfaceId[]): readonly CommandSpec[] =>
  surfaceIds.map((surfaceId) => ({
    label: `build-${surfaceId}`,
    argv: ['bunx', 'vite', 'build', '--config', `apps/${surfaceId}/vite.config.ts`],
  }));

const run = async (): Promise<void> => {
  const surfaceIds = parseSurfaceSelection(Bun.argv.slice(2));
  await runCommands(createBuildCommands(surfaceIds));
  console.info(`FRONTEND_BUILD_OK surfaces=${surfaceIds.join(',')}`);
};

if (import.meta.main) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

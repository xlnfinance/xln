import type { SurfaceId } from '../config/surfaces';
import { runCommands, type CommandSpec } from './command-runner';
import { parseSurfaceSelection } from './surface-selection';

export type LocalCheckRequest = Readonly<{
  surfaceIds: readonly SurfaceId[];
  explain: boolean;
}>;

export const parseLocalCheckRequest = (args: readonly string[]): LocalCheckRequest => {
  const selectionArgs: string[] = [];
  let explain = false;
  for (const arg of args) {
    if (arg === '--explain') {
      explain = true;
      continue;
    }
    if (arg === '--level=local') continue;
    if (arg.startsWith('--level=')) throw new Error(`FRONTEND_CHECK_LEVEL_UNSUPPORTED:${arg}`);
    selectionArgs.push(arg);
  }
  return { surfaceIds: parseSurfaceSelection(selectionArgs), explain };
};

export const createLocalCheckCommands = (surfaceIds: readonly SurfaceId[]): readonly CommandSpec[] => [
  { label: 'frontend-unsafe-types', argv: ['bun', 'scripts/check-unsafe-types.ts'] },
  { label: 'react-tooling', argv: ['bunx', 'tsc', '-p', 'tsconfig.react-tooling.json'] },
  ...surfaceIds.map((surfaceId) => ({
    label: `react-${surfaceId}`,
    argv: ['bunx', 'tsc', '-p', `apps/${surfaceId}/tsconfig.json`],
  })),
];

const run = async (): Promise<void> => {
  const request = parseLocalCheckRequest(Bun.argv.slice(2));
  const commands = createLocalCheckCommands(request.surfaceIds);
  if (request.explain) {
    console.info(commands.map(({ label, argv }) => `${label}: ${argv.join(' ')}`).join('\n'));
    return;
  }
  await runCommands(commands);
  console.info(`FRONTEND_CHECK_OK surfaces=${request.surfaceIds.join(',')} level=local`);
};

if (import.meta.main) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

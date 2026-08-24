import { fileURLToPath } from 'node:url';

import { SURFACES } from '../config/surfaces';
import { prepareGeneratedInputs } from './generated-inputs';

const FRONTEND_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export type DevelopmentProcessSpec = Readonly<{
  label: string;
  argv: readonly string[];
  gatewayAware: boolean;
}>;

export const createDevelopmentProcessSpecs = (): readonly DevelopmentProcessSpec[] => [
  ...SURFACES.map(({ id }) => ({
    label: `vite-${id}`,
    argv: ['bunx', 'vite', '--config', `apps/${id}/vite.config.ts`],
    gatewayAware: true,
  })),
  {
    label: 'same-origin-gateway',
    argv: ['bun', 'scripts/run-dev-gateway.ts'],
    gatewayAware: false,
  },
];

export const getDevelopmentExitFailure = (
  shutdownRequested: boolean,
  label: string,
  exitCode: number,
): Error | undefined => shutdownRequested
  ? undefined
  : new Error(`FRONTEND_DEV_PROCESS_EXITED:${label}:${exitCode}`);

const run = async (): Promise<void> => {
  await prepareGeneratedInputs(REPOSITORY_ROOT, FRONTEND_ROOT, SURFACES.map(({ id }) => id));
  const processes = createDevelopmentProcessSpecs().map((spec) => ({
    spec,
    child: Bun.spawn([...spec.argv], {
      cwd: FRONTEND_ROOT,
      env: {
        ...process.env,
        ...(spec.gatewayAware ? { XLN_REACT_DEV_GATEWAY: '1' } : {}),
      },
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    }),
  }));

  let shutdownRequested = false;
  const stop = (): void => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    for (const { child } of processes) child.kill('SIGTERM');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const exits = processes.map(async ({ spec, child }) => ({ spec, exitCode: await child.exited }));
  const first = await Promise.race(exits);
  const shutdownWasRequested = shutdownRequested;
  stop();
  await Promise.all(exits);
  const failure = getDevelopmentExitFailure(shutdownWasRequested, first.spec.label, first.exitCode);
  if (failure !== undefined) throw failure;
};

if (import.meta.main) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

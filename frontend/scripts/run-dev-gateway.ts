import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND_ROOT = fileURLToPath(new URL('..', import.meta.url));
const GATEWAY_OUTPUT = fileURLToPath(new URL('../.artifacts/tooling/dev-gateway.mjs', import.meta.url));

const runCommand = async (argv: readonly string[]): Promise<void> => {
  const child = Bun.spawn([...argv], {
    cwd: FRONTEND_ROOT,
    env: process.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`FRONTEND_GATEWAY_COMMAND_FAILED:${argv[0]}:${exitCode}`);
};

const run = async (): Promise<void> => {
  await mkdir(dirname(GATEWAY_OUTPUT), { recursive: true });
  await runCommand([
    'bun',
    'build',
    'scripts/dev-gateway.ts',
    '--target=node',
    '--outfile',
    GATEWAY_OUTPUT,
  ]);
  const gateway = Bun.spawn(['node', GATEWAY_OUTPUT], {
    cwd: FRONTEND_ROOT,
    env: process.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const forwardSignal = (signal: NodeJS.Signals): void => gateway.kill(signal);
  process.once('SIGINT', () => forwardSignal('SIGINT'));
  process.once('SIGTERM', () => forwardSignal('SIGTERM'));
  const exitCode = await gateway.exited;
  if (exitCode !== 0) throw new Error(`FRONTEND_GATEWAY_EXITED:${exitCode}`);
};

if (import.meta.main) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

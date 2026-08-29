import { fileURLToPath } from 'node:url';

const FRONTEND_ROOT = fileURLToPath(new URL('..', import.meta.url));

export type CommandSpec = Readonly<{
  label: string;
  argv: readonly string[];
}>;

export const runCommands = async (commands: readonly CommandSpec[]): Promise<void> => {
  for (const command of commands) {
    console.info(`FRONTEND_STEP_START label=${command.label}`);
    const process = Bun.spawn([...command.argv], {
      cwd: FRONTEND_ROOT,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const exitCode = await process.exited;
    if (exitCode !== 0) throw new Error(`FRONTEND_STEP_FAILED:${command.label}:${exitCode}`);
    console.info(`FRONTEND_STEP_OK label=${command.label}`);
  }
};

import { resolve } from 'node:path';

export const PLAYWRIGHT_NODE_EXECUTABLE = 'node';

export const playwrightCliArgs = (args: readonly string[]): string[] => [
  resolve(process.cwd(), 'node_modules/playwright/cli.js'),
  ...args,
];

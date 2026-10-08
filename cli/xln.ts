#!/usr/bin/env bun
/**
 * xln CLI wallet — in-process runtime, TUI + agent subcommands.
 *
 *   bun cli/xln.ts
 *   bun cli/xln.ts pay <to> <amount>
 */
import { loadSettings } from './lib/settings.ts';

const main = async (): Promise<void> => {
  try {
    // Runtime storage captures its root at import; establish wallet ownership first.
    const settings = await loadSettings();
    process.env['XLN_DB_PATH'] = settings.dbPath;
    const { runCli } = await import('./commands/index.ts');
    const code = await runCli(process.argv);
    process.exitCode = code;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31mxln error:\x1b[0m ${message}`);
    process.exitCode = 1;
  }
};

await main();

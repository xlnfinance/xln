import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StatusConfig } from '../config';

export const runStatus = async (config: StatusConfig): Promise<void> => {
  const scratch = mkdtempSync(join(tmpdir(), 'xln-usdc-status-'));
  try {
    // Storage paths are bound on module load. Even native LevelDB recovery
    // and log rotation must be confined to the temporary copy.
    process.env['XLN_DB_PATH'] = join(scratch, 'db');
    process.env['XLN_RDB_ROOT'] = scratch;
    process.env['XLN_HLT_ENGINE'] = 'ts';
    process.env['XLN_LOG_LEVEL'] = 'error';
    process.env['XLN_JURISDICTIONS_PATH'] = join(config.stand.directory, 'jurisdictions.json');
    const { observeRun, printStatus } = await import('./report');
    printStatus(await observeRun(config, scratch), config.json);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readCliOption } from '../../config/cli';
import { isLoopbackUrl } from '../../network/p2p/loopback-url';

const args = process.argv.slice(2);
const apiBase = readCliOption(args, '--api-base', '');
const workDir = readCliOption(args, '--work-dir', '');
if (!apiBase || !isLoopbackUrl(apiBase) || !workDir) throw new Error('USDC_POC_LOCAL_INPUTS_REQUIRED');
const userDirectory = readCliOption(args, '--user-directory', 'poc-user');
if (!/^poc-[a-z-]+$/.test(userDirectory)) throw new Error('USDC_POC_USER_DIRECTORY_INVALID');
const directory = resolve(workDir, userDirectory);
if (!args.includes('--resume')) mkdirSync(directory, { mode: 0o700 });
process.env['XLN_JURISDICTIONS_PATH'] = join(workDir, 'prod-main', 'jurisdictions.json');
process.env['XLN_RDB_ROOT'] = directory;
process.env['XLN_DB_PATH'] = join(directory, 'db');
// Runtime modules capture their storage root at module initialization.
// Load the journey only after the isolated environment has been established.
if (args.includes('--resume')) {
  const { resumeJourney } = await import('./recovery/resume');
  await resumeJourney(
    apiBase,
    directory,
    workDir,
    readCliOption(args, '--interrupt-point', ''),
    args.includes('--clear-remainder'),
  );
} else await import('./source-journey');

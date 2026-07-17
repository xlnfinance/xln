import { spawnSync } from 'node:child_process';

import { safeStringify } from '../protocol/serialization';
import { sanitizeChildProcessEnv } from '../server/child-process-env';
import {
  assertRepositoryCodeFingerprintStable,
  computeRepositoryCodeFingerprint,
} from './code-fingerprint';

const usage = (): never => {
  throw new Error(
    'QA_CODE_FINGERPRINT_USAGE: ' +
      'bun runtime/qa/code-fingerprint-cli.ts snapshot | guard -- <command> [args...]',
  );
};

if (import.meta.main) {
  try {
    const [mode = 'snapshot', separator, command, ...args] = process.argv.slice(2);
    if (mode === 'snapshot') {
      if (separator !== undefined) usage();
      console.log(safeStringify(computeRepositoryCodeFingerprint(), 2));
    } else if (mode === 'guard') {
      if (separator !== '--' || !command) usage();
      const start = computeRepositoryCodeFingerprint();
      console.log(`QA_CODE_SNAPSHOT_START:${start.snapshotHash}`);
      const result = spawnSync(command!, args, {
        cwd: process.cwd(),
        env: sanitizeChildProcessEnv(process.env),
        stdio: 'inherit',
        shell: false,
      });
      const end = computeRepositoryCodeFingerprint();
      assertRepositoryCodeFingerprintStable(start, end);
      console.log(`QA_CODE_SNAPSHOT_END:${end.snapshotHash}`);
      if (result.error) throw result.error;
      if (result.signal) throw new Error(`QA_GUARDED_COMMAND_SIGNAL:${result.signal}`);
      process.exitCode = result.status ?? 1;
    } else {
      usage();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

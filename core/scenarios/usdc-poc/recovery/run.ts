import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCliOption } from '../../../config/cli';
import { requireSameRestoredProof } from './evidence';
import { safeStringify } from '../../../protocol/serialization';
import { verifyRecoveredLedger } from './ledger';

const args = process.argv.slice(2);
const apiBase = readCliOption(args, '--api-base', '');
const workDir = readCliOption(args, '--work-dir', '');
const run = (resume: boolean, point: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        'core/scenarios/usdc-poc/source-funding.ts',
        '--api-base',
        apiBase,
        '--work-dir',
        workDir,
        '--external-payout',
        '--duplicate-account-delivery',
        ...(resume ? ['--resume'] : []),
        ...(point ? ['--interrupt-point', point] : []),
      ],
      { env: process.env, stdio: 'inherit' },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (point ? signal === 'SIGKILL' : code === 0) resolve();
      else reject(new Error(`USDC_POC_RECOVERY_CHILD_FAILED:resume=${resume}:code=${code}:signal=${signal}`));
    });
  });
const { requireBoundaryRecord } = await import('../../../protocol/boundary-validation');
const interruptions = [];
const restores = [];
const directory = join(workDir, 'poc-user');
for (const [index, point] of ['deposit', 'cross-prepared', 'cover-fee', 'withdrawal', ''].entries()) {
  await run(index > 0, point);
  if (index > 0) {
    const after = requireBoundaryRecord(
      JSON.parse(readFileSync(join(directory, 'restored.json'), 'utf8')),
      'USDC_POC_RESTORE_PROOF_INVALID',
    );
    const before = interruptions[index - 1];
    if (!before) throw new Error('USDC_POC_INTERRUPTION_PROOF_MISSING');
    requireSameRestoredProof(before, after);
    restores.push({ before, after });
    console.log(`USDC_POC_RECOVERY_ROOT_MATCH:${before['point']}:height=${after['height']}`);
  }
  if (point)
    interruptions.push(
      requireBoundaryRecord(
        JSON.parse(readFileSync(join(directory, 'interruption.json'), 'utf8')),
        'USDC_POC_INTERRUPTION_PROOF_INVALID',
      ),
    );
}
writeFileSync(join(directory, 'recovery.json'), safeStringify({ interruptions, restores }, 2));
await verifyRecoveredLedger(apiBase, directory);
console.log(`USDC_POC_RECOVERY_COMPLETE:interruptions=${interruptions.length}`);

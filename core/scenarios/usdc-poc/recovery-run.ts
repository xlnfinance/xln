import { spawn } from 'node:child_process';
import { closeSync, cpSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { safeStringify } from '../../protocol/serialization';

const job = resolve('.logs/ts-usdc-cross-j-poc', `recovery-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(job, { recursive: true, mode: 0o700 });
const cases = [
  { name: 'accepted-effects', flag: '--interrupted-recovery', directory: 'poc-user' },
  { name: 'partial-full', flag: '--partial-recovery', directory: 'poc-partial-user' },
  { name: 'expired-clear', flag: '--partial-clear-recovery', directory: 'poc-expired-user' },
];
const results = [];
for (const scenario of cases) {
  const destination = join(job, scenario.name);
  mkdirSync(destination, { mode: 0o700 });
  const fd = openSync(join(destination, 'run.log'), 'wx', 0o600);
  let workDir = '';
  let pending = '';
  const child = spawn(process.execPath, ['core/scripts/operations/production/local-prod-smoke.ts', scenario.flag], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const capture = (chunk: Buffer) => {
    writeSync(fd, chunk);
    process.stdout.write(chunk);
    pending += chunk.toString();
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const match = /^\[local-prod-smoke\] workDir=(\S+) portBase=\d+$/.exec(line);
      if (match?.[1]) workDir = match[1];
    }
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) =>
        code === 0 ? resolve() : reject(new Error(`USDC_POC_RECOVERY_STAND_FAILED:${scenario.name}:${code}:${signal}`)),
      );
    });
  } finally {
    closeSync(fd);
  }
  if (!workDir || !/\/xln-local-prod-smoke-\d+$/.test(workDir))
    throw new Error('USDC_POC_RECOVERY_STAND_DIRECTORY_INVALID');
  cpSync(join(workDir, scenario.directory), join(destination, 'user'), { recursive: true, errorOnExist: true });
  const metrics: unknown = JSON.parse(readFileSync(join(workDir, 'bootstrap-metrics.json'), 'utf8'));
  writeFileSync(join(destination, 'bootstrap-metrics.json'), safeStringify(metrics, 2));
  results.push({ name: scenario.name, directory: join(destination, 'user'), command: scenario.flag });
  writeFileSync(join(job, 'matrix.json'), safeStringify({ status: 'running', cases: results }, 2));
  console.log(`USDC_POC_RECOVERY_CASE_COMPLETE:${scenario.name}`);
}
writeFileSync(
  join(job, 'matrix.json'),
  safeStringify({ status: 'complete', cases: results, interruptedProcesses: 8, publicFinancialExecution: false }, 2),
);
console.log(`USDC_POC_RECOVERY_MATRIX:${join(job, 'matrix.json')}`);

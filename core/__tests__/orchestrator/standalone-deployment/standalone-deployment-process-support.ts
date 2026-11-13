import { execFileSync, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stopProcessGroup } from '../../../scripts/e2e/runners/process-group';
import { privateKey } from '../stack-manager-recovery/stack-manager-resume-support';
import type { startStandaloneNode } from './standalone-deployment-support';

type Fixture = Awaited<ReturnType<typeof startStandaloneNode>>;
type Options = Readonly<{
  mode?: 'new' | 'resume';
  deploymentId?: string;
  directory?: string;
  parameters?: string;
  key?: string;
  rpcUrl?: string;
  config?: string;
  environment?: Readonly<Record<string, string>>;
}>;

export const launchDeployment = (fixture: Fixture, name: string, options: Options = {}) => {
  const logs = ['json', 'log'].map(extension => openSync(join(fixture.directory, `${name}.${extension}`), 'wx', 0o600));
  // A real calling session waits for bunx/Hardhat. Losing this launcher must
  // neither signal its native child nor release that child's deployment lane.
  const launcher =
    "import { spawn } from 'node:child_process'; const child = spawn('bunx', process.argv.slice(1), { stdio: 'inherit' }); child.on('error', error => { throw error; }); child.on('exit', code => { process.exitCode = code ?? 1; });";
  const child = spawn(
    'node',
    [
      '--input-type=module',
      '-e',
      launcher,
      'hardhat',
      ...(options.config ? ['--config', options.config] : []),
      'xln-deploy',
      '--network',
      'stack-manager',
      '--parameters',
      options.parameters || fixture.parameters,
      '--deployment-id',
      options.deploymentId || 'resume-usdc',
      '--mode',
      options.mode || 'new',
      '--deployment-dir',
      options.directory || fixture.nativeDirectory,
    ],
    {
      cwd: join(process.cwd(), 'jurisdictions'),
      detached: true,
      stdio: ['ignore', logs[0]!, logs[1]!],
      env: {
        ...process.env,
        ...options.environment,
        DEPLOYER_PRIVATE_KEY: options.key || privateKey,
        XLN_JURISDICTIONS_PATH: fixture.catalog,
        XLN_STACK_MANAGER_RPC_URL: options.rpcUrl || fixture.request.rpcUrl,
        XLN_STACK_MANAGER_CHAIN_ID: '31337',
      },
    },
  );
  logs.forEach(closeSync);
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
  if (!child.pid) throw new Error('DEPLOYMENT_LAUNCHER_PID_MISSING');
  const pid = child.pid;
  let outcome: number | undefined;
  void exited.then(code => {
    outcome = code;
  });
  const started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
  return {
    pid,
    started,
    exited,
    outcome: () => outcome,
    log: () => readFile(join(fixture.directory, `${name}.log`), 'utf8'),
    stop: () =>
      stopProcessGroup({
        pid,
        termTimeoutMs: 2_000,
        killTimeoutMs: 2_000,
        timeoutError: 'DEPLOYMENT_TEST_GROUP_REMAINS',
      }),
  };
};

export const launchUnrelatedProcess = () => {
  // A real, nonsending process in another group is a cleanup counterexample.
  const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
  if (!child.pid) throw new Error('DEPLOYMENT_DECOY_PID_MISSING');
  const pid = child.pid;
  return {
    pid,
    stop: async () => {
      await stopProcessGroup({
        pid,
        termTimeoutMs: 2_000,
        killTimeoutMs: 2_000,
        timeoutError: 'DEPLOYMENT_DECOY_REMAINS',
      });
      await exited;
    },
  };
};

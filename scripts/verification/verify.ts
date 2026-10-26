import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { arch, hostname, platform, release } from 'node:os';
import { join } from 'node:path';
import { repository, sourceProblem, sourceState, type SourceState } from './git';
import { runBoundedCommand, type CommandResult } from './process';

// The aggregate release check includes the full repository lint and parallel gates;
// its measured 186-second run exceeds the ordinary single-check 60-second budget.
const CHECK_TIMEOUT_MS = 300_000;
// `check` runs only the Foundry invariant subset; the Hardhat suite (~48 s) once stayed
// red for 22 pushed commits after a Solidity change, so every push runs it as well.
const CONTRACTS_TIMEOUT_MS = 300_000;

const toolVersion = (command: string, args: string[]) => {
  try {
    const result = Bun.spawnSync([command, ...args], { timeout: 2_000, stdout: 'pipe', stderr: 'pipe' });
    return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}`.trim() };
  } catch (error) {
    return { exitCode: null, output: error instanceof Error ? error.message : String(error) };
  }
};

const tools = () => ({
  bun: { executable: process.execPath, version: Bun.version, revision: Bun.revision },
  git: toolVersion('git', ['--version']),
  node: toolVersion('node', ['--version']),
  forge: toolVersion('forge', ['--version']),
  cargo: toolVersion('cargo', ['--version']),
  os: { platform: platform(), release: release(), arch: arch(), hostname: hostname() },
});

const atomicResult = (path: string, value: unknown): void => {
  const temporary = `${path}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
};

export const verify = async (cwd: string) => {
  const { root, commonDir } = repository(cwd);
  const before = sourceState(root);
  const startedAt = new Date().toISOString();
  const directory = join(
    commonDir,
    'xln-verification',
    before.head,
    `${startedAt.replaceAll(':', '-')}-${randomUUID()}`,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const logPath = join(directory, 'check.log');
  const logFd = openSync(logPath, 'wx', 0o600);
  const started = performance.now();
  let after: SourceState | null = null;
  let command: CommandResult | null = null;
  let contracts: CommandResult | null = null;
  let problem = sourceProblem(before);
  const commandLine = [process.execPath, 'run', 'check'] as const;
  const contractsLine = [process.execPath, 'run', 'test:contracts:full'] as const;
  const versions = tools();
  const commandProblem = (name: string, result: CommandResult, budgetMs: number): string | null => {
    if (result.error) return `VERIFY_${name}_PROCESS_ERROR:${result.error}`;
    if (result.timedOut) return `VERIFY_${name}_TIMEOUT:budgetMs=${budgetMs}`;
    if (result.interrupted) return `VERIFY_INTERRUPTED:${result.interrupted}`;
    if (result.exitCode !== 0) return `VERIFY_${name}_FAILED:exitCode=${result.exitCode}`;
    return null;
  };
  try {
    if (!problem) {
      command = await runBoundedCommand(commandLine, root, logFd, CHECK_TIMEOUT_MS);
      problem = commandProblem('CHECK', command, CHECK_TIMEOUT_MS);
    }
    if (!problem) {
      contracts = await runBoundedCommand(contractsLine, root, logFd, CONTRACTS_TIMEOUT_MS);
      problem = commandProblem('CONTRACTS', contracts, CONTRACTS_TIMEOUT_MS);
    }
    after = sourceState(root);
    problem ??= sourceProblem(after);
    if (after.head !== before.head || after.tree !== before.tree) problem = 'VERIFY_COMMIT_CHANGED_DURING_CHECK';
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  } finally {
    fsyncSync(logFd);
    closeSync(logFd);
  }
  const result = {
    schema: 1,
    passed: problem === null && command?.exitCode === 0 && contracts?.exitCode === 0,
    problem,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    root,
    before,
    after,
    command: { argv: commandLine, budgetMs: CHECK_TIMEOUT_MS, result: command },
    contracts: { argv: contractsLine, budgetMs: CONTRACTS_TIMEOUT_MS, result: contracts },
    tools: versions,
    logPath,
  };
  const resultPath = join(directory, 'result.json');
  atomicResult(resultPath, result);
  console.log(
    `${result.passed ? 'VERIFY_PASS' : 'VERIFY_FAIL'}:${problem ?? before.head}\nVERIFY_RESULT:${resultPath}`,
  );
  return { ...result, resultPath };
};

if (import.meta.main) {
  verify(process.cwd())
    .then(result => {
      process.exitCode = result.passed ? 0 : 1;
    })
    .catch(error => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

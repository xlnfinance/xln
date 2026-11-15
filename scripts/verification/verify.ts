import { randomUUID } from 'node:crypto';
import { assertCheckEnvironment } from '../../tools/checks/check-environment';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { arch, hostname, platform, release } from 'node:os';
import { join } from 'node:path';
import { safeStringify } from '../../core/protocol/serialization';
import { repository, sourceProblem, sourceState, type SourceState } from './git';
import { runBoundedCommand, type CommandResult } from './process';
import { fullProfile, verificationBudget, verificationProfile } from './profile';

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
    writeSync(fd, `${safeStringify(value, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
};

export const verify = async (cwd: string, base?: string) => {
  assertCheckEnvironment();
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
  let profile = fullProfile('source-not-admitted', base ?? null);
  let commandLine: readonly [string, ...string[]] = [process.execPath, 'run', 'check'];
  let checkTimeoutMs = verificationBudget(profile);
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
      profile = verificationProfile(root, before.head, base);
      commandLine = [process.execPath, 'run', profile.name === 'deployment' ? 'check:deployment' : 'check'];
      checkTimeoutMs = verificationBudget(profile);
      console.log(`VERIFY_PROFILE:${profile.name}:reason=${profile.reason}:base=${profile.base ?? 'none'}`);
      command = await runBoundedCommand(commandLine, root, logFd, checkTimeoutMs);
      problem = commandProblem('CHECK', command, checkTimeoutMs);
    }
    if (!problem && profile.name === 'full') {
      contracts = await runBoundedCommand(contractsLine, root, logFd, CONTRACTS_TIMEOUT_MS);
      problem = commandProblem('CONTRACTS', contracts, CONTRACTS_TIMEOUT_MS);
    }
    after = sourceState(root);
    problem ??= sourceProblem(after);
    if (after.head !== before.head || after.tree !== before.tree) problem = 'VERIFY_COMMIT_CHANGED_DURING_CHECK';
    if (after.branch !== before.branch) problem = 'VERIFY_BRANCH_CHANGED_DURING_CHECK';
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  } finally {
    fsyncSync(logFd);
    closeSync(logFd);
  }
  const result = {
    schema: 2,
    passed: problem === null && command?.exitCode === 0 && (profile.name === 'deployment' || contracts?.exitCode === 0),
    profile,
    problem,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    root,
    before,
    after,
    command: { argv: commandLine, budgetMs: checkTimeoutMs, result: command },
    contracts:
      profile.name === 'full' ? { argv: contractsLine, budgetMs: CONTRACTS_TIMEOUT_MS, result: contracts } : null,
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
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--base' || !args[1])) {
    throw new Error('VERIFY_ARGUMENTS_INVALID:expected=--base <git-ref>');
  }
  verify(process.cwd(), args[1])
    .then(result => {
      process.exitCode = result.passed ? 0 : 1;
    })
    .catch(error => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

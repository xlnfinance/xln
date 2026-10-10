import { spawn } from 'node:child_process';
import type { SpawnOptionsWithoutStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';

export type ProcessResult = Readonly<{
  exitCode: number | null;
  elapsedMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: string | null;
}>;
type ProcessInput = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  input?: string;
  env?: SpawnOptionsWithoutStdio['env'];
}>;

const terminateGroup = (pid: number | undefined): void => {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    // ESRCH: the group is gone. EPERM: macOS refuses to signal a group whose
    // members are already exiting (seen under load right after close).
    if (!(error instanceof Error && 'code' in error && (error.code === 'ESRCH' || error.code === 'EPERM'))) {
      throw error;
    }
  }
};

/** The deadline covers inherited pipes too; grandchildren cannot keep a finished child alive. */
export const runProcess = (input: ProcessInput): Promise<ProcessResult> =>
  new Promise(resolve => {
    const started = performance.now();
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '',
      stderr = '',
      error: string | null = null,
      timedOut = false;
    const stop = (): void => terminateGroup(child.pid);
    const cancel = (): void => {
      error = 'interrupted';
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, input.timeoutMs);
    const collect = (text: string, lane: 'stdout' | 'stderr'): void => {
      if (lane === 'stdout') stdout += text;
      else stderr += text;
      if (stdout.length + stderr.length > 2_000_000) {
        error = 'output_limit';
        stop();
      }
    };
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    child.stdout.on('data', (data: Buffer) => collect(data.toString(), 'stdout'));
    child.stderr.on('data', (data: Buffer) => collect(data.toString(), 'stderr'));
    child.once('error', () => {
      error = 'spawn_failed';
    });
    child.stdin.on('error', (cause: NodeJS.ErrnoException) => {
      if (cause.code !== 'EPIPE') {
        error = 'stdin_failed';
        stop();
      }
    });
    child.once('close', exitCode => {
      clearTimeout(timer);
      stop();
      EventEmitter.prototype.removeListener.call(process, 'SIGINT', cancel);
      EventEmitter.prototype.removeListener.call(process, 'SIGTERM', cancel);
      resolve({ exitCode, elapsedMs: Math.round(performance.now() - started), stdout, stderr, timedOut, error });
    });
    child.stdin.end(input.input ?? '');
  });

#!/usr/bin/env bun

import { spawn, type ChildProcess } from 'node:child_process';
import { statSync, watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';
import { stopProcessGroup } from './process-group';

type SupervisorOptions = Readonly<{
  label: string;
  watchRoots: string[];
  ignorePrefixes: string[];
  debounceMs: number;
  termTimeoutMs: number;
  killTimeoutMs: number;
  command: string;
  commandArgs: string[];
}>;

type MutableOptions = {
  label: string;
  watchRoots: string[];
  ignorePrefixes: string[];
  debounceMs: number;
  termTimeoutMs: number;
  killTimeoutMs: number;
};

type Generation = Readonly<{
  child: ChildProcess;
  pid: number;
  number: number;
}>;

const readPositiveInteger = (raw: string, label: string, max: number): number => {
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${label}_INVALID:${raw}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) throw new Error(`${label}_INVALID:${raw}`);
  return value;
};

const readOption = (args: string[], index: number, name: string): { value: string; next: number } => {
  const arg = args[index] || '';
  const prefix = `--${name}=`;
  const inlineValue = arg.startsWith(prefix) ? arg.slice(prefix.length) : '';
  if (inlineValue) return { value: inlineValue, next: index };
  const value = args[index + 1];
  if (arg !== `--${name}` || !value || value.startsWith('--')) {
    throw new Error(`DEV_WATCH_OPTION_REQUIRED:${name}`);
  }
  return { value, next: index + 1 };
};

const applyOption = (options: MutableOptions, name: string, value: string): void => {
  if (name === 'label') options.label = value;
  if (name === 'watch-root') options.watchRoots.push(resolve(value));
  if (name === 'ignore-prefix') {
    const normalized = value.replaceAll('\\', '/').replace(/^\.?\//, '').replace(/\/+$/, '');
    if (!normalized || normalized.includes('..')) throw new Error(`DEV_WATCH_IGNORE_PREFIX_INVALID:${value}`);
    options.ignorePrefixes.push(`${normalized}/`);
  }
  if (name === 'debounce-ms') {
    options.debounceMs = readPositiveInteger(value, 'DEV_WATCH_DEBOUNCE_MS', 10_000);
  }
  if (name === 'term-timeout-ms') {
    options.termTimeoutMs = readPositiveInteger(value, 'DEV_WATCH_TERM_TIMEOUT_MS', 120_000);
  }
  if (name === 'kill-timeout-ms') {
    options.killTimeoutMs = readPositiveInteger(value, 'DEV_WATCH_KILL_TIMEOUT_MS', 30_000);
  }
};

const validateOptions = (options: MutableOptions): void => {
  if (!/^[A-Za-z0-9_-]+$/.test(options.label)) {
    throw new Error(`DEV_WATCH_LABEL_INVALID:${options.label}`);
  }
  if (options.watchRoots.length === 0) throw new Error('DEV_WATCH_ROOT_REQUIRED');
  for (const root of options.watchRoots) {
    if (!statSync(root).isDirectory()) throw new Error(`DEV_WATCH_ROOT_NOT_DIRECTORY:${root}`);
  }
};

export const parseDevWatchSupervisorArgs = (argv: string[]): SupervisorOptions => {
  const separator = argv.indexOf('--');
  if (separator < 0) throw new Error('DEV_WATCH_COMMAND_SEPARATOR_REQUIRED');
  const [command, ...commandArgs] = argv.slice(separator + 1);
  if (!command) throw new Error('DEV_WATCH_COMMAND_REQUIRED');
  const options: MutableOptions = {
    label: '',
    watchRoots: [],
    ignorePrefixes: [],
    debounceMs: 100,
    termTimeoutMs: 15_000,
    killTimeoutMs: 2_000,
  };
  const flags = argv.slice(0, separator);
  const allowed = new Set([
    'label',
    'watch-root',
    'ignore-prefix',
    'debounce-ms',
    'term-timeout-ms',
    'kill-timeout-ms',
  ]);
  for (let index = 0; index < flags.length; index += 1) {
    const arg = flags[index] || '';
    const name = arg.replace(/^--/, '').split('=')[0] || '';
    if (!allowed.has(name)) throw new Error(`DEV_WATCH_OPTION_UNKNOWN:${arg}`);
    const parsed = readOption(flags, index, name);
    applyOption(options, name, parsed.value);
    index = parsed.next;
  }
  options.watchRoots = [...new Set(options.watchRoots)];
  options.ignorePrefixes = [...new Set(options.ignorePrefixes)];
  validateOptions(options);
  return { ...options, command, commandArgs };
};

const stopGeneration = async (generation: Generation, options: SupervisorOptions, reason: string): Promise<void> => {
  const { pid, number } = generation;
  console.log(`[${options.label}] stopping generation=${number} pgid=${pid} reason=${reason}`);
  await stopProcessGroup({
    pid,
    termTimeoutMs: options.termTimeoutMs,
    killTimeoutMs: options.killTimeoutMs,
    timeoutError: `DEV_WATCH_GROUP_EXIT_TIMEOUT:label=${options.label}:generation=${number}:pgid=${pid}`,
    onEscalate: () => console.warn(`[${options.label}] force-stopping generation=${number} pgid=${pid}`),
  });
};

const shouldRestartForPath = (
  filename: string | Buffer | null,
  ignorePrefixes: readonly string[],
): boolean => {
  if (filename === null) return true;
  const normalized = String(filename).replaceAll('\\', '/').replace(/^\.?\//, '');
  if (ignorePrefixes.some((prefix) => normalized.startsWith(prefix))) return false;
  return /\.(?:[cm]?[jt]sx?|json)$/i.test(normalized);
};

class DevProcessTreeSupervisor {
  private active: Generation | null = null;
  private generationNumber = 0;
  private stopping = false;
  private restarting = false;
  private restartRequested = false;
  private restartQueued = false;
  private restartReason = 'source-change';
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lifecycle: Promise<void> = Promise.resolve();
  private readonly watchers: FSWatcher[] = [];
  private complete!: (code: number) => void;
  private failCompletion!: (error: unknown) => void;
  private readonly completion = new Promise<number>((complete, fail) => {
    this.complete = complete;
    this.failCompletion = fail;
  });

  constructor(private readonly options: SupervisorOptions) {}

  private startGeneration(): void {
    this.generationNumber += 1;
    const child = spawn(this.options.command, this.options.commandArgs, {
      cwd: process.cwd(), env: process.env, stdio: 'inherit', detached: true,
    });
    child.once('error', error => this.fail(error));
    const pid = child.pid;
    if (!pid) throw new Error(`DEV_WATCH_CHILD_PID_MISSING:label=${this.options.label}`);
    const generation = { child, pid, number: this.generationNumber };
    this.active = generation;
    console.log(`[${this.options.label}] started generation=${generation.number} pgid=${pid}`);
    child.once('exit', (code, signal) => this.onGenerationExit(generation, code, signal));
  }

  private onGenerationExit(generation: Generation, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.active !== generation || this.restarting || this.stopping) return;
    this.fail(new Error(
      `DEV_WATCH_CHILD_EXITED:label=${this.options.label}:generation=${generation.number}:` +
      `code=${String(code)}:signal=${String(signal)}`,
    ));
  }

  private async stopActive(reason: string): Promise<void> {
    const generation = this.active;
    if (!generation) return;
    await stopGeneration(generation, this.options, reason);
    if (this.active === generation) this.active = null;
  }

  private async restartOnce(): Promise<void> {
    this.restarting = true;
    try {
      await this.stopActive(this.restartReason);
      if (!this.stopping) this.startGeneration();
    } finally {
      this.restarting = false;
    }
  }

  private queueRestartDrain(): void {
    if (this.restartQueued || this.stopping) return;
    this.restartQueued = true;
    this.lifecycle = this.lifecycle.then(async () => {
      while (this.restartRequested && !this.stopping) {
        this.restartRequested = false;
        await this.restartOnce();
      }
    }).finally(() => {
      this.restartQueued = false;
    }).catch(error => this.fail(error));
  }

  private requestRestart(reason: string): void {
    if (this.stopping) return;
    this.restartReason = reason;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.restartRequested = true;
      this.queueRestartDrain();
    }, this.options.debounceMs);
  }

  private closeWatchers(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    for (const watcher of this.watchers) watcher.close();
    this.watchers.length = 0;
  }

  private finish(code: number, reason: string): void {
    if (this.stopping) return;
    this.stopping = true;
    this.closeWatchers();
    this.lifecycle = this.lifecycle
      .then(() => this.stopActive(reason))
      .then(() => this.complete(code))
      .catch(error => this.failCompletion(error));
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`[${this.options.label}] supervisor failure: ${message}`);
    this.finish(1, 'supervisor-failure');
  }

  private startWatchers(): void {
    for (const root of this.options.watchRoots) {
      const watcher = watch(root, { recursive: true }, (eventType, filename) => {
        if (shouldRestartForPath(filename, this.options.ignorePrefixes)) {
          this.requestRestart(`${eventType}:${String(filename || root)}`);
        }
      });
      watcher.on('error', error => this.fail(error));
      this.watchers.push(watcher);
      console.log(`[${this.options.label}] watching ${root}`);
    }
  }

  async run(): Promise<number> {
    if (process.platform === 'win32') throw new Error('DEV_WATCH_PROCESS_GROUP_UNSUPPORTED:win32');
    process.once('SIGTERM', () => this.finish(143, 'SIGTERM'));
    process.once('SIGINT', () => this.finish(130, 'SIGINT'));
    try {
      this.startWatchers();
      this.startGeneration();
    } catch (error) {
      this.closeWatchers();
      throw error;
    }
    return await this.completion;
  }
}

if (import.meta.main) {
  new DevProcessTreeSupervisor(parseDevWatchSupervisorArgs(process.argv.slice(2))).run()
    .then(code => process.exit(code))
    .catch(error => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exit(1);
    });
}

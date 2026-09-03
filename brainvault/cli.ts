#!/usr/bin/env bun
/**
 * BrainVault CLI - Production wallet derivation
 *
 * Usage:
 *   bun run bv                                  # Interactive
 *   bun test brainvault/core.test.ts            # Run deterministic tests
 *   bun run bv --bench                          # Benchmark performance
 *   bun run bv --smoke                          # Fast 2-shard backend parity check
 *   bun run bv --lib=wasm                       # Force hash-wasm (slower, parity check)
 *   bun run bv --lib=native                     # Force portable @node-rs/argon2
 *   bun run bv --lib=neon                       # Force bundled Apple Silicon C/NEON
 *   bun run bv --engine=metal                   # Force fastest Apple Metal hybrid
 *   bun run bv --ask                            # Ask for factor, multiplier, and workers
 *   bun run bv --allow-short-password           # Legacy recovery only: allow fewer than 8 chars
 *   bun run bv --repeat                         # Interactive: require double entry for name/pass
 *   bun run bv --show-password                  # Echo password input (unsafe on shared screens)
 *   bun run bv --shard-multiplier=4             # Custom KDF mode: 256 MiB * multiplier per shard
 *   bun run bv --address-count=5                # Number of standard + ledger-live addresses
 *   bun run bv --show-private-key               # Also reveal raw key for Address 1 (highest risk)
 *   bun run bv --help                           # Show usage/help
 */

import { stdin, stdout } from 'process';
import { cpus, totalmem } from 'os';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Writable } from 'node:stream';
import * as readline from 'readline/promises';
import { Worker } from 'worker_threads';
import { hashRaw as argon2Native } from '@node-rs/argon2';
import {
  getShardCount, combineShardsWithParams, deriveKey, entropyToMnemonic,
  deriveEthereumAddress, deriveEthereumAddressMatrix, deriveEthereumPrivateKeyAtPath,
  factorForShardCount, formatDuration, bytesToHex,
  BRAINVAULT_V1, BRAINVAULT_V1_SPEC_ID, createShardSalt, deriveSitePassword, rootFingerprint,
} from './core.ts';
import { assertBrainVaultName, assertBrainVaultPassphrase, shardRequestFingerprint } from './primitives/spec.ts';
import { acceptShard, createShardSlots, finalizeShards } from './shard-collector.ts';
import { cliCreationCharacterError, cliPasswordError } from './cli-policy.ts';
import { verifyBundledExecutable } from './binary-integrity.ts';
import { acceleratorPlan, deriveHybridNativeShards, type AcceleratorEngine } from './native-hybrid.ts';
import { BRAINVAULT_NATIVE_PROGRESS_ENV, readNativeProgress } from './native/progress.ts';
import {
  BRAINVAULT_DEFAULT_LEVEL,
  BRAINVAULT_LEVEL_NAMES,
  BRAINVAULT_LEVEL_SHARDS,
  getShardCountForLevel,
} from './presets.ts';
import {
  generateSuggestedPassword,
  SUGGESTED_PASSWORD_BITS,
  SUGGESTED_PASSWORD_CHARACTERS,
} from './suggestion.ts';

const args = process.argv.slice(2);
const BOOLEAN_FLAGS = new Set([
  '--help', '-h', '--bench', '--smoke', '--password', '--ask', '--repeat',
  '--show-private-key', '--reveal', '--allow-short-password',
  '--suggest-password', '--unicode-recovery', '--show-password',
]);
const VALUE_FLAGS = new Set([
  '--level', '--shards', '--factor', '--multiplier', '--shard-multiplier',
  '--workers', '--w', '--engine', '--address-count',
]);
const LEGACY_ENGINE_FLAGS = new Set(['--lib=wasm', '--lib=native', '--lib=neon']);

function rejectUnsafeArgv(): never {
  console.error('Error: unsupported or secret-bearing argv. Passwords are accepted only through interactive input.');
  process.exit(1);
}

function validateArgv(argv: readonly string[]): void {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (/^--(?:unsafe-password|passphrase|pass|secret)(?:=|$)/.test(argument)
      || argument.startsWith('--password=')) rejectUnsafeArgv();
    if (BOOLEAN_FLAGS.has(argument) || LEGACY_ENGINE_FLAGS.has(argument)) continue;
    const equals = argument.indexOf('=');
    if (equals !== -1) {
      if (!VALUE_FLAGS.has(argument.slice(0, equals)) || equals === argument.length - 1) rejectUnsafeArgv();
      continue;
    }
    if (VALUE_FLAGS.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) rejectUnsafeArgv();
      index += 1;
      continue;
    }
    rejectUnsafeArgv();
  }
}

validateArgv(args);
const showHelp = args.includes('--help') || args.includes('-h');

const UI_INNER_WIDTH = 68;
const MAX_WASM_MULTIPLIER = 7;

function terminalColumns(): number {
  const environmentColumns = Number(process.env.COLUMNS);
  const reported = Number.isSafeInteger(stdout.columns) && (stdout.columns ?? 0) >= 20
    ? stdout.columns!
    : 80;
  return Number.isSafeInteger(environmentColumns) && environmentColumns >= 20
    ? Math.min(reported, environmentColumns)
    : reported;
}

function fitTerminal(text: string, width: number): string {
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}

class PromptOutput extends Writable {
  muted = false;

  override _write(
    chunk: string | Uint8Array,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted) stdout.write(chunk, encoding);
    callback();
  }
}

function printBrand(): void {
  const tty = stdout.isTTY;
  const color = tty && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
  const cyan = color ? '\x1b[38;5;45m' : '';
  const reset = color ? '\x1b[0m' : '';
  const [topLeft, topRight, bottomLeft, bottomRight, horizontal, vertical] = tty
    ? ['╭', '╮', '╰', '╯', '─', '│']
    : ['+', '+', '+', '+', '-', '|'];
  const innerWidth = Math.max(12, Math.min(UI_INNER_WIDTH, terminalColumns() - 4));
  const top = `${cyan}${topLeft}${horizontal.repeat(innerWidth + 2)}${topRight}${reset}`;
  const bottom = `${cyan}${bottomLeft}${horizontal.repeat(innerWidth + 2)}${bottomRight}${reset}`;
  const row = (text: string) => `${cyan}${vertical}${reset} ${fitTerminal(text, innerWidth).padEnd(innerWidth)} ${cyan}${vertical}${reset}`;
  console.log(top);
  console.log(row('brainvault v1  ·  memory-hard deterministic wallet'));
  console.log(row('same V1 inputs → same wallet · no recovery file'));
  console.log(bottom);
}

function printStep(step: number, title: string): void {
  const color = stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
  const cyan = color ? '\x1b[38;5;45m' : '';
  const dim = color ? '\x1b[2m' : '';
  const reset = color ? '\x1b[0m' : '';
  console.log(`\n${cyan}◆${reset} ${title.toLowerCase()} ${dim}[${step}/3]${reset}`);
}

function startDerivationProgress(shards: number, workers: number): Readonly<{
  update: (completed: number) => void;
  complete: (elapsedMs: number) => void;
  stop: () => void;
}> {
  if (!stdout.isTTY) return { update: () => {}, complete: () => {}, stop: () => {} };
  const compact = terminalColumns() < 72;
  const width = compact ? Math.max(6, terminalColumns() - 24) : 40;
  const color = process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
  const cyan = color ? '\x1b[38;5;45m' : '';
  const green = color ? '\x1b[38;5;82m' : '';
  const dim = color ? '\x1b[2m' : '';
  const reset = color ? '\x1b[0m' : '';
  const startedAt = Date.now();
  let completed = 0;
  let stopped = false;
  let rendered = false;
  const render = () => {
    const elapsedMs = Math.max(1, Date.now() - startedAt);
    const ratio = Math.min(1, completed / shards);
    const filled = Math.floor(ratio * width);
    const bar = `${cyan}${'━'.repeat(filled)}${reset}${filled < width ? `${cyan}╸${reset}${dim}${'·'.repeat(width - filled - 1)}${reset}` : ''}`;
    const percent = Math.floor(ratio * 100);
    const rate = completed / (elapsedMs / 1000);
    const eta = completed > 0 && completed < shards ? (shards - completed) / rate * 1000 : 0;
    const etaText = completed >= shards ? 'finalizing' : completed > 0 ? `ETA ${formatDuration(eta)}` : 'ETA --';
    if (compact) {
      stdout.write(`\r\x1b[2K${cyan}◇${reset} ${String(percent).padStart(3)}% [${bar}] ${completed}/${shards}`);
    } else {
      if (rendered) stdout.write('\x1b[2A');
      stdout.write(`\r\x1b[2K  ${cyan}◇ DERIVING${reset}  ${String(percent).padStart(3)}%  [${bar}]\n`);
      stdout.write(`\r\x1b[2K     ${completed.toLocaleString('en-US')} / ${shards.toLocaleString('en-US')} shards  ·  ${rate.toFixed(rate >= 100 ? 0 : 1)} shards/s  ·  ${etaText}  ·  ${workers} workers\n`);
    }
    rendered = true;
  };
  const timer = setInterval(render, 100);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (rendered) {
      stdout.write(compact
        ? '\r\x1b[2K'
        : '\x1b[2A\r\x1b[2K\n\r\x1b[2K\x1b[1A\r');
    }
  };
  return {
    update: value => {
      if (Number.isSafeInteger(value) && value >= 0 && value <= shards) completed = value;
    },
    complete: elapsedMs => {
      stop();
      if (compact) {
        console.log(`${green}✓ DERIVED${reset} 100% · ${shards}/${shards} · ${formatDuration(elapsedMs)}`);
      } else {
        console.log(`  ${green}✓ DERIVED${reset}  100%  [${green}${'━'.repeat(width)}${reset}]`);
        console.log(`     ${shards.toLocaleString('en-US')} / ${shards.toLocaleString('en-US')} shards  ·  ${workers} workers  ·  ${formatDuration(elapsedMs)}`);
      }
    },
    stop,
  };
}

let sensitiveScreenOpen = false;

function canUseSensitiveScreen(): boolean {
  return stdin.isTTY === true && stdout.isTTY === true && process.env.TERM !== 'dumb';
}

function openSensitiveScreen(): void {
  if (!canUseSensitiveScreen()) throw new Error('BRAINVAULT_SENSITIVE_TERMINAL_UNAVAILABLE');
  sensitiveScreenOpen = true;
  stdout.write('\x1b[?1049h\x1b[2J\x1b[H');
}

function eraseSensitiveScreen(): void {
  if (!sensitiveScreenOpen) return;
  // Alternate-screen teardown keeps recovery material out of normal scrollback
  // on conventional terminals. It cannot defeat recordings or terminal logging.
  stdout.write('\x1b[2J\x1b[3J\x1b[H\x1b[?1049l');
  sensitiveScreenOpen = false;
}

process.once('exit', eraseSensitiveScreen);
process.once('SIGHUP', () => {
  eraseSensitiveScreen();
  process.exit(129);
});
process.once('SIGTERM', () => {
  eraseSensitiveScreen();
  process.exit(143);
});

async function askSecret(
  rl: readline.Interface,
  output: PromptOutput,
  prompt: string,
): Promise<string> {
  stdout.write(prompt);
  output.muted = true;
  try {
    return await rl.question('');
  } finally {
    output.muted = false;
    stdout.write('\n');
  }
}

async function askPasswordInput(
  rl: readline.Interface,
  output: PromptOutput,
  hiddenPrompt: string,
  visiblePrompt: string,
): Promise<string> {
  return showPasswordInput
    ? await rl.question(visiblePrompt)
    : await askSecret(rl, output, hiddenPrompt);
}

function printVisibleInputWarning(): void {
  if (!showPasswordInput) return;
  console.warn('WARNING: visible password input is ON.');
  console.warn('Characters appear on screen and may be retained by scrollback,');
  console.warn('recordings, logs, tmux, or photos.\n');
}

function rejectPrompt(rl: readline.Interface, message: string): void {
  console.error(`Error: ${message}`);
  process.exitCode = 1;
  rl.close();
}

async function selectOption(title: string, options: readonly string[], initial = 0): Promise<number> {
  if (!stdin.isTTY || !stdout.isTTY) return initial;
  let selected = Math.max(0, Math.min(initial, options.length - 1));
  let drawn = false;
  const previousRaw = stdin.isRaw ?? false;
  const optionWidth = Math.max(10, terminalColumns() - 2);
  const draw = () => {
    if (drawn) stdout.write(`\x1b[${options.length}A`);
    for (const [index, option] of options.entries()) {
      stdout.write(`\x1b[2K\r${index === selected ? '>' : ' '} ${fitTerminal(option, optionWidth)}\n`);
    }
    drawn = true;
  };
  console.log(`${title} (up/down or j/k, Enter confirms)`);
  draw();
  stdin.setRawMode(true);
  stdin.resume();
  return await new Promise<number>((resolve, reject) => {
    const finish = (result?: number, error?: Error) => {
      stdin.off('data', onData);
      stdin.setRawMode(previousRaw);
      stdin.pause();
      stdout.write('\n');
      if (error !== undefined) reject(error); else resolve(result!);
    };
    const onData = (chunk: Buffer) => {
      const key = chunk.toString();
      if (key.includes('\u0003')) {
        const error = new Error('Aborted with Ctrl+C');
        error.name = 'AbortError';
        finish(undefined, error);
      } else {
        const up = key.match(/\u001b\[A|k/g)?.length ?? 0;
        const down = key.match(/\u001b\[B|j/g)?.length ?? 0;
        if (up !== 0 || down !== 0) {
          selected = (selected - up + down + (options.length * (up + 1))) % options.length;
          draw();
        }
        if (key.includes('\r') || key.includes('\n')) finish(selected);
      }
    };
    stdin.on('data', onData);
  });
}

function printHelp(): void {
  console.log(`BrainVault v1 (bv)

What is BrainVault?
- Memory-hard deterministic wallet derivation from: Username + Password + work settings.
- Uses Argon2id per-shard and BLAKE3 domain-separated combine.
- Same V1 semantic inputs => same master key, mnemonics, and addresses.
- Engine and worker count affect speed only; they are not recovery inputs.

Usage:
- bunx brainvault
- bunx brainvault --ask
- bun run bv
- bun run bv --ask
- bun run bv --bench
- bun run bv --smoke
- bun run bv --password

Flags:
- --help, -h
  Show this help message.
- --bench
  Sequentially benchmark every compatible backend. Defaults: 1,000 shards,
  level 3 (internal frozen factor 4), multiplier 1, and up to 32 CPU cores.
- --smoke
  Fast backend sanity check: run the same engines sequentially with exactly
  2 shards and verify that every result has the same root.
- --password
  Derive site-specific passwords from the master key.
- --ask
  Advanced interactive setup: ask for level/shards, shard multiplier, workers,
  and engine. Engine choice never changes the derived root.
  Without this flag the recommended wallet default is level 4 (10,000 shards),
  multiplier 1, and the fastest bundled backend supported by the machine.
- --engine NAME
  Choose auto, metal, metal-generic, opencl, c-neon, c-neon-wipe,
  native-direct, native-sync, native, rust, rust-no-wipe, or wasm.
  On the measured M3 Ultra class, auto uses Metal V1 hybrid for 1,000+ shards at
  multiplier 1; other Apple Silicon safely uses C/NEON or portable native.
- --lib=native
  Force the portable @node-rs/argon2 worker implementation.
- --lib=neon
  Force the bundled C/NEON implementation on Apple Silicon.
- --lib=wasm
  Use hash-wasm worker (slower, cross-backend parity/testing path).
- --w=N
  Number of parallel workers in non-interactive mode (default: all CPU cores allowed by RAM).
- --level N, --shards N, --factor N, --multiplier N, --workers N, --engine NAME
  Inline forms of every advanced setting. Both "--flag value" and "--flag=value"
  work. Levels 1..6 map to 1/100/1,000/10,000/100,000/1,000,000 shards.
  --shards is always exact. --factor preserves recovery of the legacy 1/10/100...
  scale and should not be used for new wallets.
- --repeat
  Interactive mode only: require second entry for Username and Password.
- --show-password
  Echo password and confirmation input. Explicitly unsafe: characters appear on
  screen and may be retained by scrollback, recordings, logs, tmux, or photos.
  Passwords remain forbidden in argv.
- --reveal
  Backward-compatible alias. The interactive flow always offers one password
  confirmation after printing the public fingerprint and first address.
- --shard-multiplier=N
  Custom KDF mode. Memory per shard = 256 MiB * N.
  Warning: changing this changes the derived wallet.
- --address-count=N
  Number of addresses generated per scheme (standard + Ledger Live).
- --show-private-key
  After exact interactive password confirmation, also print the raw private key for
  Address 1 (highest risk).
- --allow-short-password
  Unsafe override intended only for legacy recovery. Eight characters is input
  hygiene, not a security recommendation; weak or reused passwords remain unsafe.
- --suggest-password
  Interactive creation only: generate ${SUGGESTED_PASSWORD_CHARACTERS} random
  a-z/A-Z/0-9 characters (${SUGGESTED_PASSWORD_BITS.toFixed(2)} bits) with the
  operating-system CSPRNG. It is shown once and must be repeated.
- --unicode-recovery
  Permit non-ASCII input for legacy recovery using V1 NFKD/UTF-8 semantics.
  For values a terminal cannot represent exactly, use the library API and verify
  the remembered first address. New CLI wallet creation accepts printable ASCII.

Examples:
- bunx brainvault
- bunx brainvault --ask
- bunx brainvault --bench --level 3 --multiplier 10 --workers 32
- bunx brainvault --ask --level 3 --multiplier 1 --workers 32 --engine metal
- bun run bv
- bunx brainvault --show-private-key

Recovery rule:
- You must use the same V1 Username + Password + Shard count + multiplier
  to reproduce the same master key.
- Capitalization and every space are exact for printable-ASCII creation.
- Engine and worker count do not affect the wallet.

Wallet import:
- Import either displayed mnemonic as an existing BIP-39 wallet.
- Leave the optional BIP-39 passphrase empty. Never enter your BrainVault password into that field.
- The 24-word PRIMARY and 12-word SECONDARY are separate wallets. Verify the
  corresponding first receiving address before sending funds.
- Optional: you can load unpacked Rabby from https://github.com/RabbyHub/Rabby
  (note: unpacked extension has no auto-updates).`);
}

if (showHelp) {
  printHelp();
  process.exit(0);
}

function getFlagValue(names: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    for (const name of names) {
      if (argument.startsWith(`--${name}=`)) return argument.slice(name.length + 3);
      if (argument === `--${name}`) {
        const next = args[index + 1];
        return next === undefined || next.startsWith('--') ? '' : next;
      }
    }
  }
  return undefined;
}

function getPositiveIntFlag(names: readonly string[], defaultValue?: number): number | undefined {
  const raw = getFlagValue(names);
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    console.error(`Error: invalid --${names[0]} value: ${raw}. Expected a positive integer.`);
    process.exit(1);
  }
  return value;
}

const ENGINE_IDS = [
  'auto',
  'metal',
  'metal-generic',
  'opencl',
  'c-neon',
  'c-neon-wipe',
  'native-direct',
  'native-sync',
  'native',
  'rust',
  'rust-no-wipe',
  'wasm',
] as const;
type EngineSelection = typeof ENGINE_IDS[number];

const legacyEngineFlags: EngineSelection[] = [
  ...(args.includes('--lib=wasm') ? ['wasm' as const] : []),
  ...(args.includes('--lib=native') ? ['native' as const] : []),
  ...(args.includes('--lib=neon') ? ['c-neon' as const] : []),
];
const inlineEngine = getFlagValue(['engine']);
if (inlineEngine !== undefined && !ENGINE_IDS.includes(inlineEngine as EngineSelection)) {
  console.error(`Error: invalid --engine value: ${inlineEngine}. Expected one of: ${ENGINE_IDS.join(', ')}.`);
  process.exit(1);
}
if (legacyEngineFlags.length > 1 || (inlineEngine !== undefined && legacyEngineFlags.length > 0)) {
  console.error('Error: choose only one of --engine, --lib=wasm, --lib=native, or --lib=neon');
  process.exit(1);
}

const flagEngine = (inlineEngine ?? legacyEngineFlags[0] ?? 'auto') as EngineSelection;
const requireRepeat = args.includes('--repeat');
const showPasswordInput = args.includes('--show-password');
const showPrivateKey = args.includes('--show-private-key');
const revealRequested = args.includes('--reveal');
const askAdvanced = args.includes('--ask');
const allowShortPassword = args.includes('--allow-short-password');
const suggestPassword = args.includes('--suggest-password');
const unicodeRecovery = args.includes('--unicode-recovery');
const addressCount = getPositiveIntFlag(['address-count'], 5)!;
const shardMultiplierFlag = getPositiveIntFlag(['multiplier', 'shard-multiplier']);
const shardMultiplier = shardMultiplierFlag ?? 1;
const inlineLevel = getPositiveIntFlag(['level']);
const inlineFactor = getPositiveIntFlag(['factor']);
const inlineShards = getPositiveIntFlag(['shards']);
const inlineWorkers = getPositiveIntFlag(['workers', 'w']);

if ((revealRequested || showPrivateKey) && !canUseSensitiveScreen()) {
  console.error('Error: sensitive output requires a reliable interactive terminal with alternate-screen support.');
  process.exit(1);
}

if (!args.includes('--bench') && !args.includes('--smoke') && (!stdin.isTTY || !stdout.isTTY)) {
  console.error('Error: interactive password input requires a TTY; piped or redirected input is refused.');
  process.exit(1);
}

if ([inlineLevel, inlineFactor, inlineShards].filter(value => value !== undefined).length > 1) {
  console.error('Error: choose only one of --level, --factor, or --shards');
  process.exit(1);
}
if (inlineLevel !== undefined && inlineLevel > 6) {
  console.error('Error: --level must be 1-6');
  process.exit(1);
}
if (inlineFactor !== undefined && inlineFactor > BRAINVAULT_V1.MAX_FACTOR) {
  console.error(`Error: --factor must be ${BRAINVAULT_V1.MIN_FACTOR}-${BRAINVAULT_V1.MAX_FACTOR}`);
  process.exit(1);
}

function getCliPasswordError(passphrase: string): string | undefined {
  return cliPasswordError(passphrase, allowShortPassword);
}

function getCliCreationCharacterError(name: string, passphrase: string): string | undefined {
  return cliCreationCharacterError(name, passphrase, unicodeRecovery);
}

function isUserCancellation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: unknown };
  return error.name === 'AbortError'
    || candidate.code === 'ABORT_ERR'
    || error.message.includes('Aborted with Ctrl+C');
}

type EngineChoice = Readonly<{
  id: Exclude<EngineSelection, 'auto'>;
  label: string;
  referenceRate: number;
  warning?: string;
}>;

type WorkSpec = Readonly<{ shardCount: number; factor: number; level?: number }>;

function workFromLevel(level: number): WorkSpec {
  const shardCount = getShardCountForLevel(level);
  return { shardCount, factor: factorForShardCount(shardCount), level };
}

function workFromExactShards(shardCount: number): WorkSpec {
  return { shardCount, factor: factorForShardCount(shardCount) };
}

function workFromLegacyFactor(factor: number): WorkSpec {
  return { shardCount: getShardCount(factor), factor };
}

function recoveryRuleText(shardCount: number, shardMultiplierValue: number): string {
  return `Recovery inputs: exact Username + Password + ${shardCount.toLocaleString('en-US')} shards + Multiplier ${shardMultiplierValue}.`;
}

type HardwarePlan = Readonly<{
  cpuCores: number;
  totalGB: number;
  memoryPerWorkerGb: number;
  maxFromRAM: number;
  recommendedWorkers: number;
  strongerMultiplier: number;
  upperMultiplier: number;
}>;

function floorPowerOfTwo(value: number): number {
  if (value < 1) return 1;
  return 2 ** Math.floor(Math.log2(value));
}

function getHardwarePlan(shardCount: number, multiplier: number): HardwarePlan {
  const cpuCores = cpus().length;
  const totalGB = Math.floor(totalmem() / (1024 ** 3));
  const baseMemoryPerWorkerGb = BRAINVAULT_V1.SHARD_MEMORY_KB / (1024 * 1024);
  const memoryPerWorkerGb = baseMemoryPerWorkerGb * multiplier;
  const maxFromRAM = Math.floor((totalGB * 0.8) / memoryPerWorkerGb);
  const maxForAllCoresAtQuarterRAM = Math.max(1, Math.floor((totalGB * 0.25) / (cpuCores * baseMemoryPerWorkerGb)));
  const maxForAllCoresAtHalfRAM = Math.max(1, Math.floor((totalGB * 0.5) / (cpuCores * baseMemoryPerWorkerGb)));
  return {
    cpuCores,
    totalGB,
    memoryPerWorkerGb,
    maxFromRAM,
    recommendedWorkers: Math.min(cpuCores, maxFromRAM, shardCount),
    strongerMultiplier: floorPowerOfTwo(maxForAllCoresAtQuarterRAM),
    upperMultiplier: maxForAllCoresAtHalfRAM,
  };
}

// ============================================================================
// CORE DERIVATION
// ============================================================================

interface DeriveOptions {
  engine?: EngineSelection;
  shardMultiplier?: number;
  onProgress?: (completed: number, total: number) => void;
}

function resolveNeonExecutable(): string | undefined {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return undefined;
  const isAppleM3 = cpus().some(cpu => cpu.model.toLowerCase().includes('apple m3'));
  const candidates = [
    ...(isAppleM3 ? [`${import.meta.dir}/prebuilds/darwin-arm64/brainvault-argon2-m3`] : []),
    `${import.meta.dir}/prebuilds/darwin-arm64/brainvault-argon2`,
    `${import.meta.dir}/experimental/argon2-c/brainvault-argon2`,
  ];
  return candidates.find(candidate => existsSync(candidate));
}

function isMeasuredM3Ultra(): boolean {
  return process.platform === 'darwin'
    && process.arch === 'arm64'
    && totalmem() >= 500 * 1024 ** 3
    && cpus().length === 32
    && cpus().some(cpu => cpu.model.toLowerCase().includes('apple m3'));
}

function resolveRustExecutable(noWipe: boolean): string | undefined {
  const basename = noWipe ? 'brainvault-argon2-rust-no-wipe' : 'brainvault-argon2-rust';
  const candidates = [
    ...(process.platform === 'darwin' && process.arch === 'arm64'
      ? [`${import.meta.dir}/prebuilds/darwin-arm64/${basename}`]
      : []),
    noWipe
      ? `${import.meta.dir}/experimental/argon2-rust/target-no-wipe/release/brainvault-argon2-rust`
      : `${import.meta.dir}/experimental/argon2-rust/target/release/brainvault-argon2-rust`,
  ];
  return candidates.find(candidate => existsSync(candidate));
}

type AcceleratorBundle = Readonly<{
  executable: string;
  metalLibrary?: string;
  openclKernel?: string;
}>;

function resolveAcceleratorBundle(engine: AcceleratorEngine): AcceleratorBundle | undefined {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return undefined;
  if (engine === 'opencl') {
    const openclKernel = `${import.meta.dir}/experimental/argon2-opencl/data/kernels/argon2_kernel.cl`;
    const executable = [
      `${import.meta.dir}/prebuilds/darwin-arm64/brainvault-argon2-opencl`,
      `${import.meta.dir}/experimental/argon2-opencl/brainvault-argon2-opencl`,
    ].find(candidate => existsSync(candidate));
    return executable !== undefined && existsSync(openclKernel) ? { executable, openclKernel } : undefined;
  }
  const prebuiltExecutable = `${import.meta.dir}/prebuilds/darwin-arm64/brainvault-argon2-metal`;
  const prebuiltLibrary = `${import.meta.dir}/prebuilds/darwin-arm64/argon2.metallib`;
  if (existsSync(prebuiltExecutable) && existsSync(prebuiltLibrary)) {
    return { executable: prebuiltExecutable, metalLibrary: prebuiltLibrary };
  }
  const executable = `${import.meta.dir}/experimental/argon2-metal/brainvault-argon2-metal`;
  const metalLibrary = `${import.meta.dir}/experimental/argon2-metal/argon2.metallib`;
  return existsSync(executable) && existsSync(metalLibrary) ? { executable, metalLibrary } : undefined;
}

function getInteractiveEngineChoices(multiplier: number): EngineChoice[] {
  const choices: EngineChoice[] = [];
  if (multiplier === 1 && resolveAcceleratorBundle('metal') !== undefined && resolveNeonExecutable() !== undefined) {
    choices.push(
      { id: 'metal', label: 'Metal V1 + C/NEON hybrid (fastest)', referenceRate: 365.81 },
      { id: 'metal-generic', label: '(experimental) Metal generic + C/NEON hybrid', referenceRate: 355.22 },
    );
  }
  if (multiplier === 1 && resolveAcceleratorBundle('opencl') !== undefined && resolveNeonExecutable() !== undefined) {
    choices.push({ id: 'opencl', label: '(experimental) OpenCL + C/NEON hybrid', referenceRate: 337.43 });
  }
  if (resolveNeonExecutable() !== undefined) {
    choices.push(
      { id: 'c-neon', label: 'C/NEON final wipe (fastest)', referenceRate: 191.87 },
      { id: 'c-neon-wipe', label: '(experimental) C/NEON wipe after every shard', referenceRate: 177.11 },
    );
  }
  choices.push(
    { id: 'native-direct', label: '(experimental) Native direct async', referenceRate: 167.10 },
    { id: 'native-sync', label: '(experimental) Native sync workers', referenceRate: 165.12 },
    { id: 'native', label: 'Native isolated workers', referenceRate: 159.61 },
  );
  if (resolveRustExecutable(false) !== undefined) {
    choices.push({ id: 'rust', label: '(experimental) Rust pool secure wipe', referenceRate: 149.03 });
  }
  if (resolveRustExecutable(true) !== undefined) {
    choices.push({
      id: 'rust-no-wipe',
      label: '(experimental) Rust pool without internal wipe',
      referenceRate: 136.94,
      warning: 'unsafe memory-hygiene comparison',
    });
  }
  if (multiplier <= MAX_WASM_MULTIPLIER) {
    choices.push({ id: 'wasm', label: 'TypeScript/WASM reference', referenceRate: 76.36 });
  }
  return choices;
}

async function deriveExecutableShards(
  executable: string,
  name: string,
  passphrase: string,
  shardCount: number,
  workers: number,
  wipePerShard = false,
  shardMemoryKb = BRAINVAULT_V1.SHARD_MEMORY_KB,
  algId = BRAINVAULT_V1.ALG_ID,
  onProgress?: (completed: number) => void,
): Promise<Uint8Array[]> {
  const verifiedExecutable = verifyBundledExecutable(executable, import.meta.dir);
  const password = new TextEncoder().encode(passphrase.normalize('NFKD'));
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0x32435642, 0);
  header.writeUInt32LE(shardCount, 4);
  header.writeUInt32LE(workers, 8);
  header.writeUInt32LE(password.length, 12);
  header.writeUInt32LE(wipePerShard ? 1 : 0, 16);
  header.writeUInt32LE(shardMemoryKb, 20);
  const input = Buffer.alloc(header.length + password.length + (shardCount * 32));
  header.copy(input, 0);
  input.set(password, header.length);
  let output = Buffer.alloc(0);
  let stderr = '';
  let exitCode = -1;
  let lastProgress = 0;
  const acceptProgress = onProgress === undefined ? undefined : (completed: number) => {
    if (!Number.isSafeInteger(completed) || completed < 1 || completed > shardCount) {
      throw new Error(`BRAINVAULT_NATIVE_PROGRESS_INVALID:${completed}:${lastProgress}:${shardCount}`);
    }
    if (completed <= lastProgress) return;
    lastProgress = completed;
    onProgress(completed);
  };
  try {
    for (let index = 0; index < shardCount; index += 1) {
      input.set(await createShardSalt(name, index, shardCount, algId), header.length + password.length + (index * 32));
    }
    const child = Bun.spawn([verifiedExecutable], {
      env: {
        ...process.env,
        ...(onProgress === undefined ? {} : { [BRAINVAULT_NATIVE_PROGRESS_ENV]: '1' }),
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    child.stdin.write(input);
    child.stdin.end();
    const [stdoutBytes, stderrText, status] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      readNativeProgress(child.stderr, acceptProgress),
      child.exited,
    ]);
    output = Buffer.from(stdoutBytes);
    stderr = stderrText;
    exitCode = status;
  } finally {
    password.fill(0);
    input.fill(0);
  }
  if (exitCode !== 0) {
    output.fill(0);
    throw new Error(`BRAINVAULT_EXECUTABLE_FAILED:${String(exitCode)}:${stderr.trim()}`);
  }
  if (onProgress !== undefined && lastProgress !== shardCount) {
    output.fill(0);
    throw new Error(`BRAINVAULT_NATIVE_PROGRESS_INCOMPLETE:${lastProgress}:${shardCount}`);
  }
  if (output.length !== shardCount * BRAINVAULT_V1.SHARD_OUTPUT_BYTES) {
    const actual = output.length;
    output.fill(0);
    throw new Error(`BRAINVAULT_EXECUTABLE_OUTPUT_INVALID:${actual}`);
  }
  const shards = Array.from({ length: shardCount }, (_, index) => new Uint8Array(
    output.subarray(
      index * BRAINVAULT_V1.SHARD_OUTPUT_BYTES,
      (index + 1) * BRAINVAULT_V1.SHARD_OUTPUT_BYTES,
    ),
  ));
  output.fill(0);
  return shards;
}

async function deriveDirectAsyncShards(
  name: string,
  passphrase: string,
  shardCount: number,
  workers: number,
  shardMemoryKb: number,
  algId: string,
  onProgress?: (completed: number) => void,
): Promise<Uint8Array[]> {
  const password = new TextEncoder().encode(passphrase.normalize('NFKD'));
  const shards = new Array<Uint8Array>(shardCount);
  let nextShard = 0;
  let completed = 0;
  try {
    await Promise.all(Array.from({ length: workers }, async () => {
      for (;;) {
        const shardIndex = nextShard++;
        if (shardIndex >= shardCount) return;
        const salt = await createShardSalt(name, shardIndex, shardCount, algId);
        shards[shardIndex] = new Uint8Array(await argon2Native(password, {
          salt,
          memoryCost: shardMemoryKb,
          timeCost: BRAINVAULT_V1.ARGON_TIME_COST,
          parallelism: BRAINVAULT_V1.ARGON_PARALLELISM,
          outputLen: BRAINVAULT_V1.SHARD_OUTPUT_BYTES,
          algorithm: 2,
          version: 1,
        }));
        completed += 1;
        onProgress?.(completed);
      }
    }));
    return shards;
  } finally {
    password.fill(0);
  }
}

async function derive(name: string, passphrase: string, work: WorkSpec, workers = 64, options: DeriveOptions = {}) {
  const {
    engine = 'auto',
    shardMultiplier = 1,
    onProgress,
  } = options;

  assertBrainVaultName(name);
  assertBrainVaultPassphrase(passphrase);

  if (!Number.isSafeInteger(work.shardCount) || work.shardCount < 1) {
    throw new Error(`BRAINVAULT_SHARD_COUNT_INVALID:${work.shardCount}`);
  }
  if (!Number.isSafeInteger(workers) || workers < 1) {
    throw new Error(`BRAINVAULT_WORKER_COUNT_INVALID:${workers}`);
  }

  const { shardCount, factor } = work;
  const kdfAlgId = shardMultiplier === 1 ? BRAINVAULT_V1.ALG_ID : `${BRAINVAULT_V1.ALG_ID}|custom`;
  const shardMemoryKb = BRAINVAULT_V1.SHARD_MEMORY_KB * shardMultiplier;

  // Cap workers at shard count (no point having more workers than shards)
  const actualWorkers = Math.min(workers, shardCount);

  const start = Date.now();
  const neonExecutable = resolveNeonExecutable();
  const metalBundle = resolveAcceleratorBundle('metal');
  const autoSelectedMetal = engine === 'auto'
    && isMeasuredM3Ultra()
    && shardMultiplier === 1
    && shardCount >= 1_000
    && neonExecutable !== undefined
    && metalBundle !== undefined;
  const autoSelectedC = engine === 'auto'
    && !autoSelectedMetal
    && shardCount >= 100
    && neonExecutable !== undefined;
  const allowAutoRecovery = autoSelectedC || autoSelectedMetal;
  let selectedEngine: Exclude<EngineSelection, 'auto'> = autoSelectedMetal
    ? 'metal'
    : autoSelectedC ? 'c-neon' : engine === 'auto' ? 'native' : engine;
  if (selectedEngine === 'wasm' && shardMultiplier > MAX_WASM_MULTIPLIER) {
    throw new Error(`BRAINVAULT_ENGINE_MULTIPLIER_UNSUPPORTED:wasm:${shardMultiplier}:wasm32-memory-limit`);
  }
  let shardResults: Uint8Array[] | undefined;
  if (selectedEngine === 'metal' || selectedEngine === 'metal-generic' || selectedEngine === 'opencl') {
    if (shardMultiplier !== 1) {
      throw new Error(`BRAINVAULT_ENGINE_MULTIPLIER_UNSUPPORTED:${selectedEngine}:${shardMultiplier}`);
    }
    const acceleratorBundle = resolveAcceleratorBundle(selectedEngine);
    if (acceleratorBundle === undefined || neonExecutable === undefined) {
      throw new Error(`BRAINVAULT_ACCELERATOR_UNAVAILABLE:${selectedEngine}`);
    }
    const password = new TextEncoder().encode(passphrase.normalize('NFKD'));
    const planned = acceleratorPlan(selectedEngine, shardCount, actualWorkers);
    console.log(
      `Using ${selectedEngine === 'metal' ? 'Metal V1' : selectedEngine === 'metal-generic' ? '(experimental) Metal generic' : '(experimental) OpenCL'} + C/NEON hybrid `
      + `(${planned.acceleratorShards} GPU / ${planned.cpuShards} CPU shards · `
      + `${planned.acceleratorProcesses}×${planned.acceleratorWorkers} GPU / ${planned.cpuWorkers} CPU workers)`,
    );
    let salts: Uint8Array[] = [];
    try {
      salts = await Promise.all(Array.from(
        { length: shardCount },
        (_, index) => createShardSalt(name, index, shardCount, kdfAlgId),
      ));
      const accelerated = await deriveHybridNativeShards({
        engine: selectedEngine,
        password,
        salts,
        memoryKiB: shardMemoryKb,
        requestedCpuWorkers: actualWorkers,
        onProgress,
        paths: {
          packageRoot: import.meta.dir,
          cpuExecutable: neonExecutable,
          acceleratorExecutable: acceleratorBundle.executable,
          metalLibrary: acceleratorBundle.metalLibrary,
          openclKernel: acceleratorBundle.openclKernel,
        },
      });
      shardResults = accelerated.shards;
    } catch (error) {
      if (!autoSelectedMetal) throw error;
      console.warn(`Metal unavailable at runtime; using C/NEON backend (${String(error)}).`);
      onProgress?.(0, shardCount);
      selectedEngine = 'c-neon';
    } finally {
      password.fill(0);
      for (const salt of salts) salt.fill(0);
    }
  }

  if (selectedEngine === 'c-neon' || selectedEngine === 'c-neon-wipe') {
    if (neonExecutable === undefined) throw new Error('BRAINVAULT_C_NEON_UNAVAILABLE');
    console.log(`Using ${selectedEngine === 'c-neon' ? 'C/NEON final wipe' : '(experimental) C/NEON per-shard wipe'} (${actualWorkers} workers)`);
    try {
      shardResults = await deriveExecutableShards(
        neonExecutable,
        name,
        passphrase,
        shardCount,
        actualWorkers,
        selectedEngine === 'c-neon-wipe',
        shardMemoryKb,
        kdfAlgId,
        completed => onProgress?.(completed, shardCount),
      );
    } catch (error) {
      if (!allowAutoRecovery) throw error;
      console.warn(`C/NEON unavailable at runtime; using portable native fallback (${String(error)}).`);
      onProgress?.(0, shardCount);
      selectedEngine = 'native';
    }
  }

  if (selectedEngine === 'rust' || selectedEngine === 'rust-no-wipe') {
    const rustExecutable = resolveRustExecutable(selectedEngine === 'rust-no-wipe');
    if (rustExecutable === undefined) throw new Error(`BRAINVAULT_RUST_UNAVAILABLE:${selectedEngine}`);
    if (selectedEngine === 'rust-no-wipe') {
      console.warn('WARNING: Rust no-wipe is parity/performance mode; sensitive Argon memory is not zeroized.');
    }
    console.log(`Using ${selectedEngine === 'rust' ? '(experimental) Rust secure-wipe pool' : '(experimental) Rust no-wipe pool'} (${actualWorkers} workers)`);
    shardResults = await deriveExecutableShards(
      rustExecutable,
      name,
      passphrase,
      shardCount,
      actualWorkers,
      false,
      shardMemoryKb,
      kdfAlgId,
      completed => onProgress?.(completed, shardCount),
    );
  }

  if (selectedEngine === 'native-direct') {
    console.log(`Using (experimental) native direct async (${actualWorkers} workers)`);
    shardResults = await deriveDirectAsyncShards(
      name,
      passphrase,
      shardCount,
      actualWorkers,
      shardMemoryKb,
      kdfAlgId,
      completed => onProgress?.(completed, shardCount),
    );
  }

  if (shardResults === undefined) {
    const workerShardResults = createShardSlots(shardCount);
    let completed = 0;
    let nextShard = 0;
    let failed = false;
    const workerPath = selectedEngine === 'wasm'
      ? `${import.meta.dir}/worker-wasm.ts`
      : selectedEngine === 'native-sync'
        ? `${import.meta.dir}/experimental/worker-sync.ts`
        : `${import.meta.dir}/worker-native.ts`;
    const pool: Worker[] = [];

    console.log(selectedEngine === 'wasm'
      ? `Using TypeScript/WASM reference (${actualWorkers} workers)`
      : selectedEngine === 'native-sync'
        ? `Using (experimental) native sync workers (${actualWorkers} workers)`
        : `Using native isolated workers (${actualWorkers} workers)`);

    await new Promise<void>((resolve, reject) => {
    const terminatePool = () => Promise.all(pool.map(worker => worker.terminate())).then(() => undefined);
    const fail = (error: unknown) => {
      if (failed) return;
      failed = true;
      const cause = error instanceof Error ? error : new Error(String(error));
      void terminatePool().then(
        () => reject(cause),
        terminationError => reject(new AggregateError([cause, terminationError], 'BrainVault worker failure')),
      );
    };

    for (let i = 0; i < actualWorkers; i++) {
      const w = new Worker(workerPath);
      pool.push(w);

      w.on('error', fail);
      w.on('exit', code => {
        if (!failed && completed < shardCount) {
          fail(new Error(`BRAINVAULT_WORKER_EXITED:${code}`));
        }
      });

      w.on('message', (message) => {
        if (failed) return;
        try {
          acceptShard(
            workerShardResults,
            message,
            BRAINVAULT_V1_SPEC_ID,
            BRAINVAULT_V1.SHARD_OUTPUT_BYTES,
            index => shardRequestFingerprint(index, shardCount, kdfAlgId, shardMemoryKb),
          );
        } catch (error) {
          fail(error);
          return;
        }
        completed++;
        onProgress?.(completed, shardCount);

        if (completed >= shardCount) {
          void terminatePool().then(resolve, reject);
        } else if (nextShard < shardCount) {
          w.postMessage({
            specId: BRAINVAULT_V1_SPEC_ID,
            name,
            passphrase,
            shardIndex: nextShard++,
            shardCount,
            shardMemoryKb,
            algId: kdfAlgId,
          });
        }
      });

      if (nextShard < shardCount) {
        w.postMessage({
          specId: BRAINVAULT_V1_SPEC_ID,
          name,
          passphrase,
          shardIndex: nextShard++,
          shardCount,
          shardMemoryKb,
          algId: kdfAlgId,
        });
      }
    }
    });
    shardResults = finalizeShards(workerShardResults);
  }

  const derivationTime = Date.now() - start;
  let masterKey: Uint8Array;
  try {
    masterKey = await combineShardsWithParams(shardResults, factor, {
      algId: kdfAlgId,
      shardMemoryKb,
    });
  } finally {
    for (const shard of shardResults) shard.fill(0);
  }
  try {
    const fingerprint = rootFingerprint(masterKey);

    // Derive only the first public address before reveal. The root remains in a
    // wipeable buffer; mnemonic/address matrices are projected only after confirmation.
    const entropy24 = await deriveKey(masterKey, 'bip39/entropy/v1.0', 32);
    try {
      const mnemonic24 = await entropyToMnemonic(entropy24);
      const ethAddr24 = await deriveEthereumAddress(mnemonic24);
      return {
        name, shardCount, factor, workers, engine: selectedEngine, derivationTime, shardMultiplier,
        fingerprint, ethAddr24, rootKey: masterKey,
      };
    } finally {
      entropy24.fill(0);
    }
  } catch (error) {
    masterKey.fill(0);
    throw error;
  }
}

async function deriveSensitiveMaterial(rootKey: Uint8Array, count: number, includePrivateKeys: boolean) {
  let entropy24: Uint8Array | undefined;
  let entropy12: Uint8Array | undefined;
  try {
    entropy24 = await deriveKey(rootKey, 'bip39/entropy/v1.0', 32);
    entropy12 = await deriveKey(rootKey, 'bip39/entropy-128/v1.0', 16);
    const mnemonic24 = await entropyToMnemonic(entropy24);
    const mnemonic12 = await entropyToMnemonic(entropy12);
    const matrix24 = await deriveEthereumAddressMatrix(mnemonic24, '', count);
    const matrix12 = await deriveEthereumAddressMatrix(mnemonic12, '', count);
    return {
      mnemonic24,
      mnemonic12,
      standardAddrs24: matrix24.standard,
      ledgerLiveAddrs24: matrix24.ledgerLive,
      standardAddrs12: matrix12.standard,
      ledgerLiveAddrs12: matrix12.ledgerLive,
      privateKey24: includePrivateKeys
        ? await deriveEthereumPrivateKeyAtPath(mnemonic24, "m/44'/60'/0'/0/0")
        : undefined,
      privateKey12: includePrivateKeys
        ? await deriveEthereumPrivateKeyAtPath(mnemonic12, "m/44'/60'/0'/0/0")
        : undefined,
    };
  } finally {
    entropy24?.fill(0);
    entropy12?.fill(0);
  }
}


// ============================================================================
// BENCHMARK
// ============================================================================

async function runBenchmark(smoke = false) {
  const configuredShardCount = inlineLevel !== undefined
    ? workFromLevel(inlineLevel).shardCount
    : inlineFactor !== undefined
      ? getShardCount(inlineFactor)
      : inlineShards ?? 1_000;
  const shardCount = smoke ? 2 : configuredShardCount;
  const benchmarkMultiplier = smoke ? 1 : shardMultiplier;
  const benchmarkPlan = getHardwarePlan(shardCount, benchmarkMultiplier);
  const defaultWorkers = Math.min(32, benchmarkPlan.recommendedWorkers);
  const workers = inlineWorkers ?? defaultWorkers;
  if (Math.min(workers, shardCount) > benchmarkPlan.recommendedWorkers) {
    throw new Error(`BRAINVAULT_WORKERS_EXCEED_MEMORY_LIMIT:${workers}:${benchmarkPlan.recommendedWorkers}`);
  }
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 32) {
    throw new Error(`Benchmark workers must be an integer in 1..32: ${String(workers)}`);
  }

  const benchmarkPath = `${import.meta.dir}/experimental/benchmark.ts`;
  if (!existsSync(benchmarkPath)) throw new Error('BRAINVAULT_BENCHMARK_HARNESS_MISSING');

  type BenchmarkBackend = Readonly<{
    id: string;
    label: string;
    executable?: string;
    maxMultiplier: number;
  }>;
  const benchmarkNeonExecutable = resolveNeonExecutable();
  const candidates: BenchmarkBackend[] = [
    {
      id: 'metal-v1',
      label: 'Metal V1 + C/NEON hybrid',
      executable: resolveAcceleratorBundle('metal')?.executable ?? '__unavailable__',
      maxMultiplier: 1,
    },
    {
      id: 'metal-generic',
      label: '(experimental) Metal generic + C/NEON hybrid',
      executable: resolveAcceleratorBundle('metal-generic')?.executable ?? '__unavailable__',
      maxMultiplier: 1,
    },
    {
      id: 'opencl',
      label: '(experimental) OpenCL + C/NEON hybrid',
      executable: resolveAcceleratorBundle('opencl')?.executable ?? '__unavailable__',
      maxMultiplier: 1,
    },
    {
      id: 'c-neon',
      label: 'C/NEON final wipe',
      executable: benchmarkNeonExecutable ?? '__unavailable__',
      maxMultiplier: Number.MAX_SAFE_INTEGER,
    },
    {
      id: 'c-neon-wipe',
      label: '(experimental) C/NEON per-shard wipe',
      executable: benchmarkNeonExecutable ?? '__unavailable__',
      maxMultiplier: Number.MAX_SAFE_INTEGER,
    },
    { id: 'direct-async', label: '(experimental) Native direct async', maxMultiplier: Number.MAX_SAFE_INTEGER },
    { id: 'sync', label: '(experimental) Native sync workers', maxMultiplier: Number.MAX_SAFE_INTEGER },
    { id: 'baseline', label: 'Native isolated workers', maxMultiplier: Number.MAX_SAFE_INTEGER },
    {
      id: 'rust-pool',
      label: '(experimental) Rust pool secure',
      executable: resolveRustExecutable(false) ?? '__unavailable__',
      maxMultiplier: Number.MAX_SAFE_INTEGER,
    },
    {
      id: 'rust-pool-no-wipe',
      label: '(experimental) Rust pool no wipe',
      executable: resolveRustExecutable(true) ?? '__unavailable__',
      maxMultiplier: Number.MAX_SAFE_INTEGER,
    },
    { id: 'wasm', label: 'TypeScript/WASM', maxMultiplier: MAX_WASM_MULTIPLIER },
  ];
  const engineBackend: string | undefined = ({
    metal: 'metal-v1',
    'metal-generic': 'metal-generic',
    opencl: 'opencl',
    'c-neon': 'c-neon',
    'c-neon-wipe': 'c-neon-wipe',
    'native-direct': 'direct-async',
    'native-sync': 'sync',
    native: 'baseline',
    rust: 'rust-pool',
    'rust-no-wipe': 'rust-pool-no-wipe',
    wasm: 'wasm',
    auto: undefined,
  } satisfies Record<EngineSelection, string | undefined>)[flagEngine];
  const available = candidates.filter(candidate => (
    (candidate.executable === undefined || existsSync(candidate.executable))
    && benchmarkMultiplier <= candidate.maxMultiplier
    && (engineBackend === undefined || candidate.id === engineBackend)
  ));
  const skippedFixed = candidates.filter(candidate => (
    benchmarkMultiplier > candidate.maxMultiplier
    && (candidate.executable === undefined || existsSync(candidate.executable))
    && (engineBackend === undefined || candidate.id === engineBackend)
  ));
  if (skippedFixed.length > 0) {
    console.log(`Skipping engines beyond their address-space limit for multiplier ${benchmarkMultiplier}: ${skippedFixed.map(item => item.label).join(', ')}`);
  }
  if (available.length === 0) {
    throw new Error(`BRAINVAULT_ENGINE_MULTIPLIER_UNSUPPORTED:${flagEngine}:${benchmarkMultiplier}`);
  }
  const estimatedSeconds = smoke || shardCount <= 2
    ? 'a few seconds'
    : available.length <= 4 ? 'about 30 seconds' : 'about one minute';
  console.log(smoke ? 'BrainVault backend smoke test' : 'BrainVault canonical backend benchmark');
  console.log(`${shardCount.toLocaleString('en-US')} shards | factor ${factorForShardCount(shardCount)} | multiplier ${benchmarkMultiplier} | ${workers} workers`);
  console.log(`Running ${available.length} engines sequentially; expected duration: ${estimatedSeconds}.\n`);

  type BenchmarkResult = Readonly<{
    backend: string;
    label: string;
    derivationTimeMs: number;
    shardsPerSecond: number;
    root: string;
  }>;
  const results: BenchmarkResult[] = [];

  for (const [index, candidate] of available.entries()) {
    process.stdout.write(`[${index + 1}/${available.length}] ${candidate.label}... `);
    const child = spawnSync(process.execPath, [
      benchmarkPath,
      `--backend=${candidate.id}`,
      `--shards=${shardCount}`,
      `--workers=${workers}`,
      `--multiplier=${benchmarkMultiplier}`,
    ], {
      cwd: import.meta.dir,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, UV_THREADPOOL_SIZE: String(workers) },
    });
    if (child.status !== 0) {
      console.log('FAILED');
      const details = child.stderr.trim() || child.stdout.trim() || `exit ${String(child.status)}`;
      throw new Error(`BRAINVAULT_BENCHMARK_ENGINE_FAILED:${candidate.id}:${details}`);
    }
    const parsed = JSON.parse(child.stdout) as {
      backend?: unknown;
      specId?: unknown;
      shardCount?: unknown;
      factor?: unknown;
      workers?: unknown;
      multiplier?: unknown;
      derivationTimeMs?: unknown;
      shardsPerSecond?: unknown;
      root?: unknown;
    };
    if (
      parsed.backend !== candidate.id
      || parsed.specId !== BRAINVAULT_V1_SPEC_ID
      || parsed.shardCount !== shardCount
      || parsed.factor !== factorForShardCount(shardCount)
      || parsed.workers !== Math.min(workers, shardCount)
      || parsed.multiplier !== benchmarkMultiplier
      || typeof parsed.derivationTimeMs !== 'number' || !Number.isFinite(parsed.derivationTimeMs) || parsed.derivationTimeMs <= 0
      || typeof parsed.shardsPerSecond !== 'number' || !Number.isFinite(parsed.shardsPerSecond) || parsed.shardsPerSecond <= 0
      || typeof parsed.root !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.root)
    ) {
      console.log('FAILED');
      throw new Error(`BRAINVAULT_BENCHMARK_RESULT_INVALID:${candidate.id}`);
    }
    results.push({
      backend: parsed.backend,
      label: candidate.label,
      derivationTimeMs: parsed.derivationTimeMs,
      shardsPerSecond: parsed.shardsPerSecond,
      root: parsed.root,
    });
    console.log(`${(parsed.derivationTimeMs / 1000).toFixed(3)}s`);
  }

  if (results.length === 0) throw new Error('BRAINVAULT_BENCHMARK_ALL_ENGINES_FAILED');
  const roots = new Set(results.map(result => result.root));
  if (roots.size !== 1) {
    throw new Error(`BRAINVAULT_BENCHMARK_ROOT_MISMATCH:${[...roots].join(':')}`);
  }
  const sorted = [...results].sort((left, right) => left.derivationTimeMs - right.derivationTimeMs);
  const fastest = sorted[0]!.derivationTimeMs;
  const labelWidth = Math.max('Engine'.length, ...sorted.map(result => result.label.length));
  console.log('\nResults (fastest first)');
  console.log(`${'Engine'.padEnd(labelWidth)}  Time      Shards/s  Root[0..4]  vs fastest`);
  console.log(`${'-'.repeat(labelWidth)}  --------  --------  ----------  ----------`);
  for (const result of sorted) {
    console.log(
      `${result.label.padEnd(labelWidth)}  ${(result.derivationTimeMs / 1000).toFixed(3).padStart(7)}s  `
      + `${result.shardsPerSecond.toFixed(2).padStart(8)}  ${result.root.slice(0, 8).padStart(10)}  `
      + `${(result.derivationTimeMs / fastest).toFixed(2).padStart(8)}x`,
    );
  }
  if (results.length >= 2) {
    console.log(`\nRoot parity: PASS (${results[0]!.root})`);
  } else {
    const matrix = await Bun.file(`${import.meta.dir}/matrix-v1.json`).json() as { roots?: Record<string, string> };
    const expected = matrix.roots?.[`s${shardCount}-m${benchmarkMultiplier}`]
      ?? (shardCount === workers ? matrix.roots?.[`w${workers}-m${benchmarkMultiplier}`] : undefined);
    if (expected !== undefined && results[0]!.root !== expected) {
      throw new Error(`BRAINVAULT_FROZEN_ROOT_MISMATCH:${results[0]!.root}:${expected}`);
    }
    console.log(expected === undefined
      ? `\nSingle-engine root (not a parity check): ${results[0]!.root}`
      : `\nFrozen root check: PASS (${results[0]!.root})`);
  }
}

// ============================================================================
// INTERACTIVE MODE
// ============================================================================

async function interactive() {
  const promptOutput = new PromptOutput();
  let rl = readline.createInterface({ input: stdin, output: promptOutput, terminal: true });

  printBrand();
  console.log('\nHuman passwords have limited entropy.');
  console.log('Work settings raise the cost of each guess; they cannot make a weak');
  console.log('or reused password safe.');
  console.log('BrainVault writes no recovery file.');
  console.log('Remember the exact Username, Password, Shard count, and Multiplier.');
  console.log('Forget any recovery input and the wallet cannot be recovered.');
  console.log('Before funding, repeat a fresh run and verify the same first receiving address.\n');
  printVisibleInputWarning();
  if (shardMultiplier > 1) {
    const memoryPerShardGb = (BRAINVAULT_V1.SHARD_MEMORY_KB * shardMultiplier) / (1024 * 1024);
    console.log(`CUSTOM MODE: multiplier=${shardMultiplier} (${memoryPerShardGb.toFixed(2)} GiB per shard)\n`);
  }

  printStep(1, 'IDENTITY');
  const name = await rl.question('Username: ');
  if (requireRepeat) {
    const nameRepeat = await rl.question('Repeat Username: ');
    if (name !== nameRepeat) {
      rejectPrompt(rl, 'Username entries do not match');
      return;
    }
  }

  let pass: string;
  if (suggestPassword) {
    pass = generateSuggestedPassword();
    console.log(`\nGenerated recovery password · ${SUGGESTED_PASSWORD_CHARACTERS} random a-z/A-Z/0-9 characters`);
    console.log(`${SUGGESTED_PASSWORD_BITS.toFixed(2)} bits while undisclosed:`);
    console.log(pass);
    console.log('BrainVault does not save it, but terminal scrollback may.');
    console.log('This repeat checks transcription only; test a fresh recovery before funding.');
    const passRepeat = await askPasswordInput(
      rl,
      promptOutput,
      'Repeat generated password (hidden; typing works): ',
      'Repeat generated password (VISIBLE): ',
    );
    if (pass !== passRepeat) {
      rejectPrompt(rl, 'Suggested password was not repeated exactly');
      return;
    }
  } else {
    pass = await askPasswordInput(
      rl,
      promptOutput,
      'Password (hidden; typing works): ',
      'Password (VISIBLE): ',
    );
  }
  if (requireRepeat && !suggestPassword) {
    const passRepeat = await askPasswordInput(
      rl,
      promptOutput,
      'Repeat Password (hidden; typing works): ',
      'Repeat Password (VISIBLE): ',
    );
    if (pass !== passRepeat) {
      rejectPrompt(rl, 'Password entries do not match');
      return;
    }
  }

  if (!name) {
    rejectPrompt(rl, 'Username cannot be empty');
    return;
  }
  const passwordError = getCliPasswordError(pass);
  if (passwordError !== undefined) {
    rejectPrompt(rl, passwordError);
    return;
  }
  const characterError = getCliCreationCharacterError(name, pass);
  if (characterError !== undefined) {
    rejectPrompt(rl, characterError);
    return;
  }

  let selectedWork = inlineLevel !== undefined
    ? workFromLevel(inlineLevel)
    : inlineFactor !== undefined
      ? workFromLegacyFactor(inlineFactor)
      : inlineShards !== undefined
        ? workFromExactShards(inlineShards)
        : workFromLevel(BRAINVAULT_DEFAULT_LEVEL);
  let selectedMultiplier = shardMultiplier;
  let selectedEngine = flagEngine;

  printStep(2, 'WORK SETTINGS');
  if (askAdvanced) {
    if (inlineLevel === undefined && inlineFactor === undefined && inlineShards === undefined) {
      console.log('Use --shards N for an exact recovery count or --factor N for a legacy factor.\n');
      console.log('Work presets change guess cost; they are not password-security ratings.');
      const levelOptions = BRAINVAULT_LEVEL_SHARDS.map((shards, index) => {
        const suffix = index <= 1
          ? ' | DO NOT FUND'
          : index === 2
            ? ' | reduced work'
            : index === BRAINVAULT_DEFAULT_LEVEL - 1
              ? ' | recommended default'
              : '';
        return `${index + 1}. ${BRAINVAULT_LEVEL_NAMES[index]!.padEnd(8)} | ${shards.toLocaleString('en-US').padStart(9)} shards${suffix}`;
      });
      rl.close();
      const selectedIndex = await selectOption('work level', levelOptions, BRAINVAULT_DEFAULT_LEVEL - 1);
      selectedWork = workFromLevel(selectedIndex + 1);
      rl = readline.createInterface({ input: stdin, output: promptOutput, terminal: true });
    }

    if (shardMultiplierFlag === undefined) {
      const initialPlan = getHardwarePlan(selectedWork.shardCount, 1);
      console.log(`\nRecommended multiplier: 1 (portable frozen default).`);
      if (initialPlan.strongerMultiplier > 1) {
        const ultraWorkingSetGb = 0.25 * initialPlan.strongerMultiplier * initialPlan.cpuCores;
        console.log(`Ultra memory-hard option: multiplier ${initialPlan.strongerMultiplier} (${(0.25 * initialPlan.strongerMultiplier).toFixed(2)} GiB per worker; ${ultraWorkingSetGb.toFixed(0)} GiB at ${initialPlan.cpuCores} workers).`);
        console.log(`This is stronger but slower; multiplier ${initialPlan.upperMultiplier} is the 50% RAM ceiling, not a recommendation.`);
      }
      console.log('Warning: any multiplier other than 1 changes the root and must be remembered for recovery.');
      selectedMultiplier = Number((await rl.question('Shard multiplier (1): ')).trim() || '1');
      if (!Number.isSafeInteger(selectedMultiplier) || selectedMultiplier < 1) {
        rejectPrompt(rl, 'multiplier must be a positive integer');
        return;
      }
    }

    if (selectedEngine === 'auto') {
      const engineChoices = getInteractiveEngineChoices(selectedMultiplier);
      console.log('\nAvailable engines (same tested root; reference measurement on one M3 Ultra, so your speed will differ):');
      const engineOptions = engineChoices.map((choice, index) => {
        const warning = choice.warning === undefined ? '' : ` | WARNING: ${choice.warning}`;
        return `${index + 1}. ${choice.label} | ${choice.referenceRate.toFixed(2)} shards/s${warning}`;
      });
      rl.close();
      const engineIndex = await selectOption('engine', engineOptions);
      selectedEngine = engineChoices[engineIndex]!.id;
      rl = readline.createInterface({ input: stdin, output: promptOutput, terminal: true });
    }
  }

  const shardCount = selectedWork.shardCount;
  const plan = getHardwarePlan(shardCount, selectedMultiplier);
  let workersInput = inlineWorkers ?? plan.recommendedWorkers;
  if (askAdvanced) {
    console.log(`\nCPU cores detected: ${plan.cpuCores}`);
    console.log(`System RAM: ${plan.totalGB} GiB; ${plan.memoryPerWorkerGb.toFixed(2)} GiB per worker`);
    console.log(`Recommended workers: ${plan.recommendedWorkers}\n`);
    if (inlineWorkers === undefined) {
      workersInput = Number((await rl.question(`Parallel workers (${plan.recommendedWorkers}): `)).trim() || `${plan.recommendedWorkers}`);
    } else {
      console.log(`Inline workers: ${workersInput}`);
    }
  } else {
    const level = selectedWork.level === undefined ? 'custom' : `${selectedWork.level} ${BRAINVAULT_LEVEL_NAMES[selectedWork.level - 1]}`;
    console.log(`\n${level}  ·  ${shardCount.toLocaleString('en-US')} shards  ·  multiplier ${selectedMultiplier}  ·  ${workersInput} workers`);
    const usingRecommendedDefaults = inlineLevel === undefined
      && inlineFactor === undefined
      && inlineShards === undefined
      && shardMultiplierFlag === undefined
      && inlineWorkers === undefined
      && flagEngine === 'auto';
    console.log(usingRecommendedDefaults
      ? 'Recommended defaults · use --ask for advanced setup.'
      : 'Selected settings · engine and worker count affect speed only.');
  }
  if (!Number.isSafeInteger(workersInput) || workersInput < 1) {
    rejectPrompt(rl, 'workers must be a positive integer');
    return;
  }
  if (workersInput > plan.recommendedWorkers) {
    rejectPrompt(rl, `workers exceed the safe hardware limit (${plan.recommendedWorkers}) for this shard count/multiplier.`);
    return;
  }

  rl.close();

  console.log(`\n${shardCount.toLocaleString('en-US')} shards × ${workersInput} workers`);
  console.log(recoveryRuleText(shardCount, selectedMultiplier));
  console.log('Engine and worker count affect speed only; they are not recovery inputs.');
  console.log(`Addresses: ${addressCount} standard + ${addressCount} Ledger Live`);
  printStep(3, 'DERIVE');

  let rootKey: Uint8Array | undefined;
  const progress = startDerivationProgress(shardCount, workersInput);
  try {
    const result = await derive(name, pass, selectedWork, workersInput, {
      engine: selectedEngine,
      shardMultiplier: selectedMultiplier,
      onProgress: completed => progress.update(completed),
    });
    rootKey = result.rootKey;
    progress.complete(result.derivationTime);

    console.log('\n╭─ PUBLIC RESULT · no private material shown');
    console.log(`│ Wallet fingerprint:       ${result.fingerprint}  (quick visual check)`);
    console.log(`│ First receiving address:  ${result.ethAddr24}`);
    console.log('│ 24-word primary · authoritative recovery check');
    console.log('╰─ The address is public, but may still be privacy-sensitive.');

    if (!canUseSensitiveScreen()) {
      console.log('\nRecovery words unavailable: this terminal cannot safely isolate the sensitive view.');
      return;
    }

    const revealOutput = new PromptOutput();
    const revealRl = readline.createInterface({ input: stdin, output: revealOutput, terminal: true });
    const confirmation = await askPasswordInput(
      revealRl,
      revealOutput,
      '\nRe-enter password to show recovery words (hidden; typing works), or press Enter to exit: ',
      '\nRe-enter password to show recovery words (VISIBLE), or press Enter to exit: ',
    );
    revealRl.close();
    if (confirmation === '') {
      return;
    }
    if (confirmation !== pass) {
      console.error('Password did not match. Nothing was revealed.');
      process.exitCode = 1;
      return;
    }

    const sensitive = await deriveSensitiveMaterial(result.rootKey, addressCount, showPrivateKey);
    openSensitiveScreen();
    try {
      console.log('RECOVERY WORDS · SECRET');
      console.log('Anyone who sees these words can spend the wallet funds.');
      console.log('This view clears on Enter or Ctrl+C; recordings, terminal logs, and photographs cannot be erased.');
      console.log('\nPRIMARY WALLET · 24 words · matches the public first receiving address:');
      console.log(sensitive.mnemonic24);
      for (let i = 0; i < sensitive.standardAddrs24.length; i++) console.log(`Address ${i + 1}:`, sensitive.standardAddrs24[i]);
      for (let i = 0; i < sensitive.ledgerLiveAddrs24.length; i++) console.log(`Ledger Live ${i + 1}:`, sensitive.ledgerLiveAddrs24[i]);
      if (sensitive.privateKey24) console.log('Private Key 1:', sensitive.privateKey24);

      console.log('\nSECONDARY WALLET · 12 words · separate wallet and addresses:');
      console.log(sensitive.mnemonic12);
      for (let i = 0; i < sensitive.standardAddrs12.length; i++) console.log(`Address ${i + 1}:`, sensitive.standardAddrs12[i]);
      for (let i = 0; i < sensitive.ledgerLiveAddrs12.length; i++) console.log(`Ledger Live ${i + 1}:`, sensitive.ledgerLiveAddrs12[i]);
      if (sensitive.privateKey12) console.log('Private Key 1:', sensitive.privateKey12);

      const dismissRl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
      try {
        await dismissRl.question('\nPress Enter to clear and exit: ');
      } finally {
        dismissRl.close();
      }
    } finally {
      eraseSensitiveScreen();
    }
    console.log('Sensitive view erased. The privacy-sensitive public address remains above.');
  } catch (err) {
    progress.stop();
    if (isUserCancellation(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Derivation failed: ${message}`);
    process.exitCode = 1;
  } finally {
    rootKey?.fill(0);
  }
}

// ============================================================================
// PASSWORD MANAGER
// ============================================================================

async function derivePassword() {
  const promptOutput = new PromptOutput();
  const rl = readline.createInterface({ input: stdin, output: promptOutput, terminal: true });
  let confirmationRl: readline.Interface | undefined;
  let rlPassword: readline.Interface | undefined;
  let rootKey: Uint8Array | undefined;

  try {

  printBrand();
  console.log('\nPASSWORD MODE\n');
  printVisibleInputWarning();
  const name = await rl.question('Username: ');
  const pass = await askPasswordInput(
    rl,
    promptOutput,
    'Password (hidden; typing works): ',
    'Password (VISIBLE): ',
  );
  const selectedLevel = Number((await rl.question(`Level (${BRAINVAULT_DEFAULT_LEVEL}): `)).trim() || `${BRAINVAULT_DEFAULT_LEVEL}`);

  const passwordError = getCliPasswordError(pass);
  if (passwordError !== undefined) {
    rejectPrompt(rl, passwordError);
    return;
  }
  const characterError = getCliCreationCharacterError(name, pass);
  if (characterError !== undefined) {
    rejectPrompt(rl, characterError);
    return;
  }

  if (!Number.isSafeInteger(selectedLevel) || selectedLevel < 1 || selectedLevel > BRAINVAULT_LEVEL_SHARDS.length) {
    rejectPrompt(rl, `level must be an integer in 1..${BRAINVAULT_LEVEL_SHARDS.length}`);
    return;
  }

  rl.close();

  const selectedWork = workFromLevel(selectedLevel);
  const workers = getHardwarePlan(selectedWork.shardCount, shardMultiplier).recommendedWorkers;
  const progress = startDerivationProgress(selectedWork.shardCount, workers);
  let result: Awaited<ReturnType<typeof derive>>;
  try {
    result = await derive(name, pass, selectedWork, workers, {
      engine: flagEngine,
      shardMultiplier,
      onProgress: completed => progress.update(completed),
    });
    progress.complete(result.derivationTime);
  } catch (error) {
    progress.stop();
    throw error;
  }
  rootKey = result.rootKey;

  console.log('\n[OK] Master key ready\n');

  confirmationRl = readline.createInterface({ input: stdin, output: promptOutput, terminal: true });
  const confirmation = await askPasswordInput(
    confirmationRl,
    promptOutput,
    'Re-enter password to enable site-password output (hidden; typing works): ',
    'Re-enter password to enable site-password output (VISIBLE): ',
  );
  confirmationRl.close();
  if (confirmation !== pass) {
    console.error('Password did not match. No site password was revealed.');
    process.exitCode = 1;
    return;
  }

  rlPassword = readline.createInterface({ input: stdin, output: process.stdout });

  while (true) {
    const domain = await rlPassword.question('Domain (or Enter to exit): ');
    if (!domain) break;

    const sitePass = await deriveSitePassword(result.rootKey, domain);
    openSensitiveScreen();
    try {
      console.log('SITE PASSWORD · SECRET');
      console.log('This view clears on Enter or Ctrl+C; recordings, terminal logs, and photographs cannot be erased.');
      console.log(`\n${domain}: ${sitePass}`);
      await rlPassword.question('\nPress Enter to clear and continue: ');
    } finally {
      eraseSensitiveScreen();
    }
  }

  } finally {
    rl.close();
    confirmationRl?.close();
    rlPassword?.close();
    rootKey?.fill(0);
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  if (args.includes('--bench') || args.includes('--smoke')) {
    if (suggestPassword) throw new Error('BRAINVAULT_SUGGEST_PASSWORD_INTERACTIVE_ONLY');
    await runBenchmark(args.includes('--smoke'));
  } else if (args.includes('--password')) {
    if (suggestPassword) throw new Error('BRAINVAULT_SUGGEST_PASSWORD_INTERACTIVE_ONLY');
    if (!canUseSensitiveScreen()) {
      throw new Error('BRAINVAULT_PASSWORD_MODE_TERMINAL_REQUIRED: site passwords require alternate-screen support');
    }
    await derivePassword();
  } else {
    await interactive();
  }
}

try {
  await main();
} catch (error) {
  if (isUserCancellation(error)) {
    console.log('\nExited.');
    process.exitCode = 130;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env bun
/**
 * BrainVault CLI - Production wallet derivation
 *
 * Usage:
 *   bun ./brainvault                            # Interactive from this package
 *   bun test tests/core.test.ts                 # Run deterministic tests
 *   bun ./brainvault --bench                    # Benchmark performance
 *   bun ./brainvault --smoke                    # Fast 2-shard backend parity check
 *   bun ./brainvault --lib=wasm                 # Force hash-wasm (slower, parity check)
 *   bun ./brainvault --lib=native               # Force portable @node-rs/argon2
 *   bun ./brainvault --lib=neon                 # Force bundled Apple Silicon C/NEON
 *   bun ./brainvault --engine=metal             # Force the Apple Metal hybrid
 *   bun ./brainvault --ask                      # Ask for factor, multiplier, and workers
 *   bun ./brainvault --allow-short-password     # Legacy recovery only: allow fewer than 8 chars
 *   bun ./brainvault --repeat                   # Interactive: require double entry for name/pass
 *   bun ./brainvault --show-password            # Echo password input (unsafe on shared screens)
 *   bun ./brainvault --promo                    # Optional recording intro/outro cards
 *   bun ./brainvault --shard-multiplier=4       # Custom KDF mode: 256 MiB * multiplier per shard
 *   bun ./brainvault --address-count=5          # Number of standard + ledger-live addresses
 *   bun ./brainvault --show-private-key         # Also reveal raw key for Address 1 (highest risk)
 *   bun ./brainvault --help                     # Show usage/help
 */

import { stdin, stdout } from 'process';
import { cpus, totalmem } from 'os';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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
} from '../core/index.ts';
import {
  assertBrainVaultName,
  assertBrainVaultPassphrase,
  BRAINVAULT_MAX_SHARD_COUNT,
  shardRequestFingerprint,
} from '../core/primitives/spec.ts';
import { copyAndWipe } from '../core/primitives/encoding.ts';
import { acceptShard, createShardSlots, finalizeShards } from '../native/shard-collector.ts';
import {
  cliCreationCharacterError, cliDomainError, cliPasswordError, cliProgressStatusLine,
  fitTerminal, publicErrorCode, publicErrorMessage,
} from './policy.ts';
import { verifyBundledExecutable } from '../packaging/binary-integrity.ts';
import { acceleratorPlan, deriveHybridNativeShards, type AcceleratorEngine } from '../native/hybrid.ts';
import { BRAINVAULT_NATIVE_PROGRESS_ENV, readNativeProgress } from '../native/progress.ts';
import {
  nativeChildEnvironment, readNativeOutput, terminateNativeChildGroup,
  terminateNativeChildren, trackNativeChild,
} from '../native/children.ts';
import {
  BRAINVAULT_DEFAULT_LEVEL,
  BRAINVAULT_LEVEL_NAMES,
  BRAINVAULT_LEVEL_SHARDS,
  BRAINVAULT_PRIMARY_LEVELS,
  getShardCountForLevel,
} from './presets.ts';
import {
  generateSuggestedPassword,
  SUGGESTED_PASSWORD_BITS,
  SUGGESTED_PASSWORD_CHARACTERS,
} from './suggestion.ts';

const PACKAGE_ROOT = resolve(import.meta.dir, '../..');

const args = process.argv.slice(2);
const BOOLEAN_FLAGS = new Set([
  '--help', '-h', '--bench', '--smoke', '--password', '--ask', '--repeat',
  '--show-private-key', '--reveal', '--allow-short-password',
  '--suggest-password', '--unicode-recovery', '--show-password', '--promo',
]);
const VALUE_FLAGS = new Set([
  '--level', '--shards', '--factor', '--multiplier', '--shard-multiplier',
  '--workers', '--w', '--engine', '--address-count',
]);
const VALUE_FLAG_GROUPS = new Map([
  ['--level', 'level'],
  ['--shards', 'shards'],
  ['--factor', 'factor'],
  ['--multiplier', 'multiplier'],
  ['--shard-multiplier', 'multiplier'],
  ['--workers', 'workers'],
  ['--w', 'workers'],
  ['--engine', 'engine'],
  ['--address-count', 'address-count'],
]);
const LEGACY_ENGINE_FLAGS = new Set(['--lib=wasm', '--lib=native', '--lib=neon']);

function rejectUnsafeArgv(): never {
  console.error('Error: unsupported or secret-bearing argv. Passwords are accepted only through interactive input.');
  process.exit(1);
}

function rejectDuplicateArgv(): never {
  console.error('Error: duplicate CLI options are refused; provide each setting once.');
  process.exit(1);
}

function validateArgv(argv: readonly string[]): void {
  const seenValueGroups = new Set<string>();
  const acceptValueFlag = (flag: string): void => {
    const group = VALUE_FLAG_GROUPS.get(flag);
    if (group === undefined) rejectUnsafeArgv();
    if (seenValueGroups.has(group)) rejectDuplicateArgv();
    seenValueGroups.add(group);
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (/^--(?:unsafe-password|passphrase|pass|secret)(?:=|$)/.test(argument)
      || argument.startsWith('--password=')) rejectUnsafeArgv();
    if (BOOLEAN_FLAGS.has(argument)) continue;
    if (LEGACY_ENGINE_FLAGS.has(argument)) {
      acceptValueFlag('--engine');
      continue;
    }
    const equals = argument.indexOf('=');
    if (equals !== -1) {
      const flag = argument.slice(0, equals);
      if (!VALUE_FLAGS.has(flag) || equals === argument.length - 1) rejectUnsafeArgv();
      acceptValueFlag(flag);
      continue;
    }
    if (VALUE_FLAGS.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) rejectUnsafeArgv();
      acceptValueFlag(argument);
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

function terminalRows(): number {
  const environmentRows = Number(process.env.LINES);
  const reported = Number.isSafeInteger(stdout.rows) && (stdout.rows ?? 0) >= 10
    ? stdout.rows!
    : 24;
  return Number.isSafeInteger(environmentRows) && environmentRows >= 10
    ? Math.min(reported, environmentRows)
    : reported;
}

function supportsCursorControl(): boolean {
  const term = process.env.TERM?.trim().toLowerCase();
  return stdout.isTTY === true
    && term !== undefined
    && term !== ''
    && term !== 'dumb'
    && term !== 'unknown';
}

function supportsAlternateScreen(): boolean {
  const term = process.env.TERM?.trim().toLowerCase();
  return term !== undefined
    && /^(?:xterm(?:[-.].*)?|screen(?:[-.].*)?|tmux(?:[-.].*)?|alacritty|foot(?:[-.].*)?|st(?:[-.].*)?)$/.test(term);
}

function hasReliableSensitiveGeometry(): boolean {
  return Number.isSafeInteger(stdout.columns) && (stdout.columns ?? 0) >= 40
    && Number.isSafeInteger(stdout.rows) && (stdout.rows ?? 0) >= 14
    && terminalColumns() >= 40
    && terminalRows() >= 14;
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

// readline history can re-echo a muted answer at a later prompt via Up-arrow.
function createPrivateReadline(output: Writable): readline.Interface {
  return readline.createInterface({ input: stdin, output, terminal: true, historySize: 0 });
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

async function showPromoScreen(outro = false): Promise<void> {
  if (!stdout.isTTY) throw new Error('BRAINVAULT_PROMO_TERMINAL_REQUIRED');
  const color = process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
  const cyan = color ? '\x1b[38;5;45m' : '';
  const warning = color ? '\x1b[38;5;214m' : '';
  const bold = color ? '\x1b[1m' : '';
  const dim = color ? '\x1b[2m' : '';
  const reset = color ? '\x1b[0m' : '';
  const columns = terminalColumns();
  const innerWidth = Math.min(52, columns - 2);
  const indent = ' '.repeat(Math.min(6, Math.max(0, Math.floor((columns - innerWidth - 2) / 2))));
  const border = (left: string, right: string): string =>
    `${indent}${cyan}${left}${'─'.repeat(innerWidth)}${right}${reset}`;
  const row = (text: string): string =>
    `${indent}${cyan}│${reset} ${fitTerminal(text, innerWidth - 2).padEnd(innerWidth - 2)} ${cyan}│${reset}`;
  const centered = (text: string): string => {
    const fitted = fitTerminal(text, columns);
    return `${' '.repeat(Math.max(0, Math.floor((columns - fitted.length) / 2)))}${fitted}`;
  };
  stdout.write('\x1b[2J\x1b[H\n\n');
  console.log(border('╭', '╮'));
  console.log(row(outro ? 'no account · no seed file · no cloud' : 'brainvault v1'));
  console.log(row(outro ? 'open source · auditable · deterministic' : 'memory-hard deterministic wallet'));
  if (!outro) console.log(row('same exact inputs → same wallet'));
  console.log(border('╰', '╯'));
  if (!outro) console.log(`\n${dim}${centered('remember. derive. recover.')}${reset}`);
  console.log(`\n${bold}${cyan}${centered('brainvault.sh')}${reset}`);
  console.log(`\n${warning}${centered('demo wallet · never fund addresses shown')}${reset}`);
  await new Promise(resolve => setTimeout(resolve, outro ? 4_000 : 3_000));
  stdout.write('\x1b[2J\x1b[H');
}

function startDerivationProgress(shards: number, workers: number): Readonly<{
  update: (completed: number) => void;
  notice: (message: string, warning?: boolean) => void;
  complete: (elapsedMs: number) => void;
  stop: () => void;
}> {
  if (!stdout.isTTY || !supportsCursorControl()) return {
    update: () => {},
    notice: (message, warning = false) => (warning ? console.warn(message) : console.log(message)),
    complete: elapsedMs => console.log(`Derived ${shards.toLocaleString('en-US')} shards in ${formatDuration(elapsedMs)}.`),
    stop: () => {},
  };
  const columns = terminalColumns();
  const compact = columns < 72;
  const width = 40;
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
    const percent = Math.floor(ratio * 100);
    const rate = completed / (elapsedMs / 1000);
    const eta = completed > 0 && completed < shards ? (shards - completed) / rate * 1000 : 0;
    const etaText = completed >= shards ? 'finalizing' : completed > 0 ? `ETA ${formatDuration(eta)}` : 'ETA --';
    if (compact) {
      const count = `${completed}/${shards}`;
      const barWidth = Math.max(0, columns - count.length - 10);
      if (barWidth === 0) {
        stdout.write(`\r\x1b[2K${fitTerminal(`${String(percent).padStart(3)}% ${count}`, columns)}`);
      } else {
        const filled = Math.floor(ratio * barWidth);
        const bar = `${cyan}${'━'.repeat(filled)}${reset}${filled < barWidth ? `${cyan}╸${reset}${dim}${'·'.repeat(barWidth - filled - 1)}${reset}` : ''}`;
        stdout.write(`\r\x1b[2K${cyan}◇${reset} ${String(percent).padStart(3)}% [${bar}] ${count}`);
      }
    } else {
      const filled = Math.floor(ratio * width);
      const bar = `${cyan}${'━'.repeat(filled)}${reset}${filled < width ? `${cyan}╸${reset}${dim}${'·'.repeat(width - filled - 1)}${reset}` : ''}`;
      if (rendered) stdout.write('\x1b[2A');
      stdout.write(`\r\x1b[2K  ${cyan}◇ DERIVING${reset}  ${String(percent).padStart(3)}%  [${bar}]\n`);
      stdout.write(`\r\x1b[2K${cliProgressStatusLine(completed, shards, rate, etaText, workers, columns)}\n`);
    }
    rendered = true;
  };
  const timer = setInterval(render, 100);
  const clearRendered = () => {
    if (!rendered) return;
    stdout.write(compact
      ? '\r\x1b[2K'
      : '\x1b[2A\r\x1b[2K\n\r\x1b[2K\x1b[1A\r');
    rendered = false;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clearRendered();
  };
  return {
    update: value => {
      if (Number.isSafeInteger(value) && value >= 0 && value <= shards) completed = value;
    },
    notice: (message, warning = false) => {
      clearRendered();
      if (warning) console.warn(message);
      else console.log(message);
    },
    complete: elapsedMs => {
      stop();
      if (compact) {
        const detailed = `✓ DERIVED 100% · ${shards}/${shards} · ${formatDuration(elapsedMs)}`;
        const concise = `✓ ${shards}/${shards} 100% ${formatDuration(elapsedMs)}`;
        console.log(`${green}${fitTerminal(detailed.length <= columns ? detailed : concise, columns)}${reset}`);
      } else {
        console.log(`  ${green}✓ DERIVED${reset}  100%  [${green}${'━'.repeat(width)}${reset}]`);
        console.log(fitTerminal(
          `     ${shards.toLocaleString('en-US')} / ${shards.toLocaleString('en-US')} shards  ·  ${workers} workers  ·  ${formatDuration(elapsedMs)}`,
          columns,
        ));
      }
    },
    stop,
  };
}

let sensitiveScreenOpen = false;

function canUseSensitiveScreen(): boolean {
  return stdin.isTTY === true
    && stdout.isTTY === true
    && supportsAlternateScreen()
    && hasReliableSensitiveGeometry();
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

let signalExitStarted = false;

function exitFromSignal(exitCode: number): void {
  if (signalExitStarted) process.exit(exitCode);
  signalExitStarted = true;
  eraseSensitiveScreen();
  void terminateNativeChildren().finally(() => process.exit(exitCode));
}

process.once('exit', eraseSensitiveScreen);
process.once('SIGHUP', () => exitFromSignal(129));
process.once('SIGTERM', () => exitFromSignal(143));

function ignoreInputDuringDerivation(): () => void {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return () => {};
  const previousRaw = stdin.isRaw ?? false;
  let active = true;
  const onData = (chunk: Buffer) => {
    if (chunk.includes(3)) exitFromSignal(130);
  };
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', onData);
  return () => {
    if (!active) return;
    active = false;
    stdin.off('data', onData);
    stdin.pause();
    stdin.setRawMode(previousRaw);
  };
}

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
  if (!supportsCursorControl()) {
    console.log(`${title}:`);
    for (const [index, option] of options.entries()) {
      const prefix = `${index + 1}. `;
      console.log(option.startsWith(prefix) ? option : `${prefix}${option}`);
    }
    const plain = readline.createInterface({ input: stdin, output: stdout, terminal: false });
    try {
      const answer = (await plain.question(`${title} (enter a number; default ${initial + 1}): `)).trim();
      if (answer === '') return initial;
      const selected = Number(answer);
      if (!Number.isSafeInteger(selected) || selected < 1 || selected > options.length) {
        throw new Error('BRAINVAULT_MENU_SELECTION_INVALID');
      }
      return selected - 1;
    } finally {
      plain.close();
    }
  }
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
- bun ./brainvault
- bun ./brainvault --ask
- bun ./brainvault --bench
- bun ./brainvault --smoke
- bun ./brainvault --password

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
  Derive site-specific passwords from the master key. With no inline work
  setting, asks for the same Standard, High, or Maximum profile as wallet mode.
- --ask
  Advanced interactive setup: ask for level/shards, shard multiplier, workers,
  and engine. Engine choice never changes the derived root.
  Without this flag, interactive wallet mode still asks you to choose Standard
  (10,000), High (100,000), or Maximum (1,000,000 shards). Standard is selected
  by default. Multiplier remains 1 and the verified production backend is used.
- --engine NAME
  Choose auto, metal, metal-generic, opencl, c-neon, c-neon-wipe,
  native-direct, native-sync, native, rust, rust-no-wipe, or wasm.
  native-direct is benchmark/smoke-only: wallet and site-password derivation
  refuse it because same-isolate corruption was observed.
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
  Interactive wallet and password modes: require second entry for Username and Password.
- --show-password
  Echo password and confirmation input. Explicitly unsafe: characters appear on
  screen and may be retained by scrollback, recordings, logs, tmux, or photos.
  Passwords remain forbidden in argv.
- --promo
  Show short brainvault.sh intro and outro cards for terminal recordings.
  Off by default; wallet derivation and recovery semantics are unchanged.
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
  Unsafe override intended only for existing V1 wallet recovery. Eight characters is input
  hygiene, not a security recommendation; weak or reused passwords remain unsafe.
- --suggest-password
  Interactive creation only: generate ${SUGGESTED_PASSWORD_CHARACTERS} random
  a-z/A-Z/0-9 characters (${SUGGESTED_PASSWORD_BITS.toFixed(2)} bits) with the
  operating-system CSPRNG. It is shown once in a temporary sensitive screen,
  must be repeated, and is then erased from the ordinary terminal view.
- --unicode-recovery
  Legacy no-op retained for old recovery instructions. Unicode input is accepted
  by default and uses the frozen V1 NFKD/UTF-8 semantics. For values a terminal
  cannot represent exactly, use the library API and verify the complete first address.

Examples:
- bunx brainvault
- bunx brainvault --ask
- bunx brainvault --bench --level 3 --multiplier 10 --workers 32
- bunx brainvault --ask --level 3 --multiplier 1 --workers 32 --engine metal
- bun ./brainvault
- bunx brainvault --show-private-key

Recovery rule:
- You must use the same V1 Username + Password + Shard count + multiplier
  to reproduce the same master key.
- Capitalization and every space are exact. Unicode is accepted; V1 NFKD makes
  canonically or compatibility-equivalent spellings intentionally identical.
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
    console.error(`Error: invalid --${names[0]} value. Expected a positive integer.`);
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
  console.error(`Error: invalid --engine value. Expected one of: ${ENGINE_IDS.join(', ')}.`);
  process.exit(1);
}
if (legacyEngineFlags.length > 1 || (inlineEngine !== undefined && legacyEngineFlags.length > 0)) {
  console.error('Error: choose only one of --engine, --lib=wasm, --lib=native, or --lib=neon');
  process.exit(1);
}

const flagEngine = (inlineEngine ?? legacyEngineFlags[0] ?? 'auto') as EngineSelection;
if (flagEngine === 'native-direct' && !args.includes('--bench') && !args.includes('--smoke')) {
  console.error('Error: BRAINVAULT_ENGINE_RESEARCH_ONLY:native-direct');
  process.exit(1);
}
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

if (suggestPassword && !canUseSensitiveScreen()) {
  console.error('Error: suggested passwords require a reliable interactive terminal with alternate-screen support.');
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

function workFromInlineSettings(): WorkSpec | undefined {
  if (inlineLevel !== undefined) return workFromLevel(inlineLevel);
  if (inlineFactor !== undefined) return workFromLegacyFactor(inlineFactor);
  if (inlineShards !== undefined) return workFromExactShards(inlineShards);
  return undefined;
}

const PRIMARY_WORK_OPTIONS = Object.freeze([
  'STANDARD | 10,000 shards | recommended | 1× work',
  'HIGH     | 100,000 shards | about 10× work',
  'MAXIMUM  | 1,000,000 shards | about 100× work',
] as const);

async function choosePrimaryWork(
  promptOutput: PromptOutput,
  rl: readline.Interface,
): Promise<Readonly<{ work: WorkSpec; rl: readline.Interface }>> {
  console.log('Choose how much work every recovery—and every attacker guess—must pay.');
  console.log('This multiplies guess cost; it does not repair a weak or reused password.\n');
  rl.close();
  const profileIndex = await selectOption('recovery work', PRIMARY_WORK_OPTIONS);
  return {
    work: workFromLevel(BRAINVAULT_PRIMARY_LEVELS[profileIndex]!),
    rl: createPrivateReadline(promptOutput),
  };
}

function printWorkSafety(work: WorkSpec): void {
  if (work.shardCount <= 100) {
    console.warn('DO NOT FUND: this test/low-work setting is unsafe for funded wallets.');
  }
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
  onNotice?: (message: string, warning: boolean) => void;
}

function resolveNeonExecutable(): string | undefined {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return undefined;
  const isAppleM3 = cpus().some(cpu => cpu.model.toLowerCase().includes('apple m3'));
  const candidates = [
    ...(isAppleM3 ? [`${PACKAGE_ROOT}/src/native/prebuilds/darwin-arm64/brainvault-argon2-m3`] : []),
    `${PACKAGE_ROOT}/src/native/prebuilds/darwin-arm64/brainvault-argon2`,
    `${PACKAGE_ROOT}/src/native/source/c/brainvault-argon2`,
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
  const isAppleM3 = process.platform === 'darwin'
    && process.arch === 'arm64'
    && cpus().some(cpu => cpu.model.toLowerCase().includes('apple m3'));
  const candidates = [
    ...(process.platform === 'darwin' && process.arch === 'arm64'
      ? [
        ...(isAppleM3 ? [`${PACKAGE_ROOT}/src/native/prebuilds/darwin-arm64/${basename}-m3`] : []),
        `${PACKAGE_ROOT}/src/native/prebuilds/darwin-arm64/${basename}`,
      ]
      : []),
    ...(isAppleM3
      ? [`${PACKAGE_ROOT}/src/native/source/rust/target-m3${noWipe ? '-no-wipe' : ''}/release/brainvault-argon2-rust`]
      : []),
    `${PACKAGE_ROOT}/src/native/source/rust/target-m1${noWipe ? '-no-wipe' : ''}/release/brainvault-argon2-rust`,
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
    const openclKernel = `${PACKAGE_ROOT}/src/native/source/opencl/data/kernels/argon2_kernel.cl`;
    const executable = [
      `${PACKAGE_ROOT}/src/native/prebuilds/darwin-arm64/brainvault-argon2-opencl`,
      `${PACKAGE_ROOT}/src/native/source/opencl/brainvault-argon2-opencl`,
    ].find(candidate => existsSync(candidate));
    return executable !== undefined && existsSync(openclKernel) ? { executable, openclKernel } : undefined;
  }
  const prebuiltExecutable = `${PACKAGE_ROOT}/src/native/prebuilds/darwin-arm64/brainvault-argon2-metal`;
  const prebuiltLibrary = `${PACKAGE_ROOT}/src/native/prebuilds/darwin-arm64/argon2.metallib`;
  if (existsSync(prebuiltExecutable) && existsSync(prebuiltLibrary)) {
    return { executable: prebuiltExecutable, metalLibrary: prebuiltLibrary };
  }
  const executable = `${PACKAGE_ROOT}/src/native/source/metal/brainvault-argon2-metal`;
  const metalLibrary = `${PACKAGE_ROOT}/src/native/source/metal/argon2.metallib`;
  return existsSync(executable) && existsSync(metalLibrary) ? { executable, metalLibrary } : undefined;
}

function getInteractiveEngineChoices(multiplier: number, shardCount: number): EngineChoice[] {
  const choices: EngineChoice[] = [];
  const neonAvailable = resolveNeonExecutable() !== undefined;
  const metalAvailable = multiplier === 1
    && resolveAcceleratorBundle('metal') !== undefined
    && neonAvailable;
  const measuredMetalDefault = metalAvailable
    && isMeasuredM3Ultra()
    && shardCount >= 1_000;
  const cNeon: EngineChoice = {
    id: 'c-neon',
    label: measuredMetalDefault
      ? 'C/NEON final wipe (portable baseline)'
      : 'C/NEON final wipe (portable Apple Silicon default)',
    referenceRate: 191.87,
  };
  if (neonAvailable && !measuredMetalDefault) choices.push(cNeon);
  if (metalAvailable) {
    choices.push(
      {
        id: 'metal',
        label: measuredMetalDefault
          ? 'Metal V1 + C/NEON hybrid (measured M3 Ultra default)'
          : 'Metal V1 + C/NEON hybrid (advanced; benchmark locally)',
        referenceRate: 365.81,
      },
      { id: 'metal-generic', label: '(experimental) Metal generic + C/NEON hybrid', referenceRate: 355.22 },
    );
  }
  if (multiplier === 1 && resolveAcceleratorBundle('opencl') !== undefined && neonAvailable) {
    choices.push({ id: 'opencl', label: '(experimental) OpenCL + C/NEON hybrid', referenceRate: 337.43 });
  }
  if (neonAvailable && measuredMetalDefault) choices.push(cNeon);
  if (neonAvailable) {
    choices.push(
      { id: 'c-neon-wipe', label: '(experimental) C/NEON wipe after every shard', referenceRate: 177.11 },
    );
  }
  choices.push(
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
  const verifiedExecutable = verifyBundledExecutable(executable, PACKAGE_ROOT);
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
    const child = trackNativeChild(Bun.spawn([verifiedExecutable], {
      env: nativeChildEnvironment({
        ...(onProgress === undefined ? {} : { [BRAINVAULT_NATIVE_PROGRESS_ENV]: '1' }),
      }),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }));
    child.stdin.write(input);
    child.stdin.end();
    let nativeOutput: Buffer;
    let status: number;
    try {
      [nativeOutput, , status] = await Promise.all([
        readNativeOutput(child.stdout, shardCount * BRAINVAULT_V1.SHARD_OUTPUT_BYTES),
        readNativeProgress(child.stderr, acceptProgress, shardCount),
        child.exited,
      ]);
    } catch (error) {
      await terminateNativeChildGroup([child]);
      throw error;
    }
    output = nativeOutput;
    exitCode = status;
  } finally {
    password.fill(0);
    input.fill(0);
  }
  if (exitCode !== 0) {
    output.fill(0);
    throw new Error(`BRAINVAULT_EXECUTABLE_FAILED:${String(exitCode)}`);
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
  let failure: unknown;
  try {
    await Promise.all(Array.from({ length: workers }, async () => {
      while (failure === undefined) {
        const shardIndex = nextShard++;
        if (shardIndex >= shardCount) return;
        try {
          const salt = await createShardSalt(name, shardIndex, shardCount, algId);
          shards[shardIndex] = copyAndWipe(await argon2Native(password, {
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
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error('BRAINVAULT_NATIVE_DIRECT_FAILURE');
        }
      }
    }));
    if (failure !== undefined) throw failure;
    return shards;
  } catch (error) {
    for (const shard of shards) shard?.fill(0);
    throw error;
  } finally {
    password.fill(0);
  }
}

async function derive(name: string, passphrase: string, work: WorkSpec, workers = 64, options: DeriveOptions = {}) {
  const {
    engine = 'auto',
    shardMultiplier = 1,
    onProgress,
    onNotice,
  } = options;
  const reportNotice = (message: string, warning = false): void => {
    if (onNotice !== undefined) onNotice(message, warning);
    else if (warning) console.warn(message);
    else console.log(message);
  };

  assertBrainVaultName(name);
  assertBrainVaultPassphrase(passphrase);

  if (!Number.isSafeInteger(work.shardCount) || work.shardCount < 1
    || work.shardCount > BRAINVAULT_MAX_SHARD_COUNT) {
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
  // `auto` picks exactly one backend before derivation from what is
  // installed; a backend that then fails at runtime is an error, never a
  // silent switch to another engine.
  const selectedEngine: Exclude<EngineSelection, 'auto'> = autoSelectedMetal
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
    reportNotice(
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
          packageRoot: PACKAGE_ROOT,
          cpuExecutable: neonExecutable,
          acceleratorExecutable: acceleratorBundle.executable,
          metalLibrary: acceleratorBundle.metalLibrary,
          openclKernel: acceleratorBundle.openclKernel,
        },
      });
      shardResults = accelerated.shards;
    } finally {
      password.fill(0);
      for (const salt of salts) salt.fill(0);
    }
  }

  if (selectedEngine === 'c-neon' || selectedEngine === 'c-neon-wipe') {
    if (neonExecutable === undefined) throw new Error('BRAINVAULT_C_NEON_UNAVAILABLE');
    reportNotice(`Using ${selectedEngine === 'c-neon' ? 'C/NEON final wipe' : '(experimental) C/NEON per-shard wipe'} (${actualWorkers} workers)`);
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
  }

  if (selectedEngine === 'rust' || selectedEngine === 'rust-no-wipe') {
    const rustExecutable = resolveRustExecutable(selectedEngine === 'rust-no-wipe');
    if (rustExecutable === undefined) throw new Error(`BRAINVAULT_RUST_UNAVAILABLE:${selectedEngine}`);
    if (selectedEngine === 'rust-no-wipe') {
      reportNotice('WARNING: Rust no-wipe is parity/performance mode; sensitive Argon memory is not zeroized.', true);
    }
    reportNotice(`Using ${selectedEngine === 'rust' ? '(experimental) Rust secure-wipe pool' : '(experimental) Rust no-wipe pool'} (${actualWorkers} workers)`);
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
    reportNotice(`Using (experimental) native direct async (${actualWorkers} workers)`);
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
      ? `${PACKAGE_ROOT}/src/native/workers/wasm.ts`
      : selectedEngine === 'native-sync'
        ? `${PACKAGE_ROOT}/src/native/workers/sync.ts`
        : `${PACKAGE_ROOT}/src/native/workers/native.ts`;
    const pool: Worker[] = [];

    reportNotice(selectedEngine === 'wasm'
      ? `Using TypeScript/WASM reference (${actualWorkers} workers)`
      : selectedEngine === 'native-sync'
        ? `Using (experimental) native sync workers (${actualWorkers} workers)`
        : `Using native isolated workers (${actualWorkers} workers)`);

    try {
      await new Promise<void>((resolve, reject) => {
        const terminatePool = () => Promise.all(pool.map(worker => worker.terminate())).then(() => undefined);
        const fail = (error: unknown) => {
          if (failed) return;
          failed = true;
          const cause = error instanceof Error ? error : new Error('BRAINVAULT_WORKER_FAILURE');
          void terminatePool().then(
            () => reject(cause),
            terminationError => reject(new AggregateError([cause, terminationError], 'BRAINVAULT_WORKER_FAILURE')),
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
            } catch (error) {
              fail(error);
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
    } catch (error) {
      for (const shard of workerShardResults) shard?.fill(0);
      throw error;
    }
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
      const ethAddr24 = await deriveEthereumAddress(mnemonic24, '');
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
        ? await deriveEthereumPrivateKeyAtPath(mnemonic24, "m/44'/60'/0'/0/0", '')
        : undefined,
      privateKey12: includePrivateKeys
        ? await deriveEthereumPrivateKeyAtPath(mnemonic12, "m/44'/60'/0'/0/0", '')
        : undefined,
    };
  } finally {
    entropy24?.fill(0);
    entropy12?.fill(0);
  }
}

type SensitivePage = Readonly<{ destination: string; lines: readonly string[] }>;

function wrapSensitiveLine(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > width) {
    const space = remaining.lastIndexOf(' ', width);
    const cut = space > 0 ? space : width;
    lines.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut + (space > 0 ? 1 : 0));
  }
  if (remaining !== '') lines.push(remaining);
  return lines;
}

function sensitivePages(
  primary: readonly string[],
  secondary: readonly string[],
): Readonly<{ header: readonly string[]; pages: readonly SensitivePage[] }> {
  const columns = terminalColumns();
  const header = [
    'RECOVERY WORDS · SECRET',
    'Anyone who sees these words can spend the wallet funds.',
    'This view clears on Enter or Ctrl+C; recordings, terminal logs, and photographs cannot be erased.',
  ];
  const headerRows = header.flatMap(line => wrapSensitiveLine(line, columns)).length;
  const longestPrompt = 'Press Enter for the SECONDARY wallet (continued): ';
  const reservedRows = headerRows + 3 + wrapSensitiveLine(longestPrompt, columns).length;
  const capacity = terminalRows() - reservedRows;
  if (capacity < 3) throw new Error('BRAINVAULT_SENSITIVE_TERMINAL_TOO_SHORT');

  const pages: SensitivePage[] = [];
  for (const block of [
    { name: 'PRIMARY', lines: primary },
    { name: 'SECONDARY', lines: secondary },
  ]) {
    const content = block.lines.flatMap(line => wrapSensitiveLine(line, columns));
    let offset = 0;
    let first = true;
    while (offset < content.length) {
      const heading = wrapSensitiveLine(
        first
          ? `${block.name} WALLET · ${block.name === 'PRIMARY' ? '24 words · matches the public first receiving address' : '12 words · separate wallet and addresses'}:`
          : `${block.name} WALLET (continued):`,
        columns,
      );
      const count = Math.max(1, capacity - heading.length);
      pages.push({
        destination: `the ${block.name} wallet${first ? '' : ' (continued)'}`,
        lines: [...heading, ...content.slice(offset, offset + count)],
      });
      offset += count;
      first = false;
    }
  }
  return { header, pages };
}

async function showSensitiveMaterial(
  primary: readonly string[],
  secondary: readonly string[],
): Promise<void> {
  const { header, pages } = sensitivePages(primary, secondary);
  openSensitiveScreen();
  const dismissRl = createPrivateReadline(stdout);
  try {
    for (let index = 0; index < pages.length; index += 1) {
      if (index > 0) stdout.write('\x1b[2J\x1b[H');
      for (const line of header) console.log(line);
      console.log(`Page ${index + 1}/${pages.length}\n`);
      for (const line of pages[index]!.lines) console.log(line);
      const next = pages[index + 1];
      await dismissRl.question(next === undefined
        ? '\nPress Enter to clear and exit: '
        : `\nPress Enter for ${next.destination}: `);
    }
  } finally {
    dismissRl.close();
    eraseSensitiveScreen();
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

  const benchmarkPath = `${PACKAGE_ROOT}/src/native/source/benchmark.ts`;
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
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, UV_THREADPOOL_SIZE: String(workers) },
    });
    if (child.status !== 0) {
      console.log('FAILED');
      throw new Error(`BRAINVAULT_BENCHMARK_ENGINE_FAILED:${candidate.id}:${String(child.status)}`);
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
    const matrix = await Bun.file(`${PACKAGE_ROOT}/tests/data/matrix-v1.json`).json() as { roots?: Record<string, string> };
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
  let rl = createPrivateReadline(promptOutput);

  printBrand();
  console.log('\nHuman passwords have limited entropy.');
  console.log('Work settings raise the cost of each guess; they cannot make a weak');
  console.log('or reused password safe.');
  console.log('BrainVault writes no recovery file.');
  console.log('Remember the exact Username, Password, Shard count, and Multiplier.');
  console.log('Forget any recovery input and the wallet cannot be recovered.');
  console.log('Before funding, perform a fresh independent derivation and compare the complete first receiving address.\n');
  printVisibleInputWarning();
  if (shardMultiplier > 1) {
    const memoryPerShardGb = (BRAINVAULT_V1.SHARD_MEMORY_KB * shardMultiplier) / (1024 * 1024);
    console.log(`CUSTOM MODE: multiplier=${shardMultiplier} (${memoryPerShardGb.toFixed(2)} GiB per shard)\n`);
  }

  printStep(1, 'IDENTITY');
  const name = await rl.question('Username: ');
  if (!name) {
    rejectPrompt(rl, 'Username cannot be empty');
    return;
  }
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
    let mismatch = false;
    openSensitiveScreen();
    try {
      console.log(`Generated recovery password · ${SUGGESTED_PASSWORD_CHARACTERS} random a-z/A-Z/0-9 characters`);
      console.log(`${SUGGESTED_PASSWORD_BITS.toFixed(2)} bits while undisclosed:`);
      console.log(pass);
      console.log('BrainVault does not save it. Recordings, terminal logs, and photographs cannot be erased.');
      console.log('This repeat checks transcription only; test a fresh recovery before funding.');
      const passRepeat = await askPasswordInput(
        rl,
        promptOutput,
        'Repeat generated password (hidden; typing works): ',
        'Repeat generated password (VISIBLE): ',
      );
      if (pass !== passRepeat) {
        mismatch = true;
      }
    } finally {
      eraseSensitiveScreen();
    }
    if (mismatch) {
      rejectPrompt(rl, 'Suggested password was not repeated exactly');
      return;
    }
    console.log('Generated password confirmed. Sensitive view erased.');
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

  let selectedWork = workFromInlineSettings() ?? workFromLevel(BRAINVAULT_DEFAULT_LEVEL);
  let selectedMultiplier = shardMultiplier;
  let selectedEngine = flagEngine;

  printStep(2, 'WORK SETTINGS');
  if (!askAdvanced && inlineLevel === undefined && inlineFactor === undefined && inlineShards === undefined) {
    const selection = await choosePrimaryWork(promptOutput, rl);
    selectedWork = selection.work;
    rl = selection.rl;
  }
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
      rl = createPrivateReadline(promptOutput);
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
      const engineChoices = getInteractiveEngineChoices(selectedMultiplier, selectedWork.shardCount);
      console.log('\nAvailable engines (same tested root; rates are from one M3 Ultra, not a ranking for this Mac):');
      const engineOptions = engineChoices.map((choice, index) => {
        const warning = choice.warning === undefined ? '' : ` | WARNING: ${choice.warning}`;
        return `${index + 1}. ${choice.label} | ${choice.referenceRate.toFixed(2)} shards/s${warning}`;
      });
      rl.close();
      const engineIndex = await selectOption('engine', engineOptions);
      selectedEngine = engineChoices[engineIndex]!.id;
      rl = createPrivateReadline(promptOutput);
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
    const usingRecommendedDefaults = selectedWork.level === BRAINVAULT_DEFAULT_LEVEL
      && shardMultiplierFlag === undefined
      && inlineWorkers === undefined
      && flagEngine === 'auto';
    console.log(usingRecommendedDefaults
      ? 'Standard work selected · use --ask for advanced setup.'
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

  printWorkSafety(selectedWork);
  rl.close();

  console.log(`\n${shardCount.toLocaleString('en-US')} shards × ${workersInput} workers`);
  console.log(recoveryRuleText(shardCount, selectedMultiplier));
  console.log('Engine and worker count affect speed only; they are not recovery inputs.');
  console.log(`Addresses: ${addressCount} standard + ${addressCount} Ledger Live`);
  printStep(3, 'DERIVE');

  let rootKey: Uint8Array | undefined;
  let stopIgnoringInput: (() => void) | undefined;
  const progress = startDerivationProgress(shardCount, workersInput);
  try {
    stopIgnoringInput = ignoreInputDuringDerivation();
    const result = await derive(name, pass, selectedWork, workersInput, {
      engine: selectedEngine,
      shardMultiplier: selectedMultiplier,
      onProgress: completed => progress.update(completed),
      onNotice: (message, warning) => progress.notice(message, warning),
    });
    rootKey = result.rootKey;
    progress.complete(result.derivationTime);

    console.log('\n╭─ PUBLIC RESULT · no private material shown');
    console.log(`│ Engine used:              ${result.engine}  (speed only)`);
    console.log(`│ Wallet fingerprint:       ${result.fingerprint}  (quick visual check)`);
    console.log(`│ First receiving address:  ${result.ethAddr24}`);
    console.log('│ 24-word primary · authoritative recovery check');
    console.log('╰─ The address is public, but may still be privacy-sensitive.');

    if (!canUseSensitiveScreen()) {
      stopIgnoringInput();
      stopIgnoringInput = undefined;
      console.log('\nRecovery words unavailable: this terminal cannot safely isolate the sensitive view.');
      return;
    }

    stopIgnoringInput();
    stopIgnoringInput = undefined;
    const revealOutput = new PromptOutput();
    const revealRl = createPrivateReadline(revealOutput);
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
    await showSensitiveMaterial(
      [
        sensitive.mnemonic24,
        ...sensitive.standardAddrs24.map((address, index) => `Address ${index + 1}: ${address}`),
        ...sensitive.ledgerLiveAddrs24.map((address, index) => `Ledger Live ${index + 1}: ${address}`),
        ...(sensitive.privateKey24 === undefined ? [] : [`Private Key 1: ${sensitive.privateKey24}`]),
      ],
      [
        sensitive.mnemonic12,
        ...sensitive.standardAddrs12.map((address, index) => `Address ${index + 1}: ${address}`),
        ...sensitive.ledgerLiveAddrs12.map((address, index) => `Ledger Live ${index + 1}: ${address}`),
        ...(sensitive.privateKey12 === undefined ? [] : [`Private Key 1: ${sensitive.privateKey12}`]),
      ],
    );
    console.log('Sensitive view erased. The privacy-sensitive public address remains above.');
  } catch (err) {
    progress.stop();
    if (isUserCancellation(err)) throw err;
    const message = publicErrorMessage(err, 'BRAINVAULT_DERIVATION_FAILED');
    console.error(`Derivation failed: ${message}`);
    process.exitCode = 1;
  } finally {
    stopIgnoringInput?.();
    rootKey?.fill(0);
  }
}

// ============================================================================
// PASSWORD MANAGER
// ============================================================================

async function derivePassword() {
  const promptOutput = new PromptOutput();
  let rl = createPrivateReadline(promptOutput);
  let confirmationRl: readline.Interface | undefined;
  let rlPassword: readline.Interface | undefined;
  let rootKey: Uint8Array | undefined;
  let stopIgnoringInput: (() => void) | undefined;

  try {

  printBrand();
  console.log('\nPASSWORD MODE\n');
  printVisibleInputWarning();
  const name = await rl.question('Username: ');
  if (!name) {
    rejectPrompt(rl, 'Username cannot be empty');
    return;
  }
  if (requireRepeat) {
    const nameRepeat = await rl.question('Repeat Username: ');
    if (name !== nameRepeat) {
      rejectPrompt(rl, 'Username entries do not match');
      return;
    }
  }
  const pass = await askPasswordInput(
    rl,
    promptOutput,
    'Password (hidden; typing works): ',
    'Password (VISIBLE): ',
  );
  if (requireRepeat) {
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

  let selectedWork = workFromInlineSettings();
  if (selectedWork === undefined) {
    const selection = await choosePrimaryWork(promptOutput, rl);
    selectedWork = selection.work;
    rl = selection.rl;
  }

  const plan = getHardwarePlan(selectedWork.shardCount, shardMultiplier);
  const workers = inlineWorkers ?? plan.recommendedWorkers;
  if (workers > plan.recommendedWorkers) {
    rejectPrompt(rl, `workers exceed the safe hardware limit (${plan.recommendedWorkers}) for this shard count/multiplier.`);
    return;
  }
  printWorkSafety(selectedWork);
  rl.close();

  console.log(`\n${selectedWork.shardCount.toLocaleString('en-US')} shards × ${workers} workers`);
  console.log(recoveryRuleText(selectedWork.shardCount, shardMultiplier));

  const progress = startDerivationProgress(selectedWork.shardCount, workers);
  let result: Awaited<ReturnType<typeof derive>>;
  stopIgnoringInput = ignoreInputDuringDerivation();
  try {
    result = await derive(name, pass, selectedWork, workers, {
      engine: flagEngine,
      shardMultiplier,
      onProgress: completed => progress.update(completed),
      onNotice: (message, warning) => progress.notice(message, warning),
    });
    progress.complete(result.derivationTime);
  } catch (error) {
    progress.stop();
    throw error;
  }
  rootKey = result.rootKey;

  console.log(`\n[OK] Master key ready · engine: ${result.engine} (speed only)\n`);

  stopIgnoringInput();
  stopIgnoringInput = undefined;
  confirmationRl = createPrivateReadline(promptOutput);
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

  rlPassword = createPrivateReadline(promptOutput);

  while (true) {
    const domain = await askSecret(
      rlPassword,
      promptOutput,
      'Domain (hidden; typing works; Enter exits): ',
    );
    if (!domain) break;
    const domainError = cliDomainError(domain);
    if (domainError !== undefined) {
      console.error(`Error: ${domainError}`);
      process.exitCode = 1;
      break;
    }

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
    stopIgnoringInput?.();
    rootKey?.fill(0);
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  const promo = args.includes('--promo');
  if (promo && (args.includes('--bench') || args.includes('--smoke') || args.includes('--password'))) {
    throw new Error('BRAINVAULT_PROMO_INTERACTIVE_ONLY');
  }
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
    if (promo) await showPromoScreen();
    await interactive();
    if (promo && (process.exitCode === undefined || process.exitCode === 0)) await showPromoScreen(true);
  }
}

try {
  await main();
} catch (error) {
  if (isUserCancellation(error)) {
    console.log('\nExited.');
    process.exitCode = 130;
  } else {
    const message = publicErrorMessage(error, 'BRAINVAULT_UNEXPECTED_FAILURE');
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}

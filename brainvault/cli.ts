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
 *   bun run bv --ask                            # Ask for factor, multiplier, and workers
 *   bun run bv --allow-short-password           # Legacy recovery only: allow fewer than 8 chars
 *   bun run bv --repeat                         # Interactive: require double entry for name/pass
 *   bun run bv --shard-multiplier=4             # Custom KDF mode: 256MB * multiplier per shard
 *   bun run bv --address-count=5                # Number of standard + ledger-live addresses
 *   bun run bv --reveal                         # Rehearse password, then reveal recovery material
 *   bun run bv --reveal --show-private-key      # Also reveal raw key for Address 1 (highest risk)
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
  deriveEthereumAddressMatrix, deriveEthereumPrivateKeyAtPath,
  factorForShardCount, formatDuration, bytesToHex,
  BRAINVAULT_V1, BRAINVAULT_V1_SPEC_ID, createShardSalt, deriveSitePassword, rootFingerprint,
} from './core.ts';
import { assertBrainVaultName, assertBrainVaultPassphrase } from './primitives/spec.ts';
import { acceptShard, createShardSlots, finalizeShards } from './shard-collector.ts';
import { cliCreationCharacterError, cliPasswordError } from './cli-policy.ts';
import { verifyBundledExecutable } from './binary-integrity.ts';
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
const showHelp = args.includes('--help') || args.includes('-h');

const UI_INNER_WIDTH = 70;
const MAX_WASM_MULTIPLIER = 7;

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
  const border = `+${'-'.repeat(UI_INNER_WIDTH + 2)}+`;
  const row = (text: string) => `| ${text.padEnd(UI_INNER_WIDTH)} |`;
  console.log(border);
  console.log(row('BRAINVAULT v1  /  MEMORY-HARD BRAIN WALLET'));
  console.log(row('Same exact inputs. Same root. Any supported engine.'));
  console.log(border);
}

function printStep(step: number, title: string): void {
  console.log(`\n[${step}/3] ${title}`);
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

async function selectOption(title: string, options: readonly string[], initial = 0): Promise<number> {
  if (!stdin.isTTY || !stdout.isTTY) return initial;
  let selected = Math.max(0, Math.min(initial, options.length - 1));
  let drawn = false;
  const previousRaw = stdin.isRaw ?? false;
  const draw = () => {
    if (drawn) stdout.write(`\x1b[${options.length}A`);
    for (const [index, option] of options.entries()) {
      stdout.write(`\x1b[2K\r${index === selected ? '>' : ' '} ${option}\n`);
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
- Memory-hard deterministic wallet derivation from: Name + Passphrase + Shard settings.
- Uses Argon2id per-shard and BLAKE3 domain-separated combine.
- Same inputs => same master key, mnemonics, and addresses.

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
  and production engine. Engine choice never changes the derived root.
  Without this flag the recommended default is level 3 (1,000 shards),
  multiplier 1, and all CPU cores allowed by RAM.
- --lib=native
  Force the portable @node-rs/argon2 worker implementation.
- --lib=neon
  Force the bundled C/NEON implementation (Apple Silicon, multiplier 1 only).
  It is selected automatically when available and falls back safely elsewhere.
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
  Interactive mode only: require second entry for Name and Passphrase.
- --reveal
  After derivation, require exact hidden password rehearsal before printing
  mnemonics and the full address matrix. Without it, Enter exits and only the
  root fingerprint plus first address are printed.
- --shard-multiplier=N
  Custom KDF mode. Memory per shard = 256MB * N.
  Warning: changing this changes the derived wallet.
- --address-count=N
  Number of addresses generated per scheme (standard + Ledger Live).
- --show-private-key
  Requires --reveal. Also print raw private key for Address 1 (highest risk).
- --allow-short-password
  Legacy recovery only. The CLI normally requires at least 8 password characters;
  this flag preserves recovery of older wallets created with a shorter password.
- --suggest-password
  Interactive creation only: generate ${SUGGESTED_PASSWORD_CHARACTERS} random
  a-z/A-Z/0-9 characters (${SUGGESTED_PASSWORD_BITS.toFixed(2)} bits) with the
  operating-system CSPRNG. It is shown once and must be repeated.
- --unicode-recovery
  Permit exact non-ASCII/control-character inputs for recovery. New CLI wallet
  creation accepts printable ASCII only; the V1 library remains Unicode exact.

Examples:
- bunx brainvault
- bunx brainvault --ask
- bunx brainvault --bench --level 3 --multiplier 10 --workers 32
- bunx brainvault --ask --level 3 --multiplier 1 --workers 32 --engine c-neon
- bun run bv
- bunx brainvault --reveal
- bunx brainvault --reveal --show-private-key

Recovery rule:
- You must use the exact same Name + Passphrase + Shard count + shard-multiplier
  to reproduce the same master key.

Wallet interoperability:
- Resulting PRIMARY/SECONDARY mnemonics can be imported to Ledger/Trezor
  via "Enter recovery phrase/passphrase" flows, and to Rabby / MetaMask, etc.
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

if (args.includes('--unsafe-password')) {
  console.error('Error: password argv is forbidden. Use hidden interactive input or the library API.');
  process.exit(1);
}
if (showPrivateKey && !revealRequested) {
  console.error('Error: --show-private-key requires --reveal and exact password rehearsal.');
  process.exit(1);
}
if (revealRequested && (!stdin.isTTY || !stdout.isTTY)) {
  console.error('Error: --reveal requires an interactive TTY for hidden password rehearsal.');
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
  return `Recovery rule: use the exact same Name + Passphrase + Shards (${shardCount}) + shard-multiplier (${shardMultiplierValue}) to reproduce the same master key.`;
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

function getHardwarePlan(shardCount: number, multiplier: number): HardwarePlan {
  const cpuCores = cpus().length;
  const totalGB = Math.floor(totalmem() / (1024 ** 3));
  const baseMemoryPerWorkerGb = BRAINVAULT_V1.SHARD_MEMORY_KB / (1024 * 1024);
  const memoryPerWorkerGb = baseMemoryPerWorkerGb * multiplier;
  const maxFromRAM = Math.floor((totalGB * 0.8) / memoryPerWorkerGb);
  const maxForAllCoresAtHalfRAM = Math.max(1, Math.floor((totalGB * 0.5) / (cpuCores * baseMemoryPerWorkerGb)));
  return {
    cpuCores,
    totalGB,
    memoryPerWorkerGb,
    maxFromRAM,
    recommendedWorkers: Math.min(cpuCores, maxFromRAM, shardCount),
    strongerMultiplier: Math.min(4, maxForAllCoresAtHalfRAM),
    upperMultiplier: maxForAllCoresAtHalfRAM,
  };
}

// ============================================================================
// CORE DERIVATION
// ============================================================================

interface DeriveOptions {
  engine?: EngineSelection;
  showDevice?: boolean;
  showPrivateKey?: boolean;
  addressCount?: number;
  shardMultiplier?: number;
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

function getInteractiveEngineChoices(multiplier: number): EngineChoice[] {
  const choices: EngineChoice[] = [];
  if (resolveNeonExecutable() !== undefined) {
    choices.push(
      { id: 'c-neon', label: 'C/NEON final wipe (fastest)', referenceRate: 186.44 },
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
): Promise<Uint8Array[]> {
  verifyBundledExecutable(executable, import.meta.dir);
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
  for (let index = 0; index < shardCount; index += 1) {
    input.set(await createShardSalt(name, index, shardCount, algId), header.length + password.length + (index * 32));
  }

  const child = spawnSync(executable, [], {
    input,
    maxBuffer: Math.max(1024 * 1024, shardCount * 64),
  });
  password.fill(0);
  input.fill(0);
  if (child.status !== 0) {
    throw new Error(`BRAINVAULT_EXECUTABLE_FAILED:${String(child.status)}:${child.stderr.toString().trim()}`);
  }
  if (child.stdout.length !== shardCount * BRAINVAULT_V1.SHARD_OUTPUT_BYTES) {
    throw new Error(`BRAINVAULT_EXECUTABLE_OUTPUT_INVALID:${child.stdout.length}`);
  }
  const shards = Array.from({ length: shardCount }, (_, index) => new Uint8Array(
    child.stdout.subarray(
      index * BRAINVAULT_V1.SHARD_OUTPUT_BYTES,
      (index + 1) * BRAINVAULT_V1.SHARD_OUTPUT_BYTES,
    ),
  ));
  child.stdout.fill(0);
  return shards;
}

async function deriveDirectAsyncShards(
  name: string,
  passphrase: string,
  shardCount: number,
  workers: number,
  shardMemoryKb: number,
  algId: string,
): Promise<Uint8Array[]> {
  const password = new TextEncoder().encode(passphrase.normalize('NFKD'));
  const shards = new Array<Uint8Array>(shardCount);
  let nextShard = 0;
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
    showDevice = false,
    showPrivateKey = false,
    addressCount = 5,
    shardMultiplier = 1,
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
  const autoSelectedC = engine === 'auto'
    && shardCount >= 100
    && neonExecutable !== undefined;
  let selectedEngine: Exclude<EngineSelection, 'auto'> = autoSelectedC ? 'c-neon' : engine === 'auto' ? 'native' : engine;
  if (selectedEngine === 'wasm' && shardMultiplier > MAX_WASM_MULTIPLIER) {
    throw new Error(`BRAINVAULT_ENGINE_MULTIPLIER_UNSUPPORTED:wasm:${shardMultiplier}:wasm32-memory-limit`);
  }
  let shardResults: Uint8Array[] | undefined;
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
      );
    } catch (error) {
      if (!autoSelectedC) throw error;
      console.warn(`C/NEON unavailable at runtime; using portable native fallback (${String(error)}).`);
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
    let lastUpdate = 0;
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
          acceptShard(workerShardResults, message, BRAINVAULT_V1_SPEC_ID, BRAINVAULT_V1.SHARD_OUTPUT_BYTES);
        } catch (error) {
          fail(error);
          return;
        }
        completed++;

        const now = Date.now();
        const elapsed = now - start;

        // Live progress bar
        if ((now - lastUpdate > 100) || (completed % Math.max(1, Math.ceil(shardCount / 20)) === 0) || completed === shardCount) {
          lastUpdate = now;
          const pct = completed / shardCount;
          const filled = Math.round(pct * 40);
          const bar = '#'.repeat(filled) + '.'.repeat(40 - filled);
          const rate = completed / (elapsed / 1000);
          const eta = (shardCount - completed) / rate * 1000;
          process.stdout.write(`\r[${bar}] ${Math.round(pct * 100)}% ${completed}/${shardCount} | ${actualWorkers}w | ${formatDuration(elapsed)} | ETA: ${formatDuration(eta)}     `);
        }

        if (completed >= shardCount) {
          console.log('');
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
  const masterKey = await combineShardsWithParams(shardResults, factor, {
    algId: kdfAlgId,
    shardMemoryKb,
  });
  for (const shard of shardResults) shard.fill(0);
  const fingerprint = rootFingerprint(masterKey);

  // Derive TWO wallets from one masterKey
  const entropy24 = await deriveKey(masterKey, 'bip39/entropy/v1.0', 32);
  const mnemonic24 = await entropyToMnemonic(entropy24);
  entropy24.fill(0);
  const matrix24 = await deriveEthereumAddressMatrix(mnemonic24, '', addressCount);
  const ethAddr24 = matrix24.standard[0]!;
  const privKey24 = showPrivateKey
    ? await deriveEthereumPrivateKeyAtPath(mnemonic24, "m/44'/60'/0'/0/0")
    : undefined;

  const entropy12 = await deriveKey(masterKey, 'bip39/entropy-128/v1.0', 16);
  const mnemonic12 = await entropyToMnemonic(entropy12);
  entropy12.fill(0);
  const matrix12 = await deriveEthereumAddressMatrix(mnemonic12, '', addressCount);
  const ethAddr12 = matrix12.standard[0]!;
  const privKey12 = showPrivateKey
    ? await deriveEthereumPrivateKeyAtPath(mnemonic12, "m/44'/60'/0'/0/0")
    : undefined;

  const devicePassBytes = showDevice
    ? await deriveKey(masterKey, 'bip39/passphrase/v1.0', 32)
    : undefined;
  const devicePass = devicePassBytes === undefined ? undefined : bytesToHex(devicePassBytes);
  devicePassBytes?.fill(0);
  const masterKeyHex = showDevice ? bytesToHex(masterKey) : undefined;
  masterKey.fill(0);

  return {
    name, shardCount, factor, workers, engine: selectedEngine, derivationTime, shardMultiplier, addressCount,
    fingerprint,
    mnemonic24, ethAddr24,
    standardAddrs24: matrix24.standard,
    ledgerLiveAddrs24: matrix24.ledgerLive,
    ...(showPrivateKey ? { privateKey24: privKey24 } : {}),
    mnemonic12, ethAddr12,
    standardAddrs12: matrix12.standard,
    ledgerLiveAddrs12: matrix12.ledgerLive,
    ...(showPrivateKey ? { privateKey12: privKey12 } : {}),
    ...(showDevice ? { devicePass, masterKey: masterKeyHex } : {}),
  };
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
      console.error(details);
      continue;
    }
    const parsed = JSON.parse(child.stdout) as {
      backend?: unknown;
      derivationTimeMs?: unknown;
      shardsPerSecond?: unknown;
      root?: unknown;
    };
    if (
      typeof parsed.backend !== 'string'
      || typeof parsed.derivationTimeMs !== 'number'
      || typeof parsed.shardsPerSecond !== 'number'
      || typeof parsed.root !== 'string'
    ) {
      console.log('FAILED');
      console.error('Benchmark returned malformed JSON.');
      continue;
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
  console.log(`\nRoot parity: PASS (${results[0]!.root})`);
}

// ============================================================================
// INTERACTIVE MODE
// ============================================================================

async function interactive() {
  const promptOutput = new PromptOutput();
  let rl = readline.createInterface({ input: stdin, output: promptOutput, terminal: true });

  printBrand();
  console.log('\nHuman inputs have limited entropy; shards make every guess pay Argon2id time and RAM.');
  console.log('More shards buy more resistance through waiting. They do not make a weak password strong.');
  console.log('NO RECEIPT: no seed file, QR, or recovery secret is saved. Your memory is the backup.');
  console.log('Remember the exact username, password, level, and multiplier.\n');
  if (shardMultiplier > 1) {
    const memoryPerShardGb = (BRAINVAULT_V1.SHARD_MEMORY_KB * shardMultiplier) / (1024 * 1024);
    console.log(`CUSTOM MODE: shard-multiplier=${shardMultiplier} (${memoryPerShardGb.toFixed(2)}GB per shard)\n`);
  }

  printStep(1, 'IDENTITY');
  const name = await rl.question('Username: ');
  if (requireRepeat) {
    const nameRepeat = await rl.question('Repeat Name: ');
    if (name !== nameRepeat) {
      console.log('Error: Name entries do not match');
      rl.close();
      return;
    }
  }

  let pass: string;
  if (suggestPassword) {
    pass = generateSuggestedPassword();
    console.log(`\nSuggested password (${SUGGESTED_PASSWORD_CHARACTERS} random a-z/A-Z/0-9 characters / ${SUGGESTED_PASSWORD_BITS.toFixed(2)} bits):`);
    console.log(pass);
    console.log('Memorize it. It is not saved; terminal scrollback may retain what is displayed.');
    const passRepeat = await askSecret(rl, promptOutput, 'Repeat Suggested Password: ');
    if (pass !== passRepeat) {
      console.log('Error: Suggested password was not repeated exactly');
      rl.close();
      return;
    }
  } else {
    pass = await askSecret(rl, promptOutput, 'Password: ');
  }
  if (requireRepeat && !suggestPassword) {
    const passRepeat = await askSecret(rl, promptOutput, 'Repeat Password: ');
    if (pass !== passRepeat) {
      console.log('Error: Passphrase entries do not match');
      rl.close();
      return;
    }
  }

  if (!name) {
    console.log('Error: Username cannot be empty');
    rl.close();
    return;
  }
  const passwordError = getCliPasswordError(pass);
  if (passwordError !== undefined) {
    console.log(`Error: ${passwordError}`);
    rl.close();
    return;
  }
  const characterError = getCliCreationCharacterError(name, pass);
  if (characterError !== undefined) {
    console.log(`Error: ${characterError}`);
    rl.close();
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

  if (askAdvanced) {
    if (inlineLevel === undefined && inlineFactor === undefined && inlineShards === undefined) {
      console.log('Use --shards N for an exact recovery count or --factor N for a legacy factor.\n');
      const levelOptions = BRAINVAULT_LEVEL_SHARDS.map((shards, index) => {
        const suffix = index === 0 ? ' | compatibility only' : index === 2 ? ' | recommended' : '';
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
        console.log(`Hardware-aware stronger option: ${initialPlan.strongerMultiplier} (${(0.25 * initialPlan.strongerMultiplier).toFixed(2)}GB per worker).`);
        console.log(`50% RAM ceiling with all ${initialPlan.cpuCores} CPUs: multiplier ${initialPlan.upperMultiplier}.`);
      }
      console.log('Warning: any multiplier other than 1 changes the root and must be remembered for recovery.');
      selectedMultiplier = Number((await rl.question('Shard multiplier (1): ')).trim() || '1');
      if (!Number.isSafeInteger(selectedMultiplier) || selectedMultiplier < 1) {
        console.log('Error: multiplier must be a positive integer');
        rl.close();
        return;
      }
    }

    if (selectedEngine === 'auto') {
      const engineChoices = getInteractiveEngineChoices(selectedMultiplier);
      console.log('\nAvailable engines (same root; reference is the latest 1,000-shard / 32-worker run):');
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
  printStep(2, 'WORK SETTINGS');
  if (askAdvanced) {
    console.log(`\nCPU cores detected: ${plan.cpuCores}`);
    console.log(`System RAM: ${plan.totalGB}GB; ${plan.memoryPerWorkerGb.toFixed(2)}GB per worker`);
    console.log(`Recommended workers: ${plan.recommendedWorkers}\n`);
    if (inlineWorkers === undefined) {
      workersInput = Number((await rl.question(`Parallel workers (${plan.recommendedWorkers}): `)).trim() || `${plan.recommendedWorkers}`);
    } else {
      console.log(`Inline workers: ${workersInput}`);
    }
  } else {
    console.log('\nRecommended defaults:');
    console.log(`  Level: ${selectedWork.level ?? 'custom'} (${shardCount.toLocaleString('en-US')} exact shards)`);
    console.log(`  Shard multiplier: ${selectedMultiplier}`);
    console.log(`  Workers: ${workersInput} (all available CPUs allowed by RAM)`);
    console.log('  Use --ask for advanced setup.');
  }
  if (!Number.isSafeInteger(workersInput) || workersInput < 1) {
    console.log('Error: workers must be a positive integer');
    rl.close();
    return;
  }
  if (workersInput > plan.recommendedWorkers) {
    console.log(`Error: workers exceed the safe hardware limit (${plan.recommendedWorkers}) for this shard count/multiplier.`);
    rl.close();
    return;
  }

  rl.close();

  console.log(`\n${shardCount} shards x ${workersInput} workers`);
  console.log(recoveryRuleText(shardCount, selectedMultiplier));
  console.log(`Address matrix: ${addressCount} standard + ${addressCount} Ledger Live`);
  printStep(3, 'DERIVE');

  try {
    const result = await derive(name, pass, selectedWork, workersInput, {
      engine: selectedEngine,
      showPrivateKey,
      addressCount,
      shardMultiplier: selectedMultiplier,
    });

    console.log(`\n[OK] Root derived in ${formatDuration(result.derivationTime)}\n`);
    console.log(`Root fingerprint: ${result.fingerprint}`);
    console.log(`First address:    ${result.ethAddr24}`);

    if (!stdin.isTTY || !stdout.isTTY) {
      if (revealRequested) throw new Error('BRAINVAULT_REVEAL_TTY_REQUIRED');
      return;
    }

    const revealOutput = new PromptOutput();
    const revealRl = readline.createInterface({ input: stdin, output: revealOutput, terminal: true });
    const command = revealRequested
      ? 'reveal'
      : (await revealRl.question('\nEnter exits. Type reveal to rehearse the password and reveal recovery material: ')).trim();
    if (command === '') {
      revealRl.close();
      return;
    }
    if (command !== 'reveal') {
      revealRl.close();
      throw new Error('BRAINVAULT_REVEAL_CONFIRMATION_INVALID');
    }
    const rehearsal = await askSecret(revealRl, revealOutput, 'Repeat the exact password: ');
    revealRl.close();
    if (rehearsal !== pass) throw new Error('BRAINVAULT_REHEARSAL_MISMATCH');

    console.log('\nSENSITIVE OUTPUT — terminal scrollback may retain everything below.');
    console.log('\nPRIMARY (24-word):');
    console.log(result.mnemonic24);
    for (let i = 0; i < result.standardAddrs24.length; i++) console.log(`Address ${i + 1}:`, result.standardAddrs24[i]);
    for (let i = 0; i < result.ledgerLiveAddrs24.length; i++) console.log(`Ledger Live ${i + 1}:`, result.ledgerLiveAddrs24[i]);
    if ('privateKey24' in result && result.privateKey24) console.log('Private Key 1:', result.privateKey24);

    console.log('\nSECONDARY (12-word):');
    console.log(result.mnemonic12);
    for (let i = 0; i < result.standardAddrs12.length; i++) console.log(`Address ${i + 1}:`, result.standardAddrs12[i]);
    for (let i = 0; i < result.ledgerLiveAddrs12.length; i++) console.log(`Ledger Live ${i + 1}:`, result.ledgerLiveAddrs12[i]);
    if ('privateKey12' in result && result.privateKey12) console.log('Private Key 1:', result.privateKey12);
  } catch (err) {
    console.error('Derivation failed:', err);
    process.exit(1);
  }
}

// ============================================================================
// PASSWORD MANAGER
// ============================================================================

async function derivePassword() {
  const promptOutput = new PromptOutput();
  const rl = readline.createInterface({ input: stdin, output: promptOutput, terminal: true });

  printBrand();
  console.log('\nPASSWORD MODE\n');
  const name = await rl.question('Name: ');
  const pass = await askSecret(rl, promptOutput, 'Password: ');
  const selectedLevel = Number((await rl.question(`Level (${BRAINVAULT_DEFAULT_LEVEL}): `)).trim() || `${BRAINVAULT_DEFAULT_LEVEL}`);

  const passwordError = getCliPasswordError(pass);
  if (passwordError !== undefined) {
    console.error(`Error: ${passwordError}`);
    rl.close();
    return;
  }
  const characterError = getCliCreationCharacterError(name, pass);
  if (characterError !== undefined) {
    console.error(`Error: ${characterError}`);
    rl.close();
    return;
  }

  if (!Number.isSafeInteger(selectedLevel) || selectedLevel < 1 || selectedLevel > BRAINVAULT_LEVEL_SHARDS.length) {
    console.error(`Error: level must be an integer in 1..${BRAINVAULT_LEVEL_SHARDS.length}`);
    rl.close();
    return;
  }

  rl.close();

  const selectedWork = workFromLevel(selectedLevel);
  const workers = getHardwarePlan(selectedWork.shardCount, shardMultiplier).recommendedWorkers;
  console.log('\nDeriving master key...');
  const result = await derive(name, pass, selectedWork, workers, {
    engine: flagEngine,
    showDevice: true,
    shardMultiplier,
  });
  if (!result.masterKey) {
    throw new Error('Internal error: masterKey missing in password mode');
  }

  console.log('\n[OK] Master key ready\n');

  const rlPassword = readline.createInterface({ input: stdin, output: process.stdout });

  while (true) {
    const domain = await rlPassword.question('Domain (or Enter to exit): ');
    if (!domain) break;

    const sitePass = await deriveSitePassword(result.masterKey, domain);
    console.log(`  ${domain}: ${sitePass}\n`);
  }

  rlPassword.close();
}

// ============================================================================
// MAIN
// ============================================================================

if (args.includes('--bench') || args.includes('--smoke')) {
  if (suggestPassword) throw new Error('BRAINVAULT_SUGGEST_PASSWORD_INTERACTIVE_ONLY');
  await runBenchmark(args.includes('--smoke'));
} else if (args.includes('--password')) {
  if (suggestPassword) throw new Error('BRAINVAULT_SUGGEST_PASSWORD_INTERACTIVE_ONLY');
  await derivePassword();
} else if (args[0] !== undefined && !args[0].startsWith('--')) {
  console.error('Error: positional username/password arguments are forbidden because shell history and process listings retain them.');
  console.error('Run brainvault interactively, or import the library API for programmatic derivation.');
  process.exit(1);
} else {
  try {
    await interactive();
  } catch (error) {
    if (isUserCancellation(error)) {
      console.log('\nExited.');
      process.exitCode = 130;
    } else {
      throw error;
    }
  }
}

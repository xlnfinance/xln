#!/usr/bin/env bun
/**
 * BrainVault CLI - Production wallet derivation
 *
 * Usage:
 *   bun run bv                                  # Interactive
 *   bun run bv -- test secret123 100 --w=64     # Non-interactive (JSON output)
 *   bun test brainvault/core.test.ts            # Run deterministic tests
 *   bun run bv --bench                          # Benchmark performance
 *   bun run bv --smoke                          # Fast 2-shard backend parity check
 *   bun run bv --lib=wasm                       # Force hash-wasm (slower, parity check)
 *   bun run bv --lib=native                     # Force portable @node-rs/argon2
 *   bun run bv --lib=neon                       # Force bundled Apple Silicon C/NEON
 *   bun run bv --ask                            # Ask for factor, multiplier, and workers
 *   bun run bv --repeat                         # Interactive: require double entry for name/pass
 *   bun run bv --shard-multiplier=4             # Custom KDF mode: 256MB * multiplier per shard
 *   bun run bv --address-count=5                # Number of standard + ledger-live addresses
 *   bun run bv --show-private-key               # Print raw key for Address 1 (high risk)
 *   bun run bv --help                           # Show usage/help
 */

import { stdin } from 'process';
import { cpus, totalmem } from 'os';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as readline from 'readline/promises';
import { Worker } from 'worker_threads';
import {
  getShardCount, combineShardsWithParams, deriveKey, entropyToMnemonic,
  deriveEthereumAddressMatrix, deriveEthereumPrivateKeyAtPath,
  factorForShardCount, formatDuration, hexToBytes, bytesToHex,
  BRAINVAULT_V1, BRAINVAULT_V1_SPEC_ID, createShardSalt, deriveSitePassword,
} from './core.ts';
import { assertBrainVaultName, assertBrainVaultPassphrase } from './primitives/spec.ts';

const args = process.argv.slice(2);
const showHelp = args.includes('--help') || args.includes('-h');

function printHelp(): void {
  console.log(`BrainVault CLI (bv)

What is BrainVault?
- Memory-hard deterministic wallet derivation from: Name + Passphrase + Shard settings.
- Uses Argon2id per-shard and BLAKE3 domain-separated combine.
- Same inputs => same master key, mnemonics, and addresses.

Usage:
- bunx brainvault
- bunx brainvault --ask
- bun run bv
- bun run bv --ask
- bun run bv -- <name> <passphrase> <shards> [--w=N]
- bun run bv --bench
- bun run bv --smoke
- bun run bv --password

Flags:
- --help, -h
  Show this help message.
- --bench
  Sequentially benchmark every available backend with the canonical defaults:
  1,000 shards, factor 4, multiplier 1, and all available CPU cores (up to 32).
- --smoke
  Fast backend sanity check: run the same engines sequentially with exactly
  2 shards and verify that every result has the same root.
- --password
  Derive site-specific passwords from the master key.
- --ask
  Advanced interactive setup: ask for factor/shards, shard multiplier, and workers.
  Without this flag the recommended defaults are factor 4 (1,000 shards),
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
- --repeat
  Interactive mode only: require second entry for Name and Passphrase.
- --shard-multiplier=N
  Custom KDF mode. Memory per shard = 256MB * N.
  Warning: changing this changes the derived wallet.
- --address-count=N
  Number of addresses generated per scheme (standard + Ledger Live).
- --show-private-key
  Also print raw private key for Address 1 (high risk; use only if you understand key handling risks).

Examples:
- bunx brainvault
- bunx brainvault --ask
- bun run bv
- bun run bv -- alice "correct horse battery staple" 100 --w=16
- bun run bv -- alice "secret123456" 1 --address-count=10
- bun run bv -- alice "secret123456" 100 --w=24 --shard-multiplier=50
- bun run bv -- alice "secret123456" 1 --show-private-key

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

const useWasm = args.includes('--lib=wasm');
const useNative = args.includes('--lib=native');
const useNeon = args.includes('--lib=neon');
const requireRepeat = args.includes('--repeat');
const showPrivateKey = args.includes('--show-private-key');
const askAdvanced = args.includes('--ask');

function getPositiveIntFlag(name: string, defaultValue: number): number {
  const flag = args.find(a => a.startsWith(`--${name}=`));
  if (!flag) return defaultValue;
  const raw = flag.split('=')[1] ?? '';
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    console.error(`Error: invalid --${name} value: ${raw}. Expected a positive integer.`);
    process.exit(1);
  }
  return value;
}

const addressCount = getPositiveIntFlag('address-count', 5);
const shardMultiplier = getPositiveIntFlag('shard-multiplier', 1);
const hasShardMultiplierFlag = args.some(argument => argument.startsWith('--shard-multiplier='));

if ([useWasm, useNative, useNeon].filter(Boolean).length > 1) {
  console.error('Error: choose only one of --lib=wasm, --lib=native, or --lib=neon');
  process.exit(1);
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
  const maxFromRAM = Math.max(1, Math.floor((totalGB * 0.8) / memoryPerWorkerGb));
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
  useWasm?: boolean;
  useNative?: boolean;
  useNeon?: boolean;
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

async function deriveNeonShards(
  executable: string,
  name: string,
  passphrase: string,
  shardCount: number,
  workers: number,
): Promise<Uint8Array[]> {
  const password = new TextEncoder().encode(passphrase.normalize('NFKD'));
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x31435642, 0);
  header.writeUInt32LE(shardCount, 4);
  header.writeUInt32LE(workers, 8);
  header.writeUInt32LE(password.length, 12);
  header.writeUInt32LE(0, 16);
  const input = Buffer.alloc(header.length + password.length + (shardCount * 32));
  header.copy(input, 0);
  input.set(password, header.length);
  for (let index = 0; index < shardCount; index += 1) {
    input.set(await createShardSalt(name, index, shardCount), header.length + password.length + (index * 32));
  }

  const child = spawnSync(executable, [], {
    input,
    maxBuffer: Math.max(1024 * 1024, shardCount * 64),
  });
  password.fill(0);
  input.fill(0);
  if (child.status !== 0) {
    throw new Error(`BRAINVAULT_NEON_FAILED:${String(child.status)}:${child.stderr.toString().trim()}`);
  }
  if (child.stdout.length !== shardCount * BRAINVAULT_V1.SHARD_OUTPUT_BYTES) {
    throw new Error(`BRAINVAULT_NEON_OUTPUT_INVALID:${child.stdout.length}`);
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

async function derive(name: string, passphrase: string, shardInput: number, workers = 64, options: DeriveOptions = {}) {
  const {
    useWasm = false,
    useNative = false,
    useNeon = false,
    showDevice = false,
    showPrivateKey = false,
    addressCount = 5,
    shardMultiplier = 1,
  } = options;

  assertBrainVaultName(name);
  assertBrainVaultPassphrase(passphrase);

  if (!Number.isSafeInteger(shardInput) || shardInput < 1) {
    throw new Error(`BRAINVAULT_SHARD_COUNT_INVALID:${shardInput}`);
  }
  if (!Number.isSafeInteger(workers) || workers < 1) {
    throw new Error(`BRAINVAULT_WORKER_COUNT_INVALID:${workers}`);
  }

  const isPreset = shardInput >= 1 && shardInput <= 5;
  const shardCount = isPreset ? getShardCount(shardInput) : shardInput;
  const factor = isPreset ? shardInput : factorForShardCount(shardCount);
  const kdfAlgId = shardMultiplier === 1 ? BRAINVAULT_V1.ALG_ID : `${BRAINVAULT_V1.ALG_ID}|custom`;
  const shardMemoryKb = BRAINVAULT_V1.SHARD_MEMORY_KB * shardMultiplier;

  // Cap workers at shard count (no point having more workers than shards)
  const actualWorkers = Math.min(workers, shardCount);

  const shardResults: Uint8Array[] = new Array(shardCount);

  const start = Date.now();
  const neonExecutable = resolveNeonExecutable();
  const selectNeon = useNeon || (
    !useWasm
    && !useNative
    && shardMultiplier === 1
    && shardCount >= 100
    && neonExecutable !== undefined
  );
  if (useNeon && (neonExecutable === undefined || shardMultiplier !== 1)) {
    throw new Error('BRAINVAULT_NEON_UNAVAILABLE: requires Apple Silicon, bundled binary, and shard-multiplier=1');
  }

  let usedNeon = false;
  if (selectNeon) {
    console.log(`Using bundled Apple Silicon C/NEON (${actualWorkers} workers)`);
    try {
      const nativeShards = await deriveNeonShards(neonExecutable!, name, passphrase, shardCount, actualWorkers);
      for (let index = 0; index < shardCount; index += 1) shardResults[index] = nativeShards[index]!;
      usedNeon = true;
    } catch (error) {
      if (useNeon) throw error;
      console.warn(`C/NEON unavailable at runtime; using portable native fallback (${String(error)}).`);
    }
  }

  if (!usedNeon) {
    let completed = 0;
    let nextShard = 0;
    let failed = false;
    const workerPath = import.meta.dir + (useWasm ? '/worker-wasm.ts' : '/worker-native.ts');
    const pool: Worker[] = [];

    if (useWasm) {
      console.log('Using hash-wasm (WASM) - slower but browser-compatible');
    }

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

      w.on('message', ({ specId, shardIndex, result }) => {
        if (failed) return;
        if (specId !== BRAINVAULT_V1_SPEC_ID) {
          fail(new Error(
            `BRAINVAULT_WORKER_SPEC_MISMATCH:${String(specId)}:${BRAINVAULT_V1_SPEC_ID}`,
          ));
          return;
        }
        if (!Number.isSafeInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
          fail(new Error(`BRAINVAULT_WORKER_SHARD_INDEX_INVALID:${shardIndex}`));
          return;
        }
        if (shardResults[shardIndex] !== undefined) {
          fail(new Error(`BRAINVAULT_WORKER_SHARD_DUPLICATE:${shardIndex}`));
          return;
        }
        if (typeof result !== 'string' || result.length !== BRAINVAULT_V1.SHARD_OUTPUT_BYTES * 2) {
          fail(new Error(`BRAINVAULT_WORKER_RESULT_INVALID:${shardIndex}`));
          return;
        }
        try {
          shardResults[shardIndex] = hexToBytes(result);
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
          const bar = '█'.repeat(filled) + '░'.repeat(40 - filled);
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
  }

  const derivationTime = Date.now() - start;
  const masterKey = await combineShardsWithParams(shardResults, factor, {
    algId: kdfAlgId,
    shardMemoryKb,
  });

  // Derive TWO wallets from one masterKey
  const entropy24 = await deriveKey(masterKey, 'bip39/entropy/v1.0', 32);
  const mnemonic24 = await entropyToMnemonic(entropy24);
  const matrix24 = await deriveEthereumAddressMatrix(mnemonic24, '', addressCount);
  const ethAddr24 = matrix24.standard[0]!;
  const privKey24 = showPrivateKey
    ? await deriveEthereumPrivateKeyAtPath(mnemonic24, "m/44'/60'/0'/0/0")
    : undefined;

  const entropy12 = await deriveKey(masterKey, 'bip39/entropy-128/v1.0', 16);
  const mnemonic12 = await entropyToMnemonic(entropy12);
  const matrix12 = await deriveEthereumAddressMatrix(mnemonic12, '', addressCount);
  const ethAddr12 = matrix12.standard[0]!;
  const privKey12 = showPrivateKey
    ? await deriveEthereumPrivateKeyAtPath(mnemonic12, "m/44'/60'/0'/0/0")
    : undefined;

  const devicePass = bytesToHex(await deriveKey(masterKey, 'bip39/passphrase/v1.0', 32));

  return {
    name, shardCount, workers, derivationTime, shardMultiplier, addressCount,
    mnemonic24, ethAddr24,
    standardAddrs24: matrix24.standard,
    ledgerLiveAddrs24: matrix24.ledgerLive,
    ...(showPrivateKey ? { privateKey24: privKey24 } : {}),
    mnemonic12, ethAddr12,
    standardAddrs12: matrix12.standard,
    ledgerLiveAddrs12: matrix12.ledgerLive,
    ...(showPrivateKey ? { privateKey12: privKey12 } : {}),
    ...(showDevice ? { devicePass, masterKey: bytesToHex(masterKey) } : {}),
  };
}


// ============================================================================
// BENCHMARK
// ============================================================================

async function runBenchmark(smoke = false) {
  const shardCount = smoke ? 2 : 1_000;
  const defaultWorkers = Math.min(32, getHardwarePlan(shardCount, 1).recommendedWorkers);
  const workerFlag = args.find(argument => argument.startsWith('--w='));
  const workers = workerFlag ? Number(workerFlag.slice('--w='.length)) : defaultWorkers;
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 32) {
    throw new Error(`Benchmark workers must be an integer in 1..32: ${String(workers)}`);
  }

  const benchmarkPath = `${import.meta.dir}/experimental/benchmark.ts`;
  if (!existsSync(benchmarkPath)) throw new Error('BRAINVAULT_BENCHMARK_HARNESS_MISSING');

  type BenchmarkBackend = Readonly<{ id: string; label: string; executable?: string }>;
  const benchmarkNeonExecutable = resolveNeonExecutable();
  const candidates: BenchmarkBackend[] = [
    {
      id: 'c-neon',
      label: 'C/NEON final wipe',
      executable: benchmarkNeonExecutable ?? '__unavailable__',
    },
    {
      id: 'c-neon-wipe',
      label: 'C/NEON per-shard wipe',
      executable: benchmarkNeonExecutable ?? '__unavailable__',
    },
    { id: 'direct-async', label: 'Native direct async (experimental)' },
    { id: 'sync', label: 'Native sync isolated' },
    { id: 'baseline', label: 'Native production' },
    {
      id: 'rust-pool',
      label: 'Rust pool secure',
      executable: `${import.meta.dir}/experimental/argon2-rust/target/release/brainvault-argon2-rust`,
    },
    {
      id: 'rust-pool-no-wipe',
      label: 'Rust pool final wipe',
      executable: `${import.meta.dir}/experimental/argon2-rust/target-no-wipe/release/brainvault-argon2-rust`,
    },
    { id: 'wasm', label: 'TypeScript/WASM' },
  ];
  const available = candidates.filter(candidate => candidate.executable === undefined || existsSync(candidate.executable));
  const estimatedSeconds = smoke
    ? 'a few seconds'
    : available.length <= 4 ? 'about 30 seconds' : 'about one minute';
  console.log(smoke ? 'BrainVault backend smoke test' : 'BrainVault canonical backend benchmark');
  console.log(`${shardCount.toLocaleString('en-US')} shards · factor ${factorForShardCount(shardCount)} · multiplier 1 · ${workers} workers`);
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
  console.log(`${'Engine'.padEnd(labelWidth)}  Time      Shards/s  vs fastest`);
  console.log(`${'-'.repeat(labelWidth)}  --------  --------  ----------`);
  for (const result of sorted) {
    console.log(
      `${result.label.padEnd(labelWidth)}  ${(result.derivationTimeMs / 1000).toFixed(3).padStart(7)}s  `
      + `${result.shardsPerSecond.toFixed(2).padStart(8)}  ${(result.derivationTimeMs / fastest).toFixed(2).padStart(8)}x`,
    );
  }
  console.log(`\nRoot parity: PASS (${results[0]!.root})`);
}

// ============================================================================
// INTERACTIVE MODE
// ============================================================================

async function interactive() {
  const rl = readline.createInterface({ input: stdin, output: process.stdout, terminal: true });

  console.log('BrainVault v1.0 - Memory-Hard Brain Wallet\n');
  console.log('WHY: Mnemonic backups are brittle (lose/steal). BrainVault: remember inputs, derive anywhere.');
  console.log('DESIGN: unlike classic brainwallets, every guess pays Argon2id memory cost.');
  console.log('SECURITY: each shard uses 256MB. Shards can run in parallel when RAM allows.\n');
  if (shardMultiplier > 1) {
    const memoryPerShardGb = (BRAINVAULT_V1.SHARD_MEMORY_KB * shardMultiplier) / (1024 * 1024);
    console.log(`CUSTOM MODE: shard-multiplier=${shardMultiplier} (${memoryPerShardGb.toFixed(2)}GB per shard)\n`);
  }

  const name = await rl.question('Username: ');
  if (requireRepeat) {
    const nameRepeat = await rl.question('Repeat Name: ');
    if (name !== nameRepeat) {
      console.log('Error: Name entries do not match');
      rl.close();
      return;
    }
  }

  const pass = await rl.question('Password: ');
  if (requireRepeat) {
    const passRepeat = await rl.question('Repeat Pass: ');
    if (pass !== passRepeat) {
      console.log('Error: Passphrase entries do not match');
      rl.close();
      return;
    }
  }

  if (!name || !pass) {
    console.log('Error: Invalid input');
    rl.close();
    return;
  }

  let shardInput = 4;
  let selectedMultiplier = shardMultiplier;

  if (askAdvanced) {
    console.log('\nFactor presets (or enter an exact shard count):');
    console.log('  1 →      1 shard');
    console.log('  2 →     10 shards');
    console.log('  3 →    100 shards');
    console.log('  4 →  1,000 shards  (recommended)');
    console.log('  5 → 10,000 shards');
    console.log('  6+ → exact shard count (e.g. 64, 256, 528)\n');
    shardInput = Number((await rl.question('Factor or exact shard count (4): ')).trim() || '4');
    if (!Number.isSafeInteger(shardInput) || shardInput < 1) {
      console.log('Error: factor/shards must be a positive integer');
      rl.close();
      return;
    }

    if (!hasShardMultiplierFlag) {
      const initialPlan = getHardwarePlan(shardInput <= 5 ? getShardCount(shardInput) : shardInput, 1);
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
  }

  const shardCount = shardInput <= 5 ? getShardCount(shardInput) : shardInput;
  const plan = getHardwarePlan(shardCount, selectedMultiplier);
  let workersInput = plan.recommendedWorkers;
  if (askAdvanced) {
    console.log(`\nCPU cores detected: ${plan.cpuCores}`);
    console.log(`System RAM: ${plan.totalGB}GB; ${plan.memoryPerWorkerGb.toFixed(2)}GB per worker`);
    console.log(`Recommended workers: ${plan.recommendedWorkers}\n`);
    workersInput = Number((await rl.question(`Parallel workers (${plan.recommendedWorkers}): `)).trim() || `${plan.recommendedWorkers}`);
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
  } else {
    console.log('\nRecommended defaults:');
    console.log(`  Factor: 4 (${shardCount.toLocaleString('en-US')} shards)`);
    console.log(`  Shard multiplier: ${selectedMultiplier}`);
    console.log(`  Workers: ${workersInput} (all available CPUs allowed by RAM)`);
    console.log('  Use --ask for advanced setup.');
  }

  rl.close();

  console.log(`\n${shardCount} shards × ${workersInput} workers\n`);
  console.log(recoveryRuleText(shardCount, selectedMultiplier));
  console.log(`Address matrix count: ${addressCount} standard + ${addressCount} Ledger Live\n`);

  try {
    const result = await derive(name, pass, shardInput, workersInput, {
      useWasm,
      useNative,
      useNeon,
      showPrivateKey,
      addressCount,
      shardMultiplier: selectedMultiplier,
    });

    console.log(`\n✅ ${formatDuration(result.derivationTime)}\n`);

    console.log('PRIMARY (24-word):');
    console.log(result.mnemonic24);
    for (let i = 0; i < result.standardAddrs24.length; i++) {
      console.log(`Address ${i + 1}:`, result.standardAddrs24[i]);
    }
    for (let i = 0; i < result.ledgerLiveAddrs24.length; i++) {
      console.log(`Ledger Live ${i + 1}:`, result.ledgerLiveAddrs24[i]);
    }
    if ('privateKey24' in result && result.privateKey24) {
      console.log('Private Key 1:', result.privateKey24);
    }

    console.log('\nSECONDARY (12-word):');
    console.log(result.mnemonic12);
    for (let i = 0; i < result.standardAddrs12.length; i++) {
      console.log(`Address ${i + 1}:`, result.standardAddrs12[i]);
    }
    for (let i = 0; i < result.ledgerLiveAddrs12.length; i++) {
      console.log(`Ledger Live ${i + 1}:`, result.ledgerLiveAddrs12[i]);
    }
    if ('privateKey12' in result && result.privateKey12) {
      console.log('Private Key 1:', result.privateKey12);
    }
  } catch (err) {
    console.error('Derivation failed:', err);
    process.exit(1);
  }
}

// ============================================================================
// PASSWORD MANAGER
// ============================================================================

async function derivePassword() {
  const rl = readline.createInterface({ input: stdin, output: process.stdout });

  console.log('BrainVault Password Manager\n');
  const name = await rl.question('Name: ');
  const pass = await rl.question('Pass: ');
  const shardInput = Number((await rl.question('Shards (3): ')).trim() || '3');

  if (!Number.isSafeInteger(shardInput) || shardInput < 1) {
    console.error('Error: Shards must be a positive integer');
    rl.close();
    return;
  }

  rl.close();

  console.log('\nDeriving master key...');
  const result = await derive(name, pass, shardInput, 1, {
    useWasm,
    useNative,
    useNeon,
    showDevice: true,
    shardMultiplier,
  });
  if (!result.masterKey) {
    throw new Error('Internal error: masterKey missing in password mode');
  }

  console.log('\n✅ Master key ready\n');

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
  await runBenchmark(args.includes('--smoke'));
} else if (args.includes('--password')) {
  await derivePassword();
} else if (args.length >= 3 && !args[0]?.startsWith('--')) {
  // Non-interactive: name pass shards [--w=N] [--lib=wasm|native] [--address-count=N] [--shard-multiplier=N]
  const [name, pass, shardStr] = args;
  const shards = Number(shardStr);
  if (!Number.isSafeInteger(shards) || shards < 1) {
    console.error(`Error: invalid shard count: ${shardStr}`);
    process.exit(1);
  }

  const wFlag = args.find(a => a.startsWith('--w='));
  const resolvedShardCount = shards <= 5 ? getShardCount(shards) : shards;
  const workers = wFlag ? Number(wFlag.split('=')[1]) : getHardwarePlan(resolvedShardCount, shardMultiplier).recommendedWorkers;
  if (!Number.isSafeInteger(workers) || workers < 1) {
    console.error(`Error: invalid worker count: ${wFlag?.split('=')[1] ?? ''}`);
    process.exit(1);
  }

  if (requireRepeat) {
    console.error('Note: --repeat is interactive-only and is ignored in non-interactive mode.');
  }

  const result = await derive(name!, pass!, shards, workers, {
    useWasm,
    useNative,
    useNeon,
    showPrivateKey,
    addressCount,
    shardMultiplier,
  });
  const output = {
    ...result,
    recoveryRule: recoveryRuleText(result.shardCount, shardMultiplier),
  };
  console.log(JSON.stringify(output, null, 2));
} else {
  await interactive();
}

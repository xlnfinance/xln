#!/usr/bin/env bun
/**
 * BrainVault CLI - Production wallet derivation
 *
 * Usage:
 *   bun brainvault.ts                           # Interactive
 *   bun brainvault.ts test secret123 100 --w=64 # Non-interactive (JSON output)
 *   bun brainvault.ts --test                    # Run deterministic tests
 *   bun brainvault.ts --bench                   # Benchmark performance
 *   bun brainvault.ts --lib=wasm                # Force hash-wasm (slower, compat check)
 *   bun brainvault.ts --lib=native              # Force @node-rs/argon2 (default, faster)
 *   bun brainvault.ts --repeat                  # Interactive: require double entry for name/pass
 *   bun brainvault.ts --shard-multiplier=4      # Custom KDF mode: 256MB * multiplier per shard
 *   bun brainvault.ts --address-count=5         # Number of standard + ledger-live addresses
 *   bun brainvault.ts --show-private-key        # Print raw key for Address 1 (high risk)
 *   bun brainvault.ts --help                    # Show usage/help
 */

import { stdin } from 'process';
import * as readline from 'readline/promises';
import { Worker } from 'worker_threads';
import {
  getShardCount, combineShardsWithParams, deriveKey, entropyToMnemonic,
  deriveEthereumAddressMatrix, deriveEthereumPrivateKeyAtPath,
  formatDuration, hexToBytes, bytesToHex, estimatePasswordStrength,
  BRAINVAULT_V1, deriveSitePassword,
} from './core.ts';

const args = process.argv.slice(2);
const showHelp = args.includes('--help') || args.includes('-h');

function printHelp(): void {
  console.log(`BrainVault CLI (bv)

What is BrainVault?
- Memory-hard deterministic wallet derivation from: Name + Passphrase + Shard settings.
- Uses Argon2id per-shard and BLAKE3 domain-separated combine.
- Same inputs => same master key, mnemonics, and addresses.

Usage:
- bun bv
- bun bv <name> <passphrase> <shards> [--w=N]
- bun bv --test
- bun bv --bench
- bun bv --password

Flags:
- --help, -h
  Show this help message.
- --test
  Run deterministic test vectors.
- --bench
  Benchmark derivation speed.
- --password
  Derive site-specific passwords from the master key.
- --lib=native
  Use @node-rs/argon2 worker (default).
- --lib=wasm
  Use hash-wasm worker (slower, compatibility/testing path).
- --w=N
  Number of parallel workers in non-interactive mode (default 64, capped by shard count).
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
- bun bv
- bun bv alice "correct horse battery staple" 100 --w=16
- bun bv alice "secret123456" 1 --address-count=10
- bun bv alice "secret123456" 100 --w=24 --shard-multiplier=50
- bun bv alice "secret123456" 1 --show-private-key

Recovery rule:
- You must use the exact same Name + Passphrase + Shard count + shard-multiplier
  to reproduce the same master key.

Compatibility:
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
const requireRepeat = args.includes('--repeat');
const showPrivateKey = args.includes('--show-private-key');

function getPositiveIntFlag(name: string, defaultValue: number): number {
  const flag = args.find(a => a.startsWith(`--${name}=`));
  if (!flag) return defaultValue;
  const raw = flag.split('=')[1] ?? '';
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`Error: invalid --${name} value: ${raw}. Expected a positive integer.`);
    process.exit(1);
  }
  return value;
}

const addressCount = getPositiveIntFlag('address-count', 5);
const shardMultiplier = getPositiveIntFlag('shard-multiplier', 1);

if (useWasm && useNative) {
  console.error('Error: cannot use both --lib=wasm and --lib=native');
  process.exit(1);
}

function recoveryRuleText(shardCount: number, shardMultiplierValue: number): string {
  return `Recovery rule: use the exact same Name + Passphrase + Shards (${shardCount}) + shard-multiplier (${shardMultiplierValue}) to reproduce the same master key.`;
}

// ============================================================================
// CORE DERIVATION
// ============================================================================

interface DeriveOptions {
  useWasm?: boolean;
  showDevice?: boolean;
  showPrivateKey?: boolean;
  addressCount?: number;
  shardMultiplier?: number;
}

async function derive(name: string, passphrase: string, shardInput: number, workers = 64, options: DeriveOptions = {}) {
  const {
    useWasm = false,
    showDevice = false,
    showPrivateKey = false,
    addressCount = 5,
    shardMultiplier = 1,
  } = options;

  const isPreset = shardInput >= 1 && shardInput <= 5;
  const shardCount = isPreset ? getShardCount(shardInput) : shardInput;
  const factor = isPreset ? shardInput : Math.ceil(Math.log10(shardCount)) + 1;
  const kdfAlgId = shardMultiplier === 1 ? BRAINVAULT_V1.ALG_ID : `${BRAINVAULT_V1.ALG_ID}|custom`;
  const shardMemoryKb = BRAINVAULT_V1.SHARD_MEMORY_KB * shardMultiplier;

  // Cap workers at shard count (no point having more workers than shards)
  const actualWorkers = Math.min(workers, shardCount);

  const shardResults: Uint8Array[] = new Array(shardCount);

  const start = Date.now();
  let completed = 0;
  let nextShard = 0;
  let failed = false;

  // Choose worker based on library
  const workerPath = import.meta.dir + (useWasm ? '/worker-wasm.ts' : '/worker-native.ts');
  const pool: Worker[] = [];

  if (useWasm) {
    console.log('Using hash-wasm (WASM) - slower but browser-compatible');
  }

  function safeTerminate(w: Worker) {
    try {
      w.terminate();
    } catch (e) {
      // Ignore
    }
  }

  await new Promise<void>((resolve, reject) => {
    let lastUpdate = 0;

    for (let i = 0; i < actualWorkers; i++) {
      const w = new Worker(workerPath);
      pool.push(w);

      w.on('error', (err) => {
        if (failed) return;
        failed = true;
        console.error('\nWorker error:', err);
        pool.forEach(safeTerminate);
        reject(err);
      });

      w.on('message', ({ shardIndex, result }) => {
        if (failed) return;
        shardResults[shardIndex] = hexToBytes(result);
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
          pool.forEach(safeTerminate);
          resolve();
        } else if (nextShard < shardCount) {
          w.postMessage({
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
// TESTS (deterministic vectors)
// ============================================================================

async function runTests() {
  console.log('Running deterministic tests...\n');

  const vectors = [
    {
      name: 'alice', pass: 'secret123456', shards: 1,
      expect: {
        mnemonic24: 'milk click novel require across cousin good chair street mouse crash movie same daughter air quote total pride crop mention focus sick slice hole',
        ethAddr24: '0x93bAb14eD871462D414a7c0357BF1a76DE741397',
      }
    },
    {
      name: 'bob', pass: 'password123', shards: 1,
      expect: {
        mnemonic24: 'lion shoot refuse toss scissors brass voice blame climb identify surface attack sing topic burden deer captain stone unit hood clarify scatter captain during',
        ethAddr24: '0x4A699A1F4061ceEbC83b9dC14d6A0c33eC3E2327',
      }
    },
  ];

  for (const v of vectors) {
    const result = await derive(v.name, v.pass, v.shards, 1);
    const match24 = result.mnemonic24 === v.expect.mnemonic24;
    const matchAddr = result.ethAddr24 === v.expect.ethAddr24;

    console.log(`Test: ${v.name}/${v.pass}/${v.shards} shards`);
    console.log(`  Mnemonic: ${match24 ? '✅' : '❌'}`);
    console.log(`  Address:  ${matchAddr ? '✅' : '❌'}`);
    if (!match24) console.log(`    Got: ${result.mnemonic24.split(' ').slice(0, 6).join(' ')}...`);
    if (!matchAddr) console.log(`    Got: ${result.ethAddr24}`);
    console.log('');

    if (!match24 || !matchAddr) process.exit(1);
  }

  console.log('✅ All tests passed');
}

// ============================================================================
// BENCHMARK
// ============================================================================

async function runBenchmark() {
  console.log('Benchmarking argon2id performance...\n');

  const configs = [
    { shards: 1, workers: 1 },
    { shards: 10, workers: 10 },
    { shards: 10, workers: 1 },
  ];

  for (const { shards, workers } of configs) {
    const result = await derive('bench', 'password', shards, workers, {
      useWasm,
      addressCount: 1,
      shardMultiplier,
    });
    const perShard = result.derivationTime / shards;
    const speedup = workers > 1 ? (perShard * shards / result.derivationTime) : 1;
    console.log(`${shards} shards × ${workers} workers: ${result.derivationTime}ms (${perShard.toFixed(0)}ms/shard, ${speedup.toFixed(1)}x speedup)`);
  }
}

// ============================================================================
// INTERACTIVE MODE
// ============================================================================

async function interactive() {
  const rl = readline.createInterface({ input: stdin, output: process.stdout, terminal: true });

  console.log('BrainVault v1.0 - Memory-Hard Brain Wallet\n');
  console.log('WHY: Mnemonic backups are brittle (lose/steal). BrainVault: remember inputs, derive anywhere.');
  console.log('HISTORY: brainwallet.io (MD5) → crackable; WarpWallet (scrypt) → never cracked; BrainVault (argon2id sharding)');
  console.log('SECURITY: 256MB per shard forces attackers to use RAM. Parallelizable on powerful hardware.\n');
  if (shardMultiplier > 1) {
    const memoryPerShardGb = (BRAINVAULT_V1.SHARD_MEMORY_KB * shardMultiplier) / (1024 * 1024);
    console.log(`CUSTOM MODE: shard-multiplier=${shardMultiplier} (${memoryPerShardGb.toFixed(2)}GB per shard)\n`);
  }

  const name = (await rl.question('Name: ')).trim();
  if (requireRepeat) {
    const nameRepeat = (await rl.question('Repeat Name: ')).trim();
    if (name !== nameRepeat) {
      console.log('Error: Name entries do not match');
      rl.close();
      return;
    }
  }

  const pass = (await rl.question('Pass: ')).trim();
  if (requireRepeat) {
    const passRepeat = (await rl.question('Repeat Pass: ')).trim();
    if (pass !== passRepeat) {
      console.log('Error: Passphrase entries do not match');
      rl.close();
      return;
    }
  }

  if (!name || !pass || pass.length < 6) {
    console.log('Error: Invalid input');
    rl.close();
    return;
  }

  console.log('\nShards (quick presets or any number):');
  console.log('  1 →      1 shard   (256MB)    ~0.2s');
  console.log('  2 →     10 shards  (2.5GB)    ~0.2s');
  console.log('  3 →    100 shards  (25GB)     ~1s');
  console.log('  4 →  1,000 shards  (256GB)    ~11s');
  console.log('  5 → 10,000 shards  (2.5TB)    ~2min');
  console.log('  6+ → any number (e.g., 64, 256, 528)\n');

  const shardInput = parseInt((await rl.question('Shards (100): ')).trim() || '100');
  const shardCount = shardInput >= 1 && shardInput <= 5 ? getShardCount(shardInput) : shardInput;

  // Calculate recommended workers (CPU cores, capped by RAM)
  const os = await import('os');
  const totalGB = Math.floor(os.totalmem() / (1024**3));
  const cpuCores = os.cpus().length;
  const memoryPerWorkerGb = 0.256 * shardMultiplier;
  const maxFromRAM = Math.floor((totalGB * 0.8) / memoryPerWorkerGb);
  const maxFromHW = Math.min(cpuCores, maxFromRAM);
  const recommended = Math.min(maxFromHW, shardCount);
  const bottleneck = recommended === shardCount ? `shard count (${shardCount})` : recommended === cpuCores ? `CPU cores (${cpuCores})` : `RAM (${totalGB}GB)`;

  console.log(`\nCPU cores detected: ${cpuCores}`);
  console.log(`System RAM: ${totalGB}GB → max ${maxFromRAM} workers from memory`);
  console.log(`Memory per worker: ${memoryPerWorkerGb.toFixed(2)}GB`);
  console.log(`Hardware capacity: ${maxFromHW} parallel workers`);
  console.log(`Recommended workers: ${recommended} (limited by ${bottleneck})\n`);

  const workersInput = parseInt((await rl.question(`Number of parallel workers (${recommended}): `)).trim() || `${recommended}`);

  rl.close();

  console.log(`\n${shardCount} shards × ${workersInput} workers\n`);
  console.log(recoveryRuleText(shardCount, shardMultiplier));
  console.log(`Address matrix count: ${addressCount} standard + ${addressCount} Ledger Live\n`);

  try {
    const result = await derive(name, pass, shardInput, workersInput, {
      useWasm,
      showPrivateKey,
      addressCount,
      shardMultiplier,
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
  const shardInput = parseInt((await rl.question('Shards (3): ')).trim() || '3');

  rl.close();

  console.log('\nDeriving master key...');
  const result = await derive(name, pass, shardInput, 1, {
    useWasm,
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

if (args.includes('--test')) {
  await runTests();
} else if (args.includes('--bench')) {
  await runBenchmark();
} else if (args.includes('--password')) {
  await derivePassword();
} else if (args.length >= 3 && !args[0]?.startsWith('--')) {
  // Non-interactive: name pass shards [--w=N] [--lib=wasm|native] [--address-count=N] [--shard-multiplier=N]
  const [name, pass, shardStr] = args;
  const shards = parseInt(shardStr!, 10);
  if (!Number.isInteger(shards) || shards < 1) {
    console.error(`Error: invalid shard count: ${shardStr}`);
    process.exit(1);
  }

  const wFlag = args.find(a => a.startsWith('--w='));
  const workers = wFlag ? parseInt(wFlag.split('=')[1]!, 10) : 64;
  if (!Number.isInteger(workers) || workers < 1) {
    console.error(`Error: invalid worker count: ${wFlag?.split('=')[1] ?? ''}`);
    process.exit(1);
  }

  if (requireRepeat) {
    console.error('Note: --repeat is interactive-only and is ignored in non-interactive mode.');
  }

  const result = await derive(name!, pass!, shards, workers, {
    useWasm,
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

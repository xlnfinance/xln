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
 */

import { stdin } from 'process';
import * as readline from 'readline/promises';
import { Worker } from 'worker_threads';
import {
  getShardCount, combineShards, deriveKey, entropyToMnemonic,
  deriveEthereumAddress, formatDuration, hexToBytes, bytesToHex, estimatePasswordStrength,
  BRAINVAULT_V1, deriveSitePassword,
} from './core.ts';

const args = process.argv.slice(2);

// ============================================================================
// CORE DERIVATION
// ============================================================================

async function derive(name: string, passphrase: string, shardInput: number, workers = 64, useWasm = false, showDevice = false) {
  const isPreset = shardInput >= 1 && shardInput <= 5;
  const shardCount = isPreset ? getShardCount(shardInput) : shardInput;
  const factor = isPreset ? shardInput : Math.ceil(Math.log10(shardCount)) + 1;

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
          w.postMessage({ name, passphrase, shardIndex: nextShard++, shardCount });
        }
      });

      if (nextShard < shardCount) {
        w.postMessage({ name, passphrase, shardIndex: nextShard++, shardCount });
      }
    }
  });

  const derivationTime = Date.now() - start;
  const masterKey = await combineShards(shardResults, factor);

  // Derive TWO wallets from one masterKey
  const entropy24 = await deriveKey(masterKey, 'bip39/entropy/v1.0', 32);
  const mnemonic24 = await entropyToMnemonic(entropy24);
  const ethAddr24 = await deriveEthereumAddress(mnemonic24);

  const entropy12 = await deriveKey(masterKey, 'bip39/entropy-128/v1.0', 16);
  const mnemonic12 = await entropyToMnemonic(entropy12);
  const ethAddr12 = await deriveEthereumAddress(mnemonic12);

  const devicePass = bytesToHex(await deriveKey(masterKey, 'bip39/passphrase/v1.0', 32));

  return {
    name, shardCount, workers, derivationTime,
    mnemonic24, ethAddr24,
    mnemonic12, ethAddr12,
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
    const match24 = result.mnemonic === v.expect.mnemonic;
    const matchAddr = result.ethAddr === v.expect.ethAddr;

    console.log(`Test: ${v.name}/${v.pass}/${v.shards} shards`);
    console.log(`  Mnemonic: ${match24 ? '✅' : '❌'}`);
    console.log(`  Address:  ${matchAddr ? '✅' : '❌'}`);
    if (!match24) console.log(`    Got: ${result.mnemonic.split(' ').slice(0, 6).join(' ')}...`);
    if (!matchAddr) console.log(`    Got: ${result.ethAddr}`);
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
    const result = await derive('bench', 'password', shards, workers);
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

  const name = (await rl.question('Name: ')).trim();
  const pass = (await rl.question('Pass: ')).trim();

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
  const maxFromRAM = Math.floor((totalGB * 0.66) / 0.256);
  const recommended = Math.min(cpuCores, maxFromRAM, shardCount);

  console.log(`\nCPU cores detected: ${cpuCores}`);
  console.log(`System RAM: ${totalGB}GB`);
  console.log(`Recommended workers: ${recommended} (optimal for this hardware)\n`);

  const workersInput = parseInt((await rl.question(`Number of parallel workers (${recommended}): `)).trim() || `${recommended}`);

  rl.close();

  console.log(`\n${shardCount} shards × ${workersInput} workers\n`);

  try {
    const result = await derive(name, pass, shardInput, workersInput);

    console.log(`\n✅ ${formatDuration(result.derivationTime)}\n`);

    console.log('PRIMARY (24-word):');
    console.log(result.mnemonic24);
    console.log('Address:', result.ethAddr24);

    console.log('\nSECONDARY (12-word):');
    console.log(result.mnemonic12);
    console.log('Address:', result.ethAddr12);
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
  const result = await derive(name, pass, shardInput, 1);

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

const useWasm = args.includes('--lib=wasm');
const useNative = args.includes('--lib=native');

if (useWasm && useNative) {
  console.error('Error: Cannot use both --lib=wasm and --lib=native');
  process.exit(1);
}

if (args.includes('--test')) {
  await runTests();
} else if (args.includes('--bench')) {
  await runBenchmark();
} else if (args.includes('--password')) {
  await derivePassword();
} else if (args.length >= 3 && !args[0]?.startsWith('--')) {
  // Non-interactive: name pass shards [--w=N] [--lib=wasm|native]
  const [name, pass, shardStr] = args;
  const shards = parseInt(shardStr!);
  const wFlag = args.find(a => a.startsWith('--w='));
  const workers = wFlag ? parseInt(wFlag.split('=')[1]!) : 64;

  const result = await derive(name!, pass!, shards, workers, useWasm);
  console.log(JSON.stringify(result, null, 2));
} else {
  await interactive();
}

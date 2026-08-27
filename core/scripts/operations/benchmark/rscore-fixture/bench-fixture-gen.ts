#!/usr/bin/env bun

/**
 * Deterministic benchmark fixture builder.
 * One H1 Runtime, one H1 Entity, N peer Account IDs.
 * Peers registered as signers in H1 Runtime; no peer EntityReplicas or peer Runtime.
 *
 * Canonical peer identity: deriveManagedEntityIdentity with seed+signerLabel.
 * Signed Account inputs/ACKs built using signDigest() with registered peer keys.
 *
 * Tiers: smoke(8), medium(1024), heavy(10000)
 * Output: .logs/bench-{label}-a{N}-p{N}/
 */

import { execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const LOGS_DIR = resolve(import.meta.dir, '../../../../../.logs');

const CLI = process.execPath;
const BUILDER = 'core/scripts/operations/hlt/replay/build-single-entity-native-recording.ts';
const QUIET_ENV = { ...process.env, XLN_LOG_LEVEL: 'warn' };

type Tier = Readonly<{
  label: string;
  accounts: number;
  payments: number;
  paymentBatch: number;
  peerSetupBatch: number;
}>;

const TIERS: Record<string, Tier> = {
  smoke:   { label: 'smoke',   accounts: 8,    payments: 100,   paymentBatch: 16,  peerSetupBatch: 8 },
  medium:  { label: 'medium',  accounts: 1024, payments: 1024,  paymentBatch: 128, peerSetupBatch: 64 },
  heavy:   { label: 'heavy',   accounts: 10000,payments: 10000, paymentBatch: 128, peerSetupBatch: 64 },
};

const dirFor = (t: Tier) =>
  resolve(LOGS_DIR, `bench-${t.label}-a${t.accounts}-p${t.payments}`);

const generate = (tier: Tier): { ok: boolean; dir: string; ms: number; error?: string } => {
  const dir = dirFor(tier);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const args = [
    BUILDER,
    '--output-dir', dir,
    '--payments', String(tier.payments),
    '--peers', String(tier.accounts),
    '--payment-batch-size', String(tier.paymentBatch),
    '--peer-setup-batch', String(tier.peerSetupBatch),
    '--no-swap',
  ];

  const timeout = tier.label === 'heavy' ? 900_000 : 600_000;
  const started = performance.now();
  try {
    console.error(`\nBENCH_GEN ${tier.label} a=${tier.accounts} p=${tier.payments} timeout=${timeout / 1000}s`);
    const result = execSync([CLI, ...args].join(' '), {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      env: QUIET_ENV,
    });
    // Print the paths JSON line (last line of stdout)
    const lines = result.trim().split('\n');
    const jsonLine = lines.findLast(l => l.startsWith('{'));
    if (jsonLine) console.error('BENCH_GEN_OK', jsonLine.slice(0, 200));
    return { ok: true, dir, ms: Math.round(performance.now() - started) };
  } catch (err: any) {
    const stderr = err?.stderr ? String(err.stderr).slice(-500) : String(err);
    return { ok: false, dir, ms: Math.round(performance.now() - started), error: stderr };
  }
};

if (import.meta.main) {
  const requested = process.argv.filter(a => a === 'smoke' || a === 'medium' || a === 'heavy');
  if (requested.length === 0) {
    console.error('Usage: bun bench-fixture-gen.ts [smoke] [medium] [heavy]');
    process.exit(1);
  }
  for (const name of requested) {
    const tier = TIERS[name];
    if (!tier) continue;
    const r = generate(tier);
    console.error(`RESULT ${name} ok=${r.ok} ms=${r.ms}${r.error ? ' ERROR' : ''}`);
  }
}

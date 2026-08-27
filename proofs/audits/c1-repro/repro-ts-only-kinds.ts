/**
 * C1 audit reproducer — boundary finding #3 (report.md «Найденные/задокументированные
 * асимметрии», п.3): TS-only tx kinds.
 *
 * Historical state (commit dfd45cc7c, the state the C1 report fuzzed):
 *   TS  `canonicalAccountTxForFrameHash` hashes ANY tx kind passthrough
 *       (`{type, data}`), including `lending_fund`, `request_collateral`,
 *       `reserve_to_collateral`.
 *   Rust `canonical_tx_value` returns `StateError::UnsupportedFrameTx(kind)` for
 *       kinds it does not model (`request_collateral` has no Rust enum variant
 *       at all; the other two exist but are not frame-hashable).
 *   => a frame with such a tx is hashable in TS and never reproducible in Rust.
 *       Confirmed by committed corpus cases (class ts-only).
 *
 * Current state (FX-2, proofs/fixes.md D3 — landing in parallel with this audit):
 *   admission + preflight reject out-of-profile kinds loudly in TS; the frame-hash
 *   layer keeps them hashable on purpose so committed historical frames stay
 *   verifiable. If run.ts-level ts-only cases start failing, that is the fix
 *   closing admission, not absence of the historical asymmetry.
 *
 * Usage (bun):
 *   bun proofs/audits/c1-repro/repro-ts-only-kinds.ts \
 *     [--root <repo-tree>] [--binary <enc-diff-rust>]
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const argValue = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback;
};
const ROOT = resolve(argValue('root', resolve(import.meta.dir, '..', '..', '..')));
const BINARY = resolve(argValue('binary', resolve(ROOT, 'proofs/fuzz/enc-diff/enc-diff-rust/target/release/enc-diff-rust')));

// Wire data copied verbatim from the committed corpus seeds (seed-tx-lending-fund,
// seed-tx-request-collateral, seed-tx-reserve-to-collateral).
const PROBES: { id: string; kind: string; class: string; txKind: string; data: Record<string, unknown> }[] = [
  {
    id: 'probe-lending-fund',
    kind: 'tx',
    class: 'ts-only',
    txKind: 'lending_fund',
    data: {
      positionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      hubEntityId: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      lenderEntityId: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      tokenId: 1,
      amount: '5',
      termId: 'one_hour',
      interestBps: 100,
    },
  },
  {
    id: 'probe-request-collateral',
    kind: 'tx',
    class: 'ts-only',
    txKind: 'request_collateral',
    data: { tokenId: 1, amount: '7', feeTokenId: 2, feeAmount: '1', policyVersion: 3 },
  },
  {
    id: 'probe-reserve-to-collateral',
    kind: 'tx',
    class: 'ts-only',
    txKind: 'reserve_to_collateral',
    data: {
      tokenId: 1,
      collateral: '5',
      ondelta: '0',
      side: 'receiving',
      blockNumber: 1,
      transactionHash: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    },
  },
];

const { canonicalAccountTxForFrameHash } = await import(
  pathToFileURL(resolve(ROOT, 'core/account/consensus/frame/hash.ts')).href
);
const { encodeAccountStateValue } = await import(
  pathToFileURL(resolve(ROOT, 'core/account/commitment/account-state-value.ts')).href
);

// Same field coercion run.ts applies (BIGINT_FIELDS for these kinds).
const BIGINT_FIELDS: Record<string, string[]> = {
  lending_fund: ['amount'],
  request_collateral: ['amount', 'feeAmount'],
  reserve_to_collateral: ['collateral', 'ondelta'],
};
const buildData = (kind: string, data: Record<string, unknown>): Record<string, unknown> => {
  const bigints = new Set(BIGINT_FIELDS[kind] ?? []);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = bigints.has(key) ? BigInt(value as string) : value;
  }
  return out;
};

console.log(`TS tree under test: ${ROOT}`);
const probe = mkdtempSync(resolve(tmpdir(), 'c1-repro-kinds-'));
try {
  for (const p of PROBES) {
    writeFileSync(resolve(probe, `${p.id}.json`), JSON.stringify(p));
    try {
      const canonical = canonicalAccountTxForFrameHash({ type: p.txKind, data: buildData(p.txKind, p.data) });
      const hex = `0x${Buffer.from(encodeAccountStateValue(canonical)).toString('hex')}`;
      console.log(`TS  ${p.txKind.padEnd(22)} -> ENCODED ${hex.slice(0, 96)}${hex.length > 96 ? '…' : ''}`);
    } catch (error) {
      console.log(`TS  ${p.txKind.padEnd(22)} -> REJECTED ${(error as Error).message.slice(0, 96)}`);
    }
  }
  const out = spawnSync(BINARY, [probe], { encoding: 'utf8' });
  for (const line of out.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as { file: string; result: string; error?: string };
    const kind = parsed.file.replace('probe-', '').replace('.json', '').replaceAll('-', '_');
    console.log(`RUST ${kind.padEnd(22)} -> ${parsed.result.toUpperCase()}${parsed.error ? ` ${parsed.error}` : ''}`);
  }
  if (out.status !== 0) console.log(`RUST driver exit ${out.status}: ${out.stderr.slice(0, 400)}`);
} finally {
  rmSync(probe, { recursive: true, force: true });
}

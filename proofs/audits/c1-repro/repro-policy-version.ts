/**
 * C1 audit reproducer — boundary finding #2 (report.md "Found/documented
  * asymmetries", item 2): `rebalance_policy.policyVersion > 2^53-1`.
 *
 * Historical state (commit dfd45cc7c, i.e. the state the C1 report fuzzed):
 *   TS  `canonicalAccountTxForFrameHash` is a passthrough — it hashes whatever
 *       JS `number` it was given via `String(n)`, silently rounding anything
 *       above 2^53. Two DIFFERENT policy versions (2^53 and 2^53+1) produce
 *       IDENTICAL canonical bytes: silent value distortion before the hash.
 *   Rust `canonical_tx_value` refuses (`CanonicalNumber` UnsafeInteger range
 *       via `try_from_u64`; engine frame/hash.rs MAX_POLICY_VERSION).
 *   => a frame carrying such a tx hashes in TS but can never be reproduced by
 *      a Rust node. Real asymmetry, confirmed by the committed corpus case
 *      `seed-tx-policy-unsafe-version` (class rust-rejects).
 *
 * Current state (FX-1, proofs/fixes.md D2 — landing in parallel with this audit):
 *   TS throws a typed admission error (`ACCOUNT_TX_POLICY_VERSION_OUT_OF_RANGE`)
 *       from core/account/tx/admission-policy.ts plus a tripwire inside
 *       canonicalAccountTxForFrameHash; Rust reports its own typed range error.
 *   => asymmetry closed on both sides; a failed run of this reproducer on the
 *      live tree showing the typed TS reject is the FIX, not absence of the
 *      historical behavior.
 *
 * Usage (bun):
 *   bun proofs/audits/c1-repro/repro-policy-version.ts \
 *     [--root <repo-tree>] [--binary <enc-diff-rust>]
 *
 *   historical: --root /tmp/c1-faithful  (git archive extract of dfd45cc7c)
 *               --binary /tmp/c1-faithful/proofs/fuzz/enc-diff/enc-diff-rust/target/release/enc-diff-rust
 *   current:    (no args — live tree + prebuilt binary)
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

// ── 1. TypeScript side ───────────────────────────────────────────────────────
const { canonicalAccountTxForFrameHash } = await import(
  pathToFileURL(resolve(ROOT, 'core/account/consensus/frame/hash.ts')).href
);
const { encodeAccountStateValue } = await import(
  pathToFileURL(resolve(ROOT, 'core/account/commitment/account-state-value.ts')).href
);

const hexOf = (tx: unknown): string => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const canonical = canonicalAccountTxForFrameHash(tx as any);
  return `0x${Buffer.from(encodeAccountStateValue(canonical)).toString('hex')}`;
};

const build = (versionText: string): unknown => ({
  type: 'rebalance_policy',
  data: {
    tokenId: 7,
    policyVersion: Number(versionText), // corpus wire carries the decimal text; run.ts converts the same way
    baseFee: 1n,
    liquidityFeeBps: 2n,
    gasFee: 3n,
  },
});

console.log(`TS tree under test: ${ROOT}`);
const V52 = '9007199254740992'; // 2^53   (MAX_SAFE_INTEGER + 1)
const V52P1 = '9007199254740993'; // 2^53+1 (NOT representable as a JS number)
console.log(`Number('${V52P1}') rendered by JS String(): ${String(Number(V52P1))} (silent rounding)`);
for (const text of [V52, V52P1]) {
  try {
    console.log(`TS  policyVersion=${text} -> ENCODED ${hexOf(build(text))}`);
  } catch (error) {
    console.log(`TS  policyVersion=${text} -> REJECTED ${(error as Error).message}`);
  }
}
try {
  const a = hexOf(build(V52));
  const b = hexOf(build(V52P1));
  console.log(
    a === b
      ? 'TS  DISTORTION: 2^53 and 2^53+1 hash to IDENTICAL canonical bytes (historical silent-hash confirmed)'
      : 'TS  bytes differ (unexpected for double rendering)',
  );
} catch {
  console.log('TS  no bytes: typed rejection active (FX-1 fix state)');
}

// ── 2. Rust side (single-case corpus through the same driver the harness uses) ─
const probe = mkdtempSync(resolve(tmpdir(), 'c1-repro-pv-'));
try {
  const caseFile = {
    id: 'probe-policy-version',
    kind: 'tx',
    class: 'rust-rejects',
    txKind: 'rebalance_policy',
    data: { tokenId: 7, policyVersion: V52, baseFee: '1', liquidityFeeBps: '2', gasFee: '3' },
  };
  mkdirSync(probe, { recursive: true });
  writeFileSync(resolve(probe, 'probe-policy-version.json'), JSON.stringify(caseFile));
  const out = spawnSync(BINARY, [probe], { encoding: 'utf8' });
  for (const line of out.stdout.split('\n')) {
    if (line.trim()) console.log(`RUST ${line}`);
  }
  if (out.status !== 0) console.log(`RUST driver exit ${out.status}: ${out.stderr.slice(0, 400)}`);
} finally {
  rmSync(probe, { recursive: true, force: true });
}

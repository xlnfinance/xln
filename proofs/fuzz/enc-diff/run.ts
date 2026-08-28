/**
 * C1 differential runner: TS encoders vs Rust enc-diff-rust over the corpus.
 *
 * For every case file it reconstructs the input from the shared tagged wire
 * schema (generate.ts), computes the TypeScript bytes, runs the Rust binary
 * once over the whole corpus, and compares per case class:
 *   both-encode : both sides succeed AND bytes (and radix counters) are equal
 *   both-reject : both sides reject (error presence; texts differ by design)
 *   rust-rejects / ts-only : TS encodes, Rust rejects (documented asymmetries)
 *
 * Any class violation or byte mismatch is auto-shrunk (structure drops and
 * scalar reductions that keep reproducing the failure) into minimized/.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { encodeAccountStateValue, encodeAccountStateValueOracle } from '../../../core/account/commitment/account-state-value';
import { computeCanonicalMerkleRoot } from '../../../core/account/commitment/state-root';
import { canonicalAccountTxForFrameHash } from '../../../core/account/consensus/frame/hash';
import {
  buildRadixMerkle,
  computeRadixMerkleBranchHashFromSlots,
  computeRadixMerkleEdgeHash,
  computeRadixMerkleLeafHash,
} from '../../../core/protocol/state/radix-merkle';
import { safeStringify } from '../../../core/protocol/serialization';
import { hexToBytes } from '../../../core/support/bytes/hex-bytes';

type Wire = { t: string; v?: unknown };
export type CaseFile = {
  id: string;
  kind: string;
  class: 'both-encode' | 'both-reject' | 'rust-rejects' | 'ts-only' | 'known-divergence';
  [key: string]: unknown;
};
type TsResult = { ok: true; hex: string; counters?: Record<string, number> } | { ok: false; error: string };
type RustResult = { file: string; result: 'ok' | 'error'; hex?: string; error?: string } & Record<string, unknown>;
export type SabotageMode = 'none' | 'content-hex' | 'class-inversion' | 'field-divergence';

const ROOT = resolve(import.meta.dir);
const BIN_DEFAULT = resolve(ROOT, 'enc-diff-rust/target/release/enc-diff-rust');

const args = process.argv.slice(2);
const argValue = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback;
};
const corpusDir = resolve(argValue('corpus', resolve(ROOT, 'corpus')));
const binary = resolve(argValue('binary', BIN_DEFAULT));
const minimizedDir = resolve(argValue('minimized', resolve(ROOT, 'minimized')));
const sabotageMode = argValue('sabotage', 'none') as SabotageMode;
if (!['none', 'content-hex', 'class-inversion', 'field-divergence'].includes(sabotageMode)) {
  throw new Error(`SABOTAGE_MODE_UNKNOWN:${sabotageMode}`);
}

// ── wire → JS value reconstruction ───────────────────────────────────────────
const buildValue = (wire: Wire): unknown => {
  switch (wire.t) {
    case 'null': return null;
    case 'bool': return wire.v === true;
    case 'num': {
      const value = Number(wire.v);
      // Sharp texts (-0, NaN, Infinity) reconstruct as the raw JS number.
      return value;
    }
    case 'bign': return BigInt(wire.v as string);
    case 'str': return wire.v as string;
    case 'arr': return (wire.v as Wire[]).map(buildValue);
    case 'set': return new Set((wire.v as Wire[]).map(buildValue));
    case 'map': return new Map((wire.v as [Wire, Wire][]).map(([k, v]) => [buildValue(k), buildValue(v)]));
    case 'obj': return Object.fromEntries(
      (wire.v as [string, Wire][]).map(([key, entry]) => [
        key,
        entry.t === 'undef' ? undefined : buildValue(entry),
      ]),
    );
    default: throw new Error(`WIRE_TAG_UNKNOWN:${wire.t}`);
  }
};

/**
 * Driver-level duplicate rejection. JS runtime values cannot carry duplicate
 * Map keys / Set members (SameValueZero) or duplicate object keys, but the
 * shared wire schema can: this stands in for the receiving boundary both
 * implementations enforce (Rust rejects inside its encoder).
 */
const assertNoDuplicates = (wire: Wire): void => {
  const walk = (node: Wire): void => {
    if (node.t === 'map') {
      const seen = new Set<string>();
      for (const [key] of node.v as [Wire, Wire][]) {
        const hex = Buffer.from(encodeAccountStateValue(buildValue(key))).toString('hex');
        if (seen.has(hex)) throw new Error(`DRIVER_DUPLICATE_MAP_KEY:${hex}`);
        seen.add(hex);
      }
    }
    if (node.t === 'set') {
      const seen = new Set<string>();
      for (const member of node.v as Wire[]) {
        const hex = Buffer.from(encodeAccountStateValue(buildValue(member))).toString('hex');
        if (seen.has(hex)) throw new Error(`DRIVER_DUPLICATE_SET_VALUE:${hex}`);
        seen.add(hex);
      }
    }
    if (node.t === 'obj') {
      const seen = new Set<string>();
      for (const [key] of node.v as [string, Wire][]) {
        if (seen.has(key)) throw new Error(`DRIVER_DUPLICATE_OBJECT_KEY:${key}`);
        seen.add(key);
      }
    }
    const children: Wire[] = node.t === 'arr' || node.t === 'set'
      ? (node.v as Wire[])
      : node.t === 'map'
        ? (node.v as [Wire, Wire][]).flatMap(([k, v]) => [k, v])
        : node.t === 'obj'
          ? (node.v as [string, Wire][]).map(([, v]) => v).filter((v) => v.t !== 'undef')
          : [];
    for (const child of children) walk(child);
  };
  walk(wire);
};

// ── tx wire → TS AccountTx ───────────────────────────────────────────────────
const BIGINT_FIELDS: Record<string, string[]> = {
  direct_payment: ['amount'],
  set_credit_limit: ['amount'],
  rebalance_policy: ['baseFee', 'liquidityFeeBps', 'gasFee'],
  swap_offer: ['giveAmount', 'wantAmount', 'maxFee', 'minNetReceive', 'priceTicks'],
  swap_resolve: [
    'fillNumerator', 'fillDenominator', 'feeAmount', 'executionGiveAmount', 'executionWantAmount',
    'restingPriceTicks', 'restingGiveAmount', 'restingWantAmount', 'restingQuantizedGive', 'restingQuantizedWant',
  ],
  htlc_lock: ['timelock', 'amount'],
  lending_fund: ['amount'],
  request_collateral: ['amount', 'feeAmount'],
};
const NUMERIC_STRING_FIELDS = new Set(['policyVersion']);

const buildTxData = (kind: string, data: Record<string, unknown>): Record<string, unknown> => {
  const bigints = new Set(BIGINT_FIELDS[kind] ?? []);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (bigints.has(key)) out[key] = BigInt(value as string);
    else if (NUMERIC_STRING_FIELDS.has(key) && typeof value === 'string') out[key] = Number(value);
    else out[key] = structuredClone(value);
  }
  return out;
};

// ── TS encoder execution per case ────────────────────────────────────────────
const toHex = (bytes: Uint8Array): string => `0x${Buffer.from(bytes).toString('hex')}`;
const normHex = (hex: string): string => (hex.startsWith('0x') ? hex : `0x${hex}`);

const computeTs = (testCase: CaseFile): TsResult => {
  try {
    switch (testCase.kind) {
      case 'value': {
        const wire = testCase.value as Wire;
        assertNoDuplicates(wire);
        const value = buildValue(wire);
        const fast = encodeAccountStateValue(value);
        const oracle = encodeAccountStateValueOracle(value);
        if (Buffer.from(fast).toString('hex') !== Buffer.from(oracle).toString('hex')) {
          return { ok: false, error: 'TS_FAST_WRITER_VS_ORACLE_MISMATCH' };
        }
        return { ok: true, hex: toHex(fast) };
      }
      case 'flat-root': {
        const entries = (testCase.entries as [string, Wire][]).map(([path, wire]) => {
          assertNoDuplicates(wire);
          return [path, buildValue(wire)] as const;
        });
        return { ok: true, hex: computeCanonicalMerkleRoot(testCase.namespace as string, entries, 'integrity') };
      }
      case 'radix-leaf':
        return {
          ok: true,
          hex: computeRadixMerkleLeafHash(
            hexToBytes(testCase.keyHex as string),
            hexToBytes(testCase.valueHex as string),
            'integrity',
          ),
        };
      case 'radix-branch': {
        const slots = (testCase.slots as (string | null)[]).map((slot) => slot ?? undefined);
        return { ok: true, hex: computeRadixMerkleBranchHashFromSlots(16, slots, 'integrity') };
      }
      case 'radix-extension': {
        const path = testCase.path as number[];
        return {
          ok: true,
          // computeRadixMerkleEdgeHash(16, [], 'branch', [dummy, ...path], h) hashes
          // extension16(path): the parent slice drops exactly the dummy slot.
          hex: computeRadixMerkleEdgeHash(16, [], 'branch', [0, ...path], testCase.childHex as string, 'integrity'),
        };
      }
      case 'radix-tree': {
        const leaves = (testCase.leaves as { keyHex: string; valueHex: string }[]).map((leaf) => ({
          key: hexToBytes(leaf.keyHex),
          value: hexToBytes(leaf.valueHex),
        }));
        const result = buildRadixMerkle(leaves, { radix: 16, hashAlgorithm: 'integrity' });
        return {
          ok: true,
          hex: result.root,
          counters: {
            depth: result.depth,
            leafCount: result.leafCount,
            branchCount: result.branchCount,
            extensionCount: result.extensionCount,
            maxDepth: result.maxDepth,
          },
        };
      }
      case 'tx': {
        const tx = {
          type: testCase.txKind as string,
          data: buildTxData(testCase.txKind as string, testCase.data as Record<string, unknown>),
        };
        const canonical = canonicalAccountTxForFrameHash(tx as never);
        return { ok: true, hex: toHex(encodeAccountStateValue(canonical)) };
      }
      default:
        return { ok: false, error: `CASE_KIND_UNKNOWN:${testCase.kind}` };
    }
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message ?? error) };
  }
};

// ── rust runner ──────────────────────────────────────────────────────────────
const runRust = (dir: string): Map<string, RustResult> => {
  const output = spawnSync(binary, [dir], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (output.status !== 0) {
    throw new Error(`rust driver failed (${output.status}): ${output.stderr.slice(0, 2000)}`);
  }
  const results = new Map<string, RustResult>();
  for (const line of output.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as RustResult;
    results.set(parsed.file, parsed);
  }
  return results;
};

// ── comparison ───────────────────────────────────────────────────────────────
type Failure = { file: string; reason: string; ts: TsResult; rust: RustResult; case: CaseFile };

const isFailure = (testCase: CaseFile, ts: TsResult, rust: RustResult): string | null => {
  const rustOk = rust.result === 'ok';
  if (testCase.class === 'both-encode') {
    if (!ts.ok) return `TS_ERROR:${ts.error}`;
    if (!rustOk) return `RUST_ERROR:${rust.error ?? 'unknown'}`;
    if (normHex(ts.hex) !== normHex(rust.hex!)) return 'BYTES_DIFFER';
    if (testCase.kind === 'radix-tree') {
      for (const [key, value] of Object.entries(ts.counters!)) {
        if (rust[key] !== value) return `COUNTER_DIFFER:${key}:ts=${value}:rust=${String(rust[key])}`;
      }
    }
    return null;
  }
  if (testCase.class === 'both-reject') {
    if (ts.ok) return 'TS_ACCEPTED_BUT_CLASS_BOTH_REJECT';
    if (rustOk) return 'RUST_ACCEPTED_BUT_CLASS_BOTH_REJECT';
    return null;
  }
  if (testCase.class === 'known-divergence') {
    if (!ts.ok) return `TS_ERROR:${ts.error}`;
    if (!rustOk) return `RUST_ERROR:${rust.error ?? 'unknown'}`;
    return normHex(ts.hex) === normHex(rust.hex!) ? 'KNOWN_DIVERGENCE_DISAPPEARED' : null;
  }
  // rust-rejects | ts-only: TS must encode, Rust must reject
  if (!ts.ok) return `TS_ERROR:${ts.error}`;
  if (rustOk) return `RUST_ACCEPTED_BUT_CLASS_${testCase.class.toUpperCase()}`;
  return null;
};

const rootWireEntries = (testCase: CaseFile): [string, Wire][] => {
  if (testCase.kind !== 'value') return [];
  const wire = testCase.value as Wire;
  return wire.t === 'obj' ? wire.v as [string, Wire][] : [];
};

export const sabotageApplies = (mode: SabotageMode, testCase: CaseFile): boolean => {
  if (mode === 'content-hex' && testCase.kind === 'value') {
    const wire = testCase.value as Wire;
    if (wire.t !== 'map') return false;
    const keys = (wire.v as [Wire, Wire][]).map(([key]) => `${key.t}:${String(key.v)}`);
    return keys.includes('num:1') && keys.includes('bign:1');
  }
  const entries = rootWireEntries(testCase);
  if (mode === 'class-inversion') {
    return testCase.class === 'both-reject' && entries.filter(([key]) => key === 'k').length === 2;
  }
  return mode === 'field-divergence'
    && entries.some(([key, wire]) => key === 'b' && wire.t === 'num' && wire.v === '1');
};

const corruptHex = (hex: string): string => `${hex.slice(0, -1)}${hex.endsWith('0') ? '1' : '0'}`;

const applySabotage = (testCase: CaseFile, rust: RustResult, mode: SabotageMode): RustResult => {
  if (mode === 'none' || !sabotageApplies(mode, testCase)) return rust;
  if (mode === 'class-inversion') return { ...rust, result: 'ok', hex: '0x00', error: undefined };
  if (rust.result !== 'ok') return rust;
  if (typeof rust.hex !== 'string') throw new Error(`RUST_OK_WITHOUT_BYTES:${mode}:${testCase.id}`);
  return { ...rust, hex: corruptHex(rust.hex) };
};

// ── shrinker ─────────────────────────────────────────────────────────────────
const valueCandidates = (wire: Wire): Wire[] => {
  const out: Wire[] = [];
  if (wire.t === 'arr' || wire.t === 'set') {
    const list = wire.v as Wire[];
    list.forEach((_, index) => out.push({ t: wire.t, v: list.filter((_, j) => j !== index) }));
    list.forEach((child, index) => {
      for (const mutated of valueCandidates(child)) {
        out.push({ t: wire.t, v: list.map((entry, j) => (j === index ? mutated : entry)) });
      }
    });
  } else if (wire.t === 'map') {
    const pairs = wire.v as [Wire, Wire][];
    pairs.forEach((_, index) => out.push({ t: 'map', v: pairs.filter((_, j) => j !== index) }));
    pairs.forEach(([key, value], index) => {
      for (const mutatedKey of valueCandidates(key)) {
        out.push({ t: 'map', v: pairs.map((pair, j) => (j === index ? [mutatedKey, pair[1]!] : pair)) });
      }
      for (const mutatedValue of valueCandidates(value)) {
        out.push({ t: 'map', v: pairs.map((pair, j) => (j === index ? [pair[0]!, mutatedValue] : pair)) });
      }
    });
  } else if (wire.t === 'obj') {
    const entries = wire.v as [string, Wire][];
    entries.forEach((_, index) => out.push({ t: 'obj', v: entries.filter((_, j) => j !== index) }));
    entries.forEach(([key, value], index) => {
      for (const mutated of valueCandidates(value)) {
        out.push({ t: 'obj', v: entries.map((entry, j) => (j === index ? [key, mutated] : entry)) });
      }
    });
  } else if (wire.t === 'str') {
    const text = wire.v as string;
    out.push({ t: 'str', v: text.slice(0, text.length >> 1) });
    out.push({ t: 'str', v: '' });
  } else if (wire.t === 'num') {
    out.push({ t: 'num', v: '0' });
  } else if (wire.t === 'bign') {
    out.push({ t: 'bign', v: '0' });
  }
  return out;
};

const caseCandidates = (testCase: CaseFile): CaseFile[] => {
  const out: CaseFile[] = [];
  const clone = (patch: Partial<CaseFile>): CaseFile => ({ ...testCase, ...patch });
  switch (testCase.kind) {
    case 'value':
      for (const mutated of valueCandidates(testCase.value as Wire)) out.push(clone({ value: mutated }));
      break;
    case 'flat-root': {
      const entries = testCase.entries as [string, Wire][];
      entries.forEach((_, index) => out.push(clone({ entries: entries.filter((_, j) => j !== index) })));
      entries.forEach(([path, wire], index) => {
        for (const mutated of valueCandidates(wire)) {
          out.push(clone({ entries: entries.map((entry, j) => (j === index ? [path, mutated] : entry)) }));
        }
        if (path.length > 1) out.push(clone({ entries: entries.map((entry, j) => (j === index ? [path.slice(0, 1), entry[1]] : entry)) }));
      });
      if ((testCase.namespace as string).length > 1) out.push(clone({ namespace: 'a' }));
      break;
    }
    case 'radix-tree': {
      const leaves = testCase.leaves as { keyHex: string; valueHex: string }[];
      leaves.forEach((_, index) => out.push(clone({ leaves: leaves.filter((_, j) => j !== index) })));
      break;
    }
    case 'radix-branch': {
      const slots = testCase.slots as (string | null)[];
      slots.forEach((slot, index) => {
        if (slot !== null) out.push(clone({ slots: slots.map((entry, j) => (j === index ? null : entry)) }));
      });
      break;
    }
    case 'radix-extension': {
      const path = testCase.path as number[];
      path.forEach((_, index) => out.push(clone({ path: path.filter((_, j) => j !== index) })));
      break;
    }
    case 'tx': {
      const data = testCase.data as Record<string, unknown>;
      for (const key of Object.keys(data)) {
        const shrunk: Record<string, unknown> = { ...data };
        delete shrunk[key];
        out.push(clone({ data: shrunk }));
        if (typeof data[key] === 'string' && (data[key] as string).length > 1) {
          out.push(clone({ data: { ...data, [key]: (data[key] as string).slice(0, 1) } }));
        }
        if (BIGINT_FIELDS[testCase.txKind as string]?.includes(key)) {
          out.push(clone({ data: { ...data, [key]: '0' } }));
        }
        if (Array.isArray(data[key])) {
          const list = data[key] as unknown[];
          list.forEach((_, index) => out.push(clone({ data: { ...data, [key]: list.filter((_, j) => j !== index) } })));
        }
        if (data[key] && typeof data[key] === 'object' && Array.isArray((data[key] as { nodes?: unknown[] }).nodes)) {
          const nodes = (data[key] as { nodes: unknown[] }).nodes;
          nodes.forEach((_, index) => out.push(clone({
            data: { ...data, [key]: { ...(data[key] as object), nodes: nodes.filter((_, j) => j !== index) } },
          })));
        }
      }
      break;
    }
    default:
      break;
  }
  return out.slice(0, 512);
};

const SHRINK_DIR = resolve(ROOT, '.shrink');
export const identifyShrinkCandidates = (
  candidates: CaseFile[],
  originId: string,
  round: number,
): CaseFile[] => {
  const safeOrigin = originId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return candidates.map((candidate, index) => ({
    ...candidate,
    id: `${safeOrigin}-r${round.toString().padStart(2, '0')}-c${index.toString().padStart(3, '0')}`,
  }));
};

export const failureSignature = (reason: string): string => {
  const parts = reason.split(':');
  return parts[0] === 'COUNTER_DIFFER' || parts[0] === 'TS_ERROR' || parts[0] === 'RUST_ERROR'
    ? parts.slice(0, 2).join(':')
    : parts[0]!;
};

const shrinkCheck = (cases: CaseFile[], mode: SabotageMode): Map<string, Failure | null> => {
  rmSync(SHRINK_DIR, { recursive: true, force: true });
  mkdirSync(SHRINK_DIR, { recursive: true });
  for (const testCase of cases) writeFileSync(resolve(SHRINK_DIR, `${testCase.id}.json`), safeStringify(testCase));
  const rust = runRust(SHRINK_DIR);
  const failures = new Map<string, Failure | null>();
  for (const testCase of cases) {
    const file = `${testCase.id}.json`;
    const rawRustResult = rust.get(file);
    if (!rawRustResult) throw new Error(`shrink: rust result missing for ${file}`);
    const rustResult = applySabotage(testCase, rawRustResult, mode);
    const ts = computeTs(testCase);
    const reason = isFailure(testCase, ts, rustResult);
    failures.set(file, reason
      ? { file, reason, ts, rust: rustResult, case: testCase }
      : null);
  }
  return failures;
};

const shrinkFailure = (failure: Failure, mode: SabotageMode): CaseFile => {
  let current = failure.case;
  for (let round = 0; round < 64; round += 1) {
    const candidates = identifyShrinkCandidates(
      caseCandidates(current).filter((candidate) => candidate.class === 'both-encode').slice(0, 96),
      failure.case.id,
      round,
    );
    if (candidates.length === 0) break;
    const batch = shrinkCheck(candidates, mode);
    const reproducing = candidates.find((candidate) => {
      const result = batch.get(`${candidate.id}.json`);
      return result !== null && result !== undefined
        && failureSignature(result.reason) === failureSignature(failure.reason);
    });
    if (!reproducing) break;
    current = reproducing;
  }
  return current;
};

// ── main ─────────────────────────────────────────────────────────────────────
const main = (): void => {
  if (!existsSync(binary)) {
    console.error(`rust binary missing: ${binary} (cargo build --release first)`);
    process.exit(2);
  }
  const files = readdirSync(corpusDir).filter((name) => name.endsWith('.json')).sort();
  if (files.length === 0) {
    console.error(`corpus empty: ${corpusDir}`);
    process.exit(2);
  }
  const cases = files.map((file) => {
    const testCase = JSON.parse(String(readFileSync(resolve(corpusDir, file), 'utf8'))) as CaseFile;
    return { ...testCase, id: testCase.id || basename(file, '.json') };
  });
  const rust = runRust(corpusDir);
  const tally = {
    cases: cases.length,
    byClass: {} as Record<string, { ok: number; failed: number }>,
    byKind: {} as Record<string, number>,
    byOutcome: {} as Record<string, number>,
    byTxKind: {} as Record<string, number>,
    failures: [] as Failure[],
  };
  for (const testCase of cases) {
    tally.byKind[testCase.kind] = (tally.byKind[testCase.kind] ?? 0) + 1;
    tally.byClass[testCase.class] ??= { ok: 0, failed: 0 };
    const rawRustResult = rust.get(`${testCase.id}.json`);
    if (!rawRustResult) {
      tally.byClass[testCase.class]!.failed += 1;
      tally.failures.push({
        file: testCase.id, reason: 'RUST_RESULT_MISSING', ts: { ok: false, error: 'n/a' },
        rust: { file: testCase.id, result: 'error', error: 'missing' }, case: testCase,
      });
      continue;
    }
    const rustResult = applySabotage(testCase, rawRustResult, sabotageMode);
    const ts = computeTs(testCase);
    const outcome = `${ts.ok ? 'ts-ok' : 'ts-reject'}/${rustResult.result === 'ok' ? 'rust-ok' : 'rust-reject'}`;
    tally.byOutcome[outcome] = (tally.byOutcome[outcome] ?? 0) + 1;
    if (testCase.kind === 'tx') {
      const txKey = `${String(testCase.txKind)}:${testCase.class}`;
      tally.byTxKind[txKey] = (tally.byTxKind[txKey] ?? 0) + 1;
    }
    const reason = isFailure(testCase, ts, rustResult);
    if (reason === null) tally.byClass[testCase.class]!.ok += 1;
    else {
      tally.byClass[testCase.class]!.failed += 1;
      tally.failures.push({ file: testCase.id, reason, ts, rust: rustResult, case: testCase });
    }
  }

  const sampleErrors: Record<string, string[]> = {};
  for (const testCase of cases) {
    if (testCase.class !== 'both-reject') continue;
    const rawRustResult = rust.get(`${testCase.id}.json`);
    const rustResult = rawRustResult ? applySabotage(testCase, rawRustResult, sabotageMode) : undefined;
    const ts = computeTs(testCase);
    const key = `${testCase.kind}`;
    (sampleErrors[key] ??= []).push(
      `ts=${ts.ok ? 'ok' : ts.error} rust=${rustResult?.result === 'ok' ? 'ok' : rustResult?.error}`,
    );
  }

  rmSync(minimizedDir, { recursive: true, force: true });
  let minimizedCount = 0;
  if (tally.failures.length > 0) {
    mkdirSync(minimizedDir, { recursive: true });
    for (const failure of tally.failures.slice(0, 20)) {
      const minimized = failure.case.class === 'both-encode'
        ? shrinkFailure(failure, sabotageMode)
        : failure.case;
      const id = `min-${failure.case.id}`;
      writeFileSync(resolve(minimizedDir, `${id}.json`), safeStringify(minimized, 2));
      minimizedCount += 1;
      console.error(`FAIL ${failure.file}: ${failure.reason}`);
      console.error(`  ts  : ${failure.ts.ok ? `${failure.ts.hex.slice(0, 96)}${failure.ts.hex.length > 96 ? '…' : ''}` : failure.ts.error}`);
      console.error(`  rust: ${failure.rust.result === 'ok' ? `${normHex(failure.rust.hex!).slice(0, 96)}…` : failure.rust.error}`);
    }
    if (tally.failures.length > 20) console.error(`…and ${tally.failures.length - 20} more failures`);
  }
  rmSync(SHRINK_DIR, { recursive: true, force: true });

  console.log(safeStringify({
    corpus: corpusDir,
    cases: tally.cases,
    byClass: tally.byClass,
    byKind: tally.byKind,
    byOutcome: tally.byOutcome,
    byTxKind: tally.byTxKind,
    failures: tally.failures.length,
    minimized: minimizedCount,
    sabotage: sabotageMode,
    bothRejectSamples: Object.fromEntries(
      Object.entries(sampleErrors).map(([kind, list]) => [kind, list.slice(0, 4)]),
    ),
  }, null, 2));
  process.exit(tally.failures.length > 0 ? 1 : 0);
};

if (import.meta.main) main();

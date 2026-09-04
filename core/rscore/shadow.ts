/**
 * Shadow mirror: replays every committed bilateral Account frame of the owning
 * entity into the Rust account engine and compares the per-account state root
 * (and the whole-tree accounts root) against the TypeScript authority.
 *
 * The mirror never influences consensus: it is fed fire-and-forget from the
 * frame-commit path, runs on its own queue, and on any internal failure
 * disables itself loudly. Divergences are counted and logged, never thrown
 * into the caller.
 *
 * Account lifecycle: the first time an account is seen (and after any frame
 * carrying txs outside the payment profile, or after a divergence) the mirror
 * reseeds it from the committed post-frame snapshot via UpsertAccounts, and
 * comparison resumes from the next frame.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createStructuredLogger } from '../support/logger';
import { computeAccountStateRoot, computeCanonicalMerkleRoot } from '../account/commitment/state-root';
import { canonicalAccountTxForFrameHash } from '../account/consensus/frame/hash';
import { computeEntityAccountValueHash, projectEntityAccountLeaf } from '../entity/consensus/state-root';
import { PersistentRadixValueMap } from '../protocol/state/persistent-radix-value-map';
import { safeStringify } from '../protocol/serialization';
import { requirePersistentAccountStateMap } from '../account/state/persistent-state-map';
import type { ApplyAccountTxOk } from '../account/tx/apply-types';
import type { AccountReplica, AccountState, AccountTx } from '../types/account';
import { PersistentEntityAccountMap } from '../entity/state/persistent-account-map';
import type { RuntimeState } from '../runtime/types';
import type { RscoreProcessClient, RscoreWireValue } from './client';
import { decodeRscoreCanonicalValue } from './canonical-wire';
import {
  shadowOutputRows,
  accountEnvelopeWire,
  accountSeedWire,
  accountTxWire,
  hexToWireBytes,
  shadowIneligibilityReason,
  swapMarketPolicyDigest,
  swapMarketPolicyWire,
  type ShadowOutputRow,
} from './shadow-wire';

const shadowLog = createStructuredLogger('rscore.shadow');

const wireTuple = (value: unknown, code: string, length?: number): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${code}:tuple`);
  if (length !== undefined && value.length !== length) {
    throw new Error(`${code}:arity:${value.length}:${length}`);
  }
  return value;
};

const wireBytes = (value: unknown, code: string, length?: number): Uint8Array => {
  if (!(value instanceof Uint8Array)) throw new Error(`${code}:bytes`);
  if (length !== undefined && value.byteLength !== length) {
    throw new Error(`${code}:length:${value.byteLength}:${length}`);
  }
  return value;
};

const wireText = (value: unknown, code: string): string => {
  if (typeof value !== 'string') throw new Error(`${code}:text`);
  return value;
};

const wireInteger = (value: unknown, code: string): number => {
  const integer = Number(value);
  if (!Number.isSafeInteger(integer) || integer < 0) throw new Error(`${code}:integer`);
  return integer;
};

const wireOptionalText = (value: unknown, code: string): string | null =>
  value === null ? null : wireText(value, code);

const decodeEngineOutput = (value: unknown): ShadowOutputRow => {
  const output = wireTuple(value, 'SHADOW_ENGINE_OUTPUT');
  const tag = wireInteger(output[0], 'SHADOW_ENGINE_OUTPUT_TAG');
  if (tag === 0) {
    wireTuple(output, 'SHADOW_ENGINE_FORWARD', 7);
    const deliveryMode = wireInteger(output[5], 'SHADOW_ENGINE_FORWARD_MODE');
    if (deliveryMode !== 1) throw new Error(`SHADOW_ENGINE_FORWARD_MODE:${deliveryMode}`);
    return [
      'forward',
      wireInteger(output[1], 'SHADOW_ENGINE_FORWARD_TOKEN'),
      wireText(output[2], 'SHADOW_ENGINE_FORWARD_AMOUNT'),
      wireTuple(output[3], 'SHADOW_ENGINE_FORWARD_ROUTE')
        .map((hop, index) => wireText(hop, `SHADOW_ENGINE_FORWARD_ROUTE_${index}`)),
      wireOptionalText(output[4], 'SHADOW_ENGINE_FORWARD_DESCRIPTION'),
      'trusted',
      wireText(output[6], 'SHADOW_ENGINE_FORWARD_GATEWAY'),
    ];
  }
  if (tag === 1) {
    wireTuple(output, 'SHADOW_ENGINE_SECRET', 6);
    return [
      'secret',
      wireText(output[1], 'SHADOW_ENGINE_SECRET_LOCK'),
      wireText(output[2], 'SHADOW_ENGINE_SECRET_HASHLOCK'),
      wireText(output[3], 'SHADOW_ENGINE_SECRET_VALUE'),
      wireInteger(output[4], 'SHADOW_ENGINE_SECRET_TOKEN'),
      wireText(output[5], 'SHADOW_ENGINE_SECRET_AMOUNT'),
    ];
  }
  if (tag === 2) {
    wireTuple(output, 'SHADOW_ENGINE_ERROR', 6);
    return [
      'error',
      wireText(output[1], 'SHADOW_ENGINE_ERROR_LOCK'),
      wireText(output[2], 'SHADOW_ENGINE_ERROR_HASHLOCK'),
      wireInteger(output[3], 'SHADOW_ENGINE_ERROR_TOKEN'),
      wireText(output[4], 'SHADOW_ENGINE_ERROR_AMOUNT'),
      wireOptionalText(output[5], 'SHADOW_ENGINE_ERROR_REASON'),
    ];
  }
  if (tag === 3) {
    wireTuple(output, 'SHADOW_ENGINE_OFFER', 19);
    const makerSide = wireInteger(output[14], 'SHADOW_ENGINE_OFFER_MAKER');
    if (makerSide !== 0 && makerSide !== 1) throw new Error(`SHADOW_ENGINE_OFFER_MAKER:${makerSide}`);
    return [
      'offerUpsert',
      wireText(output[1], 'SHADOW_ENGINE_OFFER_ID'),
      wireText(output[2], 'SHADOW_ENGINE_OFFER_LEFT'),
      wireText(output[3], 'SHADOW_ENGINE_OFFER_RIGHT'),
      wireInteger(output[4], 'SHADOW_ENGINE_OFFER_GIVE_TOKEN'),
      wireInteger(output[5], 'SHADOW_ENGINE_OFFER_GIVE_DECIMALS'),
      wireText(output[6], 'SHADOW_ENGINE_OFFER_GIVE_AMOUNT'),
      wireInteger(output[7], 'SHADOW_ENGINE_OFFER_WANT_TOKEN'),
      wireInteger(output[8], 'SHADOW_ENGINE_OFFER_WANT_DECIMALS'),
      wireText(output[9], 'SHADOW_ENGINE_OFFER_WANT_AMOUNT'),
      wireText(output[10], 'SHADOW_ENGINE_OFFER_MAX_FEE'),
      wireText(output[11], 'SHADOW_ENGINE_OFFER_MIN_NET'),
      wireText(output[12], 'SHADOW_ENGINE_OFFER_PRICE_TICKS'),
      output[13] === null || output[13] === undefined
        ? null
        : wireInteger(output[13], 'SHADOW_ENGINE_OFFER_TIF'),
      makerSide,
      wireInteger(output[15], 'SHADOW_ENGINE_OFFER_HEIGHT'),
      wireText(output[16], 'SHADOW_ENGINE_OFFER_QUANTIZED_GIVE'),
      wireText(output[17], 'SHADOW_ENGINE_OFFER_QUANTIZED_WANT'),
      output[18] === null || output[18] === undefined
        ? null
        : (() => {
            decodeRscoreCanonicalValue(output[18], 'SHADOW_ENGINE_OFFER_CROSS_JURISDICTION');
            return output[18] as RscoreWireValue;
          })(),
    ];
  }
  if (tag === 4) {
    wireTuple(output, 'SHADOW_ENGINE_OFFER_REMOVE', 3);
    const makerSide = wireInteger(output[2], 'SHADOW_ENGINE_OFFER_REMOVE_MAKER');
    if (makerSide !== 0 && makerSide !== 1) {
      throw new Error(`SHADOW_ENGINE_OFFER_REMOVE_MAKER:${makerSide}`);
    }
    return ['offerRemove', wireText(output[1], 'SHADOW_ENGINE_OFFER_REMOVE_ID')];
  }
  if (tag === 5) {
    wireTuple(output, 'SHADOW_ENGINE_CANCEL_REQUEST', 2);
    return ['cancelRequest', wireText(output[1], 'SHADOW_ENGINE_CANCEL_REQUEST_ID')];
  }
  if (tag === 6) {
    wireTuple(output, 'SHADOW_ENGINE_ACCOUNT_SETTLED', 5);
    return [
      'accountSettledFinalized',
      wireInteger(output[1], 'SHADOW_ENGINE_ACCOUNT_SETTLED_TOKEN'),
      wireInteger(output[2], 'SHADOW_ENGINE_ACCOUNT_SETTLED_J_HEIGHT'),
      wireText(output[3], 'SHADOW_ENGINE_ACCOUNT_SETTLED_COLLATERAL'),
      wireText(output[4], 'SHADOW_ENGINE_ACCOUNT_SETTLED_ONDELTA'),
    ];
  }
  if (tag === 7) {
    wireTuple(output, 'SHADOW_ENGINE_REQUEST_COLLATERAL_COMMITTED', 7);
    return [
      'requestCollateralCommitted',
      wireText(output[1], 'SHADOW_ENGINE_REQUEST_COLLATERAL_ENTITY'),
      wireText(output[2], 'SHADOW_ENGINE_REQUEST_COLLATERAL_ACCOUNT'),
      wireInteger(output[3], 'SHADOW_ENGINE_REQUEST_COLLATERAL_TOKEN'),
      wireText(output[4], 'SHADOW_ENGINE_REQUEST_COLLATERAL_AMOUNT'),
      wireText(output[5], 'SHADOW_ENGINE_REQUEST_COLLATERAL_FEE'),
      wireInteger(output[6], 'SHADOW_ENGINE_REQUEST_COLLATERAL_TIMESTAMP'),
    ];
  }
  throw new Error(`SHADOW_ENGINE_OUTPUT_TAG_UNSUPPORTED:${tag}`);
};

type IndexedShadowOutputRow = readonly [
  inputIndex: number,
  outputIndex: number,
  output: ShadowOutputRow,
];

/** Engine outputs normalized with their protocol-defined association intact. */
export const engineOutputProjection = (
  outputs: readonly unknown[],
  accountKey: string,
): IndexedShadowOutputRow[] => outputs
  .map(entry => wireTuple(entry, 'SHADOW_ENGINE_INDEXED_OUTPUT', 4))
  .filter(fields => Buffer.from(
    wireBytes(fields[2], 'SHADOW_ENGINE_ACCOUNT_ID', 32),
  ).toString('hex') === accountKey)
  .sort((left, right) => {
    const input = wireInteger(left[0], 'SHADOW_ENGINE_INPUT_INDEX')
      - wireInteger(right[0], 'SHADOW_ENGINE_INPUT_INDEX');
    return input !== 0
      ? input
      : wireInteger(left[1], 'SHADOW_ENGINE_OUTPUT_INDEX')
        - wireInteger(right[1], 'SHADOW_ENGINE_OUTPUT_INDEX');
  })
  .map(fields => [
    wireInteger(fields[0], 'SHADOW_ENGINE_INPUT_INDEX'),
    wireInteger(fields[1], 'SHADOW_ENGINE_OUTPUT_INDEX'),
    decodeEngineOutput(fields[3]),
  ]);

/**
 * The Entity's own mempool commitment, recomputed here so a shell divergence
 * says whether the queued transactions differ or something else in the shell
 * does.
 */
const tsMempoolRoot = (mempool: readonly AccountTx[]): string => (mempool.length === 0
  ? EMPTY_RADIX_ROOT
  : computeCanonicalMerkleRoot(
    'entity.account-mempool',
    mempool.map((tx, index) => [String(index), canonicalAccountTxForFrameHash(tx)] as const),
    'integrity',
  ).toLowerCase());

/**
 * Diagnostic: re-send every mirrored shell at every boundary instead of only
 * the ones whose leaf moved. Distinguishes a stale-shell bookkeeping bug from
 * a real projection divergence.
 */
const SHELL_REFRESH_ALL = typeof process !== 'undefined'
  && process.env?.['XLN_RSCORE_SHADOW_SHELL_ALL'] === '1';

/** Root of an empty radix map on both sides. */
const EMPTY_RADIX_ROOT = `0x${'00'.repeat(32)}`;

/**
 * Where divergences are written, one JSON per mismatch. Defaults to
 * .logs/rscore-diffs; set the env to an empty string to turn recording off.
 */
const DIFF_DIR: string | null = (() => {
  if (typeof process === 'undefined' || typeof process.env === 'undefined') return null;
  const configured = process.env['XLN_RSCORE_SHADOW_DIFF_DIR'];
  if (configured === '') return null;
  return configured ?? '.logs/rscore-diffs';
})();

const reportShadowDiagnostic = (code: string, value: unknown): void => {
  const line = `${code} ${safeStringify(value)}`;
  try {
    console.error(line);
  } catch {
    try { process.stderr.write(`${line}\n`); } catch { /* observer-only */ }
  }
};

const writeShadowArtifact = (name: string, payload: unknown): string | undefined => {
  if (DIFF_DIR === null) return undefined;
  const artifact = resolve(DIFF_DIR, name);
  try {
    mkdirSync(DIFF_DIR, { recursive: true });
    writeFileSync(artifact, safeStringify(payload, 2), { mode: 0o600 });
    return artifact;
  } catch (error) {
    reportShadowDiagnostic('RSCORE_SHADOW_DIFF_WRITE_FAILED', {
      artifact,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
};

/**
 * HTLC preimages travel through outputs and through the htlc_resolve wire. A
 * divergence dump is a durable file, so the secret is replaced by its length:
 * enough to see that one was present and how long, never enough to spend it.
 */
const redactSecrets = <T>(value: T): T => {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      // ['secret', lockId, hashlock, <preimage>, ...] and the resolve wire
      // [tag=2, lockId, outcome, <preimage bytes>].
      const rows = node.map(walk);
      if (rows[0] === 'secret' && typeof rows[3] === 'string') {
        rows[3] = `redacted:${(rows[3] as string).length}`;
      }
      if (rows[0] === 2 && rows[3] instanceof Uint8Array) {
        rows[3] = `redacted:${(rows[3] as Uint8Array).byteLength}`;
      }
      // Canonical object entries are `[fieldName, taggedValue]`. Account
      // mempool rows use this shape, so redact before a diagnostic preview is
      // persisted or printed even when the transaction wire is nested.
      if (rows.length === 2 && (rows[0] === 'secret' || rows[0] === 'preimage')) {
        rows[1] = `redacted:${safeStringify(rows[1]).length}`;
      }
      return rows;
    }
    if (node instanceof Uint8Array || node === null || typeof node !== 'object') return node;
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([key, entry]) => [
        key,
        key === 'secret' || key === 'preimage'
          ? `redacted:${safeStringify(entry).length}`
          : walk(entry),
      ]),
    );
  };
  return walk(value) as T;
};

type ShadowValuePreview = Readonly<{
  type: string;
  value: string;
  totalChars: number;
}>;

type ShadowFirstDifference = Readonly<{
  path: string;
  reason: 'value-mismatch' | 'missing-typescript' | 'missing-rust';
  typescript: ShadowValuePreview;
  rust: ShadowValuePreview;
}>;

type ShadowDifferenceContext = Readonly<{
  section?: string;
  inputIndex?: number;
  outputIndex?: number;
  txType?: string;
  outputKind?: string;
}>;

const SHADOW_PREVIEW_CHARS = 320;
const missingPreview = (): ShadowValuePreview => ({
  type: 'missing',
  value: '<missing>',
  totalChars: 0,
});

const valuePreview = (value: unknown, sensitive = false): ShadowValuePreview => {
  const redacted = sensitive
    ? `redacted:${safeStringify(value).length}`
    : redactSecrets(value);
  const canonical = safeStringify(redacted);
  const clipped = canonical.length <= SHADOW_PREVIEW_CHARS
    ? canonical
    : `${canonical.slice(0, 150)}…<truncated>…${canonical.slice(-150)}`;
  return {
    type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
    value: clipped,
    totalChars: canonical.length,
  };
};

const shadowDifference = (
  path: string,
  reason: ShadowFirstDifference['reason'],
  typescript: unknown,
  rust: unknown,
  sensitive = false,
): ShadowFirstDifference => ({
  path,
  reason,
  typescript: reason === 'missing-typescript' ? missingPreview() : valuePreview(typescript, sensitive),
  rust: reason === 'missing-rust' ? missingPreview() : valuePreview(rust, sensitive),
});

type ShadowMismatch = Readonly<{
  detail: string;
  firstDifference: ShadowFirstDifference;
  actualOutputs?: readonly IndexedShadowOutputRow[];
  actualRoot?: string;
  envelope?: ShadowEnvelopeMismatch;
}>;

type ShadowEnvelopeMismatch = Readonly<{
  firstDifference: ShadowFirstDifference;
  typescript: unknown;
  rust: unknown;
}>;

const shadowDifferenceFieldRank = (field: string): number =>
  /(?:Hash|Root|Digest)$/.test(field) ? 1 : 0;

/** Deterministic first path plus bounded, secret-redacted value previews. */
export const findFirstShadowDifference = (
  typescript: unknown,
  rust: unknown,
  path = '$',
  sensitive = false,
): ShadowFirstDifference | null => {
  if (safeStringify(typescript) === safeStringify(rust)) return null;
  if (Array.isArray(typescript) && Array.isArray(rust)) {
    const length = Math.max(typescript.length, rust.length);
    for (let index = 0; index < length; index += 1) {
      const secretSlot = index === 3
        && (typescript[0] === 'secret' || rust[0] === 'secret'
          || typescript[0] === 2 || rust[0] === 2);
      const canonicalSecretSlot = index === 1
        && (typescript[0] === 'secret' || rust[0] === 'secret'
          || typescript[0] === 'preimage' || rust[0] === 'preimage');
      const childSensitive = sensitive || secretSlot || canonicalSecretSlot;
      if (index >= typescript.length) {
        return shadowDifference(
          `${path}[${index}]`, 'missing-typescript', undefined, rust[index], childSensitive,
        );
      }
      if (index >= rust.length) {
        return shadowDifference(
          `${path}[${index}]`, 'missing-rust', typescript[index], undefined, childSensitive,
        );
      }
      const difference = findFirstShadowDifference(
        typescript[index],
        rust[index],
        `${path}[${index}]`,
        childSensitive,
      );
      if (difference !== null) return difference;
    }
  }
  if (typescript !== null && rust !== null
    && typeof typescript === 'object' && typeof rust === 'object'
    && !(typescript instanceof Uint8Array) && !(rust instanceof Uint8Array)) {
    const left = typescript as Record<string, unknown>;
    const right = rust as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort((a, b) =>
      shadowDifferenceFieldRank(a) - shadowDifferenceFieldRank(b)
      || (a < b ? -1 : a > b ? 1 : 0));
    for (const key of keys) {
      const childSensitive = sensitive || key === 'secret' || key === 'preimage';
      if (!(key in left)) {
        return shadowDifference(
          `${path}.${key}`, 'missing-typescript', undefined, right[key], childSensitive,
        );
      }
      if (!(key in right)) {
        return shadowDifference(
          `${path}.${key}`, 'missing-rust', left[key], undefined, childSensitive,
        );
      }
      const difference = findFirstShadowDifference(
        left[key],
        right[key],
        `${path}.${key}`,
        childSensitive,
      );
      if (difference !== null) return difference;
    }
  }
  return shadowDifference(path, 'value-mismatch', typescript, rust, sensitive);
};

const decodeShadowEnvelopeFields = (fields: unknown, side: string): unknown =>
  decodeRscoreCanonicalValue([8, fields], `SHADOW_${side}_ACCOUNT_ENVELOPE`);

/** Decode canonical-value tags before diffing, so paths name protocol fields. */
export const findShadowEnvelopeDifference = (
  typescriptFields: unknown,
  rustFields: unknown,
): ShadowEnvelopeMismatch | undefined => {
  const typescript = decodeShadowEnvelopeFields(typescriptFields, 'TYPESCRIPT');
  const rust = decodeShadowEnvelopeFields(rustFields, 'RUST');
  const firstDifference = findFirstShadowDifference(
    typescript,
    rust,
    '$.accountEnvelope',
  );
  return firstDifference === null ? undefined : {
    firstDifference,
    typescript,
    rust,
  };
};

const shadowFailure = (detail: string, path: string): ShadowMismatch => ({
  detail,
  firstDifference: shadowDifference(path, 'value-mismatch', 'accepted', detail),
});

/**
 * The engine's own tree, computed on the TypeScript side — and the Entity's
 * accounts tree at the same time: key = the raw 32-byte counterparty id, leaf
 * = the Entity account leaf digest (the replica shell plus the financial
 * root), radix 16. Same data model as PersistentEntityAccountMap.
 */
const emptyForest = (): PersistentRadixValueMap<string, string> =>
  PersistentRadixValueMap.empty<string, string>({
    radix: 16,
    ownKey: (key: string): string => key,
    keyBytes: (key: string): Uint8Array => hexToWireBytes(key, 32, 'SHADOW_FOREST_KEY'),
    // The leaf is the digest itself, taken at the instant the frame was noted.
    // Holding the live replica instead made the tree re-hash whatever the
    // authority looked like at root time: the entity mutates its replicas in
    // place, so a mempool append between the note and the flush moved a leaf
    // the engine had never been told about.
    valueHash: (digest: string): string => digest,
    ownValue: (digest: string): string => digest,
  });

const MAX_QUEUE = 50_000;
/**
 * One engine process per owner entity means an unbounded stand (a lane with a
 * thousand user entities) would fork a thousand processes. Shadow is a
 * diagnostic, so it binds to the first N owners it sees and ignores the rest;
 * a hub-only run is the intended shape (N=1).
 */
const DEFAULT_MAX_OWNERS = 1;
/** Progress reporting cadence, in compared frames. */
const PROGRESS_EVERY = 500;
/** Field count of one `read_account_summary_page` row; pinned with the wire. */
const SUMMARY_ROW_FIELDS = 12;
/**
 * Whole-tree reconciliation cadence, in compared frames. Per-frame comparison
 * only covers frames the mirror replayed; a periodic full diff also catches an
 * account that silently stopped being mirrored. 0 disables it.
 */
const RECONCILE_EVERY = Number(
  (typeof process === 'undefined' ? undefined : process.env['XLN_RSCORE_SHADOW_RECONCILE_EVERY'])
  ?? '0',
);

export type ShadowFrameInput = Readonly<{
  /**
   * The Runtime frame this commit belongs to, from the caller's own consensus
   * context. The authority driver attributes outputs by it: a process hosts
   * many Runtimes, and module state would mix their frames.
   */
  runtimeId?: string;
  /** Exact ephemeral Runtime frame used by the authority collector. */
  accountAuthorityFrameId?: string | null;
  ownerEntityId: string;
  counterpartyEntityId: string;
  frameHeight: number;
  byLeft: boolean;
  timestamp: number;
  jHeight: number;
  enforcementTimestamp: number;
  enforcementJHeight: number;
  accountTxs: readonly AccountTx[];
  /**
   * The authority's own per-tx results, in tx order. The mirror projects them
   * with the single canonical projector (shadowOutputRows), so the comparison
   * never depends on a second, hand-written derivation at each commit site.
   */
  txResults: readonly ApplyAccountTxOk[];
  /**
   * Microseconds the TypeScript reducer spent applying exactly these txs. The
   * mirror aggregates it against the engine's own execution time so a run
   * answers "is Rust faster here" with measured numbers, not an assumption.
   */
  tsApplyUs: number;
  /** TS authority root committed by this frame (hex). */
  committedStateRoot: string;
  /**
   * The state this frame started from. A never-mirrored account is seeded from
   * it and then executes the frame like any other; importing the committed
   * post-state instead would import the very transition under test.
   */
  preFrameState?: AccountState;
  /** Committed post-frame replica, read synchronously at note time. */
  account: AccountReplica;
}>;

/** One mirrored Account frame inside a wave. */
type WaveFrame = Readonly<{
  accountKey: string;
  frameHeight: number;
  expectedRootHex: string;
  txTypes: readonly string[];
  /** Canonical projection of the TS outputs this frame must reproduce. */
  expectedOutputs: readonly IndexedShadowOutputRow[];
  /** TypeScript reducer time for this frame's txs, in microseconds. */
  tsApplyUs: number;
  /**
   * Per-section roots of the TS replica as this frame committed them. Captured
   * here because the live replica keeps moving: diffing the engine against
   * whatever the account looks like later named the wrong section.
   */
  sections: Readonly<Record<string, string>>;
}>;

const shadowDifferenceContext = (
  frame: WaveFrame,
  failure: ShadowMismatch,
  section?: string,
): ShadowDifferenceContext => {
  const outputRowIndex = /^\$\.outputs\[(\d+)\]/.exec(failure.firstDifference.path)?.[1];
  if (outputRowIndex === undefined) return section === undefined ? {} : { section };
  const index = Number(outputRowIndex);
  const row = frame.expectedOutputs[index] ?? failure.actualOutputs?.[index];
  if (row === undefined) return section === undefined ? {} : { section };
  const [inputIndex, outputIndex, output] = row;
  return {
    ...(section === undefined ? {} : { section }),
    inputIndex,
    outputIndex,
    ...(frame.txTypes[inputIndex] === undefined ? {} : { txType: frame.txTypes[inputIndex] }),
    ...(typeof output[0] === 'string' ? { outputKind: output[0] } : {}),
  };
};

/**
 * The four sections the engine commits separately. Every root is already
 * folded and memoized by the commit that produced this frame, so reading them
 * at note time costs no extra hashing.
 */
const tsSectionRoots = (state: AccountState): Readonly<{
  deltas: string;
  locks: string;
  swapOffers: string;
  rebalanceFeePolicies: string;
}> => ({
  deltas: requirePersistentAccountStateMap(state.deltas, 'deltas').rootHash().toLowerCase(),
  locks: requirePersistentAccountStateMap(state.locks, 'locks').rootHash().toLowerCase(),
  swapOffers: requirePersistentAccountStateMap(state.swapOffers, 'swapOffers')
    .rootHash().toLowerCase(),
  rebalanceFeePolicies: state.rebalanceFeePolicies === undefined
    ? EMPTY_RADIX_ROOT
    : requirePersistentAccountStateMap(state.rebalanceFeePolicies, 'rebalanceFeePolicies')
      .rootHash().toLowerCase(),
});

/** One committed frame and its request-local jobs before Runtime-wave packing. */
type PendingWaveFrame = Readonly<{
  frame: WaveFrame;
  jobs: readonly RscoreWireValue[][];
}>;

/** Encode one committed frame without mutating mirror bookkeeping. */
const committedFrameJobs = (
  input: ShadowFrameInput,
  accountIdBytes: Uint8Array,
  wires: readonly ReturnType<typeof accountTxWire>[],
): RscoreWireValue[][] => {
  const jobs: RscoreWireValue[][] = [];
  // The shell belongs to the frame, not to one transition, so it rides on
  // the last job of the frame: after that job the engine holds exactly the
  // replica the authority committed.
  const envelope = accountEnvelopeWire(input.account);
  for (const [index, wire] of wires.entries()) {
    if (wire === null) throw new Error('SHADOW_TX_UNSUPPORTED_AFTER_ADMISSION');
    jobs.push([
      index,
      accountIdBytes,
      input.byLeft ? 0 : 1,
      [
        input.timestamp,
        input.enforcementTimestamp,
        input.enforcementJHeight,
        input.frameHeight - 1,
        // Swap and pull transitions are clocked with the frame's own J
        // height (core/account/consensus: frameJHeight), which is neither
        // the account height nor the Entity enforcement clock.
        input.jHeight,
      ],
      wire,
      index === wires.length - 1 ? envelope : null,
      // Authority for this input (frame digest, signature, expected
      // signer). Null while the mirror observes an authority that has
      // already verified the Hanko itself; the engine verifies whatever it
      // is given.
      null,
    ]);
  }
  return jobs;
};

/** Snapshot the authority facts that one queued engine wave must reproduce. */
const pendingCommittedFrame = (
  input: ShadowFrameInput,
  accountKey: string,
  jobs: readonly RscoreWireValue[][],
): PendingWaveFrame => ({
  frame: {
    accountKey,
    frameHeight: input.frameHeight,
    expectedRootHex: input.committedStateRoot.trim().toLowerCase().replace(/^0x/, ''),
    txTypes: input.accountTxs.map(tx => tx.type),
    expectedOutputs: input.txResults.flatMap((result, inputIndex) =>
      shadowOutputRows(result).map((output, outputIndex) => [
        inputIndex,
        outputIndex,
        output,
      ])),
    tsApplyUs: input.tsApplyUs,
    sections: tsSectionRoots(input.account.state),
  },
  jobs,
});

type PendingSubwave = Readonly<{
  frames: WaveFrame[];
  jobs: RscoreWireValue[][];
}>;

/**
 * How much of one Runtime frame goes into one engine request. A hub commits
 * thousands of account frames per Runtime frame, and a job that carries a
 * replica shell is kilobytes rather than bytes, so the job count alone says
 * nothing about the request size. Both bounds apply: whichever is reached
 * first closes the chunk.
 */
const MAX_JOBS_PER_WAVE = Math.max(
  1,
  Number(process.env['XLN_RSCORE_SHADOW_MAX_JOBS_PER_WAVE'] ?? '16384'),
);
/** Encoded-byte budget per request, well under the wire's own ceiling. */
const MAX_BYTES_PER_WAVE = Math.max(
  1,
  Number(process.env['XLN_RSCORE_SHADOW_MAX_BYTES_PER_WAVE'] ?? String(64 * 1024 * 1024)),
);

/**
 * Rough encoded size of one job, without encoding it: strings and byte arrays
 * dominate, everything else is a few bytes of MessagePack header.
 */
const wireValueBytes = (value: RscoreWireValue): number => {
  if (value === null || typeof value === 'boolean') return 1;
  if (typeof value === 'number') return 9;
  if (typeof value === 'string') return value.length + 5;
  if (value instanceof Uint8Array) return value.length + 5;
  if (Array.isArray(value)) {
    let total = 5;
    for (const entry of value) total += wireValueBytes(entry);
    return total;
  }
  return 9;
};

const jobBytes = (job: RscoreWireValue[]): number => wireValueBytes(job);

/** Preserve per-account frame order while retaining cross-account parallelism. */
const packRuntimeSubwaves = (pending: readonly PendingWaveFrame[]): PendingSubwave[] => {
  // One chunk list per depth: an account's nth frame always lands in depth n,
  // and depths are emitted in order, so per-account order survives chunking
  // while distinct accounts stay independent.
  const byDepth: PendingSubwave[][] = [];
  const chunkBytes = new Map<PendingSubwave, number>();
  const occurrence = new Map<string, number>();
  for (const pendingFrame of pending) {
    // ack_frame can commit the ACKed frame and the peer's next proposal in one
    // Runtime frame. The nth frame of each account belongs in the nth subwave.
    const depth = occurrence.get(pendingFrame.frame.accountKey) ?? 0;
    occurrence.set(pendingFrame.frame.accountKey, depth + 1);
    const chunks = byDepth[depth] ?? [];
    byDepth[depth] = chunks;
    const open = chunks.at(-1);
    let frameBytes = 0;
    for (const job of pendingFrame.jobs) frameBytes += jobBytes(job);
    const openBytes = open ? chunkBytes.get(open) ?? 0 : 0;
    const fits = open !== undefined
      && open.jobs.length + pendingFrame.jobs.length <= MAX_JOBS_PER_WAVE
      && (open.jobs.length === 0 || openBytes + frameBytes <= MAX_BYTES_PER_WAVE);
    const subwave = fits ? open : { frames: [], jobs: [] };
    if (subwave !== open) chunks.push(subwave);
    chunkBytes.set(subwave, (chunkBytes.get(subwave) ?? 0) + frameBytes);
    const inputBase = subwave.jobs.length;
    subwave.frames.push({
      ...pendingFrame.frame,
      expectedOutputs: pendingFrame.frame.expectedOutputs.map(([inputIndex, outputIndex, output]) => [
        inputBase + inputIndex,
        outputIndex,
        output,
      ]),
    });
    for (const [index, job] of pendingFrame.jobs.entries()) {
      // Rust input indexes are request-local, contiguous, and bind returned
      // results/outputs to this exact subwave.
      subwave.jobs.push([inputBase + index, ...job.slice(1)]);
    }
  }
  return byDepth.flat();
};

type QueueEntry = Readonly<{
  kind: 'wave';
  ownerKey: string;
  /** Every account frame of one Runtime frame, in commit order. */
  frames: readonly WaveFrame[];
  jobs: RscoreWireValue[][];
}> | Readonly<{
  /**
   * Whole-tree checkpoint queued at a Runtime boundary: the engine's committed
   * accounts root must equal the TypeScript forest root as of the last frame
   * that entered this flush.
   */
  kind: 'verify';
  ownerKey: string;
  expectedForestRoot: string;
  frameCount: number;
  /**
   * 'entity' when the expectation is the Entity's own accounts root — the
   * strongest form, available only while the mirror holds every account of
   * that owner. 'forest' when it is the mirror's tree over the accounts it
   * does hold.
   */
  source: 'entity' | 'forest';
}> | Readonly<{
  /**
   * Replica shells the Entity re-projected since the last boundary. Shell-only
   * by construction: it can never overwrite the financial state the engine
   * reached by executing, so it cannot hide a divergence.
   */
  kind: 'shells';
  ownerKey: string;
  rows: RscoreWireValue[][];
}> | Readonly<{
  /** Accounts the mirror stopped following; the engine drops their leaves. */
  kind: 'remove';
  ownerKey: string;
  accountKeys: readonly string[];
}> | Readonly<{
  kind: 'reseed';
  ownerKey: string;
  accountKey: string;
  seed: RscoreWireValue[];
  reason: string;
  frameHeight: number;
}>;

type ShadowReconciliationMismatch = Readonly<{
  accountId: string;
  /** The financial leaf: identity, dispute config, journal counters, every section. */
  accountStateRoot: Readonly<{ typescript: string; rust: string }>;
  /** The Entity's committed Account leaf; replica coordination is excluded. */
  entityAccountLeaf: Readonly<{ typescript: string; rust: string }>;
  /** Queued transactions on each side, when the shells disagree. */
  mempool: Readonly<{ typescript: string; rust: string }>;
  /** Root over those transactions: isolates a shell gap to the mempool. */
  mempoolRoot: Readonly<{ typescript: string; rust: string }>;
  /** Which section moved, when the full root differs. */
  deltasRoot: Readonly<{ typescript: string; rust: string }>;
  locksRoot: Readonly<{ typescript: string; rust: string }>;
  swapOffersRoot: Readonly<{ typescript: string; rust: string }>;
  rebalanceFeePoliciesRoot: Readonly<{ typescript: string; rust: string }>;
  ownerSide: Readonly<{ typescript: string; rust: string }>;
  firstDifference: ShadowFirstDifference;
  artifact?: string;
}>;

export type ShadowReconciliation = Readonly<{
  matched: number;
  /**
   * Radix-16 forest over the Entity account leaves — the tree the Rust engine
   * commits and the same value the Entity's own accounts map roots to, so a
   * match means the engine could hand its tree back to the entity machine.
   */
  forestRoot: Readonly<{ typescript: string; rust: string; equal: boolean }>;
  mismatched: readonly ShadowReconciliationMismatch[];
  missingInEngine: readonly string[];
  extraInEngine: readonly string[];
}>;

type EngineSummaryRow = Readonly<{
  ownerSide: string;
  deltasRoot: string;
  locksRoot: string;
  swapOffersRoot: string;
  rebalanceFeePoliciesRoot: string;
  accountStateRoot: string;
  mempoolRoot: string;
  entityAccountLeaf: string;
  mempoolLength: number;
}>;

/** Decode one strict summary row returned by the engine. */
const decodeEngineSummaryRow = (row: unknown): readonly [string, EngineSummaryRow] => {
  const fields = wireTuple(row, 'SHADOW_SUMMARY_ROW', 12);
  const side = wireInteger(fields[1], 'SHADOW_SUMMARY_OWNER_SIDE');
  if (side !== 0 && side !== 1) throw new Error(`SHADOW_SUMMARY_OWNER_SIDE:${side}`);
  return [`0x${Buffer.from(
    wireBytes(fields[0], 'SHADOW_SUMMARY_ACCOUNT_ID', 32),
  ).toString('hex')}`, {
    ownerSide: side === 0 ? 'left' : 'right',
    deltasRoot: `0x${Buffer.from(wireBytes(fields[4], 'SHADOW_SUMMARY_DELTAS_ROOT', 32)).toString('hex')}`,
    locksRoot: `0x${Buffer.from(wireBytes(fields[5], 'SHADOW_SUMMARY_LOCKS_ROOT', 32)).toString('hex')}`,
    accountStateRoot: `0x${Buffer.from(wireBytes(fields[6], 'SHADOW_SUMMARY_STATE_ROOT', 32)).toString('hex')}`,
    swapOffersRoot: `0x${Buffer.from(wireBytes(
      fields[7], 'SHADOW_SUMMARY_SWAP_OFFERS_ROOT', 32,
    )).toString('hex')}`,
    rebalanceFeePoliciesRoot: `0x${Buffer.from(wireBytes(
      fields[8], 'SHADOW_SUMMARY_REBALANCE_FEE_POLICIES_ROOT', 32,
    )).toString('hex')}`,
    mempoolRoot: `0x${Buffer.from(wireBytes(fields[10], 'SHADOW_SUMMARY_MEMPOOL_ROOT', 32)).toString('hex')}`,
    entityAccountLeaf: `0x${Buffer.from(wireBytes(fields[9], 'SHADOW_SUMMARY_ENTITY_LEAF', 32)).toString('hex')}`,
    mempoolLength: wireInteger(fields[11], 'SHADOW_SUMMARY_MEMPOOL_LEN'),
  }];
};

/** Page one stable engine revision into an account-keyed summary map. */
const readEngineSummaryRows = async (
  client: RscoreProcessClient,
): Promise<Map<string, EngineSummaryRow>> => {
  const engineRows = new Map<string, EngineSummaryRow>();
  let pageRevision: number | undefined;
  let cursor: Uint8Array | null = null;
  for (;;) {
    const page = wireTuple(
      await client.readAccountSummaryPage(cursor, 512, []),
      'SHADOW_SUMMARY_PAGE',
      4,
    );
    const revision = wireInteger(page[0], 'SHADOW_SUMMARY_REVISION');
    pageRevision ??= revision;
    if (revision !== pageRevision) {
      throw new Error(`SHADOW_RECONCILE_REVISION_CHANGED:${pageRevision}:${revision}`);
    }
    for (const row of wireTuple(page[1], 'SHADOW_SUMMARY_ROWS')) {
      const [accountKey, summary] = decodeEngineSummaryRow(row);
      engineRows.set(accountKey, summary);
    }
    const next = page[2];
    if (next === null || next === undefined) break;
    cursor = wireBytes(next, 'SHADOW_SUMMARY_CURSOR', 32);
  }
  return engineRows;
};

/**
 * A parity gap the mirror observed. Divergence is the obvious one; a repair
 * reseed and a refused account are gaps too — they silently restore agreement
 * instead of proving it, so a strict run must treat them as failures.
 */
export type ShadowGap = Readonly<{
  kind: 'divergence' | 'forest-divergence' | 'reseed-repair' | 'ineligible'
    | 'dropped' | 'disabled';
  owner: string;
  account: string;
  frameHeight: number;
  detail: string;
  txTypes: readonly string[];
  /** Per-section roots, filled in for divergences so the dump names the section. */
  sections?: Readonly<Record<string, Readonly<{ typescript: string; rust: string }>>>;
  firstDifference?: ShadowFirstDifference;
  context?: ShadowDifferenceContext;
  artifact?: string;
}>;

export type ShadowStats = {
  framesSeen: number;
  framesCompared: number;
  matches: number;
  /**
   * Effect rows both engines produced for the same frame and agreed on. The
   * frame match count alone cannot tell a frame whose effects agreed from one
   * that produced none: outputs are not in any state root, so a run where this
   * stays zero has proven nothing about them.
   */
  outputRowsCompared: number;
  mismatches: number;
  reseeds: number;
  /** Reseeds that repaired a gap (unsupported tx, drop, divergence) rather than registering a new account. */
  reseedsRepair: number;
  /** Frames carrying no account txs: nothing to replay, nothing to compare. */
  emptyFrames: number;
  skippedIneligible: number;
  /** Why accounts were refused, by out-of-profile section. */
  ineligibleReasons: Record<string, number>;
  /**
   * Account tx types the engine cannot replay, by count. These force a reseed
   * instead of a comparison, so this is the exact remaining port list for
   * parity across the entity's whole account interface.
   */
  unsupportedTxTypes: Record<string, number>;
  skippedUnboundOwner: number;
  /** Accounts imported at a recovery boundary as shared initial condition. */
  adoptedAccounts: number;
  /** Queue entries and account frames lost to overflow. */
  droppedWaves: number;
  droppedFrames: number;
  /**
   * Monotonic: accounts whose first observed frame was imported instead of
   * executed. Later frames of the same account never erase this, so a green
   * run cannot hide an unproven first transition.
   */
  firstFramesSkipped: number;
  /**
   * Accounts whose state was imported from TypeScript but that never had a
   * single transition executed by the engine. A seeded account reproduces the
   * TS root by construction, so counting it as agreement proves nothing.
   */
  seededNeverExecuted: number;
  /** Transitions the engine applied, by tx type. Rejections are counted apart. */
  executedByType: Record<string, number>;
  rejectedByType: Record<string, number>;
  /** Replica shells re-sent because the Entity leaf moved outside a frame. */
  shellRefreshes: number;
  /** Whole-tree checkpoints taken against the Entity's own accounts root. */
  entityRootChecks: number;
  /** Whole-tree diffs run mid-flight, and how many found a gap. */
  reconciliations: number;
  reconcileFailures: number;
  /**
   * Speed comparison over compared frames only: TypeScript reducer time, the
   * engine's own execution time (transport excluded) and the whole round trip
   * including transport, encoding and the commit.
   */
  tsApplyUs: number;
  rustEngineUs: number;
  rustWireUs: number;
  /** Transitions behind those three numbers. */
  timedTxs: number;
  /** Whole-tree checkpoints run at Runtime boundaries, and how many disagreed. */
  forestChecks: number;
  forestMismatches: number;
  disabledReason: string | null;
};

export class RscoreShadowMirror {
  readonly #binaryPath: string;
  readonly #workers: number;
  readonly #makeClient: (binaryPath: string) => RscoreProcessClient;
  readonly #clients = new Map<string, RscoreProcessClient>();
  readonly #boundOwners = new Set<string>();
  /** Owners already reported as beyond the binding limit; one gap each. */
  readonly #reportedUnbound = new Set<string>();
  readonly #maxOwners: number;
  readonly #registered = new Set<string>();
  /**
   * Live replica references, per owner, for self-reconciliation. These are the
   * very objects the entity owns and mutates in place, so the map stays
   * current without copying state; it retains nothing the entity has not
   * already retained.
   */
  readonly #mirrored = new Map<string, Map<string, AccountReplica>>();
  /** Incremental TypeScript forest per owner: the engine's tree, computed here. */
  readonly #forests = new Map<string, PersistentRadixValueMap<string, string>>();
  /** Last committed account map seen per owner, for the O(changed) shell diff. */
  readonly #lastAccountsMap = new Map<string, PersistentEntityAccountMap>();
  readonly #needsReseed = new Set<string>();
  /** Scoped keys seeded from TypeScript that have not executed a wave yet. */
  readonly #seeded = new Set<string>();
  /** Last accounts-forest root and revision the engine reported per owner. */
  readonly #lastCommittedRoot = new Map<string, string>();
  readonly #lastRevision = new Map<string, number>();
  readonly #queue: QueueEntry[] = [];
  /**
   * Account frames committed since the last Runtime frame boundary, per owner.
   * They are handed to the engine as ONE Prepare: the engine groups jobs by
   * account id and runs distinct accounts on its worker pool, so batching by
   * Runtime frame is what actually fills the cores. Sending one account frame
   * per Prepare left a single Rayon task and idle workers.
   */
  readonly #pendingWave = new Map<string, PendingWaveFrame[]>();
  #draining = false;
  #shuttingDown = false;
  /** Changes on every observed committed frame, including skipped frames. */
  #noteEpoch = 0;
  #disabledReason: string | null = null;
  readonly #stats: ShadowStats = {
    framesSeen: 0,
    framesCompared: 0,
    matches: 0,
    mismatches: 0,
    reseeds: 0,
    reseedsRepair: 0,
    emptyFrames: 0,
    skippedIneligible: 0,
    ineligibleReasons: {},
    unsupportedTxTypes: {},
    skippedUnboundOwner: 0,
    adoptedAccounts: 0,
    droppedWaves: 0,
    droppedFrames: 0,
    firstFramesSkipped: 0,
    seededNeverExecuted: 0,
    executedByType: {},
    rejectedByType: {},
    shellRefreshes: 0,
    entityRootChecks: 0,
    reconciliations: 0,
    reconcileFailures: 0,
    tsApplyUs: 0,
    rustEngineUs: 0,
    rustWireUs: 0,
    timedTxs: 0,
    outputRowsCompared: 0,
    forestChecks: 0,
    forestMismatches: 0,
    disabledReason: null,
  };
  #onProgress: (() => void) | null = null;
  #onGap: ((gap: ShadowGap) => void) | null = null;
  #idle: Promise<void> = Promise.resolve();
  #idleResolve: (() => void) | null = null;

  constructor(options: Readonly<{
    binaryPath: string;
    workers: number;
    maxOwners?: number;
    makeClient: (binaryPath: string) => RscoreProcessClient;
  }>) {
    this.#binaryPath = options.binaryPath;
    this.#workers = options.workers;
    this.#maxOwners = options.maxOwners ?? DEFAULT_MAX_OWNERS;
    this.#makeClient = options.makeClient;
  }

  /** Observer hook: called every PROGRESS_EVERY compared frames. */
  onProgress(callback: () => void): void {
    this.#onProgress = callback;
  }

  /**
   * Observer hook for every parity gap. A strict run halts here on the first
   * one; the default run only counts them.
   */
  onGap(callback: (gap: ShadowGap) => void): void {
    this.#onGap = callback;
  }

  stats(): ShadowStats {
    return {
      ...this.#stats,
      ineligibleReasons: { ...this.#stats.ineligibleReasons },
      unsupportedTxTypes: { ...this.#stats.unsupportedTxTypes },
      seededNeverExecuted: this.#seeded.size,
      executedByType: { ...this.#stats.executedByType },
      rejectedByType: { ...this.#stats.rejectedByType },
      disabledReason: this.#disabledReason,
    };
  }

  /**
   * Install the authoritative recovery checkpoint before replaying its WAL
   * tail. These accounts are the shared initial condition, not post-transition
   * reseeds, so they do not count as unexecuted shadow coverage.
   */
  async primeOwner(
    ownerEntityId: string,
    accounts: ReadonlyMap<string, AccountReplica>,
  ): Promise<void> {
    if (this.#disabledReason) throw new Error(`SHADOW_PRIME_DISABLED:${this.#disabledReason}`);
    const ownerKey = ownerEntityId.trim().toLowerCase();
    if (!this.#tryBindOwner(ownerKey)) throw new Error(`SHADOW_PRIME_OWNER_LIMIT:${ownerKey}`);
    if (this.#clients.has(ownerKey) || this.#mirrored.has(ownerKey)) {
      throw new Error(`SHADOW_PRIME_OWNER_ALREADY_LOADED:${ownerKey}`);
    }
    const ordered = [...accounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right));
    const { seeds, primed } = this.#checkpointSeeds(ownerKey, ownerEntityId, ordered);
    const { client, restored } = await this.#bootstrapAccounts(seeds);
    this.#clients.set(ownerKey, client);
    this.#noteRevision(ownerKey, restored);
    this.#mirrored.set(ownerKey, new Map());
    for (const [counterpartyId, account] of primed) {
      const accountKey = Buffer.from(
        hexToWireBytes(counterpartyId, 32, 'SHADOW_PRIME_ACCOUNT_ID'),
      ).toString('hex');
      this.#registered.add(`${ownerKey}/${accountKey}`);
      this.#remember(ownerKey, counterpartyId, account);
    }
  }

  /**
   * Adopt the owner's whole account map as shared initial condition, for every
   * account the mirror does not already hold. The recovery path restores a
   * tree of which one run may touch a handful of accounts; without this the
   * engine only ever learns about the accounts that happened to move, and a
   * clean reconciliation then covers that subset instead of the tree.
   *
   * Unlike a post-transition reseed this imports nothing that was under test:
   * these leaves are the state both engines start from.
   */
  async adoptOwner(
    ownerEntityId: string,
    accounts: ReadonlyMap<string, AccountReplica>,
  ): Promise<number> {
    if (this.#disabledReason) return 0;
    const ownerKey = ownerEntityId.trim().toLowerCase();
    if (!this.#tryBindOwner(ownerKey)) return 0;
    const seeds: RscoreWireValue[][] = [];
    const adopted: (readonly [string, AccountReplica])[] = [];
    for (const [counterpartyId, account] of [...accounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))) {
      const accountKey = Buffer.from(
        hexToWireBytes(counterpartyId, 32, 'SHADOW_ADOPT_ACCOUNT_ID'),
      ).toString('hex');
      const scopedKey = `${ownerKey}/${accountKey}`;
      if (this.#registered.has(scopedKey)) continue;
      const reason = shadowIneligibilityReason(account.state);
      if (reason !== null) {
        this.#stats.skippedIneligible += 1;
        this.#stats.ineligibleReasons[reason] = (this.#stats.ineligibleReasons[reason] ?? 0) + 1;
        this.#reportGap({
          kind: 'ineligible',
          owner: ownerKey,
          account: accountKey,
          frameHeight: account.currentHeight ?? 0,
          detail: `adopt:${reason}`,
          txTypes: [],
        });
        continue;
      }
      seeds.push(accountSeedWire(
        ownerEntityId,
        counterpartyId,
        account.state,
        accountEnvelopeWire(account),
      ));
      adopted.push([counterpartyId, account]);
      this.#registered.add(scopedKey);
      this.#needsReseed.delete(scopedKey);
    }
    if (seeds.length === 0) return 0;
    const client = await this.#ensureClient(ownerKey);
    const upserted = (await client.upsertAccounts(seeds)) as unknown[];
    this.#noteRevision(ownerKey, upserted);
    this.#stats.adoptedAccounts += adopted.length;
    for (const [counterpartyId, account] of adopted) {
      this.#remember(ownerKey, counterpartyId, account);
    }
    return adopted.length;
  }

  /**
   * Whole-tree reconciliation: page every account the engine holds and compare
   * it against the authoritative TypeScript map, leaf by leaf. Per-frame
   * comparison only covers frames the mirror chose to replay; this covers the
   * entire committed tree, so accounts that were skipped, dropped or never
   * seen show up as gaps instead of passing silently. Intended for the end of
   * a deterministic replay: identical trees mean the two engines are
   * interchangeable across a crash.
   */
  async reconcile(
    ownerEntityId: string,
    accounts: ReadonlyMap<string, AccountReplica>,
  ): Promise<ShadowReconciliation> {
    const ownerKey = ownerEntityId.trim().toLowerCase();
    const client = await this.#ensureClient(ownerKey);
    const engineRows = await readEngineSummaryRows(client);

    const matched: string[] = [];
    const mismatched: ShadowReconciliationMismatch[] = [];
    const missingInEngine: string[] = [];
    for (const [counterpartyId, account] of accounts) {
      const key = counterpartyId.trim().toLowerCase();
      const engine = engineRows.get(key);
      if (!engine) {
        missingInEngine.push(key);
        continue;
      }
      engineRows.delete(key);
      const mismatch = await this.#reconcileAccount(ownerKey, key, account, engine);
      if (mismatch === null) matched.push(key);
      else mismatched.push(mismatch);
    }
    // The mirror's own tree — the digests recorded at the instants they were
    // handed over — rather than one rebuilt from replicas that kept moving.
    // Same data model as the engine's: key = 32-byte counterparty id, leaf =
    // Entity account leaf digest, radix 16.
    let forest = this.#forests.get(ownerKey);
    if (forest === undefined) {
      forest = emptyForest();
      for (const [counterpartyId, account] of accounts) {
        forest = forest.updated(
          counterpartyId.trim().toLowerCase(),
          computeEntityAccountValueHash(account),
        );
      }
    }
    const typescriptForest = forest.rootHash().toLowerCase();
    const rustForest = (this.#lastCommittedRoot.get(ownerKey) ?? '').toLowerCase();
    return {
      matched: matched.length,
      forestRoot: {
        typescript: typescriptForest,
        rust: rustForest,
        equal: rustForest !== '' && rustForest === typescriptForest,
      },
      mismatched,
      missingInEngine,
      extraInEngine: [...engineRows.keys()],
    };
  }

  async #reconcileAccount(
    ownerKey: string,
    accountKey: string,
    account: AccountReplica,
    engine: EngineSummaryRow,
  ): Promise<ShadowReconciliationMismatch | null> {
    const sections = tsSectionRoots(account.state);
    const stateRoot = computeAccountStateRoot(account.state).toLowerCase();
    const mempoolRoot = tsMempoolRoot(account.mempool);
    // Use the digest captured when the shell was handed to Rust. The live TS
    // replica may already contain the next queued tx or ACK.
    const leaf = (this.#forests.get(ownerKey)?.get(accountKey)
      ?? computeEntityAccountValueHash(account)).toLowerCase();
    const side = account.state.leftEntity.trim().toLowerCase() === ownerKey ? 'left' : 'right';
    if (engine.accountStateRoot === stateRoot
      && engine.entityAccountLeaf === leaf
      && engine.ownerSide === side) return null;

    const differing = ([
      ['deltasRoot', sections.deltas, engine.deltasRoot],
      ['locksRoot', sections.locks, engine.locksRoot],
      ['swapOffersRoot', sections.swapOffers, engine.swapOffersRoot],
      ['rebalanceFeePoliciesRoot', sections.rebalanceFeePolicies, engine.rebalanceFeePoliciesRoot],
      ['accountStateRoot', stateRoot, engine.accountStateRoot],
      ['mempoolRoot', mempoolRoot, engine.mempoolRoot],
      ['mempoolLength', String(account.mempool.length), String(engine.mempoolLength)],
      ['entityAccountLeaf', leaf, engine.entityAccountLeaf],
      ['ownerSide', side, engine.ownerSide],
    ] as const).find(([, typescript, rust]) => typescript !== rust)
      ?? ['entityAccountLeaf', leaf, engine.entityAccountLeaf] as const;
    let firstDifference = shadowDifference(
      `$.${differing[0]}`, 'value-mismatch', differing[1], differing[2],
    );
    const envelope = await this.#envelopeMismatch(
      ownerKey, accountKey, accountEnvelopeWire(account),
    );
    firstDifference = envelope?.firstDifference ?? firstDifference;
    const artifact = this.#writeReconcileMismatch(
      ownerKey,
      accountKey,
      account,
      stateRoot,
      leaf,
      engine,
      sections,
      envelope,
      firstDifference,
    );
    return {
      accountId: accountKey,
      accountStateRoot: { typescript: stateRoot, rust: engine.accountStateRoot },
      entityAccountLeaf: { typescript: leaf, rust: engine.entityAccountLeaf },
      mempool: { typescript: String(account.mempool.length), rust: String(engine.mempoolLength) },
      mempoolRoot: { typescript: mempoolRoot, rust: engine.mempoolRoot },
      deltasRoot: { typescript: sections.deltas, rust: engine.deltasRoot },
      locksRoot: { typescript: sections.locks, rust: engine.locksRoot },
      swapOffersRoot: { typescript: sections.swapOffers, rust: engine.swapOffersRoot },
      rebalanceFeePoliciesRoot: {
        typescript: sections.rebalanceFeePolicies,
        rust: engine.rebalanceFeePoliciesRoot,
      },
      ownerSide: { typescript: side, rust: engine.ownerSide },
      firstDifference,
      ...(artifact === undefined ? {} : { artifact }),
    };
  }

  #writeReconcileMismatch(
    owner: string,
    accountKey: string,
    account: AccountReplica,
    stateRoot: string,
    leaf: string,
    engine: EngineSummaryRow,
    sections: ReturnType<typeof tsSectionRoots>,
    envelope: ShadowEnvelopeMismatch | undefined,
    firstDifference: ShadowFirstDifference,
  ): string | undefined {
    const artifact = writeShadowArtifact(
      `reconcile-${accountKey.slice(2, 14)}.json`,
      {
        owner,
        account: accountKey,
        firstDifference,
        roots: {
          accountStateRoot: { typescript: stateRoot, rust: engine.accountStateRoot },
          entityAccountLeaf: { typescript: leaf, rust: engine.entityAccountLeaf },
          sections: {
            deltas: { typescript: sections.deltas, rust: engine.deltasRoot },
            locks: { typescript: sections.locks, rust: engine.locksRoot },
            swapOffers: { typescript: sections.swapOffers, rust: engine.swapOffersRoot },
            rebalanceFeePolicies: {
              typescript: sections.rebalanceFeePolicies,
              rust: engine.rebalanceFeePoliciesRoot,
            },
          },
        },
        projection: redactSecrets(projectEntityAccountLeaf(account)),
        envelope: envelope === undefined ? null : {
          typescript: redactSecrets(envelope.typescript),
          rust: redactSecrets(envelope.rust),
        },
      },
    );
    if (artifact !== undefined) {
      reportShadowDiagnostic('RSCORE_SHADOW_FIRST_DIFF', {
        owner,
        account: accountKey,
        firstDifference,
        artifact,
      });
    }
    return artifact;
  }

  /**
   * Runtime frame boundary: hand every account frame committed since the last
   * boundary to the engine as one wave.
   */
  flushWave(state?: RuntimeState): void {
    if (this.#disabledReason) return;
    const queuedByOwner = new Map<string, number>();
    for (const [ownerKey, pending] of this.#pendingWave) {
      let queued = 0;
      for (const subwave of packRuntimeSubwaves(pending)) {
        if (subwave.jobs.length === 0) continue;
        this.#push({ kind: 'wave', ownerKey, frames: subwave.frames, jobs: subwave.jobs });
        queued += subwave.frames.length;
      }
      queuedByOwner.set(ownerKey, queued);
    }
    this.#pendingWave.clear();
    for (const ownerKey of this.#boundOwners) {
      // The Entity commits mempool, frame bindings, hankos and acks around a
      // state no account transaction touches, and they move between account
      // frames. Refresh them here so the engine's tree is the Entity's tree at
      // this boundary, not only at the instant a frame committed.
      const owned = state === undefined ? undefined : this.#ownerAccounts(state, ownerKey);
      const complete = owned === undefined ? false : this.#refreshShells(ownerKey, owned);
      const forest = this.#forests.get(ownerKey);
      const frameCount = queuedByOwner.get(ownerKey) ?? 0;
      if (complete && owned) {
        this.#push({
          kind: 'verify',
          ownerKey,
          expectedForestRoot: owned.rootHash().trim().toLowerCase(),
          frameCount,
          source: 'entity',
        });
        continue;
      }
      if (frameCount === 0 || !forest) continue;
      this.#push({
        kind: 'verify',
        ownerKey,
        expectedForestRoot: forest.rootHash().trim().toLowerCase(),
        frameCount,
        source: 'forest',
      });
    }
  }

  /** The owner's committed account map, when this Runtime holds that entity. */
  #ownerAccounts(state: RuntimeState, ownerKey: string): PersistentEntityAccountMap | undefined {
    for (const replica of state.eReplicas.values()) {
      if (replica.entityId.trim().toLowerCase() !== ownerKey) continue;
      const accounts = replica.state.accounts;
      return accounts instanceof PersistentEntityAccountMap ? accounts : undefined;
    }
    return undefined;
  }

  /**
   * Queue a shell update for every account whose Entity leaf moved since the
   * last boundary, and answer whether the mirror now holds the owner's whole
   * account map — the condition for comparing against the Entity's own root
   * instead of the mirror's partial tree.
   */
  #refreshShells(ownerKey: string, accounts: PersistentEntityAccountMap): boolean {
    const previous = this.#lastAccountsMap.get(ownerKey);
    this.#lastAccountsMap.set(ownerKey, accounts);
    // O(changed): the persistent tree shares untouched subtrees by identity.
    // A cold rebuild breaks the diff, and then the whole map is rescanned.
    const changes = previous === undefined || SHELL_REFRESH_ALL
      ? null
      : accounts.changedAccountsSince(previous);
    const candidates: Iterable<readonly [string, AccountReplica]> = changes === null
      ? accounts.entries()
      : changes.changed;
    // An account the Entity dropped has to leave the engine's tree in the same
    // boundary. Left behind, it keeps its last leaf in both the engine and the
    // mirror's forest, so the two agree with each other and disagree with the
    // Entity — exactly the divergence the forest is supposed to catch.
    for (const counterpartyId of changes?.removed ?? []) {
      const key = counterpartyId.trim().toLowerCase();
      const accountKey = key.replace(/^0x/, '');
      if (!this.#registered.has(`${ownerKey}/${accountKey}`)) continue;
      this.#forget(ownerKey, accountKey, counterpartyId);
    }
    const rows: RscoreWireValue[][] = [];
    // After the removals: `#forget` rewrites the same forest.
    let forest = this.#forests.get(ownerKey) ?? emptyForest();
    let mirrored = 0;
    for (const [counterpartyId, account] of candidates) {
      const key = counterpartyId.trim().toLowerCase();
      const accountKey = key.replace(/^0x/, '');
      if (!this.#registered.has(`${ownerKey}/${accountKey}`)) continue;
      const digest = computeEntityAccountValueHash(account).trim().toLowerCase();
      if (forest.get(key) === digest && !SHELL_REFRESH_ALL) continue;
      rows.push([
        hexToWireBytes(counterpartyId, 32, 'SHADOW_SHELL_ACCOUNT_ID'),
        accountEnvelopeWire(account),
      ]);
      forest = forest.updated(key, digest);
    }
    this.#forests.set(ownerKey, forest);
    if (rows.length > 0) {
      this.#stats.shellRefreshes += rows.length;
      this.#push({ kind: 'shells', ownerKey, rows });
    }
    for (const counterpartyId of accounts.keys()) {
      const accountKey = counterpartyId.trim().toLowerCase().replace(/^0x/, '');
      if (this.#registered.has(`${ownerKey}/${accountKey}`)) mirrored += 1;
    }
    return mirrored === accounts.size && accounts.size > 0;
  }

  /** Resolves when the queue has fully drained — test/shutdown ordering only. */
  settled(): Promise<void> {
    return this.#idle;
  }

  noteCommittedFrame(input: ShadowFrameInput): void {
    if (this.#disabledReason) return;
    this.#noteEpoch += 1;
    this.#stats.framesSeen += 1;
    // Parity with the entity machine: the account key is the raw 32-byte
    // counterparty entity id, never a hash. Owners are separated by running
    // one engine process per owner entity, exactly the way the entity machine
    // owns exactly one account map.
    const ownerKey = input.ownerEntityId.trim().toLowerCase();
    if (!this.#tryBindOwner(ownerKey)) {
      // Counted, not a live gap: the owner limit is the operator's scoping
      // decision (one engine process per owner entity, default one owner), and
      // a lane holding hundreds of user entities would otherwise halt on its
      // second entity. Every process that is asked to PROVE parity still fails
      // its end-of-run gate while this is non-zero.
      // Once per owner, not once per frame: the counter answers "how many
      // owners went unmirrored", and the gate fails while it is non-zero.
      this.noteUnboundOwner(ownerKey);
      return;
    }
    const accountIdBytes = hexToWireBytes(input.counterpartyEntityId, 32, 'SHADOW_ACCOUNT_ID');
    const accountKey = Buffer.from(accountIdBytes).toString('hex');
    const scopedKey = `${ownerKey}/${accountKey}`;
    if (process.env['XLN_RSCORE_SHADOW_TRACE'] === '1') {
      try {
        console.error(`SHADOW_TRACE note ${accountKey.slice(0, 8)} h${input.frameHeight} byLeft=${input.byLeft} txs=[${input.accountTxs.map(tx => tx.type).join(',')}] registered=${this.#registered.has(scopedKey)} needsReseed=${this.#needsReseed.has(scopedKey)}`);
      } catch { /* observer-only */ }
    }
    try {
      if (input.txResults.length !== input.accountTxs.length) {
        throw new Error(
          `SHADOW_TX_RESULT_LENGTH:${input.txResults.length}:${input.accountTxs.length}`,
        );
      }
      // Encoded once: support is decided by the payload, and the same wire is
      // reused for the jobs below.
      const wires = input.accountTxs.map(accountTxWire);
      const unsupported = input.accountTxs.filter((_tx, index) => wires[index] === null);
      for (const tx of unsupported) {
        this.#stats.unsupportedTxTypes[tx.type] = (this.#stats.unsupportedTxTypes[tx.type] ?? 0) + 1;
      }
      const supported = unsupported.length === 0;
      const wasRegistered = this.#registered.has(scopedKey);
      const fresh = !wasRegistered || this.#needsReseed.has(scopedKey);
      if (!supported || fresh) {
        // Reseeds are queued immediately while supported frames wait for the
        // Runtime boundary. Flush the earlier frames first; otherwise a later
        // unsupported frame of the same account would seed its post-state and
        // the queued earlier frame would be replayed on top of that state.
        this.flushWave();
        const repair = wasRegistered || this.#needsReseed.has(scopedKey);
        // Seed the state this frame STARTED in whenever the frame itself can
        // still be replayed: the engine then executes the transition instead of
        // importing its result, and no frame of a mirrored account goes unproven.
        const seedFromPre = supported && input.preFrameState !== undefined;
        const seedState = seedFromPre
          ? input.preFrameState as AccountState
          : input.account.state;
        const reason = shadowIneligibilityReason(seedState);
        if (reason !== null) {
          if (process.env['XLN_RSCORE_SHADOW_TRACE'] === '1') {
            try { console.error(`SHADOW_TRACE ineligible ${accountKey.slice(0, 8)} h${input.frameHeight} ${reason}`); } catch { /* observer-only */ }
          }
          // Live out-of-profile state: cannot seed. Forget the account
          // everywhere — including the engine's tree, whose leaf would
          // otherwise stay frozen at the last shell it was told about and
          // hold the whole accounts root apart. A later clean snapshot
          // re-registers it.
          this.#forget(ownerKey, accountKey, input.counterpartyEntityId);
          this.#stats.skippedIneligible += 1;
          this.#stats.ineligibleReasons[reason] = (this.#stats.ineligibleReasons[reason] ?? 0) + 1;
          this.#reportGap({
            kind: 'ineligible',
            owner: ownerKey,
            account: accountKey,
            frameHeight: input.frameHeight,
            detail: reason,
            txTypes: input.accountTxs.map(tx => tx.type),
          });
          return;
        }
        this.#push({
          kind: 'reseed',
          ownerKey,
          accountKey,
          seed: accountSeedWire(
            input.ownerEntityId,
            input.counterpartyEntityId,
            seedState,
            // A pre-frame seed gets no shell: the frame that follows installs
            // the one it produced. Everything else imports the shell as it
            // stands, so the engine's leaf is the Entity's leaf immediately.
            seedFromPre ? null : accountEnvelopeWire(input.account),
          ),
          reason: seedFromPre
            ? (repair ? 'repair-pre-frame' : 'register-pre-frame')
            : (repair ? (supported ? 'repair' : 'unsupported-tx') : 'register'),
          frameHeight: input.frameHeight,
        });
        if (repair) {
          this.#stats.reseedsRepair += 1;
          this.#reportGap({
            kind: 'reseed-repair',
            owner: ownerKey,
            account: accountKey,
            frameHeight: input.frameHeight,
            detail: supported ? 'continuity-lost' : `unsupported:${unsupported.map(tx => tx.type).join(',')}`,
            txTypes: input.accountTxs.map(tx => tx.type),
          });
        }
        this.#registered.add(scopedKey);
        this.#needsReseed.delete(scopedKey);
        if (!seedFromPre) {
          // The frame itself was imported, not executed. Monotonic on the
          // first sighting of an account, so a later matching frame cannot
          // retire the fact that this one was never proven.
          this.#seeded.add(scopedKey);
          if (!wasRegistered) this.#stats.firstFramesSkipped += 1;
          this.#remember(ownerKey, input.counterpartyEntityId, input.account);
          return;
        }
        // Falls through: this frame is replayed on top of the pre-frame seed.
      }
      const jobs = committedFrameJobs(input, accountIdBytes, wires);
      if (jobs.length === 0) {
        // Ack-only frames carry no account txs: there is nothing to replay and
        // nothing to compare. Counted so framesSeen always adds up.
        this.#stats.emptyFrames += 1;
        return;
      }
      this.#remember(ownerKey, input.counterpartyEntityId, input.account);
      const pending = this.#pendingWave.get(ownerKey) ?? [];
      pending.push(pendingCommittedFrame(input, accountKey, jobs));
      this.#pendingWave.set(ownerKey, pending);
      // Runtime-boundary batching preserves every per-account root: repeated
      // frames of one account are split into ordered subwaves, while distinct
      // accounts share one Prepare and fill the Rust worker pool.
    } catch (error) {
      this.#disable(`note:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Teardown in progress: transport failures from here on are the engine being
   * torn down with the process, not a parity signal.
   */
  markShuttingDown(): void {
    this.#shuttingDown = true;
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    this.flushWave();
    await this.#idle;
    for (const client of this.#clients.values()) {
      try { await client.shutdown(); } catch { /* already down */ }
      client.kill();
    }
    this.#clients.clear();
  }

  #push(entry: QueueEntry): void {
    if (this.#queue.length >= MAX_QUEUE) {
      this.#stats.droppedWaves += 1;
      // A dropped wave breaks replay continuity for every account it carried.
      if (entry.kind === 'reseed') this.#needsReseed.add(`${entry.ownerKey}/${entry.accountKey}`);
      else if (entry.kind === 'wave') {
        this.#stats.droppedFrames += entry.frames.length;
        for (const frame of entry.frames) this.#needsReseed.add(`${entry.ownerKey}/${frame.accountKey}`);
      }
      // Lost coverage is a parity gap, not a statistic: strict mode must stop
      // here rather than at whatever the end-of-run gate happens to notice.
      this.#reportGap({
        kind: 'dropped',
        owner: entry.ownerKey,
        account: entry.kind === 'reseed' ? entry.accountKey : '',
        frameHeight: entry.kind === 'wave' ? entry.frames.length : 0,
        detail: `queue-overflow:${entry.kind}:${MAX_QUEUE}`,
        txTypes: entry.kind === 'wave' ? entry.frames.flatMap(frame => frame.txTypes) : [],
      });
      return;
    }
    this.#queue.push(entry);
    if (!this.#draining) {
      this.#draining = true;
      this.#idle = new Promise(resolve => { this.#idleResolve = resolve; });
      void this.#drain();
    }
  }

  #reconcileIfDue(ownerKey: string): Promise<void> | null {
    // Only meaningful once everything the authority has committed is also
    // in the engine: TypeScript mutates its replicas in place, so a frame
    // still sitting in the pending wave legitimately puts the engine behind
    // and every diff taken then would be a false alarm.
    if (RECONCILE_EVERY <= 0
      || this.#stats.framesCompared <= 0
      || this.#stats.framesCompared % RECONCILE_EVERY !== 0
      || this.#queue.length !== 0
      || this.#pendingWave.size !== 0) return null;
    const owned = this.#mirrored.get(ownerKey);
    return owned ? this.#reconcileOwner(ownerKey, owned) : null;
  }

  async #reconcileOwner(
    ownerKey: string,
    owned: ReadonlyMap<string, AccountReplica>,
  ): Promise<void> {
    const epoch = this.#noteEpoch;
    const report = await this.reconcile(ownerKey, owned);
    this.#stats.reconciliations += 1;
    const gap = report.mismatched.length > 0 || report.missingInEngine.length > 0
      || report.extraInEngine.length > 0 || !report.forestRoot.equal;
    // A frame that arrived while the diff was running puts the engine
    // behind again; only an unchanged, still-quiet authority makes it real.
    if (gap
      && epoch === this.#noteEpoch
      && this.#queue.length === 0
      && this.#pendingWave.size === 0) {
      this.#stats.reconcileFailures += 1;
      this.#reportGap({
        kind: 'forest-divergence',
        owner: ownerKey,
        account: report.mismatched[0]?.accountId ?? '',
        frameHeight: this.#stats.framesCompared,
        detail: `reconcile:mismatched=${report.mismatched.length}:missing=${
          report.missingInEngine.length}:extra=${report.extraInEngine.length}:forest=${
          report.forestRoot.equal}`,
        txTypes: [],
        ...(report.mismatched[0]?.firstDifference
          ? { firstDifference: report.mismatched[0].firstDifference }
          : {}),
        ...(report.mismatched[0]?.artifact
          ? { artifact: report.mismatched[0].artifact }
          : {}),
      });
    }
    try {
      console.error(`RSCORE_SHADOW_RECONCILE matched=${report.matched} mismatched=${
        report.mismatched.length} missing=${report.missingInEngine.length} extra=${
        report.extraInEngine.length} forestRoot=${report.forestRoot.equal}`);
    } catch { /* observer-only */ }
  }

  async #drainWave(
    client: RscoreProcessClient,
    entry: Extract<QueueEntry, { kind: 'wave' }>,
  ): Promise<void> {
    const wireStartedUs = Math.round(performance.now() * 1000);
    const { candidate, token } = await client.prepareCandidate(entry.jobs);
    const prepared = candidate as unknown[];
    // Outputs and roots are read from the candidate before it is
    // committed, so a rejected wave never reaches the committed tree.
    const engineOutputs = prepared[3] as unknown[];
    const roots = prepared[4] as unknown[];
    const committed = (await client.commit(token)) as unknown[];
    this.#stats.rustWireUs += Math.round(performance.now() * 1000) - wireStartedUs;
    this.#stats.rustEngineUs += wireInteger(prepared[5], 'SHADOW_ENGINE_MICROS');
    this.#stats.timedTxs += entry.jobs.length;
    for (const frame of entry.frames) this.#stats.tsApplyUs += frame.tsApplyUs;
    // Every transition of this wave, in input-index order: which account it
    // belongs to and what it was. The engine returns the same binding, so a
    // rejection lands on the account that produced it instead of being
    // smeared over every account in the wave.
    const jobAccounts: string[] = [];
    const jobTypes: string[] = [];
    for (const frame of entry.frames) {
      for (const type of frame.txTypes) {
        jobAccounts.push(frame.accountKey);
        jobTypes.push(type);
      }
    }
    const results = prepared[2] as unknown[];
    if (results.length !== jobTypes.length) {
      throw new Error(`SHADOW_ENGINE_RESULT_LENGTH:${results.length}:${jobTypes.length}`);
    }
    const rejectionByAccount = new Map<string, string>();
    for (const row of results) {
      const fields = wireTuple(row, 'SHADOW_ENGINE_RESULT', 4);
      const inputIndex = wireInteger(fields[0], 'SHADOW_ENGINE_RESULT_INPUT');
      const type = jobTypes[inputIndex];
      const expectedAccount = jobAccounts[inputIndex];
      if (type === undefined || expectedAccount === undefined) {
        throw new Error(`SHADOW_ENGINE_RESULT_INDEX:${inputIndex}`);
      }
      const accountKey = Buffer.from(
        wireBytes(fields[1], 'SHADOW_ENGINE_RESULT_ACCOUNT', 32),
      ).toString('hex');
      if (accountKey !== expectedAccount) {
        throw new Error(`SHADOW_ENGINE_RESULT_ACCOUNT_BINDING:${inputIndex}:${accountKey}`);
      }
      const verdict = wireTuple(fields[2], 'SHADOW_ENGINE_VERDICT');
      if (Number(verdict[0]) === 0) {
        // Applied only. Counting rejected verdicts as executions claimed
        // coverage for a transition that changed nothing.
        this.#stats.executedByType[type] = (this.#stats.executedByType[type] ?? 0) + 1;
        continue;
      }
      this.#stats.rejectedByType[type] = (this.#stats.rejectedByType[type] ?? 0) + 1;
      if (!rejectionByAccount.has(accountKey)) {
        rejectionByAccount.set(
          accountKey,
          `rejected:${type}:input=${inputIndex}:${safeStringify(redactSecrets(verdict))}`,
        );
      }
    }
    for (const frame of entry.frames) {
      this.#seeded.delete(`${entry.ownerKey}/${frame.accountKey}`);
    }
    // The engine's revision must advance by exactly one per commit; a gap
    // means a candidate was silently dropped or replayed.
    const expectedRevision = (this.#lastRevision.get(entry.ownerKey) ?? 0) + 1;
    const revisionGap = Number(committed[0]) !== expectedRevision
      ? `revision:${committed[0]}!=${expectedRevision}`
      : null;
    this.#noteRevision(entry.ownerKey, committed);
    if (this.#stats.framesCompared % PROGRESS_EVERY === 0) {
      try { this.#onProgress?.(); } catch { /* observer-only */ }
    }
    const reconciliation = this.#reconcileIfDue(entry.ownerKey);
    if (reconciliation !== null) await reconciliation;
    for (const frame of entry.frames) {
      const accountKey = frame.accountKey;
      // Counted only once a verdict exists, so framesCompared always equals
      // matches + mismatches; incrementing first let a stats snapshot taken
      // mid-frame report a comparison with no outcome.
      this.#stats.framesCompared += 1;
      const rejection = rejectionByAccount.get(accountKey);
      const failure = revisionGap !== null
        ? shadowFailure(revisionGap, '$.wave.revision')
        : rejection !== undefined
          ? shadowFailure(rejection, '$.verdict')
          : this.#verifyAccount(
            accountKey,
            frame,
            frame.expectedOutputs,
            engineOutputs,
            roots,
          );
      if (failure === null) {
        this.#stats.matches += 1;
        continue;
      }
      await this.#recordMismatch(entry, accountKey, frame, failure);
    }
  }

  async #drain(): Promise<void> {
    let lastEntry: QueueEntry | null = null;
    try {
      for (let entry = this.#queue.shift(); entry !== undefined; entry = this.#queue.shift()) {
        lastEntry = entry;
        const client = await this.#ensureClient(entry.ownerKey);
        if (entry.kind === 'verify') {
          this.#verifyForest(entry);
          continue;
        }
        if (entry.kind === 'remove') {
          const removed = (await client.removeAccounts(
            entry.accountKeys.map(key => hexToWireBytes(`0x${key}`, 32, 'SHADOW_REMOVE_ACCOUNT_ID')),
          )) as unknown[];
          this.#noteRevision(entry.ownerKey, removed);
          continue;
        }
        if (entry.kind === 'shells') {
          const updated = (await client.updateAccountShells(entry.rows)) as unknown[];
          this.#noteRevision(entry.ownerKey, updated);
          continue;
        }
        if (entry.kind === 'reseed') {
          const upserted = (await client.upsertAccounts([entry.seed])) as unknown[];
          this.#noteRevision(entry.ownerKey, upserted);
          this.#stats.reseeds += 1;
          continue;
        }
        await this.#drainWave(client, entry);
      }
    } catch (error) {
      const context = lastEntry
        ? `${lastEntry.kind}:${safeStringify(
            lastEntry.kind === 'wave'
              ? lastEntry.jobs
              : lastEntry.kind === 'reseed'
                ? lastEntry.seed
                : lastEntry.kind === 'shells'
                  ? lastEntry.rows.length
                  : lastEntry.kind === 'remove'
                    ? lastEntry.accountKeys
                    : lastEntry.expectedForestRoot,
          ).slice(0, 600)}`
        : 'idle';
      this.#disable(`drain:${error instanceof Error ? error.message : String(error)}:${context}`);
    } finally {
      this.#draining = false;
      this.#idleResolve?.();
      this.#idleResolve = null;
      if (this.#queue.length > 0 && !this.#disabledReason) {
        this.#draining = true;
        this.#idle = new Promise(resolve => { this.#idleResolve = resolve; });
        void this.#drain();
      }
    }
  }

  /** Outputs then final root, for one account of a wave. Null when it matches. */
  #verifyAccount(
    accountKey: string,
    frame: WaveFrame,
    expectedOutputs: readonly IndexedShadowOutputRow[],
    engineOutputs: readonly unknown[],
    roots: readonly unknown[],
  ): ShadowMismatch | null {
    const actualOutputs = engineOutputProjection(engineOutputs, accountKey);
    this.#stats.outputRowsCompared += expectedOutputs.length;
    // Compare the raw values — two different preimages of the same length must
    // not compare equal — but build the message, which ends up in a durable
    // dump file, from redacted copies.
    if (safeStringify(actualOutputs) !== safeStringify(expectedOutputs)) {
      const firstDifference = findFirstShadowDifference(
        expectedOutputs,
        actualOutputs,
        '$.outputs',
      ) ?? shadowDifference('$.outputs', 'value-mismatch', expectedOutputs, actualOutputs);
      return {
        detail: `outputs:${firstDifference.path}:${firstDifference.reason}`,
        firstDifference,
        actualOutputs,
      };
    }
    const row = roots.find(candidate =>
      Buffer.from((candidate as unknown[])[0] as Uint8Array).toString('hex') === accountKey);
    const actual = row ? Buffer.from((row as unknown[])[1] as Uint8Array).toString('hex') : 'missing';
    return actual === frame.expectedRootHex ? null : {
      detail: `root:ts=${frame.expectedRootHex}:rust=${actual}`,
      firstDifference: shadowDifference(
        '$.accountStateRoot', 'value-mismatch', frame.expectedRootHex, actual,
      ),
      actualRoot: actual,
    };
  }

  /** Exact replica-shell read, used only after a leaf mismatch. */
  async #envelopeMismatch(
    ownerKey: string,
    accountKey: string,
    expected: RscoreWireValue,
  ): Promise<ShadowEnvelopeMismatch | undefined> {
    try {
      const envelope = wireTuple(expected, 'SHADOW_EXPECTED_ENVELOPE', 2);
      const taggedFields = wireTuple(
        envelope[0],
        'SHADOW_EXPECTED_ENVELOPE_FIELDS',
        2,
      );
      if (wireInteger(taggedFields[0], 'SHADOW_EXPECTED_ENVELOPE_FIELDS_TAG') !== 8) {
        throw new Error('SHADOW_EXPECTED_ENVELOPE_FIELDS_TAG:object');
      }
      const expectedFields = wireTuple(
        taggedFields[1],
        'SHADOW_EXPECTED_ENVELOPE_FIELD_ROWS',
      );
      const client = await this.#ensureClient(ownerKey);
      const reply = wireTuple(
        await client.readAccountEnvelope(Buffer.from(accountKey.replace(/^0x/, ''), 'hex')),
        'SHADOW_ACCOUNT_ENVELOPE_REPLY',
        2,
      );
      wireInteger(reply[0], 'SHADOW_ACCOUNT_ENVELOPE_REVISION');
      const actualFields = wireTuple(reply[1], 'SHADOW_ACCOUNT_ENVELOPE_FIELD_ROWS');
      return findShadowEnvelopeDifference(
        expectedFields,
        actualFields,
      );
    } catch (error) {
      try {
        console.error(
          `RSCORE_SHADOW_ENVELOPE_DIFF_FAILED ${accountKey.slice(-12)}:` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      } catch { /* observer-only */ }
      return undefined;
    }
  }

  async #recordMismatch(
    entry: Extract<QueueEntry, { kind: 'wave' }>,
    accountKey: string,
    frame: WaveFrame,
    failure: ShadowMismatch,
  ): Promise<void> {
    this.#stats.mismatches += 1;
    this.#needsReseed.add(`${entry.ownerKey}/${accountKey}`);
    const sections = await this.#diverginSections(entry.ownerKey, accountKey, frame);
    const section = Object.entries(sections ?? {}).find(([, roots]) =>
      roots.typescript !== roots.rust);
    const sectionDifference = section === undefined ? undefined : shadowDifference(
      `$.accountState.${section[0]}Root`,
      'value-mismatch',
      section[1].typescript,
      section[1].rust,
    );
    const ownJobs = entry.jobs.filter(job =>
      job[1] instanceof Uint8Array && Buffer.from(job[1]).toString('hex') === accountKey);
    const expectedEnvelope = [...ownJobs]
      .reverse()
      .map(job => job[5])
      .find(value => value !== null && value !== undefined);
    const envelope = expectedEnvelope === undefined
      ? undefined
      : await this.#envelopeMismatch(entry.ownerKey, accountKey, expectedEnvelope);
    // An effect mismatch is independently consensus-visible even if the state
    // root also moved. For a root-only mismatch, name the first bad section;
    // for a shell mismatch, name the exact projected field.
    const firstDifference = failure.detail.startsWith('outputs:')
      ? failure.firstDifference
      : sectionDifference ?? envelope?.firstDifference ?? failure.firstDifference;
    const diagnostic: ShadowMismatch = {
      ...failure,
      firstDifference,
      ...(envelope === undefined ? {} : { envelope }),
    };
    const context = shadowDifferenceContext(frame, diagnostic, section?.[0]);
    const artifact = this.#writeDiff(
      entry,
      accountKey,
      frame,
      diagnostic,
      sections,
      context,
    );
    // Logging must never take the mirror down (scenario harnesses may turn
    // console.error into a thrown failure).
    try {
      shadowLog.error('shadow.divergence', {
        owner: entry.ownerKey,
        account: accountKey,
        frameHeight: frame.frameHeight,
        expected: frame.expectedRootHex,
        detail: diagnostic.detail,
        firstDifference,
        sections,
        context,
        artifact: artifact ?? null,
      });
    } catch { /* observer-only */ }
    this.#reportGap({
      kind: 'divergence',
      owner: entry.ownerKey,
      account: accountKey,
      frameHeight: frame.frameHeight,
      detail: diagnostic.detail,
      txTypes: frame.txTypes,
      firstDifference,
      context,
      ...(artifact === undefined ? {} : { artifact }),
      ...(sections ? { sections } : {}),
    });
  }

  /**
   * Whole-tree checkpoint: the engine's committed accounts root against the
   * TypeScript forest root taken at the same Runtime boundary. Per-frame
   * comparison proves each touched leaf; this proves that nothing else in the
   * tree moved, drifted or was silently dropped.
   */
  #verifyForest(entry: Extract<QueueEntry, { kind: 'verify' }>): void {
    const rust = (this.#lastCommittedRoot.get(entry.ownerKey) ?? '').trim().toLowerCase();
    this.#stats.forestChecks += 1;
    if (entry.source === 'entity') this.#stats.entityRootChecks += 1;
    if (rust === entry.expectedForestRoot) return;
    this.#stats.forestMismatches += 1;
    try {
      shadowLog.error('shadow.forest-divergence', {
        owner: entry.ownerKey,
        frames: entry.frameCount,
        source: entry.source,
        typescript: entry.expectedForestRoot,
        rust,
      });
    } catch { /* observer-only */ }
    this.#reportGap({
      kind: 'forest-divergence',
      owner: entry.ownerKey,
      account: '',
      frameHeight: entry.frameCount,
      detail: `${entry.source}-root:ts=${entry.expectedForestRoot}:rust=${rust}`,
      txTypes: [],
    });
  }

  /**
   * One file per divergence, so a long run leaves a diffable record instead of
   * a log line that scrolls away: the frame, its tx types, both roots, the
   * per-section roots and the exact wire jobs that produced it.
   *
   * The record is deliberately narrow. Only the diverging account's own jobs
   * are written (a wave carries other accounts' financial payloads), HTLC
   * preimages are replaced by their length, and the file is created 0600: a
   * durable plaintext secret is worth more to an attacker than the diff is to
   * us.
   */
  #writeDiff(
    entry: Extract<QueueEntry, { kind: 'wave' }>,
    accountKey: string,
    frame: WaveFrame,
    failure: ShadowMismatch,
    sections: Record<string, { typescript: string; rust: string }> | undefined,
    context: ShadowDifferenceContext,
  ): string | undefined {
    const name = `${String(this.#stats.mismatches).padStart(6, '0')}-${accountKey.slice(0, 12)}-h${frame.frameHeight}.json`;
    const ownJobs = entry.jobs.filter(job =>
      job[1] instanceof Uint8Array && Buffer.from(job[1]).toString('hex') === accountKey);
    const artifact = writeShadowArtifact(name, {
        owner: entry.ownerKey,
        account: accountKey,
        frameHeight: frame.frameHeight,
        txTypes: frame.txTypes,
        detail: failure.detail,
        firstDifference: failure.firstDifference,
        context,
        expectedRoot: frame.expectedRootHex,
        actualRoot: failure.actualRoot ?? null,
        sections: sections ?? null,
        expectedOutputs: redactSecrets(frame.expectedOutputs),
        actualOutputs: redactSecrets(failure.actualOutputs ?? []),
        envelope: failure.envelope === undefined ? null : {
          firstDifference: failure.envelope.firstDifference,
          typescript: redactSecrets(failure.envelope.typescript),
          rust: redactSecrets(failure.envelope.rust),
        },
        jobs: redactSecrets(ownJobs),
      });
    if (artifact !== undefined) {
      reportShadowDiagnostic('RSCORE_SHADOW_FIRST_DIFF', {
        owner: entry.ownerKey,
        account: accountKey,
        frameHeight: frame.frameHeight,
        context,
        firstDifference: failure.firstDifference,
        artifact,
      });
    }
    return artifact;
  }

  /**
   * Which section of the account diverged. The frame comparison only proves
   * the state roots differ; this diffs the TS section roots captured when the
   * frame committed against the engine's own, so the halt dump names deltas vs
   * locks vs offers vs fee policies instead of one opaque hash.
   */
  async #diverginSections(
    ownerKey: string,
    accountKey: string,
    frame: WaveFrame,
  ): Promise<Record<string, { typescript: string; rust: string }> | undefined> {
    try {
      const client = await this.#ensureClient(ownerKey);
      // Page until the account is found: a hub holds thousands of accounts and
      // reading only the first page left most divergences unlocalized.
      let cursor: Uint8Array | null = null;
      let fields: unknown[] | null = null;
      for (;;) {
        const page = wireTuple(
          await client.readAccountSummaryPage(cursor, 512, []),
          'SHADOW_SECTION_PAGE',
          4,
        );
        const row = wireTuple(page[1], 'SHADOW_SECTION_ROWS').find(candidate =>
          Buffer.from(wireBytes((candidate as unknown[])[0], 'SHADOW_SECTION_ID', 32))
            .toString('hex') === accountKey);
        if (row) {
          fields = wireTuple(row, 'SHADOW_SECTION_ROW', SUMMARY_ROW_FIELDS);
          break;
        }
        const next = page[2];
        if (next === null || next === undefined) break;
        cursor = wireBytes(next, 'SHADOW_SECTION_CURSOR', 32);
      }
      if (!fields) return undefined;
      const engine = (index: number): string =>
        `0x${Buffer.from(wireBytes(fields[index], 'SHADOW_SECTION_ROOT', 32)).toString('hex')}`;
      const pair = (name: string, index: number): [string, { typescript: string; rust: string }] =>
        [name, { typescript: frame.sections[name] ?? 'missing', rust: engine(index) }];
      return Object.fromEntries([
        pair('deltas', 4),
        pair('locks', 5),
        pair('swapOffers', 7),
        pair('rebalanceFeePolicies', 8),
      ]);
    } catch (error) {
      // Diagnostics must never mask the mismatch itself, but a silent failure
      // here is what made "sections: null" indistinguishable from "the account
      // was not found".
      try {
        console.error(
          `RSCORE_SHADOW_SECTION_DIFF_FAILED ${accountKey.slice(0, 8)}:` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      } catch { /* observer-only */ }
      return undefined;
    }
  }

  /** Reply shape for commit/upsert alike: [revision, accountsRoot]. */
  #noteRevision(ownerKey: string, reply: readonly unknown[]): void {
    this.#lastRevision.set(ownerKey, Number(reply[0]));
    this.#lastCommittedRoot.set(
      ownerKey,
      `0x${Buffer.from(reply[1] as Uint8Array).toString('hex')}`,
    );
  }

  #reportGap(gap: ShadowGap): void {
    try { this.#onGap?.(gap); } catch { /* observer-only */ }
  }

  /**
   * One engine process per owner entity: the engine's account tree is keyed by
   * the raw counterparty entity id, so a process may only ever hold the
   * accounts of a single owner — exactly the entity machine's own scope.
   */
  #remember(ownerKey: string, counterpartyId: string, account: AccountReplica): void {
    const key = counterpartyId.trim().toLowerCase();
    const owned = this.#mirrored.get(ownerKey) ?? new Map<string, AccountReplica>();
    owned.set(key, account);
    this.#mirrored.set(ownerKey, owned);
    // The same tree the engine builds, updated leaf by leaf as frames commit:
    // one path copy per frame instead of an O(accounts) rebuild, so the whole
    // tree can be compared at every Runtime boundary rather than at the end.
    const forest = this.#forests.get(ownerKey) ?? emptyForest();
    this.#forests.set(ownerKey, forest.updated(key, computeEntityAccountValueHash(account)));
  }

  /**
   * Stop following an account: drop it from the registry, the live map, the
   * TypeScript forest and the engine's tree, so the two trees keep describing
   * the same account set.
   */
  #forget(ownerKey: string, accountKey: string, counterpartyEntityId: string): void {
    const scopedKey = `${ownerKey}/${accountKey}`;
    const key = counterpartyEntityId.trim().toLowerCase();
    this.#registered.delete(scopedKey);
    this.#needsReseed.delete(scopedKey);
    this.#seeded.delete(scopedKey);
    this.#mirrored.get(ownerKey)?.delete(key);
    const forest = this.#forests.get(ownerKey);
    if (forest?.get(key) !== undefined) this.#forests.set(ownerKey, forest.removed(key));
    this.#push({ kind: 'remove', ownerKey, accountKeys: [accountKey] });
  }

  /**
   * Record an owner this mirror will never follow (more owners than engine
   * processes). Idempotent per owner, and the end-of-run gate fails while the
   * count is non-zero.
   */
  noteUnboundOwner(ownerEntityId: string): void {
    const ownerKey = ownerEntityId.trim().toLowerCase();
    if (this.#boundOwners.has(ownerKey) || this.#reportedUnbound.has(ownerKey)) return;
    this.#reportedUnbound.add(ownerKey);
    this.#stats.skippedUnboundOwner += 1;
  }

  #tryBindOwner(ownerKey: string): boolean {
    if (this.#boundOwners.has(ownerKey)) return true;
    if (this.#boundOwners.size >= this.#maxOwners) return false;
    this.#boundOwners.add(ownerKey);
    return true;
  }

  /**
   * Checkpoint seeds, minus the accounts the engine cannot represent yet. A
   * refused account is a counted coverage hole (and fatal at the gate), not a
   * reason to leave the whole checkpoint unmirrored: one live cross-J offer
   * used to take the entire replay prime down.
   */
  #checkpointSeeds(
    ownerKey: string,
    ownerEntityId: string,
    accounts: readonly (readonly [string, AccountReplica])[],
  ): { seeds: RscoreWireValue[][]; primed: (readonly [string, AccountReplica])[] } {
    const seeds: RscoreWireValue[][] = [];
    const primed: (readonly [string, AccountReplica])[] = [];
    for (const [counterpartyId, account] of accounts) {
      const reason = shadowIneligibilityReason(account.state);
      if (reason !== null) {
        this.#stats.skippedIneligible += 1;
        this.#stats.ineligibleReasons[reason] = (this.#stats.ineligibleReasons[reason] ?? 0) + 1;
        this.#reportGap({
          kind: 'ineligible',
          owner: ownerKey,
          account: counterpartyId.trim().toLowerCase().replace(/^0x/, ''),
          frameHeight: account.currentHeight ?? 0,
          detail: `prime:${reason}`,
          txTypes: [],
        });
        continue;
      }
      seeds.push(accountSeedWire(
        ownerEntityId,
        counterpartyId,
        account.state,
        accountEnvelopeWire(account),
      ));
      primed.push([counterpartyId, account]);
    }
    return { seeds, primed };
  }

  /**
   * Install the registry-derived swap market tables and prove the engine read
   * them as sent: the engine cannot derive pair orientation or the price step
   * from account state, so a silent disagreement there would misprice offers
   * on one side only.
   */
  async #hello(client: RscoreProcessClient): Promise<void> {
    const market = swapMarketPolicyWire();
    const reply = wireTuple(await client.hello(this.#workers, market), 'SHADOW_HELLO', 6);
    const digest = `0x${Buffer.from(wireBytes(reply[3], 'SHADOW_HELLO_MARKET', 32)).toString('hex')}`;
    const expected = swapMarketPolicyDigest(market);
    if (digest !== expected) throw new Error(`SHADOW_HELLO_MARKET_DIGEST:${digest}:${expected}`);
  }

  async #bootstrapAccounts(seeds: RscoreWireValue[][]): Promise<Readonly<{
    client: RscoreProcessClient;
    restored: unknown[];
  }>> {
    const client = this.#makeClient(this.#binaryPath);
    try {
      await this.#hello(client);
      const restored = wireTuple(await client.bootstrapAccounts(0, seeds), 'SHADOW_PRIME_RESTORE', 3);
      return { client, restored };
    } catch (error) {
      client.kill();
      throw error;
    }
  }

  /**
   * Reconcile every owner this mirror bound, against the live replicas it was
   * fed. Used as an end-of-run gate: identical trees mean the two engines are
   * interchangeable, and any gap names the exact account.
   */
  async selfReconcile(state?: RuntimeState): Promise<Map<string, ShadowReconciliation>> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // With the Runtime state in hand this also refreshes the replica shells,
      // so the comparison is against the authority as it stands now rather
      // than as it stood at the last account frame.
      this.flushWave(state);
      await this.#idle;
      const epoch = this.#noteEpoch;
      const reports = new Map<string, ShadowReconciliation>();
      try {
        for (const [ownerKey, accounts] of this.#mirrored) {
          reports.set(ownerKey, await this.reconcile(ownerKey, accounts));
        }
      } catch (error) {
        if (epoch !== this.#noteEpoch && attempt < 3) continue;
        throw error;
      }
      if (
        epoch === this.#noteEpoch
        && this.#pendingWave.size === 0
        && this.#queue.length === 0
        && !this.#draining
      ) {
        return reports;
      }
    }
    throw new Error('RSCORE_SHADOW_RECONCILE_NOT_QUIESCENT');
  }

  async #ensureClient(ownerKey: string): Promise<RscoreProcessClient> {
    const existing = this.#clients.get(ownerKey);
    if (existing) return existing;
    const client = this.#makeClient(this.#binaryPath);
    await this.#hello(client);
    await client.bootstrapAccounts(0, []);
    this.#clients.set(ownerKey, client);
    return client;
  }

  #disable(reason: string): void {
    if (this.#disabledReason !== null) return;
    this.#disabledReason = reason;
    this.#stats.disabledReason = reason;
    this.#queue.length = 0;
    try {
      shadowLog.error('shadow.disabled', { reason });
    } catch { /* observer-only */ }
    // From here on the authority runs unmirrored. Under strict that is a
    // fail-stop: waiting for the end-of-run gate assumes the harness reaches it.
    // Except during teardown, where a broken pipe is the engine going down with
    // the process.
    if (this.#shuttingDown) return;
    this.#reportGap({
      kind: 'disabled',
      owner: '',
      account: '',
      frameHeight: 0,
      detail: reason,
      txTypes: [],
    });
    for (const client of this.#clients.values()) client.kill();
    this.#clients.clear();
  }
}

#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { safeStringify } from '../../core/protocol/serialization/index.ts';

// --- Helpers ---

function parseArg(flag: string): string {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (index < 0 || value === undefined || value.length === 0 || value.startsWith('--')) {
    throw new Error(`Usage: bun tools/hlt-viz/extract.ts --recording <path> --out <path.json> (missing ${flag})`);
  }
  return resolve(value);
}

/** Narrow unknown to Record<string, unknown> */
function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

/** Narrow unknown to string */
function isStr(val: unknown): val is string {
  return typeof val === 'string';
}

/** Narrow unknown to number */
function isNum(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val);
}

/** Safe access to a string field */
function strField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return isStr(v) ? v : undefined;
}

/** Safe access to a number field */
function numField(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return isNum(v) ? v : undefined;
}

/** Safe access to an array */
function arrField(obj: Record<string, unknown>, key: string): unknown[] | undefined {
  const v = obj[key];
  return Array.isArray(v) ? v : undefined;
}

/** Safe access to a record */
function recField(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = obj[key];
  return isRecord(v) ? v : undefined;
}

/** Convert a BigInt-like value or number to its decimal string */
function bigIntStr(val: unknown): string | undefined {
  if (isStr(val)) return val;
  if (typeof val === 'number') return String(val);
  if (isRecord(val) && val.__xlnType === 'BigInt') return strField(val, 'value');
  return undefined;
}

/** Short hash: first 10 hex chars after 0x, or first 10 chars */
function shortHash(val: unknown): string | undefined {
  if (!isStr(val)) return undefined;
  if (val.startsWith('0x') && val.length > 12) return val.slice(0, 12);
  return val.slice(0, 10);
}

// --- Types for the output ---

/** [kindIndex, fromUserIndex|-1, toUserIndex|-1, amountString|null, lockIdShort|null] */
type VizEventArray = [number, number, number, string | null, string | null];

interface VizFrame {
  h: number;
  t: number;
  ev: VizEventArray[];
}

interface VizOutput {
  hub: string;
  users: string[];
  startTs: number;
  endTs: number;
  frames: VizFrame[];
  kinds: string[];
  totals: Record<string, number>;
}

// --- Kind mapping ---

const KINDS: readonly string[] = [
  'lock',
  'resolve',
  'direct',
  'swap_offer',
  'swap_resolve',
  'swap_cancel',
  'settle',
  'other',
];

function kindIndex(type: string): number {
  switch (type) {
    case 'htlc_lock':
      return 0;
    case 'htlc_resolve':
      return 1;
    case 'direct_payment':
      return 2;
    case 'swap_offer':
      return 3;
    case 'swap_resolve':
      return 4;
    case 'swap_cancel_request':
      return 5;
    case 'settle_transition':
      return 6;
    default:
      return 7; // other (includes j_event_claim, add_delta, etc.)
  }
}

// --- Main ---

function main(): void {
  const recordingPath = parseArg('--recording');
  const outPath = parseArg('--out');

  const raw = readFileSync(recordingPath, 'utf-8');
  const data: unknown = JSON.parse(raw);

  // Validate top-level
  if (!isRecord(data)) throw new Error('Root is not an object');
  const source = recField(data, 'source');
  const tail = recField(data, 'tail');
  if (tail === undefined) throw new Error('Missing tail');
  const framesRaw = arrField(tail, 'frames');
  if (framesRaw === undefined) throw new Error('Missing tail.frames');

  // Hub identity from snapshot.checkpoint.eReplicas
  const snapshot = recField(data, 'snapshot');
  let hubId = 'hub';
  if (snapshot !== undefined) {
    const snapCheckpoint = recField(snapshot, 'checkpoint');
    if (snapCheckpoint !== undefined) {
      const eReplicas = arrField(snapCheckpoint, 'eReplicas');
      if (eReplicas !== undefined && eReplicas.length > 0) {
        const firstER = eReplicas[0];
        if (Array.isArray(firstER) && firstER.length > 0 && isStr(firstER[0])) {
          // eReplicas keys are `<entityId>:<signerId>`; account txs carry the bare entityId.
          const [entityId] = firstER[0].split(':');
          if (entityId !== undefined && entityId.length > 0) hubId = entityId;
        }
      }
    }
  }

  // User registry
  const users: string[] = [];
  const userIndex = new Map<string, number>();

  /** User index, or -1 for the hub itself (the hub is never a ring member). */
  function internUserId(id: string): number {
    if (id === hubId) return -1;
    const existing = userIndex.get(id);
    if (existing !== undefined) return existing;
    const idx = users.length;
    users.push(id);
    userIndex.set(id, idx);
    return idx;
  }

  // Kind counts
  const kindCounts: Record<string, number> = {};

  // First pass: intern all user IDs
  for (const frameRaw of framesRaw) {
    if (!isRecord(frameRaw)) continue;
    const runtimeInput = recField(frameRaw, 'runtimeInput');
    if (runtimeInput !== undefined) {
      const eis = arrField(runtimeInput, 'entityInputs');
      if (eis !== undefined) internEntityInputsUserIds(eis);
    }
    const ros = arrField(frameRaw, 'runtimeOutputs');
    if (ros !== undefined) internEntityInputsUserIds(ros);
  }

  function internEntityInputsUserIds(items: unknown[]): void {
    for (const item of items) {
      if (!isRecord(item)) continue;
      const etxs = arrField(item, 'entityTxs');
      if (etxs === undefined) continue;
      for (const etx of etxs) {
        if (!isRecord(etx)) continue;
        const data = recField(etx, 'data');
        if (data === undefined) continue;
        const type = strField(etx, 'type');
        if (type === 'entityCommand') {
          const txs = arrField(data, 'txs');
          if (txs !== undefined) {
            for (const tx of txs) {
              if (!isRecord(tx)) continue;
              const td = recField(tx, 'data');
              if (td === undefined) continue;
              const fe = strField(td, 'fromEntityId');
              const te = strField(td, 'toEntityId');
              if (fe !== undefined) internUserId(fe);
              if (te !== undefined) internUserId(te);
            }
          }
        }
        if (type !== 'accountInput') continue;
        const fromEid = strField(data, 'fromEntityId');
        const toEid = strField(data, 'toEntityId');
        if (fromEid !== undefined) internUserId(fromEid);
        if (toEid !== undefined) internUserId(toEid);
      }
    }
  }

  // Process frames: extract events
  const frames: VizFrame[] = [];
  let startTs = 0;

  for (let fi = 0; fi < framesRaw.length; fi++) {
    const frameRaw = framesRaw[fi];
    if (!isRecord(frameRaw)) continue;

    const height = numField(frameRaw, 'height');
    const timestamp = numField(frameRaw, 'timestamp');
    if (height === undefined || timestamp === undefined) continue;
    if (fi === 0) startTs = timestamp;

    const t = timestamp - startTs;
    const events: VizEventArray[] = [];

    // Walk runtimeInput.entityInputs
    const runtimeInput = recField(frameRaw, 'runtimeInput');
    if (runtimeInput !== undefined) {
      const eis = arrField(runtimeInput, 'entityInputs');
      if (eis !== undefined) {
        for (const ei of eis) {
          if (!isRecord(ei)) continue;
          walkEtxs(arrField(ei, 'entityTxs'), events);
        }
      }
    }

    // Walk runtimeOutputs
    const ros = arrField(frameRaw, 'runtimeOutputs');
    if (ros !== undefined) {
      for (const ro of ros) {
        if (!isRecord(ro)) continue;
        walkEtxs(arrField(ro, 'entityTxs'), events);
      }
    }

    frames.push({ h: height, t, ev: events });
  }

  /** Walk entity txs to find accountInput proposals */
  function walkEtxs(etxs: unknown[] | undefined, events: VizEventArray[]): void {
    if (etxs === undefined) return;
    for (const etx of etxs) {
      if (!isRecord(etx)) continue;
      const type = strField(etx, 'type');
      if (type === undefined) continue;
      const data = recField(etx, 'data');
      if (data === undefined) continue;

      if (type === 'entityCommand') {
        const txs = arrField(data, 'txs');
        if (txs !== undefined) walkEtxs(txs, events);
        continue;
      }

      if (type !== 'accountInput') continue;

      const fromEid = strField(data, 'fromEntityId');
      const toEid = strField(data, 'toEntityId');
      if (fromEid === undefined || toEid === undefined) continue;
      const fromIdx = internUserId(fromEid);
      const toIdx = internUserId(toEid);

      const proposal = recField(data, 'proposal');
      if (proposal === undefined) continue;
      const pf = recField(proposal, 'frame');
      if (pf === undefined) continue;
      const atxs = arrField(pf, 'accountTxs');
      if (atxs === undefined) continue;

      for (const atx of atxs) {
        if (!isRecord(atx)) continue;
        const atype = strField(atx, 'type');
        if (atype === undefined) continue;
        const ki = kindIndex(atype);
        const adata = recField(atx, 'data');
        let amountStr: string | null = null;
        let lockShort: string | null = null;

        if (adata !== undefined) {
          if (atype === 'htlc_lock' || atype === 'direct_payment') {
            amountStr = bigIntStr(adata.amount) ?? null;
          } else if (atype === 'swap_offer') {
            amountStr = bigIntStr(adata.giveAmount) ?? null;
          } else if (atype === 'swap_resolve') {
            amountStr = bigIntStr(adata.executionGiveAmount) ?? null;
          }

          if (atype === 'htlc_lock') {
            lockShort = shortHash(adata.hashlock);
          } else if (atype === 'htlc_resolve') {
            lockShort = shortHash(adata.lockId);
          }
        }

        const kindName = ki < KINDS.length ? KINDS[ki] : 'other';
        kindCounts[kindName] = (kindCounts[kindName] ?? 0) + 1;

        events.push([ki, fromIdx, toIdx, amountStr, lockShort]);
      }
    }
  }

  const endTs = startTs + (frames.length > 0 ? frames[frames.length - 1].t : 0);
  const sourceUsers = isRecord(source) ? numField(source, 'users') : undefined;

  // Build output
  const output: VizOutput = {
    hub: hubId,
    users,
    startTs,
    endTs,
    frames,
    kinds: [...KINDS],
    totals: {
      users: users.length,
      frames: frames.length,
      events: Object.values(kindCounts).reduce((a: number, b: number) => a + b, 0),
      sourceUsers: sourceUsers ?? 0,
      durationMs: endTs - startTs,
      ...kindCounts,
    },
  };

  const json = safeStringify(output);
  writeFileSync(outPath, json, 'utf-8');

  // Report
  const report: Record<string, unknown> = {
    out: outPath,
    bytes: Buffer.byteLength(json),
    users: users.length,
    hub: hubId,
    frames: frames.length,
    events: output.totals.events,
    kinds: { ...kindCounts },
    durationMs: output.totals.durationMs,
    sourceUsers,
  };
  process.stdout.write(`${safeStringify(report)}\n`);
}

main();
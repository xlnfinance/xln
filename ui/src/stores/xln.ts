import { writable } from 'svelte/store';

type XLNModule = any;

export const xlnEnv = writable<any>(null);
export const xln = writable<XLNModule | null>(null);
export const timeIndex = writable<number>(-1);
export const dropdownMode = writable<'signer-first' | 'entity-first'>('signer-first');
export const seedStore = writable<number | null>(null);
export const historyLen = writable<number>(0);

export const toasts = writable<Array<{ id: number; text: string }>>([]);

export function pushToast(text: string) {
  const id = Date.now();
  toasts.update((t) => [...t, { id, text }]);
  setTimeout(() => {
    toasts.update((t) => t.filter((x) => x.id !== id));
  }, 2500);
}

function mulberry32(a: number) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const prng = writable<() => number>(() => Math.random());

export async function initEnvFromBrowser() {
  let XLN: XLNModule | null = null;
  try {
    // Always attempt runtime import in dev; flag still supported to force
    const dynamicImport = new Function('p', 'return import(p)');
    const candidates = [
      '/dist/server.js',
      'http://localhost:8080/dist/server.js',
      `${location.protocol}//${location.hostname}:56522/dist/server.js`,
    ];
    for (const url of candidates) {
      try {
        XLN = await dynamicImport(/* @vite-ignore */ url);
        if (XLN) break;
      } catch (e) {
        // continue
      }
    }
  } catch (e) {
    console.warn('XLN server runtime not available yet:', e);
  }

  if (!XLN) {
    xln.set(null);
    xlnEnv.set(null);
    return { XLN: null, env: null };
  }

  xln.set(XLN);
  const params = new URLSearchParams(location.search);
  const seedParam = params.get('seed');
  if (seedParam) {
    const seedNum = Number(seedParam) >>> 0;
    seedStore.set(seedNum);
    prng.set(mulberry32(seedNum));
  }

  const env = await XLN.main();
  (window as any).xlnEnv = env;
  xlnEnv.set(env);
  try { historyLen.set(XLN.getHistory()?.length ?? 0); } catch {}
  return { XLN, env };
}

export async function createLazyEntity(
  entityName: string,
  validators: Array<{ signer: string; weight: number }>,
  threshold: number,
  jurisdiction: any
) {
  let currentXLN: XLNModule | null = null;
  let env: any = null;
  xln.subscribe((v) => (currentXLN = v));
  xlnEnv.subscribe((v) => (env = v));

  if (!currentXLN || !env) throw new Error('Environment not initialized');

  const signerIds = validators.map((v) => v.signer);
  const config = currentXLN.createLazyEntity(entityName, signerIds, BigInt(threshold), jurisdiction);
  const entityId = currentXLN.generateLazyEntityId(signerIds, BigInt(threshold));

  const serverTxs = signerIds.map((signerId, i) => ({
    type: 'importReplica',
    entityId,
    signerId,
    data: { config, isProposer: i === 0 }
  }));

  const result = currentXLN.applyServerInput(env, { serverTxs, entityInputs: [] });
  currentXLN.processUntilEmpty(env, result.entityOutbox);
  xlnEnv.set(env);
  try { historyLen.set(currentXLN.getHistory()?.length ?? 0); } catch {}
  pushToast(`Entity "${entityName}" created`);
  return { entityId };
}

export async function createNumberedEntity(
  entityName: string,
  validators: Array<{ signer: string; weight: number }>,
  threshold: number,
  jurisdiction: any,
  options?: { registerOnChain?: boolean }
) {
  let currentXLN: XLNModule | null = null;
  let env: any = null;
  xln.subscribe((v) => (currentXLN = v));
  xlnEnv.subscribe((v) => (env = v));

  if (!currentXLN || !env) throw new Error('Environment not initialized');
  if (!jurisdiction) throw new Error('Jurisdiction required for numbered entity');

  const signerIds = validators.map((v) => v.signer);
  const { config, entityNumber } = await currentXLN.createNumberedEntity(entityName, signerIds, BigInt(threshold), jurisdiction);
  const entityId = currentXLN.generateNumberedEntityId(entityNumber);

  const serverTxs = signerIds.map((signerId, i) => ({
    type: 'importReplica',
    entityId,
    signerId,
    data: { config, isProposer: i === 0 }
  }));

  const result = currentXLN.applyServerInput(env, { serverTxs, entityInputs: [] });
  currentXLN.processUntilEmpty(env, result.entityOutbox);
  xlnEnv.set(env);
  updateHistoryLen();
  if (options?.registerOnChain) {
    try {
      await currentXLN.registerNumberedEntityOnChain(config, entityName);
    } catch (e) {
      // registration optional; surface via toast
      pushToast('On-chain registration failed; entity created locally');
    }
  }
  pushToast(`Numbered entity #${entityNumber} created`);
  return { entityId, entityNumber };
}

export function getCurrentXLN(): XLNModule | null {
  let current: XLNModule | null = null;
  xln.subscribe((v) => (current = v))();
  return current;
}

export function updateHistoryLen(): void {
  const current = getCurrentXLN();
  try { historyLen.set(current?.getHistory()?.length ?? 0); } catch { historyLen.set(0); }
}

export async function sendChatMessage(entityId: string, signerId: string, message: string) {
  const current = getCurrentXLN();
  let env: any = null;
  xlnEnv.subscribe((v) => (env = v))();
  if (!current || !env) return;
  const input = { entityId, signerId, entityTxs: [{ type: 'chat', data: { message } }] };
  const result = current.applyServerInput(env, { serverTxs: [], entityInputs: [input] });
  current.processUntilEmpty(env, result.entityOutbox);
  xlnEnv.set(env);
  updateHistoryLen();
}

export async function proposeCollectiveMessage(entityId: string, signerId: string, message: string) {
  const current = getCurrentXLN();
  let env: any = null;
  xlnEnv.subscribe((v) => (env = v))();
  if (!current || !env) return;
  const input = {
    entityId,
    signerId,
    entityTxs: [
      { type: 'propose', data: { action: { type: 'collective_message', data: { message } }, proposer: signerId } },
    ],
  };
  const result = current.applyServerInput(env, { serverTxs: [], entityInputs: [input] });
  current.processUntilEmpty(env, result.entityOutbox);
  xlnEnv.set(env);
  updateHistoryLen();
}

export async function voteOnProposal(entityId: string, signerId: string, proposalId: string, choice: 'yes' | 'no' | 'abstain', comment?: string) {
  const current = getCurrentXLN();
  let env: any = null;
  xlnEnv.subscribe((v) => (env = v))();
  if (!current || !env) return;
  const voteData = comment ? { choice, comment } : choice;
  const input = { entityId, signerId, entityTxs: [{ type: 'vote', data: { proposalId, voter: signerId, choice, comment } }] };
  const result = current.applyServerInput(env, { serverTxs: [], entityInputs: [input] });
  current.processUntilEmpty(env, result.entityOutbox);
  xlnEnv.set(env);
  updateHistoryLen();
}

export function setTimePosition(index: number) {
  timeIndex.set(index);
}

export function getReplicaAtTime(entityId: string, signerId: string): any | null {
  let current: XLNModule | null = null; xln.subscribe(v => current = v)();
  let env: any = null; xlnEnv.subscribe(v => env = v)();
  if (!current) return null;
  let snapshotEnv = env;
  let idx: number | null = null; timeIndex.subscribe(v => idx = v)();
  if (idx !== null && typeof idx === 'number' && idx >= 0) {
    try { snapshotEnv = current.getHistory()?.[idx] ?? env; } catch {}
  }
  if (!snapshotEnv?.replicas) return null;
  return snapshotEnv.replicas.get(`${entityId}:${signerId}`) ?? null;
}

export async function runDemoIfAvailable() {
  const current = getCurrentXLN();
  let env: any = null; xlnEnv.subscribe(v => env = v)();
  if (!current || !env) return;
  try { await (current.runDemoWrapper?.(env) ?? current.runDemo?.(env)); updateHistoryLen(); } catch {}
}

export async function getAvailableJurisdictions(): Promise<Map<string, any>> {
  const current = getCurrentXLN();
  if (!current) return new Map();
  try {
    const result = await current.getAvailableJurisdictions();
    // Runtime may return an array of jurisdiction configs; normalize to Map keyed by RPC port
    if (result instanceof Map) return result as Map<string, any>;
    const m = new Map<string, any>();
    const arr: any[] = Array.isArray(result) ? result : [];
    for (const j of arr) {
      try {
        const url = new URL(j.address || j.rpc || '');
        const port = url.port || (url.protocol === 'http:' ? '80' : '443');
        if (port) m.set(String(port), j);
      } catch {
        // Fallback: try to extract :PORT from string
        const match = String(j.address || j.rpc || '').match(/:(\d{2,5})\b/);
        if (match) m.set(match[1], j);
      }
    }
    return m;
  } catch {
    return new Map();
  }
}

export async function getJurisdictionByPort(port: number | string): Promise<any | null> {
  const key = String(port);
  const map = await getAvailableJurisdictions();
  return map.get(key) ?? null;
}

export async function getNextEntityNumber(jurisdiction: any): Promise<number | null> {
  const current = getCurrentXLN();
  if (!current || !jurisdiction) return null;
  try {
    const n = await current.getNextEntityNumber(jurisdiction);
    return Number(n);
  } catch {
    return null;
  }
}



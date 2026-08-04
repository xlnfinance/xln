import type { RuntimeActivityEvent, RuntimeAdapterEntitySummary } from '@xln/runtime/api/public/runtime-module';
import { probeRpcHealth } from '$lib/health/rpcHealth';
import { runtimeControllerHandleExternalStore } from '$lib/stores/runtimeControllerStore';
import { runtimeQueryClient } from '$lib/stores/runtimeQueryClient';
import { createExternalStore } from '../../../packages/client-core/external-store';

export type OpsHealthGate = Readonly<{ id: string; label: string; status: 'ready' | 'degraded' | 'down' | 'unknown'; detail: string }>;
export type OpsHealthHub = Readonly<{ entityId: string; name: string; status: 'healthy' | 'degraded' | 'down'; online: boolean; accounts: number | null }>;
export type OpsHealthProcess = Readonly<{ name: string; role: string; online: boolean; restartCount: number; lastError: string | null }>;
export type OpsHealthView = Readonly<{
  timestamp: number;
  verdict: 'READY' | 'DEGRADED' | 'FAIL' | 'UNKNOWN';
  reason: string;
  sourceHeight: number | null;
  codeHash: string | null;
  gitHead: string | null;
  dirty: boolean;
  uptimeMs: number | null;
  hubs: readonly OpsHealthHub[];
  gates: readonly OpsHealthGate[];
  processes: readonly OpsHealthProcess[];
  storage: Readonly<{ ok: boolean | null; freeBytes: number | null; usedPct: number | null; tracked: number }>;
}>;

export type OpsHealthSnapshot = Readonly<{
  loading: boolean;
  health: OpsHealthView | null;
  error: string | null;
  projectionError: string | null;
  events: readonly RuntimeActivityEvent[];
  entities: readonly RuntimeAdapterEntitySummary[];
  rpc: Readonly<{ ok: boolean | null; latencyMs: number | null; error: string | null }>;
}>;

const record = (value: unknown, code: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
};
const array = (value: unknown, code: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(code);
  return value;
};
const text = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim();
};
const optionalText = (value: unknown, code: string): string | null => value === null || value === undefined ? null : text(value, code);
const emptyableText = (value: unknown, code: string): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(code);
  return value.trim() || null;
};
const number = (value: unknown, code: string, minimum = 0): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) throw new Error(code);
  return value;
};
const optionalNumber = (value: unknown, code: string, minimum = 0): number | null => value === null || value === undefined ? null : number(value, code, minimum);
const optionalBoolean = (value: unknown, code: string): boolean | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'boolean') throw new Error(code);
  return value;
};

const gate = (id: string, label: string, value: boolean | null, detail: string): OpsHealthGate => Object.freeze({
  id, label, status: value === true ? 'ready' : value === false ? 'down' : 'unknown', detail,
});

export const parseOpsHealth = (value: unknown): OpsHealthView => {
  const raw = record(value, 'OPS_HEALTH_PAYLOAD_INVALID');
  const timestamp = number(raw['timestamp'], 'OPS_HEALTH_TIMESTAMP_INVALID', 1);
  const system = record(raw['system'], 'OPS_HEALTH_SYSTEM_INVALID');
  const runtimeOk = optionalBoolean(system['runtime'], 'OPS_HEALTH_RUNTIME_INVALID');
  const relayOk = optionalBoolean(system['relay'], 'OPS_HEALTH_RELAY_INVALID');
  const coreOk = optionalBoolean(raw['coreOk'], 'OPS_HEALTH_CORE_INVALID');
  const systemOk = optionalBoolean(raw['systemOk'], 'OPS_HEALTH_SYSTEM_OK_INVALID');
  const degraded = array(raw['degraded'] ?? [], 'OPS_HEALTH_DEGRADED_INVALID').map((entry, index) => text(entry, `OPS_HEALTH_DEGRADED_ENTRY_INVALID:${index}`));
  const source = raw['source'] === undefined ? {} : record(raw['source'], 'OPS_HEALTH_SOURCE_INVALID');
  const process = raw['process'] === undefined ? {} : record(raw['process'], 'OPS_HEALTH_PROCESS_INVALID');
  const disk = raw['disk'] === undefined ? {} : record(raw['disk'], 'OPS_HEALTH_DISK_INVALID');
  const storage = raw['storage'] === undefined ? {} : record(raw['storage'], 'OPS_HEALTH_STORAGE_INVALID');
  const mesh = raw['hubMesh'] === undefined ? {} : record(raw['hubMesh'], 'OPS_HEALTH_MESH_INVALID');
  const market = raw['marketMaker'] === undefined ? {} : record(raw['marketMaker'], 'OPS_HEALTH_MARKET_INVALID');
  const reserves = raw['bootstrapReserves'] === undefined ? {} : record(raw['bootstrapReserves'], 'OPS_HEALTH_RESERVES_INVALID');
  const hubs = array(raw['hubs'], 'OPS_HEALTH_HUBS_INVALID').map((entry, index): OpsHealthHub => {
    const hub = record(entry, `OPS_HEALTH_HUB_INVALID:${index}`);
    const online = optionalBoolean(hub['online'], `OPS_HEALTH_HUB_ONLINE_INVALID:${index}`) ?? false;
    const status = optionalText(hub['status'], `OPS_HEALTH_HUB_STATUS_INVALID:${index}`) ?? (online ? 'healthy' : 'down');
    if (status !== 'healthy' && status !== 'degraded' && status !== 'down') throw new Error(`OPS_HEALTH_HUB_STATUS_UNKNOWN:${status}`);
    const name = text(hub['name'], `OPS_HEALTH_HUB_NAME_INVALID:${index}`);
    return Object.freeze({
      entityId: emptyableText(hub['entityId'], `OPS_HEALTH_HUB_ID_INVALID:${index}`)?.toLowerCase() ?? `pending:${name.toLowerCase()}`,
      name,
      status,
      online,
      accounts: optionalNumber(hub['accounts'], `OPS_HEALTH_HUB_ACCOUNTS_INVALID:${index}`),
    });
  });
  const children = array(process['children'] ?? [], 'OPS_HEALTH_CHILDREN_INVALID').map((entry, index): OpsHealthProcess => {
    const child = record(entry, `OPS_HEALTH_CHILD_INVALID:${index}`);
    return Object.freeze({
      name: text(child['name'], `OPS_HEALTH_CHILD_NAME_INVALID:${index}`),
      role: optionalText(child['role'], `OPS_HEALTH_CHILD_ROLE_INVALID:${index}`) ?? 'process',
      online: optionalBoolean(child['online'], `OPS_HEALTH_CHILD_ONLINE_INVALID:${index}`) ?? false,
      restartCount: optionalNumber(child['restartCount'], `OPS_HEALTH_CHILD_RESTART_INVALID:${index}`) ?? 0,
      lastError: optionalText(child['lastErrorLine'], `OPS_HEALTH_CHILD_ERROR_INVALID:${index}`),
    });
  });
  const marketEnabled = optionalBoolean(market['enabled'], 'OPS_HEALTH_MARKET_ENABLED_INVALID') ?? false;
  const marketOk = optionalBoolean(market['ok'], 'OPS_HEALTH_MARKET_OK_INVALID');
  const reserveOk = optionalBoolean(reserves['ok'], 'OPS_HEALTH_RESERVE_OK_INVALID');
  const reserveTarget = optionalBoolean(reserves['targetMet'], 'OPS_HEALTH_RESERVE_TARGET_INVALID');
  const gateRows = [
    gate('runtime', 'Runtime', runtimeOk, runtimeOk === true ? 'runtime process reachable' : 'runtime process unavailable'),
    gate('relay', 'Relay', relayOk, relayOk === true ? 'relay reachable' : 'relay unavailable'),
    gate('mesh', 'Direct mesh', optionalBoolean(mesh['ok'], 'OPS_HEALTH_MESH_OK_INVALID'), `${optionalNumber(record(mesh['direct'] ?? {}, 'OPS_HEALTH_MESH_DIRECT_INVALID')['openLinkCount'], 'OPS_HEALTH_LINK_COUNT_INVALID') ?? 0} open links`),
    gate('market', 'Market maker', marketEnabled ? marketOk : true, marketEnabled ? text(market['startupPhase'] ?? 'enabled', 'OPS_HEALTH_MARKET_PHASE_INVALID') : 'disabled by policy'),
    gate('reserves', 'Bootstrap reserves', reserveOk === true && reserveTarget === true, `${optionalNumber(reserves['entityCount'], 'OPS_HEALTH_RESERVE_ENTITIES_INVALID') ?? 0} entities`),
    gate('storage', 'Storage', optionalBoolean(storage['ok'] ?? disk['ok'], 'OPS_HEALTH_STORAGE_OK_INVALID'), `${optionalNumber(disk['usedPct'], 'OPS_HEALTH_DISK_USED_INVALID') ?? 0}% used`),
  ];
  const verdict = coreOk === false || systemOk === false ? 'FAIL'
    : coreOk === true && systemOk === true && degraded.length === 0 ? 'READY'
    : degraded.length > 0 ? 'DEGRADED' : 'UNKNOWN';
  return Object.freeze({
    timestamp,
    verdict,
    reason: degraded.join(', ') || (verdict === 'READY' ? 'All reported system gates are clear' : 'Health evidence is incomplete'),
    sourceHeight: optionalNumber(source['height'], 'OPS_HEALTH_SOURCE_HEIGHT_INVALID'),
    codeHash: optionalText(source['codeHash'], 'OPS_HEALTH_CODE_HASH_INVALID'),
    gitHead: optionalText(source['gitHead'], 'OPS_HEALTH_GIT_HEAD_INVALID'),
    dirty: optionalBoolean(source['dirty'], 'OPS_HEALTH_DIRTY_INVALID') ?? false,
    uptimeMs: optionalNumber(raw['uptime'] ?? (process['uptimeSec'] === undefined ? null : number(process['uptimeSec'], 'OPS_HEALTH_UPTIME_SEC_INVALID') * 1_000), 'OPS_HEALTH_UPTIME_INVALID'),
    hubs: Object.freeze(hubs),
    gates: Object.freeze(gateRows),
    processes: Object.freeze(children),
    storage: Object.freeze({
      ok: optionalBoolean(storage['ok'] ?? disk['ok'], 'OPS_HEALTH_STORAGE_OK_INVALID'),
      freeBytes: optionalNumber(disk['freeBytes'], 'OPS_HEALTH_DISK_FREE_INVALID'),
      usedPct: optionalNumber(disk['usedPct'], 'OPS_HEALTH_DISK_USED_INVALID'),
      tracked: array(storage['tracked'] ?? [], 'OPS_HEALTH_STORAGE_TRACKED_INVALID').length,
    }),
  });
};

const emptySnapshot = (): OpsHealthSnapshot => Object.freeze({
  loading: false, health: null, error: null, projectionError: null,
  events: Object.freeze([]), entities: Object.freeze([]), rpc: Object.freeze({ ok: null, latencyMs: null, error: null }),
});
const binding = createExternalStore(emptySnapshot());
export const opsHealthExternalStore = binding.store;
let interval: number | null = null;
let owners = 0;
let version = 0;

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error || 'OPS_HEALTH_READ_FAILED');

const refresh = async (): Promise<void> => {
  const requestVersion = ++version;
  binding.controller.update(snapshot => Object.freeze({ ...snapshot, loading: true, error: null }));
  const handle = runtimeControllerHandleExternalStore.getSnapshot();
  const healthPromise = fetch('/api/health', { cache: 'no-store' }).then(async response => {
    if (!response.ok) throw new Error(`OPS_HEALTH_HTTP_${response.status}`);
    return parseOpsHealth(await response.json());
  });
  const projectionPromise = handle.status === 'connected'
    ? Promise.all([runtimeQueryClient.readActivity({ limit: 250, scanLimit: 500 }), runtimeQueryClient.readEntities({ limit: 1000 })])
    : Promise.reject(new Error(`OPS_RUNTIME_PROJECTION_UNAVAILABLE:${handle.status}`));
  const [healthResult, rpcResult, projectionResult] = await Promise.allSettled([healthPromise, probeRpcHealth(), projectionPromise]);
  if (requestVersion !== version) return;
  const prior = binding.store.getSnapshot();
  const health = healthResult.status === 'fulfilled' ? healthResult.value : null;
  const rpc = rpcResult.status === 'fulfilled'
    ? Object.freeze({ ok: rpcResult.value.ok, latencyMs: rpcResult.value.latencyMs, error: rpcResult.value.error ?? null })
    : Object.freeze({ ok: false, latencyMs: null, error: errorText(rpcResult.reason) });
  const projection = projectionResult.status === 'fulfilled' ? projectionResult.value : null;
  binding.controller.set(Object.freeze({
    loading: false,
    health,
    error: healthResult.status === 'rejected' ? errorText(healthResult.reason) : null,
    projectionError: projectionResult.status === 'rejected' ? errorText(projectionResult.reason) : null,
    events: projection ? Object.freeze(projection[0].events) : prior.events,
    entities: projection ? Object.freeze(projection[1]) : prior.entities,
    rpc,
  }));
};

export const opsHealthController = Object.freeze({
  start: (): void => {
    owners += 1;
    if (owners > 1) return;
    void refresh();
    interval = window.setInterval(() => void refresh(), 4_000);
  },
  stop: (): void => {
    owners = Math.max(0, owners - 1);
    if (owners > 0) return;
    if (interval !== null) window.clearInterval(interval);
    interval = null;
    version += 1;
  },
  refresh,
});

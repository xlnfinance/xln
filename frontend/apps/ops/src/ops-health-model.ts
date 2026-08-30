import type { RpcHealthProbeResult } from '../../../src/lib/health/rpcHealth';
import {
  formatQaBytes,
  normalizeQaAdminHealth,
  type QaAdminHealthSnapshot,
} from '../../../src/lib/health/adminHealth';
import { isUnknownRecord } from '../../../src/lib/utils/boundary';

export type OpsHealthEvidence = Readonly<{
  admin: QaAdminHealthSnapshot;
  timestamp: number;
  uptimeMs: number | null;
  p2pOk: boolean | null;
  jBlock: number | null;
  sourceHeight: number | null;
  codeHash: string | null;
  sourceOwner: string | null;
  resetInProgress: boolean;
  resetError: string | null;
  marketMakerEnabled: boolean | null;
  marketMakerOk: boolean | null;
  marketMakerPhase: string | null;
  rssBytes: number | null;
  heapUsedBytes: number | null;
}>;

export type OpsHealthVerdict = Readonly<{
  status: 'READY' | 'DEGRADED' | 'FAIL';
  reason: string;
}>;

export type OpsHealthMetric = Readonly<{
  label: string;
  value: string;
  state: 'ok' | 'fail' | 'neutral';
}>;

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const cleanString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const optionalBoolean = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null;

const childRecord = (record: Record<string, unknown>, key: string): Record<string, unknown> =>
  isUnknownRecord(record[key]) ? record[key] : {};

const firstJBlock = (payload: Record<string, unknown>): number | null => {
  const machines = payload['jMachines'];
  if (!Array.isArray(machines)) return null;
  const first = machines.find(isUnknownRecord);
  return first ? finiteNumber(first['lastBlock']) : null;
};

export const decodeOpsHealthEvidence = (
  payload: unknown,
  observedAt: number,
): OpsHealthEvidence => {
  if (!isUnknownRecord(payload)) throw new Error('OPS_HEALTH_RESPONSE_INVALID');
  const system = childRecord(payload, 'system');
  if (
    typeof payload['coreOk'] !== 'boolean'
    || typeof payload['systemOk'] !== 'boolean'
    || typeof system['runtime'] !== 'boolean'
    || typeof system['relay'] !== 'boolean'
  ) throw new Error('OPS_HEALTH_RESPONSE_INVALID');
  const admin = normalizeQaAdminHealth(payload);
  if (!admin) throw new Error('OPS_HEALTH_RESPONSE_INVALID');
  const process = childRecord(payload, 'process');
  const source = childRecord(payload, 'source');
  const reset = childRecord(payload, 'reset');
  const marketMaker = childRecord(payload, 'marketMaker');
  const timestamp = finiteNumber(payload['timestamp']) ?? observedAt;
  const uptime = finiteNumber(payload['uptime']);
  const uptimeSeconds = finiteNumber(process['uptimeSec']);

  return {
    admin,
    timestamp,
    uptimeMs: uptime ?? (uptimeSeconds === null ? null : uptimeSeconds * 1_000),
    p2pOk: optionalBoolean(system['p2p']),
    jBlock: firstJBlock(payload),
    sourceHeight: finiteNumber(source['height']),
    codeHash: cleanString(source['codeHash']),
    sourceOwner: cleanString(source['owner']),
    resetInProgress: optionalBoolean(reset['inProgress']) === true,
    resetError: cleanString(reset['lastError']),
    marketMakerEnabled: optionalBoolean(marketMaker['enabled']),
    marketMakerOk: optionalBoolean(marketMaker['ok']),
    marketMakerPhase: cleanString(marketMaker['startupPhase']),
    rssBytes: finiteNumber(process['rssBytes']),
    heapUsedBytes: finiteNumber(process['heapUsedBytes']),
  };
};

export const deriveOpsHealthVerdict = (
  health: OpsHealthEvidence,
  rpc: RpcHealthProbeResult | null,
): OpsHealthVerdict => {
  if (rpc?.ok === false) return { status: 'FAIL', reason: `RPC health check failed: ${rpc.error ?? 'unknown'}` };
  if (health.admin.systemOk === false || health.admin.coreOk === false) {
    return {
      status: 'FAIL',
      reason: health.admin.degraded.join(', ') || 'Core/system health gate failed',
    };
  }
  if (!rpc) return { status: 'DEGRADED', reason: 'RPC health check is pending' };
  return { status: 'READY', reason: 'Health gates are clear' };
};

export const deriveOpsHealthDisplayVerdict = (
  health: OpsHealthEvidence,
  rpc: RpcHealthProbeResult | null,
  refreshError: string,
): OpsHealthVerdict => refreshError
  ? { status: 'FAIL', reason: 'Latest refresh failed; showing the last verified snapshot' }
  : deriveOpsHealthVerdict(health, rpc);

const metricState = (value: boolean | null): OpsHealthMetric['state'] =>
  value === true ? 'ok' : value === false ? 'fail' : 'neutral';

const booleanLabel = (value: boolean | null): string =>
  value === true ? 'healthy' : value === false ? 'down' : 'unknown';

export const formatOpsHealthUptime = (milliseconds: number | null): string => {
  if (milliseconds === null) return 'n/a';
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
};

export const shortOpsHealthHash = (value: string | null): string => {
  if (!value) return 'n/a';
  const dirty = value.endsWith('-dirty');
  const clean = dirty ? value.slice(0, -6) : value;
  return `${clean.slice(0, 10)}${dirty ? '-dirty' : ''}`;
};

export const buildOpsHealthMetrics = (
  health: OpsHealthEvidence,
  rpc: RpcHealthProbeResult | null,
): readonly OpsHealthMetric[] => [
  { label: 'Core', value: booleanLabel(health.admin.coreOk), state: metricState(health.admin.coreOk) },
  { label: 'System', value: booleanLabel(health.admin.systemOk), state: metricState(health.admin.systemOk) },
  { label: 'Runtime', value: booleanLabel(health.admin.runtimeOk), state: metricState(health.admin.runtimeOk) },
  { label: 'P2P', value: booleanLabel(health.p2pOk), state: metricState(health.p2pOk) },
  { label: 'Relay', value: booleanLabel(health.admin.relayOk), state: metricState(health.admin.relayOk) },
  {
    label: 'RPC',
    value: rpc ? (rpc.ok ? `${rpc.latencyMs ?? 0}ms` : 'down') : 'checking',
    state: metricState(rpc?.ok ?? null),
  },
  { label: 'Uptime', value: formatOpsHealthUptime(health.uptimeMs), state: 'neutral' },
  { label: 'J block', value: health.jBlock === null ? 'n/a' : `#${Math.floor(health.jBlock)}`, state: 'neutral' },
  { label: 'Direct links', value: String(health.admin.directLinkCount), state: 'neutral' },
  {
    label: 'Disk free',
    value: health.admin.disk.freeGiB === null ? 'n/a' : `${health.admin.disk.freeGiB.toFixed(1)} GiB`,
    state: metricState(health.admin.disk.ok),
  },
  { label: 'RSS', value: health.rssBytes === null ? 'n/a' : formatQaBytes(health.rssBytes), state: 'neutral' },
  { label: 'Relay clients', value: String(health.admin.relayActiveClientCount), state: 'neutral' },
];

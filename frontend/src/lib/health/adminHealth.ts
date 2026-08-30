import { isUnknownRecord as isRecord } from '../utils/boundary';

export type QaAdminHealthOwner = {
  role: string;
  name: string;
  status: 'online' | 'offline' | 'unknown';
  runtimeId: string | null;
  dbPath: string | null;
  detail: string | null;
};

export type QaAdminStorageTrack = {
  name: string;
  kind: string;
  path: string;
  currentBytes: number;
  deltaBytes1h: number;
  bytesPerHour: number;
  scanMode: string;
  scanTruncated: boolean;
};

export type QaAdminCreditPair = {
  left: string;
  right: string;
  ok: boolean;
  expectedCreditAmount: string;
};

export type QaAdminHealthSnapshot = {
  systemOk: boolean | null;
  coreOk: boolean | null;
  runtimeOk: boolean | null;
  relayOk: boolean | null;
  relayActiveClientCount: number;
  relayProfileCount: number;
  watchtowerCount: number;
  degraded: string[];
  disk: { ok: boolean | null; freeGiB: number | null; usedPct: number | null };
  directLinkCount: number;
  owners: QaAdminHealthOwner[];
  tracked: QaAdminStorageTrack[];
  creditPairs: QaAdminCreditPair[];
};

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;
const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const asBoolean = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null;
const asRecordArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const normalizeOwner = (input: Record<string, unknown>, defaultRole: string): QaAdminHealthOwner => {
  const online = asBoolean(input['online']);
  const exitCode = asNumber(input['exitCode']);
  return {
    role: asString(input['role']) ?? defaultRole,
    name: asString(input['name']) ?? asString(input['role']) ?? defaultRole,
    status: online === true || exitCode === null ? 'online' : online === false ? 'offline' : 'unknown',
    runtimeId: asString(input['runtimeId']) ?? asString(input['leaseOwnerId']),
    dbPath: asString(input['dbPath']),
    detail: asString(input['lastErrorLine']) ?? (asNumber(input['apiPort']) ? `api:${asNumber(input['apiPort'])}` : null),
  };
};

const normalizeTracked = (input: Record<string, unknown>): QaAdminStorageTrack | null => {
  const name = asString(input['name']);
  const path = asString(input['path']);
  if (!name || !path) return null;
  return {
    name,
    kind: asString(input['kind']) ?? 'unknown',
    path,
    currentBytes: asNumber(input['currentBytes']) ?? 0,
    deltaBytes1h: asNumber(input['deltaBytes1h']) ?? 0,
    bytesPerHour: asNumber(input['bytesPerHour']) ?? 0,
    scanMode: asString(input['scanMode']) ?? 'unknown',
    scanTruncated: asBoolean(input['scanTruncated']) ?? false,
  };
};

const normalizeCreditPair = (input: Record<string, unknown>): QaAdminCreditPair | null => {
  const left = asString(input['left']);
  const right = asString(input['right']);
  if (!left || !right) return null;
  return {
    left,
    right,
    ok: asBoolean(input['ok']) ?? false,
    expectedCreditAmount: asString(input['expectedCreditAmount']) ?? 'n/a',
  };
};

export const normalizeQaAdminHealth = (payload: unknown): QaAdminHealthSnapshot | null => {
  if (!isRecord(payload)) return null;
  const process = isRecord(payload['process']) ? payload['process'] : {};
  const system = isRecord(payload['system']) ? payload['system'] : {};
  const relay = isRecord(payload['relay']) ? payload['relay'] : {};
  const storage = isRecord(payload['storage']) ? payload['storage'] : {};
  const disk = isRecord(payload['disk']) ? payload['disk'] : {};
  const hubMesh = isRecord(payload['hubMesh']) ? payload['hubMesh'] : {};
  const direct = isRecord(hubMesh['direct']) ? hubMesh['direct'] : {};
  const marketMaker = isRecord(payload['marketMaker']) ? payload['marketMaker'] : {};
  const custody = isRecord(payload['custody']) ? payload['custody'] : {};
  const owners = [
    ...asRecordArray(process['children']).map(child => normalizeOwner(child, 'child')),
    ...asRecordArray(payload['hubs']).map(hub => normalizeOwner(hub, 'hub')),
  ];
  if (asBoolean(marketMaker['enabled']) !== null) {
    owners.push({
      role: 'market-maker', name: 'market-maker',
      status: asBoolean(marketMaker['ok']) === true ? 'online' : 'offline',
      runtimeId: asString(marketMaker['entityId']), dbPath: null,
      detail: `offers ${asNumber(marketMaker['expectedOffersPerHub']) ?? 0}/hub`,
    });
  }
  if (asBoolean(custody['enabled']) !== null) {
    owners.push({
      role: 'custody', name: 'custody',
      status: asBoolean(custody['ok']) === true ? 'online' : 'offline',
      runtimeId: asString(custody['entityId']), dbPath: null,
      detail: asNumber(custody['servicePort']) ? `service:${asNumber(custody['servicePort'])}` : null,
    });
  }
  return {
    systemOk: asBoolean(payload['systemOk']),
    coreOk: asBoolean(payload['coreOk']),
    runtimeOk: asBoolean(system['runtime']),
    relayOk: asBoolean(system['relay']),
    relayActiveClientCount: asNumber(relay['activeClientCount']) ?? asNumber(relay['clientCount']) ?? 0,
    relayProfileCount: asNumber(relay['profileCount']) ?? 0,
    watchtowerCount: owners.filter(owner => /watchtower|tower/i.test(owner.role)).length,
    degraded: Array.isArray(payload['degraded']) ? payload['degraded'].map(String).filter(Boolean) : [],
    disk: { ok: asBoolean(disk['ok']), freeGiB: asNumber(disk['freeGiB']), usedPct: asNumber(disk['usedPct']) },
    directLinkCount: asNumber(direct['openLinkCount']) ?? 0,
    owners,
    tracked: asRecordArray(storage['tracked']).map(normalizeTracked).filter((value): value is QaAdminStorageTrack => Boolean(value)),
    creditPairs: asRecordArray(hubMesh['pairs']).map(normalizeCreditPair).filter((value): value is QaAdminCreditPair => Boolean(value)),
  };
};

export const formatQaBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${Math.round(bytes)} B`;
};

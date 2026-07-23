import { normalizeWsConnectUrl } from './wsUrl';
import { REMOTE_RUNTIME } from '@xln/runtime/constants';

export const REMOTE_RUNTIME_IMPORT_HASH_PARAM = REMOTE_RUNTIME.IMPORT_HASH_PARAM;
export const REMOTE_RUNTIME_IMPORT_SOURCE_HASH_PARAM = REMOTE_RUNTIME.IMPORT_SOURCE_HASH_PARAM;
export const REMOTE_RUNTIME_IMPORT_STORAGE_KEY = REMOTE_RUNTIME.IMPORT_STORAGE_KEY;
export const REMOTE_RUNTIME_IMPORT_RESULT_STORAGE_KEY = REMOTE_RUNTIME.IMPORT_RESULT_STORAGE_KEY;
export const MAX_REMOTE_RUNTIME_IMPORTS = REMOTE_RUNTIME.MAX_IMPORTS;

export type RemoteRuntimeImportAccess = 'admin';

export type RemoteRuntimeImportEntry = {
  label: string;
  access: RemoteRuntimeImportAccess;
  wsUrl: string;
  token: string;
};

export type RemoteRuntimeHubJurisdiction = {
  name?: string;
  address?: string;
  chainId?: number | string;
  depositoryAddress?: string;
  entityProviderAddress?: string;
};

export type RemoteRuntimeHubSummary = {
  entityId: string;
  runtimeId?: string;
  label: string;
  height: number;
  jurisdiction?: RemoteRuntimeHubJurisdiction;
};

export type StoredRemoteRuntimeImportEntry = RemoteRuntimeImportEntry & {
  runtimeId: string;
  authLevel: 'admin';
  height: number;
  entityCount: number;
  importedAt: number;
  hubEntityId?: string;
  hubName?: string;
  hubJurisdiction?: RemoteRuntimeHubJurisdiction;
  hubEntities?: RemoteRuntimeHubSummary[];
};

export type RemoteRuntimeImportManifest = {
  v: 1;
  entries: RemoteRuntimeImportEntry[];
  issuedAt?: number;
  expiresAt?: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const normalizeAccess = (value: unknown): RemoteRuntimeImportAccess => {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'admin' || raw === 'full' || raw === 'write') return 'admin';
  throw new Error(`REMOTE_RUNTIME_IMPORT_ACCESS_INVALID:${raw || 'missing'}`);
};

export const remoteRuntimeIdForWsUrl = (wsUrl: string): string =>
  `radapter:${normalizeRemoteRuntimeWsUrl(wsUrl)}`.toLowerCase();

export const normalizeRemoteRuntimeWsUrl = (value: string): string => {
  const parsed = new URL(normalizeWsConnectUrl(String(value || '').trim()));
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('REMOTE_RUNTIME_WS_REQUIRED');
  }
  return parsed.toString();
};

const decodeBase64UrlUtf8 = (value: string): string => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = `${normalized}${'='.repeat((4 - normalized.length % 4) % 4)}`;
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

export const readRemoteRuntimeTokenExpiry = (token: string): number | null => {
  const parts = String(token || '').trim().split('.');
  if (parts.length !== 7 || parts[0] !== 'xlnra1') return null;
  const expiresAt = Math.floor(Number(parts[2]));
  return Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null;
};

export const readRemoteRuntimeTokenAudience = (token: string): string => {
  const parts = String(token || '').trim().split('.');
  if (parts.length !== 7 || parts[0] !== 'xlnra1') return '';
  try {
    return decodeBase64UrlUtf8(parts[3] || '').trim().toLowerCase();
  } catch {
    return '';
  }
};

export const readRemoteRuntimeTokenAccess = (token: string): RemoteRuntimeImportAccess | '' => {
  const role = String(token || '').trim().split('.')[1]?.trim().toLowerCase();
  if (role === 'full' || role === 'admin' || role === 'write') return 'admin';
  return '';
};

export const assertRemoteRuntimeTokenFresh = (entry: Pick<RemoteRuntimeImportEntry, 'label' | 'token'>, now = Date.now()): void => {
  const expiresAt = readRemoteRuntimeTokenExpiry(entry.token);
  if (expiresAt !== null && expiresAt <= now) {
    throw new Error(`REMOTE_RUNTIME_TOKEN_EXPIRED:${entry.label || 'runtime'}:${expiresAt}`);
  }
};

export const describeRemoteRuntimeImportError = (
  value: unknown,
  entry?: Pick<RemoteRuntimeImportEntry, 'label' | 'wsUrl' | 'access'>,
): string => {
  const raw = value instanceof Error ? value.message : String(value || 'Remote runtime import failed');
  const label = entry?.label || 'runtime';
  const wsUrl = entry?.wsUrl || '';
  if (raw.startsWith('REMOTE_RUNTIME_CONNECT_FAILED:') || raw.includes('WebSocket') || raw.includes('network error')) {
    return `${label}: connection failed. Check that the mesh is running and ${wsUrl || 'the WebSocket URL'} is reachable from the browser.`;
  }
  if (raw.startsWith('REMOTE_RUNTIME_ACCESS_MISMATCH:')) {
    return `${label}: a full admin capability is required, but the server returned a different token role.`;
  }
  if (raw.startsWith('REMOTE_RUNTIME_IMPORT_ADMIN_TOKEN_REQUIRED:')) {
    return `Line ${raw.split(':')[1] || '?'} must contain a full admin capability token.`;
  }
  if (raw.startsWith('REMOTE_RUNTIME_TOKEN_EXPIRED:')) {
    return `${label}: token expired. Reopen the fresh import link from bun run dev.`;
  }
  if (raw.startsWith('REMOTE_RUNTIME_EMPTY:')) {
    return `${label}: runtime answered, but its snapshot has no entities yet. Wait for bootstrap and retry.`;
  }
  if (raw.startsWith('REMOTE_RUNTIME_IMPORT_SOURCE_FAILED:')) {
    return `Import source failed with HTTP ${raw.split(':')[1] || 'error'}. Check /api/runtime-import and retry.`;
  }
  if (raw.startsWith('REMOTE_RUNTIME_IMPORT_SOURCE_ORIGIN_INVALID:')) {
    return 'Import source must be same-origin so tokens do not leak to another host.';
  }
  if (raw.startsWith('REMOTE_RUNTIME_IMPORT_LIMIT_EXCEEDED:')) {
    const [, actual, limit] = raw.split(':');
    return `Too many runtimes: ${actual} lines, limit is ${limit}.`;
  }
  if (raw.startsWith('REMOTE_RUNTIME_IMPORT_TOKEN_INVALID:') || raw.startsWith('REMOTE_RUNTIME_IMPORT_TOKEN_MISSING:')) {
    return `Line ${raw.split(':')[1] || '?'} has no valid xlnra1 token.`;
  }
  if (raw.startsWith('REMOTE_RUNTIME_IMPORT_WS_MISSING:') || raw === 'REMOTE_RUNTIME_WS_REQUIRED') {
    return `Line ${raw.split(':')[1] || '?'} has no valid ws:// or wss:// runtime URL.`;
  }
  if (raw.startsWith('REMOTE_RUNTIME_IMPORT_ACCESS_MISSING:') || raw.startsWith('REMOTE_RUNTIME_IMPORT_ACCESS_INVALID:')) {
    return `Line ${raw.split(':')[1] || '?'} must include admin access.`;
  }
  return raw;
};

const entryFromUnknown = (value: unknown, index: number): RemoteRuntimeImportEntry => {
  if (!isRecord(value)) throw new Error(`REMOTE_RUNTIME_IMPORT_ENTRY_INVALID:${index + 1}`);
  const wsUrl = normalizeRemoteRuntimeWsUrl(String(value['wsUrl'] || value['ws'] || value['url'] || '').trim());
  const token = String(value['token'] || value['authKey'] || value['key'] || '').trim();
  if (!token.startsWith('xlnra1.')) throw new Error(`REMOTE_RUNTIME_IMPORT_TOKEN_INVALID:${index + 1}`);
  if (readRemoteRuntimeTokenAccess(token) !== 'admin') {
    throw new Error(`REMOTE_RUNTIME_IMPORT_ADMIN_TOKEN_REQUIRED:${index + 1}`);
  }
  const access = normalizeAccess(value['access'] || value['role'] || value['mode']);
  const label = String(value['label'] || value['name'] || new URL(wsUrl).host || `runtime ${index + 1}`).trim();
  const entry = { label, access, wsUrl, token };
  assertRemoteRuntimeTokenFresh(entry);
  return entry;
};

const rawImportEntriesFromUnknown = (value: unknown): unknown[] => {
  const source = isRecord(value) && isRecord(value['manifest']) ? value['manifest'] : value;
  const entries = Array.isArray(source)
    ? source
    : isRecord(source) && Array.isArray(source['entries'])
      ? source['entries']
      : [];
  if (entries.length === 0) throw new Error('REMOTE_RUNTIME_IMPORT_ENTRIES_MISSING');
  return entries;
};

const entriesFromJson = (
  value: unknown,
  options: { dropExpired?: boolean } = {},
): RemoteRuntimeImportEntry[] => {
  const entries: RemoteRuntimeImportEntry[] = [];
  for (const [index, entry] of rawImportEntriesFromUnknown(value).entries()) {
    try {
      entries.push(entryFromUnknown(entry, index));
    } catch (error) {
      if (
        options.dropExpired === true
        && error instanceof Error
        && error.message.startsWith('REMOTE_RUNTIME_TOKEN_EXPIRED:')
      ) {
        continue;
      }
      throw error;
    }
  }
  return limitRemoteRuntimeImportEntries(entries);
};

const hubJurisdictionFromUnknown = (value: unknown): RemoteRuntimeHubJurisdiction | undefined => {
  if (!isRecord(value)) return undefined;
  const jurisdiction: RemoteRuntimeHubJurisdiction = {};
  const name = String(value['name'] || '').trim();
  const address = String(value['address'] || '').trim();
  const chainIdValue = value['chainId'];
  const depositoryAddress = String(value['depositoryAddress'] || '').trim();
  const entityProviderAddress = String(value['entityProviderAddress'] || '').trim();
  if (name) jurisdiction.name = name;
  if (address) jurisdiction.address = address;
  if (typeof chainIdValue === 'number' || typeof chainIdValue === 'string') jurisdiction.chainId = chainIdValue;
  if (depositoryAddress) jurisdiction.depositoryAddress = depositoryAddress;
  if (entityProviderAddress) jurisdiction.entityProviderAddress = entityProviderAddress;
  return Object.keys(jurisdiction).length > 0 ? jurisdiction : undefined;
};

const hubSummaryFromUnknown = (value: unknown): RemoteRuntimeHubSummary | null => {
  if (!isRecord(value)) return null;
  const entityId = String(value['entityId'] || '').trim().toLowerCase();
  if (!entityId) return null;
  const runtimeId = String(value['runtimeId'] || '').trim().toLowerCase();
  const label = String(value['label'] || value['name'] || entityId).trim();
  const height = Math.max(0, Math.floor(Number(value['height'] || 0)));
  const jurisdiction = hubJurisdictionFromUnknown(value['jurisdiction']);
  return {
    entityId,
    ...(runtimeId ? { runtimeId } : {}),
    label,
    height,
    ...(jurisdiction ? { jurisdiction } : {}),
  };
};

const readHubSummaries = (value: unknown): RemoteRuntimeHubSummary[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const summary = hubSummaryFromUnknown(entry);
    return summary ? [summary] : [];
  });
};

const storedHubFieldsFromSource = (source: Record<string, unknown>): Pick<
  StoredRemoteRuntimeImportEntry,
  'hubEntityId' | 'hubName' | 'hubJurisdiction' | 'hubEntities'
> => {
  const hubEntities = readHubSummaries(source['hubEntities']);
  const primaryHub = hubEntities[0] ?? null;
  const hubEntityId = String(source['hubEntityId'] || primaryHub?.entityId || '').trim().toLowerCase();
  const hubName = String(source['hubName'] || primaryHub?.label || '').trim();
  const hubJurisdiction = hubJurisdictionFromUnknown(source['hubJurisdiction']) ?? primaryHub?.jurisdiction;
  return {
    ...(hubEntityId ? { hubEntityId } : {}),
    ...(hubName ? { hubName } : {}),
    ...(hubJurisdiction ? { hubJurisdiction } : {}),
    ...(hubEntities.length > 0 ? { hubEntities } : {}),
  };
};

export const parseRemoteRuntimeImportSourcePayload = (value: unknown): RemoteRuntimeImportEntry[] => {
  const source = isRecord(value) && isRecord(value['manifest']) ? value['manifest'] : value;
  return entriesFromJson(source);
};

const tokenizeImportLine = (line: string): string[] => {
  const pipeParts = line.split('|').map(part => part.trim()).filter(Boolean);
  if (pipeParts.length >= 3) return pipeParts;
  const commaParts = line.split(',').map(part => part.trim()).filter(Boolean);
  if (commaParts.length >= 3) return commaParts;
  return line.split(/\s+/).map(part => part.trim()).filter(Boolean);
};

const entryFromLine = (line: string, index: number): RemoteRuntimeImportEntry => {
  const parts = tokenizeImportLine(line);
  const wsIndex = parts.findIndex(part => /^(wss?|https?):\/\//i.test(part));
  const tokenIndex = parts.findIndex(part => part.startsWith('xlnra1.'));
  const accessIndex = parts.findIndex(part => /^(admin|full|write)$/i.test(part));
  if (wsIndex < 0) throw new Error(`REMOTE_RUNTIME_IMPORT_WS_MISSING:${index + 1}`);
  if (tokenIndex < 0) throw new Error(`REMOTE_RUNTIME_IMPORT_TOKEN_MISSING:${index + 1}`);
  if (accessIndex < 0) throw new Error(`REMOTE_RUNTIME_IMPORT_ACCESS_MISSING:${index + 1}`);

  const wsUrl = normalizeRemoteRuntimeWsUrl(parts[wsIndex]!);
  const token = parts[tokenIndex]!;
  if (readRemoteRuntimeTokenAccess(token) !== 'admin') {
    throw new Error(`REMOTE_RUNTIME_IMPORT_ADMIN_TOKEN_REQUIRED:${index + 1}`);
  }
  const access = normalizeAccess(parts[accessIndex]);
  const labelParts = parts.filter((_, partIndex) => partIndex !== wsIndex && partIndex !== tokenIndex && partIndex !== accessIndex);
  const label = labelParts.join(' ').trim() || new URL(wsUrl).host;
  const entry = { label, access, wsUrl, token };
  assertRemoteRuntimeTokenFresh(entry);
  return entry;
};

export const parseRemoteRuntimeImportText = (text: string): RemoteRuntimeImportEntry[] => {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('REMOTE_RUNTIME_IMPORT_EMPTY');
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return entriesFromJson(JSON.parse(trimmed));
  }
  const entries = trimmed
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(entryFromLine);
  return limitRemoteRuntimeImportEntries(entries);
};

export const parseRemoteRuntimeImportPayload = (payload: string): RemoteRuntimeImportEntry[] => {
  const raw = String(payload || '').trim();
  if (!raw) throw new Error('REMOTE_RUNTIME_IMPORT_PAYLOAD_EMPTY');
  const candidates = [
    raw,
    (() => {
      try {
        return decodeURIComponent(raw);
      } catch {
        return '';
      }
    })(),
    (() => {
      try {
        return decodeBase64UrlUtf8(raw);
      } catch {
        return '';
      }
    })(),
  ].filter(Boolean);

  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      return parseRemoteRuntimeImportText(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('REMOTE_RUNTIME_IMPORT_PAYLOAD_INVALID');
};

export const formatRemoteRuntimeImportLines = (entries: RemoteRuntimeImportEntry[]): string =>
  entries.map(entry => `${entry.label} | ${entry.access} | ${entry.wsUrl} | ${entry.token}`).join('\n');

export const limitRemoteRuntimeImportEntries = <T extends RemoteRuntimeImportEntry>(entries: T[]): T[] => {
  if (entries.length > MAX_REMOTE_RUNTIME_IMPORTS) {
    throw new Error(`REMOTE_RUNTIME_IMPORT_LIMIT_EXCEEDED:${entries.length}:${MAX_REMOTE_RUNTIME_IMPORTS}`);
  }
  return entries;
};

export const mergeStoredRemoteRuntimeImports = (
  current: StoredRemoteRuntimeImportEntry[],
  next: StoredRemoteRuntimeImportEntry[],
): StoredRemoteRuntimeImportEntry[] => {
  const byId = new Map<string, StoredRemoteRuntimeImportEntry>();
  for (const entry of current) byId.set(remoteRuntimeIdForWsUrl(entry.wsUrl), entry);
  for (const entry of next) {
    const id = remoteRuntimeIdForWsUrl(entry.wsUrl);
    const existing = byId.get(id);
    byId.set(id, {
      ...entry,
      ...(!entry.hubEntityId && existing?.hubEntityId ? { hubEntityId: existing.hubEntityId } : {}),
      ...(!entry.hubName && existing?.hubName ? { hubName: existing.hubName } : {}),
      ...(!entry.hubJurisdiction && existing?.hubJurisdiction ? { hubJurisdiction: existing.hubJurisdiction } : {}),
      ...(!entry.hubEntities?.length && existing?.hubEntities?.length ? { hubEntities: existing.hubEntities } : {}),
    });
  }
  const merged = Array.from(byId.values()).sort((a, b) => {
    const importedDelta = (a.importedAt || 0) - (b.importedAt || 0);
    if (importedDelta !== 0) return importedDelta;
    return a.label.localeCompare(b.label);
  });
  return limitRemoteRuntimeImportEntries(merged);
};

const remoteRuntimePersistentStorage = (): Storage | null => {
  if (typeof localStorage !== 'undefined') return localStorage;
  if (typeof sessionStorage !== 'undefined') return sessionStorage;
  return null;
};

const remoteRuntimeSessionStorage = (): Storage | null =>
  typeof sessionStorage !== 'undefined' ? sessionStorage : null;

export const writeStoredRemoteRuntimeImports = (entries: StoredRemoteRuntimeImportEntry[]): void => {
  const storage = remoteRuntimePersistentStorage();
  if (!storage) return;
  storage.setItem(REMOTE_RUNTIME_IMPORT_STORAGE_KEY, JSON.stringify(limitRemoteRuntimeImportEntries(entries)));
  if (storage !== remoteRuntimeSessionStorage()) {
    remoteRuntimeSessionStorage()?.removeItem(REMOTE_RUNTIME_IMPORT_STORAGE_KEY);
  }
};

export const readStoredRemoteRuntimeImports = (
  options: { dropExpired?: boolean; dropInvalid?: boolean } = {},
): StoredRemoteRuntimeImportEntry[] => {
  const storage = remoteRuntimePersistentStorage();
  const session = remoteRuntimeSessionStorage();
  if (!storage && !session) return [];
  const persistentRaw = String(storage?.getItem(REMOTE_RUNTIME_IMPORT_STORAGE_KEY) || '').trim();
  const sessionRaw = String(session?.getItem(REMOTE_RUNTIME_IMPORT_STORAGE_KEY) || '').trim();
  const raw = persistentRaw || sessionRaw;
  if (!raw) return [];
  let parsed: unknown;
  let rawEntries: unknown[];
  try {
    parsed = JSON.parse(raw) as unknown;
    rawEntries = rawImportEntriesFromUnknown(parsed);
  } catch (error) {
    if (options.dropInvalid === true) {
      storage?.removeItem(REMOTE_RUNTIME_IMPORT_STORAGE_KEY);
      session?.removeItem(REMOTE_RUNTIME_IMPORT_STORAGE_KEY);
      return [];
    }
    throw error;
  }
  const entries: StoredRemoteRuntimeImportEntry[] = [];
  for (const [index, rawEntry] of rawEntries.entries()) {
    let entry: RemoteRuntimeImportEntry;
    try {
      entry = entryFromUnknown(rawEntry, index);
    } catch (error) {
      if (
        options.dropExpired === true
        && error instanceof Error
        && error.message.startsWith('REMOTE_RUNTIME_TOKEN_EXPIRED:')
      ) {
        continue;
      }
      throw error;
    }
    const source = isRecord(rawEntry) ? rawEntry : {};
    entries.push({
      ...entry,
      runtimeId: String(source['runtimeId'] || remoteRuntimeIdForWsUrl(entry.wsUrl)).toLowerCase(),
      authLevel: 'admin',
      height: Math.max(0, Math.floor(Number(source['height'] || 0))),
      entityCount: Math.max(0, Math.floor(Number(source['entityCount'] || 0))),
      importedAt: Math.max(0, Math.floor(Number(source['importedAt'] || 0))),
      ...storedHubFieldsFromSource(source),
    });
  }
  const limited = limitRemoteRuntimeImportEntries(entries);
  if (options.dropExpired === true && limited.length !== rawEntries.length && storage) {
    writeStoredRemoteRuntimeImports(limited);
  }
  if (!persistentRaw && sessionRaw && storage) writeStoredRemoteRuntimeImports(limited);
  return limited;
};

export const resolveStoredRemoteRuntimeAuthKey = (
  wsUrl: string,
): string => {
  const normalizedWsUrl = normalizeRemoteRuntimeWsUrl(wsUrl);
  const targetId = remoteRuntimeIdForWsUrl(normalizedWsUrl);
  const entry = readStoredRemoteRuntimeImports().find(candidate =>
    remoteRuntimeIdForWsUrl(candidate.wsUrl) === targetId
  );
  if (!entry) return '';
  assertRemoteRuntimeTokenFresh(entry);
  return entry.token;
};

export const persistRemoteRuntimeImports = (
  entries: StoredRemoteRuntimeImportEntry[],
  options: { merge?: boolean } = {},
): StoredRemoteRuntimeImportEntry[] => {
  const next = options.merge
    ? mergeStoredRemoteRuntimeImports(readStoredRemoteRuntimeImports({ dropExpired: true, dropInvalid: true }), entries)
    : limitRemoteRuntimeImportEntries(entries);
  writeStoredRemoteRuntimeImports(next);
  return next;
};

export const removeStoredRemoteRuntimeImport = (runtimeIdOrWsUrl: string): StoredRemoteRuntimeImportEntry[] => {
  const raw = String(runtimeIdOrWsUrl || '').trim().toLowerCase();
  let targetEndpointId = '';
  try {
    targetEndpointId = raw.startsWith('radapter:') ? raw : remoteRuntimeIdForWsUrl(raw);
  } catch {
    targetEndpointId = '';
  }
  const next = readStoredRemoteRuntimeImports().filter((entry) => {
    const entryRuntimeId = String(entry.runtimeId || '').trim().toLowerCase();
    if (entryRuntimeId && entryRuntimeId === raw) return false;
    return !targetEndpointId || remoteRuntimeIdForWsUrl(entry.wsUrl) !== targetEndpointId;
  });
  writeStoredRemoteRuntimeImports(next);
  return next;
};

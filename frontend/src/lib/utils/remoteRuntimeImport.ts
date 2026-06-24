import { normalizeWsUrl } from './wsUrl';
import { REMOTE_RUNTIME } from '@xln/runtime/constants';

export const REMOTE_RUNTIME_IMPORT_HASH_PARAM = REMOTE_RUNTIME.IMPORT_HASH_PARAM;
export const REMOTE_RUNTIME_IMPORT_STORAGE_KEY = REMOTE_RUNTIME.IMPORT_STORAGE_KEY;
export const REMOTE_RUNTIME_IMPORT_RESULT_STORAGE_KEY = REMOTE_RUNTIME.IMPORT_RESULT_STORAGE_KEY;
export const MAX_REMOTE_RUNTIME_IMPORTS = REMOTE_RUNTIME.MAX_IMPORTS;

export type RemoteRuntimeImportAccess = 'read' | 'admin';

export type RemoteRuntimeImportEntry = {
  label: string;
  access: RemoteRuntimeImportAccess;
  wsUrl: string;
  token: string;
};

export type StoredRemoteRuntimeImportEntry = RemoteRuntimeImportEntry & {
  runtimeId: string;
  authLevel: 'inspect' | 'admin';
  height: number;
  entityCount: number;
  importedAt: number;
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
  if (raw === 'read' || raw === 'inspect') return 'read';
  if (raw === 'admin' || raw === 'full' || raw === 'write') return 'admin';
  throw new Error(`REMOTE_RUNTIME_IMPORT_ACCESS_INVALID:${raw || 'missing'}`);
};

export const remoteRuntimeIdForWsUrl = (wsUrl: string): string =>
  `radapter:${normalizeRemoteRuntimeWsUrl(wsUrl)}`.toLowerCase();

export const normalizeRemoteRuntimeWsUrl = (value: string): string => {
  const parsed = new URL(normalizeWsUrl(String(value || '').trim()));
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

const entryFromUnknown = (value: unknown, index: number): RemoteRuntimeImportEntry => {
  if (!isRecord(value)) throw new Error(`REMOTE_RUNTIME_IMPORT_ENTRY_INVALID:${index + 1}`);
  const wsUrl = normalizeRemoteRuntimeWsUrl(String(value['wsUrl'] || value['ws'] || value['url'] || '').trim());
  const token = String(value['token'] || value['authKey'] || value['key'] || '').trim();
  if (!token.startsWith('xlnra1.')) throw new Error(`REMOTE_RUNTIME_IMPORT_TOKEN_INVALID:${index + 1}`);
  const access = normalizeAccess(value['access'] || value['role'] || value['mode']);
  const label = String(value['label'] || value['name'] || new URL(wsUrl).host || `runtime ${index + 1}`).trim();
  return { label, access, wsUrl, token };
};

const entriesFromJson = (value: unknown): RemoteRuntimeImportEntry[] => {
  const entries = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value['entries'])
      ? value['entries']
      : [];
  if (entries.length === 0) throw new Error('REMOTE_RUNTIME_IMPORT_ENTRIES_MISSING');
  return limitRemoteRuntimeImportEntries(entries.map(entryFromUnknown));
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
  const accessIndex = parts.findIndex(part => /^(read|inspect|admin|full|write)$/i.test(part));
  if (wsIndex < 0) throw new Error(`REMOTE_RUNTIME_IMPORT_WS_MISSING:${index + 1}`);
  if (tokenIndex < 0) throw new Error(`REMOTE_RUNTIME_IMPORT_TOKEN_MISSING:${index + 1}`);
  if (accessIndex < 0) throw new Error(`REMOTE_RUNTIME_IMPORT_ACCESS_MISSING:${index + 1}`);

  const wsUrl = normalizeRemoteRuntimeWsUrl(parts[wsIndex]!);
  const token = parts[tokenIndex]!;
  const access = normalizeAccess(parts[accessIndex]);
  const labelParts = parts.filter((_, partIndex) => partIndex !== wsIndex && partIndex !== tokenIndex && partIndex !== accessIndex);
  const label = labelParts.join(' ').trim() || new URL(wsUrl).host;
  return { label, access, wsUrl, token };
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
  for (const entry of next) byId.set(remoteRuntimeIdForWsUrl(entry.wsUrl), entry);
  const merged = Array.from(byId.values()).sort((a, b) => {
    const importedDelta = (a.importedAt || 0) - (b.importedAt || 0);
    if (importedDelta !== 0) return importedDelta;
    return a.label.localeCompare(b.label);
  });
  return limitRemoteRuntimeImportEntries(merged);
};

export const writeStoredRemoteRuntimeImports = (entries: StoredRemoteRuntimeImportEntry[]): void => {
  if (typeof sessionStorage === 'undefined') return;
  sessionStorage.setItem(REMOTE_RUNTIME_IMPORT_STORAGE_KEY, JSON.stringify(limitRemoteRuntimeImportEntries(entries)));
};

export const readStoredRemoteRuntimeImports = (): StoredRemoteRuntimeImportEntry[] => {
  if (typeof sessionStorage === 'undefined') return [];
  const raw = String(sessionStorage.getItem(REMOTE_RUNTIME_IMPORT_STORAGE_KEY) || '').trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  const entries: StoredRemoteRuntimeImportEntry[] = entriesFromJson(parsed).map((entry, index): StoredRemoteRuntimeImportEntry => {
    const rawEntry = Array.isArray(parsed)
      ? parsed[index]
      : isRecord(parsed) && Array.isArray(parsed['entries'])
        ? parsed['entries'][index]
        : null;
    const source = isRecord(rawEntry) ? rawEntry : {};
    return {
      ...entry,
      runtimeId: String(source['runtimeId'] || remoteRuntimeIdForWsUrl(entry.wsUrl)).toLowerCase(),
      authLevel: source['authLevel'] === 'admin' ? 'admin' : 'inspect',
      height: Math.max(0, Math.floor(Number(source['height'] || 0))),
      entityCount: Math.max(0, Math.floor(Number(source['entityCount'] || 0))),
      importedAt: Math.max(0, Math.floor(Number(source['importedAt'] || 0))),
    };
  });
  return limitRemoteRuntimeImportEntries(entries);
};

export const persistRemoteRuntimeImports = (
  entries: StoredRemoteRuntimeImportEntry[],
  options: { merge?: boolean } = {},
): StoredRemoteRuntimeImportEntry[] => {
  const next = options.merge
    ? mergeStoredRemoteRuntimeImports(readStoredRemoteRuntimeImports(), entries)
    : limitRemoteRuntimeImportEntries(entries);
  writeStoredRemoteRuntimeImports(next);
  return next;
};

export const removeStoredRemoteRuntimeImport = (runtimeIdOrWsUrl: string): StoredRemoteRuntimeImportEntry[] => {
  const raw = String(runtimeIdOrWsUrl || '').trim().toLowerCase();
  const targetId = raw.startsWith('radapter:') ? raw : remoteRuntimeIdForWsUrl(raw);
  const next = readStoredRemoteRuntimeImports().filter(entry => remoteRuntimeIdForWsUrl(entry.wsUrl) !== targetId);
  writeStoredRemoteRuntimeImports(next);
  return next;
};

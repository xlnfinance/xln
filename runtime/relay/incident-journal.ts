import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { safeStringify } from '../protocol/serialization';
import { redactTelemetryValue } from '../infra/telemetry-redaction';
import type {
  RelayDebugEvent,
  RelayDebugIncident,
  RelayDebugIncidentState,
} from './store';

const JOURNAL_SCHEMA = 'xln-debug-incident-v1';
const MAX_RESTORED_INCIDENTS = 1_000;
const COMPACT_AFTER_BYTES = 16 * 1024 * 1024;
const DEBUG_ID_RESERVATION_SIZE = 1_000_000;

type PersistedIncident = Omit<RelayDebugIncident, 'sample'>;

type IncidentJournalRecord = {
  schema: typeof JOURNAL_SCHEMA;
  debugId: number;
  incident: PersistedIncident;
};

type IncidentCursorRecord = {
  schema: typeof JOURNAL_SCHEMA;
  debugId: number;
  kind: 'cursor';
};

export type RelayIncidentJournal = {
  path: string;
  debugId: number;
  incidents: RelayDebugIncident[];
  allocateDebugId(): number;
  record(incident: RelayDebugIncident): void;
};

const states = new Set<RelayDebugIncidentState>(['unread', 'acknowledged', 'resolved']);

const finiteInteger = (value: unknown, label: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`DEBUG_INCIDENT_JOURNAL_${label}_INVALID:${String(value)}`);
  }
  return parsed;
};

const requiredText = (value: unknown, label: string, maxLength: number): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`DEBUG_INCIDENT_JOURNAL_${label}_INVALID`);
  }
  return value;
};

const validatePersistedIncident = (value: unknown): PersistedIncident => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('DEBUG_INCIDENT_JOURNAL_INCIDENT_INVALID');
  }
  const input = value as Record<string, unknown>;
  const state = requiredText(input['state'], 'STATE', 30) as RelayDebugIncidentState;
  if (!states.has(state)) throw new Error(`DEBUG_INCIDENT_JOURNAL_STATE_INVALID:${state}`);
  const firstSeen = finiteInteger(input['firstSeen'], 'FIRST_SEEN');
  const lastSeen = finiteInteger(input['lastSeen'], 'LAST_SEEN');
  const firstEventId = finiteInteger(input['firstEventId'], 'FIRST_EVENT_ID');
  const lastEventId = finiteInteger(input['lastEventId'], 'LAST_EVENT_ID');
  const count = finiteInteger(input['count'], 'COUNT');
  if (lastSeen < firstSeen || lastEventId < firstEventId || count < 1) {
    throw new Error('DEBUG_INCIDENT_JOURNAL_ORDER_INVALID');
  }
  const runtimeId = typeof input['runtimeId'] === 'string' && input['runtimeId'].length > 0
    ? requiredText(input['runtimeId'], 'RUNTIME_ID', 200)
    : undefined;
  return {
    fingerprint: requiredText(input['fingerprint'], 'FINGERPRINT', 300),
    state,
    source: requiredText(input['source'], 'SOURCE', 80),
    code: requiredText(input['code'], 'CODE', 200),
    message: requiredText(input['message'], 'MESSAGE', 2_000),
    ...(runtimeId ? { runtimeId } : {}),
    firstSeen,
    lastSeen,
    count,
    firstEventId,
    lastEventId,
  };
};

const validateRecord = (value: unknown): IncidentJournalRecord | IncidentCursorRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('DEBUG_INCIDENT_JOURNAL_RECORD_INVALID');
  }
  const input = value as Record<string, unknown>;
  if (input['schema'] !== JOURNAL_SCHEMA) {
    throw new Error(`DEBUG_INCIDENT_JOURNAL_SCHEMA_INVALID:${String(input['schema'])}`);
  }
  const debugId = finiteInteger(input['debugId'], 'DEBUG_ID');
  if (input['kind'] === 'cursor' && input['incident'] === undefined) {
    return { schema: JOURNAL_SCHEMA, debugId, kind: 'cursor' };
  }
  return { schema: JOURNAL_SCHEMA, debugId, incident: validatePersistedIncident(input['incident']) };
};

const withoutSample = (incident: RelayDebugIncident): PersistedIncident => {
  const { sample: _sample, ...persisted } = incident;
  return redactTelemetryValue(persisted) as PersistedIncident;
};

const restoredSample = (incident: PersistedIncident): RelayDebugEvent => ({
  id: incident.lastEventId,
  ts: incident.lastSeen,
  event: 'restored_incident',
  runtimeId: incident.runtimeId,
  status: incident.state,
  reason: incident.code,
});

const restoreIncident = (incident: PersistedIncident): RelayDebugIncident => ({
  ...incident,
  sample: restoredSample(incident),
});

const appendDurable = (path: string, payload: string): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'a', 0o600);
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

const writeAtomicDurable = (path: string, payload: string): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  const fd = openSync(temporary, 'w', 0o600);
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const dirFd = openSync(dirname(path), 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
};

const selectRetained = (incidents: Iterable<PersistedIncident>): PersistedIncident[] =>
  Array.from(incidents)
    .sort((left, right) => {
      const leftResolved = left.state === 'resolved' ? 0 : 1;
      const rightResolved = right.state === 'resolved' ? 0 : 1;
      return rightResolved - leftResolved || right.lastSeen - left.lastSeen;
    })
    .slice(0, MAX_RESTORED_INCIDENTS);

const readJournal = (path: string): { debugId: number; incidents: PersistedIncident[] } => {
  if (!existsSync(path)) return { debugId: 0, incidents: [] };
  const raw = readFileSync(path, 'utf8');
  const finalNewline = raw.lastIndexOf('\n');
  if (finalNewline < raw.length - 1) {
    truncateSync(path, Math.max(0, finalNewline + 1));
    const fd = openSync(path, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  const latest = new Map<string, PersistedIncident>();
  let debugId = 0;
  const complete = finalNewline >= 0 ? raw.slice(0, finalNewline) : '';
  for (const [index, line] of complete.split('\n').entries()) {
    if (!line) continue;
    try {
      const record = validateRecord(JSON.parse(line));
      debugId = Math.max(
        debugId,
        record.debugId,
        'incident' in record ? record.incident.lastEventId : 0,
      );
      if ('incident' in record) latest.set(record.incident.fingerprint, record.incident);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`DEBUG_INCIDENT_JOURNAL_CORRUPT:line=${index + 1}:${message}`);
    }
  }
  return { debugId, incidents: selectRetained(latest.values()) };
};

export const openRelayIncidentJournal = (path: string): RelayIncidentJournal => {
  const restored = readJournal(path);
  let debugId = restored.debugId;
  let nextDebugId = debugId + 1;
  let reservedThrough = debugId;
  const latest = new Map(restored.incidents.map(incident => [incident.fingerprint, incident]));
  const compact = (): void => {
    const retained = selectRetained(latest.values());
    latest.clear();
    for (const incident of retained) latest.set(incident.fingerprint, incident);
    const payload = retained
      .map(incident => `${safeStringify({
        schema: JOURNAL_SCHEMA,
        debugId,
        incident,
      } satisfies IncidentJournalRecord)}\n`)
      .join('');
    writeAtomicDurable(path, payload);
  };
  return {
    path,
    get debugId() {
      return debugId;
    },
    incidents: restored.incidents.map(restoreIncident),
    allocateDebugId(): number {
      if (nextDebugId > reservedThrough) {
        reservedThrough = Math.max(
          reservedThrough + DEBUG_ID_RESERVATION_SIZE,
          nextDebugId + DEBUG_ID_RESERVATION_SIZE - 1,
        );
        debugId = reservedThrough;
        appendDurable(
          path,
          `${safeStringify({
            schema: JOURNAL_SCHEMA,
            debugId: reservedThrough,
            kind: 'cursor',
          } satisfies IncidentCursorRecord)}\n`,
        );
      }
      return nextDebugId++;
    },
    record(incident: RelayDebugIncident): void {
      const persisted = withoutSample(incident);
      debugId = Math.max(debugId, persisted.lastEventId);
      latest.set(persisted.fingerprint, persisted);
      appendDurable(
        path,
        `${safeStringify({
          schema: JOURNAL_SCHEMA,
          debugId,
          incident: persisted,
        } satisfies IncidentJournalRecord)}\n`,
      );
      if (statSync(path).size > COMPACT_AFTER_BYTES) compact();
    },
  };
};

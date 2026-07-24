import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { openRelayIncidentJournal } from '../relay/incident-journal';
import {
  createRelayStore,
  pushDebugEvent,
  setDebugIncidentState,
} from '../relay/store';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const journalPath = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'xln-debug-incidents-'));
  roots.push(root);
  return join(root, 'incidents.jsonl');
};

const storeFromJournal = (path: string) => {
  const journal = openRelayIncidentJournal(path);
  return {
    journal,
    store: createRelayStore('relay-test', {
      initialDebugId: journal.debugId,
      initialIncidents: journal.incidents,
      debugIdAllocator: () => journal.allocateDebugId(),
      incidentSink: incident => journal.record(incident),
    }),
  };
};

test('incident journal restores grouped state and monotonic cursors after restart', () => {
  const path = journalPath();
  const first = storeFromJournal(path);
  pushDebugEvent(first.store, {
    event: 'error',
    runtimeId: 'runtime-a',
    reason: 'STORAGE_NOT_OPEN',
    status: 'fatal',
  });
  pushDebugEvent(first.store, {
    event: 'error',
    runtimeId: 'runtime-a',
    reason: 'STORAGE_NOT_OPEN',
    status: 'fatal',
  });
  const fingerprint = Array.from(first.store.debugIncidents.keys())[0]!;
  setDebugIncidentState(first.store, fingerprint, 'acknowledged');
  const beforeRestartId = first.store.debugId;

  const restarted = storeFromJournal(path);
  expect(restarted.store.debugId).toBeGreaterThan(beforeRestartId);
  expect(restarted.store.debugIncidents.get(fingerprint)).toMatchObject({
    state: 'acknowledged',
    count: 2,
    firstEventId: 1,
    lastEventId: 2,
  });

  pushDebugEvent(restarted.store, {
    event: 'error',
    runtimeId: 'runtime-a',
    reason: 'STORAGE_NOT_OPEN',
    status: 'fatal',
  });
  expect(restarted.store.debugId).toBeGreaterThan(beforeRestartId);
  expect(restarted.store.debugIncidents.get(fingerprint)).toMatchObject({
    state: 'unread',
    count: 3,
    lastEventId: restarted.store.debugId,
  });
});

test('root incident survives 100,000 lower-priority events and restart', () => {
  const path = journalPath();
  const first = storeFromJournal(path);
  const root = pushDebugEvent(first.store, {
    event: 'error',
    runtimeId: 'runtime-a',
    reason: 'RUNTIME_STORAGE_FATAL',
    status: 'fatal',
  });
  expect(root).not.toBeNull();

  for (let index = 0; index < 100_000; index += 1) {
    pushDebugEvent(first.store, {
      event: 'gossip',
      runtimeId: 'runtime-noise',
      status: 'info',
      reason: `GOSSIP_NOISE_${index % 10}`,
    });
  }

  expect(first.store.debugEvents).toHaveLength(5_000);
  expect(first.store.debugIncidents.get(root!.fingerprint)).toMatchObject({
    state: 'unread',
    count: 1,
  });
  const restarted = storeFromJournal(path);
  expect(restarted.store.debugIncidents.get(root!.fingerprint)).toMatchObject({
    state: 'unread',
    code: 'RUNTIME_STORAGE_FATAL',
    count: 1,
  });
  expect(restarted.store.debugId).toBeGreaterThan(100_001);
});

test('incident journal discards only a torn final append and remains writable', () => {
  const path = journalPath();
  const first = storeFromJournal(path);
  pushDebugEvent(first.store, { event: 'error', reason: 'FIRST_FATAL', status: 'fatal' });
  appendFileSync(path, '{"schema":"xln-debug-incident-v1","incident":');

  const recovered = storeFromJournal(path);
  expect(recovered.store.debugIncidents.size).toBe(1);
  pushDebugEvent(recovered.store, { event: 'error', reason: 'SECOND_FATAL', status: 'fatal' });

  const restarted = storeFromJournal(path);
  expect(restarted.store.debugIncidents.size).toBe(2);
  expect(restarted.store.debugId).toBeGreaterThan(2);
});

test('incident journal fails fast on complete corruption and persists no secrets', () => {
  const path = journalPath();
  const first = storeFromJournal(path);
  pushDebugEvent(first.store, {
    event: 'browser_error',
    reason: 'WAL_FATAL',
    status: 'fatal',
    details: {
      source: 'browser',
      severity: 'fatal',
      message: 'Authorization=Bearer secret-token',
      seed: 'mnemonic secret words',
    },
  });
  const persisted = readFileSync(path, 'utf8');
  expect(persisted).not.toContain('secret-token');
  expect(persisted).not.toContain('mnemonic secret words');

  writeFileSync(path, '{"schema":"wrong"}\n');
  expect(() => openRelayIncidentJournal(path)).toThrow('DEBUG_INCIDENT_JOURNAL_CORRUPT:line=1');
});

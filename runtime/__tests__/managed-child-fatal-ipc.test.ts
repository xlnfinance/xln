import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachManagedChildFatalIpc,
  parseManagedChildFatalReport,
} from '../orchestrator/managed-child-fatal-ipc';
import { openRelayIncidentJournal } from '../relay/incident-journal';
import { createRelayStore, pushDebugEvent } from '../relay/store';

const fixture = join(import.meta.dir, 'fixtures/managed-child-fatal-ipc-child.ts');
const tempPaths: string[] = [];

afterEach(() => {
  for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

test('fatal report parser accepts only bounded allowlisted metadata', () => {
  expect(parseManagedChildFatalReport({
    type: 'xln:managed-child-fatal',
    reportId: 'report-1',
    runtimeId: 'runtime-1',
    code: 'RUNTIME_LOOP_ERROR',
    message: 'boom',
    height: 7.8,
    timestamp: -1,
    rawInput: { secret: 'must-not-cross-ipc' },
  })).toEqual({
    type: 'xln:managed-child-fatal',
    reportId: 'report-1',
    runtimeId: 'runtime-1',
    code: 'RUNTIME_LOOP_ERROR',
    message: 'boom',
    height: 7,
    timestamp: 0,
  });
  expect(parseManagedChildFatalReport({ type: 'xln:managed-child-fatal' })).toBeNull();
});

test('runtime fatal waits for parent fsync acknowledgement before non-zero exit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xln-managed-child-fatal-'));
  tempPaths.push(root);
  const journalPath = join(root, 'incidents.jsonl');
  const journal = openRelayIncidentJournal(journalPath);
  const store = createRelayStore('fatal-ipc-test', {
    incidentSink: incident => journal.record(incident),
  });
  const child = spawn('bun', [fixture], {
    cwd: join(import.meta.dir, '..', '..'),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on('data', chunk => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr?.on('data', chunk => stderrChunks.push(Buffer.from(chunk)));
  attachManagedChildFatalIpc(child, report => {
    const incident = pushDebugEvent(store, {
      event: 'error',
      runtimeId: report.runtimeId,
      status: 'fatal',
      reason: report.code,
      details: {
        source: 'runtime',
        severity: 'fatal',
        message: report.message,
        height: report.height,
        timestamp: report.timestamp,
        transport: 'local-ipc',
      },
    });
    if (!incident) throw new Error('TEST_FATAL_INCIDENT_NOT_CLASSIFIED');
    return incident.fingerprint;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
  const stdout = Buffer.concat(stdoutChunks).toString('utf8');
  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  const output = `${stdout}\n${stderr}`;
  const restored = openRelayIncidentJournal(journalPath);

  expect(exitCode, output).toBe(1);
  expect(output).toContain('MANAGED_CHILD_FATAL_IPC_ACK:runtime_tx_unknown-');
  expect(output).not.toContain('MANAGED_CHILD_FATAL_IPC_FIXTURE_TIMEOUT');
  expect(restored.incidents).toHaveLength(1);
  expect(restored.incidents[0]).toMatchObject({
    state: 'unread',
    code: 'RUNTIME_TX_UNKNOWN',
    source: 'runtime',
  });
}, 10_000);

test('consequences retain the original fatal root fingerprint', () => {
  const store = createRelayStore('root-fingerprint-test');
  const root = pushDebugEvent(store, {
    event: 'error',
    runtimeId: 'runtime-1',
    status: 'fatal',
    reason: 'RUNTIME_LOOP_ERROR',
    details: { source: 'runtime', severity: 'fatal', message: 'boom' },
  });
  expect(root).not.toBeNull();
  const consequence = pushDebugEvent(store, {
    event: 'error',
    rootFingerprint: root!.fingerprint,
    runtimeId: 'runtime-1',
    status: 'fatal',
    reason: 'CHILD_EXITED',
    details: { source: 'orchestrator', severity: 'fatal', message: 'exit 1' },
  });

  expect(consequence?.fingerprint).toBe(root?.fingerprint);
  expect(store.debugIncidents).toHaveLength(1);
  expect(store.debugIncidents.get(root!.fingerprint)?.count).toBe(2);
});

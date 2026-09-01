import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  filterActiveRuntimeDiagnosticsIncidents,
  formatRuntimeDiagnosticsTimestamp,
  getRuntimeDiagnosticsAdapterLabel,
  getRuntimeDiagnosticsErrorMessage,
  getRuntimeDiagnosticsFrameLabel,
  sortRuntimeDiagnosticsIncidents,
  visibleRuntimeDiagnosticsIncidents,
  type RuntimeDiagnosticsIncident,
  type RuntimeDiagnosticsTimelineFrame,
} from '../../../frontend/packages/runtime-client/src/runtime-diagnostics-panel-view';

const incident = (
  id: string,
  lastSeenAt: number,
  status: 'active' | 'resolved' = 'active',
): RuntimeDiagnosticsIncident => ({
  id, lastSeenAt, status, code: `CODE_${id}`, summary: `summary ${id}`,
  entityId: `entity-${id}`, occurrences: 1,
});

const frame = (
  graphChanged: boolean,
  materialized: boolean,
): RuntimeDiagnosticsTimelineFrame => ({
  runtimeId: 'runtime', height: 7, timestamp: 1_700_000_000_000,
  stateHash: 'hash', graphChanged, materialized,
});

describe('runtime diagnostics panel view model', () => {
  test('sorts incidents newest-first with stable id ties and preserves the input', () => {
    const input = [incident('z', 10), incident('b', 20, 'resolved'), incident('a', 20)];
    expect(sortRuntimeDiagnosticsIncidents(input).map(({ id }) => id)).toEqual(['a', 'b', 'z']);
    expect(input.map(({ id }) => id)).toEqual(['z', 'b', 'a']);
    expect(filterActiveRuntimeDiagnosticsIncidents(sortRuntimeDiagnosticsIncidents(input)).map(({ id }) => id))
      .toEqual(['a', 'z']);
  });

  test('bounds visible incident evidence to the canonical newest twenty rows', () => {
    const incidents = Array.from({ length: 22 }, (_, index) => incident(String(index), 22 - index));
    expect(visibleRuntimeDiagnosticsIncidents(incidents)).toHaveLength(20);
    expect(visibleRuntimeDiagnosticsIncidents(incidents)[0]?.id).toBe('0');
    expect(visibleRuntimeDiagnosticsIncidents(incidents)[19]?.id).toBe('19');
  });

  test('preserves adapter, timeline, timestamp, and error display semantics', () => {
    expect(getRuntimeDiagnosticsAdapterLabel('embedded')).toBe('browser');
    expect(getRuntimeDiagnosticsAdapterLabel('remote')).toBe('remote');
    expect(getRuntimeDiagnosticsAdapterLabel(undefined)).toBe('remote');
    expect(getRuntimeDiagnosticsFrameLabel(frame(true, true))).toBe('graph');
    expect(getRuntimeDiagnosticsFrameLabel(frame(false, true))).toBe('snapshot');
    expect(getRuntimeDiagnosticsFrameLabel(frame(false, false))).toBe('frame');
    expect(formatRuntimeDiagnosticsTimestamp(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(getRuntimeDiagnosticsErrorMessage(new Error('offline'))).toBe('offline');
    expect(getRuntimeDiagnosticsErrorMessage(503)).toBe('503');
  });

  test('keeps effects in the Svelte facade and consumes the shared projection', () => {
    const source = readFileSync('frontend/src/lib/view/panels/RuntimeDiagnosticsPanel.svelte', 'utf8');
    expect(source).toContain("from '../../../../packages/runtime-client/src/runtime-diagnostics-panel-view'");
    expect(source).toContain('Promise.all([');
    expect(source).toContain("adapter.control('verify-chain')");
    expect(source).toContain('sortRuntimeDiagnosticsIncidents');
    expect(source).not.toContain('.sort((left, right) =>');
    expect(source).not.toContain('cause instanceof Error');
  });
});

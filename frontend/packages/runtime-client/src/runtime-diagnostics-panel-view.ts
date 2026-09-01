// Framework-neutral view model for the workspace Runtime Diagnostics panel.
// Runtime reads and control effects stay with the owning client adapter; this
// module only projects already-typed evidence for deterministic presentation.

import type { RuntimeAdapterTimelineIndexPage } from '@xln/core/api/public/runtime-module';

export type RuntimeDiagnosticsIncident = Readonly<{
  id: string;
  code: string;
  status: 'active' | 'resolved';
  summary: string;
  entityId: string;
  lastSeenAt: number;
  occurrences: number;
}>;

export type RuntimeDiagnosticsTimelineFrame = RuntimeAdapterTimelineIndexPage['entries'][number];

export const sortRuntimeDiagnosticsIncidents = <T extends RuntimeDiagnosticsIncident>(
  incidents: Iterable<T>,
): T[] => [...incidents]
  .sort((left, right) => right.lastSeenAt - left.lastSeenAt || left.id.localeCompare(right.id));

export const filterActiveRuntimeDiagnosticsIncidents = <T extends RuntimeDiagnosticsIncident>(
  incidents: readonly T[],
): T[] => incidents.filter((incident) => incident.status === 'active');

export const visibleRuntimeDiagnosticsIncidents = <T extends RuntimeDiagnosticsIncident>(
  incidents: readonly T[],
): T[] => incidents.slice(0, 20);

export const getRuntimeDiagnosticsAdapterLabel = (mode: unknown): 'browser' | 'remote' =>
  mode === 'embedded' ? 'browser' : 'remote';

export const getRuntimeDiagnosticsFrameLabel = (
  frame: RuntimeDiagnosticsTimelineFrame,
): 'graph' | 'snapshot' | 'frame' =>
  frame.graphChanged ? 'graph' : frame.materialized ? 'snapshot' : 'frame';

export const formatRuntimeDiagnosticsTimestamp = (timestamp: number): string =>
  new Date(timestamp).toISOString();

export const getRuntimeDiagnosticsErrorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

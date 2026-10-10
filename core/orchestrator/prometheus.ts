import type { AggregatedHealth } from './orchestrator-types';

const prometheusLabelValue = (value: string | number | boolean | null | undefined): string =>
  String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');

const prometheusLine = (
  name: string,
  value: number | boolean,
  labels: Record<string, string | number | boolean | null | undefined> = {},
): string => {
  const numericValue = typeof value === 'boolean' ? (value ? 1 : 0) : Number.isFinite(value) ? value : 0;
  const labelEntries = Object.entries(labels).filter(([, labelValue]) => labelValue !== undefined && labelValue !== null);
  const labelText = labelEntries.length > 0
    ? `{${labelEntries.map(([labelName, labelValue]) => `${labelName}="${prometheusLabelValue(labelValue)}"`).join(',')}}`
    : '';
  return `${name}${labelText} ${numericValue}`;
};

// Public callers see exactly what the redacted /api/health shows
// (api/server/health/redaction.ts); per-child, per-path storage and external
// client detail stays operator-only.
const publicMetricLines = (health: AggregatedHealth): string[] => [
  '# HELP xln_core_ok Core XLN readiness.',
  '# TYPE xln_core_ok gauge',
  prometheusLine('xln_core_ok', health.coreOk),
  '# HELP xln_system_ok Full system readiness including children and storage.',
  '# TYPE xln_system_ok gauge',
  prometheusLine('xln_system_ok', health.systemOk),
  prometheusLine('xln_degraded_count', health.degraded.length),
  prometheusLine('xln_reset_in_progress', health.reset.inProgress),
  prometheusLine('xln_relay_clients', health.relay.clientCount),
  prometheusLine('xln_relay_market_subscriptions', health.relay.marketSubscriptions.total),
  prometheusLine('xln_process_uptime_seconds', health.process.uptimeSec),
  prometheusLine('xln_process_rss_bytes', health.process.rssBytes),
  prometheusLine('xln_process_heap_used_bytes', health.process.heapUsedBytes),
  prometheusLine('xln_disk_used_pct', health.disk.usedPct),
  prometheusLine('xln_storage_ok', health.storage.ok),
  prometheusLine('xln_hub_mesh_ok', health.hubMesh.ok),
  prometheusLine('xln_hub_mesh_open_direct_links', health.hubMesh.direct.openLinkCount),
  prometheusLine('xln_market_maker_ok', health.marketMaker.ok),
  prometheusLine('xln_custody_ok', health.custody.enabled ? health.custody.ok : true),
  prometheusLine('xln_bootstrap_reserves_ok', health.bootstrapReserves.ok),
  prometheusLine('xln_bootstrap_reserves_target_met', health.bootstrapReserves.targetMet),
  ...health.hubs.flatMap(hub => [
    prometheusLine('xln_hub_online', hub.online, { name: hub.name }),
    prometheusLine('xln_hub_self_relay_presence', hub.selfRelayPresence, { name: hub.name }),
  ]),
  ...Object.entries(health.timings).flatMap(([stage, timing]) =>
    typeof timing.ms === 'number' ? [prometheusLine('xln_orchestrator_stage_ms', timing.ms, { stage })] : []),
];

const operatorMetricLines = (health: AggregatedHealth): string[] => [
  prometheusLine('xln_relay_external_clients', health.relay.externalClientIds.length),
  prometheusLine('xln_disk_free_bytes', health.disk.freeBytes),
  ...health.process.children.flatMap(child => [
    prometheusLine('xln_child_online', child.online, { role: child.role, name: child.name }),
    prometheusLine('xln_child_restart_total', child.restartCount, { role: child.role, name: child.name }),
  ]),
  ...health.hubs.map(hub => prometheusLine('xln_hub_restart_total', hub.restartCount, { name: hub.name })),
  ...health.storage.tracked.flatMap(tracked => {
    const labels = { name: tracked.name, kind: tracked.kind };
    return [
      prometheusLine('xln_storage_tracked_bytes', tracked.currentBytes, labels),
      prometheusLine('xln_storage_tracked_bytes_per_hour', tracked.bytesPerHour, labels),
      prometheusLine('xln_storage_scan_truncated', tracked.scanTruncated, labels),
    ];
  }),
];

export const buildPrometheusMetrics = (health: AggregatedHealth, operatorAuthorized: boolean): string => {
  const lines = operatorAuthorized
    ? [...publicMetricLines(health), ...operatorMetricLines(health)]
    : publicMetricLines(health);
  return `${lines.join('\n')}\n`;
};

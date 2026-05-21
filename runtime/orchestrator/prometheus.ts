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

export const buildPrometheusMetrics = (health: AggregatedHealth): string => {
  const lines: string[] = [
    '# HELP xln_core_ok Core XLN readiness.',
    '# TYPE xln_core_ok gauge',
    prometheusLine('xln_core_ok', health.coreOk),
    '# HELP xln_system_ok Full system readiness including children and storage.',
    '# TYPE xln_system_ok gauge',
    prometheusLine('xln_system_ok', health.systemOk),
    prometheusLine('xln_degraded_count', health.degraded.length),
    prometheusLine('xln_reset_in_progress', health.reset.inProgress),
    prometheusLine('xln_relay_clients', health.relay.clientCount),
    prometheusLine('xln_relay_external_clients', health.relay.externalClientIds.length),
    prometheusLine('xln_relay_market_subscriptions', health.relay.marketSubscriptions.total),
    prometheusLine('xln_process_uptime_seconds', health.process.uptimeSec),
    prometheusLine('xln_process_rss_bytes', health.process.rssBytes),
    prometheusLine('xln_process_heap_used_bytes', health.process.heapUsedBytes),
    prometheusLine('xln_disk_free_bytes', health.disk.freeBytes),
    prometheusLine('xln_disk_used_pct', health.disk.usedPct),
    prometheusLine('xln_storage_ok', health.storage.ok),
    prometheusLine('xln_hub_mesh_ok', health.hubMesh.ok),
    prometheusLine('xln_hub_mesh_open_direct_links', health.hubMesh.direct.openLinkCount),
    prometheusLine('xln_market_maker_ok', health.marketMaker.ok),
    prometheusLine('xln_custody_ok', health.custody.enabled ? health.custody.ok : true),
    prometheusLine('xln_bootstrap_reserves_ok', health.bootstrapReserves.ok),
    prometheusLine('xln_bootstrap_reserves_target_met', health.bootstrapReserves.targetMet),
  ];

  for (const child of health.process.children) {
    const labels = { role: child.role, name: child.name };
    lines.push(prometheusLine('xln_child_online', child.online, labels));
    lines.push(prometheusLine('xln_child_restart_total', child.restartCount, labels));
  }
  for (const hub of health.hubs) {
    const labels = { name: hub.name };
    lines.push(prometheusLine('xln_hub_online', hub.online, labels));
    lines.push(prometheusLine('xln_hub_self_relay_presence', hub.selfRelayPresence, labels));
    lines.push(prometheusLine('xln_hub_restart_total', hub.restartCount, labels));
  }
  for (const tracked of health.storage.tracked) {
    const labels = { name: tracked.name, kind: tracked.kind };
    lines.push(prometheusLine('xln_storage_tracked_bytes', tracked.currentBytes, labels));
    lines.push(prometheusLine('xln_storage_tracked_bytes_per_hour', tracked.bytesPerHour, labels));
    lines.push(prometheusLine('xln_storage_scan_truncated', tracked.scanTruncated, labels));
  }
  for (const [stage, timing] of Object.entries(health.timings)) {
    if (typeof timing.ms === 'number') lines.push(prometheusLine('xln_orchestrator_stage_ms', timing.ms, { stage }));
  }

  return `${lines.join('\n')}\n`;
};

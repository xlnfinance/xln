#!/usr/bin/env bun

type HealthSmokeArgs = {
  baseUrl: string;
  timeoutMs: number;
  allowDegraded: boolean;
};

const ADVISORY_DEGRADED_REASONS = new Set([
  'bootstrapReserveTargets',
]);

const parseArgs = (): HealthSmokeArgs => {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    const current = process.argv[index];
    if (!current) continue;
    if (!current.startsWith('--')) {
      positional.push(current);
      continue;
    }
    const [inlineKeyRaw, inlineValue] = current.split('=', 2);
    const inlineKey = inlineKeyRaw || current;
    if (inlineValue !== undefined) {
      flags.set(inlineKey, inlineValue);
      continue;
    }
    const next = process.argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags.set(current, true);
      continue;
    }
    flags.set(current, next);
    index += 1;
  }
  const baseUrl = String(flags.get('--url') || positional[0] || process.env['XLN_PROD_HEALTH_URL'] || 'https://xln.finance').replace(/\/+$/, '');
  const timeoutMs = Math.max(1_000, Math.floor(Number(flags.get('--timeout-ms') || 15_000)));
  return {
    baseUrl,
    timeoutMs,
    allowDegraded: flags.has('--allow-degraded'),
  };
};

const fetchWithTimeout = async (url: string, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const readMetric = (metrics: string, name: string): number | null => {
  const line = metrics
    .split(/\r?\n/)
    .find(candidate => candidate.startsWith(`${name} `));
  if (!line) return null;
  const value = Number(line.trim().split(/\s+/)[1]);
  return Number.isFinite(value) ? value : null;
};

const readDiagnosticMetricLines = (metrics: string): string[] => {
  const prefixes = [
    'xln_core_ok',
    'xln_system_ok',
    'xln_relay_clients',
    'xln_relay_external_clients',
    'xln_child_online',
    'xln_hub_online',
    'xln_hub_self_relay_presence',
    'xln_hub_mesh_ok',
    'xln_market_maker_ok',
    'xln_custody_ok',
    'xln_bootstrap_reserves_ok',
  ];
  return metrics
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => prefixes.some(prefix => line === prefix || line.startsWith(`${prefix} `) || line.startsWith(`${prefix}{`)));
};

export const buildProdHealthFailureSummary = (
  health: {
    coreOk?: boolean;
    systemOk?: boolean;
    degraded?: unknown[];
    relay?: { clientCount?: number; activeClientCount?: number };
    storage?: { ok?: boolean };
    hubMesh?: { ok?: boolean };
    marketMaker?: { ok?: boolean; startupPhase?: string | null; cross?: { applicable?: boolean; ok?: boolean; expectedRoutes?: number } };
    custody?: { ok?: boolean };
    hubs?: Array<{ name?: string; online?: boolean; selfRelayPresence?: boolean }>;
  },
  metrics = '',
): string => JSON.stringify({
  coreOk: health.coreOk,
  systemOk: health.systemOk,
  degraded: health.degraded,
  relayClientCount: health.relay?.clientCount ?? health.relay?.activeClientCount ?? null,
  storageOk: health.storage?.ok ?? null,
  hubMeshOk: health.hubMesh?.ok ?? null,
  marketMakerOk: health.marketMaker?.ok ?? null,
  startupPhase: health.marketMaker?.startupPhase ?? null,
  cross: health.marketMaker?.cross
    ? {
        applicable: health.marketMaker.cross.applicable ?? null,
        ok: health.marketMaker.cross.ok ?? null,
        expectedRoutes: health.marketMaker.cross.expectedRoutes ?? null,
      }
    : null,
  custodyOk: health.custody?.ok ?? null,
  hubs: Array.isArray(health.hubs)
    ? health.hubs.map(hub => ({
        name: hub.name ?? null,
        online: hub.online ?? null,
        selfRelayPresence: hub.selfRelayPresence ?? null,
      }))
    : [],
  diagnosticMetrics: readDiagnosticMetricLines(metrics),
});

export const getFatalDegradedReasons = (degraded: unknown): string[] => {
  if (!Array.isArray(degraded)) return [];
  return degraded
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .filter((reason) => !ADVISORY_DEGRADED_REASONS.has(reason));
};

const main = async (): Promise<void> => {
  const args = parseArgs();
  const healthRes = await fetchWithTimeout(`${args.baseUrl}/api/health`, args.timeoutMs);
  requireCondition(healthRes.ok, `/api/health HTTP ${healthRes.status}`);
  const health = await healthRes.json() as {
    coreOk?: boolean;
    systemOk?: boolean;
    degraded?: unknown[];
    storage?: { ok?: boolean };
    hubMesh?: { ok?: boolean };
    marketMaker?: { ok?: boolean; startupPhase?: string | null };
    custody?: { ok?: boolean };
    hubs?: Array<{ name?: string; online?: boolean; selfRelayPresence?: boolean }>;
    relay?: { clientCount?: number; activeClientCount?: number };
  };

  let metrics = '';
  let metricsHttpStatus: number | null = null;
  try {
    const diagnosticMetricsRes = await fetchWithTimeout(`${args.baseUrl}/api/metrics`, args.timeoutMs);
    metricsHttpStatus = diagnosticMetricsRes.status;
    if (diagnosticMetricsRes.ok) metrics = await diagnosticMetricsRes.text();
  } catch (error) {
    metrics = `metrics fetch failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  const healthSummary = buildProdHealthFailureSummary(health, metrics);

  requireCondition(health.coreOk === true, `health.coreOk is not true: ${healthSummary}`);
  requireCondition(health.systemOk === true, `health.systemOk is not true: ${healthSummary}`);
  if (!args.allowDegraded) {
    const fatalDegraded = getFatalDegradedReasons(health.degraded);
    requireCondition(
      fatalDegraded.length === 0,
      `health.degraded has fatal entries: ${JSON.stringify(fatalDegraded)} (full=${JSON.stringify(health.degraded)})`,
    );
  }

  requireCondition(metricsHttpStatus !== null, `/api/metrics did not return a response: ${healthSummary}`);
  requireCondition(metricsHttpStatus >= 200 && metricsHttpStatus < 300, `/api/metrics HTTP ${metricsHttpStatus}: ${healthSummary}`);
  requireCondition(readMetric(metrics, 'xln_core_ok') === 1, 'xln_core_ok metric is not 1');
  requireCondition(readMetric(metrics, 'xln_system_ok') === 1, 'xln_system_ok metric is not 1');

  const appRes = await fetchWithTimeout(`${args.baseUrl}/app`, args.timeoutMs);
  requireCondition(appRes.ok, `/app HTTP ${appRes.status}`);
  const contentType = appRes.headers.get('content-type') || '';
  requireCondition(contentType.includes('text/html'), `/app content-type is not HTML: ${contentType}`);

  console.log('✅ prod-health-smoke passed');
  console.log(JSON.stringify({
    baseUrl: args.baseUrl,
    coreOk: health.coreOk,
    systemOk: health.systemOk,
    degraded: health.degraded,
    storageOk: health.storage?.ok ?? null,
    hubMeshOk: health.hubMesh?.ok ?? null,
    marketMakerOk: health.marketMaker?.ok ?? null,
    startupPhase: health.marketMaker?.startupPhase ?? null,
  }, null, 2));
};

if (import.meta.main) {
  main().catch((error) => {
    console.error('❌ prod-health-smoke failed:', error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}

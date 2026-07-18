type BootstrapProgress = {
  active?: unknown;
  idleMs?: unknown;
  stallTimeoutMs?: unknown;
  step?: unknown;
  totalMs?: unknown;
};

type BootstrapHub = {
  bootstrapProgress?: BootstrapProgress | null;
  exitCode?: unknown;
  exitSignal?: unknown;
  name?: unknown;
  online?: unknown;
  recoveryInProgress?: unknown;
  selfRelayPresence?: unknown;
};

type BootstrapHealth = {
  bootstrapReserves?: { ok?: unknown };
  bootstrapTimeline?: { stages?: Array<Record<string, unknown>> };
  coreOk?: unknown;
  custody?: { ok?: unknown };
  failures?: Array<Record<string, unknown>>;
  hubMesh?: { ok?: unknown };
  hubs?: BootstrapHub[];
  marketMaker?: { ok?: unknown; startupPhase?: unknown };
  reset?: Record<string, unknown>;
  system?: { relay?: unknown; runtime?: unknown };
  systemOk?: unknown;
};

type ChildFailureReceipt = {
  recordedAt?: unknown;
  reasonCode?: unknown;
  name?: unknown;
  fingerprint?: unknown;
};

const finiteNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const isProductionBootstrapReady = (health: BootstrapHealth): boolean =>
  health.coreOk === true &&
  health.systemOk === true &&
  health.system?.runtime === true &&
  health.system.relay === true &&
  health.hubMesh?.ok === true &&
  health.marketMaker?.ok === true &&
  health.bootstrapReserves?.ok === true &&
  health.custody?.ok === true &&
  Array.isArray(health.hubs) &&
  health.hubs.length >= 3;

export const findProductionBootstrapFatal = (
  health: BootstrapHealth,
  _nowMs: number,
): string | null => {
  if (health.reset?.['hasError'] === true || finiteNumber(health.reset?.['failedAt']) !== null) {
    return 'PROD_BOOTSTRAP_RESET_FAILED';
  }
  const fatalFailure = health.failures?.find((failure) => failure['fatal'] === true);
  if (fatalFailure) return `PROD_BOOTSTRAP_FATAL_SIGNAL:${String(fatalFailure['code'] || 'unknown')}`;

  for (const hub of health.hubs ?? []) {
    const name = String(hub.name || 'unknown');
    if (hub.recoveryInProgress !== true && (
      finiteNumber(hub.exitCode) !== null || String(hub.exitSignal || '').length > 0
    )) {
      const signal = String(hub.exitSignal || '');
      return `PROD_BOOTSTRAP_HUB_EXITED:${name}:code=${String(hub.exitCode)}${signal ? `:signal=${signal}` : ''}`;
    }
  }

  for (const stage of health.bootstrapTimeline?.stages ?? []) {
    const status = String(stage['status'] || '');
    if (status === 'done' || status === 'disabled') continue;
    const failure = stage['failure'];
    if (failure && typeof failure === 'object' && (failure as Record<string, unknown>)['fatal'] === true) {
      return `PROD_BOOTSTRAP_STAGE_FATAL:${String(stage['key'] || 'unknown')}:${String((failure as Record<string, unknown>)['code'] || 'unknown')}`;
    }
  }
  return null;
};

export const findDeployScopedChildFatal = (
  receipt: ChildFailureReceipt | null,
  deployStartedAtMs: number,
): string | null => {
  if (!receipt) return null;
  const recordedAtMs = Date.parse(String(receipt.recordedAt ?? ''));
  if (!Number.isFinite(recordedAtMs)) return 'PROD_BOOTSTRAP_FATAL_RECEIPT_INVALID';
  if (recordedAtMs < deployStartedAtMs) return null;
  return `PROD_BOOTSTRAP_CHILD_FATAL_RECEIPT:` +
    `${String(receipt.name || 'unknown')}:` +
    `${String(receipt.reasonCode || 'unknown')}:` +
    `${String(receipt.fingerprint || 'unknown')}`;
};

export const summarizeProductionBootstrap = (health: BootstrapHealth): Record<string, unknown> => ({
  reset: health.reset?.['inProgress'] === true ? 'running' : health.reset?.['completedAt'] ? 'done' : 'pending',
  stages: (health.bootstrapTimeline?.stages ?? [])
    .filter((stage) => stage['status'] !== 'disabled')
    .map((stage) => `${String(stage['key'] || 'unknown')}:${String(stage['status'] || 'pending')}`),
  hubs: (health.hubs ?? []).map((hub) => ({
    name: String(hub.name || 'unknown'),
    online: hub.online === true,
    relay: hub.selfRelayPresence === true,
    recovering: hub.recoveryInProgress === true,
    step: String(hub.bootstrapProgress?.step || 'unreported'),
    idleMs: finiteNumber(hub.bootstrapProgress?.idleMs),
    totalMs: finiteNumber(hub.bootstrapProgress?.totalMs),
  })),
  marketMaker: {
    ok: health.marketMaker?.ok === true,
    phase: String(health.marketMaker?.startupPhase || 'pending'),
  },
  custody: health.custody?.ok === true,
  ready: isProductionBootstrapReady(health),
});

const transitionSignature = (summary: Record<string, unknown>): string => {
  const stable = structuredClone(summary) as {
    hubs?: Array<{ idleMs?: unknown; totalMs?: unknown }>;
  };
  for (const hub of stable.hubs ?? []) {
    delete hub.idleMs;
    delete hub.totalMs;
  }
  return JSON.stringify(stable);
};

const fetchHealth = async (url: string): Promise<BootstrapHealth> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`status=${response.status}`);
  const payload = await response.json();
  if (!payload || typeof payload !== 'object') throw new Error('payload=invalid');
  return payload as BootstrapHealth;
};

const readChildFailureReceipt = async (path: string): Promise<ChildFailureReceipt | null> => {
  const file = Bun.file(path);
  if (!await file.exists()) return null;
  const payload = await file.json();
  if (!payload || typeof payload !== 'object') {
    throw new Error('PROD_BOOTSTRAP_FATAL_RECEIPT_INVALID');
  }
  return payload as ChildFailureReceipt;
};

const main = async (): Promise<void> => {
  const url = String(process.argv[2] || 'http://127.0.0.1:8080/api/health');
  const timeoutMs = Number(process.argv[3] || 0);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error(`PROD_BOOTSTRAP_TIMEOUT_INVALID:${timeoutMs}`);
  const startedAt = Date.now();
  const deployStartedAtMs = finiteNumber(process.env['XLN_PROD_DEPLOY_STARTED_AT_MS']) ?? startedAt;
  const childFailureReceiptPath = String(
    process.env['XLN_CHILD_FAILURE_RECEIPT_PATH'] ||
    '/var/lib/xln/rdb/runtime/prod-mesh/.control-plane/diagnostics/last-fatal.json',
  );
  let lastAvailableAt = 0;
  let lastSignature = '';
  let lastFetchError = '';

  while (timeoutMs === 0 || Date.now() - startedAt <= timeoutMs) {
    try {
      const receiptFatal = findDeployScopedChildFatal(
        await readChildFailureReceipt(childFailureReceiptPath),
        deployStartedAtMs,
      );
      if (receiptFatal) throw new Error(receiptFatal);
      const health = await fetchHealth(url);
      lastAvailableAt = Date.now();
      lastFetchError = '';
      const fatal = findProductionBootstrapFatal(health, Date.now());
      if (fatal) throw new Error(fatal);
      const summary = summarizeProductionBootstrap(health);
      const signature = transitionSignature(summary);
      if (signature !== lastSignature) {
        console.log(`[bootstrap] ${JSON.stringify(summary)}`);
        lastSignature = signature;
      }
      if (summary['ready'] === true) {
        console.log(`[bootstrap] PROD_BOOTSTRAP_READY elapsedMs=${Date.now() - startedAt}`);
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('PROD_BOOTSTRAP_')) throw error;
      if (message !== lastFetchError) {
        console.log(`[bootstrap] health unavailable: ${message}`);
        lastFetchError = message;
      }
      const unavailableMs = Date.now() - (lastAvailableAt || startedAt);
      const limitMs = lastAvailableAt > 0 ? 15_000 : 60_000;
      if (unavailableMs > limitMs) {
        throw new Error(`PROD_BOOTSTRAP_HEALTH_UNAVAILABLE:elapsedMs=${unavailableMs}:last=${message}`);
      }
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`PROD_BOOTSTRAP_DEADLINE_EXCEEDED:timeoutMs=${timeoutMs}`);
};

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

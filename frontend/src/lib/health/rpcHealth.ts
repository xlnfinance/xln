export type RpcHealthProbeResult = {
  ok: boolean;
  attempts: number;
  latencyMs: number | null;
  error: string | null;
  status?: number;
  body?: unknown;
};

type RpcHealthProbeOptions = {
  attempts?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const RPC_HEALTH_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'eth_chainId',
  params: [],
};

const defaultNow = (): number => {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
};

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const normalizeAttempts = (value: number | undefined): number =>
  Math.max(1, Math.floor(Number.isFinite(Number(value)) ? Number(value) : 3));

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export async function probeRpcHealth(options: RpcHealthProbeOptions = {}): Promise<RpcHealthProbeResult> {
  const attempts = normalizeAttempts(options.attempts);
  const retryDelayMs = Math.max(0, Math.floor(Number(options.retryDelayMs ?? 150)));
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? defaultNow;
  const sleep = options.sleep ?? defaultSleep;
  let last: RpcHealthProbeResult = {
    ok: false,
    attempts: 0,
    latencyMs: null,
    error: 'not attempted',
  };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const started = now();
    try {
      const response = await fetchImpl('/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(RPC_HEALTH_BODY),
      });
      const latencyMs = Math.round(now() - started);
      if (!response.ok) {
        last = {
          ok: false,
          attempts: attempt,
          latencyMs,
          error: `HTTP ${response.status}`,
          status: response.status,
        };
      } else {
        const body = (await response.json()) as { result?: string; error?: unknown };
        if (typeof body.result === 'string' && body.result.length > 0) {
          return {
            ok: true,
            attempts: attempt,
            latencyMs,
            error: null,
          };
        }
        last = {
          ok: false,
          attempts: attempt,
          latencyMs,
          error: body.error ? JSON.stringify(body.error) : 'No chainId result',
          body,
        };
      }
    } catch (error) {
      last = {
        ok: false,
        attempts: attempt,
        latencyMs: null,
        error: errorMessage(error),
      };
    }

    if (attempt < attempts && retryDelayMs > 0) {
      await sleep(retryDelayMs);
    }
  }

  return last;
}

import type { CliSettings } from './settings';

export type ApiJurisdictionConfig = {
  name?: string;
  primary?: boolean;
  status?: string;
  chainId?: number;
  rpc?: string;
  rpcs?: string[];
  blockTimeMs?: number;
  entityProviderDeploymentBlock?: number;
  currency?: string;
  contracts?: {
    depository?: string;
    entityProvider?: string;
    [key: string]: string | undefined;
  };
};

export type JurisdictionsPayload = {
  version?: string;
  jurisdictions: Record<string, ApiJurisdictionConfig>;
};

export type HubApiRow = {
  entityId: string;
  runtimeId: string | null;
  name?: string;
  bio?: string | null;
  website?: string | null;
  wsUrl?: string | null;
  publicAccounts?: unknown[];
  metadata?: {
    isHub?: boolean;
    jurisdiction?: { name?: string; chainId?: number | string; depositoryAddress?: string };
    fee?: number;
    peerCount?: number;
    description?: string;
  };
  lastUpdated?: number;
  online?: boolean;
};

const withBust = (url: string): string => {
  const joiner = url.includes('?') ? '&' : '?';
  return `${url}${joiner}ts=${Date.now()}`;
};

export const apiUrl = (settings: CliSettings, path: string): string => {
  const base = settings.apiBase.replace(/\/$/, '');
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalized}`;
};

export const fetchJson = async <T>(url: string): Promise<T> => {
  const resp = await fetch(withBust(url), {
    headers: {
      'cache-control': 'no-cache, no-store, must-revalidate',
      pragma: 'no-cache',
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return (await resp.json()) as T;
};

export const fetchJurisdictions = async (settings: CliSettings): Promise<JurisdictionsPayload> =>
  fetchJson<JurisdictionsPayload>(apiUrl(settings, '/api/jurisdictions'));

export const fetchHubs = async (settings: CliSettings): Promise<HubApiRow[]> => {
  const payload = await fetchJson<{ ok?: boolean; hubs?: HubApiRow[] }>(apiUrl(settings, '/api/hubs'));
  return Array.isArray(payload.hubs) ? payload.hubs : [];
};

export const fetchLendingState = async (
  settings: CliSettings,
  query: { hubEntityId: string; userEntityId: string; tokenId: number },
): Promise<unknown> => {
  const q = new URLSearchParams({
    hubEntityId: query.hubEntityId,
    userEntityId: query.userEntityId,
    tokenId: String(query.tokenId),
  });
  return fetchJson(apiUrl(settings, `/api/lending/state?${q.toString()}`));
};

export const resolveJurisdictionRpc = (config: ApiJurisdictionConfig, apiBase: string): string => {
  const rpc = config.rpc ?? config.rpcs?.[0] ?? '';
  if (!rpc) throw new Error(`Missing RPC for jurisdiction ${config.name || '?'}`);
  const base = apiBase.replace(/\/$/, '');
  if (rpc.startsWith('http')) {
    try {
      const parsed = new URL(rpc);
      // Collapse /rpc/<chain> bridge paths to the canonical /rpc endpoint.
      if (parsed.pathname === '/rpc' || parsed.pathname.startsWith('/rpc/')) {
        return `${parsed.origin}/rpc`;
      }
      if (parsed.pathname === '/rpc2' || parsed.pathname.startsWith('/rpc2/')) {
        return `${parsed.origin}/rpc2`;
      }
    } catch {
      /* fall through */
    }
    return rpc;
  }
  // Relative paths from /api/jurisdictions (e.g. "/rpc") resolve against XLN_API_BASE
  // the same way the frontend resolves against window.location.origin.
  if (rpc.startsWith('/')) return new URL(rpc, `${base}/`).toString();
  return new URL(rpc, `${base}/`).toString();
};

export const listUsableJurisdictions = (
  payload: JurisdictionsPayload,
): Array<{ key: string; name: string; config: ApiJurisdictionConfig }> => {
  const entries = Object.entries(payload.jurisdictions || {}).filter(([, config]) => {
    const status = String(config.status || 'active').trim().toLowerCase();
    return (
      status === 'active' &&
      Boolean(config.contracts?.depository && config.contracts?.entityProvider && (config.rpc || config.rpcs?.[0]))
    );
  });
  if (entries.length === 0) throw new Error('No usable jurisdictions from /api/jurisdictions');
  const primary =
    entries.find(([, c]) => c.primary === true) ||
    entries[0]!;
  const rest = entries.filter(([key, config]) => key !== primary[0] && config !== primary[1]);
  const ordered = [primary, ...rest];
  return ordered.map(([key, config], index) => ({
    key,
    name: String(config.name || key).trim() || (index === 0 ? 'primary' : `Jurisdiction ${index + 1}`),
    config,
  }));
};

export const requestErc20Faucet = async (
  settings: CliSettings,
  address: string,
): Promise<{ ok: boolean; detail: string }> => {
  try {
    const resp = await fetch(apiUrl(settings, '/api/faucet/erc20'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAddress: address, tokenSymbol: 'USDC', amount: '100' }),
    });
    const text = await resp.text();
    return { ok: resp.ok, detail: text.slice(0, 200) };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
};

import { formatUnits } from 'ethers';
import { parseTokenAmount } from '../runtime/financial-utils';
import { DEFAULT_TOKENS } from '../runtime/jadapter/default-tokens';
import { DaemonRpcClient, type DaemonFrameLog } from './daemon-client';
import { CustodyStore, type ActivityRecord, type SessionRecord } from './store';

const HOST = process.env.CUSTODY_HOST || '127.0.0.1';
const PORT = Number(process.env.CUSTODY_PORT || '8787');
const DAEMON_WS_URL = process.env.CUSTODY_DAEMON_WS || 'ws://127.0.0.1:8080/rpc';
const WALLET_URL = process.env.CUSTODY_WALLET_URL || 'http://127.0.0.1:8080/app';
const CUSTODY_JURISDICTION = String(process.env.CUSTODY_JURISDICTION_ID || process.env.CUSTODY_JURISDICTION || 'arrakis').trim();
const CUSTODY_ENTITY_ID = String(process.env.CUSTODY_ENTITY_ID || '').trim().toLowerCase();
const CUSTODY_SIGNER_ID = String(process.env.CUSTODY_SIGNER_ID || '').trim().toLowerCase() || undefined;
const CUSTODY_DB_PATH = process.env.CUSTODY_DB_PATH || './db-tmp/custody.sqlite';
const SESSION_COOKIE = 'custody_session';
const DEPOSIT_PRESETS = ['1', '10', '100'] as const;
const JOURNAL_CURSOR_KEY = 'journal_cursor';
const JOURNAL_SYNC_INTERVAL_MS = 200;

if (!CUSTODY_ENTITY_ID) {
  throw new Error('CUSTODY_ENTITY_ID is required');
}

const TOKENS = DEFAULT_TOKENS.map((token, index) => ({
  tokenId: index + 1,
  symbol: token.symbol,
  name: token.name,
  decimals: token.decimals,
  accent: ['#0f766e', '#2563eb', '#b45309'][index] || '#334155',
}));

const store = new CustodyStore(CUSTODY_DB_PATH);
const daemon = new DaemonRpcClient(DAEMON_WS_URL);

let syncInFlight = false;
let lastSyncOkAt = 0;
let lastSyncError: string | null = null;

const staticDir = new URL('./static/', import.meta.url);

const parseCookies = (raw: string | null): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const chunk of String(raw || '').split(';')) {
    const [namePart, ...valueParts] = chunk.split('=');
    const name = namePart?.trim();
    if (!name) continue;
    out[name] = decodeURIComponent(valueParts.join('=').trim());
  }
  return out;
};

const makeSessionCookie = (token: string): string => {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
};

const createUserId = (): string => `usr_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
const createSessionToken = (): string => crypto.randomUUID().replace(/-/g, '');
const createInvoiceId = (): string => `inv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const ensureSession = (req: Request): { session: SessionRecord; setCookie?: string } => {
  const cookies = parseCookies(req.headers.get('cookie'));
  const existingToken = cookies[SESSION_COOKIE];
  if (existingToken) {
    const touched = store.touchSession(existingToken);
    if (touched) {
      return { session: touched };
    }
  }

  const token = createSessionToken();
  const session = store.createSession(token, createUserId());
  return { session, setCookie: makeSessionCookie(token) };
};

const json = (body: unknown, init?: ResponseInit, setCookie?: string): Response => {
  const headers = new Headers(init?.headers || {});
  headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', 'no-store');
  if (setCookie) headers.append('Set-Cookie', setCookie);
  return new Response(JSON.stringify(body), { ...init, headers });
};

const html = (content: Bun.BunFile, setCookie?: string): Response => {
  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  if (setCookie) headers.append('Set-Cookie', setCookie);
  return new Response(content, { headers });
};

const asset = (path: string): Response => {
  const file = Bun.file(new URL(path, staticDir));
  return new Response(file);
};

const getToken = (tokenId: number) => TOKENS.find(token => token.tokenId === tokenId) || TOKENS[0]!;

const formatAmount = (tokenId: number, amountMinor: bigint): string => {
  const token = getToken(tokenId);
  const raw = formatUnits(amountMinor, token.decimals);
  const [whole, fractional = ''] = raw.split('.');
  const compactFractional = fractional.replace(/0+$/, '').slice(0, 6);
  return compactFractional.length > 0 ? `${whole}.${compactFractional}` : whole;
};

const buildDepositLink = (userId: string, tokenId: number, amount: string): string => {
  const url = new URL(WALLET_URL);
  url.search = '';
  const params = new URLSearchParams();
  const invoiceId = createInvoiceId();
  params.set('id', CUSTODY_ENTITY_ID);
  params.set('token', String(tokenId));
  params.set('amt', amount);
  params.set('u', userId);
  params.set('desc', `Custody invoice:${invoiceId}`);
  params.set('locked', '1');
  if (CUSTODY_JURISDICTION) params.set('jId', CUSTODY_JURISDICTION);
  url.hash = `pay?${params.toString()}`;
  return url.toString();
};

const parseUidFromDescription = (description: string): string | null => {
  const match = description.match(/(?:^|\b)uid:([a-zA-Z0-9_-]+)/);
  return match?.[1] || null;
};

const getLogString = (value: unknown): string => (typeof value === 'string' ? value : '');

const serializeActivity = (activity: ActivityRecord[]) => {
  return activity.map(item => {
    if (item.kind === 'deposit') {
      return {
        kind: 'deposit' as const,
        id: item.eventKey,
        status: 'finalized' as const,
        tokenId: item.tokenId,
        amountMinor: item.amountMinor.toString(),
        amountDisplay: formatAmount(item.tokenId, item.amountMinor),
        description: item.description,
        counterpartyEntityId: item.fromEntityId,
        hashlock: item.hashlock,
        frameHeight: item.frameHeight,
        createdAt: item.createdAt,
        updatedAt: item.createdAt,
      };
    }

    return {
      kind: 'withdrawal' as const,
      id: item.id,
      status: item.status,
      tokenId: item.tokenId,
      amountMinor: item.amountMinor.toString(),
      amountDisplay: formatAmount(item.tokenId, item.amountMinor),
      description: item.description,
      counterpartyEntityId: item.targetEntityId,
      hashlock: item.hashlock,
      frameHeight: item.frameHeight,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      error: item.daemonError,
    };
  });
};

const buildDashboardPayload = (session: SessionRecord) => {
  const balances = store.getBalances(session.userId);
  const balanceByToken = new Map(balances.map(entry => [entry.tokenId, entry]));
  const tokenRows = TOKENS.map(token => {
    const balance = balanceByToken.get(token.tokenId);
    const amountMinor = balance?.amountMinor ?? 0n;
    return {
      tokenId: token.tokenId,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      accent: token.accent,
      amountMinor: amountMinor.toString(),
      amountDisplay: formatAmount(token.tokenId, amountMinor),
      depositLinks: DEPOSIT_PRESETS.map(amount => ({
        amount,
        href: buildDepositLink(session.userId, token.tokenId, amount),
      })),
    };
  });
  const headline = tokenRows[0]!;

  return {
    session: {
      userId: session.userId,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
    },
    custody: {
      entityId: CUSTODY_ENTITY_ID,
      signerId: CUSTODY_SIGNER_ID ?? null,
      daemonWsUrl: DAEMON_WS_URL,
      walletUrl: WALLET_URL,
      jurisdictionId: CUSTODY_JURISDICTION || null,
      connected: daemon.isConnected(),
      lastSyncOkAt: lastSyncOkAt || null,
      lastSyncError,
    },
    headlineBalance: {
      tokenId: headline.tokenId,
      symbol: headline.symbol,
      amountMinor: headline.amountMinor,
      amountDisplay: headline.amountDisplay,
    },
    tokens: tokenRows,
    activity: serializeActivity(store.getRecentActivity(session.userId, 24)),
  };
};

const creditDepositFromLog = (height: number, log: DaemonFrameLog): void => {
  const data = log.data || {};
  const entityId = getLogString(data.entityId).toLowerCase();
  if (entityId !== CUSTODY_ENTITY_ID) return;

  const description = getLogString(data.description);
  const userId = parseUidFromDescription(description);
  const tokenId = Number(data.tokenId || 0);
  const amountMinor = BigInt(getLogString(data.amount) || '0');
  const hashlock = getLogString(data.hashlock);
  const fromEntityId = getLogString(data.inboundEntity) || getLogString(data.fromEntity);
  if (tokenId <= 0 || amountMinor <= 0n || !hashlock) return;

  store.creditDeposit({
    eventKey: `deposit:${hashlock.toLowerCase()}`,
    userId: userId && store.userExists(userId) ? userId : null,
    tokenId,
    amountMinor,
    description,
    fromEntityId,
    hashlock,
    frameHeight: height,
    createdAt: log.timestamp || Date.now(),
  });
};

const processFrameLog = (height: number, log: DaemonFrameLog): void => {
  if (log.message === 'HtlcReceived') {
    creditDepositFromLog(height, log);
    return;
  }

  if (log.message === 'PaymentFinalized') {
    const data = log.data || {};
    const entityId = getLogString(data.entityId).toLowerCase();
    if (entityId !== CUSTODY_ENTITY_ID) return;
    const hashlock = getLogString(data.hashlock);
    const finalRecipient = data.finalRecipient === true;
    if (finalRecipient) {
      creditDepositFromLog(height, log);
      return;
    }

    if (hashlock) {
      store.finalizeWithdrawalByHashlock({
        hashlock,
        frameHeight: height,
        updatedAt: log.timestamp || Date.now(),
      });
    }
    return;
  }

  if (log.message === 'PaymentFailed') {
    const data = log.data || {};
    const entityId = getLogString(data.entityId).toLowerCase();
    if (entityId !== CUSTODY_ENTITY_ID) return;
    const hashlock = getLogString(data.hashlock);
    if (!hashlock) return;
    const reason = getLogString(data.reason) || 'payment failed';
    store.failWithdrawalByHashlock({
      hashlock,
      error: reason,
      frameHeight: height,
      updatedAt: log.timestamp || Date.now(),
    });
  }
};

const syncJournal = async (): Promise<void> => {
  if (syncInFlight) return;
  syncInFlight = true;
  try {
    const fromHeight = store.getStateNumber(JOURNAL_CURSOR_KEY, 0) + 1;
    const response = await daemon.getFrameReceipts({
      fromHeight,
      limit: 250,
      entityId: CUSTODY_ENTITY_ID,
      eventNames: ['HtlcReceived', 'PaymentFinalized', 'PaymentFailed'],
    });

    for (const receipt of response.receipts) {
      for (const log of receipt.logs) {
        processFrameLog(receipt.height, log);
      }
    }

    store.setStateNumber(JOURNAL_CURSOR_KEY, response.toHeight);
    lastSyncOkAt = Date.now();
    lastSyncError = null;
  } catch (error) {
    lastSyncError = error instanceof Error ? error.message : String(error);
  } finally {
    syncInFlight = false;
  }
};

const syncTimer = setInterval(() => {
  void syncJournal();
}, JOURNAL_SYNC_INTERVAL_MS);

store.recoverSubmittingWithdrawals('Recovered after custody service restart before daemon confirmation');
void syncJournal();

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    if (pathname === '/') {
      const { setCookie } = ensureSession(req);
      return html(Bun.file(new URL('./index.html', staticDir)), setCookie);
    }

    if (pathname === '/app.js') {
      return asset('./app.js');
    }

    if (pathname === '/styles.css') {
      return asset('./styles.css');
    }

    if (pathname === '/api/me') {
      const { session, setCookie } = ensureSession(req);
      return json(buildDashboardPayload(session), undefined, setCookie);
    }

    if (pathname === '/api/withdraw' && req.method === 'POST') {
      const { session, setCookie } = ensureSession(req);
      try {
        const body = await req.json() as {
          targetEntityId?: string;
          tokenId?: number;
          amount?: string;
        };
        const targetEntityId = String(body.targetEntityId || '').trim().toLowerCase();
        const tokenId = Number(body.tokenId ?? 1);
        const amount = String(body.amount || '').trim();
        if (!/^0x[0-9a-f]{64}$/i.test(targetEntityId)) {
          return json({ ok: false, error: 'targetEntityId must be a 32-byte entity id' }, { status: 400 }, setCookie);
        }
        if (!Number.isFinite(tokenId) || tokenId <= 0) {
          return json({ ok: false, error: 'tokenId must be a positive integer' }, { status: 400 }, setCookie);
        }
        if (!amount) {
          return json({ ok: false, error: 'amount is required' }, { status: 400 }, setCookie);
        }

        const amountMinor = parseTokenAmount(tokenId, amount);
        if (amountMinor <= 0n) {
          return json({ ok: false, error: 'amount must be positive' }, { status: 400 }, setCookie);
        }

        const withdrawalId = `wd_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
        const description = `custody-withdrawal:${withdrawalId}`;
        store.reserveWithdrawal({
          id: withdrawalId,
          userId: session.userId,
          tokenId,
          amountMinor,
          targetEntityId,
          description,
          createdAt: Date.now(),
        });

        try {
          const queued = await daemon.queuePayment({
            sourceEntityId: CUSTODY_ENTITY_ID,
            signerId: CUSTODY_SIGNER_ID,
            targetEntityId,
            tokenId,
            amount: amountMinor.toString(),
            description,
            mode: 'htlc',
          });
          if (!queued.hashlock) {
            throw new Error('Daemon did not return hashlock for queued withdrawal');
          }
          store.markWithdrawalSent({
            id: withdrawalId,
            hashlock: queued.hashlock,
            routeJson: JSON.stringify(queued.route),
            updatedAt: Date.now(),
          });
          return json(
            {
              ok: true,
              withdrawalId,
              hashlock: queued.hashlock,
              route: queued.route,
              dashboard: buildDashboardPayload(session),
            },
            undefined,
            setCookie,
          );
        } catch (error) {
          store.failWithdrawalById({
            id: withdrawalId,
            error: error instanceof Error ? error.message : String(error),
            updatedAt: Date.now(),
            restoreBalance: true,
          });
          return json(
            { ok: false, error: error instanceof Error ? error.message : String(error), dashboard: buildDashboardPayload(session) },
            { status: 502 },
            setCookie,
          );
        }
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 }, setCookie);
      }
    }

    return new Response('Not found', { status: 404 });
  },
});

const shutdown = async (): Promise<void> => {
  clearInterval(syncTimer);
  await daemon.close();
  store.close();
  server.stop(true);
};

process.on('SIGINT', () => {
  void shutdown().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0));
});

console.log(`[custody] listening on http://${HOST}:${PORT}`);
console.log(`[custody] daemon ws: ${DAEMON_WS_URL}`);
console.log(`[custody] custody entity: ${CUSTODY_ENTITY_ID}`);

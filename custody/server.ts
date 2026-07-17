import { formatUnits } from 'ethers';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { parseTokenAmount } from '../runtime/account/financial-utils';
import { DEFAULT_TOKENS } from '../runtime/jadapter/default-tokens';
import { deriveRuntimeAdapterCapabilityToken } from '../runtime/radapter/auth';
import { RuntimeAdapterError } from '../runtime/radapter/errors';
import { createStructuredLogger } from '../runtime/infra/logger';
import { deserializeTaggedJson, serializeTaggedJson } from '../runtime/protocol/serialization';
import { readInheritedChildSecrets, resolveChildSecret } from '../runtime/orchestrator/child-secrets';
import { startParentLivenessWatch } from '../runtime/orchestrator/parent-watch';
import { DaemonRpcClient, type DaemonFrameLog } from './daemon-client';
import { CustodyStore, type ActivityRecord, type SessionRecord, type WithdrawalRecord } from './store';

const inheritedSecrets = readInheritedChildSecrets();

const HOST = process.env['CUSTODY_HOST'] || 'localhost';
const PORT = Number(process.env['CUSTODY_PORT'] || '8087');
const DAEMON_WS_URL = process.env['CUSTODY_DAEMON_WS'] || 'ws://127.0.0.1:8088/rpc';
const DAEMON_AUTH_SEED = String(process.env['CUSTODY_DAEMON_AUTH_SEED'] || '').trim();
const DAEMON_AUTH_AUDIENCE = String(process.env['CUSTODY_DAEMON_AUTH_AUDIENCE'] || '').trim().toLowerCase();
const DAEMON_RUNTIME_SEED = resolveChildSecret(inheritedSecrets, 'daemonRuntimeSeed', '');
const WALLET_URL = process.env['CUSTODY_WALLET_URL'] || 'https://localhost:8080/app';
const ENABLE_HTTPS = (() => {
  const raw = String(process.env['CUSTODY_HTTPS'] || '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  return HOST === 'localhost';
})();
const CUSTODY_NAME = String(process.env['CUSTODY_PROFILE_NAME'] || 'Custody').trim() || 'Custody';
const CUSTODY_JURISDICTION = String(process.env['CUSTODY_JURISDICTION_ID'] || process.env['CUSTODY_JURISDICTION'] || '').trim();
const CUSTODY_ENTITY_ID = String(process.env['CUSTODY_ENTITY_ID'] || '').trim().toLowerCase();
const CUSTODY_SIGNER_ID = String(process.env['CUSTODY_SIGNER_ID'] || '').trim().toLowerCase();
const CUSTODY_DB_PATH = process.env['CUSTODY_DB_PATH'] || './db-tmp/custody.sqlite';
const SESSION_COOKIE = 'custody_session';
const JOURNAL_CURSOR_KEY = 'journal_cursor';
const JOURNAL_ACTIVE_SYNC_MS = 1000;
const JOURNAL_IDLE_SYNC_MS = 1000;
const JOURNAL_ERROR_SYNC_MS = 1000;

if (!CUSTODY_ENTITY_ID) {
  throw new Error('CUSTODY_ENTITY_ID is required');
}
if (!CUSTODY_JURISDICTION) {
  throw new Error('CUSTODY_JURISDICTION_ID is required');
}
if (!DAEMON_AUTH_SEED || !DAEMON_AUTH_AUDIENCE) {
  throw new Error('CUSTODY_DAEMON_AUTH_SEED and CUSTODY_DAEMON_AUTH_AUDIENCE are required');
}
if (!DAEMON_RUNTIME_SEED) {
  throw new Error('CUSTODY_DAEMON_RUNTIME_SEED is required through the inherited secret channel');
}
if (!/^0x[0-9a-f]{40}$/.test(CUSTODY_SIGNER_ID)) {
  throw new Error('CUSTODY_SIGNER_ID must be an EOA address');
}

const TOKENS = DEFAULT_TOKENS.map((token, index) => ({
  tokenId: index + 1,
  symbol: token.symbol,
  name: token.name,
  decimals: token.decimals,
  accent: ['#0f766e', '#2563eb', '#b45309'][index] || '#334155',
}));

const store = new CustodyStore(CUSTODY_DB_PATH);
const custodyLog = createStructuredLogger('custody.service');
const daemon = new DaemonRpcClient(DAEMON_WS_URL, () => deriveRuntimeAdapterCapabilityToken(
  DAEMON_AUTH_SEED,
  'full',
  Date.now() + 5 * 60_000,
  {
    audience: DAEMON_AUTH_AUDIENCE,
    keyId: 'custody',
    tokenId: 'custody-service',
  },
), DAEMON_RUNTIME_SEED);

let syncInFlight = false;
let lastSyncOkAt = 0;
let lastSyncError: string | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

const staticDir = new URL('./static/', import.meta.url);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const resolveTlsFiles = (): { key: string; cert: string } | null => {
  const candidates = [
    { key: join(repoRoot, 'frontend', 'localhost+3-key.pem'), cert: join(repoRoot, 'frontend', 'localhost+3.pem') },
    { key: join(repoRoot, 'frontend', 'localhost+2-key.pem'), cert: join(repoRoot, 'frontend', 'localhost+2.pem') },
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate.key) && existsSync(candidate.cert)) {
      return candidate;
    }
  }
  return null;
};

const tlsFiles = ENABLE_HTTPS ? resolveTlsFiles() : null;

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

const compactUuid = (raw: string, limit?: number): string => {
  let compact = '';
  for (const char of raw) {
    if (char === '-') continue;
    compact += char;
    if (limit && compact.length >= limit) break;
  }
  return compact;
};

const createUserId = (): string => `usr_${compactUuid(crypto.randomUUID(), 20)}`;
const createSessionToken = (): string => compactUuid(crypto.randomUUID());

const ensureSession = (
  req: Request,
  options: { touch?: boolean } = {},
): { session: SessionRecord; setCookie?: string } => {
  const cookies = parseCookies(req.headers.get('cookie'));
  const existingToken = cookies[SESSION_COOKIE];
  if (existingToken) {
    const existing = options.touch === true
      ? store.touchSession(existingToken)
      : store.getSessionByToken(existingToken);
    if (existing) {
      return { session: existing };
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
  return new Response(serializeTaggedJson(body), { ...init, headers });
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

const svg = (content: string): Response => {
  return new Response(content, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
};

const getToken = (tokenId: number) => TOKENS.find(token => token.tokenId === tokenId) || TOKENS[0]!;

const formatAmount = (tokenId: number, amountMinor: bigint): string => {
  const token = getToken(tokenId);
  const raw = formatUnits(amountMinor, token.decimals);
  const [whole, fractional = ''] = raw.split('.');
  let compactFractional = fractional;
  while (compactFractional.endsWith('0')) {
    compactFractional = compactFractional.slice(0, -1);
  }
  compactFractional = compactFractional.slice(0, 6);
  const safeWhole = whole ?? '0';
  return compactFractional.length > 0 ? `${safeWhole}.${compactFractional}` : safeWhole;
};

const parseUidFromDescription = (description: string): string | null => {
  const source = String(description || '');
  for (let index = 0; index < source.length; index += 1) {
    const isBoundary = index === 0 || source[index - 1] === ' ' || source[index - 1] === '|';
    if (!isBoundary) continue;
    if (source.slice(index, index + 4) !== 'uid:') continue;
    let cursor = index + 4;
    let value = '';
    while (cursor < source.length) {
      const char = source[cursor]!;
      const code = char.charCodeAt(0);
      const isUpper = code >= 65 && code <= 90;
      const isLower = code >= 97 && code <= 122;
      const isDigit = code >= 48 && code <= 57;
      if (isUpper || isLower || isDigit || char === '_' || char === '-') {
        value += char;
        cursor += 1;
        continue;
      }
      break;
    }
    return value || null;
  }
  return null;
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
        finalizedAt: item.createdAt,
        startedAtMs: item.startedAtMs,
      };
    }

    return {
      kind: 'withdrawal' as const,
      id: item.id,
      status: item.status,
      tokenId: item.tokenId,
      amountMinor: item.amountMinor.toString(),
      amountDisplay: formatAmount(item.tokenId, item.amountMinor),
      requestedAmountMinor: item.requestedAmountMinor.toString(),
      requestedAmountDisplay: formatAmount(item.tokenId, item.requestedAmountMinor),
      feeMinor: item.feeMinor.toString(),
      feeDisplay: formatAmount(item.tokenId, item.feeMinor),
      description: item.description,
      counterpartyEntityId: item.targetEntityId,
      hashlock: item.hashlock,
      frameHeight: item.frameHeight,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      finalizedAt: item.finalizedAt,
      startedAtMs: item.startedAtMs,
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
      name: CUSTODY_NAME,
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
  const entityId = getLogString(data['entityId']).toLowerCase();
  if (entityId !== CUSTODY_ENTITY_ID) return;

  const description = getLogString(data['description']);
  const userId = parseUidFromDescription(description);
  const tokenId = Number(data['tokenId'] || 0);
  const amountMinor = BigInt(getLogString(data['amount']) || '0');
  const hashlock = getLogString(data['hashlock']);
  const fromEntityId = getLogString(data['inboundEntity']) || getLogString(data['fromEntity']);
  const startedAtMs = Number(data['startedAtMs'] || 0);
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
    startedAtMs: Number.isFinite(startedAtMs) && startedAtMs > 0 ? startedAtMs : null,
  });
};

const processFrameLog = (height: number, log: DaemonFrameLog): void => {
  if (log.message === 'HtlcReceived') {
    creditDepositFromLog(height, log);
    return;
  }

  if (log.message === 'HtlcFinalized') {
    const data = log.data || {};
    const entityId = getLogString(data['entityId']).toLowerCase();
    if (entityId !== CUSTODY_ENTITY_ID) return;
    const hashlock = getLogString(data['hashlock']);
    if (hashlock) {
      store.finalizeWithdrawalByHashlock({
        hashlock,
        frameHeight: height,
        updatedAt: log.timestamp || Date.now(),
      });
    }
    return;
  }

  if (log.message === 'HtlcFailed') {
    const data = log.data || {};
    const entityId = getLogString(data['entityId']).toLowerCase();
    if (entityId !== CUSTODY_ENTITY_ID) return;
    const hashlock = getLogString(data['hashlock']);
    if (!hashlock) return;
    const reason = getLogString(data['reason']) || 'payment failed';
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
      eventNames: ['HtlcReceived', 'HtlcFinalized', 'HtlcFailed'],
    });

    for (const receipt of response.receipts) {
      for (const log of receipt.logs) {
        processFrameLog(receipt.height, log);
      }
    }

    store.setStateNumber(JOURNAL_CURSOR_KEY, response.toHeight);
    if (response.returned > 0 || lastSyncOkAt === 0 || lastSyncError) {
      lastSyncOkAt = Date.now();
    }
    lastSyncError = null;
    scheduleJournalSync(response.returned > 0 ? JOURNAL_ACTIVE_SYNC_MS : JOURNAL_IDLE_SYNC_MS);
  } catch (error) {
    lastSyncError = error instanceof Error ? error.message : String(error);
    scheduleJournalSync(JOURNAL_ERROR_SYNC_MS);
  } finally {
    syncInFlight = false;
  }
};

const scheduleJournalSync = (delayMs: number): void => {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncJournal();
  }, delayMs);
};

let activePaymentSubmission: Promise<void> | null = null;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;
let resumeInFlight = false;

const withPaymentSubmissionLock = async <T>(operation: () => Promise<T>): Promise<T> => {
  while (activePaymentSubmission) await activePaymentSubmission;
  let release!: () => void;
  activePaymentSubmission = new Promise<void>(resolve => { release = resolve; });
  try {
    return await operation();
  } finally {
    activePaymentSubmission = null;
    release();
  }
};

const routeFromWithdrawal = (withdrawal: WithdrawalRecord): string[] => {
  if (!withdrawal.routeJson) throw new Error(`CUSTODY_WITHDRAWAL_ROUTE_MISSING:${withdrawal.id}`);
  const decoded = deserializeTaggedJson<unknown>(withdrawal.routeJson);
  if (!Array.isArray(decoded) || decoded.some(entry => typeof entry !== 'string')) {
    throw new Error(`CUSTODY_WITHDRAWAL_ROUTE_INVALID:${withdrawal.id}`);
  }
  return decoded;
};

const submitWithdrawal = async (withdrawal: WithdrawalRecord) => await withPaymentSubmissionLock(async () => {
  const route = routeFromWithdrawal(withdrawal);
  const queued = await daemon.queuePayment({
    sourceEntityId: CUSTODY_ENTITY_ID,
    signerId: CUSTODY_SIGNER_ID,
    targetEntityId: withdrawal.targetEntityId,
    tokenId: withdrawal.tokenId,
    amount: withdrawal.requestedAmountMinor.toString(),
    description: withdrawal.description,
    route,
    mode: 'htlc',
    commandId: withdrawal.commandId,
    ...(withdrawal.commandSequence !== null ? { commandSequence: withdrawal.commandSequence } : {}),
    onCommandPrepared: commandSequence => {
      store.setWithdrawalCommandSequence(withdrawal.id, withdrawal.commandId, commandSequence);
    },
  });
  if (!queued.hashlock) throw new Error(`CUSTODY_WITHDRAWAL_COMMITTED_HASHLOCK_MISSING:${withdrawal.id}`);
  const updated = store.markWithdrawalSent({
    id: withdrawal.id,
    hashlock: queued.hashlock,
    routeJson: withdrawal.routeJson!,
    updatedAt: Date.now(),
  });
  if (!updated || updated.status !== 'sent') {
    throw new Error(`CUSTODY_WITHDRAWAL_SENT_WRITE_FAILED:${withdrawal.id}`);
  }
  return queued;
});

const isTerminalSubmissionRejection = (error: unknown): boolean =>
  error instanceof RuntimeAdapterError && error.code === 'E_BAD_QUERY' && error.retryable !== true;

const recordTerminalSubmissionRejection = (
  withdrawalId: string,
  error: unknown,
): boolean => {
  const current = store.getWithdrawalById(withdrawalId);
  if (!current) throw new Error(`CUSTODY_WITHDRAWAL_DISAPPEARED:${withdrawalId}`);
  const balanceRestored = current.commandSequence === null;
  const withdrawal = store.failWithdrawalById({
    id: withdrawalId,
    error: error instanceof Error ? error.message : String(error),
    updatedAt: Date.now(),
    // A durable command sequence means network I/O may already have happened.
    // Quarantine the reserved funds instead of risking an exact-once violation.
    restoreBalance: balanceRestored,
  });
  if (!withdrawal) throw new Error(`CUSTODY_WITHDRAWAL_DISAPPEARED:${withdrawalId}`);
  return balanceRestored;
};

const scheduleSubmittingResume = (delayMs: number): void => {
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    void resumeSubmittingWithdrawals();
  }, delayMs);
};

const resumeSubmittingWithdrawals = async (): Promise<void> => {
  if (resumeInFlight) return;
  resumeInFlight = true;
  try {
    for (const withdrawal of store.listSubmittingWithdrawals()) {
      try {
        await submitWithdrawal(withdrawal);
        custodyLog.info('withdrawal.resume_committed', {
          commandId: withdrawal.commandId,
          commandSequence: withdrawal.commandSequence,
          status: 'sent',
        });
      } catch (error) {
        if (isTerminalSubmissionRejection(error)) {
          const balanceRestored = recordTerminalSubmissionRejection(withdrawal.id, error);
          custodyLog.error('withdrawal.resume_rejected', {
            commandId: withdrawal.commandId,
            commandSequence: withdrawal.commandSequence,
            status: 'failed',
            balanceRestored,
            reason: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        custodyLog.warn('withdrawal.resume_pending', {
          commandId: withdrawal.commandId,
          commandSequence: withdrawal.commandSequence,
          status: 'submitting',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    resumeInFlight = false;
  }
  if (store.listSubmittingWithdrawals().length > 0) scheduleSubmittingResume(1_000);
};

void resumeSubmittingWithdrawals();
void syncJournal();

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  ...(tlsFiles
    ? {
        tls: {
          key: Bun.file(tlsFiles.key),
          cert: Bun.file(tlsFiles.cert),
        },
      }
    : {}),
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    if (pathname === '/') {
      return html(Bun.file(new URL('./index.html', staticDir)));
    }

    if (pathname === '/app.js') {
      return asset('./app.js');
    }

    if (pathname === '/withdrawal-preflight.js') {
      return asset('./withdrawal-preflight.js');
    }

    if (pathname === '/styles.css') {
      return asset('./styles.css');
    }

    if (pathname === '/favicon.ico') {
      return new Response(null, {
        status: 204,
        headers: { 'Cache-Control': 'public, max-age=86400' },
      });
    }

    if (pathname === '/api/qr') {
      const data = String(url.searchParams.get('data') || '').trim();
      if (!data) {
        return json({ ok: false, error: 'data is required' }, { status: 400 });
      }
      try {
        const markup = await QRCode.toString(data, {
          type: 'svg',
          errorCorrectionLevel: 'M',
          margin: 1,
          width: 320,
          color: {
            dark: '#111827',
            light: '#ffffff',
          },
        });
        return svg(markup);
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
      }
    }

    if (pathname === '/api/me') {
      const { session, setCookie } = ensureSession(req, { touch: false });
      return json(buildDashboardPayload(session), undefined, setCookie);
    }

    if (pathname === '/api/reset-session' && req.method === 'POST') {
      const token = createSessionToken();
      const session = store.createSession(token, createUserId());
      return json({ ok: true, dashboard: buildDashboardPayload(session) }, undefined, makeSessionCookie(token));
    }

    if (pathname === '/api/withdraw' && req.method === 'POST') {
      const { session, setCookie } = ensureSession(req, { touch: true });
      try {
        const body = await req.json() as {
          targetEntityId?: string;
          tokenId?: number;
          amount?: string;
        };
        const targetEntityId = String(body.targetEntityId || '').trim().toLowerCase();
        const rawTokenId = body.tokenId;
        if (rawTokenId === undefined || rawTokenId === null) {
          return json({ ok: false, error: 'tokenId is required' }, { status: 400 }, setCookie);
        }
        const tokenId = Number(rawTokenId);
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
        const currentBalanceMinor = store.getBalanceAmount(session.userId, tokenId);
        if (currentBalanceMinor < amountMinor) {
          return json({ ok: false, error: 'Insufficient custody balance' }, { status: 400 }, setCookie);
        }

        const routeQuote = await daemon.findRoutes({
          sourceEntityId: CUSTODY_ENTITY_ID,
          targetEntityId,
          tokenId,
          amount: amountMinor.toString(),
        });
        const selectedRoute = routeQuote.routes[0];
        if (!selectedRoute) {
          return json({ ok: false, error: `No route found from ${CUSTODY_ENTITY_ID} to ${targetEntityId}` }, { status: 502 }, setCookie);
        }
        const senderAmountMinor = BigInt(selectedRoute.senderAmount);
        const feeMinor = BigInt(selectedRoute.totalFee);
        if (senderAmountMinor <= 0n || senderAmountMinor < amountMinor) {
          return json({ ok: false, error: 'Invalid route quote from daemon' }, { status: 502 }, setCookie);
        }
        if (currentBalanceMinor < senderAmountMinor) {
          return json(
            {
              ok: false,
              error: `Insufficient custody balance after fees: need ${formatAmount(tokenId, senderAmountMinor)} total`,
            },
            { status: 400 },
            setCookie,
          );
        }

        const withdrawalId = `wd_${compactUuid(crypto.randomUUID(), 20)}`;
        const commandId = `custody:${withdrawalId}`;
        const startedAtMs = Date.now();
        const description = `custody-withdrawal:${withdrawalId} requested:${amountMinor.toString()} fee:${feeMinor.toString()}`;
        const withdrawal = store.reserveWithdrawal({
          id: withdrawalId,
          userId: session.userId,
          tokenId,
          amountMinor: senderAmountMinor,
          requestedAmountMinor: amountMinor,
          feeMinor,
          targetEntityId,
          description,
          routeJson: serializeTaggedJson(selectedRoute.path),
          commandId,
          createdAt: Date.now(),
          startedAtMs,
        });

        try {
          const queued = await submitWithdrawal(withdrawal);
          return json(
            {
              ok: true,
              withdrawalId,
              hashlock: queued.hashlock,
              route: queued.route,
              senderAmount: senderAmountMinor.toString(),
              senderAmountDisplay: formatAmount(tokenId, senderAmountMinor),
              feeAmount: feeMinor.toString(),
              feeAmountDisplay: formatAmount(tokenId, feeMinor),
              dashboard: buildDashboardPayload(session),
            },
            undefined,
            setCookie,
          );
        } catch (error) {
          const terminal = isTerminalSubmissionRejection(error);
          if (terminal) {
            recordTerminalSubmissionRejection(withdrawalId, error);
          } else {
            scheduleSubmittingResume(1_000);
          }
          return json(
            {
              ok: false,
              pending: !terminal,
              withdrawalId,
              error: error instanceof Error ? error.message : String(error),
              dashboard: buildDashboardPayload(session),
            },
            { status: terminal ? 400 : 202 },
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
  if (syncTimer) clearTimeout(syncTimer);
  if (resumeTimer) clearTimeout(resumeTimer);
  await daemon.close();
  store.close();
  server.stop(true);
};

const managedParentPid = process.env['XLN_MANAGED_PARENT_PID'];
const stopParentWatch = managedParentPid
  ? startParentLivenessWatch('custody-service', managedParentPid, () => {
      process.kill(process.pid, 'SIGTERM');
    }, 250)
  : () => {};

process.on('SIGINT', () => {
  stopParentWatch();
  void shutdown().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  stopParentWatch();
  void shutdown().finally(() => process.exit(0));
});

console.log(`[custody] listening on ${tlsFiles ? 'https' : 'http'}://${HOST}:${PORT}`);
console.log(`[custody] daemon ws: ${DAEMON_WS_URL}`);
console.log(`[custody] custody entity: ${CUSTODY_ENTITY_ID}`);

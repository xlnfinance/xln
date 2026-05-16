import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateVerdicts, defaultJudgeBoards, judgeDebate, type AggregatedVerdict, type JudgeConfig, type JudgeVerdict } from './ai';
import { DebatesStore, type ChallengeRecord, type SessionRecord } from './store';
import { formatTokenAmount, getToken, parseTokenAmount, TOKENS } from './tokens';
import { DaemonRpcClient, deriveDebatesCapabilityToken, type DaemonFrameLog } from './xln-client';

const HOST = process.env['DEBATES_HOST'] || '127.0.0.1';
const PORT = Number(process.env['DEBATES_PORT'] || '8097');
const DB_PATH = process.env['DEBATES_DB_PATH'] || './db-tmp/debates.sqlite';
const DEV_MODE = process.env['DEBATES_DEV_MODE'] === '1' || process.env['NODE_ENV'] !== 'production';
const DAEMON_WS_URL = String(process.env['DEBATES_DAEMON_WS'] || process.env['CUSTODY_DAEMON_WS'] || 'ws://127.0.0.1:8088/rpc');
const DAEMON_AUTH_SEED = String(process.env['DEBATES_DAEMON_AUTH_SEED'] || process.env['CUSTODY_DAEMON_AUTH_SEED'] || '').trim();
const DAEMON_AUTH_AUDIENCE = String(process.env['DEBATES_DAEMON_AUTH_AUDIENCE'] || process.env['CUSTODY_DAEMON_AUTH_AUDIENCE'] || '').trim().toLowerCase();
const DAEMON_ENABLED = process.env['DEBATES_OFFLINE_XLN'] !== '1' && !!DAEMON_AUTH_SEED && !!DAEMON_AUTH_AUDIENCE;
const OFFLINE_XLN = !DAEMON_ENABLED;
const SESSION_COOKIE = 'debates_session';
const SERVICE_ENTITY_ID = String(process.env['DEBATES_ENTITY_ID'] || process.env['CUSTODY_ENTITY_ID'] || '0xdebadebadebadebadebadebadebadebadebadebadebadebadebadebadebadeb').toLowerCase();
const SERVICE_SIGNER_ID = String(process.env['DEBATES_SIGNER_ID'] || process.env['CUSTODY_SIGNER_ID'] || '').trim().toLowerCase() || undefined;
const STATIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'static');
const JOURNAL_CURSOR_KEY = 'journal_cursor';
const JOURNAL_ACTIVE_SYNC_MS = 1000;
const JOURNAL_IDLE_SYNC_MS = 1500;
const JOURNAL_ERROR_SYNC_MS = 2000;

const store = new DebatesStore(DB_PATH);
const daemon = DAEMON_ENABLED
  ? new DaemonRpcClient(DAEMON_WS_URL, () => deriveDebatesCapabilityToken(
    DAEMON_AUTH_SEED,
    'full',
    Date.now() + 5 * 60_000,
    {
      audience: DAEMON_AUTH_AUDIENCE,
      keyId: 'debates',
      tokenId: randomUUID(),
    },
  ))
  : null;

let syncInFlight = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let lastSyncOkAt = 0;
let lastSyncError: string | null = null;

const compactUuid = (): string => randomUUID().replaceAll('-', '');

const parseCookies = (raw: string | null): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const part of String(raw || '').split(';')) {
    const [name, ...value] = part.split('=');
    const key = name?.trim();
    if (key) out[key] = decodeURIComponent(value.join('=').trim());
  }
  return out;
};

const makeCookie = (token: string): string =>
  `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;

const ensureSession = (req: Request, touch = true): { session: SessionRecord; setCookie?: string } => {
  const token = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE];
  if (token) {
    const existing = touch ? store.touchSession(token) : store.getSessionByToken(token);
    if (existing) return { session: existing };
  }
  const session = store.createSession();
  return { session, setCookie: makeCookie(session.token) };
};

const json = (body: unknown, init?: ResponseInit, setCookie?: string): Response => {
  const headers = new Headers(init?.headers || {});
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  if (setCookie) headers.append('Set-Cookie', setCookie);
  return new Response(JSON.stringify(body), { ...init, headers });
};

const readJson = async <T>(req: Request): Promise<T> => {
  try {
    return await req.json() as T;
  } catch {
    return {} as T;
  }
};

const parseUidFromDescription = (description: string): string | null => {
  const source = String(description || '');
  for (let index = 0; index < source.length; index += 1) {
    const boundary = index === 0 || source[index - 1] === ' ' || source[index - 1] === '|';
    if (!boundary || source.slice(index, index + 4) !== 'uid:') continue;
    let cursor = index + 4;
    let value = '';
    while (cursor < source.length) {
      const char = source[cursor]!;
      if (/^[A-Za-z0-9_-]$/.test(char)) {
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

const getLogString = (value: unknown): string => typeof value === 'string' ? value : '';

const creditDepositFromLog = (height: number, log: DaemonFrameLog): void => {
  const data = log.data || {};
  const entityId = getLogString(data['entityId']).toLowerCase();
  if (entityId !== SERVICE_ENTITY_ID) return;
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
    if (getLogString(data['entityId']).toLowerCase() !== SERVICE_ENTITY_ID) return;
    const hashlock = getLogString(data['hashlock']);
    if (hashlock) store.finalizeWithdrawalByHashlock({ hashlock, frameHeight: height, updatedAt: log.timestamp || Date.now() });
    return;
  }
  if (log.message === 'HtlcFailed') {
    const data = log.data || {};
    if (getLogString(data['entityId']).toLowerCase() !== SERVICE_ENTITY_ID) return;
    const hashlock = getLogString(data['hashlock']);
    if (!hashlock) return;
    store.failWithdrawalByHashlock({
      hashlock,
      error: getLogString(data['reason']) || 'payment failed',
      frameHeight: height,
      updatedAt: log.timestamp || Date.now(),
    });
  }
};

const syncJournal = async (): Promise<void> => {
  if (!daemon || syncInFlight) return;
  syncInFlight = true;
  try {
    const fromHeight = store.getStateNumber(JOURNAL_CURSOR_KEY, 0) + 1;
    const response = await daemon.getFrameReceipts({
      fromHeight,
      limit: 250,
      entityId: SERVICE_ENTITY_ID,
      eventNames: ['HtlcReceived', 'HtlcFinalized', 'HtlcFailed'],
    });
    for (const receipt of response.receipts) {
      for (const log of receipt.logs) processFrameLog(receipt.height, log);
    }
    store.setStateNumber(JOURNAL_CURSOR_KEY, response.toHeight);
    if (response.returned > 0 || lastSyncOkAt === 0 || lastSyncError) lastSyncOkAt = Date.now();
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
  if (!daemon) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncJournal();
  }, delayMs);
};

const asset = async (pathname: string): Promise<Response> => {
  const clean = pathname === '/' ? '/index.html' : pathname;
  const fullPath = join(STATIC_DIR, clean.replace(/^\/+/, ''));
  if (!fullPath.startsWith(STATIC_DIR) || !existsSync(fullPath)) {
    return new Response('Not found', { status: 404 });
  }
  const type = fullPath.endsWith('.css')
    ? 'text/css; charset=utf-8'
    : fullPath.endsWith('.js')
      ? 'application/javascript; charset=utf-8'
      : 'text/html; charset=utf-8';
  return new Response(Bun.file(fullPath), {
    headers: { 'Content-Type': type, 'Cache-Control': 'no-store' },
  });
};

const serializeBalance = (balance: ReturnType<DebatesStore['getBalance']>) => ({
  tokenId: balance.tokenId,
  symbol: getToken(balance.tokenId).symbol,
  availableMinor: balance.availableMinor.toString(),
  lockedMinor: balance.lockedMinor.toString(),
  spentMinor: balance.spentMinor.toString(),
  availableDisplay: formatTokenAmount(balance.tokenId, balance.availableMinor),
  lockedDisplay: formatTokenAmount(balance.tokenId, balance.lockedMinor),
  spentDisplay: formatTokenAmount(balance.tokenId, balance.spentMinor),
  updatedAt: balance.updatedAt,
});

const serializeMessage = (message: ReturnType<DebatesStore['getMessages']>[number]) => ({
  id: message.id,
  roundNumber: message.roundNumber,
  side: message.side,
  userId: message.userId,
  body: message.body,
  bodyHash: message.bodyHash,
  charsCount: message.charsCount,
  createdAt: message.createdAt,
});

const serializeChallengeSummary = (challenge: ChallengeRecord) => ({
  id: challenge.id,
  slug: challenge.slug,
  statement: challenge.statement,
  sideALabel: challenge.sideALabel,
  sideBLabel: challenge.sideBLabel,
  status: challenge.status,
  visibility: challenge.visibility,
  tokenId: challenge.tokenId,
  tokenSymbol: getToken(challenge.tokenId).symbol,
  stakeMinor: challenge.stakeMinor.toString(),
  stakeDisplay: formatTokenAmount(challenge.tokenId, challenge.stakeMinor),
  roundsTotal: challenge.roundsTotal,
  currentRound: challenge.currentRound,
  messageLimitChars: challenge.messageLimitChars,
  createdAt: challenge.createdAt,
  finalizedAt: challenge.finalizedAt,
  verdictSummary: (() => {
    const verdict = store.getVerdict(challenge.id);
    if (!verdict) return null;
    const payout = JSON.parse(verdict.payout_json);
    return `Side ${verdict.winner} ${payout.scores1000?.A ?? '-'}-${payout.scores1000?.B ?? '-'} (+${payout.margin ?? '-'})`;
  })(),
});

const serializeChallengeDetail = (challenge: ChallengeRecord, session?: SessionRecord) => {
  const messages = store.getMessages(challenge.id);
  const verdict = store.getVerdict(challenge.id);
  const judgeRuns = store.getJudgeRuns(challenge.id);
  const side = session?.userId === challenge.sideAUserId ? 'A' : session?.userId === challenge.sideBUserId ? 'B' : null;
  const expectedSide = challenge.status === 'active'
    ? (messages.length % 2 === 0 ? 'A' : 'B')
    : null;
  return {
    ...serializeChallengeSummary(challenge),
    createdByUserId: challenge.createdByUserId,
    sideAUserId: challenge.sideAUserId,
    sideBUserId: challenge.sideBUserId,
    payoutRule: challenge.payoutRule,
    inviteToken: session?.userId === challenge.createdByUserId ? challenge.inviteToken : null,
    inviteUrl: session?.userId === challenge.createdByUserId ? `/c/${challenge.slug}?invite=${challenge.inviteToken}` : null,
    acceptedAt: challenge.acceptedAt,
    startedAt: challenge.startedAt,
    judgingStartedAt: challenge.judgingStartedAt,
    rules: JSON.parse(challenge.rulesJson),
    context: JSON.parse(challenge.contextJson),
    judgeBoard: JSON.parse(challenge.judgeBoardJson) as JudgeConfig[],
    messages: messages.map(serializeMessage),
    userSide: side,
    canAccept: !!session && challenge.status === 'waiting_for_counterparty' && challenge.sideAUserId !== session.userId,
    canSubmit: !!side && challenge.status === 'active' && expectedSide === side,
    expectedSide,
    verdict: verdict ? {
      id: verdict.id,
      winner: verdict.winner,
      method: verdict.method,
      votes: JSON.parse(verdict.votes_json),
      confidence: verdict.confidence,
      payout: JSON.parse(verdict.payout_json),
      summary: verdict.summary,
      createdAt: verdict.created_at,
    } : null,
    judgeRuns: judgeRuns.map(run => ({
      id: run.id,
      judgeId: run.judge_id,
      provider: run.provider,
      model: run.model,
      status: run.status,
      inputHash: run.input_hash,
      verdict: run.verdict_json ? JSON.parse(run.verdict_json) : null,
      error: run.error,
      startedAt: run.started_at,
      completedAt: run.completed_at,
    })),
  };
};

const buildDashboard = (session: SessionRecord) => {
  const user = store.getUser(session.userId);
  const balances = TOKENS.map(token => serializeBalance(store.getBalance(session.userId, token.tokenId)));
  const publicChallenges = store.listPublicChallenges(30).map(serializeChallengeSummary);
  const myChallenges = store.listUserChallenges(session.userId, 30).map(serializeChallengeSummary);
  return {
    session: {
      userId: session.userId,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
    },
    user,
      service: {
      name: 'XLN Debates',
      entityId: SERVICE_ENTITY_ID,
      offlineXln: OFFLINE_XLN,
      daemonEnabled: DAEMON_ENABLED,
      daemonConnected: daemon?.isConnected() ?? false,
      daemonWsUrl: DAEMON_WS_URL,
      lastSyncOkAt: lastSyncOkAt || null,
      lastSyncError,
      devMode: DEV_MODE,
      domain: 'debates.xln.finance',
    },
    tokens: TOKENS,
    balances,
    ledger: store.getRecentLedger(session.userId, 30).map(row => ({
      id: row.id,
      tokenId: row.token_id,
      tokenSymbol: getToken(row.token_id).symbol,
      deltaAvailableMinor: row.delta_available_minor,
      deltaLockedMinor: row.delta_locked_minor,
      deltaSpentMinor: row.delta_spent_minor,
      reason: row.reason,
      referenceType: row.reference_type,
      referenceId: row.reference_id,
      createdAt: row.created_at,
    })),
    judgeBoards: defaultJudgeBoards,
    publicChallenges,
    myChallenges,
  };
};

const validateChallengeInput = (body: Record<string, unknown>) => {
  const statement = String(body['statement'] || '').trim();
  if (statement.length < 8) throw new Error('Statement is too short');
  const tokenId = Number(body['tokenId'] || 1);
  const stakeMinor = parseTokenAmount(tokenId, String(body['stake'] || '0'));
  const roundsTotal = Math.max(1, Math.min(10, Math.floor(Number(body['roundsTotal'] || 3))));
  const messageLimitChars = Math.max(200, Math.min(8000, Math.floor(Number(body['messageLimitChars'] || 1200))));
  const boardId = String(body['boardId'] || 'classic3');
  const judgeBoard = defaultJudgeBoards[boardId] || defaultJudgeBoards['classic3']!;
  return {
    statement,
    sideALabel: String(body['sideALabel'] || 'Affirmative').trim().slice(0, 80) || 'Affirmative',
    sideBLabel: String(body['sideBLabel'] || 'Negative').trim().slice(0, 80) || 'Negative',
    visibility: (body['visibility'] === 'unlisted' || body['visibility'] === 'private' ? body['visibility'] : 'public') as 'public' | 'unlisted' | 'private',
    tokenId,
    stakeMinor,
    roundsTotal,
    messageLimitChars,
    context: {
      text: String(body['contextText'] || '').trim().slice(0, 24_000),
      attachments: [],
    },
    rules: {
      template: String(body['rulesTemplate'] || 'General Debate'),
      custom: String(body['customRules'] || '').trim().slice(0, 12_000),
      criteria: ['logic', 'evidence', 'directness', 'rebuttal', 'clarity', 'rule_compliance'],
    },
    judgeBoard,
  };
};

const demoCases = [
  {
    statement: 'Remote-first companies outperform office-first companies for senior engineering teams.',
    a: 'Remote-first maximizes deep work and global hiring quality',
    b: 'Office-first creates faster trust and coordination',
    winner: 'A' as const,
    scores: { A: 842, B: 711 },
    context: 'Evaluate productivity, hiring, onboarding, coordination, retention, and management overhead.',
    rounds: [
      ['Remote-first wins because senior engineering output depends on uninterrupted deep work, written artifacts, and access to global talent. The evidence is that distributed teams force documentation and async decision records, reducing hallway politics and making decisions auditable.', 'Office-first wins because trust, mentorship, and fast ambiguity resolution are easier in person. Remote teams often hide coordination debt behind documents and meetings, while product discovery benefits from immediate shared context.'],
      ['The office argument confuses speed with quality. Senior teams do not need constant interruption; they need crisp specs, ownership, and review loops. Remote-first exposes weak management instead of masking it with presence.', 'Remote-first still fails for junior onboarding and ambiguous strategy. The cost of misalignment compounds when hard conversations are delayed or flattened into text.'],
    ],
  },
  {
    statement: 'USDC is a better settlement token than volatile native assets for application escrow.',
    a: 'Stablecoin escrow gives users predictable stakes and payouts',
    b: 'Native assets give deeper liquidity and simpler chain economics',
    winner: 'A' as const,
    scores: { A: 901, B: 684 },
    context: 'Focus on user trust, accounting, volatility, liquidity, and application UX.',
    rounds: [
      ['USDC is better because escrow users reason in dollars. A challenge for 100 should not become 87 or 116 during judging. Stable accounting improves trust, tax records, refunds, and product comprehension.', 'Native assets reduce dependencies and align incentives with the underlying network. They are easier for crypto-native users and can have better immediate liquidity.'],
      ['The dependency critique is real, but application escrow is a UX promise. Volatility turns dispute resolution into accidental speculation. The product should make the debate risky, not the unit of account.', 'Some users accept volatility for censorship resistance and upside. A protocol should not force one asset model.'],
    ],
  },
  {
    statement: 'Open-source AI models will dominate private enterprise inference.',
    a: 'Open models win through control, privacy, and cost curves',
    b: 'Closed frontier models keep winning on quality and support',
    winner: 'B' as const,
    scores: { A: 733, B: 821 },
    context: 'Evaluate model quality, deployment control, support, compliance, and total cost.',
    rounds: [
      ['Open models dominate because enterprises need data locality, predictable costs, and the ability to fine-tune. Once quality is good enough, control beats marginal benchmark wins.', 'Closed models keep winning because enterprises buy outcomes, uptime, and frontier quality. Support, safety review, and tool ecosystems matter more than running weights.'],
      ['Quality gaps compress over time, while privacy and procurement friction remain. Open models can be deployed per jurisdiction and audited internally.', 'The argument assumes good enough is enough. In high-value workflows, a 5 percent quality delta can dwarf infra savings. Closed providers also offer compliance and indemnity that internal teams cannot replicate quickly.'],
    ],
  },
  {
    statement: 'A two-party AI court should publish every transcript and judge vote by default.',
    a: 'Public transcripts create legitimacy and prevent hidden manipulation',
    b: 'Privacy defaults are required for adoption and sensitive disputes',
    winner: 'B' as const,
    scores: { A: 718, B: 794 },
    context: 'Balance transparency, privacy, appealability, abuse prevention, and product adoption.',
    rounds: [
      ['Public transcripts are the source of legitimacy. If money moves based on AI judgement, the public needs to inspect the claims, context, and every judge vote.', 'Privacy must be the default. Many valuable disputes include sensitive business facts, personal context, or unreleased product details. Public-by-default kills adoption.'],
      ['Private disputes can exist, but public default creates norms and searchable precedent. Hidden courts invite manipulation and unverifiable outcomes.', 'The stronger design is user-chosen visibility plus cryptographic hashes. You can prove transcript integrity without forcing every dispute into public view.'],
    ],
  },
  {
    statement: 'Linux is better than Windows for professional developers.',
    a: 'Linux matches production systems and gives better automation',
    b: 'Windows wins on compatibility, vendor support, and mainstream polish',
    winner: 'A' as const,
    scores: { A: 866, B: 742 },
    context: 'Compare production parity, developer tooling, security posture, cost, enterprise support, and hardware compatibility.',
    rounds: [
      ['Linux is better because most production infrastructure runs Linux. Developers benefit when local tools, shells, containers, package managers, permissions, and debugging match deployment targets.', 'Windows has broader commercial software support, driver coverage, and enterprise management. WSL narrows the Linux gap while preserving mainstream compatibility.'],
      ['WSL is useful but it proves the point: developers need Linux semantics. Running a Linux layer inside Windows adds complexity compared with using the native environment directly.', 'Native Linux can still impose hardware and app compatibility costs. For mixed enterprise teams, Windows may reduce support burden.'],
    ],
  },
];

const makeDemoVerdicts = (winner: 'A' | 'B', scores: { A: number; B: number }): JudgeVerdict[] => {
  const labels = ['Logic Judge', 'Evidence Judge', 'Clarity Judge'];
  return labels.map((label, index) => {
    const shift = (index - 1) * 13;
    const a = Math.max(0, Math.min(1000, scores.A + shift));
    const b = Math.max(0, Math.min(1000, scores.B - shift));
    return {
      winner: a === b ? 'draw' : a > b ? 'A' : 'B',
      confidence: 0.72 + index * 0.05,
      scores: { A: Math.round(a / 10), B: Math.round(b / 10) },
      scores1000: { A: a, B: b },
      margin: Math.abs(a - b),
      criteria: {
        logic: { A: Math.round(a / 100), B: Math.round(b / 100) },
        evidence: { A: Math.round((a - 30) / 100), B: Math.round((b - 30) / 100) },
        rebuttal: { A: Math.round((a - 50) / 100), B: Math.round((b - 50) / 100) },
        clarity: { A: 8, B: 8 },
        rule_compliance: { A: 10, B: 10 },
      },
      ruleViolations: [],
      reasoning: `${label} scored Side ${winner} higher on the 1000-point court scale because it better connected claims to the supplied context and rebutted the strongest opposing point.`,
      decisiveMoments: [{ round: 2, side: winner, summary: `Side ${winner} converted the core tradeoff into a clearer decision rule.` }],
    };
  });
};

const seedDemoDebates = (): { created: number; challenges: Array<{ slug: string; statement: string }> } => {
  const existing = store.listPublicChallenges(200).filter(challenge => challenge.status === 'finalized').length;
  if (existing >= 5) {
    return { created: 0, challenges: store.listPublicChallenges(5).map(challenge => ({ slug: challenge.slug, statement: challenge.statement })) };
  }
  const created: Array<{ slug: string; statement: string }> = [];
  for (const demo of demoCases) {
    const sideA = store.createDemoUser(`Counsel A ${created.length + 1}`);
    const sideB = store.createDemoUser(`Counsel B ${created.length + 1}`);
    store.fundDevBalance(sideA.id, 1, parseTokenAmount(1, '1000'));
    store.fundDevBalance(sideB.id, 1, parseTokenAmount(1, '1000'));
    const challenge = store.createChallenge({
      userId: sideA.id,
      statement: demo.statement,
      sideALabel: demo.a,
      sideBLabel: demo.b,
      visibility: 'public',
      tokenId: 1,
      stakeMinor: parseTokenAmount(1, '25'),
      roundsTotal: demo.rounds.length,
      messageLimitChars: 1600,
      context: { text: demo.context, attachments: [] },
      rules: { template: 'Court Mode', custom: 'Two parties argue alternating rounds. Judges score out of 1000 and decide by margin.', criteria: ['logic', 'evidence', 'rebuttal', 'clarity', 'rule_compliance'] },
      judgeBoard: defaultJudgeBoards['classic3']!,
    });
    const accepted = store.acceptChallenge(challenge.slug, sideB.id);
    let timestamp = Date.now() - (created.length + 1) * 60_000;
    demo.rounds.forEach((round, index) => {
      store.addDemoMessage(accepted.id, sideA.id, index + 1, 'A', round[0]!, timestamp += 1000);
      store.addDemoMessage(accepted.id, sideB.id, index + 1, 'B', round[1]!, timestamp += 1000);
    });
    store.markReadyForJudging(accepted.id);
    const completed = store.getChallengeBySlug(accepted.slug)!;
    const messages = store.getMessages(completed.id);
    store.beginJudging(completed.id);
    const inputHash = store.inputHashForChallenge(completed, messages);
    const verdicts = makeDemoVerdicts(demo.winner, demo.scores);
    const judges = defaultJudgeBoards['classic3']!;
    verdicts.forEach((verdict, index) => {
      store.recordJudgeRun({ challengeId: completed.id, judge: judges[index]!, inputHash, verdict });
    });
    const aggregated: AggregatedVerdict = aggregateVerdicts(verdicts);
    store.finalizeVerdict(completed.id, aggregated);
    created.push({ slug: completed.slug, statement: completed.statement });
  }
  return { created: created.length, challenges: created };
};

const runJudgePipeline = async (challenge: ChallengeRecord) => {
  const messages = store.getMessages(challenge.id);
  if (messages.length < challenge.roundsTotal * 2) throw new Error('Debate transcript is incomplete');
  store.beginJudging(challenge.id);
  const current = store.getChallengeBySlug(challenge.slug) || challenge;
  const judgeBoard = JSON.parse(current.judgeBoardJson) as JudgeConfig[];
  const input = {
    challengeId: current.id,
    statement: current.statement,
    sideALabel: current.sideALabel,
    sideBLabel: current.sideBLabel,
    rules: JSON.parse(current.rulesJson),
    context: JSON.parse(current.contextJson),
    transcript: messages.map(message => ({
      roundNumber: message.roundNumber,
      side: message.side,
      body: message.body,
    })),
  };
  const inputHash = store.inputHashForChallenge(current, messages);
  const results = await judgeDebate(input, judgeBoard);
  for (const result of results) {
    store.recordJudgeRun({
      challengeId: current.id,
      judge: result.judge,
      inputHash,
      verdict: result.verdict,
    });
  }
  const aggregated = aggregateVerdicts(results.map(result => result.verdict));
  store.finalizeVerdict(current.id, aggregated);
  return store.getChallengeBySlug(current.slug)!;
};

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    try {
      if (pathname === '/api/me') {
        const { session, setCookie } = ensureSession(req, false);
        return json(buildDashboard(session), undefined, setCookie);
      }

      if (pathname === '/api/reset-session' && req.method === 'POST') {
        const session = store.createSession();
        return json({ ok: true, dashboard: buildDashboard(session) }, undefined, makeCookie(session.token));
      }

      if (pathname === '/api/auth/challenge') {
        const { session, setCookie } = ensureSession(req);
        const nonce = compactUuid();
        return json({
          nonce,
          expiresAt: Date.now() + 5 * 60_000,
          message: `Sign in to XLN Debates\nuser:${session.userId}\nnonce:${nonce}`,
        }, undefined, setCookie);
      }

      if (pathname === '/api/auth/verify' && req.method === 'POST') {
        const { session, setCookie } = ensureSession(req);
        const body = await readJson<Record<string, unknown>>(req);
        return json({
          ok: true,
          mode: 'placeholder',
          message: 'XLN signature verification adapter is reserved; session is active for MVP.',
          entityId: String(body['entityId'] || ''),
          signerId: String(body['signerId'] || ''),
          dashboard: buildDashboard(session),
        }, undefined, setCookie);
      }

      if (pathname === '/api/dev/fund' && req.method === 'POST') {
        if (!DEV_MODE) return json({ ok: false, error: 'Dev funding is disabled' }, { status: 403 });
        const { session, setCookie } = ensureSession(req);
        const body = await readJson<{ tokenId?: number; amount?: string }>(req);
        const tokenId = Number(body.tokenId || 1);
        const amountMinor = parseTokenAmount(tokenId, String(body.amount || '250'));
        store.fundDevBalance(session.userId, tokenId, amountMinor);
        return json({ ok: true, dashboard: buildDashboard(session) }, undefined, setCookie);
      }

      if (pathname === '/api/dev/seed-demo' && req.method === 'POST') {
        if (!DEV_MODE) return json({ ok: false, error: 'Demo seeding is disabled' }, { status: 403 });
        const { session, setCookie } = ensureSession(req);
        const result = seedDemoDebates();
        return json({ ok: true, ...result, dashboard: buildDashboard(session) }, undefined, setCookie);
      }

      if (pathname === '/api/deposit/instructions') {
        const { session, setCookie } = ensureSession(req);
        const tokenId = Number(url.searchParams.get('tokenId') || '1');
        return json({
          ok: true,
          tokenId,
          token: getToken(tokenId),
          serviceEntityId: SERVICE_ENTITY_ID,
          description: `uid:${session.userId} xln-debates-deposit`,
          offline: OFFLINE_XLN,
        }, undefined, setCookie);
      }

      if (pathname === '/api/challenges' && req.method === 'GET') {
        const { session, setCookie } = ensureSession(req, false);
        return json({
          ok: true,
          publicChallenges: store.listPublicChallenges(60).map(serializeChallengeSummary),
          myChallenges: store.listUserChallenges(session.userId, 60).map(serializeChallengeSummary),
        }, undefined, setCookie);
      }

      if (pathname === '/api/challenges' && req.method === 'POST') {
        const { session, setCookie } = ensureSession(req);
        const body = await readJson<Record<string, unknown>>(req);
        const input = validateChallengeInput(body);
        const challenge = store.createChallenge({ userId: session.userId, ...input });
        return json({ ok: true, challenge: serializeChallengeDetail(challenge, session), dashboard: buildDashboard(session) }, undefined, setCookie);
      }

      const challengeMatch = pathname.match(/^\/api\/challenges\/([^/]+)(?:\/([^/]+))?$/);
      if (challengeMatch) {
        const slug = decodeURIComponent(challengeMatch[1]!);
        const action = challengeMatch[2] || '';
        const { session, setCookie } = ensureSession(req, action !== '');
        const challenge = store.getChallengeBySlug(slug);
        if (!challenge) return json({ ok: false, error: 'Challenge not found' }, { status: 404 }, setCookie);

        if (!action && req.method === 'GET') {
          return json({ ok: true, challenge: serializeChallengeDetail(challenge, session) }, undefined, setCookie);
        }

        if (action === 'accept' && req.method === 'POST') {
          const accepted = store.acceptChallenge(slug, session.userId);
          return json({ ok: true, challenge: serializeChallengeDetail(accepted, session), dashboard: buildDashboard(session) }, undefined, setCookie);
        }

        if (action === 'messages' && req.method === 'POST') {
          const body = await readJson<{ body?: string }>(req);
          const result = store.addMessage(slug, session.userId, String(body.body || ''));
          return json({ ok: true, challenge: serializeChallengeDetail(result.challenge, session), message: serializeMessage(result.message) }, undefined, setCookie);
        }

        if (action === 'judge' && req.method === 'POST') {
          const judged = await runJudgePipeline(challenge);
          return json({ ok: true, challenge: serializeChallengeDetail(judged, session), dashboard: buildDashboard(session) }, undefined, setCookie);
        }

        return json({ ok: false, error: 'Unsupported challenge action' }, { status: 404 }, setCookie);
      }

      if (pathname === '/api/withdraw' && req.method === 'POST') {
        const { session, setCookie } = ensureSession(req);
        const body = await readJson<{ tokenId?: number; amount?: string; targetEntityId?: string }>(req);
        const tokenId = Number(body.tokenId || 1);
        const amountMinor = parseTokenAmount(tokenId, String(body.amount || '0'));
        if (amountMinor <= 0n) throw new Error('Amount must be positive');
        const targetEntityId = String(body.targetEntityId || '').trim().toLowerCase();
        if (!/^0x[0-9a-f]{64}$/i.test(targetEntityId)) throw new Error('Target entity must be a 32-byte hex XLN entity id');
        let withdrawal;
        if (daemon) {
          const routeQuote = await daemon.findRoutes({
            sourceEntityId: SERVICE_ENTITY_ID,
            targetEntityId,
            tokenId,
            amount: amountMinor.toString(),
          });
          const selectedRoute = routeQuote.routes[0];
          if (!selectedRoute) throw new Error(`No XLN route found from ${SERVICE_ENTITY_ID} to ${targetEntityId}`);
          const senderAmountMinor = BigInt(selectedRoute.senderAmount);
          const feeMinor = BigInt(selectedRoute.totalFee);
          const withdrawalId = `wd_${compactUuid().slice(0, 20)}`;
          const startedAtMs = Date.now();
          const description = `debates-withdrawal:${withdrawalId} requested:${amountMinor.toString()} fee:${feeMinor.toString()}`;
          withdrawal = store.reserveWithdrawal({
            id: withdrawalId,
            userId: session.userId,
            tokenId,
            amountMinor: senderAmountMinor,
            requestedAmountMinor: amountMinor,
            feeMinor,
            targetEntityId,
            description,
            createdAt: Date.now(),
            startedAtMs,
          });
          try {
            const queued = await daemon.queuePayment({
              sourceEntityId: SERVICE_ENTITY_ID,
              targetEntityId,
              tokenId,
              amount: amountMinor.toString(),
              description,
              startedAtMs,
              route: selectedRoute.path,
              mode: 'htlc',
              ...(SERVICE_SIGNER_ID ? { signerId: SERVICE_SIGNER_ID } : {}),
            });
            if (!queued.hashlock) throw new Error('Daemon did not return hashlock for queued withdrawal');
            withdrawal = store.markWithdrawalSent({
              id: withdrawalId,
              hashlock: queued.hashlock,
              routeJson: JSON.stringify(queued.route),
              updatedAt: Date.now(),
            }) || withdrawal;
          } catch (error) {
            store.failWithdrawalById({
              id: withdrawalId,
              error: error instanceof Error ? error.message : String(error),
              updatedAt: Date.now(),
              restoreBalance: true,
            });
            throw error;
          }
        } else {
          withdrawal = store.createWithdrawal({
            userId: session.userId,
            tokenId,
            amountMinor,
            targetEntityId,
            offlineFinalized: true,
          });
        }
        return json({
          ok: true,
          withdrawal: {
            id: withdrawal.id,
            status: withdrawal.status,
            hashlock: withdrawal.hashlock,
            amountDisplay: formatTokenAmount(withdrawal.tokenId, withdrawal.requestedAmountMinor),
            finalizedAt: withdrawal.finalizedAt,
          },
          dashboard: buildDashboard(session),
        }, undefined, setCookie);
      }

      if (pathname === '/healthz') {
        return json({ ok: true, service: 'xln-debates' });
      }

      if (pathname === '/' || pathname === '/app.js' || pathname === '/styles.css') {
        return await asset(pathname);
      }

      if (pathname.startsWith('/c/')) {
        return await asset('/index.html');
      }

      return await asset('/index.html');
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  },
});

const shutdown = (): void => {
  if (syncTimer) clearTimeout(syncTimer);
  void daemon?.close();
  store.close();
  server.stop(true);
};

process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});

process.on('SIGTERM', () => {
  shutdown();
  process.exit(0);
});

console.log(`[debates] listening on http://${HOST}:${PORT}`);
console.log(`[debates] db: ${DB_PATH}`);
console.log(`[debates] service entity: ${SERVICE_ENTITY_ID}`);
console.log(`[debates] xln mode: ${DAEMON_ENABLED ? `daemon ${DAEMON_WS_URL}` : 'offline/dev'}`);

store.recoverSubmittingWithdrawals('Recovered after debates service restart before daemon confirmation');
if (daemon) void syncJournal();

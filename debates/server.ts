import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateVerdicts, alignScoresWithWinner, defaultJudgeBoards, generateDebateTurn, judgeDebate, type AggregatedVerdict, type DebateMessageForJudge, type JudgeConfig, type JudgeVerdict } from './ai';
import { DebatesStore, type ChallengeRecord, type CustomSkillRecord, type DebateSide, type SessionRecord, type WithdrawalRecord } from './store';
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
const DEFAULT_AI_MODEL = String(process.env['DEBATES_AI_MODEL'] || 'gemma3-27b-mlx');

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

const escapeHtml = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[char] || char));

type PageMeta = {
  title: string;
  description: string;
  url: string;
  imageUrl: string;
};

const defaultPageMeta = (origin: string): PageMeta => ({
  title: 'XLN Debates',
  description: 'AI-judged challenge arena with XLN escrow, 1000-point verdicts, and public receipts.',
  url: `${origin}/`,
  imageUrl: `${origin}/api/arena/card.svg`,
});

const metaTags = (meta: PageMeta): string => `
    <meta name="description" content="${escapeHtml(meta.description)}" />
    <meta property="og:title" content="${escapeHtml(meta.title)}" />
    <meta property="og:description" content="${escapeHtml(meta.description)}" />
    <meta property="og:type" content="article" />
    <meta property="og:url" content="${escapeHtml(meta.url)}" />
    <meta property="og:image" content="${escapeHtml(meta.imageUrl)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(meta.title)}" />
    <meta name="twitter:description" content="${escapeHtml(meta.description)}" />
    <meta name="twitter:image" content="${escapeHtml(meta.imageUrl)}" />`;

const asset = async (pathname: string, meta?: PageMeta): Promise<Response> => {
  const clean = pathname === '/' ? '/index.html' : pathname;
  const fullPath = join(STATIC_DIR, clean.replace(/^\/+/, ''));
  if (!fullPath.startsWith(STATIC_DIR) || !existsSync(fullPath)) {
    return new Response('Not found', { status: 404 });
  }
  const type = fullPath.endsWith('.css')
    ? 'text/css; charset=utf-8'
    : fullPath.endsWith('.js')
      ? 'application/javascript; charset=utf-8'
      : fullPath.endsWith('.json')
        ? 'application/manifest+json; charset=utf-8'
        : 'text/html; charset=utf-8';
  if (fullPath.endsWith('.html')) {
    const fallback = defaultPageMeta(`http://${HOST}:${PORT}`);
    const pageMeta = meta || fallback;
    const html = (await Bun.file(fullPath).text())
      .replace(/<title>.*?<\/title>/, `<title>${escapeHtml(pageMeta.title)}</title>`)
      .replace('</head>', `${metaTags(pageMeta)}\n  </head>`);
    return new Response(html, {
      headers: { 'Content-Type': type, 'Cache-Control': 'no-store' },
    });
  }
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

const parseJsonSafe = <T>(raw: string, fallback: T): T => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const categoryForStatement = (statement: string, context?: unknown): { id: string; label: string } => {
  const source = `${statement} ${typeof context === 'object' && context && 'text' in context ? String((context as { text?: unknown }).text || '') : ''}`.toLowerCase();
  if (/\b(ai|model|llm|openrouter|gemma|claude|gpt|inference)\b/.test(source)) return { id: 'ai', label: 'AI' };
  if (/\b(usdc|usdt|stablecoin|xln|escrow|payment|crypto|token|settlement)\b/.test(source)) return { id: 'crypto', label: 'Crypto' };
  if (/\b(linux|windows|sqlite|postgres|developer|engineering|software|security|api)\b/.test(source)) return { id: 'tech', label: 'Tech' };
  if (/\b(remote|office|team|company|product|market|startup|business)\b/.test(source)) return { id: 'business', label: 'Business' };
  if (/\b(governance|dao|vote|policy|politics|regulation)\b/.test(source)) return { id: 'policy', label: 'Policy' };
  return { id: 'culture', label: 'Culture' };
};

const decisionKind = (votes: Record<string, number> | null | undefined): 'unanimous' | 'split' | 'hung' | 'pending' => {
  if (!votes) return 'pending';
  const total = Object.values(votes).reduce((sum, value) => sum + Number(value || 0), 0);
  if (!total) return 'pending';
  if (Number(votes['draw'] || 0) > 0 || Number(votes['invalid'] || 0) > 0) return 'hung';
  const a = Number(votes['A'] || 0);
  const b = Number(votes['B'] || 0);
  if (a === total || b === total) return 'unanimous';
  return 'split';
};

const skillPersonas: Record<string, { label: string; persona: string }> = {
  logic: { label: 'Skeptical Logician', persona: 'Stress-test internal consistency, definitions, contradictions, and direct rebuttals. Reward clear decision rules.' },
  evidence: { label: 'Evidence Auditor', persona: 'Demand concrete support, examples, factual grounding, and source discipline. Penalize unsupported certainty.' },
  product: { label: 'Product Pragmatist', persona: 'Score usefulness, adoption friction, user impact, and operational tradeoffs over abstract elegance.' },
  security: { label: 'Adversarial Reviewer', persona: 'Think in failure modes, incentives, abuse cases, edge conditions, and adversarial pressure.' },
  economics: { label: 'Cost Economist', persona: 'Compare hidden costs, liquidity, coordination overhead, risk transfer, and long-run incentives.' },
  clarity: { label: 'Clarity Editor', persona: 'Reward concise argumentation, readable structure, clean tradeoffs, and non-evasive answers.' },
  philosopher: { label: 'Steelman Philosopher', persona: 'Steelman both sides before judging. Reward durable principles and careful handling of uncertainty.' },
};

const fallbackModelCatalog = [
  { id: 'gemma3-27b-mlx', name: 'Gemma 3 27B MLX', provider: 'local-gemma', backend: 'mlx', available: true },
  { id: 'qwen3-235b-mlx', name: 'Qwen 3 235B MLX', provider: 'local-gemma', backend: 'mlx', available: true },
  { id: 'gpt-oss-heretic-mlx', name: 'GPT-OSS 120B Heretic MLX', provider: 'local-gemma', backend: 'mlx', available: true },
  { id: 'deepseek-v3.2-speciale-mlx', name: 'DeepSeek V3.2 Speciale MLX', provider: 'local-gemma', backend: 'mlx', available: true },
  { id: 'kimi-vl-mlx', name: 'Kimi-VL A3B MLX', provider: 'local-gemma', backend: 'mlx_vision', available: true },
  { id: 'qwen3-coder:latest', name: 'Qwen 3 Coder Ollama', provider: 'local-gemma', backend: 'ollama', available: true },
  { id: 'gpt-oss:120b', name: 'GPT-OSS 120B Ollama', provider: 'local-gemma', backend: 'ollama', available: true },
  { id: 'huihui_ai/qwen3-abliterated:235b', name: 'Qwen 3 235B Abliterated Ollama', provider: 'local-gemma', backend: 'ollama', available: true },
];

const serializeCustomSkill = (skill: CustomSkillRecord) => ({
  id: skill.id,
  value: `custom:${skill.id}`,
  label: skill.label,
  prompt: skill.prompt,
  createdAt: skill.createdAt,
});

const defaultSkillOptions = () => Object.entries(skillPersonas).map(([id, skill]) => ({
  id,
  value: id,
  label: skill.label,
  prompt: skill.persona,
  custom: false,
}));

const skillOptionsForUser = (userId: string) => [
  ...defaultSkillOptions(),
  ...store.listCustomSkills(userId).map(skill => ({ ...serializeCustomSkill(skill), custom: true })),
];

const inlineSkillFromBody = (body: Record<string, unknown>, labelKey: string, promptKey: string) => {
  const label = String(body[labelKey] || '').trim().slice(0, 80);
  const persona = String(body[promptKey] || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2400);
  if (!persona) return null;
  return {
    key: 'custom_inline',
    label: label || 'Custom Skill',
    persona,
  };
};

const resolveSkill = (
  userId: string | null | undefined,
  skillKeyRaw: unknown,
  inline?: { label: string; persona: string } | null,
) => {
  const skillKey = String(skillKeyRaw || '').trim();
  if ((skillKey === 'custom' || skillKey === 'custom_inline') && inline?.persona) return inline;
  if (skillKey.startsWith('custom:') && userId) {
    const skill = store.getCustomSkill(userId, skillKey.slice('custom:'.length));
    if (skill) return { label: skill.label, persona: skill.prompt };
  }
  return skillPersonas[skillKey] || skillPersonas['logic']!;
};

const modelFromBody = (body: Record<string, unknown>, key: string, fallback = DEFAULT_AI_MODEL): string => {
  const selected = String(body[key] || '').trim();
  const custom = String(body[`${key}Custom`] || '').trim();
  const value = selected === 'custom' ? custom : selected || custom || fallback;
  return value.slice(0, 160) || fallback;
};

const providerFromBody = (value: unknown): JudgeConfig['provider'] => {
  const raw = String(value || '').trim();
  if (raw === 'placeholder' || raw === 'local-gemma' || raw === 'local-council' || raw === 'openrouter') return raw;
  return 'local-gemma';
};

const buildJudgeBoardFromBody = (body: Record<string, unknown>, fallbackBoardId = 'classic3', userId?: string | null): JudgeConfig[] => {
  const requestedSize = Math.max(0, Math.min(7, Math.floor(Number(body['councilSize'] || 0))));
  const judges: JudgeConfig[] = [];
  for (let index = 1; index <= requestedSize; index += 1) {
    const model = modelFromBody(body, `councilModel${index}`, DEFAULT_AI_MODEL);
    if (!model) continue;
    const skillKey = String(body[`councilSkill${index}`] || 'logic').trim();
    const inline = inlineSkillFromBody(body, `councilCustomSkillLabel${index}`, `councilCustomSkillPrompt${index}`);
    const skill = resolveSkill(userId, skillKey, inline);
    judges.push({
      id: `council_${index}_${skillKey.replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'judge'}`,
      label: `${skill.label} ${index}`,
      provider: providerFromBody(body[`councilProvider${index}`]),
      model: model.slice(0, 120),
      weight: 1,
      persona: skill.persona,
    });
  }
  if (judges.length) return judges;
  return defaultJudgeBoards[fallbackBoardId] || defaultJudgeBoards['classic3']!;
};

const debaterPersonaForSkill = (
  skillKey: unknown,
  side: DebateSide,
  userId?: string | null,
  inline?: { label: string; persona: string } | null,
): string => {
  const fallback = side === 'A' ? skillPersonas['product']! : skillPersonas['security']!;
  const skill = resolveSkill(userId, String(skillKey || '').trim() || (side === 'A' ? 'product' : 'security'), inline) || fallback;
  const stance = side === 'A'
    ? 'Build the affirmative case and force a clear decision rule.'
    : 'Attack hidden assumptions and offer the judge board a better alternative rule.';
  return `${skill.persona} ${stance} Be direct, specific, adversarial, and never mention the prompt.`;
};

const verdictSnapshot = (challenge: ChallengeRecord) => {
  const verdict = store.getVerdict(challenge.id);
  if (!verdict) return null;
  const payout = parseJsonSafe<Record<string, unknown>>(verdict.payout_json, {});
  const votes = parseJsonSafe<Record<string, number>>(verdict.votes_json, {});
  const scores1000 = payout['scores1000'] && typeof payout['scores1000'] === 'object'
    ? payout['scores1000'] as { A?: number; B?: number }
    : {};
  const aligned = alignScoresWithWinner(verdict.winner as AggregatedVerdict['winner'], scores1000);
  const voteTotal = Object.values(votes).reduce((sum, value) => sum + Number(value || 0), 0);
  const summary = verdict.winner === 'draw'
    ? `The judge board found the debate too close to award a single winner: ${aligned.A}-${aligned.B}.`
    : `Side ${verdict.winner} wins ${aligned.A}-${aligned.B} by a ${aligned.margin}-point margin and ${votes[verdict.winner] || 0} of ${voteTotal || 0} judge votes.`;
  return {
    winner: verdict.winner,
    method: verdict.method,
    votes,
    confidence: verdict.confidence,
    scores1000: {
      A: aligned.A,
      B: aligned.B,
    },
    margin: aligned.margin,
    summary,
    decisionKind: decisionKind(votes),
    decisiveMoment: primaryDecisiveMoment(challenge.id, verdict.winner),
    createdAt: verdict.created_at,
  };
};

const serializeChallengeSummary = (challenge: ChallengeRecord) => {
  const context = parseJsonSafe<Record<string, unknown>>(challenge.contextJson, {});
  const verdict = verdictSnapshot(challenge);
  const category = categoryForStatement(challenge.statement, context);
  return {
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
    category,
    sideAModel: typeof context['sideAModel'] === 'string' ? context['sideAModel'] : null,
    sideBModel: typeof context['sideBModel'] === 'string' ? context['sideBModel'] : null,
    mode: typeof context['mode'] === 'string' ? context['mode'] : 'human_court',
    verdict,
    verdictSummary: verdict
      ? `Side ${verdict.winner} ${verdict.scores1000.A ?? '-'}-${verdict.scores1000.B ?? '-'} (+${verdict.margin ?? '-'})`
      : null,
  };
};

const serializeChallengeDetail = (challenge: ChallengeRecord, session?: SessionRecord) => {
  const messages = store.getMessages(challenge.id);
  const verdict = store.getVerdict(challenge.id);
  const verdictView = verdictSnapshot(challenge);
  const judgeRuns = store.getJudgeRuns(challenge.id);
  const side = session?.userId === challenge.sideAUserId ? 'A' : session?.userId === challenge.sideBUserId ? 'B' : null;
  const expectedSide = challenge.status === 'active'
    ? (messages.length % 2 === 0 ? 'A' : 'B')
    : null;
  const rawPayout = verdict ? parseJsonSafe<Record<string, unknown>>(verdict.payout_json, {}) : {};
  const displayPayout = verdictView
    ? { ...rawPayout, scores1000: verdictView.scores1000, margin: verdictView.margin }
    : rawPayout;
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
      votes: verdictView?.votes || JSON.parse(verdict.votes_json),
      confidence: verdict.confidence,
      payout: displayPayout,
      summary: verdictView?.summary || verdict.summary,
      decisionKind: verdictView?.decisionKind || 'pending',
      decisiveMoment: verdictView?.decisiveMoment || null,
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

const escapeSvg = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  }[char] || char));

const svgLines = (value: unknown, maxChars: number, maxLines: number): string[] => {
  const words = String(value ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
    if (lines.length === maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines.length ? lines : ['AI Court verdict'];
};

const primaryDecisiveMoment = (challengeId: string, winner?: string): string | null => {
  for (const run of store.getJudgeRuns(challengeId)) {
    if (!run.verdict_json) continue;
    try {
      const verdict = JSON.parse(run.verdict_json) as JudgeVerdict;
      const moment = verdict.decisiveMoments?.find(item => !winner || item.side === winner) || verdict.decisiveMoments?.[0];
      if (moment?.summary) return `Round ${moment.round}: ${moment.summary}`;
    } catch {
      continue;
    }
  }
  return null;
};

const judgeIcon = (judgeId: string): string => {
  const id = judgeId.toLowerCase();
  if (id.includes('logic')) return 'OWL';
  if (id.includes('evidence')) return 'LENS';
  if (id.includes('clarity')) return 'PRISM';
  if (id.includes('security')) return 'SHIELD';
  if (id.includes('systems')) return 'TEMPLE';
  if (id.includes('product')) return 'TARGET';
  if (id.includes('cost')) return 'COIN';
  if (id.includes('chair')) return 'SCALES';
  return 'JUDGE';
};

const judgeVoteLine = (challengeId: string): string => {
  const parts = store.getJudgeRuns(challengeId).map(run => {
    if (!run.verdict_json) return '';
    const verdict = parseJsonSafe<JudgeVerdict | null>(run.verdict_json, null);
    if (!verdict) return '';
    return `${judgeIcon(run.judge_id)} ${verdict.winner}`;
  }).filter(Boolean);
  return parts.length ? parts.join('   ') : 'JUDGE BOARD PENDING';
};

const buildVerdictCardSvg = (challenge: ChallengeRecord): string => {
  const verdict = store.getVerdict(challenge.id);
  const payout = verdict ? JSON.parse(verdict.payout_json) : {};
  const votes = verdict ? parseJsonSafe<Record<string, number>>(verdict.votes_json, {}) : null;
  const scores = payout.scores1000 || {};
  const margin = payout.margin ?? '-';
  const winner = verdict?.winner ? `Side ${verdict.winner}` : 'Pending';
  const kind = decisionKind(votes);
  const title = svgLines(challenge.statement, 44, 3);
  const summary = svgLines(verdict?.summary || 'Challenge accepted. Judges score each side out of 1000 and settle through XLN escrow.', 68, 2);
  const decisive = svgLines(primaryDecisiveMoment(challenge.id, verdict?.winner) || 'Every vote includes criteria, decisive moments, transcript hashes, and an XLN receipt trail.', 74, 1)[0]!;
  const voteLine = judgeVoteLine(challenge.id);
  const scoreA = scores.A ?? '-';
  const scoreB = scores.B ?? '-';
  const token = getToken(challenge.tokenId).symbol;
  const scoreLine = verdict ? `${scoreA} - ${scoreB}` : `${challenge.stakeMinor > 0n ? formatTokenAmount(challenge.tokenId, challenge.stakeMinor) : '0'} ${token}`;
  const path = `/v/${challenge.slug}`;
  const titleSpans = title.map((line, index) =>
    `<tspan x="72" y="${146 + index * 54}">${escapeSvg(line)}</tspan>`).join('');
  const summarySpans = summary.map((line, index) =>
    `<tspan x="72" y="${430 + index * 30}">${escapeSvg(line)}</tspan>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${escapeSvg(challenge.statement)} verdict card">
  <defs>
    <linearGradient id="rail" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#0052ff"/>
      <stop offset="52%" stop-color="#635bff"/>
      <stop offset="100%" stop-color="#0aa66b"/>
    </linearGradient>
    <linearGradient id="soft" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#f4f8ff"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="24" stdDeviation="28" flood-color="#0b1f33" flood-opacity="0.16"/>
    </filter>
  </defs>
  <rect width="1200" height="630" fill="#f6f9fc"/>
  <rect x="34" y="34" width="1132" height="562" rx="8" fill="url(#soft)" stroke="#d8e1ed"/>
  <rect x="34" y="34" width="1132" height="12" rx="6" fill="url(#rail)"/>
  <g transform="translate(72 78)">
    <rect width="44" height="44" rx="8" fill="#0052ff"/>
    <text x="22" y="29" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="19" font-weight="800" fill="#fff">X</text>
    <text x="62" y="18" font-family="Inter, Arial, sans-serif" font-size="16" font-weight="800" fill="#0b1f33">XLN Debates</text>
    <text x="62" y="39" font-family="Inter, Arial, sans-serif" font-size="13" fill="#66758a">AI court settled by escrow receipts</text>
  </g>
  <text x="1128" y="104" text-anchor="end" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="900" fill="${kind === 'unanimous' ? '#b7791f' : kind === 'split' ? '#475569' : '#64748b'}">${escapeSvg(kind.toUpperCase())}</text>
  <text font-family="Inter, Arial, sans-serif" font-size="44" font-weight="760" letter-spacing="-0.3" fill="#0b1f33">${titleSpans}</text>
  <g filter="url(#shadow)">
    <rect x="72" y="306" width="322" height="92" rx="8" fill="#ffffff" stroke="#dce5f0"/>
    <text x="96" y="342" font-family="Inter, Arial, sans-serif" font-size="13" font-weight="800" fill="#66758a">WINNER</text>
    <text x="96" y="378" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="820" fill="${verdict?.winner === 'B' ? '#ef4444' : '#3b82f6'}">${escapeSvg(winner)}</text>
    <rect x="426" y="306" width="322" height="92" rx="8" fill="#ffffff" stroke="#dce5f0"/>
    <text x="450" y="342" font-family="Inter, Arial, sans-serif" font-size="13" font-weight="800" fill="#66758a">COURT SCORE</text>
    <text x="450" y="378" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="820" fill="#0b1f33">${escapeSvg(scoreLine)}</text>
    <rect x="780" y="306" width="322" height="92" rx="8" fill="#ffffff" stroke="#dce5f0"/>
    <text x="804" y="342" font-family="Inter, Arial, sans-serif" font-size="13" font-weight="800" fill="#66758a">MARGIN</text>
    <text x="804" y="378" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="820" fill="#05a66b">+${escapeSvg(margin)}</text>
  </g>
  <text x="72" y="418" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="800" fill="#475569">${escapeSvg(voteLine)}</text>
  <text font-family="Inter, Arial, sans-serif" font-size="22" fill="#273951">${summarySpans}</text>
  <text x="72" y="500" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="700" fill="#0052ff">Decisive: ${escapeSvg(decisive)}</text>
  <line x1="72" y1="520" x2="1128" y2="520" stroke="#dce5f0"/>
  <text x="72" y="558" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="760" fill="#0b1f33">${escapeSvg(path)}</text>
  <text x="1128" y="558" text-anchor="end" font-family="Inter, Arial, sans-serif" font-size="16" fill="#66758a">${challenge.judgeBoardJson ? `${JSON.parse(challenge.judgeBoardJson).length} AI judges` : 'AI judges'} · ${escapeSvg(formatTokenAmount(challenge.tokenId, challenge.stakeMinor))} ${escapeSvg(token)} stake</text>
</svg>`;
};

const buildArenaCardSvg = (): string => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#f6f9fc"/>
  <rect x="34" y="34" width="1132" height="562" rx="8" fill="#ffffff" stroke="#d8e1ed"/>
  <rect x="34" y="34" width="1132" height="12" rx="6" fill="#0052ff"/>
  <rect x="72" y="82" width="52" height="52" rx="8" fill="#0052ff"/>
  <text x="98" y="116" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="800" fill="#fff">X</text>
  <text x="72" y="210" font-family="Inter, Arial, sans-serif" font-size="58" font-weight="820" fill="#0b1f33">XLN Debates</text>
  <text x="72" y="270" font-family="Inter, Arial, sans-serif" font-size="30" fill="#273951">AI-judged challenge arena settled through XLN escrow.</text>
  <text x="72" y="360" font-family="Inter, Arial, sans-serif" font-size="26" font-weight="760" fill="#0052ff">1000-point verdicts · public receipts · share-ready cards</text>
  <text x="72" y="558" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="760" fill="#0b1f33">debates.xln.finance</text>
</svg>`;

const challengePageMeta = (challenge: ChallengeRecord, origin: string): PageMeta => {
  const verdict = store.getVerdict(challenge.id);
  const payout = verdict ? JSON.parse(verdict.payout_json) : {};
  const title = verdict
    ? `Side ${verdict.winner} wins ${payout.scores1000?.A ?? '-'}-${payout.scores1000?.B ?? '-'} | XLN Debates`
    : `${challenge.statement} | XLN Debates`;
  const description = verdict?.summary || `${challenge.sideALabel} vs ${challenge.sideBLabel}. Judges score the debate out of 1000 on XLN Debates.`;
  return {
    title,
    description,
    url: `${origin}/v/${challenge.slug}`,
    imageUrl: `${origin}/api/challenges/${challenge.slug}/card.svg`,
  };
};

const buildEmbedHtml = (challenge: ChallengeRecord, origin: string): string => {
  const summary = serializeChallengeSummary(challenge);
  const verdict = summary.verdict;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(summary.statement)} | XLN Debates Embed</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; background: #080b12; color: #f8fafc; }
      a { color: inherit; text-decoration: none; }
      .card { display: grid; gap: 18px; min-height: 100vh; padding: 22px; border: 1px solid #1f2937; background: linear-gradient(135deg, #111827, #090d16); }
      .top { display: flex; justify-content: space-between; gap: 12px; align-items: center; color: #94a3b8; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; }
      h1 { margin: 0; font-size: clamp(26px, 6vw, 48px); line-height: 1.02; letter-spacing: 0; }
      .score { display: grid; grid-template-columns: 1fr auto 1fr; gap: 14px; align-items: center; }
      .side { border: 1px solid #243047; padding: 14px; background: rgba(255,255,255,.04); }
      .side span { display:block; color:#94a3b8; font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
      .side strong { display:block; margin-top:8px; font-size:34px; }
      .a strong { color:#3b82f6; } .b strong { color:#ef4444; }
      .margin { color:#f8fafc; font-size:28px; font-weight:900; }
      .verdict { color:#facc15; font-weight:900; }
      .quote { color:#cbd5e1; line-height:1.45; border-left:3px solid #3b82f6; padding-left:12px; }
      .receipt { color:#94a3b8; font-size:12px; display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; }
    </style>
  </head>
  <body>
    <a class="card" href="${escapeHtml(`${origin}/v/${challenge.slug}`)}" target="_blank" rel="noreferrer">
      <div class="top"><span>XLN Debates</span><span>${escapeHtml(summary.category.label)} · ${escapeHtml(verdict?.decisionKind || 'pending')}</span></div>
      <h1>${escapeHtml(summary.statement)}</h1>
      <div class="score">
        <div class="side a"><span>Side A</span><strong>${escapeHtml(verdict?.scores1000.A ?? '-')}</strong></div>
        <div class="margin">+${escapeHtml(verdict?.margin ?? '-')}</div>
        <div class="side b"><span>Side B</span><strong>${escapeHtml(verdict?.scores1000.B ?? '-')}</strong></div>
      </div>
      <div class="verdict">${verdict ? `Winner: Side ${escapeHtml(verdict.winner)}` : 'Pending verdict'}</div>
      <div class="quote">${escapeHtml(verdict?.decisiveMoment || 'Judges publish decisive moments, criteria, and transcript hashes.')}</div>
      <div class="receipt"><span>${escapeHtml(summary.stakeDisplay)} ${escapeHtml(summary.tokenSymbol)} · settled via XLN</span><span>open full verdict</span></div>
    </a>
  </body>
</html>`;
};

const challengeEvents = (slug: string): Response => {
  let timer: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const send = () => {
        const challenge = store.getChallengeBySlug(slug);
        if (!challenge) {
          controller.enqueue(`event: error\ndata: ${JSON.stringify({ error: 'Challenge not found' })}\n\n`);
          controller.close();
          if (timer) clearInterval(timer);
          return;
        }
        controller.enqueue(`data: ${JSON.stringify({
          slug,
          status: challenge.status,
          messageCount: store.getMessages(challenge.id).length,
          finalizedAt: challenge.finalizedAt,
          updatedAt: Date.now(),
        })}\n\n`);
      };
      send();
      timer = setInterval(send, 2000);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    },
  });
};

const buildModelLeaderboard = () => {
  const rows = new Map<string, { model: string; wins: number; losses: number; draws: number; pointsFor: number; pointsAgainst: number }>();
  const ensure = (model: string) => {
    const key = model || 'unknown-model';
    if (!rows.has(key)) rows.set(key, { model: key, wins: 0, losses: 0, draws: 0, pointsFor: 0, pointsAgainst: 0 });
    return rows.get(key)!;
  };
  for (const challenge of store.listPublicChallenges(200)) {
    if (challenge.status !== 'finalized') continue;
    const context = parseJsonSafe<Record<string, unknown>>(challenge.contextJson, {});
    if (context['mode'] !== 'ai_gladiator') continue;
    const verdict = verdictSnapshot(challenge);
    if (!verdict) continue;
    const sideAModel = String(context['sideAModel'] || 'Side A model');
    const sideBModel = String(context['sideBModel'] || 'Side B model');
    const a = ensure(sideAModel);
    const b = ensure(sideBModel);
    const scoreA = Number(verdict.scores1000.A || 0);
    const scoreB = Number(verdict.scores1000.B || 0);
    a.pointsFor += scoreA;
    a.pointsAgainst += scoreB;
    b.pointsFor += scoreB;
    b.pointsAgainst += scoreA;
    if (verdict.winner === 'A') {
      a.wins += 1;
      b.losses += 1;
    } else if (verdict.winner === 'B') {
      b.wins += 1;
      a.losses += 1;
    } else {
      a.draws += 1;
      b.draws += 1;
    }
  }
  return Array.from(rows.values())
    .map(row => ({
      ...row,
      matches: row.wins + row.losses + row.draws,
      elo: 1000 + row.wins * 32 - row.losses * 24 + Math.round((row.pointsFor - row.pointsAgainst) / 20),
      pointDiff: row.pointsFor - row.pointsAgainst,
    }))
    .sort((a, b) => b.elo - a.elo || b.wins - a.wins)
    .slice(0, 8);
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
    modelCatalog: fallbackModelCatalog,
    skillOptions: skillOptionsForUser(session.userId),
    publicChallenges,
    myChallenges,
    modelLeaderboard: buildModelLeaderboard(),
  };
};

const validateChallengeInput = (body: Record<string, unknown>, userId: string) => {
  const statement = String(body['statement'] || '').trim();
  if (statement.length < 8) throw new Error('Statement is too short');
  const tokenId = Number(body['tokenId'] || 1);
  const stakeMinor = parseTokenAmount(tokenId, String(body['stake'] || '0'));
  const roundsTotal = Math.max(1, Math.min(10, Math.floor(Number(body['roundsTotal'] || 3))));
  const messageLimitChars = Math.max(200, Math.min(8000, Math.floor(Number(body['messageLimitChars'] || 1200))));
  const boardId = String(body['boardId'] || 'classic3');
  const judgeBoard = buildJudgeBoardFromBody(body, boardId, userId);
  const sideAPayoutEntityId = normalizeEntityId(body['sideAPayoutEntityId']);
  if (sideAPayoutEntityId && !validEntityId(sideAPayoutEntityId)) throw new Error('Side A payout entity must be a 32-byte hex XLN entity id');
  if (sideAPayoutEntityId) store.updateUserEntity(userId, sideAPayoutEntityId);
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
      mode: 'human_court',
      councilSize: judgeBoard.length,
      payoutTargets: {
        ...(sideAPayoutEntityId ? { A: sideAPayoutEntityId } : {}),
      },
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

const normalizeEntityId = (value: unknown): string => String(value || '').trim().toLowerCase();
const validEntityId = (value: string): boolean => /^0x[0-9a-f]{64}$/i.test(value);

const submitWithdrawalForUser = async (input: {
  userId: string;
  tokenId: number;
  amountMinor: bigint;
  targetEntityId: string;
  reason: string;
}): Promise<WithdrawalRecord> => {
  if (input.amountMinor <= 0n) throw new Error('Amount must be positive');
  const targetEntityId = normalizeEntityId(input.targetEntityId);
  if (!validEntityId(targetEntityId)) throw new Error('Target entity must be a 32-byte hex XLN entity id');

  if (daemon) {
    const routeQuote = await daemon.findRoutes({
      sourceEntityId: SERVICE_ENTITY_ID,
      targetEntityId,
      tokenId: input.tokenId,
      amount: input.amountMinor.toString(),
    });
    const selectedRoute = routeQuote.routes[0];
    if (!selectedRoute) throw new Error(`No XLN route found from ${SERVICE_ENTITY_ID} to ${targetEntityId}`);
    const senderAmountMinor = BigInt(selectedRoute.senderAmount);
    const feeMinor = BigInt(selectedRoute.totalFee);
    const withdrawalId = `wd_${compactUuid().slice(0, 20)}`;
    const startedAtMs = Date.now();
    const description = `${input.reason}:${withdrawalId} requested:${input.amountMinor.toString()} fee:${feeMinor.toString()}`;
    let withdrawal = store.reserveWithdrawal({
      id: withdrawalId,
      userId: input.userId,
      tokenId: input.tokenId,
      amountMinor: senderAmountMinor,
      requestedAmountMinor: input.amountMinor,
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
        tokenId: input.tokenId,
        amount: input.amountMinor.toString(),
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
      return withdrawal;
    } catch (error) {
      store.failWithdrawalById({
        id: withdrawalId,
        error: error instanceof Error ? error.message : String(error),
        updatedAt: Date.now(),
        restoreBalance: true,
      });
      throw error;
    }
  }

  return store.createWithdrawal({
    userId: input.userId,
    tokenId: input.tokenId,
    amountMinor: input.amountMinor,
    targetEntityId,
    offlineFinalized: true,
  });
};

const autoPayoutWinner = async (challenge: ChallengeRecord): Promise<WithdrawalRecord | null> => {
  const verdict = store.getVerdict(challenge.id);
  if (!verdict) return null;
  const payout = parseJsonSafe<Record<string, unknown>>(verdict.payout_json, {});
  const existing = payout['autoPayout'] && typeof payout['autoPayout'] === 'object'
    ? payout['autoPayout'] as Record<string, unknown>
    : null;
  if (existing && ['submitting', 'sent', 'finalized'].includes(String(existing['status'] || ''))) return null;

  const winner = String(payout['winner'] || verdict.winner);
  if (winner !== 'A' && winner !== 'B') return null;
  const winnerUserId = String(payout['winnerUserId'] || '');
  const winnerAmountMinor = BigInt(String(payout['winnerAmountMinor'] || '0'));
  if (!winnerUserId || winnerAmountMinor <= 0n) return null;

  const context = parseJsonSafe<Record<string, unknown>>(challenge.contextJson, {});
  const payoutTargets = context['payoutTargets'] && typeof context['payoutTargets'] === 'object'
    ? context['payoutTargets'] as Record<string, unknown>
    : {};
  const winnerUser = store.getUser(winnerUserId);
  const targetEntityId = normalizeEntityId(payoutTargets[winner] || winnerUser?.entityId || '');

  if (!targetEntityId) {
    store.updateVerdictPayoutJson(challenge.id, {
      ...payout,
      autoPayout: {
        status: 'not_configured',
        reason: `Side ${winner} has no XLN payout entity`,
      },
    });
    return null;
  }

  try {
    const withdrawal = await submitWithdrawalForUser({
      userId: winnerUserId,
      tokenId: challenge.tokenId,
      amountMinor: winnerAmountMinor,
      targetEntityId,
      reason: `debates-auto-payout:${challenge.id}`,
    });
    store.updateVerdictPayoutJson(challenge.id, {
      ...payout,
      autoPayout: {
        status: withdrawal.status,
        withdrawalId: withdrawal.id,
        targetEntityId,
        amountMinor: withdrawal.requestedAmountMinor.toString(),
        hashlock: withdrawal.hashlock,
        finalizedAt: withdrawal.finalizedAt,
      },
    });
    return withdrawal;
  } catch (error) {
    store.updateVerdictPayoutJson(challenge.id, {
      ...payout,
      autoPayout: {
        status: 'failed',
        targetEntityId,
        amountMinor: winnerAmountMinor.toString(),
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return null;
  }
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
  const finalized = store.getChallengeBySlug(current.slug)!;
  await autoPayoutWinner(finalized);
  return store.getChallengeBySlug(current.slug)!;
};

const scoreChallengeTranscript = async (challenge: ChallengeRecord) => {
  const messages = store.getMessages(challenge.id);
  if (messages.length < 2) throw new Error('At least one complete round is required for live council scoring');
  const judgeBoard = JSON.parse(challenge.judgeBoardJson) as JudgeConfig[];
  const input = {
    challengeId: challenge.id,
    statement: challenge.statement,
    sideALabel: challenge.sideALabel,
    sideBLabel: challenge.sideBLabel,
    rules: JSON.parse(challenge.rulesJson),
    context: JSON.parse(challenge.contextJson),
    transcript: messages.map(message => ({
      roundNumber: message.roundNumber,
      side: message.side,
      body: message.body,
    })),
  };
  const results = await judgeDebate(input, judgeBoard);
  const aggregate = aggregateVerdicts(results.map(result => result.verdict));
  return {
    roundNumber: Math.max(...messages.map(message => message.roundNumber)),
    messageCount: messages.length,
    aggregate,
    judges: results.map(result => ({
      judgeId: result.judge.id,
      label: result.judge.label,
      provider: result.judge.provider,
      model: result.judge.model,
      verdict: result.verdict,
    })),
  };
};

const draftDebateTurn = async (challenge: ChallengeRecord, body: Record<string, unknown>, userId?: string | null): Promise<{ side: DebateSide; draft: string }> => {
  const messages = store.getMessages(challenge.id);
  if (challenge.status !== 'active') throw new Error('Challenge is not accepting filings');
  const side: DebateSide = messages.length % 2 === 0 ? 'A' : 'B';
  const model = modelFromBody(body, 'draftModel', DEFAULT_AI_MODEL);
  const skill = String(body['draftSkill'] || (side === 'A' ? 'product' : 'security'));
  const inline = inlineSkillFromBody(body, 'draftCustomSkillLabel', 'draftCustomSkillPrompt');
  const draft = await generateDebateTurn({
    statement: challenge.statement,
    side,
    sideALabel: challenge.sideALabel,
    sideBLabel: challenge.sideBLabel,
    roundNumber: Math.floor(messages.length / 2) + 1,
    roundsTotal: challenge.roundsTotal,
    context: JSON.parse(challenge.contextJson),
    transcript: messages.map(message => ({
      roundNumber: message.roundNumber,
      side: message.side,
      body: message.body,
    })),
    messageLimitChars: challenge.messageLimitChars,
    persona: debaterPersonaForSkill(skill, side, userId, inline),
    model,
    provider: providerFromBody(body['draftProvider'] || 'local-gemma'),
  });
  return { side, draft };
};

const gladiatorTopics = [
  'Local open-source AI will beat closed frontier APIs for most enterprise workflows.',
  'Stablecoin payment channels are a better consumer payment rail than card networks.',
  'SQLite is a better default database than Postgres for early-stage products.',
  'Remote-first engineering teams outperform office-first teams for senior product work.',
  'AI agents should be allowed to negotiate and settle small claims without human lawyers.',
  'Linux is better than Windows for professional developers.',
];

const pickGladiatorTopic = (): string =>
  gladiatorTopics[Math.floor(Math.random() * gladiatorTopics.length)] || gladiatorTopics[0]!;

const normalizeGladiatorStatement = (body: Record<string, unknown>): string => {
  const statement = String(body['statement'] || body['topic'] || '').trim();
  return (statement || pickGladiatorTopic()).slice(0, 240);
};

const runGladiatorMatch = async (body: Record<string, unknown>, userId?: string | null): Promise<ChallengeRecord> => {
  const statement = normalizeGladiatorStatement(body);
  const roundsTotal = Math.max(1, Math.min(5, Math.floor(Number(body['roundsTotal'] || 2))));
  const messageLimitChars = Math.max(600, Math.min(2200, Math.floor(Number(body['messageLimitChars'] || 1400))));
  const boardId = String(body['boardId'] || 'classic3');
  const judgeBoard = buildJudgeBoardFromBody(body, boardId, userId);
  const sideAModel = modelFromBody(body, 'sideAModel', DEFAULT_AI_MODEL);
  const sideBModel = modelFromBody(body, 'sideBModel', DEFAULT_AI_MODEL);
  const sideASkill = String(body['sideASkill'] || 'product');
  const sideBSkill = String(body['sideBSkill'] || 'security');
  const sideALabel = String(body['sideALabel'] || 'Frontier Optimist').trim().slice(0, 80) || 'Frontier Optimist';
  const sideBLabel = String(body['sideBLabel'] || 'Systems Skeptic').trim().slice(0, 80) || 'Systems Skeptic';
  const sideA = store.createDemoUser(`AI Gladiator A ${compactUuid().slice(0, 4)}`);
  const sideB = store.createDemoUser(`AI Gladiator B ${compactUuid().slice(0, 4)}`);
  const challenge = store.createChallenge({
    userId: sideA.id,
    statement,
    sideALabel,
    sideBLabel,
    visibility: 'public',
    tokenId: 1,
    stakeMinor: 0n,
    roundsTotal,
    messageLimitChars,
    context: {
      text: String(body['contextText'] || `Exhibition match generated by AI Gladiator Mode. Side A model: ${sideAModel}. Side B model: ${sideBModel}. Judges should score the transcript only.`).slice(0, 24_000),
      mode: 'ai_gladiator',
      sideAModel,
      sideBModel,
      sideASkill,
      sideBSkill,
      councilSize: judgeBoard.length,
    },
    rules: {
      template: 'AI Gladiator Exhibition',
      custom: 'Two AI debaters argue alternating rounds. No real-money stake. Judges score out of 1000 and publish a share-ready verdict card.',
      criteria: ['logic', 'evidence', 'directness', 'rebuttal', 'clarity', 'rule_compliance'],
    },
    judgeBoard,
  });
  const accepted = store.acceptChallenge(challenge.slug, sideB.id);
  const transcript: DebateMessageForJudge[] = [];
  let timestamp = Date.now();
  for (let roundNumber = 1; roundNumber <= roundsTotal; roundNumber += 1) {
    for (const side of ['A', 'B'] as DebateSide[]) {
      const sideUserId = side === 'A' ? sideA.id : sideB.id;
      const model = side === 'A' ? sideAModel : sideBModel;
      const inline = side === 'A'
        ? inlineSkillFromBody(body, 'sideACustomSkillLabel', 'sideACustomSkillPrompt')
        : inlineSkillFromBody(body, 'sideBCustomSkillLabel', 'sideBCustomSkillPrompt');
      const persona = debaterPersonaForSkill(side === 'A' ? sideASkill : sideBSkill, side, userId, inline);
      const turn = await generateDebateTurn({
        statement,
        side,
        sideALabel,
        sideBLabel,
        roundNumber,
        roundsTotal,
        context: JSON.parse(accepted.contextJson),
        transcript,
        messageLimitChars,
        persona,
        model,
        provider: 'local-gemma',
      });
      store.addDemoMessage(accepted.id, sideUserId, roundNumber, side, turn, timestamp += 1000);
      transcript.push({ roundNumber, side, body: turn });
    }
  }
  store.markReadyForJudging(accepted.id);
  return await runJudgePipeline(store.getChallengeBySlug(accepted.slug)!);
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

      if (pathname === '/api/wallet' && req.method === 'POST') {
        const { session, setCookie } = ensureSession(req);
        const body = await readJson<Record<string, unknown>>(req);
        const entityId = normalizeEntityId(body['entityId']);
        if (entityId && !validEntityId(entityId)) throw new Error('Entity must be a 32-byte hex XLN entity id');
        const user = store.updateUserEntity(session.userId, entityId || null);
        return json({ ok: true, user, dashboard: buildDashboard(session) }, undefined, setCookie);
      }

      if (pathname === '/api/skills' && req.method === 'POST') {
        const { session, setCookie } = ensureSession(req);
        const body = await readJson<Record<string, unknown>>(req);
        const label = String(body['label'] || '').trim().slice(0, 80);
        const prompt = String(body['prompt'] || '')
          .replace(/[\u0000-\u001f\u007f]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 2400);
        if (label.length < 2) throw new Error('Skill name is too short');
        if (prompt.length < 20) throw new Error('Skill prompt is too short');
        const skill = store.createCustomSkill({ userId: session.userId, label, prompt });
        return json({ ok: true, skill: serializeCustomSkill(skill), dashboard: buildDashboard(session) }, undefined, setCookie);
      }

      if (pathname === '/api/skills' && req.method === 'GET') {
        const { session, setCookie } = ensureSession(req, false);
        return json({ ok: true, skills: skillOptionsForUser(session.userId) }, undefined, setCookie);
      }

      if (pathname === '/api/ai/models' && req.method === 'GET') {
        try {
          const response = await fetch(`${String(process.env['DEBATES_AI_SERVER_URL'] || 'http://127.0.0.1:3031').replace(/\/+$/, '')}/api/models`, {
            signal: AbortSignal.timeout(1800),
          });
          if (!response.ok) throw new Error(`AI model registry returned ${response.status}`);
          const data = await response.json() as { models?: Array<Record<string, unknown>> };
          const liveModels = Array.isArray(data.models)
            ? data.models.map(model => ({
                id: String(model['id'] || ''),
                name: String(model['name'] || model['id'] || ''),
                provider: 'local-gemma',
                backend: String(model['backend'] || 'local'),
                available: Boolean(model['available'] ?? true),
                loaded: Boolean(model['loaded']),
                params: model['params'] ? String(model['params']) : '',
                vision: Boolean(model['vision']),
              })).filter(model => model.id)
            : [];
          return json({ ok: true, models: liveModels.length ? liveModels : fallbackModelCatalog, source: 'live' });
        } catch (error) {
          return json({
            ok: true,
            models: fallbackModelCatalog,
            source: 'fallback',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (pathname === '/api/gladiator' && req.method === 'POST') {
        const { session, setCookie } = ensureSession(req);
        const body = await readJson<Record<string, unknown>>(req);
        const challenge = await runGladiatorMatch(body, session.userId);
        return json({ ok: true, challenge: serializeChallengeDetail(challenge, session), dashboard: buildDashboard(session) }, undefined, setCookie);
      }

      if (pathname === '/api/daily-match' && req.method === 'POST') {
        const { session, setCookie } = ensureSession(req);
        const challenge = await runGladiatorMatch({ statement: pickGladiatorTopic(), roundsTotal: 2 });
        return json({ ok: true, challenge: serializeChallengeDetail(challenge, session), dashboard: buildDashboard(session) }, undefined, setCookie);
      }

      if (pathname === '/api/settle-url' && req.method === 'POST') {
        const { session, setCookie } = ensureSession(req);
        const body = await readJson<Record<string, unknown>>(req);
        const sourceUrl = String(body['url'] || '').trim();
        if (!/^https?:\/\//i.test(sourceUrl)) throw new Error('Paste a public http(s) URL to settle');
        const challenge = await runGladiatorMatch({
          statement: `The central claim in this post withstands adversarial scrutiny: ${sourceUrl}`,
          contextText: `Source URL submitted by visitor: ${sourceUrl}. The AI counsels should debate whether the central claim is robust, useful, and well-supported. Do not assume facts not present in the source URL; argue from general public context if the source cannot be fetched.`,
          sideALabel: 'The claim holds up',
          sideBLabel: 'The claim fails under scrutiny',
          roundsTotal: 2,
        });
        return json({ ok: true, challenge: serializeChallengeDetail(challenge, session), dashboard: buildDashboard(session) }, undefined, setCookie);
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
        const input = validateChallengeInput(body, session.userId);
        const challenge = store.createChallenge({ userId: session.userId, ...input });
        return json({ ok: true, challenge: serializeChallengeDetail(challenge, session), dashboard: buildDashboard(session) }, undefined, setCookie);
      }

      const cardMatch = pathname.match(/^\/api\/challenges\/([^/]+)\/card\.svg$/);
      if (cardMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        const slug = decodeURIComponent(cardMatch[1]!);
        const challenge = store.getChallengeBySlug(slug);
        if (!challenge) return new Response('Challenge not found', { status: 404 });
        return new Response(req.method === 'HEAD' ? null : buildVerdictCardSvg(challenge), {
          headers: {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Cache-Control': DEV_MODE ? 'no-store' : 'public, max-age=300',
          },
        });
      }

      if (pathname === '/api/arena/card.svg' && (req.method === 'GET' || req.method === 'HEAD')) {
        return new Response(req.method === 'HEAD' ? null : buildArenaCardSvg(), {
          headers: {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Cache-Control': DEV_MODE ? 'no-store' : 'public, max-age=300',
          },
        });
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

        if (action === 'events' && req.method === 'GET') {
          return challengeEvents(slug);
        }

        if (action === 'accept' && req.method === 'POST') {
          const body = await readJson<Record<string, unknown>>(req);
          const sideBPayoutEntityId = normalizeEntityId(body['sideBPayoutEntityId'] || body['targetEntityId']);
          if (sideBPayoutEntityId && !validEntityId(sideBPayoutEntityId)) throw new Error('Side B payout entity must be a 32-byte hex XLN entity id');
          const accepted = store.acceptChallenge(slug, session.userId);
          let challengeForResponse = accepted;
          if (sideBPayoutEntityId) {
            store.updateUserEntity(session.userId, sideBPayoutEntityId);
            const context = parseJsonSafe<Record<string, unknown>>(accepted.contextJson, {});
            const payoutTargets = context['payoutTargets'] && typeof context['payoutTargets'] === 'object'
              ? context['payoutTargets'] as Record<string, unknown>
              : {};
            challengeForResponse = store.updateChallengeContext(accepted.id, {
              ...context,
              payoutTargets: {
                ...payoutTargets,
                B: sideBPayoutEntityId,
              },
            });
          }
          return json({ ok: true, challenge: serializeChallengeDetail(challengeForResponse, session), dashboard: buildDashboard(session) }, undefined, setCookie);
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

        if (action === 'round-score' && req.method === 'POST') {
          const score = await scoreChallengeTranscript(challenge);
          return json({ ok: true, score }, undefined, setCookie);
        }

        if (action === 'draft' && req.method === 'POST') {
          const body = await readJson<Record<string, unknown>>(req);
          const draft = await draftDebateTurn(challenge, body, session.userId);
          return json({ ok: true, ...draft }, undefined, setCookie);
        }

        if (action === 'rematch' && req.method === 'POST') {
          const rules = JSON.parse(challenge.rulesJson);
          const context = JSON.parse(challenge.contextJson);
          const judgeBoard = JSON.parse(challenge.judgeBoardJson) as JudgeConfig[];
          const verdict = store.getVerdict(challenge.id);
          const verdictSummary = verdict?.summary || 'No final verdict yet.';
          const text = typeof context?.text === 'string' ? context.text : '';
          const rematch = store.createChallenge({
            userId: session.userId,
            statement: challenge.statement,
            sideALabel: challenge.sideALabel,
            sideBLabel: challenge.sideBLabel,
            visibility: 'public',
            tokenId: challenge.tokenId,
            stakeMinor: 0n,
            roundsTotal: challenge.roundsTotal,
            messageLimitChars: challenge.messageLimitChars,
            rules: {
              ...rules,
              custom: `${String(rules?.custom || '').trim()}\n\nRematch of /v/${challenge.slug}. New judges should evaluate only the new transcript, but the prior verdict is available as context.`.trim(),
            },
            context: {
              ...context,
              text: `${text}\n\nPrior verdict: ${verdictSummary}`.trim(),
              parentChallengeSlug: challenge.slug,
            },
            judgeBoard,
          });
          return json({ ok: true, challenge: serializeChallengeDetail(rematch, session), dashboard: buildDashboard(session) }, undefined, setCookie);
        }

        return json({ ok: false, error: 'Unsupported challenge action' }, { status: 404 }, setCookie);
      }

      if (pathname === '/api/withdraw' && req.method === 'POST') {
        const { session, setCookie } = ensureSession(req);
        const body = await readJson<{ tokenId?: number; amount?: string; targetEntityId?: string }>(req);
        const tokenId = Number(body.tokenId || 1);
        const amountMinor = parseTokenAmount(tokenId, String(body.amount || '0'));
        const targetEntityId = normalizeEntityId(body.targetEntityId);
        const withdrawal = await submitWithdrawalForUser({
          userId: session.userId,
          tokenId,
          amountMinor,
          targetEntityId,
          reason: 'debates-withdrawal',
        });
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

      if (pathname === '/' || pathname === '/app.js' || pathname === '/styles.css' || pathname === '/manifest.json') {
        return await asset(pathname, pathname === '/' ? defaultPageMeta(url.origin) : undefined);
      }

      if (pathname.startsWith('/v/')) {
        const slug = decodeURIComponent(pathname.slice('/v/'.length).split('/')[0] || '');
        const challenge = store.getChallengeBySlug(slug);
        return await asset('/index.html', challenge ? challengePageMeta(challenge, url.origin) : defaultPageMeta(url.origin));
      }

      if (pathname.startsWith('/embed/v/')) {
        const slug = decodeURIComponent(pathname.slice('/embed/v/'.length).split('/')[0] || '');
        const challenge = store.getChallengeBySlug(slug);
        if (!challenge) return new Response('Embed not found', { status: 404 });
        return new Response(buildEmbedHtml(challenge, url.origin), {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': DEV_MODE ? 'no-store' : 'public, max-age=120' },
        });
      }

      if (pathname.startsWith('/c/')) {
        return await asset('/index.html', defaultPageMeta(url.origin));
      }

      return await asset('/index.html', defaultPageMeta(url.origin));
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

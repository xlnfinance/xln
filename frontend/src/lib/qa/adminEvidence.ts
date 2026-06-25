import type { QaArtifact, QaRun, QaShard, QaStoryScreenshot } from './types';

export type QaAdminStoryKey = 'payment' | 'swap' | 'cross-chain-swap' | 'dispute';

type QaAdminStoryDefinition = {
  key: QaAdminStoryKey;
  title: string;
  short: string;
  full: string;
  screenshotGroups: string[];
  keywords: string[];
};

export type QaAdminStoryCard = QaAdminStoryDefinition & {
  screenshot: QaStoryScreenshot | null;
  screenshotIndex: number | null;
  video: QaArtifact | null;
  shard: QaShard | null;
  shardIndex: number | null;
};

export type QaAdminHealthOwner = {
  role: string;
  name: string;
  status: 'online' | 'offline' | 'unknown';
  runtimeId: string | null;
  dbPath: string | null;
  detail: string | null;
};

export type QaAdminStorageTrack = {
  name: string;
  kind: string;
  path: string;
  currentBytes: number;
  deltaBytes1h: number;
  bytesPerHour: number;
  scanMode: string;
  scanTruncated: boolean;
};

export type QaAdminCreditPair = {
  left: string;
  right: string;
  ok: boolean;
  expectedCreditAmount: string;
};

export type QaAdminHealthSnapshot = {
  systemOk: boolean | null;
  coreOk: boolean | null;
  degraded: string[];
  disk: {
    ok: boolean | null;
    freeGiB: number | null;
    usedPct: number | null;
  };
  directLinkCount: number;
  owners: QaAdminHealthOwner[];
  tracked: QaAdminStorageTrack[];
  creditPairs: QaAdminCreditPair[];
};

const MAINNET_USER_STORIES: QaAdminStoryDefinition[] = [
  {
    key: 'payment',
    title: 'Payment',
    short: 'Prepare hub payment',
    full: 'User prepares a payment from an open hub account, with capacity visible before signing.',
    screenshotGroups: ['Payments'],
    keywords: ['payment', 'pay', 'invoice', 'receive'],
  },
  {
    key: 'swap',
    title: 'Swap',
    short: 'Quote and place swap',
    full: 'User selects source token, quote token, route, and sees market-maker depth before order entry.',
    screenshotGroups: ['Swap'],
    keywords: ['swap', 'orderbook', 'quote', 'token picker', 'resting order'],
  },
  {
    key: 'cross-chain-swap',
    title: 'Cross-chain Swap',
    short: 'Route across hubs',
    full: 'User routes liquidity across jurisdictions and checks the target hub path before committing.',
    screenshotGroups: ['Swap'],
    keywords: ['cross-chain', 'cross chain', 'route', 'jurisdiction', 'target hub', 'liquidity path'],
  },
  {
    key: 'dispute',
    title: 'Dispute',
    short: 'Challenge account state',
    full: 'User opens dispute controls, prepares evidence, and verifies challenge lifecycle history.',
    screenshotGroups: ['Disputes'],
    keywords: ['dispute', 'challenge', 'evidence', 'finalized'],
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const asBoolean = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null;

const asRecordArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const isVideoArtifact = (artifact: QaArtifact): boolean =>
  artifact.kind === 'video' || String(artifact.contentType || '').startsWith('video/');

const lowerText = (value: string | null | undefined): string => String(value || '').toLowerCase();

const shardSearchText = (shard: QaShard): string => {
  const scenarioSteps = shard.scenario?.steps
    ?.map(step => `${step.title} ${step.text}`)
    .join(' ') ?? '';
  return [
    shard.handle,
    shard.title,
    shard.description,
    shard.target,
    shard.scenario?.summary10w,
    scenarioSteps,
    ...shard.artifacts.map(artifact => `${artifact.name} ${artifact.relativePath}`),
  ].map(value => String(value || '').toLowerCase()).join(' ');
};

const storySearchText = (story: QaStoryScreenshot): string =>
  [
    story.group,
    story.title,
    story.description,
    story.name,
    story.relativePath,
    ...story.tags,
  ].map(value => String(value || '').toLowerCase()).join(' ');

const scoreText = (text: string, keywords: string[]): number =>
  keywords.reduce((score, keyword) => score + (text.includes(keyword) ? 1 : 0), 0);

const findStoryScreenshot = (
  definition: QaAdminStoryDefinition,
  screenshots: QaStoryScreenshot[],
): { screenshot: QaStoryScreenshot | null; index: number | null } => {
  const best = screenshots
    .map((screenshot, index) => {
      const groupScore = definition.screenshotGroups.includes(screenshot.group) ? 4 : 0;
      const keywordScore = scoreText(storySearchText(screenshot), definition.keywords);
      const platformScore = screenshot.platform === 'desktop' ? 1 : 0;
      return { screenshot, index, score: groupScore + keywordScore + platformScore };
    })
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score)[0];
  return best ? { screenshot: best.screenshot, index: best.index } : { screenshot: null, index: null };
};

const findStoryVideo = (
  definition: QaAdminStoryDefinition,
  run: QaRun | null,
  usedShardIndexes: Set<number>,
): { shard: QaShard | null; shardIndex: number | null; video: QaArtifact | null } => {
  if (!run) return { shard: null, shardIndex: null, video: null };
  const best = run.shards
    .map((shard, shardIndex) => ({
      shard,
      shardIndex,
      video: shard.artifacts.find(isVideoArtifact) ?? null,
      score: usedShardIndexes.has(shardIndex) ? 0 : scoreText(shardSearchText(shard), definition.keywords),
    }))
    .filter((candidate): candidate is { shard: QaShard; shardIndex: number; video: QaArtifact; score: number } =>
      candidate.video !== null && candidate.score > 0)
    .sort((left, right) => right.score - left.score)[0];
  if (best) {
    usedShardIndexes.add(best.shardIndex);
    return { shard: best.shard, shardIndex: best.shardIndex, video: best.video };
  }
  const fallback = run.shards
    .map((shard, shardIndex) => ({ shard, shardIndex, video: shard.artifacts.find(isVideoArtifact) ?? null }))
    .find(candidate => !usedShardIndexes.has(candidate.shardIndex) && candidate.video);
  if (!fallback?.video) return { shard: null, shardIndex: null, video: null };
  usedShardIndexes.add(fallback.shardIndex);
  return { shard: fallback.shard, shardIndex: fallback.shardIndex, video: fallback.video };
};

export const buildAdminStoryCards = (
  run: QaRun | null,
  screenshots: QaStoryScreenshot[],
): QaAdminStoryCard[] => {
  const usedShardIndexes = new Set<number>();
  return MAINNET_USER_STORIES.map(definition => {
    const screenshot = findStoryScreenshot(definition, screenshots);
    const video = findStoryVideo(definition, run, usedShardIndexes);
    return {
      ...definition,
      screenshot: screenshot.screenshot,
      screenshotIndex: screenshot.index,
      shard: video.shard,
      shardIndex: video.shardIndex,
      video: video.video,
    };
  });
};

const normalizeOwner = (input: Record<string, unknown>, fallbackRole: string): QaAdminHealthOwner => {
  const online = asBoolean(input['online']);
  const exitCode = asNumber(input['exitCode']);
  return {
    role: asString(input['role']) ?? fallbackRole,
    name: asString(input['name']) ?? asString(input['role']) ?? fallbackRole,
    status: online === true || exitCode === null ? 'online' : online === false ? 'offline' : 'unknown',
    runtimeId: asString(input['runtimeId']) ?? asString(input['leaseOwnerId']),
    dbPath: asString(input['dbPath']),
    detail: asString(input['lastErrorLine']) ?? (asNumber(input['apiPort']) ? `api:${asNumber(input['apiPort'])}` : null),
  };
};

const normalizeTracked = (input: Record<string, unknown>): QaAdminStorageTrack | null => {
  const name = asString(input['name']);
  const path = asString(input['path']);
  if (!name || !path) return null;
  return {
    name,
    kind: asString(input['kind']) ?? 'unknown',
    path,
    currentBytes: asNumber(input['currentBytes']) ?? 0,
    deltaBytes1h: asNumber(input['deltaBytes1h']) ?? 0,
    bytesPerHour: asNumber(input['bytesPerHour']) ?? 0,
    scanMode: asString(input['scanMode']) ?? 'unknown',
    scanTruncated: asBoolean(input['scanTruncated']) ?? false,
  };
};

const normalizeCreditPair = (input: Record<string, unknown>): QaAdminCreditPair | null => {
  const left = asString(input['left']);
  const right = asString(input['right']);
  if (!left || !right) return null;
  return {
    left,
    right,
    ok: asBoolean(input['ok']) ?? false,
    expectedCreditAmount: asString(input['expectedCreditAmount']) ?? 'n/a',
  };
};

export const normalizeQaAdminHealth = (payload: unknown): QaAdminHealthSnapshot | null => {
  if (!isRecord(payload)) return null;
  const process = isRecord(payload['process']) ? payload['process'] : {};
  const storage = isRecord(payload['storage']) ? payload['storage'] : {};
  const disk = isRecord(payload['disk']) ? payload['disk'] : {};
  const hubMesh = isRecord(payload['hubMesh']) ? payload['hubMesh'] : {};
  const direct = isRecord(hubMesh['direct']) ? hubMesh['direct'] : {};
  const marketMaker = isRecord(payload['marketMaker']) ? payload['marketMaker'] : {};
  const custody = isRecord(payload['custody']) ? payload['custody'] : {};
  const owners = [
    ...asRecordArray(process['children']).map(child => normalizeOwner(child, 'child')),
    ...asRecordArray(payload['hubs']).map(hub => normalizeOwner(hub, 'hub')),
  ];
  if (asBoolean(marketMaker['enabled']) !== null) {
    owners.push({
      role: 'market-maker',
      name: 'market-maker',
      status: asBoolean(marketMaker['ok']) === true ? 'online' : 'offline',
      runtimeId: asString(marketMaker['entityId']),
      dbPath: null,
      detail: `offers ${asNumber(marketMaker['expectedOffersPerHub']) ?? 0}/hub`,
    });
  }
  if (asBoolean(custody['enabled']) !== null) {
    owners.push({
      role: 'custody',
      name: 'custody',
      status: asBoolean(custody['ok']) === true ? 'online' : 'offline',
      runtimeId: asString(custody['entityId']),
      dbPath: null,
      detail: asNumber(custody['servicePort']) ? `service:${asNumber(custody['servicePort'])}` : null,
    });
  }
  return {
    systemOk: asBoolean(payload['systemOk']),
    coreOk: asBoolean(payload['coreOk']),
    degraded: Array.isArray(payload['degraded'])
      ? payload['degraded'].map(value => String(value)).filter(Boolean)
      : [],
    disk: {
      ok: asBoolean(disk['ok']),
      freeGiB: asNumber(disk['freeGiB']),
      usedPct: asNumber(disk['usedPct']),
    },
    directLinkCount: asNumber(direct['openLinkCount']) ?? 0,
    owners,
    tracked: asRecordArray(storage['tracked']).map(normalizeTracked).filter((value): value is QaAdminStorageTrack => Boolean(value)),
    creditPairs: asRecordArray(hubMesh['pairs']).map(normalizeCreditPair).filter((value): value is QaAdminCreditPair => Boolean(value)),
  };
};

export const formatQaBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${Math.round(bytes)} B`;
};

export const shortHealthId = (value: string | null | undefined): string => {
  const clean = String(value || '').trim();
  if (!clean) return 'n/a';
  return clean.length > 10 ? clean.slice(0, 10) : clean;
};

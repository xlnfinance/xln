import type { QaArtifact, QaRun, QaShard, QaStoryScreenshot } from './qa-types';

export { formatQaBytes, normalizeQaAdminHealth } from './admin-health';
export type {
  QaAdminCreditPair,
  QaAdminHealthOwner,
  QaAdminHealthSnapshot,
  QaAdminStorageTrack,
} from './admin-health';

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

const isVideoArtifact = (artifact: QaArtifact): boolean =>
  artifact.kind === 'video' || String(artifact.contentType || '').startsWith('video/');

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
  const firstAvailable = run.shards
    .map((shard, shardIndex) => ({ shard, shardIndex, video: shard.artifacts.find(isVideoArtifact) ?? null }))
    .find(candidate => !usedShardIndexes.has(candidate.shardIndex) && candidate.video);
  if (!firstAvailable?.video) return { shard: null, shardIndex: null, video: null };
  usedShardIndexes.add(firstAvailable.shardIndex);
  return { shard: firstAvailable.shard, shardIndex: firstAvailable.shardIndex, video: firstAvailable.video };
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

export const shortHealthId = (value: string | null | undefined): string => {
  const clean = String(value || '').trim();
  if (!clean) return 'n/a';
  return clean.length > 10 ? clean.slice(0, 10) : clean;
};

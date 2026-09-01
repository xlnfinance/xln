// Framework-neutral presentation rules for the workspace Architect panel.
// Runtime ingress, Account dispute construction, JAdapter calls, scenario
// execution, timers, browser events, and component lifecycle stay in Svelte.

export type ArchitectMode =
  | 'explore'
  | 'build'
  | 'economy'
  | 'solvency'
  | 'governance'
  | 'resolve';

export const getArchitectErrorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const getArchitectLiveModeBlockMessage = (action: string): string =>
  `${action} requires LIVE mode. Switch to the current runtime state before acting.`;

export const listArchitectEntityIds = (replicaKeys: Iterable<string>): string[] => {
  const entityIds = new Set<string>();
  for (const key of replicaKeys) entityIds.add(key.split(':')[0] || key);
  return [...entityIds];
};

export const findArchitectScenarioFrameLine = (
  scenarioCode: string,
  frameIndex: number,
): number => {
  const framePattern = new RegExp(`FRAME\\s+${frameIndex}[:\\s]`, 'i');
  const lineIndex = scenarioCode.split('\n').findIndex((line) => framePattern.test(line));
  return Math.max(0, lineIndex);
};

export const getArchitectScenarioScrollTop = (
  scenarioCode: string,
  frameIndex: number,
  lineHeight = 18,
  topPadding = 50,
): number => findArchitectScenarioFrameLine(scenarioCode, frameIndex) * lineHeight - topPadding;

export const getArchitectFrameLabel = (frameIndex: number): number | 'LIVE' =>
  frameIndex >= 0 ? frameIndex : 'LIVE';

export const getNextArchitectJurisdictionName = (currentName: string): string => {
  const match = currentName.match(/Testnet(\d+)/i);
  return match?.[1] ? `Testnet${Number.parseInt(match[1], 10) + 1}` : 'Testnet';
};

const ENTITY_NAME_SEQUENCE = [
  'alice',
  'bob',
  'charlie',
  'dave',
  'eve',
  'frank',
  'grace',
  'heidi',
] as const;

export const getNextArchitectEntityName = (currentName: string): string => {
  const normalized = currentName.toLowerCase();
  const currentIndex = ENTITY_NAME_SEQUENCE.findIndex((name) => name === normalized);
  return currentIndex >= 0 && currentIndex < ENTITY_NAME_SEQUENCE.length - 1
    ? (ENTITY_NAME_SEQUENCE[currentIndex + 1] ?? 'entity')
    : 'entity';
};

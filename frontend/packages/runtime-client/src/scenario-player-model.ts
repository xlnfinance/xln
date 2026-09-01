import type { EnvSnapshot } from '@xln/core/api/public/runtime-module';

export type ScenarioId = 'hub-collapse' | 'ahb' | 'settle' | 'swap';

export const DEFAULT_SCENARIO_ID: ScenarioId = 'ahb';

export type ScenarioOption = Readonly<{
  id: ScenarioId;
  runtimeId: string;
  runner?: string;
  title: string;
  description: string;
  intent: string;
  tags: readonly string[];
  focus: readonly string[];
}>;

export type ScenarioFrameNode = Readonly<{
  id: string;
  label: string;
  x: number;
  y: number;
  isHub: boolean;
  disputed: boolean;
  debtCount: number;
  accountCount: number;
}>;

export type ScenarioFrameEdge = Readonly<{
  key: string;
  from: ScenarioFrameNode;
  to: ScenarioFrameNode;
  disputed: boolean;
}>;

export type ScenarioFrameVisual = Readonly<{
  nodes: readonly ScenarioFrameNode[];
  edges: readonly ScenarioFrameEdge[];
  activeDisputes: number;
  debtCount: number;
  accountCount: number;
  title: string;
  description: string;
  collapse: boolean;
}>;

type PositionedNode = ScenarioFrameNode & Readonly<{ rawX: number; rawY: number }>;

export const SCENARIO_OPTIONS: readonly ScenarioOption[] = [
  {
    id: 'ahb',
    runtimeId: 'ahb',
    runner: 'ahb',
    title: 'Alice-Hub-Bob Triangle',
    description: 'Full bilateral flow: reserves, hub routing, collateral, settlements, disputes, and cooperative close.',
    intent: 'Inspect the full wallet and hub mechanics over time.',
    tags: ['bilateral', 'routing', 'settlement'],
    focus: ['Alice', 'Hub', 'Bob', 'payment', 'settlement'],
  },
  {
    id: 'hub-collapse',
    runtimeId: 'dispute-lifecycle',
    runner: 'disputeLifecycle',
    title: 'Hub collapse',
    description: 'Unilateral last-resort dispute: user freezes the hub account, waits timeout, finalizes, then reopens.',
    intent: 'Watch what happens when the hub stops cooperating.',
    tags: ['dispute', 'last resort', 'hub'],
    focus: ['dispute', 'freeze', 'finalize', 'debt', 'reopen'],
  },
  {
    id: 'settle',
    runtimeId: 'settle',
    runner: 'settle',
    title: 'Settlement workspace',
    description: 'Bilateral settlement negotiation: propose, counter, approve, execute, reject.',
    intent: 'Build and inspect settlement UI narratives quickly.',
    tags: ['settlement', 'workspace'],
    focus: ['Settlement', 'propose', 'signed', 'reject'],
  },
  {
    id: 'swap',
    runtimeId: 'swap',
    runner: 'swap',
    title: 'Swap orderbook',
    description: 'Same-jurisdiction bilateral orderbook with limit orders, fills, holds, and cancel flow.',
    intent: 'Check how trading state evolves frame by frame.',
    tags: ['swap', 'orderbook'],
    focus: ['swap', 'order', 'fill', 'cancel'],
  },
] as const;

export const EMPTY_SCENARIO_VISUAL: ScenarioFrameVisual = {
  nodes: [], edges: [], activeDisputes: 0, debtCount: 0, accountCount: 0,
  title: '', description: '', collapse: false,
};

export const scenarioMapEntries = <T = unknown>(value: unknown): Array<[string, T]> => {
  if (value instanceof Map) return Array.from(value.entries()).map(([key, item]) => [String(key), item as T]);
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.entries(value as Record<string, T>);
  return [];
};

const mapSize = (value: unknown): number => {
  if (value instanceof Map) return value.size;
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.keys(value).length;
  return 0;
};

const normalizeId = (value: unknown): string => String(value || '').trim().toLowerCase();

export const scenarioAsRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const shortId = (value: string): string => {
  const id = normalizeId(value);
  return id.length > 12 ? `${id.slice(0, 6)}...${id.slice(-4)}` : id;
};

const profileFor = (frame: EnvSnapshot, entityId: string) => {
  const target = normalizeId(entityId);
  return (frame.gossip?.profiles || []).find(item => normalizeId(item.entityId) === target);
};

const profileName = (frame: EnvSnapshot, entityId: string): string =>
  String(profileFor(frame, entityId)?.name || '').trim() || shortId(entityId);

const profileIsHub = (frame: EnvSnapshot, entityId: string, displayedName: string): boolean =>
  profileFor(frame, entityId)?.metadata?.isHub === true || /hub/i.test(displayedName);

const countDebts = (state: Record<string, unknown>): number =>
  ['outDebtsByToken', 'inDebtsByToken'].reduce((count, family) =>
    count + scenarioMapEntries(state[family]).reduce((sum, [, debts]) => sum + mapSize(debts), 0), 0);

const readPosition = (
  replica: Record<string, unknown>,
  index: number,
  total: number,
): Readonly<{ x: number; y: number }> => {
  const state = scenarioAsRecord(replica['state']);
  const raw = (replica['position'] || state['position']) as { x?: unknown; y?: unknown } | undefined;
  const x = Number(raw?.x);
  const y = Number(raw?.y);
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  const angle = total <= 1 ? 0 : (index / total) * Math.PI * 2;
  return { x: Math.cos(angle) * 40, y: Math.sin(angle) * 24 };
};

const normalizePositions = (nodes: readonly PositionedNode[]): readonly ScenarioFrameNode[] => {
  if (nodes.length === 0) return [];
  const xs = nodes.map(node => node.rawX);
  const ys = nodes.map(node => node.rawY);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const width = Math.max(1, Math.max(...xs) - minX);
  const height = Math.max(1, Math.max(...ys) - minY);
  return nodes.map(({ rawX, rawY, ...node }) => ({
    ...node,
    x: 12 + ((rawX - minX) / width) * 76,
    y: 12 + ((rawY - minY) / height) * 40,
  }));
};

const createNodes = (frame: EnvSnapshot): readonly ScenarioFrameNode[] => {
  const entries = scenarioMapEntries<Record<string, unknown>>(frame.state.eReplicas);
  const ids = new Set<string>();
  const nodes = entries.flatMap(([replicaKey, replica], index): PositionedNode[] => {
    const state = scenarioAsRecord(replica['state']);
    const entityId = normalizeId(replica['entityId'] || state['entityId'] || replicaKey.split(':')[0]);
    if (!entityId || ids.has(entityId)) return [];
    ids.add(entityId);
    const accounts = scenarioMapEntries<Record<string, unknown>>(state['accounts']);
    const label = profileName(frame, entityId);
    const position = readPosition(replica, index, Math.max(1, entries.length));
    return [{
      id: entityId, label, x: 0, y: 0, rawX: position.x, rawY: position.y,
      isHub: profileIsHub(frame, entityId, label),
      disputed: accounts.some(([, account]) => Boolean(account['activeDispute'])),
      debtCount: countDebts(state), accountCount: accounts.length,
    }];
  });
  return normalizePositions(nodes);
};

const createEdges = (
  frame: EnvSnapshot,
  nodes: readonly ScenarioFrameNode[],
): Readonly<{ edges: readonly ScenarioFrameEdge[]; activeDisputes: number; accountCount: number }> => {
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const edges = new Map<string, ScenarioFrameEdge>();
  let activeDisputes = 0;
  let accountCount = 0;
  for (const [, replica] of scenarioMapEntries<Record<string, unknown>>(frame.state.eReplicas)) {
    const state = scenarioAsRecord(replica['state']);
    const from = nodeById.get(normalizeId(replica['entityId'] || state['entityId']));
    if (!from) continue;
    for (const [counterparty, account] of scenarioMapEntries<Record<string, unknown>>(state['accounts'])) {
      const to = nodeById.get(normalizeId(counterparty));
      if (!to || from.id === to.id) continue;
      accountCount += 1;
      const disputed = Boolean(account['activeDispute']);
      if (disputed) activeDisputes += 1;
      const key = [from.id, to.id].sort().join('|');
      edges.set(key, { key, from, to, disputed: disputed || edges.get(key)?.disputed === true });
    }
  }
  return { edges: Array.from(edges.values()), activeDisputes, accountCount };
};

const frameText = (frame: EnvSnapshot): string => [
  frame.meta?.title, frame.meta?.subtitle?.title, frame.description, frame.narrative,
].filter(Boolean).join(' ').toLowerCase();

export const buildScenarioFrameVisual = (
  frame: EnvSnapshot,
  option: ScenarioOption,
): ScenarioFrameVisual => {
  const nodes = createNodes(frame);
  const edgeResult = createEdges(frame, nodes);
  const debtCount = scenarioMapEntries<Record<string, unknown>>(frame.state.eReplicas)
    .reduce((count, [, replica]) => count + countDebts(scenarioAsRecord(replica['state'])), 0);
  const title = String(frame.meta?.title || frame.meta?.subtitle?.title || `Frame ${frame.state.height}`);
  const description = String(frame.description || frame.narrative || option.description);
  const collapse = option.id === 'hub-collapse' && (
    edgeResult.activeDisputes > 0 || debtCount > 0 ||
    /dispute|finalize|freeze|debt|reopen|non-cooperative/i.test(`${title} ${description}`)
  );
  return { nodes, ...edgeResult, debtCount, title, description, collapse };
};

export const focusScenarioFrameIndex = (
  option: ScenarioOption,
  frames: readonly EnvSnapshot[],
): number => {
  if (frames.length === 0) return 0;
  if (option.id === 'hub-collapse') {
    const collapse = frames.findIndex(frame => buildScenarioFrameVisual(frame, option).collapse);
    if (collapse >= 0) return collapse;
  }
  const focused = frames.findIndex(frame => option.focus.some(keyword => frameText(frame).includes(keyword.toLowerCase())));
  return focused >= 0 ? focused : 0;
};

export const findScenarioOption = (id: string): ScenarioOption =>
  SCENARIO_OPTIONS.find(option => option.id === id) ?? requireScenarioOption(DEFAULT_SCENARIO_ID);

export const requireScenarioOption = (id: string): ScenarioOption => {
  const option = SCENARIO_OPTIONS.find(candidate => candidate.id === id);
  if (!option) throw new Error(`RUNTIME_SCENARIO_UNKNOWN:${id}`);
  return option;
};

export const clampScenarioFrameIndex = (index: number, frameCount: number): number =>
  frameCount === 0 ? 0 : Math.max(0, Math.min(frameCount - 1, Math.floor(index)));

export const scenarioPreviewHref = (id: ScenarioId, frame: number): string => {
  const params = new URLSearchParams({ locktest: '1', scenarioPreview: '1', scenario: id, frame: String(frame) });
  return `/app?${params.toString()}`;
};

export const readScenarioPreviewRequest = (search: string): Readonly<{ id: ScenarioId; frame: number }> => {
  const params = new URLSearchParams(search);
  if (params.get('locktest') !== '1' || params.get('scenarioPreview') !== '1') {
    throw new Error('RUNTIME_SCENARIO_PREVIEW_MARKERS_REQUIRED');
  }
  const option = requireScenarioOption(String(params.get('scenario') || '').trim());
  const rawFrame = String(params.get('frame') || '0');
  if (!/^\d+$/.test(rawFrame)) throw new Error(`RUNTIME_SCENARIO_FRAME_INVALID:${rawFrame}`);
  const frame = Number(rawFrame);
  if (!Number.isSafeInteger(frame)) throw new Error(`RUNTIME_SCENARIO_FRAME_INVALID:${rawFrame}`);
  return { id: option.id, frame };
};

export const formatScenarioBuilderText = (
  frame: EnvSnapshot | null,
  visual: ScenarioFrameVisual,
  option: ScenarioOption,
  index: number,
  totalFrames: number,
): string => frame ? [
  `scenario=${option.id}`,
  `runtime=${option.runtimeId}`,
  `frame=${index + 1}/${totalFrames}`,
  `height=${frame.state.height}`,
  `title=${visual.title}`,
  `inputs=${frame.runtimeInput?.entityInputs?.length ?? 0}`,
  `outputs=${frame.runtimeOutputs?.length ?? 0}`,
  `logs=${frame.logs?.length ?? 0}`,
  `entities=${visual.nodes.length}`,
  `accounts=${visual.accountCount}`,
  `activeDisputes=${visual.activeDisputes}`,
  `debts=${visual.debtCount}`,
].join('\n') : 'No frame loaded.';

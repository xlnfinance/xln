import type {
  EntityReplica,
  Env,
  EnvSnapshot,
  RuntimeAdapterEntitySummary,
  RuntimeAdapterViewFrame,
} from '@xln/runtime/xln-api';
import type { StorageEntityCoreDoc } from '@xln/runtime/storage/types';

export type RuntimeGraphAdapterKind = 'browser' | 'remote';
export type RuntimeGraphCanonicity = 'timestamp' | 'height' | 'left' | 'right' | 'hub';

export type RuntimeGraphPosition = {
  x: number;
  y: number;
  z: number;
  jurisdiction?: string;
};

export type RuntimeGraphSource = {
  runtimeId: string;
  label: string;
  adapterKind: RuntimeGraphAdapterKind;
  height: number;
  timestamp: number;
};

export type RuntimeGraphNodeState = RuntimeGraphSource & {
  entityId: string;
  label: string;
  signerId: string;
  isHub: boolean;
  jurisdiction: string;
  position: RuntimeGraphPosition | null;
  replica: EntityReplica | null;
  core: StorageEntityCoreDoc | null;
};

export type RuntimeGraphAccountState = RuntimeGraphSource & {
  accountId: string;
  observerEntityId: string;
  observerIsHub: boolean;
  leftEntityId: string;
  rightEntityId: string;
  height: number;
  account: unknown;
};

export type RuntimeGraphJMachineState = RuntimeGraphSource & {
  jMachineId: string;
  name: string;
  position: RuntimeGraphPosition | null;
  machine: unknown;
};

export type RuntimeGraphProjection = {
  source: RuntimeGraphSource;
  nodes: RuntimeGraphNodeState[];
  accounts: RuntimeGraphAccountState[];
  jMachines: RuntimeGraphJMachineState[];
};

export type MergedRuntimeGraphNode = {
  entityId: string;
  selected: RuntimeGraphNodeState;
  states: RuntimeGraphNodeState[];
  provenance: string[];
  desynchronized: boolean;
};

export type MergedRuntimeGraphAccount = {
  accountId: string;
  selected: RuntimeGraphAccountState;
  states: RuntimeGraphAccountState[];
  provenance: string[];
  desynchronized: boolean;
};

export type MergedRuntimeGraphJMachine = {
  jMachineId: string;
  selected: RuntimeGraphJMachineState;
  states: RuntimeGraphJMachineState[];
  provenance: string[];
  desynchronized: boolean;
};

export type MergedRuntimeGraph = {
  scope: 'merged' | string;
  canonicity: RuntimeGraphCanonicity;
  sources: RuntimeGraphSource[];
  nodes: MergedRuntimeGraphNode[];
  accounts: MergedRuntimeGraphAccount[];
  jMachines: MergedRuntimeGraphJMachine[];
};

type ProjectionOptions = {
  runtimeId: string;
  label?: string;
  adapterKind: RuntimeGraphAdapterKind;
};

type RuntimeGraphEnvFrame = Env | EnvSnapshot;

const text = (value: unknown): string => String(value || '').trim();
const id = (value: unknown): string => text(value).toLowerCase();
const integer = (value: unknown): number => {
  const parsed = Math.floor(Number(value || 0));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};
const sortedUnique = (values: string[]): string[] => Array.from(new Set(values)).sort();
const sourceOf = (options: ProjectionOptions, height: number, timestamp: number): RuntimeGraphSource => ({
  runtimeId: id(options.runtimeId),
  label: text(options.label) || id(options.runtimeId),
  adapterKind: options.adapterKind,
  height: integer(height),
  timestamp: integer(timestamp),
});
const jurisdictionName = (value: unknown): string => {
  const candidate = value as { name?: unknown } | null;
  return text(candidate?.name ?? value);
};
const positionOf = (value: unknown): RuntimeGraphPosition | null => {
  const candidate = value as Partial<RuntimeGraphPosition> & { xlnomy?: string } | null;
  const x = Number(candidate?.x);
  const y = Number(candidate?.y);
  const z = Number(candidate?.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  const jurisdiction = text(candidate?.jurisdiction || candidate?.xlnomy);
  return { x, y, z, ...(jurisdiction ? { jurisdiction } : {}) };
};

const profileMap = (env: RuntimeGraphEnvFrame): Map<string, { entityId?: string; name?: string; metadata?: Record<string, unknown> }> => {
  const gossip = env.gossip as Env['gossip'] | EnvSnapshot['gossip'] | undefined;
  const rawProfiles = gossip && 'getProfiles' in gossip && typeof gossip.getProfiles === 'function'
    ? gossip.getProfiles()
    : gossip?.profiles;
  const profiles = rawProfiles instanceof Map
    ? Array.from(rawProfiles.values())
    : Array.isArray(rawProfiles) ? rawProfiles : [];
  return new Map(profiles.map((profile) => [id(profile.entityId), profile]));
};

const nodeFromReplica = (
  replica: EntityReplica,
  source: RuntimeGraphSource,
  profile: { name?: string; metadata?: Record<string, unknown> } | undefined,
): RuntimeGraphNodeState => {
  const entityId = id(replica.entityId || replica.state?.entityId);
  const stateProfile = replica.state?.profile as { name?: string; isHub?: boolean; metadata?: Record<string, unknown> } | undefined;
  const profilePosition = positionOf(profile?.metadata?.['position']);
  const jurisdiction = text(replica.position?.jurisdiction || replica.position?.xlnomy)
    || jurisdictionName(profile?.metadata?.['jurisdiction']);
  return {
    ...source,
    entityId,
    label: text(profile?.name || stateProfile?.name) || entityId,
    signerId: text(replica.signerId),
    isHub: profile?.metadata?.['isHub'] === true || stateProfile?.isHub === true || Boolean(replica.state?.orderbookExt?.hubProfile),
    jurisdiction,
    height: integer(replica.state?.height ?? source.height),
    timestamp: integer(replica.state?.timestamp ?? source.timestamp),
    position: positionOf(replica.position) ?? profilePosition,
    replica,
    core: null,
  };
};

const preferReplicaNode = (left: RuntimeGraphNodeState, right: RuntimeGraphNodeState): RuntimeGraphNodeState => {
  const leftProposer = left.replica?.isProposer === true ? 1 : 0;
  const rightProposer = right.replica?.isProposer === true ? 1 : 0;
  if (leftProposer !== rightProposer) return leftProposer > rightProposer ? left : right;
  if (left.timestamp !== right.timestamp) return left.timestamp > right.timestamp ? left : right;
  if (left.height !== right.height) return left.height > right.height ? left : right;
  return left.signerId <= right.signerId ? left : right;
};

const accountState = (
  source: RuntimeGraphSource,
  node: RuntimeGraphNodeState,
  counterpartyId: string,
  account: unknown,
): RuntimeGraphAccountState => {
  const value = account as { leftEntity?: unknown; rightEntity?: unknown; currentHeight?: unknown } | null;
  const observer = node.entityId;
  const counterparty = id(counterpartyId);
  const leftEntityId = id(value?.leftEntity) || [observer, counterparty].sort()[0] || observer;
  const rightEntityId = id(value?.rightEntity) || [observer, counterparty].sort()[1] || counterparty;
  return {
    ...source,
    accountId: `${leftEntityId}:${rightEntityId}`,
    observerEntityId: observer,
    observerIsHub: node.isHub,
    leftEntityId,
    rightEntityId,
    height: integer(value?.currentHeight ?? node.height),
    timestamp: node.timestamp,
    account,
  };
};

const projectEnvJMachines = (env: RuntimeGraphEnvFrame, source: RuntimeGraphSource): RuntimeGraphJMachineState[] =>
  Array.from(env.jReplicas?.entries?.() ?? []).map(([key, machine]) => {
    const value = machine as { name?: unknown; blockNumber?: unknown; position?: unknown };
    const name = text(value.name || key);
    return {
      ...source,
      jMachineId: id(name),
      name,
      height: integer(value.blockNumber ?? source.height),
      position: positionOf(value.position),
      machine,
    };
  }).sort((left, right) => left.jMachineId.localeCompare(right.jMachineId));

export const projectRuntimeEnv = (env: RuntimeGraphEnvFrame, options: ProjectionOptions): RuntimeGraphProjection => {
  const source = sourceOf(options, env.height, env.timestamp);
  const profiles = profileMap(env);
  const selected = new Map<string, RuntimeGraphNodeState>();
  for (const replica of env.eReplicas?.values?.() ?? []) {
    const candidate = nodeFromReplica(replica, source, profiles.get(id(replica.entityId)));
    if (!candidate.entityId) continue;
    const existing = selected.get(candidate.entityId);
    selected.set(candidate.entityId, existing ? preferReplicaNode(existing, candidate) : candidate);
  }
  const nodes = Array.from(selected.values()).sort((left, right) => left.entityId.localeCompare(right.entityId));
  const accounts = nodes.flatMap((node) => Array.from(node.replica?.state?.accounts?.entries?.() ?? [])
    .map(([counterpartyId, account]) => accountState(source, node, counterpartyId, account)));
  return { source, nodes, accounts, jMachines: projectEnvJMachines(env, source) };
};

const nodeFromSummary = (
  summary: RuntimeAdapterEntitySummary,
  frame: RuntimeAdapterViewFrame,
  source: RuntimeGraphSource,
): RuntimeGraphNodeState => {
  const entityId = id(summary.entityId);
  const active = id(frame.activeEntityId) === entityId ? frame.activeEntity : null;
  const core = active?.core ?? null;
  const coreProfile = core?.profile as { name?: string; isHub?: boolean } | undefined;
  return {
    ...source,
    entityId,
    label: text(summary.label || coreProfile?.name) || entityId,
    signerId: text(summary.signerId || core?.signerId),
    isHub: summary.isHub === true || coreProfile?.isHub === true || Boolean(core?.orderbookHubProfile),
    jurisdiction: jurisdictionName(summary.jurisdiction),
    height: integer(core?.height ?? summary.height ?? source.height),
    timestamp: integer(core?.timestamp ?? source.timestamp),
    position: null,
    replica: null,
    core,
  };
};

export const projectRuntimeViewFrame = (
  frame: RuntimeAdapterViewFrame,
  options: ProjectionOptions,
): RuntimeGraphProjection => {
  const source = sourceOf(options, frame.height, frame.activeEntity?.core?.timestamp ?? frame.height);
  const nodes = frame.entities.map((summary) => nodeFromSummary(summary, frame, source))
    .sort((left, right) => left.entityId.localeCompare(right.entityId));
  const activeNode = nodes.find((node) => node.entityId === id(frame.activeEntityId));
  const accounts = !activeNode ? [] : frame.activeEntity!.accounts.items
    .map((account) => accountState(source, activeNode, account.leftEntity === activeNode.entityId ? account.rightEntity : account.leftEntity, account));
  const jMachines = sortedUnique(nodes.map((node) => node.jurisdiction).filter(Boolean)).map((name) => ({
    ...source,
    jMachineId: id(name),
    name,
    position: null,
    machine: null,
  }));
  return { source, nodes, accounts, jMachines };
};

const compareState = (
  left: RuntimeGraphNodeState | RuntimeGraphAccountState | RuntimeGraphJMachineState,
  right: RuntimeGraphNodeState | RuntimeGraphAccountState | RuntimeGraphJMachineState,
  policy: RuntimeGraphCanonicity,
): number => {
  if ('observerEntityId' in left && 'observerEntityId' in right) {
    const preferred = policy === 'left' ? left.leftEntityId : policy === 'right' ? left.rightEntityId : '';
    if (preferred) {
      const delta = Number(right.observerEntityId === preferred) - Number(left.observerEntityId === preferred);
      if (delta) return delta;
    }
    if (policy === 'hub') {
      const delta = Number(right.observerIsHub) - Number(left.observerIsHub);
      if (delta) return delta;
    }
  }
  const primary = policy === 'height' ? 'height' : 'timestamp';
  const secondary = primary === 'height' ? 'timestamp' : 'height';
  return right[primary] - left[primary] || right[secondary] - left[secondary] || left.runtimeId.localeCompare(right.runtimeId);
};

const stateVersion = (state: RuntimeGraphNodeState | RuntimeGraphAccountState): string =>
  'accountId' in state
    ? `${state.height}|${String((state.account as { status?: unknown })?.status || '')}`
    : `${state.height}|${state.timestamp}|${state.label}|${state.signerId}|${state.isHub}|${state.jurisdiction}`;

const jMachineVersion = (state: RuntimeGraphJMachineState): string =>
  `${state.height}|${state.timestamp}|${state.name}|${state.position?.x ?? ''}|${state.position?.y ?? ''}|${state.position?.z ?? ''}`;

export const mergeRuntimeGraphProjections = (
  projections: RuntimeGraphProjection[],
  canonicity: RuntimeGraphCanonicity,
  scope: 'merged' | string = 'merged',
): MergedRuntimeGraph => {
  const included = scope === 'merged' ? projections : projections.filter((item) => item.source.runtimeId === scope);
  const nodeGroups = new Map<string, RuntimeGraphNodeState[]>();
  const accountGroups = new Map<string, RuntimeGraphAccountState[]>();
  const jMachineGroups = new Map<string, RuntimeGraphJMachineState[]>();
  for (const projection of included) {
    for (const node of projection.nodes) nodeGroups.set(node.entityId, [...(nodeGroups.get(node.entityId) ?? []), node]);
    for (const account of projection.accounts) accountGroups.set(account.accountId, [...(accountGroups.get(account.accountId) ?? []), account]);
    for (const machine of projection.jMachines) jMachineGroups.set(machine.jMachineId, [...(jMachineGroups.get(machine.jMachineId) ?? []), machine]);
  }
  const nodes = Array.from(nodeGroups, ([entityId, states]) => {
    const ordered = [...states].sort((left, right) => compareState(left, right, canonicity));
    return { entityId, selected: ordered[0]!, states: ordered, provenance: sortedUnique(states.map((state) => state.runtimeId)), desynchronized: new Set(states.map(stateVersion)).size > 1 };
  }).sort((left, right) => left.entityId.localeCompare(right.entityId));
  const accounts = Array.from(accountGroups, ([accountId, states]) => {
    const ordered = [...states].sort((left, right) => compareState(left, right, canonicity));
    return { accountId, selected: ordered[0]!, states: ordered, provenance: sortedUnique(states.map((state) => state.runtimeId)), desynchronized: new Set(states.map(stateVersion)).size > 1 };
  }).sort((left, right) => left.accountId.localeCompare(right.accountId));
  const jMachines = Array.from(jMachineGroups, ([jMachineId, states]) => {
    const ordered = [...states].sort((left, right) => compareState(left, right, canonicity));
    return { jMachineId, selected: ordered[0]!, states: ordered, provenance: sortedUnique(states.map((state) => state.runtimeId)), desynchronized: new Set(states.map(jMachineVersion)).size > 1 };
  }).sort((left, right) => left.jMachineId.localeCompare(right.jMachineId));
  return { scope, canonicity, sources: included.map((item) => item.source), nodes, accounts, jMachines };
};

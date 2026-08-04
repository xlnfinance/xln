import type { EnvSnapshot } from '@xln/runtime/api/public/runtime-module';

export type OpsGraphNode = Readonly<{ id: string; label: string; x: number; y: number; hub: boolean; disputed: boolean; accounts: number; debts: number }>;
export type OpsGraphEdge = Readonly<{ id: string; from: string; to: string; disputed: boolean }>;
export type OpsGraphFrame = Readonly<{ height: number; title: string; description: string; nodes: readonly OpsGraphNode[]; edges: readonly OpsGraphEdge[]; disputes: number; debts: number }>;

const entries = <T>(value: unknown): Array<[string, T]> => value instanceof Map
  ? Array.from(value.entries()).map(([key, item]) => [String(key), item as T])
  : value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value as Record<string, T>) : [];
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const id = (value: unknown): string => String(value ?? '').trim().toLowerCase();
const countDebts = (state: Record<string, unknown>): number => ['outDebtsByToken', 'inDebtsByToken'].reduce((sum, family) => sum + entries(state[family]).reduce((inner, [, byId]) => inner + entries(byId).length, 0), 0);
const labelFor = (frame: EnvSnapshot, entityId: string): string => {
  const profile = (frame.gossip?.profiles ?? []).find(item => id(item.entityId) === entityId);
  return String(profile?.name ?? '').trim() || (entityId.length > 12 ? `${entityId.slice(0, 6)}…${entityId.slice(-4)}` : entityId);
};

export const projectOpsGraphFrame = (frame: EnvSnapshot): OpsGraphFrame => {
  if (!frame?.state || !Number.isFinite(frame.state.height)) throw new Error('OPS_SCENARIO_FRAME_INVALID');
  const replicas = entries<Record<string, unknown>>(frame.state.eReplicas);
  const rawNodes = replicas.map(([replicaKey, replica], index) => {
    const state = object(replica['state']);
    const entityId = id(replica['entityId'] ?? state['entityId'] ?? replicaKey.split(':')[0]);
    if (!entityId) throw new Error(`OPS_SCENARIO_ENTITY_ID_INVALID:${index}`);
    const accounts = entries<Record<string, unknown>>(state['accounts']);
    const angle = replicas.length <= 1 ? 0 : index / replicas.length * Math.PI * 2;
    const position = object(replica['position'] ?? state['position']);
    const x = Number(position['x']); const y = Number(position['y']);
    const name = labelFor(frame, entityId);
    return { id: entityId, label: name, rawX: Number.isFinite(x) ? x : Math.cos(angle) * 40, rawY: Number.isFinite(y) ? y : Math.sin(angle) * 24, hub: /hub/i.test(name), disputed: accounts.some(([, account]) => Boolean(account['activeDispute'])), accounts: accounts.length, debts: countDebts(state) };
  });
  const xs = rawNodes.map(node => node.rawX); const ys = rawNodes.map(node => node.rawY);
  const minX = Math.min(...xs, 0); const maxX = Math.max(...xs, 1); const minY = Math.min(...ys, 0); const maxY = Math.max(...ys, 1);
  const nodes = rawNodes.map(({ rawX, rawY, ...node }) => Object.freeze({ ...node, x: 12 + (rawX - minX) / Math.max(1, maxX - minX) * 76, y: 12 + (rawY - minY) / Math.max(1, maxY - minY) * 40 }));
  const byId = new Map(nodes.map(node => [node.id, node])); const edgeMap = new Map<string, OpsGraphEdge>();
  for (const [replicaKey, replica] of replicas) {
    const state = object(replica['state']); const source = id(replica['entityId'] ?? state['entityId'] ?? replicaKey.split(':')[0]);
    for (const [targetRaw, account] of entries<Record<string, unknown>>(state['accounts'])) {
      const target = id(targetRaw); if (!byId.has(source) || !byId.has(target) || source === target) continue;
      const edgeId = [source, target].toSorted().join('|'); const disputed = Boolean(account['activeDispute']);
      edgeMap.set(edgeId, Object.freeze({ id: edgeId, from: source, to: target, disputed: disputed || edgeMap.get(edgeId)?.disputed === true }));
    }
  }
  const edges = Object.freeze(Array.from(edgeMap.values()));
  return Object.freeze({ height: frame.state.height, title: String(frame.meta?.title ?? frame.meta?.subtitle?.title ?? `Frame ${frame.state.height}`), description: String(frame.description || frame.narrative || 'Deterministic Runtime frame'), nodes: Object.freeze(nodes), edges, disputes: edges.filter(edge => edge.disputed).length, debts: nodes.reduce((sum, node) => sum + node.debts, 0) });
};

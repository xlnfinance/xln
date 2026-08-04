import type { RuntimeAdapterGraphFrame } from '@xln/runtime/api/public/runtime-module';
import type { OpsGraphEdge, OpsGraphFrame, OpsGraphNode } from './ops-scenario-graph';

export const projectTrailGraphFrame = (frame: RuntimeAdapterGraphFrame): OpsGraphFrame => {
  if (!frame.runtimeId.trim() || !Number.isSafeInteger(frame.height) || frame.height < 1) throw new Error('OPS_EMBED_TRAIL_FRAME_INVALID');
  const total = frame.entities.length;
  const nodes: OpsGraphNode[] = frame.entities.map((entity, index) => {
    const entityId = String(entity.summary.entityId || entity.core?.entityId || '').trim().toLowerCase(); if (!entityId) throw new Error(`OPS_EMBED_TRAIL_ENTITY_INVALID:${index}`);
    const angle = total <= 1 ? 0 : index / total * Math.PI * 2; const label = String(entity.core?.profile.name || entity.summary.label || entityId).trim(); const accounts = entity.accounts.items;
    return Object.freeze({ id: entityId, label, x: 50 + Math.cos(angle) * 34, y: 32 + Math.sin(angle) * 22, hub: entity.core?.profile.isHub === true || entity.core?.isHub === true, disputed: accounts.some(account => Boolean(account.activeDispute)), accounts: accounts.length, debts: 0 });
  });
  const ids = new Set(nodes.map(node => node.id)); const edgeMap = new Map<string, OpsGraphEdge>();
  for (const entity of frame.entities) for (const account of entity.accounts.items) {
    const left = String(account.leftEntity).trim().toLowerCase(); const right = String(account.rightEntity).trim().toLowerCase(); if (!ids.has(left) || !ids.has(right) || left === right) continue;
    const edgeId = [left, right].toSorted().join('|'); const disputed = Boolean(account.activeDispute); edgeMap.set(edgeId, Object.freeze({ id: edgeId, from: left, to: right, disputed: disputed || edgeMap.get(edgeId)?.disputed === true }));
  }
  const edges = Object.freeze(Array.from(edgeMap.values())); return Object.freeze({ height: frame.height, title: `Recorded Runtime ${frame.runtimeId}`, description: `Exact recorded graph frame · ${frame.stateHash.slice(0, 16)}`, nodes: Object.freeze(nodes), edges, disputes: edges.filter(edge => edge.disputed).length, debts: 0 });
};

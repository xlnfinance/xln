// Framework-neutral input projection for the Graph3D scene. Runtime source
// summaries and untrusted transaction envelopes are normalized here; Three.js
// object creation, animation, and browser effects remain in the panel facade.

import { isUnknownRecord } from './boundary';

export type Graph3dSceneTransaction = Readonly<{
  type?: string;
  kind?: string;
  targetEntityId?: string;
  amount?: string | number | bigint;
  data?: Readonly<{
    amount?: string | number | bigint;
    tokenId?: number;
    targetEntityId?: string;
    fromEntityId?: string;
    toEntityId?: string;
    accountTx?: Graph3dSceneTransaction;
  }>;
}>;

type Graph3dRuntimeProjectionLike = Readonly<{
  source: Readonly<{
    runtimeId: string;
    label: string;
    adapterKind: string;
  }>;
}>;

type DesynchronizedProjection = Readonly<{ desynchronized: boolean }>;
type Graph3dMergedJMachineLike = DesynchronizedProjection & Readonly<{
  provenance: readonly string[];
  selected: Readonly<{
    name: string;
    height: number;
    position: Readonly<{ x: number; y: number; z: number }> | null;
    machine: unknown;
  }>;
}>;

type Graph3dMergedSceneLike = Readonly<{
  nodes: readonly DesynchronizedProjection[];
  accounts: readonly DesynchronizedProjection[];
  jMachines: readonly Graph3dMergedJMachineLike[];
}>;

export type Graph3dJurisdictionView = Readonly<{
  name: string;
  jMachine: Readonly<{
    position: Readonly<{ x: number; y: number; z: number }>;
    capacity: 3;
    jHeight: number;
    mempool: readonly unknown[];
    provenance: readonly string[];
  }>;
}>;

export type Graph3dSceneInputView = Readonly<{
  runtimeOptions: readonly Readonly<{ value: string; label: string }>[];
  desyncCount: number;
  activeJurisdictionName: string | null;
  jurisdictions: readonly Graph3dJurisdictionView[];
}>;

const graphTransactionData = (value: Record<string, unknown>): NonNullable<Graph3dSceneTransaction['data']> => ({
  ...(typeof value['amount'] === 'string' || typeof value['amount'] === 'number' || typeof value['amount'] === 'bigint'
    ? { amount: value['amount'] }
    : {}),
  ...(typeof value['tokenId'] === 'number' ? { tokenId: value['tokenId'] } : {}),
  ...(typeof value['targetEntityId'] === 'string' ? { targetEntityId: value['targetEntityId'] } : {}),
  ...(typeof value['fromEntityId'] === 'string' ? { fromEntityId: value['fromEntityId'] } : {}),
  ...(typeof value['toEntityId'] === 'string' ? { toEntityId: value['toEntityId'] } : {}),
  ...(value['accountTx'] !== undefined ? { accountTx: graph3dSceneTransactionOf(value['accountTx']) } : {}),
});

export const graph3dSceneTransactionOf = (value: unknown): Graph3dSceneTransaction => {
  if (!isUnknownRecord(value)) return {};
  const data = isUnknownRecord(value['data']) ? value['data'] : null;
  const amount = value['amount'] ?? data?.['amount'];
  return {
    ...(typeof value['type'] === 'string' ? { type: value['type'] } : {}),
    ...(typeof value['kind'] === 'string' ? { kind: value['kind'] } : {}),
    ...(typeof value['targetEntityId'] === 'string' ? { targetEntityId: value['targetEntityId'] } : {}),
    ...(typeof amount === 'string' || typeof amount === 'number' || typeof amount === 'bigint' ? { amount } : {}),
    ...(data ? { data: graphTransactionData(data) } : {}),
  };
};

const jurisdictionMempool = (name: string, machine: unknown): readonly unknown[] => {
  if (!isUnknownRecord(machine) || machine['mempool'] === undefined) return [];
  if (!Array.isArray(machine['mempool'])) throw new Error(`GRAPH_JURISDICTION_MEMPOOL_INVALID:${name}`);
  return machine['mempool'];
};

export const createGraph3dSceneInputView = (
  projections: readonly Graph3dRuntimeProjectionLike[],
  merged: Graph3dMergedSceneLike,
): Graph3dSceneInputView => ({
  runtimeOptions: [
    { value: 'merged', label: `Merged (${projections.length})` },
    ...projections.map(({ source }) => ({
      value: source.runtimeId,
      label: `${source.label} · ${source.adapterKind}`,
    })),
  ],
  desyncCount: [...merged.nodes, ...merged.accounts, ...merged.jMachines]
    .filter(({ desynchronized }) => desynchronized).length,
  activeJurisdictionName: merged.jMachines[0]?.selected.name ?? null,
  jurisdictions: merged.jMachines.map(({ selected, provenance }) => ({
    name: selected.name,
    jMachine: {
      position: selected.position ?? { x: 0, y: 600, z: 0 },
      capacity: 3,
      jHeight: Number(selected.height || 0),
      mempool: jurisdictionMempool(selected.name, selected.machine),
      provenance,
    },
  })),
});

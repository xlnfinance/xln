export type NetworkDeviceType = 'phone' | 'laptop' | 'server' | 'datacenter';
export type BroadcastDeviceStatus = 'healthy' | 'struggling' | 'pruned';

export type NetworkDeviceDefinition = Readonly<{
  type: NetworkDeviceType;
  count: number;
  capacityTps: number;
  label: string;
  shortLabel: string;
}>;

export type NetworkNode = Readonly<{
  id: string;
  type: NetworkDeviceType;
  capacityTps: number;
  x: number;
  y: number;
}>;

export type UnicastFrame = Readonly<{
  tps: number;
  broadcastAlive: number;
  broadcastPruned: number;
  broadcastCentralization: 'distributed' | 'edge-strained' | 'server-only';
  unicastAlive: number;
  settlementTps: 1;
  consensusBlock: number;
  consensusFill: number;
  insight: Readonly<{
    tone: 'stable' | 'warning' | 'failure';
    lead: string;
    detail: string;
  }>;
}>;

export const NETWORK_DEVICE_DEFINITIONS: readonly NetworkDeviceDefinition[] = [
  { type: 'phone', count: 70, capacityTps: 10, label: 'Phones', shortLabel: 'P' },
  { type: 'laptop', count: 24, capacityTps: 100, label: 'Laptops', shortLabel: 'L' },
  { type: 'server', count: 5, capacityTps: 1_000, label: 'Servers', shortLabel: 'S' },
  { type: 'datacenter', count: 1, capacityTps: 100_000, label: 'Datacenter', shortLabel: 'D' },
] as const;

const DEVICE_RADIUS: Readonly<Record<NetworkDeviceType, number>> = {
  phone: 252,
  laptop: 180,
  server: 106,
  datacenter: 22,
};

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export const NETWORK_NODES: readonly NetworkNode[] = NETWORK_DEVICE_DEFINITIONS.flatMap(
  (definition, definitionIndex) => Array.from({ length: definition.count }, (_, index) => {
    const angle = (index * GOLDEN_ANGLE) + (definitionIndex * 0.61);
    const radius = DEVICE_RADIUS[definition.type] * (0.86 + ((index % 7) * 0.022));
    return {
      id: `${definition.type}-${index}`,
      type: definition.type,
      capacityTps: definition.capacityTps,
      x: Math.round((300 + (Math.cos(angle) * radius)) * 10) / 10,
      y: Math.round((300 + (Math.sin(angle) * radius)) * 10) / 10,
    };
  }),
) as readonly NetworkNode[];

export const parseNetworkTps = (value: number): number => {
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new Error('UNICAST_TPS_INVALID');
  }
  return value;
};

const getBroadcastDeviceStatusForValidTps = (
  type: NetworkDeviceType,
  tps: number,
): BroadcastDeviceStatus => {
  if (tps <= 10) return 'healthy';
  if (tps <= 100) return type === 'phone' ? 'struggling' : 'healthy';
  return type === 'phone' || type === 'laptop' ? 'pruned' : 'healthy';
};

export const getBroadcastDeviceStatus = (
  type: NetworkDeviceType,
  tpsInput: number,
): BroadcastDeviceStatus => getBroadcastDeviceStatusForValidTps(type, parseNetworkTps(tpsInput));

export const deriveUnicastFrame = (tpsInput: number): UnicastFrame => {
  const tps = parseNetworkTps(tpsInput);
  const broadcastPruned = NETWORK_NODES.reduce(
    (count, node) => count + (getBroadcastDeviceStatusForValidTps(node.type, tps) === 'pruned' ? 1 : 0),
    0,
  );
  const broadcastAlive = NETWORK_NODES.length - broadcastPruned;
  const shared = {
    tps,
    broadcastAlive,
    broadcastPruned,
    unicastAlive: NETWORK_NODES.length,
    settlementTps: 1 as const,
    consensusBlock: Math.floor((tps - 1) / 10),
    consensusFill: ((tps - 1) % 10) + 1,
  };

  if (tps <= 10) {
    return {
      ...shared,
      broadcastCentralization: 'distributed',
      insight: {
        tone: 'stable',
        lead: 'Both architectures look healthy.',
        detail: 'Low throughput hides the cost of asking every participant to replay every transaction.',
      },
    };
  }

  if (tps <= 100) {
    return {
      ...shared,
      broadcastCentralization: 'edge-strained',
      insight: {
        tone: 'warning',
        lead: 'The broadcast edge starts to strain.',
        detail: 'Phones process more global traffic than their capacity; unicast participants still handle only their own route.',
      },
    };
  }

  return {
    ...shared,
    broadcastCentralization: 'server-only',
    insight: {
      tone: 'failure',
      lead: 'Broadcast collapses toward six operators.',
      detail: 'Phones and laptops prune global state. Unicast keeps all 100 participants online while settlement demand stays constant.',
    },
  };
};

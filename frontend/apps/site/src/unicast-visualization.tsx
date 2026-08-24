import {
  NETWORK_NODES,
  deriveUnicastFrame,
  getBroadcastDeviceStatus,
  type NetworkDeviceType,
} from './unicast-model';

type NetworkMode = 'broadcast' | 'unicast';

const NODE_RADIUS: Readonly<Record<NetworkDeviceType, number>> = {
  phone: 3.2,
  laptop: 5,
  server: 8,
  datacenter: 13,
};

const BROADCAST_ROUTES = NETWORK_NODES.filter((_, index) => index % 5 === 0);
const UNICAST_ROUTES = [
  [2, 73], [14, 62], [28, 80], [44, 91], [70, 96], [82, 98],
] as const;

function BroadcastRoutes({ tps }: Readonly<{ tps: number }>) {
  return BROADCAST_ROUTES.map((node) => (
    <line
      className={`network-route ${getBroadcastDeviceStatus(node.type, tps)}`}
      key={node.id}
      x1={node.x}
      y1={node.y}
      x2="300"
      y2="300"
    />
  ));
}

function UnicastRoutes() {
  return UNICAST_ROUTES.map(([fromIndex, toIndex], index) => {
    const from = NETWORK_NODES[fromIndex];
    const to = NETWORK_NODES[toIndex];
    if (!from || !to) throw new Error('UNICAST_ROUTE_NODE_MISSING');
    return <line className={`network-route route-${index}`} key={`${from.id}-${to.id}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />;
  });
}

function NetworkNodes({ mode, tps }: Readonly<{ mode: NetworkMode; tps: number }>) {
  return NETWORK_NODES.map((node) => {
    const status = mode === 'broadcast' ? getBroadcastDeviceStatus(node.type, tps) : 'healthy';
    return (
      <circle
        className={`network-node type-${node.type} status-${status}`}
        cx={node.x}
        cy={node.y}
        key={node.id}
        r={NODE_RADIUS[node.type]}
      />
    );
  });
}

function NetworkField({ mode, tps }: Readonly<{ mode: NetworkMode; tps: number }>) {
  return (
    <svg className={`network-field is-${mode}`} viewBox="0 0 600 600" role="img" aria-label={mode === 'broadcast' ? 'Broadcast sends global state to every participant' : 'Unicast keeps traffic on selected routes'}>
      <circle className="network-orbit orbit-one" cx="300" cy="300" r="108" />
      <circle className="network-orbit orbit-two" cx="300" cy="300" r="184" />
      <circle className="network-orbit orbit-three" cx="300" cy="300" r="258" />
      {mode === 'broadcast' ? <BroadcastRoutes tps={tps} /> : <UnicastRoutes />}
      <NetworkNodes mode={mode} tps={tps} />
      <g className="network-core"><circle cx="300" cy="300" r="31" /><text x="300" y="298">{mode === 'broadcast' ? 'GLOBAL' : 'J'}</text><text x="300" y="311">{mode === 'broadcast' ? 'BLOCK' : '1 TPS'}</text></g>
    </svg>
  );
}

function FrameMetric({ label, value, tone }: Readonly<{ label: string; value: string; tone: 'good' | 'bad' | 'neutral' }>) {
  return <div className={`frame-metric is-${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

export function NetworkComparison({ tps }: Readonly<{ tps: number }>) {
  const frame = deriveUnicastFrame(tps);
  return (
    <div className="network-comparison">
      <article className="network-system is-broadcast">
        <header><div><span>Broadcast · O(n)</span><h3>Everyone replays everything.</h3></div><b>{frame.broadcastCentralization.replace('-', ' ')}</b></header>
        <NetworkField mode="broadcast" tps={tps} />
        <footer><FrameMetric label="Participants online" value={`${frame.broadcastAlive} / 100`} tone={frame.broadcastPruned > 0 ? 'bad' : 'neutral'} /><FrameMetric label="Pruned edge" value={`${frame.broadcastPruned}`} tone={frame.broadcastPruned > 0 ? 'bad' : 'neutral'} /><FrameMetric label="Global block" value={`#${frame.consensusBlock} · ${frame.consensusFill}/10`} tone="neutral" /></footer>
      </article>
      <article className="network-system is-unicast">
        <header><div><span>xln unicast · O(1) per hop</span><h3>Only the route carries traffic.</h3></div><b>distributed</b></header>
        <NetworkField mode="unicast" tps={tps} />
        <footer><FrameMetric label="Participants online" value={`${frame.unicastAlive} / 100`} tone="good" /><FrameMetric label="Pruned edge" value="0" tone="good" /><FrameMetric label="J settlement" value={`${frame.settlementTps} TPS`} tone="good" /></footer>
      </article>
    </div>
  );
}

export function ComplexityPoster() {
  return (
    <div className="complexity-poster" aria-label="Broadcast complexity compared with unicast complexity">
      <header><span>Network load / routing scope</span><b>LIVE MODEL</b></header>
      <div className="complexity-row is-broadcast"><span>Broadcast</span><strong>O(n)</strong><small>Every transaction<br />to every node</small></div>
      <div className="complexity-row is-unicast"><span>Unicast</span><strong>O(1)</strong><small>One transaction<br />along one route</small></div>
      <footer><i /><span>1 → 1,000 transactions per second</span><i /></footer>
    </div>
  );
}

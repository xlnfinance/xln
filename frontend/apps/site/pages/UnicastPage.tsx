import { useState } from 'react';

import './unicast.css';

const nodes = (count: number): readonly number[] => Array.from({ length: count }, (_, index) => index);

const Topology = ({ count, broadcast }: Readonly<{ count: number; broadcast: boolean }>) => (
  <div className={broadcast ? 'topology broadcast' : 'topology unicast'} aria-label={broadcast ? 'Broadcast topology' : 'Unicast route'}>
    <svg viewBox="0 0 400 400" aria-hidden="true">
      {nodes(count).map(index => {
        const angle = index / count * Math.PI * 2;
        const x = 200 + Math.cos(angle) * 155;
        const y = 200 + Math.sin(angle) * 155;
        const active = broadcast || index === 0 || index === Math.floor(count / 3) || index === Math.floor(count * 2 / 3);
        return <g key={index}><line x1="200" y1="200" x2={x} y2={y} className={active ? 'active' : undefined} /><circle cx={x} cy={y} r="7" className={active ? 'active' : undefined} /></g>;
      })}
      <circle cx="200" cy="200" r="12" className="origin" />
    </svg>
  </div>
);

export default function UnicastPage() {
  const [count, setCount] = useState(24);
  const hops = 3;
  return (
    <div className="unicast-page">
      <header><p className="eyebrow">Scaling topology</p><h1>Why Broadcast Dies at Scale</h1><p>Every global participant does not need every local update.</p></header>
      <label className="node-control"><span>Network nodes</span><input type="range" min="8" max="72" value={count} onChange={event => setCount(Number(event.currentTarget.value))} /><strong>{count}</strong></label>
      <section className="topology-comparison">
        <article><div className="topology-heading"><span>Broadcast</span><strong>O(n) · {count - 1} deliveries</strong></div><Topology count={count} broadcast /></article>
        <article><div className="topology-heading"><span>Unicast</span><strong>O(1) per hop · {hops} deliveries</strong></div><Topology count={count} broadcast={false} /></article>
      </section>
      <section className="unicast-conclusion"><p>Global ledgers amplify local intent across the whole network.</p><p>xln routes one signed bilateral update across the path that needs it.</p></section>
    </div>
  );
}

import type { OpsGraphFrame } from '../data/ops-scenario-graph';

export const ScenarioGraph = ({ graph }: Readonly<{ graph: OpsGraphFrame | null }>) => {
  if (!graph) return <div className="ops-empty">No deterministic frame loaded.</div>;
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  return (
    <div className="ops-graph-wrap" data-testid="scenario-graph" data-height={graph.height}>
      <svg viewBox="0 0 100 64" role="img" aria-label={`Runtime graph at height ${graph.height}`}>
        {graph.edges.map(edge => { const from = nodes.get(edge.from); const to = nodes.get(edge.to); return from && to ? <line key={edge.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={edge.disputed ? 'is-disputed' : ''} /> : null; })}
        {graph.nodes.map(node => <g key={node.id} transform={`translate(${node.x} ${node.y})`} className={`${node.hub ? 'is-hub' : ''} ${node.disputed ? 'is-disputed' : ''}`}><circle r={node.hub ? 4.1 : 3.2}/><text y="7" textAnchor="middle">{node.label}</text><title>{`${node.label}: ${node.accounts} accounts, ${node.debts} debts`}</title></g>)}
      </svg>
      <footer><div><strong>{graph.title}</strong><span>{graph.description}</span></div><dl><div><dt>height</dt><dd>{graph.height}</dd></div><div><dt>entities</dt><dd>{graph.nodes.length}</dd></div><div><dt>accounts</dt><dd>{graph.edges.length}</dd></div><div><dt>disputes</dt><dd>{graph.disputes}</dd></div><div><dt>debts</dt><dd>{graph.debts}</dd></div></dl></footer>
    </div>
  );
};

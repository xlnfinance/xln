import { useExternalStore } from '../../../packages/react-adapters/use-external-store';
import { opsScenarioExternalStore } from '../data/ops-scenario-store';
import type { OpsPanelProps } from './dockview-react-lifecycle';

export const InspectorPanel = ({ active }: OpsPanelProps) => {
  const state = useExternalStore(opsScenarioExternalStore); const graph = state.graph;
  return <section className="ops-inspector" data-active={active}><p className="ops-eyebrow">runtime inspector</p><h2>{graph?.title ?? 'No frame'}</h2><dl className="ops-kv"><div><dt>scenario</dt><dd>{state.scenarioId}</dd></div><div><dt>frame</dt><dd>{state.frames.length ? `${state.index + 1}/${state.frames.length}` : '0/0'}</dd></div><div><dt>height</dt><dd>{graph?.height ?? 'n/a'}</dd></div><div><dt>entities</dt><dd>{graph?.nodes.length ?? 0}</dd></div><div><dt>accounts</dt><dd>{graph?.edges.length ?? 0}</dd></div><div><dt>disputes</dt><dd>{graph?.disputes ?? 0}</dd></div></dl>{graph ? <pre>{graph.nodes.map(node => `${node.label}\t${node.accounts} accounts\t${node.debts} debts`).join('\n')}</pre> : null}</section>;
};

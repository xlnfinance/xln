import { safeStringify } from '@xln/runtime/protocol/serialization';
import { useExternalStore } from '../../../packages/react-adapters/use-external-store';
import { opsScenarioExternalStore } from '../data/ops-scenario-store';
import type { OpsPanelProps } from './dockview-react-lifecycle';

export const ArchitectPanel = ({ active }: OpsPanelProps) => {
  const state = useExternalStore(opsScenarioExternalStore); const frame = state.frames[state.index];
  return <section className="ops-architect" data-active={active}><p className="ops-eyebrow">frame architect</p><h2>Deterministic evidence</h2><p>Read-only Runtime input/output inspection. Protocol state is never edited here.</p>{frame ? <pre>{safeStringify({ height: frame.state.height, runtimeInput: frame.runtimeInput, runtimeOutputs: frame.runtimeOutputs, logs: frame.logs ?? [], meta: frame.meta ?? null }, 2)}</pre> : <div className="ops-empty">Run a scenario to inspect its frame.</div>}</section>;
};

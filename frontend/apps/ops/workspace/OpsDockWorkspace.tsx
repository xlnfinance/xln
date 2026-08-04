import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { DockviewComponent, type SerializedDockview } from 'dockview';
import { ReactDockPanelRegistry, type OpsPanelProps } from './dockview-react-lifecycle';
import { InspectorPanel } from './InspectorPanel';
import { ArchitectPanel } from './ArchitectPanel';

const Graph3D = lazy(async () => ({ default: (await import('./Graph3DPanel')).Graph3DPanel }));
const GraphPanel = (props: OpsPanelProps) => <Suspense fallback={<div className="ops-loading">Loading 3D renderer…</div>}><Graph3D {...props}/></Suspense>;
const STORAGE_KEY = 'xln-ops-dock-layout-v1';

const addDefaultPanels = (dockview: DockviewComponent): void => {
  const graph = dockview.addPanel({ id: 'graph', component: 'graph', title: '3D graph' });
  dockview.addPanel({ id: 'inspector', component: 'inspector', title: 'Inspector', position: { referencePanel: 'graph', direction: 'right' }, initialWidth: 340 });
  dockview.addPanel({ id: 'architect', component: 'architect', title: 'Architect', position: { referencePanel: 'graph', direction: 'below' }, initialHeight: 260, inactive: true });
  graph.api.setActive();
};

export const OpsDockWorkspace = () => {
  const host = useRef<HTMLDivElement>(null); const dockRef = useRef<DockviewComponent | null>(null); const [layoutError, setLayoutError] = useState<string | null>(null); const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const element = host.current; if (!element) return;
    const registry = new ReactDockPanelRegistry({ graph: GraphPanel, inspector: InspectorPanel, architect: ArchitectPanel });
    const dockview = new DockviewComponent(element, { className: 'dockview-theme-dark', createComponent: options => registry.create(options.id, options.name) }); dockRef.current = dockview;
    dockview.layout(Math.max(1, element.clientWidth), Math.max(1, element.clientHeight));
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try { dockview.fromJSON(JSON.parse(saved) as SerializedDockview); }
      catch (error) { setLayoutError(error instanceof Error ? `OPS_DOCK_LAYOUT_INVALID:${error.message}` : 'OPS_DOCK_LAYOUT_INVALID'); dockview.clear(); addDefaultPanels(dockview); }
    } else addDefaultPanels(dockview);
    registry.setActive(dockview.activePanel?.id ?? null);
    const activeSubscription = dockview.onDidActivePanelChange(panel => registry.setActive(panel?.id ?? null));
    const layoutSubscription = dockview.onDidLayoutChange(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(dockview.toJSON())));
    const observer = new ResizeObserver(() => dockview.layout(Math.max(1, element.clientWidth), Math.max(1, element.clientHeight))); observer.observe(element);
    dockview.layout(Math.max(1, element.clientWidth), Math.max(1, element.clientHeight));
    return () => { observer.disconnect(); layoutSubscription.dispose(); activeSubscription.dispose(); dockview.dispose(); registry.dispose(); if (dockRef.current === dockview) dockRef.current = null; };
  }, [generation]);
  const reset = (): void => { localStorage.removeItem(STORAGE_KEY); setLayoutError(null); setGeneration(value => value + 1); };
  return <section className="ops-workspace" data-testid="ops-dock-workspace"><header><div><span>Dockview workspace</span><strong>React roots + suspended hidden loops</strong></div><button type="button" onClick={reset}>Reset layout</button></header>{layoutError ? <div className="ops-error" role="alert" data-testid="ops-layout-error">{layoutError}</div> : null}<p className="ops-mobile-workspace">The draggable 3D workspace requires a laptop-width viewport. The exact 2D scenario and playback controls remain available above.</p><div ref={host} className="ops-dock-host"/></section>;
};

import { createRoot, type Root } from 'react-dom/client';
import { createElement, type ComponentType } from 'react';
import type { GroupPanelPartInitParameters, IContentRenderer, Parameters as DockParameters } from 'dockview';

export type OpsPanelProps = Readonly<{ panelId: string; active: boolean; params: Readonly<DockParameters> }>;
export type OpsPanelComponent = ComponentType<OpsPanelProps>;
export type OpsRoot = Pick<Root, 'render' | 'unmount'>;
export type OpsRootFactory = (host: HTMLElement) => OpsRoot;

export class ReactDockPanelRenderer implements IContentRenderer {
  readonly element = document.createElement('div');
  private root: OpsRoot | null = null;
  private params: Readonly<DockParameters> = Object.freeze({});
  private active = false;
  private disposed = false;
  constructor(readonly panelId: string, private readonly component: OpsPanelComponent, private readonly create: OpsRootFactory, private readonly onDispose: (id: string) => void) {
    this.element.className = 'ops-dock-panel-host';
    this.element.dataset['panelId'] = panelId;
  }
  init(parameters: GroupPanelPartInitParameters): void {
    if (this.disposed) throw new Error(`OPS_DOCK_INIT_AFTER_DISPOSE:${this.panelId}`);
    if (this.root) throw new Error(`OPS_DOCK_ROOT_DUPLICATE:${this.panelId}`);
    this.params = Object.freeze({ ...parameters.params }); this.root = this.create(this.element); this.render();
  }
  update(event: Readonly<{ params: Partial<DockParameters> }>): void {
    if (this.disposed || !this.root) throw new Error(`OPS_DOCK_UPDATE_INACTIVE:${this.panelId}`);
    this.params = Object.freeze({ ...this.params, ...event.params }); this.render();
  }
  setActive(active: boolean): void { if (this.disposed || this.active === active) return; this.active = active; if (this.root) this.render(); }
  private render(): void { this.root?.render(createElement(this.component, { panelId: this.panelId, active: this.active, params: this.params })); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.root?.unmount(); this.root = null; this.element.replaceChildren(); this.onDispose(this.panelId);
  }
}

export class ReactDockPanelRegistry {
  private readonly renderers = new Map<string, ReactDockPanelRenderer>();
  constructor(private readonly components: Readonly<Record<string, OpsPanelComponent>>, private readonly rootFactory: OpsRootFactory = createRoot) {}
  create(panelId: string, componentName: string): ReactDockPanelRenderer {
    if (this.renderers.has(panelId)) throw new Error(`OPS_DOCK_PANEL_DUPLICATE:${panelId}`);
    const component = this.components[componentName]; if (!component) throw new Error(`OPS_DOCK_COMPONENT_UNKNOWN:${componentName}`);
    const renderer = new ReactDockPanelRenderer(panelId, component, this.rootFactory, id => this.renderers.delete(id)); this.renderers.set(panelId, renderer); return renderer;
  }
  setActive(panelId: string | null): void { for (const [id, renderer] of this.renderers) renderer.setActive(id === panelId); }
  dispose(): void { for (const renderer of [...this.renderers.values()]) renderer.dispose(); this.renderers.clear(); }
  get size(): number { return this.renderers.size; }
}

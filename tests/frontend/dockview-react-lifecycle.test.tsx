import { afterAll, beforeAll, expect, test } from 'bun:test';
import { ReactDockPanelRegistry, type OpsRoot } from '../../frontend/apps/ops/workspace/dockview-react-lifecycle';

const originalDocument = globalThis.document;
const elements: Array<Record<string, unknown>> = [];
beforeAll(() => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => { const element = { className: '', dataset: {}, replaceChildren: () => undefined }; elements.push(element); return element; } } });
});
afterAll(() => Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument }));

test('open, hide, close, and reopen owns exactly one root per panel lifetime', () => {
  const renders: string[] = []; const unmounts: string[] = []; let sequence = 0;
  const factory = (): OpsRoot => { const id = `root-${++sequence}`; return { render: () => renders.push(id), unmount: () => unmounts.push(id) }; };
  const registry = new ReactDockPanelRegistry({ graph: ({ active }) => active ? 'active' : 'stopped' }, factory);
  const first = registry.create('graph', 'graph');
  first.init({ params: {}, title: 'Graph' } as never);
  registry.setActive('graph'); registry.setActive('inspector'); registry.setActive('inspector');
  expect(registry.size).toBe(1); expect(renders).toEqual(['root-1', 'root-1', 'root-1']);
  first.dispose(); first.dispose(); expect(unmounts).toEqual(['root-1']); expect(registry.size).toBe(0);
  const reopened = registry.create('graph', 'graph'); reopened.init({ params: {}, title: 'Graph' } as never); registry.setActive('graph');
  expect(renders.slice(-2)).toEqual(['root-2', 'root-2']); registry.dispose(); expect(unmounts).toEqual(['root-1', 'root-2']);
});

test('duplicate root and duplicate live panel fail loudly', () => {
  const registry = new ReactDockPanelRegistry({ inspector: () => null }, () => ({ render: () => undefined, unmount: () => undefined }));
  const renderer = registry.create('inspector', 'inspector');
  expect(() => registry.create('inspector', 'inspector')).toThrow('OPS_DOCK_PANEL_DUPLICATE:inspector');
  renderer.init({ params: {}, title: 'Inspector' } as never);
  expect(() => renderer.init({ params: {}, title: 'Inspector' } as never)).toThrow('OPS_DOCK_ROOT_DUPLICATE:inspector'); registry.dispose();
});

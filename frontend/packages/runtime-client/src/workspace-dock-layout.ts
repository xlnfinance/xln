import type { AddPanelOptions, SerializedDockview } from 'dockview';

import { isUnknownRecord, parseJsonUnknown } from './boundary';

export const WORKSPACE_LAYOUT_STORAGE_KEY = 'xln-workspace-layout';
export const WORKSPACE_LAYOUT_VERSION = '1.0.0';
export const WORKSPACE_LAYOUT_SAVE_DELAY_MS = 500;

export type WorkspaceLayoutEnvelope = Readonly<{
  dockview: SerializedDockview;
  version?: string;
  timestamp?: string;
  camera?: unknown;
  settings?: unknown;
}>;

export type WorkspaceDockStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;
export type WorkspaceDockTimer = ReturnType<typeof globalThis.setTimeout> | number;
export type WorkspaceDockApi = Readonly<{
  addPanel: (options: AddPanelOptions) => unknown;
  fromJSON: (layout: SerializedDockview) => void;
  getPanel: (id: string) => unknown | undefined;
  onDidLayoutChange: (listener: () => void) => Readonly<{ dispose: () => void }>;
  toJSON: () => SerializedDockview;
}>;

export type WorkspaceDockDiagnostic = Readonly<{
  operation: 'restore' | 'save';
  cause: unknown;
}>;

export type WorkspaceDockSessionOptions = Readonly<{
  api: WorkspaceDockApi;
  panels: readonly AddPanelOptions[];
  storage: WorkspaceDockStorage | null;
  onDiagnostic: (diagnostic: WorkspaceDockDiagnostic) => void;
  now?: () => string;
  schedule?: (callback: () => void, delayMs: number) => WorkspaceDockTimer;
  cancel?: (timer: WorkspaceDockTimer) => void;
}>;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isOptional = <T>(value: unknown, guard: (candidate: unknown) => candidate is T): value is T | undefined =>
  value === undefined || guard(value);

const isString = (value: unknown): value is string => typeof value === 'string';
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

const hasValidConstraints = (value: Record<string, unknown>): boolean =>
  ['minimumWidth', 'maximumWidth', 'minimumHeight', 'maximumHeight']
    .every((key) => isOptional(value[key], isFiniteNumber));

const isGroupPanelState = (value: unknown): boolean => {
  if (!isUnknownRecord(value) || typeof value['id'] !== 'string' || !isStringArray(value['views'])) return false;
  if (!isOptional(value['activeView'], isString) || !isOptional(value['hideHeader'], isBoolean)) return false;
  if (!isOptional(value['skipSetActive'], isBoolean)) return false;
  if (!isOptional(value['initialWidth'], isFiniteNumber) || !isOptional(value['initialHeight'], isFiniteNumber)) return false;
  const locked = value['locked'];
  if (locked !== undefined && typeof locked !== 'boolean' && locked !== 'no-drop-target') return false;
  const constraints = value['constraints'];
  return constraints === undefined || (isUnknownRecord(constraints) && hasValidConstraints(constraints));
};

const isGridNode = (value: unknown): boolean => {
  if (!isUnknownRecord(value)) return false;
  if (!isOptional(value['size'], isFiniteNumber) || !isOptional(value['visible'], isBoolean)) return false;
  if (value['type'] === 'leaf') return isGroupPanelState(value['data']);
  if (value['type'] !== 'branch' || !Array.isArray(value['data'])) return false;
  return value['data'].every(isGridNode);
};

const isPanelState = (value: unknown): boolean => {
  if (!isUnknownRecord(value) || typeof value['id'] !== 'string' || !hasValidConstraints(value)) return false;
  if (!['contentComponent', 'tabComponent', 'title'].every((key) => isOptional(value[key], isString))) return false;
  const renderer = value['renderer'];
  if (renderer !== undefined && renderer !== 'onlyWhenVisible' && renderer !== 'always') return false;
  return value['params'] === undefined || isUnknownRecord(value['params']);
};

const isAnchoredBox = (value: unknown): boolean => {
  if (!isUnknownRecord(value) || !isFiniteNumber(value['width']) || !isFiniteNumber(value['height'])) return false;
  const vertical = isFiniteNumber(value['top']) || isFiniteNumber(value['bottom']);
  const horizontal = isFiniteNumber(value['left']) || isFiniteNumber(value['right']);
  return vertical && horizontal;
};

const isFloatingGroup = (value: unknown): boolean =>
  isUnknownRecord(value) && isGroupPanelState(value['data']) && isAnchoredBox(value['position']);

const isPopoutGroup = (value: unknown): boolean => {
  if (!isUnknownRecord(value) || !isGroupPanelState(value['data'])) return false;
  if (!isOptional(value['url'], isString) || !isOptional(value['gridReferenceGroup'], isString)) return false;
  const position = value['position'];
  return position === null || (
    isUnknownRecord(position) &&
    ['left', 'top', 'width', 'height'].every((key) => isFiniteNumber(position[key]))
  );
};

const isSerializedDockview = (value: unknown): value is SerializedDockview => {
  if (!isUnknownRecord(value) || !isUnknownRecord(value['grid']) || !isUnknownRecord(value['panels'])) return false;
  const grid = value['grid'];
  if (!isFiniteNumber(grid['height']) || !isFiniteNumber(grid['width'])) return false;
  if (grid['orientation'] !== 'HORIZONTAL' && grid['orientation'] !== 'VERTICAL') return false;
  if (!isUnknownRecord(grid['root']) || grid['root']['type'] !== 'branch' || !isGridNode(grid['root'])) return false;
  if (!Object.values(value['panels']).every(isPanelState)) return false;
  if (!isOptional(value['activeGroup'], isString)) return false;
  const floatingGroups = value['floatingGroups'];
  const popoutGroups = value['popoutGroups'];
  return (floatingGroups === undefined || (Array.isArray(floatingGroups) && floatingGroups.every(isFloatingGroup))) &&
    (popoutGroups === undefined || (Array.isArray(popoutGroups) && popoutGroups.every(isPopoutGroup)));
};

const requireDockviewLayout = (value: unknown): SerializedDockview => {
  if (!isSerializedDockview(value)) throw new Error('WORKSPACE_DOCK_LAYOUT_INVALID');
  return value;
};

export const parseWorkspaceLayoutEnvelope = (serialized: string): WorkspaceLayoutEnvelope => {
  const value = parseJsonUnknown(serialized, 'WORKSPACE_LAYOUT_JSON_INVALID');
  if (!isUnknownRecord(value)) throw new Error('WORKSPACE_LAYOUT_INVALID');
  const version = value['version'];
  const timestamp = value['timestamp'];
  if (version !== undefined && typeof version !== 'string') throw new Error('WORKSPACE_LAYOUT_VERSION_INVALID');
  if (timestamp !== undefined && typeof timestamp !== 'string') throw new Error('WORKSPACE_LAYOUT_TIMESTAMP_INVALID');
  return {
    dockview: requireDockviewLayout(value['dockview']),
    ...(version === undefined ? {} : { version }),
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(value['camera'] === undefined ? {} : { camera: value['camera'] }),
    ...(value['settings'] === undefined ? {} : { settings: value['settings'] }),
  };
};

export const serializeWorkspaceDockLayout = (
  dockview: SerializedDockview,
  timestamp: string,
): string => JSON.stringify({
  version: WORKSPACE_LAYOUT_VERSION,
  timestamp,
  dockview,
});

const ensurePanels = (api: WorkspaceDockApi, panels: readonly AddPanelOptions[]): void => {
  for (const panel of panels) {
    if (!api.getPanel(panel.id)) api.addPanel(panel);
  }
};

export const openWorkspaceDockSession = (
  options: WorkspaceDockSessionOptions,
): Readonly<{ dispose: () => void }> => {
  const {
    api,
    panels,
    storage,
    onDiagnostic,
    now = () => new Date().toISOString(),
    schedule = setTimeout,
    cancel = clearTimeout,
  } = options;
  let saveTimer: WorkspaceDockTimer | null = null;

  if (storage) {
    try {
      const savedLayout = storage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY);
      if (savedLayout) api.fromJSON(parseWorkspaceLayoutEnvelope(savedLayout).dockview);
    } catch (cause) {
      onDiagnostic({ operation: 'restore', cause });
      try {
        storage.removeItem(WORKSPACE_LAYOUT_STORAGE_KEY);
      } catch (removalCause) {
        onDiagnostic({ operation: 'restore', cause: removalCause });
      }
    }
  }
  ensurePanels(api, panels);

  const layoutDisposable = api.onDidLayoutChange(() => {
    if (!storage) return;
    if (saveTimer !== null) cancel(saveTimer);
    saveTimer = schedule(() => {
      saveTimer = null;
      try {
        storage.setItem(
          WORKSPACE_LAYOUT_STORAGE_KEY,
          serializeWorkspaceDockLayout(api.toJSON(), now()),
        );
      } catch (cause) {
        onDiagnostic({ operation: 'save', cause });
      }
    }, WORKSPACE_LAYOUT_SAVE_DELAY_MS);
  });

  return {
    dispose: () => {
      if (saveTimer !== null) cancel(saveTimer);
      saveTimer = null;
      layoutDisposable.dispose();
    },
  };
};

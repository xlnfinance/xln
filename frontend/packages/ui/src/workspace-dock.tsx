import { useCallback, useEffect, useRef, type FunctionComponent } from 'react';
import {
  DockviewReact,
  type AddPanelOptions,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type IDockviewReactProps,
} from 'dockview';
import 'dockview/dist/styles/dockview.css';

import {
  openWorkspaceDockSession,
  type WorkspaceDockDiagnostic,
  type WorkspaceDockStorage,
} from '../../runtime-client/src/workspace-dock-layout';

export type WorkspaceDockProps = Omit<IDockviewReactProps, 'components' | 'onReady'> & Readonly<{
  components: Record<string, FunctionComponent<IDockviewPanelProps>>;
  panels: readonly AddPanelOptions[];
  storage?: WorkspaceDockStorage | null;
  onDiagnostic: (diagnostic: WorkspaceDockDiagnostic) => void;
  onReady?: (event: DockviewReadyEvent) => void;
}>;

const browserStorage = (): WorkspaceDockStorage | null =>
  typeof window === 'undefined' ? null : window.localStorage;

export function WorkspaceDock({
  components,
  panels,
  storage,
  onDiagnostic,
  onReady,
  ...dockviewOptions
}: WorkspaceDockProps) {
  const sessionRef = useRef<Readonly<{ dispose: () => void }> | null>(null);
  const configurationRef = useRef({ panels, storage, onDiagnostic, onReady });
  configurationRef.current = { panels, storage, onDiagnostic, onReady };

  useEffect(() => () => {
    sessionRef.current?.dispose();
    sessionRef.current = null;
  }, []);

  const handleReady = useCallback((event: DockviewReadyEvent): void => {
    sessionRef.current?.dispose();
    const configuration = configurationRef.current;
    let resolvedStorage: WorkspaceDockStorage | null;
    try {
      resolvedStorage = configuration.storage === undefined ? browserStorage() : configuration.storage;
    } catch (cause) {
      configuration.onDiagnostic({ operation: 'restore', cause });
      resolvedStorage = null;
    }
    sessionRef.current = openWorkspaceDockSession({
      api: event.api,
      panels: configuration.panels,
      storage: resolvedStorage,
      onDiagnostic: configuration.onDiagnostic,
    });
    configuration.onReady?.(event);
  }, []);

  return (
    <DockviewReact
      {...dockviewOptions}
      components={components}
      onReady={handleReady}
    />
  );
}

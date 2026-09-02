import { readRuntimeAdapterStorageSnapshot } from '../../../packages/browser/src/runtime-adapter-session';
import { OpsEntityWorkspaceSource } from './ops-entity-workspace-source';

export const opsEntityWorkspaceSource = new OpsEntityWorkspaceSource(
  readRuntimeAdapterStorageSnapshot({ durable: localStorage, session: sessionStorage }),
);

let pagehideInstalled = false;

const stopOnPageHide = (event: PageTransitionEvent): void => {
  if (!event.persisted) opsEntityWorkspaceSource.stop();
};

export const startOpsEntityWorkspaceRuntime = (): void => {
  if (!pagehideInstalled) {
    window.addEventListener('pagehide', stopOnPageHide);
    pagehideInstalled = true;
  }
  void opsEntityWorkspaceSource.start();
};

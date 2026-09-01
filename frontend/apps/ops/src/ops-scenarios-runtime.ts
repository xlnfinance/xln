import { createRuntimeScenarioSource } from '../../../packages/browser/src/runtime-scenario-source';

export const opsScenariosSource = createRuntimeScenarioSource();

let started = false;
let unsubscribe: (() => void) | null = null;

const rememberPosition = (): void => {
  const snapshot = opsScenariosSource.getSnapshot();
  if (snapshot.status !== 'ready') return;
  const url = new URL(window.location.href);
  url.searchParams.set('scenario', snapshot.option.id);
  url.searchParams.set('frame', String(snapshot.currentFrame));
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
};

export const startOpsScenariosRuntime = (): void => {
  if (started) return;
  started = true;
  const url = new URL(window.location.href);
  unsubscribe = opsScenariosSource.subscribe(rememberPosition);
  void opsScenariosSource.startFromRouteRequest(
    url.searchParams.get('scenario') || url.hash.slice(1),
    url.searchParams.get('frame'),
  );
  window.addEventListener('pagehide', () => {
    unsubscribe?.();
    unsubscribe = null;
    opsScenariosSource.stop();
    started = false;
  }, { once: true });
};

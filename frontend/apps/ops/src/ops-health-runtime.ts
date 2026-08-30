import { createOpsHealthSource } from './ops-health-source';

export const opsHealthSource = createOpsHealthSource();

let started = false;
let pagehideInstalled = false;

const stopOnPageHide = (event: PageTransitionEvent): void => {
  if (!event.persisted) opsHealthSource.stop();
};

export const startOpsHealthRuntime = (): void => {
  if (!pagehideInstalled) {
    window.addEventListener('pagehide', stopOnPageHide);
    pagehideInstalled = true;
  }
  if (started) return;
  started = true;
  void opsHealthSource.start().catch((error: unknown) => {
    started = false;
    window.setTimeout(() => {
      throw error instanceof Error ? error : new Error(String(error));
    }, 0);
  });
};

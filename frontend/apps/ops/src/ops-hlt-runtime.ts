import { createOpsHltSource } from './ops-hlt-source';

export const opsHltSource = createOpsHltSource();

let started = false;
let pagehideInstalled = false;

const stopOnPageHide = (event: PageTransitionEvent): void => {
  if (!event.persisted) opsHltSource.stop();
};

export const startOpsHltRuntime = (): void => {
  if (!pagehideInstalled) {
    window.addEventListener('pagehide', stopOnPageHide);
    pagehideInstalled = true;
  }
  if (started) return;
  started = true;
  void opsHltSource.start();
};

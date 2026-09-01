import { createOpsQaSource } from './ops-qa-source';

export const opsQaSource = createOpsQaSource();

let started = false;
let pagehideInstalled = false;

const stopOnPageHide = (event: PageTransitionEvent): void => {
  if (!event.persisted) opsQaSource.stop();
};

export const startOpsQaRuntime = (): void => {
  if (!pagehideInstalled) {
    window.addEventListener('pagehide', stopOnPageHide);
    pagehideInstalled = true;
  }
  if (started) return;
  started = true;
  void opsQaSource.start();
};

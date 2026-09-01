import { createRuntimeScenarioSource } from '../../../packages/browser/src/runtime-scenario-source';

export const walletScenarioPreviewSource = createRuntimeScenarioSource();

let started = false;
let pagehideInstalled = false;

const stopOnPageHide = (event: PageTransitionEvent): void => {
  if (!event.persisted) {
    walletScenarioPreviewSource.stop();
    started = false;
  }
};

export const startWalletScenarioPreviewRuntime = (): void => {
  if (!pagehideInstalled) {
    window.addEventListener('pagehide', stopOnPageHide);
    pagehideInstalled = true;
  }
  if (started) return;
  started = true;
  void walletScenarioPreviewSource.startFromPreviewSearch(window.location.search);
};

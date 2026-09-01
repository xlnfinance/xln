import { createOpsAiSource } from './ops-ai-source';

export const opsAiSource = createOpsAiSource();

let started = false;

export const startOpsAiRuntime = (): void => {
  if (started) return;
  started = true;
  void opsAiSource.start();
  window.addEventListener('pagehide', () => {
    opsAiSource.stop();
    started = false;
  }, { once: true });
};

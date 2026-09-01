import { createOpsRunsSource } from './ops-runs-source';

export const opsRunsSource = createOpsRunsSource();

let started = false;

export const startOpsRunsRuntime = (): void => {
  if (started) return;
  started = true;
  void opsRunsSource.start();
  window.addEventListener('pagehide', () => {
    opsRunsSource.stop();
    started = false;
  }, { once: true });
};

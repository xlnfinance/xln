import { resolve } from 'node:path';

import { cleanupTestArtifactsBeforeRun } from '../runtime/scripts/test-artifact-cleanup';

export const PLAYWRIGHT_ARTIFACT_CLEANUP_CWD = resolve(import.meta.dir, '..');

export const runPlaywrightArtifactCleanup = (cwd = PLAYWRIGHT_ARTIFACT_CLEANUP_CWD): void => {
  cleanupTestArtifactsBeforeRun({
    cwd,
    reason: 'playwright',
    scope: 'e2e',
  });
};

export default async function globalSetup(): Promise<void> {
  runPlaywrightArtifactCleanup();
}

import { cleanupTestArtifactsBeforeRun } from '../runtime/scripts/test-artifact-cleanup';

export default async function globalSetup(): Promise<void> {
  cleanupTestArtifactsBeforeRun({
    reason: 'playwright',
    scope: 'e2e',
  });
}

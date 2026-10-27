import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('FormationPanel uses injected runtime projection instead of xlnEnvironment', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/onboarding/FormationPanel.svelte', 'utf8');

  expect(source).toContain('export let runtimeProjection: FormationRuntimeProjection');
  expect(source).toContain('emptyFormationRuntimeProjection');
  expect(source).toContain('registerActiveNumberedEntities(');
  expect(source).not.toContain('export let runtimeEnv');
  expect(source).not.toContain('$: env = runtimeEnv');
  expect(source).not.toContain('RuntimeReplica');
  expect(source).not.toContain('jReplicas');
  expect(source).not.toContain('eReplicas');
  expect(source).not.toContain('xlnEnvironment');
  expect(source).not.toContain('xlnFunctions');
});

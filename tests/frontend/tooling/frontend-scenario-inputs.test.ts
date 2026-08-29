import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { PREPARED_GENERATED_INPUTS } from '../../../frontend/config/generated-inputs';
import { prepareGeneratedInputs } from '../../../frontend/scripts/generated-inputs';
import { createScenarioAssetCatalog } from '../../../frontend/scripts/scenario-assets.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const temporaryRoots: string[] = [];

const createFrontendRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'xln-scenario-inputs-'));
  temporaryRoots.push(root);
  const frontendRoot = join(root, 'frontend');
  await mkdir(frontendRoot, { recursive: true });
  return frontendRoot;
};

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('ops scenario generated input', () => {
  test('projects executable scenario metadata into a deterministic data-only catalog', () => {
    const first = createScenarioAssetCatalog();
    const second = createScenarioAssetCatalog();
    const ids = first.scenarios.map(({ id }) => id);

    expect(second).toEqual(first);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(first.media).toEqual([]);
    for (const scenario of first.scenarios) {
      expect(Object.keys(scenario).sort()).toEqual(['description', 'id', 'name', 'tags']);
      expect(scenario.tags).toEqual([...scenario.tags].sort());
    }
  });

  test('publishes only the catalog JSON into the ops public directory', async () => {
    const frontendRoot = await createFrontendRoot();
    const definition = PREPARED_GENERATED_INPUTS.find(({ id }) => id === 'ops-scenario-assets');
    if (definition === undefined) throw new Error('TEST_SCENARIO_INPUT_DEFINITION_MISSING');

    const first = await prepareGeneratedInputs(REPOSITORY_ROOT, frontendRoot, ['ops'], [definition]);
    const firstManifest = await readFile(
      join(frontendRoot, '.artifacts/inputs/ops-scenario-assets/input-manifest.json'),
      'utf8',
    );
    const second = await prepareGeneratedInputs(REPOSITORY_ROOT, frontendRoot, ['ops'], [definition]);
    const secondManifest = await readFile(
      join(frontendRoot, '.artifacts/inputs/ops-scenario-assets/input-manifest.json'),
      'utf8',
    );
    const catalog = await readFile(
      join(frontendRoot, '.artifacts/public/ops/scenarios/catalog.json'),
      'utf8',
    );

    expect(second).toEqual(first);
    expect(secondManifest).toBe(firstManifest);
    expect(first[0]?.files.map(({ destinationPath }) => destinationPath)).toEqual([
      'scenarios/catalog.json',
    ]);
    expect(JSON.parse(catalog)).toEqual(createScenarioAssetCatalog());
    expect(catalog).not.toContain('.ts"');
    expect(catalog).not.toContain('"run"');
  });
});

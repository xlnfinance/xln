import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { safeStringify } from '../../core/protocol/serialization/index.ts';
import { SCENARIOS } from '../../core/scenarios/runner/catalog.ts';

const SCENARIO_CATALOG_SCHEMA_VERSION = 1;
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

const normalizeScenario = ({ id, name, description, tags }) => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`SCENARIO_CATALOG_ID_INVALID:${id}`);
  if (name.trim() === '') throw new Error(`SCENARIO_CATALOG_NAME_REQUIRED:${id}`);
  if (description.trim() === '') throw new Error(`SCENARIO_CATALOG_DESCRIPTION_REQUIRED:${id}`);
  const normalizedTags = [...tags].sort(compareText);
  if (normalizedTags.length === 0) throw new Error(`SCENARIO_CATALOG_TAGS_REQUIRED:${id}`);
  if (new Set(normalizedTags).size !== normalizedTags.length) {
    throw new Error(`SCENARIO_CATALOG_TAG_DUPLICATE:${id}`);
  }
  return { id, name, description, tags: normalizedTags };
};

export const createScenarioAssetCatalog = (scenarios = SCENARIOS) => {
  const entries = scenarios.map(normalizeScenario).sort(({ id: left }, { id: right }) => compareText(left, right));
  if (new Set(entries.map(({ id }) => id)).size !== entries.length) {
    throw new Error('SCENARIO_CATALOG_ID_DUPLICATE');
  }
  return {
    schemaVersion: SCENARIO_CATALOG_SCHEMA_VERSION,
    scenarios: entries,
    media: [],
  };
};

export const writeScenarioAssets = async (outputRoot) => {
  if (outputRoot.trim() === '') throw new Error('SCENARIO_ASSET_OUTPUT_REQUIRED');
  const outputPath = join(outputRoot, 'scenarios', 'catalog.json');
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${safeStringify(createScenarioAssetCatalog(), 2)}\n`);
  return outputPath;
};

if (import.meta.main) {
  const outputRoot = process.env['XLN_SCENARIO_ASSET_DIR'];
  if (outputRoot === undefined) throw new Error('SCENARIO_ASSET_OUTPUT_REQUIRED');
  await writeScenarioAssets(outputRoot);
}

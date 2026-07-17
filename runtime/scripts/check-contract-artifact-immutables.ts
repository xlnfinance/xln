import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const buildInfoDir = join(root, 'jurisdictions', 'artifacts', 'build-info');
const staticDir = join(root, 'frontend', 'static', 'contracts');
const buildInfos = readdirSync(buildInfoDir)
  .filter(filename => filename.endsWith('.json'))
  .sort()
  .map(filename => JSON.parse(readFileSync(join(buildInfoDir, filename), 'utf8')));

for (const contractName of ['Account', 'Depository', 'EntityProvider', 'DeltaTransformer']) {
  const artifact = JSON.parse(readFileSync(join(staticDir, `${contractName}.json`), 'utf8'));
  const matches = buildInfos.flatMap(buildInfo => {
    const compiled = buildInfo?.output?.contracts?.[artifact.sourceName]?.[artifact.contractName];
    const deployed = compiled?.evm?.deployedBytecode;
    return `0x${String(deployed?.object || '')}`.toLowerCase() ===
      String(artifact.deployedBytecode || '').toLowerCase()
      ? [deployed]
      : [];
  });
  if (matches.length === 0) {
    throw new Error(`CONTRACT_IMMUTABLE_PARITY_BUILD_INFO_MISSING:${contractName}`);
  }
  const embedded = JSON.stringify(artifact.immutableReferences);
  for (const deployed of matches) {
    if (JSON.stringify(deployed.immutableReferences) !== embedded) {
      throw new Error(`CONTRACT_IMMUTABLE_PARITY_MISMATCH:${contractName}`);
    }
  }
}

console.log('CONTRACT_IMMUTABLE_METADATA_PARITY_OK contracts=4');

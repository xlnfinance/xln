#!/usr/bin/env bun
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { produceDocsCatalog } from './scripts/docs-catalog-producer.ts';

const FRONTEND_DIR = dirname(fileURLToPath(import.meta.url));
const fromFrontend = (...parts) => resolve(FRONTEND_DIR, ...parts);
const REPO_ROOT = resolve(FRONTEND_DIR, '..');
const STATIC_DIR = resolve(FRONTEND_DIR, process.env.XLN_STATIC_DIR || 'static');
const fromStatic = (...parts) => resolve(STATIC_DIR, ...parts);

const files = [
  { src: '../jurisdictions/artifacts/contracts/Account.sol/Account.json', dest: 'static/contracts/Account.json' },
  { src: '../jurisdictions/artifacts/contracts/Depository.sol/Depository.json', dest: 'static/contracts/Depository.json' },
  { src: '../jurisdictions/artifacts/contracts/EntityProvider.sol/EntityProvider.json', dest: 'static/contracts/EntityProvider.json' },
  { src: '../jurisdictions/artifacts/contracts/HankoVerifier.sol/HankoVerifier.json', dest: 'static/contracts/HankoVerifier.json' },
  { src: '../jurisdictions/artifacts/contracts/DeltaTransformer.sol/DeltaTransformer.json', dest: 'static/contracts/DeltaTransformer.json' },
  { src: '../jurisdictions/artifacts/contracts/ERC20Mock.sol/ERC20Mock.json', dest: 'static/contracts/ERC20Mock.json' },
];

const buildInfoDir = fromFrontend('../jurisdictions/artifacts/build-info');

function validateImmutableReferences(value, artifact) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`CONTRACT_IMMUTABLE_REFERENCES_INVALID:${artifact.contractName}`);
  }
  const deployedBytes = (artifact.deployedBytecode.length - 2) / 2;
  const occupied = new Set();
  for (const [groupId, references] of Object.entries(value)) {
    if (!groupId || !Array.isArray(references) || references.length === 0) {
      throw new Error(`CONTRACT_IMMUTABLE_GROUP_INVALID:${artifact.contractName}:${groupId || 'missing'}`);
    }
    for (const reference of references) {
      const start = reference?.start;
      const length = reference?.length;
      if (
        !Number.isSafeInteger(start) || start < 0 ||
        !Number.isSafeInteger(length) || length <= 0 ||
        start + length > deployedBytes
      ) {
        throw new Error(`CONTRACT_IMMUTABLE_REFERENCE_INVALID:${artifact.contractName}:${groupId}`);
      }
      const location = `${start}:${length}`;
      if (occupied.has(location)) {
        throw new Error(`CONTRACT_IMMUTABLE_REFERENCE_DUPLICATE:${artifact.contractName}:${location}`);
      }
      occupied.add(location);
    }
  }
  return value;
}

function loadImmutableReferences(artifact) {
  if (!existsSync(buildInfoDir)) {
    throw new Error(`CONTRACT_BUILD_INFO_REQUIRED:${buildInfoDir}`);
  }
  const matching = [];
  for (const filename of readdirSync(buildInfoDir).filter(name => name.endsWith('.json')).sort()) {
    const buildInfo = JSON.parse(readFileSync(join(buildInfoDir, filename), 'utf8'));
    const compiled = buildInfo?.output?.contracts?.[artifact.sourceName]?.[artifact.contractName];
    if (!compiled) continue;
    const deployed = compiled?.evm?.deployedBytecode;
    if (`0x${String(deployed?.object || '')}`.toLowerCase() !== artifact.deployedBytecode.toLowerCase()) {
      continue;
    }
    matching.push(validateImmutableReferences(deployed.immutableReferences, artifact));
  }
  if (matching.length === 0) {
    throw new Error(`CONTRACT_BUILD_INFO_MATCH_MISSING:${artifact.sourceName}:${artifact.contractName}`);
  }
  const canonical = JSON.stringify(matching[0]);
  if (matching.some(candidate => JSON.stringify(candidate) !== canonical)) {
    throw new Error(`CONTRACT_BUILD_INFO_IMMUTABLE_AMBIGUOUS:${artifact.sourceName}:${artifact.contractName}`);
  }
  return matching[0];
}

function ensureDir(pathname) {
  mkdirSync(pathname, { recursive: true });
}

function buildBrainvaultWorker() {
  const source = resolve(REPO_ROOT, 'brainvault/worker-browser.ts');
  const output = fromStatic('brainvault-worker.js');
  const bunExecutable = String(process.env.XLN_BUN_EXECUTABLE || 'bun').trim();
  if (!existsSync(source)) throw new Error(`BRAINVAULT_WORKER_SOURCE_MISSING:${source}`);
  if (!bunExecutable) throw new Error('BRAINVAULT_WORKER_BUN_EXECUTABLE_MISSING');

  ensureDir(dirname(output));
  execFileSync(bunExecutable, ['build', source, '--outfile', output, '--target=browser', '--minify'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
  if (!existsSync(output) || statSync(output).size === 0) {
    throw new Error(`BRAINVAULT_WORKER_BUILD_FAILED:${output}`);
  }
  console.log(`[static] built brainvault worker (${statSync(output).size} bytes)`);
}

function cleanDir(pathname) {
  rmSync(pathname, { recursive: true, force: true });
  ensureDir(pathname);
}

function copyContracts(requireAllSources) {
  for (const file of files) {
    const srcPath = fromFrontend(file.src);
    const destPath = fromStatic(file.dest.replace(/^static\//, ''));

    if (!existsSync(srcPath)) {
      if (requireAllSources) {
        throw new Error(`CONTRACT_SOURCE_REQUIRED:${srcPath}. Build every contract before verifying bundled artifacts.`);
      }
      if (!existsSync(destPath) || statSync(destPath).size === 0) {
        throw new Error(`CONTRACT_STATIC_MISSING:${destPath}. Run ./scripts/sync-contract-artifacts.sh to generate it.`);
      }
      console.log(`[static] using bundled ${file.dest}; source artifact is not present`);
      continue;
    }

    const artifact = JSON.parse(readFileSync(srcPath, 'utf8'));
    artifact.immutableReferences = loadImmutableReferences(artifact);
    ensureDir(dirname(destPath));
    writeFileSync(destPath, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(`[static] copied ${file.src} -> ${file.dest}`);
  }
}

function copyScenarios() {
  const scenariosSrc = fromFrontend('../scenarios');
  const scenariosDest = fromStatic('scenarios');

  try {
    const stats = lstatSync(scenariosDest);
    if (stats.isSymbolicLink()) {
      console.log('[static] static/scenarios is symlinked; skipping copy');
      return;
    }
  } catch {
    // no-op
  }

  if (!existsSync(scenariosSrc)) return;
  ensureDir(scenariosDest);
  cpSync(scenariosSrc, scenariosDest, { recursive: true });
  console.log('[static] copied scenarios/ -> static/scenarios/');
}

function copyDocsAndManifest() {
  const docsSrc = fromFrontend('../docs');
  const docsDest = fromStatic('docs-catalog');
  const manifest = produceDocsCatalog(docsSrc, docsDest);
  console.log(`[static] copied docs/ -> static/docs-catalog/ (${manifest.counts.total} docs)`);
}

function generateLlmsStaticFiles() {
  const llmsPath = fromStatic('llms.txt');
  const rebuildRequested = process.env.XLN_REBUILD_LLMS === '1' || process.argv.includes('--rebuild-llms');
  const llmsVerbose = process.env.XLN_STATIC_VERBOSE === '1' || process.argv.includes('--verbose');
  const llmsContextPresent = existsSync(llmsPath) && statSync(llmsPath).size > 0;
  if (!rebuildRequested && llmsContextPresent) {
    console.log('[static] llms static context present; skipping rebuild (set XLN_REBUILD_LLMS=1 to refresh)');
    return;
  }

  const generatorPath = resolve(REPO_ROOT, 'scripts/debug/gpt.cjs');
  if (!existsSync(generatorPath)) {
    throw new Error(`LLMS_CONTEXT_GENERATOR_MISSING:${generatorPath}`);
  }

  try {
    execFileSync(process.execPath, [generatorPath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: llmsVerbose ? 'inherit' : 'pipe',
    });
  } catch (error) {
    if (!llmsVerbose && error && typeof error === 'object') {
      const output = [
        'stdout' in error ? String(error.stdout || '') : '',
        'stderr' in error ? String(error.stderr || '') : '',
      ].join('\n').trim();
      if (output) console.error(output.slice(-4000));
    }
    throw error;
  }

  if (!existsSync(llmsPath) || statSync(llmsPath).size === 0) {
    throw new Error(`LLMS_CONTEXT_GENERATION_FAILED:${llmsPath}`);
  }
  if (!llmsVerbose) {
    console.log('[static] llms static context regenerated (set XLN_STATIC_VERBOSE=1 for token breakdowns)');
  }
}

const contractsOnly = process.argv.includes('--contracts-only');
const requireAllContractSources = process.argv.includes('--require-all-contract-sources');

copyContracts(requireAllContractSources);
if (!contractsOnly) {
  buildBrainvaultWorker();
  copyScenarios();
  copyDocsAndManifest();
  generateLlmsStaticFiles();
}

console.log('[static] files copied for build');

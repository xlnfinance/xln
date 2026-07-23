#!/usr/bin/env bun

const { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(repoRoot, '..');
const contractsRoot = path.join(repoRoot, 'contracts');
const buildRoot = path.join(repoRoot, 'build-tron');
const artifactsRoot = path.join(buildRoot, 'contracts');
const quiet = process.argv.includes('--quiet');
const expectedCompiler = '0.8.25';

const sourceFiles = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const absolute = path.join(directory, entry.name);
  if (entry.isDirectory()) return sourceFiles(absolute);
  return entry.isFile() && entry.name.endsWith('.sol') ? [absolute] : [];
});

const sources = Object.fromEntries(sourceFiles(contractsRoot).map((absolute) => [
  path.relative(repoRoot, absolute).split(path.sep).join('/'),
  { content: readFileSync(absolute, 'utf8') },
]));
const importPattern = /import\s+(?:[^"']*?from\s+)?["']([^"']+)["']\s*;/g;
const pendingSources = Object.keys(sources);
for (let cursor = 0; cursor < pendingSources.length; cursor += 1) {
  const importingName = pendingSources[cursor];
  const importingSource = sources[importingName].content;
  for (const match of importingSource.matchAll(importPattern)) {
    const requested = match[1];
    const sourceName = requested.startsWith('.')
      ? path.posix.normalize(path.posix.join(path.posix.dirname(importingName), requested))
      : requested;
    if (sources[sourceName]) continue;
    const absolute = sourceName.startsWith('contracts/')
      ? path.resolve(repoRoot, sourceName)
      : path.resolve(workspaceRoot, 'node_modules', sourceName);
    if (!statSync(absolute).isFile()) throw new Error(`TRON_SOLC_IMPORT_NOT_FOUND:${sourceName}`);
    sources[sourceName] = { content: readFileSync(absolute, 'utf8') };
    pendingSources.push(sourceName);
  }
}
const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 1 },
    viaIR: true,
    evmVersion: 'shanghai',
    outputSelection: {
      '*': {
        '*': [
          'abi',
          'metadata',
          'evm.bytecode.object',
          'evm.bytecode.linkReferences',
          'evm.deployedBytecode.object',
          'evm.deployedBytecode.linkReferences',
        ],
      },
    },
  },
};
const solcCli = path.resolve(workspaceRoot, 'node_modules', 'solc', 'solc.js');
const versionResult = spawnSync('bun', [solcCli, '--version'], { encoding: 'utf8' });
const compilerVersion = versionResult.stdout.trim();
if (versionResult.status !== 0 || !compilerVersion.startsWith(`${expectedCompiler}+`)) {
  throw new Error(`TRON_SOLC_VERSION_MISMATCH:expected=${expectedCompiler}:actual=${compilerVersion || versionResult.stderr}`);
}
const compile = spawnSync('bun', [solcCli, '--standard-json'], {
  cwd: workspaceRoot,
  input: JSON.stringify(input),
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
});
if (compile.status !== 0) {
  throw new Error(`TRON_SOLC_PROCESS_FAILED:${compile.status}:${compile.stderr}`);
}
const outputStart = compile.stdout.indexOf('{');
if (outputStart < 0) throw new Error(`TRON_SOLC_OUTPUT_MISSING:${compile.stdout}:${compile.stderr}`);
const output = JSON.parse(compile.stdout.slice(outputStart));
const diagnostics = output.errors || [];
for (const diagnostic of diagnostics) {
  const line = diagnostic.formattedMessage || diagnostic.message;
  if (diagnostic.severity === 'error') console.error(line);
  else if (!quiet) console.warn(line);
}
if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
  throw new Error('TRON_SOLC_COMPILE_FAILED');
}

rmSync(artifactsRoot, { recursive: true, force: true });
mkdirSync(artifactsRoot, { recursive: true });
let artifactCount = 0;
for (const [sourceName, contracts] of Object.entries(output.contracts || {})) {
  for (const [contractName, contract] of Object.entries(contracts)) {
    const artifact = {
      contractName,
      sourceName,
      abi: contract.abi,
      bytecode: contract.evm.bytecode.object,
      deployedBytecode: contract.evm.deployedBytecode.object,
      linkReferences: contract.evm.bytecode.linkReferences,
      deployedLinkReferences: contract.evm.deployedBytecode.linkReferences,
      compiler: { name: 'solc', version: compilerVersion },
      metadata: contract.metadata,
    };
    writeFileSync(path.join(artifactsRoot, `${contractName}.json`), `${JSON.stringify(artifact, null, 2)}\n`);
    artifactCount += 1;
  }
}
if (!quiet) console.log(`[tron-compile] solc=${compilerVersion} artifacts=${artifactCount}`);

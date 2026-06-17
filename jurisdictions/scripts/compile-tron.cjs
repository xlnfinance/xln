#!/usr/bin/env bun

const path = require('path');

const Contracts = require('tronbox/build/components/WorkflowCompile');

const repoRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(repoRoot, '..');
const args = new Set(process.argv.slice(2));
const compilerVersion = process.env.TRON_SOLC_VERSION || '0.8.25';
const buildDirectory = path.join(repoRoot, 'build-tron');
const logger = args.has('--quiet') ? { log() {} } : console;

process.env.PATH = [
  path.join(repoRoot, 'node_modules', '.bin'),
  path.join(workspaceRoot, 'node_modules', '.bin'),
  process.env.PATH || '',
].filter(Boolean).join(path.delimiter);

const compile = () => new Promise((resolve, reject) => {
  Contracts.compile({
    working_directory: workspaceRoot,
    contracts_directory: path.join(repoRoot, 'contracts'),
    build_directory: buildDirectory,
    contracts_build_directory: path.join(buildDirectory, 'contracts'),
    build_info_directory: path.join(buildDirectory, 'build-info'),
    all: args.has('--all'),
    compileAll: args.has('--all'),
    quietWrite: args.has('--quiet'),
    logger,
    solc: {},
    compilers: {
      solc: {
        version: compilerVersion,
        settings: {
          optimizer: { enabled: true, runs: 1 },
          viaIR: true,
        },
      },
    },
    networks: {},
  }, (error, contracts) => {
    if (error) {
      reject(error);
      return;
    }
    resolve(contracts || []);
  });
});

compile()
  .then(() => {
    if (!args.has('--quiet')) {
      console.log(`[tron-compile] artifacts: ${path.relative(repoRoot, path.join(buildDirectory, 'contracts'))}`);
    }
  })
  .catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exit(1);
  });

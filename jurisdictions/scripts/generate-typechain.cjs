#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { glob, runTypeChain } = require('typechain');

async function main() {
  const cwd = path.resolve(__dirname, '..');
  const outDir = path.join(cwd, 'typechain-types');
  const artifactsDir = path.join(cwd, 'artifacts');
  const allFiles = glob(cwd, [`${artifactsDir}/!(build-info)/**/+([a-zA-Z0-9_]).json`]);

  if (allFiles.length === 0) {
    throw new Error(`TYPECHAIN_ARTIFACTS_MISSING: ${artifactsDir}`);
  }

  fs.rmSync(outDir, { recursive: true, force: true });

  const result = await runTypeChain({
    cwd,
    allFiles,
    filesToProcess: allFiles,
    outDir: 'typechain-types',
    target: 'ethers-v6',
    flags: {
      alwaysGenerateOverloads: false,
      discriminateTypes: false,
      tsNocheck: false,
      environment: 'hardhat',
      node16Modules: false,
    },
  });

  console.log(`[typechain] generated ${result.filesGenerated} files into ${outDir}`);
}

main().catch((error) => {
  console.error('[typechain] failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});

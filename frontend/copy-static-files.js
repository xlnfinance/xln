#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, cpSync } from 'fs';
import { join, resolve } from 'path';

// Copy necessary files to static folder before build
// Note: server.js is built directly to static/ now (no copy needed)
const files = [
  { src: '../jurisdictions.json', dest: 'static/jurisdictions.json' },
  { src: '../jurisdictions/artifacts/contracts/Account.sol/Account.json', dest: 'static/contracts/Account.json' },
  { src: '../jurisdictions/artifacts/contracts/Depository.sol/Depository.json', dest: 'static/contracts/Depository.json' },
  { src: '../jurisdictions/artifacts/contracts/EntityProvider.sol/EntityProvider.json', dest: 'static/contracts/EntityProvider.json' },
  { src: '../jurisdictions/artifacts/contracts/DeltaTransformer.sol/DeltaTransformer.json', dest: 'static/contracts/DeltaTransformer.json' },
  { src: '../jurisdictions/artifacts/contracts/ERC20Mock.sol/ERC20Mock.json', dest: 'static/contracts/ERC20Mock.json' }
];

for (const file of files) {
  const srcPath = resolve(file.src);
  const destPath = resolve(file.dest);

  if (existsSync(srcPath)) {
    // Create directory if needed
    const destDir = destPath.substring(0, destPath.lastIndexOf('/'));
    mkdirSync(destDir, { recursive: true });

    copyFileSync(srcPath, destPath);
    console.log(`✅ Copied ${file.src} → ${file.dest}`);
  } else {
    console.log(`⚠️ Source file not found: ${file.src}`);
  }
}

// Verify server.js exists (it should already be built there)
const serverJsPath = resolve('static/server.js');
if (existsSync(serverJsPath)) {
  console.log(`✅ static/server.js exists (built directly)`);
} else {
  console.log(`⚠️ static/server.js missing - run 'bun run build' first`);
}

// Copy scenarios directory (skip if already symlinked)
const scenariosSrc = resolve('../scenarios');
const scenariosDest = resolve('static/scenarios');
try {
  const { lstatSync } = await import('fs');
  const stats = lstatSync(scenariosDest);
  if (stats.isSymbolicLink()) {
    console.log(`ℹ️  static/scenarios is symlinked - skipping copy`);
  } else {
    throw new Error('Not a symlink');
  }
} catch {
  // Not symlinked, do the copy
  if (existsSync(scenariosSrc)) {
    mkdirSync(scenariosDest, { recursive: true });
    cpSync(scenariosSrc, scenariosDest, { recursive: true });
    console.log(`✅ Copied scenarios/ → static/scenarios/`);
  }
}

// Copy docs directory for DocsView
const docsSrc = resolve('../docs');
const docsDest = resolve('static/docs-static');
if (existsSync(docsSrc)) {
  mkdirSync(docsDest, { recursive: true });
  cpSync(docsSrc, docsDest, { recursive: true });
  console.log(`✅ Copied docs/ → static/docs-static/`);
} else {
  console.log(`⚠️ Source directory not found: ${docsSrc}`);
}

console.log('📦 Static files copied for build');

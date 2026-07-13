#!/usr/bin/env bun

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const docPath = resolve(root, 'docs/runtime/overview.md');
const source = readFileSync(docPath, 'utf8');

const runtimePaths = [...source.matchAll(/`(runtime\/[A-Za-z0-9_./-]+(?:\.ts|\/))`/g)]
  .map((match) => match[1]!);
const docLinks = [...source.matchAll(/\]\((\.\/[A-Za-z0-9_./-]+\.md)\)/g)]
  .map((match) => match[1]!);

if (runtimePaths.length < 20) {
  throw new Error(`RUNTIME_DOC_PATH_COVERAGE_TOO_SMALL:${runtimePaths.length}`);
}

const missingRuntimePaths = runtimePaths.filter((path) => !existsSync(resolve(root, path)));
const missingDocLinks = docLinks.filter((path) => !existsSync(resolve(dirname(docPath), path)));
const missing = [...missingRuntimePaths, ...missingDocLinks];

if (missing.length > 0) {
  throw new Error(`RUNTIME_DOC_PATH_MISSING:\n${missing.map((path) => `- ${path}`).join('\n')}`);
}

console.log(`RUNTIME_DOC_PATHS_OK runtime=${runtimePaths.length} docs=${docLinks.length}`);

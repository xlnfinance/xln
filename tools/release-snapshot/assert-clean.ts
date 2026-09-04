#!/usr/bin/env bun

import { resolve } from 'node:path';

import { assertCleanReleaseSource } from './source-policy.ts';

const root = resolve(process.argv[2] ?? process.cwd());
assertCleanReleaseSource(root);
console.log('XLN_RELEASE_SOURCE_CLEAN');

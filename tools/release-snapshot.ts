#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { collectSnapshot } from './release-snapshot/collect.ts';
import { writeManifest, writeReleaseMarkdown } from './release-snapshot/render.ts';
import { signReleaseSnapshot } from './release-snapshot/sign.ts';
import {
  assertCleanReleaseSource,
  assertReleaseSourcePublished,
  assertReleaseUnpublished,
  assertReleaseSigningConfigured,
  assertReleaseVersionMatchesSource,
} from './release-snapshot/source-policy.ts';
import type { ReleaseSnapshot } from './release-snapshot/types.ts';

type Args = {
  version: string;
  root: string;
  output: string;
  markdown: string;
  previous?: string;
  releasesDir: string;
  signingKeys?: string;
  board: string;
};

function usage(message?: string): never {
  if (message) console.error(message);
  console.error('Usage: bun tools/release-snapshot.ts --version=0.1.6 [--root=.] [--previous=docs/releases/data/0.1.5.json]');
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.+)$/);
    if (!match) usage(`Unknown argument: ${arg}`);
    values.set(match[1]!, match[2]!);
  }
  const version = values.get('version');
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) usage('A semantic --version is required.');
  const releasesDir = resolve(values.get('releases-dir') || 'docs/releases');
  return {
    version,
    root: resolve(values.get('root') || '.'),
    output: resolve(values.get('output') || `${releasesDir}/data/${version}.json`),
    markdown: resolve(values.get('markdown') || `${releasesDir}/${version}.md`),
    previous: values.get('previous') ? resolve(values.get('previous')!) : undefined,
    releasesDir,
    signingKeys: values.get('signing-keys') ? resolve(values.get('signing-keys')!) : undefined,
    board: resolve(values.get('board') || 'foundation-release-board.json'),
  };
}

const args = parseArgs(process.argv.slice(2));
assertCleanReleaseSource(args.root);
assertReleaseSourcePublished(args.root);
assertReleaseVersionMatchesSource(args.root, args.version);
assertReleaseSigningConfigured(args.version, args.signingKeys);
assertReleaseUnpublished(args.root, args.version, args.output);
const previous = args.previous
  ? JSON.parse(readFileSync(args.previous, 'utf8')) as ReleaseSnapshot
  : undefined;
const snapshot = collectSnapshot({ root: args.root, version: args.version, previous });
if (args.signingKeys) signReleaseSnapshot(snapshot, args.board, args.signingKeys);

mkdirSync(dirname(args.output), { recursive: true });
mkdirSync(dirname(args.markdown), { recursive: true });
writeFileSync(args.output, `${JSON.stringify(snapshot, null, 2)}\n`);
writeReleaseMarkdown(args.markdown, snapshot);
writeManifest(args.releasesDir);

console.log([
  `release ${snapshot.release.version}`,
  `${snapshot.repository.metrics.files} files`,
  `${snapshot.repository.metrics.code} LOC`,
  `${snapshot.repository.metrics.complexity} complexity`,
  `${snapshot.excluded.length} excluded`,
  snapshot.attestation ? `hanko ${snapshot.attestation.signerCount}/${snapshot.attestation.board.members.length} verified` : 'unsigned',
].join(' | '));

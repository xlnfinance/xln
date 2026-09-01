/**
 * Slim a native replay recording down to what rscore-runtime-replay actually
 * reads: featurePolicy, the recording height range, and the journal_tail
 * frame expectations. Same JSON shape as the full recording, so the Rust
 * side needs no changes; the multi-hundred-MB input/state bundles that the
 * replay never touches (inputs come from the WAL) are dropped.
 *
 * Usage: bun slim-recording.ts <recording.json> [out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { safeStringify } from '../../../../protocol/serialization';

const [, , input, outputArg] = process.argv;
if (!input) throw new Error('USAGE: slim-recording.ts <recording.json> [out.json]');
const output = outputArg ?? input.replace(/\.json$/, '.slim.json');

const FRAME_FIELDS = [
  'height',
  'timestamp',
  'postStateHash',
  'runtimeStateHash',
  'runtimeOutputCount',
  'runtimeOutputsDigest',
] as const;

const root = JSON.parse(readFileSync(input, 'utf8')) as Record<string, unknown>;
const recording = root['recording'] as Record<string, unknown>;
const bundles = recording['bundles'] as { kind?: string; frames?: Record<string, unknown>[] }[];
const slim = {
  featurePolicy: root['featurePolicy'],
  authorityEvidence: root['authorityEvidence'],
  recording: {
    ...recording,
    bundles: bundles
      .filter(bundle => bundle.kind === 'journal_tail')
      .map(bundle => ({
        kind: 'journal_tail',
        frames: (bundle.frames ?? []).map(frame =>
          Object.fromEntries(FRAME_FIELDS.flatMap(name => (name in frame ? [[name, frame[name]]] : []))),
        ),
      })),
  },
};
writeFileSync(output, safeStringify(slim));
console.log(safeStringify({ output, bundles: slim.recording.bundles.length }));

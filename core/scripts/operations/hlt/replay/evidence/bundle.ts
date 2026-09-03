/**
 * Portable evidence bundle. The recorder's work directory already holds the
 * recording, the closed hub WAL (prod-mesh/h1/<runtimeId>-wal), the mesh seed
 * (secrets/mesh-root.seed) and the smoke reports; this adds PROVENANCE.json
 * (which code, which command, which artifact) and a README so the folder can be
 * archived and replayed by anyone with the repository at that commit.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { safeStringify } from '../../../../../protocol/serialization';
import { readHltHubRecordingManifest } from '../recording';

const git = (args: readonly string[]): string => {
  try {
    return execFileSync('git', [...args], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

export const fileSha256 = async (path: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `0x${hash.digest('hex')}`;
};

const fileSha256Sync = (path: string): string => `0x${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

export type EvidenceBundleProvenance = Readonly<{
  schema: 'xln-hlt-evidence-bundle-v1';
  createdAt: string;
  startedAt: string;
  git: Readonly<{ sha: string; branch: string; dirtyFiles: readonly string[] }>;
  toolchain: Readonly<{ bun: string; platform: string; arch: string }>;
  command: string;
  knobs: Readonly<Record<string, string>>;
  recording: Readonly<{
    file: string;
    bytes: number;
    sha256: string;
    manifestHash: string;
    runtimeId: string;
    frames: number;
    entityInputs: number;
    outboxEnvelopes: number;
    heights: Readonly<{ first: number; last: number }>;
  }>;
  hubWalDir: string;
  meshSeedFile: string;
  replays: readonly string[];
}>;

/** Write PROVENANCE.json + README.md into the bundle after a recording. */
export const writeEvidenceBundleProvenance = (options: Readonly<{
  bundleDir: string;
  recordingPath: string;
  startedAt: string;
  knobs: Readonly<Record<string, string>>;
}>): EvidenceBundleProvenance => {
  const artifact = readHltHubRecordingManifest(options.recordingPath);
  const heights = artifact.authorityEvidence.expectations.runtimeFrames.map(frame => frame.height);
  const provenance: EvidenceBundleProvenance = {
    schema: 'xln-hlt-evidence-bundle-v1',
    createdAt: new Date().toISOString(),
    startedAt: options.startedAt,
    git: {
      sha: git(['rev-parse', 'HEAD']),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      dirtyFiles: git(['status', '--short', '--untracked-files=no']).split('\n').filter(line => line.trim()),
    },
    toolchain: { bun: Bun.version, platform: process.platform, arch: process.arch },
    command: process.argv.slice(1).map(part => basename(part)).join(' '),
    knobs: options.knobs,
    recording: {
      file: basename(options.recordingPath),
      bytes: statSync(options.recordingPath).size,
      sha256: fileSha256Sync(options.recordingPath),
      manifestHash: artifact.runtimeRecordingManifestHash,
      runtimeId: artifact.tail.runtimeId,
      frames: artifact.totals.runtimeFrames,
      entityInputs: artifact.totals.runtimeEntityInputs,
      outboxEnvelopes: artifact.totals.outboxEnvelopes,
      heights: { first: Math.min(...heights), last: Math.max(...heights) },
    },
    hubWalDir: artifact.source.hubWalDir,
    meshSeedFile: artifact.source.meshSeedFile,
    replays: [],
  };
  writeFileSync(join(options.bundleDir, 'PROVENANCE.json'), `${safeStringify(provenance, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(options.bundleDir, 'README.md'), [
    '# XLN HLT evidence bundle',
    '',
    `Recorded ${provenance.createdAt} at commit ${provenance.git.sha} (${provenance.git.branch}),`,
    `${provenance.git.dirtyFiles.length} dirty tracked files.`,
    '',
    `- recording: ${provenance.recording.file} (${provenance.recording.bytes} bytes, sha256 ${provenance.recording.sha256})`,
    `- frames ${provenance.recording.frames} (heights ${provenance.recording.heights.first}-${provenance.recording.heights.last}), entityInputs ${provenance.recording.entityInputs}`,
    `- hub WAL: ${provenance.hubWalDir}; mesh seed: ${provenance.meshSeedFile}`,
    `- load: ${Object.entries(provenance.knobs).map(([key, value]) => `${key}=${value}`).join(' ')}`,
    '',
    'Replay the six-way TS/Rust parity gate in two bounded stages:',
    '',
    '```bash',
    `bun tools/stand-lock.ts run --reason evidence-ts-replay -- bun run rscore:evidence:replay --recording <bundle>/${provenance.recording.file} --ts-only --ts-report-dir <bundle>/replays/ts-stage`,
    `bun tools/stand-lock.ts run --reason evidence-rust-replay -- bun run rscore:evidence:replay --recording <bundle>/${provenance.recording.file} --resume-ts-report-dir <bundle>/replays/ts-stage`,
    '```',
    '',
  ].join('\n'), { mode: 0o600 });
  return provenance;
};

/** Append a replay report into <bundle>/replays and list it in PROVENANCE.json. */
export const publishEvidenceBundleReplay = (
  recordingPath: string,
  name: string,
  report: unknown,
): string | null => {
  const bundleDir = dirname(recordingPath);
  const provenancePath = join(bundleDir, 'PROVENANCE.json');
  if (!existsSync(provenancePath)) return null;
  const replays = join(bundleDir, 'replays');
  mkdirSync(replays, { recursive: true, mode: 0o700 });
  const path = join(replays, name);
  writeFileSync(path, `${safeStringify(report, 2)}\n`, { mode: 0o600 });
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8')) as EvidenceBundleProvenance;
  const next = { ...provenance, replays: [...provenance.replays, join('replays', name)] };
  writeFileSync(provenancePath, `${safeStringify(next, 2)}\n`, { mode: 0o600 });
  return path;
};

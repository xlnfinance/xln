import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ethers } from 'ethers';
import { decodeHankoEnvelope } from '../../runtime/hanko/codec.ts';

import {
  buildReleaseHanko,
  computeCodeSnapshotRoot,
  computeReleaseEnvelopeHash,
  createFoundationReleaseBoard,
  CURRENT_XLN_RELEASE_VERSION,
  isCanonicalFoundationBoard,
  signReleaseEnvelope,
  verifyReleaseAttestation,
  verifyReleaseManifestEntry,
  verifyReleaseManifestPolicy,
  verifyReleaseManifestSnapshotBinding,
  verifyReleaseSnapshot,
  type ReleaseEnvelope,
} from '../../frontend/src/lib/releases/release-signature.ts';
import type { ReleaseManifest, ReleaseSnapshot } from '../../tools/release-snapshot/types.ts';
import { releaseSnapshotExclusion } from '../../tools/release-snapshot/collect.ts';
import { RELEASE_EDITORIAL_NOTICE, writeReleaseMarkdown } from '../../tools/release-snapshot/render.ts';

const ROOT = resolve(import.meta.dir, '../..');
const RELEASE_017 = JSON.parse(readFileSync(resolve(ROOT, 'docs/releases/data/0.1.7.json'), 'utf8')) as ReleaseSnapshot;
const RELEASE_016 = JSON.parse(readFileSync(resolve(ROOT, 'docs/releases/data/0.1.6.json'), 'utf8')) as ReleaseSnapshot;
const MANIFEST = JSON.parse(readFileSync(resolve(ROOT, 'docs/releases/manifest.json'), 'utf8')) as ReleaseManifest;
const MANIFEST_017 = MANIFEST.releases.find((release) => release.version === '0.1.7')!;

const PRIVATE_KEYS = [
  `0x${'01'.padStart(64, '0')}`,
  `0x${'02'.padStart(64, '0')}`,
  `0x${'03'.padStart(64, '0')}`,
];
const ADDRESSES = PRIVATE_KEYS.map((key) => ethers.computeAddress(new ethers.SigningKey(key).publicKey));
const ENVELOPE: ReleaseEnvelope = {
  version: '0.1.7',
  sourceCommit: '0123456789abcdef0123456789abcdef01234567',
  codeSnapshotRoot: `0x${'11'.repeat(32)}`,
  frozenCoreRoot: `0x${'22'.repeat(32)}`,
  generatedAt: '2026-07-11T00:00:00.000Z',
};

describe('Foundation release Hanko', () => {
  test('produces an EntityProvider-compatible 2-of-3 lazy entity proof', () => {
    const board = createFoundationReleaseBoard(ADDRESSES, 2);
    const attestation = signReleaseEnvelope(ENVELOPE, board, PRIVATE_KEYS);
    const decoded = decodeHankoEnvelope(attestation.hanko);

    expect(board.entityId).toBe(board.boardHash);
    expect(attestation.signerCount).toBe(2);
    expect(decoded.placeholders).toHaveLength(1);
    expect(verifyReleaseAttestation(attestation, board)).toBe(true);
  });

  test('rejects envelope and Hanko tampering', () => {
    const board = createFoundationReleaseBoard(ADDRESSES, 2);
    const attestation = signReleaseEnvelope(ENVELOPE, board, PRIVATE_KEYS);
    expect(verifyReleaseAttestation({ ...attestation, envelope: { ...ENVELOPE, version: '0.1.8' } }, board)).toBe(false);
    expect(verifyReleaseAttestation({ ...attestation, hanko: `${attestation.hanko.slice(0, -2)}00` }, board)).toBe(false);
  });

  test('hash and packed Hanko are deterministic for fixed inputs', () => {
    const board = createFoundationReleaseBoard(ADDRESSES, 2);
    const hash = computeReleaseEnvelopeHash(ENVELOPE);
    expect(buildReleaseHanko(hash, board, PRIVATE_KEYS)).toEqual(buildReleaseHanko(hash, board, PRIVATE_KEYS));
  });

  test('includes the canonical Bun lockfile in the signed code root', () => {
    expect(releaseSnapshotExclusion('bun.lock')).toBeNull();
    const base = [{ path: 'runtime/runtime.ts', sha256: '11'.repeat(32) }];
    const withLock = [...base, { path: 'bun.lock', sha256: '22'.repeat(32) }];
    const changedLock = [...base, { path: 'bun.lock', sha256: '33'.repeat(32) }];
    expect(computeCodeSnapshotRoot(withLock)).not.toBe(computeCodeSnapshotRoot(base));
    expect(computeCodeSnapshotRoot(changedLock)).not.toBe(computeCodeSnapshotRoot(withLock));
  });

  test('pins the checked-in Foundation board and rejects an attacker-owned 2-of-3 board', () => {
    const attackerBoard = createFoundationReleaseBoard(ADDRESSES, 2);
    const attackerAttestation = signReleaseEnvelope(ENVELOPE, attackerBoard, PRIVATE_KEYS);

    expect(isCanonicalFoundationBoard(attackerBoard)).toBe(false);
    expect(verifyReleaseAttestation(attackerAttestation)).toBe(false);
    expect(verifyReleaseAttestation(attackerAttestation, attackerBoard)).toBe(true);
    expect(verifyReleaseAttestation(RELEASE_017.attestation!)).toBe(false);

    const mismatchedEntity = structuredClone(RELEASE_017.attestation!);
    mismatchedEntity.board.entityId = `0x${'77'.repeat(32)}`;
    expect(verifyReleaseAttestation(mismatchedEntity)).toBe(false);
  });

  test('binds the signed envelope to snapshot claims and recomputes the file Merkle root', () => {
    expect(computeCodeSnapshotRoot(RELEASE_017.files)).toBe(RELEASE_017.repository.merkleRoot);
    expect(verifyReleaseSnapshot(RELEASE_017)).toBe(true);

    const mutations: Array<(snapshot: ReleaseSnapshot) => void> = [
      (snapshot) => { snapshot.release.version = '0.1.8'; },
      (snapshot) => { snapshot.release.tag = 'v9.9.9'; },
      (snapshot) => { snapshot.release.sourceCommit = 'f'.repeat(40); },
      (snapshot) => { snapshot.release.generatedAt = '2026-07-12T00:00:00.000Z'; },
      (snapshot) => { snapshot.repository.merkleRoot = `0x${'44'.repeat(32)}`; },
      (snapshot) => { snapshot.frozenCore!.rootHash = `0x${'55'.repeat(32)}`; },
      (snapshot) => { snapshot.files[0]!.sha256 = '66'.repeat(32); },
    ];
    for (const mutate of mutations) {
      const tampered = structuredClone(RELEASE_017);
      mutate(tampered);
      expect(verifyReleaseSnapshot(tampered)).toBe(false);
    }
  });

  test('keeps pre-v2 Hanko immutable but unverified and requires canonical v2 from 0.1.9', () => {
    expect(CURRENT_XLN_RELEASE_VERSION).toBe(readFileSync(resolve(ROOT, 'VERSION'), 'utf8').trim());
    expect(verifyReleaseManifestPolicy(MANIFEST)).toBe(true);
    expect(verifyReleaseManifestEntry(MANIFEST_017)).toBe(true);
    expect(verifyReleaseManifestSnapshotBinding(MANIFEST_017, RELEASE_017)).toBe(true);
    expect(verifyReleaseSnapshot(RELEASE_016)).toBe(true);
    const manifest016 = MANIFEST.releases.find((release) => release.version === '0.1.6')!;
    expect(verifyReleaseManifestEntry(manifest016)).toBe(true);
    expect(verifyReleaseManifestSnapshotBinding(manifest016, RELEASE_016)).toBe(true);

    const unsignedSnapshot = structuredClone(RELEASE_017);
    delete unsignedSnapshot.attestation;
    expect(verifyReleaseSnapshot(unsignedSnapshot)).toBe(false);
    const unsignedManifest = structuredClone(MANIFEST_017);
    delete unsignedManifest.attestation;
    expect(verifyReleaseManifestEntry(unsignedManifest)).toBe(false);

    const rolledBack = structuredClone(MANIFEST);
    rolledBack.latest = '0.1.6';
    expect(verifyReleaseManifestPolicy(rolledBack)).toBe(false);
    const stripped = structuredClone(MANIFEST);
    stripped.releases = stripped.releases.filter((release) => release.version !== '0.1.7');
    stripped.latest = '0.1.6';
    expect(verifyReleaseManifestPolicy(stripped)).toBe(false);

    const mutations: Array<(entry: typeof MANIFEST_017) => void> = [
      (entry) => { entry.version = '0.1.8'; },
      (entry) => { entry.tag = 'release-0.1.7'; },
      (entry) => { entry.markdown = '/docs-catalog/releases/0.1.6.md'; },
      (entry) => { entry.snapshot = '/docs-catalog/releases/data/0.1.6.json'; },
      (entry) => { entry.sourceCommit = 'a'.repeat(40); },
      (entry) => { entry.generatedAt = '2026-07-12T00:00:00.000Z'; },
      (entry) => { entry.codeSnapshotRoot = `0x${'88'.repeat(32)}`; },
      (entry) => { entry.frozenCore!.rootHash = `0x${'99'.repeat(32)}`; },
    ];
    for (const mutate of mutations) {
      const tampered = structuredClone(MANIFEST_017);
      mutate(tampered);
      expect(verifyReleaseManifestEntry(tampered)).toBe(false);
      expect(verifyReleaseManifestSnapshotBinding(tampered, RELEASE_017)).toBe(false);
    }

    const manifestMetricTamper = structuredClone(MANIFEST_017);
    manifestMetricTamper.metrics.code += 1;
    expect(verifyReleaseManifestEntry(manifestMetricTamper)).toBe(true);
    expect(verifyReleaseManifestSnapshotBinding(manifestMetricTamper, RELEASE_017)).toBe(false);

    const manifestModuleTamper = structuredClone(MANIFEST_017);
    manifestModuleTamper.modules.runtime!.code += 1;
    expect(verifyReleaseManifestSnapshotBinding(manifestModuleTamper, RELEASE_017)).toBe(false);

    const snapshotMetricTamper = structuredClone(RELEASE_017);
    snapshotMetricTamper.repository.metrics.code += 1;
    snapshotMetricTamper.tree.metrics.code += 1;
    expect(verifyReleaseSnapshot(snapshotMetricTamper)).toBe(true);
    expect(verifyReleaseManifestSnapshotBinding(MANIFEST_017, snapshotMetricTamper)).toBe(false);

    const snapshotModuleTamper = structuredClone(RELEASE_017);
    snapshotModuleTamper.tree.children!.find((node) => node.path === 'runtime')!.metrics.code += 1;
    expect(verifyReleaseSnapshot(snapshotModuleTamper)).toBe(true);
    expect(verifyReleaseManifestSnapshotBinding(MANIFEST_017, snapshotModuleTamper)).toBe(false);
  });

  test('labels mutable release notes outside the verified snapshot boundary', () => {
    const directory = mkdtempSync(join(tmpdir(), 'xln-release-notes-'));
    const markdownPath = join(directory, '0.1.7.md');
    try {
      expect(readFileSync(resolve(ROOT, 'docs/releases/0.1.7.md'), 'utf8')).toContain(RELEASE_EDITORIAL_NOTICE);
      const releasesView = readFileSync(resolve(ROOT, 'frontend/src/lib/components/Releases/ReleasesView.svelte'), 'utf8');
      expect(releasesView).toContain('Foundation code root verified');
      expect(releasesView).not.toContain('Foundation verified');

      writeReleaseMarkdown(markdownPath, RELEASE_017);
      const edited = readFileSync(markdownPath, 'utf8').replace('Release notes pending.', 'Editorial copy changed later.');
      writeFileSync(markdownPath, edited);
      writeReleaseMarkdown(markdownPath, RELEASE_017);

      const rendered = readFileSync(markdownPath, 'utf8');
      expect(rendered).toContain(RELEASE_EDITORIAL_NOTICE);
      expect(rendered.match(/release-editorial-notice:start/g)).toHaveLength(1);
      expect(rendered).toContain('Editorial copy changed later.');
      expect(rendered.indexOf(RELEASE_EDITORIAL_NOTICE)).toBeLessThan(rendered.indexOf('## Release Notes'));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects replay below the current build when the newest signed release is removed', () => {
    const board = createFoundationReleaseBoard(ADDRESSES, 2);
    const release = (version: string, generatedAt: string) => {
      const envelope: ReleaseEnvelope = {
        version,
        sourceCommit: version === '0.1.8' ? '8'.repeat(40) : '7'.repeat(40),
        codeSnapshotRoot: `0x${version === '0.1.8' ? '88' : '77'}`.padEnd(66, version === '0.1.8' ? '8' : '7'),
        frozenCoreRoot: `0x${'55'.repeat(32)}`,
        generatedAt,
      };
      return {
        version,
        tag: `v${version}`,
        generatedAt,
        markdown: `/docs-catalog/releases/${version}.md`,
        snapshot: `/docs-catalog/releases/data/${version}.json`,
        sourceCommit: envelope.sourceCommit,
        metrics: { code: 1 },
        modules: { runtime: { code: 1 } },
        codeSnapshotRoot: envelope.codeSnapshotRoot,
        frozenCore: { rootHash: envelope.frozenCoreRoot },
        attestation: signReleaseEnvelope(envelope, board, PRIVATE_KEYS),
      };
    };
    const release017 = release('0.1.7', '2026-07-10T00:00:00.000Z');
    const release018 = release('0.1.8', '2026-07-11T00:00:00.000Z');
    const current = { schemaVersion: 1, latest: '0.1.8', releases: [release018, release017] } as const;
    expect(verifyReleaseManifestPolicy(current, board, '0.1.8')).toBe(true);
    expect(verifyReleaseManifestPolicy(
      { schemaVersion: 1, latest: '0.1.7', releases: [release017] },
      board,
      '0.1.8',
    )).toBe(false);
  });

  test('CLI verification rejects an explicitly supplied attacker board', () => {
    const directory = mkdtempSync(join(tmpdir(), 'xln-foundation-board-'));
    try {
      const boardPath = join(directory, 'attacker-board.json');
      writeFileSync(boardPath, JSON.stringify(createFoundationReleaseBoard(ADDRESSES, 2)));
      const result = Bun.spawnSync([
        process.execPath,
        resolve(ROOT, 'tools/foundation-release.ts'),
        'verify',
        `--board=${boardPath}`,
        `--snapshot=${resolve(ROOT, 'docs/releases/data/0.1.7.json')}`,
      ], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });

      expect(result.exitCode).not.toBe(0);
      expect(new TextDecoder().decode(result.stderr)).toContain('FOUNDATION_RELEASE_BOARD_NOT_TRUSTED');

      const tamperedSnapshotPath = join(directory, 'tampered-snapshot.json');
      const tamperedSnapshot = structuredClone(RELEASE_017);
      tamperedSnapshot.release.sourceCommit = 'b'.repeat(40);
      writeFileSync(tamperedSnapshotPath, JSON.stringify(tamperedSnapshot));
      const tamperedResult = Bun.spawnSync([
        process.execPath,
        resolve(ROOT, 'tools/foundation-release.ts'),
        'verify',
        `--board=${resolve(ROOT, 'foundation-release-board.json')}`,
        `--snapshot=${tamperedSnapshotPath}`,
      ], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      expect(tamperedResult.exitCode).not.toBe(0);
      expect(new TextDecoder().decode(tamperedResult.stderr)).toContain('RELEASE_ATTESTATION_INVALID');

      const historicalResult = Bun.spawnSync([
        process.execPath,
        resolve(ROOT, 'tools/foundation-release.ts'),
        'verify',
        `--board=${resolve(ROOT, 'foundation-release-board.json')}`,
        `--snapshot=${resolve(ROOT, 'docs/releases/data/0.1.6.json')}`,
      ], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      expect(historicalResult.exitCode).toBe(0);
      expect(new TextDecoder().decode(historicalResult.stdout)).toContain('Historical unsigned release: 0.1.6');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

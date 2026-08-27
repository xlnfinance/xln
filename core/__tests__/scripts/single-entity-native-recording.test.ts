import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Level } from 'level';

import { buildSingleEntityNativeRecording } from '../../scripts/operations/hlt/replay/build-single-entity-native-recording';
import { loadRscoreCheckpoint } from '../../storage/schema/rscore/checkpoint';

test('builds one exact pay plus same-J swap Runtime fixture below checkpoint cadence', async () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'xln-native-recording-'));
  const startedAt = performance.now();
  try {
    const paths = await buildSingleEntityNativeRecording(outputDirectory);
    const { readHltHubRecording, recordingFrames } = await import(
      '../../scripts/operations/hlt/replay/recording'
    );
    const artifact = readHltHubRecording(paths.recording);
    const frames = recordingFrames(artifact.recording);
    const baseHeight = artifact.recording.bundles[0]!.runtimeHeight;

    expect(performance.now() - startedAt).toBeLessThan(10_000);
    expect(paths.stateDb).not.toBe(paths.walDb);
    expect(Object.values(paths).every(path => existsSync(path))).toBe(true);
    expect(JSON.parse(readFileSync(paths.manifest, 'utf8'))).toEqual(paths);
    expect(artifact.featurePolicy).toEqual({
      hubRebalance: 'disabled',
      crossJ: 'disabled',
      disputes: 'disabled',
      lending: 'disabled',
    });
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]!.height).toBe(baseHeight + 1);
    expect(frames.at(-1)!.height).toBeLessThan(100);
    expect(frames.every(frame =>
      frame.runtimeInput.runtimeTxs.length === 0 && (frame.runtimeInput.jInputs?.length ?? 0) === 0
    )).toBe(true);
    expect(artifact.authorityFrameOracle.entityFrames).toHaveLength(frames.length);
    expect(artifact.authorityFrameOracle.entityFrames.every(frame =>
      /^0x[0-9a-f]{64}$/.test(frame.accountsRoot)
    )).toBe(true);
    expect(artifact.authorityEvidence.expectations.entityEffects.map(row => row.runtimeHeight))
      .toEqual(frames.map(frame => frame.height));
    expect(artifact.authorityEvidence.economicOperations.coverage).toMatchObject({
      directPayments: 1,
      swapOffers: 2,
      swapResolves: 1,
    });
    expect(frames.some(frame => frame.runtimeOutputCount > 0)).toBe(true);
    const db = new Level<Buffer, Buffer>(paths.stateDb, {
      valueEncoding: 'buffer',
      keyEncoding: 'binary',
    });
    try {
      await db.open();
      const owner = artifact.authorityFrameOracle.entityFrames[0]!.entityId;
      const checkpoint = await loadRscoreCheckpoint(db, owner);
      expect(checkpoint?.restoreToken[4]).toBe(1);
      expect(checkpoint?.accounts).toHaveLength(1);
    } finally {
      await db.close();
    }
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
}, 15_000);

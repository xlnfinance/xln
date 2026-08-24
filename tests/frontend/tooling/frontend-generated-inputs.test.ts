import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  COPY_GENERATED_INPUTS,
  type CopyGeneratedInputDefinition,
} from '../../../frontend/config/generated-inputs';
import {
  prepareGeneratedInputs,
  readPreparedGeneratedInputs,
} from '../../../frontend/scripts/generated-inputs';

const temporaryRoots: string[] = [];

const createWorkspace = async (): Promise<Readonly<{ repositoryRoot: string; frontendRoot: string }>> => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'xln-generated-inputs-'));
  temporaryRoots.push(repositoryRoot);
  const frontendRoot = join(repositoryRoot, 'frontend');
  await mkdir(frontendRoot, { recursive: true });
  return { repositoryRoot, frontendRoot };
};

const writeSource = async (repositoryRoot: string, pathname: string, contents = pathname): Promise<void> => {
  const output = join(repositoryRoot, pathname);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, contents);
};

const writeImplementedSources = async (repositoryRoot: string): Promise<void> => {
  for (const pathname of [
    'frontend/static/install.sh',
    'frontend/static/favicon.ico',
    'frontend/static/favicon-16x16.png',
    'frontend/static/favicon-32x32.png',
    'frontend/static/apple-touch-icon.png',
    'frontend/static/android-chrome-192x192.png',
    'frontend/static/android-chrome-512x512.png',
    'frontend/static/site.webmanifest',
    'frontend/static/comparative-results.json',
  ]) await writeSource(repositoryRoot, pathname);
  await writeSource(repositoryRoot, 'frontend/static/img/logo.png', 'logo');
  await writeSource(repositoryRoot, 'frontend/static/img/RCPAN.png', 'uppercase');
  await writeSource(repositoryRoot, 'frontend/static/bikes/rcpan.svg', 'bike');
};

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('frontend generated input preparation', () => {
  test('copies selected source-controlled inputs into deterministic isolated payloads', async () => {
    const { repositoryRoot, frontendRoot } = await createWorkspace();
    await writeImplementedSources(repositoryRoot);

    const first = await prepareGeneratedInputs(repositoryRoot, frontendRoot, ['site', 'ops']);
    const firstManifest = await readFile(
      join(frontendRoot, '.artifacts/inputs/site-public-static/input-manifest.json'),
      'utf8',
    );
    const second = await prepareGeneratedInputs(repositoryRoot, frontendRoot, ['site', 'ops']);
    const secondManifest = await readFile(
      join(frontendRoot, '.artifacts/inputs/site-public-static/input-manifest.json'),
      'utf8',
    );

    expect(second).toEqual(first);
    expect(secondManifest).toBe(firstManifest);
    expect(first.map(({ id }) => id)).toEqual(['site-public-static', 'ops-comparative-results']);
    expect(await readFile(
      join(frontendRoot, '.artifacts/inputs/site-public-static/files/img/logo.png'),
      'utf8',
    )).toBe('logo');
  });

  test('prepares only copy producers owned by the selected application', async () => {
    const { repositoryRoot, frontendRoot } = await createWorkspace();
    await writeImplementedSources(repositoryRoot);

    const manifests = await prepareGeneratedInputs(repositoryRoot, frontendRoot, ['ops']);

    expect(manifests.map(({ id }) => id)).toEqual(['ops-comparative-results']);
  });

  test('rejects prepared payload bytes that no longer match their manifest', async () => {
    const { repositoryRoot, frontendRoot } = await createWorkspace();
    await writeImplementedSources(repositoryRoot);
    await prepareGeneratedInputs(repositoryRoot, frontendRoot, ['ops']);
    await writeFile(
      join(frontendRoot, '.artifacts/inputs/ops-comparative-results/files/comparative-results.json'),
      'corrupted',
    );

    const opsDefinition = COPY_GENERATED_INPUTS.find(({ id }) => id === 'ops-comparative-results');
    if (opsDefinition === undefined) throw new Error('TEST_OPS_INPUT_DEFINITION_MISSING');
    await expect(readPreparedGeneratedInputs(
      frontendRoot,
      [opsDefinition],
    )).rejects.toThrow(
      'CANDIDATE_INPUT_FILE_MISMATCH:ops-comparative-results:comparative-results.json',
    );
  });

  test('rejects two source mappings that claim the same public destination', async () => {
    const { repositoryRoot, frontendRoot } = await createWorkspace();
    await writeSource(repositoryRoot, 'frontend/static/left.txt', 'left');
    await writeSource(repositoryRoot, 'frontend/static/right.txt', 'right');
    const collision: CopyGeneratedInputDefinition = {
      id: 'collision-fixture',
      owner: 'site',
      sourcePaths: ['frontend/static/left.txt', 'frontend/static/right.txt'],
      outputNamespace: 'collision-fixture',
      producer: {
        kind: 'copy',
        entries: [
          { sourcePath: 'frontend/static/left.txt', destinationPath: 'same.txt' },
          { sourcePath: 'frontend/static/right.txt', destinationPath: 'same.txt' },
        ],
      },
    };

    await expect(prepareGeneratedInputs(
      repositoryRoot,
      frontendRoot,
      ['site'],
      [collision],
    )).rejects.toThrow('GENERATED_INPUT_DESTINATION_COLLISION:collision-fixture:same.txt');
  });
});

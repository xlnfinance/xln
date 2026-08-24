import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  COPY_GENERATED_INPUTS,
  type CommandGeneratedInputDefinition,
  type CopyGeneratedInputDefinition,
} from '../../../frontend/config/generated-inputs';
import {
  prepareGeneratedInputs,
  readPreparedGeneratedInputs,
} from '../../../frontend/scripts/generated-inputs';

const temporaryRoots: string[] = [];
const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

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
    expect(await readFile(join(frontendRoot, '.artifacts/public/site/img/logo.png'), 'utf8')).toBe('logo');
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

  test('runs command producers inside their isolated payload and validates declared routes', async () => {
    const { repositoryRoot, frontendRoot } = await createWorkspace();
    await writeSource(repositoryRoot, 'frontend/static/docs-static/legacy.md', 'legacy');
    const command: CommandGeneratedInputDefinition = {
      id: 'docs-command-fixture',
      owner: 'docs',
      sourcePaths: ['fixture'],
      outputNamespace: 'docs-command-fixture',
      producer: {
        kind: 'command',
        argv: ['bun', '-e', [
          "import { mkdir } from 'node:fs/promises'",
          "const root = process.env['TEST_OUTPUT']",
          "if (!root) throw new Error('TEST_OUTPUT_MISSING')",
          "await mkdir(`${root}/docs-catalog/audit`, { recursive: true })",
          "await Bun.write(`${root}/docs-catalog/audit/advisor.md`, 'advisor')",
          "await Bun.write(`${root}/docs-catalog/audit-protocol.md`, 'protocol')",
          "await Bun.write(`${root}/llms.txt`, 'context')",
        ].join(';')],
        outputEnvironment: 'TEST_OUTPUT',
        environment: {},
        copies: [{
          sourcePath: 'frontend/static/docs-static',
          destinationPath: 'docs-static',
        }],
        outputRoutes: [
          { kind: 'prefix', pathname: '/docs-catalog' },
          { kind: 'prefix', pathname: '/docs-static' },
          { kind: 'stem', pathname: '/llms' },
        ],
      },
    };

    const first = await prepareGeneratedInputs(repositoryRoot, frontendRoot, ['docs'], [command]);
    const second = await prepareGeneratedInputs(repositoryRoot, frontendRoot, ['docs'], [command]);

    expect(second).toEqual(first);
    expect(first[0]?.files.map(({ destinationPath }) => destinationPath)).toEqual([
      'docs-catalog/audit-protocol.md',
      'docs-catalog/audit/advisor.md',
      'docs-static/legacy.md',
      'llms.txt',
    ]);
    expect(await readFile(
      join(frontendRoot, '.artifacts/public/docs/docs-catalog/audit-protocol.md'),
      'utf8',
    )).toBe('protocol');
  });

  test('keeps the legacy docs generator isolated and accepts a deterministic timestamp', async () => {
    const { frontendRoot } = await createWorkspace();
    const outputRoot = join(frontendRoot, 'docs-generator-output');
    const child = Bun.spawn([
      'bun',
      'frontend/copy-static-files.js',
      '--docs-only',
      '--skip-llms',
    ], {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        XLN_STATIC_DIR: outputRoot,
        XLN_GENERATED_AT: '1970-01-01T00:00:00.000Z',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await child.exited;
    const manifest = JSON.parse(await readFile(join(outputRoot, 'docs-catalog/manifest.json'), 'utf8')) as {
      generatedAt: string;
    };

    expect(exitCode).toBe(0);
    expect(manifest.generatedAt).toBe('1970-01-01T00:00:00.000Z');
    expect(await readFile(join(outputRoot, 'docs-catalog/readme.md'), 'utf8')).toContain('#');
    await expect(readFile(join(outputRoot, 'contracts/Account.json'), 'utf8')).rejects.toThrow();
  });
});

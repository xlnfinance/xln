import { expect, test } from 'bun:test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStringify } from '../../../protocol/serialization';
import { startStandaloneNode } from './standalone-deployment-support';
import { launchDeployment } from './standalone-deployment-process-support';
import { launchInspectedDeployment, type DebugCut } from './standalone-deployment-inspector-support';
import { awaitVerification, finish, journalMessages, readJson } from './standalone-deployment-transactions-support';
import { poisonCatalog, verifyMatrixCompletion, verifyCompletedReruns } from './standalone-deployment-matrix-assertions-support';

type Cut = Readonly<{ name: string; source: string; statement: string; operations: number;
  terminal?: boolean; manifest?: boolean; archiveComplete?: boolean; rootComplete?: boolean }>;
const cuts: readonly Cut[] = [
  { name: 'base-before-hanko', source: 'deploy-stack.cjs', statement: 'const listing = await prepareListing', operations: 10 },
  { name: 'hanko-before-save', source: 'deploy-stack.cjs', statement: 'save(`${attempt.output}.listing.json`', operations: 10 },
  { name: 'fullgraph-before-manifest', source: 'deploy-stack.cjs', statement: 'publishManifest(attempt.output, manifest)', operations: 11 },
  { name: 'manifest-before-rename', source: 'deployment/manifest.cjs', statement: 'renameSync(temporary, path);', operations: 11 },
  { name: 'manifest-after-rename', source: 'deployment/manifest.cjs', statement: 'const directory = openSync(dirname(path)', operations: 11, manifest: true },
  { name: 'invocation-terminal-before-rename', source: 'deployment/manifest.cjs', statement: 'renameSync(temporary, path);', operations: 11, terminal: true, manifest: true },
  { name: 'terminal-root-before-rename', source: 'deployment/manifest.cjs', statement: 'renameSync(temporary, path);', operations: 11, terminal: true, manifest: true, archiveComplete: true },
  { name: 'terminal-root-after-rename', source: 'deployment/manifest.cjs', statement: 'const directory = openSync(dirname(path)', operations: 11, terminal: true, manifest: true, archiveComplete: true, rootComplete: true },
];

const debugCut = (nativeDirectory: string, cut: Cut): DebugCut => {
  const source = `jurisdictions/scripts/${cut.source}`;
  if (cut.source === 'deploy-stack.cjs') return { source, statement: cut.statement };
  const result = cut.terminal;
  const path = join(nativeDirectory, result ? 'result.json' : 'manifest.json');
  const target = cut.name.startsWith('invocation-')
    ? `path.startsWith(${safeStringify(join(nativeDirectory, 'invocations') + '/')}) && path.endsWith('/result.json')`
    : `path === ${safeStringify(path)}`;
  return { source, statement: cut.statement, condition: target + (result ? " && value.status === 'complete'" : '') };
};

const temporaryWrites = async (directory: string): Promise<unknown[]> => {
  const results: unknown[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory() && item.name === 'invocations') results.push(...await temporaryWrites(path));
    else if (item.isDirectory() && directory.endsWith('/invocations')) results.push(...await temporaryWrites(path));
    else if (item.isFile() && item.name.endsWith('.tmp')) {
      const bytes = await readFile(path, 'utf8');
      results.push({ path, value: JSON.parse(bytes) });
    }
  }
  return results;
};

test.each(cuts)('native writing interruption $name preserves history and resumes eleven operations', async cut => {
  const fixture = await startStandaloneNode(0, cut.name === 'hanko-before-save' ? 2 : 0);
  const initialBalance = await fixture.provider.getBalance(fixture.signer.address);
  await writeFile(fixture.catalog, poisonCatalog);
  let child: Awaited<ReturnType<typeof launchInspectedDeployment>> | undefined;
  let resumed: ReturnType<typeof launchDeployment> | undefined;
  try {
    child = await launchInspectedDeployment(fixture, `writing-${cut.name}`, debugCut(fixture.nativeDirectory, cut));
    if (cut.terminal) {
      await awaitVerification(child);
      await fixture.provider.send('anvil_mine', ['0xb']);
    }
    const breakpoint = await child.waitForCut();
    const before = await readJson(join(fixture.nativeDirectory, 'result.json'));
    expect(before.owner.pid).toBe(child.pid);
    expect(before.status).toBe(cut.rootComplete ? 'complete' : 'running');
    const archivePath = join(before.invocation, 'result.json');
    const archiveBefore = await readFile(archivePath, 'utf8');
    expect(JSON.parse(archiveBefore).status).toBe(cut.archiveComplete ? 'complete' : 'running');
    const manifestBefore = await readFile(join(fixture.nativeDirectory, 'manifest.json'), 'utf8');
    if (cut.manifest) expect(JSON.parse(manifestBefore).deploymentId).toBe('resume-usdc');
    else expect(manifestBefore).toBe('');
    const originalJournal = await readFile(join(fixture.nativeDirectory, 'journal.jsonl'), 'utf8');
    const confirmations = (await journalMessages(fixture)).filter(message => message.type === 'TRANSACTION_CONFIRM');
    expect(confirmations).toHaveLength(cut.operations);
    expect(BigInt(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'latest']))).toBe(BigInt(fixture.initialNonce + cut.operations));
    const temporary = await temporaryWrites(fixture.nativeDirectory);
    const listingPath = join(fixture.nativeDirectory, 'manifest.json.listing.json');
    const listingBefore = await Bun.file(listingPath).exists() ? await readFile(listingPath, 'utf8') : null;
    expect(listingBefore === null).toBe(cut.operations === 10);
    await writeFile(join(fixture.directory, `writing-${cut.name}-cut.json`), safeStringify({ breakpoint, before, archive: JSON.parse(archiveBefore), manifestBefore, temporary, confirmations }, 2));
    await child.stop();
    const exitCode = await child.exited;
    expect(exitCode).not.toBe(0);
    const sends = fixture.submissions();
    resumed = launchDeployment(fixture, `resumed-${cut.name}`, { mode: 'resume' });
    let result;
    if (cut.terminal) {
      expect(await resumed.exited).toBe(0);
      result = await readJson(join(fixture.nativeDirectory, 'result.json'));
    } else result = await finish(fixture, resumed);
    expect(fixture.submissions() - sends).toBe(11 - cut.operations);
    expect((await readFile(join(fixture.nativeDirectory, 'journal.jsonl'), 'utf8')).startsWith(originalJournal)).toBeTrue();
    if (listingBefore !== null) expect(await readFile(listingPath, 'utf8')).toBe(listingBefore);
    const archiveAfter = await readFile(archivePath, 'utf8');
    if (cut.archiveComplete) expect(archiveAfter).toBe(archiveBefore);
    else expect(JSON.parse(archiveAfter)).toEqual({ ...JSON.parse(archiveBefore), status: 'interrupted' });
    const completion = await verifyMatrixCompletion(fixture, result, initialBalance);
    const reruns = await verifyCompletedReruns(fixture, result, archivePath);
    const proof = join(fixture.directory, `writing-${cut.name}-proof.json`);
    await writeFile(proof, safeStringify({ name: cut.name, breakpoint, exitCode, before, manifestBefore, temporary,
      archiveBefore: JSON.parse(archiveBefore), archiveAfter: JSON.parse(archiveAfter), completion, result, reruns }, 2));
    console.log(`STANDALONE_WRITING_EVIDENCE:${proof}:cut=${cut.name}:operations=11`);
  } finally { await child?.stop(); await resumed?.stop(); await fixture.close(); }
}, 90_000);

test('native resume rejects an array-shaped archived terminal status', async () => {
  const fixture = await startStandaloneNode(0);
  let child: Awaited<ReturnType<typeof launchInspectedDeployment>> | undefined;
  let resumed: ReturnType<typeof launchDeployment> | undefined;
  try {
    const target = join(fixture.nativeDirectory, 'result.json');
    child = await launchInspectedDeployment(fixture, 'archive-shape-cut', {
      source: 'jurisdictions/scripts/deployment/manifest.cjs', statement: 'renameSync(temporary, path);',
      condition: `path === ${safeStringify(target)} && value.status === 'complete'`,
    });
    await awaitVerification(child);
    await fixture.provider.send('anvil_mine', ['0xb']);
    const cut = await child.waitForCut();
    const before = await readJson(target);
    const archive = join(before.invocation, 'result.json');
    const archived = await readJson(archive);
    expect(archived.status).toBe('complete');
    await child.stop();
    const corrupted = safeStringify({ ...archived, status: ['complete'] }, 2);
    await writeFile(archive, corrupted);
    const sends = fixture.submissions();
    resumed = launchDeployment(fixture, 'archive-shape-resume', { mode: 'resume' });
    const exitCode = await resumed.exited;
    const log = await resumed.log();
    const result = await readJson(target);
    const proof = join(fixture.directory, 'archive-status-shape-proof.json');
    await writeFile(proof, safeStringify({ cut, before, corruptedStatus: ['complete'], exitCode, log, result }, 2));
    expect(exitCode).not.toBe(0);
    expect(log).toContain('XLN_DEPLOY_INVOCATION_INVALID');
    expect(result).toEqual(before);
    expect(await readFile(archive, 'utf8')).toBe(corrupted);
    expect(fixture.submissions()).toBe(sends);
    console.log(`STANDALONE_ARCHIVE_SHAPE_EVIDENCE:${proof}`);
  } finally { await child?.stop(); await resumed?.stop(); await fixture.close(); }
}, 60_000);

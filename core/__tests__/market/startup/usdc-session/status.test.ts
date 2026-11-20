import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hexlify, JsonRpcProvider, Wallet } from 'ethers';
import { Depository__factory } from '../../../../../jurisdictions/typechain-types';
import { readVaultSeed } from '../../../../../jurisdictions/scripts/usdc-cross-j-preflight/identities';
import { acquireStoreOwnership } from '../../../../../jurisdictions/scripts/usdc-cross-j-preflight/operators/session/stores';
import { deriveSignerKeySync } from '../../../../account/crypto';
import { prepareSignedBatch } from '../../../../hanko/batch';
import { createEmptyBatch } from '../../../../jurisdiction/machine/batch';
import { safeStringify } from '../../../../protocol/serialization';
import { executionEntry, fundRun, issueAuthority, readReport, type UsdcFixture } from './approval';
import { createUsdcFixture, stopFixtureChildren, until } from './fixture';
import { startReportRpc } from './report-rpc';

const sessionEntry = 'jurisdictions/scripts/usdc-cross-j-preflight/operators/session/index.ts';
const fingerprint = (path: string) =>
  readdirSync(path, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const file = join(entry.parentPath, entry.name);
      return [file, createHash('sha256').update(readFileSync(file)).digest('hex')];
    })
    .sort(([first], [second]) => first!.localeCompare(second!));

const awaitExit = (child: ChildProcess) =>
  new Promise<number | null>((resolve, reject) => child.once('exit', resolve).once('error', reject));

const sourceUser = (fixture: UsdcFixture) => fixture.identities.find(identity => identity.role === 'user')!.chains[0]!;

const sendRevertingCollateral = async (fixture: UsdcFixture, source: JsonRpcProvider) => {
  const user = sourceUser(fixture);
  const hub = fixture.identities.find(identity => identity.role === 'hub')!.chains[0]!;
  const key = hexlify(deriveSignerKeySync(readVaultSeed(join(fixture.root, 'user')), '1'));
  const chain = fixture.chains[0]!;
  const depos = Depository__factory.connect(chain.contracts.depository, new Wallet(key, source));
  const batch = createEmptyBatch();
  batch.reserveToCollateral.push({
    receivingEntity: user.entityId,
    tokenId: 1,
    pairs: [{ entity: hub.entityId, amount: 1_000_000n }],
  });
  const signed = prepareSignedBatch(
    batch,
    user.entityId,
    key,
    BigInt(chain.chainId),
    chain.contracts.depository,
    await depos.entityNonces(user.entityId),
  );
  const tx = await depos.processBatch(signed.encodedBatch, signed.hankoData, signed.nextNonce, {
    nonce: 2,
    type: 2,
    gasLimit: 50_000,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 100_000_000n,
  });
  await until('collateral-revert-receipt', async () => (await source.getTransactionReceipt(tx.hash)) !== null);
  expect((await source.getTransactionReceipt(tx.hash))?.status).toBe(0);
  return tx.hash;
};

const launchStatus = async (
  fixture: UsdcFixture,
  authority: string,
  name: string,
  env: NodeJS.ProcessEnv,
  stand = join(fixture.root, 'stand.json'),
) => {
  const child = fixture.launch(
    name,
    executionEntry,
    ['status', '--stand', stand, '--authority-file', authority, '--run-id', 'demo-01', '--json'],
    {
      ...env,
      XLN_CRYPTO_SIGN_WORKERS: '0',
      BUN_OPTIONS: '--preload ./core/__tests__/fixtures/usdc-poc/forbid-status-signing.ts',
    },
  );
  const exit = await awaitExit(child);
  const log = join(fixture.root, `${name}.log`);
  if (exit !== 0) throw new Error(readFileSync(log, 'utf8'));
  return readReport(log);
};

test('status reconciles the mined deposit of an expired interrupted run without signing, submitting or writing WAL', async () => {
  const fixture = await createUsdcFixture({ reserves: [1_000_000n, 1_000_000n] });
  const { root, stores, apiBase, hubPort, mmPort } = fixture;
  const sourceUrl = fixture.rpcUpstreams.get('/rpc')!;
  const targetUrl = fixture.rpcUpstreams.get('/rpc2')!;
  const source = new JsonRpcProvider(sourceUrl, 11155111, { cacheTimeout: -1 });
  const target = new JsonRpcProvider(targetUrl, 421614, { cacheTimeout: -1 });
  let runner: ChildProcess | undefined;
  let depositHash: string | null = null;
  let anchorToPrune: string | null = null;
  let prunedReads = 0;
  const submitted: string[] = [];
  const sourceRpc = startReportRpc(sourceUrl, source, '', async wire => {
    submitted.push(wire.hash!);
    if (wire.from?.toLowerCase() !== sourceUser(fixture).signerId || wire.nonce !== 1) return;
    if (!runner?.kill('SIGSTOP')) throw new Error('TEST_RUNNER_PAUSE_FAILED');
    depositHash = wire.hash;
  });
  const targetRpc = startReportRpc(targetUrl, target, '', async wire => {
    submitted.push(wire.hash!);
  });
  const rateLimited = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('rate limited', { status: 429 }),
  });
  const pruned = startReportRpc(sourceUrl, source, '', undefined, call => {
    if (anchorToPrune === null || call.method !== 'eth_getTransactionCount' || call.params[1] !== anchorToPrune)
      return false;
    prunedReads++;
    return true;
  });
  const rpcEnv = { ETH_SEPOLIA_RPC: sourceRpc.url.toString(), ARB_SEPOLIA_RPC: targetRpc.url.toString() };
  const manifest = join(root, 'authority.json');
  const output = join(root, 'interrupted.json');
  const runArgs = ['--authority-file', manifest, '--run-id', 'demo-01'];
  try {
    await fundRun(fixture, source, target);
    await issueAuthority(fixture, manifest, 50_000);
    const expiry = Number(readReport(manifest)['expiresAt']);
    writeFileSync(join(root, 'stand.json'), safeStringify({ directory: root, stores, apiBase, hubPort, mmPort }));
    await stopFixtureChildren(fixture.operators);
    fixture.closeGateway();
    // The account fixture predates execution ownership. Establish the same
    // lock inode a stopped execution leaves, without committing another frame.
    acquireStoreOwnership([['user', stores.user]])();
    const unmaterialized = await launchStatus(fixture, manifest, 'status-unmaterialized-tail', rpcEnv);
    expect(unmaterialized).toMatchObject({ wal: null, complete: false, lastConfirmedStep: null });
    expect(unmaterialized['reasons']).toContain('USDC_STATUS_WAL_HEAD_NOT_MATERIALIZED');
    const heights = unmaterialized['walHeights'] as { head: number; materialized: number };
    expect(heights.head).toBeGreaterThan(heights.materialized);
    const operators = fixture.launch(
      'status-operators',
      sessionEntry,
      [
        '--directory',
        root,
        '--api-base',
        apiBase,
        '--hub-port',
        String(hubPort),
        '--mm-port',
        String(mmPort),
        '--hub-store',
        stores.hub,
        '--mm-store',
        stores.mm,
        '--user-store',
        stores.user,
        '--operators-only',
        ...runArgs,
      ],
      { ...fixture.roleEnv('hub'), ...rpcEnv },
    );
    await until('status-operators', async () => {
      if (operators.exitCode !== null) throw new Error(`TEST_OPERATORS_EXIT:${root}`);
      return /^USDC_SESSION_READY:/m.test(readFileSync(join(root, 'status-operators.log'), 'utf8'));
    });
    runner = fixture.launch(
      'interrupted',
      executionEntry,
      [
        'run',
        '--directory',
        root,
        '--user-store',
        stores.user,
        '--api-base',
        apiBase,
        '--hub-url',
        `ws://127.0.0.1:${hubPort}/rpc`,
        '--output',
        output,
        ...runArgs,
      ],
      fixture.roleEnv('user'),
    );
    await until('deposit-mined-while-user-is-paused', async () => {
      if (runner?.exitCode !== null) throw new Error(`TEST_INTERRUPTED_RUN_EXIT:${root}`);
      return depositHash !== null && (await source.getTransactionReceipt(depositHash))?.status === 1;
    });
    const busy = await launchStatus(fixture, manifest, 'status-store-busy', rpcEnv);
    expect(busy).toMatchObject({ lastConfirmedStep: 'deposit', wal: null, remainingPrincipal: null });
    expect(busy['reasons']).toContain('USDC_SESSION_STORE_BUSY');
    await stopFixtureChildren([runner], 'SIGKILL');
    await stopFixtureChildren([operators]);
    expect(existsSync(output)).toBe(false);
    expect(submitted).toHaveLength(2);
    const storeHash = Object.values(stores).flatMap(fingerprint);
    const originalManifest = readFileSync(manifest, 'utf8');
    await Bun.sleep(Math.max(0, expiry - Date.now() + 2));
    const env = { ...fixture.roleEnv('user'), ...rpcEnv };
    const observed = await launchStatus(fixture, manifest, 'status-expired', env);
    expect(observed).toMatchObject({
      authority: { expired: true, approved: true, expiresAt: expiry },
      complete: false,
      lastConfirmedStep: 'deposit',
      remainingPrincipal: 1_000_000n,
      slots: [
        expect.anything(),
        expect.objectContaining({
          status: 'confirmed',
          hash: depositHash,
          via: 'hash',
          walObservation: 'watcher-behind',
        }),
        ...Array.from({ length: 3 }, () => expect.objectContaining({ status: 'unobserved' })),
      ],
    });
    expect(observed['wal']).toMatchObject({
      entities: [
        expect.objectContaining({ chainId: 11155111, reserve: 0n, collateral: 0n, route: null }),
        expect.objectContaining({ chainId: 421614, reserve: 0n, collateral: 0n, route: null }),
      ],
    });
    const currentHeights = observed['walHeights'] as { head: number; materialized: number };
    expect(currentHeights.head).toBe(currentHeights.materialized);
    const missingStand = join(root, 'stand-missing.json');
    writeFileSync(
      missingStand,
      safeStringify({
        directory: root,
        apiBase,
        hubPort,
        mmPort,
        stores: Object.fromEntries(Object.keys(stores).map(role => [role, join(root, role, 'absent')])),
      }),
    );
    const missing = await launchStatus(fixture, manifest, 'status-missing-wal', env, missingStand);
    expect(missing).toMatchObject({ wal: null, lastConfirmedStep: 'deposit' });
    expect(missing['reasons']).toContain('USDC_STATUS_WAL_STORE_MISSING');
    expect((missing['slots'] as unknown[])[1]).toMatchObject({ status: 'confirmed', hash: depositHash, via: 'nonce' });

    const brokenStore = join(root, 'user', 'corrupt-runtime');
    cpSync(stores.user, brokenStore, { recursive: true });
    writeFileSync(join(brokenStore, 'db', `${sourceUser(fixture).signerId}-wal`, 'CURRENT'), 'INVALID');
    const brokenStand = join(root, 'stand-corrupt.json');
    writeFileSync(
      brokenStand,
      safeStringify({
        directory: root,
        apiBase,
        hubPort,
        mmPort,
        stores: { ...stores, user: brokenStore },
      }),
    );
    await expect(launchStatus(fixture, manifest, 'status-corrupt-wal', env, brokenStand)).rejects.toThrow(
      /STORAGE_|Corruption/i,
    );
    const noArchive = {
      ...env,
      ETH_SEPOLIA_RPC: rateLimited.url.toString(),
      POC_RUNTIME_11155111_RPC: rpcEnv.ETH_SEPOLIA_RPC,
    };
    const missingHistory = await launchStatus(fixture, manifest, 'status-history-off', noArchive);
    expect((missingHistory['slots'] as unknown[])[0]).toMatchObject({
      status: 'confirmed',
      hash: submitted[0],
      via: 'hash',
    });
    const withoutHints = await launchStatus(fixture, manifest, 'status-history-and-hints-off', noArchive, missingStand);
    expect((withoutHints['slots'] as unknown[])[0]).toMatchObject({
      status: 'unavailable',
      consumed: true,
      reason: 'RPC_HTTP_429',
    });
    expect((missingHistory['slots'] as unknown[])[1]).toMatchObject({
      status: 'confirmed',
      hash: depositHash,
      via: 'hash',
    });
    const chains = readReport(manifest)['chains'] as { anchorNumber: number }[];
    anchorToPrune = `0x${chains[0]!.anchorNumber.toString(16)}`;
    const prunedStatus = await launchStatus(fixture, manifest, 'status-pruned-current', {
      ...env,
      POC_RUNTIME_11155111_RPC: pruned.url.toString(),
    });
    expect(prunedReads).toBeGreaterThan(0);
    expect((prunedStatus['slots'] as unknown[])[1]).toMatchObject({
      status: 'confirmed',
      hash: depositHash,
      via: 'hash',
    });
    const revertedHash = await sendRevertingCollateral(fixture, source);
    const reverted = await launchStatus(fixture, manifest, 'status-reverted', env);
    expect(reverted).toMatchObject({ complete: false, lastConfirmedStep: 'deposit', remainingPrincipal: 1_000_000n });
    expect((reverted['slots'] as unknown[])[2]).toMatchObject({
      status: 'reverted',
      consumed: true,
      hash: revertedHash,
      via: 'nonce',
    });
    expect(submitted).toHaveLength(2);
    expect(Object.values(stores).flatMap(fingerprint)).toEqual(storeHash);
    expect(readFileSync(manifest, 'utf8')).toBe(originalManifest);
  } finally {
    if (runner?.exitCode === null && runner.signalCode === null) await stopFixtureChildren([runner], 'SIGKILL');
    sourceRpc.stop(true);
    targetRpc.stop(true);
    rateLimited.stop(true);
    pruned.stop(true);
    source.destroy();
    target.destroy();
    await fixture.close();
  }
}, 180_000);

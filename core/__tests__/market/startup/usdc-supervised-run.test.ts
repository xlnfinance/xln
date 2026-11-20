import { expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hexlify, JsonRpcProvider, NonceManager, Wallet, zeroPadValue } from 'ethers';
import { Depository__factory, ERC20Mock__factory } from '../../../../jurisdictions/typechain-types';
import { readVaultSeed } from '../../../../jurisdictions/scripts/usdc-cross-j-preflight/identities';
import { STAND_LOCK_TOKEN_ENV } from '../../../../tools/stand-lock';
import { deriveSignerKeySync } from '../../../account/crypto';
import { generateLazyEntityId } from '../../../entity/factory';
import { prepareSignedBatch } from '../../../hanko/batch';
import { buildExternalTokenToReserveBatch } from '../../../jurisdiction/adapter/events/contract-codec';
import { createEmptyBatch } from '../../../jurisdiction/machine/batch';
import { safeStringify } from '../../../protocol/serialization';
import { createUsdcFixture, stopFixtureChildren, until } from './usdc-session/fixture';
import { executionEntry as entry, issueAuthority, readReport, type UsdcFixture } from './usdc-session/approval';
import {
  coverBalanceReadFault,
  financialChildPid,
  reportReceipts,
  startReportRpc,
  tariffChangeDuringCover,
  verifyArchiveForkRejected,
  verifyPendingCoverHash,
  withoutPreflightReports,
} from './usdc-session/report-rpc';

const mnemonic = 'test test test test test test test test test test test junk';

const reserveOperators = (fixture: UsdcFixture, provider: JsonRpcProvider, signer: NonceManager) => {
  const chain = fixture.chains[1]!;
  const hub = fixture.identities.find(identity => identity.role === 'hub')!.chains[1]!;
  const sponsor = Wallet.fromPhrase(mnemonic);
  const depos = Depository__factory.connect(chain.contracts.depository, signer);
  const token = ERC20Mock__factory.connect(chain.tokens.USDC.address, signer);
  const apply = async (batch: ReturnType<typeof createEmptyBatch>, entity: string, key: string) => {
    await provider.send('anvil_nodeInfo', []);
    const signed = prepareSignedBatch(
      batch,
      entity,
      key,
      BigInt(chain.chainId),
      chain.contracts.depository,
      await depos.entityNonces(entity),
    );
    await (await depos.processBatch(signed.encodedBatch, signed.hankoData, signed.nextNonce)).wait();
  };
  return {
    async add(amount: bigint) {
      await (await token.approve(chain.contracts.depository, amount)).wait();
      await apply(
        buildExternalTokenToReserveBatch({
          entityId: hub.entityId,
          tokenAddress: chain.tokens.USDC.address,
          amount,
          internalTokenId: 1,
        }),
        generateLazyEntityId([sponsor.address], 1n),
        sponsor.privateKey,
      );
    },
    async remove(amount: bigint) {
      if (!('signerLabel' in hub) || !hub.signerLabel) throw new Error('TEST_TARGET_HUB_LABEL_MISSING');
      const key = hexlify(deriveSignerKeySync(readVaultSeed(join(fixture.root, 'hub')), hub.signerLabel));
      expect(new Wallet(key).address.toLowerCase()).toBe(hub.signerId);
      const batch = createEmptyBatch();
      batch.reserveToExternalToken.push({ receivingEntity: zeroPadValue(sponsor.address, 32), tokenId: 1, amount });
      await apply(batch, hub.entityId, key);
    },
  };
};

test('supervised execution guards the first approval and rechecks backing after source collateral', async () => {
  const fixture = await createUsdcFixture({ reserves: [1_000_000n, 500_000n] });
  const { root, identities, chains, stores, apiBase, hubPort, mmPort } = fixture;
  const direct = [fixture.rpcUpstreams.get('/rpc')!, fixture.rpcUpstreams.get('/rpc2')!];
  const [source, target] = direct.map(url => new JsonRpcProvider(url)) as [JsonRpcProvider, JsonRpcProvider];
  const sourceSponsor = new NonceManager(Wallet.fromPhrase(mnemonic, source));
  const targetSponsor = new NonceManager(Wallet.fromPhrase(mnemonic, target));
  const users = identities.find(identity => identity.role === 'user')!.chains;
  const targetHub = identities.find(identity => identity.role === 'hub')!.chains[1]!;
  const reserve = reserveOperators(fixture, target, targetSponsor);
  let drainBeforeCollateral = false;
  let drainBeforeApproval = false;
  let sourceArchiveUnavailable = false;
  let sourceSubmissions = 0;
  let targetSubmissions = 0;
  let firstApprovalWire: string | undefined;
  const inspectedCoverHashes: string[] = [];
  let active: ChildProcess | undefined;
  let cut: { payer: string; nonce: number; output: string; observed?: { pid: number; hash: string } } | undefined;
  const pauseAt = (payer: string, nonce: number, hash: string) => {
    if (!cut || cut.observed || cut.payer !== payer || cut.nonce !== nonce || !active) return;
    const pid = financialChildPid(active, cut.output);
    process.kill(pid, 'SIGSTOP');
    cut.observed = { pid, hash };
  };
  const sourceRpc = startReportRpc(
    direct[0]!,
    source,
    users[1]!.signerId,
    async wire => {
      if (wire.from?.toLowerCase() !== users[0]!.signerId) return;
      sourceSubmissions++;
      if (wire.nonce === 0) firstApprovalWire ??= wire.serialized;
      pauseAt(users[0]!.signerId, wire.nonce, wire.hash!);
      if (!drainBeforeCollateral || wire.nonce !== 2) return;
      drainBeforeCollateral = false;
      await reserve.remove(200_000n);
    },
    async call => {
      if (drainBeforeApproval && call.method === 'eth_estimateGas') {
        drainBeforeApproval = false;
        await reserve.remove(200_000n);
      }
      return false;
    },
  );
  const sourceArchive = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      // Keep the outage through report construction, then let the operators
      // finish their watcher shutdown before the next restore takes the WAL.
      if (sourceArchiveUnavailable && !existsSync(join(root, 'covered-stop.json')))
        return new Response(null, { status: 429 });
      return fetch(sourceRpc.url, { method: 'POST', body: await request.text() });
    },
  });
  const coverFault = coverBalanceReadFault(target, users[1]!.signerId);
  const tariffRace = tariffChangeDuringCover(fixture);
  const targetRpc = startReportRpc(
    direct[1]!,
    target,
    users[1]!.signerId,
    async wire => {
      targetSubmissions++;
      if (wire.from?.toLowerCase() === targetHub.signerId) {
        coverFault.recordCover(wire.hash!);
        inspectedCoverHashes.push(await verifyPendingCoverHash(fixture, target, wire));
      }
      pauseAt(wire.from!.toLowerCase(), wire.nonce, wire.hash!);
    },
    async call => {
      await tariffRace.beforeRead(call);
      const reject = await coverFault.rejectRead(call);
      if (reject) sourceArchiveUnavailable = true;
      return reject;
    },
  );
  const unavailableArchive = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(null, { status: 429 }),
  });
  const stand = join(root, 'stand.json'),
    authority = join(root, 'authority.json');
  const run = (name: string, output = join(root, `${name}.json`)): Promise<number | null> =>
    new Promise((resolve, reject) => {
      const child = fixture.launch(
        name,
        entry,
        ['run', '--stand', stand, '--authority-file', authority, '--run-id', 'demo-01', '--output', output],
        {
          ...fixture.roleEnv('user'),
          [STAND_LOCK_TOKEN_ENV]: process.env[STAND_LOCK_TOKEN_ENV],
          ETH_SEPOLIA_RPC: sourceArchive.url.toString(),
          POC_RUNTIME_11155111_RPC: sourceRpc.url.toString(),
          ARB_SEPOLIA_RPC: targetRpc.url.toString(),
        },
      );
      active = child;
      child.once('exit', resolve).once('error', reject);
    });
  const interruptRun = async (name: string, payer: string, nonce: number, provider: JsonRpcProvider, mined = true) => {
    const armed: NonNullable<typeof cut> = { payer, nonce, output: join(root, `${name}.json`) };
    cut = armed;
    const exiting = run(name);
    try {
      await until(name, async () => {
        if (active?.exitCode !== null) throw new Error(readFileSync(join(root, `${name}.log`), 'utf8'));
        if (!armed.observed) return false;
        return mined
          ? (await provider.getTransactionReceipt(armed.observed.hash))?.status === 1
          : (await provider.getTransaction(armed.observed.hash))?.blockNumber === null;
      });
    } finally {
      if (armed.observed) process.kill(armed.observed.pid, 'SIGKILL');
      cut = undefined;
    }
    expect(await exiting).not.toBe(0);
    expect(existsSync(armed.output)).toBe(false);
    return armed.observed!.hash;
  };
  const status = (name: string, json = true, archiveAvailable = true): Promise<number | null> =>
    new Promise((resolve, reject) => {
      const child = fixture.launch(
        name,
        entry,
        ['status', '--stand', stand, '--authority-file', authority, '--run-id', 'demo-01', ...(json ? ['--json'] : [])],
        {
          ...fixture.roleEnv('user'),
          ETH_SEPOLIA_RPC: archiveAvailable ? direct[0] : unavailableArchive.url.toString(),
          POC_RUNTIME_11155111_RPC: direct[0],
          ARB_SEPOLIA_RPC: archiveAvailable ? direct[1] : unavailableArchive.url.toString(),
          POC_RUNTIME_421614_RPC: direct[1],
        },
      );
      child.once('exit', resolve).once('error', reject);
    });
  try {
    await issueAuthority(fixture, authority);
    await verifyArchiveForkRejected(fixture, direct[1]!, target, authority);
    writeFileSync(stand, safeStringify({ directory: root, stores, apiBase, hubPort, mmPort }));
    await stopFixtureChildren(fixture.operators);
    fixture.closeGateway();
    await (await sourceSponsor.sendTransaction({ to: users[0]!.signerId, value: 10n ** 17n })).wait();
    for (const address of [users[1]!.signerId, targetHub.signerId])
      await (await targetSponsor.sendTransaction({ to: address, value: 10n ** 17n })).wait();
    const token = ERC20Mock__factory.connect(chains[0]!.tokens.USDC.address, sourceSponsor);
    await (await token.transfer(users[0]!.signerId, 1_000_000n)).wait();
    const catalog = join(root, 'jurisdictions.json');
    const original = readFileSync(catalog, 'utf8');
    writeFileSync(catalog, safeStringify({ ...readReport(catalog), lastUpdated: 'changed' }));
    expect(await run('bad-catalog')).not.toBe(0);
    expect(readFileSync(join(root, 'bad-catalog.log'), 'utf8')).toContain('USDC_EXECUTION_AUTHORITY_CANDIDATE_CHANGED');
    writeFileSync(catalog, original);
    expect(await run('low-backing')).not.toBe(0);
    const initialStop = readReport(join(root, 'low-backing.json'));
    expect(initialStop['reason']).toContain('USDC_EXECUTION_TARGET_BACKING_INSUFFICIENT');
    expect(initialStop['lastConfirmedStep']).toBeNull();
    expect(sourceSubmissions).toBe(0);
    expect(await source.getTransactionCount(users[0]!.signerId)).toBe(0);
    expect(await target.getTransactionCount(targetHub.signerId)).toBe(0);
    const blocked = join(root, 'report-blocker');
    writeFileSync(blocked, 'fixture');
    expect(await run('output-failure', join(blocked, 'result.json'))).not.toBe(0);
    const failed = readFileSync(join(root, 'output-failure.log'), 'utf8');
    const logs = failed.match(/^USDC_EXECUTION_LOG_DIRECTORY:(.+)$/m)?.[1];
    const diagnostic = readFileSync(join(logs!, 'execution.log'), 'utf8');
    expect(diagnostic).toContain('USDC_EXECUTION_TARGET_BACKING_INSUFFICIENT');
    expect(diagnostic).toContain('ENOTDIR');
    expect(await status('status-before-approval')).toBe(0);
    expect(readReport(join(root, 'status-before-approval.log'))['lastConfirmedStep']).toBeNull();
    await reserve.add(500_000n);
    drainBeforeApproval = true;
    expect(await run('backing-lost-before-approval')).not.toBe(0);
    expect(readReport(join(root, 'backing-lost-before-approval.json'))['reason']).toContain(
      'USDC_EXECUTION_TARGET_BACKING_INSUFFICIENT',
    );
    expect(sourceSubmissions).toBe(0);
    expect(await source.getTransactionCount(users[0]!.signerId)).toBe(0);
    await reserve.add(200_000n);
    await source.send('evm_setIntervalMining', [0]);
    await source.send('evm_setAutomine', [false]);
    const approval = await interruptRun('approval-interrupted', users[0]!.signerId, 0, source, false);
    await source.send('anvil_dropTransaction', [approval]);
    expect(await source.send('eth_getTransactionCount', [users[0]!.signerId, 'pending'])).toBe('0x0');
    expect(await withoutPreflightReports(stores.user, () => run('approval-unresolved'))).not.toBe(0);
    expect(sourceSubmissions).toBe(1);
    expect(readReport(join(root, 'approval-unresolved.json'))).toMatchObject({
      reason: `USDC_EXECUTION_APPROVAL_UNRESOLVED:${approval}`,
      preflight: null,
    });
    expect(await source.send('eth_sendRawTransaction', [firstApprovalWire!])).toBe(approval);
    await source.send('evm_mine', []);
    expect((await source.getTransactionReceipt(approval))?.status).toBe(1);
    await source.send('evm_setIntervalMining', [1]);
    const deposit = await interruptRun('deposit-interrupted', users[0]!.signerId, 1, source);
    expect(await status('status-deposit-interrupted')).toBe(0);
    const depositStatus = readReport(join(root, 'status-deposit-interrupted.log'));
    expect(depositStatus['lastConfirmedStep']).toBe('deposit');
    expect((depositStatus['slots'] as unknown[])[1]).toMatchObject({ hash: deposit, status: 'confirmed' });
    expect(sourceSubmissions).toBe(2);
    drainBeforeCollateral = true;
    expect(await run('lost-backing')).not.toBe(0);
    const stopped = readReport(join(root, 'lost-backing.json'));
    expect(stopped['reason']).toContain('USDC_EXECUTION_TARGET_BACKING_INSUFFICIENT');
    expect(stopped['lastConfirmedStep']).toBe('collateral');
    expect(stopped['route']).toBeNull();
    expect(await source.getTransactionCount(users[0]!.signerId)).toBe(3);
    expect(await target.getTransactionCount(targetHub.signerId)).toBe(0);
    await reserve.add(200_000n);
    coverFault.arm();
    tariffRace.arm();
    expect(await run('covered-stop')).not.toBe(0);
    expect(sourceArchiveUnavailable).toBe(true);
    sourceArchiveUnavailable = false;
    const covered = readReport(join(root, 'covered-stop.json'));
    expect(covered).toMatchObject({
      lastConfirmedStep: 'cover',
      target: { collateral: 899_801n, reserve: 0n, claim: 0n },
    });
    expect(inspectedCoverHashes).toEqual([coverFault.coverHash()!]);
    const slots = covered['slots'] as unknown[];
    expect(slots.slice(0, 3)).toEqual(
      Array.from({ length: 3 }, () => expect.objectContaining({ via: 'hash', status: 'confirmed' })),
    );
    const coverSlot = slots[3];
    expect(coverSlot).toMatchObject({ via: 'hash', knownHashes: [coverFault.coverHash()] });
    const coveredLogs = readFileSync(join(root, 'covered-stop.log'), 'utf8').match(
      /^USDC_EXECUTION_LOG_DIRECTORY:(.+)$/m,
    );
    expect(readFileSync(join(coveredLogs![1]!, 'execution.log'), 'utf8')).toContain('USDC_POC_COVER_TARIFF_STALE:1');
    expect(await status('covered-no-archive', true, false)).toBe(0);
    expect((readReport(join(root, 'covered-no-archive.log'))['slots'] as unknown[])[3]).toMatchObject({
      via: 'hash',
      hash: coverFault.coverHash(),
      status: 'confirmed',
    });
    const exit = await interruptRun('exit-interrupted', users[1]!.signerId, 0, target);
    expect(await status('status-exit-interrupted')).toBe(0);
    const exitStatus = readReport(join(root, 'status-exit-interrupted.log'));
    expect(exitStatus['lastConfirmedStep']).toBe('withdrawal');
    expect((exitStatus['slots'] as unknown[])[4]).toMatchObject({ hash: exit, status: 'confirmed' });
    expect(await run('resumed')).toBe(0);
    const report = readReport(join(root, 'resumed.json'));
    expect(stopped['preflight']).toMatchObject({ quote: { net: 899_801n } });
    expect(report['preflight']).toEqual(stopped['preflight']);
    expect(report['paid']).toBe(899_801n);
    expect(report['crossJ']).toMatchObject({
      authorization: { orderId: report['orderId'], status: 'intent' },
      sourceProof: { localFrameHanko: expect.any(String), peerFrameHanko: expect.any(String) },
      targetProof: { localFrameHanko: expect.any(String), peerFrameHanko: expect.any(String) },
    });
    expect(reportReceipts(report, 'ingress')).toHaveLength(3);
    expect(reportReceipts(report, 'target')).toHaveLength(2);
    expect(reportReceipts(report, 'ingress')[1]!.hash).toBe(deposit);
    expect(reportReceipts(report, 'target')[1]!.hash).toBe(exit);
    expect(sourceSubmissions).toBe(3);
    expect(targetSubmissions).toBe(2);
    expect(await source.getTransactionCount(users[0]!.signerId)).toBe(3);
    expect(await target.getTransactionCount(targetHub.signerId)).toBe(1);
    expect(await target.getTransactionCount(users[1]!.signerId)).toBe(1);
    expect(await status('status-complete', true, false)).toBe(0);
    const observed = readReport(join(root, 'status-complete.log'));
    expect(observed).toMatchObject({
      complete: true,
      lastConfirmedStep: 'withdrawal',
      remainingPrincipal: 0n,
      payout: { amount: 899_801n, recipient: users[1]!.signerId },
      slots: Array.from({ length: 5 }, () => expect.objectContaining({ status: 'confirmed', via: 'hash' })),
    });
    expect(await status('status-human', false)).toBe(0);
    const human = readFileSync(join(root, 'status-human.log'), 'utf8');
    expect(human).toContain('USDC run demo-01 · complete');
    expect(human).toContain('remainingPrincipal: 0n');
    expect(human).toContain(reportReceipts(report, 'target')[1]!.hash);
    console.log(`USDC_SUPERVISED_CLI_LOCAL_EVIDENCE:${root}`);
  } finally {
    sourceRpc.stop(true);
    sourceArchive.stop(true);
    targetRpc.stop(true);
    unavailableArchive.stop(true);
    source.destroy();
    target.destroy();
    await fixture.close();
  }
}, 180_000);

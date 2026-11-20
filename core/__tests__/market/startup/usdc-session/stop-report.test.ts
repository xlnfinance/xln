import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsonRpcProvider } from 'ethers';
import { STAND_LOCK_TOKEN_ENV } from '../../../../../tools/stand-lock';
import { safeStringify } from '../../../../protocol/serialization';
import { createUsdcFixture, stopFixtureChildren } from './fixture';
import { executionEntry, fundRun, issueAuthority, readReport } from './approval';
import { startReportRpc } from './report-rpc';

test('supervised stop reports the pending approval hash across grant expiry', async () => {
  const fixture = await createUsdcFixture();
  const { root, stores, apiBase, hubPort, mmPort } = fixture;
  const sourceUrl = fixture.rpcUpstreams.get('/rpc')!;
  const targetUrl = fixture.rpcUpstreams.get('/rpc2')!;
  const source = new JsonRpcProvider(sourceUrl, 11155111, { cacheTimeout: -1 });
  const target = new JsonRpcProvider(targetUrl, 421614, { cacheTimeout: -1 });
  const sourceUser = fixture.identities.find(role => role.role === 'user')!.chains[0]!.signerId;
  const submitted: string[] = [];
  const sourceRpc = startReportRpc(sourceUrl, source, '', async wire => {
    if (wire.from?.toLowerCase() !== sourceUser) return;
    if (wire.nonce !== 0) throw new Error('TEST_PENDING_APPROVAL_DEPENDENT_BROADCAST');
    await source.send('evm_setIntervalMining', [0]);
    await source.send('evm_setAutomine', [false]);
    submitted.push(wire.hash!);
  });
  try {
    await fundRun(fixture, source, target);
    const authority = join(root, 'authority.json');
    const stand = join(root, 'stand.json');
    const output = join(root, 'pending-stop.json');
    await issueAuthority(fixture, authority, 32_000);
    writeFileSync(stand, safeStringify({ directory: root, stores, apiBase, hubPort, mmPort }));
    await stopFixtureChildren(fixture.operators);
    fixture.closeGateway();
    const child = fixture.launch(
      'pending-run',
      executionEntry,
      ['run', '--stand', stand, '--authority-file', authority, '--run-id', 'demo-01', '--output', output],
      {
        ...fixture.roleEnv('user'),
        [STAND_LOCK_TOKEN_ENV]: process.env[STAND_LOCK_TOKEN_ENV],
        ETH_SEPOLIA_RPC: sourceRpc.url.toString(),
        ARB_SEPOLIA_RPC: targetUrl,
      },
    );
    const code = await new Promise<number | null>((resolve, reject) =>
      child.once('exit', resolve).once('error', reject),
    );
    expect(code).not.toBe(0);
    expect(submitted).toHaveLength(1);
    const report = readReport(output);
    expect(report).toMatchObject({
      status: 'stopped',
      lastConfirmedStep: null,
      preflight: { quote: { net: 899_801n } },
      slots: [
        expect.objectContaining({ step: 'approval', status: 'pending', hash: submitted[0], knownHashes: submitted }),
        ...Array.from({ length: 4 }, () => expect.objectContaining({ status: 'unobserved' })),
      ],
    });
    expect(await source.getTransactionReceipt(submitted[0]!)).toBeNull();
    expect(await source.getTransactionCount(sourceUser, 'latest')).toBe(0);
    expect(await source.getTransactionCount(sourceUser, 'pending')).toBe(1);
  } catch (error) {
    console.error(readFileSync(join(root, 'pending-run.log'), 'utf8'));
    throw error;
  } finally {
    sourceRpc.stop(true);
    source.destroy();
    target.destroy();
    await fixture.close();
  }
}, 90_000);

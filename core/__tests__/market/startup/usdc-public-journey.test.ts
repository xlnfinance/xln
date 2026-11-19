import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsonRpcProvider, NonceManager, Wallet } from 'ethers';
import { ERC20Mock__factory, Depository__factory } from '../../../../jurisdictions/typechain-types';
import { safeParse, safeStringify } from '../../../protocol/serialization';
import { requireBoundaryRecord } from '../../../protocol/boundary-validation';
import { createUsdcFixture, stopFixtureChildren, until } from './usdc-session/fixture';
import type { ChildProcess } from 'node:child_process';
import { requireSameRestoredProof } from '../../../scenarios/usdc-poc/recovery/evidence';
import { reportReceipts, startReportRpc } from './usdc-session/report-rpc';

const exited = (child: ChildProcess): Promise<number | null> =>
  new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });

test('authorized public-ID CLI completes five one-USDC runs on the same WAL and proves an old run without another debit', async () => {
  const fixture = await createUsdcFixture();
  const { root, stores, apiBase } = fixture;
  const direct = [fixture.rpcUpstreams.get('/rpc')!, fixture.rpcUpstreams.get('/rpc2')!];
  const providers = direct.map(rpc => new JsonRpcProvider(rpc));
  const signers = providers.map(
    provider =>
      new NonceManager(Wallet.fromPhrase('test test test test test test test test test test test junk', provider)),
  );
  const common = [
    '--directory',
    root,
    '--user-store',
    stores.user,
    '--api-base',
    apiBase,
    '--hub-url',
    `ws://127.0.0.1:${fixture.hubPort}/rpc`,
  ];
  const entry = 'jurisdictions/scripts/usdc-cross-j-preflight/execution/index.ts';
  const userEnv = fixture.roleEnv('user');
  const authorityPath = join(root, 'authority.json');
  const limitsPath = join(root, 'limits.json');
  const users = fixture.identities.find(value => value.role === 'user')!.chains;
  const targetRpc = startReportRpc(direct[1]!, providers[1]!, users[1]!.signerId);
  const launchRun = (name: string, runId = 'run-1', authorityFile = authorityPath) =>
    fixture.launch(
      name,
      entry,
      ['run', ...common, '--authority-file', authorityFile, '--run-id', runId, '--output', join(root, `${name}.json`)],
      userEnv,
    );
  let supervisor: ChildProcess | undefined;
  try {
    expect(
      await exited(
        fixture.launch(
          'accounts',
          'core/__tests__/fixtures/usdc-poc/fund-user.ts',
          [root, apiBase, '--accounts-only'],
          userEnv,
        ),
      ),
    ).toBe(0);
    const cap = {
      gasLimit: '2000000',
      maxFeePerGasWei: '5000000000',
      maxPriorityFeePerGasWei: '1000000000',
      totalFeeLimitWei: '150000000000000000',
    };
    writeFileSync(
      limitsPath,
      safeStringify({
        expiresAt: Date.now() + 600_000,
        runIds: ['run-1', 'run-2', 'run-3', 'run-4', 'run-5'],
        'source-user': cap,
        'target-user': cap,
        'target-hub': cap,
      }),
    );
    expect(
      await exited(
        fixture.launch(
          'prepare',
          entry,
          ['prepare', ...common, '--limits-file', limitsPath, '--output', authorityPath],
          userEnv,
        ),
      ),
    ).toBe(0);
    const proposed = requireBoundaryRecord(safeParse(readFileSync(authorityPath, 'utf8')), 'TEST_AUTHORITY_INVALID');
    expect(proposed['approved']).toBeFalse();
    const blocked = launchRun('unapproved');
    expect(await exited(blocked)).not.toBe(0);
    expect(await providers[0]!.getTransactionCount(users[0]!.signerId)).toBe(0);
    for (const [name, patch, message] of [
      ['expired', { approved: true, expiresAt: Date.now() - 1 }, 'USDC_EXECUTION_AUTHORITY_EXPIRED'],
      ['candidate', { approved: true, candidateDigest: '0'.repeat(64) }, 'USDC_EXECUTION_AUTHORITY_CANDIDATE_CHANGED'],
    ] as const) {
      const path = join(root, `${name}-authority.json`);
      writeFileSync(path, safeStringify({ ...proposed, ...patch }));
      expect(await exited(launchRun(name, 'run-1', path))).not.toBe(0);
      expect(readFileSync(join(root, `${name}.log`), 'utf8')).toContain(message);
      expect(await providers[0]!.getTransactionCount(users[0]!.signerId)).toBe(0);
    }
    // Authority is approved only for these private Anvil instances; the exact
    // production parser/gateway/CLI below has no test-mode bypass.
    writeFileSync(authorityPath, safeStringify({ ...proposed, approved: true }, 2), { mode: 0o600 });
    await stopFixtureChildren(fixture.operators);
    fixture.closeGateway();
    const gateway = fixture.launch(
      'execution-gateway',
      'jurisdictions/scripts/usdc-cross-j-preflight/operators/gateway.ts',
      ['--api-base', apiBase, '--authority-file', authorityPath],
      {
        ...userEnv,
        ETH_SEPOLIA_RPC: direct[0],
        ARB_SEPOLIA_RPC: targetRpc.url.toString(),
        POC_RUNTIME_421614_RPC: targetRpc.url.toString(),
      },
    );
    await until('execution-gateway', async () => {
      if (gateway.exitCode !== null) throw new Error(`TEST_GATEWAY_EXIT:${root}`);
      try {
        const response = await fetch(apiBase + '/rpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: safeStringify({ jsonrpc: '2.0', id: 1, method: 'xln_executionAuthority', params: [] }),
        });
        const value = requireBoundaryRecord(await response.json(), 'TEST_GATEWAY_REPLY');
        return typeof value['result'] === 'string';
      } catch {
        return false;
      }
    });
    for (const path of ['/history/rpc', '/history/rpc2']) {
      const response = await fetch(apiBase + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: safeStringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: ['0x'] }),
      });
      const reply = requireBoundaryRecord(await response.json(), 'TEST_HISTORY_REPLY');
      expect(requireBoundaryRecord(reply['error'], 'TEST_HISTORY_REJECT')['message']).toBe(
        'USDC_PREFLIGHT_RPC_REJECTED',
      );
    }
    expect(await providers[0]!.getTransactionCount(users[0]!.signerId)).toBe(0);
    expect(await providers[1]!.getTransactionCount(users[1]!.signerId)).toBe(0);
    supervisor = fixture.launch(
      'restored-operators',
      'jurisdictions/scripts/usdc-cross-j-preflight/operators/session/index.ts',
      [
        '--directory',
        root,
        '--api-base',
        apiBase,
        '--hub-port',
        String(fixture.hubPort),
        '--mm-port',
        String(fixture.mmPort),
        '--hub-store',
        stores.hub,
        '--mm-store',
        stores.mm,
        '--user-store',
        stores.user,
        '--external-gateway',
        '--operators-only',
      ],
      userEnv,
    );
    await until('restored-operators', async () => {
      if (supervisor!.exitCode !== null) throw new Error(`TEST_RESTORED_OPERATORS_EXIT:${root}`);
      const sessions = join(root, 'sessions');
      return (
        existsSync(sessions) && readdirSync(sessions).some(name => existsSync(join(sessions, name, 'session.json')))
      );
    });
    expect(await exited(launchRun('no-native'))).not.toBe(0);
    expect(readFileSync(join(root, 'no-native.log'), 'utf8')).toContain('USDC_EXECUTION_PAYER_NATIVE_INSUFFICIENT');
    expect(await providers[0]!.getTransactionCount(users[0]!.signerId)).toBe(0);
    for (const [index, chain] of fixture.chains.entries()) {
      for (const identity of fixture.identities.filter(value => value.role !== 'mm')) {
        const signer = identity.chains.find(value => value.chainId === chain.chainId)!.signerId;
        await (await signers[index]!.sendTransaction({ to: signer, value: 10n ** 18n })).wait();
      }
    }
    expect(await exited(launchRun('no-principal'))).not.toBe(0);
    expect(readFileSync(join(root, 'no-principal.log'), 'utf8')).toContain('USDC_EXECUTION_SOURCE_PRINCIPAL_MISSING');
    expect(await providers[0]!.getTransactionCount(users[0]!.signerId)).toBe(0);
    const token = ERC20Mock__factory.connect(fixture.chains[0]!.tokens.USDC.address, signers[0]!);
    const results = [];
    const interruptions = [];
    for (let index = 1; index <= 5; index++) {
      await (await token.transfer(users[0]!.signerId, 1_000_000n)).wait();
      const output = join(root, `run-${index}.json`);
      const point = index === 2 ? 'deposit' : index === 4 ? 'withdrawal' : null;
      let before: Record<string, unknown> | undefined;
      if (point) {
        const interrupted = fixture.launch(
          `cut-${point}`,
          'core/__tests__/fixtures/usdc-poc/fault-run.ts',
          [point, 'run', ...common, '--authority-file', authorityPath, '--run-id', `run-${index}`, '--output', output],
          userEnv,
        );
        expect(await exited(interrupted)).toBeNull();
        expect(interrupted.signalCode).toBe('SIGKILL');
        before = requireBoundaryRecord(
          safeParse(readFileSync(join(root, 'user', 'interruption.json'), 'utf8')),
          'TEST_CUT_PROOF',
        );
        expect(before['point']).toBe(point);
        expect(await providers[0]!.getTransactionCount(users[0]!.signerId)).toBe(point === 'deposit' ? 4 : 12);
        if (point === 'withdrawal') expect(await providers[1]!.getTransactionCount(users[1]!.signerId)).toBe(3);
      }
      const child = launchRun(`run-${index}`, `run-${index}`);
      expect(await exited(child)).toBe(0);
      const result = requireBoundaryRecord(safeParse(readFileSync(output, 'utf8')), 'TEST_RUN_REPORT');
      expect(result['paid']).toBe(899_801n);
      expect(result['sourceAmount']).toBe(1_000_000n);
      expect(result['fullSourcePocSuccess']).toBeTrue();
      if (before) {
        const after = requireBoundaryRecord(result['restored'], 'TEST_RESTORED_PROOF');
        requireSameRestoredProof(before, after);
        interruptions.push({ runId: `run-${index}`, point, before, after });
      }
      results.push(result);
    }
    expect(new Set(results.map(result => result['orderId'])).size).toBe(5);
    const before = await providers[0]!.getTransactionCount(users[0]!.signerId);
    expect(before).toBe(15);
    expect(await providers[1]!.getTransactionCount(users[1]!.signerId)).toBe(5);
    const targetHub = fixture.identities.find(value => value.role === 'hub')!.chains[1]!;
    const targetToken = ERC20Mock__factory.connect(fixture.chains[1]!.tokens.USDC.address, providers[1]!);
    const depository = Depository__factory.connect(fixture.chains[1]!.contracts.depository, providers[1]!);
    expect(await targetToken.balanceOf(users[1]!.signerId)).toBe(4_499_005n);
    expect(await depository._reserves(targetHub.entityId, 1)).toBe(500_995n);
    expect(await providers[1]!.getTransactionCount(targetHub.signerId)).toBe(5);
    expect(
      new Set(results.map(result => requireBoundaryRecord(result['runtime'], 'TEST_RUNTIME')['runtimeId'])).size,
    ).toBe(1);
    expect(interruptions).toHaveLength(2);
    writeFileSync(join(root, 'interruptions.json'), safeStringify(interruptions, 2));
    const ledger = [];
    for (const [index, chain] of fixture.chains.entries()) {
      const provider = providers[index]!;
      const point = await provider.getBlock('latest');
      if (!point?.hash) throw new Error('TEST_FINAL_CHAIN_POINT_MISSING');
      const at = { blockTag: point.number };
      const depos = Depository__factory.connect(chain.contracts.depository, provider);
      const usdc = ERC20Mock__factory.connect(chain.tokens.USDC.address, provider);
      const hub = fixture.identities.find(value => value.role === 'hub')!.chains[index]!;
      ledger.push({
        chainId: chain.chainId,
        blockNumber: point.number,
        blockHash: point.hash,
        user: users[index]!,
        hub,
        userNonce: await provider.getTransactionCount(users[index]!.signerId, point.number),
        hubNonce: await provider.getTransactionCount(hub.signerId, point.number),
        userTokens: await usdc.balanceOf(users[index]!.signerId, at),
        hubReserve: await depos._reserves(hub.entityId, 1, at),
        userEntityNonce: await depos.entityNonces(users[index]!.entityId, at),
      });
    }
    writeFileSync(join(root, 'final-ledger.json'), safeStringify(ledger, 2));
    expect(await exited(launchRun('sixth-run', 'run-6'))).not.toBe(0);
    expect(readFileSync(join(root, 'sixth-run.log'), 'utf8')).toContain('USDC_EXECUTION_RUN_NOT_AUTHORIZED');
    const duplicate = launchRun('repeat-old');
    expect(await exited(duplicate)).toBe(0);
    const first = results[0]!;
    const repeated = requireBoundaryRecord(
      safeParse(readFileSync(join(root, 'repeat-old.json'), 'utf8')),
      'TEST_REPEAT',
    );
    const sourceReceipts = reportReceipts(first, 'ingress');
    const targetReceipts = reportReceipts(first, 'target');
    expect(sourceReceipts).toHaveLength(3);
    expect(targetReceipts).toHaveLength(2);
    expect(targetReceipts[1]!.blockNumber - targetReceipts[0]!.blockNumber).toBeGreaterThan(10);
    expect(reportReceipts(repeated, 'target')).toEqual(targetReceipts);
    expect(reportReceipts(repeated, 'ingress')).toEqual(sourceReceipts);
    expect(repeated['paid']).toBe(899_801n);
    expect(await providers[0]!.getTransactionCount(users[0]!.signerId)).toBe(before);
    expect(await providers[1]!.getTransactionCount(users[1]!.signerId)).toBe(5);
    expect(await providers[1]!.getTransactionCount(targetHub.signerId)).toBe(5);
    console.log(`USDC_PUBLIC_CLI_LOCAL_EVIDENCE:${root}`);
  } finally {
    if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) {
      const stopped = exited(supervisor);
      supervisor.kill('SIGTERM');
      await stopped;
    }
    for (const provider of providers) provider.destroy();
    await fixture.close();
    targetRpc.stop(true);
  }
}, 180_000);

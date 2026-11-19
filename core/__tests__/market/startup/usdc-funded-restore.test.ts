import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { JsonRpcProvider, Wallet } from 'ethers';
import { Depository__factory, ERC20Mock__factory } from '../../../../jurisdictions/typechain-types';
import { requireBoundaryRecord } from '../../../protocol/boundary-validation';
import { safeStringify } from '../../../protocol/serialization';
import {
  sessionArgs,
  type SessionConfig,
} from '../../../../jurisdictions/scripts/usdc-cross-j-preflight/operators/session/config';
import { createUsdcFixture, freePort, stopFixtureChildren, until } from './usdc-session/fixture';

const record = (path: string): Record<string, unknown> =>
  requireBoundaryRecord(JSON.parse(readFileSync(path, 'utf8')), 'USDC_SESSION_TEST_RECORD_INVALID');
const exited = async (child: ChildProcess) => {
  await until('child-exit', async () => child.exitCode !== null || child.signalCode !== null);
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return false;
  }
};

test('funded user, Hub and MM restore exact WAL state, reject conflicts and stop together on child failure', async () => {
  const fixture = await createUsdcFixture();
  const { root, stores, apiBase, hubPort, mmPort } = fixture;
  const config: SessionConfig = {
    startupTimeoutMs: 60_000,
    directory: root,
    stores,
    apiBase,
    hubPort,
    mmPort,
    externalGateway: true,
    operatorsOnly: false,
    authorityFile: null,
  };
  const providers = fixture.chains.map(chain => new JsonRpcProvider(chain.rpc));
  const observations: unknown[] = [];
  const launch = (name: string, selected = config) =>
    fixture.launch(
      name,
      'jurisdictions/scripts/usdc-cross-j-preflight/operators/session/index.ts',
      sessionArgs(selected),
      {
        PATH: process.env['PATH'],
        HOME: process.env['HOME'],
        TMPDIR: process.env['TMPDIR'],
        ETH_SEPOLIA_RPC: fixture.chains[0]!.rpc,
        ARB_SEPOLIA_RPC: fixture.chains[1]!.rpc,
        POC_RUNTIME_421614_RPC: fixture.chains[1]!.rpc,
      },
    );
  const snapshot = async () =>
    Promise.all(
      fixture.chains.map(async (chain, index) => {
        const provider = providers[index]!;
        const depository = Depository__factory.connect(chain.contracts.depository, provider);
        const token = ERC20Mock__factory.connect(chain.tokens.USDC.address, provider);
        const user = fixture.identities.find(identity => identity.role === 'user')!.chains[index]!;
        const hub = fixture.identities.find(identity => identity.role === 'hub')!.chains[index]!;
        const point = await provider.getBlock('latest');
        if (!point || !point.hash) throw new Error('USDC_SESSION_TEST_CHAIN_POINT_MISSING');
        const at = { blockTag: point.number };
        const balances = {
          userNonce: String(await depository.entityNonces(user.entityId, at)),
          userReserve: String(await depository._reserves(user.entityId, 1, at)),
          hubReserve: String(await depository._reserves(hub.entityId, 1, at)),
          userTokens: String(await token.balanceOf(user.signerId, at)),
          backing: String(await token.balanceOf(chain.contracts.depository, at)),
          userWalletNonce: await provider.getTransactionCount(user.signerId, point.number),
          userNativeWei: String(await provider.getBalance(user.signerId, point.number)),
        };
        observations.push({ chainId: chain.chainId, blockNumber: point.number, blockHash: point.hash, balances });
        return balances;
      }),
    );
  const ready = async (child: ChildProcess, previous: string[]) => {
    let result = '';
    await until('session-ready', async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`USDC_SESSION_TEST_EXIT:${root}`);
      const current = readdirSync(join(root, 'sessions')).filter(name => !previous.includes(name));
      if (current.length !== 1) return false;
      result = join(root, 'sessions', current[0]!);
      try {
        return record(join(result, 'session.json'))['status'] === 'ready';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    });
    return result;
  };
  try {
    const empty = join(root, 'user', 'empty');
    mkdirSync(empty, { mode: 0o700 });
    const required = fixture.launch(
      'require-restore',
      '-e',
      ["const {main}=await import('./core/runtime');await main(process.env.XLN_RUNTIME_SEED,{requireRestore:true});"],
      { ...fixture.roleEnv('user'), XLN_RDB_ROOT: empty, XLN_DB_PATH: join(empty, 'db') },
    );
    await exited(required);
    expect(required.exitCode).not.toBe(0);
    expect(readFileSync(join(root, 'require-restore.log'), 'utf8')).toContain('RUNTIME_RESTORE_REQUIRED');

    const user = fixture.launch(
      'fund-user',
      'core/__tests__/fixtures/usdc-poc/fund-user.ts',
      [root, apiBase],
      fixture.roleEnv('user'),
    );
    await exited(user);
    if (user.exitCode !== 0) throw new Error(`USDC_SESSION_FUND_USER_FAILED:${root}`);
    const funded = record(join(root, 'funded-user.json'));
    const before = await snapshot();
    await stopFixtureChildren(fixture.operators, 'SIGKILL');

    const missing = launch('missing-store', { ...config, stores: { ...stores, user: empty } });
    await exited(missing);
    expect(missing.exitCode).not.toBe(0);

    const vault = join(root, 'mm', 'vault.seed');
    const original = readFileSync(vault, 'utf8');
    renameSync(vault, vault + '.held');
    const absentVault = launch('absent-vault');
    await exited(absentVault);
    expect(absentVault.exitCode).not.toBe(0);
    expect(existsSync(vault)).toBeFalse();
    renameSync(vault + '.held', vault);
    writeFileSync(vault, readFileSync(join(root, 'hub', 'vault.seed')), { mode: 0o600 });
    const wrongVault = launch('wrong-vault');
    await exited(wrongVault);
    expect(wrongVault.exitCode).not.toBe(0);
    expect(readFileSync(join(root, 'wrong-vault.log'), 'utf8')).toContain('USDC_SESSION_IDENTITIES_NOT_DISTINCT');
    writeFileSync(vault, original, { mode: 0o600 });
    writeFileSync(vault, Wallet.createRandom().mnemonic!.phrase, { mode: 0o600 });
    const foreignVault = launch('foreign-vault');
    await exited(foreignVault);
    expect(foreignVault.exitCode).not.toBe(0);
    writeFileSync(vault, original, { mode: 0o600 });

    const catalogPath = join(root, 'jurisdictions.json');
    const originalCatalog = readFileSync(catalogPath, 'utf8');
    const catalog = record(catalogPath);
    const jurisdictions = requireBoundaryRecord(catalog['jurisdictions'], 'TEST_JURISDICTIONS');
    const source = requireBoundaryRecord(jurisdictions['rpc'], 'TEST_SOURCE');
    const contracts = requireBoundaryRecord(source['contracts'], 'TEST_CONTRACTS');
    contracts['entityProvider'] = `0x${'44'.repeat(20)}`;
    writeFileSync(catalogPath, safeStringify(catalog));
    const wrongConfig = launch('wrong-config');
    await exited(wrongConfig);
    expect(wrongConfig.exitCode).not.toBe(0);
    writeFileSync(catalogPath, originalCatalog);
    expect(await snapshot()).toEqual(before);

    const protectedApi = `http://127.0.0.1:${await freePort()}`;
    const protectedConfig = { ...config, apiBase: protectedApi, externalGateway: false };
    const protectedCatalog = record(catalogPath);
    const protectedJurisdictions = requireBoundaryRecord(protectedCatalog['jurisdictions'], 'TEST_JURISDICTIONS');
    requireBoundaryRecord(protectedJurisdictions['rpc'], 'TEST_SOURCE')['rpc'] = protectedApi + '/rpc';
    requireBoundaryRecord(protectedJurisdictions['rpc2'], 'TEST_TARGET')['rpc'] = protectedApi + '/rpc2';
    writeFileSync(catalogPath, safeStringify(protectedCatalog));
    const beforeBlocked = readdirSync(join(root, 'sessions'));
    const occupiedHubPort = Number(new URL(fixture.rpcUpstreams.get('/rpc')!).port);
    const blockedHub = launch('hub-port-occupied', { ...protectedConfig, hubPort: occupiedHubPort });
    await exited(blockedHub);
    expect(blockedHub.exitCode).not.toBe(0);
    const blockedRuns = readdirSync(join(root, 'sessions')).filter(name => !beforeBlocked.includes(name));
    expect(blockedRuns).toHaveLength(1);
    const blockedRun = join(root, 'sessions', blockedRuns[0]!);
    expect(existsSync(join(blockedRun, 'hub.log'))).toBeTrue();
    expect(existsSync(join(blockedRun, 'mm.log'))).toBeFalse();

    const previous = readdirSync(join(root, 'sessions'));
    const session = launch('session', protectedConfig);
    const directory = await ready(session, previous);
    const restored = record(join(directory, 'user-restored.json'));
    for (const key of ['runtimeId', 'height', 'canonicalStateHash', 'entityHashes', 'accounts', 'orderedOutboxDigest'])
      expect(restored[key]).toEqual(funded[key]);
    expect(restored['pid']).not.toBe(funded['pid']);
    for (const role of ['hub', 'mm']) {
      const proof = record(join(directory, `${role}-restored.json`));
      expect(Number(proof['livePulls'])).toBeGreaterThan(0);
      expect(Number(proof['committedOffers'])).toBeGreaterThan(0);
      expect(String(proof['canonicalStateHash']).length).toBeGreaterThan(10);
    }
    const duplicate = launch('duplicate', protectedConfig);
    await exited(duplicate);
    expect(duplicate.exitCode).not.toBe(0);
    expect(readFileSync(join(root, 'duplicate.log'), 'utf8')).toContain('USDC_SESSION_STORE_BUSY:hub');
    expect(session.exitCode).toBeNull();
    expect(await snapshot()).toEqual(before);

    const sessionRecord = record(join(directory, 'session.json'));
    if (!Array.isArray(sessionRecord['children'])) throw new Error('TEST_SESSION_CHILDREN');
    const owned = sessionRecord['children'].map(value => requireBoundaryRecord(value, 'TEST_CHILD'));
    const failed = owned.find(value => value['name'] === 'user')!;
    process.kill(Number(failed['pid']), 'SIGKILL');
    await exited(session);
    expect(session.exitCode).not.toBe(0);
    expect(owned.every(value => !alive(Number(value['pid'])))).toBeTrue();
    const previousRuns = readdirSync(join(root, 'sessions'));
    const restarted = launch('session-again', protectedConfig);
    const second = await ready(restarted, previousRuns);
    expect(await snapshot()).toEqual(before);
    const secondRecord = record(join(second, 'session.json'));
    if (!Array.isArray(secondRecord['children'])) throw new Error('TEST_SECOND_SESSION_CHILDREN');
    const secondOwned = secondRecord['children'].map(value => requireBoundaryRecord(value, 'TEST_CHILD'));
    restarted.kill('SIGKILL');
    await exited(restarted);
    await until('orphan-shutdown', async () => secondOwned.every(value => !alive(Number(value['pid']))));
    expect(secondOwned.every(value => !alive(Number(value['pid'])))).toBeTrue();
    const lastRuns = readdirSync(join(root, 'sessions'));
    const last = launch('session-final', { ...protectedConfig, startupTimeoutMs: 6 * 60 * 60 * 1_000 });
    const third = await ready(last, lastRuns);
    expect(await snapshot()).toEqual(before);
    last.kill('SIGTERM');
    await exited(last);
    expect(last.exitCode).toBe(0);

    const beforeHubOnly = readdirSync(join(root, 'sessions'));
    const hubOnly = launch('session-hub-only', { ...protectedConfig, hubOnly: true });
    const hubOnlyRun = await ready(hubOnly, beforeHubOnly);
    const hubOnlyRecord = record(join(hubOnlyRun, 'session.json'));
    const hubOnlyChildren = hubOnlyRecord['children'];
    if (!Array.isArray(hubOnlyChildren)) throw new Error('TEST_HUB_ONLY_SESSION_CHILDREN');
    const childNames = hubOnlyChildren.map(value => requireBoundaryRecord(value, 'TEST_CHILD')['name']);
    expect(childNames).toEqual(['gateway', 'hub']);
    expect(hubOnlyRecord['gateway']).toBe('read-only');
    expect(existsSync(join(hubOnlyRun, 'mm-restored.json'))).toBeFalse();
    expect(existsSync(join(hubOnlyRun, 'user-restored.json'))).toBeFalse();
    hubOnly.kill('SIGTERM');
    await exited(hubOnly);
    expect(hubOnly.exitCode).toBe(0);
    expect(await snapshot()).toEqual(before);
    writeFileSync(
      join(root, 'restored-session-result.json'),
      safeStringify(
        {
          status: 'complete',
          before,
          firstSession: directory,
          secondSession: second,
          thirdSession: third,
          hubOnlySession: hubOnlyRun,
          exactUserRestore: true,
          liveOperatorPullsPreserved: true,
          duplicateFunding: false,
          rejected: ['missing-state', 'missing-vault', 'wrong-vault', 'wrong-contract', 'occupied-hub-port', 'concurrent-owner'],
          failedHubPreventsMmStart: true,
          allOwnedChildrenStoppedAfterFailure: true,
          allOwnedChildrenStoppedAfterSupervisorCrash: true,
          observations,
        },
        2,
      ),
    );
    console.log(`USDC_FUNDED_RESTORE_EVIDENCE:${root}`);
  } finally {
    for (const provider of providers) provider.destroy();
    await fixture.close();
  }
}, 180_000);

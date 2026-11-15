import { safeStringify } from '../../../protocol/serialization';
import { describe, expect, test } from 'bun:test';
import { getAddress } from 'ethers';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ERC20Mock__factory } from '../../../../jurisdictions/typechain-types/factories/ERC20Mock__factory';
import {
  decodeDeploymentIntent,
  decodeDeploymentParameters,
  type DeploymentArguments,
} from '../../../../jurisdictions/scripts/deployment/operator/inputs';
import { sanitizeDeploymentMessage } from '../../../../jurisdictions/scripts/deployment/evidence.cjs';
import { privateKey } from '../stack-manager-recovery/stack-manager-resume-support';
import { startStandaloneNode } from './support/standalone-deployment-support';

const tokenAddress = '0x1111111111111111111111111111111111111111';
const otherAccount = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const parameters = () => ({ chainId: 11155111, stablecoin: { kind: 'existing' as const, address: tokenAddress }, confirmations: 12 });
const intent = (): DeploymentArguments => ({
  parameters: '/tmp/xln-deployment-parameters.json', deploymentId: 'operator-attempt_1', deploymentDir: undefined, mode: 'new',
});

describe('Standalone deployment admission', () => {
  test('keeps reusable parameters independent from attempt identity and normalizes addresses', () => {
    const input = Object.freeze({ ...parameters(), foundationRecipient: otherAccount.toLowerCase() });
    const first = decodeDeploymentParameters(input);
    const second = decodeDeploymentParameters(input);
    expect(first).toEqual({ ...parameters(), foundationRecipient: getAddress(otherAccount) });
    expect(second).toEqual(first);
    expect(decodeDeploymentParameters({ chainId: 31337, stablecoin: { kind: 'test' }, confirmations: 12 }))
      .toEqual({ chainId: 31337, stablecoin: { kind: 'test' }, confirmations: 12 });
    expect(decodeDeploymentIntent(intent()).deploymentId).toBe('operator-attempt_1');
    expect(decodeDeploymentIntent({ ...intent(), deploymentId: 'another-attempt', mode: 'resume' }).mode).toBe('resume');
    expect(decodeDeploymentParameters(input)).toEqual(first);
  });

  test('rejects secret laundering, retired fields and incomplete parameter objects', () => {
    for (const value of [null, [], 'parameters', 42]) {
      expect(() => decodeDeploymentParameters(value)).toThrow('XLN_DEPLOY_OBJECT_REQUIRED');
    }
    for (const key of ['privateKey', 'rpcUrl', 'deploymentId', 'mode', 'stackVersion', 'wrappedNative']) {
      expect(() => decodeDeploymentParameters({ ...parameters(), [key]: 'forbidden' }))
        .toThrow('XLN_DEPLOY_PARAMETERS_KEYS_INVALID');
    }
    for (const key of ['chainId', 'stablecoin', 'confirmations']) {
      const incomplete: Record<string, unknown> = parameters();
      delete incomplete[key];
      expect(() => decodeDeploymentParameters(incomplete)).toThrow('XLN_DEPLOY_PARAMETERS_KEYS_INVALID');
    }
  });

  test('requires exact safe chain IDs and at least twelve whole confirmations', () => {
    for (const chainId of [0, -1, 1.5, '11155111', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null]) {
      expect(() => decodeDeploymentParameters({ ...parameters(), chainId })).toThrow('XLN_DEPLOY_CHAIN_ID_INVALID');
    }
    for (const confirmations of [0, 1, 11, 12.5, '12', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null]) {
      expect(() => decodeDeploymentParameters({ ...parameters(), confirmations })).toThrow('XLN_DEPLOY_CONFIRMATIONS_INVALID');
    }
  });

  test('rejects ambiguous token shape and missing or zero authority addresses', () => {
    for (const stablecoin of [
      { kind: 'existing' }, { kind: 'test', address: tokenAddress },
      { kind: 'existing' as const, address: tokenAddress, decimals: 6 }, { kind: 'fixture' },
    ]) expect(() => decodeDeploymentParameters({ ...parameters(), stablecoin })).toThrow();
    for (const address of ['', '0x1234', `0x${'0'.repeat(40)}`, 1, null, undefined]) {
      expect(() => decodeDeploymentParameters({ ...parameters(), stablecoin: { kind: 'existing', address } }))
        .toThrow('XLN_DEPLOY_ADDRESS_INVALID');
      expect(() => decodeDeploymentParameters({ ...parameters(), foundationRecipient: address }))
        .toThrow('XLN_DEPLOY_ADDRESS_INVALID');
    }
    expect(() => decodeDeploymentParameters({ ...parameters(), stablecoin: null })).toThrow('XLN_DEPLOY_OBJECT_REQUIRED');
  });

  test('requires an explicit attempt and exact new or resume intent', () => {
    expect(() => decodeDeploymentIntent({ ...intent(), parameters: undefined })).toThrow('XLN_DEPLOY_PARAMETERS_REQUIRED');
    expect(() => decodeDeploymentIntent({ ...intent(), parameters: '' })).toThrow('XLN_DEPLOY_PARAMETERS_REQUIRED');
    for (const deploymentId of [undefined, '', '../other', '/other', 'a/b', 'a\\b', '.hidden', 'a b', 'a'.repeat(81)]) {
      expect(() => decodeDeploymentIntent({ ...intent(), deploymentId })).toThrow('XLN_DEPLOYMENT_ID_INVALID');
    }
    for (const mode of [undefined, '', 'reset', 'NEW', 'Resume', 'new ']) {
      expect(() => decodeDeploymentIntent({ ...intent(), mode })).toThrow('XLN_DEPLOYMENT_MODE_INVALID');
    }
  });

  test('redacts key variants and credential-bearing RPC URLs without losing the final error', () => {
    const secret = `0x${'a1'.repeat(32)}`;
    const rpc = 'https://fixture-user:fixture-pass@rpc.example.invalid/rpc/FIXTURE_PATH_KEY?apiKey=FIXTURE_QUERY_KEY';
    const message = `${secret} ${secret.slice(2).toUpperCase()} ${rpc}\nhttps://other.example.invalid/secret\rFINAL_FAILURE`;
    const sanitized = sanitizeDeploymentMessage(message, secret, rpc);
    expect(sanitized).toContain('[REDACTED_PRIVATE_KEY]');
    expect(sanitized).toContain('[REDACTED_RPC_URL]');
    expect(sanitized).toEndWith('FINAL_FAILURE');
    for (const forbidden of [secret, secret.slice(2).toUpperCase(), 'fixture-user', 'fixture-pass', 'FIXTURE_PATH_KEY',
      'FIXTURE_QUERY_KEY', 'other.example.invalid', '\n', '\r']) expect(sanitized).not.toContain(forbidden);
    expect(sanitizeDeploymentMessage(`${'x'.repeat(5_000)} FINAL_FAILURE`, secret, rpc)).toHaveLength(4_096);
  });
});

test('native task rejects wrong chain, Foundation and token metadata before sending', async () => {
  const fixture = await startStandaloneNode(0);
  let child: ReturnType<typeof fixture.startNative> | undefined;
  try {
    const wrongDecimals = await new ERC20Mock__factory(fixture.signer).deploy('Wrong Decimal Token', 'BAD', 18, 1_000_000n);
    await wrongDecimals.waitForDeployment();
    expect(await wrongDecimals.decimals()).toBe(18n);
    expect(await fixture.provider.getCode(otherAccount)).toBe('0x');
    const base = { chainId: 31337, stablecoin: fixture.request.stablecoin, confirmations: 12 };
    const cases = [
      { name: 'chain', changes: { chainId: 11155111 }, error: 'STACK_MANAGER_CHAIN_ID_MISMATCH' },
      { name: 'foundation', changes: { foundationRecipient: otherAccount }, error: 'FOUNDATION_LISTING_SIGNER_MISMATCH' },
      { name: 'token-code', changes: { stablecoin: { kind: 'existing', address: otherAccount } }, error: 'DEPLOYMENT_TOKEN_CODE_MISSING' },
      { name: 'token-decimals', changes: { stablecoin: { kind: 'existing', address: await wrongDecimals.getAddress() } },
        error: 'DEPLOYMENT_TOKEN_DECIMALS_MISMATCH' },
    ];
    const nonce = await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'pending']);
    for (const scenario of cases) {
      await writeFile(fixture.parameters, safeStringify({ ...base, ...scenario.changes }));
      const nativeDirectory = join(fixture.directory, `rejected-${scenario.name}`);
      child = fixture.startNative({ parameters: fixture.parameters, nativeDirectory, mode: 'new', name: scenario.name });
      expect(await child.exited).not.toBe(0);
      const log = await fixture.read(`${scenario.name}.log`);
      expect(log).toContain(scenario.error);
      expect(log).not.toContain(privateKey);
      expect(log).not.toContain(fixture.request.rpcUrl);
      expect(fixture.submissions()).toBe(0);
      expect(await fixture.provider.send('eth_getTransactionCount', [fixture.signer.address, 'pending'])).toBe(nonce);
      expect(await Bun.file(join(nativeDirectory, 'manifest.json')).exists()).toBeFalse();
      expect(await Bun.file(fixture.catalog).exists()).toBeFalse();
    }
    await writeFile(fixture.parameters, safeStringify(base));
    await fixture.provider.send('anvil_setBalance', [fixture.signer.address, '0x0']);
    const failedDirectory = join(fixture.directory, 'failed-valid-attempt');
    child = fixture.startNative({ parameters: fixture.parameters, nativeDirectory: failedDirectory, mode: 'new', name: 'no-gas' });
    expect(await child.exited).not.toBe(0);
    const failed = await Bun.file(join(failedDirectory, 'result.json')).json();
    expect(failed.status).toBe('failed');
    expect(failed.error.code).toBe('STACK_MANAGER_SIGNER_GAS_BALANCE_EMPTY');
    expect(failed.expenses.coverage).toBe('unavailable');
    expect(fixture.submissions()).toBe(0);
    console.log(`STANDALONE_ADMISSION_EVIDENCE:${fixture.directory}:rejections=4:sends=0`);
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await child.exited; }
    await fixture.close();
  }
}, 180_000);

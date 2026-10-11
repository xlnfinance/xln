import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HDNodeWallet } from 'ethers';
import { requireBoundaryRecord } from '../../../protocol/boundary-validation';
import { safeStringify } from '../../../protocol/serialization';
import { acquireLocalTestPortLease } from '../../../scripts/e2e/harness/local-test-port-lease';

const run = async (cmd: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> => {
  const child = Bun.spawn(cmd, { cwd, env, stdout: 'pipe', stderr: 'pipe', timeout: 50_000 });
  const [status, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (status !== 0) throw new Error(`PUBLIC_PROOF_CHILD_FAILED:${status}\n${stdout}\n${stderr}`);
  return stdout;
};

const rpcCall = async (rpc: string, method: string, params: unknown[]): Promise<unknown> => {
  const response = await fetch(rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: safeStringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(1_000),
  });
  const payload = requireBoundaryRecord(await response.json(), 'PUBLIC_PROOF_RPC_INVALID');
  if (payload['error']) throw new Error(`PUBLIC_PROOF_RPC_ERROR:${safeStringify(payload['error'])}`);
  return payload['result'];
};

const waitForRpc = async (rpc: string): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if (await rpcCall(rpc, 'eth_chainId', []) === '0x7a69') return;
      throw new Error('PUBLIC_PROOF_RPC_CHAIN_INVALID');
    } catch (error) {
      if (attempt === 49) throw error;
    }
    await Bun.sleep(100);
  }
  throw new Error('PUBLIC_PROOF_RPC_NOT_READY');
};

test.each([
  { name: 'secured collateral', unsecuredClaim: 0n, keyIndex: 0 },
  { name: 'unsecured shortfall', unsecuredClaim: 150n, keyIndex: 0 },
  { name: 'unsecured shortfall from left', unsecuredClaim: 150n, keyIndex: 3 },
])('public proof command: $name with a real clock and changed-code rejection', async ({ unsecuredClaim, keyIndex }) => {
  const root = process.cwd();
  const work = await mkdtemp(join(tmpdir(), 'xln-public-proof-'));
  const lease = await acquireLocalTestPortLease({ requiredOffsets: [0] });
  const rpc = `http://127.0.0.1:${lease.basePort}`;
  const key = HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, `m/44'/60'/0'/0/${keyIndex}`).privateKey;
  const node = Bun.spawn([
    'anvil', '--host', '127.0.0.1', '--port', String(lease.basePort),
    '--chain-id', '31337', '--block-time', '1',
  ], { stdout: 'ignore', stderr: 'inherit' });
  try {
    await waitForRpc(rpc);
    const deploymentPath = join(work, 'deployment.json');
    await run(['bunx', '--bun', 'hardhat', 'run', 'scripts/deploy-stack.cjs', '--network', 'stack-manager', '--no-compile'], join(root, 'jurisdictions'), {
      ...process.env, DEPLOYER_PRIVATE_KEY: key, XLN_FOUNDATION_ADDRESS: '', XLN_STABLECOIN_ADDRESS: '',
      XLN_STACK_MANAGER_RPC_URL: rpc, XLN_STACK_MANAGER_CHAIN_ID: '31337',
      XLN_DEPLOY_TEST_STABLECOIN: '1', XLN_DEPLOY_OUTPUT: deploymentPath,
    });
    const deployment = requireBoundaryRecord(await Bun.file(deploymentPath).json(), 'PUBLIC_PROOF_DEPLOYMENT_INVALID');
    await mkdir(join(work, 'jurisdictions'));
    await Bun.write(join(work, 'jurisdictions/jurisdictions.json'), safeStringify({ jurisdictions: {
      rehearsal: { chainId: 31337, rpc, contracts: deployment['contracts'], tokens: deployment['registeredTokens'] },
    } }));
    const command = ['bun', join(root, 'jurisdictions/scripts/public-proof-smoke.ts'), '--jurisdiction=rehearsal', `--unsecured-claim=${unsecuredClaim}`];
    const proofEnv = { ...process.env, PUBLIC_CHAIN_PRIVATE_KEY: key };
    const output = await run(command, work, proofEnv);
    const report = requireBoundaryRecord(JSON.parse(output), 'PUBLIC_PROOF_REPORT_INVALID');
    expect(report['kind']).toBe('PUBLIC_PROOF_SMOKE');
    expect(report['ownerReserve']).toBe(unsecuredClaim === 0n ? '850' : '950');
    expect(report['counterpartyReserve']).toBe(unsecuredClaim === 0n ? '100' : '0');
    expect(report['fundedCollateral']).toBe('850');
    expect(report['finalCollateral']).toBe('0');
    expect(report['disputeWindowSeconds']).toBe(10);
    expect(report['unsecuredClaim']).toBe(unsecuredClaim.toString());
    expect(report['collectedUnsecured']).toBe(unsecuredClaim === 0n ? '0' : '100');
    expect(report['remainingDebt']).toBe(unsecuredClaim === 0n ? '0' : '50');
    expect(report['debtCreditor']).toBe(unsecuredClaim === 0n ? null : report['ownerEntityId']);
    expect(report['debtIndex']).toBe(unsecuredClaim === 0n ? null : '0');
    expect(report['ownerIsLeft']).toBe(keyIndex === 3);
    for (const field of ['depositTransactionHash', 'settlementTransactionHash', 'collateralFundingTransactionHash', 'disputeStartTransactionHash', 'disputeFinalizeTransactionHash', 'withdrawalTransactionHash']) {
      expect(report[field]).toMatch(/^0x[0-9a-f]{64}$/);
    }
    console.log(output.trim());
    if (unsecuredClaim > 0n) {
      const nonceBeforeRetry = await rpcCall(rpc, 'eth_getTransactionCount', [deployment['deployer'], 'pending']);
      await expect(run(command, work, proofEnv)).rejects.toThrow('PUBLIC_PROOF_REQUIRES_DEBT_FREE_ENTITIES');
      expect(await rpcCall(rpc, 'eth_getTransactionCount', [deployment['deployer'], 'pending'])).toBe(nonceBeforeRetry);
    }
    // A stale/corrupt deployment must fail before the operator signs approval
    // or deposits again; a successful prior proof cannot authorize different code.
    const contracts = requireBoundaryRecord(deployment['contracts'], 'PUBLIC_PROOF_CONTRACTS_INVALID');
    const beforeNonce = await rpcCall(rpc, 'eth_getTransactionCount', [deployment['deployer'], 'pending']);
    await rpcCall(rpc, 'anvil_setCode', [contracts['deltaTransformer'], '0x60006000f3']);
    await expect(run(command, work, proofEnv)).rejects.toThrow('PUBLIC_PROOF_CODE_MISMATCH:deltaTransformer');
    expect(await rpcCall(rpc, 'eth_getTransactionCount', [deployment['deployer'], 'pending'])).toBe(beforeNonce);
  } finally {
    node.kill('SIGTERM');
    await node.exited;
    lease.release();
    await rm(work, { recursive: true, force: true });
  }
}, 60_000);

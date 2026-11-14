import { expect, test } from 'bun:test';
import { JsonRpcProvider, Wallet, getBytes } from 'ethers';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERC20Mock__factory } from '../../../jurisdictions/typechain-types/factories/ERC20Mock__factory';
import { validateJurisdictionsDataValue } from '../../jurisdiction/adapter/kernel/jurisdiction-loader';
import { deployJurisdictionStack } from '../../jurisdiction/adapter/stack-manager/deploy';
import { decodeDeployJurisdictionStackRequest } from '../../jurisdiction/adapter/stack-manager/validation';
import { safeStringify } from '../../protocol/serialization';
import { waitForRpcReady } from '../../scripts/operations/settlement/rpc-settlement-anvil';

const ANVIL_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const OTHER_ACCOUNT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

test('rejects invalid deployment targets, signer, tokens and catalog collisions before spending', async () => {
  const anvil = Bun.which('anvil');
  if (!anvil) throw new Error('ANVIL_BINARY_REQUIRED');
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') });
  const port = reservation.port;
  await reservation.stop(true);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const node = Bun.spawn(
    [
      anvil,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--chain-id',
      '31337',
      '--block-time',
      '0.1',
      '--block-gas-limit',
      '60000000',
      '--code-size-limit',
      '65536',
      '--silent',
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  const provider = new JsonRpcProvider(rpcUrl);
  const directory = await mkdtemp(join(tmpdir(), 'xln-stack-preflight-guards-'));
  const discoveryPath = join(directory, 'jurisdictions.json');
  const previous = process.env['XLN_JURISDICTIONS_PATH'];
  process.env['XLN_JURISDICTIONS_PATH'] = discoveryPath;
  try {
    await waitForRpcReady(rpcUrl, 5_000);
    const wallet = new Wallet(ANVIL_PRIVATE_KEY, provider);
    const eighteenDecimalToken = await new ERC20Mock__factory(wallet).deploy(
      'Eighteen Decimal Token',
      'BAD',
      18,
      1_000_000n,
    );
    await eighteenDecimalToken.waitForDeployment();
    expect(await eighteenDecimalToken.decimals()).toBe(18n);
    expect(await provider.getCode(OTHER_ACCOUNT)).toBe('0x');
    const sourceCatalog = new URL('../../../jurisdictions/jurisdictions.json', import.meta.url);
    const catalog = validateJurisdictionsDataValue(JSON.parse(await readFile(sourceCatalog, 'utf8')));
    expect(catalog['jurisdictions']).toHaveProperty('ethereum-sepolia');
    const catalogText = safeStringify(catalog, 2);
    await writeFile(discoveryPath, catalogText, { mode: 0o600 });
    const cases: readonly Readonly<{
      name: string;
      changes: Record<string, unknown>;
      error: string;
      phases: string[];
    }>[] = [
      {
        name: 'wrong-chain',
        changes: { expectedChainId: 11155111 },
        error: 'HHE708',
        phases: ['preflight', 'deploying'],
      },
      {
        name: 'wrong-signer',
        changes: { signerId: OTHER_ACCOUNT },
        error: 'STACK_MANAGER_SIGNER_KEY_MISMATCH',
        phases: [],
      },
      {
        name: 'token-without-code',
        changes: { stablecoin: { kind: 'existing', address: OTHER_ACCOUNT } },
        error: 'DEPLOYMENT_TOKEN_CODE_MISSING',
        phases: ['preflight', 'deploying'],
      },
      {
        name: 'wrong-decimals',
        changes: { stablecoin: { kind: 'existing', address: await eighteenDecimalToken.getAddress() } },
        error: 'DEPLOYMENT_TOKEN_DECIMALS_MISMATCH',
        phases: ['preflight', 'deploying'],
      },
      {
        name: 'catalog-collision',
        changes: { key: 'ethereum-sepolia' },
        error: 'STACK_MANAGER_JURISDICTION_KEY_EXISTS',
        phases: ['preflight'],
      },
      {
        name: 'rpc-credentials',
        changes: { rpcUrl: `${rpcUrl}/?apiKey=EXAMPLE_API_KEY` },
        error: 'STACK_MANAGER_RPC_URL_CREDENTIALS_FORBIDDEN',
        phases: [],
      },
    ];
    for (const scenario of cases) {
      const input = {
        stackVersion: 'V1',
        name: `Rejected ${scenario.name}`,
        key: `anvil-${scenario.name}-${port}`,
        rpcUrl,
        expectedChainId: 31337,
        blockTimeMs: 250,
        currency: 'ETH',
        explorer: '',
        signerId: wallet.address,
        foundationRecipient: wallet.address,
        stablecoin: { kind: 'test' },
        publication: 'local',
        confirmations: 12,
        ...scenario.changes,
      };
      const phases: string[] = [];
      const nonceBefore = await provider.send('eth_getTransactionCount', [wallet.address, 'pending']);
      const request = decodeDeployJurisdictionStackRequest({ ...input, rpcUrl });
      const deploy = async () =>
        deployJurisdictionStack(
          { ...request, rpcUrl: input.rpcUrl },
          {
            deploymentId: input.key,
            mode: 'new',
            signerPrivateKey: getBytes(ANVIL_PRIVATE_KEY),
            evidenceDirectory: join(directory, 'evidence'),
            onPhase: phase => phases.push(phase),
          },
        );
      await expect(deploy()).rejects.toThrow(scenario.error);
      expect(await provider.send('eth_getTransactionCount', [wallet.address, 'pending'])).toBe(nonceBefore);
      expect(phases).toEqual(scenario.phases);
      expect(await Bun.file(join(directory, 'evidence', input.key, 'manifest.json')).exists()).toBeFalse();
      expect(await readFile(discoveryPath, 'utf8')).toBe(catalogText);
    }
  } finally {
    provider.destroy();
    node.kill('SIGTERM');
    await node.exited;
    if (previous === undefined) delete process.env['XLN_JURISDICTIONS_PATH'];
    else process.env['XLN_JURISDICTIONS_PATH'] = previous;
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

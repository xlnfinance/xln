import { expect, test } from 'bun:test';
import { JsonRpcProvider, Wallet, getBytes } from 'ethers';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployJurisdictionStack } from '../../jurisdiction/adapter/stack-manager/deploy';
import { decodeDeployJurisdictionStackRequest } from '../../jurisdiction/adapter/stack-manager/validation';
import { validateJurisdictionsDataValue } from '../../jurisdiction/adapter/kernel/jurisdiction-loader';
import type { DeployJurisdictionStackResult } from '../../jurisdiction/adapter/stack-manager/types';
import { waitForRpcReady } from '../../scripts/operations/settlement/rpc-settlement-anvil';

const ANVIL_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
type DeploymentOutcome =
  { status: 'fulfilled'; result: DeployJurisdictionStackResult } | { status: 'rejected'; reason: unknown };

const within = async <T>(promise: Promise<T>, milliseconds: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('TEST_STACK_MANAGER_WAIT_TIMEOUT')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

test('waits for twelve confirmations before admitting deployment into discovery', async () => {
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
      '--block-gas-limit',
      '60000000',
      '--code-size-limit',
      '65536',
      '--silent',
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  const provider = new JsonRpcProvider(rpcUrl);
  const directory = await mkdtemp(join(tmpdir(), 'xln-stack-manager-confirmations-'));
  const path = join(directory, 'jurisdictions.json');
  const previous = process.env['XLN_JURISDICTIONS_PATH'];
  process.env['XLN_JURISDICTIONS_PATH'] = path;
  let deployment: Promise<DeploymentOutcome> | undefined;
  let observed: DeploymentOutcome | undefined;
  try {
    await waitForRpcReady(rpcUrl, 5_000);
    const wallet = new Wallet(ANVIL_PRIVATE_KEY);
    const phases: string[] = [];
    let reachedVerification!: () => void;
    const verifying = new Promise<void>(resolve => {
      reachedVerification = resolve;
    });
    const request = decodeDeployJurisdictionStackRequest({
      stackVersion: 'V1',
      name: 'Twelve-confirmation Anvil stack',
      key: `anvil-confirmations-${port}`,
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
    });
    deployment = deployJurisdictionStack(request, {
      deploymentId: request.key,
      mode: 'new',
      signerPrivateKey: getBytes(ANVIL_PRIVATE_KEY),
      evidenceDirectory: join(directory, 'evidence'),
      onPhase: phase => {
        phases.push(phase);
        if (phase === 'verifying') reachedVerification();
      },
    }).then(
      result => {
        observed = { status: 'fulfilled', result };
        return observed;
      },
      reason => {
        observed = { status: 'rejected', reason };
        return observed;
      },
    );
    await within(
      Promise.race([
        verifying,
        deployment.then(outcome => {
          if (outcome.status === 'rejected') throw outcome.reason;
          throw new Error('TEST_DEPLOYMENT_COMPLETED_BEFORE_VERIFICATION');
        }),
      ]),
      30_000,
    );

    const inclusionHeight = BigInt(await provider.send('eth_blockNumber', []));
    await Bun.sleep(500);
    expect(observed).toBeUndefined();
    expect(await Bun.file(path).exists()).toBeFalse();
    await provider.send('anvil_mine', ['0xa']);
    const depthBeforeLastBlock = BigInt(await provider.send('eth_blockNumber', [])) - inclusionHeight + 1n;
    expect(depthBeforeLastBlock).toBe(11n);
    // Let the native confirmation observer see depth 11 without catalog admission.
    await Bun.sleep(5_000);
    expect(observed).toBeUndefined();
    expect(await Bun.file(path).exists()).toBeFalse();
    expect(phases).toEqual(['preflight', 'deploying', 'verifying']);

    await provider.send('anvil_mine', ['0x1']);
    const outcome = await within(deployment, 30_000);
    if (outcome.status === 'rejected') throw outcome.reason;
    const registration = outcome.result.manifest.evmContracts.stablecoinRegistration;
    const tip = BigInt(await provider.send('eth_blockNumber', []));
    expect(tip - BigInt(registration.blockNumber) + 1n).toBe(12n);
    expect(phases).toEqual(['preflight', 'deploying', 'verifying', 'persisting', 'complete']);
    const persisted = validateJurisdictionsDataValue(JSON.parse(await readFile(path, 'utf8')));
    expect(persisted['jurisdictions']).toHaveProperty(request.key);
  } finally {
    try {
      if (deployment && observed === undefined) {
        await provider.send('anvil_mine', ['0xc']);
        await within(deployment, 30_000);
      }
    } finally {
      provider.destroy();
      node.kill('SIGTERM');
      await node.exited;
      if (previous === undefined) delete process.env['XLN_JURISDICTIONS_PATH'];
      else process.env['XLN_JURISDICTIONS_PATH'] = previous;
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 180_000);
